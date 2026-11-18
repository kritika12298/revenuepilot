import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { getPolicy, LOCKED_APPROVALS } from '../../modules/autonomy/autonomy.service.js';
import { checkFollowUpEligibility, checkSendPermission } from '../../modules/followUps/followUp.policy.js';
import { checkOutboundMessage } from '../guards/outboundGuard.js';
import * as events from '../../modules/leadEvents/leadEvent.repository.js';

/**
 * Policy & Approval Agent. Deterministic by design: permission decisions must
 * be predictable and auditable, so this agent applies rules rather than asking
 * a model. Every evaluation is recorded as an agent run (POLICY_CHECK) with
 * the checks it made, so it appears in the AI execution timeline.
 *
 * Verdicts: ALLOW (agents may proceed), REQUIRE_APPROVAL (owner decides),
 * BLOCK (not permitted at all, e.g. opted out).
 */

const FINANCIAL = { DISCOUNT: 'discounts', QUOTE: 'quotations', CONTRACT: 'contracts', CUSTOM_PRICE: 'customPricing' };

const DAY = 86_400_000;
/** An approval decided by the system (no user), i.e. an automatic send. */
const AUTO_APPROVED = { type: 'OUTBOUND_MESSAGE', status: 'APPROVED', decidedById: null };

/**
 * Automatic emails committed in the last 24 hours: every AI message the policy
 * auto-approved, whether it has been delivered yet or is still queued/scheduled.
 * Counting at approval time (not delivery) stops a burst of queued sends from
 * slipping past the limit. Transactional emails (confirmations, reminders) are not counted.
 */
export async function autoEmailsCommitted(businessId) {
  return prisma.approval.count({ where: { businessId, ...AUTO_APPROVED, decidedAt: { gte: new Date(Date.now() - DAY) } } });
}

/** Automatic emails actually delivered in the last 24 hours (re-checked at send time). */
export async function autoEmailsDelivered(businessId) {
  return prisma.emailDelivery.count({
    where: { businessId, status: 'SENT', sentAt: { gte: new Date(Date.now() - DAY) }, message: { approvals: { some: AUTO_APPROVED } } },
  });
}

