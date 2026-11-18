import clsx from 'clsx';

/**
 * Lead score 0-100 as a meter: one hue (magnitude, not good/bad), the track a
 * lighter step of the same ramp. The number is always shown as text.
 */
export function ScoreMeter({ score, className }) {
  if (score == null) return <span className={clsx('text-sm text-muted', className)}>Not scored</span>;
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <span className="w-7 text-right text-sm font-semibold text-ink tabular">{score}</span>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-accent-soft"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label="Lead score"
      >
        <div className="h-full rounded-full bg-series-1" style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

/** One score component with its maximum, e.g. urgency 27/35. */
export function ScoreComponent({ label, value, max }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-ink-2">{label}</span>
        <span className="text-ink tabular">
          <span className="font-semibold">{value}</span>
          <span className="text-muted">/{max}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft" aria-hidden>
        <div className="h-full rounded-full bg-series-1" style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}
