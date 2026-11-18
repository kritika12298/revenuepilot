/**
 * User-facing names and one-line decision summaries for agent runs. Shared by
 * the dashboard, lead timeline and AI activity page. Summaries come from the
 * recorded run output: never from hidden model reasoning.
 */

const NEXT_ACTION_TEXT = {
  AWAIT_OWNER_APPROVAL: 'Waiting for owner approval',
  AWAIT_LEAD_REPLY: 'Waiting for the lead to reply',
  OWNER_ACTION_REQUIRED: 'Needs owner attention',
  NO_ACTION_NEEDED: 'No action needed',
  RECOMMEND_CLOSE: 'Recommends closing the lead',
};

export function agentName(run) {
  if (run.kind === 'CONVERSATION' && run.input?.goal === 'FOLLOW_UP') return 'Follow-up Agent';
  return (
    {
      ORCHESTRATION: 'Sales Orchestrator',
      QUALIFICATION: 'Lead Intelligence Agent',
      CONVERSATION: 'Conversation Agent',
      FOLLOW_UP_PLANNING: 'Follow-up Agent',
      MEETING: 'Meeting Agent',
      POLICY_CHECK: 'Policy & Approval Agent',
      SALES_INSIGHTS: 'Sales Intelligence Agent',
      WEBSITE_ANALYSIS: 'Website Intelligence Agent',
    }[run.kind] ?? run.kind
  );
}

export function decisionSummary(run) {
  const o = run.output ?? {};
  if (run.status === 'FAILED') return { decision: 'Run failed', reason: run.error ?? run.errorCode ?? null };
  if (run.status !== 'SUCCEEDED') return { decision: null, reason: null };
  switch (run.kind) {
    case 'ORCHESTRATION':
      return { decision: NEXT_ACTION_TEXT[o.nextAction] ?? 'Planned next steps', reason: o.rationale ?? null };
    case 'QUALIFICATION':
      return {
        decision: o.score != null ? `Scored ${o.score}/100${o.intent ? `, ${o.intent.toLowerCase()} intent` : ''}` : 'Analysed the enquiry',
        reason: o.missingInformation?.length ? `Still missing: ${o.missingInformation.join(', ')}` : (o.summary ?? null),
      };
    case 'CONVERSATION':
      if (o.sent) return { decision: 'Sent a reply (auto-approved by policy)', reason: o.policyReason ?? null };
      return { decision: o.draftMessageId ? (run.input?.goal === 'FOLLOW_UP' ? 'Drafted a follow-up for approval' : 'Drafted a reply for approval') : 'No message drafted', reason: o.policyReason ?? o.summary ?? null };
    case 'FOLLOW_UP_PLANNING':
      return { decision: o.decision === 'SCHEDULE' ? `Scheduled follow-up ${o.step ?? ''} in ${o.delayHours}h` : o.decision === 'NONE' ? 'Decided not to follow up' : 'Reviewed follow-ups', reason: o.reason ?? null };
    case 'MEETING':
      if (o.appointment) return { decision: `${o.appointment.status === 'CONFIRMED' ? 'Booked' : 'Proposed'} an appointment`, reason: o.reason ?? null };
      return {
        decision: { NO_SLOTS: 'No free slot available', CALENDAR_UNAVAILABLE: 'Calendar unavailable', NOT_PERMITTED: 'Booking not permitted' }[o.outcome] ?? 'Checked availability',
        reason: o.detail ?? o.reason ?? null,
      };
    case 'POLICY_CHECK':
      return { decision: { ALLOW: 'Allowed', REQUIRE_APPROVAL: 'Requires owner approval', BLOCK: 'Blocked' }[o.verdict] ?? 'Checked policy', reason: o.reasons?.join('; ') ?? null };
    case 'SALES_INSIGHTS':
      return { decision: `${o.insights?.length ?? 0} insight${o.insights?.length === 1 ? '' : 's'}`, reason: o.insights?.[0]?.title ?? o.summary ?? null };
    case 'WEBSITE_ANALYSIS':
      return { decision: `Extracted ${o.itemsExtracted ?? 0} knowledge items from ${o.pagesFetched ?? 0} pages`, reason: o.summary ?? null };
    default:
      return { decision: null, reason: null };
  }
}

export function presentRun(run) {
  return { ...run, agentName: agentName(run), ...decisionSummary(run) };
}
