import { prisma } from '../../lib/prisma.js';
import { isWithinWorkingHours } from '../../lib/workingHours.js';
import { CLOSED_STATUSES } from '../../modules/leads/lead.status.js';
import { FUNNEL_STAGES, funnel, leadCohort, rangeWindow, rates, STAGE_INDEX } from '../../modules/dashboard/metrics.js';

/**
 * Facts the Sales Intelligence agent may reason about. Every number here is
 * computed from the business's own data; an insight must cite at least one
 * fact id, and the server rejects citations of facts that do not exist, so
 * recommendations stay grounded in real data.
 *
 * A fact is only included when the data supports it (no zero-value padding).
 */

const HOUR = 3_600_000;
const STAGE_LABEL = {
  NEW: 'New',
  QUALIFYING: 'Qualifying',
  QUALIFIED: 'Qualified',
  CONTACTED: 'Contacted',
  ENGAGED: 'Engaged',
  APPOINTMENT_BOOKED: 'Appointment booked',
  WON: 'Won',
};
const LOST_LABEL = { PRICE: 'price', NO_RESPONSE: 'no response', TIMING: 'timing', COMPETITOR: 'a competitor', POOR_FIT: 'poor fit', OTHER: 'other' };

const hours = (ms) => Math.round(ms / HOUR);
const names = (leads, max = 3) => {
  const list = leads.slice(0, max).map((l) => l.name);
  return leads.length > max ? `${list.join(', ')} and ${leads.length - max} more` : list.join(', ');
};

