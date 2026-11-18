import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, getToken } from './api.js';

/** Which cached queries each live event makes stale. */
const INVALIDATES = {
  'agent-run': ['agents', 'agentRuns', 'agentRun', 'lead', 'summary', 'website', 'knowledge', 'insights', 'integrations', 'revenue'],
  notification: ['notifications'],
  recommendations: ['recommendations'],
  'lead-event': ['activity', 'leadEvents', 'lead', 'leads', 'followUps', 'conversations', 'approvals', 'summary'],
};

/**
 * Subscribes to /api/events/stream (Server-Sent Events) with fetch so the
 * bearer token stays in a header. Reconnects with backoff. Returns whether the
 * stream is connected, for the "Live" indicator.
 */
export function useLiveEvents(onNotification) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let controller;
    let retry = 1000;
    let timer;

    async function connect() {
      controller = new AbortController();
      try {
        const res = await fetch('/api/events/stream', { headers: { Authorization: `Bearer ${getToken()}` }, signal: controller.signal });
        if (res.status === 401) {
          // Session revoked or expired: let the auth layer sign out instead of retrying forever.
          stopped = true;
          await api('/auth/me').catch(() => {});
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setConnected(true);
        retry = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const type = chunk.match(/^event: (.+)$/m)?.[1];
            const data = chunk.match(/^data: (.+)$/m)?.[1];
            if (!type || type === 'ready') continue;
            if (type === 'session-ended') {
              // The server ended the stream because access was revoked: re-check the session (a 401 signs out).
              await api('/auth/me').catch(() => {});
              continue;
            }
            for (const key of INVALIDATES[type] ?? []) qc.invalidateQueries({ queryKey: [key] });
            if (type === 'notification' && data) onNotification?.(JSON.parse(data));
          }
        }
      } catch {
        /* reconnect below */
      }
      setConnected(false);
      if (!stopped) {
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      }
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [qc, onNotification]);

  return connected;
}
