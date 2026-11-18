import clsx from 'clsx';
import { BookOpenCheck, Bot, BrainCircuit, CalendarClock, FlaskConical, LayoutDashboard, LineChart, LogOut, Menu, MessagesSquare, Plug, Settings, ShieldCheck, Users, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { GlobalSearch } from '../components/GlobalSearch.jsx';
import { NotificationBell } from '../components/NotificationBell.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { useLiveEvents } from '../lib/liveEvents.js';
import { NavLink, Outlet } from 'react-router';
import { useAiStatus, useApprovals } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Avatar } from '../components/ui/Misc.jsx';
import { Spinner } from '../components/ui/States.jsx';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare, badge: 'approvals' },
  { to: '/follow-ups', label: 'Follow-ups', icon: CalendarClock },
  { to: '/revenue', label: 'Revenue', icon: LineChart },
  { to: '/simulator', label: 'Simulator', icon: FlaskConical },
  { to: '/ai-activity', label: 'AI activity', icon: BrainCircuit },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpenCheck },
  { to: '/autonomy', label: 'Autonomy', icon: ShieldCheck },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2 px-2">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M9 21l5-6 4 3 5-8" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-ink">RevenuePilot</span>
    </div>
  );
}

function Sidebar({ onNavigate }) {
  const { session, business, logout, switchBusiness } = useAuth();
  const approvals = useApprovals({ status: 'PENDING', type: 'OUTBOUND_MESSAGE', pageSize: 1 });
  const ai = useAiStatus();
  const pending = approvals.data?.meta.total ?? 0;

  return (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      <Logo />
      {session?.businesses.length > 1 ? (
        <select
          aria-label="Business"
          value={session.activeBusinessId}
          onChange={(e) => switchBusiness(e.target.value)}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink"
        >
          {session.businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="truncate px-2 text-sm font-medium text-ink-2">{business?.name}</p>
      )}
      <nav aria-label="Main" className="flex-1 space-y-0.5">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
              )
            }
          >
            <item.icon className="h-4 w-4" aria-hidden />
            <span className="flex-1">{item.label}</span>
            {item.badge === 'approvals' && pending > 0 && (
              <span className="rounded-full bg-warning-soft px-1.5 text-xs font-semibold text-warning tabular" aria-label={`${pending} drafts need approval`}>
                {pending}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-3">
        {ai.data && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink-2">
            <Bot className="h-3.5 w-3.5 text-accent" aria-hidden />
            {ai.data.mode === 'live' ? (
              <span>
                Claude · <span className="font-medium text-ink">{ai.data.model}</span>
              </span>
            ) : (
              <span>
                AI: <span className="font-medium text-ink">mock mode</span>
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 px-1">
          <Avatar name={session?.user.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{session?.user.name}</p>
            <p className="truncate text-xs text-muted">{session?.role === 'OWNER' ? 'Owner' : 'Team member'}</p>
          </div>
          <button type="button" onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label="Log out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveIndicator({ connected }) {
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex" title={connected ? 'Receiving live updates' : 'Reconnecting to live updates'}>
      <span className={`h-2 w-2 rounded-full ${connected ? 'bg-good-mark' : 'bg-line-strong'}`} aria-hidden />
      {connected ? 'Live' : 'Offline'}
    </span>
  );
}

/** Mobile navigation drawer: a modal dialog (Escape closes, focus is trapped and restored). */
function MobileNav({ onClose }) {
  const panel = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const focusables = () => [...panel.current.querySelectorAll('a[href], button:not([disabled])')];
    focusables()[0]?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside ref={panel} role="dialog" aria-modal="true" aria-label="Main menu" className="absolute inset-y-0 left-0 w-64 border-r border-line bg-page shadow-xl">
        <button type="button" onClick={onClose} className="absolute top-4 right-3 rounded-md p-1 text-muted" aria-label="Close menu">
          <X className="h-4 w-4" />
        </button>
        <Sidebar onNavigate={onClose} />
      </aside>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  const toast = useToast();
  const onNotification = useCallback((n) => n.priority === 'URGENT' && toast.success('New alert', n.message), [toast]);
  const live = useLiveEvents(onNotification);
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-line bg-page lg:block">
        <Sidebar />
      </aside>
      {open && <MobileNav onClose={closeMenu} />}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-page/90 px-4 py-2.5 backdrop-blur sm:px-6 lg:px-8">
          <button type="button" onClick={() => setOpen(true)} className="rounded-md p-1.5 text-ink-2 lg:hidden" aria-label="Open menu" aria-expanded={open} aria-haspopup="dialog">
            <Menu className="h-5 w-5" />
          </button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator connected={live} />
            <NotificationBell />
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
          <Suspense fallback={<div className="flex min-h-64 items-center justify-center text-muted" role="status" aria-label="Loading page"><Spinner /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
