import { EmailError } from '../errors.js';

/**
 * Resend adapter (https://resend.com/docs/api-reference/emails/send-email).
 * Uses the REST API directly; the Idempotency-Key header makes Resend return
 * the original result for a repeated key within 24 hours.
 */
export function createResendProvider({ apiKey, fetch = globalThis.fetch, baseUrl = 'https://api.resend.com', timeoutMs = 15_000 }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is required for the Resend provider');

  return {
    name: 'resend',
    async send(email) {
      let res;
      try {
        res = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': email.idempotencyKey,
          },
          body: JSON.stringify({
            from: email.from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            ...(email.replyTo && { reply_to: email.replyTo }),
            ...(email.headers && { headers: email.headers }),
            ...(email.tags && { tags: email.tags }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EmailError('PROVIDER_UNREACHABLE', `Resend request failed: ${err.message}`, { retryable: true });
      }

      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) return { id: body.id, deduplicated: false };

      const name = body.name ?? 'unknown_error';
      const message = `Resend ${res.status} ${name}: ${body.message ?? res.statusText}`;
      // 429 (rate/quota), 5xx and an in-flight request with the same key are
      // transient; everything else (validation, auth, unverified domain, a
      // reused key with a different body) will not succeed on retry.
      const retryable = res.status === 429 || res.status >= 500 || name === 'concurrent_idempotent_requests';
      throw new EmailError(name.toUpperCase(), message, { retryable, status: res.status });
    },
  };
}
