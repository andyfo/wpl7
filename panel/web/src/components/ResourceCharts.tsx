import { useId, useState } from 'react';
import { chartSegments, type ResourcePoint as Point } from '../lib/resourceChart';
import type { ServerHistoryDto, ServerMonitorDto } from '../../../shared/types';
import { useServerHistory } from '../api/hooks';
import { formatBytes, timeAgo } from '../lib/format';
import { Icon, type IconName } from './Icon';

type Sample = ServerHistoryDto['samples'][number];
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ResourceChart({
  title,
  icon,
  color,
  value,
  unit,
  detail,
  points,
  history,
  percent = false,
  loading,
}: {
  title: string;
  icon: IconName;
  color: string;
  value: string;
  unit: string;
  detail: string;
  points: Point[];
  history?: ServerHistoryDto;
  percent?: boolean;
  loading: boolean;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const nums = points.flatMap((p) => (p.value === null || !Number.isFinite(p.value) ? [] : [p.value]));
  const ceiling = percent ? 100 : Math.max(1, Math.ceil(Math.max(0, ...nums) * 1.2 * 2) / 2);
  const since = history?.since ?? Date.now() - 3600_000;
  const until = history?.until ?? Date.now();
  const gapMs = Math.max(history?.sampleIntervalMs ?? 60_000, history?.bucketMs ?? 15_000) * 2.5;
  const segments = chartSegments(points, since, until, ceiling, gapMs);
  const selected = hover === null ? undefined : points[hover];
  const selectedX = selected ? ((selected.ts - since) / Math.max(1, until - since)) * 320 : 0;
  const format = (n: number) => (percent ? `${n.toFixed(1)}%` : n.toFixed(2));
  return (
    <div className="resource-chart" style={{ color }}>
      <div className="resource-label">
        <Icon name={icon} size={15} />
        <span>{title}</span>
        <span className="ml-auto text-[9px] text-neutral-400">{percent ? '0–100%' : `0–${ceiling.toFixed(1)}`}</span>
      </div>
      <div className="resource-value text-neutral-900">
        {value}
        <span className="resource-unit">{unit}</span>
      </div>
      <div className="resource-sub">{detail}</div>
      <div className="chart-area" onMouseLeave={() => setHover(null)}>
        {selected && (
          <div className="chart-tooltip text-neutral-700">
            {clock(selected.ts)} · {selected.value === null ? 'Unavailable' : format(selected.value)}
          </div>
        )}
        <svg
          viewBox="0 0 320 108"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title}: ${value} ${unit}. ${detail}${nums.length ? '. Use left and right arrow keys to inspect samples.' : '. No samples available.'}`}
          tabIndex={points.length ? 0 : undefined}
          onFocus={() => setHover(points.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setHover((current) =>
                Math.max(
                  0,
                  Math.min(points.length - 1, (current ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)),
                ),
              );
            }
          }}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ts = since + ((event.clientX - rect.left) / rect.width) * (until - since);
            if (points.length)
              setHover(
                points.reduce((best, p, i) => (Math.abs(p.ts - ts) < Math.abs(points[best]!.ts - ts) ? i : best), 0),
              );
          }}
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity=".18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[8, 54, 100].map((y) => (
            <line key={y} x1="0" x2="320" y1={y} y2={y} className="chart-grid" />
          ))}
          {segments.map((segment, i) => {
            const path = segment.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
            return (
              <g key={i}>
                <path d={`${path} L${segment.at(-1)!.x},100 L${segment[0]!.x},100 Z`} fill={`url(#${id})`} />
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
                {segment.length === 1 && <circle cx={segment[0]!.x} cy={segment[0]!.y} r="2.5" fill="currentColor" />}
              </g>
            );
          })}
          {selected && (
            <line
              x1={selectedX}
              x2={selectedX}
              y1="8"
              y2="100"
              stroke="currentColor"
              strokeOpacity=".6"
              strokeDasharray="3 3"
            />
          )}
        </svg>
        {!nums.length && (
          <div className="chart-empty">{loading ? 'Loading resource history…' : 'Waiting for resource samples'}</div>
        )}
        <span className="sr-only" aria-live="polite">
          {selected ? `${clock(selected.ts)}: ${selected.value === null ? 'Unavailable' : format(selected.value)}` : ''}
        </span>
      </div>
      <div className="chart-times">
        <span>{clock(since)}</span>
        <span>{clock((since + until) / 2)}</span>
        <span>{clock(until)}</span>
      </div>
    </div>
  );
}

