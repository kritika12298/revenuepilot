import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { estimateDealValue } from '../../src/modules/revenue/dealValue.js';
import { addMember, api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';

const HOT = 'Need weekly mowing and edging starting next week, budget around $300 a month. Thanks! Can someone come out?';

describe('deal value estimation', () => {
  const services = new Map([
    ['s1', { id: 's1', name: 'Lawn care', priceType: 'RANGE', priceMinCents: 4500, priceMaxCents: 8500 }],
    ['s2', { id: 's2', name: 'Design', priceType: 'FIXED', priceMinCents: 15000, priceMaxCents: 15000 }],
    ['s3', { id: 's3', name: 'Install', priceType: 'QUOTE_ONLY', priceMinCents: null, priceMaxCents: null }],
  ]);
  it('prefers owner value, then stated budget, then published prices, and never guesses', () => {
    expect(estimateDealValue({ dealValueCents: 99900, qualification: null }, services)).toMatchObject({ cents: 99900, source: 'OWNER' });
    expect(estimateDealValue({ qualification: { budget: { stated: true, min: 12000, max: 15000 } } }, services)).toMatchObject({
      cents: 1350000,
      source: 'BUDGET',
      basis: 'Midpoint of the stated budget ($12,000–$15,000)',
    });
    expect(estimateDealValue({ qualification: { budget: { stated: false }, matchedServiceIds: ['s1', 's2'] } }, services)).toMatchObject({ cents: 6500 + 15000, source: 'SERVICE_PRICE' });
    expect(estimateDealValue({ qualification: { budget: { stated: false }, matchedServiceIds: ['s3'] } }, services)).toMatchObject({ cents: null, source: null });
    expect(estimateDealValue({ qualification: null }, services)).toMatchObject({ cents: null });
  });
});

describe('360-degree lead profile', () => {
  it('returns analysis with sentiment, deal value basis, next action and lifecycle after the AI runs', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', subject: 'Mowing', message: HOT } });
    await startAgent(owner.token, lead.id);

    const res = await api().get(`/api/leads/${lead.id}`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.qualification.sentiment).toEqual({ label: 'POSITIVE', evidence: '"thanks"' });
    expect(res.body.dealValue).toMatchObject({ cents: 30000, source: 'BUDGET' });
    expect(res.body.nextAction).toMatchObject({ nextAction: 'AWAIT_OWNER_APPROVAL', rationale: expect.any(String) });
    // The lead asked "Can someone come out?": the Meeting Agent proposed a slot for owner approval.
    expect(res.body.appointments).toHaveLength(1);
    expect(res.body.appointments[0]).toMatchObject({ status: 'PROPOSED', bookedBy: 'AI' });
    expect(res.body.assignedTo).toBeNull();
  });

  it('lets the team assign leads to members and set a deal value, and records the assignment', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const lead = await createLead(owner.token);

    const members = await api().get('/api/business/members').set(auth(owner.token));
    expect(members.body.data.map((m) => m.role).sort()).toEqual(['MEMBER', 'OWNER']);

    const res = await api().patch(`/api/leads/${lead.id}`).set(auth(owner.token)).send({ assignedToId: member.userId, dealValueCents: 450000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assignedTo: { id: member.userId }, dealValue: { cents: 450000, source: 'OWNER' } });
    expect((await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'ASSIGNED' } })).data).toMatchObject({ assignedToId: member.userId });

    const outsider = await registerOwner();
    const bad = await api().patch(`/api/leads/${lead.id}`).set(auth(owner.token)).send({ assignedToId: outsider.userId });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_ASSIGNEE');
  });
});

describe('AI execution timeline', () => {
  it('lists every workflow with agent names, triggers, decisions and nested sub-agent runs', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: HOT } });
    await startAgent(owner.token, lead.id);

    const res = await api().get('/api/agent-runs').set(auth(owner.token));
    expect(res.status).toBe(200);
    const [run] = res.body.data;
    expect(run).toMatchObject({
      agentName: 'Sales Orchestrator',
      triggerDetail: 'Started from the dashboard (Run AI)',
      decision: 'Waiting for owner approval',
      lead: { id: lead.id },
    });
    expect(run.childRuns.map((c) => c.agentName)).toEqual([
      'Lead Intelligence Agent',
      'Meeting Agent',
      'Policy & Approval Agent',
      'Conversation Agent',
      'Policy & Approval Agent',
    ]);
    expect(run.childRuns.filter((c) => c.agentName === 'Policy & Approval Agent').map((c) => c.decision)).toEqual(['Requires owner approval', 'Requires owner approval']);
    expect(run.childRuns[0].triggerDetail).toMatch(/^Orchestrator: /);
    expect(run.childRuns[0].decision).toMatch(/^Scored \d+\/100/);

    const detail = await api().get(`/api/agent-runs/${run.id}`).set(auth(owner.token));
    expect(detail.body.toolCalls[0]).toMatchObject({ toolName: 'get_lead_details', outcome: 'EXECUTED', result: expect.any(Object) });
    expect(detail.body.childRuns[0].toolCalls.length).toBeGreaterThan(0);

    const filtered = await api().get('/api/agent-runs?agent=sales_intelligence').set(auth(owner.token));
    expect(filtered.body.data).toEqual([]);
    expect((await api().get('/api/agent-runs?agent=bogus').set(auth(owner.token))).status).toBe(400);
    const other = await registerOwner();
    expect((await api().get('/api/agent-runs').set(auth(other.token))).body.data).toEqual([]);
  });
});
