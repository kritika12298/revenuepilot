import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';

const HOT_ENQUIRY =
  'Hi, I manage three rentals and need weekly mowing and edging starting next week. ' +
  'Budget is around $300 a month. Can someone come out to take a look?';

async function setup(message = HOT_ENQUIRY, subject = 'Weekly mowing') {
  const owner = await registerOwner();
  await seedServices(owner.businessId);
  const lead = await createLead(owner.token, {
    name: 'Daniel Okafor',
    enquiry: { channel: 'WEB_FORM', subject, message },
  });
  return { owner, lead };
}

describe('lead intelligence agent (mock AI)', () => {
  it('analyses the enquiry, saves an explainable score and audits every tool call', async () => {
    const { owner, lead } = await setup();
    const res = await startAgent(owner.token, lead.id, { agent: 'lead_intelligence' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'QUALIFICATION', status: 'SUCCEEDED', model: 'mock', trigger: 'USER' });
    expect(res.body.toolCalls.map((c) => [c.toolName, c.outcome])).toEqual([
      ['get_lead_details', 'EXECUTED'],
      ['get_business_pricing', 'EXECUTED'],
      ['record_lead_analysis', 'EXECUTED'],
      ['update_lead_score', 'EXECUTED'],
    ]);

    const saved = await prisma.lead.findUnique({ where: { id: lead.id } });
    const b = saved.scoreBreakdown;
    expect(saved.score).toBe(b.urgency + b.budgetFit + b.conversionLikelihood);
    expect(b).toMatchObject({ method: 'AI' });
    expect(b.reasons.length).toBeGreaterThan(0);
    expect(saved.qualification).toMatchObject({
      timeline: { urgency: 'THIS_WEEK' },
      budget: { stated: true, max: 300 },
      intent: { level: 'HIGH' },
      agentRunId: res.body.id,
    });
    expect(saved.qualification.matchedServiceIds).toHaveLength(1);

    const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id, actorType: 'AI' } });
    expect(events.map((e) => e.type).sort()).toEqual(['ANALYSIS_UPDATED', 'SCORE_UPDATED']);
    // Analysis is AI-only: it must not touch status or send anything.
    expect(saved.status).toBe('NEW');
  });

  it('sends the model only contact flags, never the email address or phone', async () => {
    const { owner, lead } = await setup();
    const res = await startAgent(owner.token, lead.id, { agent: 'lead_intelligence' });
    const details = res.body.toolCalls.find((c) => c.toolName === 'get_lead_details').result;
    expect(JSON.stringify(details)).not.toContain('jordan@example.com');
    expect(details.lead).toMatchObject({ has_email: true, has_phone: false });
  });
});

