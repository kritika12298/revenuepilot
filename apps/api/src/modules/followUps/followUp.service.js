import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import { nextWorkingTime } from '../../lib/workingHours.js';
import { enqueueDraft, enqueueSend, removeJob, draftJobId, sendJobId, QUEUES } from '../../queue/queues.js';
import { logAutomation } from '../automation/audit.js';
import { ACTIVE_FOLLOW_UP_STATUSES } from './followUp.repository.js';
import { checkFollowUpEligibility, followUpSettings } from './followUp.policy.js';

const HOUR = 3600e3;
const MIN_LEAD_TIME_MS = 60e3;

/**
 * Locks the lead row for the rest of the transaction. Every code path that
 * creates or changes follow-ups for a lead takes this lock, so the scheduler,
 * the sweeper and API calls cannot create duplicates concurrently.
 */
async function lockLead(tx, businessId, leadId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM leads WHERE id = ${leadId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

function enqueueSafely(fn, context) {
  return fn().catch((err) => {
    // The row is the source of truth; the sweeper re-enqueues anything missing.
    logger.error({ err: { message: err.message }, ...context }, 'Enqueue failed; sweeper will retry');
    return null;
  });
}

/**
 * Schedules the next follow-up for a lead.
 *
 * mode 'auto'   (after a send / by the sweeper): returns { scheduled: false, reason } when not applicable.
 * mode 'manual' (owner via API): throws a 4xx explaining why it cannot be scheduled.
 */
export async function scheduleNext(ctx, leadId, { mode = 'auto', scheduledFor, delayHours, respectWorkingHours = true, actor = { type: 'SYSTEM' } } = {}) {
  const manual = mode === 'manual';
  const skip = (code, reason) => {
    if (manual) {
      if (code === 'ACTIVE_FOLLOW_UP') throw new ConflictError(reason);
      throw new UnprocessableError(code, reason);
    }
    return { scheduled: false, code, reason };
  };

  const result = await prisma.$transaction(async (tx) => {
    if (!(await lockLead(tx, ctx.businessId, leadId))) throw new NotFoundError('Lead');
    const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { business: true } });

    const eligibility = checkFollowUpEligibility(lead, lead.business);
    if (!eligibility.ok) return skip(eligibility.code, eligibility.reason);

    const active = await tx.followUpJob.findFirst({
      where: { leadId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } },
    });
    if (active) return skip('ACTIVE_FOLLOW_UP', 'This lead already has an active follow-up');

    // The last message we sent is what this follow-up chases.
    const anchor = await tx.message.findFirst({
      where: { businessId: ctx.businessId, conversation: { leadId }, direction: 'OUTBOUND', status: 'SENT' },
      orderBy: { sentAt: 'desc' },
    });
    if (!manual) {
      if (!anchor) return skip('NOTHING_TO_FOLLOW_UP', 'We have not sent this lead anything yet');
      if (lead.lastInboundAt && lead.lastInboundAt > anchor.sentAt) {
        return skip('LEAD_REPLIED', 'The lead replied after our last message; they need an answer, not a follow-up');
      }
    }

    const settings = followUpSettings(lead.business);
    const sent = await tx.followUpJob.count({ where: { leadId, status: 'SENT' } });
    const step = sent + 1;
    if (step > settings.maxFollowUps) {
      return skip('MAX_FOLLOW_UPS_REACHED', `All ${settings.maxFollowUps} follow-ups have been sent`);
    }

    const now = Date.now();
    let base;
    if (scheduledFor) base = new Date(scheduledFor);
    else if (delayHours) base = new Date(now + delayHours * HOUR);
    else {
      const cadence = settings.cadenceHours[Math.min(step, settings.cadenceHours.length) - 1];
      base = new Date((anchor?.sentAt?.getTime() ?? now) + cadence * HOUR);
    }
    if (base.getTime() < now + MIN_LEAD_TIME_MS) base = new Date(now + MIN_LEAD_TIME_MS);
    const when = respectWorkingHours ? nextWorkingTime(base, lead.business.workingHours, lead.business.timezone) : base;

    const followUp = await tx.followUpJob.create({
      data: {
        businessId: ctx.businessId,
        leadId,
        step,
        scheduledFor: when,
        status: 'DRAFTING',
        anchorMessageId: anchor?.id ?? null,
        queueJobId: null,
      },
    });
    await logAutomation(
      {
        businessId: ctx.businessId,
        leadId,
        type: 'FOLLOW_UP_SCHEDULED',
        actor,
        data: { followUpId: followUp.id, step, scheduledFor: when.toISOString(), mode },
      },
      tx,
    );
    return { scheduled: true, followUp };
  });

  if (result.scheduled) {
    const jobId = await enqueueSafely(() => enqueueDraft(result.followUp.id), { followUpId: result.followUp.id });
    if (jobId) await prisma.followUpJob.update({ where: { id: result.followUp.id }, data: { queueJobId: jobId } });
  }
  return result;
}

// ---------------------------------------------------------------------------

const detailInclude = {
  lead: { select: { id: true, name: true, status: true, score: true, consentEmail: true } },
  message: {
    select: {
      id: true,
      subject: true,
      body: true,
      status: true,
      sentAt: true,
      delivery: { select: { status: true, provider: true, attempts: true, lastError: true, sentAt: true } },
      approvals: { where: { type: 'OUTBOUND_MESSAGE' }, select: { id: true, status: true } },
    },
  },
};

export async function list(ctx, { page, pageSize, status, leadId }) {
  const where = {
    businessId: ctx.businessId,
    ...(status && { status: { in: status } }),
    ...(leadId && { leadId }),
  };
  const [rows, total] = await Promise.all([
    prisma.followUpJob.findMany({ where, orderBy: { scheduledFor: 'asc' }, include: detailInclude, ...toSkipTake({ page, pageSize }) }),
    prisma.followUpJob.count({ where }),
  ]);
  return paginated(rows, total, { page, pageSize });
}

