import { Router } from 'express';
import { createLimiter } from '../../middleware/rateLimit.js';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { validate } from '../../middleware/validate.js';
import * as leadService from '../leads/lead.service.js';
import { enqueueProcessLead } from '../../jobs/processLead.js';

/**
 * Public lead capture: the hosted enquiry form (/f/:slug in the web app),
 * which can be embedded on a GoDaddy Websites + Marketing site or any other
 * site. Rate-limited per IP, with a honeypot field for bots.
 */
export const publicRouter = Router();

const formLimit = createLimiter({ name: 'public-form', windowMs: 10 * 60e3, limit: 10, skip: () => isTest, standardHeaders: 'draft-8', legacyHeaders: false });
const MAX_PER_EMAIL_PER_BUSINESS = 3;
const MAX_PER_EMAIL_OVERALL = 10;
const slugParam = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/) });

async function businessBySlug(slug) {
  const business = await prisma.business.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } });
  if (!business) throw new NotFoundError('Business');
  return business;
}

publicRouter.get('/forms/:slug', validate({ params: slugParam }), async (req, res) => {
  const business = await businessBySlug(req.valid.params.slug);
  res.json({ business: { name: business.name, slug: business.slug }, consentText: `I agree to receive emails from ${business.name} about my enquiry.` });
});

const enquiry = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address')),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/, 'Invalid phone number').optional().or(z.literal('')),
  company: z.string().trim().max(200).optional().or(z.literal('')),
  message: z.string().trim().min(10, 'Tell us a little more about what you need').max(5000),
  consent: z.boolean(),
  /** Honeypot: humans never see or fill this field. */
  website: z.string().max(500).optional(),
});

publicRouter.post('/forms/:slug/leads', formLimit, validate({ params: slugParam, body: enquiry }), async (req, res) => {
  const business = await businessBySlug(req.valid.params.slug);
  const b = req.valid.body;
  if (b.website) {
    logger.warn({ businessId: business.id }, 'Public form honeypot triggered; enquiry discarded');
    return res.status(201).json({ ok: true, message: `Thanks! ${business.name} will be in touch shortly.` });
  }
  // Anyone can type any address into a public form. Cap submissions per address so the
  // form (and any automatic reply) can't be used to flood someone's inbox. The response
  // is identical either way, so the cap can't be used to probe addresses.
  const since = new Date(Date.now() - 24 * 3600e3);
  const [forThisBusiness, everywhere] = await Promise.all([
    prisma.lead.count({ where: { businessId: business.id, email: b.email, source: 'WEB_FORM', createdAt: { gte: since } } }),
    prisma.lead.count({ where: { email: b.email, source: 'WEB_FORM', createdAt: { gte: since } } }),
  ]);
  if (forThisBusiness >= MAX_PER_EMAIL_PER_BUSINESS || everywhere >= MAX_PER_EMAIL_OVERALL) {
    logger.warn({ businessId: business.id }, 'Public form: per-address limit reached; enquiry discarded');
    return res.status(201).json({ ok: true, message: `Thanks! ${business.name} will be in touch shortly.` });
  }
  const lead = await leadService.create(
    { businessId: business.id, userId: null },
    {
      name: b.name,
      email: b.email,
      ...(b.phone && { phone: b.phone }),
      ...(b.company && { company: b.company }),
      source: 'WEB_FORM',
      enquiry: { channel: 'WEB_FORM', subject: 'Website enquiry', message: b.message },
      ...(b.consent && { consent: { email: true, source: `web_form:/f/${business.slug}` } }),
    },
    { type: 'LEAD' },
  );
  await enqueueProcessLead({ businessId: business.id, leadId: lead.id, trigger: 'LEAD_CREATED', detail: 'New enquiry via the website form', dedupe: 'created' }).catch((err) =>
    logger.error({ err: { message: err.message }, leadId: lead.id }, 'Could not queue lead processing; the owner can run the AI manually'),
  );
  res.status(201).json({ ok: true, message: `Thanks! ${business.name} will be in touch shortly.` });
});
