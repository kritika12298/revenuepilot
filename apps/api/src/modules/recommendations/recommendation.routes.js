import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParam } from '../../lib/validators.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { refreshRecommendations } from './engine.js';

const PRIORITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** /api/recommendations */
export const recommendationRouter = Router();
recommendationRouter.use(authenticate);
recommendationRouter.get('/', validate({ query: z.strictObject({ status: z.enum(['OPEN', 'DONE', 'DISMISSED']).default('OPEN') }) }), async (req, res) => {
  const rows = await prisma.recommendation.findMany({
    where: { businessId: req.auth.businessId, status: req.valid.query.status },
    include: { lead: { select: { id: true, name: true, status: true, score: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  rows.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  res.json({ data: rows });
});
recommendationRouter.post('/refresh', async (req, res) => res.json(await refreshRecommendations(req.auth.businessId)));
for (const [action, status] of [['dismiss', 'DISMISSED'], ['done', 'DONE']]) {
  recommendationRouter.post(`/:id/${action}`, validate({ params: idParam }), async (req, res) => {
    const { count } = await prisma.recommendation.updateMany({ where: { id: req.valid.params.id, businessId: req.auth.businessId }, data: { status, resolvedAt: new Date() } });
    if (!count) throw new NotFoundError('Recommendation');
    res.status(204).end();
  });
}
