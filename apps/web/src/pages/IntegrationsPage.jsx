import { Code2, FlaskConical, Inbox, AlertTriangle, CheckCircle2, CircleDashed, Copy, ExternalLink, KeyRound, Plug, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useConnectGoDaddy, useConnectWebsite, useDisconnectIntegration, useIntegrations, useRotateWebhook, useTestIntegration } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Field, Input } from '../components/ui/Field.jsx';
import { PageHeader, RelativeTime } from '../components/ui/Misc.jsx';
import { ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';

const STATUS = {
  CONNECTED: { tone: 'good', icon: CheckCircle2, label: 'Connected' },
  ERROR: { tone: 'critical', icon: AlertTriangle, label: 'Error' },
  NOT_CONFIGURED: { tone: 'neutral', icon: CircleDashed, label: 'Not connected' },
  DISABLED: { tone: 'neutral', icon: CircleDashed, label: 'Not available' },
  MOCK: { tone: 'warning', icon: FlaskConical, label: 'Mock mode' },
  AVAILABLE: { tone: 'neutral', icon: Code2, label: 'Embed available' },
  RECEIVING: { tone: 'good', icon: Inbox, label: 'Receiving enquiries' },
};

const LAST_LABEL = { godaddy_websites: 'Last form enquiry', website_webhook: 'Last webhook lead' };

function CopyBox({ value, label }) {
  const toast = useToast();
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-2 p-2">
      <code className="min-w-0 flex-1 text-xs break-all text-ink-2">{value}</code>
      <button type="button" className="rounded p-1 text-muted hover:text-ink" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'))}>
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function GoDaddyConnect() {
  const toast = useToast();
  const connect = useConnectGoDaddy();
  const [token, setToken] = useState('');
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); connect.mutate(token, { onSuccess: (r) => { setToken(''); toast.success('GoDaddy connected', `${r.domains.length} domains found`); }, onError: (err) => toast.error('Could not connect', err.message) }); }}>
      <Field label="Personal Access Token" className="min-w-56 flex-1">{(p) => <Input {...p} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
      <Button type="submit" icon={KeyRound} loading={connect.isPending} disabled={token.length < 10}>Connect</Button>
    </form>
  );
}

