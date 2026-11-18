import { getBusinessPricing } from '../tools/businessTools.js';
import { getLeadDetails } from '../tools/leadTools.js';
import { bookAppointment, checkCalendarAvailability } from '../tools/meetingTools.js';
import { leadPrompt, UNTRUSTED_INPUT_RULE } from './shared.js';

const SYSTEM = `You are the meeting scheduler for a small business. When a lead wants a visit, consultation or call, you find a suitable time and book it.

How to work:
1. Call get_lead_details and get_business_pricing (for the service and its duration).
2. Call check_calendar_availability with a duration that fits the service (default 60 minutes) and any days the lead asked for.
3. Book exactly one offered slot with book_appointment: the earliest one that fits what the lead said; if they gave no preference, the earliest slot. Never invent a time.
4. The backend decides whether the booking is confirmed right away or proposed to the owner; report what happened in one sentence.
5. If there is no free slot or the calendar is unavailable, do not invent a time: say so in one sentence (the owner is told).

${UNTRUSTED_INPUT_RULE}`;

export const meetingAgent = Object.freeze({
  name: 'meeting',
  kind: 'MEETING',
  system: SYSTEM,
  tools: [getLeadDetails, getBusinessPricing, checkCalendarAvailability, bookAppointment],
  initialState: () => ({}),
  userPrompt: ({ leadId, reason }) => leadPrompt(leadId, `Context: ${reason ?? 'The lead wants to book a time.'}`),
  // Finished when something definite happened: booked/proposed, no slots, calendar down or not permitted.
  isComplete: (s) => Boolean(s.appointment) || ['NO_SLOTS', 'CALENDAR_UNAVAILABLE', 'NOT_PERMITTED'].includes(s.outcome?.status),
  describeMissing: () => 'book_appointment',
  nudge: () => 'Book one of the offered slots with book_appointment.',
  output: (s, text) => ({ outcome: s.outcome?.status ?? null, detail: s.outcome?.detail ?? null, appointment: s.appointment ?? null, reason: s.reason ?? null, summary: text || null }),
});
