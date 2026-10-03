import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, schedules, sites, type SiteRow } from '../../src/db/schema.js';
import { customCronProblem, graceMs } from '../../src/services/schedules.js';
import { MAX_CUSTOM_SCHEDULES } from '../../shared/scheduleActions.js';
import { makeWorld, type TestWorld } from '../helpers.js';

function addSite(w: TestWorld, slug: string, opts: { status?: string; serverId?: number; backupsEnabled?: number } = {}): SiteRow {
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
      backupsEnabled: opts.backupsEnabled ?? 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, (opts.status ?? 'running') === 'running' ? 'running' : 'exited');
  return site;
}

const HOUR = 3600_000;
const allJobs = (w: TestWorld) => w.db.select().from(jobs).all();
const scheduleRow = (w: TestWorld, id: number) => w.db.select().from(schedules).where(eq(schedules.id, id)).get()!;

describe('custom schedule validation', () => {
  it('accepts only five-field crons at least five minutes apart', () => {
    expect(customCronProblem('0 3 * * *')).toBeNull();
    expect(customCronProblem('*/5 * * * *')).toBeNull();
    expect(customCronProblem('* * * * *')).toMatch(/at most every 5 minutes/);
    expect(customCronProblem('0,2 3 * * *')).toMatch(/at most every 5 minutes/);
    // A day boundary counts too: 23:59 and 00:00 are a minute apart.
    expect(customCronProblem('59 23 * * *')).toBeNull();
    expect(customCronProblem('0,59 0,23 * * *')).toMatch(/at most every 5 minutes/);
    expect(customCronProblem('*/10 * * * * *')).toMatch(/five fields/);
    expect(customCronProblem('0 3 31 2 *')).toMatch(/never runs|Invalid|not/i);
  });

  it('refuses what cannot work, with the reason', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const s = w.deps.schedulers;
    const base = { name: 'x', action: 'site.restart', target: { kind: 'sites', slugs: ['alpha'] }, cron: '0 3 * * *' };
    expect(() => s.createCustom({ ...base, cron: undefined })).toThrow(/either "cron"/);
    expect(() => s.createCustom({ ...base, runAt: Date.now() + HOUR })).toThrow(/either "cron"/);
    expect(() => s.createCustom({ ...base, target: { kind: 'sites', slugs: ['nope'] } })).toThrow(/No such site: "nope"/);
    expect(() => s.createCustom({ ...base, target: { kind: 'panel' } })).toThrow(/runs on .* targets/);
    expect(() => s.createCustom({ ...base, target: { kind: 'server', serverId: 99 } })).toThrow(/No such server/);
    expect(() => s.createCustom({ ...base, cron: '* * * * *' })).toThrow(/cron: Runs may be at most every 5 minutes/);
    expect(() => s.createCustom({ ...base, cron: undefined, runAt: Date.now() - 1000 })).toThrow(/already passed/);
    expect(() => s.createCustom({ ...base, action: 'wp.cli', params: { args: [] } })).toThrow(/params\.args/);
    expect(() => s.createCustom({ ...base, action: 'wp.update', params: { plugins: false, themes: false, core: false } })).toThrow(
      /Choose plugins, themes or WordPress core/,
    );
  });

  it('stops at the cap', async () => {
    const w = await makeWorld();
    const now = Date.now();
    for (let i = 0; i < MAX_CUSTOM_SCHEDULES; i++) {
      w.db.insert(schedules).values({ name: `s${i}`, action: 'panel.snapshot', target: '{"kind":"panel"}', params: '{}', cron: '0 3 * * *', createdAt: now, updatedAt: now }).run();
    }
    expect(() =>
      w.deps.schedulers.createCustom({ name: 'one more', action: 'panel.snapshot', target: { kind: 'panel' }, cron: '0 3 * * *' }),
    ).toThrow(/already 100 custom schedules/);
  });
});

