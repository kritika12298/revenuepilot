/**
 * Demo data for RevenuePilot.
 *
 * Creates two businesses so tenant isolation can be demonstrated:
 *  - Evergreen Landscaping Co. (rich pipeline across every lead status)
 *  - Northside Plumbing (a couple of leads that Evergreen must never see)
 *
 * Idempotent: removes the demo businesses/users first, then recreates them.
 * Run with `npm run db:seed`.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_IN_PRODUCTION !== '1') {
  console.error('Refusing to seed demo data in production (set ALLOW_SEED_IN_PRODUCTION=1 to override).');
  process.exit(1);
}

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'DemoPass123!';
const DEMO_SLUGS = ['evergreen-landscaping', 'northside-plumbing'];
const DEMO_EMAILS = ['maria@evergreen.example', 'sam@evergreen.example', 'dev@northside.example'];

const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3_600_000);
const daysAgo = (d) => hoursAgo(d * 24);
const hoursFromNow = (h) => new Date(now + h * 3_600_000);
const dollars = (n) => n * 100;

const weekdayHours = [{ open: '08:00', close: '17:00' }];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createLead(tx, businessId, ownerId, spec) {
  const { messages = [], scored, events = [], channel = 'EMAIL', subject, ...fields } = spec;
  const createdAt = fields.createdAt;

  const inbound = messages.filter((m) => m.author === 'LEAD').map((m) => m.at);
  const outbound = messages.filter((m) => m.author !== 'LEAD' && (m.status ?? 'SENT') === 'SENT').map((m) => m.at);
  const latest = (dates) => (dates.length ? new Date(Math.max(...dates.map(Number))) : null);

  const lead = await tx.lead.create({
    data: {
      businessId,
      lastInboundAt: latest(inbound),
      lastOutboundAt: latest(outbound),
      ...fields,
      ...(scored && {
        score: scored.urgency + scored.budgetFit + scored.conversionLikelihood,
        scoreBreakdown: { ...scored, method: scored.method ?? 'SEED', scoredAt: createdAt.toISOString() },
      }),
    },
  });

  await tx.leadEvent.create({
    data: {
      businessId,
      leadId: lead.id,
      type: 'CREATED',
      actorType: 'SYSTEM',
      data: { source: lead.source, hasEnquiry: messages.length > 0 },
      createdAt,
    },
  });

  let conversation = null;
  const createdMessages = [];
  if (messages.length) {
    conversation = await tx.conversation.create({
      data: { businessId, leadId: lead.id, channel, subject, createdAt },
    });
    for (const m of messages) {
      const message = await tx.message.create({
        data: {
          businessId,
          conversationId: conversation.id,
          direction: m.author === 'LEAD' ? 'INBOUND' : 'OUTBOUND',
          author: m.author,
          subject,
          body: m.body,
          status: m.status ?? (m.author === 'LEAD' ? 'RECEIVED' : 'SENT'),
          sentAt: m.status && m.status !== 'SENT' ? null : m.at,
          createdAt: m.at,
        },
      });
      createdMessages.push(message);
      if (message.status === 'RECEIVED' || message.status === 'SENT') {
        await tx.leadEvent.create({
          data: {
            businessId,
            leadId: lead.id,
            type: message.direction === 'INBOUND' ? 'MESSAGE_RECEIVED' : 'MESSAGE_SENT',
            actorType: m.author === 'OWNER' ? 'USER' : m.author,
            actorUserId: m.author === 'OWNER' ? ownerId : null,
            data: { channel },
            createdAt: m.at,
          },
        });
      }
    }
  }

  if (scored) {
    await tx.leadEvent.create({
      data: {
        businessId,
        leadId: lead.id,
        type: 'SCORE_UPDATED',
        actorType: 'SYSTEM',
        data: { from: null, to: lead.score, method: lead.scoreBreakdown?.method ?? 'SEED' },
        createdAt: new Date(createdAt.getTime() + 60_000),
      },
    });
  }

  for (const e of events) {
    await tx.leadEvent.create({
      data: {
        businessId,
        leadId: lead.id,
        actorUserId: e.actorType === 'USER' ? ownerId : null,
        ...e,
      },
    });
  }

  return { lead, conversation, messages: createdMessages };
}

/** Analysis in the shape record_lead_analysis saves; only facts stated in the seeded messages. */
function analysis({ summary, requirements, budget = null, urgency = 'UNKNOWN', timing = null, intent, signals, services = [], missing = [], sentiment = null }) {
  return {
    summary,
    requirements,
    budget: budget ? { stated: true, currency: 'USD', notes: null, ...budget } : { stated: false, min: null, max: null, currency: null, notes: null },
    timeline: { urgency, description: timing },
    intent: { level: intent, signals },
    matchedServiceIds: services,
    missingInformation: missing,
    sentiment,
    analyzedAt: new Date().toISOString(),
    agentRunId: null,
  };
}

