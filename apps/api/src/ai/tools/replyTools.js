import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import * as events from '../../modules/leadEvents/leadEvent.repository.js';
import { checkOutboundMessage } from '../guards/outboundGuard.js';
import { checkSendPermission } from '../../modules/followUps/followUp.policy.js';
import { evaluatePolicy } from '../policy/policyAgent.js';
import * as approvalService from '../../modules/approvals/approval.service.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';

const GOAL_TEXT = {
  FIRST_RESPONSE: 'First reply to a new enquiry',
  ASK_MISSING_INFORMATION: 'Asks for details still missing from the enquiry',
  ANSWER_QUESTIONS: "Answers the lead's questions",
  FOLLOW_UP: 'Follow-up because the lead has not replied',
};

/** Plain-language explanation stored with the approval request. */
function describeDraft(goal, services, questions) {
  const parts = [GOAL_TEXT[goal] ?? 'Reply to the lead'];
  if (services.length) parts.push(`quotes published prices for ${services.map((s) => s.name).join(', ')}`);
  if (questions.length) parts.push(`asks ${questions.length} qualifying question${questions.length > 1 ? 's' : ''}`);
  return `${parts.join('; ')}. Passed the pricing and commitment checks.`;
}

/**
 * Prepares an email to the lead. The backend validates it (published prices
 * only, no commitments), checks consent, then asks the Policy & Approval
 * Agent whether it may be sent automatically (owner's autonomy settings and
 * daily limits). Otherwise it waits for owner approval. Follow-up drafts are
 * always held: the follow-up job sends them at their scheduled time.
 */
export const sendCustomerEmail = defineTool({
  name: 'send_customer_email',
  description:
    'Send an email to the lead. The backend checks it and either queues it for sending (if the owner allows ' +
    'automatic replies) or holds it for owner approval; the result tells you which. Any price you mention must ' +
    'exactly match a published price of a service listed in referenced_service_ids. No discounts, guarantees or ' +
    'specific appointment times. If it breaks a rule you will get the violations back; rewrite and call again.',
  access: 'write',
  input: z.strictObject({
    lead_id: leadIdField,
    subject: z.string().trim().min(3).max(150),
    body: z.string().trim().min(20).max(2000).describe('Plain text email body, including greeting and sign-off.'),
    questions: z
      .array(z.string().trim().min(5).max(200))
      .max(3)
      .describe('The qualification questions included in the body (for the dashboard).'),
    referenced_service_ids: z.array(z.uuid()).max(5).describe('Services whose details or prices the body mentions.'),
  }),
  async handler(input, runCtx) {
    if (runCtx.state.draftId) {
      throw new ToolPolicyError('DRAFT_ALREADY_CREATED', 'A draft was already saved in this run; finish now.');
    }
    const pending = await prisma.approval.count({
      where: { businessId: runCtx.businessId, leadId: input.lead_id, type: 'OUTBOUND_MESSAGE', status: 'PENDING' },
    });
    if (pending) {
      throw new ToolPolicyError(
        'DRAFT_PENDING',
        'A previous draft for this lead is still waiting for owner approval; do not create another.',
      );
    }

    const ids = [...new Set(input.referenced_service_ids)];
    const services = await prisma.service.findMany({
      where: { id: { in: ids }, businessId: runCtx.businessId, active: true },
    });
    if (services.length !== ids.length) {
      throw new ToolPolicyError('UNKNOWN_SERVICE', 'referenced_service_ids must be IDs from get_business_pricing.');
    }

    const check = checkOutboundMessage(`${input.subject}\n${input.body}`, services);
    if (!check.ok) {
      runCtx.state.guardRejections = (runCtx.state.guardRejections ?? 0) + 1;
      throw new ToolPolicyError('DRAFT_REJECTED', 'The draft breaks messaging rules. Rewrite it.', check.violations);
    }

    const lead = await prisma.lead.findUnique({ where: { id: input.lead_id }, include: { business: true } });
    const kind = runCtx.state.goal === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'REPLY';
    const leadHasWritten = (await prisma.message.count({ where: { conversation: { leadId: lead.id }, direction: 'INBOUND' } })) > 0;
    const permission = checkSendPermission({ lead, business: lead.business, kind, leadHasWritten });
    if (!permission.ok) throw new ToolPolicyError('NOT_PERMITTED', `This lead cannot be emailed: ${permission.reason}.`);

    const { message, approval } = await prisma.$transaction(async (tx) => {
      let conversation = await tx.conversation.findFirst({
        where: { businessId: runCtx.businessId, leadId: input.lead_id, status: 'OPEN' },
        orderBy: { updatedAt: 'desc' },
      });
      conversation ??= await tx.conversation.create({
        data: { businessId: runCtx.businessId, leadId: input.lead_id, channel: 'EMAIL', subject: input.subject },
      });
      const message = await tx.message.create({
        data: {
          businessId: runCtx.businessId,
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          author: 'AI',
          subject: input.subject,
          body: input.body,
          status: 'PENDING_APPROVAL',
        },
      });
      const approval = await tx.approval.create({
        data: {
          businessId: runCtx.businessId,
          leadId: input.lead_id,
          messageId: message.id,
          agentRunId: runCtx.runId,
          type: 'OUTBOUND_MESSAGE',
          payload: {
            channel: conversation.channel,
            questions: input.questions,
            serviceIds: ids,
            ...(runCtx.state.followUpId && { followUpId: runCtx.state.followUpId }),
          },
          aiRationale: describeDraft(runCtx.state.goal, services, input.questions),
        },
      });
      await events.record(
        {
          businessId: runCtx.businessId,
          leadId: input.lead_id,
          type: 'APPROVAL_REQUESTED',
          actor: { type: 'AI' },
          data: { type: 'OUTBOUND_MESSAGE', approvalId: approval.id, runId: runCtx.runId },
        },
        tx,
      );
      return { message, approval };
    });

    runCtx.state.draftId = message.id;
    runCtx.state.approvalId = approval.id;
    if (kind === 'FOLLOW_UP') {
      return { status: 'DRAFTED_FOR_FOLLOW_UP', message_id: message.id, note: 'The follow-up job sends it at the scheduled time if permitted.' };
    }

    const policy = await evaluatePolicy(
      { type: 'SEND_EMAIL', lead, business: lead.business, kind, leadHasWritten, text: `${input.subject}\n${input.body}`, services, summary: `Email to ${lead.name}: "${input.subject}"` },
      { businessId: runCtx.businessId, leadId: lead.id, parentRunId: runCtx.rootRunId },
    );
    runCtx.state.policyReason = policy.reasons.join('; ') || 'All policy checks passed';
    if (policy.verdict === 'ALLOW') {
      await approvalService.approve(
        { businessId: runCtx.businessId, userId: null },
        approval.id,
        { note: 'Auto-approved by the Policy & Approval Agent (owner allows automatic replies)' },
        { type: 'SYSTEM' },
      );
      runCtx.state.sent = true;
      return { status: 'QUEUED_FOR_SENDING', message_id: message.id, policy: 'Allowed by the owner\'s autonomy settings' };
    }
    return { status: 'PENDING_APPROVAL', message_id: message.id, approval_id: approval.id, policy: runCtx.state.policyReason };
  },
});
