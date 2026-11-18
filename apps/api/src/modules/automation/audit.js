import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import * as events from '../leadEvents/leadEvent.repository.js';
import { publishEvent } from '../events/eventBus.js';

/**
 * Records an automated action twice: on the lead timeline (visible to the
 * owner) and in the structured log (for operators). Every scheduler, worker
 * and webhook side effect goes through here.
 */
export async function logAutomation({ businessId, leadId, type, data = {}, actor = { type: 'SYSTEM' } }, db = prisma) {
  logger.info({ automation: type, businessId, leadId, ...data }, `automation: ${type}`);
  publishEvent(businessId, 'lead-event', { type, leadId });
  return events.record({ businessId, leadId, type, actor, data }, db);
}
