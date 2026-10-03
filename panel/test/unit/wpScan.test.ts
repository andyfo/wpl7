import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, siteWpStatus, sites, type SiteRow } from '../../src/db/schema.js';
import { Schedulers } from '../../src/jobs/schedulers.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 });

function addSite(w: TestWorld, slug: string, opts: { status?: string; serverId?: number } = {}): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      serverId: opts.serverId ?? 1,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: opts.status ?? 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const docker = opts.serverId && opts.serverId !== 1 ? w.remote(opts.serverId).docker : w.docker;
  docker.containers.set(site.containerName, 'running');
  return site;
}

const PLUGIN_LIST = JSON.stringify([
  { name: 'cf7', title: 'Contact Form 7', status: 'active', version: '5.3.1', update: 'available', update_version: '6.0.1', auto_update: 'off', file: 'cf7/cf7.php' },
]);
const THEME_LIST = JSON.stringify([
  { name: 'child', title: 'Child', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off' },
]);

function scriptScan(w: TestWorld, serverId = 1, times = 1): void {
  const docker = serverId === 1 ? w.docker : w.remote(serverId).docker;
  for (let i = 0; i < times; i++) {
    docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
  }
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

describe('wp.scanAll', () => {
  it('scans every running site, skipping stopped and busy ones', async () => {
    const w = await makeWorld();
    const a = addSite(w, 'alpha');
    addSite(w, 'sleeping', { status: 'stopped' });
    const busy = addSite(w, 'busy');
    w.worker.enqueue('site.restart', { siteId: busy.id }, { id: busy.id, slug: busy.slug, serverId: 1 });
    scriptScan(w, 1, 1);

    const job = w.worker.enqueue('wp.scanAll', {});
    // The restart job is claimed too; let it run against the default exec answer.
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    const result = JSON.parse(done.result!) as { scanned: number; skippedStopped: number; skippedBusy: number };
    expect(result).toMatchObject({ scanned: 1, skippedStopped: 1, skippedBusy: 1 });
    expect(w.db.select().from(siteWpStatus).all().map((r) => r.siteId)).toEqual([a.id]);
  });

  it('covers every server and keeps going when one site fails', async () => {
    const w = await makeWorld();
    const second = w.addSshServer('worker-2');
    addSite(w, 'alpha');
    addSite(w, 'broken');
    addSite(w, 'remote-site', { serverId: second.id });
    // Server 1 runs its two sites in order: the first scans, the second fatals twice (the
    // listing and its --skip-plugins retry).
    w.docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
    w.docker.execQueue.push(fail('container gone'), fail('container gone'));
    scriptScan(w, second.id, 1);

    const job = w.worker.enqueue('wp.scanAll', {});
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    expect(JSON.parse(done.result!)).toMatchObject({ scanned: 2, failed: 1 });
    const scanned = w.db.select().from(siteWpStatus).all();
    expect(scanned.filter((r) => r.scannedAt !== null)).toHaveLength(2);
  });

  it('skips a server the panel cannot reach rather than failing the pass', async () => {
    const w = await makeWorld();
    const second = w.addSshServer('worker-2');
    addSite(w, 'alpha');
    addSite(w, 'remote-site', { serverId: second.id });
    w.db.update(sites).set({ status: 'running' }).run();
    w.servers.markUnreachable(second.id, new Error('ssh: connect: connection refused'));
    scriptScan(w, 1, 1);

    const done = await runJob(w, w.worker.enqueue('wp.scanAll', {}).id);
    expect(done.status).toBe('succeeded');
    expect(JSON.parse(done.result!)).toMatchObject({ scanned: 1 });
  });

  it('fails when every site in the pass failed, so it is not a silent no-op', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    w.docker.execQueue.push(fail('container gone'), fail('container gone'));

    const done = await runJob(w, w.worker.enqueue('wp.scanAll', {}).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/failed to scan/);
  });
});

describe('wp-scan scheduler tick', () => {
  const tick = (s: Schedulers) => s.run('wp-scan', 'timer');

  it('enqueues one scan when the snapshot is overdue, and never a second', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const schedulers = new Schedulers(w.core, w.worker);

    expect(schedulers.wpScanIsDue()).toBe(true);
    await tick(schedulers);
    await tick(schedulers);

    const scans = w.db.select().from(jobs).where(eq(jobs.type, 'wp.scanAll')).all();
    expect(scans).toHaveLength(1);
    schedulers.stop();
  });

  it('is due for a site nobody has scanned, however busy the rest of the fleet is', async () => {
    const w = await makeWorld();
    const busy = addSite(w, 'busy');
    addSite(w, 'forgotten');
    scriptScan(w, 1, 1);
    // One site is scanned constantly (a "Check now", a plugin update, a bulk run…).
    await w.core.wpInventory.scanSite(busy, w.servers.handleFor(1), { refreshFeed: false });
    const schedulers = new Schedulers(w.core, w.worker);

    // Measuring the freshest snapshot in the fleet let that one site postpone everybody.
    expect(schedulers.wpScanIsDue()).toBe(true);
    schedulers.stop();
  });

  it('is due when one site is stale even though another was scanned a minute ago', async () => {
    const w = await makeWorld();
    const fresh = addSite(w, 'fresh');
    const stale = addSite(w, 'stale');
    scriptScan(w, 1, 2);
    await w.core.wpInventory.scanSite(fresh, w.servers.handleFor(1), { refreshFeed: false });
    await w.core.wpInventory.scanSite(stale, w.servers.handleFor(1), { refreshFeed: false });
    w.db
      .update(siteWpStatus)
      .set({ scannedAt: Date.now() - 48 * 3600_000 })
      .where(eq(siteWpStatus.siteId, stale.id))
      .run();

    const schedulers = new Schedulers(w.core, w.worker);
    expect(schedulers.wpScanIsDue()).toBe(true);
    schedulers.stop();
  });

  it('ignores stopped sites, which the pass would skip anyway', async () => {
    const w = await makeWorld();
    addSite(w, 'sleeping', { status: 'stopped' });
    const schedulers = new Schedulers(w.core, w.worker);
    expect(schedulers.wpScanIsDue()).toBe(false);
    schedulers.stop();
  });

  it('does not queue a pass every tick for a site that cannot be scanned', async () => {
    const w = await makeWorld();
    addSite(w, 'unreachable');
    const schedulers = new Schedulers(w.core, w.worker);

    await tick(schedulers);
    const first = w.db.select().from(jobs).where(eq(jobs.type, 'wp.scanAll')).all();
    expect(first).toHaveLength(1);
    // The pass ran and could not scan it, so the site is still overdue - but a second pass
    // inside the interval would just repeat the failure every ten minutes.
    w.db.update(jobs).set({ status: 'failed', finishedAt: Date.now() }).where(eq(jobs.id, first[0]!.id)).run();
    expect(schedulers.wpScanIsDue()).toBe(false);
    await tick(schedulers);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'wp.scanAll')).all()).toHaveLength(1);

    // Once the interval has elapsed, it tries again.
    w.db
      .update(jobs)
      .set({ createdAt: Date.now() - 7 * 3600_000 })
      .where(eq(jobs.id, first[0]!.id))
      .run();
    expect(schedulers.wpScanIsDue()).toBe(true);
    schedulers.stop();
  });

  it('leaves a fresh snapshot alone until the interval has passed', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    scriptScan(w, 1, 1);
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1), { refreshFeed: false });
    const schedulers = new Schedulers(w.core, w.worker);

    expect(schedulers.wpScanIsDue()).toBe(false);
    await tick(schedulers);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'wp.scanAll')).all()).toHaveLength(0);

    // Seven hours later, with the default six-hour interval, it is due again.
    w.db
      .update(siteWpStatus)
      .set({ scannedAt: Date.now() - 7 * 3600_000 })
      .where(eq(siteWpStatus.siteId, site.id))
      .run();
    expect(schedulers.wpScanIsDue()).toBe(true);

    // And the setting is what decides: a longer interval makes the same snapshot fresh.
    w.core.settings.set('wpScanIntervalHours', 24);
    expect(schedulers.wpScanIsDue()).toBe(false);
    schedulers.stop();
  });

  it('is not put off by a schedule that scans only some of the sites', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    addSite(w, 'beta');
    const schedulers = w.deps.schedulers;
    expect(schedulers.wpScanIsDue()).toBe(true);

    // An hourly custom schedule that scans alpha, and only alpha.
    const hourly = schedulers.createCustom({
      name: 'alpha, hourly',
      action: 'wp.scan',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '0 * * * *',
    });
    const [scan] = (await schedulers.runNow(String(hourly.id), 'full')).jobs;
    scriptScan(w, 1, 1);
    expect((await runJob(w, scan!.id)).status).toBe('succeeded');

    // beta has never been scanned, and nothing has scanned the fleet: counting alpha's scan as
    // a fleet pass kept the automatic one off for as long as the hourly schedule kept running.
    expect(schedulers.wpScanIsDue()).toBe(true);
    expect(w.deps.wpBulk.lastScanJob()).toBeUndefined();
    await tick(schedulers);
    const fleet = w.db.select().from(jobs).where(eq(jobs.type, 'wp.scanAll')).all().at(-1)!;
    expect(fleet.id).not.toBe(scan!.id);
    expect(JSON.parse(fleet.payload)).toEqual({});

    // A pass over the whole fleet is what holds off the next one, and what the Bulk page shows.
    w.db.update(jobs).set({ status: 'failed', finishedAt: Date.now() }).where(eq(jobs.id, fleet.id)).run();
    expect(schedulers.wpScanIsDue()).toBe(false);
    expect(w.deps.wpBulk.lastScanJob()?.id).toBe(fleet.id);
  });

  it('does not queue scans on an install with no sites', async () => {
    const w = await makeWorld();
    const schedulers = new Schedulers(w.core, w.worker);
    expect(schedulers.wpScanIsDue()).toBe(false);
    await tick(schedulers);
    expect(w.db.select().from(jobs).all()).toHaveLength(0);
    schedulers.stop();
  });
});
