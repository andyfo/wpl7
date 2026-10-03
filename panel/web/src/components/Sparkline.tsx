/** Tiny dependency-free inline SVG sparkline. */
export function Sparkline({
  values,
  width = 160,
  height = 36,
  formatValue,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="text-xs text-neutral-400">no data yet</span>;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => (v === null ? null : `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / range) * (height - 6)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  const last = nums[nums.length - 1]!;
  return (
    <span className="inline-flex items-center gap-2">
      <svg width={width} height={height} className="overflow-visible">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-neutral-500" />
      </svg>
      <span className="text-xs text-neutral-500">{formatValue ? formatValue(last) : last.toFixed(1)}</span>
    </span>
  );
}
