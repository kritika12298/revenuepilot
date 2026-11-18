import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam, pagination } from '../../lib/validators.js';
import { NotFoundError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import * as repo from './notification.repository.js';
import { prisma } from '../../lib/prisma.js';

const listQuery = z.strictObject({
  ...pagination,
  unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const { page, pageSize, unread } = req.valid.query;
  const { rows, total } = await repo.list(req.auth.businessId, { unreadOnly: unread, ...toSkipTake({ page, pageSize }) });
  res.json(paginated(rows, total, { page, pageSize }));
});

notificationRouter.post('/:id/read', validate({ params: idParam }), async (req, res) => {
  if (!(await repo.markRead(req.auth.businessId, req.valid.params.id))) throw new NotFoundError('Notification');
  res.status(204).end();
});

notificationRouter.get('/unread-count', async (req, res) => {
  res.json({ count: await prisma.notification.count({ where: { businessId: req.auth.businessId, readAt: null } }) });
});
notificationRouter.post('/read-all', async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { businessId: req.auth.businessId, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: count });
});
