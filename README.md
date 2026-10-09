# agent-send-guard

Blast-radius controls for autonomous agents that email and call real people.

An agent that can send email will, eventually, send the same person five emails. Not
because of a bug — because the thing your code reasons about (a record, a row, a task) is
not the thing that experiences the consequence (a person). This is four layers of guard
that keep those two nouns straight, extracted from a pipeline that learned each one the
expensive way.

```
npm install agent-send-guard      # or copy src/ — zero dependencies
```

## The failure it prevents

One real audit: **969 emails to 457 addresses.** 120 addresses hit 3+ times. One
municipal inbox hit **19 times across 9 records**. One person who runs fourteen separate
festivals hit **15 times across 14 records** — they marked the sender rejected, and
because they were the gatekeeper for all fourteen, the pipeline lost all fourteen at once.

The sender's filter was this, and every clause in it is correct:

```js
record.contact_email && !record.emailed && record.state === 'NEW'
```

It is also entirely **per-record**. Real pipelines are full of gatekeepers who own many
records, so one human equals many records equals many legitimate-looking "first touches"
to the same inbox.

## Quickstart

```js
import { addressIndex, screen, groupByAddress } from 'agent-send-guard';

// Build the index over EVERY record, not just the ones you're about to send to.
// The guard is only correct if it can see the whole dataset.
const ix = addressIndex(allRecords);

const { allowed, blocked } = screen(candidates, ix);

for (const { record, reason } of blocked) {
  console.log(`skip ${record.id}: ${reason}`);
  // → skip fest-7: address already had 2 cold sends across 14 record(s) (cap 2)
  // → skip fest-9: address said NO on another record (REJECTED) — never contact again
}

// One message per human naming all their records, instead of one per record.
for (const { address, records } of groupByAddress(allowed.map(a => a.record))) {
  await send(address, records);
}
```

Every decision returns a `reason`. A guard that silently drops a send is
indistinguishable from a broken pipeline.

## The four layers

They are listed in the order they stop a bad send. Each one exists because the others
were not enough.

| Layer | File | Stops |
|---|---|---|
| **host lock** | `src/host-lock.js` | two machines running the same job against two copies of state |
| **suppression** | `src/suppression.js` | contacting anyone who already answered, from any job |
| **send guard** | `src/send-guard.js` | over-contacting one address across many records |
| **call guard** | `src/call-guard.js` | over-dialling one person; email answers blocking calls |
| **the hook** | `hooks/outbound-send-guard.mjs` | an agent writing its own sender and skipping all four |

### 1. host lock — one writer

```js
import { assertSenderHost } from 'agent-send-guard/host-lock';
assertSenderHost('nightly follow-up', { logFile: './host-lock.log' });
// ↑ first line of every scheduled job, BEFORE loading any state
```

A deploy script once mirrored a working tree to a second machine, launchd jobs included.
The second machine ran the 09:00 follow-up against its own stale queue: **31 duplicate
emails** in one morning. Every guard below was working perfectly — they were just running
twice, and a per-address cap of two means nothing when two processes each keep their own
count.

Unset config authorises *nobody*. Exits 0, not 1, so a legitimate refusal doesn't train
you to ignore your scheduler log.

### 2. suppression — one definition

```js
import { isSuppressed, isOpenDoor, isStaleChase } from 'agent-send-guard/suppression';
```

Four jobs each carried their own hand-written list of states to skip, and the lists
disagreed — one omitted the rejected state, so someone who said no could still be
robot-called. Four copies of a rule is zero copies.

Note one deliberate asymmetry: a pending call-back on a *hot* record is **kept**, not
cancelled. Only a "no" earns a cancellation. Blanket-cancelling chases on answered records
would quietly delete the follow-through on your best leads — the guard would become the
leak.

### 3. send guard — per address, across everything

```js
import { addressIndex, canSend } from 'agent-send-guard/send-guard';
const ix = addressIndex(allRecords);
const { ok, reason } = canSend(record, ix);
```

- 2-touch lifetime cap per **address** before they reply
- hard stop on any address that answered no on *any* record
- no cold mail to an address that replied *anywhere* — a human owns that thread
- 4-day floor between sends to the same person
- sends are attributed to the address that **received** them, so correcting a typo in a
  bounced record doesn't burn the corrected address

### 4. call guard — per person, cross-channel

