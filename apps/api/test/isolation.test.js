import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { api, auth, createLead, registerOwner } from './helpers.js';

/**
 * Business-level data isolation: a user of business B must not be able to
 * observe or change anything belonging to business A, and must get the same
 * 404 as for a lead that does not exist (no existence oracle).
 */
describe('multi-business data isolation', () => {
  let a;
  let b;
  let leadA;

  beforeEach(async () => {
    a = await registerOwner({ businessName: 'Business A' });
    b = await registerOwner({ businessName: 'Business B' });
    leadA = await createLead(a.token, { name: 'Alpha Lead', email: 'alpha@example.com' });
    await createLead(b.token, { name: 'Beta Lead', email: 'beta@example.com' });
  });

  it('lists only the caller’s own leads', async () => {
    const res = await api().get('/api/leads').set(auth(b.token));
    expect(res.body.data.map((l) => l.name)).toEqual(['Beta Lead']);

    const search = await api().get('/api/leads?q=alpha').set(auth(b.token));
    expect(search.body.data).toEqual([]);
  });

  it.each([
    ['GET', (id) => `/api/leads/${id}`, undefined],
    ['GET', (id) => `/api/leads/${id}/events`, undefined],
    ['PATCH', (id) => `/api/leads/${id}`, { name: 'Hijacked' }],
    ['PATCH', (id) => `/api/leads/${id}/status`, { status: 'QUALIFIED' }],
    ['PATCH', (id) => `/api/leads/${id}/score`, { score: 1, reason: 'x' }],
    ['DELETE', (id) => `/api/leads/${id}`, undefined],
  ])('%s %s on another business’s lead returns 404', async (method, path, body) => {
    let req = api()[method.toLowerCase()](path(leadA.id)).set(auth(b.token));
    if (body) req = req.send(body);
    const res = await req;
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('leaves the other business’s data untouched', async () => {
    await api().patch(`/api/leads/${leadA.id}`).set(auth(b.token)).send({ name: 'Hijacked' });
    await api().delete(`/api/leads/${leadA.id}`).set(auth(b.token));

    const lead = await prisma.lead.findUnique({ where: { id: leadA.id } });
    expect(lead).toMatchObject({ name: 'Alpha Lead', status: 'NEW', score: null });
    expect(await prisma.leadEvent.count({ where: { leadId: leadA.id, actorUserId: b.userId } })).toBe(0);
  });

  it('a token for one business cannot read another even if the user is re-pointed', async () => {
    // Forge a token claiming business A for user B: membership check rejects it.
    const { signAccessToken } = await import('../src/modules/auth/token.js');
    const forged = signAccessToken({ userId: b.userId, businessId: a.businessId });
    const res = await api().get('/api/leads').set(auth(forged));
    expect(res.status).toBe(401);
  });
});
