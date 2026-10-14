import { describe, expect, it } from 'vitest';
import {
  chipSummary,
  chipText,
  clampToWindow,
  consoleWidth,
  DEFAULT_PREFS,
  defaultLeft,
  EMPTY_SESSION,
  GAP,
  MARGIN,
  MAX_JOBS,
  MAX_WIDTH,
  nudge,
  outcomeOf,
  place,
  prefsFrom,
  reduce,
  sessionFrom,
  toStored,
  trimJobs,
  type ConsoleEvent,
  type ConsoleState,
  type Frame,
} from '../../web/src/lib/jobConsole.js';

/** Jobs 1-99 are over; 100 and up still queued or running. */
const ended = (id: number) => id < 100;
const state = (session: Partial<ConsoleState['session']> = {}, prefs: Partial<ConsoleState['prefs']> = {}): ConsoleState => ({
  session: { ...EMPTY_SESSION, ...session },
  prefs: { ...DEFAULT_PREFS, ...prefs },
});
const run = (from: ConsoleState, ...events: ConsoleEvent[]) => events.reduce((s, e) => reduce(s, e, ended), from);

describe('the job console: following jobs', () => {
  it('comes out as the bar when a job starts, with the new job selected', () => {
    const next = run(state(), { type: 'follow', id: 101 });
    expect(next.session).toEqual({ jobs: [101], selected: 101, view: 'bar' });
  });

  it('comes back as the bar from a header it went to by itself', () => {
    const settled = run(state(), { type: 'follow', id: 1 }, { type: 'settled' });
    expect(settled.session.view).toBe('chip');
    expect(run(settled, { type: 'follow', id: 102 }).session).toEqual({ jobs: [102, 1], selected: 102, view: 'bar' });
  });

  it('stays in the header the user put it in, through later jobs, until they open it', () => {
    const minimized = run(state(), { type: 'follow', id: 101 }, { type: 'minimize' });
    expect(minimized.session.view).toBe('chip');
    expect(minimized.prefs.minimized).toBe(true);

    const later = run(minimized, { type: 'follow', id: 102 });
    expect(later.session).toEqual({ jobs: [102, 101], selected: 102, view: 'chip' });

    // Remembered by the browser: a new tab starts minimized too.
    const newTab = run(state({}, { minimized: true }), { type: 'follow', id: 103 });
    expect(newTab.session.view).toBe('chip');

    const opened = run(later, { type: 'open' });
    expect(opened.session.view).toBe('log');
    expect(opened.prefs.minimized).toBe(false);
  });

  it('keeps an open console as it is, showing the new job', () => {
    expect(run(state({ jobs: [101], selected: 101, view: 'bar' }), { type: 'follow', id: 102 }).session.view).toBe('bar');
    expect(run(state({ jobs: [101], selected: 101, view: 'log' }), { type: 'follow', id: 102 }).session).toEqual({
      jobs: [102, 101],
      selected: 102,
      view: 'log',
    });
  });

  it('lists a job followed twice once, moved to the front and selected', () => {
    const next = run(state({ jobs: [102, 101], selected: 102, view: 'log' }), { type: 'follow', id: 101 });
    expect(next.session.jobs).toEqual([101, 102]);
    expect(next.session.selected).toBe(101);
  });

  it('selects only a job it follows', () => {
    const from = state({ jobs: [102, 101], selected: 102, view: 'log' });
    expect(run(from, { type: 'select', id: 101 }).session.selected).toBe(101);
    expect(run(from, { type: 'select', id: 7 })).toBe(from);
  });
});

describe('the job console: which jobs it keeps', () => {
  it('drops the oldest ended job to make room for a sixth', () => {
    const jobs = [5, 104, 3, 2, 1];
    expect(trimJobs([106, ...jobs], ended)).toEqual([106, 5, 104, 3, 2]);
    expect(run(state({ jobs, selected: 5, view: 'bar' }), { type: 'follow', id: 106 }).session.jobs).toHaveLength(MAX_JOBS);
  });

  it('never drops a job that is still queued or running, nor the one just followed', () => {
    expect(trimJobs([106, 105, 104, 103, 102, 101], ended)).toEqual([106, 105, 104, 103, 102, 101]);
    expect(trimJobs([1, 105, 104, 103, 102, 101], ended)).toEqual([1, 105, 104, 103, 102, 101]);
    expect(trimJobs([106, 105, 1, 104, 2, 103], ended)).toEqual([106, 105, 1, 104, 103]);
  });

  it('always has one of its jobs selected, or none when it has none', () => {
    let s = state();
    const events: ConsoleEvent[] = [
      { type: 'follow', id: 1 },
      { type: 'follow', id: 2 },
      { type: 'select', id: 1 },
      { type: 'follow', id: 3 },
      { type: 'follow', id: 4 },
      { type: 'follow', id: 5 },
      { type: 'follow', id: 6 },
      { type: 'select', id: 1 },
      { type: 'follow', id: 7 },
      { type: 'close' },
    ];
    for (const event of events) {
      s = run(s, event);
      const { jobs, selected } = s.session;
      if (jobs.length === 0) expect(selected).toBeNull();
      else expect(jobs).toContain(selected);
    }
    expect(s.session).toEqual(EMPTY_SESSION);
  });
});