export async function get(ctx, id) {
  const row = await prisma.followUpJob.findFirst({ where: { id, businessId: ctx.businessId }, include: detailInclude });
  if (!row) throw new NotFoundError('Follow-up');
  return row;
}

async function loadActive(tx, ctx, id) {
  const row = await tx.followUpJob.findFirst({ where: { id, businessId: ctx.businessId } });
  if (!row) throw new NotFoundError('Follow-up');
  await lockLead(tx, ctx.businessId, row.leadId);
  const fresh = await tx.followUpJob.findUnique({ where: { id } });
  if (!ACTIVE_FOLLOW_UP_STATUSES.includes(fresh.status)) {
    throw new UnprocessableError('FOLLOW_UP_NOT_ACTIVE', `Follow-up is already ${fresh.status}`);
  }
  return fresh;
}

function jobRefs(followUp) {
  return [
    [QUEUES.FOLLOW_UPS, draftJobId(followUp.id)],
    ...(followUp.messageId ? [[QUEUES.EMAIL, sendJobId(followUp.messageId, followUp.scheduledFor)]] : []),
  ];
}

export async function cancel(ctx, id, { reason } = {}, actor = { type: 'USER', userId: ctx.userId }) {
  const cancelled = await prisma.$transaction(async (tx) => {
    const fu = await loadActive(tx, ctx, id);
    const skipReason = reason ?? 'Cancelled by owner';
    await tx.followUpJob.update({ where: { id }, data: { status: 'CANCELLED', skipReason } });
    if (fu.messageId) {
      // An approved-but-unsent draft must never go out after cancellation.
      await tx.message.updateMany({
        where: { id: fu.messageId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
        data: { status: 'CANCELLED' },
      });
      await tx.approval.updateMany({
        where: { messageId: fu.messageId, status: 'PENDING' },
        data: { status: 'EXPIRED', decisionNote: skipReason, decidedAt: new Date() },
      });
    }
    await logAutomation(
      { businessId: ctx.businessId, leadId: fu.leadId, type: 'FOLLOW_UP_CANCELLED', actor, data: { followUpId: id, reason: skipReason } },
      tx,
    );
    return fu;
  });
  await Promise.all(jobRefs(cancelled).map(([q, jobId]) => removeJob(q, jobId)));
  return get(ctx, id);
}

export async function reschedule(ctx, id, { scheduledFor, delayHours, respectWorkingHours = true }, actor = { type: 'USER', userId: ctx.userId }) {
  const { before, after } = await prisma.$transaction(async (tx) => {
    const fu = await loadActive(tx, ctx, id);
    const business = await tx.business.findUnique({ where: { id: ctx.businessId } });
    let when = scheduledFor ? new Date(scheduledFor) : new Date(Date.now() + delayHours * HOUR);
    if (when.getTime() < Date.now() + MIN_LEAD_TIME_MS) {
      throw new UnprocessableError('SCHEDULE_IN_PAST', 'The new time must be at least a minute in the future');
    }
    if (respectWorkingHours) when = nextWorkingTime(when, business.workingHours, business.timezone);

    const after = await tx.followUpJob.update({ where: { id }, data: { scheduledFor: when } });
    await logAutomation(
      {
        businessId: ctx.businessId,
        leadId: fu.leadId,
        type: 'FOLLOW_UP_RESCHEDULED',
        actor,
        data: { followUpId: id, from: fu.scheduledFor.toISOString(), to: when.toISOString() },
      },
      tx,
    );
    return { before: fu, after };
  });

  if (after.status === 'SCHEDULED' && after.messageId) {
    // The old job (if it still fires) sees a different scheduledFor and does nothing.
    await removeJob(QUEUES.EMAIL, sendJobId(before.messageId, before.scheduledFor));
    const jobId = await enqueueSafely(
      () => enqueueSend({ messageId: after.messageId, followUpId: id, scheduledFor: after.scheduledFor }),
      { followUpId: id },
    );
    if (jobId) await prisma.followUpJob.update({ where: { id }, data: { queueJobId: jobId } });
  }
  return get(ctx, id);
}

/**
 * Cancels every active follow-up for a lead (reply, opt-out, closed). Used
 * inside other transactions; returns the cancelled rows so the caller can
 * remove their queue jobs after commit.
 */
export async function cancelAllForLead(tx, { businessId, leadId, reason, actor = { type: 'SYSTEM' } }) {
  const active = await tx.followUpJob.findMany({ where: { businessId, leadId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } } });
  if (!active.length) return [];
  await tx.followUpJob.updateMany({
    where: { id: { in: active.map((f) => f.id) } },
    data: { status: 'CANCELLED', skipReason: reason },
  });
  const messageIds = active.map((f) => f.messageId).filter(Boolean);
  if (messageIds.length) {
    await tx.message.updateMany({
      where: { id: { in: messageIds }, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
    await tx.approval.updateMany({
      where: { messageId: { in: messageIds }, status: 'PENDING' },
      data: { status: 'EXPIRED', decisionNote: reason, decidedAt: new Date() },
    });
  }
  await logAutomation(
    { businessId, leadId, type: 'FOLLOW_UP_CANCELLED', actor, data: { count: active.length, reason, followUpIds: active.map((f) => f.id) } },
    tx,
  );
  return active;
}

export async function removeJobsFor(followUps) {
  await Promise.all(followUps.flatMap(jobRefs).map(([q, jobId]) => removeJob(q, jobId)));
}
