import { CalendarClock, CheckCircle2, ClipboardCheck, Clock, DollarSign, Gauge, Percent, Trophy, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useActivity, useAgents, useSummary } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { ActivityFeed, EVENT_CATEGORIES } from '../components/ActivityFeed.jsx';
import { AgentActivity } from '../components/AgentActivity.jsx';
import { ApprovalsPanel } from '../components/ApprovalsPanel.jsx';
import { BarList } from '../components/charts/BarList.jsx';
import { ChartCard, DataTable } from '../components/charts/ChartCard.jsx';
import { ColumnChart } from '../components/charts/ColumnChart.jsx';
import { Funnel } from '../components/charts/Funnel.jsx';
import { InsightsCard } from '../components/InsightsCard.jsx';
import { StatTile } from '../components/StatTile.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { InfoTip } from '../components/ui/InfoTip.jsx';
import { Select } from '../components/ui/Field.jsx';
import { PageHeader, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows, Skeleton } from '../components/ui/States.jsx';
import { STATUS_LABELS } from '../lib/constants.js';
import { formatDayKey, formatDuration, formatMoney, formatNumber, formatPercent } from '../lib/format.js';

const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];
const PERIOD_NAME = { '7d': 'previous 7 days', '30d': 'previous 30 days', '90d': 'previous 90 days' };
const RANGE_TEXT = { '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days', all: 'all time' };

/** Metric definitions, shown as tooltips. Keep in sync with api/src/modules/dashboard/metrics.js. */
const DEFINITIONS = {
  total: 'Leads created in the selected date range, compared with the same length of time just before it.',
  qualification:
    'Leads that reached Qualified or any later stage (Contacted, Engaged, Appointment booked, Won), divided by all leads in the range. A lead that was qualified and later lost still counts.',
  conversion: 'Leads marked Won, divided by all leads created in the range.',
  win: 'Won leads divided by closed leads (Won + Lost) created in the range. Open and opted-out leads are excluded.',
  followUps:
    'Follow-ups that have not been sent yet, right now: being drafted by AI, waiting for your approval, or scheduled to send. Not affected by the date range.',
  approvals:
    'Everything waiting for your decision right now: reply drafts, follow-up drafts, appointments, and discount or quote requests. A follow-up draft counts in both this tile and Pending follow-ups. Not affected by the date range.',
  followUpApprovals: 'AI-written follow-ups waiting for your approval right now. Turn on automatic follow-up sending in Autonomy to skip this step.',
  pipeline:
    'Sum over open leads of deal value × win chance for their stage. Deal value: your value, else the lead\'s stated budget, else published prices of matched services. An estimate, not guaranteed revenue; see Revenue for details.',
  averageScore: 'Mean AI or manual score (0–100) of scored leads created in the range. Unscored leads are left out.',
  firstResponse: "Middle value of the time between a lead's enquiry and our first email, for leads created in the range that have been answered.",
};

const PLURALS = { reply: 'replies' };
const plural = (n, word) => `${formatNumber(n)} ${n === 1 ? word : (PLURALS[word] ?? `${word}s`)}`;