async function evaluateRules(action, ctx) {
  const policy = await getPolicy(ctx.businessId);
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed, detail });
  let verdict = 'ALLOW';
  const escalate = (v) => {
    const rank = { ALLOW: 0, REQUIRE_APPROVAL: 1, BLOCK: 2 };
    if (rank[v] > rank[verdict]) verdict = v;
  };

  switch (action.type) {
    case 'SEND_EMAIL': {
      const { lead, business, kind, leadHasWritten, text, services } = action;
      const permission = checkSendPermission({ lead, business, kind, leadHasWritten });
      check('Consent and communication permission', permission.ok, permission.ok ? 'Permitted' : permission.reason);
      if (!permission.ok) escalate('BLOCK');
      if (text) {
        const guard = checkOutboundMessage(text, services ?? []);
        check('Published prices only, no commitments', guard.ok, guard.ok ? 'No unpublished prices, discounts or promised times' : guard.violations.map((v) => v.detail).join(' '));
        if (!guard.ok) escalate('BLOCK');
      }
      const setting = kind === 'FOLLOW_UP' ? 'autoApproveFollowUps' : 'autoSendResponses';
      check(`Autonomy: ${kind === 'FOLLOW_UP' ? 'send follow-ups without approval' : 'send replies without approval'}`, policy[setting], policy[setting] ? 'Enabled by the owner' : 'Owner approval required');
      if (!policy[setting]) escalate('REQUIRE_APPROVAL');
      const sent = await autoEmailsCommitted(ctx.businessId);
      const underLimit = sent < policy.maxAutoEmailsPerDay;
      check('Daily automatic email limit', underLimit, `${sent} of ${policy.maxAutoEmailsPerDay} automatic emails in the last 24 hours`);
      if (!underLimit) escalate('REQUIRE_APPROVAL');
      break;
    }
    case 'FINANCIAL_COMMITMENT': {
      check(`Approval required for ${FINANCIAL[action.approvalType] ?? 'financial commitments'}`, false, 'Always requires the owner; cannot be automated');
      escalate(LOCKED_APPROVALS[FINANCIAL[action.approvalType]] === false ? 'ALLOW' : 'REQUIRE_APPROVAL');
      break;
    }
    case 'BOOK_APPOINTMENT': {
      const optedOut = action.lead.status === 'OPTED_OUT' || action.lead.optedOutAt;
      check('Lead has not opted out', !optedOut, optedOut ? 'Lead opted out' : 'OK');
      if (optedOut) escalate('BLOCK');
      check('Autonomy: book appointments without approval', policy.autoBookAppointments, policy.autoBookAppointments ? 'Enabled by the owner' : 'Owner confirms bookings');
      if (!policy.autoBookAppointments) escalate('REQUIRE_APPROVAL');
      break;
    }
    case 'SCHEDULE_FOLLOW_UP': {
      check('Autonomy: schedule follow-ups automatically', policy.autoScheduleFollowUps, policy.autoScheduleFollowUps ? 'Enabled by the owner' : 'Turned off');
      if (!policy.autoScheduleFollowUps) escalate('BLOCK');
      const eligibility = checkFollowUpEligibility(action.lead, action.business);
      check('Consent, status and follow-up settings', eligibility.ok, eligibility.ok ? 'Eligible' : eligibility.reason);
      if (!eligibility.ok) escalate('BLOCK');
      break;
    }
    case 'AUTO_PROCESS_LEAD': {
      check('Autonomy: score and analyse new leads automatically', policy.autoScoreLeads, policy.autoScoreLeads ? 'Enabled by the owner' : 'Turned off');
      if (!policy.autoScoreLeads) escalate('BLOCK');
      break;
    }
    case 'GENERATE_RESPONSE': {
      check('Autonomy: generate customer responses automatically', policy.autoGenerateResponses, policy.autoGenerateResponses ? 'Enabled by the owner' : 'Turned off; the owner writes replies');
      if (!policy.autoGenerateResponses) escalate('BLOCK');
      break;
    }
    default:
      check('Known action', false, `Unknown action ${action.type}`);
      escalate('BLOCK');
  }
  return { verdict, checks, reasons: checks.filter((c) => !c.passed).map((c) => c.detail) };
}

/**
 * Evaluate an action and record the decision (agent run + lead event).
 * ctx: { businessId, leadId?, parentRunId?, triggerDetail? }
 */
export async function evaluatePolicy(action, ctx) {
  const started = Date.now();
  const result = await evaluateRules(action, ctx);
  const summary = action.summary ?? action.type;
  try {
    const run = await prisma.agentRun.create({
      data: {
        businessId: ctx.businessId,
        leadId: ctx.leadId ?? null,
        parentRunId: ctx.parentRunId ?? null,
        kind: 'POLICY_CHECK',
        status: 'SUCCEEDED',
        trigger: ctx.parentRunId ? 'ORCHESTRATOR' : 'SYSTEM',
        triggerDetail: ctx.triggerDetail ?? `Validate: ${summary}`,
        model: 'policy-engine',
        input: { action: action.type, summary },
        output: { verdict: result.verdict, reasons: result.reasons.length ? result.reasons : ['All checks passed'], checks: result.checks },
        iterations: 0,
        latencyMs: Date.now() - started,
        startedAt: new Date(started),
        finishedAt: new Date(),
        toolCalls: {
          create: {
            businessId: ctx.businessId,
            toolUseId: `policy_${started}`,
            toolName: 'evaluate_policy',
            input: { action: action.type, summary },
            outcome: 'EXECUTED',
            result: { verdict: result.verdict, checks: result.checks },
            durationMs: Date.now() - started,
          },
        },
      },
    });
    if (ctx.leadId) {
      await events.record({
        businessId: ctx.businessId,
        leadId: ctx.leadId,
        type: 'POLICY_DECISION',
        actor: { type: 'AI' },
        data: { action: action.type, summary, verdict: result.verdict, reasons: result.reasons, runId: run.id },
      });
    }
    return { ...result, runId: run.id };
  } catch (err) {
    logger.error({ err }, 'Could not record policy decision');
    return result;
  }
}
