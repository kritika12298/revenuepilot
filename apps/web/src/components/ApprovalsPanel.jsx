import { BadgePercent, CalendarDays, Check, ClipboardCheck, FileText, Mail, X } from 'lucide-react';
import { Link } from 'react-router';
import { useApprovals, useApprove, useReject } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { formatDateTime } from '../lib/format.js';
import { NEXT_ACTION_LABELS } from '../lib/constants.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { Card, CardHeader } from './ui/Card.jsx';
import { Avatar, RelativeTime } from './ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from './ui/States.jsx';
import { useToast } from './ui/Toast.jsx';

/** What the approval is for, what the AI recommends and a preview of it. */
export function describeApproval(a, timeZone) {
  const p = a.payload ?? {};
  if (a.type === 'OUTBOUND_MESSAGE') {
    const fu = a.message?.followUpJob;
    return {
      icon: Mail,
      action: fu ? `Follow-up ${fu.step} email` : 'Reply email',
      recommendation: fu ? `Send this follow-up ${formatDateTime(fu.scheduledFor, timeZone)}` : 'Send this reply now',
      preview: a.message ? { label: a.message.subject ?? 'Message', text: a.message.body } : null,
      onApprove: fu ? 'Scheduled; it will be sent at its planned time, within working hours.' : 'Queued; it will be emailed shortly.',
    };
  }
  if (a.type === 'DISCOUNT') {
    const value = p.value ?? p.percent;
    const what = value ? `${value}% off${p.appliesTo ? ` ${p.appliesTo}` : ''}${p.condition ? ` (${p.condition})` : ''}` : (p.summary ?? 'a discount');
    return {
      icon: BadgePercent,
      action: 'Discount request',
      recommendation: `Decide whether to offer ${what}`,
      preview: { label: 'Requested', text: what },
      onApprove: 'Decision recorded. Tell the customer in your reply.',
    };
  }
  if (a.type === 'APPOINTMENT') {
    return {
      icon: CalendarDays,
      action: 'Appointment',
      recommendation: `Confirm ${(p.title ?? 'appointment').toLowerCase()} on ${formatDateTime(p.startsAt, timeZone)}`,
      preview: { label: 'Proposed by the Meeting Agent', text: `${p.title ?? 'Appointment'} · ${p.durationMinutes ?? 60} minutes · ${formatDateTime(p.startsAt, timeZone)}` },
      onApprove: 'Booked: calendar event created and the customer emailed (consent permitting).',
    };
  }
  if (a.type === 'CONTRACT' || a.type === 'CUSTOM_PRICE') {
    return {
      icon: FileText,
      action: a.type === 'CONTRACT' ? 'Contract request' : 'Custom pricing',
      recommendation: p.summary ?? 'Review this request',
      preview: null,
      onApprove: 'Decision recorded. Follow up with the customer.',
    };
  }
  if (a.type === 'QUOTE') {
    return {
      icon: FileText,
      action: 'Quote request',
      recommendation: 'Prepare a quote for this customer',
      preview: null,
      onApprove: 'Decision recorded. Send the quote in your reply.',
    };
  }
  return { icon: ClipboardCheck, action: 'Decision needed', recommendation: 'Review this request', preview: null, onApprove: 'Decision recorded.' };
}

function ApprovalItem({ approval, timeZone }) {
  const { isOwner } = useAuth();
  const toast = useToast();
  const approve = useApprove();
  const reject = useReject();
  const d = describeApproval(approval, timeZone);
  const reason = approval.aiRationale ?? approval.agentRun?.parentRun?.output?.rationale;
  const decision = approval.agentRun?.parentRun?.output?.nextAction;
  const busy = approve.isPending || reject.isPending;
  const name = approval.lead?.name ?? 'Unknown lead';

  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <Avatar name={name} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{name}</span>
            <Badge icon={d.icon}>{d.action}</Badge>
            <span className="text-xs text-muted">
              <RelativeTime date={approval.createdAt} timeZone={timeZone} />
            </span>
          </div>
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="sr-only">AI recommendation</dt>
              <dd className="font-medium text-ink">{d.recommendation}</dd>
            </div>
            {(reason || decision) && (
              <div>
                <dt className="inline text-muted">Why: </dt>
                <dd className="inline text-ink-2">{reason ?? NEXT_ACTION_LABELS[decision]}</dd>
              </div>
            )}
          </dl>
          {d.preview && (
            <blockquote className="rounded-lg border border-line bg-page px-3 py-2 text-sm">
              <p className="text-xs font-medium text-muted">{d.preview.label}</p>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-ink">{d.preview.text}</p>
            </blockquote>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {isOwner ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={Check}
                  loading={approve.isPending}
                  disabled={busy}
                  onClick={() =>
                    approve.mutate(
                      { id: approval.id },
                      { onSuccess: () => toast.success(`Approved for ${name}`, d.onApprove), onError: (e) => toast.error('Could not approve', e.message) },
                    )
                  }
                  aria-label={`Approve ${d.action.toLowerCase()} for ${name}`}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={X}
                  loading={reject.isPending}
                  disabled={busy}
                  onClick={() =>
                    reject.mutate(
                      { id: approval.id },
                      { onSuccess: () => toast.success(`Rejected for ${name}`), onError: (e) => toast.error('Could not reject', e.message) },
                    )
                  }
                  aria-label={`Reject ${d.action.toLowerCase()} for ${name}`}
                >
                  Reject
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted">Only the owner can approve.</span>
            )}
            {approval.lead && (
              <Link to={`/conversations/${approval.lead.id}`} className="ml-auto text-sm font-medium text-accent hover:underline">
                Review details
              </Link>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function ApprovalsPanel({ timeZone, limit = 4 }) {
  const query = useApprovals({ status: 'PENDING', pageSize: limit });
  const total = query.data?.meta.total ?? 0;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Needs your approval"
        description={total ? `${total} item${total > 1 ? 's' : ''} waiting · nothing is sent until you approve` : 'AI drafts and requests waiting for your decision'}
        actions={
          total > limit && (
            <Link to="/conversations" className="text-sm font-medium text-accent hover:underline">
              View all {total}
            </Link>
          )
        }
      />
      {query.isPending ? (
        <LoadingRows rows={3} label="Loading approvals" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load approvals" />
      ) : query.data.data.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="You're all caught up" description="New AI drafts and requests will appear here." />
      ) : (
        <ul className="divide-y divide-line">
          {query.data.data.map((a) => (
            <ApprovalItem key={a.id} approval={a} timeZone={timeZone} />
          ))}
        </ul>
      )}
    </Card>
  );
}
