import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';

/** Audit trail for security-relevant changes (settings, autonomy, integrations, knowledge). */
export async function audit({ businessId, actor = { type: 'USER' }, action, entityType, entityId = null, data = {} }, db = prisma) {
  logger.info({ audit: action, businessId, entityType, entityId }, `audit: ${action}`);
  return db.auditLog.create({
    data: { businessId, actorType: actor.type, actorUserId: actor.userId ?? null, action, entityType, entityId, data },
  });
}
