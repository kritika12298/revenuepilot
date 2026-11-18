import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider.jsx';
import { ToastProvider } from '../components/ui/Toast.jsx';

export const ME = (role = 'OWNER') => ({
  user: { id: 'u1', name: 'Maria Lopez', email: 'maria@example.com' },
  activeBusinessId: 'b1',
  role,
  businesses: [{ id: 'b1', name: 'Evergreen', slug: 'evergreen', timezone: 'UTC', role }],
});

const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Installs a fetch mock routed by "METHOD /path" (query string ignored).
 * Handlers receive { url, body } and return [status, body] or a body (200).
 */
export function mockApi(routes) {
  const calls = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const key = `${method} ${url.pathname}`;
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => new RegExp(`^${k.replace(/:[^/]+/g, '[^/]+')}$`).test(key))?.[1];
    if (!handler) return json(404, { error: { code: 'NOT_FOUND', message: `No mock for ${key}` } });
    const out = typeof handler === 'function' ? await handler({ url, body }) : handler;
    return Array.isArray(out) ? json(out[0], out[1]) : json(200, out);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

export function renderApp(ui, { route = '/', path = '*', role = 'OWNER', routes = {} } = {}) {
  localStorage.setItem('rp.token', 'test-token');
  const calls = mockApi({ 'GET /api/auth/me': ME(role), ...routes });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path={path} element={ui} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, calls };
}
