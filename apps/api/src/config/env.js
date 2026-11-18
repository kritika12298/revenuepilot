import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load apps/api/.env regardless of the working directory (npm workspaces,
// PM2 and tests all start from different places). Real environment variables
// always take precedence over the file.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const flag = (fallback) =>
  z
    .enum(['0', '1', 'true', 'false'])
    .default(fallback)
    .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Interface to listen on. Production defaults to loopback: only Nginx reaches the API. */
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: flag('0'),

  // --- AI ---------------------------------------------------------------
  /** auto: live when an Anthropic credential env var is set, otherwise mock. */
  AI_MODE: z.enum(['auto', 'live', 'mock']).default('auto'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  /** Leave empty for models that do not support the effort parameter. */
  AI_EFFORT: z
    .union([z.enum(['low', 'medium', 'high', 'xhigh', 'max']), z.literal('')])
    .default('medium')
    .transform((v) => v || null),
  AI_MAX_TOKENS: z.coerce.number().int().min(1024).max(64000).default(16000),
  /** SDK-level retries (429, 5xx, connection errors) with exponential backoff. */
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
  /** Upper bound on model round-trips in one agent run. */
  AI_MAX_ITERATIONS: z.coerce.number().int().min(2).max(30).default(12),
  /** Server-side refusal fallback for models that support it. */
  AI_REFUSAL_FALLBACK: flag('1'),

  // --- Queues and email -------------------------------------------------
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().regex(/^[a-z0-9-]+$/).default('rp'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  FOLLOW_UP_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(600_000),
  EMAIL_PROVIDER: z.enum(['mock', 'resend']).default('mock'),
  RESEND_API_KEY: z.string().optional(),
  /** Verified sender address; the business name is used as display name. */
  EMAIL_FROM_ADDRESS: z.email().default('notifications@example.com'),
  /** Reply-To template with a {token} placeholder, e.g. replies+{token}@in.yourdomain.com */
  INBOUND_REPLY_ADDRESS: z.string().regex(/\{token\}/, 'must contain {token}').optional(),
  INBOUND_WEBHOOK_SECRET: z.string().min(24).optional(),
  /** Public URL of this API, used in unsubscribe links. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  /** Bearer token for /ops endpoints; ops endpoints are disabled when unset. */
  OPS_TOKEN: z.string().min(24).optional(),
  /** Demo features (bundled demo website, demo labels). Off in production unless set. */
  DEMO_MODE: flag(process.env.NODE_ENV === 'production' ? '0' : '1'),
  /** 32-byte key (base64) for encrypting integration secrets. */
  INTEGRATIONS_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  /** Where the dashboard is served (OAuth redirects back here). */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.EMAIL_PROVIDER === 'resend') {
    if (!v.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required when EMAIL_PROVIDER=resend' });
    if (v.EMAIL_FROM_ADDRESS.endsWith('@example.com')) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM_ADDRESS'], message: 'set a verified sender address for Resend' });
    }
  }
});

function loadEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // The logger depends on env, so write directly to stderr.
    process.stderr.write(`Invalid environment configuration:\n${problems}\n`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('replace-me')) {
    process.stderr.write('JWT_SECRET still has the placeholder value from .env.example\n');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && !env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.stderr.write('INTEGRATIONS_ENCRYPTION_KEY is required in production (32 random bytes, base64)\n');
    process.exit(1);
  }
  const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const aiMode = env.AI_MODE === 'auto' ? (hasCredential && env.NODE_ENV !== 'test' ? 'live' : 'mock') : env.AI_MODE;
  return Object.freeze({ ...env, AI_MODE_RESOLVED: aiMode });
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
