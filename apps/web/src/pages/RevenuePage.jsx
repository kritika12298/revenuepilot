import { AlertTriangle, Info, LineChart } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useRevenue } from '../api/hooks.js';
import { ChartCard, DataTable } from '../components/charts/ChartCard.jsx';
import { ColumnChart } from '../components/charts/ColumnChart.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { LOST_REASONS, STATUS_LABELS } from '../lib/constants.js';
import { formatDayKey, formatMoney, formatNumber } from '../lib/format.js';

const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];
const money = (c) => (c == null ? 'Unknown' : formatMoney(c));
const TIER = { HIGH: ['critical', 'High intent'], MEDIUM: ['warning', 'Medium intent'], LOW: ['neutral', 'Low intent'] };

function OpportunityTable({ rows, showRisk }) {
  if (!rows.length) return <EmptyState icon={LineChart} title="Nothing here" className="py-8" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-5 py-2 font-medium">Lead</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 text-right font-medium">Deal value</th>
            <th className="px-3 py-2 text-right font-medium">Win chance</th>
            <th className="px-5 py-2 font-medium">{showRisk ? 'Why at risk' : 'Intent'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((o) => (
            <tr key={o.lead.id}>
              <td className="px-5 py-2.5"><Link to={`/leads/${o.lead.id}`} className="font-medium text-ink hover:underline">{o.lead.name}</Link></td>
              <td className="px-3 py-2.5"><StatusBadge status={o.lead.status} /></td>
              <td className="px-3 py-2.5 text-right tabular" title={o.valueBasis}>{money(o.valueCents)}</td>
              <td className="px-3 py-2.5 text-right tabular">{Math.round(o.probability * 100)}%</td>
              <td className="px-5 py-2.5 text-ink-2">{showRisk ? o.risks.join('; ') : <Badge tone={TIER[o.tier][0]}>{TIER[o.tier][1]}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RevenuePage() {
  const [range, setRange] = useState('30d');
  const query = useRevenue(range);
  const r = query.data;
  const dim = query.isFetching && query.isPlaceholderData;

  return (
    <>
      <PageHeader
        title="Revenue intelligence"
        description="Estimated pipeline value, opportunities and risk, from your actual leads. Estimates, not guaranteed revenue."
        actions={<Segmented label="Date range" value={range} onChange={setRange} options={RANGES} />}
      />
      {query.isPending ? (
        <Card><LoadingRows rows={6} label="Loading revenue" /></Card>
      ) : query.isError ? (
        <Card><ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load revenue intelligence" /></Card>
      ) : (
        <div className="space-y-5">
          {!r.dataSufficiency.sufficient && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
              {r.dataSufficiency.note} Treat win chances as rough guides until you have more closed leads.
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile dim={dim} label="Pipeline value" scope="Now" value={money(r.pipeline.valueCents)} hint={`${r.pipeline.leadsWithValue} of ${r.pipeline.openLeads} open leads have a value`} info={r.methodology.dealValue} />
            <StatTile dim={dim} label="Weighted pipeline" scope="Now" value={money(r.pipeline.weightedCents)} hint="Deal value × win chance" info="Each open lead's deal value multiplied by the win probability for its stage (see methodology below)." />
            <StatTile dim={dim} label="Revenue at risk" scope="Now" value={money(r.atRisk.valueCents)} hint={`${r.atRisk.count} lead${r.atRisk.count === 1 ? '' : 's'} need${r.atRisk.count === 1 ? 's' : ''} attention${r.atRisk.count > r.atRisk.leadsWithValue ? ` · ${r.atRisk.count - r.atRisk.leadsWithValue} without a value` : ''}`} info={r.methodology.risk} />
            <StatTile dim={dim} label="Lost in range" value={money(r.lost.valueCents)} hint={`${r.lost.count} lost · ${money(r.won.valueCents)} won (${r.won.count})`} info="Estimated value of leads created in the range that were marked Lost (or Won)." />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {['high', 'medium', 'low'].map((t) => (
              <StatTile key={t} dim={dim} label={`${t[0].toUpperCase()}${t.slice(1)}-intent opportunities`} value={formatNumber(r.tiers[t].count)} hint={`${money(r.tiers[t].valueCents)} value · ${money(r.tiers[t].weightedCents)} weighted`} info={r.methodology.tiers} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <Card className="xl:col-span-7">
              <CardHeader title="Leads requiring attention" description="Highest weighted value and open risks first" />
              <OpportunityTable rows={r.needsAttention} />
            </Card>
            <div className="xl:col-span-5">
              <ChartCard
                dim={dim}
                title="Conversion trend"
                description="Share of leads won, by the week they arrived"
                table={<DataTable columns={[{ key: 'week', label: 'Week of' }, { key: 'leads', label: 'Leads', numeric: true }, { key: 'won', label: 'Won', numeric: true }, { key: 'rate', label: 'Conversion', numeric: true }]} rows={r.trend.map((w) => ({ week: formatDayKey(w.weekStart), leads: w.leads, won: w.won, rate: w.conversionRate == null ? '–' : `${w.conversionRate}%` }))} />}
              >
                {r.trend.every((w) => !w.leads) ? (
                  <EmptyState icon={LineChart} title="Not enough data" description="No leads in this range yet." />
                ) : (
                  <ColumnChart data={r.trend.map((w) => ({ key: w.weekStart, value: w.won }))} formatLabel={formatDayKey} valueLabel="Won leads" height={200} />
                )}
              </ChartCard>
            </div>
          </div>

          <Card>
            <CardHeader title="Revenue at risk" description="Open leads with a reason to act now" />
            <OpportunityTable rows={r.atRisk.leads} showRisk />
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="How predictions are calculated" />
              <CardBody className="space-y-3 text-sm text-ink-2">
                <p>{r.methodology.dealValue}</p>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Stage</th><th className="pb-1 text-right font-medium">Win chance</th><th className="pb-1 text-right font-medium">Source</th></tr></thead>
                  <tbody>
                    {Object.entries(r.methodology.probabilities).map(([stage, p]) => (
                      <tr key={stage} className="border-t border-line">
                        <td className="py-1.5">{STATUS_LABELS[stage]}</td>
                        <td className="py-1.5 text-right tabular">{Math.round(p.probability * 100)}%</td>
                        <td className="py-1.5 text-right text-xs">{p.method === 'HISTORY' ? `Your history (${p.sample} closed)` : 'Default'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted">{r.disclaimer}</p>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Why leads were lost" description="Leads created in this range" />
              <CardBody>
                {r.lost.count === 0 ? (
                  <p className="text-sm text-muted">No lost leads in this range.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {Object.entries(r.lost.reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
                      <li key={reason} className="flex justify-between"><span className="flex items-center gap-1.5 text-ink-2"><AlertTriangle className="h-3.5 w-3.5 text-muted" aria-hidden />{LOST_REASONS[reason] ?? reason}</span><span className="tabular text-ink">{n}</span></li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
