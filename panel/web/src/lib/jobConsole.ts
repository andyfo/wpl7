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

/** Where the console was put by hand. */
export interface StoredPlace {
  /** The side of the window it is nearer to. */
  edge: 'left' | 'right';
  /** Its distance from that side, in px. */
  inset: number;
  /** Its header's vertical centre, as a fraction of the window's height. */
  center: number;
}

export interface ConsolePrefs {
  /** null = the default place, beside the content. */
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
/** From the content column, in px. */
export const GAP = 16;
/** 28rem: one width for the bar and the log, so the buttons never move sideways. */
export const MAX_WIDTH = 448;
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

function placeFrom(value: unknown): StoredPlace | null {
  if (!value || typeof value !== 'object') return null;
  const { edge, inset, center } = value as Record<string, unknown>;
  if (edge !== 'left' && edge !== 'right') return null;
  if (typeof inset !== 'number' || !Number.isFinite(inset) || inset < 0 || inset > 100_000) return null;
  if (typeof center !== 'number' || !Number.isFinite(center) || center < 0 || center > 1) return null;
  return { edge, inset, center };
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
  /** The right edge of the page's content column. */
  contentRight: number;
  /** The console as drawn now: its width, its header's height (the bar), its whole height. */
  width: number;
  headerHeight: number;
  height: number;
}

/** The console's width in a window this wide. */
export function consoleWidth(windowWidth: number): number {
  return Math.max(0, Math.min(MAX_WIDTH, windowWidth - 2 * MARGIN));
}

/** Just right of the content column when it fits there, against the window's right edge when not. */
export function defaultLeft(contentRight: number, windowWidth: number, width: number): number {
  return Math.max(MARGIN, Math.min(contentRight + GAP, windowWidth - MARGIN - width));
}

/** A position kept inside the window, MARGIN from each edge. */
export function clampToWindow(left: number, top: number, frame: Frame): { left: number; top: number } {
  return {
    left: Math.max(MARGIN, Math.min(left, frame.windowWidth - MARGIN - frame.width)),
    // Expanding grows the box downward; near the foot of the window it moves up as far as it must.
    top: Math.max(MARGIN, Math.min(top, frame.windowHeight - MARGIN - frame.height)),
  };
}

/**
 * Where the console goes: where it was put, or by default on the right with its header at half
 * the window's height. Always inside the window. The stored place itself never changes here, so
 * a box pushed up by its log goes back down when the log is hidden.
 */
export function place(stored: StoredPlace | null, frame: Frame): { left: number; top: number } {
  const left = !stored
    ? defaultLeft(frame.contentRight, frame.windowWidth, frame.width)
    : stored.edge === 'left'
      ? stored.inset
      : frame.windowWidth - stored.inset - frame.width;
  const top = (stored?.center ?? 0.5) * frame.windowHeight - frame.headerHeight / 2;
  return clampToWindow(Math.round(left), Math.round(top), frame);
}

/** A place to store for a console dropped at `left`, `top`. */
export function toStored(left: number, top: number, frame: Frame): StoredPlace {
  const at = clampToWindow(left, top, frame);
  const fromLeft = at.left;
  const fromRight = frame.windowWidth - at.left - frame.width;
  const edge = fromLeft < fromRight ? 'left' : 'right';
  const center = frame.windowHeight > 0 ? (at.top + frame.headerHeight / 2) / frame.windowHeight : 0.5;
  return {
    edge,
    inset: Math.max(0, Math.round(edge === 'left' ? fromLeft : fromRight)),
    center: Math.min(1, Math.max(0, center)),
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
