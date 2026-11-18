import { prisma } from '../../lib/prisma.js';

/**
 * Lead cohort metrics shared by the dashboard summary, the funnel and the
 * insights agent, so every number on the Overview comes from one definition.
 *
 * "Reached stage" = the furthest pipeline stage a lead has ever been at, from
 * its current status, its status history and whether we have emailed it. A
 * lead that was qualified and later lost still counts as qualified.
 */

export const FUNNEL_STAGES = ['NEW', 'QUALIFYING', 'QUALIFIED', 'CONTACTED', 'ENGAGED', 'APPOINTMENT_BOOKED', 'WON'];

export const STAGE_INDEX = {
  NEW: 0,
  QUALIFYING: 1,
  QUALIFIED: 2,
  CONTACTED: 3,
  ENGAGED: 4,
  APPOINTMENT_BOOKED: 5,
  WON: 6,
};

export const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const DAY = 86_400_000;

export function rangeWindow(range, now = Date.now()) {
  const days = RANGE_DAYS[range] ?? null;
  return {
    days,
    since: days ? new Date(now - days * DAY) : null,
    previousSince: days ? new Date(now - 2 * days * DAY) : null,
  };
}

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/** Leads created in the window, each with the furthest stage it reached. */
export async function leadCohort(businessId, since) {
  const leads = await prisma.lead.findMany({
    where: { businessId, ...(since && { createdAt: { gte: since } }) },
    select: {
      id: true,
      status: true,
      source: true,
      score: true,
      lostReason: true,
      createdAt: true,
      firstResponseAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      qualification: true,
    },
  });
  if (!leads.length) return [];

  const events = await prisma.leadEvent.findMany({
    where: { businessId, leadId: { in: leads.map((l) => l.id) }, type: { in: ['STATUS_CHANGED', 'OPTED_OUT'] } },
    select: { leadId: true, data: true },
  });
  const history = new Map();
  for (const e of events) {
    const list = history.get(e.leadId) ?? [];
    list.push(e.data?.from, e.data?.to);
    history.set(e.leadId, list);
  }

  return leads.map((lead) => {
    let reached = STAGE_INDEX[lead.status] ?? 0;
    // Analysed by the AI (or reviewed) counts as having entered qualification.
    if (lead.qualification || lead.score != null) reached = Math.max(reached, STAGE_INDEX.QUALIFYING);
    for (const status of history.get(lead.id) ?? []) reached = Math.max(reached, STAGE_INDEX[status] ?? 0);
    if (lead.lastOutboundAt) reached = Math.max(reached, STAGE_INDEX.CONTACTED);
    if (lead.lastOutboundAt && lead.lastInboundAt && lead.lastInboundAt > lead.firstResponseAt) {
      reached = Math.max(reached, STAGE_INDEX.ENGAGED);
    }
    return { ...lead, reachedStage: reached };
  });
}

/**
 * Funnel: how many leads reached each stage (cumulative), the share of all
 * leads, and the step conversion from the previous stage.
 */
export function funnel(cohort) {
  const total = cohort.length;
  return FUNNEL_STAGES.map((stage, i) => {
    const count = cohort.filter((l) => l.reachedStage >= i).length;
    const previous = i === 0 ? total : cohort.filter((l) => l.reachedStage >= i - 1).length;
    return {
      stage,
      count,
      percentOfTotal: pct(count, total),
      stepConversion: i === 0 ? null : pct(count, previous),
    };
  });
}

/** Rates with their exact definitions (also shown as tooltips in the UI). */
export function rates(cohort) {
  const total = cohort.length;
  const qualified = cohort.filter((l) => l.reachedStage >= STAGE_INDEX.QUALIFIED).length;
  const won = cohort.filter((l) => l.status === 'WON').length;
  const lost = cohort.filter((l) => l.status === 'LOST').length;
  return {
    total,
    qualified,
    won,
    lost,
    qualificationRate: pct(qualified, total),
    conversionRate: pct(won, total),
    winRate: pct(won, won + lost),
  };
}
