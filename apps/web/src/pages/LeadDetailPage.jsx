import { ArrowLeft, CalendarDays, CalendarPlus, Compass, DollarSign, Mail, MessagesSquare, Pencil, Phone, Sparkles, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useChangeStatus, useLead, useLeadEvents, useMembers, useRunAgent, useScheduleFollowUp, useUpdateLead } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { ActivityFeed } from '../components/ActivityFeed.jsx';
import { AgentRunsPanel } from '../components/AgentRunsPanel.jsx';
import { Composer, ConversationThread } from '../components/ConversationThread.jsx';
import { FollowUpList } from '../components/FollowUpList.jsx';
import { AppointmentList, BookAppointmentDialog } from '../components/Appointments.jsx';
import { ScoreComponent, ScoreMeter } from '../components/ScoreMeter.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select, Switch, Textarea } from '../components/ui/Field.jsx';
import { InfoTip } from '../components/ui/InfoTip.jsx';
import { PageHeader, RelativeTime, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows, QueryState } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { fieldErrors } from '../lib/api.js';
import { LOST_REASONS, NEXT_ACTION_LABELS, SOURCE_LABELS, STATUS_LABELS } from '../lib/constants.js';
import { formatMoney, formatNumber } from '../lib/format.js';

const SENTIMENT = { POSITIVE: 'Positive', NEUTRAL: 'Neutral', NEGATIVE: 'Negative', MIXED: 'Mixed' };
const CLOSED = ['WON', 'LOST', 'OPTED_OUT'];

