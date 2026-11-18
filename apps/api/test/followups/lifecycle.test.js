import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { processSendMessage } from '../../src/jobs/sendMessage.js';
import { processDraftFollowUp } from '../../src/jobs/draftFollowUp.js';
import { processSweep } from '../../src/jobs/sweep.js';
import { scheduleNext } from '../../src/modules/followUps/followUp.service.js';
import { getEmailProvider } from '../../src/email/index.js';
import { setAIClient } from '../../src/ai/client.js';
import { AIError } from '../../src/ai/errors.js';
import { draftJobId, QUEUES, sendJobId } from '../../src/queue/queues.js';
import { isWithinWorkingHours } from '../../src/lib/workingHours.js';
import { api, auth } from '../helpers.js';
import { scriptedClient, text } from '../ai/scripted.js';
import { events, fakeJob, leadWithDraftReply, leadWithSentReply, outbox, queuedJob } from './fixtures.js';

const HOUR = 3600e3;
const approve = (ctx, approvalId, body = {}) => api().post(`/api/approvals/${approvalId}/approve`).set(auth(ctx.owner.token)).send(body);

/** Drafts and approves the pending follow-up; returns its send job data. */
async function draftAndApprove(ctx, followUpId) {
  const drafted = await processDraftFollowUp(fakeJob({ followUpId }, { attempts: 3 }));
  expect(drafted.outcome).toBe('PENDING_APPROVAL');
  const approval = await prisma.approval.findFirst({ where: { messageId: drafted.messageId } });
  await approve(ctx, approval.id);
  const fu = await prisma.followUpJob.findUnique({ where: { id: followUpId } });
  return { fu, messageId: drafted.messageId, job: { messageId: drafted.messageId, followUpId, scheduledFor: fu.scheduledFor.toISOString() } };
}