```js
import { phoneIndex, canCall, countableCalls } from 'agent-send-guard/call-guard';
const pix = phoneIndex(allRecords, countableCalls(fs.readFileSync('log.ndjson', 'utf8')));
const { ok, reason } = canCall(record, pix, { emailIndex: ix });
```

103 phone numbers in one dataset appeared on 2+ records; one appeared on nine. A daily cap
limits your volume — it protects no individual. Three things here weren't obvious until
they bit:

- **An answer does not un-happen.** One record slid
  `READY_TO_REGISTER → CALLED → INFO_GATHERED → EMAILED` as later automation overwrote the
  field. Every state a record has *ever* held counts, not the one it holds now.
- **A call that never rang is not a touch.** Providers acknowledge a placement as "queued"
  even when the carrier refuses it. 15 calls through a suspended account all failed at
  transport, yet each logged as placed — which would have spent those people's allowance
  on calls that never happened.
- **The channels are one relationship.** Someone who answered by email must not then be
  auto-dialled on a sibling record.

### 5. the hook — the layer the agent can't skip

```jsonc
// .claude/settings.json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "node ~/.claude/hooks/outbound-send-guard.mjs" } ] } ] } }
```

All four layers above live inside one library. An agent asked to run a 13-email wave
**wrote its own sender** and ran that instead. Replaying the guard showed it would have
blocked **6 of 8** sends — including a 16th touch to the address that had already cost
fourteen events. It also invented record ids, so five sends logged to nothing and
under-counted the index the guard depends on. The damage outlived the script.

Not malice. Writing twelve lines of `fetch` was simply the shortest path to the goal as
stated, and a library it has to go find and read is a longer path. The instruction to use
the sanctioned sender existed, in the project's own instructions file. It lost to
convenience.

**The hook reads the scripts a command runs.** The real bypass was `node send-wave.mjs` —
a command that looks innocent, with the send hidden one file away. A hook that only
matches command text catches the careless case and misses the one that happens.

Configure `SANCTIONED` and `SEND_PATTERNS` at the top for your stack. Ships with patterns
for Resend, SendGrid, Postmark, Mailgun and SES.

## Tests

```
node --test            # 20 tests, one per incident
```

Every test is named after the incident it prevents. If a test fails, the incident is back.

```
ok  #1 one human owning many records gets ONE cold touch budget, not one per record
ok  #1 fixing a typo in an address must not burn the corrected address
ok  #2 a waitlist is the record of a NO, not a lead
ok  #2 a pending call_back on a HOT record is kept, not cancelled
ok  #3 an answer does not un-happen when state slides backwards
ok  #3 a call that never reached a phone does not spend the allowance
ok  #4 an unset sender host authorises nobody, not everybody
```

Writing those tests found **two live bugs** in guards that had been running in production
for a month and appeared to be working:

1. The hook **crashed on its own most important code path** — `require()` is undefined in
   an ESM package, so the script-inspection branch threw and emitted nothing. A hook that
   emits nothing *allows*. It failed open, silently, on exactly the case it was written
   for.
2. The SDK detector required the literal receiver `resend.emails.send`. A bespoke sender
   writes `const r = new Resend(k)` then `r.emails.send(...)`. It had only ever caught the
   real bypass *via the URL*; an SDK-only script went straight through.

Both found in about ten minutes by a test harness. **The guards were never the hard part.
Knowing whether they actually fire was.**

One more detail, offered without further comment: writing this repo required base64-ing
the test fixtures, because the installed hook read the test file, found a send pattern in
it, and blocked the commit.

## Field mapping

Defaults assume `{ id, contact_email, contact_phone, state_machine, history, notes,
do_not_contact }`. Override per call:

```js
canSend(record, ix, { fields: { ...FIELDS, state: 'status', email: 'email' } });
```

## What I'd tell someone building this

**Guard the noun that feels the consequence** — the person, not the record. Nearly every
incident in [INCIDENTS.md](./INCIDENTS.md) is that one error in a different costume.

**Every block needs a reason string**, or you'll spend a day proving whether your guard
works or your pipeline is broken.

**Test the guard, not just the sender.** Two of five incidents were *in the guards*.

**Fail closed, exit zero.** Refuse on missing config; keep legitimate refusals quiet.

**Assume one writer, then enforce it.** Replication is the default behaviour of every
deploy tool.

**The last layer must be one the agent cannot choose.** Instructions are a request. A hook
is a wall.

Full writeup with numbers and costs: **[INCIDENTS.md](./INCIDENTS.md)**

## License

MIT
