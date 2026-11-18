import { createHash } from 'node:crypto';
/**
 * Google Calendar adapter (Calendar API v3, OAuth 2.0 refresh tokens).
 *   freeBusy:  POST https://www.googleapis.com/calendar/v3/freeBusy
 *   insert:    POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
 *   patch:     PATCH .../events/{eventId}
 *   delete:    DELETE .../events/{eventId}
 *   token:     POST https://oauth2.googleapis.com/token (grant_type=refresh_token)
 * Only used when the owner connected Google Calendar in the Integration Hub.
 */
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class CalendarError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.code = 'CALENDAR_ERROR';
    this.retryable = retryable;
    this.status = status;
  }
}

export function createGoogleCalendar({ clientId, clientSecret, refreshToken, calendarId = 'primary', timeZone, fetch = globalThis.fetch }) {
  let cached = null;

  async function accessToken() {
    if (cached && cached.expiresAt > Date.now() + 60e3) return cached.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new CalendarError(`Google token refresh failed: ${body.error_description ?? body.error ?? res.status}`, { status: res.status });
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  async function call(method, path, payload) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (res.status === 204) return {};
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new CalendarError(`Google Calendar ${res.status}: ${body.error?.message ?? res.statusText}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    return body;
  }

  const cal = encodeURIComponent(calendarId);
  return {
    name: 'google',
    label: 'Google Calendar',
    async busy(timeMin, timeMax) {
      const body = await call('POST', '/freeBusy', { timeMin, timeMax, timeZone, items: [{ id: calendarId }] });
      return body.calendars?.[calendarId]?.busy ?? [];
    },
    async createEvent({ title, start, end, description, location, requestId }) {
      // Deterministic event id (Google allows base32hex: 0-9a-v), so a retried confirmation
      // can't create a second event: Google answers 409 and we reuse the existing one.
      const id = `rp${createHash('sha256').update(String(requestId)).digest('hex').slice(0, 40)}`;
      // sendUpdates=none: the customer is emailed by RevenuePilot, not by Google.
      let body;
      try {
        body = await call('POST', `/calendars/${cal}/events?sendUpdates=none`, eventBody(id));
      } catch (err) {
        if (err.status !== 409) throw err;
        // Already created by an earlier attempt, or a cancelled event for the same booking key
        // (re-booked after a cancellation): make sure it is live with the current details.
        const existing = await call('GET', `/calendars/${cal}/events/${id}`);
        if (existing.status === 'cancelled') await call('PATCH', `/calendars/${cal}/events/${id}?sendUpdates=none`, { ...eventBody(id), status: 'confirmed' });
        return { id };
      }
      return { id: body.id };

      function eventBody(eventId) {
        return {
          id: eventId,
          summary: title,
          description,
          location,
          start: { dateTime: start, timeZone },
          end: { dateTime: end, timeZone },
          extendedProperties: { private: { revenuepilotRequestId: requestId } },
        };
      }
    },
    async updateEvent(eventId, { start, end }) {
      await call('PATCH', `/calendars/${cal}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone } });
      return { ok: true };
    },
    async cancelEvent(eventId) {
      await call('DELETE', `/calendars/${cal}/events/${encodeURIComponent(eventId)}?sendUpdates=none`);
      return { ok: true };
    },
  };
}
