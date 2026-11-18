import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import { nextWorkingTime } from '../../lib/workingHours.js';
import { enqueueSend } from '../../queue/queues.js';
import { logAutomation } from '../automation/audit.js';
import * as appointments from '../appointments/appointment.service.js';

const include = {
  lead: { select: { id: true, name: true, status: true, score: true } },
  message: {
    select: {
      id: true,
      subject: true,
      body: true,
      status: true,
      author: true,
      followUpJob: { select: { id: true, step: true, scheduledFor: true } },
    },
  },
  agentRun: { select: { id: true, kind: true, parentRun: { select: { id: true, output: true } } } },
  decidedBy: { select: { id: true, name: true } },
};

export async function list(ctx, { page, pageSize, status, type }) {
  const where = { businessId: ctx.businessId, ...(status && { status }), ...(type && { type }) };
  const [rows, total] = await Promise.all([
    prisma.approval.findMany({ where, orderBy: { createdAt: 'desc' }, include, ...toSkipTake({ page, pageSize }) }),
    prisma.approval.count({ where }),
  ]);
  return paginated(rows, total, { page, pageSize });
}

async function loadPending(tx, ctx, id) {
  const approval = await tx.approval.findFirst({ where: { id, businessId: ctx.businessId } });
  if (!approval) throw new NotFoundError('Approval');
  if (approval.status !== 'PENDING') throw new ConflictError(`Approval is already ${approval.status}`);
  return approval;
}

/**
 * Approves a pending item. For OUTBOUND_MESSAGE approvals this is the only way
 * a message becomes sendable; the owner may edit the text while approving.
 * Replies are queued for immediate delivery; follow-ups keep their schedule.
 */
export async function approve(ctx, id, { subject, body, note }, actor = { type: 'USER', userId: ctx.userId }) {
  // Appointments: confirm first (calendar event + DB). If the calendar write fails the
  // approval stays PENDING, so the owner can simply approve again (no stuck hold).
  const pending = await loadPending(prisma, ctx, id);
  if (pending.type === 'APPOINTMENT' && pending.payload?.appointmentId) {
    await appointments.confirm(ctx, pending.payload.appointmentId, actor);
  }
  const outcome = await prisma.$transaction(async (tx) => {
    const approval = await loadPending(tx, ctx, id);
    // Conditional update: two owners approving at once cannot both win.
    const { count } = await tx.approval.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        decidedById: actor.userId ?? null,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        payload: { ...(approval.payload ?? {}), edited: Boolean(subject || body) },
      },
    });
    if (!count) throw new ConflictError('Approval was decided by someone else');

    let send = null;
    if (approval.type === 'OUTBOUND_MESSAGE' && approval.messageId) {
      const message = await tx.message.findUnique({ where: { id: approval.messageId } });
      if (message.status !== 'PENDING_APPROVAL') {
        throw new ConflictError(`Message is ${message.status} and can no longer be approved`);
      }
      await tx.message.update({
        where: { id: message.id },
        data: { status: 'APPROVED', ...(subject && { subject }), ...(body && { body }) },
      });

      const followUp = await tx.followUpJob.findUnique({ where: { messageId: message.id } });
      if (followUp) {
        if (followUp.status !== 'PENDING_APPROVAL') {
          throw new ConflictError(`Follow-up is ${followUp.status}; it cannot be approved`);
        }
        const business = await tx.business.findUnique({ where: { id: ctx.businessId } });
        // If approval came after the planned time, send at the next working moment.
        const when =
          followUp.scheduledFor > new Date()
            ? followUp.scheduledFor
            : nextWorkingTime(new Date(Date.now() + 60e3), business.workingHours, business.timezone);
        await tx.followUpJob.update({ where: { id: followUp.id }, data: { status: 'SCHEDULED', scheduledFor: when } });
        send = { messageId: message.id, followUpId: followUp.id, scheduledFor: when };
      } else {
        send = { messageId: message.id };
      }
    }

    await logAutomation(
      {
        businessId: ctx.businessId,
        leadId: approval.leadId,
        type: 'APPROVAL_DECIDED',
        actor,
        data: { approvalId: id, type: approval.type, decision: 'APPROVED', edited: Boolean(subject || body), ...(send && { queuedSend: true }) },
      },
      tx,
    );
    return { send };
  });

  if (outcome.send) {
    try {
      const jobId = await enqueueSend(outcome.send);
      if (outcome.send.followUpId) {
        await prisma.followUpJob.update({ where: { id: outcome.send.followUpId }, data: { queueJobId: jobId } });
      }
    } catch (err) {
      logger.error({ err: { message: err.message }, approvalId: id }, 'Could not enqueue send; sweeper will retry');
    }
  }
  return prisma.approval.findUnique({ where: { id }, include });
}

export async function reject(ctx, id, { note }, actor = { type: 'USER', userId: ctx.userId }) {
  await prisma.$transaction(async (tx) => {
    const approval = await loadPending(tx, ctx, id);
    await tx.approval.update({
      where: { id },
      data: { status: 'REJECTED', decidedById: actor.userId ?? null, decidedAt: new Date(), decisionNote: note ?? null },
    });
    if (approval.type === 'APPOINTMENT' && approval.payload?.appointmentId) {
      await tx.appointment.updateMany({ where: { id: approval.payload.appointmentId, businessId: ctx.businessId, status: 'PROPOSED' }, data: { status: 'CANCELLED' } });
    }
    if (approval.messageId) {
      await tx.message.updateMany({ where: { id: approval.messageId, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } });
      await tx.followUpJob.updateMany({
        where: { messageId: approval.messageId, status: 'PENDING_APPROVAL' },
        data: { status: 'CANCELLED', skipReason: 'Draft rejected by owner' },
      });
    }
    await logAutomation(
      { businessId: ctx.businessId, leadId: approval.leadId, type: 'APPROVAL_DECIDED', actor, data: { approvalId: id, type: approval.type, decision: 'REJECTED' } },
      tx,
    );
  });
  return prisma.approval.findUnique({ where: { id }, include });
}
