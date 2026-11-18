import clsx from 'clsx';
import { ChevronDown, Lightbulb, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useGenerateInsights, useInsights } from '../api/hooks.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { Card, CardHeader } from './ui/Card.jsx';
import { RelativeTime } from './ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from './ui/States.jsx';
import { Segmented } from './ui/Misc.jsx';
import { RecommendationsList } from './RecommendationsList.jsx';
import { useToast } from './ui/Toast.jsx';

const PRIORITY = {
  HIGH: { tone: 'critical', label: 'High priority' },
  MEDIUM: { tone: 'warning', label: 'Medium' },
  LOW: { tone: 'neutral', label: 'Low' },
};
const RANGE_TEXT = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', all: 'all time' };

function Insight({ insight, index }) {
  const [open, setOpen] = useState(index === 0);
  const p = PRIORITY[insight.priority] ?? PRIORITY.LOW;
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={p.tone}>{p.label}</Badge>
        <h3 className="text-sm font-semibold text-ink">{insight.title}</h3>
      </div>
      <p className="mt-1.5 text-sm text-ink">{insight.recommendation}</p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
      >
        Why this recommendation
        <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-surface-2 p-3 text-xs">
          <p className="text-ink-2">{insight.reason}</p>
          <ul className="space-y-1">
            {insight.evidence.map((e) => (
              <li key={e.id} className="text-muted">
                <span className="font-medium text-ink-2">Based on: {e.title}.</span>
                {e.detail !== insight.reason && ` ${e.detail}`}
              </li>
            ))}
          </ul>
          {insight.leadIds?.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {insight.leadIds.slice(0, 5).map((id, i) => (
                <Link key={id} to={`/leads/${id}`} className="font-medium text-accent hover:underline">
                  Lead {i + 1}
                </Link>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * AI-generated recommendations from the Sales Intelligence agent. Each one
 * cites facts computed from the business's own data (validated server-side).
 */
const VISIBLE = 3;

export function InsightsCard({ range }) {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState('recommendations');
  const query = useInsights();
  const generate = useGenerateInsights();
  const data = query.data?.data;

  const refresh = () =>
    generate.mutate(range, {
      onSuccess: (res) => toast.success('Insights updated', `${res.data.insights.length} recommendation${res.data.insights.length === 1 ? '' : 's'} from your data.`),
      onError: (e) => toast.error("Couldn't generate insights", e.message),
    });

  return (
    <Card className="flex h-full flex-col">
      <div className="border-b border-line px-5 pt-3 pb-2">
        <Segmented
          label="Insight type"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'recommendations', label: 'Recommendations' },
            { value: 'ai', label: 'AI pipeline analysis' },
          ]}
        />
      </div>
      {tab === 'recommendations' ? <RecommendationsList /> : (
      <>
      <CardHeader
        title="RevenuePilot insights"
        description={
          data ? (
            <>
              Based on {RANGE_TEXT[data.range] ?? data.range} ({data.leadsInRange ?? 0} leads) · <RelativeTime date={data.generatedAt} /> ·{' '}
              {data.model === 'mock' ? 'mock AI (rule-based)' : data.model}
            </>
          ) : (
            'Recommendations from your leads, conversations and follow-ups'
          )
        }
        actions={
          <Button size="sm" icon={RefreshCw} loading={generate.isPending} onClick={refresh}>
            {data ? 'Refresh' : 'Generate'}
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingRows rows={3} label="Loading insights" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load insights" />
      ) : !data ? (
        <EmptyState
          icon={Lightbulb}
          title="No insights yet"
          description="Generate insights to get recommendations based on your actual pipeline. They also refresh daily when there is new activity."
        />
      ) : (
        <>
          {(data.range !== range || data.newActivitySinceGenerated > 0) && (
            <p className="border-b border-line bg-surface-2 px-5 py-2 text-xs text-ink-2">
              {data.range !== range ? `These insights cover ${RANGE_TEXT[data.range]}; refresh to analyse ${RANGE_TEXT[range]}.` : `${data.newActivitySinceGenerated} new events since these were generated.`}
            </p>
          )}
          {data.insights.length === 0 ? (
            <EmptyState icon={Lightbulb} title="Nothing needs attention" description={data.summary ?? 'The data did not support any recommendation.'} />
          ) : (
            <>
              <ol className="flex-1 divide-y divide-line">
                {(showAll ? data.insights : data.insights.slice(0, VISIBLE)).map((insight, i) => (
                  <Insight key={`${insight.title}-${i}`} insight={insight} index={i} />
                ))}
              </ol>
              {data.insights.length > VISIBLE && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  aria-expanded={showAll}
                  className="border-t border-line px-5 py-2.5 text-left text-sm font-medium text-accent hover:bg-surface-2"
                >
                  {showAll ? 'Show fewer' : `Show all ${data.insights.length} insights`}
                </button>
              )}
            </>
          )}
        </>
      )}
      </>
      )}
    </Card>
  );
}
