import clsx from 'clsx';

export function Card({ className, children, ...props }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]', className)} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions, className }) {
  return (
    <header className={clsx('flex items-start justify-between gap-4 border-b border-line px-5 py-4', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, children }) {
  return <div className={clsx('px-5 py-4', className)}>{children}</div>;
}
