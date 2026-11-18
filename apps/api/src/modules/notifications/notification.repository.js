import { prisma } from '../../lib/prisma.js';
import { publishEvent } from '../events/eventBus.js';

export async function create(data, db = prisma) {
  const n = await db.notification.create({ data });
  publishEvent(n.businessId, 'notification', { id: n.id, message: n.message, priority: n.priority });
  return n;
}

export function findRecent(businessId, leadId, reason, since, db = prisma) {
  return db.notification.findFirst({
    where: { businessId, leadId, reason, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function list(businessId, { unreadOnly, skip, take }, db = prisma) {
  const where = { businessId, ...(unreadOnly && { readAt: null }) };
  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { lead: { select: { id: true, name: true, status: true, score: true } } },
    }),
    db.notification.count({ where }),
  ]);
  return { rows, total };
}

export async function markRead(businessId, id, db = prisma) {
  const { count } = await db.notification.updateMany({
    where: { id, businessId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count) return true;
  return (await db.notification.count({ where: { id, businessId } })) > 0;
}
