import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { CLOSED_STATUSES } from '../leads/lead.status.js';
import { estimateDealValue } from '../revenue/dealValue.js';
import { formatCents } from '../../lib/money.js';
import { publishEvent } from '../events/eventBus.js';

/**
 * Proactive recommendation engine. Deterministic detectors over live data;
 * each finding has a stable dedupeKey tied to the situation (e.g. the lead's
 * last message), so the same situation never produces a second card or
 * notification, and a new situation produces a fresh one.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VISIT = /(book|schedule|appointment|consultation|site visit|come out|come by|take a look|meet)/i;
const hours = (ms) => Math.round(ms / HOUR);

function impactFor(lead, byId) {
  const v = estimateDealValue(lead, byId);
  return v.cents == null ? null : { valueCents: v.cents, label: `${formatCents(v.cents)} potential deal`, basis: v.basis };
}

export async function detect(businessId, now = Date.now()) {
  const [leads, services, approvals, overdue] = await Promise.all([
    prisma.lead.findMany({
      where: { businessId, status: { notIn: [...CLOSED_STATUSES] } },
      include: {
        conversations: { include: { messages: { where: { status: { in: ['RECEIVED', 'SENT'] } }, orderBy: { createdAt: 'asc' }, select: { direction: true, createdAt: true, body: true } } } },
        appointments: { where: { status: { in: ['PROPOSED', 'CONFIRMED'] } }, select: { id: true } },
      },
    }),
    prisma.service.findMany({ where: { businessId } }),
    prisma.approval.findMany({ where: { businessId, status: 'PENDING', createdAt: { lt: new Date(now - 4 * HOUR) } }, include: { lead: { select: { id: true, name: true } } } }),
    prisma.followUpJob.findMany({
      where: { businessId, status: { in: ['PENDING_APPROVAL', 'SCHEDULED'] }, scheduledFor: { lt: new Date(now - HOUR) } },
      include: { lead: { select: { id: true, name: true } } },
    }),
  ]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const recs = [];

  for (const lead of leads) {
    const msgs = lead.conversations.flatMap((c) => c.messages).sort((a, b) => a.createdAt - b.createdAt);
    const inbound = msgs.filter((m) => m.direction === 'INBOUND');
    const lastIn = inbound.at(-1);
    const lastOut = msgs.filter((m) => m.direction === 'OUTBOUND').at(-1);
    const highIntent = (lead.score ?? 0) >= 70 || lead.qualification?.intent?.level === 'HIGH';
    const impact = impactFor(lead, byId);

    if (highIntent && lastIn && (!lastOut || lastIn.createdAt > lastOut.createdAt) && now - lastIn.createdAt > HOUR) {
      recs.push({
        type: 'HIGH_INTENT_NO_RESPONSE', leadId: lead.id, dedupeKey: `high-intent:${lead.id}:${lastIn.createdAt.getTime()}`, priority: 'HIGH',
        title: `${lead.name} is waiting for a reply`,
        reason: `High-intent lead (score ${lead.score ?? '–'}) wrote ${hours(now - lastIn.createdAt)} hours ago and has not had a reply.`,
        suggestedAction: 'Approve the AI draft or reply now; fast replies win high-intent leads.',
        data: { hoursWaiting: hours(now - lastIn.createdAt), score: lead.score }, impact,
      });
    }
    // Contacted but never replied, at least twice.
    const outSinceIn = msgs.filter((m) => m.direction === 'OUTBOUND' && (!lastIn || m.createdAt > lastIn.createdAt));
    if (outSinceIn.length >= 2 && lastOut && now - lastOut.createdAt > 3 * DAY) {
      const declining = inbound.length >= 2;
      recs.push({
        type: declining ? 'DECLINING_ENGAGEMENT' : 'STOPPED_RESPONDING', leadId: lead.id,
        dedupeKey: `${declining ? 'declining' : 'silent'}:${lead.id}:${lastOut.createdAt.getTime()}`, priority: 'MEDIUM',
        title: declining ? `${lead.name}'s engagement is dropping` : `${lead.name} has stopped responding`,
        reason: `${outSinceIn.length} emails sent since their ${lastIn ? 'last reply' : 'enquiry'}${lastIn ? ` ${Math.round((now - lastIn.createdAt) / DAY)} days ago` : ''}, no response.${declining ? ` They had replied ${inbound.length} times before.` : ''}`,
        suggestedAction: declining ? 'Try a phone call or a different offer (for example a site visit).' : 'Send a short, final check-in or close the lead.',
        data: { emailsWithoutReply: outSinceIn.length }, impact,
      });
    }
    if (!lead.appointments.length && ['QUALIFIED', 'CONTACTED', 'ENGAGED'].includes(lead.status) && (lead.qualification?.intent?.level === 'HIGH' || inbound.some((m) => VISIT.test(m.body)))) {
      recs.push({
        type: 'READY_FOR_APPOINTMENT', leadId: lead.id, dedupeKey: `appointment:${lead.id}`, priority: 'MEDIUM',
        title: `Offer ${lead.name} an appointment`,
        reason: inbound.some((m) => VISIT.test(m.body)) ? 'They asked for a visit or consultation and have no appointment yet.' : 'High purchase intent and no appointment booked yet.',
        suggestedAction: 'Use Book to pick a free slot, or run the AI to let the Meeting Agent propose one.',
        data: {}, impact,
      });
    }
    const lastTouch = Math.max(lead.lastContactAt?.getTime() ?? 0, lead.createdAt.getTime());
    if (now - lastTouch > 14 * DAY) {
      recs.push({
        type: 'POTENTIALLY_LOST', leadId: lead.id, dedupeKey: `stale:${lead.id}:${lastTouch}`, priority: 'LOW',
        title: `${lead.name} may be lost`,
        reason: `No activity for ${Math.round((now - lastTouch) / DAY)} days while the lead is still open.`,
        suggestedAction: 'Re-engage with a final message, or mark the lead as lost with a reason.',
        data: { daysInactive: Math.round((now - lastTouch) / DAY) }, impact,
      });
    }
  }

  for (const fu of overdue) {
    recs.push({
      type: 'OVERDUE_FOLLOW_UP', leadId: fu.leadId, dedupeKey: `overdue:${fu.id}`, priority: fu.status === 'PENDING_APPROVAL' ? 'HIGH' : 'MEDIUM',
      title: `Follow-up ${fu.step} to ${fu.lead.name} is overdue`,
      reason: fu.status === 'PENDING_APPROVAL'
        ? `Planned for ${hours(now - fu.scheduledFor)} hours ago but still waiting for your approval.`
        : `Scheduled ${hours(now - fu.scheduledFor)} hours ago and not sent yet (outside working hours or a delivery problem).`,
      suggestedAction: fu.status === 'PENDING_APPROVAL' ? 'Review and approve or cancel it in Follow-ups.' : 'Check Follow-ups for the delivery status.',
      data: { followUpId: fu.id }, impact: null,
    });
  }
  for (const a of approvals) {
    recs.push({
      type: 'APPROVAL_WAITING', leadId: a.leadId, dedupeKey: `approval:${a.id}`, priority: a.type === 'OUTBOUND_MESSAGE' ? 'HIGH' : 'MEDIUM',
      title: `${a.lead?.name ?? 'A lead'}: ${a.type.toLowerCase().replace('_', ' ')} waiting for you`,
      reason: `Waiting for your decision for ${hours(now - a.createdAt)} hours; nothing happens until you decide.`,
      suggestedAction: 'Approve or reject it in Needs your approval.',
      data: { approvalId: a.id, type: a.type }, impact: null,
    });
  }
  return recs;
}

/** Sync detections into the recommendations table and notify about new HIGH ones. */
export async function refreshRecommendations(businessId) {
  const found = await detect(businessId);
  const keys = new Set(found.map((r) => r.dedupeKey));
  let created = 0;
  for (const rec of found) {
    const existing = await prisma.recommendation.findUnique({ where: { businessId_dedupeKey: { businessId, dedupeKey: rec.dedupeKey } } });
    if (existing) {
      if (existing.status === 'OPEN') await prisma.recommendation.update({ where: { id: existing.id }, data: { reason: rec.reason, data: rec.data, impact: rec.impact ?? Prisma.DbNull } }); // a stale impact is cleared, not kept
      continue; // dismissed/done situations are not re-raised
    }
    await prisma.recommendation.create({ data: { businessId, ...rec, impact: rec.impact ?? undefined } });
    created += 1;
    if (rec.priority === 'HIGH') {
      await prisma.notification
        .create({ data: { businessId, leadId: rec.leadId, reason: rec.type === 'OVERDUE_FOLLOW_UP' ? 'OVERDUE_FOLLOW_UP' : 'RECOMMENDATION', priority: 'URGENT', message: `${rec.title}. ${rec.suggestedAction}`, dedupeKey: `rec:${rec.dedupeKey}` } })
        .then((n) => publishEvent(businessId, 'notification', { id: n.id, message: n.message }))
        .catch(() => {}); // unique dedupeKey: already notified
    }
  }
  // Situations that resolved themselves close automatically.
  const resolved = await prisma.recommendation.updateMany({
    where: { businessId, status: 'OPEN', dedupeKey: { notIn: [...keys] } },
    data: { status: 'DONE', resolvedAt: new Date() },
  });
  if (created || resolved.count) publishEvent(businessId, 'recommendations', { created, resolved: resolved.count });
  return { open: found.length, created, resolved: resolved.count };
}

export async function refreshAll() {
  const businesses = await prisma.business.findMany({ select: { id: true } });
  let created = 0;
  for (const b of businesses) created += (await refreshRecommendations(b.id)).created;
  return { businesses: businesses.length, created };
}
