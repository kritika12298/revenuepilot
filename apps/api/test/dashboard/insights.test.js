import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { setAIClient } from '../../src/ai/client.js';
import { refreshStaleInsights } from '../../src/modules/dashboard/agents.service.js';
import { api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';
import { scriptedClient, text, toolResultsIn, toolUse } from '../ai/scripted.js';

const status = (token, id, body) => api().patch(`/api/leads/${id}/status`).set(auth(token)).send(body);

describe('KPI definitions and funnel', () => {
  it('counts the furthest stage each lead reached, so a qualified-then-lost lead still counts as qualified', async () => {
    const owner = await registerOwner();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push((await createLead(owner.token, { name: `L${i}`, email: `l${i}@example.com` })).id);
    await status(owner.token, ids[0], { status: 'QUALIFIED' });
    await status(owner.token, ids[0], { status: 'LOST', lostReason: 'PRICE' }); // qualified, then lost
    await status(owner.token, ids[1], { status: 'QUALIFIED' });
    await status(owner.token, ids[1], { status: 'CONTACTED' });
    await status(owner.token, ids[1], { status: 'WON' });
    await status(owner.token, ids[2], { status: 'LOST', lostReason: 'TIMING' }); // never qualified

    const res = await api().get('/api/dashboard/summary?range=30d').set(auth(owner.token));
    expect(res.body).toMatchObject({
      totals: { leads: 4, qualified: 2, won: 1, lost: 2 },
      qualificationRate: 50, // reached Qualified or later / all leads
      conversionRate: 25, // won / all leads
      winRate: 33.3, // won / (won + lost)
    });
    expect(res.body.funnel.map((f) => [f.stage, f.count, f.percentOfTotal, f.stepConversion])).toEqual([
      ['NEW', 4, 100, null],
      ['QUALIFYING', 2, 50, 50],
      ['QUALIFIED', 2, 50, 100],
      ['CONTACTED', 1, 25, 50],
      ['ENGAGED', 1, 25, 100],
      ['APPOINTMENT_BOOKED', 1, 25, 100],
      ['WON', 1, 25, 100],
    ]);
  });

  it('separates follow-ups from approvals so the two counts never disagree', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: 'Need weekly mowing starting next week, budget $300. Can someone come?' } });
    await startAgent(owner.token, lead.id); // creates a reply draft (approval) + hot-lead alert
    await prisma.approval.create({ data: { businessId: owner.businessId, leadId: lead.id, type: 'DISCOUNT', payload: { percent: 10 } } });

    const res = await api().get('/api/dashboard/summary').set(auth(owner.token));
    expect(res.body).toMatchObject({
      pendingFollowUps: 0,
      followUps: { drafting: 0, needsApproval: 0, scheduled: 0 },
      pendingApprovals: 2,
      approvals: { replies: 1, followUps: 0, discounts: 1, quotes: 0, other: 0 },
    });
  });
});

