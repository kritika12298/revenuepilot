import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { startWorkers } from '../../src/jobs/workers.js';
import { getEmailProvider } from '../../src/email/index.js';
import { api, auth } from '../helpers.js';
import { leadWithDraftReply, outbox } from './fixtures.js';

/** End-to-end through real BullMQ workers and Redis. */

let running;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function eventually(check, { timeout = 10_000, interval = 100 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('workers (end to end)', () => {
  it('approval -> email sent by the worker -> next follow-up drafted by the worker', async () => {
    running = await startWorkers({ concurrency: 2, registerSweep: false });
    const ctx = await leadWithDraftReply();
    await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({});

    await eventually(async () => (await prisma.message.findUnique({ where: { id: ctx.messageId } })).status === 'SENT');
    expect(outbox()).toHaveLength(1);

    const fu = await eventually(() => prisma.followUpJob.findFirst({ where: { leadId: ctx.lead.id, status: 'PENDING_APPROVAL' } }));
    expect(fu.messageId).toBeTruthy();
    expect(outbox()).toHaveLength(1); // the follow-up waits for approval
  });

  it('permanent failures land in the failed set, are visible in /ops and can be retried', async () => {
    running = await startWorkers({ concurrency: 1, registerSweep: false });
    getEmailProvider().failNext(1, { retryable: false, code: 'VALIDATION_ERROR' });
    const ctx = await leadWithDraftReply();
    await api().post(`/api/approvals/${ctx.approval.id}/approve`).set(auth(ctx.owner.token)).send({});

    const ops = { Authorization: `Bearer ${process.env.OPS_TOKEN}` };
    const failed = await eventually(async () => {
      const res = await api().get('/ops/queues').set(ops);
      return res.body.queues.email.recentFailures[0];
    });
    expect(failed).toMatchObject({
      name: 'send-message',
      data: { messageId: ctx.messageId },
      failedReason: expect.stringContaining('failed permanently'),
      attemptsMade: 1, // unrecoverable: no pointless retries
    });
    expect((await api().get('/ops/queues').set(ops)).body.queues.email.counts.failed).toBe(1);

    const retry = await api().post(`/ops/queues/email/jobs/${failed.id}/retry`).set(ops);
    expect(retry.status).toBe(200);
    // The retried job re-checks state: the message is FAILED, so nothing is sent.
    await eventually(async () => (await api().get('/ops/queues').set(ops)).body.queues.email.counts.failed === 0);
    expect(outbox()).toHaveLength(0);
  });
});
