/**
 * The files a site's caches are made of, as they reach its server (services/siteCaches.ts), and the
 * settings and limits they follow. What the files say is services/siteStack.ts's test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_KEEP_SECONDS, type CacheRule } from '../../shared/cacheRules.js';
import { MIN_PIDS_CAP, pidsLimitAllowed, settingsUpdateBody, siteLimitProblem, siteLimitsBody } from '../../shared/schemas.js';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { ensureSiteMountSources } from '../../src/jobs/handlers/shared.js';
import { effectiveKeepSeconds, effectivePageCache, runtimeSizes, siteContainerStack, writeSiteRuntimeFiles } from '../../src/services/siteCaches.js';
import { siteRuntimeFrom, sitePaths, NO_OWN_LIMITS } from '../../src/services/siteSpec.js';
import { fpmMaxChildren, redisMaxMemoryMb } from '../../src/services/siteStack.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

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
  });
  const done = await runJob(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

const fileIn = (w: TestWorld, site: { slug: string }, name: string) => path.join(sitePaths(w.config, site.slug).runtimeDir, name);
const read = (w: TestWorld, site: { slug: string }, name: string) => fs.readFileSync(fileIn(w, site, name), 'utf8');

/** A row with these changes, in the database and in hand. */
function change(w: TestWorld, site: SiteRow, patch: Partial<typeof sites.$inferInsert>): SiteRow {
  return w.db.update(sites).set(patch).where(eq(sites.id, site.id)).returning().get();
}

const ALL_FILES = ['nginx-site.conf', 'php-fpm-pool.conf', 'php.ini', 'wp-cache.php', 'mail-from'];

