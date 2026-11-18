import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';
import { runAgent } from '../ai/runAgent.js';
import { followUpPlannerAgent } from '../ai/agents/followUpPlanner.js';
import { followUpContext } from '../ai/tools/followUpTools.js';
import { evaluatePolicy } from '../ai/policy/policyAgent.js';
import { getPolicy } from '../modules/autonomy/autonomy.service.js';

/**
 * Follow-up Agent entry point. Hard constraints (consent, status, settings,
 * an existing follow-up, max reached, autonomy) are checked deterministically
 * first, so no model call is spent when a follow-up is not allowed anyway.
 * Otherwise the agent decides whether and when to follow up.
 */
export async function planFollowUp({ businessId, leadId, triggerDetail, jobAttempt = null }) {
  const policy = await getPolicy(businessId);
  const ctx = await followUpContext(businessId, leadId);
  if (!policy.autoScheduleFollowUps || (ctx.code && ctx.code !== 'NOTHING_TO_FOLLOW_UP' && ctx.code !== 'ACTIVE_FOLLOW_UP' && ctx.code !== 'LEAD_REPLIED')) {
    if (!policy.autoScheduleFollowUps || ['NO_CONSENT', 'OPTED_OUT', 'FOLLOW_UPS_DISABLED', 'CHANNEL_DISABLED', 'NO_EMAIL', 'STATUS_NOT_ELIGIBLE'].includes(ctx.code)) {
      await evaluatePolicy({ type: 'SCHEDULE_FOLLOW_UP', lead: ctx.lead, business: ctx.lead.business, summary: `Follow-up for ${ctx.lead.name}` }, { businessId, leadId, triggerDetail });
    }
    return { decision: 'NONE', code: policy.autoScheduleFollowUps ? ctx.code : 'AUTONOMY_DISABLED', followUpId: null };
  }
  if (ctx.code) return { decision: 'NONE', code: ctx.code, followUpId: null };

  try {
    const { output } = await runAgent(followUpPlannerAgent, {
      businessId,
      leadId,
      trigger: 'SYSTEM',
      triggerDetail: triggerDetail ?? 'Email sent; deciding on a follow-up',
      jobAttempt,
      input: { reason: triggerDetail ?? 'An email was just sent to this lead.' },
    });
    return { decision: output.decision, code: output.code, followUpId: output.followUpId };
  } catch (err) {
    logger.error({ err: { message: err.message }, leadId }, 'Follow-up planning failed; the sweeper will retry');
    return { decision: 'ERROR', code: err.code ?? 'ERROR', followUpId: null };
  }
}

export async function leadIdsNeedingPlan(limit = 20) {
  return prisma.lead.findMany({
    where: {
      status: { in: ['QUALIFIED', 'CONTACTED', 'ENGAGED'] },
      consentEmail: true,
      optedOutAt: null,
      email: { not: null },
      lastOutboundAt: { not: null },
      followUpJobs: { none: { status: { in: ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED'] } } },
    },
    select: { id: true, businessId: true, lastInboundAt: true, lastOutboundAt: true },
    take: limit * 5,
  });
}
