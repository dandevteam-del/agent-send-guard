# Five incidents

Every guard in this package exists because something already went wrong. This is the
record of what each one cost to learn, in the order the lessons arrived.

The setting: a one-person food business running an autonomous outreach pipeline — about
2,000 records across 40 states, each one a market, festival or venue to apply to. Agents
research the records, draft the emails, place the calls, and classify the replies. Roughly
900 emails and 120 calls have gone out through it.

Names and addresses are redacted. The organizers in this story are real people who did
nothing wrong.

---

## #1 — One human, fourteen records, fifteen emails

**What broke.** An audit of the send log found 969 emails delivered to 457 distinct
addresses. 120 addresses had been contacted 3+ times, 35 of them 5+ times, and three more
than 10. The worst single case was a municipal inbox at **19 sends across 9 records**.
The second worst was one person who runs **fourteen separate festivals**: 15 emails across
14 records.

**What it cost.** That second person marked us as rejected. Because they were the
gatekeeper for fourteen events, the pipeline lost all fourteen at once — roughly a third
of one state's opportunity set, from one over-contacted inbox.

**Why it happened.** Not a bug in the sense of a wrong line of code. The sender's filter
was:

```js
record.contact_email && !record.emailed && record.state === 'NEW'
```

Read that carefully. Every clause is correct. Every clause is also **per-record**. The
pipeline is full of gatekeepers who each own many records, so one human equals many
records equals many legitimate-looking "first touches" to the same inbox. The system was
working exactly as written, and what it was written to do was wrong.

This is the shape of most agent-outreach failures I have seen since: the unit the code
reasons about (a record, a task, a row) is not the unit that experiences the consequence
(a person).

**The fix.** `src/send-guard.js`. Every check is keyed on the **address**, indexed across
the entire dataset, not the record being sent to:

- a 2-touch lifetime cap per address before they ever reply
- a hard stop on any address that answered "no" on *any* record
- no cold mail at all to an address that replied *anywhere* — a human owns that thread
- a 4-day floor between sends to the same person
- `groupByAddress()`, which is the positive form of the same insight: one message naming
  all fourteen of someone's events, instead of fourteen messages

**The subtler follow-on.** A venue was queued with a misspelled contact address. The send
bounced. Someone then corrected the spelling — and the guard immediately blocked the
*good* address for four days, over an email nobody had ever received. Fixing a wrong
address burned the right one. History entries now carry the address a send actually went
to, so a touch is attributed to the inbox that received it rather than to whatever the
record says today.

---

## #2 — The state named `ANSWERED_NO` suppressed nothing

**What broke.** Each outbound job carried its own hand-written list of states to skip, and
the lists disagreed. The auto-dialler's list omitted the rejected state entirely, so an
organizer who had explicitly said no could still be robot-called by a stale call-back task.

Separately, a reply classifier started writing a new state, `ANSWERED_NO`, when an
organizer declined in plain words. Nothing was taught to suppress it. For three weeks, the
one state whose **name** means "they said no" was the only state in the system that
suppressed nothing at all.

**What it cost.** No single dramatic number — which is what makes it the most dangerous of
the five. It leaked slowly, as a small ongoing tax of chasing people who had already
answered, each one a relationship quietly spent.

**Why it happened.** The definition of "done with this person" lived in four places. Four
copies of a rule is zero copies of a rule; it is four opportunities to disagree.

A second instance: a revenue plan counted every `WAITLIST_REQUESTED` record as a bookable
opportunity, and presented a sold-out circuit as a conversation we had never had. We had
had it. It was in the record's own notes, in plain English. Both sources were correct — an
ad-hoc script that hand-listed its own idea of "open" ignored both. **A waitlist is the
record of a no, not a lead.**

**The fix.** `src/suppression.js` is the only definition, and nothing re-derives it inline.
Two sets: `ANSWERED_NO` and `ANSWERED_YES`, with `isSuppressed()` over both.

One deliberate asymmetry worth noting, because getting it wrong would have been expensive
in the other direction: a pending call-back on a *hot* record is **not** cancelled. Only a
"no" earns a cancellation. A blanket "cancel all pending chases on answered records" would
have silently deleted the follow-through on the best leads in the pipeline — the guard
would have become the leak.

And one near-miss on over-correction: a pattern that matched the bare substring `exclusiv`
flagged 229 records as closed. They weren't. They carried the research prompt *"is there
already a vendor, and do they have exclusivity?"* — an open question. A guard tuned too
tight killed a fifth of the pipeline in a single pass. The shipped pattern requires
`has exclusiv` or `category exclusiv`, and callers can strip their own boilerplate first.

---

## #3 — A daily cap protects your volume, not any person

**What broke.** The auto-dialler's only per-target check was "has this record been
called?" — one call per record. In the dataset, **103 phone numbers appeared on 2+ records
and one appeared on nine.** A gatekeeper running nine events would have been dialled nine
times by a robot. The only thing that had ever throttled it was a blunt 25-calls-per-day
limit, which is not protection; it is a speed limit on the harm.

**Why it happened.** Same root cause as #1, one channel over. The cap was on the wrong
noun.

**The fix.** `src/call-guard.js`, keyed on the normalised phone number across the whole
dataset. Three things in it were not obvious until they bit:

**State can slide backwards.** One record went
`READY_TO_REGISTER → CALLED → INFO_GATHERED → EMAILED` as later automation overwrote the
field. A guard reading only the *current* state would have robot-called someone who had
already said yes. So every state a record has **ever** held counts. An answer does not
un-happen.

