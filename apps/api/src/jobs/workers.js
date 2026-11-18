import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createRedis, getQueues, JOBS, JOB_OPTIONS, QUEUES } from '../queue/queues.js';
import { processDraftFollowUp } from './draftFollowUp.js';
import { processSendMessage } from './sendMessage.js';
import { processSweep } from './sweep.js';
import { refreshStaleInsights } from '../modules/dashboard/agents.service.js';
import { processAnalyzeWebsite } from './analyzeWebsite.js';
import { JOB_ANALYZE_WEBSITE } from '../modules/knowledge/knowledge.service.js';
import { JOB_PROCESS_LEAD, processLead } from './processLead.js';
import { refreshAll as refreshRecommendations } from '../modules/recommendations/engine.js';
import { JOB_APPOINTMENT_REMINDER, processReminder } from '../modules/appointments/appointment.service.js';

const followUpProcessors = {
  [JOBS.DRAFT_FOLLOW_UP]: processDraftFollowUp,
  [JOBS.SWEEP]: processSweep,
  [JOBS.INSIGHTS]: () => refreshStaleInsights(),
  [JOB_ANALYZE_WEBSITE]: (job) => processAnalyzeWebsite(job),
  [JOB_PROCESS_LEAD]: processLead,
  'refresh-recommendations': () => refreshRecommendations(),
  [JOB_APPOINTMENT_REMINDER]: processReminder,
};

function monitor(worker) {
  worker.on('completed', (job, result) => {
    logger.info({ queue: worker.name, jobId: job.id, job: job.name, outcome: result?.outcome, reason: result?.reason }, 'Job completed');
  });
  // Failed-job monitoring: every failure is logged; final failures at error
  // level (alert on these) and they stay in the failed set for /ops/queues.
  worker.on('failed', (job, err) => {
    const final = !job || job.attemptsMade >= (job.opts?.attempts ?? 1) || err?.name === 'UnrecoverableError';
    logger[final ? 'error' : 'warn'](
      { queue: worker.name, jobId: job?.id, job: job?.name, attemptsMade: job?.attemptsMade, final, err: { message: err?.message } },
      final ? 'Job failed permanently' : 'Job failed; will retry',
    );
  });
  worker.on('stalled', (jobId) => logger.warn({ queue: worker.name, jobId }, 'Job stalled; it will be retried'));
  worker.on('error', (err) => logger.error({ queue: worker.name, err: { message: err.message } }, 'Worker error'));
  return worker;
}

/**
 * Starts the follow-up and email workers and registers the periodic sweep.
 * Returns a close() function for graceful shutdown.
 */
export async function startWorkers({ concurrency = env.WORKER_CONCURRENCY, sweepEvery = env.FOLLOW_UP_SWEEP_INTERVAL_MS, registerSweep = true } = {}) {
  const common = { prefix: env.QUEUE_PREFIX, concurrency };

  const followUps = monitor(
    new Worker(
      QUEUES.FOLLOW_UPS,
      (job) => {
        const processor = followUpProcessors[job.name];
        if (!processor) throw new Error(`Unknown job ${job.name}`);
        return processor(job);
      },
      { ...common, connection: createRedis({ worker: true }) },
    ),
  );
  const email = monitor(
    new Worker(QUEUES.EMAIL, (job) => processSendMessage(job), {
      ...common,
      connection: createRedis({ worker: true }),
      // Stay well under provider rate limits (Resend: requests per second).
      limiter: { max: 8, duration: 1000 },
    }),
  );

  if (registerSweep) {
    await getQueues()[QUEUES.FOLLOW_UPS].upsertJobScheduler(
      'follow-up-sweep',
      { every: sweepEvery },
      { name: JOBS.SWEEP, data: {}, opts: JOB_OPTIONS[JOBS.SWEEP] },
    );
    await getQueues()[QUEUES.FOLLOW_UPS].upsertJobScheduler('recommendations', { every: 15 * 60e3 }, { name: 'refresh-recommendations', data: {}, opts: { attempts: 1 } });
    // Hourly check; each business is refreshed at most once a day, and only
    // when it has new activity (see refreshStaleInsights).
    await getQueues()[QUEUES.FOLLOW_UPS].upsertJobScheduler(
      'insights-refresh',
      { every: 60 * 60e3 },
      { name: JOBS.INSIGHTS, data: {}, opts: JOB_OPTIONS[JOBS.INSIGHTS] },
    );
  }
  logger.info({ concurrency, sweepEvery }, 'Workers started');

  return {
    workers: { followUps, email },
    async close() {
      await Promise.allSettled([followUps.close(), email.close()]);
    },
  };
}
