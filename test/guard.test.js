/**
 * Each test reproduces a real incident. If a test fails, the incident is back.
 * Run: node --test
 */
import { test } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  addressIndex, canSend, groupByAddress, screen,
  phoneIndex, canCall, countableCalls, phoneKey,
  isSuppressed, isStaleChase, isOpenDoor, contradictsState,
  senderHost, isSenderHost,
} from '../src/index.js';

const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

// ───────────────────────────────────────────────────────────────────────────────
// INCIDENT #1 — one gatekeeper, fourteen records, fifteen emails.
// ───────────────────────────────────────────────────────────────────────────────

test('#1 one human owning many records gets ONE cold touch budget, not one per record', () => {
  // The shape that caused it: 14 separate records, all NEW, all the same inbox.
  const records = Array.from({ length: 14 }, (_, i) => ({
    id: `fest-${i}`,
    contact_email: 'organizer@example.org',
    state_machine: 'NEW',
    history: [],
  }));

  // The old per-record filter would have approved all 14.
  const naive = records.filter(r => r.contact_email && r.state_machine === 'NEW');
  assert.equal(naive.length, 14, 'per-record filter approves every record — this is the bug');

  // Simulate the first two sends landing.
  records[0].history = [{ state: 'EMAILED', at: ago(30), to: 'organizer@example.org' }];
  records[1].history = [{ state: 'EMAILED', at: ago(20), to: 'organizer@example.org' }];

  const ix = addressIndex(records);
  const { allowed, blocked } = screen(records, ix);
  assert.equal(allowed.length, 0, 'cap is spent — no record may send');
  assert.equal(blocked.length, 14);
  assert.match(blocked[0].reason, /2 cold sends across 14 record/);
});

test('#1 an address that answered REJECTED on one record is dead on all of them', () => {
  const records = [
    { id: 'a', contact_email: 'gate@example.org', state_machine: 'REJECTED', history: [] },
    { id: 'b', contact_email: 'gate@example.org', state_machine: 'NEW', history: [] },
  ];
  const ix = addressIndex(records);
  const v = canSend(records[1], ix);
  assert.equal(v.ok, false);
  assert.match(v.reason, /said NO on another record/);
});

test('#1 a reply anywhere stops cold mail everywhere — a human owns the thread', () => {
  const records = [
    { id: 'a', contact_email: 'gate@example.org', state_machine: 'REPLIED', history: [] },
    { id: 'b', contact_email: 'gate@example.org', state_machine: 'NEW', history: [] },
  ];
  const ix = addressIndex(records);
  assert.match(canSend(records[1], ix).reason, /already responded elsewhere/);
});

test('#1 the 4-day cooloff is measured from the actual last send', () => {
  const recs = [{
    id: 'a', contact_email: 'x@example.org', state_machine: 'NEW',
    history: [{ state: 'EMAILED', at: ago(1), to: 'x@example.org' }],
  }];
  const ix = addressIndex(recs);
  assert.equal(canSend(recs[0], ix).ok, false, '1 day ago → blocked');

  recs[0].history[0].at = ago(5);
  const ix2 = addressIndex(recs);
  assert.equal(canSend(recs[0], ix2).ok, true, '5 days ago, 1 of 2 touches used → allowed');
});

test('#1 fixing a typo in an address must not burn the corrected address', () => {
  // The send went to the MISSPELLED address and bounced. The record was then corrected.
  // History carries `to`, so the send stays attributed to the address that received it.
  const recs = [{
    id: 'hall',
    contact_email: 'Jaime@example.org',                               // corrected
    state_machine: 'NEW',
    history: [{ state: 'EMAILED', at: ago(1), to: 'jamie@example.org' }],  // bounced
  }];
  const ix = addressIndex(recs);
  const v = canSend(recs[0], ix);
  assert.equal(v.ok, true, 'the corrected address has received nothing and must be sendable');
  assert.equal(ix.get('jamie@example.org').sends, 1, 'the send is attributed to the bad address');
});

test('#1 groupByAddress collapses one human into one message', () => {
  const recs = [
    { id: '1', contact_email: 'g@example.org', state_machine: 'NEW' },
    { id: '2', contact_email: 'g@example.org', state_machine: 'NEW' },
    { id: '3', contact_email: 'other@example.org', state_machine: 'NEW' },
  ];
  const groups = groupByAddress(recs);
  assert.equal(groups.length, 2, 'three records, two humans, two emails');
  assert.equal(groups.find(g => g.address === 'g@example.org').records.length, 2);
});

