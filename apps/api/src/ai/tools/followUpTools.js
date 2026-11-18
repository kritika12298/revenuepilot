import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { checkFollowUpEligibility, followUpSettings } from '../../modules/followUps/followUp.policy.js';
import { ACTIVE_FOLLOW_UP_STATUSES } from '../../modules/followUps/followUp.repository.js';
import * as followUps from '../../modules/followUps/followUp.service.js';
import { evaluatePolicy } from '../policy/policyAgent.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';

/** Everything that constrains a follow-up decision, computed by the backend. */
export async function followUpContext(businessId, leadId) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId }, include: { business: true } });
  const settings = followUpSettings(lead.business);
  const [sent, active, lastSent] = await Promise.all([
    prisma.followUpJob.count({ where: { leadId, status: 'SENT' } }),
    prisma.followUpJob.findFirst({ where: { leadId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } }, select: { id: true, status: true, scheduledFor: true, step: true } }),
    prisma.message.findFirst({ where: { businessId, conversation: { leadId }, direction: 'OUTBOUND', status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
  ]);
  const eligibility = checkFollowUpEligibility(lead, lead.business);
  const replied = Boolean(lead.lastInboundAt && lastSent?.sentAt && lead.lastInboundAt > lastSent.sentAt);
  let code = eligibility.ok ? null : eligibility.code;
  if (!code && active) code = 'ACTIVE_FOLLOW_UP';
  if (!code && !lastSent) code = 'NOTHING_TO_FOLLOW_UP';
  if (!code && replied) code = 'LEAD_REPLIED';
  if (!code && sent >= settings.maxFollowUps) code = 'MAX_FOLLOW_UPS_REACHED';
  return {
    lead,
    code,
    view: {
      can_schedule: !code,
      blocked_reason: code ? (eligibility.ok ? code.toLowerCase().replace(/_/g, ' ') : eligibility.reason) : null,
      follow_ups_sent: sent,
      max_follow_ups: settings.maxFollowUps,
      suggested_delay_hours: settings.cadenceHours[Math.min(sent, settings.cadenceHours.length - 1)],
      allowed_delay_hours: { min: 1, max: 720 },
      working_hours: lead.business.workingHours,
      time_zone: lead.business.timezone,
      active_follow_up: active,
      last_email_sent_at: lastSent?.sentAt ?? null,
      lead_replied_since_last_email: replied,
    },
  };
}

export const getFollowUpPolicy = defineTool({
  name: 'get_follow_up_policy',
  description: 'Consent, settings and history that decide whether a follow-up is allowed, plus the suggested delay.',
  access: 'read',
  input: z.strictObject({ lead_id: leadIdField }),
  async handler({ lead_id }, runCtx) {
    const ctx = await followUpContext(runCtx.businessId, lead_id);
    runCtx.state.code = ctx.code;
    return ctx.view;
  },
});

export const scheduleFollowup = defineTool({
  name: 'schedule_followup',
  description: 'Schedule the next follow-up after delay_hours (moved into working hours). The AI drafts it later for approval or sending.',
  access: 'write',
  input: z.strictObject({
    lead_id: leadIdField,
    delay_hours: z.number().min(1).max(720),
    reason: z.string().trim().min(5).max(300),
  }),
  async handler({ lead_id, delay_hours, reason }, runCtx) {
    const lead = await prisma.lead.findUnique({ where: { id: lead_id }, include: { business: true } });
    const policy = await evaluatePolicy(
      { type: 'SCHEDULE_FOLLOW_UP', lead, business: lead.business, summary: `Follow-up for ${lead.name} in ${delay_hours}h` },
      { businessId: runCtx.businessId, leadId: lead_id, parentRunId: runCtx.rootRunId },
    );
    if (policy.verdict === 'BLOCK') throw new ToolPolicyError('NOT_PERMITTED', policy.reasons.join('; '));
    const result = await followUps.scheduleNext({ businessId: runCtx.businessId }, lead_id, { mode: 'auto', delayHours: delay_hours, actor: { type: 'AI' } });
    if (!result.scheduled) {
      runCtx.state.code = result.code;
      throw new ToolPolicyError(result.code, result.reason);
    }
    runCtx.state.followUp = { id: result.followUp.id, step: result.followUp.step, scheduledFor: result.followUp.scheduledFor };
    runCtx.state.delayHours = delay_hours;
    runCtx.state.reason = reason;
    return { scheduled: true, follow_up_id: result.followUp.id, step: result.followUp.step, scheduled_for: result.followUp.scheduledFor };
  },
});

export const cancelFollowup = defineTool({
  name: 'cancel_followup',
  description: 'Cancel a pending follow-up for this lead (e.g. the lead asked for time or no longer needs it).',
  access: 'write',
  input: z.strictObject({ lead_id: leadIdField, follow_up_id: z.uuid(), reason: z.string().trim().min(5).max(300) }),
  async handler({ lead_id, follow_up_id, reason }, runCtx) {
    const fu = await prisma.followUpJob.findFirst({ where: { id: follow_up_id, businessId: runCtx.businessId, leadId: lead_id } });
    if (!fu) throw new ToolPolicyError('NOT_FOUND', 'No such follow-up for this lead.');
    await followUps.cancel({ businessId: runCtx.businessId, userId: null }, follow_up_id, { reason }, { type: 'AI' });
    return { cancelled: true };
  },
});

export const recordFollowUpDecision = defineTool({
  name: 'record_follow_up_decision',
  description: 'Record your final decision (SCHEDULE, NONE or WAIT) and a short reason the owner will read. Call once, last.',
  access: 'read',
  input: z.strictObject({ lead_id: leadIdField, decision: z.enum(['SCHEDULE', 'NONE', 'WAIT']), reason: z.string().trim().min(5).max(300) }),
  async handler({ decision, reason }, runCtx) {
    if (decision === 'SCHEDULE' && !runCtx.state.followUp) throw new ToolPolicyError('NOT_SCHEDULED', 'Call schedule_followup successfully before recording SCHEDULE.');
    runCtx.state.decision = decision;
    runCtx.state.reason = reason;
    return { recorded: true };
  },
});