describe('the runtime files', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are there, each readable by everyone, before a container is created and before it starts', async () => {
    const w = await makeWorld();
    const seen: Record<string, boolean[]> = { create: [], start: [] };
    const present = (slug: string) => ALL_FILES.every((name) => fs.existsSync(fileIn(w, { slug }, name)));
    const create = w.docker.createSiteContainer.bind(w.docker);
    vi.spyOn(w.docker, 'createSiteContainer').mockImplementation(async (spec) => {
      seen.create!.push(present(spec.name.slice(3)));
      return create(spec);
    });
    const start = w.docker.startContainer.bind(w.docker);
    vi.spyOn(w.docker, 'startContainer').mockImplementation(async (name) => {
      if (name.startsWith('wp-')) seen.start!.push(present(name.slice(3)));
      return start(name);
    });
    const site = await createSite(w);
    expect(seen.create).toEqual([true, true]);
    expect(seen.start).toEqual([true, true]);
    for (const name of ALL_FILES) expect(fs.statSync(fileIn(w, site, name)).mode & 0o777, name).toBe(0o644);
    expect(fs.statSync(sitePaths(w.config, site.slug).runtimeDir).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(fileIn(w, site, 'redis.conf'))).toBe(false);
    expect(fs.readdirSync(sitePaths(w.config, site.slug).runtimeDir).sort()).toEqual([...ALL_FILES].sort());
  });

  it('are written again at every start, from the settings as they are then', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    expect(read(w, site, 'nginx-site.conf')).toContain('proxy_cache wpl7;');
    change(w, site, { pageCache: 'off' });
    const job = w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    expect(read(w, site, 'nginx-site.conf')).toContain('The page cache is off for this site');
    expect(read(w, site, 'wp-cache.php')).not.toContain('wpl7_cache_settings');
  });

  it('do not take a change back with a row a job has held on to', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    // The row as a job began with it; the setting changes while it runs.
    const held = w.deps.sites.bySlug(site.slug);
    change(w, site, { pageCache: 'off' });
    await ensureSiteMountSources(w.servers.handleFor(1), w.core, held);
    expect(read(w, site, 'nginx-site.conf')).toContain('The page cache is off for this site');
  });

  it('have Redis’s file exactly while the object cache is on', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const handle = w.servers.handleFor(1);
    const on = change(w, site, { objectCache: 1 });
    await writeSiteRuntimeFiles(handle, w.core, on);
    const conf = read(w, site, 'redis.conf');
    expect(conf).toContain(`maxmemory ${redisMaxMemoryMb(512)}mb`);
    expect(conf).toContain('unixsocket /run/wpl7/redis.sock');
    expect(fs.statSync(fileIn(w, site, 'redis.conf')).mode & 0o777).toBe(0o644);

    const off = change(w, site, { objectCache: 0 });
    await writeSiteRuntimeFiles(handle, w.core, off);
    expect(fs.existsSync(fileIn(w, site, 'redis.conf'))).toBe(false);
    // Nothing there to remove is no reason to fail.
    await writeSiteRuntimeFiles(handle, w.core, off);
  });

  it('are replaced, never rewritten, because a reader must not see half of one', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const handle = w.servers.handleFor(1);
    const write = vi.spyOn(handle.files, 'writeFile');
    await writeSiteRuntimeFiles(handle, w.core, w.deps.sites.bySlug(site.slug));
    expect(write.mock.calls.map((call) => path.basename(call[0])).sort()).toEqual([...ALL_FILES].sort());
    for (const call of write.mock.calls) expect(call[2]).toEqual({ atomic: true, mode: 0o644 });
  });

  it('let nginx take what uploads.ini lets PHP take', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    expect(read(w, site, 'nginx-site.conf')).not.toContain('client_max_body_size');
    fs.writeFileSync(sitePaths(w.config, site.slug).uploadsIni, 'post_max_size = 2G\n');
    await writeSiteRuntimeFiles(w.servers.handleFor(1), w.core, w.deps.sites.bySlug(site.slug));
    expect(read(w, site, 'nginx-site.conf')).toContain('client_max_body_size 2064m;');
    expect(read(w, site, 'nginx-site.conf')).toContain('proxy_cache wpl7;');
  });

  it('size PHP from the site’s limits, and from the host’s cores with no CPU cap', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const handle = w.servers.handleFor(1);
    const pool = () => read(w, site, 'php-fpm-pool.conf');

    await writeSiteRuntimeFiles(handle, w.core, w.deps.sites.bySlug(site.slug));
    expect(pool()).toContain(`pm.max_children = ${fpmMaxChildren(512, 2)}`);

    await writeSiteRuntimeFiles(handle, w.core, change(w, site, { memoryLimitMb: 2048, cpuLimit: 1 }));
    expect(pool()).toContain(`pm.max_children = ${fpmMaxChildren(2048, 1)}`);
    expect(read(w, site, 'php.ini')).toContain('opcache.memory_consumption = 192');

    w.docker.cpus = 8;
    await writeSiteRuntimeFiles(handle, w.core, change(w, site, { memoryLimitMb: 4096, cpuLimit: 0 }));
    expect(pool()).toContain(`pm.max_children = ${fpmMaxChildren(4096, 8)}`);
    expect(fpmMaxChildren(4096, 8)).toBeGreaterThan(fpmMaxChildren(4096, null));

    // A cap above the host's cores is fitted to them when the container is made, so this is too.
    w.docker.cpus = 2;
    expect(await runtimeSizes(w.docker, w.core.settings, change(w, site, { cpuLimit: 16 }))).toEqual({ memoryMb: 4096, cpus: 2 });
    // And with a host that can't be asked, what the site says will do.
    w.docker.cpus = null;
    expect(await runtimeSizes(w.docker, w.core.settings, change(w, site, { cpuLimit: 3 }))).toEqual({ memoryMb: 4096, cpus: 3 });
    expect(await runtimeSizes(w.docker, w.core.settings, change(w, site, { cpuLimit: 0 }))).toEqual({ memoryMb: 4096, cpus: null });
  });

  it('keep pages for what the site says, or what Settings says', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const handle = w.servers.handleFor(1);
    w.core.settings.set('sitePageCacheSeconds', 7200);
    await writeSiteRuntimeFiles(handle, w.core, w.deps.sites.bySlug(site.slug));
    expect(read(w, site, 'wp-cache.php')).toContain("'keep_seconds' => 7200");
    await writeSiteRuntimeFiles(handle, w.core, change(w, site, { cacheRules: JSON.stringify({ keepSeconds: 600, off: [], own: [] }) }));
    expect(read(w, site, 'wp-cache.php')).toContain("'keep_seconds' => 600");
  });

  it('tell the job, once, about a stored rule they leave out, and work anyway', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const own: CacheRule[] = [
      { id: 'bad1', kind: 'skip', match: 'path', value: '/a"; evil;' },
      { id: 'good1', kind: 'skip', match: 'path', value: '/fine/*' },
    ];
    const warn = vi.fn();
    await writeSiteRuntimeFiles(w.servers.handleFor(1), w.core, change(w, site, { cacheRules: JSON.stringify({ off: [], own }) }), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('bad1');
    expect(read(w, site, 'nginx-site.conf')).not.toContain('evil');
    expect(read(w, site, 'nginx-site.conf')).toContain('fine');
  });

  it('come from a broken row as if it were empty: a site keeps working over one', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await writeSiteRuntimeFiles(w.servers.handleFor(1), w.core, change(w, site, { cacheRules: 'not json' }));
    expect(read(w, site, 'nginx-site.conf')).toContain('proxy_cache wpl7;');
  });

  it('put back what an old archive brought along', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    fs.writeFileSync(fileIn(w, site, 'redis.conf'), 'from a backup');
    fs.writeFileSync(fileIn(w, site, 'nginx-site.conf'), 'from a backup');
    await ensureSiteMountSources(w.servers.handleFor(1), w.core, w.deps.sites.bySlug(site.slug));
    expect(fs.existsSync(fileIn(w, site, 'redis.conf'))).toBe(false);
    expect(read(w, site, 'nginx-site.conf')).not.toContain('from a backup');
  });
});

