/**
 * Regressions for the September 2026 project review. Each test reproduces the reported
 * trigger and asserts the FIXED behaviour; the review's own harness (.context/review)
 * asserts the buggy one, so the two must disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, jobLogs, jobs, moveCleanups, servers, sites } from '../../src/db/schema.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { hostExec } from '../../src/lib/exec.js';
import { autoFinalizeMoves } from '../../src/services/housekeeping.js';
import { demuxToStreams } from '../../src/lib/demux.js';
import { withDeadline } from '../../src/services/docker.js';
import { proxyConfigYaml } from '../../src/jobs/handlers/moveHelpers.js';

function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    return row.status !== 'queued' && row.status !== 'running';
  }, 25_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

async function createSite(w: TestWorld, slug = 'review-site') {
  seedCoreFilesOnStart(w);
  const { job } = w.deps.sites.create({
    title: 'Review',
    slug,
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.test',
    discourageSearchEngines: true,
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  expect((await runJob(w, job.id)).status).toBe('succeeded');
  return w.deps.sites.bySlug(slug);
}

const execCmds = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));

describe('review regressions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('site.create: refuses to publish when the expected administrator does not exist', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    // core install "succeeds" (someone else's admin), then `wp user get boss` fails.
    w.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 }, { stdout: '', stderr: 'Invalid user', exitCode: 1 });
    const { site, job } = w.deps.sites.create({ title: 'Hijack', slug: 'hijack', domainMode: 'dev', adminUser: 'boss', adminEmail: 'b@e.test', discourageSearchEngines: true });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/administrator "boss" does not exist/);
    // Never routed publicly, and fully rolled back.
    const specs = w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as { labels: Record<string, string> });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.labels['traefik.enable']).toBe('false');
    expect(w.docker.containers.has(site.containerName)).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
  });

  it('domain change: the registry is committed only after WordPress was rewritten; a retry repairs', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const wp = w.servers.handleFor(1).wp;
    const update = vi.spyOn(wp, 'optionUpdate').mockRejectedValueOnce(new Error('WP unavailable'));

    const failed = await runJob(w, w.deps.sites.updateDomains(site.slug, ['customer.example.test'], true, true).id);
    expect(failed.status).toBe('failed');
    const afterFail = w.deps.sites.bySlug(site.slug);
    expect(JSON.parse(afterFail.domains)[0]).toBe(site.devHostname); // NOT committed
    expect(afterFail.isLive).toBe(0);
    expect(afterFail.status).toBe('running');
    expect(w.docker.containers.get(site.containerName)).toBe('running'); // transition router restored

    update.mockClear();
    const retry = await runJob(w, w.deps.sites.updateDomains(site.slug, ['customer.example.test'], true, true).id);
    expect(retry.status).toBe('succeeded');
    expect(update).toHaveBeenCalledWith(site.containerName, 'home', 'http://customer.example.test');
    expect(update).toHaveBeenCalledWith(site.containerName, 'siteurl', 'http://customer.example.test');
    const afterRetry = w.deps.sites.bySlug(site.slug);
    expect(JSON.parse(afterRetry.domains)).toEqual(['customer.example.test', site.devHostname]);
    expect(afterRetry.isLive).toBe(1);
  });

  it('PHP switch: a failed replacement restores the old container and keeps the recorded version', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));

    const failed = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(failed.status).toBe('failed');
    expect(w.deps.sites.bySlug(site.slug).phpVersion).toBe('8.3');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    const restored = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { image: string };
    expect(restored.image).toBe('wpl7-wordpress:php8.3');

    const retry = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(retry.status).toBe('succeeded');
    expect(w.deps.sites.bySlug(site.slug).phpVersion).toBe('8.4');
    const current = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { image: string };
    expect(current.image).toBe('wpl7-wordpress:php8.4');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('start: repairs the bind mount instead of recreating the directory it fails on', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.enforceFileBinds = true;
    const p = sitePaths(w.config, site.slug);

    // Binds are resolved at START, not only at create: a container that exists already will
    // have Docker recreate the missing source as a directory and then refuse to run. That is
    // what put the directory back every time it was removed by hand.
    w.docker.containers.set(site.containerName, 'exited');
    fs.rmSync(p.msmtprc, { force: true });

    const done = await runJob(w, w.deps.sites.action(site.slug, 'start').id);
    expect(done.status).toBe('succeeded');
    expect(fs.statSync(p.msmtprc).isFile()).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('restart: repairs the bind mount too', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.enforceFileBinds = true;
    const p = sitePaths(w.config, site.slug);
    fs.rmSync(p.msmtprc, { force: true });
    fs.mkdirSync(p.msmtprc);

    const done = await runJob(w, w.deps.sites.action(site.slug, 'restart').id);
    expect(done.status).toBe('succeeded');
    expect(fs.statSync(p.msmtprc).isFile()).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('reconcile: a container that FAILED to start is not mistaken for one stopped on purpose', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);

    // Exactly the state a failed start leaves behind: the container exists and has never
    // run, so Docker reports it as `created` - which is not `exited`, and must not be read
    // as one. The registry still says the site is running, and that is the intent to honour.
    w.docker.containers.set(site.containerName, 'created');
    fs.rmSync(p.msmtprc, { force: true });
    fs.mkdirSync(p.msmtprc);
    w.docker.enforceFileBinds = true;
    expect(w.deps.sites.bySlug(site.slug).status).toBe('running');

    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('succeeded');
    // Rebuilt AND running: a rebuilt-but-down container is a 404 behind Traefik.
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(fs.statSync(p.msmtprc).isFile()).toBe(true);
  });

  it('reconcile: a site stopped on purpose stays stopped, and says so', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await runJob(w, w.deps.sites.action(site.slug, 'stop').id);
    expect(w.docker.containers.get(site.containerName)).toBe('exited');

    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('succeeded');
    expect(w.docker.containers.get(site.containerName)).toBe('created');
    const logs = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, done.id)).all();
    expect(logs.map((l) => l.message).join('\n')).toMatch(/left stopped/i);
  });

  it('PHP switch: a site with no msmtprc is repaired rather than left with no container', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    // Docker creates a missing bind source as a DIRECTORY, and then cannot mount it over the
    // file the image has there. Once that has happened the failure sticks: the rollback
    // rebuilds the same spec and hits the same directory, so the site ends up with nothing.
    w.docker.enforceFileBinds = true;

    // What an upgrade finds: a site from before per-site mail auth - no credential, no
    // msmtprc - after one container create has already left the directory behind.
    const p = sitePaths(w.config, site.slug);
    w.db.update(sites).set({ mailPassword: null }).where(eq(sites.id, site.id)).run();
    fs.rmSync(p.msmtprc, { force: true });
    fs.mkdirSync(p.msmtprc);

    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status).toBe('succeeded');
    expect(fs.statSync(p.msmtprc).isFile()).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.deps.sites.bySlug(site.slug).phpVersion).toBe('8.4');
  });

  it('reconcile: rebuilds the container of a site a failed switch left with none', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.enforceFileBinds = true;
    const p = sitePaths(w.config, site.slug);

    // The state the bug left behind: no container, and the directory that keeps every
    // recreate failing. Reconcile is what the panel offers as the way out.
    w.docker.containers.delete(site.containerName);
    fs.rmSync(p.msmtprc, { force: true });
    fs.mkdirSync(p.msmtprc);

    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('succeeded');
    expect(fs.statSync(p.msmtprc).isFile()).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('PHP switch: "already on that version" is not believed while the container is missing', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.containers.delete(site.containerName);
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.3').id);
    expect(done.status).toBe('succeeded');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('move: the maintenance freeze is re-armed while the copy runs and stops afterwards', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    w.db.update(sites).set({ isLive: 1 }).where(eq(sites.id, site.id)).run();
    const target = w.addSshServer('target', { real: true });
    // Make the copy take long enough for the (test-speed) keepalive to fire.
    const dump = w.dbAdmin.dumpTo.bind(w.dbAdmin);
    vi.spyOn(w.dbAdmin, 'dumpTo').mockImplementation(async (db, dest) => {
      await new Promise((r) => setTimeout(r, 200));
      await dump(db, dest);
    });
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');
    const refreshes = () => execCmds(w).filter((c) => c === 'wp maintenance-mode activate --force').length;
    expect(refreshes()).toBeGreaterThan(0);
    const after = refreshes();
    await new Promise((r) => setTimeout(r, 200));
    expect(refreshes()).toBe(after); // keepalive stopped with the job
  });

  it('move: the source copy is parked (never torn down in-job) and every hostname is forwarded and verified', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w); // dev site, no DNS provider configured
    const target = w.addSshServer('target', { real: true });
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id);
    expect(done.status).toBe('succeeded');

    const result = JSON.parse(done.result!) as { dns: { manual: { host: string }[] } };
    expect(result.dns.manual.map((m) => m.host)).toContain(site.devHostname);
    // Source container gone, files/db parked, cleanup pending on the dev hostname.
    expect(w.docker.containers.has(site.containerName)).toBe(false);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(true);
    expect(w.dbAdmin.databases.has(site.dbName)).toBe(true);
    const cleanup = w.db.select().from(moveCleanups).all()[0]!;
    expect(cleanup.status).toBe('pending');
    expect(JSON.parse(cleanup.verifyHosts)).toEqual([site.devHostname]);
    // The old server forwards the dev hostname to the new one.
    const yaml = fs.readFileSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', `move-${site.slug}.yml`), 'utf8');
    expect(yaml).toContain(site.devHostname!);
    expect(yaml).toContain('203.0.113.9');
  });

  it('move forwarder: pure dev-domain hosts reuse the wildcard resolver, custom hosts use HTTP-01', () => {
    const base = { slug: 's', targetIp: '203.0.113.9', tlsMode: 'letsencrypt' as const, acmeResolver: 'letsencrypt' };
    const dev = proxyConfigYaml({ ...base, hosts: ['s.dev.example.test'], devDomain: 'dev.example.test', dnsProvider: 'cloudflare' });
    expect(dev).toContain('certResolver: letsencrypt-dns');
    expect(dev).toContain('- "*.dev.example.test"');
    const custom = proxyConfigYaml({ ...base, hosts: ['shop.example.com', 's.dev.example.test'], devDomain: 'dev.example.test', dnsProvider: 'cloudflare' });
    expect(custom).toContain('certResolver: letsencrypt\n');
    expect(custom).not.toContain('letsencrypt-dns');
  });

  it('auto-finalize: needs every A answer to be the target and no AAAA records', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const target = w.addSshServer('target');
    w.db
      .insert(moveCleanups)
      .values({
        siteId: site.id, siteSlug: site.slug, sourceServerId: 1, targetServerId: target.id,
        containerName: site.containerName, dbName: site.dbName, dbUser: site.dbUser,
        filesPath: sitePaths(w.config, site.slug).root, verifyHosts: JSON.stringify(['customer.example.test']),
        targetIp: '203.0.113.9', status: 'pending', createdAt: Date.now() - 25 * 3600_000,
      })
      .run();
    const queued = () => w.db.select().from(jobs).where(eq(jobs.type, 'site.moveFinalize')).all().length;
    await autoFinalizeMoves(w.core, w.worker, w.core.log, { resolve4: async () => ['203.0.113.9', '198.51.100.1'], resolve6: async () => [] });
    expect(queued()).toBe(0); // old address still in the answer
    await autoFinalizeMoves(w.core, w.worker, w.core.log, { resolve4: async () => ['203.0.113.9'], resolve6: async () => ['2001:db8::1'] });
    expect(queued()).toBe(0); // IPv6 points somewhere the panel cannot verify
    await autoFinalizeMoves(w.core, w.worker, w.core.log, { resolve4: async () => ['203.0.113.9'], resolve6: async () => [] });
    expect(queued()).toBe(1);
  });

  it('delete: a failed parked-copy cleanup keeps the site row (slug reserved) and marks it error', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    w.db.update(sites).set({ isLive: 1, domains: JSON.stringify(['customer.example.test']) }).where(eq(sites.id, site.id)).run();
    const target = w.addSshServer('target', { real: true });
    expect((await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id)).status).toBe('succeeded');

    const files = w.servers.handleFor(1).files;
    vi.spyOn(files, 'rm').mockRejectedValueOnce(new Error('source filesystem unavailable'));
    const failed = await runJob(w, w.deps.sites.delete(site.slug, false).id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/site NOT deleted/);
    expect(w.deps.sites.bySlug(site.slug).status).toBe('error');
    expect(w.db.select().from(moveCleanups).all()[0]!.status).toBe('pending');
    // The slug stays taken until the parked copy is really gone.
    expect(() =>
      w.deps.sites.create({ title: 'Again', slug: site.slug, domainMode: 'dev', adminUser: 'boss', adminEmail: 'b@e.test', discourageSearchEngines: true }),
    ).toThrow(/already (taken|in use)/);

    vi.restoreAllMocks();
    expect((await runJob(w, w.deps.sites.delete(site.slug, false).id)).status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    expect(w.db.select().from(moveCleanups).all()[0]!.status).toBe('done');
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(false);
  });

  it('finalize: never tears down what a site now living on the source server owns', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w); // lives on server 1 with these very container/db/dir names
    const target = w.addSshServer('target');
    // A stale cleanup from a long-gone earlier site with the same slug.
    const stale = w.db
      .insert(moveCleanups)
      .values({
        siteId: 999_999, siteSlug: site.slug, sourceServerId: 1, targetServerId: target.id,
        containerName: site.containerName, dbName: site.dbName, dbUser: site.dbUser,
        filesPath: sitePaths(w.config, site.slug).root, verifyHosts: '[]', targetIp: '203.0.113.9',
        status: 'pending', createdAt: Date.now() - 25 * 3600_000,
      })
      .returning()
      .get();
    const fin = w.worker.enqueue('site.moveFinalize', { cleanupId: stale.id }, { id: 999_999, slug: site.slug, serverId: 1 }, { serverId: 1 });
    expect((await runJob(w, fin.id)).status).toBe('succeeded');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.dbAdmin.databases.has(site.dbName)).toBe(true);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(true);
    expect(w.db.select().from(moveCleanups).where(eq(moveCleanups.id, stale.id)).get()!.status).toBe('done');
  });

  it('backups: cannot be deleted by the API or retention while a job may be using them', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const backup = await w.core.backup.create(site, 'manual');
    const { app } = await makeApp(w);
    const { token } = w.deps.apiKeys.create('review');
    let deleteStatus = 0;
    vi.spyOn(w.dbAdmin, 'recreateDb').mockImplementation(async () => {
      const res = await app.inject({ method: 'DELETE', url: `/api/backups/${backup.id}`, headers: { authorization: `Bearer ${token}` } });
      deleteStatus = res.statusCode;
    });
    const importFrom = vi.spyOn(w.dbAdmin, 'importFrom').mockImplementation(async (src) => {
      if (!fs.existsSync(src)) throw new Error('backup disappeared after database drop');
    });
    try {
      const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
      const done = await runJob(w, job.id);
      expect(deleteStatus).toBe(409);
      expect(done.status).toBe('succeeded');
      expect(importFrom).toHaveBeenCalled();
      expect(w.deps.sites.bySlug(site.slug).status).toBe('running');
      expect(fs.existsSync(backup.path)).toBe(true);

      // Retention skips backups of a site with an in-flight job, and catches up afterwards.
      for (let i = 0; i < 3; i++) {
        await w.core.backup.create(site, 'scheduled');
        await new Promise((r) => setTimeout(r, 5));
      }
      const pending = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
      expect((await w.core.backup.prune(1)).deleted).toBe(0);
      expect(w.worker.cancel(pending.id)).toBe('canceled');
      expect((await w.core.backup.prune(1)).deleted).toBe(2);

      // And the API refuses again once the site has a queued job.
      const again = w.worker.enqueue('site.move', {}, { id: site.id, slug: site.slug, serverId: 1 });
      const res = await app.inject({ method: 'DELETE', url: `/api/backups/${backup.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain(`#${again.id}`);
    } finally {
      await app.close();
    }
  });

  it('queued cancellation releases the site reservation and flags a never-started provision', async () => {
    const w = await makeWorld();
    const { site, job } = w.deps.sites.create({ title: 'Cancel', slug: 'cancel-site', domainMode: 'dev', adminUser: 'boss', adminEmail: 'b@e.test', discourageSearchEngines: true });
    expect(w.worker.cancel(job.id)).toBe('canceled');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    // The slug is free again.
    expect(() => w.deps.sites.create({ title: 'Cancel', slug: 'cancel-site', domainMode: 'dev', adminUser: 'boss', adminEmail: 'b@e.test', discourageSearchEngines: true })).not.toThrow();

    const row = w.db
      .insert(servers)
      .values({ name: 'blank', kind: 'ssh', sshHost: 'blank.test', devDomain: 'dev.example.test', status: 'provisioning', createdAt: Date.now(), updatedAt: Date.now() })
      .returning()
      .get();
    const prov = w.worker.enqueue('server.provision', { serverId: row.id, rootUser: 'root', acmeEmail: 'a@b.test' }, undefined, { serverId: row.id });
    expect(w.worker.cancel(prov.id)).toBe('canceled');
    const fresh = w.servers.rowById(row.id)!;
    expect(fresh.status).toBe('error');
    expect(fresh.lastError).toMatch(/canceled before it started/);
  });

  it('password change revokes every other session; logout-all revokes them all', async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    try {
      const login = async (password: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
        expect(res.statusCode).toBe(200);
        const c = res.cookies.find((x) => x.name === 'panel.sid')!;
        return `${c.name}=${c.value}`;
      };
      const owner = await login('correct-horse-battery');
      const other = await login('correct-horse-battery');
      const ownerId = w.deps.users.owner()!.id;
      const changed = await app.inject({
        method: 'PUT', url: `/api/users/${ownerId}/password`, headers: { cookie: owner, 'x-csrf': '1' },
        payload: { password: 'correct-horse-battery', newPassword: 'changed-password-123' },
      });
      expect(changed.statusCode).toBe(204);
      const reissued = changed.cookies.find((x) => x.name === 'panel.sid')!;
      const ownerNow = `${reissued.name}=${reissued.value}`;

      const stolen = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: other, 'x-csrf': '1' }, payload: { name: 'old-session-key' } });
      expect(stolen.statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerNow } })).statusCode).toBe(200);

      expect((await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { cookie: ownerNow, 'x-csrf': '1' } })).statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerNow } })).statusCode).toBe(401);
      await login('changed-password-123');
    } finally {
      await app.close();
    }
  });

  it('demuxToStreams pauses the container stream while the destination is full', async () => {
    const src = new PassThrough();
    let blocked = true;
    const held: (() => void)[] = [];
    let received = 0;
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (blocked) held.push(cb);
        else cb();
      },
    });
    const stderr = new Writable({ write: (_c, _e, cb) => cb() });
    const done = demuxToStreams(src, sink, stderr);

    const payload = Buffer.alloc(64 * 1024, 1);
    const frame = Buffer.alloc(payload.length + 8);
    frame[0] = 1;
    frame.writeUInt32BE(payload.length, 4);
    payload.copy(frame, 8);
    for (let i = 0; i < 64; i++) src.write(frame);
    await new Promise((r) => setTimeout(r, 20));

    // Only what fits before the first refusal reached the sink; the rest waits in the source.
    expect(received).toBeLessThanOrEqual(2 * payload.length);
    expect(src.readableLength).toBeGreaterThan(0);

    blocked = false;
    for (const cb of held.splice(0)) cb();
    src.end();
    await done;
    expect(received).toBe(64 * payload.length);
  });

  it('docker exec deadlines are enforced inside the container via coreutils timeout', () => {
    expect(withDeadline(['wp', 'search-replace'], 2500)).toEqual(['timeout', '-k', '5', '3', 'wp', 'search-replace']);
    expect(withDeadline(['sh', '-c', 'x'], 100)).toEqual(['timeout', '-k', '5', '1', 'sh', '-c', 'x']);
  });

  it('site detail is served from the registry when the hosting server cannot be inspected', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    vi.spyOn(w.docker, 'containerState').mockRejectedValueOnce(new Error('ssh: connection refused'));
    const detail = await w.deps.sites.detail(site.slug);
    expect(detail.containerState).toBe('unknown');
    expect(detail.dbName).toBe(site.dbName);
  });
});

describe('review regressions: plugin licenses', () => {
  it('delete: Docker being unreachable at the license-release step does not leave the site stuck in "deleting"', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    // The first state lookup of the delete job is the one before the recipes' beforeRemove
    // hook; it used to escape the job outside the teardown's own error handling.
    vi.spyOn(w.docker, 'containerState').mockRejectedValueOnce(new Error('docker socket unavailable'));
    const job = await runJob(w, w.deps.sites.delete(site.slug, false).id);
    vi.restoreAllMocks();
    expect(job.status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    const messages = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all().map((l) => l.message);
    expect(messages.some((m) => m.startsWith('Could not release plugin licenses before deleting'))).toBe(true);
  });
});
