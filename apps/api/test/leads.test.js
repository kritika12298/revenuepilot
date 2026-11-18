import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { addMember, api, auth, createLead, registerOwner } from './helpers.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('lead CRUD', () => {
  it('creates a lead with its first conversation, message and timeline events', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token, { email: '  Jordan@Example.com ' });

    expect(lead).toMatchObject({
      name: 'Jordan Rivera',
      email: 'jordan@example.com',
      status: 'NEW',
      source: 'WEB_FORM',
      businessId: owner.businessId,
      consentEmail: true,
      consentSource: 'web_form:test',
      score: null,
    });
    expect(lead.allowedTransitions).toContain('QUALIFIED');
    expect(lead.conversations).toHaveLength(1);
    expect(lead.conversations[0].messages[0]).toMatchObject({
      direction: 'INBOUND',
      author: 'LEAD',
      status: 'RECEIVED',
      body: 'Need weekly mowing from next week.',
    });

    const events = await api().get(`/api/leads/${lead.id}/events`).set(auth(owner.token));
    expect(events.body.data.map((e) => e.type).sort()).toEqual(['CREATED', 'MESSAGE_RECEIVED']);
  });

  it('ignores any businessId sent in the body', async () => {
    const owner = await registerOwner();
    const other = await registerOwner();
    const res = await api()
      .post('/api/leads')
      .set(auth(owner.token))
      .send({ name: 'Sneaky', email: 'x@example.com', businessId: other.businessId });
    expect(res.status).toBe(400); // strict schema rejects unknown keys
  });

  it('requires an email or phone number', async () => {
    const owner = await registerOwner();
    const res = await api().post('/api/leads').set(auth(owner.token)).send({ name: 'No Contact' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('email');
  });

  it('lists leads with filters, search, sorting and pagination', async () => {
    const owner = await registerOwner();
    const a = await createLead(owner.token, { name: 'Alice Garden', email: 'alice@example.com' });
    const b = await createLead(owner.token, { name: 'Bob Builder', email: 'bob@acme.example.com', company: 'Acme' });
    await createLead(owner.token, { name: 'Cara Unscored', email: 'cara@example.com', source: 'EMAIL' });

    await api().patch(`/api/leads/${a.id}/score`).set(auth(owner.token)).send({ score: 40, reason: 'Manual' });
    await api().patch(`/api/leads/${b.id}/score`).set(auth(owner.token)).send({ score: 90, reason: 'Manual' });

    const byScore = await api().get('/api/leads?sort=score&order=desc').set(auth(owner.token));
    expect(byScore.status).toBe(200);
    expect(byScore.body.data.map((l) => l.name)).toEqual(['Bob Builder', 'Alice Garden', 'Cara Unscored']);
    expect(byScore.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 3, totalPages: 1 });

    const minScore = await api().get('/api/leads?minScore=50').set(auth(owner.token));
    expect(minScore.body.data.map((l) => l.id)).toEqual([b.id]);

    const search = await api().get('/api/leads?q=acme').set(auth(owner.token));
    expect(search.body.data.map((l) => l.id)).toEqual([b.id]);

    const bySource = await api().get('/api/leads?source=EMAIL').set(auth(owner.token));
    expect(bySource.body.data.map((l) => l.name)).toEqual(['Cara Unscored']);

    const paged = await api().get('/api/leads?pageSize=2&page=2&sort=name&order=asc').set(auth(owner.token));
    expect(paged.body.data.map((l) => l.name)).toEqual(['Cara Unscored']);
    expect(paged.body.meta.totalPages).toBe(2);
  });

  it('validates list query parameters', async () => {
    const owner = await registerOwner();
    const res = await api().get('/api/leads?status=BOGUS&pageSize=1000').set(auth(owner.token));
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['status.0', 'pageSize']));
  });

  it('returns 404 for unknown leads and 400 for malformed ids', async () => {
    const owner = await registerOwner();
    expect((await api().get(`/api/leads/${UNKNOWN_ID}`).set(auth(owner.token))).status).toBe(404);
    expect((await api().get('/api/leads/not-a-uuid').set(auth(owner.token))).status).toBe(400);
  });

  it('updates contact details and records changed field names only', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api()
      .patch(`/api/leads/${lead.id}`)
      .set(auth(owner.token))
      .send({ phone: '+1 303 555 0100', company: 'Rivera Homes' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '+1 303 555 0100', company: 'Rivera Homes' });

    const event = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'UPDATED' } });
    expect(event.data).toEqual({ fields: ['phone', 'company'] });
  });

  it('refuses to remove the last contact method', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api().patch(`/api/leads/${lead.id}`).set(auth(owner.token)).send({ email: null });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LEAD_UNCONTACTABLE');
  });

  it('withdrawing consent cancels pending follow-ups', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    await prisma.followUpJob.create({
      data: { businessId: owner.businessId, leadId: lead.id, scheduledFor: new Date(Date.now() + 3600e3), status: 'SCHEDULED' },
    });
    const res = await api()
      .patch(`/api/leads/${lead.id}`)
      .set(auth(owner.token))
      .send({ consent: { email: false } });
    expect(res.status).toBe(200);
    expect(res.body.consentEmail).toBe(false);
    expect(res.body.followUpJobs[0]).toMatchObject({ status: 'CANCELLED', skipReason: 'Email consent withdrawn' });
  });

  it('lets only owners delete leads', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const lead = await createLead(owner.token);

    const forbidden = await api().delete(`/api/leads/${lead.id}`).set(auth(member.token));
    expect(forbidden.status).toBe(403);

    const deleted = await api().delete(`/api/leads/${lead.id}`).set(auth(owner.token));
    expect(deleted.status).toBe(204);
    expect(await prisma.lead.count({ where: { id: lead.id } })).toBe(0);
    expect(await prisma.leadEvent.count({ where: { leadId: lead.id } })).toBe(0);

    const again = await api().delete(`/api/leads/${lead.id}`).set(auth(owner.token));
    expect(again.status).toBe(404);
  });
});

