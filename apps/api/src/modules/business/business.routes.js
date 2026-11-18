import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { serviceSchema, updateBusinessSchema } from './business.schemas.js';
import { idParam } from '../../lib/validators.js';
import * as controller from './business.controller.js';

export const businessRouter = Router();

businessRouter.use(authenticate);
businessRouter.get('/', controller.getCurrent);
businessRouter.patch('/', requireRole('OWNER'), validate({ body: updateBusinessSchema }), controller.updateCurrent);
businessRouter.get('/services', controller.listServices);
businessRouter.get('/members', async (req, res) => {
  const rows = await prisma.membership.findMany({
    where: { businessId: req.auth.businessId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, user: { select: { id: true, name: true, email: true } } },
  });
  res.json({ data: rows.map((m) => ({ ...m.user, role: m.role })) });
});
businessRouter.post('/services', requireRole('OWNER'), validate({ body: serviceSchema }), controller.createService);
businessRouter.put('/services/:id', requireRole('OWNER'), validate({ params: idParam, body: serviceSchema }), controller.updateService);
businessRouter.delete('/services/:id', requireRole('OWNER'), validate({ params: idParam }), controller.archiveService);
