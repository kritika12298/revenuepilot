import { UnrecoverableError } from 'bullmq';
import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';
import { isWithinWorkingHours, nextWorkingTime } from '../lib/workingHours.js';
import { getEmailProvider } from '../email/index.js';
import { composeEmail } from '../email/compose.js';
import { EmailError } from '../email/errors.js';
import { enqueueSend } from '../queue/queues.js';
import { logAutomation } from '../modules/automation/audit.js';
import { checkSendPermission } from '../modules/followUps/followUp.policy.js';
import { cancelAllForLead, removeJobsFor } from '../modules/followUps/followUp.service.js';
import { planFollowUp } from './planFollowUp.js';
import { isFinalAttempt, notifyOwner } from './failures.js';
import { autoEmailsDelivered } from '../ai/policy/policyAgent.js';
import { getPolicy } from '../modules/autonomy/autonomy.service.js';

/** A SENDING claim older than this is assumed to belong to a crashed worker. */
const CLAIM_TIMEOUT_MS = 5 * 60e3;
const CONTACTED_FROM = new Set(['NEW', 'QUALIFYING', 'QUALIFIED']);

const done = (outcome, reason, extra = {}) => ({ outcome, reason, ...extra });

async function load(messageId) {
  return prisma.message.findUnique({
    where: { id: messageId },
    include: {
      conversation: { include: { lead: { include: { business: true } } } },
      followUpJob: true,
      delivery: true,
    },
  });
}

async function skipFollowUp(fu, reason, code) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.followUpJob.updateMany({
      where: { id: fu.id, status: 'SCHEDULED' },
      data: { status: 'SKIPPED', skipReason: reason },
    });
    if (count) {
      await tx.message.updateMany({ where: { id: fu.messageId, status: 'APPROVED' }, data: { status: 'CANCELLED' } });
      await logAutomation({ businessId: fu.businessId, leadId: fu.leadId, type: 'FOLLOW_UP_SKIPPED', data: { followUpId: fu.id, reason, code } }, tx);
    }
  });
}

async function blockReply(message, lead, reason, code) {
  await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({ where: { id: message.id, status: 'APPROVED' }, data: { status: 'FAILED' } });
    await logAutomation({ businessId: lead.businessId, leadId: lead.id, type: 'MESSAGE_FAILED', data: { messageId: message.id, reason, code } }, tx);
  });
}

/** Turns an automatic send back into a pending approval (daily limit reached). */
async function holdForApproval({ message, lead, fu, approval, limit }) {
  const note = `Held: the daily limit of ${limit} automatic emails was reached. Approve to send.`;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.message.updateMany({ where: { id: message.id, status: 'APPROVED' }, data: { status: 'PENDING_APPROVAL' } });
    if (!count) return;
    await tx.approval.update({ where: { id: approval.id }, data: { status: 'PENDING', decidedAt: null, decisionNote: note } });
    if (fu) await tx.followUpJob.updateMany({ where: { id: fu.id, status: 'SCHEDULED' }, data: { status: 'PENDING_APPROVAL' } });
    await logAutomation({ businessId: lead.businessId, leadId: lead.id, type: 'APPROVAL_REQUESTED', data: { messageId: message.id, approvalId: approval.id, reason: note, held: 'DAILY_LIMIT' } }, tx);
    await notifyOwner({ businessId: lead.businessId, leadId: lead.id, priority: 'URGENT', message: `${lead.name}: an automatic email was held because the daily limit (${limit}) was reached. Review it in Needs your approval.` }, tx);
  });
}

/**
 * Atomically claims the right to send. Only one worker can move a delivery
 * from PENDING (or an abandoned SENDING) to SENDING, so the same message is
 * never handed to the provider twice concurrently. The provider receives the
 * same idempotency key on every attempt, covering crashes after a send.
 */
