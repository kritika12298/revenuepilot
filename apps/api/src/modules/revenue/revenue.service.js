import { prisma } from '../../lib/prisma.js';
import { CLOSED_STATUSES } from '../leads/lead.status.js';
import { leadCohort, rangeWindow, STAGE_INDEX } from '../dashboard/metrics.js';
import { estimateDealValue } from './dealValue.js';

/**
 * Revenue intelligence. All values are estimates derived from actual lead
 * data and documented rules; nothing here is guaranteed revenue.
 *
 * Win probability per pipeline stage:
 *   - DEFAULT_PROBABILITY below (conservative small-business defaults), or
 *   - the business's own history once at least MIN_CLOSED closed leads
 *     reached that stage: won / (won + lost) among them.
 */
export const DEFAULT_PROBABILITY = { NEW: 0.05, QUALIFYING: 0.1, QUALIFIED: 0.2, CONTACTED: 0.25, ENGAGED: 0.4, APPOINTMENT_BOOKED: 0.6 };
export const MIN_CLOSED = 10;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export async function stageProbabilities(businessId) {
  const history = await leadCohort(businessId, null);
  const closed = history.filter((l) => l.status === 'WON' || l.status === 'LOST');
  return Object.fromEntries(
    Object.entries(DEFAULT_PROBABILITY).map(([stage, fallback]) => {
      const reached = closed.filter((l) => l.reachedStage >= STAGE_INDEX[stage]);
      if (reached.length >= MIN_CLOSED) {
        const won = reached.filter((l) => l.status === 'WON').length;
        return [stage, { probability: Math.round((won / reached.length) * 100) / 100, method: 'HISTORY', sample: reached.length }];
      }
      return [stage, { probability: fallback, method: 'DEFAULT', sample: reached.length }];
    }),
  );
}

/** Open leads with deal value, probability and risk signals. */
export async function openOpportunities(businessId, now = Date.now()) {
  const [leads, services, probabilities] = await Promise.all([
    prisma.lead.findMany({
      where: { businessId, status: { notIn: [...CLOSED_STATUSES] } },
      select: {
        id: true, name: true, status: true, score: true, qualification: true, dealValueCents: true, createdAt: true,
        lastInboundAt: true, lastOutboundAt: true, lastContactAt: true,
        followUpJobs: { where: { status: { in: ['PENDING_APPROVAL', 'SCHEDULED'] } }, select: { status: true, scheduledFor: true } },
        approvals: { where: { status: 'PENDING' }, select: { type: true, createdAt: true } },
      },
    }),
    prisma.service.findMany({ where: { businessId } }),
    stageProbabilities(businessId),
  ]);
  const byId = new Map(services.map((s) => [s.id, s]));
  return {
    probabilities,
    opportunities: leads.map((lead) => {
      const value = estimateDealValue(lead, byId);
      const p = probabilities[lead.status]?.probability ?? 0;
      const intent = lead.qualification?.intent?.level ?? null;
      const tier = (lead.score ?? 0) >= 75 || intent === 'HIGH' ? 'HIGH' : (lead.score ?? 0) >= 50 || intent === 'MEDIUM' ? 'MEDIUM' : 'LOW';
      const risks = [];
      const waiting = lead.lastInboundAt && (!lead.lastOutboundAt || lead.lastInboundAt > lead.lastOutboundAt);
      if (waiting && now - lead.lastInboundAt > DAY) risks.push(`Waiting ${Math.round((now - lead.lastInboundAt) / HOUR)}h for our reply`);
      const lastTouch = Math.max(lead.lastContactAt?.getTime() ?? 0, lead.createdAt.getTime());
      if (now - lastTouch > 7 * DAY) risks.push(`No activity for ${Math.round((now - lastTouch) / DAY)} days`);
      for (const f of lead.followUpJobs) if (f.scheduledFor.getTime() < now - HOUR) risks.push(f.status === 'PENDING_APPROVAL' ? 'Follow-up overdue: waiting for your approval' : 'Follow-up overdue');
      for (const a of lead.approvals) if (now - a.createdAt > DAY) risks.push(`${a.type.toLowerCase().replace('_', ' ')} approval waiting ${Math.round((now - a.createdAt) / HOUR)}h`);
      return {
        lead: { id: lead.id, name: lead.name, status: lead.status, score: lead.score },
        valueCents: value.cents,
        valueSource: value.source,
        valueBasis: value.basis,
        probability: p,
        weightedCents: value.cents == null ? null : Math.round(value.cents * p),
        tier,
        risks,
      };
    }),
  };
}

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);

