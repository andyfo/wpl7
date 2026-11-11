/**
 * A PHP site's database is optional: one without has '' in its three columns, and every path that
 * reaches a site's own database - backups, restore, move, delete, the Database tab - asks first,
 * because the database tools refuse an empty name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobLogs, jobs, moveCleanups, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');

/** A PHP site with files on disk, as one that has been running a while. */
function phpSite(w: TestWorld, slug: string, opts: { database?: boolean } = {}): SiteRow {
  const site = addPhpSite(w, slug, opts);
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(p.wordpress, { recursive: true });
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php echo "app";');
  fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  if (opts.database) {
    w.dbAdmin.databases.add(site.dbName);
    w.dbAdmin.users.set(site.dbUser, site.dbPassword);
  }
  return site;
}

const restore = (w: TestWorld, site: SiteRow, backupId: number) =>
  w.worker.enqueue('backup.restore', { backupId, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });

const row = (w: TestWorld, id: number) => w.db.select().from(sites).where(eq(sites.id, id)).get()!;

describe('a backup of a PHP site', () => {
  it('without a database: its files, and no dump in it, the checksums or the manifest', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'plain');
    const backup = await w.core.backup.create(site, 'manual');
    expect(backup.hasDatabase).toBe(0);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dumpTo')).toEqual([]);
    expect(fs.existsSync(path.join(backup.path, 'db.sql.gz'))).toBe(false);
    expect(fs.readFileSync(path.join(backup.path, 'sha256sums'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/)[1])).toEqual(['files.tar.gz']);
    await expect(w.core.backup.verifyChecksums(backup)).resolves.toBeUndefined();
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8'));
    expect([manifest.app, manifest.database, manifest.webRoot, manifest.wpVersion]).toEqual(['php', false, '', null]);
  });

  it('with one: the dump as for any site, and the download offers it only then', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const withDb = await w.core.backup.create(site, 'manual');
    expect(withDb.hasDatabase).toBe(1);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dumpTo').map((c) => c.args[0])).toEqual(['wp_shop']);
    const without = await w.core.backup.create(phpSite(w, 'plain'), 'manual');

    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
    const refused = await app.inject({ method: 'GET', url: `/api/backups/${without.id}/download?part=database`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('This backup has no database: its site had none.');
    expect((await app.inject({ method: 'GET', url: `/api/backups/${without.id}/download?part=files`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/backups/${withDb.id}/download?part=database`, headers })).statusCode).toBe(200);
  });
});

describe('restoring a PHP site', () => {
  it('a backup with a database, into a site that has one: as for any site', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const backup = await w.core.backup.create(site, 'manual');
    const done = await runJob(w, restore(w, site, backup.id).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.dbAdmin.calls.filter((c) => c.method === 'recreateDb' || c.method === 'importFrom').map((c) => `${c.method} ${c.args.at(-1)}`)).toEqual([
      'recreateDb wp_shop',
      'importFrom wp_shop',
    ]);
    // No WordPress steps: no URL rewrite, no table prefix.
    expect(w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[])[0])).not.toContain('wp');
  });

  it('a backup with a database, into a site that has none now: the database is made first, then filled', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const backup = await w.core.backup.create(site, 'manual');
    // The slug's site was deleted and made again, without a database.
    w.db.update(sites).set({ dbName: '', dbUser: '', dbPassword: '' }).where(eq(sites.id, site.id)).run();
    w.dbAdmin.databases.delete('wp_shop');
    w.dbAdmin.users.delete('wp_shop');

    const done = await runJob(w, restore(w, site, backup.id).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const after = row(w, site.id);
    expect([after.dbName, after.dbUser]).toEqual(['wp_shop', 'wp_shop']);
    expect(after.dbPassword).not.toBe('');
    expect(w.dbAdmin.users.get('wp_shop')).toBe(after.dbPassword);
    const calls = w.dbAdmin.calls.map((c) => `${c.method} ${c.args[0]}`);
    expect(calls.indexOf('createSiteDb wp_shop')).toBeGreaterThan(-1);
    expect(calls.indexOf('createSiteDb wp_shop')).toBeLessThan(calls.lastIndexOf('recreateDb wp_shop'));
    expect(w.dbAdmin.calls.filter((c) => c.method === 'importFrom').map((c) => c.args[1])).toEqual(['wp_shop']);
  });

  it('a backup without a database, into a site that has one: the database is left as it is, and the log says so', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop');
    const backup = await w.core.backup.create(site, 'manual');
    w.db.update(sites).set({ dbName: 'wp_shop', dbUser: 'wp_shop', dbPassword: 'pw' }).where(eq(sites.id, site.id)).run();
    w.dbAdmin.databases.add('wp_shop');

    const job = restore(w, row(w, site.id), backup.id);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.dbAdmin.calls.filter((c) => ['recreateDb', 'importFrom', 'dropSiteDb'].includes(c.method))).toEqual([]);
    expect(logOf(w, job.id)).toContain('The backup has no database: wp_shop is left as it is.');
  });

  it("a backup of the other app is refused before anything changes, by the API and by the job", async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const backup = await w.core.backup.create(site, 'manual');
    // A WordPress site took the slug since.
    w.db.update(sites).set({ app: 'wordpress' }).where(eq(sites.id, site.id)).run();

    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const res = await app.inject({ method: 'POST', url: `/api/backups/${backup.id}/restore`, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' }, payload: { skipPreRestoreBackup: true } });
    expect(res.statusCode).toBe(409);
    const message = 'This is a backup of a PHP site, and "shop" is a WordPress site: it can\'t be restored into it. Nothing was changed.';
    expect(res.json().error.message).toBe(message);

    const before = w.dbAdmin.calls.length;
    const done = await runJob(w, restore(w, site, backup.id).id);
    expect([done.status, done.error]).toEqual(['failed', message]);
    expect(w.dbAdmin.calls.slice(before)).toEqual([]);
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer')).toEqual([]);
    expect(row(w, site.id).status).toBe('running');
  });

  it('a backup from before PHP sites is a WordPress site’s', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const backup = await w.core.backup.create(site, 'manual');
    const file = path.join(backup.path, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete manifest.app;
    fs.writeFileSync(file, JSON.stringify(manifest));
    const done = await runJob(w, restore(w, site, backup.id).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^This is a backup of a WordPress site, and "shop" is a PHP site/);
  });
});

describe('moving and deleting a PHP site', () => {
  it('without a database: nothing database on either server, no wp-config.php asked for, and a live site is stopped while it moves', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'plain');
    w.db.update(sites).set({ isLive: 1 }).where(eq(sites.id, site.id)).run();
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    expect(JSON.parse(job.payload).quiesce).toBe('stop');
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(s2.dbAdmin.calls.filter((c) => c.method !== 'inventory')).toEqual([]);
    expect(row(w, site.id).serverId).toBe(s2.id);

    const cleanup = w.db.select().from(moveCleanups).get()!;
    expect(cleanup.dbName).toBe('');
    const fin = w.worker.enqueue('site.moveFinalize', { cleanupId: cleanup.id }, { id: site.id, slug: site.slug, serverId: 1 }, { serverId: 1 });
    expect((await runJob(w, fin.id)).status).toBe('succeeded');
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dropSiteDb')).toEqual([]);
  });

  it('with one: it goes along', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: s2.id }).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(s2.dbAdmin.calls.map((c) => `${c.method} ${c.args[0]}`)).toEqual(expect.arrayContaining(['dropSiteDb wp_shop', 'createSiteDb wp_shop', 'importFrom ' + s2.dbAdmin.calls.find((c) => c.method === 'importFrom')!.args[0]]));
  });

  it('maintenance mode is refused as a freeze, and an image from before PHP sites on the target stops it before anything changes', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'plain');
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    expect(() => w.deps.sites.move(site.slug, { targetServerId: s2.id, quiesce: 'maintenance' })).toThrowError(
      '"plain" is a PHP site, which has no maintenance mode: stop it while it moves, or keep serving.',
    );
    s2.docker.appsOf('wpl7-wordpress:php8.3', ['wordpress']);
    s2.docker.images.add('wpl7-wordpress:php8.3');
    await expect(w.deps.sites.assertPhpImageOn(site, s2.id)).rejects.toThrowError('The site image on "s2" is from before PHP sites. Update the server, then try again.');
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: s2.id }).id);
    expect([done.status, done.error]).toEqual(['failed', 'The site image on "s2" is from before PHP sites. Update the server, then try again.']);
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer')).toEqual([]);
    expect(row(w, site.id).serverId).toBe(1);
  });

  it('delete: no database to drop, and no licences to release', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'plain');
    const done = await runJob(w, w.deps.sites.delete(site.slug, false).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dropSiteDb')).toEqual([]);
    expect(w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[])[0])).not.toContain('wp');
    expect(w.db.select().from(sites).all()).toEqual([]);
  });
});

describe("a PHP site's Database tab", () => {
  async function authed(w: TestWorld) {
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
  }

  it('without a database: says so, refuses everything that needs one, and makes it on request', async () => {
    const w = await makeWorld();
    const site = phpSite(w, 'plain');
    const { app, headers } = await authed(w);

    const info = await app.inject({ method: 'GET', url: '/api/sites/plain/databases', headers });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ name: null, user: null, databases: [] });
    const detail = await app.inject({ method: 'GET', url: '/api/sites/plain', headers });
    expect(detail.json()).toMatchObject({ app: 'php', hasDatabase: false, dbName: '', webRoot: '', webRootMissing: false });

    for (const [method, url, payload] of [
      ['POST', '/api/sites/plain/database-password/reveal', undefined],
      ['POST', '/api/sites/plain/database-password', undefined],
      ['GET', '/api/sites/plain/databases/wp_plain/tables', undefined],
      ['GET', '/api/sites/plain/databases/wp_plain/export', undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect([url, res.statusCode, res.json().error.message]).toEqual([url, 409, '"plain" has no database.']);
    }
    const extra = await app.inject({ method: 'POST', url: '/api/sites/plain/databases', headers, payload: { name: 'plain_crm' } });
    expect([extra.statusCode, extra.json().error.message]).toEqual([409, '"plain" has no database of its own yet. Create it first: the others share its user.']);

    const create = await app.inject({ method: 'POST', url: '/api/sites/plain/database', headers });
    expect(create.statusCode).toBe(202);
    const done = await runJob(w, create.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const after = row(w, site.id);
    expect([after.dbName, after.dbUser]).toEqual(['wp_plain', 'wp_plain']);
    expect(w.dbAdmin.calls.find((c) => c.method === 'createSiteDb')!.args).toEqual(['wp_plain', 'wp_plain', after.dbPassword]);
    // Nothing in the container holds the login: no new container.
    expect(w.docker.calls.filter((c) => c.method === 'createSiteContainer')).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/sites/plain/databases', headers })).json()).toMatchObject({ name: 'wp_plain', user: 'wp_plain' });
    const again = await app.inject({ method: 'POST', url: '/api/sites/plain/database', headers });
    expect([again.statusCode, again.json().error.message]).toEqual([409, '"plain" has a database already: wp_plain']);
  });

  it('a database or user of that name already on the server is neither adopted nor dropped', async () => {
    const w = await makeWorld();
    const site = phpSite(w, 'plain');
    w.dbAdmin.databases.add('wp_plain');
    const job = w.worker.enqueue('database.create', { siteId: site.id, own: true }, site);
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toBe('"local" already has a database or a user called wp_plain. Delete it under Databases if no site needs it, then try again.');
    expect(w.dbAdmin.databases.has('wp_plain')).toBe(true);
    expect(row(w, site.id).dbName).toBe('');
  });

  it('a new password reaches MariaDB and the panel, and no container is made for it', async () => {
    const w = await makeWorld();
    const site = phpSite(w, 'shop', { database: true });
    const job = w.worker.enqueue('database.password', { siteId: site.id }, site);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const after = row(w, site.id);
    expect(after.dbPassword).not.toBe(site.dbPassword);
    expect(w.dbAdmin.users.get('wp_shop')).toBe(after.dbPassword);
    expect(w.docker.calls.filter((c) => c.method === 'createSiteContainer' || c.method === 'removeContainer')).toEqual([]);
    expect(logOf(w, job.id)).toContain("The site's own config still has the old one: put the new one there, or the site loses its database.");
  });

  it('an import into its own database needs no WordPress tables, and the site starts again', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = phpSite(w, 'shop', { database: true });
    const upload = 'a'.repeat(32);
    const file = w.core.databases.uploadPath(site, upload);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const zlib = await import('node:zlib');
    fs.writeFileSync(file, zlib.gzipSync('CREATE TABLE `orders` (id int);\nINSERT INTO `orders` VALUES (1);\n'));
    const job = w.worker.enqueue('database.import', { siteId: site.id, database: 'wp_shop', uploadId: upload, empty: true, backupFirst: false }, site);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer')).toHaveLength(1);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
  });
});

describe('the database inventory', () => {
  it('claims no database for a PHP site that has none', async () => {
    const w = await makeWorld();
    phpSite(w, 'plain');
    phpSite(w, 'shop', { database: true });
    w.dbAdmin.databases.add('stray');
    await w.core.databases.scanAll();
    const uses = Object.fromEntries(w.core.databases.list().databases.map((d) => [d.name, d.use.kind]));
    expect(uses).toMatchObject({ wp_shop: 'site' });
    expect(Object.keys(uses)).not.toContain('');
  });
});
