/**
 * call-guard — cap robot calls per PERSON, not per day.
 *
 * WHY A PER-PERSON CAP HAD TO EXIST BEFORE THE DAILY CAP COULD GO. The auto-dialler's
 * only per-target check was "has this record been called?" — one call per RECORD. In one
 * real pipeline 103 phone numbers appeared on 2+ records and one appeared on NINE. A
 * gatekeeper who runs nine events would have been dialled nine times, and a blunt
 * 25-calls-per-day cap was the only thing that had ever throttled it. A daily cap limits
 * your volume; it does not protect any individual human.
 *
 * This is the phone twin of the email audit in send-guard.js, where one person received
 * 15 emails across 14 records and cost roughly fourteen events. The cap here is per
 * HUMAN, keyed on the normalised phone number, across the whole dataset.
 *
 * See INCIDENTS.md #3.
 */
import { ANSWERED_NO, ANSWERED_YES, FIELDS } from './suppression.js';
import { RESPONDED as EMAIL_RESPONDED, HARD_NO as EMAIL_HARD_NO } from './send-guard.js';

/** Lifetime robot calls to one person before they reply. Mirrors MAX_COLD_TOUCHES. */
export const MAX_CALLS_PER_PERSON = 2;

/** Minimum days between two calls to the same person. */
export const MIN_DAYS_BETWEEN_CALLS = 4;

const ANSWERED = new Set([...ANSWERED_NO, ...ANSWERED_YES]);

/** First well-formed NANP number in free text → 10 digits, or null. */
export function phoneKey(p) {
  const m = String(p || '')
    .match(/(?:\+?1[\s.-]*)?\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})(?!\d)/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Build phone → {calls, lastAt, states, records} over every record AND every call ever
 * placed.
 *
 * @param {Array<object>} records
 * @param {Array<{at: string, to: string, call_id?: string}>} callLog
 *   the calls actually dialled — so a call counts against that human even if the
 *   record's phone number later changed. Use countableCalls() to build this.
 */
export function phoneIndex(records, callLog = [], { fields: f = FIELDS } = {}) {
  const ix = new Map();
  const rec_ = (k) => {
    let r = ix.get(k);
    if (!r) ix.set(k, (r = { calls: 0, lastAt: null, states: new Set(), records: [] }));
    return r;
  };

  for (const rec of records) {
    const k = phoneKey(rec[f.phone]);
    if (!k) continue;
    const r = rec_(k);
    r.records.push(rec[f.id]);
    r.states.add(String(rec[f.state] || 'NEW').toUpperCase());

    // AN ANSWER DOES NOT UN-HAPPEN.
    //
    // State can slide backwards. One real record went
    //   READY_TO_REGISTER → CALLED → INFO_GATHERED → EMAILED
    // as later automation overwrote it. A guard reading only the CURRENT state would
    // robot-call someone who had already said yes. So every state the record has EVER
    // held counts, not just the one it holds now.
    for (const h of rec[f.history] || []) {
      if (h?.state) r.states.add(String(h.state).toUpperCase());
    }
    if (rec[f.doNotContact] === true) r.states.add('DO_NOT_CONTACT');
  }

  for (const c of callLog) {
    const k = phoneKey(c.to);
    if (!k) continue;
    const r = rec_(k);
    r.calls++;
    if (!r.lastAt || c.at > r.lastAt) r.lastAt = c.at;
  }
  return ix;
}

/**
 * May we robot-call this record's person right now?
 *
 * Checks the PHONE's history and state across every record, and the record's EMAIL too —
 * someone who answered you by email must not then be auto-dialled on a sibling record.
 * The channels are one relationship.
 */
export function canCall(rec, pix, {
  emailIndex = null,
  maxCalls = MAX_CALLS_PER_PERSON,
  minDaysBetween = MIN_DAYS_BETWEEN_CALLS,
  fields: f = FIELDS,
  now = Date.now(),
} = {}) {
  if (!rec) return { ok: false, reason: 'no such record' };
  if (rec[f.doNotContact] === true) return { ok: false, reason: 'record is do_not_contact' };

  const k = phoneKey(rec[f.phone]);
  if (!k) return { ok: false, reason: 'no dialable phone number' };

  const r = pix.get(k);
  if (r) {
    if (r.states.has('DO_NOT_CONTACT')) {
      return { ok: false, reason: `number ${k} is do_not_contact on another record` };
    }
    for (const s of r.states) {
      if (ANSWERED.has(s)) {
        return { ok: false, reason: `number ${k} already answered (${s}) on a record — a human owns this line` };
      }
    }
    if (r.calls >= maxCalls) {
      return {
        ok: false,
        reason: `number ${k} already called ${r.calls}x across ${r.records.length} record(s) (cap ${maxCalls} per person)`,
      };
    }
    if (r.lastAt) {
      const days = (now - Date.parse(r.lastAt)) / 864e5;
      if (days < minDaysBetween) {
        return { ok: false, reason: `number ${k} last called ${days.toFixed(1)}d ago (min ${minDaysBetween}d)` };
      }
    }
  }

  // Cross-channel: an email answer blocks a call.
  if (emailIndex && rec[f.email]) {
    const er = emailIndex.get(String(rec[f.email]).trim().toLowerCase());
    if (er) {
      for (const s of er.states) {
        if (EMAIL_HARD_NO.has(s)) {
          return { ok: false, reason: `email answered ${s} — never contact again` };
        }
        if (EMAIL_RESPONDED.has(s)) {
          return { ok: false, reason: `email already replied (${s}) — no robot call` };
        }
      }
    }
  }
  return {
    ok: true,
    reason: r ? `ok (${r.calls} prior call(s) to this person)` : 'first call to this person',
  };
}

/**
 * Parse an NDJSON call log into the calls that COUNT against a person.
 *
 * A call that never reached a phone is not a touch. Telephony providers acknowledge a
 * placement as "queued" even when the carrier then refuses it, so the placement event
 * alone over-counts. In one real case 15 calls through a suspended account all ended in
 * a transport error, yet each was logged as placed — which would have spent those
 * people's 2-call allowance on calls that never rang.
 *
 * Excluded:
 *   · any call whose result carries an error/fault/transport ended_reason
 *   · any call named by a `call_void` event (set by hand, with a reason, for backfills)
 *
 * @param {string} logText  newline-delimited JSON
 * @returns {Array<{at: string, to: string, call_id?: string}>}
 */
export function countableCalls(logText) {
  const calls = [], dead = new Set();
  for (const line of String(logText || '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === 'call' && e.to) {
      calls.push({ at: e.at, id: e.id, to: e.to, call_id: e.call_id });
    } else if (e.event === 'call_void' && e.call_id) {
      dead.add(e.call_id);
    } else if (e.event === 'callresult' && e.call_id
               && /error|fault|transport/i.test(String(e.ended_reason || ''))) {
      dead.add(e.call_id);
    }
  }
  return calls.filter((c) => !c.call_id || !dead.has(c.call_id));
}
