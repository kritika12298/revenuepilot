import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { decryptJson, encryptJson } from '../../lib/secrets.js';
import { getAIClient } from '../../ai/client.js';
import { audit } from '../automation/auditLog.js';
import { createGoDaddyClient } from '../../integrations/godaddy.js';
import { checkResend } from '../../integrations/resendCheck.js';
import { checkClaude } from '../../integrations/claudeCheck.js';
import { getCalendar } from '../../calendar/index.js';

/** Test hooks for outbound HTTP. */
export const deps = { fetch: (...a) => globalThis.fetch(...a), checkClaude };

const PROVIDERS = ['godaddy_domains', 'godaddy_websites', 'claude', 'google_calendar', 'resend', 'website_webhook'];

async function connection(businessId, provider) {
  return prisma.integrationConnection.findUnique({ where: { businessId_provider: { businessId, provider } } });
}

async function save(ctx, provider, data) {
  const row = await prisma.integrationConnection.upsert({
    where: { businessId_provider: { businessId: ctx.businessId, provider } },
    update: data,
    create: { businessId: ctx.businessId, provider, ...data },
  });
  await audit({ businessId: ctx.businessId, actor: { type: 'USER', userId: ctx.userId }, action: `integration.${provider}.${data.status?.toLowerCase() ?? 'updated'}`, entityType: 'integration', entityId: row.id });
  return row;
}

