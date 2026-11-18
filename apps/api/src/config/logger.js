import pino from 'pino';
import { env, isTest } from './env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'revenuepilot-api' },
  // Never write credentials or lead PII to logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.email',
      '*.phone',
      '*.token',
    ],
    censor: '[redacted]',
  },
});
