import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam, pagination } from '../../lib/validators.js';
import * as service from './followUp.service.js';

const STATUSES = ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED', 'SENT', 'CANCELLED', 'SKIPPED', 'FAILED'];

const listQuery = z.strictObject({
  ...pagination,
  status: z
    .string()
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
    .pipe(z.array(z.enum(STATUSES)).min(1))
    .optional(),
  leadId: z.uuid().optional(),
});

const when = {
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
  delayHours: z.number().min(0.25).max(24 * 90).optional(),
  respectWorkingHours: z.boolean().default(true),
};
const exactlyOneTime = (v) => !(v.scheduledFor && v.delayHours);

const scheduleBody = z.strictObject(when).refine(exactlyOneTime, 'Use either scheduledFor or delayHours, not both');
const rescheduleBody = z
  .strictObject(when)
  .refine((v) => Boolean(v.scheduledFor) !== Boolean(v.delayHours), 'Provide exactly one of scheduledFor or delayHours');
const cancelBody = z.strictObject({ reason: z.string().trim().min(3).max(300).optional() });

/** /api/follow-ups */
export const followUpRouter = Router();
followUpRouter.use(authenticate);

followUpRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json(await service.list(req.auth, req.valid.query));
});
followUpRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json(await service.get(req.auth, req.valid.params.id));
});
followUpRouter.post('/:id/cancel', validate({ params: idParam, body: cancelBody }), async (req, res) => {
  res.json(await service.cancel(req.auth, req.valid.params.id, req.valid.body));
});
followUpRouter.post('/:id/reschedule', validate({ params: idParam, body: rescheduleBody }), async (req, res) => {
  res.json(await service.reschedule(req.auth, req.valid.params.id, req.valid.body));
});

/** /api/leads/:id/follow-ups */
export const leadFollowUpRouter = Router({ mergeParams: true });
leadFollowUpRouter.use(authenticate);
leadFollowUpRouter.post('/', validate({ params: idParam, body: scheduleBody }), async (req, res) => {
  const { followUp } = await service.scheduleNext(req.auth, req.valid.params.id, {
    mode: 'manual',
    ...req.valid.body,
    actor: { type: 'USER', userId: req.auth.userId },
  });
  res.status(201).location(`/api/follow-ups/${followUp.id}`).json(await service.get(req.auth, followUp.id));
});
