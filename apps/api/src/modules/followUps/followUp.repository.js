import { prisma } from '../../lib/prisma.js';

export const ACTIVE_FOLLOW_UP_STATUSES = ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED'];

/** Cancels every follow-up that has not been sent yet. Returns the count. */
export async function cancelActiveForLead(businessId, leadId, reason, db = prisma) {
  const active = await db.followUpJob.findMany({
    where: { businessId, leadId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } },
    select: { id: true, messageId: true },
  });
  if (!active.length) return 0;
  await db.followUpJob.updateMany({
    where: { id: { in: active.map((f) => f.id) } },
    data: { status: 'CANCELLED', skipReason: reason },
  });
  // Drafts tied to cancelled follow-ups must never be sent later.
  const messageIds = active.map((f) => f.messageId).filter(Boolean);
  if (messageIds.length) {
    await db.message.updateMany({
      where: { id: { in: messageIds }, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
  }
  return active.length;
}
