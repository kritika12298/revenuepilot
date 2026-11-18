import { getLeadDetails, updateLeadStatus } from '../tools/leadTools.js';
import { notifyBusinessOwner } from '../tools/notifyTools.js';
import { recordNextAction, runConversationAgent, runLeadIntelligence, runMeetingAgent } from '../tools/orchestratorTools.js';
import { requestOwnerApproval } from '../tools/approvalTools.js';
import { leadPrompt, UNTRUSTED_INPUT_RULE } from './shared.js';

const SYSTEM = `You are the sales orchestrator for a small business. For one lead at a time you decide the next best action and coordinate specialist agents. You never write customer messages yourself.

Your tools:
- get_lead_details: always start here.
- run_lead_intelligence: when the lead has no analysis, or has sent messages since the last analysis.
- update_lead_status: QUALIFYING or QUALIFIED when the analysis supports it (QUALIFIED: at least one matched service and a score around 50 or more). Other statuses belong to the owner.
- notify_business_owner: for hot leads (score 75+) or anything only the owner can decide (discounts, quotes for QUOTE_ONLY services, custom pricing, complaints).
- run_meeting_agent: when the lead asks to book a visit, consultation or call and has no appointment yet.
- request_owner_approval: when the lead asks for a discount, a quote, a contract or custom pricing.
- run_conversation_agent: when the last message is from the lead and no reply draft is pending approval. Pick the goal: FIRST_RESPONSE, ASK_MISSING_INFORMATION or ANSWER_QUESTIONS.
- record_next_action: exactly once, at the end, with your decision and a brief rationale the owner will read.

Work in a loop: observe (get_lead_details), understand, decide, act with one tool, check the result, and decide the next step. Be efficient: do each action at most once per run, adapt if a tool returns an error rather than repeating the same call, and stop after record_next_action.

${UNTRUSTED_INPUT_RULE}`;

export const orchestratorAgent = Object.freeze({
  name: 'orchestrator',
  kind: 'ORCHESTRATION',
  system: SYSTEM,
  tools: [getLeadDetails, runLeadIntelligence, updateLeadStatus, notifyBusinessOwner, requestOwnerApproval, runMeetingAgent, runConversationAgent, recordNextAction],
  initialState: () => ({ childRuns: [] }),
  userPrompt: ({ leadId, reason }) => leadPrompt(leadId, `Trigger: ${reason ?? 'Owner asked for the next best action.'}`),
  isComplete: (s) => Boolean(s.decision),
  describeMissing: () => 'record_next_action',
  nudge: () => 'Finish by calling record_next_action with your decision.',
  output: (s, text) => ({
    nextAction: s.decision?.nextAction ?? null,
    rationale: s.decision?.rationale ?? null,
    childRunIds: s.childRuns,
    draftMessageId: s.draftId ?? null,
    ownerNotified: Boolean(s.notified),
    summary: text || null,
  }),
});
