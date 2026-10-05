import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, schedules, sites, type SiteRow } from '../../src/db/schema.js';
import { runAs } from '../../src/jobs/actor.js';
import type { RunHow } from '../../src/jobs/schedulers.js';
import { makeWorld, type TestWorld } from '../helpers.js';

function addSite(w: TestWorld, slug: string, status = 'running'): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status,
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, status === 'running' ? 'running' : 'exited');
  return site;
}

const jobsOfType = (w: TestWorld, type: string) => w.db.select().from(jobs).where(eq(jobs.type, type)).all();
const row = (w: TestWorld, key: string) => w.db.select().from(schedules).where(eq(schedules.key, key)).get()!;

describe('built-in schedules', () => {
  it('lists every built-in task, grouped, with what can and cannot be paused', async () => {
    const w = await makeWorld();
    const list = w.deps.schedulers.list();
    const byKey = new Map(list.map((s) => [s.key, s]));
    expect([...byKey.keys()]).toEqual([
      'backups',
      'wp-scan',
      'malware-scan',
      'offsite',
      'site-limits',
      'housekeeping',
      'wp-cron',
      'uptime',
      'site-stats',
      'server-stats',
      'disk-usage',
      'traffic-ingest',
      'update-check',
      'catalog',
      'mail-ingest',
      'site-networks',
      'site-protection',
      'blocked-addresses',
      'wildcard-token',
      'ftp',
      'update-watchdog',
    ]);
    expect(byKey.get('backups')).toMatchObject({ kind: 'builtin', group: 'jobs', pausable: true, settingsHref: '/settings#backups' });
    expect(byKey.get('backups')!.cadence.cron).toBe(w.deps.settings.get('backupCron'));
    expect(byKey.get('uptime')!.group).toBe('background');
    for (const key of ['mail-ingest', 'site-networks', 'site-protection', 'blocked-addresses', 'wildcard-token', 'ftp', 'update-watchdog']) {
      expect(byKey.get(key)!.pausable, key).toBe(false);
      expect(byKey.get(key)!.lockedReason, key).toBeTruthy();
    }
    // Not started (as in every test): nothing is armed, so nothing claims a next run.
    expect(byKey.get('backups')!.nextRunAt).toBeNull();
  });

  it('a paused task skips its timer runs, and "Run now" still works', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const sched = w.deps.schedulers;
    sched.update('backups', { enabled: false });
    expect(sched.backupsPaused()).toBe(true);
    expect(row(w, 'backups').pausedAt).not.toBeNull();

    expect(await sched.run('backups', 'timer')).toBeNull();
    expect(jobsOfType(w, 'backup.create')).toHaveLength(0);

    const run = await runAs({ origin: 'user', createdBy: 'alice' }, () => sched.runNow('backups', 'full'));
    expect(run.jobs.map((j) => j.type).sort()).toEqual(['backup.create', 'panel.snapshot']);
    // "Run now" keeps who pressed it, and which schedule it ran.
    const backup = jobsOfType(w, 'backup.create')[0]!;
    expect(backup).toMatchObject({ origin: 'user', createdBy: 'alice', scheduleId: row(w, 'backups').id });

    sched.update('backups', { enabled: true });
    expect(row(w, 'backups').pausedAt).toBeNull();
  });

  it('credits the jobs a timer run queues to the schedule, and records the run', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const report = await w.deps.schedulers.run('backups', 'timer');
    expect(report!.jobs).toHaveLength(2);
    const backup = jobsOfType(w, 'backup.create')[0]!;
    expect(backup).toMatchObject({ origin: 'schedule', createdBy: 'Scheduled backups', scheduleId: row(w, 'backups').id });

    const dto = w.deps.schedulers.get('backups');
    expect(dto.lastOutcome).toBe('ok');
    expect(dto.lastRunAt).not.toBeNull();
    expect(dto.lastResult).toMatchObject({ jobs: 2, skipped: [] });
    expect(dto.lastJobs).toEqual({ queued: 2 });
  });

  it('reports a busy site as skipped rather than failing the run', async () => {
    const w = await makeWorld();
    const busy = addSite(w, 'busy');
    addSite(w, 'free');
    w.worker.enqueue('site.restart', { siteId: busy.id }, { id: busy.id, slug: busy.slug });
    const report = await w.deps.schedulers.run('backups', 'timer');
    expect(report!.skipped).toEqual([expect.objectContaining({ siteSlug: 'busy' })]);
    expect(w.deps.schedulers.get('backups').lastOutcome).toBe('ok');
  });

  it('does not record a run that had nothing to do', async () => {
    const w = await makeWorld();
    // No sites: the WordPress scan is not due.
    await w.deps.schedulers.run('wp-scan', 'timer');
    expect(row(w, 'wp-scan').lastRunAt).toBeNull();
    // A person asking is always recorded.
    await w.deps.schedulers.runNow('wp-scan', 'full');
    expect(row(w, 'wp-scan').lastRunAt).not.toBeNull();
  });

  it('records a failing tick, and keeps the timer alive', async () => {
    const w = await makeWorld();
    const monitor = w.core.monitor as unknown as { tickUptime: () => Promise<void> };
    const original = monitor.tickUptime;
    monitor.tickUptime = async () => {
      throw new Error('probe exploded');
    };
    try {
      await expect(w.deps.schedulers.run('uptime', 'timer')).resolves.not.toBeNull();
      const dto = w.deps.schedulers.get('uptime');
      expect(dto.lastOutcome).toBe('failed');
      expect(dto.lastError).toBe('probe exploded');
    } finally {
      monitor.tickUptime = original;
    }
  });

  it('never runs the same task twice at once', async () => {
    const w = await makeWorld();
    const monitor = w.core.monitor as unknown as { tickUptime: () => Promise<void> };
    const original = monitor.tickUptime;
    let release!: () => void;
    let calls = 0;
    monitor.tickUptime = () => {
      calls++;
      return new Promise<void>((r) => (release = r));
    };
    try {
      const first = w.deps.schedulers.run('uptime', 'timer');
      expect(w.deps.schedulers.get('uptime').running).toBe(true);
      expect(await w.deps.schedulers.run('uptime', 'boot')).toBeNull();
      release();
      await first;
      expect(calls).toBe(1);
      expect(w.deps.schedulers.get('uptime').running).toBe(false);
    } finally {
      monitor.tickUptime = original;
    }
  });

  it('refuses to pause what must keep running, and to change a built-in cadence', async () => {
    const w = await makeWorld();
    expect(() => w.deps.schedulers.update('mail-ingest', { enabled: false })).toThrow(/cannot be paused/);
    expect(() => w.deps.schedulers.update('backups', { cron: '0 5 * * *' })).toThrow(/only be paused or resumed/);
    expect(() => w.deps.schedulers.removeCustom('backups')).toThrow(/cannot be deleted/);
  });

  it('holds a paused "Offsite copies" against the kicks too', async () => {
    const w = await makeWorld();
    const offsite = w.core.offsite as unknown as { anyConfigured: () => boolean; tick: () => { created: number; enqueued: number } };
    const originals = { any: offsite.anyConfigured, tick: offsite.tick };
    let ticks = 0;
    offsite.anyConfigured = () => true;
    offsite.tick = () => {
      ticks++;
      return { created: 1, enqueued: 1 };
    };
    try {
      w.core.offsite.kick();
      expect(ticks).toBe(1);
      w.deps.schedulers.update('offsite', { enabled: false });
      w.core.offsite.kick();
      expect(ticks).toBe(1);
    } finally {
      offsite.anyConfigured = originals.any;
      offsite.tick = originals.tick;
    }
  });

  it('queues the nightly housekeeping as a job in its own lane, once', async () => {
    const w = await makeWorld();
    await w.deps.schedulers.run('housekeeping', 'timer');
    await w.deps.schedulers.run('housekeeping', 'timer');
    const queued = jobsOfType(w, 'system.housekeeping');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.lane).toBe('housekeeping');
    expect(w.deps.schedulers.get('housekeeping').lastOutcome).toBe('skipped');
  });

  it('arms a timer for every task that runs on an interval, and runs at boot what cannot wait', async () => {
    const w = await makeWorld();
    const sched = w.deps.schedulers;
    const runs: [string, RunHow][] = [];
    vi.spyOn(sched, 'run').mockImplementation(async (key, how) => {
      runs.push([key, how]);
      return null;
    });
    vi.spyOn(sched, 'runDueCustom').mockResolvedValue();
    vi.useFakeTimers();
    try {
      sched.start();
      // A token seeded from deploy/.env on this boot is on no server yet, and no change kicks it.
      expect(runs).toContainEqual(['wildcard-token', 'boot']);
      vi.advanceTimersByTime(61 * 60_000);
      const timed = new Set(runs.filter(([, how]) => how === 'timer').map(([key]) => key));
      const interval = sched.list().filter((t) => t.kind === 'builtin' && t.cadence.everyMs !== null);
      expect(interval.map((t) => t.key)).toContain('wildcard-token');
      for (const task of interval) expect(timed.has(task.key!), task.key!).toBe(true);
    } finally {
      sched.stop();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('does not arm a cron before it is started', async () => {
    const w = await makeWorld();
    const sched = w.deps.schedulers;
    sched.scheduleBackups('* * * * * *');
    expect((sched as unknown as { backupCron: unknown }).backupCron).toBeNull();
    expect(sched.get('backups').cadence.cron).toBe('* * * * * *');
  });
});
