import { randomUUID } from 'node:crypto';

/**
 * Built-in calendar: availability comes from working hours and appointments
 * already stored in RevenuePilot. Used when Google Calendar is not connected.
 * Events exist only inside RevenuePilot (clearly labelled "RevenuePilot calendar").
 */
export function createMockCalendar() {
  return {
    name: 'mock',
    label: 'RevenuePilot calendar (built-in)',
    async busy() {
      return []; // stored appointments are added by the caller
    },
    async createEvent() {
      return { id: `rp_evt_${randomUUID()}` };
    },
    async updateEvent() {
      return { ok: true };
    },
    async cancelEvent() {
      return { ok: true };
    },
  };
}
