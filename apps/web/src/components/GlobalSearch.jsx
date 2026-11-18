import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Search, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { StatusBadge } from './StatusBadge.jsx';
import { Spinner } from './ui/States.jsx';

/** Global search across leads and conversations. Ctrl/⌘+K to focus, arrows + Enter to open. */
export function GlobalSearch() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useQuery({ queryKey: ['search', debounced], queryFn: () => api('/search', { query: { q: debounced } }), enabled: debounced.length >= 2 });
  const items = [
    ...(results.data?.leads ?? []).map((l) => ({ key: `l-${l.id}`, to: `/leads/${l.id}`, kind: 'lead', l })),
    ...(results.data?.messages ?? []).map((m) => ({ key: `m-${m.id}`, to: `/conversations/${m.lead.id}`, kind: 'message', m })),
  ];
  const go = (item) => {
    navigate(item.to);
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
  };

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && debounced.length >= 2}
        aria-controls="global-search-results"
        aria-label="Search leads and conversations"
        placeholder="Search leads and conversations"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && items[active]) go(items[active]);
          if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
        }}
        className="h-9 w-full rounded-lg border border-line bg-surface pr-14 pl-9 text-sm text-ink placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none"
      />
      <kbd className="pointer-events-none absolute top-2 right-2.5 rounded border border-line px-1.5 text-[10px] text-muted">⌘K</kbd>
      {open && debounced.length >= 2 && (
        <div id="global-search-results" role="listbox" className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          {results.isPending ? (
            <div className="p-4 text-muted"><Spinner className="h-4 w-4" /></div>
          ) : results.isError ? (
            <p className="p-4 text-sm text-critical">{results.error.message}</p>
          ) : !items.length ? (
            <p className="p-4 text-sm text-muted">No leads or messages match &ldquo;{debounced}&rdquo;.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">
              {items.map((item, i) => (
                <li key={item.key} role="option" aria-selected={i === active}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(item)} onMouseEnter={() => setActive(i)} className={`flex w-full items-start gap-2.5 px-3 py-2 text-left ${i === active ? 'bg-surface-2' : ''}`}>
                    {item.kind === 'lead' ? (
                      <>
                        <User className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{item.l.name}</span>
                          <span className="block truncate text-xs text-muted">{item.l.company || item.l.email}</span>
                        </span>
                        <StatusBadge status={item.l.status} />
                      </>
                    ) : (
                      <>
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{item.m.lead.name}</span>
                          <span className="block text-xs text-ink-2">{item.m.snippet}</span>
                        </span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
