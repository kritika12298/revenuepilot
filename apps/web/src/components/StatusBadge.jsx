import { Ban, CalendarCheck, CheckCircle2, CircleDashed, Clock, MessageCircle, Search, Send, Sparkles, XCircle, AlertTriangle, PenLine } from 'lucide-react';
import { Badge } from './ui/Badge.jsx';
import { FOLLOW_UP_STATUS_LABELS, STATUS_LABELS } from '../lib/constants.js';

/** Lead status: icon + text; only outcome states use status colours. */
const LEAD = {
  NEW: { icon: Sparkles, tone: 'accent' },
  QUALIFYING: { icon: Search, tone: 'neutral' },
  QUALIFIED: { icon: CheckCircle2, tone: 'accent' },
  CONTACTED: { icon: Send, tone: 'neutral' },
  ENGAGED: { icon: MessageCircle, tone: 'neutral' },
  APPOINTMENT_BOOKED: { icon: CalendarCheck, tone: 'neutral' },
  WON: { icon: CheckCircle2, tone: 'good' },
  LOST: { icon: XCircle, tone: 'neutral' },
  OPTED_OUT: { icon: Ban, tone: 'neutral' },
};

export function StatusBadge({ status }) {
  const s = LEAD[status] ?? { icon: CircleDashed, tone: 'neutral' };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const FOLLOW_UP = {
  DRAFTING: { icon: PenLine, tone: 'neutral' },
  PENDING_APPROVAL: { icon: AlertTriangle, tone: 'warning' },
  SCHEDULED: { icon: Clock, tone: 'accent' },
  SENT: { icon: CheckCircle2, tone: 'good' },
  CANCELLED: { icon: Ban, tone: 'neutral' },
  SKIPPED: { icon: CircleDashed, tone: 'neutral' },
  FAILED: { icon: XCircle, tone: 'critical' },
};

export function FollowUpStatusBadge({ status }) {
  const s = FOLLOW_UP[status] ?? { icon: CircleDashed, tone: 'neutral' };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {FOLLOW_UP_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
