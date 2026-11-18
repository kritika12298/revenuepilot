import { ArrowDown } from 'lucide-react';
import { useState } from 'react';
import { STATUS_LABELS } from '../../lib/constants.js';
import { formatPercent } from '../../lib/format.js';

/**
 * Conversion funnel: one series (single colour), bars sized by share of all
 * leads, count and share at the tip, step conversion between rows. Rows are
 * hover/focus targets with a tooltip; layout reflows on narrow screens.
 */
/** Biggest step-to-step drop among stages with at least 2 leads entering. */
export function biggestDrop(steps) {
  let worst = null;
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i - 1].count < 2 || steps[i].stepConversion == null) continue;
    if (!worst || steps[i].stepConversion < worst.rate) worst = { from: steps[i - 1].stage, to: steps[i].stage, rate: steps[i].stepConversion };
  }
  return worst;
}

export function Funnel({ steps }) {
  const [active, setActive] = useState(null);
  const drop = biggestDrop(steps);
  const won = steps.at(-1);
  return (
    <div className="flex h-full flex-col">
    <ol className="space-y-0.5 px-5 py-4" aria-label="Conversion funnel">
      {steps.map((s, i) => (
        <li key={s.stage}>
          {i > 0 && (
            <p className="flex items-center gap-1 py-0.5 pl-1 text-[11px] text-muted sm:pl-[9.5rem]" aria-hidden>
              <ArrowDown className="h-3 w-3" />
              {s.stepConversion == null ? '–' : `${formatPercent(s.stepConversion)} moved on`}
            </p>
          )}
          <div
            tabIndex={0}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            aria-label={`${STATUS_LABELS[s.stage]}: ${s.count} leads, ${formatPercent(s.percentOfTotal)} of all leads${s.stepConversion != null ? `, ${formatPercent(s.stepConversion)} of the previous stage` : ''}`}
            className="relative grid grid-cols-1 gap-1 rounded-md px-1 py-1 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 sm:grid-cols-[9rem_1fr] sm:items-center sm:gap-3"
          >
            <span className="text-sm text-ink-2">{STATUS_LABELS[s.stage]}</span>
            <span className="flex h-5 min-w-0 items-center gap-2">
              {s.count > 0 && (
                <span className="h-4 rounded-r-[4px] bg-series-1 transition-[width] duration-500" style={{ width: `${Math.max(s.percentOfTotal ?? 0, 1.5) * 0.8}%` }} />
              )}
              <span className="text-sm font-medium whitespace-nowrap text-ink tabular">
                {s.count}
                <span className="ml-1.5 font-normal text-muted">{formatPercent(s.percentOfTotal)}</span>
              </span>
            </span>
            {active === i && (
              <span role="tooltip" className="pointer-events-none absolute top-full right-2 z-10 mt-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg">
                <span className="block text-sm font-semibold text-ink tabular">{s.count} leads</span>
                <span className="block text-muted">{formatPercent(s.percentOfTotal)} of all leads</span>
                {s.stepConversion != null && <span className="block text-muted">{formatPercent(s.stepConversion)} of the previous stage</span>}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
    <p className="mt-auto border-t border-line px-5 py-3 text-sm text-ink-2">
      <span className="font-medium text-ink">{formatPercent(won.percentOfTotal)}</span> of leads became customers.
      {drop && (
        <>
          {' '}Biggest drop-off: <span className="font-medium text-ink">{STATUS_LABELS[drop.from]} → {STATUS_LABELS[drop.to]}</span> ({formatPercent(drop.rate)} moved on).
        </>
      )}
    </p>
    </div>
  );
}