/** Honest, computed status for every integration card. */
export async function list(ctx) {
  const rows = new Map((await prisma.integrationConnection.findMany({ where: { businessId: ctx.businessId } })).map((r) => [r.provider, r]));
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId }, select: { slug: true } });
  const ai = getAIClient();
  const [lastRun, lastFailedRun, lastSent, lastFailedSend, lastFormLead, website] = await Promise.all([
    prisma.agentRun.findFirst({ where: { businessId: ctx.businessId, status: 'SUCCEEDED', model: { not: 'policy-engine' } }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, model: true } }),
    prisma.agentRun.findFirst({ where: { businessId: ctx.businessId, status: 'FAILED', errorCode: { in: ['AI_MISCONFIGURED', 'AI_UNAVAILABLE', 'AI_RATE_LIMITED'] } }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, error: true } }),
    prisma.emailDelivery.findFirst({ where: { businessId: ctx.businessId, status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true, provider: true } }),
    prisma.emailDelivery.findFirst({ where: { businessId: ctx.businessId, status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, lastError: true } }),
    prisma.lead.findFirst({ where: { businessId: ctx.businessId, source: 'WEB_FORM', consentSource: { startsWith: 'web_form:/f/' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.businessWebsite.findUnique({ where: { businessId: ctx.businessId }, select: { url: true, lastSyncAt: true, status: true } }),
  ]);
  const godaddy = rows.get('godaddy_domains');
  const google = rows.get('google_calendar');
  const webhook = rows.get('website_webhook');
  const failedAfter = (fail, ok) => fail && (!ok || fail > ok);

  return [
    {
      provider: 'godaddy_domains',
      name: 'GoDaddy Domains',
      description: 'List the domains in your GoDaddy account and choose the one RevenuePilot should analyse for Website Intelligence.',
      status: godaddy?.status ?? 'NOT_CONFIGURED',
      mode: 'live',
      requirements: ['A GoDaddy Personal Access Token with the domains.domain:read scope (developer.godaddy.com)', 'GoDaddy may restrict API access for some account types; a 403 means the account or token is not eligible'],
      config: { domains: godaddy?.config?.domains ?? [] },
      lastSyncAt: godaddy?.lastSyncAt ?? null,
      lastError: godaddy?.lastError ?? null,
      actions: ['connect_token', 'test', 'disconnect'],
    },
    {
      provider: 'godaddy_websites',
      name: 'GoDaddy Websites + Marketing',
      description: 'Capture enquiries from your GoDaddy website with the RevenuePilot enquiry form, and let Website Intelligence read your site.',
      // No GoDaddy API exists for this, so never claim a connection: the form is either available or receiving enquiries.
      status: lastFormLead ? 'RECEIVING' : 'AVAILABLE',
      mode: 'embed',
      note: 'Uses an embeddable form and website analysis. GoDaddy does not offer a public Websites + Marketing API, so no direct API connection is claimed.',
      requirements: ['Add an "HTML" section to your GoDaddy site and paste the embed code', 'Optional: connect your website URL on the Knowledge page'],
      config: { formUrl: `/f/${business.slug}`, embed: `<iframe src="{ORIGIN}/f/${business.slug}" title="Contact us" style="width:100%;min-height:640px;border:0"></iframe>`, websiteUrl: website?.url ?? null },
      lastSyncAt: lastFormLead?.createdAt ?? null,
      lastError: null,
      actions: [],
    },
    {
      provider: 'claude',
      name: 'Claude API',
      description: 'Powers the AI agents (analysis, replies, follow-ups, meetings, insights, website reading).',
      status: ai.mode === 'live' ? (failedAfter(lastFailedRun?.finishedAt, lastRun?.finishedAt) ? 'ERROR' : 'CONNECTED') : 'MOCK',
      mode: ai.mode,
      note: ai.mode === 'mock' ? 'Mock AI is active: agents use rule-based stand-ins and no Claude calls are made.' : `Model: ${ai.model}`,
      requirements: ['Server environment: ANTHROPIC_API_KEY (or an ant login) and AI_MODE=live', 'Configured by the server administrator, not per business'],
      config: { model: ai.mode === 'live' ? ai.model : null },
      // A mock run is not a Claude call, so it never counts as a Claude success.
      lastSyncAt: ai.mode === 'live' ? (lastRun?.finishedAt ?? null) : null,
      lastError: ai.mode === 'live' && failedAfter(lastFailedRun?.finishedAt, lastRun?.finishedAt) ? lastFailedRun.error : null,
      actions: ai.mode === 'live' ? ['test'] : [],
    },
    {
      provider: 'google_calendar',
      name: 'Google Calendar',
      description: 'Check real availability and create, move and cancel appointment events. Without it, RevenuePilot uses its built-in calendar.',
      status: !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET ? 'DISABLED' : google?.status ?? 'NOT_CONFIGURED',
      mode: 'live',
      note: !env.GOOGLE_CLIENT_ID ? 'Not available on this server: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.' : null,
      requirements: ['Server: a Google Cloud OAuth client (GOOGLE_CLIENT_ID/SECRET) with the Calendar API enabled', `Redirect URI: ${env.PUBLIC_BASE_URL}/api/integrations/google/callback`, 'You: sign in with Google and allow calendar access'],
      config: { calendarId: google?.config?.calendarId ?? 'primary', account: google?.config?.account ?? null },
      lastSyncAt: google?.lastSyncAt ?? null,
      lastError: google?.lastError ?? null,
      actions: env.GOOGLE_CLIENT_ID ? ['oauth', 'test', 'disconnect'] : [],
    },
    {
      provider: 'resend',
      name: 'Resend email',
      description: 'Delivers customer emails with idempotency keys and delivery status.',
      status: env.EMAIL_PROVIDER === 'resend' ? (failedAfter(lastFailedSend?.updatedAt, lastSent?.sentAt) ? 'ERROR' : 'CONNECTED') : 'MOCK',
      mode: env.EMAIL_PROVIDER,
      note: env.EMAIL_PROVIDER === 'mock' ? 'Mock email is active: messages are recorded but nothing leaves the server.' : `Sender: ${env.EMAIL_FROM_ADDRESS}`,
      requirements: ['Server environment: EMAIL_PROVIDER=resend, RESEND_API_KEY and an EMAIL_FROM_ADDRESS on a domain verified in Resend'],
      config: { from: env.EMAIL_FROM_ADDRESS },
      lastSyncAt: env.EMAIL_PROVIDER === 'resend' ? (lastSent?.sentAt ?? null) : null,
      lastError: env.EMAIL_PROVIDER === 'resend' && failedAfter(lastFailedSend?.updatedAt, lastSent?.sentAt) ? lastFailedSend.lastError : null,
      actions: env.EMAIL_PROVIDER === 'resend' ? ['test'] : [],
    },
    {
      provider: 'website_webhook',
      name: 'Website webhooks',
      description: 'Send enquiries from any website, form builder or CRM to RevenuePilot with a signed webhook.',
      status: webhook?.secretsEnc ? 'CONNECTED' : 'NOT_CONFIGURED',
      mode: 'live',
      requirements: ['POST JSON to the endpoint below', 'Sign each request: X-RevenuePilot-Timestamp and X-RevenuePilot-Signature = sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")'],
      config: { endpoint: `${env.PUBLIC_BASE_URL}/api/webhooks/leads/${business.slug}`, fields: ['name', 'email', 'phone?', 'company?', 'message', 'consent (boolean)'] },
      lastSyncAt: webhook?.lastSyncAt ?? null,
      lastError: null,
      actions: ['rotate_secret', 'disconnect'],
    },
  ];
}

export async function connectGoDaddy(ctx, { token }) {
  let domains;
  try {
    domains = await createGoDaddyClient({ token, fetch: deps.fetch }).listDomains();
  } catch (err) {
    await save(ctx, 'godaddy_domains', { status: 'ERROR', lastError: err.message });
    throw new UnprocessableError('GODADDY_CONNECTION_FAILED', err.message);
  }
  await save(ctx, 'godaddy_domains', { status: 'CONNECTED', secretsEnc: encryptJson({ token }), config: { domains }, lastSyncAt: new Date(), lastError: null, connectedAt: new Date() });
  return { domains };
}

export async function test(ctx, provider) {
  if (!PROVIDERS.includes(provider)) throw new NotFoundError('Integration');
  try {
    if (provider === 'claude') {
      if (getAIClient().mode !== 'live') return { ok: true, detail: 'Mock AI is active; nothing to test.' };
      const r = await deps.checkClaude(env.ANTHROPIC_MODEL);
      return { ok: true, detail: `Claude reachable: ${r.displayName ?? r.model}` };
    }
    if (provider === 'resend') {
      if (env.EMAIL_PROVIDER !== 'resend') return { ok: true, detail: 'Mock email is active; nothing to test.' };
      const r = await checkResend({ apiKey: env.RESEND_API_KEY, fetch: deps.fetch });
      return { ok: true, detail: `Resend reachable: ${r.domains.map((d) => `${d.name} (${d.status})`).join(', ') || 'no domains yet'}` };
    }
    if (provider === 'godaddy_domains') {
      const conn = await connection(ctx.businessId, provider);
      if (!conn?.secretsEnc) throw new UnprocessableError('NOT_CONNECTED', 'Connect GoDaddy first');
      const domains = await createGoDaddyClient({ token: decryptJson(conn.secretsEnc).token, fetch: deps.fetch }).listDomains();
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'CONNECTED', config: { ...conn.config, domains }, lastSyncAt: new Date(), lastError: null } });
      return { ok: true, detail: `${domains.length} active domain${domains.length === 1 ? '' : 's'} found` };
    }
    if (provider === 'google_calendar') {
      const conn = await connection(ctx.businessId, provider);
      if (conn?.status !== 'CONNECTED') throw new UnprocessableError('NOT_CONNECTED', 'Connect Google Calendar first');
      const cal = await getCalendar(ctx.businessId);
      const busy = await cal.busy(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastError: null } });
      return { ok: true, detail: `Calendar reachable: ${busy.length} busy period${busy.length === 1 ? '' : 's'} in the next 24 hours` };
    }
    return { ok: true, detail: 'Nothing to test for this integration.' };
  } catch (err) {
    if (err instanceof UnprocessableError) throw err;
    const row = await connection(ctx.businessId, provider);
    if (row) await prisma.integrationConnection.update({ where: { id: row.id }, data: { status: 'ERROR', lastError: err.message } });
    return { ok: false, detail: err.message };
  }
}

