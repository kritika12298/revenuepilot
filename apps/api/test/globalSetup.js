import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';

/**
 * Applies migrations to the test database before any suite runs.
 * Refuses to touch a database whose name does not contain "test", because
 * the suites truncate every table.
 */
async function checkRedis() {
  const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
  const db = Number(new URL(url).pathname.slice(1) || 0);
  if (!db) throw new Error(`TEST_REDIS_URL must select a non-zero Redis database (it is flushed between tests): ${url}`);
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Cannot reach Redis at ${url} (${err.message}). Start it: docker compose up -d redis, or brew services start redis.`);
  } finally {
    redis.disconnect();
  }
}

export default async function setup() {
  await checkRedis();
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://revenuepilot:revenuepilot@localhost:5432/revenuepilot_test?schema=public';
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run tests against "${dbName}": TEST_DATABASE_URL must name a *test* database.`);
  }
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    throw new Error(
      `Could not migrate the test database at ${url.replace(/\/\/.*@/, '//***@')}.\n` +
        'Is PostgreSQL running? See README "Running tests".\n\n' +
        output,
    );
  }
}