**A call that never rang is not a touch.** Telephony providers acknowledge a placement as
"queued" even when the carrier then refuses it. 15 calls through a suspended account all
ended in a transport error, yet each was logged as placed — which would have spent those
people's two-call allowance on calls that never happened. `countableCalls()` excludes any
call whose result carries an error reason.

**The channels are one relationship.** Someone who answered by email must not then be
auto-dialled on a sibling record. `canCall()` takes the email index too.

---

## #4 — Correct code, replicated, is an incorrect system

**What broke.** A deploy script mirrored the working tree to a second machine — launchd
job definitions included. The second machine began running its own copy of the 09:00
follow-up job against its own stale copy of the queue. **31 duplicate follow-up emails**
went out in one morning, several to organizers already marked full or who had already
replied.

**Why it happened.** This is the one I think about most, because **every guard in this
package was working perfectly.** They were simply running twice, in two processes, against
two copies of the state. A per-address cap of two is meaningless when two processes each
hold their own private count of how many sends have happened.

Guardrails that live in application code assume a single writer. Nothing in the code said
so, so nothing enforced it, so a routine deploy quietly doubled the writers.

**The fix.** `src/host-lock.js`. Exactly one machine may run outbound automation, named in
config. It is sourced at the **top** of every scheduled job, before any state is loaded —
the clone should refuse cheaply, not do the work and then throw it away.

Three details that matter more than the idea:

- **An unset config authorises nobody, not everybody.** Fail closed.
- **It exits 0, not 1.** A clone declining to send is the system working. A non-zero exit
  would fill the scheduler log with failures that are not failures, which trains you to
  stop reading it.
- **macOS has two hostnames.** `os.hostname()` returns the DHCP-supplied *transient* name,
  which flipped to a generic `Mac.lan` mid-session on the sender itself and refused every
  send for a day. The lock now accepts either the transient or the stable `LocalHostName`.
  A second machine matches neither, so this does not weaken the rule.

---

## #5 — A guardrail an agent can route around is one it will route around

**What broke.** Every guard above lives inside one skill. An agent, asked to run a
13-email wave, **wrote its own sender instead** and ran that. The bespoke script bypassed
the per-address cap and the suppression list completely.

**What it cost.** Re-running the guard against what had been sent showed it would have
blocked **6 of the 8** sends that matched a record — including a 16th touch to the same
address from incident #1, the one already marked rejected, whose over-contacting had
already cost fourteen events. The script also invented record ids that did not exist, so
five sends logged to nothing, which silently **under-counted the very index the guard
depends on.** The damage outlived the script.

**Why it happened.** Not malice, and not really disobedience. Writing fresh code was the
shortest path to the goal as stated. An agent optimising for "send these 13 emails" will
find the shortest path, and a library it has to go *find and read* is a longer path than
twelve lines of fetch. The instruction to use the sanctioned sender existed. It was in the
project's own instructions file. It lost to convenience.

**The fix.** `hooks/outbound-send-guard.mjs` — a `PreToolUse` hook that denies any shell
command which reaches a mail-send API and is not a sanctioned sender. The guard moved to a
layer the agent does not get to choose to skip.

One implementation note that is the whole ballgame: **the hook reads the scripts a command
runs.** The bypass that actually happened was `node send-wave.mjs` — a command that looks
completely innocent, with the send hidden one file away. A hook matching only on command
text catches the careless case and misses the real one.

### Two bugs found while packaging this repo

Writing the self-test for this hook turned up two faults in the version that had been
running in production for a month:

1. **The hook crashed on its own most important code path.** Inside an ESM package,
   `require()` is undefined — so the script-inspection branch, the one that catches the
   bypass that actually occurred, threw and produced no output. A hook that produces no
   output is a hook that **allows**. It failed open, silently, on exactly the case it was
   written for. Now portable `.mjs` with static imports.

2. **The SDK pattern required a literal receiver name.** It matched
   `resend.emails.send(...)`. A bespoke sender writes `const r = new Resend(k)` and then
   `r.emails.send(...)`. The detector only ever caught the real bypass *via its URL*; an
   SDK-only script with no URL in it sailed straight through. Now matches any receiver,
   which biases toward false positives — the correct direction, since a wrongly blocked
   command costs one sentence of explanation and a wrongly allowed one costs a
   relationship.

Both were found by `node --test` and a seven-case hook harness, in about ten minutes,
after a month of the guard appearing to work. The guards were never the hard part. Knowing
whether they actually fire was.

---

## What I would tell someone building this

**Guard the noun that feels the consequence.** Not the record, not the task, not the row.
The person. Almost every failure above is the same error in a different costume.

**One definition, imported everywhere.** Four copies of "we're done with this contact" is
zero copies.

**Every block needs a reason string.** A guard that silently drops a send is
indistinguishable from a broken pipeline, and you will spend a day proving which one you
have. Every `canSend`/`canCall` here returns `{ok, reason}`.

**Test the guard, not just the sender.** Two of the five incidents were *in the guards
themselves*, and one of them failed open for a month while looking fine.

**Fail closed, exit zero.** Refuse when the config is missing. But make a legitimate
refusal quiet, or you train yourself to ignore the log that matters.

**Assume one writer, then enforce it.** Replication is the default behaviour of every
deploy tool. Correct code running twice is not correct.

**The last layer has to be one the agent cannot choose.** Instructions are a request.
A hook is a wall.