async function qualificationRun(tx, businessId, leadId, at, qualification, status = 'SUCCEEDED') {
  return tx.agentRun.create({
    data: {
      businessId,
      leadId,
      kind: 'QUALIFICATION',
      status,
      // Demo history, clearly labelled: never presented as a real Claude call.
      model: 'seed',
      trigger: 'SYSTEM',
      triggerDetail: 'Demo data (seeded)',
      input: { trigger: 'lead.created', seeded: true },
      output: status === 'SUCCEEDED' ? qualification : undefined,
      startedAt: at,
      finishedAt: status === 'SUCCEEDED' ? new Date(at.getTime() + 3200) : null,
      createdAt: at,
    },
  });
}

// ---------------------------------------------------------------------------
// Evergreen Landscaping
// ---------------------------------------------------------------------------

async function seedEvergreen(tx, passwordHash) {
  const business = await tx.business.create({
    data: {
      name: 'Evergreen Landscaping Co.',
      slug: 'evergreen-landscaping',
      timezone: 'America/Denver',
      workingHours: {
        mon: weekdayHours,
        tue: weekdayHours,
        wed: weekdayHours,
        thu: weekdayHours,
        fri: weekdayHours,
        sat: [{ open: '09:00', close: '13:00' }],
      },
      commsPrefs: {
        tone: 'friendly',
        signature: 'Maria Lopez\nEvergreen Landscaping Co.\n(303) 555-0142',
        maxFollowUps: 3,
        followUpCadenceHours: [24, 72, 168],
        channels: ['EMAIL'],
      },
    },
  });

  const owner = await tx.user.create({
    data: {
      email: 'maria@evergreen.example',
      name: 'Maria Lopez',
      passwordHash,
      memberships: { create: { businessId: business.id, role: 'OWNER' } },
    },
  });
  await tx.user.create({
    data: {
      email: 'sam@evergreen.example',
      name: 'Sam Patel',
      passwordHash,
      memberships: { create: { businessId: business.id, role: 'MEMBER' } },
    },
  });

  await tx.service.createMany({
    data: [
      {
        businessId: business.id,
        name: 'Garden design consultation',
        description: 'On-site 90-minute consultation with a concept sketch and plant list.',
        priceType: 'FIXED',
        priceMinCents: dollars(150),
        priceMaxCents: dollars(150),
        durationMinutes: 90,
      },
      {
        businessId: business.id,
        name: 'Weekly lawn maintenance',
        description: 'Mowing, edging, blowing and weed control. Price per visit depends on lot size.',
        priceType: 'RANGE',
        priceMinCents: dollars(45),
        priceMaxCents: dollars(85),
        durationMinutes: 60,
      },
      {
        businessId: business.id,
        name: 'Seasonal cleanup',
        description: 'Spring or fall cleanup: leaves, pruning, bed refresh and haul-away.',
        priceType: 'FIXED',
        priceMinCents: dollars(295),
        priceMaxCents: dollars(295),
        durationMinutes: 240,
      },
      {
        businessId: business.id,
        name: 'Irrigation repair',
        description: 'Sprinkler diagnostics and repair, including head and valve replacement.',
        priceType: 'RANGE',
        priceMinCents: dollars(120),
        priceMaxCents: dollars(400),
        durationMinutes: 120,
      },
      {
        businessId: business.id,
        name: 'Landscape installation',
        description: 'Patios, planting, xeriscaping and hardscape. Quoted after a site visit.',
        priceType: 'QUOTE_ONLY',
        durationMinutes: null,
      },
    ],
  });

  const bid = business.id;
  const oid = owner.id;
  const svc = Object.fromEntries((await tx.service.findMany({ where: { businessId: bid } })).map((x) => [x.name, x.id]));

  // 1. Brand-new web enquiry, not yet processed.
  await createLead(tx, bid, oid, {
    name: 'Priya Shah',
    email: 'priya.shah@example.com',
    phone: '+1 303 555 0198',
    source: 'WEB_FORM',
    status: 'NEW',
    consentEmail: true,
    consentAt: hoursAgo(2),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    lastContactAt: hoursAgo(2),
    createdAt: hoursAgo(2),
    channel: 'WEB_FORM',
    subject: 'Backyard redesign',
    messages: [
      {
        author: 'LEAD',
        at: hoursAgo(2),
        body:
          "Hi! We just bought a house in Highlands Ranch and the backyard is mostly dead grass. We'd love a " +
          'flagstone patio, some native plants and drip irrigation. Hoping to have it done before July 4th for a ' +
          'family party. Budget is around $12-15k. Can someone come take a look?',
      },
    ],
  });

  // 2. Hot qualified lead with an AI draft and a discount request awaiting approval.
  const daniel = await createLead(tx, bid, oid, {
    name: 'Daniel Okafor',
    email: 'daniel@okaforproperties.example.com',
    phone: '+1 720 555 0110',
    company: 'Okafor Property Management',
    source: 'WEB_FORM',
    status: 'QUALIFIED',
    consentEmail: true,
    consentAt: hoursAgo(20),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    lastContactAt: hoursAgo(20),
    createdAt: hoursAgo(20),
    channel: 'WEB_FORM',
    subject: 'Weekly maintenance for 3 rental properties',
    scored: {
      urgency: 30,
      budgetFit: 28,
      conversionLikelihood: 24,
      reasons: [
        'Wants service to start next week',
        'Recurring work across 3 properties fits the weekly maintenance price range',
        'Decision-maker (property manager) with a clear, specific request',
      ],
    },
    messages: [
      {
        author: 'LEAD',
        at: hoursAgo(20),
        body:
          'I manage three single-family rentals in Aurora and need weekly mowing and edging starting next week. ' +
          'Lots are roughly 6,000 sq ft each. Do you offer any multi-property pricing?',
      },
      {
        author: 'AI',
        at: hoursAgo(19),
        status: 'PENDING_APPROVAL',
        body:
          'Hi Daniel, thanks for reaching out! Weekly lawn maintenance (mowing, edging, blowing and weed control) ' +
          'runs $45-$85 per visit depending on lot size, and 6,000 sq ft lots usually sit toward the lower end. ' +
          "We have openings starting next Tuesday. Could you share the three addresses so we can confirm pricing? " +
          "I've also asked Maria about multi-property pricing and will get back to you.",
      },
    ],
  });
  const danielRun = await qualificationRun(tx, bid, daniel.lead.id, hoursAgo(20), {
    requirements: ['Weekly mowing and edging', '3 properties', '~6,000 sq ft lots'],
    budget: { stated: false, notes: 'Asked about multi-property pricing' },
    timeline: 'Start next week',
    intent: 'HIGH',
    missingInfo: ['Property addresses', 'Gate/access details'],
    matchedServices: ['Weekly lawn maintenance'],
  });
  await tx.approval.create({
    data: {
      businessId: bid,
      leadId: daniel.lead.id,
      agentRunId: danielRun.id,
      type: 'DISCOUNT',
      payload: { kind: 'PERCENT', value: 10, appliesTo: 'Weekly lawn maintenance', condition: '3+ properties' },
      aiRationale:
        'Lead asked about multi-property pricing for 3 recurring weekly contracts. A 10% discount is a common ' +
        'incentive, but discounts require owner approval.',
      createdAt: hoursAgo(19),
    },
  });
  await tx.approval.create({
    data: {
      businessId: bid,
      leadId: daniel.lead.id,
      messageId: daniel.messages[1].id,
      agentRunId: danielRun.id,
      type: 'OUTBOUND_MESSAGE',
      payload: { channel: 'EMAIL', subject: 'Re: Weekly maintenance for 3 rental properties' },
      aiRationale: 'First response to a high-intent lead; quotes only the published price range.',
      createdAt: hoursAgo(19),
    },
  });
  await tx.leadEvent.create({
    data: {
      businessId: bid,
      leadId: daniel.lead.id,
      type: 'APPROVAL_REQUESTED',
      actorType: 'AI',
      data: { types: ['DISCOUNT', 'OUTBOUND_MESSAGE'] },
      createdAt: hoursAgo(19),
    },
  });

  // 3. Contacted, follow-up scheduled.
  const hannah = await createLead(tx, bid, oid, {
    name: 'Hannah Becker',
    email: 'hbecker@example.com',
    source: 'EMAIL',
    status: 'CONTACTED',
    consentEmail: true,
    consentAt: daysAgo(2),
    consentSource: 'email:inbound',
    firstResponseAt: new Date(daysAgo(2).getTime() + 240 * 60_000),
    lastContactAt: daysAgo(2),
    createdAt: daysAgo(2),
    subject: 'Sprinkler zone not working',
    scored: {
      urgency: 22,
      budgetFit: 20,
      conversionLikelihood: 19,
      reasons: ['Broken zone with lawn browning: moderate urgency', 'Repair falls within published range', 'Has not confirmed a time yet'],
    },
    messages: [
      {
        author: 'LEAD',
        at: daysAgo(2),
        body: 'Zone 3 of my sprinklers stopped working and the front lawn is browning. Can you fix it this week?',
      },
      {
        author: 'OWNER',
        at: new Date(daysAgo(2).getTime() + 45 * 60_000),
        body:
          'Hi Hannah, sorry to hear that! Irrigation repairs typically run $120-$400 depending on whether it is a ' +
          'head, line or valve issue. We have Thursday 10am or Friday 2pm open. Would either work?',
      },
    ],
  });
  const hannahFollowUp = await tx.message.create({
    data: {
      businessId: bid,
      conversationId: hannah.conversation.id,
      direction: 'OUTBOUND',
      author: 'AI',
      subject: 'Sprinkler zone not working',
      body:
        'Hi Hannah, just checking in on your sprinkler repair. Let me know which days suit you this week ' +
        'and we will get you booked in.',
      status: 'APPROVED',
      createdAt: daysAgo(1),
    },
  });
  await tx.followUpJob.create({
    data: {
      businessId: bid,
      leadId: hannah.lead.id,
      messageId: hannahFollowUp.id,
      step: 1,
      scheduledFor: hoursFromNow(6),
      status: 'SCHEDULED',
    },
  });
  await tx.leadEvent.create({
    data: {
      businessId: bid,
      leadId: hannah.lead.id,
      type: 'FOLLOW_UP_SCHEDULED',
      actorType: 'USER',
      actorUserId: oid,
      data: { step: 1 },
      createdAt: daysAgo(1),
    },
  });

  // 4. Engaged: lead replied.
  await createLead(tx, bid, oid, {
    name: 'Luis Romero',
    qualification: analysis({
      summary: 'Homeowner wants a fall cleanup before the first snow: leaves and cutting back perennials, about a quarter acre.',
      requirements: ['Fall leaf cleanup', 'Cut back perennials', 'About a quarter acre, two big maples'],
      urgency: 'THIS_MONTH',
      timing: 'Before the first snow',
      intent: 'MEDIUM',
      signals: ['Replied with property details', 'Asked whether the price still applies'],
      services: [svc['Seasonal cleanup']],
      sentiment: { label: 'POSITIVE', evidence: null },
    }),
    email: 'luis.romero@example.com',
    phone: '+1 303 555 0177',
    source: 'WEB_FORM',
    status: 'ENGAGED',
    consentEmail: true,
    consentAt: daysAgo(4),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    firstResponseAt: new Date(daysAgo(4).getTime() + 410 * 60_000),
    lastContactAt: daysAgo(1),
    createdAt: daysAgo(4),
    channel: 'WEB_FORM',
    subject: 'Fall cleanup',
    scored: {
      urgency: 24,
      budgetFit: 30,
      conversionLikelihood: 20,
      reasons: ['Wants cleanup before first snow', 'Fixed-price service matches request', 'Actively replying'],
    },
    messages: [
      { author: 'LEAD', at: daysAgo(4), body: 'Looking for a fall cleanup before the first snow. Mostly leaves and cutting back perennials.' },
      {
        author: 'AI',
        at: new Date(daysAgo(4).getTime() + 20 * 60_000),
        body:
          'Hi Luis! Our seasonal cleanup is $295 and covers leaves, pruning, a bed refresh and haul-away. ' +
          'Roughly how large is the yard, and are there any trees taller than 15 ft?',
      },
      { author: 'LEAD', at: daysAgo(1), body: 'About a quarter acre, two big maples. Does the price still apply?' },
    ],
  });

  // 5. Appointment booked.
  await createLead(tx, bid, oid, {
    name: 'Grace Kim',
    qualification: analysis({
      summary: 'Wants to convert the front lawn to xeriscape; booked the garden design consultation.',
      requirements: ['Front lawn to xeriscape conversion'],
      budget: { min: 8000, max: 8000, notes: 'Budget about $8k' },
      intent: 'HIGH',
      signals: ['Stated a budget', 'Booked a consultation'],
      services: [svc['Garden design consultation'], svc['Landscape installation']],
      sentiment: { label: 'POSITIVE', evidence: 'Saturday 9am works. See you then!' },
    }),
    email: 'grace.kim@example.com',
    source: 'WEB_FORM',
    status: 'APPOINTMENT_BOOKED',
    consentEmail: true,
    consentAt: daysAgo(6),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    firstResponseAt: new Date(daysAgo(6).getTime() + 95 * 60_000),
    lastContactAt: daysAgo(3),
    createdAt: daysAgo(6),
    channel: 'WEB_FORM',
    subject: 'Xeriscape front yard',
    scored: {
      urgency: 26,
      budgetFit: 32,
      conversionLikelihood: 28,
      reasons: ['Booked a paid consultation', 'Budget of $8k suits a quoted installation', 'Clear scope'],
    },
    messages: [
      { author: 'LEAD', at: daysAgo(6), body: 'Interested in converting our front lawn to xeriscape. Budget about $8k.' },
      {
        author: 'OWNER',
        at: daysAgo(5),
        body: 'Great project! The first step is a $150 garden design consultation. I have Saturday 9am available.',
      },
      { author: 'LEAD', at: daysAgo(3), body: 'Saturday 9am works. See you then!' },
    ],
    events: [
      { type: 'STATUS_CHANGED', actorType: 'USER', data: { from: 'ENGAGED', to: 'APPOINTMENT_BOOKED' }, createdAt: daysAgo(3) },
    ],
  });

  // 6. Won.
  await createLead(tx, bid, oid, {
    name: 'Tom Whitaker',
    qualification: analysis({
      summary: 'Dental office wants the front beds redone; budget approved up to $6k.',
      requirements: ['Redo the beds in front of the dental office'],
      budget: { min: null, max: 6000, notes: 'Budget approved up to $6k' },
      intent: 'HIGH',
      signals: ['Approved budget', 'Approved the quote'],
      services: [svc['Landscape installation']],
    }),
    email: 'tom.whitaker@example.com',
    company: 'Whitaker Dental',
    source: 'API',
    status: 'WON',
    consentEmail: true,
    consentAt: daysAgo(21),
    consentSource: 'api:partner-referral',
    firstResponseAt: new Date(daysAgo(21).getTime() + 95 * 60_000),
    lastContactAt: daysAgo(10),
    createdAt: daysAgo(21),
    subject: 'Office landscaping refresh',
    scored: {
      urgency: 28,
      budgetFit: 33,
      conversionLikelihood: 29,
      reasons: ['Commercial client with approved budget', 'Wanted completion within the month', 'Signed proposal'],
    },
    messages: [
      { author: 'LEAD', at: daysAgo(21), body: 'Need the beds in front of our dental office redone. Budget approved up to $6k.' },
      { author: 'OWNER', at: daysAgo(20), body: 'Thanks Tom, I can do a site visit Wednesday to prepare a quote.' },
      { author: 'LEAD', at: daysAgo(10), body: 'Quote approved, let us get started.' },
    ],
    events: [
      { type: 'STATUS_CHANGED', actorType: 'USER', data: { from: 'APPOINTMENT_BOOKED', to: 'WON' }, createdAt: daysAgo(10) },
    ],
  });

  // 7. Lost on price.
  await createLead(tx, bid, oid, {
    name: 'Aisha Mensah',
    qualification: analysis({
      summary: 'Wants a price for a 400 sq ft paver patio and is comparing quotes.',
      requirements: ['400 sq ft paver patio'],
      budget: { min: 3000, max: 3000, notes: 'Budget is around $3k' },
      urgency: 'FLEXIBLE',
      intent: 'LOW',
      signals: ['Getting a few quotes'],
      services: [svc['Landscape installation']],
    }),
    email: 'aisha.m@example.com',
    source: 'WEB_FORM',
    status: 'LOST',
    lostReason: 'PRICE',
    consentEmail: true,
    consentAt: daysAgo(14),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    firstResponseAt: new Date(daysAgo(13).getTime() + 18 * 60_000),
    lastContactAt: daysAgo(9),
    createdAt: daysAgo(14),
    channel: 'WEB_FORM',
    subject: 'Patio quote',
    scored: {
      urgency: 15,
      budgetFit: 8,
      conversionLikelihood: 12,
      reasons: ['No fixed timeline', '$3k budget is low for a 400 sq ft patio install', 'Comparing several quotes'],
    },
    messages: [
      { author: 'LEAD', at: daysAgo(14), body: 'How much for a 400 sq ft paver patio? Getting a few quotes, budget is around $3k.' },
      {
        author: 'OWNER',
        at: daysAgo(13),
        body: 'Hi Aisha, patios are quoted after a free site visit. Most 400 sq ft paver patios land well above $3k, though.',
      },
      { author: 'LEAD', at: daysAgo(9), body: "Thanks, we've gone with another company." },
    ],
    events: [
      { type: 'STATUS_CHANGED', actorType: 'USER', data: { from: 'CONTACTED', to: 'LOST', lostReason: 'PRICE' }, createdAt: daysAgo(9) },
    ],
  });

  // 8. Lost, never responded.
  await createLead(tx, bid, oid, {
    name: 'Robert Chen',
    email: 'rchen@example.com',
    source: 'WEB_FORM',
    status: 'LOST',
    lostReason: 'NO_RESPONSE',
    consentEmail: true,
    consentAt: daysAgo(30),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    firstResponseAt: new Date(daysAgo(28).getTime() + 18 * 60_000),
    lastContactAt: daysAgo(20),
    createdAt: daysAgo(30),
    channel: 'WEB_FORM',
    subject: 'Tree trimming?',
    scored: {
      urgency: 8,
      budgetFit: 10,
      conversionLikelihood: 12,
      reasons: ['Enquiry arrived on a Sunday evening and first reply took 2 days', 'Tree trimming is not a listed service', 'No reply to 3 follow-ups'],
    },
    messages: [
      { author: 'LEAD', at: daysAgo(30), body: 'Do you trim trees? Have two overgrown spruces.' },
      { author: 'OWNER', at: daysAgo(28), body: "Hi Robert, we don't do large tree work, but we can prune shrubs and small ornamentals." },
    ],
    events: [
      { type: 'STATUS_CHANGED', actorType: 'USER', data: { from: 'CONTACTED', to: 'LOST', lostReason: 'NO_RESPONSE' }, createdAt: daysAgo(20) },
    ],
  });

  // 9. Opted out.
  await createLead(tx, bid, oid, {
    name: 'Emily Novak',
    email: 'emily.novak@example.com',
    source: 'WEB_FORM',
    status: 'OPTED_OUT',
    consentEmail: false,
    consentAt: daysAgo(12),
    consentSource: 'web_form:evergreen-landscaping.com/contact',
    optedOutAt: daysAgo(8),
    firstResponseAt: new Date(daysAgo(12).getTime() + 240 * 60_000),
    lastContactAt: daysAgo(8),
    createdAt: daysAgo(12),
    channel: 'WEB_FORM',
    subject: 'Mulch delivery',
    messages: [{ author: 'LEAD', at: daysAgo(12), body: 'Do you deliver mulch?' }],
    events: [
      { type: 'OPTED_OUT', actorType: 'LEAD', data: { from: 'CONTACTED', to: 'OPTED_OUT', via: 'unsubscribe_link' }, createdAt: daysAgo(8) },
    ],
  });

  // 10. Fresh API enquiry, not analysed yet (the worker or "Run AI" picks it up).
  await createLead(tx, bid, oid, {
    name: 'Marcus Bell',
    email: 'marcus.bell@example.com',
    source: 'API',
    status: 'NEW',
    consentEmail: true,
    consentAt: hoursAgo(1),
    consentSource: 'api:website-chat-widget',
    lastContactAt: hoursAgo(1),
    createdAt: hoursAgo(1),
    subject: 'Drip irrigation for raised beds',
    messages: [{ author: 'LEAD', at: hoursAgo(1), body: 'Can you install drip irrigation for 6 raised garden beds?' }],
  });

  // 11. Vague email enquiry, missing information.
  await createLead(tx, bid, oid, {
    name: 'Sofia Alvarez',
    email: 'sofia.alvarez@example.com',
    source: 'EMAIL',
    status: 'NEW',
    consentEmail: false,
    lastContactAt: hoursAgo(5),
    createdAt: hoursAgo(5),
    subject: 'Pricing?',
    messages: [{ author: 'LEAD', at: hoursAgo(5), body: 'Hi, how much do you charge?' }],
  });

  return business;
}

