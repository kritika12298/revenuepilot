/**
 * Lead pipeline state machine. Keeping it as data makes the rules easy to
 * audit, test and expose to the dashboard.
 */
export const LEAD_STATUSES = [
  'NEW',
  'QUALIFYING',
  'QUALIFIED',
  'CONTACTED',
  'ENGAGED',
  'APPOINTMENT_BOOKED',
  'WON',
  'LOST',
  'OPTED_OUT',
];

export const LOST_REASONS = ['PRICE', 'NO_RESPONSE', 'TIMING', 'COMPETITOR', 'POOR_FIT', 'OTHER'];

const TRANSITIONS = {
  NEW: ['QUALIFYING', 'QUALIFIED', 'CONTACTED', 'LOST', 'OPTED_OUT'],
  QUALIFYING: ['QUALIFIED', 'CONTACTED', 'LOST', 'OPTED_OUT'],
  QUALIFIED: ['CONTACTED', 'ENGAGED', 'APPOINTMENT_BOOKED', 'LOST', 'OPTED_OUT'],
  CONTACTED: ['ENGAGED', 'APPOINTMENT_BOOKED', 'WON', 'LOST', 'OPTED_OUT'],
  ENGAGED: ['CONTACTED', 'APPOINTMENT_BOOKED', 'WON', 'LOST', 'OPTED_OUT'],
  APPOINTMENT_BOOKED: ['ENGAGED', 'WON', 'LOST', 'OPTED_OUT'],
  // Anyone can always opt out, including past customers.
  WON: ['ENGAGED', 'OPTED_OUT'],
  LOST: ['QUALIFIED', 'ENGAGED', 'OPTED_OUT'],
  // Opting out is final from the dashboard; only the lead can re-consent.
  OPTED_OUT: [],
};

/** Statuses after which no automated outreach may happen. */
export const CLOSED_STATUSES = new Set(['WON', 'LOST', 'OPTED_OUT']);

export function allowedTransitions(from) {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from, to) {
  return allowedTransitions(from).includes(to);
}
