import { FlaskConical, Info, ListOrdered, MailCheck, Timer } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useSimulate, useUpdateBusiness } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select } from '../components/ui/Field.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { formatMoney } from '../lib/format.js';

const SCENARIOS = [
  { key: 'RESPONSE_TIME', icon: Timer, title: 'Faster first responses', question: 'What if high-intent leads get a reply within a set time?', defaults: { targetMinutes: 30, segment: 'HIGH_INTENT' } },
  { key: 'FIRST_FOLLOW_UP_DELAY', icon: MailCheck, title: 'First follow-up timing', question: 'What if the first follow-up is sent after a different delay?', defaults: { delayHours: 24 } },
  { key: 'FOLLOW_UP_FREQUENCY', icon: FlaskConical, title: 'Follow-up frequency', question: 'What happens if we send more (or fewer) follow-ups?', defaults: { maxFollowUps: 4 } },
  { key: 'PRIORITISATION', icon: ListOrdered, title: 'Lead prioritisation', question: 'Which leads should we work on first?', defaults: { by: 'VALUE' } },
];

function Params({ scenario, params, setParams }) {
  const set = (k) => (e) => setParams((p) => ({ ...p, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value }));
  if (scenario === 'RESPONSE_TIME')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reply within (minutes)">{(p) => <Input {...p} type="number" min="5" max="1440" value={params.targetMinutes} onChange={set('targetMinutes')} />}</Field>
        <Field label="Leads">{(p) => <Select {...p} value={params.segment} onChange={set('segment')}><option value="HIGH_INTENT">High-intent only</option><option value="ALL">All leads</option></Select>}</Field>
      </div>
    );
  if (scenario === 'FIRST_FOLLOW_UP_DELAY') return <Field label="First follow-up after (hours)">{(p) => <Input {...p} type="number" min="1" max="720" value={params.delayHours} onChange={set('delayHours')} />}</Field>;
  if (scenario === 'FOLLOW_UP_FREQUENCY') return <Field label="Maximum follow-ups per lead">{(p) => <Input {...p} type="number" min="0" max="5" value={params.maxFollowUps} onChange={set('maxFollowUps')} />}</Field>;
  return <Field label="Prioritise by">{(p) => <Select {...p} value={params.by} onChange={set('by')}><option value="VALUE">Weighted deal value</option><option value="SCORE">Lead score</option><option value="URGENCY">Urgency (risks first)</option></Select>}</Field>;
}

