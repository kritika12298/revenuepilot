import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

beforeEach(async () => {
  // Every tenant table cascades from businesses or users.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE businesses, users CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Each test starts with the default (mock) AI client.
import { setAIClient } from '../src/ai/client.js';
beforeEach(() => setAIClient(null));

// Fresh Redis database and email outbox for every test.
import { Redis } from 'ioredis';
import { closeQueues } from '../src/queue/queues.js';
import { closeEventBus } from '../src/modules/events/eventBus.js';
import { closeReplayGuard } from '../src/lib/replayGuard.js';
import { setEmailProvider } from '../src/email/index.js';

const redis = new Redis(process.env.REDIS_URL);
beforeEach(async () => {
  await redis.flushdb();
  setEmailProvider(null);
});
afterAll(async () => {
  await closeQueues();
  await closeEventBus();
  await closeReplayGuard();
  redis.disconnect();
});
