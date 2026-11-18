import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import * as service from './appointment.service.js';

const STATUSES = ['PROPOSED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];
const iso = z.iso.datetime({ offset: true });

/** /api/appointments */
export const appointmentRouter = Router();
appointmentRouter.use(authenticate);
appointmentRouter.get(
  '/',
  validate({
    query: z.strictObject({
      from: iso.transform((s) => new Date(s)).optional(),
      to: iso.transform((s) => new Date(s)).optional(),
      status: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(STATUSES))).optional(),
    }),
  }),
  async (req, res) => res.json({ data: await service.list(req.auth, req.valid.query) }),
);
appointmentRouter.patch('/:id', validate({ params: idParam, body: z.strictObject({ startsAt: iso, durationMinutes: z.number().int().min(15).max(480).optional() }) }), async (req, res) =>
  res.json(await service.reschedule(req.auth, req.valid.params.id, req.valid.body)),
);
appointmentRouter.post('/:id/cancel', validate({ params: idParam, body: z.strictObject({ reason: z.string().trim().max(300).optional() }) }), async (req, res) =>
  res.json(await service.cancel(req.auth, req.valid.params.id, req.valid.body)),
);
appointmentRouter.post('/:id/outcome', validate({ params: idParam, body: z.strictObject({ status: z.enum(['COMPLETED', 'NO_SHOW']) }) }), async (req, res) =>
  res.json(await service.setOutcome(req.auth, req.valid.params.id, req.valid.body.status)),
);

/** /api/leads/:id/appointments */
export const leadAppointmentRouter = Router({ mergeParams: true });
leadAppointmentRouter.use(authenticate);
leadAppointmentRouter.get(
  '/slots',
  validate({ params: idParam, query: z.strictObject({ durationMinutes: z.coerce.number().int().min(15).max(480).default(60), daysAhead: z.coerce.number().int().min(1).max(21).default(10) }) }),
  async (req, res) => res.json(await service.findSlots(req.auth, req.valid.params.id, req.valid.query)),
);
leadAppointmentRouter.post(
  '/',
  validate({
    params: idParam,
    body: z.strictObject({
      startsAt: iso,
      durationMinutes: z.number().int().min(15).max(480),
      title: z.string().trim().min(3).max(120),
      location: z.string().trim().max(200).optional(),
      notes: z.string().trim().max(1000).optional(),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    // Booked by a person: confirmed immediately (no approval needed).
    const { appointment } = await service.book(req.auth, {
      leadId: req.valid.params.id,
      start: b.startsAt,
      durationMinutes: b.durationMinutes,
      title: b.title,
      location: b.location ?? null,
      notes: b.notes ?? null,
      confirm: true,
      actor: { type: 'USER', userId: req.auth.userId },
    });
    res.status(201).json(appointment);
  },
);
