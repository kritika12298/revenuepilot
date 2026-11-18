import { prisma } from '../../lib/prisma.js';
import { LEAD_STATUSES } from '../leads/lead.status.js';
import { ACTIVE_FOLLOW_UP_STATUSES } from '../followUps/followUp.repository.js';

import { funnel, leadCohort, rangeWindow, rates } from './metrics.js';
import { pipelineTotals } from '../revenue/revenue.service.js';

const DAY = 86_400_000;

/**
 * Overview metrics for one business, computed from live data.
 *
 * Range-scoped (leads created in the selected window): lead counts, rates,
 * funnel, average score, median first response, leads per day.
 * Current state ("right now", independent of the range): pending follow-ups
 * and approvals waiting. The response says which is which.
 */
export async function summary(ctx, { range }) {
  const now = Date.now();
  const { days, since, previousSince } = rangeWindow(range, now);
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId }, select: { timezone: true } });
  const chartDays = days ?? 90;
  const chartSince = new Date(now - chartDays * DAY);

  const [cohort, previousTotal, followUpsByStatus, approvalsByType, perDay, pipelineValue] = await Promise.all([
    leadCohort(ctx.businessId, since),
    days ? prisma.lead.count({ where: { businessId: ctx.businessId, createdAt: { gte: previousSince, lt: since } } }) : Promise.resolve(null),
    prisma.followUpJob.groupBy({
      by: ['status'],
      where: { businessId: ctx.businessId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } },
      _count: { _all: true },
    }),
    prisma.approval.findMany({
      where: { businessId: ctx.businessId, status: 'PENDING' },
      select: { type: true, message: { select: { followUpJob: { select: { id: true } } } } },
    }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${business.timezone}), 'YYYY-MM-DD') AS day,
             count(*)::int AS count
      FROM leads
      WHERE business_id = ${ctx.businessId}::uuid AND created_at >= ${chartSince}
      GROUP BY 1 ORDER BY 1`,
    pipelineTotals(ctx.businessId),
  ]);

  const r = rates(cohort);
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
  for (const lead of cohort) counts[lead.status] += 1;

  const scored = cohort.filter((l) => l.score != null);
  const responseMinutes = cohort
    .filter((l) => l.firstResponseAt)
    .map((l) => (l.firstResponseAt - l.createdAt) / 60_000)
    .sort((a, b) => a - b);
  const median = responseMinutes.length
    ? responseMinutes.length % 2
      ? responseMinutes[(responseMinutes.length - 1) / 2]
      : (responseMinutes[responseMinutes.length / 2 - 1] + responseMinutes[responseMinutes.length / 2]) / 2
    : null;

  const followUps = { drafting: 0, needsApproval: 0, scheduled: 0 };
  for (const row of followUpsByStatus) {
    const key = { DRAFTING: 'drafting', PENDING_APPROVAL: 'needsApproval', SCHEDULED: 'scheduled' }[row.status];
    followUps[key] = row._count._all;
  }
  const approvals = { replies: 0, followUps: 0, discounts: 0, quotes: 0, other: 0 };
  for (const a of approvalsByType) {
    if (a.type === 'OUTBOUND_MESSAGE') approvals[a.message?.followUpJob ? 'followUps' : 'replies'] += 1;
    else if (a.type === 'DISCOUNT') approvals.discounts += 1;
    else if (a.type === 'QUOTE') approvals.quotes += 1;
    else approvals.other += 1;
  }
  // One source of truth for "follow-ups to approve": the pending approvals themselves,
  // so this tile and the "Approvals waiting" breakdown can never disagree.
  followUps.needsApproval = approvals.followUps;

  // Every day in the window, including days with no leads, in the business's time zone.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const perDayMap = new Map(perDay.map((row) => [row.day, row.count]));
  const leadsByDay = [];
  for (let i = chartDays - 1; i >= 0; i -= 1) {
    const day = fmt.format(new Date(now - i * DAY));
    if (!leadsByDay.length || leadsByDay.at(-1).date !== day) leadsByDay.push({ date: day, count: perDayMap.get(day) ?? 0 });
  }

  return {
    range: days ? range : 'all',
    timezone: business.timezone,
    totals: { leads: r.total, qualified: r.qualified, won: r.won, lost: r.lost, previousLeads: previousTotal },
    conversionRate: r.conversionRate,
    qualificationRate: r.qualificationRate,
    winRate: r.winRate,
    averageScore: scored.length ? Math.round(scored.reduce((a, l) => a + l.score, 0) / scored.length) : null,
    medianFirstResponseMinutes: median == null ? null : Math.round(median),
    // Current state, not affected by the range:
    pendingFollowUps: followUps.drafting + followUps.needsApproval + followUps.scheduled,
    followUps,
    pendingApprovals: approvalsByType.length,
    approvals,
    funnel: funnel(cohort),
    // Current open pipeline (estimate; see /api/revenue for the method).
    pipelineValue,
    pipeline: LEAD_STATUSES.map((status) => ({ status, count: counts[status] })),
    leadsByDay,
  };
}

/** Activity feed categories (each a set of lead event types). */
export const ACTIVITY_CATEGORIES = {
  customer: ['CREATED', 'MESSAGE_RECEIVED', 'OPTED_OUT'],
  qualification: ['ANALYSIS_UPDATED', 'SCORE_UPDATED', 'STATUS_CHANGED', 'UPDATED'],
  ai: ['AGENT_DECISION', 'APPROVAL_REQUESTED', 'OWNER_NOTIFIED', 'FOLLOW_UP_DRAFTED'],
  followUps: ['FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_RESCHEDULED', 'FOLLOW_UP_SKIPPED', 'FOLLOW_UP_FAILED', 'FOLLOW_UP_CANCELLED'],
  messages: ['MESSAGE_SENT', 'MESSAGE_FAILED', 'NOTE'],
  approvals: ['APPROVAL_DECIDED'],
};

/** Business-wide activity feed (newest first). */
export async function activity(ctx, { limit, before, category }) {
  return prisma.leadEvent.findMany({
    where: {
      businessId: ctx.businessId,
      ...(before && { createdAt: { lt: before } }),
      ...(category && { type: { in: ACTIVITY_CATEGORIES[category] } }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      lead: { select: { id: true, name: true } },
      actorUser: { select: { id: true, name: true } },
    },
  });
}
