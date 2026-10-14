// @docs automations/jobs
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link } from 'react-router';
import type { JobLogLine } from '../../../../shared/types';
import { jobLabel } from '../../../../shared/jobTypes';
import {
  NUDGE,
  NUDGE_FAR,
  SETTLE_MS,
  clampToWindow,
  nudge,
  place,
  toStored,
  type Frame,
} from '../../lib/jobConsole';
import { Icon } from '../Icon';
import { JobLogViewer } from '../JobProgress';
import { JobStatusBadge } from '../ui';
import { useConsoleControls, useConsoleLog, useJobSnapshots, type JobSnapshot } from './context';

/** The newest line, on the console's light surface rather than the log's dark one. */
const LINE_TONES: Record<JobLogLine['level'], string> = {
  info: 'text-neutral-600',
  warn: 'text-amber-700',
  error: 'text-red-700',
};

/** How far a press on the handle must travel to be a drag rather than a click, in px. */
const DRAG_START = 4;

/**
 * The job console: the jobs started in this tab, floating over the page in the window's bottom
 * right corner, or wherever it was put. Collapsed (the bar) it names the selected job and shows
 * its newest line; expanded it shows the log as well. Drawn only while it is open - minimized, it
 * is the chip in the header.
 */
export function JobConsole() {
  const { state } = useConsoleControls();
  if (state.session.view !== 'bar' && state.session.view !== 'log') return null;
  return <ConsoleBox />;
}