export async function computeFacts(businessId, range = '30d', now = Date.now()) {
  const { since } = rangeWindow(range, now);
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { workingHours: true, timezone: true } });
  const cohort = await leadCohort(businessId, since);
  const leadNames = new Map(
    (await prisma.lead.findMany({ where: { businessId }, select: { id: true, name: true } })).map((l) => [l.id, l.name]),
  );
  const withName = (l) => ({ ...l, name: leadNames.get(l.id) });
  const facts = [];
  const add = (fact) => facts.push(fact);

  // --- Current state ---------------------------------------------------------
  const open = await prisma.lead.findMany({
    where: { businessId, status: { notIn: [...CLOSED_STATUSES] }, lastInboundAt: { not: null } },
    select: { id: true, name: true, lastInboundAt: true, lastOutboundAt: true },
  });
  const waiting = open
    .filter((l) => !l.lastOutboundAt || l.lastInboundAt > l.lastOutboundAt)
    .sort((a, b) => a.lastInboundAt - b.lastInboundAt);
  if (waiting.length) {
    add({
      id: 'waiting_for_reply',
      title: 'Leads waiting for a reply',
      value: waiting.length,
      detail: `${waiting.length} open lead${waiting.length > 1 ? 's' : ''} wrote last and ${waiting.length > 1 ? 'are' : 'is'} waiting for us (${names(waiting)}). The longest wait is ${hours(now - waiting[0].lastInboundAt)} hours.`,
      leadIds: waiting.map((l) => l.id),
    });
  }

  const pending = await prisma.approval.findMany({
    where: { businessId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { type: true, createdAt: true, lead: { select: { id: true, name: true } } },
  });
  if (pending.length) {
    add({
      id: 'pending_approvals',
      title: 'Items waiting for owner approval',
      value: pending.length,
      detail: `${pending.length} item${pending.length > 1 ? 's' : ''} need${pending.length > 1 ? '' : 's'} an owner decision; the oldest has waited ${hours(now - pending[0].createdAt)} hours (${pending
        .slice(0, 3)
        .map((p) => `${p.lead?.name ?? 'unknown'}: ${p.type.toLowerCase().replace('_', ' ')}`)
        .join('; ')}).`,
      leadIds: pending.map((p) => p.lead?.id).filter(Boolean),
    });
  }

  // --- Range-scoped ------------------------------------------------------------
  const r = rates(cohort);
  if (!r.total) return { range, facts, cohortSize: 0 };

  const hot = cohort
    .filter((l) => (l.score ?? 0) >= 75 && l.reachedStage < STAGE_INDEX.CONTACTED && !CLOSED_STATUSES.has(l.status))
    .map(withName);
  if (hot.length) {
    add({
      id: 'hot_leads_not_contacted',
      title: 'High-scoring leads not yet contacted',
      value: hot.length,
      detail: `${hot.length} lead${hot.length > 1 ? 's' : ''} scored 75 or more but ${hot.length > 1 ? 'have' : 'has'} not been emailed yet: ${names(hot)}.`,
      leadIds: hot.map((l) => l.id),
    });
  }

  const responded = cohort.filter((l) => l.firstResponseAt).map((l) => ({ ...l, wait: l.firstResponseAt - l.createdAt }));
  if (responded.length) {
    const sorted = responded.map((l) => l.wait).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const slow = responded.filter((l) => l.wait > 24 * HOUR);
    add({
      id: 'first_response_time',
      title: 'Time to first response',
      value: Math.round(median / 60_000),
      unit: 'minutes',
      detail: `Median time to first reply is ${median < HOUR ? `${Math.round(median / 60_000)} minutes` : `${(median / HOUR).toFixed(1)} hours`} across ${responded.length} leads; ${slow.length} waited more than 24 hours.`,
    });
  }

  const unscored = cohort.filter((l) => l.score == null && !CLOSED_STATUSES.has(l.status)).map(withName);
  if (unscored.length) {
    add({
      id: 'unanalysed_leads',
      title: 'Leads not analysed yet',
      value: unscored.length,
      detail: `${unscored.length} open lead${unscored.length > 1 ? 's have' : ' has'} no AI score yet: ${names(unscored)}.`,
      leadIds: unscored.map((l) => l.id),
    });
  }

  if (r.total >= 3) {
    const steps = funnel(cohort);
    let worst = null;
    for (let i = 1; i < steps.length; i += 1) {
      const fromCount = steps[i - 1].count;
      if (fromCount < 2) continue;
      if (!worst || steps[i].stepConversion < worst.rate) worst = { from: FUNNEL_STAGES[i - 1], to: FUNNEL_STAGES[i], rate: steps[i].stepConversion, fromCount, toCount: steps[i].count };
    }
    if (worst) {
      add({
        id: 'funnel_dropoff',
        title: 'Biggest drop-off in the funnel',
        value: worst.rate,
        unit: 'percent',
        detail: `Only ${worst.rate}% of leads that reached ${STAGE_LABEL[worst.from]} moved on to ${STAGE_LABEL[worst.to]} (${worst.toCount} of ${worst.fromCount}). Overall: ${r.qualificationRate}% qualified, ${r.conversionRate}% won.`,
      });
    }
  }

  const lost = cohort.filter((l) => l.status === 'LOST' && l.lostReason);
  if (lost.length) {
    const byReason = {};
    for (const l of lost) byReason[l.lostReason] = (byReason[l.lostReason] ?? 0) + 1;
    const ranked = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
    add({
      id: 'lost_reasons',
      title: 'Why leads were lost',
      value: lost.length,
      detail: `${lost.length} lead${lost.length > 1 ? 's were' : ' was'} lost: ${ranked.map(([k, n]) => `${n} to ${LOST_LABEL[k]}`).join(', ')}.`,
      data: byReason,
    });
  }

  const missing = {};
  for (const l of cohort) for (const m of l.qualification?.missingInformation ?? []) missing[m] = (missing[m] ?? 0) + 1;
  const topMissing = Object.entries(missing).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topMissing.length && topMissing[0][1] >= 2) {
    add({
      id: 'missing_information',
      title: 'Information enquiries usually leave out',
      value: topMissing[0][1],
      detail: `Most common gaps in enquiries: ${topMissing.map(([k, n]) => `${k.toLowerCase()} (${n} leads)`).join(', ')}.`,
      data: Object.fromEntries(topMissing),
    });
  }

  const unmatched = cohort.filter((l) => l.qualification && Array.isArray(l.qualification.matchedServiceIds) && !l.qualification.matchedServiceIds.length).map(withName);
  if (unmatched.length) {
    add({
      id: 'unmatched_requests',
      title: 'Requests that match none of your services',
      value: unmatched.length,
      detail: `${unmatched.length} enquir${unmatched.length > 1 ? 'ies' : 'y'} did not match a listed service (${unmatched
        .slice(0, 3)
        .map((l) => `${l.name}: "${(l.qualification.summary ?? '').slice(0, 80)}"`)
        .join('; ')}).`,
      leadIds: unmatched.map((l) => l.id),
    });
  }

  const hasHours = business.workingHours && Object.values(business.workingHours).some((d) => Array.isArray(d) && d.length);
  if (hasHours && r.total >= 3) {
    const outside = cohort.filter((l) => !isWithinWorkingHours(l.createdAt, business.workingHours, business.timezone));
    if (outside.length) {
      add({
        id: 'out_of_hours_enquiries',
        title: 'Enquiries outside working hours',
        value: Math.round((outside.length / r.total) * 100),
        unit: 'percent',
        detail: `${outside.length} of ${r.total} enquiries (${Math.round((outside.length / r.total) * 100)}%) arrived outside working hours.`,
      });
    }
  }

  const bySource = {};
  for (const l of cohort) {
    bySource[l.source] ??= { leads: 0, qualified: 0, won: 0 };
    bySource[l.source].leads += 1;
    if (l.reachedStage >= STAGE_INDEX.QUALIFIED) bySource[l.source].qualified += 1;
    if (l.status === 'WON') bySource[l.source].won += 1;
  }
  const sources = Object.entries(bySource).filter(([, s]) => s.leads >= 2);
  if (sources.length >= 2) {
    add({
      id: 'source_performance',
      title: 'Lead quality by source',
      value: sources.length,
      detail: sources
        .map(([src, s]) => `${src.replace('_', ' ').toLowerCase()}: ${s.leads} leads, ${Math.round((s.qualified / s.leads) * 100)}% qualified, ${s.won} won`)
        .join('; '),
      data: bySource,
    });
  }

  const sentFollowUps = await prisma.followUpJob.findMany({
    where: { businessId, status: 'SENT', ...(since && { updatedAt: { gte: since } }) },
    select: { updatedAt: true, lead: { select: { lastInboundAt: true } } },
  });
  if (sentFollowUps.length) {
    const replied = sentFollowUps.filter((f) => f.lead.lastInboundAt && f.lead.lastInboundAt > f.updatedAt).length;
    add({
      id: 'follow_up_response',
      title: 'Replies after follow-ups',
      value: Math.round((replied / sentFollowUps.length) * 100),
      unit: 'percent',
      detail: `${replied} of ${sentFollowUps.length} follow-ups sent were followed by a reply from the lead.`,
    });
  }

  return { range, facts, cohortSize: r.total };
}
