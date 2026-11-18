import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateTime, initials, relativeTime } from '../../lib/format.js';

export function PageHeader({ title, description, actions, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {children}
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Segmented control for a small set of mutually exclusive options. */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5 shadow-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            value === o.value ? 'bg-surface-2 text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
          {o.count != null && <span className="ml-1.5 text-xs text-muted tabular">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) return null;
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  return (
    <nav className="flex items-center justify-between border-t border-line px-5 py-3 text-sm text-muted" aria-label="Pagination">
      <span className="tabular">
        {from}–{to} of {meta.total}
      </span>
      <div className="flex gap-1">
        <button type="button" className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40" onClick={() => onPage(meta.page - 1)} disabled={meta.page <= 1} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40" onClick={() => onPage(meta.page + 1)} disabled={meta.page >= meta.totalPages} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}

export function Avatar({ name, className }) {
  return (
    <span className={clsx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink', className)} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function RelativeTime({ date, timeZone, className }) {
  if (!date) return <span className={className}>–</span>;
  return (
    <time dateTime={new Date(date).toISOString()} title={formatDateTime(date, timeZone)} className={className}>
      {relativeTime(date)}
    </time>
  );
}
