import { prisma } from '../../lib/prisma.js';

export function findUserByEmail(email, db = prisma) {
  return db.user.findUnique({ where: { email } });
}

export function findUserWithMemberships(userId, db = prisma) {
  return db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      memberships: {
        orderBy: { createdAt: 'asc' },
        select: {
          role: true,
          business: { select: { id: true, name: true, slug: true, timezone: true } },
        },
      },
    },
  });
}

export function findMembership(userId, businessId, db = prisma) {
  return db.membership.findUnique({
    where: { userId_businessId: { userId, businessId } },
    select: { userId: true, businessId: true, role: true },
  });
}

export function findFirstMembership(userId, db = prisma) {
  return db.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, businessId: true, role: true },
  });
}

export function slugExists(slug, db = prisma) {
  return db.business.count({ where: { slug } }).then((n) => n > 0);
}

/** Creates a user, their first business and an OWNER membership atomically. */
export function createUserWithBusiness({ user, business }, db = prisma) {
  return db.$transaction(async (tx) => {
    const createdBusiness = await tx.business.create({ data: business });
    const createdUser = await tx.user.create({
      data: {
        ...user,
        memberships: { create: { businessId: createdBusiness.id, role: 'OWNER' } },
      },
    });
    return { user: createdUser, business: createdBusiness };
  });
}