describe('whether a site keeps a page cache', () => {
  it('is what it says, or else what Settings says, and On by default on any install', async () => {
    const w = await makeWorld();
    const settings = w.core.settings;
    expect(settings.get('sitePageCache')).toBe(true);
    expect(settings.get('sitePageCacheSeconds')).toBe(MAX_KEEP_SECONDS);
    expect(effectivePageCache(settings, { pageCache: null })).toBe(true);
    expect(effectivePageCache(settings, { pageCache: 'off' })).toBe(false);
    settings.set('sitePageCache', false);
    expect(effectivePageCache(settings, { pageCache: null })).toBe(false);
    expect(effectivePageCache(settings, { pageCache: 'on' })).toBe(true);
    // Something that isn't one of the two follows Settings, rather than guessing.
    expect(effectivePageCache(settings, { pageCache: 'maybe' })).toBe(false);
  });

  it('has a keep time no longer than a page can be kept', async () => {
    const w = await makeWorld();
    const settings = w.core.settings;
    expect(effectiveKeepSeconds(settings, { keepSeconds: null })).toBe(MAX_KEEP_SECONDS);
    expect(effectiveKeepSeconds(settings, { keepSeconds: 60 })).toBe(60);
    settings.set('sitePageCacheSeconds', 1800);
    expect(effectiveKeepSeconds(settings, { keepSeconds: null })).toBe(1800);
    expect(effectiveKeepSeconds(settings, { keepSeconds: 999_999 })).toBe(MAX_KEEP_SECONDS);
  });

  it('starts empty on a new row, so a site follows Settings', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    expect(site).toMatchObject({ pageCache: null, objectCache: 0, cacheRules: null, stackSwitchError: null, stackSwitchImage: null });
  });

  it('takes the settings through the API’s schema', () => {
    expect(settingsUpdateBody.safeParse({ sitePageCache: false, sitePageCacheSeconds: 3600 }).success).toBe(true);
    expect(settingsUpdateBody.safeParse({ sitePageCacheSeconds: MAX_KEEP_SECONDS + 1 }).success).toBe(false);
    expect(settingsUpdateBody.safeParse({ sitePageCacheSeconds: 0 }).success).toBe(false);
    expect(settingsUpdateBody.safeParse({ sitePageCache: 'yes' }).success).toBe(false);
  });
});

describe('the process limit', () => {
  it('is refused under what a site can run on, by every way in', () => {
    expect(MIN_PIDS_CAP).toBe(64);
    for (const ok of [0, 64, 512, 100_000]) {
      expect(pidsLimitAllowed(ok)).toBe(true);
      expect(siteLimitsBody.safeParse({ pidsLimit: ok }).success, String(ok)).toBe(true);
      expect(settingsUpdateBody.safeParse({ sitePidsLimit: ok }).success, String(ok)).toBe(true);
      expect(siteLimitProblem('pidsLimit', 'Processes', ok)).toBeNull();
    }
    for (const bad of [1, 25, 63]) {
      expect(pidsLimitAllowed(bad)).toBe(false);
      expect(siteLimitsBody.safeParse({ pidsLimit: bad }).success, String(bad)).toBe(false);
      expect(settingsUpdateBody.safeParse({ sitePidsLimit: bad }).success, String(bad)).toBe(false);
      expect(siteLimitProblem('pidsLimit', 'Processes', bad)).toBe('Processes: 0, or a whole number from 64 to 100000.');
    }
    expect(siteLimitProblem('pidsLimit', 'Processes', 64.5)).not.toBeNull();
    expect(siteLimitsBody.safeParse({ pidsLimit: null }).success).toBe(true);
  });

  it('is lifted when one saved before that would put a site in a restart loop', async () => {
    const w = await makeWorld();
    const settings = w.core.settings;
    expect(siteRuntimeFrom(settings, { ...NO_OWN_LIMITS, pidsLimit: 25 }).pidsLimit).toBe(64);
    expect(siteRuntimeFrom(settings, { ...NO_OWN_LIMITS, pidsLimit: 64 }).pidsLimit).toBe(64);
    expect(siteRuntimeFrom(settings, { ...NO_OWN_LIMITS, pidsLimit: 100 }).pidsLimit).toBe(100);
    expect(siteRuntimeFrom(settings, { ...NO_OWN_LIMITS, pidsLimit: 0 }).pidsLimit).toBeUndefined();
    settings.set('sitePidsLimit', 10);
    expect(siteRuntimeFrom(settings, NO_OWN_LIMITS).pidsLimit).toBe(64);
    settings.set('sitePidsLimit', 0);
    expect(siteRuntimeFrom(settings, NO_OWN_LIMITS).pidsLimit).toBeUndefined();
  });
});

describe('what a container runs', () => {
  it('is known from the container, and is nothing without one', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(await siteContainerStack(w.docker, 'wp-nothing')).toBeNull();
  });
});
