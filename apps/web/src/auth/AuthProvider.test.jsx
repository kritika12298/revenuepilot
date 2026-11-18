import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthProvider.jsx';
import { getToken } from '../lib/api.js';
import { ME, mockApi } from '../test/render.jsx';

afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const { session, sessionError, retrySession } = useAuth();
  if (sessionError) return <button onClick={retrySession}>retry</button>;
  return <p>{session ? `hello ${session.user.name}` : 'loading'}</p>;
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );

describe('session handling', () => {
  it('keeps the session on network or server errors and recovers on retry', async () => {
    localStorage.setItem('rp.token', 't1');
    let fail = true;
    mockApi({ 'GET /api/auth/me': () => (fail ? [503, { error: { code: 'UNAVAILABLE', message: 'down' } }] : ME()) });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'retry' }));
    expect(getToken()).toBe('t1'); // not logged out
    fail = false;
    await userEvent.click(await screen.findByRole('button', { name: 'retry' })).catch(() => {});
    await waitFor(() => expect(screen.getByText('hello Maria Lopez')).toBeInTheDocument());
  });

  it('signs out on 401', async () => {
    localStorage.setItem('rp.token', 'expired');
    mockApi({ 'GET /api/auth/me': [401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }] });
    mount();
    await waitFor(() => expect(getToken()).toBeNull());
  });
});
