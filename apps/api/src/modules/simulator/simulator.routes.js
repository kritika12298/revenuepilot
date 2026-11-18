import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { simulate } from './simulator.service.js';

const body = z.discriminatedUnion('scenario', [
  z.strictObject({ scenario: z.literal('RESPONSE_TIME'), range: z.enum(['30d', '90d', 'all']).default('90d'), params: z.strictObject({ targetMinutes: z.number().int().min(5).max(1440), segment: z.enum(['HIGH_INTENT', 'ALL']).default('HIGH_INTENT') }) }),
  z.strictObject({ scenario: z.literal('FIRST_FOLLOW_UP_DELAY'), range: z.enum(['30d', '90d', 'all']).default('90d'), params: z.strictObject({ delayHours: z.number().int().min(1).max(720) }) }),
  z.strictObject({ scenario: z.literal('FOLLOW_UP_FREQUENCY'), range: z.enum(['30d', '90d', 'all']).default('90d'), params: z.strictObject({ maxFollowUps: z.number().int().min(0).max(5) }) }),
  z.strictObject({ scenario: z.literal('PRIORITISATION'), range: z.enum(['30d', '90d', 'all']).default('90d'), params: z.strictObject({ by: z.enum(['VALUE', 'SCORE', 'URGENCY']) }) }),
]);

/** POST /api/simulations: read-only what-if analysis. Never changes settings. */
export const simulatorRouter = Router();
simulatorRouter.use(authenticate);
simulatorRouter.post('/', validate({ body }), async (req, res) => res.json(await simulate(req.auth, req.valid.body)));
