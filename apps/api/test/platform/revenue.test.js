import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { app, api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';
import { refreshRecommendations } from '../../src/modules/recommendations/engine.js';
import { publishEvent } from '../../src/modules/events/eventBus.js';

const HOUR = 3600e3;

async function owner() {
  const o = await registerOwner();
  await seedServices(o.businessId);
  return o;
}

describe('revenue intelligence', () => {
  it('computes pipeline and weighted value from deal values and documented probabilities', async () => {
    const o = await owner();
    const a = await createLead(o.token, { name: 'Budget lead' });
    await prisma.lead.update({ where: { id: a.id }, data: { status: 'ENGAGED', score: 82, qualification: { budget: { stated: true, min: 1000, max: 3000 }, intent: { level: 'HIGH' } } } });
    const b = await createLead(o.token, { name: 'Owner value', email: 'b@example.com' });
    await prisma.lead.update({ where: { id: b.id }, data: { status: 'QUALIFIED', score: 60, dealValueCents: 500000 } });
    await createLead(o.token, { name: 'No basis', email: 'c@example.com' });

    const res = await api().get('/api/revenue?range=30d').set(auth(o.token));
    expect(res.status).toBe(200);
    expect(res.body.pipeline).toMatchObject({ openLeads: 3, leadsWithValue: 2, leadsWithoutValue: 1, valueCents: 200000 + 500000, weightedCents: 200000 * 0.4 + 500000 * 0.2 });
    expect(res.body.tiers.high).toMatchObject({ count: 1, valueCents: 200000 });
    expect(res.body.tiers.medium).toMatchObject({ count: 1, valueCents: 500000 });
    expect(res.body.methodology.probabilities.ENGAGED).toEqual({ probability: 0.4, method: 'DEFAULT', sample: 0 });
    expect(res.body.dataSufficiency).toMatchObject({ sufficient: false, note: expect.stringMatching(/Not enough closed leads/) });
    expect(res.body.disclaimer).toMatch(/not guaranteed/);

    const summary = await api().get('/api/dashboard/summary').set(auth(o.token));
    expect(summary.body.pipelineValue).toMatchObject({ valueCents: 700000, weightedCents: 180000, leadsWithoutValue: 1 });
  });

  it('flags revenue at risk and uses history once there is enough closed data', async () => {
    const o = await owner();
    const waiting = await createLead(o.token, { name: 'Waiting' });
    await prisma.lead.update({ where: { id: waiting.id }, data: { dealValueCents: 100000, lastInboundAt: new Date(Date.now() - 30 * HOUR) } });
    // 12 closed leads that reached QUALIFIED: 6 won, 6 lost.
    for (let i = 0; i < 12; i += 1) {
      const l = await createLead(o.token, { name: `Closed ${i}`, email: `c${i}@example.com` });
      await prisma.lead.update({ where: { id: l.id }, data: { status: i < 6 ? 'WON' : 'LOST', lostReason: i < 6 ? null : 'PRICE', score: 50 } });
      await prisma.leadEvent.create({ data: { businessId: o.businessId, leadId: l.id, type: 'STATUS_CHANGED', actorType: 'USER', data: { from: 'NEW', to: 'QUALIFIED' } } });
    }
    const res = await api().get('/api/revenue?range=all').set(auth(o.token));
    expect(res.body.atRisk.leads[0]).toMatchObject({ lead: { name: 'Waiting' }, risks: ['Waiting 30h for our reply'] });
    expect(res.body.methodology.probabilities.QUALIFIED).toEqual({ probability: 0.5, method: 'HISTORY', sample: 12 });
    expect(res.body.lost).toMatchObject({ count: 6, reasons: { PRICE: 6 } });
    expect(res.body.dataSufficiency.sufficient).toBe(true);
  });
});

describe('proactive recommendations', () => {
  it('detects a high-intent lead waiting for a reply, without duplicates, and resolves it automatically', async () => {
    const o = await owner();
    const lead = await createLead(o.token, { enquiry: { channel: 'WEB_FORM', message: 'Need weekly mowing starting next week, budget $300. Can someone come out?' } });
    await startAgent(o.token, lead.id);
    await prisma.message.updateMany({ where: { direction: 'INBOUND' }, data: { createdAt: new Date(Date.now() - 3 * HOUR) } });
    await prisma.approval.updateMany({ data: { createdAt: new Date(Date.now() - 5 * HOUR) } });

    const first = await refreshRecommendations(o.businessId);
    expect(first.created).toBeGreaterThan(0);
    const list = await api().get('/api/recommendations').set(auth(o.token));
    const types = list.body.data.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['HIGH_INTENT_NO_RESPONSE', 'APPROVAL_WAITING']));
    expect(list.body.data[0].priority).toBe('HIGH');
    const waiting = list.body.data.find((r) => r.type === 'HIGH_INTENT_NO_RESPONSE');
    expect(waiting).toMatchObject({ reason: expect.stringMatching(/wrote 3 hours ago/), impact: { valueCents: 30000 } });

    const second = await refreshRecommendations(o.businessId);
    expect(second.created).toBe(0);
    const notes = await prisma.notification.count({ where: { businessId: o.businessId, reason: 'RECOMMENDATION' } });
    await refreshRecommendations(o.businessId);
    expect(await prisma.notification.count({ where: { businessId: o.businessId, reason: 'RECOMMENDATION' } })).toBe(notes);

    // Dismissed recommendations are not raised again for the same situation.
    const approvalRec = list.body.data.find((r) => r.type === 'APPROVAL_WAITING');
    expect((await api().post(`/api/recommendations/${approvalRec.id}/dismiss`).set(auth(o.token))).status).toBe(204);
    await refreshRecommendations(o.businessId);
    expect((await api().get('/api/recommendations').set(auth(o.token))).body.data.map((r) => r.id)).not.toContain(approvalRec.id);

    // Replying resolves the "waiting" recommendation.
    await api().post(`/api/leads/${lead.id}/messages`).set(auth(o.token)).send({ body: 'Hi! Happy to help.' });
    await prisma.message.updateMany({ where: { author: 'OWNER' }, data: { status: 'SENT', sentAt: new Date() } });
    await refreshRecommendations(o.businessId);
    expect(await prisma.recommendation.findUnique({ where: { id: waiting.id } })).toMatchObject({ status: 'DONE' });

    const other = await registerOwner();
    expect((await api().get('/api/recommendations').set(auth(other.token))).body.data).toEqual([]);
    expect((await api().post(`/api/recommendations/${waiting.id}/done`).set(auth(other.token))).status).toBe(404);
  });

  it('flags overdue follow-ups and silent leads', async () => {
    const o = await owner();
    const lead = await createLead(o.token);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
    await prisma.followUpJob.create({ data: { businessId: o.businessId, leadId: lead.id, scheduledFor: new Date(Date.now() - 5 * HOUR), status: 'PENDING_APPROVAL' } });
    const conv = await prisma.conversation.findFirst({ where: { leadId: lead.id } });
    for (const days of [9, 5]) {
      await prisma.message.create({ data: { businessId: o.businessId, conversationId: conv.id, direction: 'OUTBOUND', author: 'AI', body: 'Checking in', status: 'SENT', sentAt: new Date(Date.now() - days * 24 * HOUR), createdAt: new Date(Date.now() - days * 24 * HOUR) } });
    }
    await prisma.message.updateMany({ where: { direction: 'INBOUND' }, data: { createdAt: new Date(Date.now() - 10 * 24 * HOUR) } });
    await refreshRecommendations(o.businessId);
    const recs = (await api().get('/api/recommendations').set(auth(o.token))).body.data;
    expect(recs.map((r) => r.type)).toEqual(expect.arrayContaining(['OVERDUE_FOLLOW_UP', 'STOPPED_RESPONDING']));
    expect(await prisma.notification.count({ where: { reason: 'OVERDUE_FOLLOW_UP' } })).toBe(1);
  });
});