export async function pipelineTotals(businessId) {
  const { opportunities } = await openOpportunities(businessId);
  const valued = opportunities.filter((o) => o.valueCents != null);
  return {
    valueCents: sum(valued, 'valueCents'),
    weightedCents: sum(valued, 'weightedCents'),
    leadsWithValue: valued.length,
    leadsWithoutValue: opportunities.length - valued.length,
  };
}

export async function revenueOverview(ctx, { range }) {
  const now = Date.now();
  const { since, days } = rangeWindow(range, now);
  const [{ opportunities, probabilities }, cohort, services] = await Promise.all([
    openOpportunities(ctx.businessId, now),
    leadCohort(ctx.businessId, since),
    prisma.service.findMany({ where: { businessId: ctx.businessId } }),
  ]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const valued = opportunities.filter((o) => o.valueCents != null);
  const tierSummary = (tier) => {
    const rows = opportunities.filter((o) => o.tier === tier);
    return { count: rows.length, valueCents: sum(rows.filter((r) => r.valueCents != null), 'valueCents'), weightedCents: sum(rows.filter((r) => r.valueCents != null), 'weightedCents') };
  };
  const atRisk = opportunities.filter((o) => o.risks.length).sort((a, b) => (b.valueCents ?? 0) - (a.valueCents ?? 0));
  const closedInRange = cohort.filter((l) => l.status === 'WON' || l.status === 'LOST');
  const valueOf = (l) => estimateDealValue(l, byId).cents ?? 0;
  const lost = cohort.filter((l) => l.status === 'LOST');
  const lostReasons = {};
  for (const l of lost) lostReasons[l.lostReason ?? 'OTHER'] = (lostReasons[l.lostReason ?? 'OTHER'] ?? 0) + 1;

  // Weekly conversion trend over the range (or the last 12 weeks for "all").
  const weeks = Math.min(12, Math.max(1, Math.ceil((days ?? 84) / 7)));
  const trend = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = now - (i + 1) * 7 * DAY;
    const end = now - i * 7 * DAY;
    const created = cohort.filter((l) => l.createdAt.getTime() >= start && l.createdAt.getTime() < end);
    trend.push({
      weekStart: new Date(start).toISOString().slice(0, 10),
      leads: created.length,
      won: created.filter((l) => l.status === 'WON').length,
      conversionRate: created.length ? Math.round((created.filter((l) => l.status === 'WON').length / created.length) * 1000) / 10 : null,
    });
  }

  const attention = [...opportunities]
    .filter((o) => o.tier !== 'LOW' || o.risks.length)
    .sort((a, b) => (b.weightedCents ?? 0) + b.risks.length * 1e6 - ((a.weightedCents ?? 0) + a.risks.length * 1e6))
    .slice(0, 8);

  return {
    range: days ? range : 'all',
    disclaimer: 'Estimates based on deal values and win probabilities, not guaranteed revenue.',
    pipeline: {
      openLeads: opportunities.length,
      leadsWithValue: valued.length,
      leadsWithoutValue: opportunities.length - valued.length,
      valueCents: sum(valued, 'valueCents'),
      weightedCents: sum(valued, 'weightedCents'),
    },
    tiers: { high: tierSummary('HIGH'), medium: tierSummary('MEDIUM'), low: tierSummary('LOW') },
    atRisk: { count: atRisk.length, leadsWithValue: atRisk.filter((o) => o.valueCents != null).length, valueCents: sum(atRisk.filter((o) => o.valueCents != null), 'valueCents'), leads: atRisk.slice(0, 10) },
    lost: { count: lost.length, valueCents: lost.reduce((a, l) => a + valueOf(l), 0), reasons: lostReasons },
    won: { count: cohort.filter((l) => l.status === 'WON').length, valueCents: cohort.filter((l) => l.status === 'WON').reduce((a, l) => a + valueOf(l), 0) },
    needsAttention: attention,
    trend,
    methodology: {
      probabilities,
      dealValue: 'Owner-entered value, else midpoint of the budget the lead stated, else published prices of the matched services. Leads without any of these are excluded from totals.',
      tiers: 'High intent: score 75+ or high intent from the AI analysis. Medium: score 50-74 or medium intent.',
      risk: 'At risk: waiting over 24h for our reply, no activity for 7+ days, an overdue follow-up, or an approval waiting over 24h.',
    },
    dataSufficiency: {
      closedLeadsInRange: closedInRange.length,
      sufficient: Object.values(probabilities).some((p) => p.method === 'HISTORY'),
      note: Object.values(probabilities).some((p) => p.method === 'HISTORY')
        ? 'Some stage probabilities use your own conversion history.'
        : `Not enough closed leads yet (need ${MIN_CLOSED} per stage) to use your own history; default probabilities are used.`,
    },
  };
}
