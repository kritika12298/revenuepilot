import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { setAIClient } from '../../src/ai/client.js';
import { processLead } from '../../src/jobs/processLead.js';
import { processSendMessage } from '../../src/jobs/sendMessage.js';
import { processReminder } from '../../src/modules/appointments/appointment.service.js';
import { availableSlots } from '../../src/calendar/slots.js';
import { createGoogleCalendar } from '../../src/calendar/googleCalendar.js';
import { QUEUES, sendJobId, getQueues } from '../../src/queue/queues.js';
import { addMember, api, auth, createLead, registerOwner, seedServices, startAgent } from '../helpers.js';
import { fakeJob, outbox } from '../followups/fixtures.js';
import { scriptedClient, text, toolResultsIn, toolUse } from '../ai/scripted.js';

const setAutonomy = (owner, body) => api().put('/api/autonomy').set(auth(owner.token)).send(body);
const ASKS_VISIT = 'Need weekly mowing and edging starting next week, budget around $300 a month. Can someone come out?';
const PLAIN = 'Hi, I need weekly lawn mowing for my house, budget around $300 a month, starting next week.';

async function business(autonomy = {}) {
  const owner = await registerOwner();
  await seedServices(owner.businessId);
  if (Object.keys(autonomy).length) expect((await setAutonomy(owner, autonomy)).status).toBe(200);
  return owner;
}

describe('autonomy settings', () => {
  it('has safe defaults, is owner-only to change, validated and audited', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const res = await api().get('/api/autonomy').set(auth(member.token));
    expect(res.body.policy).toMatchObject({ autoScoreLeads: true, autoGenerateResponses: true, autoSendResponses: false, autoScheduleFollowUps: true, autoApproveFollowUps: false, autoBookAppointments: false, maxAutoEmailsPerDay: 50 });
    expect(res.body.lockedApprovals).toEqual({ discounts: true, quotations: true, contracts: true, customPricing: true });

    expect((await setAutonomy(member, { autoSendResponses: true })).status).toBe(403);
    expect((await setAutonomy(owner, { autoSendResponses: 'yes' })).status).toBe(400);
    expect((await setAutonomy(owner, { requireApprovalDiscounts: false })).status).toBe(400); // not configurable
    const ok = await setAutonomy(owner, { autoSendResponses: true });
    expect(ok.body.policy.autoSendResponses).toBe(true);
    const log = await prisma.auditLog.findFirst({ where: { businessId: owner.businessId, action: 'autonomy.updated' } });
    expect(log.data).toEqual({ autoSendResponses: { from: false, to: true } });
  });
});

