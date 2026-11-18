import clsx from 'clsx';
import { Spinner } from './States.jsx';

const VARIANTS = {
  primary: 'bg-accent text-white hover:brightness-110 shadow-sm',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2 shadow-sm',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-surface text-critical border border-line hover:bg-critical-soft',
};
const SIZES = { sm: 'h-8 px-2.5 text-sm gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', icon: 'h-8 w-8 justify-center' };

export function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon, className, children, disabled, ...props }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex items-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
      {children}
    </button>
  );
}
