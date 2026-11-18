import { prisma } from '../../lib/prisma.js';
import { CLOSED_STATUSES } from '../leads/lead.status.js';
import { leadCohort, rangeWindow, STAGE_INDEX } from '../dashboard/metrics.js';
import { followUpSettings } from '../followUps/followUp.policy.js';
import { estimateDealValue } from '../revenue/dealValue.js';
import { openOpportunities } from '../revenue/revenue.service.js';

/**
 * Follow-up strategy simulator. Uses the business's own history; when a
 * comparison group is too small the estimate is withheld and the reason is
 * returned instead. Simulations never change anything: applying a strategy
 * is a separate, explicit owner action.
 */
export const MIN_SAMPLE = 5;
const HOUR = 3_600_000;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const DISCLAIMER = 'Simulation based on your past results. It is an estimate, not an actual result, and nothing has been changed.';

function compare(groupA, groupB, success) {
  const a = { size: groupA.length, successes: groupA.filter(success).length };
  const b = { size: groupB.length, successes: groupB.filter(success).length };
  a.rate = pct(a.successes, a.size);
  b.rate = pct(b.successes, b.size);
  const sufficient = a.size >= MIN_SAMPLE && b.size >= MIN_SAMPLE;
  return { a, b, sufficient, reason: sufficient ? null : `Need at least ${MIN_SAMPLE} leads in each group to compare (have ${a.size} and ${b.size}).` };
}

async function avgDealValue(businessId, leads) {
  const services = await prisma.service.findMany({ where: { businessId } });
  const byId = new Map(services.map((s) => [s.id, s]));
  const values = leads.map((l) => estimateDealValue(l, byId).cents).filter((v) => v != null);
  return values.length ? Math.round(values.reduce((a, v) => a + v, 0) / values.length) : null;
}

async function responseTime(ctx, { targetMinutes, segment }, since) {
  const cohort = await leadCohort(ctx.businessId, since);
  const inSegment = cohort.filter((l) => segment === 'ALL' || (l.score ?? 0) >= 75 || l.qualification?.intent?.level === 'HIGH');
  const answered = inSegment.filter((l) => l.firstResponseAt);
  const minutes = (l) => (l.firstResponseAt - l.createdAt) / 60_000;
  const fast = answered.filter((l) => minutes(l) <= targetMinutes);
  const slow = answered.filter((l) => minutes(l) > targetMinutes);
  const waitingNow = inSegment.filter((l) => !l.firstResponseAt && !CLOSED_STATUSES.has(l.status) && Date.now() - l.createdAt > targetMinutes * 60_000);
  const engaged = (l) => l.reachedStage >= STAGE_INDEX.ENGAGED;
  const cmp = compare(fast, slow, engaged);
  const sorted = answered.map(minutes).sort((x, y) => x - y);
  const avgValue = await avgDealValue(ctx.businessId, slow);
  const extra = cmp.sufficient ? (slow.length * (cmp.a.rate - cmp.b.rate)) / 100 : null;
  return {
    current: {
      leadsInSegment: inSegment.length,
      answered: answered.length,
      medianFirstResponseMinutes: sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : null,
      withinTarget: fast.length,
      slowerThanTarget: slow.length,
    },
    affected: { count: slow.length + waitingNow.length, description: `${slow.length} answered slower than ${targetMinutes} min; ${waitingNow.length} still waiting longer than that now`, leads: waitingNow.slice(0, 10).map((l) => ({ id: l.id })) },
    historical: { metric: 'Reached Engaged or later', fast: cmp.a, slow: cmp.b, fastLabel: `Answered within ${targetMinutes} min`, slowLabel: `Answered later` },
    estimate: cmp.sufficient
      ? { available: true, additionalEngagedLeads: Math.round(extra * 10) / 10, valueCents: avgValue == null ? null : Math.round(extra * avgValue), basis: `Applies the engagement rate of leads answered within ${targetMinutes} min (${cmp.a.rate}%) to the ${slow.length} slower ones (${cmp.b.rate}%).` }
      : { available: false, reason: cmp.reason },
    suggestion: 'Turning on "Send replies without my approval" in Autonomy is the most direct way to answer within minutes.',
  };
}

