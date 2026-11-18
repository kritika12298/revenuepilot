/**
 * Small fetch wrapper for the RevenuePilot API.
 * - Adds the bearer token and JSON handling.
 * - Turns error responses into ApiError with the server's code/message/details.
 * - Calls the registered unauthorized handler on 401 (session expired).
 */

const TOKEN_KEY = 'rp.token';
let unauthorizedHandler = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'HTTP_ERROR';
    this.details = body?.error?.details;
    this.requestId = body?.error?.requestId;
  }
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => (token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY));
export const onUnauthorized = (handler) => {
  unauthorizedHandler = handler;
};

export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export async function api(path, { method = 'GET', body, query, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${path}${buildQuery(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection.' } });
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new ApiError(res.status, data);
    if (res.status === 401 && token && unauthorizedHandler) unauthorizedHandler(error);
    throw error;
  }
  return data;
}

/** Field-level validation messages keyed by path, for forms. */
export function fieldErrors(error) {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};
  return Object.fromEntries(error.details.map((d) => [d.path, d.message]));
}
