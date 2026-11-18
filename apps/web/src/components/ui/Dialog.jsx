import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

/**
 * Modal built on the native <dialog> element: focus trapping, Esc to close and
 * an inert background come from the browser.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', side = false }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className={clsx(
        'bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[1px]',
        side
          ? 'm-0 ml-auto h-full max-h-none w-full max-w-xl border-l border-line'
          : clsx('m-auto w-[calc(100%-2rem)] rounded-xl border border-line', size === 'lg' ? 'max-w-2xl' : 'max-w-md'),
      )}
    >
      {open && (
        <div className={clsx('flex flex-col', side && 'h-full')}>
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className={clsx('px-5 py-4', side && 'flex-1 overflow-y-auto')}>{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
