/**
 * agent-send-guard — blast-radius controls for autonomous agents that contact humans.
 *
 * Four independent layers, in the order they stop a bad send:
 *
 *   1. host-lock      only one machine may run outbound automation at all
 *   2. suppression    "they already answered" — one shared definition, not per-job lists
 *   3. send-guard     per-ADDRESS caps across every record that shares an address
 *   4. call-guard     per-PERSON call caps, plus cross-channel (email answer blocks call)
 *
 * Each one exists because the layers above and below it were not enough. INCIDENTS.md
 * records what each one cost to learn.
 */
export {
  ANSWERED_NO, ANSWERED_YES, CHASE_TYPES, OPEN_DOOR, FIELDS,
  isSuppressed, isStaleChase, suppressionReason, isOpenDoor, contradictsState,
} from './suppression.js';

export {
  RESPONDED, HARD_NO, MAX_COLD_TOUCHES, MIN_DAYS_BETWEEN,
  addressIndex, canSend, groupByAddress, screen,
} from './send-guard.js';

export {
  MAX_CALLS_PER_PERSON, MIN_DAYS_BETWEEN_CALLS,
  phoneKey, phoneIndex, canCall, countableCalls,
} from './call-guard.js';

export {
  senderHost, localHostName, isSenderHost, assertSenderHost,
} from './host-lock.js';
