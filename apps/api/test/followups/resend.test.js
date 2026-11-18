import { describe, expect, it } from 'vitest';
import { createResendProvider } from '../../src/email/providers/resend.js';
import { createMockEmailProvider } from '../../src/email/providers/mock.js';

const email = {
  from: 'Evergreen <hello@example.org>',
  to: 'lead@example.com',
  replyTo: 'replies+abc@in.example.org',
  subject: 'Hi',
  text: 'Body',
  headers: { 'List-Unsubscribe': '<https://x/u/1>' },
  tags: [{ name: 'business', value: 'b1' }],
  idempotencyKey: 'msg-123',
};

function fakeFetch(status, body) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}

describe('Resend adapter', () => {
  it('sends with auth, idempotency key and mapped fields', async () => {
    const f = fakeFetch(200, { id: 're_1' });
    const result = await createResendProvider({ apiKey: 're_test', fetch: f.fetch }).send(email);
    expect(result).toEqual({ id: 're_1', deduplicated: false });
    const { url, init, body } = f.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_test', 'Idempotency-Key': 'msg-123' });
    expect(body).toEqual({
      from: email.from,
      to: ['lead@example.com'],
      subject: 'Hi',
      text: 'Body',
      reply_to: email.replyTo,
      headers: email.headers,
      tags: email.tags,
    });
  });

  it.each([
    [429, 'rate_limit_exceeded', true],
    [500, 'application_error', true],
    [503, 'service_unavailable', true],
    [409, 'concurrent_idempotent_requests', true],
    [409, 'invalid_idempotent_request', false],
    [422, 'missing_required_field', false],
    [403, 'validation_error', false],
    [401, 'missing_api_key', false],
  ])('classifies %i %s (retryable=%s)', async (status, name, retryable) => {
    const f = fakeFetch(status, { statusCode: status, name, message: 'nope' });
    const err = await createResendProvider({ apiKey: 'k', fetch: f.fetch }).send(email).catch((e) => e);
    expect(err).toMatchObject({ name: 'EmailError', code: name.toUpperCase(), retryable, status });
  });

  it('treats network failures as retryable', async () => {
    const fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await createResendProvider({ apiKey: 'k', fetch }).send(email).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNREACHABLE', retryable: true });
  });
});

describe('mock email provider', () => {
  it('deduplicates by idempotency key like a real provider', async () => {
    const mock = createMockEmailProvider();
    const a = await mock.send(email);
    const b = await mock.send(email);
    expect(b).toEqual({ id: a.id, deduplicated: true });
    expect(mock.outbox).toHaveLength(1);
  });
});
