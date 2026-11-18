/**
 * Business-hours arithmetic in the business's IANA time zone, using only Intl
 * (DST-safe, no dependencies).
 *
 * workingHours shape: { mon: [{ open: "08:00", close: "17:00" }], ... }
 * An empty object means "no restriction".
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return formatters.get(timeZone);
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday.slice(0, 3).toLowerCase(),
  };
}

function offsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` shows the given local time. */
export function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // Second pass corrects for a DST change between the guess and the result.
  result = guess - offsetMs(new Date(result), timeZone);
  return new Date(result);
}

function hasHours(workingHours) {
  return Boolean(workingHours) && DAY_KEYS.some((d) => Array.isArray(workingHours[d]) && workingHours[d].length);
}

const toHm = (hhmm) => hhmm.split(':').map(Number);

/**
 * Earliest instant >= `from` that falls inside working hours. Returns `from`
 * unchanged when no hours are configured.
 */
export function nextWorkingTime(from, workingHours, timeZone = 'UTC') {
  if (!hasHours(workingHours)) return new Date(from);
  const start = new Date(from);

  for (let offset = 0; offset < 14; offset += 1) {
    const probe = zonedParts(new Date(start.getTime() + offset * 86_400_000), timeZone);
    // Normalise to that local calendar day.
    const intervals = [...(workingHours[probe.weekday] ?? [])].sort((a, b) => a.open.localeCompare(b.open));
    for (const { open, close } of intervals) {
      const [oh, om] = toHm(open);
      const [ch, cm] = toHm(close);
      const day = { year: probe.year, month: probe.month, day: probe.day };
      const openAt = zonedTimeToUtc({ ...day, hour: oh, minute: om }, timeZone);
      const closeAt = zonedTimeToUtc({ ...day, hour: ch, minute: cm }, timeZone);
      if (start < openAt) return openAt;
      if (start < closeAt) return start;
    }
  }
  // Hours configured but unreachable (should not happen with validated input).
  return start;
}

export function isWithinWorkingHours(date, workingHours, timeZone = 'UTC') {
  return nextWorkingTime(date, workingHours, timeZone).getTime() === new Date(date).getTime();
}
