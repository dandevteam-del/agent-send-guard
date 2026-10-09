/**
 * host-lock — exactly ONE machine is allowed to run outbound automation.
 *
 * WHY THIS EXISTS. A deploy script mirrored the whole working tree to a second machine,
 * launchd job definitions included. The second machine then ran its own copy of the 09:00
 * follow-up job against a stale copy of the queue: 31 duplicate "quick follow-up" emails,
 * several of them to people already marked FULL or who had already replied.
 *
 * Every in-process guard in this package was working correctly. They were simply running
 * twice, on two machines, against two copies of the state — and a per-address cap is
 * meaningless when two processes each hold their own idea of how many sends have
 * happened. Correct code, replicated, is an incorrect system.
 *
 * So the lock is not about permissions. It is about there being exactly one writer.
 * Source this at the top of every scheduled outbound job, BEFORE it loads any state —
 * the clone should refuse cheaply, not do the work and then discard it.
 *
 * See INCIDENTS.md #4.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_ENV_VAR = 'OUTBOUND_SENDER_HOST';

const normHost = (h) => String(h || '').replace(/\.(local|lan)$/i, '').toLowerCase();

/**
 * The hostname permitted to send, from the environment or an env file.
 * @param {object} [opts.envVar]   variable name (default OUTBOUND_SENDER_HOST)
 * @param {object} [opts.envFile]  optional file to read the variable from
 */
export function senderHost({ envVar = DEFAULT_ENV_VAR, envFile = null } = {}) {
  let want = process.env[envVar] || '';
  if (!want && envFile) {
    try {
      const env = fs.readFileSync(envFile, 'utf8');
      const m = env.match(new RegExp(`^(?:export )?${envVar}=["']?([^"'\\n]+)`, 'm'));
      if (m) want = m[1].trim();
    } catch { /* no env file is fine — fall through to "unset" */ }
  }
  return normHost(want);
}

/**
 * macOS returns the DHCP-supplied *transient* name from os.hostname(), which can change
 * mid-session. It flipped to a generic "Mac.lan" on the sender itself once and refused
 * every send for a day. LocalHostName is the stable name. Check both; a second machine
 * matches neither, so accepting either does not weaken the single-writer rule.
 */
export function localHostName() {
  try {
    return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

/** True when this machine is the designated sender. */
export function isSenderHost(opts = {}) {
  const want = senderHost(opts);
  if (!want) return false;   // unset means "nobody is authorised", not "everybody is"
  return [os.hostname(), localHostName()].some((h) => h && normHost(h) === want);
}

/**
 * Refuse to continue unless this is the sender host.
 *
 * Exits 0, not 1. A clone declining to send is the system working as designed, and a
 * non-zero exit would fill your scheduler's logs with failures that are not failures —
 * which trains you to ignore them.
 *
 * @param {string} what      job name, for the log line
 * @param {string} [opts.logFile]  append refusals here
 */
export function assertSenderHost(what = 'outbound job', opts = {}) {
  if (isSenderHost(opts)) return true;
  const want = senderHost(opts) || '(unset)';
  const line = `${new Date().toISOString()} REFUSED on ${os.hostname()} — sender host is ${want} (${what})\n`;
  if (opts.logFile) {
    try {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      fs.appendFileSync(opts.logFile, line);
    } catch { /* logging must never be the thing that crashes a refusal */ }
  }
  console.log(line.trim());
  process.exit(0);
}
