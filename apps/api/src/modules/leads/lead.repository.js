import { prisma } from '../../lib/prisma.js';

/**
 * Data access for leads. Every function takes `businessId` and includes it in
 * the WHERE clause: a lead id on its own is never enough to read or modify a
 * row, which is what keeps tenants isolated.
 */

const listSelect = {
  id: true,
  assignedTo: { select: { id: true, name: true } },
  name: true,
  email: true,
  phone: true,
  company: true,
  source: true,
  status: true,
  score: true,
  lostReason: true,
  consentEmail: true,
  lastContactAt: true,
  createdAt: true,
  updatedAt: true,
};

function buildWhere(businessId, filters) {
  const where = { businessId };
  if (filters.status) where.status = { in: filters.status };
  if (filters.source) where.source = { in: filters.source };
  if (filters.minScore !== undefined || filters.maxScore !== undefined) {
    where.score = {
      ...(filters.minScore !== undefined && { gte: filters.minScore }),
      ...(filters.maxScore !== undefined && { lte: filters.maxScore }),
    };
  }
  if (filters.q) {
    const contains = { contains: filters.q, mode: 'insensitive' };
    where.OR = [{ name: contains }, { email: contains }, { company: contains }];
  }
  return where;
}

function buildOrderBy({ sort, order }) {
  // Unscored leads always sink to the bottom when sorting by score.
  const primary = sort === 'score' ? { score: { sort: order, nulls: 'last' } } : { [sort]: order };
  return [primary, { id: 'asc' }];
}

export async function findMany(businessId, filters, { skip, take }, db = prisma) {
  const where = buildWhere(businessId, filters);
  const [rows, total] = await Promise.all([
    db.lead.findMany({ where, orderBy: buildOrderBy(filters), skip, take, select: listSelect }),
    db.lead.count({ where }),
  ]);
  return { rows, total };
}

export function findById(businessId, id, db = prisma) {
  return db.lead.findFirst({ where: { id, businessId } });
}

export function findDetailById(businessId, id, db = prisma) {
  return db.lead.findFirst({
    where: { id, businessId },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      conversations: {
        orderBy: { createdAt: 'asc' },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      },
      followUpJobs: {
        orderBy: { scheduledFor: 'asc' },
        select: { id: true, step: true, scheduledFor: true, status: true, skipReason: true },
      },
      approvals: {
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, status: true, messageId: true, payload: true, aiRationale: true, createdAt: true },
      },
    },
  });
}

/**
 * Creates a lead together with its first conversation and inbound message.
 * Must run inside a transaction (pass `tx`).
 */
export async function create(businessId, data, enquiry, tx) {
  const lead = await tx.lead.create({ data: { ...data, businessId } });
  if (enquiry) {
    await tx.conversation.create({
      data: {
        businessId,
        leadId: lead.id,
        channel: enquiry.channel,
        subject: enquiry.subject,
        messages: {
          create: {
            businessId,
            direction: 'INBOUND',
            author: 'LEAD',
            subject: enquiry.subject,
            body: enquiry.message,
            status: 'RECEIVED',
          },
        },
      },
    });
  }
  return lead;
}

/**
 * Updates a lead scoped to its business. `expect` adds optimistic-concurrency
 * conditions (e.g. the status we read). Throws Prisma P2025 when no row matches.
 */
export function update(businessId, id, data, { expect = {} } = {}, db = prisma) {
  return db.lead.update({ where: { id, businessId, ...expect }, data });
}

export async function remove(businessId, id, db = prisma) {
  const { count } = await db.lead.deleteMany({ where: { id, businessId } });
  return count > 0;
}
