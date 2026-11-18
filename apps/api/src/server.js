import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { closeQueues } from './queue/queues.js';
import { closeEventBus } from './modules/events/eventBus.js';
import { closeRateLimitStore } from './middleware/rateLimit.js';
import { closeReplayGuard } from './lib/replayGuard.js';

const app = createApp();

async function start() {
  try {
    await prisma.$connect();
  } catch (err) {
    logger.fatal({ err }, 'Could not connect to PostgreSQL. Is it running and is DATABASE_URL correct?');
    process.exit(1);
  }

  const host = env.HOST ?? (env.NODE_ENV === 'production' ? '127.0.0.1' : undefined);
  const server = app.listen(env.PORT, host, () => {
    logger.info({ port: env.PORT, host: host ?? 'all interfaces', env: env.NODE_ENV }, 'RevenuePilot API listening');
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => {
      await closeQueues();
      await closeEventBus();
      await closeRateLimitStore();
      await closeReplayGuard();
      await prisma.$disconnect();
      clearTimeout(force);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

start();
