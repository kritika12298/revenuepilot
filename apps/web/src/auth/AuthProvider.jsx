import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, onUnauthorized, setToken } from '../lib/api.js';

const AuthContext = createContext(null);

/**
 * Session state. The access token lives in localStorage so a reload keeps the
 * session; it is cleared on logout or on any 401.
 */
export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const [token, setTokenState] = useState(getToken);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [sessionError, setSessionError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const applySession = useCallback(
    (data) => {
      setToken(data.token);
      setTokenState(data.token);
      qc.clear();
      return data;
    },
    [qc],
  );

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setSession(null);
    qc.clear();
  }, [qc]);

  useEffect(() => onUnauthorized(() => logout()), [logout]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSessionError(null);
    api('/auth/me')
      .then((me) => !cancelled && setSession(me))
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        // Only an authentication failure ends the session; network or server
        // errors keep the token and offer a retry.
        if (err?.status === 401) logout();
        else setSessionError(err);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, logout, attempt]);

  const value = useMemo(
    () => ({
      token,
      session,
      loading,
      sessionError,
      retrySession: () => setAttempt((a) => a + 1),
      isOwner: session?.role === 'OWNER',
      business: session?.businesses.find((b) => b.id === session.activeBusinessId) ?? null,
      login: async (body) => applySession(await api('/auth/login', { method: 'POST', body })),
      register: async (body) => applySession(await api('/auth/register', { method: 'POST', body })),
      switchBusiness: async (businessId) => applySession(await api('/auth/switch-business', { method: 'POST', body: { businessId } })),
      logout,
    }),
    [token, session, loading, sessionError, applySession, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
