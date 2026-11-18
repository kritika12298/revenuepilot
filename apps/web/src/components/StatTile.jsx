import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Skeleton } from './ui/States.jsx';
import { InfoTip } from './ui/InfoTip.jsx';

/**
 * Stat tile: label, value (proportional figures), optional comparison with a
 * named period. Direction is shown with an arrow and words, not colour alone.
 */
export function StatTile({ label, value, hint, delta, icon: Icon, loading, dim, info, scope }) {
  return (
    <div
      className={clsx(
        'flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[opacity,border-color] hover:border-line-strong',
        dim && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1 text-sm text-ink-2">
          <span className="line-clamp-2" title={label}>{label}</span>
          {info && <InfoTip label={`How ${label.toLowerCase()} is calculated`}>{info}</InfoTip>}
        </p>
        {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-20" />
      ) : (
        <p className="mt-2 text-3xl font-semibold tracking-tight text-ink">{value}</p>
      )}
      <div className="mt-auto flex min-h-5 flex-wrap items-center gap-1.5 pt-1.5 text-xs text-muted">
        {!loading && scope && (
          <span className="rounded border border-line px-1 text-[10px] font-medium tracking-wide text-ink-2 uppercase" title="Current state; not affected by the date range">
            {scope}
          </span>
        )}
        {!loading && delta && <Delta {...delta} />}
        {!loading && hint && <span>{hint}</span>}
      </div>
    </div>
  );
}

function Delta({ value, period, upIsGood = true }) {
  if (value == null) return null;
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  const good = value === 0 ? null : (value > 0) === upIsGood;
  return (
    <span className={clsx('inline-flex items-center gap-0.5 font-medium', good === true && 'text-good', good === false && 'text-critical')}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {value > 0 ? '+' : ''}
      {value}
      <span className="sr-only"> {value >= 0 ? 'more' : 'fewer'}</span>
      <span className="font-normal text-muted"> vs {period}</span>
    </span>
  );
}
