// @docs automations/jobs
import type { JobStatus } from '../../../shared/schemas';

/**
 * The job console's rules, kept apart from its components so they can be tested without a
 * browser: which view it is in, which jobs it keeps, what this browser stored for it, and where
 * in the window it sits.
 *
 * The console follows the jobs started in one browser tab. It is a small box floating over the
 * page (`bar`), the same box with the selected job's log under it (`log`), or a pill in the
 * header next to the version (`chip`).
 */

export type ConsoleView = 'hidden' | 'bar' | 'log' | 'chip';

export interface ConsoleSession {
  /** The jobs followed, newest first. */
  jobs: number[];
  /** The job whose log is shown: one of `jobs`, or null when there are none. */
  selected: number | null;
  view: ConsoleView;
}

/**
 * Where the console was put by hand: the corner of the window it is nearest, and its distance
 * from that corner's two sides, in px. A resize keeps those distances. Anchored at the bottom,
 * the console grows upward when its log shows; anchored at the top, downward.
 */
export interface StoredPlace {
  x: 'left' | 'right';
  xInset: number;
  y: 'top' | 'bottom';
  yInset: number;
}

export interface ConsolePrefs {
  /** null = the default place, the window's bottom right corner. */
  position: StoredPlace | null;
  /**
   * The user minimized it. It stays in the header through later jobs until they open it again;
   * a console that minimized itself gives way to the bar at the next job.
   */
  minimized: boolean;
}

export interface ConsoleState {
  session: ConsoleSession;
  prefs: ConsolePrefs;
}

/** From the window's edges, in px. */
export const MARGIN = 16;
/** Where the console goes until it is moved: the window's bottom right corner. */
export const DEFAULT_PLACE: StoredPlace = { x: 'right', xInset: MARGIN, y: 'bottom', yInset: MARGIN };
/** How long a bar whose jobs have all ended shows how they ended before it minimizes itself. */
export const SETTLE_MS = 3000;
/** Jobs kept. The oldest ended one makes room; a job still queued or running never does. */
export const MAX_JOBS = 5;
/** What an arrow key moves the console by, and with Shift. */
export const NUDGE = 16;
export const NUDGE_FAR = 64;

/** Stored per browser, like the theme. */
export const PREFS_KEY = 'wpl7-job-console';
/** Stored per tab: a reload keeps the console and reads its jobs again. */
export const SESSION_KEY = 'wpl7-job-console-jobs';

export const EMPTY_SESSION: ConsoleSession = { jobs: [], selected: null, view: 'hidden' };
export const DEFAULT_PREFS: ConsolePrefs = { position: null, minimized: false };

export type ConsoleEvent =
  | { type: 'follow'; id: number }
  | { type: 'select'; id: number }
  | { type: 'showLog' }
  | { type: 'hideLog' }
  | { type: 'minimize' }
  | { type: 'open' }
  | { type: 'close' }
  /** The bar has shown how its jobs ended for SETTLE_MS. */
  | { type: 'settled' };

/**
 * The jobs kept: newest first, the oldest ended ones dropped beyond `max`. The first, which was
 * just followed, always stays.
 */
export function trimJobs(jobs: readonly number[], ended: (id: number) => boolean, max = MAX_JOBS): number[] {
  const kept = [...jobs];
  for (let i = kept.length - 1; i > 0 && kept.length > max; i--) {
    if (ended(kept[i]!)) kept.splice(i, 1);
  }
  return kept;
}

/**
 * The next state. `ended(id)`: the job is over, or can no longer be read. A job the console has
 * not read yet (after a reload) has not ended.
 */
export function reduce(state: ConsoleState, event: ConsoleEvent, ended: (id: number) => boolean): ConsoleState {
  const { session, prefs } = state;
  const open = session.view === 'bar' || session.view === 'log';
  const allEnded = session.jobs.every(ended);
  switch (event.type) {
    case 'follow': {
      const jobs = trimJobs([event.id, ...session.jobs.filter((id) => id !== event.id)], ended);
      // An open console stays as it is. A hidden one, or one that went to the header by itself,
      // comes out as the bar - unless the user put it in the header.
      const view = open ? session.view : prefs.minimized ? 'chip' : 'bar';
      return { prefs, session: { jobs, selected: event.id, view } };
    }
    case 'select':
      if (!session.jobs.includes(event.id)) return state;
      return { prefs, session: { ...session, selected: event.id } };
    case 'showLog':
      if (session.view !== 'bar') return state;
      return { prefs, session: { ...session, view: 'log' } };
    case 'hideLog':
      if (session.view !== 'log') return state;
      // A collapsed console never sits on the page with nothing running.
      return { prefs, session: { ...session, view: allEnded ? 'chip' : 'bar' } };
    case 'minimize':
      if (!open) return state;
      return { prefs: { ...prefs, minimized: true }, session: { ...session, view: 'chip' } };
    case 'open':
      // Opened to read: straight to the log.
      if (session.view !== 'chip' || session.jobs.length === 0) return state;
      return { prefs: { ...prefs, minimized: false }, session: { ...session, view: 'log' } };
    case 'close':
      if (!open || !allEnded) return state;
      return { prefs, session: EMPTY_SESSION };
    case 'settled':
      if (session.view !== 'bar' || !allEnded) return state;
      return { prefs, session: { ...session, view: 'chip' } };
  }
}

