export const LEAD_STATUSES = ['NEW', 'QUALIFYING', 'QUALIFIED', 'CONTACTED', 'ENGAGED', 'APPOINTMENT_BOOKED', 'WON', 'LOST', 'OPTED_OUT'];

export const STATUS_LABELS = {
  NEW: 'New',
  QUALIFYING: 'Qualifying',
  QUALIFIED: 'Qualified',
  CONTACTED: 'Contacted',
  ENGAGED: 'Engaged',
  APPOINTMENT_BOOKED: 'Appointment booked',
  WON: 'Won',
  LOST: 'Lost',
  OPTED_OUT: 'Opted out',
};

export const SOURCE_LABELS = { WEB_FORM: 'Web form', EMAIL: 'Email', API: 'API', MANUAL: 'Manual' };

export const LOST_REASONS = {
  PRICE: 'Price',
  NO_RESPONSE: 'No response',
  TIMING: 'Timing',
  COMPETITOR: 'Went with a competitor',
  POOR_FIT: 'Poor fit',
  OTHER: 'Other',
};

export const FOLLOW_UP_STATUS_LABELS = {
  DRAFTING: 'Drafting',
  PENDING_APPROVAL: 'Needs approval',
  SCHEDULED: 'Scheduled',
  SENT: 'Sent',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
  FAILED: 'Failed',
};

export const AGENT_LABELS = {
  ORCHESTRATION: 'Sales orchestrator',
  QUALIFICATION: 'Lead intelligence',
  CONVERSATION: 'Conversation agent',
  FOLLOW_UP_DRAFT: 'Follow-up drafter',
  LOST_LEAD_ANALYSIS: 'Lost-lead analysis',
};

export const NEXT_ACTION_LABELS = {
  AWAIT_OWNER_APPROVAL: 'Waiting for your approval',
  AWAIT_LEAD_REPLY: 'Waiting for the lead to reply',
  OWNER_ACTION_REQUIRED: 'Needs your attention',
  NO_ACTION_NEEDED: 'No action needed',
  RECOMMEND_CLOSE: 'Recommends closing this lead',
};

export const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];
