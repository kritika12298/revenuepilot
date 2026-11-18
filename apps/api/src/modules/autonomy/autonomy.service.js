import { prisma } from '../../lib/prisma.js';
import { audit } from '../automation/auditLog.js';

/**
 * Business-level autonomy: what agents may do without asking. Financial
 * commitments always need the owner and are not configurable.
 */
export const LOCKED_APPROVALS = Object.freeze({
  discounts: true,
  quotations: true,
  contracts: true,
  customPricing: true,
});

export const AUTONOMY_FIELDS = ['autoScoreLeads', 'autoGenerateResponses', 'autoSendResponses', 'autoScheduleFollowUps', 'autoApproveFollowUps', 'autoBookAppointments', 'maxAutoEmailsPerDay'];

export async function getPolicy(businessId, db = prisma) {
  const policy = await db.autonomyPolicy.findUnique({ where: { businessId } });
  if (policy) return policy;
  // Defaults are created on first read. Legacy setting: commsPrefs.autoApproveFollowUps.
  const business = await db.business.findUnique({ where: { id: businessId }, select: { commsPrefs: true } });
  return db.autonomyPolicy.upsert({
    where: { businessId },
    update: {},
    create: { businessId, autoApproveFollowUps: business?.commsPrefs?.autoApproveFollowUps === true },
  });
}

export async function getAutonomy(ctx) {
  const policy = await getPolicy(ctx.businessId);
  return { policy, lockedApprovals: LOCKED_APPROVALS };
}

export async function updateAutonomy(ctx, input) {
  const before = await getPolicy(ctx.businessId);
  const policy = await prisma.autonomyPolicy.update({ where: { businessId: ctx.businessId }, data: { ...input, updatedById: ctx.userId } });
  const changes = Object.fromEntries(Object.keys(input).filter((k) => before[k] !== policy[k]).map((k) => [k, { from: before[k], to: policy[k] }]));
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: 'autonomy.updated', entityType: 'autonomy_policy', entityId: ctx.businessId, data: changes });
  return { policy, lockedApprovals: LOCKED_APPROVALS };
}
