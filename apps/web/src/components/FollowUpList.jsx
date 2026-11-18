import { CalendarClock, CalendarX2, Clock3 } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';
import { CancelFollowUpDialog, RescheduleDialog } from './FollowUpDialogs.jsx';
import { FollowUpStatusBadge } from './StatusBadge.jsx';
import { Button } from './ui/Button.jsx';
import { RelativeTime } from './ui/Misc.jsx';
import { EmptyState } from './ui/States.jsx';

export const ACTIVE = ['DRAFTING', 'PENDING_APPROVAL', 'SCHEDULED'];

/** Compact follow-up list with cancel / reschedule actions. */
export function FollowUpList({ followUps, timeZone, emptyIcon = CalendarClock }) {
  const [rescheduling, setRescheduling] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  if (!followUps?.length) {
    return <EmptyState icon={emptyIcon} title="No follow-ups" description="Follow-ups are planned automatically after each email to a consenting lead." className="py-8" />;
  }
  return (
    <>
      <ul className="divide-y divide-line">
        {followUps.map((fu) => (
          <li key={fu.id} className="px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">Follow-up {fu.step}</span>
              <FollowUpStatusBadge status={fu.status} />
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <Clock3 className="h-3.5 w-3.5" aria-hidden />
              {formatDateTime(fu.scheduledFor, timeZone)} · <RelativeTime date={fu.scheduledFor} timeZone={timeZone} />
            </p>
            {fu.skipReason && <p className="mt-1 text-xs text-ink-2">{fu.skipReason}</p>}
            {ACTIVE.includes(fu.status) && (
              <div className="mt-2 flex gap-1">
                <Button size="sm" variant="ghost" icon={CalendarClock} onClick={() => setRescheduling(fu)}>
                  Reschedule
                </Button>
                <Button size="sm" variant="ghost" icon={CalendarX2} onClick={() => setCancelling(fu)}>
                  Cancel
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rescheduling && <RescheduleDialog followUp={rescheduling} timeZone={timeZone} onClose={() => setRescheduling(null)} />}
      {cancelling && <CancelFollowUpDialog followUp={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}