describe('lead status', () => {
  it('moves through valid transitions and records events', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);

    const res = await api()
      .patch(`/api/leads/${lead.id}/status`)
      .set(auth(owner.token))
      .send({ status: 'QUALIFIED', note: 'Good fit' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('QUALIFIED');
    expect(res.body.allowedTransitions).toContain('CONTACTED');

    const event = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'STATUS_CHANGED' } });
    expect(event).toMatchObject({ actorType: 'USER', actorUserId: owner.userId });
    expect(event.data).toEqual({ from: 'NEW', to: 'QUALIFIED', note: 'Good fit' });
  });

  it('rejects invalid transitions with the allowed list', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'WON' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      details: { from: 'NEW', to: 'WON' },
    });
    expect(res.body.error.details.allowed).toContain('QUALIFIED');
  });

  it('requires lostReason for LOST and forbids it otherwise', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const missing = await api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'LOST' });
    expect(missing.status).toBe(400);
    const extra = await api()
      .patch(`/api/leads/${lead.id}/status`)
      .set(auth(owner.token))
      .send({ status: 'QUALIFIED', lostReason: 'PRICE' });
    expect(extra.status).toBe(400);
  });

  it('closing a lead cancels follow-ups and expires pending approvals', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const ctx = { businessId: owner.businessId, leadId: lead.id };
    await prisma.followUpJob.createMany({
      data: [
        { ...ctx, scheduledFor: new Date(Date.now() + 3600e3), status: 'SCHEDULED' },
        { ...ctx, scheduledFor: new Date(Date.now() + 7200e3), status: 'PENDING_APPROVAL', step: 2 },
        { ...ctx, scheduledFor: new Date(Date.now() - 3600e3), status: 'SENT', step: 0 },
      ],
    });
    await prisma.approval.create({ data: { ...ctx, type: 'DISCOUNT', payload: { percent: 10 } } });

    const res = await api()
      .patch(`/api/leads/${lead.id}/status`)
      .set(auth(owner.token))
      .send({ status: 'LOST', lostReason: 'PRICE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'LOST', lostReason: 'PRICE' });

    const jobs = await prisma.followUpJob.findMany({ where: { leadId: lead.id }, orderBy: { step: 'asc' } });
    expect(jobs.map((j) => j.status)).toEqual(['SENT', 'CANCELLED', 'CANCELLED']);
    expect(await prisma.approval.count({ where: { leadId: lead.id, status: 'EXPIRED' } })).toBe(1);

    // Reopening clears the lost reason.
    const reopened = await api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'ENGAGED' });
    expect(reopened.body).toMatchObject({ status: 'ENGAGED', lostReason: null });
  });

  it('opting out removes consent and is final', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'OPTED_OUT' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OPTED_OUT', consentEmail: false });
    expect(res.body.optedOutAt).toBeTruthy();
    expect(res.body.allowedTransitions).toEqual([]);

    const reconsent = await api()
      .patch(`/api/leads/${lead.id}`)
      .set(auth(owner.token))
      .send({ consent: { email: true, source: 'phone call' } });
    expect(reconsent.status).toBe(409);
  });

  it('never applies a status change based on a stale read', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const results = await Promise.all([
      api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'QUALIFIED' }),
      api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'CONTACTED' }),
    ]);
    // Either they serialised (both 200, a valid NEW -> X -> Y chain) or the
    // second saw a stale status and got 409. Never two changes from NEW.
    for (const r of results) expect([200, 409]).toContain(r.status);
    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, type: 'STATUS_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(results.filter((r) => r.status === 200).length);
    expect(events.filter((e) => e.data.from === 'NEW')).toHaveLength(1);
  });
});