// ───────────────────────────────────────────────────────────────────────────────
// INCIDENT #2 — the state named ANSWERED_NO suppressed nothing.
// ───────────────────────────────────────────────────────────────────────────────

test('#2 ANSWERED_NO suppresses — the state whose name means no must mean no', () => {
  assert.equal(isSuppressed({ state_machine: 'ANSWERED_NO' }), true);
});

test('#2 a waitlist is the record of a NO, not a lead', () => {
  const rec = { state_machine: 'WAITLIST_REQUESTED' };
  assert.equal(isSuppressed(rec), true);
  assert.equal(isOpenDoor(rec), false, 'must never be counted as a bookable opportunity');
});

test('#2 a pending call_back on a HOT record is kept, not cancelled', () => {
  // Only a "no" earns a cancellation. Cancelling chases on forward-moving records would
  // quietly delete the follow-through on the best leads in the pipeline.
  const hot = { state_machine: 'READY_TO_REGISTER' };
  const dead = { state_machine: 'REJECTED' };
  const followup = { type: 'call_back', done_at: null };
  assert.equal(isStaleChase(followup, hot), false, 'keep the reminder to close the deal');
  assert.equal(isStaleChase(followup, dead), true, 'cancel the chase on a no');
});

test('#2 do_not_contact overrides everything', () => {
  assert.equal(isSuppressed({ state_machine: 'NEW', do_not_contact: true }), true);
});

test('#2 notes that say "sold out" expose a stale open state', () => {
  const rec = { state_machine: 'REPLIED', notes: 'Called 7/21 — whole circuit SOLD OUT. Waitlist only.' };
  assert.equal(contradictsState(rec), 'SOLD OUT');
});

