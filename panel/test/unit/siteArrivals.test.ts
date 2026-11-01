/**
 * Files that reach a site from somewhere else, and what is done to them: an old backup or another
 * host brings back the PHP lines a site on stack 2 can't have (services/siteMigration.ts
 * migrateArrivedFiles). Each path through its real job, with real tar where it matters and the
 * script itself on real PHP, so that what is checked is what the file says when the site starts.
 * What Apache and PHP-FPM then make of it: test/engine/siteStack.test.ts.
 *
 * And the other way round: config/runtime goes into every archive, and none of it may come back.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import { hostExec } from '../../src/lib/exec.js';
import type { EphemeralOpts, SiteContainerSpec } from '../../src/services/docker.js';
import { migrateArrivedFiles } from '../../src/services/siteMigration.js';
import { SITE_STACK_LABEL } from '../../src/services/siteStack.js';
import { siteImage, sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type FakeDocker, type TestWorld } from '../helpers.js';
import { CHOICES, connected, logOf, oldSiteFiles, settle } from '../importWorld.js';
import { HAS_PHP, useRealMigration } from '../realMigration.js';

const LINE = 'php_value max_input_vars 4321';
const MOVED = `# Moved to .user.ini by WPL7: ${LINE}`;
const LEFTOVER = 'open_basedir = /home/olduser/public_html\n';
const NOT_USED = `; Not used by WPL7: ${LEFTOVER}`;

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

async function createSite(w: TestWorld): Promise<SiteRow> {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
  const { site, job } = w.deps.sites.create({
    title: 'Demo Site',
    domainMode: 'dev' as const,
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
    discourageSearchEngines: false,
  });
  const done = await runJob(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

/** A site's files as an old backup or another host has them. */
function putOldLines(wordpress: string): void {
  fs.writeFileSync(path.join(wordpress, '.htaccess'), `${LINE}\n`);
  fs.writeFileSync(path.join(wordpress, '.user.ini'), LEFTOVER);
}

const fileOf = (wordpress: string, rel: string) => fs.readFileSync(path.join(wordpress, rel), 'utf8');

/** What is in those files the moment a container starts, on any of a job's starts. */
function watchStarts(docker: FakeDocker, wordpress: string): { htaccess: string; userIni: string }[] {
  const seen: { htaccess: string; userIni: string }[] = [];
  const before = docker.onStart;
  docker.onStart = (name) => {
    before?.(name);
    if (name.startsWith('wp-')) seen.push({ htaccess: fileOf(wordpress, '.htaccess'), userIni: fileOf(wordpress, '.user.ini') });
  };
  return seen;
}

const migrations = (docker: FakeDocker) =>
  docker.calls
    .filter((c) => c.method === 'runEphemeral')
    .map((c) => c.args[0] as EphemeralOpts)
    .filter((opts) => opts.labels?.['wpl7.migration']);

const specs = (docker: FakeDocker) => docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);

/** The order some calls were made in. A migration counts by its label: other things run in throwaway containers too. */
const order = (docker: FakeDocker, methods: string[]) =>
  docker.calls
    .filter((c) => methods.includes(c.method) && (c.method !== 'runEphemeral' || (c.args[0] as EphemeralOpts).labels?.['wpl7.migration']))
    .map((c) => c.method);

/** Every image on this world's server from before stack 2. */
const allStack1 = (docker: FakeDocker) => vi.spyOn(docker, 'imageStack').mockResolvedValue(1);

const failingMigration = { stdout: '', stderr: 'PHP Fatal error: nope', exitCode: 255 };

function expectWarned(log: string[]) {
  const warning = log.find((line) => line.includes('could not be checked'));
  expect(warning, log.join('\n')).toContain('its script failed (exit 255): PHP Fatal error: nope');
  expect(warning).toContain('answers 500');
}

afterEach(() => vi.restoreAllMocks());