// ---------------------------------------------------------------------------
// Northside Plumbing (second tenant, for isolation demos)
// ---------------------------------------------------------------------------

async function seedNorthside(tx, passwordHash) {
  const business = await tx.business.create({
    data: {
      name: 'Northside Plumbing',
      slug: 'northside-plumbing',
      timezone: 'America/Chicago',
      workingHours: { mon: weekdayHours, tue: weekdayHours, wed: weekdayHours, thu: weekdayHours, fri: weekdayHours },
      commsPrefs: { tone: 'professional', maxFollowUps: 2, followUpCadenceHours: [24, 96], channels: ['EMAIL'] },
    },
  });
  const owner = await tx.user.create({
    data: {
      email: 'dev@northside.example',
      name: 'Dev Raman',
      passwordHash,
      memberships: { create: { businessId: business.id, role: 'OWNER' } },
    },
  });
  await tx.service.createMany({
    data: [
      { businessId: business.id, name: 'Drain cleaning', priceType: 'FIXED', priceMinCents: dollars(189), priceMaxCents: dollars(189), durationMinutes: 60 },
      { businessId: business.id, name: 'Water heater replacement', priceType: 'QUOTE_ONLY' },
    ],
  });
  await createLead(tx, business.id, owner.id, {
    name: 'Karen Liu',
    email: 'karen.liu@example.com',
    source: 'WEB_FORM',
    status: 'NEW',
    consentEmail: true,
    consentAt: hoursAgo(3),
    consentSource: 'web_form:northsideplumbing.example/contact',
    createdAt: hoursAgo(3),
    channel: 'WEB_FORM',
    subject: 'Kitchen sink clogged',
    messages: [{ author: 'LEAD', at: hoursAgo(3), body: 'Kitchen sink is completely clogged, can someone come today?' }],
  });
  await createLead(tx, business.id, owner.id, {
    name: 'James Porter',
    phone: '+1 312 555 0133',
    source: 'MANUAL',
    status: 'CONTACTED',
    createdAt: daysAgo(1),
    scored: { urgency: 20, budgetFit: 15, conversionLikelihood: 18, reasons: ['Phoned in; wants quote for 50-gallon heater'] },
  });
  return business;
}

