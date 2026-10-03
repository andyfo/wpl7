import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobDto, JobLogLine } from '../../../shared/types';
import { jobLabel } from '../../../shared/jobTypes';
import { isTerminal } from '../api/hooks';
import { formatClock, formatDate } from '../lib/format';
import { filterLog, levelCounts, logToText, type LogLevelFilter } from '../lib/jobLog';
import { Button, inputClass, JobStatusBadge, Segmented, Spinner } from './ui';

/** Lines the full log renders at once; "Show earlier" adds this many more. */
const LOG_WINDOW = 2000;

/** How close to the end counts as "at the end": a line's height, give or take. */
const BOTTOM_SLACK = 24;

const LEVEL_COLORS: Record<JobLogLine['level'], string> = {
  error: 'text-red-400',
  warn: 'text-[#fcd34d]',
  info: 'text-[#e4e4e7]',
};

/**
 * Follow a growing log - but only while its reader is at the end of it. Someone who scrolled
 * up to read line 40 keeps line 40 on screen; new lines are counted instead, for the "N new
 * lines" pill. `count` only ever grows as lines arrive; `size` is what is rendered, which a
 * filter or a longer window changes; `resetKey` changes when what is shown changes wholesale
 * (a filter), and makes everything on screen count as seen.
 */
function useFollowTail(count: number, size: number, resetKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(count);
  const [atEnd, setAtEnd] = useState(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    pinned.current = end;
    if (end) seen.current = count;
    setAtEnd(end);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
      seen.current = count;
    }
  }, [count, size]);

  useEffect(() => {
    seen.current = count;
    // Only when the filter changes, not with every line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return {
    ref,
    onScroll,
    atEnd,
    unseen: atEnd ? 0 : Math.max(0, count - seen.current),
    toEnd: () => ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }),
    /** Stop following, for a jump to an earlier line. */
    release: () => {
      pinned.current = false;
      setAtEnd(false);
    },
  };
}