function IntegrationCard({ item }) {
  const { isOwner } = useAuth();
  const toast = useToast();
  const testIt = useTestIntegration();
  const disconnect = useDisconnectIntegration();
  const rotate = useRotateWebhook();
  const analyse = useConnectWebsite();
  const [secret, setSecret] = useState(null);
  const s = STATUS[item.status] ?? STATUS.NOT_CONFIGURED;
  const origin = window.location.origin;

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Plug className="h-4 w-4 text-accent" aria-hidden />{item.name}</h2>
          <p className="mt-1 text-sm text-muted">{item.description}</p>
        </div>
        <Badge tone={s.tone} icon={s.icon}>{s.label}</Badge>
      </div>
      <div className="flex-1 space-y-3 px-5 py-4 text-sm">
        {item.note && <p className="rounded-lg bg-surface-2 px-3 py-2 text-ink-2">{item.note}</p>}
        {item.lastError && <p className="rounded-lg bg-critical-soft px-3 py-2 text-critical">{item.lastError}</p>}
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
          <dt className="text-muted">{LAST_LABEL[item.provider] ?? 'Last success'}</dt>
          <dd className="text-ink">{item.lastSyncAt ? <RelativeTime date={item.lastSyncAt} /> : 'Never'}</dd>
          {item.mode && <><dt className="text-muted">Mode</dt><dd className="text-ink">{item.mode}</dd></>}
        </dl>
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">What this needs</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-ink-2">{item.requirements.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>

        {item.provider === 'godaddy_domains' && item.config.domains?.length > 0 && (
          <ul className="space-y-1.5">
            {item.config.domains.map((d) => (
              <li key={d.domain} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                <span className="text-ink">{d.domain}<span className="ml-2 text-xs text-muted">expires {new Date(d.expires).toLocaleDateString()}</span></span>
                {isOwner && <Button size="sm" variant="ghost" loading={analyse.isPending} onClick={() => analyse.mutate(`https://${d.domain}/`, { onSuccess: () => toast.success('Website analysis started', 'See the Knowledge page.'), onError: (e) => toast.error('Could not analyse', e.message) })}>Analyse website</Button>}
              </li>
            ))}
          </ul>
        )}
        {item.provider === 'godaddy_domains' && isOwner && item.status !== 'CONNECTED' && <GoDaddyConnect />}

        {item.provider === 'godaddy_websites' && (
          <div className="space-y-2">
            <p className="text-xs text-muted">Hosted enquiry form</p>
            <a href={item.config.formUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{origin}{item.config.formUrl}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
            <p className="text-xs text-muted">Embed code for a GoDaddy &ldquo;HTML&rdquo; section</p>
            <CopyBox value={item.config.embed.replace('{ORIGIN}', origin)} label="embed code" />
          </div>
        )}
        {item.provider === 'website_webhook' && (
          <div className="space-y-2">
            <p className="text-xs text-muted">Endpoint</p>
            <CopyBox value={item.config.endpoint} label="endpoint" />
            <p className="text-xs text-muted">JSON fields: {item.config.fields.join(', ')}</p>
            {secret && (
              <>
                <p className="text-xs font-medium text-warning">Signing secret (shown once; store it now)</p>
                <CopyBox value={secret} label="signing secret" />
              </>
            )}
          </div>
        )}
      </div>
      {isOwner && item.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
          {item.actions.includes('test') && (item.status === 'CONNECTED' || item.status === 'ERROR' || item.mode === 'live') && (
            <Button size="sm" icon={RefreshCw} loading={testIt.isPending} onClick={() => testIt.mutate(item.provider, { onSuccess: (r) => (r.ok ? toast.success('Test passed', r.detail) : toast.error('Test failed', r.detail)), onError: (e) => toast.error('Test failed', e.message) })}>Test connection</Button>
          )}
          {item.actions.includes('oauth') && item.status !== 'CONNECTED' && (
            <Button size="sm" variant="primary" onClick={async () => { try { const { url } = await api('/integrations/google_calendar/connect'); window.location.assign(url); } catch (e) { toast.error('Could not start Google sign-in', e.message); } }}>Connect with Google</Button>
          )}
          {item.actions.includes('rotate_secret') && (
            <Button size="sm" icon={KeyRound} loading={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: (r) => setSecret(r.secret) })}>{item.status === 'CONNECTED' ? 'Rotate secret' : 'Create signing secret'}</Button>
          )}
          {item.actions.includes('disconnect') && item.status !== 'NOT_CONFIGURED' && item.status !== 'DISABLED' && (
            <Button size="sm" variant="ghost" icon={Unplug} loading={disconnect.isPending} onClick={() => disconnect.mutate(item.provider, { onSuccess: () => { setSecret(null); toast.success('Disconnected'); } })}>Disconnect</Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function IntegrationsPage() {
  const query = useIntegrations();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const g = params.get('google');
    if (!g) return;
    if (g === 'connected') toast.success('Google Calendar connected');
    else toast.error('Google Calendar was not connected', g === 'denied' ? 'Access was declined.' : 'Sign-in failed; try again.');
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  return (
    <>
      <PageHeader title="Integration hub" description="Connect GoDaddy, Claude, your calendar, email and website. Statuses reflect real configuration and recent results." />
      {query.isPending ? (
        <Card><LoadingRows rows={6} /></Card>
      ) : query.isError ? (
        <Card><ErrorState error={query.error} onRetry={() => query.refetch()} /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
          {query.data.data.map((item) => <IntegrationCard key={item.provider} item={item} />)}
        </div>
      )}
    </>
  );
}