describe('agent activity', () => {
  it('reports idle agents for a new business', async () => {
    const owner = await registerOwner();
    const res = await api().get('/api/dashboard/agents').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => [a.key, a.status])).toEqual([
      ['lead_intelligence', 'idle'],
      ['conversation', 'idle'],
      ['follow_up', 'idle'],
      ['meeting', 'idle'],
      ['sales_intelligence', 'idle'],
      ['policy', 'idle'],
      ['website', 'idle'],
    ]);
  });

  it('shows the Website Intelligence agent, and an agent\'s last run even when many newer runs exist', async () => {
    const owner = await registerOwner();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await prisma.agentRun.create({ data: { businessId: owner.businessId, kind: 'WEBSITE_ANALYSIS', status: 'SUCCEEDED', trigger: 'USER', input: {}, output: { itemsExtracted: 12, pagesFetched: 4 }, startedAt: old, finishedAt: old, createdAt: old } });
    await prisma.agentRun.createMany({ data: Array.from({ length: 250 }, () => ({ businessId: owner.businessId, kind: 'POLICY_CHECK', status: 'SUCCEEDED', trigger: 'SYSTEM', input: { action: 'SEND_EMAIL' }, output: { verdict: 'ALLOW' }, startedAt: new Date(), finishedAt: new Date() })) });
    const res = await api().get('/api/dashboard/agents').set(auth(owner.token));
    const website = res.body.data.find((a) => a.key === 'website');
    expect(website).toMatchObject({ name: 'Website Intelligence Agent', status: 'completed', lastRun: { decision: 'Extracted 12 items from 4 pages for your review' } });
  });

  it('reflects real runs: completed decisions, running tasks, failures and scheduled follow-ups', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { name: 'Daniel Okafor', enquiry: { channel: 'WEB_FORM', message: 'Need weekly mowing starting next week, budget $300. Can someone come?' } });
    await startAgent(owner.token, lead.id);

    let agents = (await api().get('/api/dashboard/agents').set(auth(owner.token))).body.data;
    const by = (key) => agents.find((a) => a.key === key);
    expect(by('lead_intelligence')).toMatchObject({ status: 'completed', lastRun: { status: 'SUCCEEDED', lead: { name: 'Daniel Okafor' } }, stats: { runs: 1, succeeded: 1, failed: 0 } });
    expect(by('lead_intelligence').lastRun.decision).toMatch(/^Scored Daniel Okafor \d+\/100/);
    expect(by('conversation').lastRun.decision).toBe('Drafted a reply to Daniel Okafor for approval');
    expect(by('sales_intelligence').lastRun.decision).toBe('Daniel Okafor: waiting for your approval');

    // A run in progress, a failure, and a queued follow-up.
    await prisma.agentRun.create({ data: { businessId: owner.businessId, leadId: lead.id, kind: 'QUALIFICATION', status: 'RUNNING', startedAt: new Date() } });
    await prisma.agentRun.create({
      data: { businessId: owner.businessId, leadId: lead.id, kind: 'CONVERSATION', status: 'FAILED', errorCode: 'AI_UNAVAILABLE', error: 'down', startedAt: new Date(), finishedAt: new Date() },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
    await prisma.followUpJob.create({ data: { businessId: owner.businessId, leadId: lead.id, scheduledFor: new Date(Date.now() + 3600e3), status: 'SCHEDULED' } });

    agents = (await api().get('/api/dashboard/agents').set(auth(owner.token))).body.data;
    expect(by('lead_intelligence')).toMatchObject({ status: 'running', currentTask: 'Analysing Daniel Okafor' });
    expect(by('conversation')).toMatchObject({ status: 'failed', lastRun: { error: 'down' } });
    expect(by('follow_up')).toMatchObject({ status: 'scheduled', currentTask: 'Send follow-up 1 to Daniel Okafor', stats: { queued: 1 } });
  });

  it('records orchestrator decisions on the timeline and filters activity by category', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: 'How much for weekly mowing?' } });
    await startAgent(owner.token, lead.id);

    const decision = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'AGENT_DECISION' } });
    expect(decision).toMatchObject({ actorType: 'AI', data: { nextAction: 'AWAIT_OWNER_APPROVAL' } });

    const ai = await api().get('/api/dashboard/activity?category=ai').set(auth(owner.token));
    expect(new Set(ai.body.data.map((e) => e.type))).toEqual(new Set(['AGENT_DECISION', 'APPROVAL_REQUESTED']));
    const customer = await api().get('/api/dashboard/activity?category=customer').set(auth(owner.token));
    expect(new Set(customer.body.data.map((e) => e.type))).toEqual(new Set(['CREATED', 'MESSAGE_RECEIVED']));
    expect((await api().get('/api/dashboard/activity?category=nope').set(auth(owner.token))).status).toBe(400);
  });

  it('gives approvals enough context to review them', async () => {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: 'Need weekly mowing starting next week, budget $300.' } });
    await startAgent(owner.token, lead.id);
    const res = await api().get('/api/approvals?status=PENDING').set(auth(owner.token));
    const draft = res.body.data.find((a) => a.type === 'OUTBOUND_MESSAGE');
    expect(draft.aiRationale).toMatch(/^(First reply to a new enquiry|Asks for details still missing).*Passed the pricing and commitment checks\.$/);
    expect(draft.message).toMatchObject({ body: expect.stringContaining('Hi Jordan'), followUpJob: null });
    expect(draft.agentRun.parentRun.output).toMatchObject({ nextAction: 'AWAIT_OWNER_APPROVAL' });
  });
});