function Kpis({ s, range, dim }) {
  const delta = s.totals.previousLeads == null ? null : { value: s.totals.leads - s.totals.previousLeads, period: PERIOD_NAME[range] };
  const approvalParts = [
    s.approvals.replies && plural(s.approvals.replies, 'reply'),
    s.approvals.followUps && plural(s.approvals.followUps, 'follow-up'),
    s.approvals.discounts && plural(s.approvals.discounts, 'discount'),
    s.approvals.quotes && plural(s.approvals.quotes, 'quote'),
    s.approvals.other && `${s.approvals.other} other`,
  ].filter(Boolean);
  const followUpParts = [
    s.followUps.scheduled && `${s.followUps.scheduled} scheduled`,
    s.followUps.needsApproval && `${s.followUps.needsApproval} need approval`,
    s.followUps.drafting && `${s.followUps.drafting} drafting`,
  ].filter(Boolean);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <StatTile dim={dim} label="Total leads" icon={Users} value={formatNumber(s.totals.leads)} delta={delta} hint={delta ? null : 'All time'} info={DEFINITIONS.total} />
      <StatTile
        dim={dim}
        label="Qualified leads"
        icon={CheckCircle2}
        value={formatNumber(s.totals.qualified)}
        hint={`${formatPercent(s.qualificationRate)} qualification rate`}
        info={DEFINITIONS.qualification}
      />
      <StatTile dim={dim} label="Conversion rate" icon={Percent} value={formatPercent(s.conversionRate)} hint={`${formatNumber(s.totals.won)} won of ${formatNumber(s.totals.leads)}`} info={DEFINITIONS.conversion} />
      <StatTile
        dim={dim}
        label="Win rate"
        icon={Trophy}
        value={formatPercent(s.winRate)}
        hint={s.totals.won + s.totals.lost ? `${formatNumber(s.totals.won)} won of ${formatNumber(s.totals.won + s.totals.lost)} closed` : 'No closed leads yet'}
        info={DEFINITIONS.win}
      />
      <StatTile
        dim={dim}
        label="Pending follow-ups"
        scope="Now"
        icon={CalendarClock}
        value={formatNumber(s.pendingFollowUps)}
        hint={followUpParts.join(' · ') || 'None queued'}
        info={DEFINITIONS.followUps}
      />
      <StatTile dim={dim} label="Follow-ups to approve" scope="Now" icon={ClipboardCheck} value={formatNumber(s.followUps.needsApproval)} hint={s.followUps.needsApproval ? 'Review in Follow-ups' : 'Nothing to review'} info={DEFINITIONS.followUpApprovals} />
      <StatTile
        dim={dim}
        label="Approvals waiting"
        scope="Now"
        icon={ClipboardCheck}
        value={formatNumber(s.pendingApprovals)}
        hint={approvalParts.join(' · ') || 'Nothing to approve'}
        info={DEFINITIONS.approvals}
      />
      <StatTile dim={dim} label="Estimated pipeline" scope="Now" icon={DollarSign} value={formatMoney(s.pipelineValue.weightedCents)} hint={`Weighted · ${formatMoney(s.pipelineValue.valueCents)} unweighted`} info={DEFINITIONS.pipeline} />
      <StatTile dim={dim} label="Average lead score" icon={Gauge} value={s.averageScore ?? '–'} hint="Scored leads in range" info={DEFINITIONS.averageScore} />
      <StatTile dim={dim} label="Median first response" icon={Clock} value={formatDuration(s.medianFirstResponseMinutes)} hint="Enquiry to first email" info={DEFINITIONS.firstResponse} />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading overview">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <StatTile key={i} label=" " loading />
        ))}
      </div>
      <Skeleton className="h-56" />
    </div>
  );
}

function RecentActivity({ timeZone }) {
  const [category, setCategory] = useState('all');
  const query = useActivity(15, category === 'all' ? undefined : category);
  return (
    <Card className="flex h-full flex-col">
      <CardHeader title="Recent activity" description="Latest events across all leads (not limited by the date range)" />
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
        <label htmlFor="activity-type" className="text-sm text-ink-2">
          Show
        </label>
        <Select id="activity-type" value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto">
          <option value="all">All events</option>
          {Object.entries(EVENT_CATEGORIES).map(([value, c]) => (
            <option key={value} value={value}>
              {c.label} events
            </option>
          ))}
        </Select>
      </div>
      <CardBody className="max-h-[36rem] flex-1 overflow-y-auto">
        {query.isPending ? (
          <LoadingRows rows={4} label="Loading activity" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load activity" />
        ) : query.data.data.length ? (
          <div className={query.isPlaceholderData ? 'opacity-60' : undefined}>
            <ActivityFeed events={query.data.data} showLead timeZone={timeZone} />
          </div>
        ) : (
          <EmptyState icon={Clock} title="No activity of this type yet" />
        )}
      </CardBody>
    </Card>
  );
}

