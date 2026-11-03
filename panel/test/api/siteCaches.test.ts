/**
 * A site's caches over the API, and what empties them. What nginx, PHP and Redis make of it all is
 * in test/engine/siteStack.test.ts, on the real thing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobs, siteWpComponents, sites, type SiteRow } from '../../src/db/schema.js';
import { markRuntimeApplied, sweepSiteRuntime, wpCliOnlyReads } from '../../src/services/siteCaches.js';
import { siteImage, sitePaths } from '../../src/services/siteSpec.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

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
  w.docker.cacheClears.length = 0;
  w.docker.reloads.length = 0;
  return w.deps.sites.bySlug(site.slug);
}

afterEach(() => vi.restoreAllMocks());

async function world() {
  const w = await makeWorld();
  const { app } = await makeApp(w);
  const site = await createSite(w);
  const headers = { authorization: `Bearer ${w.deps.apiKeys.create('key', 'full').token}` };
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/sites/${site.slug}${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const files = () => sitePaths(w.config, site.slug).runtimeDir;
  const nginxFile = () => fs.readFileSync(path.join(files(), 'nginx-site.conf'), 'utf8');
  const wpCacheFile = () => fs.readFileSync(path.join(files(), 'wp-cache.php'), 'utf8');
  return { w, app, site, call, nginxFile, wpCacheFile };
}

describe('PUT /api/sites/:slug/cache', () => {
  it('follows Settings until the site chooses, and answers what it comes to', async () => {
    const { call } = await world();
    const cache = (await call('GET', '')).json().cache;
    expect(cache).toMatchObject({ page: 'default', pageOn: true, pageDefault: true, keepSeconds: null, keepDefaultSeconds: 36000, off: [], own: [], object: false, objectBlocked: null, liveBlocked: null });
  });

  it('turns the page cache off in the running container, and clears', async () => {
    const { w, site, call, nginxFile } = await world();
    const res = await call('PUT', '/cache', { page: 'off' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job: null, site: { cache: { page: 'off', pageOn: false } } });
    expect(nginxFile()).toContain('The page cache is off');
    expect(w.docker.reloads).toEqual([{ name: site.containerName, service: 'nginx' }]);
    // Once now, and once after PHP can no longer hold the old rules.
    await waitFor(() => w.docker.cacheClears.length === 2);
  });

  it('clears when it is switched back on: the files outlive Off', async () => {
    const { w, call } = await world();
    await call('PUT', '/cache', { page: 'off' });
    await waitFor(() => w.docker.cacheClears.length === 2);
    w.docker.cacheClears.length = 0;
    await call('PUT', '/cache', { page: 'on' });
    await waitFor(() => w.docker.cacheClears.length === 2);
  });

  it('one save at a time: two at once end as the later one says, in the row and in the files', async () => {
    const { w, site, call, nginxFile } = await world();
    expect((await call('PUT', '/cache', { page: 'off' })).statusCode).toBe(200);
    // The first look the On save takes at the container waits, until the Off save has come in.
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    const stack = w.docker.containerStack.bind(w.docker);
    const looked = vi.spyOn(w.docker, 'containerStack').mockImplementationOnce(async (name: string) => {
      await gate;
      return stack(name);
    });
    const on = call('PUT', '/cache', { page: 'on' });
    await waitFor(() => looked.mock.calls.length === 1);
    const off = call('PUT', '/cache', { page: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    letGo();
    expect((await on).statusCode).toBe(200);
    expect((await off).statusCode).toBe(200);
    expect(w.deps.sites.bySlug(site.slug).pageCache).toBe('off');
    expect(nginxFile()).toContain('The page cache is off');
  });

  it('reloads nothing, and clears nothing, when nothing changed', async () => {
    const { w, call } = await world();
    await call('PUT', '/cache', { page: 'default' });
    expect(w.docker.reloads).toEqual([]);
    expect(w.docker.cacheClears).toEqual([]);
  });

  it('takes rules: own ones, a built-in switched off, and a keep time', async () => {
    const { w, site, call, nginxFile, wpCacheFile } = await world();
    const res = await call('PUT', '/cache', {
      keepSeconds: 600,
      off: ['phones'],
      own: [{ kind: 'skip', match: 'path', value: '/members/*' }, { kind: 'keep', match: 'path', value: '/live/*', seconds: 60 }],
    });
    expect(res.statusCode).toBe(200);
    const { cache } = res.json().site;
    expect(cache.keepSeconds).toBe(600);
    expect(cache.off).toEqual(['phones']);
    expect(cache.own.map((r: { id: string }) => typeof r.id)).toEqual(['string', 'string']);
    expect(nginxFile()).toContain('path /members/*');
    expect(nginxFile()).not.toContain('wpl7_phone');
    expect(wpCacheFile()).toContain("'keep_seconds' => 600");
    expect(w.docker.reloads).toEqual([{ name: site.containerName, service: 'nginx' }]);
  });

  it('keeps ids across a save, and a save of one thing leaves the rest', async () => {
    const { call } = await world();
    const first = (await call('PUT', '/cache', { own: [{ kind: 'skip', match: 'cookie', value: 'member' }] })).json().site.cache;
    const again = (await call('PUT', '/cache', { keepSeconds: 60 })).json().site.cache;
    expect(again.own).toEqual(first.own);
    expect(again.keepSeconds).toBe(60);
    expect((await call('PUT', '/cache', { keepSeconds: null })).json().site.cache.keepSeconds).toBeNull();
  });

  it.each([
    ['a value nginx could read as config', { own: [{ kind: 'skip', match: 'path', value: '/a"; deny all;' }] }],
    ['a dollar in a cookie name', { own: [{ kind: 'skip', match: 'cookie', value: '$host' }] }],
    ['a kind that does not take that match', { own: [{ kind: 'copy', match: 'path', value: '/a/' }] }],
    ['a keep rule with no time', { own: [{ kind: 'keep', match: 'path', value: '/a/' }] }],
    ['a keep rule past the ceiling', { own: [{ kind: 'keep', match: 'path', value: '/a/', seconds: 36001 }] }],
    ['a keep time past the ceiling', { keepSeconds: 36001 }],
    ['nothing to do', {}],
    ['a sixth separate copy', { own: Array.from({ length: 6 }, (_, i) => ({ kind: 'copy', match: 'cookie', value: `c${i}` })) }],
    ['a field it does not know', { keep: 5 }],
  ])('refuses %s', async (_what, body) => {
    const { call, nginxFile } = await world();
    const before = nginxFile();
    expect((await call('PUT', '/cache', body)).statusCode).toBe(400);
    expect(nginxFile()).toBe(before);
  });

  it('refuses switching off the locked group, or something that does not exist', async () => {
    const { call } = await world();
    const locked = await call('PUT', '/cache', { off: ['wordpress'] });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.message).toMatch(/can't be switched off/);
    expect((await call('PUT', '/cache', { off: ['wordpress.logged-in'] })).statusCode).toBe(400);
    expect((await call('PUT', '/cache', { off: ['no-such-thing'] })).statusCode).toBe(400);
  });

  it('puts the file and the row back when nginx refuses', async () => {
    const { w, site, call, nginxFile } = await world();
    const before = nginxFile();
    w.docker.reloadRefusals.set('nginx', 'nginx refused the panel file');
    const res = await call('PUT', '/cache', { page: 'off' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/nginx refused/);
    expect(nginxFile()).toBe(before);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.pageCache).toBeNull();
    expect(w.docker.cacheClears).toEqual([]);
  });

  it('is refused while the site is busy with something that replaces its container', async () => {
    const { w, site, call } = await world();
    const job = w.deps.sites.reconcile(site.slug);
    expect((await call('PUT', '/cache', { page: 'off' })).statusCode).toBe(409);
    await runJob(w, job.id);
    expect((await call('PUT', '/cache', { page: 'off' })).statusCode).toBe(200);
  });

  it('forgets why the cache was off once someone chooses', async () => {
    const { w, site, call } = await world();
    w.db.update(sites).set({ pageCache: 'off', cacheRules: JSON.stringify({ offReason: 'Because of Geolocate.' }) }).where(eq(sites.id, site.id)).run();
    expect((await call('GET', '')).json().cache.offReason).toBe('Because of Geolocate.');
    expect((await call('PUT', '/cache', { keepSeconds: 60 })).json().site.cache.offReason).toBe('Because of Geolocate.');
    expect((await call('PUT', '/cache', { page: 'default' })).json().site.cache.offReason).toBeNull();
  });

  it('writes the files for a stopped site and reloads nothing: its start reads them', async () => {
    const { w, site, call, nginxFile } = await world();
    w.docker.containers.set(site.containerName, 'exited');
    expect((await call('PUT', '/cache', { page: 'off' })).statusCode).toBe(200);
    expect(nginxFile()).toContain('The page cache is off');
    expect(w.docker.reloads).toEqual([]);
    expect(w.docker.cacheClears).toEqual([]);
  });

  it('writes the files for a stack 1 site, which does not read them, and reloads nothing', async () => {
    const { w, site, call } = await world();
    w.docker.labelsByContainer.set(site.containerName, {});
    expect((await call('PUT', '/cache', { page: 'off' })).statusCode).toBe(200);
    expect(w.docker.reloads).toEqual([]);
  });
});

describe('the object cache', () => {
  /** What WP-CLI answers, in the order the job asks. */
  const scripted = (w: TestWorld, answers: { stdout?: string; stderr?: string; exitCode?: number }[]) => {
    w.docker.execQueue.push(...answers.map((a) => ({ stdout: a.stdout ?? '', stderr: a.stderr ?? '', exitCode: a.exitCode ?? 0 })));
  };

  it('starts Redis, installs the plugin, and is on once it says connected', async () => {
    const { w, site, call } = await world();
    scripted(w, [{}, {}, { stdout: 'Status: Connected\nClient: PhpRedis\n' }]);
    w.docker.calls.length = 0;
    const res = await call('PUT', '/cache', { object: true });
    expect(res.statusCode).toBe(202);
    expect((await runJob(w, res.json().job.id)).status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.objectCache).toBe(1);
    expect(fs.existsSync(path.join(sitePaths(w.config, site.slug).runtimeDir, 'redis.conf'))).toBe(true);
    expect(w.docker.reloads).toEqual([{ name: site.containerName, service: 'redis' }]);
    const wp = w.docker.calls.filter((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'wp').map((c) => (c.args[1] as string[]).slice(1).join(' '));
    expect(wp).toEqual(['plugin install redis-cache --activate', 'redis enable', 'redis status']);
  });

  it('stays off and stops Redis when another object cache is in the way, and says so', async () => {
    const { w, site, call } = await world();
    scripted(w, [{}, { stderr: 'Error: An unknown object cache drop-in was found.', exitCode: 1 }]);
    const res = await call('PUT', '/cache', { object: true });
    const done = await runJob(w, res.json().job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/unknown object cache drop-in/);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.objectCache).toBe(0);
    expect(fs.existsSync(path.join(sitePaths(w.config, site.slug).runtimeDir, 'redis.conf'))).toBe(false);
    expect(w.docker.reloads.map((r) => r.service)).toEqual(['redis', 'redis']);
  });

  it('stays off when the plugin cannot reach Redis', async () => {
    const { w, site, call } = await world();
    scripted(w, [{}, {}, { stdout: 'Status: Not connected\n' }]);
    const done = await runJob(w, (await call('PUT', '/cache', { object: true })).json().job.id);
    expect(done.status).toBe('failed');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.objectCache).toBe(0);
  });

  it('goes off again whatever the plugin says: the plugin stays installed', async () => {
    const { w, site, call } = await world();
    w.db.update(sites).set({ objectCache: 1 }).where(eq(sites.id, site.id)).run();
    scripted(w, [{ stderr: 'Error: not a registered wp command', exitCode: 1 }, {}]);
    const done = await runJob(w, (await call('PUT', '/cache', { object: false })).json().job.id);
    expect(done.status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.objectCache).toBe(0);
    expect(fs.existsSync(path.join(sitePaths(w.config, site.slug).runtimeDir, 'redis.conf'))).toBe(false);
  });

  it('queues nothing when it already is as asked', async () => {
    const { call } = await world();
    expect((await call('PUT', '/cache', { object: false })).json().job).toBeNull();
  });

  it('is refused on stack 1, and the card says why', async () => {
    const { w, site, call } = await world();
    w.docker.labelsByContainer.set(site.containerName, {});
    expect((await call('PUT', '/cache', { object: true })).statusCode).toBe(409);
    expect((await call('GET', '')).json().cache.objectBlocked).toMatch(/old PHP setup/);
  });

  it('names another object cache the inventory found', async () => {
    const { w, site, call } = await world();
    w.db.insert(siteWpComponents).values({ siteId: site.id, kind: 'plugin', slug: 'object-cache.php', title: 'Some Other Cache', status: 'dropin', version: '1', updateState: 'none', autoUpdate: 0, seenAt: Date.now() } as never).run();
    expect((await call('GET', '')).json().cache.objectBlocked).toMatch(/Some Other Cache/);
  });

  it('flushes Redis along with the page cache', async () => {
    const { w, site, call } = await world();
    w.db.update(sites).set({ objectCache: 1 }).where(eq(sites.id, site.id)).run();
    expect((await call('POST', '/cache/clear')).json()).toEqual({ cleared: true });
    expect(w.docker.cacheClears).toEqual([site.containerName]);
    expect(w.docker.redisFlushes).toEqual([site.containerName]);
  });
});

