import { useState } from 'react';

export interface BarDatum {
  /** Bucket start, used for the tooltip label and the sparse axis ticks. */
  ts: number;
  value: number;
  /** Extra lines under the value in the tooltip, e.g. "412 page views". */
  detail?: string[];
}

/**
 * Single-series bar chart. Deliberately dependency-free and inline, like Sparkline —
 * the panel ships no charting library and one bar chart is not a reason to start.
 *
 * One series, so there is no legend: the card title names what is being counted. The
 * hovered bar is the label, rather than a number printed on every bar, which at 90 daily
 * buckets would be unreadable.
 */
export function BarChart({
  data,
  height = 120,
  formatValue = (v) => String(v),
  formatLabel,
  emptyLabel = 'no data yet',
}: {
  data: BarDatum[];
  height?: number;
  formatValue?: (v: number) => string;
  formatLabel: (ts: number) => string;
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <span className="text-xs text-neutral-400">{emptyLabel}</span>;

  const max = Math.max(...data.map((d) => d.value), 1);
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a));
  const active = hover !== null ? data[hover] : null;
  // Percentage widths rather than a fixed viewBox: the card is fluid, and the 2px gap the
  // mark spec asks for between adjacent bars has to stay 2px at every width.
  const slot = 100 / data.length;

  return (
    <div className="w-full">
      <div className="relative flex items-end gap-0" style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          // A zero bucket still gets a hairline: "nobody came" and "no bar drawn at all"
          // are different statements and the chart should not make them look identical.
          const h = d.value === 0 ? 1 : Math.max(2, Math.round((d.value / max) * (height - 4)));
          return (
            <div
              key={d.ts}
              className="group relative flex h-full cursor-default items-end justify-center"
              style={{ width: `${slot}%` }}
              onMouseEnter={() => setHover(i)}
            >
              <div
                className={`w-full rounded-t ${d.value === 0 ? 'bg-neutral-200' : hover === i ? 'bg-sky-700' : 'bg-sky-600'}`}
                style={{ height: h, marginInline: 1 }}
              />
            </div>
          );
        })}
        {/* Recessive baseline: it anchors the bars without competing with them. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-b border-neutral-200" />
      </div>
      <div className="mt-1.5 flex items-start justify-between gap-3 text-xs text-neutral-500">
        <span>{formatLabel(data[0]!.ts)}</span>
        {active ? (
          <span className="text-center font-medium text-neutral-900">
            {formatValue(active.value)} · {formatLabel(active.ts)}
            {active.detail?.length ? (
              <span className="ml-1 font-normal text-neutral-500">({active.detail.join(' · ')})</span>
            ) : null}
          </span>
        ) : (
          <span className="text-center">
            peak {formatValue(peak.value)} · {formatLabel(peak.ts)}
          </span>
        )}
        <span>{formatLabel(data[data.length - 1]!.ts)}</span>
      </div>
    </div>
  );
}