describe('the helper', () => {
  async function world() {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.calls.length = 0;
    const ctx = new JobContext(w.worker.enqueue('demo', {}).id, {}, w.db);
    return { w, site, ctx, handle: w.servers.handleFor(1) };
  }

  it('runs for a stack 2 container, running or not', async () => {
    const { w, site, ctx, handle } = await world();
    await w.docker.stopContainer(site.containerName);
    await migrateArrivedFiles(ctx, handle, w.core, site);
    expect(migrations(w.docker).map((opts) => [opts.image, opts.labels!['wpl7.migration']])).toEqual([[siteImage(site.phpVersion), 'migrate']]);
  });

  it('does nothing for a stack 1 container, whose mod_php reads those lines', async () => {
    const w = await makeWorld();
    allStack1(w.docker);
    const site = await createSite(w);
    w.docker.calls.length = 0;
    await migrateArrivedFiles(new JobContext(w.worker.enqueue('demo', {}).id, {}, w.db), w.servers.handleFor(1), w.core, site);
    expect(migrations(w.docker)).toEqual([]);
  });

  it('does nothing without a container: nothing says what the files are for yet', async () => {
    const { w, site, ctx, handle } = await world();
    await w.docker.removeContainer(site.containerName);
    await migrateArrivedFiles(ctx, handle, w.core, site);
    expect(migrations(w.docker)).toEqual([]);
  });

  it('asks the container, not the image: a tag that moved on does not change what runs', async () => {
    const { w, site, ctx, handle } = await world();
    vi.spyOn(w.docker, 'imageStack').mockResolvedValue(1);
    await migrateArrivedFiles(ctx, handle, w.core, site);
    expect(migrations(w.docker)).toHaveLength(1);
  });

  it.each<[string, (w: TestWorld) => void]>([
    ['its script failing', (w) => (w.docker.migrationResult = failingMigration)],
    ['a run cut short', (w) => (w.docker.migrationResult = { stdout: '', stderr: '', exitCode: 0 })],
    ['Docker refusing to run it', (w) => void vi.spyOn(w.docker, 'runEphemeral').mockRejectedValue(new Error('No such image'))],
    ['Docker not answering about the container', (w) => void vi.spyOn(w.docker, 'containerStack').mockRejectedValue(new Error('connection refused'))],
  ])('only warns on %s', async (_name, fail) => {
    const { w, site, ctx, handle } = await world();
    fail(w);
    const warn = vi.spyOn(ctx, 'warn');
    await expect(migrateArrivedFiles(ctx, handle, w.core, site)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('answers 500');
  });
});

describe.skipIf(!HAS_PHP)('a restore', () => {
  /** A backup with the old lines in it, of a site that has since moved on. */
  async function restorable(w: TestWorld) {
    const site = await createSite(w);
    const wordpress = sitePaths(w.config, site.slug).wordpress;
    putOldLines(wordpress);
    const backup = await w.core.backup.create(site, 'manual', {});
    fs.writeFileSync(path.join(wordpress, '.htaccess'), '# the site as it is now\n');
    fs.rmSync(path.join(wordpress, '.user.ini'));
    w.docker.calls.length = 0;
    return { site, wordpress, backup };
  }

  const restore = (w: TestWorld, site: SiteRow, backupId: number) =>
    w.worker.enqueue('backup.restore', { backupId, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });

  it('on stack 2: an old backup’s lines are gone by the time the site starts', async () => {
    const w = await makeWorld({ exec: hostExec });
    useRealMigration(w.docker);
    const { site, wordpress, backup } = await restorable(w);
    const starts = watchStarts(w.docker, wordpress);
    const job = restore(w, site, backup.id);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');

    expect(starts).toHaveLength(1);
    expect(starts[0]!.htaccess).toBe(`${MOVED}\n`);
    expect(starts[0]!.userIni).toContain("max_input_vars = '4321'");
    expect(starts[0]!.userIni).toContain(NOT_USED);
    expect(order(w.docker, ['stopContainer', 'runEphemeral', 'startContainer'])).toEqual(['stopContainer', 'runEphemeral', 'startContainer']);
    expect(logOf(w, job.id).join('\n')).toContain(`.htaccess:1: ${LINE}: moved to .user.ini`);
  });

  it('on stack 1: the lines stay, because mod_php reads them, and the switch moves them when it comes', async () => {
    const w = await makeWorld({ exec: hostExec });
    allStack1(w.docker);
    useRealMigration(w.docker);
    const { site, wordpress, backup } = await restorable(w);
    expect((await runJob(w, restore(w, site, backup.id).id)).status).toBe('succeeded');
    expect(migrations(w.docker)).toEqual([]);
    expect(fileOf(wordpress, '.htaccess')).toBe(`${LINE}\n`);
    expect(fileOf(wordpress, '.user.ini')).toBe(LEFTOVER);
  });

  it('when its recreate is what takes the site from stack 1 to stack 2, in the image it lands on', async () => {
    const w = await makeWorld({ exec: hostExec });
    const old = siteImage('8.3');
    const other = siteImage('8.4');
    w.docker.stackOf(old, 1);
    w.docker.images.add(other);
    useRealMigration(w.docker);
    w.core.settings.set('phpVersions', ['8.3', '8.4']);
    const { site, wordpress, backup } = await restorable(w);
    expect((await w.docker.containerStack(site.containerName))!.stack).toBe(1);
    const manifest = path.join(backup.path, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), phpVersion: '8.4' }));
    const starts = watchStarts(w.docker, wordpress);
    expect((await runJob(w, restore(w, site, backup.id).id)).status).toBe('succeeded');

    expect(specs(w.docker).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(migrations(w.docker).map((opts) => opts.image)).toEqual([other]);
    expect(starts[0]!.htaccess).toBe(`${MOVED}\n`);
  });

  it('whose migration fails: a warning, and the site is up', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, wordpress, backup } = await restorable(w);
    w.docker.migrationResult = failingMigration;
    const job = restore(w, site, backup.id);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expectWarned(logOf(w, job.id));
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
    expect(fileOf(wordpress, '.htaccess')).toBe(`${LINE}\n`);
  });
});

