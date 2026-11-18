import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { pingRedis } from '../../queue/queues.js';

export const healthRouter = Router();

/** Liveness: the process is up. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness: dependencies are reachable. Used by deploy checks. */
healthRouter.get('/readyz', async (req, res) => {
  const checks = {};
  const [db, redis] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, pingRedis()]);
  checks.database = db.status === 'fulfilled' ? 'ok' : 'error';
  checks.redis = redis.status === 'fulfilled' ? 'ok' : 'error';
  const ready = checks.database === 'ok' && checks.redis === 'ok';
  if (!ready) req.log.error({ checks }, 'Readiness check failed');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
});
