import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';
import { enqueueDraft, enqueueSend } from '../queue/queues.js';
import { FOLLOW_UP_STATUSES_ELIGIBLE } from '../modules/followUps/followUp.policy.js';
import { ACTIVE_FOLLOW_UP_STATUSES } from '../modules/followUps/followUp.repository.js';
import { planFollowUp } from './planFollowUp.js';

const BATCH = 500;
const STALE_RUN_MS = 15 * 60e3;

/**
 * Periodic self-healing pass (BullMQ job scheduler, FOLLOW_UP_SWEEP_INTERVAL_MS):
 *  1. re-enqueues work whose queue job went missing (Redis restart, enqueue
 *     failure); deterministic job ids make this a no-op when the job exists;
 *  2. schedules follow-ups for qualified leads we have emailed, who have not
 *     replied and have no follow-up in flight.
 * The database is the source of truth; the queue only holds timers.
 */
export async function processSweep() {
  const stats = { drafts: 0, sends: 0, scheduled: 0, skipped: {}, staleRuns: 0 };

  // Agent runs interrupted by a crash or deploy never finish; stop showing them as running.
  const stale = await prisma.agentRun.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
    data: { status: 'FAILED', errorCode: 'STALE', error: 'Run did not finish', finishedAt: new Date() },
  });
  stats.staleRuns = stale.count;

  const drafting = await prisma.followUpJob.findMany({
    where: { status: 'DRAFTING', createdAt: { lt: new Date(Date.now() - 2 * 60e3) } },
    select: { id: true },
    take: BATCH,
  });
  for (const fu of drafting) {
    await enqueueDraft(fu.id);
    stats.drafts += 1;
  }

  const scheduled = await prisma.followUpJob.findMany({
    where: { status: 'SCHEDULED', messageId: { not: null } },
    select: { id: true, messageId: true, scheduledFor: true },
    take: BATCH,
  });
  for (const fu of scheduled) {
    await enqueueSend({ messageId: fu.messageId, followUpId: fu.id, scheduledFor: fu.scheduledFor });
    stats.sends += 1;
  }

  // Approved replies (not follow-ups) that never got a delivery attempt.
  const orphanReplies = await prisma.message.findMany({
    where: { status: 'APPROVED', followUpJob: null, delivery: null, direction: 'OUTBOUND' },
    select: { id: true },
    take: BATCH,
  });
  for (const m of orphanReplies) {
    await enqueueSend({ messageId: m.id });
    stats.sends += 1;
  }

  const candidates = await prisma.lead.findMany({
    where: {
      status: { in: FOLLOW_UP_STATUSES_ELIGIBLE },
      consentEmail: true,
      optedOutAt: null,
      email: { not: null },
      lastOutboundAt: { not: null },
      followUpJobs: { none: { status: { in: ACTIVE_FOLLOW_UP_STATUSES } } },
    },
    select: { id: true, businessId: true, lastInboundAt: true, lastOutboundAt: true },
    take: BATCH,
  });
  let planned = 0;
  for (const lead of candidates) {
    if (lead.lastInboundAt && lead.lastInboundAt > lead.lastOutboundAt) continue; // our turn to reply
    if (planned >= 20) break; // bound model calls per sweep
    planned += 1;
    try {
      const res = await planFollowUp({ businessId: lead.businessId, leadId: lead.id, triggerDetail: 'Sweep: no follow-up planned after the last email' });
      if (res.followUpId) stats.scheduled += 1;
      else stats.skipped[res.code ?? res.decision] = (stats.skipped[res.code ?? res.decision] ?? 0) + 1;
    } catch (err) {
      logger.error({ err, leadId: lead.id }, 'Sweep could not plan follow-up');
    }
  }

  logger.info({ automation: 'SWEEP', ...stats }, 'Follow-up sweep finished');
  return stats;
}