test('#2 research boilerplate asking ABOUT exclusivity is not a rejection', () => {
  // A bare substring match on "exclusiv" treated an open QUESTION as a closed door and
  // wrongly killed 229 records — a fifth of a real pipeline. Two defences, both needed:
  // the shipped pattern requires "has/category exclusiv", not the bare stem; and callers
  // may strip their own research boilerplate before the test runs.
  const rec = {
    state_machine: 'REPLIED',
    notes: 'ASK FIRST: is there already a vendor, and do they have exclusivity?',
  };
  assert.match(rec.notes, /exclusiv/i, 'a naive bare-stem match WOULD fire here');
  assert.equal(contradictsState(rec), null, 'the shipped pattern does not fire on a question');

  // And the belt-and-braces path: stripping boilerplate first is still correct discipline,
  // because the next phrase added to the pattern may not be as careful.
  const boilerplate = /ASK FIRST: is there already a vendor, and do they have exclusivity\?/ig;
  assert.equal(contradictsState(rec, { boilerplate }), null);

  // A real closed answer still fires.
  assert.equal(
    contradictsState({ state_machine: 'REPLIED', notes: 'Sorry, the category has an exclusive already.' }),
    'has an exclusiv',
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// INCIDENT #3 — the dialler, and the state that slid backwards.
// ───────────────────────────────────────────────────────────────────────────────

test('#3 one phone number on nine records is dialled twice, not nine times', () => {
  const records = Array.from({ length: 9 }, (_, i) => ({
    id: `r${i}`, contact_phone: '(219) 555-0147', state_machine: 'NEW', history: [],
  }));
  const log = [
    { at: ago(30), to: '2195550147' },
    { at: ago(20), to: '219-555-0147' },   // same human, different formatting
  ];
  const pix = phoneIndex(records, log);
  const v = canCall(records[5], pix);
  assert.equal(v.ok, false);
  assert.match(v.reason, /called 2x across 9 record/);
});

test('#3 an answer does not un-happen when state slides backwards', () => {
  // Real sequence: READY_TO_REGISTER → CALLED → INFO_GATHERED → EMAILED, as later
  // automation overwrote the field. Reading only the CURRENT state robot-calls someone
  // who already said yes.
  const rec = {
    id: 'harvest',
    contact_phone: '555-555-1212',
    state_machine: 'EMAILED',                      // current state looks cold
    history: [
      { state: 'READY_TO_REGISTER', at: ago(40) }, // but they said YES 40 days ago
      { state: 'CALLED', at: ago(30) },
      { state: 'INFO_GATHERED', at: ago(20) },
    ],
  };
  const pix = phoneIndex([rec], []);
  const v = canCall(rec, pix);
  assert.equal(v.ok, false, 'history must veto the current state');
  assert.match(v.reason, /already answered \(READY_TO_REGISTER\)/);
});

test('#3 an email reply blocks a robot call — the channels are one relationship', () => {
  const recs = [
    { id: 'a', contact_email: 'g@example.org', state_machine: 'REPLIED', history: [] },
    { id: 'b', contact_email: 'g@example.org', contact_phone: '555-555-1212',
      state_machine: 'NEW', history: [] },
  ];
  const eix = addressIndex(recs);
  const pix = phoneIndex(recs, []);
  const v = canCall(recs[1], pix, { emailIndex: eix });
  assert.equal(v.ok, false);
  assert.match(v.reason, /already replied/);
});

test('#3 a call that never reached a phone does not spend the allowance', () => {
  // 15 calls through a suspended account all ended in a transport error, yet each was
  // logged as placed — which would have burned those people's 2-call budget on calls
  // that never rang.
  const log = [
    '{"event":"call","at":"2026-09-16T10:00:00Z","to":"5555551212","call_id":"c1"}',
    '{"event":"callresult","call_id":"c1","ended_reason":"call.start.error-get-transport"}',
    '{"event":"call","at":"2026-09-16T10:05:00Z","to":"5555551213","call_id":"c2"}',
    '{"event":"callresult","call_id":"c2","ended_reason":"customer-ended-call"}',
    '{"event":"call","at":"2026-09-16T10:09:00Z","to":"5555551214","call_id":"c3"}',
    '{"event":"call_void","call_id":"c3","reason":"backfill, never dialled"}',
    'not json at all',
  ].join('\n');
  const counted = countableCalls(log);
  assert.equal(counted.length, 1, 'only the call that actually connected counts');
  assert.equal(counted[0].call_id, 'c2');
});

test('#3 phoneKey normalises formatting and rejects junk', () => {
  for (const p of ['(219) 555-0147', '219.555.0147', '+1 219 555 0147', '12195550147']) {
    assert.equal(phoneKey(p), '2195550147', p);
  }
  assert.equal(phoneKey('ext. 4'), null);
  assert.equal(phoneKey(''), null);
});

// ───────────────────────────────────────────────────────────────────────────────
// INCIDENT #4 — correct code, replicated, is an incorrect system.
// ───────────────────────────────────────────────────────────────────────────────

test('#4 an unset sender host authorises nobody, not everybody', () => {
  const prev = process.env.OUTBOUND_SENDER_HOST;
  delete process.env.OUTBOUND_SENDER_HOST;
  try {
    assert.equal(senderHost(), '');
    assert.equal(isSenderHost(), false, 'fail closed — an empty config must not permit sending');
  } finally {
    if (prev !== undefined) process.env.OUTBOUND_SENDER_HOST = prev;
  }
});

test('#4 hostname matching ignores .local/.lan drift and case', () => {
  const prev = process.env.OUTBOUND_SENDER_HOST;
  // macOS swapped the transient hostname to a generic name mid-session once and refused
  // every send for a day; the stable name is what the config was written from.
  process.env.OUTBOUND_SENDER_HOST = `${os.hostname().replace(/\.(local|lan)$/i, '').toUpperCase()}.local`;
  try {
    assert.equal(isSenderHost(), true);
  } finally {
    if (prev === undefined) delete process.env.OUTBOUND_SENDER_HOST;
    else process.env.OUTBOUND_SENDER_HOST = prev;
  }
});

test('#4 a different host is refused', () => {
  const prev = process.env.OUTBOUND_SENDER_HOST;
  process.env.OUTBOUND_SENDER_HOST = 'some-other-machine';
  try {
    assert.equal(isSenderHost(), false);
  } finally {
    if (prev === undefined) delete process.env.OUTBOUND_SENDER_HOST;
    else process.env.OUTBOUND_SENDER_HOST = prev;
  }
});