describe.skipIf(!HAS_PHP)('the arrival of a move', () => {
  /** A stack 1 site's lines, on its way to a server of its own. */
  async function moving(w: TestWorld, stackOnSource: 1 | 2) {
    if (stackOnSource === 1) w.docker.stackOf(siteImage('8.3'), 1);
    const site = await createSite(w);
    const wordpress = sitePaths(w.config, site.slug).wordpress;
    putOldLines(wordpress);
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    const onTarget = (file: string) => file.replace(w.config.srvRoot, target.root!);
    useRealMigration(target.docker, onTarget);
    return { site, wordpress, target, targetWordpress: onTarget(wordpress) };
  }

  it('on stack 2: the target’s copy is moved before it starts there, and the source keeps its own', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, wordpress, target, targetWordpress } = await moving(w, 1);
    const starts = watchStarts(target.docker, targetWordpress);
    const job = w.deps.sites.move(site.slug, { targetServerId: target.id });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');

    expect(specs(target.docker).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(starts[0]!.htaccess).toBe(`${MOVED}\n`);
    expect(starts[0]!.userIni).toContain(NOT_USED);
    expect(order(target.docker, ['createSiteContainer', 'runEphemeral', 'startContainer'])).toEqual(['createSiteContainer', 'runEphemeral', 'startContainer']);
    expect(migrations(w.docker)).toEqual([]);
    // The source is what a move that fails falls back on, and mod_php still reads it there.
    expect(fileOf(wordpress, '.htaccess')).toBe(`${LINE}\n`);
    expect(fileOf(wordpress, '.user.ini')).toBe(LEFTOVER);
    expect(logOf(w, job.id).join('\n')).toContain(`.htaccess:1: ${LINE}: moved to .user.ini`);
  });

  it('on stack 1: the lines stay as they are', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, target, targetWordpress } = await moving(w, 1);
    allStack1(target.docker);
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');
    expect(migrations(target.docker)).toEqual([]);
    expect(fileOf(targetWordpress, '.htaccess')).toBe(`${LINE}\n`);
  });

  it('whose migration fails: a warning, and the move still lands', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, target } = await moving(w, 2);
    target.docker.ephemeral = null;
    target.docker.migrationResult = failingMigration;
    const job = w.deps.sites.move(site.slug, { targetServerId: target.id });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expectWarned(logOf(w, job.id));
    expect(target.docker.containers.get(site.containerName)).toBe('running');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.serverId).toBe(target.id);
  });
});

