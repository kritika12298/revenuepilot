import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Live events for the dashboard (agent runs, notifications, recommendations,
 * messages). Published to Redis so the API and worker processes share one
 * stream; each API process fans out to its own SSE connections.
 * Payloads carry ids and short labels only, never message bodies or PII.
 */
const CHANNEL = `${env.QUEUE_PREFIX}:live-events`;
let publisher = null;
let subscriber = null;
const listeners = new Map(); // businessId -> Set<fn>

function pub() {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    publisher.on('error', () => {});
  }
  return publisher;
}

export function publishEvent(businessId, type, data = {}) {
  try {
    pub().publish(CHANNEL, JSON.stringify({ businessId, type, data, at: new Date().toISOString() })).catch(() => {});
  } catch {
    /* live updates are best effort */
  }
}

function ensureSubscriber() {
  if (subscriber) return;
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => logger.warn({ err: { message: err.message } }, 'Live events subscriber error'));
  subscriber.subscribe(CHANNEL).catch(() => {});
  subscriber.on('message', (_channel, raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    for (const fn of listeners.get(event.businessId) ?? []) fn(event);
  });
}

export function subscribe(businessId, fn) {
  ensureSubscriber();
  if (!listeners.has(businessId)) listeners.set(businessId, new Set());
  listeners.get(businessId).add(fn);
  return () => listeners.get(businessId)?.delete(fn);
}

export async function closeEventBus() {
  await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
  publisher = null;
  subscriber = null;
}
