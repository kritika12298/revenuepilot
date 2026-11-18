import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { formatDateTimeIn } from '../../lib/time.js';
import { getCalendar } from '../../calendar/index.js';
import { availableSlots } from '../../calendar/slots.js';
import { enqueueSend, getQueues, QUEUES } from '../../queue/queues.js';
import { logAutomation } from '../automation/audit.js';
import { canTransition } from '../leads/lead.status.js';
import * as notifications from '../notifications/notification.repository.js';

export const JOB_APPOINTMENT_REMINDER = 'appointment-reminder';
const ACTIVE = ['PROPOSED', 'CONFIRMED'];

async function loadLead(businessId, leadId) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId }, include: { business: true } });
  if (!lead) throw new NotFoundError('Lead');
  return lead;
}

/** Busy intervals from RevenuePilot appointments plus the connected calendar. */
async function busyIntervals(businessId, from, to, calendar) {
  const stored = await prisma.appointment.findMany({
    where: { businessId, status: { in: ACTIVE }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { startsAt: true, endsAt: true },
  });
  let external = [];
  try {
    external = await calendar.busy(from.toISOString(), to.toISOString());
  } catch (err) {
    logger.warn({ err: { message: err.message }, businessId }, 'Calendar availability check failed');
    throw new UnprocessableError('CALENDAR_UNAVAILABLE', `Could not check calendar availability: ${err.message}`);
  }
  return [...stored.map((a) => ({ start: a.startsAt, end: a.endsAt })), ...external];
}

/** Serialises appointment changes per business, so two writers can't take the same time. */
const lockBusiness = (tx, businessId) => tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;

/**
 * Throws if the connected calendar has an event overlapping [startsAt, endsAt).
 * `ignore` is the appointment's own current time (its own event shows as busy when rescheduling).
 */
async function assertCalendarFree(calendar, businessId, startsAt, endsAt, ignore = null) {
  let busy;
  try {
    busy = await calendar.busy(startsAt.toISOString(), endsAt.toISOString());
  } catch (err) {
    logger.warn({ err: { message: err.message }, businessId }, 'Calendar availability check failed');
    throw new UnprocessableError('CALENDAR_UNAVAILABLE', `Could not check calendar availability: ${err.message}`);
  }
  const overlaps = busy.filter((b) => new Date(b.start) < endsAt && new Date(b.end) > startsAt);
  const others = ignore ? overlaps.filter((b) => !(new Date(b.start).getTime() === ignore.startsAt.getTime() && new Date(b.end).getTime() === ignore.endsAt.getTime())) : overlaps;
  if (others.length) throw new ConflictError('That time is busy in the connected calendar');
}

const clashWhere = (businessId, startsAt, endsAt, excludeId) => ({
  businessId,
  status: { in: ACTIVE },
  startsAt: { lt: endsAt },
  endsAt: { gt: startsAt },
  ...(excludeId && { id: { not: excludeId } }),
});

export async function findSlots(ctx, leadId, { durationMinutes = 60, daysAhead = 10, weekdays } = {}) {
  const lead = await loadLead(ctx.businessId, leadId);
  const calendar = await getCalendar(ctx.businessId);
  const from = new Date();
  const to = new Date(Date.now() + (daysAhead + 1) * 86_400_000);
  const busy = await busyIntervals(ctx.businessId, from, to, calendar);
  return {
    calendar: calendar.label,
    timeZone: lead.business.timezone,
    slots: availableSlots({ workingHours: lead.business.workingHours, timeZone: lead.business.timezone, busy, durationMinutes, daysAhead, weekdays }),
  };
}

/** Queues a system-written email (confirmations, reminders). Consent is re-checked at send time. */
async function queueSystemEmail(tx, { businessId, leadId, subject, body }) {
  let conversation = await tx.conversation.findFirst({ where: { businessId, leadId, status: 'OPEN' }, orderBy: { updatedAt: 'desc' } });
  conversation ??= await tx.conversation.create({ data: { businessId, leadId, channel: 'EMAIL', subject } });
  return tx.message.create({ data: { businessId, conversationId: conversation.id, direction: 'OUTBOUND', author: 'SYSTEM', subject, body, status: 'APPROVED' } });
}

async function scheduleReminder(appointment) {
  const at = appointment.startsAt.getTime() - 24 * 3600e3;
  if (at < Date.now() + 60e3) return;
  try {
    await getQueues()[QUEUES.FOLLOW_UPS].add(
      JOB_APPOINTMENT_REMINDER,
      { appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString() },
      { jobId: `reminder-${appointment.id}-${appointment.startsAt.getTime()}`, delay: at - Date.now(), attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
    );
  } catch (err) {
    logger.error({ err: { message: err.message }, appointmentId: appointment.id }, 'Could not schedule appointment reminder');
  }
}

/**
 * Creates the calendar event, marks the appointment confirmed and tells the lead.
 * Re-checks that it is still PROPOSED and the time is still free (it may have been
 * proposed days ago); the final status change is conditional, so a concurrent cancel wins.
 */
async function confirmInternal(appointment, lead, actor) {
  const calendar = await getCalendar(lead.businessId);
  await prisma.$transaction(async (tx) => {
    await lockBusiness(tx, lead.businessId);
    const current = await tx.appointment.findUnique({ where: { id: appointment.id } });
    if (current?.status !== 'PROPOSED') throw new ConflictError(`Appointment is ${current?.status ?? 'gone'}`);
    if (await tx.appointment.findFirst({ where: { ...clashWhere(lead.businessId, appointment.startsAt, appointment.endsAt, appointment.id), status: 'CONFIRMED' } })) {
      throw new ConflictError('That time is no longer available');
    }
  });
  await assertCalendarFree(calendar, lead.businessId, appointment.startsAt, appointment.endsAt);
  const event = await calendar.createEvent({
    title: `${appointment.title}: ${lead.name}`,
    start: appointment.startsAt.toISOString(),
    end: appointment.endsAt.toISOString(),
    description: `Booked via RevenuePilot for ${lead.name}${lead.phone ? ` (${lead.phone})` : ''}.`,
    location: appointment.location ?? undefined,
    requestId: appointment.idempotencyKey,
  });
  const when = formatDateTimeIn(appointment.startsAt, lead.business.timezone);
  const { confirmed, messageId } = await prisma.$transaction(async (tx) => {
    const { count } = await tx.appointment.updateMany({
      where: { id: appointment.id, status: 'PROPOSED' },
      data: { status: 'CONFIRMED', externalEventId: event.id, calendarProvider: calendar.name },
    });
    if (!count) throw new ConflictError('Appointment changed while it was being confirmed');
    const confirmed = await tx.appointment.findUnique({ where: { id: appointment.id } });
    if (canTransition(lead.status, 'APPOINTMENT_BOOKED')) {
      await tx.lead.update({ where: { id: lead.id }, data: { status: 'APPOINTMENT_BOOKED' } });
      await logAutomation({ businessId: lead.businessId, leadId: lead.id, type: 'STATUS_CHANGED', actor, data: { from: lead.status, to: 'APPOINTMENT_BOOKED', reason: 'Appointment confirmed' } }, tx);
    }
    await logAutomation(
      { businessId: lead.businessId, leadId: lead.id, type: 'APPOINTMENT_BOOKED', actor, data: { appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString(), calendar: calendar.name } },
      tx,
    );
    let messageId = null;
    if (lead.email && lead.status !== 'OPTED_OUT') {
      const msg = await queueSystemEmail(tx, {
        businessId: lead.businessId,
        leadId: lead.id,
        subject: `Confirmed: ${appointment.title}`,
        body: `Hi ${lead.name.split(' ')[0]},\n\nYour ${appointment.title.toLowerCase()} with ${lead.business.name} is confirmed for ${when}.${appointment.location ? `\nLocation: ${appointment.location}` : ''}\n\nIf you need to change it, just reply to this email.\n\n${lead.business.commsPrefs?.signature ?? lead.business.name}`,
      });
      messageId = msg.id;
    }
    return { confirmed, messageId };
  }).catch(async (err) => {
    // Don't leave an orphan calendar event behind (the event id is deterministic, so a retry is safe too).
    await calendar.cancelEvent(event.id).catch((e) => logger.warn({ err: { message: e.message }, appointmentId: appointment.id }, 'Could not remove calendar event after a failed confirmation'));
    throw err;
  });
  if (messageId) await enqueueSend({ messageId }).catch((err) => logger.error({ err: { message: err.message } }, 'Could not queue confirmation'));
  await scheduleReminder(confirmed);
  return confirmed;
}

/**
 * Books (or proposes) an appointment. `confirm=false` stores it as PROPOSED
 * with an owner approval; confirmation then creates the calendar event.
 */
export async function book(ctx, { leadId, start, durationMinutes, title, serviceId = null, notes = null, location = null, confirm, actor, agentRunId = null }) {
  const lead = await loadLead(ctx.businessId, leadId);
  if (lead.status === 'OPTED_OUT') throw new UnprocessableError('OPTED_OUT', 'This lead opted out');
  const startsAt = new Date(start);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60e3);
  if (startsAt.getTime() < Date.now()) throw new UnprocessableError('SLOT_IN_PAST', 'The appointment time is in the past');
  const idempotencyKey = `${leadId}:${startsAt.toISOString()}`;

  const existing = await prisma.appointment.findUnique({ where: { idempotencyKey } });
  if (existing && existing.status !== 'CANCELLED') return { appointment: existing, duplicate: true };
  // The connected calendar too, not just RevenuePilot's own appointments (manual bookings included).
  await assertCalendarFree(await getCalendar(ctx.businessId), ctx.businessId, startsAt, endsAt);

  const appointment = await prisma.$transaction(async (tx) => {
    // Serialise bookings per business so two requests cannot take the same slot.
    await lockBusiness(tx, ctx.businessId);
    const clash = await tx.appointment.findFirst({ where: clashWhere(ctx.businessId, startsAt, endsAt) });
    if (clash) throw new ConflictError('That time is no longer available');
    const appt = existing
      ? await tx.appointment.update({ where: { id: existing.id }, data: { status: 'PROPOSED', endsAt, title, notes, serviceId, bookedBy: actor.type, agentRunId } })
      : await tx.appointment.create({
          data: { businessId: ctx.businessId, leadId, serviceId, title, startsAt, endsAt, notes, location, idempotencyKey, bookedBy: actor.type, agentRunId, status: 'PROPOSED' },
        });
    if (!confirm) {
      const approval = await tx.approval.create({
        data: {
          businessId: ctx.businessId,
          leadId,
          agentRunId,
          type: 'APPOINTMENT',
          payload: { appointmentId: appt.id, startsAt: startsAt.toISOString(), durationMinutes, title },
          aiRationale: notes ?? `Proposed ${title.toLowerCase()} for ${formatDateTimeIn(startsAt, lead.business.timezone)}.`,
        },
      });
      await logAutomation(
        { businessId: ctx.businessId, leadId, type: 'APPOINTMENT_PROPOSED', actor, data: { appointmentId: appt.id, approvalId: approval.id, startsAt: startsAt.toISOString() } },
        tx,
      );
      await notifications.create(
        { businessId: ctx.businessId, leadId, agentRunId, reason: 'APPOINTMENT', priority: 'NORMAL', message: `Confirm ${title.toLowerCase()} with ${lead.name} on ${formatDateTimeIn(startsAt, lead.business.timezone)}.` },
        tx,
      );
    }
    return appt;
  });
  if (!confirm) return { appointment, duplicate: false };
  return { appointment: await confirmInternal(appointment, lead, actor), duplicate: false };
}

/** Owner approved a proposed appointment. */
export async function confirm(ctx, appointmentId, actor) {
  const appt = await prisma.appointment.findFirst({ where: { id: appointmentId, businessId: ctx.businessId } });
  if (!appt) throw new NotFoundError('Appointment');
  if (appt.status !== 'PROPOSED') throw new ConflictError(`Appointment is ${appt.status}`);
  const lead = await loadLead(ctx.businessId, appt.leadId);
  return confirmInternal(appt, lead, actor);
}

async function requireAppointment(ctx, id) {
  const appt = await prisma.appointment.findFirst({ where: { id, businessId: ctx.businessId }, include: { lead: { include: { business: true } } } });
  if (!appt) throw new NotFoundError('Appointment');
  return appt;
}

export async function reschedule(ctx, id, { startsAt: start, durationMinutes }, actor = { type: 'USER', userId: ctx.userId }) {
  const appt = await requireAppointment(ctx, id);
  if (!ACTIVE.includes(appt.status)) throw new UnprocessableError('NOT_ACTIVE', `Appointment is ${appt.status}`);
  const startsAt = new Date(start);
  if (startsAt.getTime() < Date.now()) throw new UnprocessableError('SLOT_IN_PAST', 'The new time is in the past');
  const endsAt = new Date(startsAt.getTime() + (durationMinutes ?? (appt.endsAt - appt.startsAt) / 60e3) * 60e3);
  const calendar = await getCalendar(ctx.businessId);
  await assertCalendarFree(calendar, ctx.businessId, startsAt, endsAt, appt);
  const when = formatDateTimeIn(startsAt, appt.lead.business.timezone);
  const { updated, messageId } = await prisma.$transaction(async (tx) => {
    // Same lock as booking: the clash check and the move happen atomically.
    await lockBusiness(tx, ctx.businessId);
    if (await tx.appointment.findFirst({ where: clashWhere(ctx.businessId, startsAt, endsAt, id) })) throw new ConflictError('That time is no longer available');
    const { count } = await tx.appointment.updateMany({ where: { id, status: appt.status }, data: { startsAt, endsAt, reminderSentAt: null } });
    if (!count) throw new ConflictError('Appointment changed while it was being rescheduled');
    // Move the calendar event inside the transaction: if it fails, nothing changes.
    if (appt.externalEventId) await calendar.updateEvent(appt.externalEventId, { start: startsAt.toISOString(), end: endsAt.toISOString() });
    const updated = await tx.appointment.findUnique({ where: { id } });
    await logAutomation({ businessId: ctx.businessId, leadId: appt.leadId, type: 'APPOINTMENT_RESCHEDULED', actor, data: { appointmentId: id, from: appt.startsAt.toISOString(), to: startsAt.toISOString() } }, tx);
    let messageId = null;
    if (appt.status === 'CONFIRMED' && appt.lead.email && appt.lead.status !== 'OPTED_OUT') {
      messageId = (await queueSystemEmail(tx, { businessId: ctx.businessId, leadId: appt.leadId, subject: `Updated: ${appt.title}`, body: `Hi ${appt.lead.name.split(' ')[0]},\n\nYour ${appt.title.toLowerCase()} has moved to ${when}.\n\n${appt.lead.business.commsPrefs?.signature ?? appt.lead.business.name}` })).id;
    }
    return { updated, messageId };
  });
  if (messageId) await enqueueSend({ messageId }).catch(() => {});
  if (updated.status === 'CONFIRMED') await scheduleReminder(updated);
  return updated;
}

export async function cancel(ctx, id, { reason } = {}, actor = { type: 'USER', userId: ctx.userId }) {
  const appt = await requireAppointment(ctx, id);
  if (!ACTIVE.includes(appt.status)) throw new UnprocessableError('NOT_ACTIVE', `Appointment is ${appt.status}`);
  if (appt.externalEventId) await (await getCalendar(ctx.businessId)).cancelEvent(appt.externalEventId);
  const { updated, messageId } = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await tx.approval.updateMany({ where: { businessId: ctx.businessId, type: 'APPOINTMENT', status: 'PENDING', payload: { path: ['appointmentId'], equals: id } }, data: { status: 'EXPIRED', decidedAt: new Date() } });
    await logAutomation({ businessId: ctx.businessId, leadId: appt.leadId, type: 'APPOINTMENT_CANCELLED', actor, data: { appointmentId: id, reason: reason ?? null } }, tx);
    let messageId = null;
    if (appt.status === 'CONFIRMED' && appt.lead.email && appt.lead.status !== 'OPTED_OUT') {
      messageId = (await queueSystemEmail(tx, { businessId: ctx.businessId, leadId: appt.leadId, subject: `Cancelled: ${appt.title}`, body: `Hi ${appt.lead.name.split(' ')[0]},\n\nYour ${appt.title.toLowerCase()} on ${formatDateTimeIn(appt.startsAt, appt.lead.business.timezone)} has been cancelled. Reply to this email to arrange a new time.\n\n${appt.lead.business.commsPrefs?.signature ?? appt.lead.business.name}` })).id;
    }
    return { updated, messageId };
  });
  if (messageId) await enqueueSend({ messageId }).catch(() => {});
  return updated;
}

