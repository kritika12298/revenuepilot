import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import {
  createLeadSchema,
  listEventsQuerySchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  updateScoreSchema,
  updateStatusSchema,
} from './lead.schemas.js';
import * as controller from './lead.controller.js';

export const leadRouter = Router();

leadRouter.use(authenticate);

leadRouter.get('/', validate({ query: listLeadsQuerySchema }), controller.list);
leadRouter.post('/', validate({ body: createLeadSchema }), controller.create);
leadRouter.get('/:id', validate({ params: idParam }), controller.get);
leadRouter.patch('/:id', validate({ params: idParam, body: updateLeadSchema }), controller.update);
leadRouter.delete('/:id', requireRole('OWNER'), validate({ params: idParam }), controller.remove);

leadRouter.patch('/:id/status', validate({ params: idParam, body: updateStatusSchema }), controller.changeStatus);
leadRouter.patch('/:id/score', validate({ params: idParam, body: updateScoreSchema }), controller.updateScore);
leadRouter.get('/:id/events', validate({ params: idParam, query: listEventsQuerySchema }), controller.listEvents);
