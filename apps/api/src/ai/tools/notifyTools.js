import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import * as events from '../../modules/leadEvents/leadEvent.repository.js';
import * as notifications from '../../modules/notifications/notification.repository.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';

const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Reasons that are really requests for a financial decision. */
const APPROVAL_FOR_REASON = {
  DISCOUNT_REQUEST: 'DISCOUNT',
  QUOTE_REQUEST: 'QUOTE',
  NEEDS_PRICING_DECISION: 'OTHER',
};

export const notifyBusinessOwner = defineTool({
  name: 'notify_business_owner',
  description:
    'Alert the business owner. Use for hot leads, and whenever the lead asks for something only the owner can ' +
    'decide: discounts, quotes for QUOTE_ONLY services, custom pricing, unusual requests or complaints. ' +
    'Discount, quote and pricing requests also create an approval item for the owner.',
  access: 'notify',
  input: z.strictObject({
    lead_id: leadIdField,
    reason: z.enum([
      'HOT_LEAD',
      'NEEDS_PRICING_DECISION',
      'DISCOUNT_REQUEST',
      'QUOTE_REQUEST',
      'CUSTOM_REQUEST',
      'COMPLAINT',
      'OTHER',
    ]),
    priority: z.enum(['LOW', 'NORMAL', 'URGENT']),
    message: z.string().trim().min(10).max(500).describe('What the owner needs to know or decide, in one or two sentences.'),
  }),
  async handler(input, runCtx) {
    if (runCtx.state.notified) {
      throw new ToolPolicyError('NOTIFY_LIMIT', 'The owner was already notified in this run.');
    }
    const recent = await notifications.findRecent(
      runCtx.businessId,
      input.lead_id,
      input.reason,
      new Date(Date.now() - DEDUPE_WINDOW_MS),
    );
    if (recent) {
      throw new ToolPolicyError('ALREADY_NOTIFIED', 'The owner was notified about this recently; do not repeat it.');
    }

    const approvalType = APPROVAL_FOR_REASON[input.reason];
    // One pending decision per type per lead (same rule as request_owner_approval): notify, but don't duplicate it.
    const alreadyPending = approvalType
      ? await prisma.approval.count({ where: { businessId: runCtx.businessId, leadId: input.lead_id, type: approvalType, status: 'PENDING' } })
      : 0;
    const result = await prisma.$transaction(async (tx) => {
      const notification = await notifications.create(
        {
          businessId: runCtx.businessId,
          leadId: input.lead_id,
          agentRunId: runCtx.runId,
          priority: input.priority,
          reason: input.reason,
          message: input.message,
        },
        tx,
      );
      const approval = approvalType && !alreadyPending
        ? await tx.approval.create({
            data: {
              businessId: runCtx.businessId,
              leadId: input.lead_id,
              agentRunId: runCtx.runId,
              type: approvalType,
              payload: { requestedBy: 'AI', reason: input.reason },
              aiRationale: input.message,
            },
          })
        : null;
      await events.record(
        {
          businessId: runCtx.businessId,
          leadId: input.lead_id,
          type: 'OWNER_NOTIFIED',
          actor: { type: 'AI' },
          data: { reason: input.reason, priority: input.priority, approvalId: approval?.id ?? null },
        },
        tx,
      );
      return { notification, approval };
    });

    // Delivery channel (email/SMS) arrives with the messaging adapters; for now
    // notifications live in the dashboard and the log.
    logger.info(
      { businessId: runCtx.businessId, leadId: input.lead_id, reason: input.reason, priority: input.priority },
      'Owner notified',
    );
    runCtx.state.notified = true;
    return {
      notified: true,
      notification_id: result.notification.id,
      ...(result.approval && { approval_id: result.approval.id, approval_type: result.approval.type }),
    };
  },
});
