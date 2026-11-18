import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const QUEUES = Object.freeze({ FOLLOW_UPS: 'follow-ups', EMAIL: 'email' });
export const JOBS = Object.freeze({ DRAFT_FOLLOW_UP: 'draft-follow-up', SEND_MESSAGE: 'send-message', SWEEP: 'sweep', INSIGHTS: 'refresh-insights' });

const DAY = 24 * 3600;
const REDIS_TIMEOUT_MS = 3000;

/** API requests must never hang on Redis: fail fast and let the sweeper catch up. */
function withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis timeout: ${what}`)), REDIS_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Retry policy per job type. Exponential backoff: delay * 2^(attempt-1). */
export const JOB_OPTIONS = Object.freeze({
  [JOBS.DRAFT_FOLLOW_UP]: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
  [JOBS.SEND_MESSAGE]: { attempts: 6, backoff: { type: 'exponential', delay: 30_000 } },
  [JOBS.SWEEP]: { attempts: 1 },
  [JOBS.INSIGHTS]: { attempts: 1 },
});

const retention = { removeOnComplete: { age: 7 * DAY, count: 5000 }, removeOnFail: { age: 30 * DAY } };

/**
 * Redis connection. Producers (the API) fail fast when Redis is down instead
 * of hanging a request; workers block and reconnect (BullMQ requirement).
 */
/** Logs connection errors at most once per 30s so an outage doesn't flood logs. */
let lastRedisWarning = 0;
function warnRedis(err) {
  if (Date.now() - lastRedisWarning < 30_000) return;
  lastRedisWarning = Date.now();
  logger.warn({ err: { message: err.message, code: err.code } }, 'Redis unavailable');
}

export function createRedis({ worker = false } = {}) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    lazyConnect: false,
  });
  redis.on('error', warnRedis);
  return redis;
}

let queues = null;

export function getQueues() {
  if (!queues) {
    const connection = createRedis();
    const opts = { connection, prefix: env.QUEUE_PREFIX, defaultJobOptions: retention };
    queues = {
      connection,
      [QUEUES.FOLLOW_UPS]: new Queue(QUEUES.FOLLOW_UPS, opts),
      [QUEUES.EMAIL]: new Queue(QUEUES.EMAIL, opts),
    };
    queues[QUEUES.FOLLOW_UPS].on('error', warnRedis);
    queues[QUEUES.EMAIL].on('error', warnRedis);
  }
  return queues;
}

export async function closeQueues() {
  if (!queues) return;
  const q = queues;
  queues = null;
  await Promise.allSettled([q[QUEUES.FOLLOW_UPS].close(), q[QUEUES.EMAIL].close()]);
  q.connection.disconnect();
}

// ---------------------------------------------------------------------------
// Deterministic job ids: adding the same job twice is a no-op in BullMQ.
// (BullMQ forbids ':' in custom ids.)
// ---------------------------------------------------------------------------

export const draftJobId = (followUpId) => `draft-${followUpId}`;
export const sendJobId = (messageId, scheduledFor) =>
  `send-${messageId}-${scheduledFor ? new Date(scheduledFor).getTime() : 'now'}`;

export async function enqueueDraft(followUpId) {
  const jobId = draftJobId(followUpId);
  await withTimeout(
    getQueues()[QUEUES.FOLLOW_UPS].add(JOBS.DRAFT_FOLLOW_UP, { followUpId }, { jobId, ...JOB_OPTIONS[JOBS.DRAFT_FOLLOW_UP] }),
    'enqueue draft',
  );
  return jobId;
}

/**
 * Enqueues delivery of an approved message. For follow-ups the job carries the
 * scheduled time; if the follow-up is rescheduled the old job becomes stale
 * and is ignored by the worker.
 */
export async function enqueueSend({ messageId, followUpId = null, scheduledFor = null }) {
  const jobId = sendJobId(messageId, scheduledFor);
  const delay = scheduledFor ? Math.max(0, new Date(scheduledFor).getTime() - Date.now()) : 0;
  await withTimeout(
    getQueues()[QUEUES.EMAIL].add(
      JOBS.SEND_MESSAGE,
      { messageId, followUpId, scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null },
      { jobId, delay, ...JOB_OPTIONS[JOBS.SEND_MESSAGE] },
    ),
    'enqueue send',
  );
  return jobId;
}

/** Best-effort removal of a waiting/delayed job; the worker re-checks state anyway. */
export async function removeJob(queueName, jobId) {
  if (!jobId) return;
  try {
    const job = await withTimeout(getQueues()[queueName].getJob(jobId), 'get job');
    if (job && !(await job.isActive())) await withTimeout(job.remove(), 'remove job');
  } catch (err) {
    logger.warn({ err: { message: err.message }, jobId }, 'Could not remove queued job');
  }
}

export async function pingRedis() {
  return withTimeout(
    (async () => {
      const q = getQueues();
      await q[QUEUES.EMAIL].waitUntilReady();
      return q.connection.ping();
    })(),
    'ping',
  );
}
