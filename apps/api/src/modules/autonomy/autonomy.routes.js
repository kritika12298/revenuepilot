import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as service from './autonomy.service.js';

const body = z
  .strictObject({
    autoScoreLeads: z.boolean().optional(),
    autoGenerateResponses: z.boolean().optional(),
    autoSendResponses: z.boolean().optional(),
    autoScheduleFollowUps: z.boolean().optional(),
    autoApproveFollowUps: z.boolean().optional(),
    autoBookAppointments: z.boolean().optional(),
    maxAutoEmailsPerDay: z.number().int().min(0).max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one setting');

/** /api/autonomy: read for the team, change for owners (enforced server-side by the Policy Agent). */
export const autonomyRouter = Router();
autonomyRouter.use(authenticate);
autonomyRouter.get('/', async (req, res) => res.json(await service.getAutonomy(req.auth)));
autonomyRouter.put('/', requireRole('OWNER'), validate({ body }), async (req, res) => res.json(await service.updateAutonomy(req.auth, req.valid.body)));
