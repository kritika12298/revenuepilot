import { prisma } from '../../lib/prisma.js';
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { verifySignature } from '../messages/message.routes.js';
import * as leadService from '../leads/lead.service.js';
import { enqueueProcessLead } from '../../jobs/processLead.js';
import * as service from './integration.service.js';
import { assertNotReplayed } from '../../lib/replayGuard.js';

const PROVIDER = z.strictObject({ provider: z.enum(['godaddy_domains', 'godaddy_websites', 'claude', 'google_calendar', 'resend', 'website_webhook']) });
const owner = requireRole('OWNER');
const OAUTH_COOKIE = 'rp_google_oauth';
const OAUTH_COOKIE_PATH = '/api/integrations/google';

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** /api/integrations */
export const integrationRouter = Router();

// Google redirects the browser here (no bearer token); the signed state proves who started it.
integrationRouter.get('/google/callback', validate({ query: z.object({ code: z.string().min(5).max(2000).optional(), state: z.string().min(10).max(2000), error: z.string().optional() }) }), async (req, res) => {
  const back = `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/integrations`;
  if (req.valid.query.error || !req.valid.query.code) {
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
    return res.redirect(`${back}?google=denied`);
  }
  const nonce = readCookie(req, OAUTH_COOKIE);
  res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
  try {
    await service.googleCallback({ ...req.valid.query, nonce });
    res.redirect(`${back}?google=connected`);
  } catch (err) {
    logger.warn({ err: { message: err.message } }, 'Google OAuth callback failed');
    res.redirect(`${back}?google=error`);
  }
});

integrationRouter.use(authenticate);
integrationRouter.get('/', async (req, res) => res.json({ data: await service.list(req.auth) }));
integrationRouter.post('/:provider/test', owner, validate({ params: PROVIDER }), async (req, res) => res.json(await service.test(req.auth, req.valid.params.provider)));
integrationRouter.put('/godaddy_domains', owner, validate({ body: z.strictObject({ token: z.string().trim().min(10).max(4000) }) }), async (req, res) =>
  res.json(await service.connectGoDaddy(req.auth, req.valid.body)),
);
integrationRouter.post('/website_webhook/rotate', owner, async (req, res) => res.json(await service.rotateWebhookSecret(req.auth)));
integrationRouter.get('/google_calendar/connect', owner, async (req, res) => {
  const { url, nonce } = await service.googleAuthUrl(req.auth);
  // Binds the sign-in to this browser; only the callback path can read it.
  res.cookie(OAUTH_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: OAUTH_COOKIE_PATH, maxAge: 10 * 60e3 });
  res.json({ url });
});
integrationRouter.delete('/:provider', owner, validate({ params: PROVIDER }), async (req, res) => {
  await service.disconnect(req.auth, req.valid.params.provider);
  res.status(204).end();
});

const webhookLead = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/).optional(),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(5000),
  consent: z.boolean().default(false),
});

/**
 * POST /api/webhooks/leads/:slug: signed lead intake for any website or tool.
 * Mounted before the JSON parser: the HMAC covers the raw body.
 */
export const leadWebhookRouter = Router();
leadWebhookRouter.post('/:slug', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const found = /^[a-z0-9-]{2,60}$/.test(req.params.slug) ? await service.webhookSecretForSlug(req.params.slug) : null;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!found?.secret || !verifySignature(raw, req.get('x-revenuepilot-timestamp'), req.get('x-revenuepilot-signature'), found.secret)) {
    throw new UnauthorizedError('Invalid webhook signature');
  }
  await assertNotReplayed(`lead-webhook:${found.business.id}`, req.get('x-revenuepilot-signature'));
  let body;
  try {
    body = webhookLead.parse(JSON.parse(raw.toString('utf8')));
  } catch (err) {
    throw new ValidationError(err.issues?.map((i) => ({ location: 'body', path: i.path.join('.'), message: i.message })) ?? [{ location: 'body', path: '', message: 'Invalid JSON' }]);
  }
  if (!body.email && !body.phone) throw new ValidationError([{ location: 'body', path: 'email', message: 'Provide an email or phone' }]);
  const lead = await leadService.create(
    { businessId: found.business.id, userId: null },
    {
      name: body.name,
      email: body.email,
      phone: body.phone,
      company: body.company,
      source: 'API',
      enquiry: { channel: 'WEB_FORM', subject: 'Website enquiry', message: body.message },
      ...(body.consent && { consent: { email: true, source: 'webhook:website' } }),
    },
    { type: 'LEAD' },
  );
  await prisma.integrationConnection.updateMany({ where: { businessId: found.business.id, provider: 'website_webhook' }, data: { lastSyncAt: new Date() } });
  await enqueueProcessLead({ businessId: found.business.id, leadId: lead.id, trigger: 'LEAD_CREATED', detail: 'New enquiry via website webhook', dedupe: 'created' }).catch(() => {});
  res.status(202).json({ accepted: true, leadId: lead.id });
});
