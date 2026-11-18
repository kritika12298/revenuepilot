import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildQuery, fieldErrors, onUnauthorized, setToken } from './api.js';
import { mockApi } from '../test/render.jsx';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('builds query strings without empty values', () => {
    expect(buildQuery({ q: 'ann', status: ['NEW', 'WON'], minScore: '', page: 2, x: undefined })).toBe('?q=ann&status=NEW%2CWON&page=2');
    expect(buildQuery({})).toBe('');
  });

  it('sends the bearer token and JSON body', async () => {
    setToken('abc');
    const calls = mockApi({ 'POST /api/leads': [201, { id: 'l1' }] });
    const out = await api('/leads', { method: 'POST', body: { name: 'A' } });
    expect(out).toEqual({ id: 'l1' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/leads', body: { name: 'A' } });
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer abc', 'Content-Type': 'application/json' });
  });

  it('turns error responses into ApiError with the server code, details and request id', async () => {
    mockApi({
      'POST /api/leads': [400, { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [{ path: 'email', message: 'Invalid email address' }], requestId: 'r1' } }],
    });
    const err = await api('/leads', { method: 'POST', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', requestId: 'r1' });
    expect(fieldErrors(err)).toEqual({ email: 'Invalid email address' });
  });

  it('signals expired sessions on 401', async () => {
    setToken('expired');
    const handler = vi.fn();
    onUnauthorized(handler);
    mockApi({ 'GET /api/leads': [401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }] });
    await expect(api('/leads')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports network failures clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/leads')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});