describe('sales insights', () => {
  async function busyBusiness() {
    const owner = await registerOwner();
    await seedServices(owner.businessId);
    const hot = await createLead(owner.token, { name: 'Hot Lead', enquiry: { channel: 'WEB_FORM', message: 'Need weekly mowing starting next week, budget $300. Can someone come?' } });
    await startAgent(owner.token, hot.id); // scored, draft pending, not yet emailed
    await createLead(owner.token, { name: 'Waiting Lead', email: 'w@example.com', enquiry: { channel: 'EMAIL', message: 'Do you do hedges?' } });
    return { owner, hot };
  }

  it('returns null before any insights exist', async () => {
    const owner = await registerOwner();
    expect((await api().get('/api/dashboard/insights').set(auth(owner.token))).body).toEqual({ data: null });
  });

  it('generates insights that cite only facts computed from real data', async () => {
    const { owner, hot } = await busyBusiness();
    const res = await api().post('/api/dashboard/insights').set(auth(owner.token)).send({ range: '30d' });
    expect(res.status).toBe(201);
    const { data } = res.body;
    expect(data).toMatchObject({ model: 'mock', range: '30d', leadsInRange: 2 });
    expect(data.insights.length).toBeGreaterThan(0);
    for (const insight of data.insights) {
      expect(insight.evidence.length).toBeGreaterThan(0);
      expect(insight.reason).toBe(insight.evidence[0].detail); // the reason quotes the fact verbatim
    }
    const titles = data.insights.map((i) => i.title);
    expect(titles).toContain('Reply to 2 waiting leads');
    expect(titles).toContain('Contact 1 high-scoring lead');
    expect(data.insights.find((i) => i.title === 'Contact 1 high-scoring lead').reason).toContain('Hot Lead');
    expect(data.insights[0].priority).toBe('HIGH');

    const latest = await api().get('/api/dashboard/insights').set(auth(owner.token));
    expect(latest.body.data).toMatchObject({ runId: data.runId, newActivitySinceGenerated: 0 });
    await api().patch(`/api/leads/${hot.id}/score`).set(auth(owner.token)).send({ score: 10, reason: 'Changed my mind' });
    expect((await api().get('/api/dashboard/insights').set(auth(owner.token))).body.data.newActivitySinceGenerated).toBe(1);
  });

  it('rejects insights whose numbers do not appear in the cited facts', async () => {
    const { owner } = await busyBusiness();
    let facts;
    const ai = scriptedClient([
      () => [toolUse('get_sales_facts', {})],
      (req) => {
        facts = toolResultsIn(req)[0].payload.facts;
        return [
          toolUse('record_insights', {
            insights: [{ title: 'Reply to 4,321 waiting leads', recommendation: 'Answer them today.', reason: 'They are waiting.', evidence: [facts[0].id], priority: 'HIGH', category: 'RESPONSE_TIME' }],
          }),
        ];
      },
      () => [toolUse('record_insights', { insights: [] })],
      () => [text('Nothing supported by the data.')],
    ]);
    setAIClient(ai);
    const res = await api().post('/api/dashboard/insights').set(auth(owner.token)).send({});
    expect(res.status).toBe(201);
    expect(toolResultsIn(ai.requests[2])[0].payload).toMatchObject({ error: 'UNGROUNDED_NUMBER', details: { ungrounded: [{ number: 4321 }] } });
  });

  it('rejects insights that cite facts which do not exist', async () => {
    const { owner } = await busyBusiness();
    const ai = scriptedClient([
      () => [toolUse('get_sales_facts', {})],
      () => [
        toolUse('record_insights', {
          insights: [
            { title: 'Your conversion beats 90% of peers', recommendation: 'Keep doing what you do.', reason: 'Industry benchmark shows it.', evidence: ['industry_benchmark'], priority: 'LOW', category: 'PIPELINE' },
          ],
        }),
      ],
      () => [toolUse('record_insights', { insights: [] })],
      () => [text('Nothing supported by the data.')],
    ]);
    setAIClient(ai);
    const res = await api().post('/api/dashboard/insights').set(auth(owner.token)).send({});
    expect(res.status).toBe(201);
    expect(toolResultsIn(ai.requests[2])[0].payload).toMatchObject({ error: 'UNKNOWN_EVIDENCE', details: { unknown: ['industry_benchmark'] } });
    expect(res.body.data.insights).toEqual([]);
    const calls = await prisma.agentToolCall.findMany({ where: { toolName: 'record_insights' }, orderBy: { createdAt: 'asc' } });
    expect(calls.map((c) => c.outcome)).toEqual(['POLICY_BLOCKED', 'EXECUTED']);
  });

  it('the daily refresh only runs for businesses with new activity', async () => {
    const { owner } = await busyBusiness();
    const quiet = await registerOwner();
    const first = await refreshStaleInsights();
    expect(first).toMatchObject({ generated: 1, failed: 0 });
    expect(await prisma.agentRun.count({ where: { businessId: quiet.businessId, kind: 'SALES_INSIGHTS' } })).toBe(0);
    expect((await refreshStaleInsights()).generated).toBe(0); // fresh insights are not regenerated
    const agents = (await api().get('/api/dashboard/agents').set(auth(owner.token))).body.data;
    const si = agents.find((a) => a.key === 'sales_intelligence');
    expect(si.lastRun.decision).toMatch(/^\d+ insights?: /);
    expect(new Date(si.nextRunAt) > new Date()).toBe(true);
  });
});
