import { Bot, Cog, MessageCircle, User } from 'lucide-react';
import { Link } from 'react-router';
import { RelativeTime } from './ui/Misc.jsx';
import { FOLLOW_UP_STATUS_LABELS, LOST_REASONS, STATUS_LABELS } from '../lib/constants.js';
import { formatDateTime, titleCase } from '../lib/format.js';
import { NEXT_ACTION_LABELS } from '../lib/constants.js';

/** Event type -> category shown as a consistent label on every row. */
export const EVENT_CATEGORIES = {
  customer: { label: 'Customer', types: ['CREATED', 'MESSAGE_RECEIVED', 'OPTED_OUT'] },
  qualification: { label: 'Qualification', types: ['ANALYSIS_UPDATED', 'SCORE_UPDATED', 'STATUS_CHANGED', 'UPDATED'] },
  ai: { label: 'AI decision', types: ['AGENT_DECISION', 'APPROVAL_REQUESTED', 'OWNER_NOTIFIED', 'FOLLOW_UP_DRAFTED'] },
  followUps: { label: 'Follow-up', types: ['FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_RESCHEDULED', 'FOLLOW_UP_SKIPPED', 'FOLLOW_UP_FAILED', 'FOLLOW_UP_CANCELLED'] },
  messages: { label: 'Message', types: ['MESSAGE_SENT', 'MESSAGE_FAILED', 'NOTE'] },
  approvals: { label: 'Approval', types: ['APPROVAL_DECIDED'] },
};
const CATEGORY_OF = Object.fromEntries(Object.values(EVENT_CATEGORIES).flatMap((c) => c.types.map((t) => [t, c.label])));

const ACTOR = {
  AI: { icon: Bot, label: 'AI' },
  USER: { icon: User, label: 'Team' },
  SYSTEM: { icon: Cog, label: 'Automation' },
  LEAD: { icon: MessageCircle, label: 'Lead' },
};

/** Human sentence for a lead timeline event. */
export function describeEvent(e, timeZone) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'CREATED':
      return `New lead via ${titleCase(d.source ?? 'manual')}`;
    case 'UPDATED':
      return `Updated ${(d.fields ?? []).join(', ') || 'details'}`;
    case 'STATUS_CHANGED':
      return `Moved from ${STATUS_LABELS[d.from] ?? d.from} to ${STATUS_LABELS[d.to] ?? d.to}${d.lostReason ? ` (${LOST_REASONS[d.lostReason]})` : ''}`;
    case 'SCORE_UPDATED':
      return `Scored ${d.to}/100${d.method === 'AI' ? ' by AI' : d.method === 'OVERRIDE' ? ' (manual override)' : d.method === 'SEED' ? ' (demo data)' : ''}`;
    case 'ANALYSIS_UPDATED':
      return `AI analysed the enquiry${d.intent ? `: ${d.intent.toLowerCase()} intent` : ''}`;
    case 'MESSAGE_RECEIVED':
      return 'Message received';
    case 'MESSAGE_SENT':
      return d.kind === 'FOLLOW_UP' ? 'Follow-up email sent' : 'Email sent';
    case 'MESSAGE_FAILED':
      return `Email not sent: ${d.reason ?? 'delivery failed'}`;
    case 'APPROVAL_REQUESTED':
      return 'AI drafted a message for approval';
    case 'APPROVAL_DECIDED':
      return `${d.decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${titleCase(d.type ?? 'item').toLowerCase()}${d.edited ? ' (edited)' : ''}`;
    case 'OWNER_NOTIFIED':
      return `Owner alerted: ${titleCase(d.reason ?? '').toLowerCase()}`;
    case 'FOLLOW_UP_SCHEDULED':
      return d.scheduledFor ? `Follow-up ${d.step ?? ''} planned for ${formatDateTime(d.scheduledFor, timeZone)}` : `Follow-up ${d.step ?? ''} scheduled`;
    case 'FOLLOW_UP_DRAFTED':
      return 'AI drafted a follow-up';
    case 'FOLLOW_UP_RESCHEDULED':
      return `Follow-up moved to ${formatDateTime(d.to, timeZone)}${d.reason ? ` (${d.reason.toLowerCase()})` : ''}`;
    case 'FOLLOW_UP_SKIPPED':
      return `Follow-up skipped: ${d.reason}`;
    case 'FOLLOW_UP_FAILED':
      return `Follow-up failed: ${d.reason}`;
    case 'FOLLOW_UP_CANCELLED':
      return `Follow-up ${FOLLOW_UP_STATUS_LABELS.CANCELLED.toLowerCase()}${d.reason ? `: ${d.reason}` : ''}`;
    case 'OPTED_OUT':
      return 'Unsubscribed from emails';
    case 'AGENT_DECISION':
      return `AI decided: ${(NEXT_ACTION_LABELS[d.nextAction] ?? titleCase(d.nextAction ?? 'next step')).toLowerCase()}`;
    case 'NOTE':
      return d.action === 'OWNER_REPLY_QUEUED' ? 'Reply queued for sending' : 'Note added';
    default:
      return titleCase(e.type);
  }
}

const eventData = (e) => e.data ?? {};

export function ActivityFeed({ events, showLead = false, timeZone }) {
  return (
    <ol className="relative space-y-4">
      {events.map((e, i) => {
        const actor = ACTOR[e.actorType] ?? ACTOR.SYSTEM;
        return (
          <li key={e.id} className="relative flex gap-3">
            {i < events.length - 1 && <span className="absolute top-7 bottom-[-1rem] left-[13px] w-px bg-line" aria-hidden />}
            <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted" title={actor.label}>
              <actor.icon className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">{actor.label}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                {showLead && e.lead && (
                  <>
                    <Link to={`/leads/${e.lead.id}`} className="font-medium hover:underline">
                      {e.lead.name}
                    </Link>
                    <span className="text-muted"> · </span>
                  </>
                )}
                {describeEvent(e, timeZone)}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                <span className="rounded bg-surface-2 px-1.5 py-px font-medium text-ink-2">{CATEGORY_OF[e.type] ?? 'Update'}</span>
                <span>{actor.label}{e.actorUser && ` (${e.actorUser.name})`}</span>
                <span aria-hidden>·</span>
                <RelativeTime date={e.createdAt} timeZone={timeZone} />
                <span aria-hidden>·</span>
                <span>{formatDateTime(e.createdAt, timeZone)}</span>
              </p>
              {e.type === 'AGENT_DECISION' && eventData(e).rationale && <p className="mt-1 text-xs text-ink-2">{eventData(e).rationale}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
