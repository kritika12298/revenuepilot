import { describe, expect, it } from 'vitest';
import { isWithinWorkingHours, nextWorkingTime } from '../../src/lib/workingHours.js';

const weekdays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [{ open: '08:00', close: '17:00' }]]));
const hours = { ...weekdays, sat: [{ open: '09:00', close: '13:00' }] };
const at = (iso) => new Date(iso);

describe('working hours', () => {
  it('keeps times that are already inside working hours', () => {
    expect(nextWorkingTime(at('2026-11-20T23:30:00Z'), hours, 'America/Denver')).toEqual(at('2026-11-20T23:30:00Z')); // Fri 16:30 MST
  });

  it('moves early-morning times to opening time the same day', () => {
    expect(nextWorkingTime(at('2026-11-23T12:00:00Z'), hours, 'America/Denver')).toEqual(at('2026-11-23T15:00:00Z')); // Mon 05:00 -> 08:00
  });

  it('skips closed days (Saturday afternoon -> Monday morning)', () => {
    expect(nextWorkingTime(at('2026-11-21T22:00:00Z'), hours, 'America/Denver')).toEqual(at('2026-11-23T15:00:00Z'));
  });

  it('handles the start of daylight saving time', () => {
    // Sat 7 Mar 2026 14:00 MST -> Mon 9 Mar 08:00 MDT (UTC-6)
    expect(nextWorkingTime(at('2026-03-07T21:00:00Z'), hours, 'America/Denver')).toEqual(at('2026-03-09T14:00:00Z'));
  });

  it('handles the end of daylight saving time', () => {
    // Sat 31 Oct 21:00 MDT -> Mon 2 Nov 08:00 MST (UTC-7)
    expect(nextWorkingTime(at('2026-11-01T03:00:00Z'), hours, 'America/Denver')).toEqual(at('2026-11-02T15:00:00Z'));
  });

  it('supports split shifts and other time zones', () => {
    const split = { tue: [{ open: '13:00', close: '17:00' }, { open: '09:00', close: '12:00' }] };
    // Tue 24 Nov 12:30 in London (UTC+0) -> 13:00
    expect(nextWorkingTime(at('2026-11-24T12:30:00Z'), split, 'Europe/London')).toEqual(at('2026-11-24T13:00:00Z'));
    // Tue 09:30 in Kolkata (UTC+5:30) is inside the first shift
    expect(isWithinWorkingHours(at('2026-11-24T04:00:00Z'), split, 'Asia/Kolkata')).toBe(true);
  });

  it('treats missing working hours as always open', () => {
    expect(nextWorkingTime(at('2026-11-22T03:00:00Z'), {}, 'UTC')).toEqual(at('2026-11-22T03:00:00Z'));
    expect(isWithinWorkingHours(at('2026-11-22T03:00:00Z'), undefined)).toBe(true);
  });
});
