import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { getQueues, QUEUES } from '../../queue/queues.js';
import { validatePublicUrl } from '../../website/netGuard.js';
import { DEMO_HOSTS } from '../../website/demoSite.js';
import { audit } from '../automation/auditLog.js';

export const JOB_ANALYZE_WEBSITE = 'analyze-website';

export async function getWebsite(ctx) {
  const [website, counts] = await Promise.all([
    prisma.businessWebsite.findUnique({ where: { businessId: ctx.businessId } }),
    prisma.knowledgeItem.groupBy({ by: ['status'], where: { businessId: ctx.businessId }, _count: { _all: true } }),
  ]);
  return { website, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), demoHosts: env.DEMO_MODE ? DEMO_HOSTS : [] };
}

/** Saves the website URL and queues an analysis (owner only). */
export async function connectWebsite(ctx, { url }) {
  let parsed;
  try {
    parsed = validatePublicUrl(url, { allowHosts: env.DEMO_MODE ? DEMO_HOSTS : [] });
  } catch (err) {
    throw new UnprocessableError('INVALID_WEBSITE_URL', err.message);
  }
  const existing = await prisma.businessWebsite.findUnique({ where: { businessId: ctx.businessId } });
  if (existing && ['QUEUED', 'FETCHING', 'ANALYZING'].includes(existing.status) && Date.now() - existing.updatedAt.getTime() < 10 * 60e3) {
    throw new ConflictError('A website analysis is already in progress');
  }
  const website = await prisma.businessWebsite.upsert({
    where: { businessId: ctx.businessId },
    update: { url: parsed.href, status: 'QUEUED', lastError: null },
    create: { businessId: ctx.businessId, url: parsed.href, status: 'QUEUED' },
  });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: 'website.analysis_requested', entityType: 'website', entityId: website.id, data: { url: parsed.href } });
  await getQueues()[QUEUES.FOLLOW_UPS].add(
    JOB_ANALYZE_WEBSITE,
    { businessId: ctx.businessId, requestedBy: ctx.userId ?? null },
    { jobId: `website-${ctx.businessId}-${Date.now()}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
  );
  return website;
}

export function listKnowledge(ctx, { status, type }) {
  return prisma.knowledgeItem.findMany({
    where: { businessId: ctx.businessId, ...(status && { status }), ...(type && { type }) },
    orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    include: { reviewedBy: { select: { id: true, name: true } } },
  });
}

export async function createKnowledge(ctx, input) {
  const item = await prisma.knowledgeItem.create({
    data: { businessId: ctx.businessId, ...input, source: 'OWNER', status: 'APPROVED', reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: 'knowledge.created', entityType: 'knowledge', entityId: item.id });
  return item;
}

async function requireItem(ctx, id) {
  const item = await prisma.knowledgeItem.findFirst({ where: { id, businessId: ctx.businessId } });
  if (!item) throw new NotFoundError('Knowledge item');
  return item;
}

/** Edit and/or approve/reject. Any owner edit or decision counts as owner-confirmed. */
export async function updateKnowledge(ctx, id, input) {
  await requireItem(ctx, id);
  const item = await prisma.knowledgeItem.update({
    where: { id },
    data: { ...input, reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: `knowledge.${input.status ? input.status.toLowerCase() : 'edited'}`, entityType: 'knowledge', entityId: id });
  return item;
}

export async function deleteKnowledge(ctx, id) {
  await requireItem(ctx, id);
  await prisma.knowledgeItem.delete({ where: { id } });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: 'knowledge.deleted', entityType: 'knowledge', entityId: id });
}

/**
 * Adds a website-extracted service to the price list. The owner supplies the
 * price explicitly; the extracted price text is only shown as a reference.
 */
export async function promoteToService(ctx, id, price) {
  const item = await requireItem(ctx, id);
  if (item.type !== 'SERVICE') throw new UnprocessableError('NOT_A_SERVICE', 'Only service items can be added to the price list');
  const service = await prisma.$transaction(async (tx) => {
    const created = await tx.service.create({ data: { businessId: ctx.businessId, name: item.title, description: item.content.slice(0, 1000), ...price } });
    await tx.knowledgeItem.update({ where: { id }, data: { status: 'APPROVED', reviewedById: ctx.userId, reviewedAt: new Date() } });
    return created;
  });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: 'knowledge.promoted_to_service', entityType: 'service', entityId: service.id, data: { knowledgeId: id } });
  return service;
}