describe('the job console: minimizing by itself', () => {
  it('goes to the header once every job in the bar has ended', () => {
    expect(run(state({ jobs: [2, 1], selected: 2, view: 'bar' }), { type: 'settled' }).session.view).toBe('chip');
  });

  it('stays while a job runs, and stays open while its log is read', () => {
    const running = state({ jobs: [101, 1], selected: 101, view: 'bar' });
    expect(run(running, { type: 'settled' })).toBe(running);
    const reading = state({ jobs: [1], selected: 1, view: 'log' });
    expect(run(reading, { type: 'settled' })).toBe(reading);
  });

  it('hides the log into the bar while a job runs, and into the header when nothing does', () => {
    expect(run(state({ jobs: [101], selected: 101, view: 'log' }), { type: 'hideLog' }).session.view).toBe('bar');
    const idle = run(state({ jobs: [1], selected: 1, view: 'log' }), { type: 'hideLog' });
    expect(idle.session.view).toBe('chip');
    // By itself: the next job brings the bar back.
    expect(idle.prefs.minimized).toBe(false);
  });
});

describe('the job console: show, minimize, open, close', () => {
  it('shows the log from the bar', () => {
    expect(run(state({ jobs: [101], selected: 101, view: 'bar' }), { type: 'showLog' }).session.view).toBe('log');
  });

  it('closes only when nothing runs, and forgets its jobs', () => {
    const running = state({ jobs: [101, 1], selected: 101, view: 'log' });
    expect(run(running, { type: 'close' })).toBe(running);
    expect(run(state({ jobs: [2, 1], selected: 2, view: 'bar' }), { type: 'close' }).session).toEqual(EMPTY_SESSION);
  });

  it('opens from the header straight to the log', () => {
    expect(run(state({ jobs: [1], selected: 1, view: 'chip' }), { type: 'open' }).session.view).toBe('log');
    const hidden = state();
    expect(run(hidden, { type: 'open' })).toBe(hidden);
  });
});

describe('the job console: what the browser stored', () => {
  it('reads anything that does not fit as an empty console', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '{"jobs":"1"}', '{"jobs":[0,-1,1.5,"2"]}', '{"jobs":[1],"view":"hidden"}']) {
      expect(sessionFrom(raw)).toEqual(EMPTY_SESSION);
    }
  });

  it('repairs what it can: a lost selection, an unknown view, repeated ids', () => {
    expect(sessionFrom('{"jobs":[3,2,3],"selected":9,"view":"floating"}')).toEqual({ jobs: [3, 2], selected: 3, view: 'chip' });
  });

  it('reads back what it wrote', () => {
    const session = { jobs: [12, 11], selected: 11, view: 'log' as const };
    expect(sessionFrom(JSON.stringify(session))).toEqual(session);
    const prefs = { position: { edge: 'left' as const, inset: 40, center: 0.25 }, minimized: true };
    expect(prefsFrom(JSON.stringify(prefs))).toEqual(prefs);
  });

  it('drops a stored place it cannot use, and keeps the rest', () => {
    for (const position of [
      null,
      'right',
      { edge: 'top', inset: 10, center: 0.5 },
      { edge: 'right', inset: -5, center: 0.5 },
      { edge: 'right', inset: 1e9, center: 0.5 },
      { edge: 'right', inset: 10, center: 1.5 },
      { edge: 'right', inset: '10', center: 0.5 },
    ]) {
      expect(prefsFrom(JSON.stringify({ position, minimized: true }))).toEqual({ position: null, minimized: true });
    }
    expect(prefsFrom('{"minimized":"yes"}')).toEqual(DEFAULT_PREFS);
    expect(prefsFrom('garbage')).toEqual(DEFAULT_PREFS);
  });
});

