import clsx from 'clsx';
import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '../api/hooks.js';
import { RelativeTime } from './ui/Misc.jsx';
import { EmptyState, LoadingRows } from './ui/States.jsx';

/** Notification centre: unread count, latest alerts, mark read. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const count = useUnreadCount();
  const list = useNotifications({ pageSize: 15 });
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const unread = count.data?.count ?? 0;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    const onClick = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative rounded-lg p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-critical-mark px-1 text-center text-[10px] leading-4 font-semibold text-white tabular">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-xl" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            <button type="button" onClick={() => markAll.mutate()} disabled={!unread} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-40">
              <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
            </button>
          </div>
          <div className="max-h-[26rem] overflow-y-auto">
            {list.isPending ? (
              <LoadingRows rows={3} />
            ) : !list.data?.data.length ? (
              <EmptyState icon={Bell} title="No notifications" description="Important events from your agents appear here." className="py-8" />
            ) : (
              <ul className="divide-y divide-line">
                {list.data.data.map((n) => (
                  <li key={n.id} className={clsx('px-4 py-3', !n.readAt && 'bg-accent-soft/40')}>
                    <div className="flex items-start gap-2">
                      {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink">{n.message}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {n.priority === 'URGENT' && <span className="font-medium text-critical">Urgent · </span>}
                          <RelativeTime date={n.createdAt} />
                          {n.lead && <> · <Link to={`/leads/${n.lead.id}`} onClick={() => { setOpen(false); if (!n.readAt) markRead.mutate(n.id); }} className="text-accent hover:underline">{n.lead.name}</Link></>}
                        </p>
                      </div>
                      {!n.readAt && <button type="button" onClick={() => markRead.mutate(n.id)} className="text-xs text-muted hover:text-ink" aria-label="Mark as read">Read</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
