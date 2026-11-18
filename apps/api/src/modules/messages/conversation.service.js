import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import { enqueueSend } from '../../queue/queues.js';
import { logger } from '../../config/logger.js';
import { logAutomation } from '../automation/audit.js';

/**
 * Inbox view: one row per lead that has messages, most recent activity first.
 */
export async function listConversations(ctx, { page, pageSize, q, needsReply }) {
  const { skip, take } = toSkipTake({ page, pageSize });
  const search = q ? Prisma.sql`AND (l.name ILIKE ${`%${q}%`} OR l.email ILIKE ${`%${q}%`} OR l.company ILIKE ${`%${q}%`})` : Prisma.empty;
  const reply = needsReply ? Prisma.sql`AND l.last_inbound_at IS NOT NULL AND (l.last_outbound_at IS NULL OR l.last_inbound_at > l.last_outbound_at)` : Prisma.empty;

  const rows = await prisma.$queryRaw`
    SELECT l.id, max(m.created_at) AS last_at, count(*)::int AS message_count,
           count(*) FILTER (WHERE m.status = 'PENDING_APPROVAL')::int AS pending_drafts,
           count(*) OVER ()::int AS total
    FROM leads l
    JOIN conversations c ON c.lead_id = l.id
    JOIN messages m ON m.conversation_id = c.id
    WHERE l.business_id = ${ctx.businessId}::uuid ${search} ${reply}
    GROUP BY l.id
    ORDER BY last_at DESC, l.id
    LIMIT ${take} OFFSET ${skip}`;

  const ids = rows.map((r) => r.id);
  const leads = await prisma.lead.findMany({
    where: { id: { in: ids }, businessId: ctx.businessId },
    select: {
      id: true,
      name: true,
      company: true,
      status: true,
      score: true,
      conversations: {
        select: {
          channel: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, author: true, direction: true, status: true, createdAt: true } },
        },
      },
    },
  });
  const byId = new Map(leads.map((l) => [l.id, l]));
  const data = rows.map((r) => {
    const lead = byId.get(r.id);
    const last = lead.conversations
      .flatMap((c) => c.messages.map((m) => ({ ...m, channel: c.channel })))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      lead: { id: lead.id, name: lead.name, company: lead.company, status: lead.status, score: lead.score },
      lastMessage: last ? { ...last, body: last.body.slice(0, 160) } : null,
      lastActivityAt: r.last_at,
      messageCount: r.message_count,
      pendingDrafts: r.pending_drafts,
    };
  });
  return paginated(data, rows[0]?.total ?? 0, { page, pageSize });
}

/**
 * A reply written by the owner in the dashboard. Written by a person, so it is
 * approved on creation; consent and opt-out are still checked by the worker
 * at send time.
 */
export async function sendOwnerReply(ctx, leadId, { subject, body }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId: ctx.businessId } });
  if (!lead) throw new NotFoundError('Lead');
  if (lead.status === 'OPTED_OUT') throw new UnprocessableError('OPTED_OUT', 'This lead opted out of emails');
  if (!lead.email) throw new UnprocessableError('NO_EMAIL', 'This lead has no email address');

  const message = await prisma.$transaction(async (tx) => {
    let conversation = await tx.conversation.findFirst({ where: { businessId: ctx.businessId, leadId, status: 'OPEN' }, orderBy: { updatedAt: 'desc' } });
    conversation ??= await tx.conversation.create({ data: { businessId: ctx.businessId, leadId, channel: 'EMAIL', subject } });
    const message = await tx.message.create({
      data: {
        businessId: ctx.businessId,
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        author: 'OWNER',
        subject: subject ?? conversation.subject,
        body,
        status: 'APPROVED',
      },
    });
    await logAutomation(
      { businessId: ctx.businessId, leadId, type: 'NOTE', actor: { type: 'USER', userId: ctx.userId }, data: { action: 'OWNER_REPLY_QUEUED', messageId: message.id } },
      tx,
    );
    return message;
  });
  try {
    await enqueueSend({ messageId: message.id });
  } catch (err) {
    logger.error({ err: { message: err.message }, messageId: message.id }, 'Could not enqueue owner reply; sweeper will retry');
  }
  return message;
}
