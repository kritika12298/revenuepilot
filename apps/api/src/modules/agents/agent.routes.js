import { Router } from 'express';
import { createLimiter } from '../../middleware/rateLimit.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import { isTest } from '../../config/env.js';
import { listRunsQuerySchema, startRunSchema } from './agent.schemas.js';
import * as controller from './agent.controller.js';
import * as service from './agent.service.js';
import { z } from 'zod';
import { pagination } from '../../lib/validators.js';

/** Model calls cost money: cap how often one user can start agents. */
const agentRateLimit = createLimiter({
  name: 'agent-runs',
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.auth.userId,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) =>
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many agent runs, please wait a minute' } }),
});

/** Mounted under /api/leads/:id/agent-runs */
export const leadAgentRouter = Router({ mergeParams: true });
leadAgentRouter.use(authenticate);
leadAgentRouter.post('/', agentRateLimit, validate({ params: idParam, body: startRunSchema }), controller.start);
leadAgentRouter.get('/', validate({ params: idParam, query: listRunsQuerySchema }), controller.listForLead);

/** Mounted under /api/agent-runs */
export const agentRunRouter = Router();
agentRunRouter.use(authenticate);
agentRunRouter.get(
  '/',
  validate({
    query: z.strictObject({
      ...pagination,
      agent: z.enum(['orchestrator', 'lead_intelligence', 'conversation', 'follow_up', 'meeting', 'policy', 'sales_intelligence', 'website']).optional(),
      status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']).optional(),
      leadId: z.uuid().optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
    }),
  }),
  async (req, res) => res.json(await service.listAll(req.auth, req.valid.query)),
);
agentRunRouter.get('/:id', validate({ params: idParam }), controller.getRun);

/** Mounted under /api/ai */
export const aiRouter = Router();
aiRouter.use(authenticate);
aiRouter.get('/status', controller.status);