function Comparison({ h }) {
  if (!h) return null;
  if (h.steps) {
    return h.steps.length ? (
      <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Step</th><th className="pb-1 text-right font-medium">Sent</th><th className="pb-1 text-right font-medium">Replied after</th></tr></thead>
        <tbody>{h.steps.map((s) => <tr key={s.step} className="border-t border-line"><td className="py-1.5">Follow-up {s.step}</td><td className="py-1.5 text-right tabular">{s.sent}</td><td className="py-1.5 text-right tabular">{s.replyRate}%</td></tr>)}</tbody></table>
    ) : <p className="text-sm text-muted">No follow-ups sent in this period.</p>;
  }
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {[[h.fastLabel, h.fast], [h.slowLabel, h.slow]].map(([label, g]) => (
        <div key={label} className="rounded-lg border border-line p-3">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">{g.rate == null ? '–' : `${g.rate}%`}</dd>
          <dd className="text-xs text-muted">{g.successes} of {g.size} leads · {h.metric.toLowerCase()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SimulatorPage() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const simulate = useSimulate();
  const updateBusiness = useUpdateBusiness();
  const [scenario, setScenario] = useState(SCENARIOS[0]);
  const [params, setParams] = useState(SCENARIOS[0].defaults);
  const [range, setRange] = useState('90d');
  const [confirming, setConfirming] = useState(false);
  const r = simulate.data;

  const pick = (s) => { setScenario(s); setParams(s.defaults); simulate.reset(); };

  return (
    <>
      <PageHeader title="Follow-up strategy simulator" description="Test a strategy against your own history before changing anything. Simulations never change settings or contact anyone." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-3">
          {SCENARIOS.map((s) => (
            <button key={s.key} type="button" onClick={() => pick(s)} aria-pressed={scenario.key === s.key} className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${scenario.key === s.key ? 'border-accent bg-accent-soft/50' : 'border-line bg-surface hover:border-line-strong'}`}>
              <s.icon className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
              <span><span className="block text-sm font-semibold text-ink">{s.title}</span><span className="block text-sm text-muted">{s.question}</span></span>
            </button>
          ))}
        </div>
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title={scenario.title} description={scenario.question} />
            <CardBody className="space-y-4">
              <Params scenario={scenario.key} params={params} setParams={setParams} />
              <div className="flex flex-wrap items-end gap-3">
                <Field label="History to use">{(p) => <Select {...p} value={range} onChange={(e) => setRange(e.target.value)} className="w-auto"><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="all">All time</option></Select>}</Field>
                <Button variant="primary" icon={FlaskConical} loading={simulate.isPending} onClick={() => simulate.mutate({ scenario: scenario.key, params, range })}>Run simulation</Button>
              </div>
              {simulate.isError && <p className="text-sm text-critical">{simulate.error.message}</p>}
            </CardBody>
          </Card>
          {r && r.scenario === scenario.key && (
            <Card>
              <div className="flex items-start gap-2 border-b border-line bg-warning-soft px-5 py-3 text-sm text-warning">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span><strong>Simulation, not an actual result.</strong> {r.disclaimer}</span>
              </div>
              <CardBody className="space-y-5">
                <section>
                  <h3 className="mb-1 text-sm font-semibold text-ink">Leads affected</h3>
                  <p className="text-sm text-ink-2"><span className="text-2xl font-semibold text-ink">{r.affected.count}</span> · {r.affected.description}</p>
                  {r.affected.leads?.[0]?.name && (
                    <ul className="mt-2 divide-y divide-line">
                      {r.affected.leads.map((l) => (
                        <li key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                          <Link to={`/leads/${l.id}`} className="font-medium text-ink hover:underline">{l.name}</Link>
                          <StatusBadge status={l.status} />
                          <span className="ml-auto text-ink-2">{l.weightedCents != null ? `${formatMoney(l.weightedCents)} weighted` : `score ${l.score ?? '–'}`}{l.risks?.length ? ` · ${l.risks[0]}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {r.current && (
                  <section>
                    <h3 className="mb-1 text-sm font-semibold text-ink">Current situation</h3>
                    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      {Object.entries(r.current).filter(([, v]) => typeof v !== 'object').map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</dt><dd className="text-ink tabular">{v ?? '–'}</dd></div>
                      ))}
                    </dl>
                  </section>
                )}
                {r.historical && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold text-ink">Historical performance</h3>
                    <Comparison h={r.historical} />
                  </section>
                )}
                <section>
                  <h3 className="mb-1 text-sm font-semibold text-ink">Estimated impact</h3>
                  {r.estimate.available ? (
                    <div className="text-sm text-ink-2">
                      {r.estimate.additionalEngagedLeads != null && <p><span className="text-lg font-semibold text-ink">≈ {r.estimate.additionalEngagedLeads}</span> more engaged leads{r.estimate.valueCents != null && <> (≈ {formatMoney(r.estimate.valueCents)} potential deals)</>}</p>}
                      {r.estimate.replyRateChange != null && <p><span className="text-lg font-semibold text-ink">{r.estimate.replyRateChange > 0 ? '+' : ''}{r.estimate.replyRateChange} pts</span> reply rate</p>}
                      {r.estimate.additionalRepliesPerLead != null && <p><span className="text-lg font-semibold text-ink">≈ {r.estimate.additionalRepliesPerLead}</span> extra replies per lead</p>}
                      <p className="mt-1 text-xs text-muted">{r.estimate.basis}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">No estimate: {r.estimate.reason}</p>
                  )}
                  {r.suggestion && <p className="mt-2 text-sm text-ink-2">{r.suggestion} <Link to="/autonomy" className="font-medium text-accent hover:underline">Open Autonomy</Link></p>}
                </section>
                {r.apply && isOwner && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                    <p className="text-sm text-ink-2">Apply this strategy: {r.apply.description}. Nothing changes until you confirm.</p>
                    <Button onClick={() => setConfirming(true)}>Apply to settings…</Button>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      {confirming && r?.apply && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title="Apply this strategy?"
          description={`${r.apply.description}. This changes your follow-up settings for future follow-ups.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" loading={updateBusiness.isPending} onClick={() => updateBusiness.mutate({ commsPrefs: r.apply.commsPrefs }, { onSuccess: () => { toast.success('Settings updated', r.apply.description); setConfirming(false); }, onError: (e) => toast.error('Could not apply', e.message) })}>
                Apply
              </Button>
            </>
          }
        >
          <pre className="rounded-lg bg-surface-2 p-3 text-xs text-ink-2">{JSON.stringify(r.apply.commsPrefs, null, 2)}</pre>
        </Dialog>
      )}
    </>
  );
}
