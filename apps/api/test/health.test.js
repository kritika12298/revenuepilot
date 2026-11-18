import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

describe('health and cross-cutting behaviour', () => {
  it('GET /healthz reports ok', async () => {
    const res = await api().get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz checks the database', async () => {
    const res = await api().get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('ok');
  });

  it('returns a request id and echoes a well-formed incoming one', async () => {
    const generated = await api().get('/healthz');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await api().get('/healthz').set('X-Request-Id', 'trace-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('trace-abc-12345');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await api().get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('sets security headers', async () => {
    const res = await api().get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request logging', () => {
  it('never logs OAuth codes, tokens, search text or unsubscribe tokens', async () => {
    const { safeUrl } = await import('../src/middleware/requestLogger.js');
    expect(safeUrl('/api/integrations/google/callback?code=4/abc&state=eyJ.x.y')).toBe('/api/integrations/google/callback?code=[redacted]&state=[redacted]');
    expect(safeUrl('/u/9f8e7d6c5b4a')).toBe('/u/[redacted]');
    expect(safeUrl('/api/leads?q=jordan&page=2')).toBe('/api/leads?q=[redacted]&page=2');
    expect(safeUrl('/api/leads?status=NEW')).toBe('/api/leads?status=NEW');
  });
});