async function firstFollowUpDelay(ctx, { delayHours }, since) {
  const firsts = await prisma.followUpJob.findMany({
    where: { businessId: ctx.businessId, step: 1, status: 'SENT', ...(since && { updatedAt: { gte: since } }), anchorMessageId: { not: null } },
    select: { updatedAt: true, anchorMessageId: true, lead: { select: { lastInboundAt: true } } },
  });
  const anchors = new Map((await prisma.message.findMany({ where: { id: { in: firsts.map((f) => f.anchorMessageId) } }, select: { id: true, sentAt: true } })).map((m) => [m.id, m.sentAt]));
  const rows = firsts.filter((f) => anchors.get(f.anchorMessageId)).map((f) => ({ delayH: (f.updatedAt - anchors.get(f.anchorMessageId)) / HOUR, replied: Boolean(f.lead.lastInboundAt && f.lead.lastInboundAt > f.updatedAt) }));
  const cmp = compare(rows.filter((r) => r.delayH <= delayHours), rows.filter((r) => r.delayH > delayHours), (r) => r.replied);
  const pending = await prisma.followUpJob.findMany({ where: { businessId: ctx.businessId, step: 1, status: { in: ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED'] } }, select: { id: true } });
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId } });
  const settings = followUpSettings(business);
  return {
    current: { cadenceHours: settings.cadenceHours, firstFollowUpDelayHours: settings.cadenceHours[0], firstFollowUpsSent: rows.length },
    affected: { count: pending.length, description: `${pending.length} first follow-ups are planned and would use the new delay if applied` },
    historical: { metric: 'Lead replied after the follow-up', fast: cmp.a, slow: cmp.b, fastLabel: `Sent within ${delayHours}h`, slowLabel: `Sent after ${delayHours}h` },
    estimate: cmp.sufficient
      ? { available: true, replyRateChange: Math.round((cmp.a.rate - cmp.b.rate) * 10) / 10, basis: `Reply rate of first follow-ups sent within ${delayHours}h vs later.` }
      : { available: false, reason: cmp.reason },
    apply: { commsPrefs: { followUpCadenceHours: [delayHours, ...settings.cadenceHours.slice(1)] }, description: `Set the first follow-up delay to ${delayHours} hours` },
  };
}

async function frequency(ctx, { maxFollowUps }, since) {
  const sent = await prisma.followUpJob.findMany({
    where: { businessId: ctx.businessId, status: 'SENT', ...(since && { updatedAt: { gte: since } }) },
    select: { step: true, updatedAt: true, lead: { select: { lastInboundAt: true } } },
  });
  const byStep = {};
  for (const f of sent) {
    byStep[f.step] ??= { sent: 0, replied: 0 };
    byStep[f.step].sent += 1;
    if (f.lead.lastInboundAt && f.lead.lastInboundAt > f.updatedAt) byStep[f.step].replied += 1;
  }
  const steps = Object.entries(byStep).map(([step, v]) => ({ step: Number(step), ...v, replyRate: pct(v.replied, v.sent) })).sort((a, b) => a.step - b.step);
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId } });
  const settings = followUpSettings(business);
  const inSequence = await prisma.lead.count({ where: { businessId: ctx.businessId, status: { in: ['QUALIFIED', 'CONTACTED', 'ENGAGED'] }, consentEmail: true, followUpJobs: { some: {} } } });
  const lastStep = steps.at(-1);
  const extraSteps = maxFollowUps - settings.maxFollowUps;
  const estimate =
    extraSteps > 0 && lastStep && lastStep.sent >= MIN_SAMPLE
      ? { available: true, additionalRepliesPerLead: Math.round((extraSteps * lastStep.replyRate) / 100 * 100) / 100, basis: `Assumes each extra follow-up performs like your last step (${lastStep.replyRate}% reply rate over ${lastStep.sent} sends); later follow-ups usually perform worse.` }
      : { available: false, reason: extraSteps <= 0 ? 'Fewer follow-ups cannot add replies; the change reduces contact frequency.' : `Need at least ${MIN_SAMPLE} sends at your current last step to estimate (have ${lastStep?.sent ?? 0}).` };
  return {
    current: { maxFollowUps: settings.maxFollowUps, cadenceHours: settings.cadenceHours, byStep: steps },
    affected: { count: inSequence, description: `${inSequence} consenting open leads have follow-ups and would follow the new limit` },
    historical: { metric: 'Reply rate by follow-up step', steps },
    estimate,
    apply: {
      commsPrefs: { maxFollowUps, followUpCadenceHours: Array.from({ length: Math.max(1, maxFollowUps) }, (_, i) => settings.cadenceHours[i] ?? settings.cadenceHours.at(-1)) },
      description: `Allow up to ${maxFollowUps} follow-ups per lead`,
    },
  };
}

async function prioritise(ctx, { by }) {
  const { opportunities } = await openOpportunities(ctx.businessId);
  const score = (o) => (by === 'VALUE' ? (o.weightedCents ?? 0) : by === 'SCORE' ? (o.lead.score ?? 0) : o.risks.length * 1000 + (o.lead.score ?? 0));
  const ranked = [...opportunities].sort((a, b) => score(b) - score(a)).slice(0, 10);
  return {
    current: { openLeads: opportunities.length },
    affected: { count: ranked.length, description: 'Leads to work on first under this rule', leads: ranked.map((o) => ({ id: o.lead.id, name: o.lead.name, status: o.lead.status, score: o.lead.score, weightedCents: o.weightedCents, risks: o.risks })) },
    historical: null,
    estimate: { available: false, reason: 'Prioritisation changes the order of work, not outcomes we can measure in advance.' },
  };
}

const SCENARIOS = { RESPONSE_TIME: responseTime, FIRST_FOLLOW_UP_DELAY: firstFollowUpDelay, FOLLOW_UP_FREQUENCY: frequency, PRIORITISATION: prioritise };

export async function simulate(ctx, { scenario, params, range }) {
  const { since } = rangeWindow(range);
  const result = await SCENARIOS[scenario](ctx, params, since);
  return { scenario, params, range, kind: 'SIMULATION', disclaimer: DISCLAIMER, minSample: MIN_SAMPLE, ...result };
}
