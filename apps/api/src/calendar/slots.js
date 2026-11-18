import { zonedParts, zonedTimeToUtc } from '../lib/workingHours.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_HOURS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [{ open: '09:00', close: '17:00' }]]));

/**
 * Free appointment slots within working hours (business time zone), not
 * overlapping busy intervals, starting at least `minLeadMinutes` from now.
 * Returns at most `max` slots, no more than `perDay` per day.
 */
export function availableSlots({ workingHours, timeZone, busy = [], durationMinutes, daysAhead = 10, stepMinutes = 30, minLeadMinutes = 120, max = 6, perDay = 2, now = Date.now(), weekdays }) {
  const hours = workingHours && Object.values(workingHours).some((d) => d?.length) ? workingHours : DEFAULT_HOURS;
  const durationMs = durationMinutes * 60e3;
  const earliest = now + minLeadMinutes * 60e3;
  const slots = [];
  const seenDays = new Set();
  for (let offset = 0; offset <= daysAhead && slots.length < max; offset += 1) {
    const p = zonedParts(new Date(now + offset * 86_400_000), timeZone);
    const dayKey = `${p.year}-${p.month}-${p.day}`;
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);
    const weekday = p.weekday;
    if (weekdays?.length && !weekdays.includes(weekday)) continue;
    let count = 0;
    for (const { open, close } of hours[weekday] ?? []) {
      const [oh, om] = open.split(':').map(Number);
      const [ch, cm] = close.split(':').map(Number);
      const day = { year: p.year, month: p.month, day: p.day };
      const openAt = zonedTimeToUtc({ ...day, hour: oh, minute: om }, timeZone).getTime();
      const closeAt = zonedTimeToUtc({ ...day, hour: ch, minute: cm }, timeZone).getTime();
      for (let start = openAt; start + durationMs <= closeAt && count < perDay && slots.length < max; start += stepMinutes * 60e3) {
        if (start < earliest) continue;
        const end = start + durationMs;
        if (busy.some((b) => start < new Date(b.end).getTime() && end > new Date(b.start).getTime())) continue;
        slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
        count += 1;
        start += durationMs - stepMinutes * 60e3; // do not offer back-to-back overlapping slots
      }
    }
  }
  return slots;
}

export { DAY_KEYS };
