import { describe, expect, it } from 'vitest';
import type { ScheduleDto } from '../../shared/types.js';
import {
  backgroundSummary,
  cronScheduleProblem,
  isPaused,
  nextRunsTooltip,
  parseRestBody,
  restRouteProblem,
  sortSchedules,
  suggestName,
  targetText,
} from '../../web/src/lib/schedules.js';

const schedule = (id: number, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id,
  key: null,
  kind: 'custom',
  group: 'custom',
  name: `Schedule ${id}`,
  description: '',
  action: 'backup',
  target: { kind: 'all' },
  missing: [],
  params: {},
  cadence: { cron: '0 3 * * *', everyMs: null, runAt: null, text: 'At 03:00, every day.' },
  settingsHref: null,
  enabled: true,
  pausedAt: null,
  pausable: true,
  lockedReason: null,
  pauseWarning: null,
  running: false,
  finished: false,
  nextRunAt: 1_000 + id,
  lastRunAt: null,
  lastDurationMs: null,
  lastOutcome: null,
  lastError: null,
  lastResult: null,
  lastJobs: null,
  createdBy: 'andy',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const SERVERS = [
  { id: 1, name: 'local' },
  { id: 2, name: 'hetzner-1' },
];

describe('schedule targets in words', () => {
  it('names the sites of a short list and counts the rest', () => {
    expect(targetText({ kind: 'sites', slugs: ['shop'] })).toBe('shop');
    expect(targetText({ kind: 'sites', slugs: ['shop', 'blog'] })).toBe('shop and blog');
    expect(targetText({ kind: 'sites', slugs: ['shop', 'blog', 'news'] })).toBe('shop, blog and news');
    expect(targetText({ kind: 'sites', slugs: ['a', 'b', 'c', 'd', 'e'] })).toBe('a, b and 3 more');
  });

  it('names a server, and falls back to its id when it is gone', () => {
    expect(targetText({ kind: 'server', serverId: 2 }, SERVERS)).toBe('running sites on hetzner-1');
    expect(targetText({ kind: 'server', serverId: 9 }, SERVERS)).toBe('running sites on server #9');
    // "Start sites" on a server starts the ones that are stopped there.
    expect(targetText({ kind: 'server', serverId: 2 }, SERVERS, 'site.start')).toBe('stopped sites on hetzner-1');
  });

  it('says what "all" and "panel" mean', () => {
    expect(targetText({ kind: 'all' })).toBe('all running sites');
    expect(targetText({ kind: 'panel' })).toBe('the panel');
    expect(targetText(null)).toBe('');
  });
});

describe('suggested names', () => {
  it('says what it does to what', () => {
    expect(suggestName('backup', { kind: 'sites', slugs: ['shop'] })).toBe('Back up shop');
    expect(suggestName('backup', { kind: 'sites', slugs: ['shop', 'blog'] })).toBe('Back up 2 sites');
    expect(suggestName('site.restart', { kind: 'server', serverId: 2 }, { servers: SERVERS })).toBe(
      'Restart sites on hetzner-1',
    );
    expect(suggestName('wp.scan', { kind: 'all' })).toBe('Scan all sites');
    expect(suggestName('panel.snapshot', { kind: 'panel' })).toBe('Panel snapshot');
  });

  it('uses the options that tell two schedules of one action apart', () => {
    expect(suggestName('wp.update', { kind: 'all' }, { params: { onlyVulnerable: true } })).toBe(
      'Security updates on all sites',
    );
    expect(suggestName('wp.update', { kind: 'all' }, { params: { onlyVulnerable: false } })).toBe('Update all sites');
    expect(suggestName('wp.cli', { kind: 'all' }, { params: { args: ['cache', 'flush'] } })).toBe(
      'wp cache flush on all sites',
    );
    expect(suggestName('wp.cli', { kind: 'sites', slugs: ['shop'] })).toBe('WP-CLI on shop');
    expect(
      suggestName('wp.rest', { kind: 'sites', slugs: ['shop'] }, { params: { method: 'POST', route: '/wp-json/shop/v1/sync?x=1' } }),
    ).toBe('POST /wp-json/shop/v1/sync on shop');
    expect(suggestName('wp.rest', { kind: 'all' }, { params: { route: '' } })).toBe('REST request on all sites');
    // A route the form is refusing is not worth a name.
    expect(suggestName('wp.rest', { kind: 'all' }, { params: { route: 'https://shop.example.com/wp-json/x' } })).toBe(
      'REST request on all sites',
    );
  });

  it('copes with nothing chosen yet, and never exceeds the 100 characters a name may have', () => {
    expect(suggestName('backup', null)).toBe('Back up sites');
    expect(suggestName('backup', { kind: 'sites', slugs: [] })).toBe('Back up sites');
    const long = suggestName('wp.cli', { kind: 'all' }, { params: { args: ['eval', 'x'.repeat(200)] } });
    expect(long.length).toBeLessThanOrEqual(100);
  });
});

describe('custom cron expressions', () => {
  it('takes what the panel takes', () => {
    expect(cronScheduleProblem('0 3 * * *', 'UTC')).toBeNull();
    expect(cronScheduleProblem('*/5 * * * *', 'UTC')).toBeNull();
    expect(cronScheduleProblem('30 2 * * 1-5')).toBeNull();
  });

  it('refuses runs closer than five minutes, the day boundary included', () => {
    expect(cronScheduleProblem('* * * * *', 'UTC')).toMatch(/at most every 5 minutes/);
    expect(cronScheduleProblem('*/2 3 * * *', 'UTC')).toMatch(/at most every 5 minutes/);
    // 23:58 today and 00:00 tomorrow are two minutes apart.
    expect(cronScheduleProblem('0,58 0,23 * * *', 'UTC')).toMatch(/at most every 5 minutes/);
  });

  it('refuses what the five boxes cannot hold, and dates that never come', () => {
    expect(cronScheduleProblem('0 3 * *', 'UTC')).toMatch(/five fields/);
    expect(cronScheduleProblem('0 0 3 * * *', 'UTC')).toMatch(/five fields/);
    expect(cronScheduleProblem('0 3 31 2 *', 'UTC')).not.toBeNull();
  });
});

describe('next runs', () => {
  it('lists the next runs of a cron schedule', () => {
    const tip = nextRunsTooltip(schedule(1), 'UTC');
    expect(tip).toMatch(/^Next: /);
    expect(tip?.split(' · ')).toHaveLength(3);
    expect(tip).toMatch(/\(UTC\)$/);
  });

  it('gives a one-off its time, and an interval task its next tick', () => {
    const once = schedule(1, { cadence: { cron: null, everyMs: null, runAt: Date.UTC(2030, 0, 1, 3), text: '' } });
    expect(nextRunsTooltip(once, 'UTC')).toMatch(/^Once: .*03:00/);
    const interval = schedule(2, { cadence: { cron: null, everyMs: 60_000, runAt: null, text: 'Every minute' } });
    expect(nextRunsTooltip({ ...interval, nextRunAt: Date.UTC(2030, 0, 1, 4) }, 'UTC')).toMatch(/^Next: .*04:00/);
    expect(nextRunsTooltip({ ...interval, nextRunAt: null })).toBeUndefined();
  });
});

describe('ordering schedules', () => {
  it('puts running first, then the soonest, then paused, then one-offs that are done', () => {
    const items = [
      schedule(1, { enabled: false, finished: true, nextRunAt: null }),
      schedule(2, { enabled: false, pausedAt: 5, nextRunAt: null }),
      schedule(3, { nextRunAt: 9_000 }),
      schedule(4, { nextRunAt: 2_000 }),
      schedule(5, { running: true, nextRunAt: 50_000 }),
      schedule(6, { nextRunAt: null }),
    ];
    expect(sortSchedules(items).map((s) => s.id)).toEqual([5, 4, 3, 6, 2, 1]);
    // A copy: the query's own array is left alone.
    expect(items.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('tells paused apart from done', () => {
    expect(isPaused({ enabled: false, finished: false })).toBe(true);
    expect(isPaused({ enabled: false, finished: true })).toBe(false);
    expect(isPaused({ enabled: true, finished: false })).toBe(false);
  });
});

describe('the background tasks line', () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => schedule(i + 1, { lastOutcome: 'ok' }));

  it('says all is well when it is', () => {
    expect(backgroundSummary(tasks(12))).toBe('12 tasks · all ok');
    expect(backgroundSummary(tasks(1))).toBe('1 task · all ok');
  });

  it('names what is failing or paused', () => {
    const items = tasks(12);
    items[3] = { ...items[3]!, name: 'Mail log', lastOutcome: 'failed' };
    expect(backgroundSummary(items)).toBe('12 tasks · 1 failing: Mail log');
    items[5] = { ...items[5]!, name: 'Uptime checks', enabled: false, pausedAt: 1 };
    expect(backgroundSummary(items)).toBe('12 tasks · 1 failing: Mail log · 1 paused: Uptime checks');
  });

  it('keeps a long list of names short', () => {
    const items = tasks(5).map((s, i) => ({ ...s, name: `T${i}`, lastOutcome: 'failed' as const }));
    expect(backgroundSummary(items)).toBe('5 tasks · 5 failing: T0, T1 and 3 more');
  });
});

describe('the REST request fields', () => {
  it('says what is wrong with a route, in a sentence', () => {
    expect(restRouteProblem('wp/v2/posts?per_page=5')).toBeNull();
    expect(restRouteProblem('  ')).toBe('Type the route to request, such as wp/v2/posts.');
    expect(restRouteProblem('https://shop.example.com/wp-json/wp/v2/posts')).toMatch(/^Give the route after \/wp-json\/.*not a whole address\.$/);
    expect(restRouteProblem('wp/v2/posts?search=two words')).toMatch(/^A route has no spaces/);
  });

  it('reads a JSON body, or says why it cannot be sent', () => {
    expect(parseRestBody('')).toEqual({ problem: null });
    expect(parseRestBody('{"status": "publish"}')).toEqual({ value: { status: 'publish' }, problem: null });
    expect(parseRestBody('[1, 2]').value).toEqual([1, 2]);
    expect(parseRestBody('{status: publish}').problem).toMatch(/^The body is not valid JSON/);
    expect(parseRestBody('"text"').problem).toBe('The body is a JSON object ({…}) or a list ([…]).');
    expect(parseRestBody(JSON.stringify({ big: 'x'.repeat(70_000) })).problem).toBe('The body may be at most 64 KB.');
  });
});
