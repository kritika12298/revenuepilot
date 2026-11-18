import { prisma } from '../../lib/prisma.js';

export function record({ businessId, leadId, type, actor, data = {} }, db = prisma) {
  return db.leadEvent.create({
    data: {
      businessId,
      leadId,
      type,
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      data,
    },
  });
}

export async function listForLead(businessId, leadId, { skip, take }, db = prisma) {
  const where = { businessId, leadId };
  const [rows, total] = await Promise.all([
    db.leadEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { actorUser: { select: { id: true, name: true } } },
    }),
    db.leadEvent.count({ where }),
  ]);
  return { rows, total };
}
