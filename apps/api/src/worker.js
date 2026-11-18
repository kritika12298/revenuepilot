import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './lib/prisma.js';
import { closeQueues, pingRedis } from './queue/queues.js';
import { startWorkers } from './jobs/workers.js';

/** Background worker process (run separately from the API, e.g. PM2 "worker"). */
async function main() {
  try {
    await prisma.$connect();
    await pingRedis();
  } catch (err) {
    logger.fatal({ err: { message: err.message } }, 'Worker cannot reach PostgreSQL or Redis');
    process.exit(1);
  }
  logger.info({ emailProvider: env.EMAIL_PROVIDER, aiMode: env.AI_MODE_RESOLVED }, 'Starting RevenuePilot worker');
  const running = await startWorkers();

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Worker shutting down (finishing active jobs)');
    setTimeout(() => process.exit(1), 30_000).unref();
    await running.close();
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  process.exit(1);
});

main();