export function ResourceCharts({ servers }: { servers: ServerMonitorDto[] }) {
  const [selectedId, setSelectedId] = useState(1);
  const [hours, setHours] = useState(1);
  const server = servers.find((s) => s.serverId === selectedId) ?? servers[0];
  const serverId = server?.serverId ?? 1;
  const history = useServerHistory(serverId, hours);
  const samples = history.data?.samples ?? [];
  const latest = samples.at(-1);
  const stale = !latest || Date.now() - latest.ts > (history.data?.sampleIntervalMs ?? 60_000) * 2.5;
  const unavailable = server !== undefined && server.status !== 'ok';
  const live = !history.isError && !stale && !unavailable;
  const points = (get: (s: Sample) => number | null) => samples.map((s) => ({ ts: s.ts, value: get(s) }));
  const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : null);
  const memory = latest ? percent(latest.memUsed, latest.memTotal) : null;
  const disk = latest ? percent(latest.diskUsed, latest.diskTotal) : null;
  return (
    <section className="panel-card resource-section" aria-label="Server resources">
      <div className="resource-toolbar">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="resource-title">
            <Icon name="activity" size={17} />
            Server resources
          </h2>
          <span className={`live-label ${!live ? 'live-label-stale' : ''}`}>
            {history.isPending
              ? 'Connecting'
              : live
                ? 'Live'
                : unavailable
                  ? 'Server offline'
                  : latest
                    ? 'Delayed'
                    : 'Awaiting data'}
          </span>
        </div>
        <div className="resource-controls">
          {servers.length > 1 ? (
            <select
              aria-label="Server to monitor"
              value={serverId}
              onChange={(e) => setSelectedId(Number(e.target.value))}
            >
              {servers.map((s) => (
                <option key={s.serverId} value={s.serverId}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-neutral-500">{server?.name ?? 'Local server'}</span>
          )}
          <div className="range-switch" role="group" aria-label="Resource history range">
            {[1, 6, 24].map((h) => (
              <button type="button" key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>
                {h}h
              </button>
            ))}
          </div>
        </div>
      </div>
      {history.isError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 text-xs text-red-700"
        >
          <span>
            Couldn’t refresh resource history. {latest ? 'Showing the last recorded readings.' : 'Please try again.'}
          </span>
          <button type="button" className="underline" onClick={() => void history.refetch()}>
            Retry
          </button>
        </div>
      )}
      <div className="resource-grid">
        <ResourceChart
          key={`${serverId}-${hours}-load`}
          title="CPU load"
          icon="activity"
          color="var(--chart-load)"
          value={latest?.load1.toFixed(2) ?? '—'}
          unit="1 min average"
          detail={
            latest
              ? `5 min ${latest.load5.toFixed(2)}  ·  15 min ${latest.load15.toFixed(2)}`
              : 'System load, not CPU utilization'
          }
          points={points((s) => s.load1)}
          history={history.data}
          loading={history.isPending}
        />
        <ResourceChart
          key={`${serverId}-${hours}-mem`}
          title="Memory"
          icon="memory"
          color="var(--chart-memory)"
          value={memory?.toFixed(1) ?? '—'}
          unit={memory !== null ? '% used' : ''}
          detail={
            latest && memory !== null
              ? `${formatBytes(Math.max(0, latest.memTotal - latest.memUsed))} available of ${formatBytes(latest.memTotal)}`
              : 'Memory reading unavailable'
          }
          points={points((s) => percent(s.memUsed, s.memTotal))}
          history={history.data}
          percent
          loading={history.isPending}
        />
        <ResourceChart
          key={`${serverId}-${hours}-disk`}
          title="Storage · /srv"
          icon="disk"
          color="var(--chart-disk)"
          value={disk?.toFixed(1) ?? '—'}
          unit={disk !== null ? '% used' : ''}
          detail={
            latest && disk !== null
              ? `${formatBytes(Math.max(0, latest.diskTotal - latest.diskUsed))} available of ${formatBytes(latest.diskTotal)}`
              : 'Storage reading unavailable'
          }
          points={points((s) => percent(s.diskUsed, s.diskTotal))}
          history={history.data}
          percent
          loading={history.isPending}
        />
      </div>
      <div className="resource-footer">
        <span>
          {latest
            ? `Last sample ${timeAgo(latest.ts)}${!live ? ' · readings may be out of date' : ''}`
            : 'Charts appear as server samples arrive'}
        </span>
        <span>
          Auto-refresh 15s{history.data ? ` · sampled every ${history.data.sampleIntervalMs / 1000}s` : ''} · last{' '}
          {hours === 1 ? 'hour' : `${hours} hours`}
        </span>
      </div>
    </section>
  );
}
