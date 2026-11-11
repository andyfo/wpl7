/**
 * What stays WordPress's: a PHP site is refused with a 409 everywhere WordPress is the point, left
 * out of every loop over WordPress sites, and keeps everything that works on any site - the shell
 * above all.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, siteWpStatus } from '../../src/db/schema.js';
import { fireAction, ineligible } from '../../src/jobs/actions.js';
import { Schedulers } from '../../src/jobs/schedulers.js';
import { clearAfterChange, clearSiteCaches } from '../../src/services/siteCaches.js';
import { addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REFUSED = '"plain" is a PHP site: this works only for WordPress sites.';

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

const execs = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));

describe('a PHP site and the WordPress endpoints', () => {
  it('answers 409 at every one of them, before anything is queued or run', async () => {
    const w = await makeWorld();
    addPhpSite(w, 'plain');
    const { app, headers } = await authed(w);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/sites/plain/wp/plugins'],
      ['GET', '/api/sites/plain/wp/version'],
      ['GET', '/api/sites/plain/wp/status'],
      ['POST', '/api/sites/plain/wp/scan', {}],
      ['POST', '/api/sites/plain/wp/core-update', {}],
      ['POST', '/api/sites/plain/wp/plugins', { source: { kind: 'wporg', slug: 'akismet' } }],
      ['POST', '/api/sites/plain/wp/plugins/akismet/update', {}],
      ['POST', '/api/sites/plain/wp/themes/twentytwenty/update', {}],
      ['GET', '/api/sites/plain/godmode/chats'],
      ['POST', '/api/sites/plain/wp/plugins/akismet/activate', {}],
      ['DELETE', '/api/sites/plain/wp/plugins/akismet'],
      ['POST', '/api/sites/plain/wp/themes/twentytwenty/activate', {}],
      ['GET', '/api/sites/plain/wp/maintenance'],
      ['PUT', '/api/sites/plain/wp/maintenance', { enabled: true }],
      ['POST', '/api/sites/plain/wp/test-email', { to: 'someone@example.com' }],
      ['POST', '/api/sites/plain/wp/admin-login', {}],
      ['POST', '/api/sites/plain/wp/cli', { args: ['plugin', 'list'] }],
      ['GET', '/api/sites/plain/wp/cli/help'],
      ['POST', '/api/sites/plain/wp/rest', { method: 'GET', route: '/wp/v2/posts' }],
      ['GET', '/api/sites/plain/godmode/agents'],
      ['GET', '/api/sites/plain/wp/recipes'],
      ['POST', '/api/sites/plain/wp/recipes/apply', { hook: 'afterInstall' }],
      ['POST', '/api/wp/bulk', { action: 'update', targets: [{ siteSlug: 'plain', kind: 'core', slug: 'wordpress' }] }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as 'GET', url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      expect([method, url, res.statusCode, res.json().error?.message]).toEqual([method, url, 409, REFUSED]);
    }
    expect(w.db.select().from(jobs).all()).toEqual([]);
    expect(execs(w)).toEqual([]);
  });

  it('runs a shell command in its folder, as for any site', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'POST', url: '/api/sites/plain/shell', headers, payload: { command: 'php -v' } });
    expect(res.statusCode).toBe(202);
    const job = w.db.select().from(jobs).where(eq(jobs.id, res.json().job.id)).get()!;
    w.worker.start();
    await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 15_000);
    await w.worker.stop();
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('succeeded');
    const shell = w.docker.calls.find((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'sh')!;
    expect(shell.args[0]).toBe(site.containerName);
    expect(shell.args[1]).toEqual(['sh', '-c', 'php -v']);
    expect(shell.args[2]).toMatchObject({ user: '33:33', workdir: '/var/www/html' });
  });

  it('refuses the WordPress jobs too, if one is queued by other means', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const queued = [
      w.worker.enqueue('wp.cli', { siteId: site.id, args: ['plugin', 'list'], timeoutMin: 5 }, site),
    ];
    w.worker.start();
    await waitFor(() => queued.every((j) => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, j.id)).get()!.status)), 15_000);
    await w.worker.stop();
    for (const j of queued) {
      const row = w.db.select().from(jobs).where(eq(jobs.id, j.id)).get()!;
      expect([row.status, row.error]).toEqual(['failed', '"plain" is a PHP site: this job works only for WordPress sites.']);
    }
    expect(execs(w)).toEqual([]);
  });

  it('refuses the page cache, the Put back and Reinstall of a finding, and maintenance mode as a move’s freeze', async () => {
    const w = await makeWorld();
    addPhpSite(w, 'plain');
    const s2 = w.addSshServer('s2', { publicIp: '203.0.113.9' });
    const { app, headers } = await authed(w);
    const cache = await app.inject({ method: 'PUT', url: '/api/sites/plain/cache', headers, payload: { page: 'on' } });
    expect([cache.statusCode, cache.json().error.message]).toEqual([409, '"plain" is a PHP site, which has no page cache.']);
    const clear = await app.inject({ method: 'POST', url: '/api/sites/plain/cache/clear', headers });
    expect([clear.statusCode, clear.json().error.message]).toEqual([409, '"plain" is a PHP site, which has no page cache.']);
    for (const action of ['put-back', 'reinstall']) {
      const res = await app.inject({ method: 'POST', url: `/api/sites/plain/security/findings/1/${action}`, headers });
      expect([action, res.statusCode, res.json().error.message]).toEqual([action, 409, REFUSED]);
    }
    const move = await app.inject({ method: 'POST', url: '/api/sites/plain/move', headers, payload: { targetServerId: s2.id, quiesce: 'maintenance' } });
    expect([move.statusCode, move.json().error.message]).toEqual([409, '"plain" is a PHP site, which has no maintenance mode: stop it while it moves, or keep serving.']);
  });
});

describe('the loops over WordPress sites', () => {
  it('leave a PHP site out: wp-cron, the scan schedule, the fleet scan and the inventory', async () => {
    const w = await makeWorld();
    addPhpSite(w, 'plain');
    const schedulers = new Schedulers(w.core, w.worker);
    // Never scanned, as a PHP site never is: it must not keep a scan due.
    expect(schedulers.wpScanIsDue()).toBe(false);
    await (schedulers as unknown as { wpCronTick(): Promise<unknown> }).wpCronTick();
    expect(execs(w).filter((c) => c.startsWith('wp '))).toEqual([]);

    const job = w.worker.enqueue('wp.scanAll', {});
    w.worker.start();
    await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 15_000);
    await w.worker.stop();
    const done = w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(JSON.parse(done.result!)).toMatchObject({ scanned: 0, failed: 0, skippedStopped: 0 });
    expect(w.db.select().from(siteWpStatus).all()).toEqual([]);
    expect(w.core.wpInventory.fleetInventory({ includeStopped: true } as never).sites ?? []).toEqual([]);
  });

  it('never empty its Redis: after a job, and when the cache files change', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    w.db.update((await import('../../src/db/schema.js')).sites).set({ objectCache: 1 }).run();
    const row = { ...site, objectCache: 1 };
    vi.spyOn(w.docker, 'containerStack').mockResolvedValue({ imageId: 'sha256:site', stack: 2 });
    await clearAfterChange(w.core, row);
    expect(await clearSiteCaches(w.servers.handleFor(1), row)).toBe(true);
    expect(execs(w).filter((c) => c.includes('redis-cli'))).toEqual([]);
  });
});

describe('schedules', () => {
  it('skip a PHP site for what needs WordPress, and keep it for the rest', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    for (const action of ['wp.scan', 'wp.update', 'wp.cli', 'wp.rest'] as const) {
      expect(ineligible(action, site)).toBe('is a PHP site: it has no WordPress');
    }
    expect(ineligible('backup', site)).toBeNull();
    expect(ineligible('site.shell', site)).toBeNull();
    expect(ineligible('site.restart', site)).toBeNull();

    const cli = fireAction(w.core, w.worker, 'wp.cli', { kind: 'all' }, { args: ['cache', 'flush'] }, { name: 'flush' });
    expect(cli.jobs).toEqual([]);
    const shell = fireAction(w.core, w.worker, 'site.shell', { kind: 'all' }, { command: 'php artisan schedule:run' }, { name: 'tick' });
    expect(shell.jobs.map((j) => j.siteId)).toEqual([site.id]);
    const named = fireAction(w.core, w.worker, 'wp.cli', { kind: 'sites', slugs: ['plain'] }, { args: ['cache', 'flush'] }, { name: 'flush' });
    expect(named.skipped).toEqual([{ siteSlug: 'plain', reason: 'is a PHP site: it has no WordPress' }]);
  });
});
