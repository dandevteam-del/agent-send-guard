/**
 * suppression — the single source of truth for "we do not contact this person again."
 *
 * WHY THIS IS ONE FILE. Every outbound job used to carry its own hand-written list of
 * states to skip, and they disagreed with each other. One job's terminal list omitted
 * REJECTED, so a recipient who had explicitly said no could still be auto-dialled by a
 * stale call-back task. That is the worst thing an outreach system can do: someone who
 * said no and then gets chased is a relationship burned for every future season, not
 * just this one.
 *
 * The rule this encodes: once someone answers, the ONLY further contact is a re-approach
 * scheduled for a specific future date. Never a nudge, never a call-back, never a
 * "just checking in."
 *
 * See INCIDENTS.md #2.
 */

/** They answered NO. Each of these is a human decision already on record. */
export const ANSWERED_NO = new Set([
  'FULL',                 // "we're full this season"
  'WAITLIST_REQUESTED',   // we asked to be queued; the ball is in THEIR court
  'NEXT_YEAR_TRACKED',    // "apply next year" — re-approach is date-scheduled, not nudged
  'REJECTED',
  'DECLINED',
  'HARD_NO',
  // 'ANSWERED_NO' was missing from this set for three weeks, so the one state whose NAME
  // means "they said no" was the only state that suppressed nothing. Added after a
  // classifier wrote it and the row stayed chaseable. See INCIDENTS.md #2.
  'ANSWERED_NO',
]);

/** They answered YES, or we're already moving forward. Chasing looks disorganised. */
export const ANSWERED_YES = new Set([
  'REPLIED', 'ANSWERED', 'ACCEPTED', 'CONFIRMED', 'CONFIRMED_RECURRING',
  'GREEN_LIGHT', 'PARTIAL_DATES', 'READY_TO_REGISTER', 'APPLICATION_SUBMITTED',
  'REGISTERED',
]);

/**
 * Follow-up types that put a NEW message or call in front of the recipient.
 *
 * Scheduled seasonal re-approaches and your own internal paperwork are deliberately NOT
 * here — the whole point of tracking a "no" is to come back at the right moment.
 */
export const CHASE_TYPES = new Set([
  'reply_followup', 'call_back', 'retry_call', 'waitlist_check', 'nudge',
]);

const stateOf = (rec, f) => String(rec?.[f.state] || 'NEW').toUpperCase();

/** True when this record must not receive another unsolicited touch. */
export function isSuppressed(rec, f = FIELDS) {
  if (!rec) return false;
  const s = stateOf(rec, f);
  return ANSWERED_NO.has(s) || ANSWERED_YES.has(s) || rec[f.doNotContact] === true;
}

/**
 * True when this pending follow-up would chase someone who already said NO.
 *
 * Deliberately keyed on ANSWERED_NO, not isSuppressed. A pending call_back on a
 * READY_TO_REGISTER record is not spam — it is your own reminder to ring them and close
 * the deal. Cancelling those would quietly delete the follow-through on your hottest
 * leads. Only a "no" earns a cancellation.
 */
export function isStaleChase(followup, rec, f = FIELDS) {
  if (!followup || followup.done_at || !CHASE_TYPES.has(followup.type)) return false;
  const s = stateOf(rec, f);
  return ANSWERED_NO.has(s) || rec?.[f.doNotContact] === true;
}

/** Human-readable reason, for the note left on the record when something is cancelled. */
export function suppressionReason(rec, f = FIELDS) {
  const s = stateOf(rec, f);
  if (rec?.[f.doNotContact]) return 'marked do_not_contact';
  if (ANSWERED_NO.has(s)) return `already answered (${s}) — re-approach is date-scheduled only`;
  if (ANSWERED_YES.has(s)) return `already forward-moving (${s}) — no chase needed`;
  return 'not suppressed';
}

// ── OPEN DOOR ───────────────────────────────────────────────────────────────────────
// Added after a revenue plan counted every WAITLIST_REQUESTED row as a bookable
// opportunity and presented a sold-out circuit as an unhad conversation. It had been had,
// and it was written plainly in the record's own notes. Both sources were correct; an
// ad-hoc script that hand-listed its own "open" states ignored them.
//
// So the definition lives here and nothing re-derives it inline.
// A waitlist is the record of a NO, not a lead.
export const OPEN_DOOR = ANSWERED_YES;

/** True when they said yes, or you are already moving forward with them. */
export function isOpenDoor(rec, f = FIELDS) {
  return !!rec && OPEN_DOOR.has(stateOf(rec, f)) && rec[f.doNotContact] !== true;
}

/**
 * Phrases that mean "closed" when a recipient writes them, used to catch a record whose
 * STATE still says open while its NOTES say otherwise.
 *
 * `boilerplate` exists because a fifth of one real pipeline carried the research prompt
 * "is there already a vendor, and do they have exclusivity?" — an open QUESTION. Matching
 * a bare "exclusiv" treated that as a rejection and wrongly killed 229 records. Strip
 * your own boilerplate before testing.
 */
const CLOSED_PHRASE =
  /sold out|no (vendor )?(space|room|openings)|already (filled|full)|we are full|at capacity|not accepting|no longer accepting|closed to new|has (an )?exclusiv|category exclusiv/i;

/**
 * The note says closed while the state still says open — the state is stale.
 * Returns the matched phrase so a human can see WHY, or null when consistent.
 */
export function contradictsState(rec, { boilerplate = null, fields: f = FIELDS } = {}) {
  if (!rec || !isOpenDoor(rec, f)) return null;
  let notes = String(rec[f.notes] || '');
  if (boilerplate) notes = notes.replace(boilerplate, '');
  const m = notes.match(CLOSED_PHRASE);
  return m ? m[0] : null;
}

/** Default field mapping. Override per-call if your records use different names. */
export const FIELDS = {
  id: 'id',
  email: 'contact_email',
  phone: 'contact_phone',
  state: 'state_machine',
  history: 'history',
  notes: 'notes',
  doNotContact: 'do_not_contact',
};