describe('sending an approved reply', () => {
  it('queues on approval, emails exactly once with compliance headers, and schedules the first follow-up', async () => {
    const ctx = await leadWithDraftReply();
    const approved = await approve(ctx, ctx.approval.id);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', message: { status: 'APPROVED' } });
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(ctx.messageId, null))).toBeTruthy();

    const result = await processSendMessage(fakeJob({ messageId: ctx.messageId, followUpId: null, scheduledFor: null }));
    expect(result.outcome).toBe('SENT');

    const lead = await prisma.lead.findUnique({ where: { id: ctx.lead.id } });
    expect(outbox()).toHaveLength(1);
    const [email] = outbox();
    expect(email).toMatchObject({
      to: 'daniel@example.com',
      from: expect.stringMatching(/^Test Business \d+ <hello@revenuepilot\.test>$/),
      replyTo: `replies+${lead.replyToken}@in.revenuepilot.test`,
      idempotencyKey: `msg-${ctx.messageId}`,
      headers: {
        'List-Unsubscribe': `<https://api.revenuepilot.test/u/${lead.unsubscribeToken}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(email.text).toContain(`https://api.revenuepilot.test/u/${lead.unsubscribeToken}`);

    expect(await prisma.emailDelivery.findUnique({ where: { messageId: ctx.messageId } })).toMatchObject({
      status: 'SENT',
      provider: 'mock',
      attempts: 1,
      providerMessageId: email.id,
    });
    expect(lead).toMatchObject({ status: 'CONTACTED' });
    expect(lead.lastOutboundAt).toBeTruthy();
    expect(lead.firstResponseAt).toBeTruthy();

    // Default cadence: first follow-up 48h after the send, queued for drafting.
    const fu = await prisma.followUpJob.findFirst({ where: { leadId: ctx.lead.id } });
    expect(fu).toMatchObject({ status: 'DRAFTING', step: 1, anchorMessageId: ctx.messageId });
    expect(Math.abs(fu.scheduledFor - lead.lastOutboundAt - 48 * HOUR)).toBeLessThan(5000);
    expect(await queuedJob(QUEUES.FOLLOW_UPS, draftJobId(fu.id))).toBeTruthy();

    const types = (await events(ctx.lead.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['APPROVAL_DECIDED', 'MESSAGE_SENT', 'STATUS_CHANGED', 'FOLLOW_UP_SCHEDULED']));
  });

  it('never emails twice: duplicate jobs and crash-retries are absorbed by idempotency keys', async () => {
    const ctx = await leadWithSentReply();
    const job = fakeJob({ messageId: ctx.messageId, followUpId: null, scheduledFor: null });

    expect((await processSendMessage(job)).outcome).toBe('NOOP');

    // Simulate a crash after the provider accepted the email but before we
    // recorded it: the DB says "not sent", the provider has already sent it.
    await prisma.message.update({ where: { id: ctx.messageId }, data: { status: 'APPROVED', sentAt: null } });
    await prisma.emailDelivery.update({ where: { messageId: ctx.messageId }, data: { status: 'SENDING', updatedAt: new Date(Date.now() - 10 * 60e3) } });
    expect((await processSendMessage(job)).outcome).toBe('SENT');

    expect(outbox()).toHaveLength(1); // provider deduplicated on the same key
    expect(await prisma.emailDelivery.findUnique({ where: { messageId: ctx.messageId } })).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('refuses to send messages that were never approved', async () => {
    const ctx = await leadWithDraftReply();
    const result = await processSendMessage(fakeJob({ messageId: ctx.messageId }));
    expect(result).toMatchObject({ outcome: 'SKIPPED', reason: 'Message is PENDING_APPROVAL, not APPROVED' });
    expect(outbox()).toHaveLength(0);
  });
});

describe('follow-up drafting and sending', () => {
  it('drafts a personalised follow-up from the lead context and waits for approval', async () => {
    const ctx = await leadWithSentReply();
    const result = await processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attempts: 3 }));
    expect(result.outcome).toBe('PENDING_APPROVAL');

    const fu = await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } });
    expect(fu).toMatchObject({ status: 'PENDING_APPROVAL', messageId: result.messageId });
    const run = await prisma.agentRun.findUnique({ where: { id: fu.draftRunId } });
    expect(run).toMatchObject({ kind: 'CONVERSATION', trigger: 'SYSTEM', status: 'SUCCEEDED', input: { goal: 'FOLLOW_UP' } });

    const message = await prisma.message.findUnique({ where: { id: result.messageId } });
    expect(message).toMatchObject({ author: 'AI', status: 'PENDING_APPROVAL' });
    expect(message.body).toMatch(/^Hi Daniel,/);
    expect(message.body).toContain('weekly lawn maintenance');
    const approval = await prisma.approval.findFirst({ where: { messageId: message.id } });
    expect(approval.payload).toMatchObject({ followUpId: fu.id });
    expect((await events(ctx.lead.id, 'FOLLOW_UP_DRAFTED')).length).toBe(1);
    expect(outbox()).toHaveLength(1); // nothing new sent
  });

  it('sends an approved follow-up at its scheduled time, then plans the next step', async () => {
    const ctx = await leadWithSentReply();
    const { fu, messageId, job } = await draftAndApprove(ctx, ctx.followUp.id);
    expect(fu.status).toBe('SCHEDULED');

    const queued = await queuedJob(QUEUES.EMAIL, sendJobId(messageId, fu.scheduledFor));
    expect(await queued.getState()).toBe('delayed');
    expect(Math.abs(queued.delay - (fu.scheduledFor - Date.now()))).toBeLessThan(5000);

    expect((await processSendMessage(fakeJob(job))).outcome).toBe('SENT');
    expect(outbox()).toHaveLength(2);
    expect(await prisma.followUpJob.findUnique({ where: { id: fu.id } })).toMatchObject({ status: 'SENT' });

    const next = await prisma.followUpJob.findFirst({ where: { leadId: ctx.lead.id, status: 'DRAFTING' } });
    expect(next).toMatchObject({ step: 2, anchorMessageId: messageId });
    const sentAt = (await prisma.message.findUnique({ where: { id: messageId } })).sentAt;
    expect(Math.abs(next.scheduledFor - sentAt - 96 * HOUR)).toBeLessThan(5000);
  });

  it('uses the business cadence and stops after maxFollowUps', async () => {
    const ctx = await leadWithSentReply({ commsPrefs: { followUpCadenceHours: [6], maxFollowUps: 1 } });
    const lead = await prisma.lead.findUnique({ where: { id: ctx.lead.id } });
    expect(Math.abs(ctx.followUp.scheduledFor - lead.lastOutboundAt - 6 * HOUR)).toBeLessThan(5000);

    const { job } = await draftAndApprove(ctx, ctx.followUp.id);
    const sent = await processSendMessage(fakeJob(job));
    expect(sent).toMatchObject({ outcome: 'SENT', nextFollowUp: null, nextFollowUpSkipped: 'MAX_FOLLOW_UPS_REACHED' });
  });

  it('auto-approves follow-ups only when the business opted in', async () => {
    const ctx = await leadWithSentReply({ commsPrefs: { autoApproveFollowUps: true } });
    const result = await processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attempts: 3 }));
    expect(result).toMatchObject({ outcome: 'SCHEDULED', autoApproved: true });
    const approval = await prisma.approval.findFirst({ where: { messageId: result.messageId } });
    expect(approval).toMatchObject({ status: 'APPROVED', decidedById: null, decisionNote: expect.stringContaining('Auto-approved') });
  });

  it('does not AI-draft automatic follow-ups when "write replies automatically" is off, and tells the owner', async () => {
    const ctx = await leadWithSentReply();
    await prisma.autonomyPolicy.update({ where: { businessId: ctx.owner.businessId }, data: { autoGenerateResponses: false } });
    const result = await processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attempts: 3 }));
    expect(result).toMatchObject({ outcome: 'SKIPPED' });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({ status: 'SKIPPED', messageId: null });
    expect(await prisma.agentRun.count({ where: { leadId: ctx.lead.id, kind: 'CONVERSATION', input: { path: ['goal'], equals: 'FOLLOW_UP' } } })).toBe(0);
    expect(await prisma.notification.findFirst({ where: { leadId: ctx.lead.id, message: { contains: 'Automatic responses are off' } } })).toBeTruthy();
  });

  it('auto-approves a follow-up that quotes published prices (the policy sees the real price list)', async () => {
    const ctx = await leadWithSentReply();
    await prisma.autonomyPolicy.update({ where: { businessId: ctx.owner.businessId }, data: { autoApproveFollowUps: true } });
    const { evaluatePolicy } = await import('../../src/ai/policy/policyAgent.js');
    const lead = await prisma.lead.findUnique({ where: { id: ctx.lead.id }, include: { business: true } });
    const services = await prisma.service.findMany({ where: { businessId: lead.businessId, active: true } });
    const text = 'Just checking in: weekly lawn maintenance is $45–$85 per visit.';
    const withPrices = await evaluatePolicy({ type: 'SEND_EMAIL', kind: 'FOLLOW_UP', lead, business: lead.business, leadHasWritten: true, text, services }, { businessId: lead.businessId, leadId: lead.id });
    expect(withPrices.verdict).toBe('ALLOW');
    const withoutPrices = await evaluatePolicy({ type: 'SEND_EMAIL', kind: 'FOLLOW_UP', lead, business: lead.business, leadHasWritten: true, text, services: [] }, { businessId: lead.businessId, leadId: lead.id });
    expect(withoutPrices.verdict).toBe('BLOCK'); // why the job must pass the real list
  });

  it('cancel_followup: the Follow-up Agent can cancel its own lead\'s follow-up, never another business\'s', async () => {
    const ctx = await leadWithSentReply();
    const other = await leadWithSentReply();
    const { toolUse, toolResultsIn } = await import('../ai/scripted.js');
    const { runAgent } = await import('../../src/ai/runAgent.js');
    const { followUpPlannerAgent } = await import('../../src/ai/agents/followUpPlanner.js');
    const ai = scriptedClient([
      () => [toolUse('cancel_followup', { lead_id: ctx.lead.id, follow_up_id: other.followUp.id, reason: 'Trying another tenant' })],
      (req) => {
        expect(toolResultsIn(req)[0].payload).toMatchObject({ error: 'NOT_FOUND' });
        return [toolUse('cancel_followup', { lead_id: ctx.lead.id, follow_up_id: ctx.followUp.id, reason: 'Lead asked us to wait until spring' })];
      },
      (req) => {
        expect(toolResultsIn(req)[0].payload).toMatchObject({ cancelled: true });
        return [toolUse('record_follow_up_decision', { lead_id: ctx.lead.id, decision: 'WAIT', reason: 'Lead asked us to wait until spring' })];
      },
      () => [text('Cancelled the follow-up; waiting as the lead asked.')],
    ]);
    setAIClient(ai);
    const { run } = await runAgent(followUpPlannerAgent, { businessId: ctx.owner.businessId, leadId: ctx.lead.id, trigger: 'SYSTEM', input: {} });
    expect(run.status).toBe('SUCCEEDED');
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await prisma.followUpJob.findUnique({ where: { id: other.followUp.id } })).status).not.toBe('CANCELLED');
    const audit = await prisma.agentToolCall.findMany({ where: { agentRunId: run.id, toolName: 'cancel_followup' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((c) => c.outcome)).toEqual(['POLICY_BLOCKED', 'EXECUTED']);
  });

  it('schedules and sends only within working hours', async () => {
    // Open only on a day that is not today (UTC), 09:00-10:00.
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const openDay = days[(new Date().getUTCDay() + 3) % 7];
    const workingHours = { [openDay]: [{ open: '09:00', close: '10:00' }] };
    const ctx = await leadWithSentReply({ workingHours });

    expect(isWithinWorkingHours(ctx.followUp.scheduledFor, workingHours, 'UTC')).toBe(true);

    // Owner forces an immediate send time; the worker must defer it to opening hours.
    const { fu, messageId } = await draftAndApprove(ctx, ctx.followUp.id);
    const now = new Date();
    await prisma.followUpJob.update({ where: { id: fu.id }, data: { scheduledFor: now } });
    const result = await processSendMessage(fakeJob({ messageId, followUpId: fu.id, scheduledFor: now.toISOString() }));
    expect(result.outcome).toBe('RESCHEDULED');
    expect(outbox()).toHaveLength(1);
    const moved = await prisma.followUpJob.findUnique({ where: { id: fu.id } });
    expect(isWithinWorkingHours(moved.scheduledFor, workingHours, 'UTC')).toBe(true);
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(messageId, moved.scheduledFor))).toBeTruthy();
    expect((await events(ctx.lead.id, 'FOLLOW_UP_RESCHEDULED'))[0].data).toMatchObject({ reason: 'Outside working hours' });
  });
});

