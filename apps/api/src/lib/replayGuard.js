import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { ConflictError } from './errors.js';

/**
 * Rejects a signed webhook delivery that was already accepted. Signatures are
 * unique per (timestamp, body), and timestamps are only valid for 5 minutes,
 * so remembering each accepted signature for 10 minutes blocks replays
 * (e.g. a captured request re-sent to create duplicate leads).
 */
const TTL_SECONDS = 600;
let client = null;
const redis = () => (client ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 }));

export async function assertNotReplayed(scope, signature) {
  const key = `${env.QUEUE_PREFIX}:replay:${scope}:${createHash('sha256').update(String(signature)).digest('hex')}`;
  const fresh = await redis().set(key, '1', 'EX', TTL_SECONDS, 'NX');
  if (fresh !== 'OK') throw new ConflictError('This webhook delivery was already processed');
}

export async function closeReplayGuard() {
  if (client) await client.quit().catch(() => {});
  client = null;
}
