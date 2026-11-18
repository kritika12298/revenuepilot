import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { processDraftFollowUp } from '../../src/jobs/draftFollowUp.js';
import { processSendMessage } from '../../src/jobs/sendMessage.js';
import { QUEUES, sendJobId } from '../../src/queue/queues.js';
import { addMember, api, auth, createLead, registerOwner } from '../helpers.js';
import { fakeJob, leadWithDraftReply, leadWithSentReply, outbox, queuedJob } from './fixtures.js';

const HOUR = 3600e3;

async function pendingApprovalFollowUp() {
  const ctx = await leadWithSentReply();
  const drafted = await processDraftFollowUp(fakeJob({ followUpId: ctx.followUp.id }, { attempts: 3 }));
  const approval = await prisma.approval.findFirst({ where: { messageId: drafted.messageId } });
  return { ...ctx, messageId: drafted.messageId, approval };
}

describe('follow-up APIs', () => {
  it('lists and shows follow-ups with their draft and delivery', async () => {
    const ctx = await pendingApprovalFollowUp();
    const list = await api().get('/api/follow-ups?status=PENDING_APPROVAL').set(auth(ctx.owner.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ step: 1, lead: { name: 'Daniel Okafor' }, message: { status: 'PENDING_APPROVAL' } });

    const one = await api().get(`/api/follow-ups/${ctx.followUp.id}`).set(auth(ctx.owner.token));
    expect(one.body.message.approvals[0]).toMatchObject({ id: ctx.approval.id, status: 'PENDING' });
    expect((await api().get(`/api/follow-ups?leadId=${ctx.lead.id}&status=SENT`).set(auth(ctx.owner.token))).body.data).toEqual([]);
  });

  it('cancels a follow-up, withdrawing its draft and queue job', async () => {
    const ctx = await pendingApprovalFollowUp();
    const res = await api().post(`/api/follow-ups/${ctx.followUp.id}/cancel`).set(auth(ctx.owner.token)).send({ reason: 'Spoke on the phone' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', skipReason: 'Spoke on the phone', message: { status: 'CANCELLED' } });
    expect(await prisma.approval.findUnique({ where: { id: ctx.approval.id } })).toMatchObject({ status: 'EXPIRED' });

    // A cancelled draft can no longer be approved and sent.
    const late = await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({});
    expect(late.status).toBe(409);
    expect((await api().post(`/api/follow-ups/${ctx.followUp.id}/cancel`).set(auth(ctx.owner.token)).send({})).status).toBe(422);
  });

  it('reschedules into working hours and swaps the queued send job', async () => {
    const ctx = await pendingApprovalFollowUp();
    await prisma.business.update({
      where: { id: ctx.owner.businessId },
      data: { timezone: 'UTC', workingHours: { mon: [{ open: '09:00', close: '17:00' }] } },
    });
    await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({});
    const before = await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } });

    const target = new Date(Date.now() + 10 * 24 * HOUR);
    const res = await api()
      .post(`/api/follow-ups/${ctx.followUp.id}/reschedule`)
      .set(auth(ctx.owner.token))
      .send({ scheduledFor: target.toISOString() });
    expect(res.status).toBe(200);
    const when = new Date(res.body.scheduledFor);
    expect(when >= target).toBe(true);
    expect(when.getUTCDay()).toBe(1); // Monday
    expect(when.getUTCHours()).toBeGreaterThanOrEqual(9);

    expect(await queuedJob(QUEUES.EMAIL, sendJobId(ctx.messageId, before.scheduledFor))).toBeUndefined();
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(ctx.messageId, when))).toBeTruthy();

    // If the old job still fired, it would be recognised as stale.
    const stale = await processSendMessage(fakeJob({ messageId: ctx.messageId, followUpId: ctx.followUp.id, scheduledFor: before.scheduledFor.toISOString() }));
    expect(stale).toMatchObject({ outcome: 'NOOP', reason: 'Stale job: follow-up was rescheduled' });
    expect(outbox()).toHaveLength(1);
  });

  it('validates reschedule input', async () => {
    const ctx = await pendingApprovalFollowUp();
    const url = `/api/follow-ups/${ctx.followUp.id}/reschedule`;
    expect((await api().post(url).set(auth(ctx.owner.token)).send({})).status).toBe(400);
    expect((await api().post(url).set(auth(ctx.owner.token)).send({ delayHours: 2, scheduledFor: new Date().toISOString() })).status).toBe(400);
    const past = await api().post(url).set(auth(ctx.owner.token)).send({ scheduledFor: new Date(Date.now() - HOUR).toISOString() });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe('SCHEDULE_IN_PAST');
    const ok = await api().post(url).set(auth(ctx.owner.token)).send({ delayHours: 3, respectWorkingHours: false });
    expect(Math.abs(new Date(ok.body.scheduledFor) - Date.now() - 3 * HOUR)).toBeLessThan(10_000);
  });

  it('schedules a follow-up manually, with consent and duplicate checks', async () => {
    const ctx = await leadWithSentReply();
    const url = `/api/leads/${ctx.lead.id}/follow-ups`;
    expect((await api().post(url).set(auth(ctx.owner.token)).send({ delayHours: 1 })).status).toBe(409); // one is already active

    await api().post(`/api/follow-ups/${ctx.followUp.id}/cancel`).set(auth(ctx.owner.token)).send({});
    const res = await api().post(url).set(auth(ctx.owner.token)).send({ delayHours: 24, respectWorkingHours: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'DRAFTING', step: 1 });

    const noConsent = await createLead(ctx.owner.token, { name: 'No Consent', email: 'nc@example.com', consent: undefined });
    await api().patch(`/api/leads/${noConsent.id}/status`).set(auth(ctx.owner.token)).send({ status: 'QUALIFIED' });
    const refused = await api().post(`/api/leads/${noConsent.id}/follow-ups`).set(auth(ctx.owner.token)).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NO_CONSENT');
  });

  it('isolates follow-ups between businesses', async () => {
    const ctx = await pendingApprovalFollowUp();
    const other = await registerOwner();
    const id = ctx.followUp.id;
    expect((await api().get(`/api/follow-ups/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await api().post(`/api/follow-ups/${id}/cancel`).set(auth(other.token)).send({})).status).toBe(404);
    expect((await api().post(`/api/follow-ups/${id}/reschedule`).set(auth(other.token)).send({ delayHours: 5 })).status).toBe(404);
    expect((await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(other.token)).send({})).status).toBe(404);
    expect((await api().post(`/api/leads/${ctx.lead.id}/follow-ups`).set(auth(other.token)).send({})).status).toBe(404);
    expect((await api().get('/api/follow-ups').set(auth(other.token))).body.data).toEqual([]);
  });
});

describe('approval APIs', () => {
  it('lets owners edit while approving; members can view but not approve', async () => {
    const ctx = await leadWithDraftReply();
    const member = await addMember(ctx.owner.businessId);
    const list = await api().get('/api/approvals?status=PENDING&type=OUTBOUND_MESSAGE').set(auth(member.token));
    expect(list.body.data.map((a) => a.id)).toContain(ctx.approval.id);
    expect((await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(member.token)).send({})).status).toBe(403);

    const res = await api()
      .post(`/api/approvals/${ctx.approval.id}/approve`)
      .set(auth(ctx.owner.token))
      .send({ body: 'Hi Daniel, Maria here. Happy to help! What is the address?', note: 'Personal touch' });
    expect(res.body).toMatchObject({ status: 'APPROVED', decidedBy: { id: ctx.owner.userId }, payload: { edited: true } });
    expect(res.body.message.body).toBe('Hi Daniel, Maria here. Happy to help! What is the address?');
    expect((await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({})).status).toBe(409);
  });

  it('rejecting a follow-up draft cancels the follow-up', async () => {
    const ctx = await pendingApprovalFollowUp();
    const res = await api().post(`/api/approvals/${ctx.approval.id}/reject`).set(auth(ctx.owner.token)).send({ note: 'Too pushy' });
    expect(res.body).toMatchObject({ status: 'REJECTED', message: { status: 'REJECTED' } });
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({
      status: 'CANCELLED',
      skipReason: 'Draft rejected by owner',
    });
  });
});

describe('inbound email webhook', () => {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  const sign = (body, ts = Math.floor(Date.now() / 1000)) => ({
    'X-RevenuePilot-Timestamp': String(ts),
    'X-RevenuePilot-Signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`,
    'Content-Type': 'application/json',
  });

  it('matches replies by reply token, strips quoted text and stops follow-ups', async () => {
    const ctx = await pendingApprovalFollowUp();
    const lead = await prisma.lead.findUnique({ where: { id: ctx.lead.id } });
    const body = JSON.stringify({
      from: 'Daniel <daniel@example.com>',
      to: [`replies+${lead.replyToken}@in.revenuepilot.test`],
      subject: 'Re: Weekly mowing',
      text: 'Sounds good, the address is 12 Elm St.\n\nOn Tue, Maria wrote:\n> Hi Daniel...',
    });
    const res = await api().post('/api/webhooks/inbound-email').set(sign(body)).send(body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, matched: true, cancelledFollowUps: 1 });

    const inbound = await prisma.message.findFirst({ where: { direction: 'INBOUND', conversation: { leadId: lead.id } }, orderBy: { createdAt: 'desc' } });
    expect(inbound.body).toBe('Sounds good, the address is 12 Elm St.');
    expect(await prisma.followUpJob.findUnique({ where: { id: ctx.followUp.id } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('rejects bad or stale signatures and ignores unknown recipients', async () => {
    const body = JSON.stringify({ to: 'replies+00000000-0000-4000-8000-000000000000@in.revenuepilot.test', text: 'hi' });
    expect((await api().post('/api/webhooks/inbound-email').set({ ...sign(body), 'X-RevenuePilot-Signature': 'sha256=deadbeef' }).send(body)).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await api().post('/api/webhooks/inbound-email').set(sign(body, stale)).send(body)).status).toBe(401);
    const ok = await api().post('/api/webhooks/inbound-email').set(sign(body)).send(body);
    expect(ok.status).toBe(202);
    expect(ok.body.matched).toBe(false);
  });
});

describe('failed-job monitoring (ops)', () => {
  const opsAuth = { Authorization: `Bearer ${process.env.OPS_TOKEN}` };

  it('requires the ops token', async () => {
    expect((await api().get('/ops/queues')).status).toBe(401);
    const owner = await registerOwner();
    expect((await api().get('/ops/queues').set(auth(owner.token))).status).toBe(401);
  });

  it('reports queue counts', async () => {
    const res = await api().get('/ops/queues').set(opsAuth);
    expect(res.status).toBe(200);
    expect(res.body.queues.email.counts).toMatchObject({ failed: 0 });
    expect(res.body.queues['follow-ups'].counts).toBeDefined();
  });
});

describe('readiness', () => {
  it('checks database and Redis', async () => {
    const res = await api().get('/readyz');
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });
});
