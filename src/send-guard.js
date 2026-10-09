/**
 * send-guard — stop an outreach queue from spamming one human.
 *
 * WHY THIS EXISTS. An audit of one real pipeline found 969 emails delivered to 457
 * addresses. 120 addresses had been hit 3+ times, 35 had been hit 5+, and three had been
 * hit 10+. The worst was a single municipal inbox at 19 sends across 9 records. Second
 * worst was one person who runs fourteen separate festivals: 15 emails across 14 records.
 * They marked the sender REJECTED, which cost roughly fourteen events in one state.
 *
 * The cause was structural, not accidental. The sender filtered on
 *
 *     record.contact_email && !record.emailed && record.state === 'NEW'
 *
 * which is a per-RECORD test. Real pipelines are full of gatekeepers who each own many
 * records, so one human = many records = many "first touches" to the same inbox. That is
 * the same leverage you want from a gatekeeper, pointed the wrong way.
 *
 * Every check here is per-ADDRESS and applies across the whole dataset.
 *
 * See INCIDENTS.md #1.
 */
import { FIELDS } from './suppression.js';

const norm = (a) => String(a || '').trim().toLowerCase();

/** States that mean this human already answered you — in ANY thread. */
export const RESPONDED = new Set([
  'REPLIED', 'REJECTED', 'FULL', 'ANSWERED', 'WAITLIST_REQUESTED',
  'NEXT_YEAR_TRACKED', 'READY_TO_REGISTER', 'APPLICATION_SUBMITTED',
  'REGISTERED', 'CONFIRMED_RECURRING', 'PARTIAL_DATES', 'GREEN_LIGHT',
  'ACCEPTED', 'CONFIRMED',
]);

/** Hard no — never contact this address again, on any record, ever. */
export const HARD_NO = new Set(['REJECTED', 'HARD_NO', 'DECLINED']);

/** Lifetime cold touches allowed per address before they reply. */
export const MAX_COLD_TOUCHES = 2;

/** Minimum days between two sends to the same address. */
export const MIN_DAYS_BETWEEN = 4;

/**
 * Build an address → {sends, records, states, lastAt} index over the WHOLE dataset.
 *
 * Build it once and pass it to canSend() for each candidate; it is O(n) over records and
 * the guard is only correct if it sees every record, not just the ones you are about to
 * send to.
 *
 * @param {Array<object>} records  every record in your pipeline
 * @param {object} [opts.fields]   field-name mapping (see FIELDS)
 * @param {string} [opts.sentState]  the history state that means "we sent mail"
 */
export function addressIndex(records, { fields: f = FIELDS, sentState = 'EMAILED' } = {}) {
  const ix = new Map();

  const bump = (addr, rec, sendEvent) => {
    const a = norm(addr);
    if (!a) return;
    let r = ix.get(a);
    if (!r) ix.set(a, (r = { sends: 0, records: [], states: new Set(), lastAt: null }));
    const id = rec[f.id];
    if (!r.records.includes(id)) r.records.push(id);
    r.states.add(String(rec[f.state] || 'NEW').toUpperCase());
    if (sendEvent) {
      r.sends++;
      if (!r.lastAt || sendEvent.at > r.lastAt) r.lastAt = sendEvent.at;
    }
  };

  for (const rec of records) {
    // The record's CURRENT address carries its state (REPLIED/REJECTED/…) even with no
    // send yet. A record someone replied to must suppress its address immediately.
    bump(rec[f.email], rec, null);

    // A send counts against the address it ACTUALLY went to, which is not always the
    // record's current one.
    //
    // This distinction cost four days of a live pipeline. A venue was queued with a
    // misspelled contact; the venue's own page spelled it differently. Correcting the
    // typo moved the already-bounced send onto the corrected address, and the guard then
    // blocked the GOOD address for four days over an email nobody ever received.
    // Fixing a wrong address burned the right one.
    //
    // So history entries carry `to`. Where an older entry predates that field, fall back
    // to the record's send receipt, then to the record's current address.
    for (const h of rec[f.history] || []) {
      if (h?.state !== sentState) continue;
      const sentTo = h.to
        || (rec.email && rec.email.id && rec.email.id === h.id ? rec.email.to : null)
        || rec[f.email];
      bump(sentTo, rec, h);
    }
  }
  return ix;
}

/**
 * May we send to this record right now?
 *
 * @returns {{ok: boolean, reason: string}} always with a reason — a blocked send you
 *   cannot explain is a bug report you will never be able to read.
 */
export function canSend(rec, ix, {
  minDaysBetween = MIN_DAYS_BETWEEN,
  maxColdTouches = MAX_COLD_TOUCHES,
  fields: f = FIELDS,
  now = Date.now(),
} = {}) {
  if (!rec) return { ok: false, reason: 'no such record' };
  if (rec[f.doNotContact] === true) return { ok: false, reason: 'record is do_not_contact' };

  const a = norm(rec[f.email]);
  if (!a) return { ok: false, reason: 'no email address' };

  const r = ix.get(a);
  if (!r) return { ok: true, reason: 'first contact' };

  for (const s of r.states) {
    if (HARD_NO.has(s)) {
      return { ok: false, reason: `address said NO on another record (${s}) — never contact again` };
    }
  }
  // If they replied anywhere, a human owns this thread. No more automated cold mail.
  for (const s of r.states) {
    if (RESPONDED.has(s)) {
      return { ok: false, reason: `address already responded elsewhere (${s}) — handle by hand` };
    }
  }
  if (r.sends >= maxColdTouches) {
    return {
      ok: false,
      reason: `address already had ${r.sends} cold sends across ${r.records.length} record(s) (cap ${maxColdTouches})`,
    };
  }
  if (r.lastAt) {
    const days = (now - Date.parse(r.lastAt)) / 864e5;
    if (days < minDaysBetween) {
      return { ok: false, reason: `last send ${days.toFixed(1)}d ago (min ${minDaysBetween}d)` };
    }
  }
  return { ok: true, reason: `ok (${r.sends} prior send${r.sends === 1 ? '' : 's'})` };
}

/**
 * Group candidate records by address, so one human gets ONE message naming all of their
 * records instead of one message per record.
 *
 * This is the positive form of the same insight behind the whole module: a gatekeeper who
 * owns nine events is one relationship, not nine leads.
 *
 * @returns {Array<{address: string, records: object[]}>}
 */
export function groupByAddress(candidates, { fields: f = FIELDS } = {}) {
  const g = new Map();
  for (const rec of candidates) {
    const a = norm(rec[f.email]);
    if (!a) continue;
    if (!g.has(a)) g.set(a, []);
    g.get(a).push(rec);
  }
  return [...g.entries()].map(([address, records]) => ({ address, records }));
}

/** Convenience: partition a candidate list into allowed / blocked, with reasons. */
export function screen(candidates, ix, opts = {}) {
  const allowed = [], blocked = [];
  for (const rec of candidates) {
    const v = canSend(rec, ix, opts);
    (v.ok ? allowed : blocked).push({ record: rec, reason: v.reason });
  }
  return { allowed, blocked };
}