describe('stopping follow-ups', () => {
  async function scheduledFollowUp(options) {
    const ctx = await leadWithSentReply(options);
    const approved = await draftAndApprove(ctx, ctx.followUp.id);
    return { ...ctx, ...approved };
  }

  it('stops when the customer replies', async () => {
    const ctx = await scheduledFollowUp();
    const res = await api()
      .post(`/api/leads/${ctx.lead.id}/messages/inbound`)
      .set(auth(ctx.owner.token))
      .send({ body: 'Thanks! Tuesday works for us.' });
    expect(res.status).toBe(201);
    expect(res.body.cancelledFollowUps).toBe(1);

    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.fu.id } })).toMatchObject({ status: 'CANCELLED', skipReason: 'Lead replied' });
    expect(await prisma.message.findUnique({ where: { id: ctx.messageId } })).toMatchObject({ status: 'CANCELLED' });
    expect((await prisma.lead.findUnique({ where: { id: ctx.lead.id } })).status).toBe('ENGAGED');
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(ctx.messageId, ctx.fu.scheduledFor))).toBeUndefined();

    // Even if the queued job had already been picked up, nothing is sent.
    expect((await processSendMessage(fakeJob(ctx.job))).outcome).toBe('SKIPPED');
    expect(outbox()).toHaveLength(1);
  });

  it('stops when the customer unsubscribes, and blocks any later reply', async () => {
    const ctx = await scheduledFollowUp();
    const lead = await prisma.lead.findUnique({ where: { id: ctx.lead.id } });

    const page = await api().get(`/u/${lead.unsubscribeToken}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form method="post"');
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('CONTACTED'); // GET alone does nothing

    const res = await api().post(`/u/${lead.unsubscribeToken}`).type('form').send({ 'List-Unsubscribe': 'One-Click' });
    expect(res.status).toBe(200);
    const after = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(after).toMatchObject({ status: 'OPTED_OUT', consentEmail: false });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.fu.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await processSendMessage(fakeJob(ctx.job))).outcome).not.toBe('SENT');

    // An owner-approved reply to an opted-out lead is blocked at send time.
    const conv = await prisma.conversation.findFirst({ where: { leadId: lead.id } });
    const reply = await prisma.message.create({
      data: { businessId: lead.businessId, conversationId: conv.id, direction: 'OUTBOUND', author: 'OWNER', body: 'One more thing...', status: 'APPROVED' },
    });
    expect(await processSendMessage(fakeJob({ messageId: reply.id }))).toMatchObject({ outcome: 'BLOCKED', code: 'OPTED_OUT' });
    expect(outbox()).toHaveLength(1);

    expect((await api().post(`/u/${lead.unsubscribeToken}`)).status).toBe(200); // idempotent
    expect((await api().post('/u/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('stops when the lead is closed', async () => {
    const ctx = await scheduledFollowUp();
    await api().patch(`/api/leads/${ctx.lead.id}/status`).set(auth(ctx.owner.token)).send({ status: 'LOST', lostReason: 'TIMING' });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.fu.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await processSendMessage(fakeJob(ctx.job))).outcome).toBe('SKIPPED');
    expect(outbox()).toHaveLength(1);
  });

  it('re-checks consent at the moment of sending', async () => {
    const ctx = await scheduledFollowUp();
    // Consent removed behind the scheduler's back (e.g. a direct DB/CRM sync).
    await prisma.lead.update({ where: { id: ctx.lead.id }, data: { consentEmail: false } });
    const result = await processSendMessage(fakeJob(ctx.job));
    expect(result).toMatchObject({ outcome: 'BLOCKED', code: 'NO_CONSENT' });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.fu.id } })).toMatchObject({ status: 'SKIPPED' });
    expect((await events(ctx.lead.id, 'FOLLOW_UP_SKIPPED'))[0].data).toMatchObject({ code: 'NO_CONSENT' });
    expect(outbox()).toHaveLength(1);
  });

  it('never schedules follow-ups without consent', async () => {
    const ctx = await leadWithDraftReply({ lead: { consent: { email: false, source: 'n/a' } } });
    await approve(ctx, ctx.approval.id);
    // The reply itself is allowed: the lead wrote to us first.
    const sent = await processSendMessage(fakeJob({ messageId: ctx.messageId }));
    expect(sent).toMatchObject({ outcome: 'SENT', nextFollowUpSkipped: 'NO_CONSENT' });
    expect(await prisma.followUpJob.count({ where: { leadId: ctx.lead.id } })).toBe(0);
  });
});

describe('retries and failures', () => {
  it('retries transient provider errors and succeeds without duplicates', async () => {
    const ctx = await leadWithDraftReply();
    await approve(ctx, ctx.approval.id);
    getEmailProvider().failNext(1, { retryable: true });
    const job = fakeJob({ messageId: ctx.messageId });

    await expect(processSendMessage(job)).rejects.toThrow('Simulated provider failure');
    expect(await prisma.emailDelivery.findUnique({ where: { messageId: ctx.messageId } })).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Simulated provider failure',
    });

    expect((await processSendMessage({ ...job, attemptsMade: 1 })).outcome).toBe('SENT');
    expect(outbox()).toHaveLength(1);
  });

  it('fails permanently on non-retryable errors, alerts the owner and records it', async () => {
    const ctx = await leadWithDraftReply();
    await approve(ctx, ctx.approval.id);
    getEmailProvider().failNext(1, { retryable: false, code: 'VALIDATION_ERROR' });

    await expect(processSendMessage(fakeJob({ messageId: ctx.messageId }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await prisma.message.findUnique({ where: { id: ctx.messageId } })).toMatchObject({ status: 'FAILED' });
    expect(await prisma.emailDelivery.findUnique({ where: { messageId: ctx.messageId } })).toMatchObject({ status: 'FAILED' });
    const note = await prisma.notification.findFirst({ where: { leadId: ctx.lead.id, priority: 'URGENT', reason: 'OTHER' } });
    expect(note.message).toContain('could not be delivered');
    expect((await events(ctx.lead.id, 'MESSAGE_FAILED')).length).toBe(1);
  });

  it('gives up on transient errors after the last attempt', async () => {
    const ctx = await leadWithDraftReply();
    await approve(ctx, ctx.approval.id);
    getEmailProvider().failNext(1, { retryable: true });
    await expect(processSendMessage(fakeJob({ messageId: ctx.messageId }, { attemptsMade: 5, attempts: 6 }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(await prisma.message.findUnique({ where: { id: ctx.messageId } })).toMatchObject({ status: 'FAILED' });
  });

  it('retries drafting on AI outages, and fails visibly when the AI cannot produce a draft', async () => {
    const ctx = await leadWithSentReply();

    setAIClient({ mode: 'live', model: 'x', createMessage: async () => { throw new AIError('AI_UNAVAILABLE', 'down', { status: 503, retryable: true }); } });
    await expect(processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attempts: 3 }))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({ status: 'DRAFTING' });

    setAIClient(scriptedClient([() => [text('No.')], () => [text('Still no.')]]));
    await expect(processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attemptsMade: 1, attempts: 3 }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({ status: 'FAILED' });
    expect(await prisma.notification.count({ where: { leadId: ctx.lead.id, reason: 'OTHER' } })).toBe(1);
  });
});

describe('scheduler safety', () => {
  it('creates at most one follow-up under concurrent scheduling', async () => {
    const ctx = await leadWithSentReply();
    await prisma.followUpJob.deleteMany({ where: { leadId: ctx.lead.id } });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => scheduleNext({ businessId: ctx.owner.businessId }, ctx.lead.id, { mode: 'auto' })),
    );
    expect(results.filter((r) => r.scheduled)).toHaveLength(1);
    expect(results.filter((r) => r.code === 'ACTIVE_FOLLOW_UP')).toHaveLength(4);
    expect(await prisma.followUpJob.count({ where: { leadId: ctx.lead.id } })).toBe(1);
  });

  it('the sweeper schedules missing follow-ups and restores lost queue jobs, idempotently', async () => {
    const ctx = await leadWithSentReply();
    await prisma.followUpJob.deleteMany({ where: { leadId: ctx.lead.id } });

    const first = await processSweep();
    expect(first.scheduled).toBe(1);
    expect((await processSweep()).scheduled).toBe(0);
    expect(await prisma.followUpJob.count({ where: { leadId: ctx.lead.id } })).toBe(1);

    // Approve it, then lose its queue job (e.g. Redis was flushed).
    const fu = await prisma.followUpJob.findFirst({ where: { leadId: ctx.lead.id } });
    const { messageId, fu: scheduled } = await draftAndApprove(ctx, fu.id);
    await (await queuedJob(QUEUES.EMAIL, sendJobId(messageId, scheduled.scheduledFor))).remove();
    await processSweep();
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(messageId, scheduled.scheduledFor))).toBeTruthy();
  });

  it('the sweeper leaves leads alone when it is our turn to reply', async () => {
    const ctx = await leadWithSentReply();
    await api().post(`/api/leads/${ctx.lead.id}/messages/inbound`).set(auth(ctx.owner.token)).send({ body: 'Question for you' });
    expect((await processSweep()).scheduled).toBe(0);
  });
});