// ---------------------------------------------------------------------------

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await prisma.$transaction(
    async (tx) => {
      // Cascades remove all tenant data for the demo businesses.
      await tx.business.deleteMany({ where: { slug: { in: DEMO_SLUGS } } });
      await tx.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });

      await seedEvergreen(tx, passwordHash);
      await seedNorthside(tx, passwordHash);
    },
    { timeout: 60_000 },
  );

  // Derive recommendations from the seeded data now, rather than waiting for the 15-minute worker schedule.
  const { refreshAll } = await import('../src/modules/recommendations/engine.js');
  const { closeEventBus } = await import('../src/modules/events/eventBus.js');
  const recs = await refreshAll().finally(() => closeEventBus());
  console.log(`Recommendations detected: ${recs.created}.`);

  const counts = await Promise.all([prisma.lead.count(), prisma.message.count(), prisma.leadEvent.count()]);
  console.log(`Seeded demo data: ${counts[0]} leads, ${counts[1]} messages, ${counts[2]} lead events.`);
  console.log('\nDemo logins (password from SEED_DEMO_PASSWORD, default "DemoPass123!"):');
  console.log('  maria@evergreen.example   OWNER  Evergreen Landscaping Co.');
  console.log('  sam@evergreen.example     MEMBER Evergreen Landscaping Co.');
  console.log('  dev@northside.example     OWNER  Northside Plumbing');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