describe('policy enforcement for customer emails', () => {
  it('holds AI replies for approval by default', async () => {
    const owner = await business();
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(owner.token, lead.id);
    expect(await prisma.message.findFirst({ where: { author: 'AI' } })).toMatchObject({ status: 'PENDING_APPROVAL' });
    const check = await prisma.agentRun.findFirst({ where: { kind: 'POLICY_CHECK', input: { path: ['action'], equals: 'SEND_EMAIL' } } });
    expect(check.output).toMatchObject({ verdict: 'REQUIRE_APPROVAL', reasons: ['Owner approval required'] });
  });

  it('auto-sends permitted replies when the owner allows it, recording the policy decision', async () => {
    const owner = await business({ autoSendResponses: true });
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    const run = await startAgent(owner.token, lead.id);
    expect(run.body.output.nextAction).toBe('AWAIT_LEAD_REPLY');
    const msg = await prisma.message.findFirst({ where: { author: 'AI' } });
    expect(msg.status).toBe('APPROVED');
    expect(await getQueues()[QUEUES.EMAIL].getJob(sendJobId(msg.id, null))).toBeTruthy();
    expect((await prisma.approval.findFirst({ where: { messageId: msg.id } })).decisionNote).toMatch(/Auto-approved by the Policy & Approval Agent/);
    expect(await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'POLICY_DECISION' } })).toMatchObject({ data: expect.objectContaining({ verdict: 'ALLOW' }) });

    // Sending re-checks consent and delivers.
    expect((await processSendMessage(fakeJob({ messageId: msg.id }))).outcome).toBe('SENT');
    expect(outbox()).toHaveLength(1);
  });

  it('falls back to approval when the daily automatic email limit is reached', async () => {
    const owner = await business({ autoSendResponses: true, maxAutoEmailsPerDay: 0 });
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(owner.token, lead.id);
    expect(await prisma.message.findFirst({ where: { author: 'AI' } })).toMatchObject({ status: 'PENDING_APPROVAL' });
    const check = await prisma.agentRun.findFirst({ where: { kind: 'POLICY_CHECK', input: { path: ['action'], equals: 'SEND_EMAIL' } } });
    expect(check.output.reasons).toContain('0 of 0 automatic emails in the last 24 hours');
  });

  it('counts queued automatic emails toward the limit, and holds a send if the limit was reached since approval', async () => {
    const owner = await business({ autoSendResponses: true, maxAutoEmailsPerDay: 1 });
    const first = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(owner.token, first.id);
    const firstMsg = await prisma.message.findFirst({ where: { conversation: { leadId: first.id }, author: 'AI' } });
    expect(firstMsg.status).toBe('APPROVED'); // auto-approved, queued, NOT yet delivered

    // The second reply is held even though nothing has been delivered yet.
    const second = await createLead(owner.token, { email: 'second@example.com', enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(owner.token, second.id);
    const secondMsg = await prisma.message.findFirst({ where: { conversation: { leadId: second.id }, author: 'AI' } });
    expect(secondMsg.status).toBe('PENDING_APPROVAL');

    // Send-time re-check: another automatic email was delivered in the meantime (simulated), so this one is held for the owner.
    await prisma.emailDelivery.create({ data: { businessId: owner.businessId, leadId: second.id, messageId: secondMsg.id, idempotencyKey: 'other', provider: 'mock', toAddress: 'x@example.com', status: 'SENT', sentAt: new Date() } });
    await prisma.approval.updateMany({ where: { messageId: secondMsg.id }, data: { status: 'APPROVED', decidedById: null, decidedAt: new Date() } });
    await prisma.message.update({ where: { id: secondMsg.id }, data: { status: 'APPROVED' } });
    const held = await processSendMessage(fakeJob({ messageId: firstMsg.id }));
    expect(held.outcome).toBe('HELD');
    expect(await prisma.message.findUnique({ where: { id: firstMsg.id } })).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(await prisma.approval.findFirst({ where: { messageId: firstMsg.id } })).toMatchObject({ status: 'PENDING', decisionNote: expect.stringMatching(/daily limit/) });
    expect(outbox()).toHaveLength(0);

    // The owner approving it sends it (a person decided, so the automatic limit doesn't apply).
    const approval = await prisma.approval.findFirst({ where: { messageId: firstMsg.id } });
    expect((await api().post(`/api/approvals/${approval.id}/approve`).set(auth(owner.token)).send({})).status).toBe(200);
    expect((await processSendMessage(fakeJob({ messageId: firstMsg.id }))).outcome).toBe('SENT');
  });

  it('always routes discounts to the owner, even with every autonomy switch on', async () => {
    const owner = await business({ autoSendResponses: true, autoBookAppointments: true, autoApproveFollowUps: true });
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: 'Weekly mowing for 3 rentals, do you offer a discount for multiple properties?' } });
    await startAgent(owner.token, lead.id);
    const approval = await prisma.approval.findFirst({ where: { leadId: lead.id, type: 'DISCOUNT' } });
    expect(approval).toMatchObject({ status: 'PENDING' });
    const check = await prisma.agentRun.findFirst({ where: { kind: 'POLICY_CHECK', input: { path: ['action'], equals: 'FINANCIAL_COMMITMENT' } } });
    expect(check.output.verdict).toBe('REQUIRE_APPROVAL');
  });
});

describe('public form abuse limits', () => {
  it('caps submissions per email address without revealing it (same response)', async () => {
    const owner = await registerOwner();
    const biz = await prisma.business.findUnique({ where: { id: owner.businessId } });
    const submit = () => api().post(`/api/public/forms/${biz.slug}/leads`).send({ name: 'Victim', email: 'victim@example.com', message: 'Please email me a quote for lawn care.', consent: true });
    const responses = [];
    for (let i = 0; i < 5; i += 1) responses.push(await submit());
    expect(responses.every((r) => r.status === 201 && r.body.ok)).toBe(true);
    expect(await prisma.lead.count({ where: { businessId: owner.businessId, email: 'victim@example.com' } })).toBe(3);
  });
});

