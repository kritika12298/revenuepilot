import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from './config/env.js';
import { AppError, NotFoundError, UnauthorizedError } from './lib/errors.js';
import { getQueues, QUEUES } from './queue/queues.js';

/**
 * Operator endpoints for failed-job monitoring. Cross-tenant by nature, so
 * they are not reachable with a user token: they need OPS_TOKEN and are
 * disabled when it is unset. Job payloads only carry ids, never PII.
 */
export const opsRouter = Router();

opsRouter.use((req, _res, next) => {
  if (!env.OPS_TOKEN) throw new AppError(404, 'ROUTE_NOT_FOUND', 'Ops endpoints are disabled');
  const given = Buffer.from(req.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(env.OPS_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedError();
  next();
});

const summarise = (job) => ({
  id: job.id,
  name: job.name,
  data: job.data,
  attemptsMade: job.attemptsMade,
  failedReason: job.failedReason,
  timestamp: new Date(job.timestamp).toISOString(),
  finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
});

opsRouter.get('/queues', async (_req, res) => {
  const queues = getQueues();
  const out = {};
  for (const name of Object.values(QUEUES)) {
    const queue = queues[name];
    out[name] = {
      counts: await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed', 'paused'),
      recentFailures: (await queue.getFailed(0, 19)).map(summarise),
    };
  }
  res.json({ queues: out });
});

opsRouter.post('/queues/:queue/jobs/:jobId/retry', async (req, res) => {
  const queue = getQueues()[req.params.queue];
  if (!queue) throw new NotFoundError('Queue');
  const job = await queue.getJob(req.params.jobId);
  if (!job || !(await job.isFailed())) throw new NotFoundError('Failed job');
  await job.retry('failed');
  res.json({ retried: true, job: summarise(job) });
});