function ConsoleBox() {
  const { state, dispatch, setPosition, focusNext } = useConsoleControls();
  const snapshots = useJobSnapshots();
  const log = useConsoleLog();
  const { session, prefs } = state;
  const expanded = session.view === 'log';
  const box = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  const selected = session.selected === null ? undefined : snapshots.get(session.selected);
  const job = selected?.job ?? null;
  const logs = log.jobId === session.selected ? log.logs : [];
  const allEnded = session.jobs.length > 0 && session.jobs.every((id) => snapshots.get(id)?.ended);
  const othersRunning = session.jobs.filter((id) => id !== session.selected && !snapshots.get(id)?.ended).length;

  // Where it is: measured, then placed - before the first paint, so it never shows in the wrong
  // place. Measured again when it grows or shrinks (its log), and when the window does.
  const [frame, setFrame] = useState<Frame | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current;
      if (!b) return;
      const root = document.documentElement;
      const next: Frame = {
        windowWidth: root.clientWidth,
        windowHeight: root.clientHeight,
        width: b.offsetWidth,
        height: b.offsetHeight,
      };
      setFrame((prev) =>
        prev && (Object.keys(next) as (keyof Frame)[]).every((key) => prev[key] === next[key]) ? prev : next,
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    if (box.current) resize.observe(box.current);
    window.addEventListener('resize', measure);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Dragging moves the box directly, without a render per pointer move. A render in between (a
  // poll) keeps it where the pointer has it.
  const drag = useRef<{
    pointer: number;
    dx: number;
    dy: number;
    x: number;
    y: number;
    at: { left: number; top: number } | null;
  } | null>(null);
  const placed = drag.current?.at ?? (frame ? place(prefs.position, frame) : null);

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    drag.current = { pointer: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: e.clientX, y: e.clientY, at: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !frame || !box.current) return;
    if (!d.at && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START) return;
    d.at = clampToWindow(e.clientX - d.dx, e.clientY - d.dy, frame);
    box.current.style.left = `${d.at.left}px`;
    box.current.style.top = `${d.at.top}px`;
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    // A press that did not travel is a click (or half a double-click): it stores nothing, so the
    // default place stays the default.
    if (d.at && frame) setPosition(toStored(d.at.left, d.at.top, frame));
  };
  const nudgeWithKeys = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    const by = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as const)[
      e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
    ];
    if (!by || !frame) return;
    e.preventDefault();
    setPosition(nudge(prefs.position, by[0], by[1], frame));
  };

  // Every job over, and only the bar showing: how they ended stays in view for SETTLE_MS, then
  // the console goes to the header. Not while the pointer is on it or focus is in it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (session.view !== 'bar' || !allEnded || hovered || focused) return;
    const t = setTimeout(() => dispatch({ type: 'settled' }), SETTLE_MS);
    return () => clearTimeout(t);
  }, [session.view, allEnded, hovered, focused, dispatch]);

  // Opened from the chip by its button: focus follows - once it is placed, as a box still hidden
  // for its first measurement takes no focus.
  useEffect(() => {
    if (!frame || focusNext.current !== 'console') return;
    focusNext.current = null;
    toggle.current?.focus();
  });

  const toggleLog = () => {
    if (!expanded) return dispatch({ type: 'showLog' });
    // With nothing running, hiding the log sends the console to the header: focus goes with it.
    if (allEnded) focusNext.current = 'chip';
    dispatch({ type: 'hideLog' });
  };

  return (
    <section
      ref={box}
      aria-label="Job console"
      className="job-console"
      style={placed ? { left: placed.left, top: placed.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="flex items-start gap-1.5 py-2 pl-1.5 pr-2">
        <button
          type="button"
          className="job-console-handle"
          aria-label="Move the job console"
          title="Drag to move. Double-click to put it back."
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={nudgeWithKeys}
          onDoubleClick={() => setPosition(null)}
        >
          <Icon name="grip" size={16} />
        </button>
        <div className="flex min-w-0 flex-1 items-start gap-2 pt-1">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <StatusIcon snapshot={selected} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium text-neutral-900">
                {job ? jobLabel(job.type) : `Job #${session.selected ?? ''}`}
              </span>
              {job?.siteSlug && <span className="min-w-0 truncate text-xs text-neutral-500">{job.siteSlug}</span>}
              {othersRunning > 0 && (
                <span
                  className="ml-auto shrink-0 rounded-full bg-neutral-100 px-1.5 py-px text-[11px] font-medium text-neutral-600"
                  title={`${othersRunning} more running`}
                >
                  +{othersRunning}
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs leading-5">
              <NewestLine snapshot={selected} logs={logs} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <ConsoleButton
            ref={toggle}
            label={expanded ? 'Hide log' : 'Show log'}
            onClick={toggleLog}
            expanded={expanded}
            controls={bodyId}
          >
            <span className={`inline-flex transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <Icon name="chevron" size={16} />
            </span>
          </ConsoleButton>
          <ConsoleButton
            label="Minimize"
            onClick={() => {
              focusNext.current = 'chip';
              dispatch({ type: 'minimize' });
            }}
          >
            <Icon name="minimize" size={16} />
          </ConsoleButton>
          {allEnded && (
            <ConsoleButton
              label="Close"
              onClick={() => {
                dispatch({ type: 'close' });
                document.getElementById('main-content')?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </ConsoleButton>
          )}
        </div>
      </div>
      {expanded && (
        <div id={bodyId} className="space-y-2 border-t border-neutral-200 px-3 pb-3 pt-2.5">
          {session.jobs.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {session.jobs.map((id) => (
                <JobPill
                  key={id}
                  id={id}
                  snapshot={snapshots.get(id)}
                  active={id === session.selected}
                  onSelect={() => dispatch({ type: 'select', id })}
                />
              ))}
            </div>
          )}
          {job && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
              {job.summary && (
                <span className="min-w-0 truncate text-neutral-500" title={job.summary}>
                  {job.summary}
                </span>
              )}
            </div>
          )}
          {job?.error && <div className="text-xs text-red-700">{job.error}</div>}
          {selected?.lost && <div className="text-xs text-red-700">{selected.error?.message}</div>}
          <JobLogViewer logs={logs} />
          {log.draining && log.jobId === session.selected && (
            <div className="text-xs text-neutral-500">Loading the rest of the log…</div>
          )}
          {session.selected !== null && (
            <div className="flex justify-end">
              <Link
                to={`/jobs/${session.selected}`}
                className="text-xs text-neutral-500 hover:text-neutral-800 hover:underline"
              >
                Open job →
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ConsoleButton({
  label,
  onClick,
  expanded,
  controls,
  children,
  ref,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  controls?: string;
  children: ReactNode;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="job-console-button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      // Only while what it names is there: the log is not drawn while hidden.
      aria-controls={expanded ? controls : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** How the job stands, at a glance; said in words for screen readers. */
function StatusIcon({ snapshot }: { snapshot: JobSnapshot | undefined }) {
  const status = !snapshot ? null : snapshot.lost ? 'failed' : (snapshot.job?.status ?? null);
  const words = <span className="sr-only">{status ?? 'loading'}</span>;
  if (status === null || status === 'queued' || status === 'running') {
    return (
      <>
        <span className="job-console-spinner" aria-hidden="true" />
        {words}
      </>
    );
  }
  return (
    <>
      {status === 'succeeded' ? (
        <span className="text-emerald-700">
          <Icon name="check" size={16} />
        </span>
      ) : status === 'failed' ? (
        <span className="text-red-700">
          <Icon name="close" size={16} />
        </span>
      ) : (
        <span className="h-0.5 w-2.5 rounded-full bg-neutral-400" aria-hidden="true" />
      )}
      {words}
    </>
  );
}

/** The bar's second line: the newest log line, or what stands in for it. */
function NewestLine({ snapshot, logs }: { snapshot: JobSnapshot | undefined; logs: JobLogLine[] }) {
  if (!snapshot) return <span className="text-neutral-500">Loading…</span>;
  if (snapshot.lost || !snapshot.job) {
    return <span className="text-red-700">{snapshot.error?.message ?? 'This job can no longer be read.'}</span>;
  }
  const { job } = snapshot;
  if (job.status === 'failed' && job.error) return <span className="text-red-700">{job.error}</span>;
  const last = logs[logs.length - 1];
  if (last) return <span className={LINE_TONES[last.level]}>{last.message}</span>;
  const text =
    job.status === 'queued'
      ? 'Waiting to start – each server runs one job at a time.'
      : job.status === 'running'
        ? 'No output yet.'
        : 'No log output.';
  return <span className="text-neutral-500">{text}</span>;
}

const DOT_TONES: Record<string, string> = {
  queued: 'bg-amber-500',
  running: 'animate-pulse bg-sky-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  canceled: 'bg-neutral-400',
};

function JobPill({
  id,
  snapshot,
  active,
  onSelect,
}: {
  id: number;
  snapshot: JobSnapshot | undefined;
  active: boolean;
  onSelect: () => void;
}) {
  const status = !snapshot ? 'queued' : snapshot.lost ? 'failed' : (snapshot.job?.status ?? 'queued');
  const name = snapshot?.job ? jobLabel(snapshot.job.type) : `Job #${id}`;
  const site = snapshot?.job?.siteSlug;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={`${name}${site ? ` · ${site}` : ''}: ${status}`}
      onClick={onSelect}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]'
          : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONES[status] ?? 'bg-neutral-400'}`} />
      <span className="truncate">
        {name}
        {site && <span className="text-neutral-500"> · {site}</span>}
      </span>
    </button>
  );
}
