import { AlertTriangle, CalendarClock, CalendarX2, Check, Eye, Mail, PenLine } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApprove, useFollowUps } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { CancelFollowUpDialog, RescheduleDialog } from '../components/FollowUpDialogs.jsx';
import { ACTIVE } from '../components/FollowUpList.jsx';
import { FollowUpStatusBadge, StatusBadge } from '../components/StatusBadge.jsx';
import { AppointmentList } from '../components/Appointments.jsx';
import { useAppointments } from '../api/hooks.js';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Textarea } from '../components/ui/Field.jsx';
import { Avatar, PageHeader, Pagination, RelativeTime, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { formatDateTime } from '../lib/format.js';

const TABS = {
  upcoming: { label: 'Upcoming', statuses: ACTIVE, empty: 'No follow-ups planned. They are created after each email to a consenting lead.' },
  sent: { label: 'Sent', statuses: ['SENT'], empty: 'No follow-ups have been sent yet.' },
  stopped: { label: 'Stopped', statuses: ['CANCELLED', 'SKIPPED', 'FAILED'], empty: 'Nothing was cancelled, skipped or failed.' },
  appointments: { label: 'Appointments' },
};

function AppointmentsTab({ timeZone }) {
  const query = useAppointments({ from: new Date(Date.now() - 7 * 86_400_000).toISOString() });
  if (query.isPending) return <LoadingRows rows={4} label="Loading appointments" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <div className="px-5"><AppointmentList appointments={query.data.data} timeZone={timeZone} showLead /></div>;
}

function preview(fu) {
  if (fu.status === 'DRAFTING') return 'The AI is writing this follow-up…';
  const lines = (fu.message?.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Skip a bare greeting line ("Hi Hannah,") but keep greetings that carry the message.
  return lines.find((l) => !/^(hi|hello|dear)\b[^.!?]*,$/i.test(l)) ?? lines[0] ?? '–';
}

function PreviewDrawer({ followUp, timeZone, onClose, onReschedule, onCancel }) {
  const { isOwner } = useAuth();
  const toast = useToast();
  const approve = useApprove();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(followUp.message?.body ?? '');
  const approval = followUp.message?.approvals?.find((a) => a.status === 'PENDING');
  const active = ACTIVE.includes(followUp.status);
  const delivery = followUp.message?.delivery;

  return (
    <Dialog open side onClose={onClose} title={`Follow-up ${followUp.step} to ${followUp.lead.name}`} description={formatDateTime(followUp.scheduledFor, timeZone)}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <FollowUpStatusBadge status={followUp.status} />
          <StatusBadge status={followUp.lead.status} />
          {!followUp.lead.consentEmail && (
            <Badge tone="warning" icon={AlertTriangle}>
              No email consent
            </Badge>
          )}
        </div>

        {followUp.message ? (
          <div className="rounded-xl border border-line bg-page p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs text-muted">
              <Mail className="h-3.5 w-3.5" aria-hidden /> Email preview
            </p>
            {followUp.message.subject && <p className="mb-2 text-sm font-semibold text-ink">{followUp.message.subject}</p>}
            {editing ? (
              <Field label="Message">{(p) => <Textarea {...p} rows={10} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
            ) : (
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{followUp.message.body}</p>
            )}
            <p className="mt-3 border-t border-line pt-2 text-xs text-muted">An unsubscribe link is added automatically.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">{preview(followUp)}</p>
        )}

        {followUp.skipReason && <p className="text-sm text-ink-2">Reason: {followUp.skipReason}</p>}
        {delivery && (
          <p className="text-sm text-ink-2">
            Delivery: {delivery.status.toLowerCase()} via {delivery.provider}
            {delivery.attempts > 1 && ` after ${delivery.attempts} attempts`}
            {delivery.lastError && <span className="block text-critical">{delivery.lastError}</span>}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {approval && isOwner && (
            <>
              <Button
                variant="primary"
                icon={Check}
                loading={approve.isPending}
                onClick={() =>
                  approve.mutate(
                    { id: approval.id, ...(editing && body !== followUp.message.body ? { body } : {}) },
                    {
                      onSuccess: () => {
                        toast.success('Follow-up approved', `It will be sent ${formatDateTime(followUp.scheduledFor, timeZone)}.`);
                        onClose();
                      },
                      onError: (e) => toast.error('Could not approve', e.message),
                    },
                  )
                }
              >
                {editing ? 'Save & approve' : 'Approve'}
              </Button>
              {!editing && (
                <Button icon={PenLine} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </>
          )}
          {active && (
            <>
              <Button icon={CalendarClock} onClick={onReschedule}>
                Reschedule
              </Button>
              <Button variant="danger" icon={CalendarX2} onClick={onCancel}>
                Cancel
              </Button>
            </>
          )}
          <Link to={`/leads/${followUp.lead.id}`} className="inline-flex h-9 items-center px-2 text-sm font-medium text-accent hover:underline">
            View lead
          </Link>
        </div>
      </div>
    </Dialog>
  );
}

export function FollowUpsPage() {
  const { business } = useAuth();
  const tz = business?.timezone;
  const [tab, setTab] = useState('upcoming');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(null);
  const query = useFollowUps({ status: TABS[tab].statuses ?? ['SENT'], page, pageSize: 20 });

  const open = (fu, next) => {
    setSelected(fu);
    setAction(next);
  };
  const close = () => {
    setSelected(null);
    setAction(null);
  };

  return (
    <>
      <PageHeader title="Follow-ups & appointments" description={`Automated check-ins and bookings, only during working hours${tz ? ` (${tz})` : ''}.`} />
      <div className="mb-4">
        <Segmented
          label="Follow-up status"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
          }}
          options={Object.entries(TABS).map(([value, t]) => ({ value, label: t.label }))}
        />
      </div>
      <Card>
        {tab === 'appointments' ? (
          <AppointmentsTab timeZone={tz} />
        ) : query.isPending ? (
          <LoadingRows rows={6} label="Loading follow-ups" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load follow-ups" />
        ) : query.data.data.length === 0 ? (
          <EmptyState icon={CalendarClock} title={`No ${TABS[tab].label.toLowerCase()} follow-ups`} description={TABS[tab].empty} />
        ) : (
          <div className={query.isPlaceholderData ? 'opacity-60' : undefined}>
            <ul className="divide-y divide-line">
              {query.data.data.map((fu) => (
                <li key={fu.id} className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-surface-2/50">
                  <Avatar name={fu.lead.name} />
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/leads/${fu.lead.id}`} className="font-medium text-ink hover:underline">
                        {fu.lead.name}
                      </Link>
                      <span className="text-xs text-muted">Follow-up {fu.step}</span>
                      <FollowUpStatusBadge status={fu.status} />
                    </div>
                    <p className="mt-1 truncate text-sm text-ink-2">{preview(fu)}</p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="text-ink">{formatDateTime(fu.scheduledFor, tz)}</p>
                    <p className="text-xs text-muted">
                      <RelativeTime date={fu.scheduledFor} timeZone={tz} />
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" onClick={() => open(fu, 'preview')} aria-label={`Preview follow-up to ${fu.lead.name}`}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    {ACTIVE.includes(fu.status) && (
                      <>
                        <Button size="icon" variant="ghost" onClick={() => open(fu, 'reschedule')} aria-label={`Reschedule follow-up to ${fu.lead.name}`}>
                          <CalendarClock className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => open(fu, 'cancel')} aria-label={`Cancel follow-up to ${fu.lead.name}`}>
                          <CalendarX2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination meta={query.data.meta} onPage={setPage} />
          </div>
        )}
      </Card>
      {selected && action === 'preview' && (
        <PreviewDrawer followUp={selected} timeZone={tz} onClose={close} onReschedule={() => setAction('reschedule')} onCancel={() => setAction('cancel')} />
      )}
      {selected && action === 'reschedule' && <RescheduleDialog followUp={selected} timeZone={tz} onClose={close} />}
      {selected && action === 'cancel' && <CancelFollowUpDialog followUp={selected} onClose={close} />}
    </>
  );
}