const VIEWS: readonly ConsoleView[] = ['hidden', 'bar', 'log', 'chip'];
const isJobId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The tab's console as stored, read back. Anything that does not fit gives an empty console. */
export function sessionFrom(raw: string | null): ConsoleSession {
  const value = parse(raw);
  if (!value || typeof value !== 'object') return EMPTY_SESSION;
  const { jobs, selected, view } = value as Record<string, unknown>;
  // A sane cap, not MAX_JOBS: more than five may have been running.
  const ids = Array.isArray(jobs) ? [...new Set(jobs.filter(isJobId))].slice(0, 50) : [];
  if (ids.length === 0 || view === 'hidden') return EMPTY_SESSION;
  return {
    jobs: ids,
    selected: isJobId(selected) && ids.includes(selected) ? selected : ids[0]!,
    view: VIEWS.includes(view as ConsoleView) ? (view as ConsoleView) : 'chip',
  };
}

const isInset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;

function placeFrom(value: unknown): StoredPlace | null {
  if (!value || typeof value !== 'object') return null;
  const { x, xInset, y, yInset } = value as Record<string, unknown>;
  if ((x !== 'left' && x !== 'right') || (y !== 'top' && y !== 'bottom')) return null;
  if (!isInset(xInset) || !isInset(yInset)) return null;
  return { x, xInset, y, yInset };
}

/** This browser's console preferences as stored, read back. Anything that does not fit is left out. */
export function prefsFrom(raw: string | null): ConsolePrefs {
  const value = parse(raw);
  if (!value || typeof value !== 'object') return DEFAULT_PREFS;
  const { position, minimized } = value as Record<string, unknown>;
  return { position: placeFrom(position), minimized: minimized === true };
}

/** What the placement works from, all in CSS px. */
export interface Frame {
  /** The window, without its scrollbars. */
  windowWidth: number;
  windowHeight: number;
  /** The console as drawn now: one width whether its log shows or not, and its whole height. */
  width: number;
  height: number;
}

/** A position kept inside the window, MARGIN from each edge. */
export function clampToWindow(left: number, top: number, frame: Frame): { left: number; top: number } {
  return {
    left: Math.max(MARGIN, Math.min(left, frame.windowWidth - MARGIN - frame.width)),
    top: Math.max(MARGIN, Math.min(top, frame.windowHeight - MARGIN - frame.height)),
  };
}

/**
 * Where the console goes: where it was put, or the window's bottom right corner. Always inside
 * the window. Anchored at the top, an expanded console near the foot of the window moves up only
 * as far as it must, and the stored place itself never changes here: hidden again, the log
 * leaves the console where it was.
 */
export function place(stored: StoredPlace | null, frame: Frame): { left: number; top: number } {
  const at = stored ?? DEFAULT_PLACE;
  const left = at.x === 'left' ? at.xInset : frame.windowWidth - at.xInset - frame.width;
  const top = at.y === 'top' ? at.yInset : frame.windowHeight - at.yInset - frame.height;
  return clampToWindow(Math.round(left), Math.round(top), frame);
}

/** A place to store for a console dropped at `left`, `top`: measured from the nearest corner. */
export function toStored(left: number, top: number, frame: Frame): StoredPlace {
  const at = clampToWindow(left, top, frame);
  const fromRight = frame.windowWidth - at.left - frame.width;
  const fromBottom = frame.windowHeight - at.top - frame.height;
  const x = at.left < fromRight ? 'left' : 'right';
  const y = at.top < fromBottom ? 'top' : 'bottom';
  return {
    x,
    xInset: Math.max(0, Math.round(x === 'left' ? at.left : fromRight)),
    y,
    yInset: Math.max(0, Math.round(y === 'top' ? at.top : fromBottom)),
  };
}

/** The place an arrow key moves the console to; from the default place when none is stored. */
export function nudge(stored: StoredPlace | null, dx: number, dy: number, frame: Frame): StoredPlace {
  const at = place(stored, frame);
  return toStored(at.left + dx, at.top + dy, frame);
}

/** How a followed job stands, for the chip. A job not read yet counts as running. */
export type JobOutcome = 'running' | 'failed' | 'done';

/** A job that can no longer be read is shown as failed: something went wrong, and it says what. */
export function outcomeOf(status: JobStatus | null, lost = false): JobOutcome {
  if (lost) return 'failed';
  if (status === null || status === 'queued' || status === 'running') return 'running';
  return status === 'failed' ? 'failed' : 'done';
}

/** What the chip says: running wins over failed, failed over done. A canceled job is done. */
export function chipSummary(outcomes: readonly JobOutcome[]): { tone: JobOutcome; count: number } {
  for (const tone of ['running', 'failed'] as const) {
    const count = outcomes.filter((o) => o === tone).length;
    if (count > 0) return { tone, count };
  }
  return { tone: 'done', count: outcomes.length };
}

/** The chip's words, and its accessible name. */
export function chipText({ tone, count }: { tone: JobOutcome; count: number }): { label: string; title: string } {
  if (tone === 'done') return { label: 'Done', title: 'Job console: done' };
  const word = tone === 'running' ? 'running' : 'failed';
  return {
    label: count === 1 ? (tone === 'running' ? 'Running' : 'Failed') : `${count} ${word}`,
    title: `Job console: ${count} ${word}`,
  };
}