export async function setOutcome(ctx, id, status) {
  const appt = await requireAppointment(ctx, id);
  if (appt.status !== 'CONFIRMED') throw new UnprocessableError('NOT_CONFIRMED', 'Only confirmed appointments can be completed');
  return prisma.appointment.update({ where: { id }, data: { status } });
}

export function list(ctx, { from, to, status }) {
  return prisma.appointment.findMany({
    where: { businessId: ctx.businessId, ...(status && { status: { in: status } }), ...((from || to) && { startsAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }) },
    orderBy: { startsAt: 'asc' },
    include: { lead: { select: { id: true, name: true, status: true } } },
    take: 200,
  });
}

/** Reminder job: 24h before a confirmed appointment. */
export async function processReminder(job) {
  const { appointmentId, startsAt } = job.data;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { lead: { include: { business: true } } } });
  if (!appt || appt.status !== 'CONFIRMED' || appt.reminderSentAt || appt.startsAt.toISOString() !== startsAt) return { outcome: 'NOOP' };
  if (!appt.lead.email || appt.lead.status === 'OPTED_OUT') return { outcome: 'SKIPPED', reason: 'Lead cannot be emailed' };
  const message = await prisma.$transaction(async (tx) => {
    const msg = await queueSystemEmail(tx, {
      businessId: appt.businessId,
      leadId: appt.leadId,
      subject: `Reminder: ${appt.title} tomorrow`,
      body: `Hi ${appt.lead.name.split(' ')[0]},\n\nA reminder that your ${appt.title.toLowerCase()} with ${appt.lead.business.name} is on ${formatDateTimeIn(appt.startsAt, appt.lead.business.timezone)}.\n\n${appt.lead.business.commsPrefs?.signature ?? appt.lead.business.name}`,
    });
    await tx.appointment.update({ where: { id: appointmentId }, data: { reminderSentAt: new Date() } });
    return msg;
  });
  await enqueueSend({ messageId: message.id });
  return { outcome: 'QUEUED', messageId: message.id };
}
