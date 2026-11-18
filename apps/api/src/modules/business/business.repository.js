import { prisma } from '../../lib/prisma.js';

const businessSelect = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  workingHours: true,
  commsPrefs: true,
  createdAt: true,
  updatedAt: true,
};

export function findById(businessId, db = prisma) {
  return db.business.findUnique({ where: { id: businessId }, select: businessSelect });
}

export function update(businessId, data, db = prisma) {
  return db.business.update({ where: { id: businessId }, data, select: businessSelect });
}

export function listServices(businessId, { includeInactive = false } = {}, db = prisma) {
  return db.service.findMany({
    where: { businessId, ...(includeInactive ? {} : { active: true }) },
    orderBy: { name: 'asc' },
  });
}

export function createService(businessId, data, db = prisma) {
  return db.service.create({ data: { ...data, businessId } });
}

/** Scoped update; returns null when the service is not in this business. */
export async function updateService(businessId, id, data, db = prisma) {
  const { count } = await db.service.updateMany({ where: { id, businessId }, data });
  return count ? db.service.findUnique({ where: { id } }) : null;
}
