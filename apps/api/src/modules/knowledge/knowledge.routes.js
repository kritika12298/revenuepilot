import { Router } from 'express';
import { createLimiter } from '../../middleware/rateLimit.js';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import * as service from './knowledge.service.js';

const TYPES = ['SERVICE', 'FAQ', 'BUSINESS_INFO', 'CONTACT', 'LOCATION', 'POLICY'];
const owner = requireRole('OWNER');
const analyseLimit = createLimiter({ name: 'website-analysis', windowMs: 60 * 60e3, limit: 6, keyGenerator: (req) => req.auth.businessId, skip: () => isTest, standardHeaders: 'draft-8', legacyHeaders: false });

const itemBody = z.strictObject({
  type: z.enum(TYPES),
  title: z.string().trim().min(2).max(200),
  content: z.string().trim().min(2).max(2000),
  priceText: z.string().trim().max(200).nullable().optional(),
});
const patchBody = z
  .strictObject({
    title: z.string().trim().min(2).max(200).optional(),
    content: z.string().trim().min(2).max(2000).optional(),
    priceText: z.string().trim().max(200).nullable().optional(),
    status: z.enum(['APPROVED', 'REJECTED', 'PENDING_REVIEW']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
const cents = z.number().int().min(0).max(100_000_000);
const promoteBody = z
  .strictObject({
    priceType: z.enum(['FIXED', 'RANGE', 'QUOTE_ONLY']),
    priceMinCents: cents.nullable().optional(),
    priceMaxCents: cents.nullable().optional(),
    durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.priceType !== 'QUOTE_ONLY' && v.priceMinCents == null) ctx.addIssue({ code: 'custom', path: ['priceMinCents'], message: 'Enter the price' });
    if (v.priceType === 'RANGE' && (v.priceMaxCents == null || v.priceMaxCents < (v.priceMinCents ?? 0))) ctx.addIssue({ code: 'custom', path: ['priceMaxCents'], message: 'Enter a maximum at least the minimum' });
  })
  .transform((v) => ({
    priceType: v.priceType,
    priceMinCents: v.priceType === 'QUOTE_ONLY' ? null : v.priceMinCents,
    priceMaxCents: v.priceType === 'QUOTE_ONLY' ? null : v.priceType === 'FIXED' ? v.priceMinCents : v.priceMaxCents,
    durationMinutes: v.durationMinutes ?? null,
  }));

/** /api/website */
export const websiteRouter = Router();
websiteRouter.use(authenticate);
websiteRouter.get('/', async (req, res) => res.json(await service.getWebsite(req.auth)));
websiteRouter.post('/', owner, analyseLimit, validate({ body: z.strictObject({ url: z.string().trim().min(4).max(2048) }) }), async (req, res) =>
  res.status(202).json(await service.connectWebsite(req.auth, req.valid.body)),
);

/** /api/knowledge */
export const knowledgeRouter = Router();
knowledgeRouter.use(authenticate);
knowledgeRouter.get('/', validate({ query: z.strictObject({ status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']).optional(), type: z.enum(TYPES).optional() }) }), async (req, res) =>
  res.json({ data: await service.listKnowledge(req.auth, req.valid.query) }),
);
knowledgeRouter.post('/', owner, validate({ body: itemBody }), async (req, res) => res.status(201).json(await service.createKnowledge(req.auth, req.valid.body)));
knowledgeRouter.patch('/:id', owner, validate({ params: idParam, body: patchBody }), async (req, res) => res.json(await service.updateKnowledge(req.auth, req.valid.params.id, req.valid.body)));
knowledgeRouter.delete('/:id', owner, validate({ params: idParam }), async (req, res) => {
  await service.deleteKnowledge(req.auth, req.valid.params.id);
  res.status(204).end();
});
knowledgeRouter.post('/:id/promote', owner, validate({ params: idParam, body: promoteBody }), async (req, res) =>
  res.status(201).json(await service.promoteToService(req.auth, req.valid.params.id, req.valid.body)),
);