/** Generates a new webhook signing secret. Returned once; stored encrypted. */
export async function rotateWebhookSecret(ctx) {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  await save(ctx, 'website_webhook', { status: 'CONNECTED', secretsEnc: encryptJson({ secret }), connectedAt: new Date(), lastError: null });
  return { secret };
}

export async function disconnect(ctx, provider) {
  if (!['godaddy_domains', 'google_calendar', 'website_webhook'].includes(provider)) throw new UnprocessableError('NOT_DISCONNECTABLE', 'This integration is configured by the server administrator');
  await save(ctx, provider, { status: 'NOT_CONFIGURED', secretsEnc: null, lastError: null, config: {} });
}

export async function webhookSecretForSlug(slug) {
  const business = await prisma.business.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!business) return null;
  const conn = await connection(business.id, 'website_webhook');
  return conn?.secretsEnc ? { business, secret: decryptJson(conn.secretsEnc).secret } : { business, secret: null };
}

// --- Google OAuth -----------------------------------------------------------------
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];
const redirectUri = () => `${env.PUBLIC_BASE_URL}/api/integrations/google/callback`;

const OAUTH_STATE_PROVIDER = 'google_oauth_state';
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * Starts Google sign-in. The state is bound to (1) the browser that asked, via a
 * random nonce returned to the caller to set as an httpOnly cookie, and (2) a
 * single-use record in the database. A link sent to someone else therefore cannot
 * attach their calendar to this business, and a state can only be redeemed once.
 */