function StatusDialog({ lead, onClose }) {
  const toast = useToast();
  const mutation = useChangeStatus(lead.id);
  const [status, setStatus] = useState(lead.allowedTransitions[0] ?? '');
  const [lostReason, setLostReason] = useState('PRICE');
  const [note, setNote] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Change status"
      description={`Currently ${STATUS_LABELS[lead.status]}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!status}
            onClick={() =>
              mutation.mutate(
                { status, ...(status === 'LOST' && { lostReason }), ...(note.trim() && { note: note.trim() }) },
                { onSuccess: () => { toast.success(`Moved to ${STATUS_LABELS[status]}`); onClose(); } },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="New status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
              {lead.allowedTransitions.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
          )}
        </Field>
        {status === 'LOST' && (
          <Field label="Why was it lost?" hint="Used for lost-lead insights.">
            {(p) => (
              <Select {...p} value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                {Object.entries(LOST_REASONS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </Select>
            )}
          </Field>
        )}
        {CLOSED.includes(status) && <p className="text-sm text-muted">Pending follow-ups and AI drafts for this lead will be cancelled.</p>}
        <Field label="Note (optional)">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {mutation.isError && <p className="text-sm text-critical">{mutation.error.message}</p>}
      </div>
    </Dialog>
  );
}

function EditLeadDialog({ lead, onClose }) {
  const toast = useToast();
  const mutation = useUpdateLead(lead.id);
  const [v, setV] = useState({ name: lead.name, email: lead.email ?? '', phone: lead.phone ?? '', company: lead.company ?? '', consent: lead.consentEmail });
  const bind = (k) => ({ value: v[k], onChange: (e) => setV((s) => ({ ...s, [k]: e.target.value })) });
  const errors = fieldErrors(mutation.error);
  const optedOut = lead.status === 'OPTED_OUT';

  const save = () => {
    const body = {
      name: v.name.trim(),
      email: v.email.trim() || null,
      phone: v.phone.trim() || null,
      company: v.company.trim() || null,
      ...(v.consent !== lead.consentEmail && { consent: { email: v.consent, source: 'dashboard: confirmed by owner' } }),
    };
    mutation.mutate(body, { onSuccess: () => { toast.success('Lead updated'); onClose(); } });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit lead"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={mutation.isPending}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} {...bind('name')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" {...bind('email')} />}</Field>
          <Field label="Phone" error={errors.phone}>{(p) => <Input {...p} type="tel" {...bind('phone')} />}</Field>
        </div>
        <Field label="Company" error={errors.company}>{(p) => <Input {...p} {...bind('company')} />}</Field>
        <Switch
          label="Email consent"
          description={optedOut ? 'This lead unsubscribed; only they can opt back in.' : 'Required for automated follow-ups. Turning it off stops pending follow-ups.'}
          checked={v.consent}
          disabled={optedOut}
          onChange={(consent) => setV((s) => ({ ...s, consent }))}
        />
        {mutation.isError && !Object.keys(errors).length && <p className="text-sm text-critical">{mutation.error.message}</p>}
      </div>
    </Dialog>
  );
}

function AssigneeSelect({ lead }) {
  const members = useMembers();
  const update = useUpdateLead(lead.id);
  const toast = useToast();
  return (
    <Select
      aria-label="Assigned to"
      value={lead.assignedTo?.id ?? ''}
      disabled={update.isPending || members.isPending}
      onChange={(e) =>
        update.mutate(
          { assignedToId: e.target.value || null },
          { onSuccess: (l) => toast.success(l.assignedTo ? `Assigned to ${l.assignedTo.name}` : 'Unassigned'), onError: (err) => toast.error('Could not assign', err.message) },
        )
      }
      className="h-8 w-auto max-w-56 text-xs"
    >
      <option value="">Unassigned</option>
      {members.data?.data.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </Select>
  );
}

function NextActionCard({ lead }) {
  const next = lead.nextAction;
  return (
    <Card>
      <CardHeader title="Recommended next action" description="From the latest AI decision and open recommendations" />
      <CardBody className="space-y-3">
        {!next && !lead.recommendations?.length ? (
          <p className="text-sm text-muted">No recommendation yet. Run the AI to analyse this lead and decide what to do next.</p>
        ) : (
          <>
            {next && (
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Compass className="h-4 w-4 text-accent" aria-hidden />
                  {NEXT_ACTION_LABELS[next.nextAction] ?? next.nextAction}
                </p>
                {next.rationale && <p className="mt-1 text-sm text-ink-2">{next.rationale}</p>}
                <p className="mt-1 text-xs text-muted">Decided <RelativeTime date={next.decidedAt} /></p>
              </div>
            )}
            {lead.recommendations?.map((r) => (
              <div key={r.id} className="rounded-lg border border-line p-3">
                <p className="text-sm font-medium text-ink">{r.title}</p>
                <p className="mt-0.5 text-sm text-ink-2">{r.suggestedAction}</p>
                <p className="mt-1 text-xs text-muted">Why: {r.reason}</p>
              </div>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function DealValueCard({ lead }) {
  const { isOwner } = useAuth();
  const update = useUpdateLead(lead.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(lead.dealValueCents != null ? String(lead.dealValueCents / 100) : '');
  const dv = lead.dealValue;
  const save = (cents) =>
    update.mutate({ dealValueCents: cents }, { onSuccess: () => { setEditing(false); toast.success(cents == null ? 'Using the estimate' : 'Deal value saved'); } });

  return (
    <Card>
      <CardHeader
        title="Potential deal value"
        actions={
          <InfoTip label="How deal value is estimated">
            Uses, in order: a value you entered; the midpoint of the budget the lead stated; or the published prices of the services the AI matched. With none of
            these, no value is shown. It is an estimate, not guaranteed revenue.
          </InfoTip>
        }
      />
      <CardBody className="space-y-2">
        {editing ? (
          <div className="flex items-end gap-2">
            <Field label="Value ($)" className="flex-1">{(p) => <Input {...p} type="number" min="0" step="1" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Button variant="primary" loading={update.isPending} disabled={value === ''} onClick={() => save(Math.round(Number(value) * 100))}>Save</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        ) : (
          <>
            <p className="text-2xl font-semibold text-ink">{dv?.cents != null ? formatMoney(dv.cents) : 'Unknown'}</p>
            <p className="text-sm text-ink-2">{dv?.basis}</p>
            {isOwner && (
              <div className="flex gap-2 pt-1">
                <Button size="sm" icon={DollarSign} onClick={() => setEditing(true)}>{lead.dealValueCents != null ? 'Edit value' : 'Set value'}</Button>
                {lead.dealValueCents != null && <Button size="sm" variant="ghost" onClick={() => save(null)}>Use estimate</Button>}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function AnalysisCard({ lead }) {
  const a = lead.qualification;
  const b = lead.scoreBreakdown;
  return (
    <Card>
      <CardHeader title="AI analysis" description={a?.analyzedAt ? <>Updated <RelativeTime date={a.analyzedAt} /></> : 'Requirements, budget, timeline and intent'} />
      <CardBody className="space-y-5">
        {!a && !b ? (
          <EmptyState icon={Sparkles} title="Not analysed yet" description="Run the AI to extract requirements, budget and timeline, and score this lead." className="py-6" />
        ) : (
          <>
            {a && (
              <dl className="space-y-3 text-sm">
                {a.summary && <p className="text-ink">{a.summary}</p>}
                <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
                  <dt className="text-muted">Intent</dt>
                  <dd className="text-ink">{a.intent?.level ? `${a.intent.level.toLowerCase()}${a.intent.signals?.length ? `: ${a.intent.signals.join(', ')}` : ''}` : '–'}</dd>
                  <dt className="text-muted">Sentiment</dt>
                  <dd className="text-ink">{a.sentiment ? `${SENTIMENT[a.sentiment.label]}${a.sentiment.evidence ? ` (${a.sentiment.evidence})` : ''}` : '–'}</dd>
                  <dt className="text-muted">Budget</dt>
                  <dd className="text-ink">
                    {a.budget?.stated ? (a.budget.min === a.budget.max ? `$${formatNumber(a.budget.max)}` : `$${formatNumber(a.budget.min)}–$${formatNumber(a.budget.max)}`) : 'Not stated'}
                  </dd>
                  <dt className="text-muted">Timeline</dt>
                  <dd className="text-ink">{a.timeline?.description ?? (a.timeline?.urgency ? a.timeline.urgency.replace('_', ' ').toLowerCase() : '–')}</dd>
                  <dt className="text-muted">Requirements</dt>
                  <dd className="text-ink">{a.requirements?.length ? a.requirements.join(', ') : '–'}</dd>
                </div>
                {a.missingInformation?.length > 0 && (
                  <div>
                    <dt className="mb-1.5 text-muted">Still to find out</dt>
                    <dd className="flex flex-wrap gap-1.5">{a.missingInformation.map((m) => <Badge key={m}>{m}</Badge>)}</dd>
                  </div>
                )}
              </dl>
            )}
            {b && (
              <div className="space-y-3 border-t border-line pt-4">
                <div className="flex items-baseline justify-between">
                  <p className="flex items-center gap-1 text-sm font-medium text-ink">
                    Lead score
                    <InfoTip label="How the lead score works">
                      Three parts that add up to 100: urgency (up to 35), budget fit against your published prices (up to 35) and likelihood to convert (up to 30).
                      Each reason cites what the lead actually said; the server adds the parts up.
                    </InfoTip>
                  </p>
                  <p className="text-2xl font-semibold text-ink">{lead.score}<span className="text-sm font-normal text-muted">/100</span></p>
                </div>
                {b.urgency != null && (
                  <div className="space-y-2.5">
                    <ScoreComponent label="Urgency" value={b.urgency} max={35} />
                    <ScoreComponent label="Budget fit" value={b.budgetFit} max={35} />
                    <ScoreComponent label="Likelihood to convert" value={b.conversionLikelihood} max={30} />
                  </div>
                )}
                {b.reasons?.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{b.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                <p className="text-xs text-muted">{b.method === 'AI' ? 'Scored by AI' : b.method === 'OVERRIDE' ? 'Manual override' : b.method === 'SEED' ? 'Demo data (seeded score)' : 'Scored manually'}</p>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Lifecycle({ leadId, timeZone }) {
  const query = useLeadEvents(leadId, 100);
  return (
    <QueryState query={query} loading={<LoadingRows rows={4} />}>
      {(page) => (page.data.length ? <ActivityFeed events={page.data} timeZone={timeZone} /> : <p className="text-sm text-muted">No activity yet.</p>)}
    </QueryState>
  );
}

export function LeadDetailPage() {
  const { id } = useParams();
  const { business, isOwner } = useAuth();
  const toast = useToast();
  const query = useLead(id);
  const runAgent = useRunAgent(id);
  const schedule = useScheduleFollowUp(id);
  const [dialog, setDialog] = useState(null);
  const [tab, setTab] = useState('conversation');
  const tz = business?.timezone;

  if (query.isPending) return <LoadingRows rows={6} label="Loading lead" />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={query.error.status === 404 ? undefined : () => query.refetch()} title={query.error.status === 404 ? 'Lead not found' : "Couldn't load this lead"} />
      </Card>
    );
  }
  const lead = query.data;
  const closed = CLOSED.includes(lead.status);

  return (
    <>
      <PageHeader
        title={lead.name}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {lead.company && <span>{lead.company}</span>}
            {lead.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" aria-hidden />{lead.email}</span>}
            {lead.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden />{lead.phone}</span>}
            <span>Source: {SOURCE_LABELS[lead.source]}</span>
            <span>Created <RelativeTime date={lead.createdAt} /></span>
            {!lead.consentEmail && <span className="inline-flex items-center gap-1"><UserX className="h-3.5 w-3.5" aria-hidden />No email consent</span>}
          </span>
        }
        actions={
          <>
            <Button icon={Pencil} onClick={() => setDialog('edit')}>Edit</Button>
            <Button icon={CalendarPlus} disabled={closed} loading={schedule.isPending} onClick={() => schedule.mutate({}, { onSuccess: () => toast.success('Follow-up scheduled', 'The AI will draft it for your approval.'), onError: (e) => toast.error("Couldn't schedule a follow-up", e.message) })}>
              Follow-up
            </Button>
            <Button icon={CalendarDays} disabled={closed} onClick={() => setDialog('book')}>Book</Button>
            <Button onClick={() => setDialog('status')} disabled={!lead.allowedTransitions.length}>Change status</Button>
            <Button variant="primary" icon={Sparkles} disabled={closed} loading={runAgent.isPending} onClick={() => runAgent.mutate({ agent: 'orchestrator' }, { onSuccess: (run) => toast.success('AI finished', NEXT_ACTION_LABELS[run.output?.nextAction] ?? 'See AI decisions.'), onError: (e) => toast.error('AI run failed', e.message) })}>
              {runAgent.isPending ? 'AI is working…' : 'Run AI'}
            </Button>
          </>
        }
      >
        <Link to="/leads" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Leads
        </Link>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <StatusBadge status={lead.status} />
          <ScoreMeter score={lead.score} />
          {isOwner ? <AssigneeSelect lead={lead} /> : lead.assignedTo && <span className="text-xs text-muted">Assigned to {lead.assignedTo.name}</span>}
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
              <Segmented
                label="Lead sections"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'conversation', label: 'Conversation' },
                  { value: 'agents', label: 'AI decisions' },
                  { value: 'lifecycle', label: 'Lifecycle' },
                  { value: 'schedule', label: 'Follow-ups & appointments' },
                ]}
              />
              <Link to={`/conversations/${lead.id}`} className="hidden items-center gap-1 text-sm text-muted hover:text-ink sm:inline-flex">
                <MessagesSquare className="h-3.5 w-3.5" aria-hidden /> Open in inbox
              </Link>
            </div>
            <CardBody>
              {tab === 'conversation' && (
                <div className="space-y-4">
                  <ConversationThread lead={lead} timeZone={tz} />
                  <Composer lead={lead} />
                </div>
              )}
              {tab === 'agents' && <AgentRunsPanel leadId={lead.id} />}
              {tab === 'lifecycle' && <Lifecycle leadId={lead.id} timeZone={tz} />}
              {tab === 'schedule' && (
                <div className="space-y-5">
                  <section>
                    <h3 className="mb-1 text-sm font-semibold text-ink">Appointments</h3>
                    <AppointmentList appointments={lead.appointments} timeZone={tz} />
                  </section>
                  <section>
                    <h3 className="mb-1 text-sm font-semibold text-ink">Follow-ups</h3>
                    <div className="-mx-5"><FollowUpList followUps={lead.followUpJobs} timeZone={tz} /></div>
                  </section>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
        <div className="space-y-5">
          <NextActionCard lead={lead} />
          <DealValueCard lead={lead} />
          <AnalysisCard lead={lead} />
        </div>
      </div>
      {dialog === 'status' && <StatusDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditLeadDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'book' && <BookAppointmentDialog lead={lead} timeZone={tz} onClose={() => setDialog(null)} />}
    </>
  );
}