describe('lead score', () => {
  it('computes the total from an explainable breakdown', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api()
      .patch(`/api/leads/${lead.id}/score`)
      .set(auth(owner.token))
      .send({
        breakdown: {
          urgency: 30,
          budgetFit: 25,
          conversionLikelihood: 20,
          reasons: ['Wants to start next week', 'Budget fits weekly maintenance range'],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(75);
    expect(res.body.scoreBreakdown).toMatchObject({ urgency: 30, budgetFit: 25, conversionLikelihood: 20, method: 'MANUAL' });

    const event = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'SCORE_UPDATED' } });
    expect(event.data).toEqual({ from: null, to: 75, method: 'MANUAL' });
  });

  it('accepts an owner override with a reason', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const res = await api()
      .patch(`/api/leads/${lead.id}/score`)
      .set(auth(owner.token))
      .send({ score: 95, reason: 'Referred by an existing client' });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(95);
    expect(res.body.scoreBreakdown).toMatchObject({ method: 'OVERRIDE', reasons: ['Referred by an existing client'] });
  });

  it('rejects out-of-range components and ambiguous payloads', async () => {
    const owner = await registerOwner();
    const lead = await createLead(owner.token);
    const tooHigh = await api()
      .patch(`/api/leads/${lead.id}/score`)
      .set(auth(owner.token))
      .send({ breakdown: { urgency: 50, budgetFit: 10, conversionLikelihood: 10, reasons: ['x'] } });
    expect(tooHigh.status).toBe(400);

    const noReason = await api().patch(`/api/leads/${lead.id}/score`).set(auth(owner.token)).send({ score: 50 });
    expect(noReason.status).toBe(400);

    const both = await api()
      .patch(`/api/leads/${lead.id}/score`)
      .set(auth(owner.token))
      .send({ score: 50, reason: 'x', breakdown: { urgency: 1, budgetFit: 1, conversionLikelihood: 1, reasons: ['x'] } });
    expect(both.status).toBe(400);
  });
});
