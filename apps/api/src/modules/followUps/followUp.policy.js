/**
 * Consent and communication-permission rules. These are checked when a
 * follow-up is scheduled, when it is drafted, and again immediately before
 * any email is sent: whichever check runs last is the one that counts.
 */

export const FOLLOW_UP_STATUSES_ELIGIBLE = ['QUALIFIED', 'CONTACTED', 'ENGAGED'];
export const DEFAULT_CADENCE_HOURS = [48, 96, 168];
export const DEFAULT_MAX_FOLLOW_UPS = 3;

export function followUpSettings(business) {
  const prefs = business.commsPrefs ?? {};
  const cadence = prefs.followUpCadenceHours?.length ? prefs.followUpCadenceHours : DEFAULT_CADENCE_HOURS;
  return {
    enabled: prefs.followUpsEnabled !== false,
    maxFollowUps: prefs.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS,
    cadenceHours: cadence,
    emailEnabled: !prefs.channels || prefs.channels.includes('EMAIL'),
  };
}

const deny = (code, reason) => ({ ok: false, code, reason });
const ALLOW = Object.freeze({ ok: true });

/** May this lead receive automated follow-ups at all? */
export function checkFollowUpEligibility(lead, business) {
  const s = followUpSettings(business);
  if (!s.enabled) return deny('FOLLOW_UPS_DISABLED', 'Follow-ups are turned off for this business');
  if (!s.emailEnabled) return deny('CHANNEL_DISABLED', 'Email is not an enabled channel for this business');
  if (lead.optedOutAt || lead.status === 'OPTED_OUT') return deny('OPTED_OUT', 'Lead opted out');
  if (!lead.consentEmail) return deny('NO_CONSENT', 'Lead has not consented to email follow-ups');
  if (!lead.email) return deny('NO_EMAIL', 'Lead has no email address');
  if (!FOLLOW_UP_STATUSES_ELIGIBLE.includes(lead.status)) {
    return deny('STATUS_NOT_ELIGIBLE', `Follow-ups only run for ${FOLLOW_UP_STATUSES_ELIGIBLE.join(', ')} leads`);
  }
  return ALLOW;
}

/**
 * Final gate before an email leaves the system.
 *  - REPLY (an owner-approved answer to the lead's own enquiry): allowed when
 *    the lead has written to us or has consented, and has not opted out.
 *  - FOLLOW_UP (unprompted): requires explicit email consent plus everything
 *    in checkFollowUpEligibility.
 */
export function checkSendPermission({ lead, business, kind, leadHasWritten }) {
  if (!lead.email) return deny('NO_EMAIL', 'Lead has no email address');
  if (lead.optedOutAt || lead.status === 'OPTED_OUT') return deny('OPTED_OUT', 'Lead opted out');
  if (!followUpSettings(business).emailEnabled) return deny('CHANNEL_DISABLED', 'Email is disabled for this business');
  if (kind === 'FOLLOW_UP') return checkFollowUpEligibility(lead, business);
  if (!lead.consentEmail && !leadHasWritten) {
    return deny('NO_PERMISSION', 'Lead has neither consented nor written to us');
  }
  return ALLOW;
}