describe('Meeting Agent and appointments', () => {
  it('proposes an appointment for owner approval by default; approving confirms and emails the lead', async () => {
    const owner = await business();
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    await startAgent(owner.token, lead.id);
    const appt = await prisma.appointment.findFirst({ where: { leadId: lead.id } });
    expect(appt).toMatchObject({ status: 'PROPOSED', bookedBy: 'AI', externalEventId: null });
    const approval = await prisma.approval.findFirst({ where: { leadId: lead.id, type: 'APPOINTMENT' } });

    const res = await api().post(`/api/approvals/${approval.id}/approve`).set(auth(owner.token)).send({});
    expect(res.status).toBe(200);
    const confirmed = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', calendarProvider: 'mock', externalEventId: expect.stringMatching(/^rp_evt_/) });
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('APPOINTMENT_BOOKED');
    const confirmation = await prisma.message.findFirst({ where: { author: 'SYSTEM', subject: { startsWith: 'Confirmed:' } } });
    expect(confirmation.body).toMatch(/is confirmed for .* \(UTC\)/);
  });

  it('books directly when the owner allows automatic booking, and rejecting a proposal cancels it', async () => {
    const auto = await business({ autoBookAppointments: true });
    const lead = await createLead(auto.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    await startAgent(auto.token, lead.id);
    expect(await prisma.appointment.findFirst({ where: { leadId: lead.id } })).toMatchObject({ status: 'CONFIRMED' });

    const manual = await business();
    const lead2 = await createLead(manual.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    await startAgent(manual.token, lead2.id);
    const approval = await prisma.approval.findFirst({ where: { leadId: lead2.id, type: 'APPOINTMENT' } });
    await api().post(`/api/approvals/${approval.id}/reject`).set(auth(manual.token)).send({});
    expect(await prisma.appointment.findFirst({ where: { leadId: lead2.id } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('refuses to book a time that was not offered by the availability check', async () => {
    const owner = await business({ autoBookAppointments: true });
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    await prisma.lead.update({ where: { id: lead.id }, data: { qualification: { summary: 'x', missingInformation: [] } } });
    const ai = scriptedClient([
      () => [toolUse('book_appointment', { lead_id: lead.id, start: '2030-01-01T03:00:00Z', duration_minutes: 60, title: 'Midnight visit', reason: 'Lead asked' })],
      () => [text('Done')],
      () => [text('Done')],
    ]);
    setAIClient(ai);
    const { meetingAgent } = await import('../../src/ai/agents/meeting.js');
    const { runAgent } = await import('../../src/ai/runAgent.js');
    await runAgent(meetingAgent, { businessId: owner.businessId, leadId: lead.id, input: {} }).catch(() => {});
    expect(toolResultsIn(ai.requests[1])[0].payload).toMatchObject({ error: 'SLOT_NOT_OFFERED' });
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('requires the exact offered duration, and finishes cleanly (no failed run) when there is no free slot', async () => {
    const owner = await business({ autoBookAppointments: true });
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    const { meetingAgent } = await import('../../src/ai/agents/meeting.js');
    const { runAgent } = await import('../../src/ai/runAgent.js');

    let offered;
    const ai = scriptedClient([
      () => [toolUse('check_calendar_availability', { lead_id: lead.id, duration_minutes: 60, days_ahead: 10 })],
      (req) => {
        offered = toolResultsIn(req)[0].payload.slots[0].start;
        return [toolUse('book_appointment', { lead_id: lead.id, start: offered, duration_minutes: 480, title: 'All-day visit', reason: 'Lead asked' })];
      },
      (req) => {
        expect(toolResultsIn(req)[0].payload).toMatchObject({ error: 'SLOT_NOT_OFFERED' });
        return [toolUse('book_appointment', { lead_id: lead.id, start: offered, duration_minutes: 60, title: 'Site visit', reason: 'Earliest slot' })];
      },
      () => [text('Booked.')],
    ]);
    setAIClient(ai);
    const booked = await runAgent(meetingAgent, { businessId: owner.businessId, leadId: lead.id, input: {} });
    expect(booked.output).toMatchObject({ outcome: 'BOOKED' });
    expect(await prisma.appointment.count({ where: { leadId: lead.id } })).toBe(1);

    // Open only on Sundays but the lead wants a weekday: nothing can be offered, and the run still succeeds honestly.
    await prisma.business.update({ where: { id: owner.businessId }, data: { workingHours: { sun: [{ open: '09:00', close: '17:00' }] } } });
    const lead2 = await createLead(owner.token, { email: 'second@example.com', enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    setAIClient(scriptedClient([
      () => [toolUse('check_calendar_availability', { lead_id: lead2.id, duration_minutes: 60, days_ahead: 10, weekdays: ['mon', 'tue'] })],
      (req) => {
        expect(toolResultsIn(req)[0].payload.slots).toEqual([]);
        return [text('There is no free slot in the next 10 days.')];
      },
    ]));
    const none = await runAgent(meetingAgent, { businessId: owner.businessId, leadId: lead2.id, input: {} });
    expect(none.run.status).toBe('SUCCEEDED');
    expect(none.output).toMatchObject({ outcome: 'NO_SLOTS', appointment: null });
  });

  it('offers slots only in working hours and free time, prevents double-booking and sends reminders', async () => {
    const owner = await business();
    const lead = await createLead(owner.token);
    const slots = await api().get(`/api/leads/${lead.id}/appointments/slots?durationMinutes=60`).set(auth(owner.token));
    expect(slots.status).toBe(200);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    const first = slots.body.slots[0];
    const hour = new Date(first.start).getUTCHours();
    expect(hour >= 9 && hour < 17).toBe(true); // default hours when none configured

    const booked = await api().post(`/api/leads/${lead.id}/appointments`).set(auth(owner.token)).send({ startsAt: first.start, durationMinutes: 60, title: 'Site visit' });
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ status: 'CONFIRMED', bookedBy: 'USER' });
    const other = await createLead(owner.token, { name: 'Other', email: 'o@example.com' });
    const clash = await api().post(`/api/leads/${other.id}/appointments`).set(auth(owner.token)).send({ startsAt: first.start, durationMinutes: 30, title: 'Clash' });
    expect(clash.status).toBe(409);
    const again = await api().get(`/api/leads/${lead.id}/appointments/slots?durationMinutes=60`).set(auth(owner.token));
    expect(again.body.slots.map((s) => s.start)).not.toContain(first.start);

    const reminder = await processReminder({ data: { appointmentId: booked.body.id, startsAt: booked.body.startsAt } });
    expect(reminder.outcome).toBe('QUEUED');
    expect((await processReminder({ data: { appointmentId: booked.body.id, startsAt: booked.body.startsAt } })).outcome).toBe('NOOP');

    const moved = await api().patch(`/api/appointments/${booked.body.id}`).set(auth(owner.token)).send({ startsAt: slots.body.slots[1].start });
    expect(moved.status).toBe(200);
    const cancelled = await api().post(`/api/appointments/${booked.body.id}/cancel`).set(auth(owner.token)).send({ reason: 'Customer asked' });
    expect(cancelled.body.status).toBe('CANCELLED');
    const types = (await prisma.leadEvent.findMany({ where: { leadId: lead.id } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['APPOINTMENT_BOOKED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED']));

    const outsider = await registerOwner();
    expect((await api().post(`/api/appointments/${booked.body.id}/cancel`).set(auth(outsider.token)).send({})).status).toBe(404);
  });

  it('slot generator respects working hours, busy time and minimum notice', () => {
    const now = Date.parse('2026-11-23T08:00:00Z'); // Monday
    const slots = availableSlots({
      workingHours: { mon: [{ open: '09:00', close: '12:00' }] },
      timeZone: 'UTC',
      busy: [{ start: '2026-11-23T10:00:00Z', end: '2026-11-23T11:00:00Z' }],
      durationMinutes: 60,
      daysAhead: 0,
      minLeadMinutes: 0,
      perDay: 5,
      now,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-11-23T09:00:00.000Z', '2026-11-23T11:00:00.000Z']);
  });
});

describe('follow-up agent and lead processing', () => {
  it('the Follow-up Agent schedules after a send, and respects the autonomy switch', async () => {
    const owner = await business();
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(owner.token, lead.id);
    const draft = await prisma.approval.findFirst({ where: { leadId: lead.id, type: 'OUTBOUND_MESSAGE' } });
    await api().post(`/api/approvals/${draft.id}/approve`).set(auth(owner.token)).send({});
    const sent = await processSendMessage(fakeJob({ messageId: draft.messageId }));
    expect(sent.nextFollowUp).toEqual(expect.any(String));
    const plan = await prisma.agentRun.findFirst({ where: { leadId: lead.id, kind: 'FOLLOW_UP_PLANNING' } });
    expect(plan).toMatchObject({ status: 'SUCCEEDED', output: expect.objectContaining({ decision: 'SCHEDULE' }) });

    const off = await business({ autoScheduleFollowUps: false });
    const lead2 = await createLead(off.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    await startAgent(off.token, lead2.id);
    const draft2 = await prisma.approval.findFirst({ where: { leadId: lead2.id, type: 'OUTBOUND_MESSAGE' } });
    await api().post(`/api/approvals/${draft2.id}/approve`).set(auth(off.token)).send({});
    const sent2 = await processSendMessage(fakeJob({ messageId: draft2.messageId }));
    expect(sent2).toMatchObject({ outcome: 'SENT', nextFollowUp: null, nextFollowUpSkipped: 'AUTONOMY_DISABLED' });
    expect(await prisma.followUpJob.count({ where: { leadId: lead2.id } })).toBe(0);
  });

  it('public enquiries are captured with consent and processed automatically when allowed', async () => {
    const owner = await business();
    const biz = await prisma.business.findUnique({ where: { id: owner.businessId } });
    const form = await api().get(`/api/public/forms/${biz.slug}`);
    expect(form.body.business.name).toBe(biz.name);

    const bad = await api().post(`/api/public/forms/${biz.slug}/leads`).send({ name: 'X', email: 'nope', message: 'short', consent: true });
    expect(bad.status).toBe(400);
    const bot = await api().post(`/api/public/forms/${biz.slug}/leads`).send({ name: 'Bot', email: 'bot@example.com', message: 'Buy cheap stuff now please', consent: false, website: 'http://spam' });
    expect(bot.status).toBe(201);
    expect(await prisma.lead.count({ where: { businessId: owner.businessId } })).toBe(0);
    expect((await api().post('/api/public/forms/no-such-business/leads').send({ name: 'A', email: 'a@example.com', message: 'Hello there, I need help', consent: true })).status).toBe(404);

    const res = await api()
      .post(`/api/public/forms/${biz.slug}/leads`)
      .send({ name: 'Priya Shah', email: 'priya@example.com', message: 'I need garden redesign and lawn maintenance. Can you share an estimated cost? I would like to start within two weeks.', consent: true });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findFirst({ where: { businessId: owner.businessId } });
    expect(lead).toMatchObject({ source: 'WEB_FORM', consentEmail: true, consentSource: `web_form:/f/${biz.slug}` });
    const job = await getQueues()[QUEUES.FOLLOW_UPS].getJob(`process-${lead.id}-created`);
    expect(job.data).toMatchObject({ trigger: 'LEAD_CREATED' });

    const result = await processLead({ data: job.data, attemptsMade: 0, opts: { attempts: 3 } });
    expect(result).toMatchObject({ outcome: 'PROCESSED', nextAction: 'AWAIT_OWNER_APPROVAL' });
    expect(await prisma.agentRun.findFirst({ where: { id: result.runId } })).toMatchObject({ trigger: 'LEAD_CREATED', triggerDetail: 'New enquiry via the website form' });

    // Hackathon demo scenario: grounded analysis, published prices only, owner approval, confirmed send.
    const analysed = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(analysed.qualification.timeline.urgency).toBe('THIS_MONTH');
    expect(analysed.qualification.budget).toMatchObject({ stated: false, min: null, max: null });
    expect(analysed.qualification.missingInformation).toContain('Budget');
    expect(analysed.qualification.missingInformation).not.toContain('Timeline');
    expect(analysed.qualification.matchedServiceIds).toHaveLength(2);
    const draft = await prisma.message.findFirst({ where: { conversation: { leadId: lead.id }, author: 'AI' } });
    expect(draft.status).toBe('PENDING_APPROVAL');
    expect(draft.body).toContain('$150');
    expect(draft.body).toContain('$45–$85');
    for (const price of draft.body.match(/\$[\d,]+/g)) expect(['$150', '$45', '$85']).toContain(price);
    const approval = await prisma.approval.findFirst({ where: { messageId: draft.id, status: 'PENDING' } });
    expect((await api().post(`/api/approvals/${approval.id}/approve`).set(auth(owner.token)).send({})).status).toBe(200);
    const sent = await processSendMessage(fakeJob({ messageId: draft.id, followUpId: null, scheduledFor: null }));
    expect(sent).toMatchObject({ outcome: 'SENT' });
    expect(outbox().at(-1)).toMatchObject({ to: 'priya@example.com' });
    expect(await prisma.message.findUnique({ where: { id: draft.id } })).toMatchObject({ status: 'SENT' });
  });

  it('honours autonomy for automatic processing and automatic responses', async () => {
    const off = await business({ autoScoreLeads: false });
    const lead = await createLead(off.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    expect(await processLead({ data: { businessId: off.businessId, leadId: lead.id, trigger: 'LEAD_CREATED', detail: 'test' }, attemptsMade: 0, opts: { attempts: 3 } })).toMatchObject({ outcome: 'SKIPPED' });
    expect(await prisma.agentRun.count({ where: { leadId: lead.id, kind: 'ORCHESTRATION' } })).toBe(0);

    const noReplies = await business({ autoGenerateResponses: false });
    const lead2 = await createLead(noReplies.token, { enquiry: { channel: 'WEB_FORM', message: PLAIN } });
    const auto = await processLead({ data: { businessId: noReplies.businessId, leadId: lead2.id, trigger: 'LEAD_CREATED', detail: 'test' }, attemptsMade: 0, opts: { attempts: 3 } });
    expect(auto.nextAction).toBe('OWNER_ACTION_REQUIRED');
    expect(await prisma.message.count({ where: { author: 'AI' } })).toBe(0);
    // An owner pressing "Run AI" is an explicit request and still gets a draft.
    await prisma.leadEvent.deleteMany({ where: { leadId: lead2.id, type: 'AGENT_DECISION' } });
    await startAgent(noReplies.token, lead2.id);
    expect(await prisma.message.count({ where: { author: 'AI' } })).toBe(1);
  });
});

describe('Google Calendar adapter', () => {
  it('refreshes the token, checks free/busy and creates events without emailing attendees', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 });
      if (String(url).endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z' }] } } }), { status: 200 });
      return new Response(JSON.stringify({ id: 'evt-1' }), { status: 200 });
    };
    const cal = createGoogleCalendar({ clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt', timeZone: 'America/Denver', fetch });
    expect(await cal.busy('2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z')).toHaveLength(1);
    expect(await cal.createEvent({ title: 'Visit', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', requestId: 'r1' })).toEqual({ id: 'evt-1' });
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1); // token cached
    const create = calls.find((c) => c.url.includes('/events'));
    expect(create.url).toContain('sendUpdates=none');
    expect(create.init.headers.Authorization).toBe('Bearer at-1');
    expect(JSON.parse(create.init.body).id).toMatch(/^rp[0-9a-f]{40}$/); // deterministic id
  });

  it('creates each booking event once: a retry reuses the event, a cancelled one is revived', async () => {
    const calls = [];
    let eventStatus = 'confirmed';
    const fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      if (init.method === 'POST') return new Response(JSON.stringify({ error: { message: 'The requested identifier already exists.' } }), { status: 409 });
      if (init.method === 'GET') return new Response(JSON.stringify({ id: 'x', status: eventStatus }), { status: 200 });
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    };
    const cal = createGoogleCalendar({ clientId: 'c', clientSecret: 's', refreshToken: 'r', timeZone: 'UTC', fetch });
    const first = await cal.createEvent({ title: 'Visit', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', requestId: 'lead:2030' });
    const again = await cal.createEvent({ title: 'Visit', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', requestId: 'lead:2030' });
    expect(again.id).toBe(first.id);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    eventStatus = 'cancelled';
    await cal.createEvent({ title: 'Visit', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', requestId: 'lead:2030' });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });
});

describe('appointment consistency', () => {
  async function bookedPair() {
    const owner = await business();
    const a = await createLead(owner.token, { email: 'a@example.com', enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    const b = await createLead(owner.token, { email: 'b@example.com', enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    const slots = (await api().get(`/api/leads/${a.id}/appointments/slots`).set(auth(owner.token))).body.slots;
    const book = (lead, start) => api().post(`/api/leads/${lead.id}/appointments`).set(auth(owner.token)).send({ startsAt: start, durationMinutes: 60, title: 'Site visit' });
    const first = (await book(a, slots[0].start)).body;
    const second = (await book(b, slots[1].start)).body;
    return { owner, first, second, slots };
  }

  it('concurrent reschedules into the same time cannot both succeed', async () => {
    const { owner, first, second, slots } = await bookedPair();
    const target = new Date(new Date(slots.at(-1).start).getTime() + 86_400_000).toISOString();
    const move = (id) => api().patch(`/api/appointments/${id}`).set(auth(owner.token)).send({ startsAt: target });
    const results = await Promise.all([move(first.id), move(second.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.appointment.count({ where: { startsAt: new Date(target), status: 'CONFIRMED' } })).toBe(1);
  });

  it('a failed calendar write on approval leaves the approval pending so it can be retried', async () => {
    const owner = await business();
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    const slots = (await api().get(`/api/leads/${lead.id}/appointments/slots`).set(auth(owner.token))).body.slots;
    const { book } = await import('../../src/modules/appointments/appointment.service.js');
    const { appointment } = await book({ businessId: owner.businessId }, { leadId: lead.id, start: slots[0].start, durationMinutes: 60, title: 'Site visit', confirm: false, actor: { type: 'AI' } });
    const approval = await prisma.approval.findFirst({ where: { leadId: lead.id, type: 'APPOINTMENT' } });

    const { setCalendarProvider } = await import('../../src/calendar/index.js');
    const failing = { name: 'google', label: 'Google Calendar', busy: async () => [], createEvent: async () => { throw new Error('Google Calendar 503'); }, updateEvent: async () => ({}), cancelEvent: async () => ({}) };
    setCalendarProvider(failing);
    try {
      const res = await api().post(`/api/approvals/${approval.id}/approve`).set(auth(owner.token)).send({});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await prisma.approval.findUnique({ where: { id: approval.id } })).toMatchObject({ status: 'PENDING' });
      expect(await prisma.appointment.findUnique({ where: { id: appointment.id } })).toMatchObject({ status: 'PROPOSED' });
    } finally {
      setCalendarProvider(null);
    }
    const retry = await api().post(`/api/approvals/${approval.id}/approve`).set(auth(owner.token)).send({});
    expect(retry.status).toBe(200);
    expect(await prisma.appointment.findUnique({ where: { id: appointment.id } })).toMatchObject({ status: 'CONFIRMED' });
  });

  it('bookings respect busy time in the connected calendar', async () => {
    const owner = await business();
    const lead = await createLead(owner.token, { enquiry: { channel: 'WEB_FORM', message: ASKS_VISIT } });
    const slots = (await api().get(`/api/leads/${lead.id}/appointments/slots`).set(auth(owner.token))).body.slots;
    const start = new Date(slots[0].start);
    const { setCalendarProvider } = await import('../../src/calendar/index.js');
    setCalendarProvider({ name: "google", label: "Google Calendar", busy: async () => [{ start: start.toISOString(), end: new Date(start.getTime() + 30 * 60e3).toISOString() }], createEvent: async () => ({ id: "e" }), updateEvent: async () => ({}), cancelEvent: async () => ({}) });
    try {
      const res = await api().post(`/api/leads/${lead.id}/appointments`).set(auth(owner.token)).send({ startsAt: start.toISOString(), durationMinutes: 60, title: 'Site visit' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/busy in the connected calendar/);
    } finally {
      setCalendarProvider(null);
    }
  });
});
