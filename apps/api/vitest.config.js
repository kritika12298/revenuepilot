import 'dotenv/config';
import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://revenuepilot:revenuepilot@localhost:5432/revenuepilot_test?schema=public';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.js'],
    setupFiles: ['./test/setup.js'],
    // Suites share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters-long',
      BCRYPT_ROUNDS: '4',
      LOG_LEVEL: 'silent',
      AI_MODE: 'mock',
      REDIS_URL: TEST_REDIS_URL,
      TEST_REDIS_URL,
      QUEUE_PREFIX: 'rp-test',
      EMAIL_PROVIDER: 'mock',
      EMAIL_FROM_ADDRESS: 'hello@revenuepilot.test',
      INBOUND_REPLY_ADDRESS: 'replies+{token}@in.revenuepilot.test',
      INBOUND_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
      OPS_TOKEN: 'test-ops-token-0123456789abcdef',
      PUBLIC_BASE_URL: 'https://api.revenuepilot.test',
    },
  },
});
