import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { decryptJson } from '../lib/secrets.js';
import { createMockCalendar } from './mockCalendar.js';
import { createGoogleCalendar } from './googleCalendar.js';

let override = null;
/** Test hook. */
export function setCalendarProvider(provider) {
  override = provider;
}

/** Google Calendar when the business connected it, otherwise the built-in calendar. */
export async function getCalendar(businessId) {
  if (override) return override;
  const conn = await prisma.integrationConnection.findUnique({ where: { businessId_provider: { businessId, provider: 'google_calendar' } } });
  if (conn?.status === 'CONNECTED' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const secrets = decryptJson(conn.secretsEnc);
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
    return createGoogleCalendar({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: secrets.refreshToken,
      calendarId: conn.config?.calendarId ?? 'primary',
      timeZone: business.timezone,
    });
  }
  return createMockCalendar();
}