describe('sales orchestrator (mock AI)', () => {
  it('coordinates analysis, status, owner alert and a reply draft awaiting approval', async () => {
    const { owner, lead } = await setup();
    const res = await startAgent(owner.token, lead.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'ORCHESTRATION', status: 'SUCCEEDED' });
    expect(res.body.output).toMatchObject({ nextAction: 'AWAIT_OWNER_APPROVAL', ownerNotified: true });
    expect(res.body.toolCalls.map((c) => c.toolName)).toEqual([
      'get_lead_details',
      'run_lead_intelligence',
      'update_lead_status',
      'notify_business_owner',
      'run_meeting_agent', // "Can someone come out to take a look?"
      'run_conversation_agent',
      'record_next_action',
    ]);
    // Sub-agents plus the Policy & Approval Agent's checks, in order.
    expect(res.body.childRuns.map((r) => [r.agentName, r.status])).toEqual([
      ['Lead Intelligence Agent', 'SUCCEEDED'],
      ['Meeting Agent', 'SUCCEEDED'],
      ['Policy & Approval Agent', 'SUCCEEDED'],
      ['Conversation Agent', 'SUCCEEDED'],
      ['Policy & Approval Agent', 'SUCCEEDED'],
    ]);
    // Owner approval is the default for bookings and replies.
    expect(await prisma.appointment.findFirst({ where: { leadId: lead.id } })).toMatchObject({ status: 'PROPOSED', bookedBy: 'AI' });

    const saved = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(saved.status).toBe('QUALIFIED');

    // The draft is stored, never sent, and tied to an approval.
    const draft = await prisma.message.findUnique({ where: { id: res.body.output.draftMessageId } });
    expect(draft).toMatchObject({ author: 'AI', direction: 'OUTBOUND', status: 'PENDING_APPROVAL', sentAt: null });
    expect(draft.body).toContain('Hi Daniel');
    expect(draft.body).toContain('$45–$85');
    const approval = await prisma.approval.findFirst({ where: { messageId: draft.id } });
    expect(approval).toMatchObject({ type: 'OUTBOUND_MESSAGE', status: 'PENDING' });

    const notes = await api().get('/api/notifications?unread=true').set(auth(owner.token));
    expect(notes.body.data.map((n) => n.reason).sort()).toEqual(['APPOINTMENT', 'HOT_LEAD']);
    const hot = notes.body.data.find((n) => n.reason === 'HOT_LEAD');
    expect(hot).toMatchObject({ priority: 'URGENT', lead: { id: lead.id } });
    expect((await api().post(`/api/notifications/${hot.id}/read`).set(auth(owner.token))).status).toBe(204);
    const unread = await api().get('/api/notifications?unread=true').set(auth(owner.token));
    expect(unread.body.data.map((n) => n.reason)).toEqual(['APPOINTMENT']);
  });

  it('does not pile up drafts or alerts when run again', async () => {
    const { owner, lead } = await setup();
    await startAgent(owner.token, lead.id);
    const again = await startAgent(owner.token, lead.id);

    expect(again.status).toBe(201);
    expect(again.body.output.nextAction).toBe('AWAIT_OWNER_APPROVAL');
    expect(again.body.toolCalls.map((c) => c.toolName)).toEqual(['get_lead_details', 'record_next_action']);
    expect(await prisma.message.count({ where: { status: 'PENDING_APPROVAL' } })).toBe(1);
    expect(await prisma.notification.count({ where: { reason: 'HOT_LEAD' } })).toBe(1);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it('asks for missing information on a vague enquiry and does not alert the owner', async () => {
    const { owner, lead } = await setup('How much do you charge?', 'Question');
    const res = await startAgent(owner.token, lead.id);
    expect(res.body.status).toBe('SUCCEEDED');
    const toolNames = res.body.toolCalls.map((c) => c.toolName);
    expect(toolNames).not.toContain('notify_business_owner');
    expect(toolNames).not.toContain('update_lead_status');

    const saved = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(saved.score).toBeLessThan(40);
    expect(saved.qualification.missingInformation).toEqual(
      expect.arrayContaining(['Which service they need', 'Timeline']),
    );
    const draft = await prisma.message.findUnique({ where: { id: res.body.output.draftMessageId } });
    expect(draft.body).toContain('what you need help with');
  });

  it('lists runs for a lead and returns the full audit trail for one run', async () => {
    const { owner, lead } = await setup();
    const started = await startAgent(owner.token, lead.id);

    const list = await api().get(`/api/leads/${lead.id}/agent-runs`).set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1); // child runs are nested, not listed separately
    expect(list.body.data[0].childRuns.map((c) => c.agentName)).toEqual(
      expect.arrayContaining(['Lead Intelligence Agent', 'Meeting Agent', 'Conversation Agent', 'Policy & Approval Agent']),
    );

    const detail = await api().get(`/api/agent-runs/${started.body.id}`).set(auth(owner.token));
    expect(detail.status).toBe(200);
    expect(detail.body.childRuns[0].toolCalls.length).toBeGreaterThan(0);
  });

  it('reports the AI mode', async () => {
    const owner = await registerOwner();
    const res = await api().get('/api/ai/status').set(auth(owner.token));
    expect(res.body).toMatchObject({ mode: 'mock', model: 'mock' });
  });
});

describe('agent run guards', () => {
  it('refuses to run on closed leads', async () => {
    const { owner, lead } = await setup();
    await api().patch(`/api/leads/${lead.id}/status`).set(auth(owner.token)).send({ status: 'OPTED_OUT' });
    const res = await startAgent(owner.token, lead.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LEAD_CLOSED');
    expect(await prisma.agentRun.count()).toBe(0);
  });

  it('requires analysis before the conversation agent', async () => {
    const { owner, lead } = await setup();
    const res = await startAgent(owner.token, lead.id, { agent: 'conversation', goal: 'FIRST_RESPONSE' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ANALYSIS_REQUIRED');
  });

  it('validates the request body', async () => {
    const { owner, lead } = await setup();
    const res = await startAgent(owner.token, lead.id, { agent: 'lead_intelligence', goal: 'FIRST_RESPONSE' });
    expect(res.status).toBe(400);
    expect((await startAgent(owner.token, lead.id, { agent: 'hacker' })).status).toBe(400);
  });

  it('allows only one active run per lead, and recovers from stale runs', async () => {
    const { owner, lead } = await setup();
    const running = await prisma.agentRun.create({
      data: { businessId: owner.businessId, leadId: lead.id, kind: 'ORCHESTRATION', status: 'RUNNING', startedAt: new Date() },
    });
    const busy = await startAgent(owner.token, lead.id);
    expect(busy.status).toBe(409);

    await prisma.agentRun.update({ where: { id: running.id }, data: { startedAt: new Date(Date.now() - 60 * 60e3) } });
    const ok = await startAgent(owner.token, lead.id);
    expect(ok.status).toBe(201);
    expect(await prisma.agentRun.findUnique({ where: { id: running.id } })).toMatchObject({ status: 'FAILED', errorCode: 'STALE' });
  });

  it('isolates agent runs between businesses', async () => {
    const { owner, lead } = await setup();
    const other = await registerOwner();
    const run = await startAgent(owner.token, lead.id);

    expect((await startAgent(other.token, lead.id)).status).toBe(404);
    expect((await api().get(`/api/leads/${lead.id}/agent-runs`).set(auth(other.token))).status).toBe(404);
    expect((await api().get(`/api/agent-runs/${run.body.id}`).set(auth(other.token))).status).toBe(404);
    const notes = await api().get('/api/notifications').set(auth(other.token));
    expect(notes.body.data).toEqual([]);
  });
});