export function OverviewPage() {
  const { business } = useAuth();
  const tz = business?.timezone;
  const [range, setRange] = useState('30d');
  const summary = useSummary(range);
  const agents = useAgents(range);
  const dim = summary.isFetching && summary.isPlaceholderData;
  const s = summary.data;

  const funnelRows = s?.funnel.map((f) => ({ stage: STATUS_LABELS[f.stage], count: f.count, share: formatPercent(f.percentOfTotal), step: f.stepConversion == null ? '–' : formatPercent(f.stepConversion) }));
  const pipeline = s?.pipeline.map((p) => ({ key: p.status, label: STATUS_LABELS[p.status], value: p.count }));
  const days = s?.leadsByDay.map((d) => ({ key: d.date, value: d.count }));

  return (
    <>
      <PageHeader
        title="Overview"
        description={`How your website enquiries are turning into customers · ${RANGE_TEXT[range]}`}
        actions={<Segmented label="Date range" value={range} onChange={setRange} options={RANGES} />}
      />

      <div className="space-y-5">
        {summary.isPending ? (
          <OverviewSkeleton />
        ) : summary.isError ? (
          <Card>
            <ErrorState error={summary.error} onRetry={() => summary.refetch()} title="Couldn't load your metrics" />
          </Card>
        ) : (
          <Kpis s={s} range={range} dim={dim} />
        )}

        <AgentActivity query={agents} timeZone={tz} />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 [&>div>section]:h-full">
          <div className="xl:col-span-7">
            {s && s.totals.leads === 0 ? (
              <Card className="h-full">
                <CardHeader title="Sales conversion funnel" description={`Leads created in ${RANGE_TEXT[range]}`} />
                <EmptyState
                  icon={Users}
                  title="No leads in this range"
                  description="Pick a longer date range, or add a lead to start your funnel."
                  action={
                    <Link to="/leads" className="text-sm font-medium text-accent hover:underline">
                      Go to leads
                    </Link>
                  }
                />
              </Card>
            ) : (
              <ChartCard
                dim={dim}
                title="Sales conversion funnel"
                description={
                  <>
                    Leads created in {RANGE_TEXT[range]} that reached each stage{' '}
                    <InfoTip label="How the funnel is calculated" align="left">
                      Each lead counts at the furthest stage it ever reached, from its status history and emails sent, so a lead that was qualified and later lost still
                      counts as qualified. Percentages are of all leads; &ldquo;moved on&rdquo; is the share of the previous stage.
                    </InfoTip>
                  </>
                }
                table={
                  funnelRows && (
                    <DataTable
                      columns={[
                        { key: 'stage', label: 'Stage' },
                        { key: 'count', label: 'Leads', numeric: true },
                        { key: 'share', label: '% of all', numeric: true },
                        { key: 'step', label: '% of previous', numeric: true },
                      ]}
                      rows={funnelRows}
                    />
                  )
                }
              >
                {s ? <Funnel steps={s.funnel} /> : <LoadingRows rows={6} />}
              </ChartCard>
            )}
          </div>
          <div className="xl:col-span-5">
            <InsightsCard range={range} />
          </div>
        </div>

        {s && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 [&>div>section]:h-full">
            <div className="xl:col-span-7">
              <ChartCard
                dim={dim}
                title="New leads per day"
                description={`${s.range === 'all' ? 'Last 90 days' : RANGE_TEXT[range].replace('the l', 'L')}, ${s.timezone} time`}
                table={<DataTable columns={[{ key: 'day', label: 'Day' }, { key: 'count', label: 'Leads', numeric: true }]} rows={days.map((d) => ({ day: formatDayKey(d.key), count: d.value }))} />}
              >
                <ColumnChart data={days} formatLabel={formatDayKey} valueLabel="Leads" height={220} />
              </ChartCard>
            </div>
            <div className="xl:col-span-5">
              <ChartCard
                dim={dim}
                title="Pipeline by current status"
                description="Where leads from this range are now"
                table={<DataTable columns={[{ key: 'label', label: 'Status' }, { key: 'value', label: 'Leads', numeric: true }]} rows={pipeline} />}
              >
                <BarList data={pipeline} formatValue={formatNumber} />
              </ChartCard>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
          <div className="xl:col-span-7">
            <ApprovalsPanel timeZone={tz} />
          </div>
          <div className="xl:col-span-5">
            <RecentActivity timeZone={tz} />
          </div>
        </div>
      </div>
    </>
  );
}