describe.skipIf(!HAS_PHP)('an import', () => {
  /** An old site with the lines its host left. */
  const oldHost = { fake: { files: { ...oldSiteFiles(), '.htaccess': `${LINE}\n`, '.user.ini': LEFTOVER } } };

  it('on stack 2: the old host’s lines are gone by the first start', async () => {
    const world = await connected(oldHost);
    const { w } = world;
    useRealMigration(w.docker);
    const seen: string[] = [];
    const before = w.docker.onStart;
    w.docker.onStart = (name) => {
      before?.(name);
      seen.push(fileOf(sitePaths(w.config, 'willow').wordpress, '.htaccess'));
    };
    w.core.imports.start(world.id, CHOICES);
    const row = await settle(w, world.id);
    expect(row.status, row.lastError ?? '').toBe('done');

    expect(seen.length).toBeGreaterThan(0);
    for (const htaccess of seen) expect(htaccess).toBe(`${MOVED}\n`);
    const wordpress = sitePaths(w.config, 'willow').wordpress;
    expect(fileOf(wordpress, '.user.ini')).toContain(NOT_USED);
    expect(fileOf(wordpress, '.user.ini')).toContain("max_input_vars = '4321'");
    // Run once, ahead of the first start: the rest of the job adds no such files.
    expect(migrations(w.docker)).toHaveLength(1);
    const finish = w.db.select().from(jobs).where(eq(jobs.type, 'site.importFinish')).get()!;
    expect(logOf(w, finish.id).join('\n')).toContain(`.htaccess:1: ${LINE}: moved to .user.ini`);
  });

  it('on stack 1: they stay', async () => {
    const world = await connected(oldHost);
    const { w } = world;
    allStack1(w.docker);
    w.core.imports.start(world.id, CHOICES);
    const row = await settle(w, world.id);
    expect(row.status, row.lastError ?? '').toBe('done');
    expect(migrations(w.docker)).toEqual([]);
    expect(fileOf(sitePaths(w.config, 'willow').wordpress, '.htaccess')).toBe(`${LINE}\n`);
  });

  it('whose migration fails: a warning, and the site is up', async () => {
    const world = await connected(oldHost);
    const { w } = world;
    w.docker.migrationResult = failingMigration;
    w.core.imports.start(world.id, CHOICES);
    const row = await settle(w, world.id);
    expect(row.status, row.lastError ?? '').toBe('done');
    expectWarned(logOf(w, w.db.select().from(jobs).where(eq(jobs.type, 'site.importFinish')).get()!.id));
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.status).toBe('running');
  });

  describe('refreshed from the old site', () => {
    async function imported(stack: 1 | 2) {
      const world = await connected();
      if (stack === 1) allStack1(world.w.docker);
      world.w.core.imports.start(world.id, CHOICES);
      const row = await settle(world.w, world.id);
      expect(row.status, row.lastError ?? '').toBe('done');
      world.w.docker.calls.length = 0;
      useRealMigration(world.w.docker);
      return { ...world, wordpress: sitePaths(world.w.config, 'willow').wordpress };
    }

    it('on stack 2: what came in again is moved before the container starts', async () => {
      const { w, id, fake, wordpress } = await imported(2);
      fake.writeFile('.htaccess', `${LINE}\n`);
      fake.writeFile('.user.ini', LEFTOVER);
      const starts = watchStarts(w.docker, wordpress);
      const job = w.core.imports.refresh(id);
      await settle(w, id);
      const log = logOf(w, job.id);
      expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, log.join('\n')).toBe('succeeded');
      expect(starts[0]!.htaccess).toBe(`${MOVED}\n`);
      expect(starts[0]!.userIni).toContain(NOT_USED);
      expect(log.join('\n')).toContain(`.htaccess:1: ${LINE}: moved to .user.ini`);
      expect(migrations(w.docker)).toHaveLength(1);
    });

    it('on stack 1: it stays', async () => {
      const { w, id, fake, wordpress } = await imported(1);
      fake.writeFile('.htaccess', `${LINE}\n`);
      const job = w.core.imports.refresh(id);
      await settle(w, id);
      expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, logOf(w, job.id).join('\n')).toBe('succeeded');
      expect(migrations(w.docker)).toEqual([]);
      expect(fileOf(wordpress, '.htaccess')).toBe(`${LINE}\n`);
    });

    it('whose migration fails: a warning, and the refresh is done', async () => {
      const { w, id, fake } = await imported(2);
      w.docker.ephemeral = null;
      w.docker.migrationResult = failingMigration;
      fake.writeFile('.htaccess', `${LINE}\n`);
      const job = w.core.imports.refresh(id);
      await settle(w, id);
      const log = logOf(w, job.id);
      expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, log.join('\n')).toBe('succeeded');
      expectWarned(log);
    });
  });
});

describe.skipIf(!HAS_PHP)('a site with no container left', () => {
  it('gets its lines moved when a recreate lands it on stack 2: what a failed way back leaves', async () => {
    const w = await makeWorld();
    useRealMigration(w.docker);
    const site = await createSite(w);
    const wordpress = sitePaths(w.config, site.slug).wordpress;
    putOldLines(wordpress);
    await w.docker.removeContainer(site.containerName);
    w.docker.calls.length = 0;
    const starts = watchStarts(w.docker, wordpress);
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(starts[0]!.htaccess).toBe(`${MOVED}\n`);
    expect(order(w.docker, ['createSiteContainer', 'runEphemeral', 'startContainer'])).toEqual(['createSiteContainer', 'runEphemeral', 'startContainer']);
  });

  it('and not when it lands on stack 1', async () => {
    const w = await makeWorld();
    allStack1(w.docker);
    useRealMigration(w.docker);
    const site = await createSite(w);
    const wordpress = sitePaths(w.config, site.slug).wordpress;
    putOldLines(wordpress);
    await w.docker.removeContainer(site.containerName);
    w.docker.calls.length = 0;
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(migrations(w.docker)).toEqual([]);
    expect(fileOf(wordpress, '.htaccess')).toBe(`${LINE}\n`);
  });

  it('and nothing is asked of a container that was there all along', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.calls.length = 0;
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(migrations(w.docker)).toEqual([]);
  });
});