/** `needle` marked wherever it occurs in `text`, case-insensitively. */
function marked(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-[#fcd34d] text-[#0a0a0a]">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** Memoized: a running job's log re-renders with every poll, and only its new lines changed. */
const LogLine = memo(function LogLine({ line, needle, highlight }: { line: JobLogLine; needle: string; highlight: boolean }) {
  return (
    <div
      data-seq={line.seq}
      className={`flex gap-3 rounded-sm ${LEVEL_COLORS[line.level]} ${highlight ? 'bg-white/10 ring-1 ring-red-400/60' : ''}`}
    >
      <span className="shrink-0 tabular-nums text-[#71717a]" title={formatDate(line.ts)}>
        {formatClock(line.ts)}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{marked(line.message, needle)}</span>
    </div>
  );
});

/**
 * A job's log. `inline` is the small box under an action that queued a job (about ten
 * places use it); `full` is the job page's: a level filter, search, Copy and Download, and
 * room for a long log without rendering all of it at once.
 */
export function JobLogViewer({
  logs,
  variant = 'inline',
  job = null,
  draining = false,
  jumpTo = null,
}: {
  logs: JobLogLine[];
  variant?: 'inline' | 'full';
  /** Full variant: the job the log is of - what to say while it has none, and the file name. */
  job?: JobDto | null;
  /** Full variant: the job is over but the rest of its log is still being fetched. */
  draining?: boolean;
  /** Full variant: bring this line into view. A new object asks again for the same line. */
  jumpTo?: { seq: number } | null;
}) {
  if (variant === 'inline') return <InlineLog logs={logs} />;
  return <FullLog logs={logs} job={job} draining={draining} jumpTo={jumpTo} />;
}

function InlineLog({ logs }: { logs: JobLogLine[] }) {
  const follow = useFollowTail(logs.length, logs.length, '');
  if (logs.length === 0) return null;
  return (
    <div
      ref={follow.ref}
      onScroll={follow.onScroll}
      className="max-h-64 overflow-y-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs leading-relaxed"
    >
      {logs.map((l) => (
        <LogLine key={l.seq} line={l} needle="" highlight={false} />
      ))}
    </div>
  );
}

function FullLog({
  logs,
  job,
  draining,
  jumpTo,
}: {
  logs: JobLogLine[];
  job: JobDto | null;
  draining: boolean;
  jumpTo: { seq: number } | null;
}) {
  const [level, setLevel] = useState<LogLevelFilter>('all');
  const [search, setSearch] = useState('');
  /**
   * The first line rendered, while that is pinned: by "Show earlier" (`manual`), or because
   * the reader scrolled up and the window must not slide from under them as lines arrive.
   * null = the last LOG_WINDOW lines, following the end.
   */
  const [anchor, setAnchor] = useState<{ seq: number; manual: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const counts = useMemo(() => levelCounts(logs), [logs]);
  const matching = useMemo(() => filterLog(logs, level, search), [logs, level, search]);
  const firstShown = (() => {
    if (!anchor) return Math.max(0, matching.length - LOG_WINDOW);
    const at = matching.findIndex((l) => l.seq >= anchor.seq);
    return at === -1 ? Math.max(0, matching.length - LOG_WINDOW) : at;
  })();
  const shown = firstShown > 0 ? matching.slice(firstShown) : matching;
  const needle = search.trim().toLowerCase();
  const follow = useFollowTail(matching.length, shown.length, `${level}|${needle}`);

  const changeLevel = (next: LogLevelFilter) => {
    setLevel(next);
    setAnchor(null);
  };
  const changeSearch = (next: string) => {
    setSearch(next);
    setAnchor(null);
  };

  // Scrolled up: hold the window where it is. Back at the end: follow again, unless the
  // reader asked for the earlier lines.
  const firstSeq = shown[0]?.seq;
  useEffect(() => {
    if (!follow.atEnd && anchor === null && firstSeq !== undefined) setAnchor({ seq: firstSeq, manual: false });
    if (follow.atEnd && anchor !== null && !anchor.manual) setAnchor(null);
    // Only on reaching or leaving the end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow.atEnd]);

  // "Show earlier" puts lines above the ones being read; keep those where they were.
  const fromBottom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = follow.ref.current;
    if (el && fromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - fromBottom.current;
      fromBottom.current = null;
    }
  }, [firstShown, follow.ref]);
  const showEarlier = () => {
    const el = follow.ref.current;
    if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
    const to = matching[Math.max(0, firstShown - LOG_WINDOW)];
    if (to) setAnchor({ seq: to.seq, manual: true });
  };

  // "Show in log": clear a search that would hide the line, widen the window to reach it,
  // then scroll it into view (the page and the box both) and mark it for a moment.
  const pendingJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpTo) return;
    setSearch('');
    const all = filterLog(logs, level, '');
    const index = all.findIndex((l) => l.seq === jumpTo.seq);
    const start = anchor ? all.findIndex((l) => l.seq >= anchor.seq) : Math.max(0, all.length - LOG_WINDOW);
    if (index !== -1 && index < start) setAnchor({ seq: jumpTo.seq, manual: true });
    pendingJump.current = jumpTo.seq;
    setHighlight(jumpTo.seq);
    // Only when asked; the log growing must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);
  useEffect(() => {
    const seq = pendingJump.current;
    if (seq === null) return;
    const el = follow.ref.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    pendingJump.current = null;
    follow.release();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  useEffect(() => {
    if (highlight === null) return;
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([logToText(logs)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = job ? `job-${job.id}-${job.type}.log` : 'job.log';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filtered = level !== 'all' || needle !== '';
  const problems = counts.warn + counts.error;

  if (logs.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        {!job || job.status === 'queued' ? (
          'Waiting to start – each server runs one job at a time.'
        ) : isTerminal(job.status) && !draining ? (
          'No log output.'
        ) : (
          <span className="inline-flex items-center gap-2">
            <Spinner /> No output yet.
          </span>
        )}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          small
          label="Which lines"
          value={level}
          onChange={changeLevel}
          options={[
            { id: 'all', label: `All (${logs.length})` },
            { id: 'problems', label: `Warnings & errors (${problems})` },
          ]}
        />
        <input
          className={`${inputClass} max-w-56`}
          type="search"
          placeholder="Search the log"
          aria-label="Search the log"
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
        />
        {needle !== '' && (
          <span className="text-xs text-neutral-500">
            {matching.length} {matching.length === 1 ? 'match' : 'matches'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {window.isSecureContext && (
            <Button
              small
              variant="secondary"
              title={filtered ? 'Copies the lines shown' : 'Copies the whole log'}
              onClick={() => void navigator.clipboard.writeText(logToText(matching)).then(() => setCopied(true))}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          <Button small variant="secondary" onClick={download} title="The whole log, as a text file">
            Download .log
          </Button>
        </span>
      </div>

      <div className="relative">
        <div
          ref={follow.ref}
          onScroll={follow.onScroll}
          className="max-h-[60vh] overflow-y-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs leading-relaxed"
        >
          {firstShown > 0 && (
            <div className="mb-2 text-center">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[#a1a1aa] underline hover:text-[#e4e4e7]"
                onClick={showEarlier}
              >
                Show {Math.min(firstShown, LOG_WINDOW).toLocaleString()} earlier lines ({firstShown.toLocaleString()} not
                shown)
              </button>
            </div>
          )}
          {shown.length === 0 ? (
            <div className="text-[#a1a1aa]">No line matches.</div>
          ) : (
            shown.map((l) => <LogLine key={l.seq} line={l} needle={needle} highlight={l.seq === highlight} />)
          )}
          {draining && (
            <div className="mt-1 text-[#a1a1aa]">Loading the rest of the log…</div>
          )}
        </div>
        {follow.unseen > 0 && (
          <button
            type="button"
            onClick={follow.toEnd}
            className="button-primary absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-medium shadow-lg"
          >
            {follow.unseen} new {follow.unseen === 1 ? 'line' : 'lines'} ↓
          </button>
        )}
      </div>
    </div>
  );
}

/** Inline progress block for a 202-job: what it is, how it is doing, its live log. */
export function JobProgress({ job, logs }: { job: JobDto | null; logs: JobLogLine[] }) {
  if (!job) return null;
  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {!isTerminal(job.status) && <Spinner />}
        <span className="font-medium">{jobLabel(job.type)}</span>
        <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
        <Link to={`/jobs/${job.id}`} className="ml-auto text-xs text-neutral-500 hover:text-neutral-800 hover:underline">
          Open job →
        </Link>
      </div>
      {job.summary && <div className="text-xs text-neutral-500">{job.summary}</div>}
      {job.error && <div className="text-xs text-red-700">{job.error}</div>}
      <JobLogViewer logs={logs} />
    </div>
  );
}
