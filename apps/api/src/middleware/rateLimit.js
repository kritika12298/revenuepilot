import { rateLimit } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';

let client = null;
function redis() {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: true });
    client.on('error', (err) => logger.warn({ err: { message: err.message } }, 'Rate-limit Redis error'));
  }
  return client;
}

/**
 * Rate limiter whose counters live in Redis, so limits hold across every API
 * process (PM2 cluster) instead of multiplying per process. If Redis is
 * unavailable the request is allowed (fail open) and Nginx limits still apply.
 * Each limiter needs a unique `name` (its Redis key prefix).
 */
export function createLimiter({ name, ...options }) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
    passOnStoreError: true,
    ...(!isTest && { store: new RedisStore({ prefix: `${env.QUEUE_PREFIX}:rl:${name}:`, sendCommand: (command, ...args) => redis().call(command, ...args) }) }),
    ...options,
  });
}

export async function closeRateLimitStore() {
  if (client) await client.quit().catch(() => {});
  client = null;
}

/** Brute-force protection for credential endpoints. */
export const authRateLimit = createLimiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  handler: (_req, res) =>
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' },
    }),
});

/** General ceiling for authenticated API traffic. */
export const apiRateLimit = createLimiter({
  name: 'api',
  windowMs: 60 * 1000,
  limit: 300,
  handler: (_req, res) =>
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
    }),
});

/** Signed webhooks: authenticated by HMAC, but still bounded per IP. */
export const webhookRateLimit = createLimiter({
  name: 'webhook',
  windowMs: 60 * 1000,
  limit: 60,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
});