describe('config/runtime in archives', () => {
  const ALL_FILES = ['nginx-site.conf', 'php-fpm-pool.conf', 'php.ini', 'wp-cache.php'];
  const STALE = '# stale';
  const tarList = (file: string) => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n');

  /** A site whose runtime folder holds what only an old archive could have put there. */
  async function siteWithStaleRuntime(w: TestWorld) {
    const site = await createSite(w);
    const dir = sitePaths(w.config, site.slug).runtimeDir;
    for (const file of ['nginx-site.conf', 'redis.conf', 'from-another-version.conf']) fs.writeFileSync(path.join(dir, file), STALE);
    return { site, dir };
  }

  const movedDir = (target: { root?: string }, site: SiteRow) => path.join(target.root!, 'sites', site.slug, 'config', 'runtime');

  it('a move: an archive’s copy comes along, and none of it stays on the target', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site } = await siteWithStaleRuntime(w);
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    let atCreate: string[] = [];
    const create = target.docker.createSiteContainer.bind(target.docker);
    vi.spyOn(target.docker, 'createSiteContainer').mockImplementation(async (spec) => {
      atCreate = fs.readdirSync(movedDir(target, site)).sort();
      return create(spec);
    });
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');
    expect(atCreate).toEqual(ALL_FILES);
    const dir = movedDir(target, site);
    expect(fs.readdirSync(dir).sort()).toEqual(ALL_FILES);
    expect(fs.readFileSync(path.join(dir, 'nginx-site.conf'), 'utf8')).not.toContain(STALE);
    expect(fs.statSync(path.join(dir, 'wp-cache.php')).mode & 0o777).toBe(0o644);
  });

  it('a move: an object cache that is on is the panel’s file, whatever the archive says', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site } = await siteWithStaleRuntime(w);
    w.db.update(sites).set({ objectCache: 1 }).where(eq(sites.id, site.id)).run();
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');
    const redis = fs.readFileSync(path.join(movedDir(target, site), 'redis.conf'), 'utf8');
    expect(redis).toContain('maxmemory');
    expect(redis).not.toContain(STALE);
  });

  it('a move: an archive from before the folder existed depends on nothing', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    fs.rmSync(sitePaths(w.config, site.slug).runtimeDir, { recursive: true });
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');
    expect(fs.readdirSync(movedDir(target, site)).sort()).toEqual(ALL_FILES);
  });

  it('a restore: the archive’s copy is not looked at, and the folder is the panel’s', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, dir } = await siteWithStaleRuntime(w);
    const backup = await w.core.backup.create(site, 'manual', {});
    expect(tarList(path.join(backup.path, 'files.tar.gz'))).toContain('config/runtime/from-another-version.conf');
    for (const file of ['redis.conf', 'from-another-version.conf']) fs.rmSync(path.join(dir, file));
    fs.writeFileSync(path.join(dir, 'php.ini'), STALE);
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    expect(fs.readdirSync(dir).sort()).toEqual(ALL_FILES);
    expect(fs.readFileSync(path.join(dir, 'nginx-site.conf'), 'utf8')).not.toContain(STALE);
    expect(fs.readFileSync(path.join(dir, 'php.ini'), 'utf8')).not.toContain(STALE);
  });

  it('a restore: an old archive’s uploads.ini still comes back, as it always has, and the page cache’s limit follows it', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { site, dir } = await siteWithStaleRuntime(w);
    const p = sitePaths(w.config, site.slug);
    fs.writeFileSync(p.uploadsIni, 'post_max_size = 2000M\n');
    const backup = await w.core.backup.create(site, 'manual', {});
    fs.writeFileSync(p.uploadsIni, 'post_max_size = 64M\n');
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    expect(fs.readFileSync(p.uploadsIni, 'utf8')).toContain('2000M');
    expect(fs.readFileSync(path.join(dir, 'nginx-site.conf'), 'utf8')).toMatch(/client_max_body_size 20\d\dm/i);
  });
});
