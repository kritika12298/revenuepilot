import { prisma } from '../../lib/prisma.js';

/** Expires pending approvals for a lead that is no longer being worked. */
export async function expirePendingForLead(businessId, leadId, note, db = prisma) {
  const { count } = await db.approval.updateMany({
    where: { businessId, leadId, status: 'PENDING' },
    data: { status: 'EXPIRED', decisionNote: note, decidedAt: new Date() },
  });
  return count;
}