export async function googleAuthUrl(ctx) {
  if (!env.GOOGLE_CLIENT_ID) throw new UnprocessableError('GOOGLE_NOT_CONFIGURED', 'Google Calendar is not configured on this server');
  const { state, nonce } = await createOAuthState(ctx);
  const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, nonce };
}

/** A fresh single-use state (replaces any earlier pending one) plus the browser nonce. */
export async function createOAuthState(ctx) {
  const nonce = randomBytes(32).toString('base64url');
  const jti = randomBytes(16).toString('hex');
  await prisma.integrationConnection.upsert({
    where: { businessId_provider: { businessId: ctx.businessId, provider: OAUTH_STATE_PROVIDER } },
    update: { status: 'NOT_CONFIGURED', config: { jti, nonceHash: sha256(nonce), userId: ctx.userId } },
    create: { businessId: ctx.businessId, provider: OAUTH_STATE_PROVIDER, status: 'NOT_CONFIGURED', config: { jti, nonceHash: sha256(nonce), userId: ctx.userId } },
  });
  const state = jwt.sign({ bid: ctx.businessId, uid: ctx.userId, jti, purpose: 'google_oauth' }, env.JWT_SECRET, { expiresIn: '10m' });
  return { state, nonce };
}

export async function googleCallback({ code, state, nonce }) {
  let claims;
  try {
    claims = jwt.verify(state, env.JWT_SECRET);
    if (claims.purpose !== 'google_oauth' || !claims.jti) throw new Error('bad purpose');
  } catch {
    throw new UnprocessableError('INVALID_STATE', 'The Google sign-in link expired or is invalid. Try connecting again.');
  }
  // Single use, same browser: consume the pending record only if the cookie nonce matches.
  const consumed = nonce
    ? await prisma.integrationConnection.deleteMany({
        where: {
          businessId: claims.bid,
          provider: OAUTH_STATE_PROVIDER,
          AND: [{ config: { path: ['jti'], equals: claims.jti } }, { config: { path: ['nonceHash'], equals: sha256(nonce) } }],
        },
      })
    : { count: 0 };
  if (consumed.count !== 1) throw new UnprocessableError('INVALID_STATE', 'This Google sign-in was not started in this browser, or was already used. Try connecting again.');
  // The person who started it must still be an owner of the business.
  const membership = await prisma.membership.findFirst({ where: { userId: claims.uid, businessId: claims.bid, role: 'OWNER' } });
  if (!membership) throw new UnprocessableError('INVALID_STATE', 'Only an owner of the business can connect Google Calendar.');
  const res = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const body = await res.json().catch(() => ({}));
  const ctx = { businessId: claims.bid, userId: claims.uid };
  if (!res.ok || !body.refresh_token) {
    const message = `Google sign-in failed: ${body.error_description ?? body.error ?? 'no refresh token returned'}`;
    await save(ctx, 'google_calendar', { status: 'ERROR', lastError: message });
    throw new UnprocessableError('GOOGLE_OAUTH_FAILED', message);
  }
  await save(ctx, 'google_calendar', { status: 'CONNECTED', secretsEnc: encryptJson({ refreshToken: body.refresh_token }), config: { calendarId: 'primary' }, connectedAt: new Date(), lastSyncAt: new Date(), lastError: null });
  return ctx;
}
