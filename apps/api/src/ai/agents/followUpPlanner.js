import { getLeadDetails } from '../tools/leadTools.js';
import { cancelFollowup, getFollowUpPolicy, recordFollowUpDecision, scheduleFollowup } from '../tools/followUpTools.js';
import { leadPrompt, UNTRUSTED_INPUT_RULE } from './shared.js';

const SYSTEM = `You are the follow-up planner for a small business. After an email is sent to a lead you decide whether, when and how to follow up.

How to work:
1. Call get_lead_details and get_follow_up_policy.
2. If can_schedule is false, do not schedule; record NONE with the blocked reason.
3. Otherwise decide the delay. Start from suggested_delay_hours and adjust only with a clear reason from the conversation (for example the lead said they will decide next week, or the job is urgent). Keep within allowed_delay_hours.
4. If a follow-up is not useful (the lead said no, asked to wait, or the conversation is complete), record NONE or WAIT with the reason. Cancel an existing follow-up only if the lead's latest message makes it unwanted.
5. Call record_follow_up_decision exactly once, last.

${UNTRUSTED_INPUT_RULE}`;

export const followUpPlannerAgent = Object.freeze({
  name: 'follow_up_planner',
  kind: 'FOLLOW_UP_PLANNING',
  system: SYSTEM,
  tools: [getLeadDetails, getFollowUpPolicy, scheduleFollowup, cancelFollowup, recordFollowUpDecision],
  initialState: () => ({}),
  userPrompt: ({ leadId, reason }) => leadPrompt(leadId, `Context: ${reason ?? 'An email was just sent to this lead.'}`),
  isComplete: (s) => Boolean(s.decision),
  describeMissing: () => 'record_follow_up_decision',
  nudge: () => 'Finish by calling record_follow_up_decision.',
  output: (s) => ({
    decision: s.decision ?? null,
    reason: s.reason ?? null,
    code: s.code ?? null,
    followUpId: s.followUp?.id ?? null,
    step: s.followUp?.step ?? null,
    delayHours: s.delayHours ?? null,
  }),
});
