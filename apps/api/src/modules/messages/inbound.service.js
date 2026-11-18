import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { logAutomation } from '../automation/audit.js';
import { cancelAllForLead, removeJobsFor } from '../followUps/followUp.service.js';
import * as leadService from '../leads/lead.service.js';
import { enqueueProcessLead } from '../../jobs/processLead.js';

/** Statuses that move to ENGAGED when the lead writes back. */
const ENGAGE_FROM = new Set(['QUALIFIED', 'CONTACTED']);

/**
 * Records a message from the lead (webhook or logged by the owner) and stops
 * all pending follow-ups: once a customer responds, they get an answer, not
 * another automated nudge.
 */
export async function recordInbound({ businessId, leadId, subject, body, channel = 'EMAIL', source, actor = { type: 'LEAD' } }) {
  const { message, cancelled } = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM leads WHERE id = ${leadId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundError('Lead');
    const lead = await tx.lead.findUnique({ where: { id: leadId } });

    let conversation = await tx.conversation.findFirst({
      where: { businessId, leadId, status: 'OPEN' },
      orderBy: { updatedAt: 'desc' },
    });
    conversation ??= await tx.conversation.create({ data: { businessId, leadId, channel, subject } });

    const now = new Date();
    const message = await tx.message.create({
      data: { businessId, conversationId: conversation.id, direction: 'INBOUND', author: 'LEAD', subject, body, status: 'RECEIVED' },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: now } });
    await tx.lead.update({ where: { id: leadId }, data: { lastInboundAt: now, lastContactAt: now } });

    await logAutomation(
      { businessId, leadId, type: 'MESSAGE_RECEIVED', actor, data: { channel, source, messageId: message.id } },
      tx,
    );
    const cancelled = await cancelAllForLead(tx, { businessId, leadId, reason: 'Lead replied' });

    if (ENGAGE_FROM.has(lead.status)) {
      await tx.lead.update({ where: { id: leadId }, data: { status: 'ENGAGED' } });
      await logAutomation(
        { businessId, leadId, type: 'STATUS_CHANGED', data: { from: lead.status, to: 'ENGAGED', reason: 'Lead replied' } },
        tx,
      );
    }
    return { message, cancelled };
  });

  await removeJobsFor(cancelled);
  await enqueueProcessLead({ businessId, leadId, trigger: 'INBOUND_MESSAGE', detail: `${source === 'webhook' ? 'Lead replied by email' : 'Owner logged a reply from the lead'}`, dedupe: message.id }).catch(() => {});
  return { message, cancelledFollowUps: cancelled.length };
}

/**
 * Honours an unsubscribe request. Always succeeds for a valid token, whatever
 * the lead's pipeline status, and stops every pending follow-up.
 */
export async function optOutByToken(token, { via }) {
  const lead = await prisma.lead.findUnique({ where: { unsubscribeToken: token } });
  if (!lead) return { found: false };
  if (lead.status === 'OPTED_OUT') return { found: true, alreadyOptedOut: true, lead };

  const ctx = { businessId: lead.businessId, userId: null };
  const pending = await prisma.followUpJob.findMany({
    where: { leadId: lead.id, status: { in: ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED'] } },
  });
  await leadService.changeStatus(ctx, lead.id, { status: 'OPTED_OUT', note: `Unsubscribed via ${via}` }, { type: 'LEAD' });
  await removeJobsFor(pending);
  return { found: true, alreadyOptedOut: false, lead };
}
