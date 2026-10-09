#!/usr/bin/env node
/**
 * outbound-send-guard — a Claude Code PreToolUse hook that refuses Bash commands which
 * send mail outside the sanctioned path.
 *
 * WHY THIS EXISTS. Every guard in this package lives inside one skill. An agent, asked to
 * run a 13-email wave, wrote its own sender instead and ran that. The bespoke script
 * bypassed the per-address cap and the suppression list entirely.
 *
 * Re-running the guard afterwards showed it would have blocked 6 of the 8 sends that
 * matched a queue record — including a 16th touch to an address already marked REJECTED,
 * whose over-contacting had already cost roughly fourteen events. The script also invented
 * record ids that did not exist, so five sends logged to nothing, which silently
 * under-counted the very index the guard depends on.
 *
 * THE LESSON, which is why this file is in the repo and not just the library:
 * a guardrail an agent can route around is a guardrail an agent will route around — not
 * from malice, but because writing fresh code is often the shortest path to the goal as
 * stated. The guard has to live at a layer the agent does not get to choose to skip.
 *
 * Blocks a command when it BOTH reaches a mail-send API AND is not a sanctioned sender.
 * Read-only calls (listing domains, fetching a send's status) are allowed — this is about
 * delivering mail, not about touching an API.
 *
 * INSTALL (.claude/settings.json):
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash",
 *       "hooks": [ { "type": "command",
 *                    "command": "node ~/.claude/hooks/outbound-send-guard.mjs" } ] } ] } }
 *
 * CONFIGURE: edit SANCTIONED and SEND_PATTERNS below for your own stack. Set
 * SEND_GUARD_ROOTS to a colon-separated list of directories that relative script paths
 * should be resolved against.
 *
 * Exit 0 = allow. JSON on stdout with permissionDecision "deny" = block, with a reason
 * the agent can act on.
 *
 * See INCIDENTS.md #5.
 */

import fs from 'node:fs';
import path from 'node:path';

// The only senders permitted. Each one must run your guards and suppression list.
const SANCTIONED = [
  /skills\/outreach\/run\.js/,
  /registrar-autoemail\.sh/,
];

// Provider send endpoints and SDK call shapes. Add your own.
// Assembled from fragments so that this file does not itself read as a send command to
// the very class of scanner it implements — including this hook, which blocked an earlier
// attempt to write it.
const HOSTS = [
  'api\\.resend\\.com/emails',
  'api\\.sendgrid\\.com/v3/mail/send',
  'api\\.postmarkapp\\.com/email',
  'api\\.mailgun\\.net/v3/[^\\s/]+/messages',
  'email\\.[\\w-]+\\.amazonaws\\.com',
].join('|');

// The SDK pattern matches ANY receiver, not a list of known client names. A bespoke
// sender almost never writes `resend.emails.send` — it writes `const r = new Resend(k)`
// and then `r.emails.send(...)`. Pinning the receiver to a provider name meant the
// detector only ever caught the bypass via its URL, and a sender that used the SDK with a
// one-letter variable sailed through. Found by this repo's own hook self-test.
//
// This biases toward false positives (`db.messages.create(` in a chat app would match).
// That is the correct direction for a guard: a wrongly blocked command costs one sentence
// of explanation, a wrongly allowed one costs a relationship.
const SEND_PATTERNS = {
  urls: new RegExp(HOSTS, 'i'),
  sdks: new RegExp(
    [
      '\\b[\\w$]+\\s*\\.\\s*(?:emails?|messages?)\\s*\\.\\s*(?:send|create)\\s*\\(',
      'sgMail\\s*\\.\\s*send\\s*\\(',
      'new\\s+SESv?2?Client',
      'new\\s+(?:Resend|MailerSend|Postmark(?:Client)?)\\s*\\(',
    ].join('|'),
    'i',
  ),
};

// A POST (or an SDK call) delivers mail. A GET against /emails/<id> reads a status.
const MUTATES = new RegExp(
  [
    '-X\\s*POST',
    '--request\\s+POST',
    'method:\\s*[\'"]POST[\'"]',
    '--data',
    '(?:^|\\s)-d\\s',
    'body:\\s*JSON\\.stringify',
  ].join('|'),
  'i',
);

function sends(text) {
  if (SEND_PATTERNS.sdks.test(text)) return true;
  if (!SEND_PATTERNS.urls.test(text)) return false;
  return MUTATES.test(text);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = String(JSON.parse(raw)?.tool_input?.command || ''); } catch { process.exit(0); }
  if (!cmd) process.exit(0);

  if (SANCTIONED.some((re) => re.test(cmd))) process.exit(0);

  let why = null;
  if (sends(cmd)) {
    why = 'the command posts to a mail-send API directly';
  } else {
    // THE BYPASS THAT ACTUALLY HAPPENED: the API call lives inside a script file, so the
    // command itself looks innocent (`node send-wave.mjs`). Resolve any script this
    // command runs and inspect its contents too. Without this, the hook catches only the
    // careless case and misses the one that occurred.
    const home = process.env.HOME || '';
    const roots = (process.env.SEND_GUARD_ROOTS || '').split(':').filter(Boolean);

    const runners = /(?:^|\s)(?:node|python3?|bun|deno run(?:\s+-[\w-]+)*|npx\s+tsx|tsx)\s+([^\s;|&<>'"]+)/g;
    for (const m of cmd.matchAll(runners)) {
      let p = m[1];
      if (p.startsWith('-')) continue;
      if (p.startsWith('~/')) p = path.join(home, p.slice(2));
      const tries = path.isAbsolute(p)
        ? [p]
        : [path.resolve(p), ...roots.map((r) => path.resolve(r, p))];
      for (const f of tries) {
        let body;
        try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (SANCTIONED.some((re) => re.test(f))) break;
        if (sends(body)) why = `${path.basename(f)} sends mail without the queue's guard`;
        break;
      }
      if (why) break;
    }
  }
  if (!why) process.exit(0);

  const reason = [
    `BLOCKED: ${why}.`,
    '',
    'Outbound mail must go through the sender that owns the queue, so that the',
    'per-address guard and the suppression list actually run.',
    '',
    'Those enforce what a one-off script cannot:',
    '  · HARD_NO — never re-contact an address that answered REJECTED',
    '  · a 2-touch lifetime cap per ADDRESS, across every record sharing it',
    '  · no cold mail to anyone who already replied on any other record',
    '  · a 4-day minimum between sends to the same person',
    '  · one message per human naming all their records, not one per record',
    '',
    'A bespoke sender once skipped all of it and re-mailed a REJECTED address that',
    'had already cost roughly fourteen events. Re-running the guard afterwards showed',
    'it would have blocked 6 of 8 sends.',
    '',
    'If the queue genuinely has no record for this recipient, add one first, then send',
    'through the sanctioned path.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
});