describe('notification centre and live events', () => {
  it('counts unread notifications and marks all read', async () => {
    const o = await owner();
    await prisma.notification.createMany({ data: [1, 2].map((i) => ({ businessId: o.businessId, reason: 'OTHER', message: `n${i}` })) });
    expect((await api().get('/api/notifications/unread-count').set(auth(o.token))).body.count).toBe(2);
    expect((await api().post('/api/notifications/read-all').set(auth(o.token))).body.updated).toBe(2);
    expect((await api().get('/api/notifications/unread-count').set(auth(o.token))).body.count).toBe(0);
  });

  it('streams events for the signed-in business only', async () => {
    const o = await owner();
    const other = await registerOwner();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { headers: { Authorization: `Bearer ${o.token}` }, signal: controller.signal });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const readUntil = async (pattern) => {
        while (!pattern.test(buffer)) buffer += decoder.decode((await reader.read()).value);
      };
      await readUntil(/event: ready/);
      await new Promise((r) => setTimeout(r, 100)); // subscriber attached
      publishEvent(other.businessId, 'notification', { id: 'not-yours' });
      publishEvent(o.businessId, 'notification', { id: 'yours' });
      await readUntil(/"id":"yours"/);
      expect(buffer).not.toContain('not-yours');
      expect((await fetch(`http://127.0.0.1:${port}/api/events/stream`)).status).toBe(401);
    } finally {
      controller.abort();
      await new Promise((r) => server.close(r));
    }
  });
});
