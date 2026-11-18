/**
 * Rule-based stand-in for Claude's judgement, used only in mock mode. Good
 * enough to make demos and tests meaningful; not a replacement for the model.
 */

const SYNONYMS = {
  irrigation: ['irrigation', 'sprinkler', 'zone 1', 'zone 2', 'zone 3'],
  lawn: ['lawn', 'mowing', 'mow', 'edging'],
  maintenance: ['maintenance', 'weekly', 'mowing'],
  installation: ['install', 'installation', 'patio', 'paver', 'xeriscape', 'hardscape', 'flagstone'],
  cleanup: ['cleanup', 'clean-up', 'leaves', 'fall', 'spring'],
  consultation: ['consultation', 'consult', 'design', 'redesign'],
  drain: ['drain', 'clog', 'clogged', 'sink'],
  heater: ['heater', 'hot water'],
};
const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'service', 'services', 'repair', 'weekly', 'seasonal', 'garden']);

const lower = (s) => s.toLowerCase();

export function leadText(details) {
  return details.conversation
    .filter((m) => m.from === 'LEAD')
    .map((m) => `${m.subject ?? ''} ${m.body}`)
    .join('\n');
}

function parseNumber(raw, k) {
  const n = Number(raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

export function extractBudget(text) {
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?(?:\s*(?:-|–|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?)?/i;
  const m = text.match(re);
  if (!m) return { stated: false, min: null, max: null, currency: null, notes: null };
  const kMax = Boolean(m[4]);
  const kMin = Boolean(m[2]) || (kMax && Number(m[1]) < 1000);
  const min = parseNumber(m[1], kMin);
  const max = m[3] ? parseNumber(m[3], kMax) : min;
  return { stated: true, min, max, currency: 'USD', notes: `Lead wrote "${m[0].trim()}"` };
}

export function extractTimeline(text) {
  const t = lower(text);
  const rules = [
    ['IMMEDIATE', /\b(today|asap|urgent|emergency|right away|immediately|completely clogged)\b/],
    ['THIS_WEEK', /\b(this week|tomorrow|next week|within (a|one) week|starting next)\b/],
    ['THIS_MONTH', /\b(this month|next month|before|by (the )?(end|first)|(within|in) (\d+|two|three|four|a few|a couple of) weeks|july|june|august|first snow)\b/],
    ['FLEXIBLE', /\b(no rush|flexible|whenever|sometime|next year)\b/],
  ];
  for (const [urgency, re] of rules) {
    const m = t.match(re);
    if (m) return { urgency, description: `Mentions "${m[0]}"` };
  }
  return { urgency: 'UNKNOWN', description: null };
}

export function matchServices(text, services) {
  const t = lower(text);
  return services.filter((s) => {
    const words = lower(s.name)
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w));
    const terms = new Set(words.flatMap((w) => SYNONYMS[w] ?? [w]));
    return [...terms].some((term) => t.includes(term));
  });
}

export function assessIntent(text, timeline, budget, matched) {
  const t = lower(text);
  const signals = [];
  if (/\b(can (someone|you)|come (out|take)|schedule|book|start|quote|available)\b/.test(t)) signals.push('Asks to book, visit or start');
  if (['IMMEDIATE', 'THIS_WEEK'].includes(timeline.urgency)) signals.push('Near-term timeline');
  if (budget.stated) signals.push('Shared a budget');
  if (matched.length) signals.push('Request matches a listed service');
  if (text.length < 60) signals.push('Very short enquiry');

  const strong = signals.filter((s) => s !== 'Very short enquiry').length;
  const level = strong >= 3 ? 'HIGH' : strong >= 1 && text.length >= 60 ? 'MEDIUM' : 'LOW';
  return { level, signals };
}

function minPublishedDollars(services) {
  const mins = services.filter((s) => s.price_type !== 'QUOTE_ONLY').map((s) => Number(s.price.replace(/[^0-9.–]/g, '').split('–')[0]));
  return mins.length ? Math.min(...mins) : null;
}

export function assessSentiment(text) {
  const t = lower(text);
  const pos = t.match(/\b(thanks|thank you|great|love|excited|perfect|happy|appreciate)\b/);
  const neg = t.match(/\b(disappointed|unhappy|frustrat\w*|angry|terrible|complain\w*|too expensive|not happy)\b/);
  if (pos && neg) return { label: 'MIXED', evidence: `"${pos[0]}" … "${neg[0]}"` };
  if (neg) return { label: 'NEGATIVE', evidence: `"${neg[0]}"` };
  if (pos) return { label: 'POSITIVE', evidence: `"${pos[0]}"` };
  return { label: 'NEUTRAL', evidence: null };
}

export function analyse(details, pricing) {
  const text = leadText(details);
  const budget = extractBudget(text);
  const timeline = extractTimeline(text);
  const matched = matchServices(text, pricing.services);
  const intent = assessIntent(text, timeline, budget, matched);

  const missing = [];
  if (!matched.length) missing.push('Which service they need');
  if (!budget.stated && matched.some((s) => s.price_type !== 'FIXED')) missing.push('Budget');
  if (timeline.urgency === 'UNKNOWN') missing.push('Timeline');
  if (text.length < 120) missing.push('Project details (size, location)');

  const urgency = { IMMEDIATE: 32, THIS_WEEK: 27, THIS_MONTH: 18, FLEXIBLE: 10, UNKNOWN: 7 }[timeline.urgency];

  let budgetFit = 8;
  let budgetReason = 'No budget and no matching service yet.';
  const minPrice = minPublishedDollars(matched);
  if (budget.stated && matched.length) {
    if (minPrice === null) {
      budgetFit = 22;
      budgetReason = `Budget of about $${budget.max} for a service that is quoted individually.`;
    } else if (budget.max >= minPrice) {
      budgetFit = 30;
      budgetReason = `Budget of about $${budget.max} covers the published price (from $${minPrice}).`;
    } else {
      budgetFit = 6;
      budgetReason = `Budget of about $${budget.max} is below the published price (from $${minPrice}).`;
    }
  } else if (matched.length) {
    budgetFit = 15;
    budgetReason = 'No budget given, but the request matches a service with a published price.';
  }

  const conversion = Math.max(3, { HIGH: 26, MEDIUM: 17, LOW: 7 }[intent.level] - 2 * missing.length);

  return {
    analysis: {
      summary: `${details.lead.name} enquired about ${matched.length ? matched.map((s) => s.name.toLowerCase()).join(' and ') : 'an unspecified need'}.`,
      requirements: matched.map((s) => s.name),
      budget,
      timeline,
      intent,
      matched_service_ids: matched.map((s) => s.id),
      missing_information: missing,
      sentiment: assessSentiment(text),
    },
    score: {
      urgency,
      budget_fit: budgetFit,
      conversion_likelihood: conversion,
      reasons: [
        timeline.urgency === 'UNKNOWN' ? 'No timeline mentioned.' : `Timeline: ${timeline.description}.`,
        budgetReason,
        `Intent ${intent.level.toLowerCase()}: ${intent.signals.join('; ') || 'few buying signals'}.`,
      ],
    },
  };
}

const QUESTION_FOR = {
  Budget: 'Do you have a rough budget in mind for this?',
  Timeline: 'When would you ideally like the work done?',
  'Which service they need': 'Could you tell me a bit more about what you need help with?',
  'Project details (size, location)': 'Could you share a few details about the property, such as its size and location?',
};

function composeFollowUp(details, pricing, matched, questions, final) {
  const firstName = details.lead.name.split(/\s+/)[0];
  const topic = matched.length ? matched.map((s) => s.name.toLowerCase()).join(' and ') : 'your enquiry';
  const lines = [`Hi ${firstName},`, '', `Just checking in on my last message about ${topic}.`];
  if (final) {
    lines.push("I don't want to fill up your inbox, so this is my last note for now. Whenever you're ready, just reply and we'll pick things up.");
  } else {
    lines.push('Happy to answer any questions, big or small.', '', questions[0]);
  }
  lines.push('', pricing.business.signature);
  return {
    subject: `Following up: ${topic}`.slice(0, 150),
    body: lines.join('\n'),
    questions: final ? [] : [questions[0]],
    referenced_service_ids: [],
  };
}

export function composeReply(details, pricing, goal, guidance = '') {
  const firstName = details.lead.name.split(/\s+/)[0];
  const analysis = details.lead.analysis ?? {};
  const matched = pricing.services.filter((s) => (analysis.matchedServiceIds ?? []).includes(s.id));
  const questions = (analysis.missingInformation ?? []).map((m) => QUESTION_FOR[m]).filter(Boolean).slice(0, 3);
  if (!questions.length) questions.push('What days and times usually work best for you?');
  if (goal === 'FOLLOW_UP') return composeFollowUp(details, pricing, matched, questions, /final follow-up/i.test(guidance));

  const lines = [`Hi ${firstName},`, '', `Thanks for getting in touch with ${pricing.business.name}!`];
  for (const s of matched) {
    lines.push(
      s.price_type === 'QUOTE_ONLY'
        ? `${s.name} is quoted individually, so I'll ask the owner to prepare a quote for you.`
        : `Our ${s.name.toLowerCase()} is ${s.price}.`,
    );
  }
  if (goal !== 'FIRST_RESPONSE' || questions.length) {
    lines.push('', 'To point you in the right direction, could you let me know:');
    for (const q of questions) lines.push(`- ${q}`);
  }
  lines.push('', 'Looking forward to hearing from you.', '', pricing.business.signature);

  return {
    subject: `Re: ${details.conversation.find((m) => m.subject)?.subject ?? `Your enquiry to ${pricing.business.name}`}`.slice(0, 150),
    body: lines.join('\n'),
    questions,
    referenced_service_ids: matched.map((s) => s.id),
  };
}