describe('POST /api/sites/:slug/cache/clear and /check', () => {
  it('says why it can not when the site is stopped or on stack 1', async () => {
    const { w, site, call } = await world();
    w.docker.containers.set(site.containerName, 'exited');
    expect((await call('POST', '/cache/clear')).statusCode).toBe(409);
    expect((await call('GET', '')).json().cache.liveBlocked).toMatch(/not running/);
    w.docker.containers.set(site.containerName, 'running');
    w.docker.labelsByContainer.set(site.containerName, {});
    expect((await call('POST', '/cache/check', { path: '/' })).statusCode).toBe(409);
  });

  const page = (status: number, headers: string) => ({ stdout: `HTTP/1.1 ${status} OK\r\n${headers}\r\n\r\n`, stderr: '', exitCode: 0 });

  it.each([
    ['a stored page', [page(200, 'X-Cache-Status: HIT')], { state: 'cached', reason: null, status: 200 }],
    ['a page stored by asking twice', [page(200, 'X-Cache-Status: MISS'), page(200, 'X-Cache-Status: HIT')], { state: 'cached', reason: null, status: 200 }],
    ['a page the rules skip', [page(200, 'X-Cache-Status: BYPASS\r\nX-Cache-Skipped: path /members/*')], { state: 'skipped', reason: 'path /members/*', status: 200 }],
    ['a page that says no', [page(200, 'X-Cache-Status: MISS\r\nX-Cache-Skipped: page says no-cache')], { state: 'not-stored', reason: 'page says no-cache', status: 200 }],
    ['something WordPress did not make', [page(200, 'X-Cache-Status: MISS'), page(200, 'X-Cache-Status: MISS')], { state: 'not-stored', reason: 'not a WordPress page', status: 200 }],
    ['the cache switched off', [page(200, 'X-Cache-Status: BYPASS\r\nX-Cache-Skipped: off')], { state: 'off', reason: null, status: 200 }],
    ['the last good copy', [page(200, 'X-Cache-Status: STALE')], { state: 'stale', reason: null, status: 200 }],
    ['no word from the cache', [page(200, 'Server: nginx')], { state: 'not-stored', reason: 'no answer from the page cache', status: 200 }],
  ])('%s', async (_what, answers, expected) => {
    const { w, call } = await world();
    w.docker.execQueue.push(...answers);
    const res = await call('POST', '/cache/check', { path: '/about/' });
    expect(res.json()).toEqual(expected);
  });

  it('asks nginx, as a visitor to the site would, without a shell in between', async () => {
    const { w, site, call } = await world();
    w.docker.execQueue.push(page(200, 'X-Cache-Status: HIT'));
    await call('POST', '/cache/check', { path: "/über/?x=1&y='$(id)'" });
    const curl = w.docker.calls.filter((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'curl').at(-1)!;
    expect(curl.args[0]).toBe(site.containerName);
    const args = curl.args[1] as string[];
    expect(args).toContain(`Host: ${site.domains ? JSON.parse(site.domains)[0] : ''}`);
    expect(args.at(-1)).toBe("http://127.0.0.1:8080/%C3%BCber/?x=1&y='$(id)'");
  });

  it.each([['no slash', 'about'], ['a space', '/a b'], ['a line break', '/a\nb'], ['nothing', '']])('refuses a path with %s', async (_what, value) => {
    const { call } = await world();
    expect((await call('POST', '/cache/check', { path: value })).statusCode).toBe(400);
  });
});

describe('what empties the caches', () => {
  it('a job that changes content, when it succeeds and when it fails', async () => {
    const { w, site } = await world();
    const enqueue = (args: string[]) => w.worker.enqueue('wp.cli', { siteId: site.id, args, timeoutMin: 1 }, { id: site.id, slug: site.slug, serverId: site.serverId });
    await runJob(w, enqueue(['post', 'update', '1', '--post_title=New']).id);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
    w.docker.execQueue.push({ stdout: '', stderr: 'Error', exitCode: 1 });
    await runJob(w, enqueue(['post', 'update', '1', '--post_title=Newer']).id);
    expect(w.docker.cacheClears).toEqual([site.containerName, site.containerName]);
  });

  it('not a command that only reads', async () => {
    const { w, site } = await world();
    const job = w.worker.enqueue('wp.cli', { siteId: site.id, args: ['plugin', 'list', '--format=json'], timeoutMin: 1 }, { id: site.id, slug: site.slug, serverId: site.serverId });
    await runJob(w, job.id);
    expect(w.docker.cacheClears).toEqual([]);
  });

  it('a REST request that writes, not one that reads', async () => {
    const { w, site } = await world();
    const rest = (method: string) => w.worker.enqueue('wp.rest', { siteId: site.id, method, route: '/wp/v2/posts', timeoutMin: 1 }, { id: site.id, slug: site.slug, serverId: site.serverId });
    await runJob(w, rest('GET').id);
    expect(w.docker.cacheClears).toEqual([]);
    await runJob(w, rest('POST').id);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
  });

  it('the synchronous WP-CLI and REST calls too', async () => {
    const { w, site, call } = await world();
    await call('POST', '/wp/cli', { args: ['option', 'get', 'home'] });
    expect(w.docker.cacheClears).toEqual([]);
    await call('POST', '/wp/cli', { args: ['option', 'update', 'blogname', 'New'] });
    expect(w.docker.cacheClears).toEqual([site.containerName]);
  });

  it('a change in the Files tab; an archive only when its job ends', async () => {
    const { w, site, call } = await world();
    // One entry record, as the Files scripts print it.
    w.docker.execQueue.push({ stdout: 'rw/d/d/5/755/1727000000.25/33/33/new-folder/\0', stderr: '', exitCode: 0 });
    const made = await call('POST', '/files/mkdir', { path: 'new-folder' });
    expect(made.statusCode, made.body).toBeLessThan(300);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
    const extract = await call('POST', '/files/extract', { path: 'a.zip', to: 'a' });
    expect(extract.statusCode, extract.body).toBe(202);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
  });

  it('a change in the database browser; not a SELECT in its SQL box', async () => {
    const { w, site, call } = await world();
    await call('POST', `/databases/${site.dbName}/query`, { sql: 'SELECT 1;' });
    expect(w.docker.cacheClears).toEqual([]);
    await call('POST', `/databases/${site.dbName}/query`, { sql: 'SELECT 1; DELETE FROM wp_posts' });
    expect(w.docker.cacheClears).toEqual([site.containerName]);
    await call('POST', `/databases/${site.dbName}/query`, { sql: "UPDATE wp_options SET option_value = 'x'" });
    expect(w.docker.cacheClears).toEqual([site.containerName, site.containerName]);
  });

  it('maintenance mode, either way: stored pages would go on being served', async () => {
    const { w, site, call } = await world();
    expect((await call('PUT', '/wp/maintenance', { enabled: true })).statusCode).toBe(200);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
  });

  it('a plugin update: and what it brought is checked for PHP lines first, with the site’s .user.ini files left as they are', async () => {
    const { w, site } = await world();
    const job = w.worker.enqueue('wp.pluginTask', { siteId: site.id, slug: 'hello', action: 'update', backupFirst: false } as never, { id: site.id, slug: site.slug, serverId: site.serverId });
    await runJob(w, job.id);
    expect(w.docker.calls.some((c) => c.method === 'runEphemeral' && (c.args[0] as { labels?: Record<string, string> }).labels?.['wpl7.migration'] === 'maintain')).toBe(true);
    expect(w.docker.cacheClears).toEqual([site.containerName]);
  });

  it('nothing for a stopped site: its start empties them', async () => {
    const { w, site } = await world();
    w.docker.containers.set(site.containerName, 'exited');
    const job = w.worker.enqueue('backup.restore', { backupId: 999 } as never, { id: site.id, slug: site.slug, serverId: site.serverId });
    await runJob(w, job.id);
    expect(w.docker.cacheClears).toEqual([]);
  });
});

describe('wpCliOnlyReads', () => {
  it.each([
    [['plugin', 'list', '--format=json']],
    [['option', 'get', 'home']],
    [['core', 'version']],
    [['core', 'is-installed']],
    [['cron', 'event', 'list']],
    [['post', 'meta', 'get', '1', 'x']],
    [['language', 'core', 'list']],
    [['redis', 'status']],
    [['help', 'plugin']],
    [['cli', 'version']],
    [['--info']],
  ])('%j only reads', (args) => {
    expect(wpCliOnlyReads(args)).toBe(true);
  });

  it.each([
    [['option', 'update', 'home', 'x']],
    [['post', 'delete', '1']],
    [['post', 'meta', 'update', '1', 'x', 'y']],
    [['eval', 'echo 1;']],
    [['db', 'query', 'DELETE FROM wp_posts']],
    [['search-replace', 'a', 'b']],
    [['plugin', 'activate', 'get']],
    [['somecommand']],
    [['godmode', 'chat', 'send', '--message=hello']],
  ])('%j counts as a change', (args) => {
    expect(wpCliOnlyReads(args)).toBe(false);
  });
});

describe('a panel update that renders a site differently', () => {
  it('queues the job until a server has had it with nothing left out', async () => {
    const { w, site } = await world();
    const jobsOf = () => w.db.select().from(jobs).where(eq(jobs.type, 'server.applySiteLimits')).all();
    expect(sweepSiteRuntime(w.core, w.worker)).toEqual([site.serverId]);
    // One waiting is enough.
    expect(sweepSiteRuntime(w.core, w.worker)).toEqual([]);
    expect(jobsOf()).toHaveLength(1);

    const done = await runJob(w, jobsOf()[0]!.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(sweepSiteRuntime(w.core, w.worker)).toEqual([]);

    // An older panel applied them.
    w.core.settings.setRaw(`site.runtimeDigest.${site.serverId}`, 'an older panel');
    expect(sweepSiteRuntime(w.core, w.worker)).toEqual([site.serverId]);
    expect(siteImage('8.3')).toContain('8.3');
    markRuntimeApplied(w.core.settings, site.serverId);
  });

  it('takes a rule saved while the job was on its way', async () => {
    const { w, site, call, nginxFile } = await world();
    const job = w.worker.enqueue('server.applySiteLimits', { serverId: site.serverId }, undefined, { serverId: site.serverId });
    expect((await call('PUT', '/cache', { own: [{ kind: 'skip', match: 'path', value: '/members/*' }] })).statusCode).toBe(200);
    await runJob(w, job.id);
    expect(nginxFile()).toContain('path /members/*');
  });
});
