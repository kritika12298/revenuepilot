import { useMemo, useState } from 'react';

function niceMax(value) {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow * 4 >= value) * pow;
  return step * 4;
}

/**
 * Column chart, single series. Hairline solid gridlines, columns <=24px with
 * 4px rounded caps and a 2px gap, the tallest column labelled on its cap,
 * per-column hover/focus tooltips. The container includes the x-axis band so
 * nothing gets clipped.
 */
export function ColumnChart({ data, formatLabel, valueLabel = 'Value', height = 180 }) {
  const [active, setActive] = useState(null);
  const max = useMemo(() => niceMax(Math.max(0, ...data.map((d) => d.value))), [data]);
  const ticks = [0, max / 2, max];
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  const labelEvery = Math.ceil(data.length / 6);

  return (
    <div className="px-5 pt-4 pb-3">
      <div className="flex">
        {/* y-axis */}
        <div className="relative mr-2 w-6 shrink-0 text-right text-[11px] text-muted tabular" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / max) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-line" style={{ top: `${100 - (t / max) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-label={`${valueLabel} per day`}>
            {data.map((d, i) => (
              <div
                key={d.key}
                role="listitem"
                tabIndex={0}
                aria-label={`${formatLabel(d.key)}: ${d.value} ${valueLabel.toLowerCase()}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="group relative flex h-full flex-1 items-end justify-center outline-none"
              >
                {d.value > 0 && (
                  <div
                    className="w-full max-w-6 rounded-t-[4px] bg-series-1 transition-[filter] group-hover:brightness-110 group-focus-visible:brightness-110"
                    style={{ height: `${(d.value / max) * 100}%` }}
                  />
                )}
                {i === peak && d.value > 0 && active !== i && (
                  <span className="absolute text-[11px] font-medium text-ink tabular" style={{ bottom: `calc(${(d.value / max) * 100}% + 2px)` }}>
                    {d.value}
                  </span>
                )}
                {active === i && (
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute z-10 -translate-y-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg"
                    style={{ bottom: `${(d.value / max) * 100}%` }}
                  >
                    <span className="block text-sm font-semibold text-ink tabular">{d.value}</span>
                    <span className="text-muted">{formatLabel(d.key)}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* x-axis band */}
      <div className="ml-8 flex border-t border-line-strong pt-1.5 text-[11px] text-muted">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 text-center whitespace-nowrap">
            {i % labelEvery === 0 ? formatLabel(d.key) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
