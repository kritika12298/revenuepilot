import { prisma } from '../lib/prisma.js';
import * as notifications from '../modules/notifications/notification.repository.js';

/** True when this is the last attempt BullMQ will make for the job. */
export function isFinalAttempt(job) {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

export function notifyOwner({ businessId, leadId, message, priority = 'NORMAL' }, db = prisma) {
  return notifications.create({ businessId, leadId, reason: 'OTHER', priority, message: message.slice(0, 500) }, db);
}
