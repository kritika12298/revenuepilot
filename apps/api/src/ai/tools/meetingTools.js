import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { formatDateTimeIn } from '../../lib/time.js';
import * as appointments from '../../modules/appointments/appointment.service.js';
import { evaluatePolicy } from '../policy/policyAgent.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const checkCalendarAvailability = defineTool({
  name: 'check_calendar_availability',
  description:
    "Find free appointment slots within the business's working hours, avoiding existing bookings and the connected calendar. " +
    'Only slots returned here can be booked.',
  access: 'read',
  input: z.strictObject({
    lead_id: leadIdField,
    duration_minutes: z.number().int().min(15).max(480),
    days_ahead: z.number().int().min(1).max(21).default(10),
    weekdays: z.array(z.enum(WEEKDAYS)).max(7).optional().describe('Only these days, if the lead stated a preference.'),
  }),
  async handler(input, runCtx) {
    let result;
    try {
      result = await appointments.findSlots({ businessId: runCtx.businessId }, input.lead_id, {
        durationMinutes: input.duration_minutes,
        daysAhead: input.days_ahead,
        weekdays: input.weekdays,
      });
    } catch (err) {
      // Calendar unreachable: a finished outcome (the owner is told), not an incomplete run.
      runCtx.state.outcome = { status: 'CALENDAR_UNAVAILABLE', detail: err.message };
      throw err;
    }
    runCtx.state.offeredSlots = [...(runCtx.state.offeredSlots ?? []), ...result.slots.map((s) => `${s.start}|${input.duration_minutes}`)];
    if (!result.slots.length && !runCtx.state.offeredSlots.length) {
      runCtx.state.outcome = { status: 'NO_SLOTS', detail: `No free ${input.duration_minutes}-minute slot in the next ${input.days_ahead} days` };
    }
    return {
      calendar: result.calendar,
      time_zone: result.timeZone,
      slots: result.slots.map((s) => ({ start: s.start, label: formatDateTimeIn(s.start, result.timeZone) })),
      ...(result.slots.length ? {} : { note: 'No free slots in this window; try more days or tell the owner.' }),
    };
  },
});

export const bookAppointment = defineTool({
  name: 'book_appointment',
  description:
    'Book one of the slots returned by check_calendar_availability. Depending on the owner\'s autonomy settings it is ' +
    'confirmed immediately (calendar event + confirmation email) or proposed to the owner for approval.',
  access: 'write',
  input: z.strictObject({
    lead_id: leadIdField,
    start: z.iso.datetime({ offset: true }).describe('Exactly the start of an offered slot.'),
    duration_minutes: z.number().int().min(15).max(480),
    title: z.string().trim().min(3).max(120).describe('e.g. "Garden design consultation".'),
    service_id: z.uuid().nullable().optional(),
    reason: z.string().trim().min(5).max(300).describe('Why this slot: e.g. "Lead asked for a weekday morning".'),
  }),
  async handler(input, runCtx) {
    if (runCtx.state.appointment) throw new ToolPolicyError('ALREADY_BOOKED', 'An appointment was already booked in this run.');
    const start = new Date(input.start).toISOString();
    // The exact slot (start and duration) must have been offered; a longer booking could overlap other events.
    if (!(runCtx.state.offeredSlots ?? []).includes(`${start}|${input.duration_minutes}`)) {
      throw new ToolPolicyError('SLOT_NOT_OFFERED', 'Only slots returned by check_calendar_availability can be booked, with the same duration_minutes.');
    }
    if (input.service_id && !(await prisma.service.count({ where: { id: input.service_id, businessId: runCtx.businessId } }))) {
      throw new ToolPolicyError('UNKNOWN_SERVICE', 'service_id must be one of this business\'s services.');
    }
    const lead = await prisma.lead.findUnique({ where: { id: input.lead_id } });
    const policy = await evaluatePolicy(
      { type: 'BOOK_APPOINTMENT', lead, summary: `${input.title} with ${lead.name} at ${start}` },
      { businessId: runCtx.businessId, leadId: lead.id, parentRunId: runCtx.rootRunId },
    );
    if (policy.verdict === 'BLOCK') {
      runCtx.state.outcome = { status: 'NOT_PERMITTED', detail: policy.reasons.join('; ') };
      throw new ToolPolicyError('NOT_PERMITTED', policy.reasons.join('; '));
    }
    const { appointment } = await appointments.book(
      { businessId: runCtx.businessId },
      {
        leadId: lead.id,
        start,
        durationMinutes: input.duration_minutes,
        title: input.title,
        serviceId: input.service_id ?? null,
        notes: input.reason,
        confirm: policy.verdict === 'ALLOW',
        actor: { type: 'AI' },
        agentRunId: runCtx.runId,
      },
    );
    runCtx.state.appointment = { id: appointment.id, status: appointment.status, startsAt: appointment.startsAt };
    runCtx.state.outcome = { status: appointment.status === 'CONFIRMED' ? 'BOOKED' : 'PROPOSED' };
    runCtx.state.reason = input.reason;
    return {
      status: appointment.status === 'CONFIRMED' ? 'CONFIRMED' : 'PROPOSED_AWAITING_OWNER_APPROVAL',
      appointment_id: appointment.id,
      policy: policy.verdict === 'ALLOW' ? 'Auto-booking allowed by the owner' : policy.reasons.join('; '),
    };
  },
});