describe('custom schedules firing', () => {
  it('fires when due, as the schedule, and moves on to the next occurrence', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom(
      { name: 'Restart alpha', action: 'site.restart', target: { kind: 'sites', slugs: ['alpha'] }, cron: '0 3 * * *' },
      'alice',
    );
    expect(created).toMatchObject({ kind: 'custom', group: 'custom', createdBy: 'alice', enabled: true });
    const due = created.nextRunAt!;
    expect(due).toBeGreaterThan(Date.now());

    await w.deps.schedulers.runDueCustom(due - 1000);
    expect(allJobs(w)).toHaveLength(0);

    await w.deps.schedulers.runDueCustom(due + 1000);
    const [job] = allJobs(w);
    expect(job).toMatchObject({ type: 'site.restart', origin: 'schedule', createdBy: 'Restart alpha', scheduleId: created.id });
    const after = w.deps.schedulers.get(String(created.id));
    expect(after.nextRunAt).toBe(due + 24 * HOUR);
    expect(after.lastOutcome).toBe('ok');
    expect(after.lastJobs).toEqual({ queued: 1 });

    // Fired at most once for that occurrence.
    w.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
    await w.deps.schedulers.runDueCustom(due + 2000);
    expect(allJobs(w)).toHaveLength(1);
  });

  it('skips a run it missed by more than its grace, and never bursts', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom({
      name: 'Hourly restart',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '0 * * * *',
    });
    const due = created.nextRunAt!;
    expect(graceMs(scheduleRow(w, created.id))).toBe(30 * 60_000);

    // The panel was down for five hours: one "missed", no pile of five restarts.
    await w.deps.schedulers.runDueCustom(due + 5 * HOUR);
    expect(allJobs(w)).toHaveLength(0);
    const dto = w.deps.schedulers.get(String(created.id));
    expect(dto.lastOutcome).toBe('skipped');
    expect(dto.lastResult?.message).toMatch(/Missed the run/);
    expect(dto.nextRunAt).toBeGreaterThan(due + 5 * HOUR);

    // Late, but inside the grace: it still runs.
    await w.deps.schedulers.runDueCustom(dto.nextRunAt! + 10 * 60_000);
    expect(allJobs(w)).toHaveLength(1);
  });

  it('runs a one-off once, then keeps it as done', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const at = Date.now() + HOUR;
    const created = w.deps.schedulers.createCustom({
      name: 'Once',
      action: 'backup',
      target: { kind: 'sites', slugs: ['alpha'] },
      runAt: at,
    });
    await w.deps.schedulers.runDueCustom(at + 5000);
    const [job] = allJobs(w);
    expect(job!.type).toBe('backup.create');
    expect(JSON.parse(job!.payload)).toEqual({ siteId: expect.any(Number), type: 'scheduled', note: 'Once' });
    const done = w.deps.schedulers.get(String(created.id));
    expect(done).toMatchObject({ finished: true, enabled: false, nextRunAt: null, pausedAt: null });

    // Renaming a finished one-off needs no new time: its old one is only checked when it changes.
    expect(w.deps.schedulers.update(String(created.id), { name: 'Once, done' })).toMatchObject({ name: 'Once, done', finished: true });
    // Resuming it needs a new time; giving one re-arms it.
    expect(() => w.deps.schedulers.update(String(created.id), { enabled: true })).toThrow(/already run/);
    const rearmed = w.deps.schedulers.update(String(created.id), { enabled: true, runAt: Date.now() + 2 * HOUR });
    expect(rearmed).toMatchObject({ finished: false, enabled: true });
  });

  it('resumes from now rather than catching up', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom({
      name: 'x',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '*/5 * * * *',
    });
    const paused = w.deps.schedulers.update(String(created.id), { enabled: false });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
    expect(paused.pausedAt).not.toBeNull();
    const resumed = w.deps.schedulers.update(String(created.id), { enabled: true });
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
    expect(resumed.pausedAt).toBeNull();
  });

  it('waits out a panel update', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom({
      name: 'x',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '0 3 * * *',
    });
    w.core.settings.setRaw('system.maintenance', { reason: 'Updating', since: Date.now() });
    await w.deps.schedulers.runDueCustom(created.nextRunAt! + 1000);
    expect(allJobs(w)).toHaveLength(0);
    expect(scheduleRow(w, created.id).nextRunAt).toBe(created.nextRunAt);
  });

  it('skips busy, stopped and deleted sites with a reason, and runs the rest', async () => {
    const w = await makeWorld();
    const busy = addSite(w, 'busy');
    addSite(w, 'idle');
    addSite(w, 'asleep', { status: 'stopped' });
    addSite(w, 'gone');
    w.worker.enqueue('site.restart', { siteId: busy.id }, { id: busy.id, slug: busy.slug });
    const created = w.deps.schedulers.createCustom({
      name: 'cache',
      action: 'wp.cli',
      target: { kind: 'sites', slugs: ['busy', 'idle', 'asleep', 'gone'] },
      params: { args: ['cache', 'flush'] },
      cron: '0 3 * * *',
    });
    // Valid when the schedule was made, deleted since.
    w.db.delete(sites).where(eq(sites.slug, 'gone')).run();
    const report = await w.deps.schedulers.runNow(String(created.id), 'full');
    expect(report.jobs.map((j) => j.siteSlug)).toEqual(['idle']);
    expect(report.skipped.map((s) => s.siteSlug).sort()).toEqual(['asleep', 'busy', 'gone']);
    expect(report.skipped.find((s) => s.siteSlug === 'gone')!.reason).toBe('no longer exists');
    expect(w.deps.schedulers.get(String(created.id)).missing).toEqual(['gone']);
  });

  it('honours the per-site backup switch for "all" but not for a named list', async () => {
    const w = await makeWorld();
    addSite(w, 'in');
    addSite(w, 'out', { backupsEnabled: 0 });
    const all = w.deps.schedulers.createCustom({ name: 'all', action: 'backup', target: { kind: 'all' }, cron: '0 3 * * *' });
    expect((await w.deps.schedulers.runNow(String(all.id), 'full')).jobs.map((j) => j.siteSlug)).toEqual(['in']);
    w.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
    const named = w.deps.schedulers.createCustom({
      name: 'named',
      action: 'backup',
      target: { kind: 'sites', slugs: ['out'] },
      cron: '0 3 * * *',
    });
    expect((await w.deps.schedulers.runNow(String(named.id), 'full')).jobs.map((j) => j.siteSlug)).toEqual(['out']);
  });

  it('queues the right job for each action', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    const make = (action: string, params: Record<string, unknown> = {}, target: Record<string, unknown> = { kind: 'sites', slugs: ['alpha'] }) =>
      w.deps.schedulers.createCustom({ name: action, action, target, params, cron: '0 3 * * *' });
    const fire = async (id: number) => {
      const report = await w.deps.schedulers.runNow(String(id), 'full');
      w.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
      return w.db.select().from(jobs).where(eq(jobs.id, report.jobs[0]!.id)).get()!;
    };

    const cli = await fire(make('wp.cli', { args: ['cache', 'flush'] }).id);
    expect(cli).toMatchObject({ type: 'wp.cli', lane: `exec:${site.serverId}`, serverId: null, siteId: site.id });
    expect(JSON.parse(cli.payload)).toEqual({ siteId: site.id, args: ['cache', 'flush'], timeoutMin: 10 });

    const shell = await fire(make('site.shell', { command: 'ls', timeoutMin: 3 }).id);
    expect(shell).toMatchObject({ type: 'site.shell', lane: `exec:${site.serverId}` });
    expect(JSON.parse(shell.payload)).toEqual({ siteId: site.id, command: 'ls', timeoutMin: 3 });

    const update = await fire(make('wp.update', { onlyVulnerable: true }).id);
    expect(update.type).toBe('wp.bulkTask');
    expect(JSON.parse(update.payload)).toEqual({
      siteId: site.id,
      policy: { plugins: true, themes: true, core: false, onlyVulnerable: true },
      backupFirst: true,
      healthCheck: true,
    });
    expect(update.summary).toBe('Update plugins and themes that fix a vulnerability');

    const scan = await fire(make('wp.scan', {}, { kind: 'all' }).id);
    expect(scan.type).toBe('wp.scanAll');
    expect(JSON.parse(scan.payload)).toEqual({});

    const snapshot = await fire(make('panel.snapshot', {}, { kind: 'panel' }).id);
    expect(snapshot).toMatchObject({ type: 'panel.snapshot', serverId: 1 });
  });

  it('does not queue a second scan while one is active', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    w.worker.enqueue('wp.scanAll', {});
    const created = w.deps.schedulers.createCustom({ name: 'scan', action: 'wp.scan', target: { kind: 'all' }, cron: '0 3 * * *' });
    const report = await w.deps.schedulers.runNow(String(created.id), 'full');
    expect(report.jobs).toHaveLength(0);
    const dto = w.deps.schedulers.get(String(created.id));
    expect(dto.lastOutcome).toBe('skipped');
    expect(dto.lastResult?.message).toMatch(/already queued or running/);
  });

  it('switching an existing schedule from repeat to once needs cron cleared', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom({
      name: 'x',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '0 3 * * *',
    });
    const at = Date.now() + HOUR;
    expect(() => w.deps.schedulers.update(String(created.id), { runAt: at })).toThrow(/either "cron"/);
    const once = w.deps.schedulers.update(String(created.id), { runAt: at, cron: null });
    expect(once).toMatchObject({ nextRunAt: at, cadence: { cron: null, runAt: at } });
    // A new action starts from its own defaults.
    const changed = w.deps.schedulers.update(String(created.id), { action: 'wp.update' });
    expect(changed.params).toMatchObject({ plugins: true, themes: true, core: false });
  });

  it('can still be paused, renamed and edited once a site it names is deleted', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const beta = addSite(w, 'beta');
    addSite(w, 'gamma');
    const s = w.deps.schedulers;
    const created = s.createCustom({
      name: 'nightly restart',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha', 'beta'] },
      cron: '0 3 * * *',
    });
    w.db.delete(sites).where(eq(sites.id, beta.id)).run();
    const id = String(created.id);

    // Refusing these with "No such site" left a schedule that could not even be switched off.
    expect(s.update(id, { enabled: false })).toMatchObject({ enabled: false, missing: ['beta'] });
    expect(s.update(id, { name: 'restart, nightly', enabled: true })).toMatchObject({ name: 'restart, nightly', enabled: true });
    // A change to the list may keep the site that is gone; only a site it brings in must exist.
    expect(s.update(id, { target: { kind: 'sites', slugs: ['alpha', 'beta', 'gamma'] } }).target).toEqual({
      kind: 'sites',
      slugs: ['alpha', 'beta', 'gamma'],
    });
    expect(() => s.update(id, { target: { kind: 'sites', slugs: ['alpha', 'beta', 'nope'] } })).toThrow(/No such site: "nope"$/);
    // A new schedule still has to name sites that exist.
    expect(() =>
      s.createCustom({ name: 'copy', action: 'site.restart', target: { kind: 'sites', slugs: ['beta'] }, cron: '0 3 * * *' }),
    ).toThrow(/No such site: "beta"/);
  });

  it('deletes custom schedules and keeps their jobs as history', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom({
      name: 'x',
      action: 'site.restart',
      target: { kind: 'sites', slugs: ['alpha'] },
      cron: '0 3 * * *',
    });
    await w.deps.schedulers.runNow(String(created.id), 'full');
    w.deps.schedulers.removeCustom(String(created.id));
    expect(() => w.deps.schedulers.get(String(created.id))).toThrow(/No schedule/);
    expect(allJobs(w)[0]!.scheduleId).toBe(created.id);
  });
});

