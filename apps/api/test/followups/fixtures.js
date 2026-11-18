import { prisma } from '../../src/lib/prisma.js';
import { getEmailProvider } from '../../src/email/index.js';
import { getQueues, QUEUES } from '../../src/queue/queues.js';
import { processSendMessage } from '../../src/jobs/sendMessage.js';
import { api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';

export const outbox = () => getEmailProvider().outbox;

/** A job-shaped object for calling processors directly. */
export function fakeJob(data, { attemptsMade = 0, attempts = 6 } = {}) {
  return { id: 'test-job', data, attemptsMade, opts: { attempts } };
}

export async function queuedJob(queue, jobId) {
  return getQueues()[queue].getJob(jobId);
}

export async function emailJobs() {
  return getQueues()[QUEUES.EMAIL].getJobs(['waiting', 'delayed']);
}

export async function followUpQueueJobs() {
  return getQueues()[QUEUES.FOLLOW_UPS].getJobs(['waiting', 'delayed']);
}

/**
 * Owner + business + consenting lead whose AI-drafted first reply is pending
 * approval (via the real orchestrator, mock AI).
 */
export async function leadWithDraftReply({ commsPrefs = {}, workingHours = {}, lead: leadOverrides = {} } = {}) {
  const owner = await registerOwner();
  await prisma.business.update({ where: { id: owner.businessId }, data: { commsPrefs, workingHours } });
  await seedServices(owner.businessId);
  const lead = await createLead(owner.token, {
    name: 'Daniel Okafor',
    email: 'daniel@example.com',
    enquiry: {
      channel: 'WEB_FORM',
      subject: 'Weekly mowing',
      message: 'Need weekly mowing and edging starting next week, budget around $300 a month. Can someone come out?',
    },
    ...leadOverrides,
  });
  const run = await startAgent(owner.token, lead.id);
  const approval = await prisma.approval.findFirst({ where: { leadId: lead.id, type: 'OUTBOUND_MESSAGE', status: 'PENDING' } });
  return { owner, lead, run: run.body, approval, messageId: approval?.messageId };
}

/** As above, then approve and deliver the first reply. */
export async function leadWithSentReply(options) {
  const ctx = await leadWithDraftReply(options);
  await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({});
  const result = await processSendMessage(fakeJob({ messageId: ctx.messageId, followUpId: null, scheduledFor: null }));
  const followUp = await prisma.followUpJob.findFirst({ where: { leadId: ctx.lead.id }, orderBy: { createdAt: 'desc' } });
  return { ...ctx, sendResult: result, followUp };
}

export async function events(leadId, type) {
  return prisma.leadEvent.findMany({ where: { leadId, ...(type && { type }) }, orderBy: { createdAt: 'asc' } });
}
