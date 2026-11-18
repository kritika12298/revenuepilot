import clsx from 'clsx';

const TONES = {
  neutral: 'bg-surface-2 text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent-ink border-transparent',
  good: 'bg-good-soft text-good border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  critical: 'bg-critical-soft text-critical border-transparent',
};

/** Small label. Colour never carries meaning alone: pass an icon or clear text. */
export function Badge({ tone = 'neutral', icon: Icon, className, children }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}