/** A 1440×900 window: a 242 px sidebar, a content column ending 40 px from the right. */
const laptop: Frame = { windowWidth: 1440, windowHeight: 900, contentRight: 1400, width: MAX_WIDTH, headerHeight: 56, height: 56 };
/** A 2560×1440 window: the 1280 px content column ends 519 px from the right. */
const wide: Frame = { windowWidth: 2560, windowHeight: 1440, contentRight: 2041, width: MAX_WIDTH, headerHeight: 56, height: 56 };

describe('the job console: where it sits', () => {
  it('sits just right of the content when it fits there', () => {
    expect(place(null, wide)).toEqual({ left: 2041 + GAP, top: 720 - 28 });
  });

  it('sits against the right edge when it does not', () => {
    expect(place(null, laptop)).toEqual({ left: 1440 - MARGIN - MAX_WIDTH, top: 450 - 28 });
  });

  it('keeps inside a window narrower than itself', () => {
    const phone: Frame = { ...laptop, windowWidth: 390, contentRight: 372, width: consoleWidth(390) };
    expect(consoleWidth(390)).toBe(390 - 2 * MARGIN);
    expect(place(null, phone).left).toBe(MARGIN);
    expect(defaultLeft(100, 200, 400)).toBe(MARGIN);
  });

  it('stores the nearer side, and keeps its distance to it when the window changes', () => {
    const right = toStored(900, 422, laptop);
    expect(right).toEqual({ edge: 'right', inset: 1440 - 900 - MAX_WIDTH, center: 0.5 });
    const narrower = { ...laptop, windowWidth: 1200, contentRight: 1160 };
    expect(place(right, narrower).left).toBe(1200 - right.inset - MAX_WIDTH);

    const left = toStored(300, 100, laptop);
    expect(left.edge).toBe('left');
    expect(place(left, narrower).left).toBe(300);
  });

  it('keeps the header at the same share of the window height', () => {
    const stored = toStored(300, 178, laptop);
    expect(stored.center).toBeCloseTo(206 / 900);
    expect(place(stored, { ...laptop, windowHeight: 450 }).top).toBeCloseTo((206 / 900) * 450 - 28);
  });

  it('moves an expanded console up only as far as the window needs', () => {
    const stored = toStored(300, 700, laptop);
    const expanded = { ...laptop, height: 420 };
    expect(place(stored, expanded).top).toBe(900 - MARGIN - 420);
    // The stored place is left alone: collapsed again, it is back where it was.
    expect(place(stored, laptop).top).toBe(700);
  });

  it('keeps a console dropped past an edge inside the window', () => {
    expect(clampToWindow(-200, 5000, laptop)).toEqual({ left: MARGIN, top: 900 - MARGIN - 56 });
    expect(toStored(5000, -300, laptop)).toEqual({ edge: 'right', inset: MARGIN, center: (MARGIN + 28) / 900 });
  });

  it('moves with the arrow keys, from the default place when none is stored, and not out of the window', () => {
    const from = place(null, laptop);
    const moved = nudge(null, -16, 64, laptop);
    expect(place(moved, laptop)).toEqual({ left: from.left - 16, top: from.top + 64 });
    let s = moved;
    for (let i = 0; i < 100; i++) s = nudge(s, 64, 64, laptop);
    expect(place(s, laptop)).toEqual({ left: 1440 - MARGIN - MAX_WIDTH, top: 900 - MARGIN - 56 });
  });
});

describe('the job console: the header chip', () => {
  it('counts what is still running first, then what failed, and calls the rest done', () => {
    expect(chipSummary(['done', 'running', 'failed', 'running'])).toEqual({ tone: 'running', count: 2 });
    expect(chipSummary(['done', 'failed', 'done'])).toEqual({ tone: 'failed', count: 1 });
    expect(chipSummary(['done', 'done'])).toEqual({ tone: 'done', count: 2 });
  });

  it('counts a canceled job as done, a job not read yet as running, and a lost one as failed', () => {
    expect(outcomeOf('canceled')).toBe('done');
    expect(outcomeOf('succeeded')).toBe('done');
    expect(outcomeOf('queued')).toBe('running');
    expect(outcomeOf(null)).toBe('running');
    expect(outcomeOf('running', true)).toBe('failed');
  });

  it('says it in a word or two, with the count in its name', () => {
    expect(chipText({ tone: 'running', count: 1 })).toEqual({ label: 'Running', title: 'Job console: 1 running' });
    expect(chipText({ tone: 'running', count: 3 })).toEqual({ label: '3 running', title: 'Job console: 3 running' });
    expect(chipText({ tone: 'failed', count: 2 })).toEqual({ label: '2 failed', title: 'Job console: 2 failed' });
    expect(chipText({ tone: 'done', count: 4 })).toEqual({ label: 'Done', title: 'Job console: done' });
  });
});