describe('REST request schedules', () => {
  const auth = { username: 'sync', applicationPassword: 'abcd efgh ijkl mnop qrst uvwx' };
  const rest = (params: Record<string, unknown>) => ({
    name: 'sync',
    action: 'wp.rest',
    target: { kind: 'sites', slugs: ['alpha'] },
    params,
    cron: '*/15 * * * *',
  });

  it('stores the application password for its runs and never hands it back', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    const created = w.deps.schedulers.createCustom(rest({ method: 'POST', route: 'shop/v1/sync', body: { since: '15m' }, auth }));
    expect(created.params).toEqual({
      method: 'POST',
      route: 'shop/v1/sync',
      body: { since: '15m' },
      auth: { username: 'sync' },
      timeoutMin: 10,
    });
    expect(JSON.stringify(w.deps.schedulers.list())).not.toContain(auth.applicationPassword);
    expect(JSON.parse(scheduleRow(w, created.id).params!).auth).toEqual(auth);

    const report = await w.deps.schedulers.runNow(String(created.id), 'full');
    expect(JSON.stringify(report)).not.toContain(auth.applicationPassword);
    const job = w.db.select().from(jobs).where(eq(jobs.id, report.jobs[0]!.id)).get()!;
    expect(job).toMatchObject({ type: 'wp.rest', lane: `exec:${site.serverId}`, siteId: site.id, summary: 'POST /wp-json/shop/v1/sync as sync' });
    expect(JSON.parse(job.payload)).toEqual({
      siteId: site.id,
      method: 'POST',
      route: 'shop/v1/sync',
      body: { since: '15m' },
      auth,
      timeoutMin: 10,
    });
  });

  it('keeps the stored password through an edit that cannot know it - for the same user only', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const s = w.deps.schedulers;
    const created = s.createCustom(rest({ route: 'wp/v2/users/me', auth }));
    const stored = () => JSON.parse(scheduleRow(w, created.id).params!).auth as unknown;

    // What the editor sends: the params as it was shown them, with one thing changed.
    const edited = s.update(String(created.id), { params: { ...created.params, route: 'wp/v2/posts' } });
    expect(edited.params).toMatchObject({ route: 'wp/v2/posts', auth: { username: 'sync' } });
    expect(stored()).toEqual(auth);

    // Another user's password would not sign this one in.
    expect(() => s.update(String(created.id), { params: { route: 'wp/v2/posts', auth: { username: 'editor' } } })).toThrow(
      /params\.auth\.applicationPassword/,
    );
    s.update(String(created.id), { params: { route: 'wp/v2/posts', auth: { username: 'editor', applicationPassword: 'zzzz zzzz' } } });
    expect(stored()).toEqual({ username: 'editor', applicationPassword: 'zzzz zzzz' });

    s.update(String(created.id), { params: { route: 'wp/v2/posts' } });
    expect(stored()).toBeUndefined();
  });

  it('refuses a body on GET, a whole address, and a username HTTP Basic cannot carry', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const s = w.deps.schedulers;
    expect(() => s.createCustom(rest({ route: 'wp/v2/posts', body: { status: 'draft' } }))).toThrow(/GET request has no body/);
    expect(() => s.createCustom(rest({ route: 'https://shop.example.com/wp-json/wp/v2/posts' }))).toThrow(/not a whole address/);
    expect(() => s.createCustom(rest({ route: 'wp/v2/posts', auth: { username: 'a:b', applicationPassword: 'x' } }))).toThrow(/":"/);
    expect(() => s.createCustom(rest({ route: 'wp/v2/posts', auth: { username: 'sync' } }))).toThrow(/applicationPassword/);
    expect(() => s.createCustom(rest({ method: 'POST', route: 'shop/v1/sync', body: 'text' }))).toThrow(/params\.body/);
  });
});
