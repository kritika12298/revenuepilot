import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import * as events from '../../modules/leadEvents/leadEvent.repository.js';
import * as notifications from '../../modules/notifications/notification.repository.js';
import { evaluatePolicy } from '../policy/policyAgent.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';

/** Financial and sensitive commitments: always routed to the owner. */
export const requestOwnerApproval = defineTool({
  name: 'request_owner_approval',
  description:
    'Ask the business owner to decide on something only they can approve: a discount, a quotation, a contract or ' +
    'custom pricing. Never promise these to the customer yourself.',
  access: 'notify',
  input: z.strictObject({
    lead_id: leadIdField,
    type: z.enum(['DISCOUNT', 'QUOTE', 'CONTRACT', 'CUSTOM_PRICE', 'OTHER']),
    summary: z.string().trim().min(10).max(300).describe('What the owner needs to decide, e.g. "10% off weekly maintenance for 3 properties".'),
    reason: z.string().trim().min(10).max(400).describe('Why: what the customer asked for, in their words where possible.'),
    percent: z.number().min(0).max(100).nullable().optional().describe('Discount percentage the customer asked for, if any.'),
  }),
  async handler(input, runCtx) {
    const pending = await prisma.approval.count({ where: { businessId: runCtx.businessId, leadId: input.lead_id, type: input.type, status: 'PENDING' } });
    if (pending) throw new ToolPolicyError('ALREADY_REQUESTED', 'A request of this type is already waiting for the owner.');
    const policy = await evaluatePolicy(
      { type: 'FINANCIAL_COMMITMENT', approvalType: input.type, summary: input.summary },
      { businessId: runCtx.businessId, leadId: input.lead_id, parentRunId: runCtx.rootRunId },
    );
    const lead = await prisma.lead.findUnique({ where: { id: input.lead_id }, select: { name: true } });
    const approval = await prisma.$transaction(async (tx) => {
      const created = await tx.approval.create({
        data: {
          businessId: runCtx.businessId,
          leadId: input.lead_id,
          agentRunId: runCtx.runId,
          type: input.type,
          payload: { requestedBy: 'AI', summary: input.summary, ...(input.percent != null && { value: input.percent, kind: 'PERCENT' }) },
          aiRationale: input.reason,
        },
      });
      await events.record({ businessId: runCtx.businessId, leadId: input.lead_id, type: 'APPROVAL_REQUESTED', actor: { type: 'AI' }, data: { type: input.type, approvalId: created.id, runId: runCtx.runId } }, tx);
      await notifications.create(
        { businessId: runCtx.businessId, leadId: input.lead_id, agentRunId: runCtx.runId, reason: input.type === 'DISCOUNT' ? 'DISCOUNT_REQUEST' : input.type === 'QUOTE' ? 'QUOTE_REQUEST' : 'NEEDS_PRICING_DECISION', priority: 'NORMAL', message: `${lead.name}: ${input.summary}` },
        tx,
      );
      return created;
    });
    runCtx.state.approvalRequested = approval.id;
    return { status: 'PENDING_OWNER_APPROVAL', approval_id: approval.id, policy: policy.verdict, note: 'Tell the customer the owner will confirm; do not promise it.' };
  },
});
