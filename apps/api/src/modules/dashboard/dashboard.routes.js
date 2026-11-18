import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createLimiter } from '../../middleware/rateLimit.js';
import { isTest } from '../../config/env.js';
import * as service from './dashboard.service.js';
import * as agents from './agents.service.js';

const summaryQuery = z.strictObject({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') });
const activityQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.iso.datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  category: z.enum(['customer', 'qualification', 'ai', 'followUps', 'messages', 'approvals']).optional(),
});

/** /api/dashboard */
export const dashboardRouter = Router();
dashboardRouter.use(authenticate);
dashboardRouter.get('/summary', validate({ query: summaryQuery }), async (req, res) => {
  res.json(await service.summary(req.auth, req.valid.query));
});
dashboardRouter.get('/activity', validate({ query: activityQuery }), async (req, res) => {
  res.json({ data: await service.activity(req.auth, req.valid.query) });
});

const rangeQuery = z.strictObject({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') });
const generateBody = z.strictObject({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') });

/** Generating insights calls the model: keep it to a few per user per hour. */
const insightsLimit = createLimiter({
  name: 'insights',
  windowMs: 60 * 60e3,
  limit: 10,
  keyGenerator: (req) => req.auth.userId,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Insights were refreshed recently; try again later' } }),
});

dashboardRouter.get('/agents', validate({ query: rangeQuery }), async (req, res) => {
  res.json({ data: await agents.agentStatus(req.auth, req.valid.query) });
});
dashboardRouter.get('/insights', async (req, res) => {
  res.json({ data: await agents.latestInsights(req.auth) });
});
dashboardRouter.post('/insights', insightsLimit, validate({ body: generateBody }), async (req, res) => {
  res.status(201).json({ data: await agents.generateInsights(req.auth, req.valid.body) });
});
