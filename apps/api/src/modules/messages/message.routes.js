import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { createLimiter } from '../../middleware/rateLimit.js';
import { z } from 'zod';
import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import { optOutByToken, recordInbound } from './inbound.service.js';
import { assertNotReplayed } from '../../lib/replayGuard.js';
import { listConversations, sendOwnerReply } from './conversation.service.js';
import { pagination } from '../../lib/validators.js';

const inboundBody = z.strictObject({
  subject: z.string().trim().max(300).optional(),
  body: z.string().trim().min(1).max(10_000),
  channel: z.enum(['EMAIL', 'PHONE', 'SMS', 'WEB_FORM']).default('EMAIL'),
});

/**
 * /api/leads/:id/messages/inbound: log a reply the owner received elsewhere
 * (phone, personal inbox). Also used for demos. Stops pending follow-ups.
 */
export const leadMessageRouter = Router({ mergeParams: true });
leadMessageRouter.use(authenticate);
leadMessageRouter.post('/inbound', validate({ params: idParam, body: inboundBody }), async (req, res) => {
  const result = await recordInbound({
    businessId: req.auth.businessId,
    leadId: req.valid.params.id,
    ...req.valid.body,
    source: 'manual',
    actor: { type: 'USER', userId: req.auth.userId },
  });
  res.status(201).json(result);
});

const replyBody = z.strictObject({
  subject: z.string().trim().min(1).max(150).optional(),
  body: z.string().trim().min(1).max(5000),
});

/** Owner writes a reply from the dashboard; it is queued for delivery. */
leadMessageRouter.post('/', validate({ params: idParam, body: replyBody }), async (req, res) => {
  res.status(201).json(await sendOwnerReply(req.auth, req.valid.params.id, req.valid.body));
});

const conversationQuery = z.strictObject({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  needsReply: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

/** /api/conversations: inbox of leads with message history. */
export const conversationRouter = Router();
conversationRouter.use(authenticate);
conversationRouter.get('/', validate({ query: conversationQuery }), async (req, res) => {
  res.json(await listConversations(req.auth, req.valid.query));
});

// ---------------------------------------------------------------------------
// Inbound email webhook (provider-agnostic)
// ---------------------------------------------------------------------------

const MAX_SKEW_MS = 5 * 60e3;

const webhookPayload = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  from: z.string().optional(),
  subject: z.string().max(998).optional(),
  text: z.string().max(100_000),
});

/** Constant-time check of `sha256=<hex HMAC of "<timestamp>.<raw body>">`. */
export function verifySignature(rawBody, timestamp, signature, secret) {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > MAX_SKEW_MS) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strips quoted history from a reply so only the new text is stored. */
function stripQuoted(text) {
  const cut = text.search(/^\s*(?:On .+ wrote:|-{2,}\s*Original Message|>)/m);
  return (cut > 0 ? text.slice(0, cut) : text).trim() || text.trim();
}

const TOKEN_IN_ADDRESS = /\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;

/**
 * POST /api/webhooks/inbound-email
 * Called by an inbound email relay (Resend inbound, Cloudflare Email Workers,
 * Mailgun routes...). The lead is identified by the reply token in the
 * Reply-To address we set on outgoing mail, never by the sender address.
 * Mounted before the JSON body parser because the signature covers raw bytes.
 */
export const webhookRouter = Router();
webhookRouter.post('/inbound-email', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  if (!env.INBOUND_WEBHOOK_SECRET) throw new AppError(404, 'ROUTE_NOT_FOUND', 'Inbound email webhook is not configured');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifySignature(raw, req.get('x-revenuepilot-timestamp'), req.get('x-revenuepilot-signature'), env.INBOUND_WEBHOOK_SECRET)) {
    throw new UnauthorizedError('Invalid webhook signature');
  }
  await assertNotReplayed('inbound-email', req.get('x-revenuepilot-signature'));
  let payload;
  try {
    payload = webhookPayload.parse(JSON.parse(raw.toString('utf8')));
  } catch {
    throw new ValidationError([{ location: 'body', path: '', message: 'Invalid inbound email payload' }]);
  }

  const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
  const token = recipients.map((r) => r.match(TOKEN_IN_ADDRESS)?.[1]).find(Boolean);
  const lead = token && (await prisma.lead.findUnique({ where: { replyToken: token.toLowerCase() }, select: { id: true, businessId: true } }));
  if (!lead) {
    logger.warn({ automation: 'INBOUND_UNMATCHED' }, 'Inbound email did not match a lead');
    return res.status(202).json({ accepted: true, matched: false });
  }

  const result = await recordInbound({
    businessId: lead.businessId,
    leadId: lead.id,
    subject: payload.subject,
    body: stripQuoted(payload.text).slice(0, 10_000),
    channel: 'EMAIL',
    source: 'webhook',
  });
  res.status(202).json({ accepted: true, matched: true, cancelledFollowUps: result.cancelledFollowUps });
});

// ---------------------------------------------------------------------------
// Unsubscribe (/u/:token). GET shows a confirmation form (link scanners must
// not unsubscribe people); POST performs it, including RFC 8058 one-click.
// ---------------------------------------------------------------------------

const tokenParam = z.strictObject({ token: z.uuid() });
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937}` +
  `button{font-size:1rem;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#111827;color:#fff;cursor:pointer}</style></head>` +
  `<body><h1>${title}</h1>${body}</body></html>`;

const unsubscribeLimit = createLimiter({ name: 'unsubscribe', windowMs: 60e3, limit: 30, skip: () => isTest, standardHeaders: 'draft-8', legacyHeaders: false });

export const unsubscribeRouter = Router();
unsubscribeRouter.use(unsubscribeLimit);
unsubscribeRouter.get('/:token', validate({ params: tokenParam }), (req, res) => {
  res
    .type('html')
    .send(
      page(
        'Unsubscribe',
        `<p>Click below to stop receiving emails from this business.</p>` +
          `<form method="post" action="/u/${req.valid.params.token}"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
});
unsubscribeRouter.post('/:token', express.urlencoded({ extended: false, limit: '2kb' }), validate({ params: tokenParam }), async (req, res) => {
  const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
  const result = await optOutByToken(req.valid.params.token, { via: oneClick ? 'one-click header' : 'unsubscribe page' });
  if (!result.found) return res.status(404).type('html').send(page('Link not recognised', '<p>This unsubscribe link is not valid.</p>'));
  res.type('html').send(page("You're unsubscribed", '<p>You will not receive further emails from us. Sorry to see you go.</p>'));
});
