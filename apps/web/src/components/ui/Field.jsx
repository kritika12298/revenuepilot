import clsx from 'clsx';
import { useId } from 'react';

const base =
  'rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted shadow-sm transition-colors ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted';

/** Width/height defaults apply only when the caller doesn't set its own (clsx doesn't dedupe Tailwind classes). */
const control = (className, height) =>
  clsx(base, !/(^|\s)!?(w|max-w|min-w)-|(^|\s)w-\S+!/.test(className ?? '') && 'w-full', !/(^|\s)h-/.test(className ?? '') && height, className);

/** Label + control + hint/error, wired up with ids for screen readers. */
export function Field({ label, hint, error, children, className }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {label}
        </label>
      )}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = ({ className, ...props }) => <input className={control(className, 'h-9')} {...props} />;
export const Textarea = ({ className, ...props }) => <textarea className={clsx(control(className), 'min-h-24 py-2 leading-relaxed')} {...props} />;
export const Select = ({ className, children, ...props }) => (
  <select className={clsx(control(className, 'h-9'), 'pr-8')} {...props}>
    {children}
  </select>
);

export function Switch({ checked, onChange, label, description, disabled }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span className={clsx('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}
