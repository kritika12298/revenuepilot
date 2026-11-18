import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { revenueOverview } from './revenue.service.js';

export const revenueRouter = Router();
revenueRouter.use(authenticate);
revenueRouter.get('/', validate({ query: z.strictObject({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') }) }), async (req, res) =>
  res.json(await revenueOverview(req.auth, req.valid.query)),
);