async function claimDelivery({ message, lead, email, provider }) {
  await prisma.emailDelivery.upsert({
    where: { messageId: message.id },
    update: {},
    create: {
      businessId: lead.businessId,
      leadId: lead.id,
      messageId: message.id,
      idempotencyKey: email.idempotencyKey,
      provider: provider.name,
      toAddress: lead.email,
    },
  });
  const { count } = await prisma.emailDelivery.updateMany({
    where: {
      messageId: message.id,
      OR: [{ status: 'PENDING' }, { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } }],
    },
    data: { status: 'SENDING', attempts: { increment: 1 }, provider: provider.name },
  });
  if (count) return { claimed: true };
  const current = await prisma.emailDelivery.findUnique({ where: { messageId: message.id } });
  return { claimed: false, status: current.status };
}

/**
 * Delivers one approved message by email.
 *
 * Checks, in order: the message is approved and unsent; for follow-ups, that
 * the job is current, the lead has not replied and it is within working
 * hours; consent and communication permissions; then claims the delivery and
 * calls the provider. Every decision is logged on the lead timeline.
 */
export async function processSendMessage(job) {
  const { messageId, followUpId, scheduledFor } = job.data;
  const message = await load(messageId);
  if (!message) return done('SKIPPED', 'Message no longer exists');
  if (message.status === 'SENT' || message.delivery?.status === 'SENT') return done('NOOP', 'Already sent');
  if (message.status !== 'APPROVED') return done('SKIPPED', `Message is ${message.status}, not APPROVED`);

  const { lead } = message.conversation;
  const { business } = lead;
  const fu = message.followUpJob;
  const kind = fu ? 'FOLLOW_UP' : 'REPLY';

  if (fu) {
    if (followUpId && fu.id !== followUpId) return done('SKIPPED', 'Job does not match follow-up');
    if (fu.status !== 'SCHEDULED') return done('NOOP', `Follow-up is ${fu.status}`);
    if (scheduledFor && fu.scheduledFor.toISOString() !== scheduledFor) {
      return done('NOOP', 'Stale job: follow-up was rescheduled');
    }
    if (lead.lastInboundAt && lead.lastInboundAt > fu.createdAt) {
      const cancelled = await prisma.$transaction((tx) =>
        cancelAllForLead(tx, { businessId: lead.businessId, leadId: lead.id, reason: 'Lead replied' }),
      );
      await removeJobsFor(cancelled.filter((c) => c.id !== fu.id));
      return done('CANCELLED', 'Lead replied');
    }
  }

  const leadHasWritten = (await prisma.message.count({ where: { conversation: { leadId: lead.id }, direction: 'INBOUND' } })) > 0;
  const permission = checkSendPermission({ lead, business, kind, leadHasWritten });
  if (!permission.ok) {
    if (fu) await skipFollowUp(fu, permission.reason, permission.code);
    else await blockReply(message, lead, permission.reason, permission.code);
    return done('BLOCKED', permission.reason, { code: permission.code });
  }

  // Daily limit, re-checked at send time for automatic sends (approved by policy, not a person):
  // scheduled follow-ups approved on different days can otherwise all fire on the same day.
  if (!message.delivery) {
    const autoApproval = await prisma.approval.findFirst({ where: { messageId: message.id, type: 'OUTBOUND_MESSAGE', status: 'APPROVED', decidedById: null } });
    if (autoApproval) {
      const policy = await getPolicy(lead.businessId);
      const delivered = await autoEmailsDelivered(lead.businessId);
      if (delivered >= policy.maxAutoEmailsPerDay) {
        await holdForApproval({ message, lead, fu, approval: autoApproval, limit: policy.maxAutoEmailsPerDay });
        return done('HELD', 'Daily automatic email limit reached; waiting for owner approval');
      }
    }
  }

  // Follow-ups only go out during working hours; move late jobs forward.
  if (fu && !isWithinWorkingHours(new Date(), business.workingHours, business.timezone)) {
    const when = nextWorkingTime(new Date(), business.workingHours, business.timezone);
    const moved = await prisma.followUpJob.updateMany({
      where: { id: fu.id, status: 'SCHEDULED', scheduledFor: fu.scheduledFor },
      data: { scheduledFor: when },
    });
    if (moved.count) {
      await logAutomation({
        businessId: lead.businessId,
        leadId: lead.id,
        type: 'FOLLOW_UP_RESCHEDULED',
        data: { followUpId: fu.id, from: fu.scheduledFor.toISOString(), to: when.toISOString(), reason: 'Outside working hours' },
      });
      const jobId = await enqueueSend({ messageId, followUpId: fu.id, scheduledFor: when });
      await prisma.followUpJob.update({ where: { id: fu.id }, data: { queueJobId: jobId } });
    }
    return done('RESCHEDULED', 'Outside working hours', { scheduledFor: when.toISOString() });
  }

  const owner = await prisma.membership.findFirst({
    where: { businessId: business.id, role: 'OWNER' },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { email: true } } },
  });
  const provider = getEmailProvider();
  const email = composeEmail({ business, lead, message, ownerEmail: owner?.user.email });

  const claim = await claimDelivery({ message, lead, email, provider });
  if (!claim.claimed) {
    if (claim.status === 'SENT') return done('NOOP', 'Already sent');
    if (claim.status === 'SENDING') throw new Error('Delivery is in progress in another worker'); // retry later
    return done('SKIPPED', `Delivery is ${claim.status}`);
  }

  let result;
  try {
    result = await provider.send(email);
  } catch (err) {
    const retryable = err instanceof EmailError ? err.retryable : true;
    const reason = err.message.slice(0, 500);
    if (retryable && !isFinalAttempt(job)) {
      await prisma.emailDelivery.update({ where: { messageId }, data: { status: 'PENDING', lastError: reason } });
      logger.warn({ messageId, attempt: job.attemptsMade + 1, err: { message: reason } }, 'Email send failed; will retry');
      throw err;
    }
    await prisma.$transaction(async (tx) => {
      await tx.emailDelivery.update({ where: { messageId }, data: { status: 'FAILED', lastError: reason } });
      await tx.message.update({ where: { id: messageId }, data: { status: 'FAILED' } });
      if (fu) await tx.followUpJob.update({ where: { id: fu.id }, data: { status: 'FAILED', lastError: reason } });
      await logAutomation(
        { businessId: lead.businessId, leadId: lead.id, type: fu ? 'FOLLOW_UP_FAILED' : 'MESSAGE_FAILED', data: { messageId, reason, attempts: job.attemptsMade + 1 } },
        tx,
      );
      await notifyOwner({ businessId: lead.businessId, leadId: lead.id, priority: 'URGENT', message: `An email to ${lead.name} could not be delivered: ${reason}` }, tx);
    });
    throw new UnrecoverableError(`Email delivery failed permanently: ${reason}`);
  }

  const sentAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.emailDelivery.update({
      where: { messageId },
      data: { status: 'SENT', providerMessageId: result.id, sentAt, lastError: null },
    });
    await tx.message.update({ where: { id: messageId }, data: { status: 'SENT', sentAt } });
    await tx.lead.update({
      where: { id: lead.id },
      data: { lastOutboundAt: sentAt, lastContactAt: sentAt, ...(!lead.firstResponseAt && { firstResponseAt: sentAt }) },
    });
    if (fu) await tx.followUpJob.update({ where: { id: fu.id }, data: { status: 'SENT' } });
    await logAutomation(
      {
        businessId: lead.businessId,
        leadId: lead.id,
        type: 'MESSAGE_SENT',
        data: { messageId, kind, followUpId: fu?.id ?? null, provider: provider.name, providerMessageId: result.id },
      },
      tx,
    );
    const moved = await tx.lead.updateMany({
      where: { id: lead.id, status: { in: [...CONTACTED_FROM] } },
      data: { status: 'CONTACTED' },
    });
    if (moved.count) {
      await logAutomation({ businessId: lead.businessId, leadId: lead.id, type: 'STATUS_CHANGED', data: { from: lead.status, to: 'CONTACTED', reason: 'Email sent' } }, tx);
    }
  });

  // The Follow-up Agent decides whether and when to follow up.
  const plan = await planFollowUp({
    businessId: lead.businessId,
    leadId: lead.id,
    triggerDetail: `${kind === 'FOLLOW_UP' ? `Follow-up ${fu.step}` : 'Email'} sent to ${lead.name}`,
  });
  return done('SENT', null, {
    providerMessageId: result.id,
    nextFollowUp: plan.followUpId,
    nextFollowUpSkipped: plan.followUpId ? undefined : plan.code,
  });
}
