import { useState } from 'react';

/**
 * Horizontal bar chart, single series (one colour, no legend: the card title
 * names it). Bars are <=24px, square at the baseline, 4px rounded at the data
 * end, value at the tip. Each row is the hover/focus target and shows a
 * tooltip with the value and its share.
 */
export function BarList({ data, formatValue = (v) => v, unit = '' }) {
  const [active, setActive] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);

  return (
    <ul className="space-y-1 px-5 py-4" aria-label="Bar chart">
      {data.map((d, i) => {
        const width = (d.value / max) * 100;
        const share = total ? Math.round((d.value / total) * 100) : 0;
        return (
          <li
            key={d.key ?? d.label}
            tabIndex={0}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            aria-label={`${d.label}: ${formatValue(d.value)}${unit}, ${share}% of total`}
            className="relative grid grid-cols-[9.5rem_1fr] items-center gap-3 rounded-md px-1 py-1 outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            <span className="truncate text-sm text-ink-2">{d.label}</span>
            <span className="flex h-5 items-center gap-2">
              {d.value > 0 && (
                <span className="h-4 rounded-r-[4px] bg-series-1 transition-[width] duration-500" style={{ width: `${Math.max(width, 1.5)}%` }} />
              )}
              <span className="text-sm font-medium text-ink tabular">{formatValue(d.value)}</span>
            </span>
            {active === i && (
              <span role="tooltip" className="pointer-events-none absolute top-full right-2 z-10 mt-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg">
                <span className="block text-sm font-semibold text-ink tabular">
                  {formatValue(d.value)}
                  {unit}
                </span>
                <span className="text-muted">
                  {d.label} · {share}% of total
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
