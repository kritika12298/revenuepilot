import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { QUEUES, sendJobId } from '../../src/queue/queues.js';
import { addMember, api, auth, createLead, registerOwner } from '../helpers.js';
import { queuedJob } from '../followups/fixtures.js';

async function setStatus(token, id, status, extra = {}) {
  const res = await api().patch(`/api/leads/${id}/status`).set(auth(token)).send({ status, ...extra });
  expect(res.status).toBe(200);
}

describe('dashboard summary', () => {
  it('computes metrics from live data, scoped to the business and range', async () => {
    const owner = await registerOwner({ timezone: 'America/Denver' });
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await createLead(owner.token, { name: `Lead ${i}`, email: `l${i}@example.com` })).id);
    await setStatus(owner.token, ids[0], 'QUALIFIED');
    await setStatus(owner.token, ids[1], 'CONTACTED');
    await setStatus(owner.token, ids[1], 'WON');
    await setStatus(owner.token, ids[2], 'LOST', { lostReason: 'PRICE' });
    await api().patch(`/api/leads/${ids[0]}/score`).set(auth(owner.token)).send({ score: 80, reason: 'x' });
    await api().patch(`/api/leads/${ids[1]}/score`).set(auth(owner.token)).send({ score: 60, reason: 'x' });
    // An old lead outside the 30-day window, and another business's lead.
    await prisma.lead.update({ where: { id: ids[4] }, data: { createdAt: new Date(Date.now() - 45 * 86_400_000) } });
    const other = await registerOwner();
    await createLead(other.token);

    const res = await api().get('/api/dashboard/summary?range=30d').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      range: '30d',
      timezone: 'America/Denver',
      totals: { leads: 4, qualified: 2, won: 1, lost: 1, previousLeads: 1 },
      conversionRate: 25,
      winRate: 50,
      averageScore: 70,
      pendingFollowUps: 0,
      pendingApprovals: 0,
    });
    expect(res.body.pipeline.find((p) => p.status === 'NEW').count).toBe(1);
    expect(res.body.leadsByDay).toHaveLength(30);
    expect(res.body.leadsByDay.reduce((a, d) => a + d.count, 0)).toBe(4);

    const all = await api().get('/api/dashboard/summary?range=all').set(auth(owner.token));
    expect(all.body.totals).toMatchObject({ leads: 5, previousLeads: null });
    expect(all.body.conversionRate).toBe(20);
  });

  it('handles a brand-new business with no data', async () => {
    const owner = await registerOwner();
    const res = await api().get('/api/dashboard/summary').set(auth(owner.token));
    expect(res.body).toMatchObject({ totals: { leads: 0 }, conversionRate: null, winRate: null, averageScore: null, medianFirstResponseMinutes: null });
    expect((await api().get('/api/dashboard/summary?range=1y').set(auth(owner.token))).status).toBe(400);
  });

  it('returns a business-wide activity feed', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    await setStatus(owner.token, lead.id, 'QUALIFIED');
    const res = await api().get('/api/dashboard/activity?limit=2').set(auth(owner.token));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ type: 'STATUS_CHANGED', lead: { id: lead.id, name: 'Jordan Rivera' } });
    const other = await registerOwner();
    expect((await api().get('/api/dashboard/activity').set(auth(other.token))).body.data).toEqual([]);
  });
});

describe('conversations', () => {
  it('lists leads with messages, latest first, with reply filtering', async () => {
    const owner = await registerOwner();
    const a = await createLead(owner.token, { name: 'Alpha' });
    const b = await createLead(owner.token, { name: 'Beta' });
    await createLead(owner.token, { name: 'Silent', enquiry: undefined, email: 's@example.com' });
    await api().post(`/api/leads/${a.id}/messages`).set(auth(owner.token)).send({ body: 'Thanks Alpha, here are the details.' });

    const res = await api().get('/api/conversations').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.lead.name)).toEqual(['Alpha', 'Beta']);
    expect(res.body.data[0]).toMatchObject({ messageCount: 2, lastMessage: { author: 'OWNER', status: 'APPROVED' } });
    expect(res.body.meta.total).toBe(2);

    const search = await api().get('/api/conversations?q=bet').set(auth(owner.token));
    expect(search.body.data.map((c) => c.lead.id)).toEqual([b.id]);
  });

  it('queues owner replies for delivery and refuses opted-out leads', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api().post(`/api/leads/${lead.id}/messages`).set(auth(owner.token)).send({ body: 'Hi Jordan!' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ author: 'OWNER', status: 'APPROVED', direction: 'OUTBOUND' });
    expect(await queuedJob(QUEUES.EMAIL, sendJobId(res.body.id, null))).toBeTruthy();

    await setStatus(owner.token, lead.id, 'OPTED_OUT');
    const blocked = await api().post(`/api/leads/${lead.id}/messages`).set(auth(owner.token)).send({ body: 'Hello?' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('OPTED_OUT');
  });
});

describe('services and pricing', () => {
  it('lets owners create, edit and archive services with consistent prices', async () => {
    const owner = await registerOwner();
    const created = await api()
      .post('/api/business/services')
      .set(auth(owner.token))
      .send({ name: 'Drain cleaning', priceType: 'FIXED', priceMinCents: 18900, priceMaxCents: 99999, durationMinutes: 60 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ priceMinCents: 18900, priceMaxCents: 18900, currency: 'USD', active: true });

    const quote = await api()
      .put(`/api/business/services/${created.body.id}`)
      .set(auth(owner.token))
      .send({ name: 'Drain cleaning', priceType: 'QUOTE_ONLY', priceMinCents: 100 });
    expect(quote.body).toMatchObject({ priceType: 'QUOTE_ONLY', priceMinCents: null, priceMaxCents: null });

    const badRange = await api()
      .post('/api/business/services')
      .set(auth(owner.token))
      .send({ name: 'Bad', priceType: 'RANGE', priceMinCents: 500, priceMaxCents: 100 });
    expect(badRange.status).toBe(400);

    expect((await api().delete(`/api/business/services/${created.body.id}`).set(auth(owner.token))).status).toBe(204);
    expect((await api().get('/api/business/services').set(auth(owner.token))).body.data).toEqual([]);
    const all = await api().get('/api/business/services?includeInactive=true').set(auth(owner.token));
    expect(all.body.data[0]).toMatchObject({ active: false });
  });

  it('restricts service changes to owners of the same business', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const body = { name: 'Thing', priceType: 'FIXED', priceMinCents: 1000 };
    expect((await api().post('/api/business/services').set(auth(member.token)).send(body)).status).toBe(403);
    const created = await api().post('/api/business/services').set(auth(owner.token)).send(body);
    const other = await registerOwner();
    expect((await api().put(`/api/business/services/${created.body.id}`).set(auth(other.token)).send(body)).status).toBe(404);
    expect((await api().delete(`/api/business/services/${created.body.id}`).set(auth(other.token))).status).toBe(404);
  });
});
