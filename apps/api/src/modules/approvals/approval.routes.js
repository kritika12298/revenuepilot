import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam, pagination } from '../../lib/validators.js';
import * as service from './approval.service.js';

const listQuery = z.strictObject({
  ...pagination,
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(),
  type: z.enum(['OUTBOUND_MESSAGE', 'DISCOUNT', 'QUOTE', 'APPOINTMENT', 'OTHER']).optional(),
});
const approveBody = z.strictObject({
  subject: z.string().trim().min(3).max(150).optional(),
  body: z.string().trim().min(10).max(5000).optional(),
  note: z.string().trim().max(500).optional(),
});
const rejectBody = z.strictObject({ note: z.string().trim().max(500).optional() });

/** /api/approvals. Only owners can approve or reject (outbound and financial decisions). */
export const approvalRouter = Router();
approvalRouter.use(authenticate);
approvalRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json(await service.list(req.auth, req.valid.query));
});
approvalRouter.post('/:id/approve', requireRole('OWNER'), validate({ params: idParam, body: approveBody }), async (req, res) => {
  res.json(await service.approve(req.auth, req.valid.params.id, req.valid.body));
});
approvalRouter.post('/:id/reject', requireRole('OWNER'), validate({ params: idParam, body: rejectBody }), async (req, res) => {
  res.json(await service.reject(req.auth, req.valid.params.id, req.valid.body));
});
