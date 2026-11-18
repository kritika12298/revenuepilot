import clsx from 'clsx';
import { BrainCircuit, CalendarClock, CalendarDays, CheckCircle2, CircleDashed, Clock, Globe, Loader2, MessageSquareText, Radar, ShieldCheck, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { Card, CardHeader } from './ui/Card.jsx';
import { InfoTip } from './ui/InfoTip.jsx';
import { RelativeTime } from './ui/Misc.jsx';
import { ErrorState, Skeleton } from './ui/States.jsx';
import { formatDateTime } from '../lib/format.js';

/** Five states, each with its own icon and label (never colour alone). */
export const AGENT_STATES = {
  running: { label: 'Running', icon: Loader2, spin: true, className: 'bg-accent-soft text-accent-ink' },
  scheduled: { label: 'Scheduled', icon: CalendarClock, className: 'bg-surface-2 text-ink-2 ring-1 ring-line-strong' },
  completed: { label: 'Completed', icon: CheckCircle2, className: 'bg-good-soft text-good' },
  failed: { label: 'Failed', icon: XCircle, className: 'bg-critical-soft text-critical' },
  idle: { label: 'Idle', icon: CircleDashed, className: 'bg-surface-2 text-muted' },
};

const AGENT_ICONS = {
  lead_intelligence: Radar,
  conversation: MessageSquareText,
  follow_up: Clock,
  sales_intelligence: BrainCircuit,
  meeting: CalendarDays,
  policy: ShieldCheck,
  website: Globe,
};

export function AgentStateBadge({ state }) {
  const s = AGENT_STATES[state] ?? AGENT_STATES.idle;
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>
      <s.icon className={clsx('h-3 w-3', s.spin && 'animate-spin')} aria-hidden />
      {s.label}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 text-xs">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function AgentCard({ agent, timeZone }) {
  const Icon = AGENT_ICONS[agent.key] ?? BrainCircuit;
  const run = agent.lastRun;
  return (
    <article
      className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
      aria-label={`${agent.name}: ${AGENT_STATES[agent.status]?.label ?? agent.status}`}
    >
      <header className="flex items-start gap-3">
        <span className="rounded-lg bg-accent-soft p-2 text-accent-ink">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{agent.name}</h3>
          <p className="mt-0.5 text-xs text-muted">{agent.description}</p>
        </div>
      </header>
      <div className="mt-3">
        <AgentStateBadge state={agent.status} />
      </div>
      <dl className="mt-3 space-y-1.5">
        <Row label={agent.status === 'running' ? 'Now' : 'Next'}>
          {agent.currentTask ? (
            <>
              {agent.currentTask}
              {agent.status !== 'running' && agent.nextRunAt && <span className="text-muted"> · {formatDateTime(agent.nextRunAt, timeZone)}</span>}
            </>
          ) : agent.key === 'sales_intelligence' && agent.nextRunAt ? (
            <span>Insights refresh after {formatDateTime(agent.nextRunAt, timeZone)} if there is new activity</span>
          ) : (
            <span className="text-muted">Nothing queued</span>
          )}
        </Row>
        <Row label="Last run">
          {agent.lastRunAt ? <RelativeTime date={agent.lastRunAt} timeZone={timeZone} /> : <span className="text-muted">Never</span>}
        </Row>
        <Row label="Decision">
          {run?.status === 'FAILED' ? (
            <span className="text-critical">{run.error}</span>
          ) : run?.decision ? (
            <span className="inline-flex items-start gap-1">
              <span className="line-clamp-2">{run.decision}</span>
              {run.rationale && (
                <InfoTip label="Why the agent decided this" className="shrink-0">
                  {run.rationale}
                </InfoTip>
              )}
            </span>
          ) : (
            <span className="text-muted">–</span>
          )}
        </Row>
      </dl>
      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
        <span className="tabular">
          {agent.stats.succeeded} succeeded
          <span className={agent.stats.failed > 0 ? 'text-critical' : undefined}> · {agent.stats.failed} failed</span>
          {agent.stats.queued > 0 && ` · ${agent.stats.queued} queued`}
        </span>
        {run?.lead && (
          <Link to={`/leads/${run.lead.id}`} className="font-medium text-accent hover:underline">
            View lead
          </Link>
        )}
      </footer>
    </article>
  );
}

export function AgentActivity({ query, timeZone }) {
  return (
    <Card>
      <CardHeader
        title="AI sales agents"
        description="What each agent is doing, from the live agent audit trail"
        actions={
          <InfoTip label="About agent states">
            <strong>Running</strong>: working now. <strong>Scheduled</strong>: has queued work. <strong>Completed</strong>: last run succeeded.{' '}
            <strong>Failed</strong>: last run failed (see the error). <strong>Idle</strong>: has not run yet. Run counts follow the date range.
          </InfoTip>
        }
      />
      {query.isPending ? (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading agents">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load agent activity" />
      ) : (
        <div className={clsx('grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3', query.isPlaceholderData && 'opacity-60')}>
          {query.data.data.map((agent) => (
            <AgentCard key={agent.key} agent={agent} timeZone={timeZone} />
          ))}
        </div>
      )}
    </Card>
  );
}
