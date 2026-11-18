import { Check, Lightbulb, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router';
import { useRecommendations, useRefreshRecommendations, useResolveRecommendation } from '../api/hooks.js';
import { formatMoney } from '../lib/format.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { RelativeTime } from './ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from './ui/States.jsx';

const PRIORITY = { HIGH: ['critical', 'High priority'], MEDIUM: ['warning', 'Medium'], LOW: ['neutral', 'Low'] };

/** Proactive, data-backed recommendations with the reason and supporting numbers. */
export function RecommendationsList({ limit = 5 }) {
  const query = useRecommendations();
  const refresh = useRefreshRecommendations();
  const resolve = useResolveRecommendation();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2">
        <p className="text-xs text-muted">Detected from live lead, conversation and follow-up data. Refreshes every 15 minutes.</p>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={refresh.isPending} onClick={() => refresh.mutate()} className="shrink-0 whitespace-nowrap">Check now</Button>
      </div>
      {query.isPending ? (
        <LoadingRows rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data.data.length ? (
        <EmptyState icon={Lightbulb} title="Nothing needs attention" description="New recommendations appear when a lead needs action." />
      ) : (
        <ol className="flex-1 divide-y divide-line">
          {query.data.data.slice(0, limit).map((r) => {
            const [tone, label] = PRIORITY[r.priority] ?? PRIORITY.LOW;
            return (
              <li key={r.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <h3 className="text-sm font-semibold text-ink">{r.title}</h3>
                </div>
                <p className="mt-1 text-sm text-ink">{r.suggestedAction}</p>
                <p className="mt-1 text-xs text-ink-2"><span className="text-muted">Why: </span>{r.reason}</p>
                {r.impact?.valueCents != null && <p className="mt-0.5 text-xs text-muted">Estimated impact: {formatMoney(r.impact.valueCents)} potential deal ({r.impact.basis.toLowerCase()})</p>}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {r.lead && <Link to={`/leads/${r.lead.id}`} className="mr-2 text-sm font-medium text-accent hover:underline">Open {r.lead.name}</Link>}
                  <Button size="sm" variant="ghost" icon={Check} onClick={() => resolve.mutate({ id: r.id, action: 'done' })}>Done</Button>
                  <Button size="sm" variant="ghost" icon={X} onClick={() => resolve.mutate({ id: r.id, action: 'dismiss' })}>Dismiss</Button>
                  <span className="ml-auto text-xs text-muted"><RelativeTime date={r.createdAt} /></span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
