import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { api, auth, createLead, registerOwner } from '../helpers.js';

const HOUR = 3600e3;
const sim = (o, body) => api().post('/api/simulations').set(auth(o.token)).send(body);

async function lead(o, i, { minutes, engaged, score = 80 }) {
  const l = await createLead(o.token, { name: `L${i}`, email: `l${i}@example.com` });
  const created = new Date(Date.now() - 10 * 24 * HOUR);
  await prisma.lead.update({
    where: { id: l.id },
    data: { createdAt: created, lastInboundAt: created, score, firstResponseAt: minutes == null ? null : new Date(created.getTime() + minutes * 60e3), status: engaged ? 'ENGAGED' : 'CONTACTED', lastOutboundAt: minutes == null ? null : new Date(created.getTime() + minutes * 60e3) },
  });
  return l;
}

describe('follow-up strategy simulator', () => {
  it('withholds estimates when there is not enough history, and says why', async () => {
    const o = await registerOwner();
    await lead(o, 1, { minutes: 10, engaged: true });
    const res = await sim(o, { scenario: 'RESPONSE_TIME', params: { targetMinutes: 30 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'SIMULATION', disclaimer: expect.stringMatching(/not an actual result/), estimate: { available: false, reason: expect.stringMatching(/at least 5 leads in each group/) } });
  });

  it('estimates the effect of faster responses from historical engagement rates', async () => {
    const o = await registerOwner();
    for (let i = 0; i < 5; i += 1) await lead(o, i, { minutes: 10, engaged: i < 4 }); // fast: 80% engaged
    for (let i = 5; i < 11; i += 1) await lead(o, i, { minutes: 300, engaged: i < 7 }); // slow: 2/6 engaged
    const res = await sim(o, { scenario: 'RESPONSE_TIME', params: { targetMinutes: 30, segment: 'HIGH_INTENT' } });
    expect(res.body.current).toMatchObject({ answered: 11, withinTarget: 5, slowerThanTarget: 6 });
    expect(res.body.historical.fast).toMatchObject({ size: 5, rate: 80 });
    expect(res.body.historical.slow).toMatchObject({ size: 6, rate: 33.3 });
    expect(res.body.estimate).toMatchObject({ available: true, additionalEngagedLeads: 2.8 });
    // Nothing was changed by simulating.
    expect(await prisma.auditLog.count({ where: { businessId: o.businessId } })).toBe(0);
  });

  it('offers an explicit settings change for cadence scenarios, and validates input', async () => {
    const o = await registerOwner();
    const res = await sim(o, { scenario: 'FIRST_FOLLOW_UP_DELAY', params: { delayHours: 24 } });
    expect(res.body.apply).toEqual({ commsPrefs: { followUpCadenceHours: [24, 96, 168] }, description: 'Set the first follow-up delay to 24 hours' });
    const freq = await sim(o, { scenario: 'FOLLOW_UP_FREQUENCY', params: { maxFollowUps: 5 } });
    expect(freq.body.apply.commsPrefs).toEqual({ maxFollowUps: 5, followUpCadenceHours: [48, 96, 168, 168, 168] });
    expect(freq.body.estimate.available).toBe(false);
    expect((await sim(o, { scenario: 'RESPONSE_TIME', params: { targetMinutes: 1 } })).status).toBe(400);
    expect((await sim(o, { scenario: 'MAGIC', params: {} })).status).toBe(400);
  });

  it('ranks open leads for prioritisation', async () => {
    const o = await registerOwner();
    const a = await createLead(o.token, { name: 'Small' });
    const b = await createLead(o.token, { name: 'Big', email: 'big@example.com' });
    await prisma.lead.update({ where: { id: a.id }, data: { status: 'ENGAGED', dealValueCents: 10000 } });
    await prisma.lead.update({ where: { id: b.id }, data: { status: 'ENGAGED', dealValueCents: 900000 } });
    const res = await sim(o, { scenario: 'PRIORITISATION', params: { by: 'VALUE' } });
    expect(res.body.affected.leads.map((l) => l.name).slice(0, 2)).toEqual(['Big', 'Small']);
  });
});
