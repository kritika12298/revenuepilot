import clsx from 'clsx';
import { Info } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * Small "i" button with an explanation. Opens on hover and keyboard focus,
 * closes on Escape; the text is linked via aria-describedby for screen readers.
 */
export function InfoTip({ label, children, align = 'right', className }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={clsx('relative inline-flex', className)} onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-0.5 text-muted hover:bg-surface-2 hover:text-ink"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={clsx(
          'absolute top-full z-30 mt-1.5 w-64 rounded-lg border border-line bg-surface p-2.5 text-xs leading-relaxed font-normal text-ink-2 shadow-lg',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </span>
    </span>
  );
}
