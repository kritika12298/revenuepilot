import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { EmailError } from '../errors.js';

/**
 * Development/test provider. Keeps an in-memory outbox and, like Resend,
 * returns the original result when an idempotency key is reused.
 */
export function createMockEmailProvider() {
  const outbox = [];
  const byKey = new Map();
  const failures = [];

  return {
    name: 'mock',
    outbox,
    /** Test helper: make the next n sends fail. */
    failNext(n = 1, { retryable = true, code = 'MOCK_FAILURE' } = {}) {
      for (let i = 0; i < n; i += 1) failures.push({ retryable, code });
    },
    async send(email) {
      if (byKey.has(email.idempotencyKey)) return { id: byKey.get(email.idempotencyKey), deduplicated: true };
      const failure = failures.shift();
      if (failure) throw new EmailError(failure.code, 'Simulated provider failure', { retryable: failure.retryable });
      const id = `mock_${randomUUID()}`;
      byKey.set(email.idempotencyKey, id);
      outbox.push({ id, ...email, sentAt: new Date() });
      logger.info({ providerMessageId: id, subject: email.subject }, 'Mock email "sent"');
      return { id, deduplicated: false };
    },
  };
}
