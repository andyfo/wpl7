import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { backups, jobs, siteDatabases, sites, type SiteRow } from '../../src/db/schema.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import type { AccessLevel } from '../../shared/access.js';
import type { DatabaseListDto, DbRowsPageDto, SiteDatabaseDto } from '../../shared/types.js';
import { wordpressTables } from '../dbBrowserFake.js';
import { badRequest } from '../../src/lib/errors.js';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function signedIn(opts: { exec?: ExecPort } = {}) {
  const world = await makeWorld(opts);
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const keyOf = async (access: AccessLevel) => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: `key-${access}`, access } });
    expect(res.statusCode, res.body).toBe(201);
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, world, headers, keyOf };
}

/** A hosted site with its database on server 1: in the fake MariaDB, and its tables in the fake browser. */
function addSite(w: TestWorld, slug: string, opts: { status?: string; wpConfig?: string } = {}): SiteRow {
  const now = Date.now();
  const db = `wp_${slug}`;
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: opts.status ?? 'running',
      dbName: db,
      dbUser: db,
      dbPassword: `pw-${slug}`,
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(p.wordpress, { recursive: true });
  fs.writeFileSync(
    path.join(p.wordpress, 'wp-config.php'),
    opts.wpConfig ?? "<?php\ndefine( 'DB_PASSWORD', getenv_docker('WORDPRESS_DB_PASSWORD', 'example password') );\n",
  );
  w.docker.containers.set(`wp-${slug}`, 'running');
  w.dbAdmin.databases.add(db);
  w.dbAdmin.users.set(db, `pw-${slug}`);
  w.dbAdmin.sizes.set(db, { tables: 5, bytes: 1_234_567 });
  for (const [name, table] of Object.entries(wordpressTables(`https://${slug}.test`))) w.dbBrowser.addTable(db, name, table);
  return site;
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

const jobId = (res: { json(): unknown }) => (res.json() as { job: { id: number } }).job.id;

describe("a site's databases", () => {
  it("describes the site's database, with sizes once its server has been read", async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const before = (await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers })).json() as SiteDatabaseDto;
    expect(before).toMatchObject({ name: 'wp_alpha', user: 'wp_alpha', host: 'mariadb', port: 3306, tablePrefix: 'wp_', scannedAt: null });
    expect(before.databases).toEqual([{ name: 'wp_alpha', kind: 'site', size: null, missing: false, createdAt: null }]);
    // The password is in no answer but the one that reveals it.
    const raw = await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers });
    expect(raw.body).not.toContain('pw-alpha');

    await app.inject({ method: 'POST', url: '/api/databases/scan', headers });
    const after = (await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers })).json() as SiteDatabaseDto;
    expect(after.scannedAt).not.toBeNull();
    expect(after.databases[0]!.size).toEqual({ tables: 5, bytes: 1_234_567 });
  });

  it('reveals the password only when asked, by POST', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password/reveal', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ password: 'pw-alpha' });
  });

  it("adds another database for the site's own user, and refuses names that are not free", async () => {
    const { app, headers, world } = await signedIn();
    const alpha = addSite(world, 'alpha');
    addSite(world, 'beta');
    for (const name of ['wp_extra', 'mysql', 'Bad-Name', '']) {
      const bad = await app.inject({ method: 'POST', url: '/api/sites/alpha/databases', headers, payload: { name } });
      expect(bad.statusCode, name).toBe(400);
    }
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/databases', headers, payload: { name: 'alpha_crm' } });
    expect(res.statusCode, res.body).toBe(202);
    const done = await runJob(world, jobId(res));
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(world.dbAdmin.calls).toContainEqual({ method: 'createExtraDb', args: ['alpha_crm', 'wp_alpha'] });
    const row = world.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, alpha.id)).get();
    expect(row).toMatchObject({ name: 'alpha_crm', createdBy: 'admin' });
    // The name is the panel's now: no other site gets it.
    const taken = await app.inject({ method: 'POST', url: '/api/sites/beta/databases', headers, payload: { name: 'alpha_crm' } });
    expect(taken.statusCode).toBe(409);
    // Nor one the server already has, unclaimed.
    world.dbAdmin.databases.add('leftover');
    await app.inject({ method: 'POST', url: '/api/databases/scan', headers });
    const onServer = await app.inject({ method: 'POST', url: '/api/sites/beta/databases', headers, payload: { name: 'leftover' } });
    expect(onServer.statusCode).toBe(409);

    const info = (await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers })).json() as SiteDatabaseDto;
    expect(info.databases.map((d) => [d.name, d.kind])).toEqual([
      ['wp_alpha', 'site'],
      ['alpha_crm', 'extra'],
    ]);
  });

  it("drops one of its other databases, never the site's own", async () => {
    const { app, headers, world } = await signedIn();
    const alpha = addSite(world, 'alpha');
    world.db.insert(siteDatabases).values({ siteId: alpha.id, name: 'alpha_crm', createdAt: Date.now() }).run();
    world.dbAdmin.databases.add('alpha_crm');
    const own = await app.inject({ method: 'DELETE', url: '/api/sites/alpha/databases/wp_alpha', headers });
    expect(own.statusCode).toBe(409);
    const unknown = await app.inject({ method: 'DELETE', url: '/api/sites/alpha/databases/nope', headers });
    expect(unknown.statusCode).toBe(404);
    const res = await app.inject({ method: 'DELETE', url: '/api/sites/alpha/databases/alpha_crm', headers });
    expect(res.statusCode).toBe(202);
    expect((await runJob(world, jobId(res))).status).toBe('succeeded');
    expect(world.dbAdmin.databases.has('alpha_crm')).toBe(false);
    expect(world.db.select().from(siteDatabases).all()).toEqual([]);
  });

  it('gives the user a new password and recreates the container with it', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers });
    expect(res.statusCode).toBe(202);
    const done = await runJob(world, jobId(res));
    expect(done.status, done.error ?? '').toBe('succeeded');
    const row = world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    expect(row.dbPassword).not.toBe('pw-alpha');
    expect(world.dbAdmin.users.get('wp_alpha')).toBe(row.dbPassword);
    const created = world.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!;
    expect((created.args[0] as { env: Record<string, string> }).env.WORDPRESS_DB_PASSWORD).toBe(row.dbPassword);
  });

  it('leaves the password alone when wp-config.php holds it itself', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha', { wpConfig: "<?php define('DB_PASSWORD', 'hard-coded');" });
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/wp-config\.php sets the database password itself/);
    expect(world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.dbPassword).toBe('pw-alpha');
    expect(world.dbAdmin.calls.some((c) => c.method === 'setUserPassword')).toBe(false);
  });

  it('puts the old password back when the container cannot be recreated', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    world.docker.failOn.set('createSiteContainer', 'docker said no');
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.dbPassword).toBe('pw-alpha');
    expect(world.dbAdmin.users.get('wp_alpha')).toBe('pw-alpha');
  });

  it('keeps the password MariaDB has when the old one cannot be put back', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    world.docker.failOn.set('createSiteContainer', 'docker said no');
    // The new password goes in; the connection drops before the old one can follow.
    const setPassword = world.dbAdmin.setUserPassword.bind(world.dbAdmin);
    let calls = 0;
    world.dbAdmin.setUserPassword = async (user, password) => {
      if (++calls > 1) throw new Error('connection lost');
      return setPassword(user, password);
    };
    const done = await runJob(world, jobId(await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers })));
    expect(done.status).toBe('failed');
    const row = world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    expect(row.dbPassword).not.toBe('pw-alpha');
    expect(row.dbPassword).toBe(world.dbAdmin.users.get('wp_alpha'));
  });

  it('changes nothing when MariaDB refuses the new password', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    world.dbAdmin.failOn.set('setUserPassword', 'connection refused');
    const done = await runJob(world, jobId(await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers })));
    expect(done.status).toBe('failed');
    expect(world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.dbPassword).toBe('pw-alpha');
    expect(world.docker.calls.some((c) => c.method === 'createSiteContainer')).toBe(false);
  });

  it('refuses when wp-config.php is there but cannot be read', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const wpConfig = path.join(sitePaths(world.config, 'alpha').wordpress, 'wp-config.php');
    fs.renameSync(wpConfig, `${wpConfig}.real`);
    fs.writeFileSync(`${wpConfig}.real`, "<?php define('DB_PASSWORD', 'hard-coded');");
    fs.symlinkSync(`${wpConfig}.real`, wpConfig);
    const done = await runJob(world, jobId(await app.inject({ method: 'POST', url: '/api/sites/alpha/database-password', headers })));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/wp-config\.php could not be read/);
    expect(world.dbAdmin.calls.some((c) => c.method === 'setUserPassword')).toBe(false);
  });
});

describe('the database browser', () => {
  it('lists tables and pages through rows as the site’s own user', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const tables = await app.inject({ method: 'GET', url: '/api/sites/alpha/databases/wp_alpha/tables', headers });
    expect(tables.statusCode).toBe(200);
    expect((tables.json() as { items: { name: string }[] }).items.map((t) => t.name)).toContain('wp_options');

    const filters = encodeURIComponent(JSON.stringify([{ column: 'option_name', op: 'startsWith', value: 'blog' }]));
    const page = await app.inject({
      method: 'GET',
      url: `/api/sites/alpha/databases/wp_alpha/tables/wp_options/rows?limit=10&sort=option_name&filters=${filters}`,
      headers,
    });
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json() as DbRowsPageDto;
    expect(body.rows.map((r) => r[1])).toEqual(['blogdescription', 'blogname']);
    // Every call went as the site's database user, to the database asked for.
    expect(world.dbBrowser.calls.every((c) => c.target.user === 'wp_alpha' && c.target.password === 'pw-alpha')).toBe(true);
    expect(world.dbBrowser.calls.every((c) => c.target.database === 'wp_alpha')).toBe(true);
  });

  it('filters on any column, and keeps a row that matches any one filter', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const rows = async (filters: object[], match?: string) => {
      const qs = `limit=50&sort=option_name&filters=${encodeURIComponent(JSON.stringify(filters))}${match ? `&match=${match}` : ''}`;
      const res = await app.inject({ method: 'GET', url: `/api/sites/alpha/databases/wp_alpha/tables/wp_options/rows?${qs}`, headers });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as DbRowsPageDto).rows.map((r) => r[1]);
    };
    expect(await rows([{ column: '*', op: 'contains', value: 'alpha.test' }])).toEqual(['home', 'siteurl']);
    const both = [
      { column: 'option_name', op: 'eq', value: 'blogname' },
      { column: 'option_name', op: 'in', value: 'home, siteurl' },
    ];
    expect(await rows(both)).toEqual([]);
    expect(await rows(both, 'any')).toEqual(['blogname', 'home', 'siteurl']);
    const bad = await app.inject({
      method: 'GET',
      url: `/api/sites/alpha/databases/wp_alpha/tables/wp_options/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'option_name', op: 'eq', value: 'x' }]))}&match=some`,
      headers,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses a database that is not one of the site's", async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    addSite(world, 'beta');
    const res = await app.inject({ method: 'GET', url: '/api/sites/alpha/databases/wp_beta/tables', headers });
    expect(res.statusCode).toBe(404);
    expect(world.dbBrowser.calls).toEqual([]);
  });

  it('refuses filters that are not a filter list', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    for (const filters of ['not-json', JSON.stringify([{ column: 'a', op: 'like' }])]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sites/alpha/databases/wp_alpha/tables/wp_options/rows?filters=${encodeURIComponent(filters)}`,
        headers,
      });
      expect(res.statusCode, filters).toBe(400);
    }
  });

  it('reads, changes, inserts and deletes rows by their key', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const base = '/api/sites/alpha/databases/wp_alpha/tables/wp_options';
    const row = await app.inject({ method: 'GET', url: `${base}/row?key=${encodeURIComponent('{"option_id":"3"}')}`, headers });
    expect(row.statusCode).toBe(200);
    expect((row.json() as { values: unknown[] }).values).toEqual(['3', 'blogname', 'Northwind Bakery', 'yes']);
    const patched = await app.inject({
      method: 'PATCH',
      url: `${base}/rows`,
      headers,
      payload: { key: { option_id: '3' }, values: { option_value: 'Southwind Bakery' } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(world.dbBrowser.table('wp_alpha', 'wp_options').rows[2]![2]).toBe('Southwind Bakery');
    const inserted = await app.inject({ method: 'POST', url: `${base}/rows`, headers, payload: { values: { option_name: 'x', option_value: 'y' } } });
    expect(inserted.json()).toMatchObject({ affected: 1, insertId: '13' });
    const deleted = await app.inject({ method: 'POST', url: `${base}/rows/delete`, headers, payload: { keys: [{ option_id: '13' }] } });
    expect(deleted.json()).toMatchObject({ affected: 1 });
    const gone = await app.inject({ method: 'GET', url: `${base}/row?key=${encodeURIComponent('{"option_id":"13"}')}`, headers });
    expect(gone.statusCode).toBe(404);
  });

  it('runs SQL as the site’s user', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/query',
      headers,
      payload: { sql: 'SELECT 1' },
    });
    expect(res.statusCode).toBe(200);
    expect(world.dbBrowser.calls.at(-1)).toMatchObject({ method: 'run', target: { user: 'wp_alpha', database: 'wp_alpha' }, args: ['SELECT 1'] });
  });

  it('changes nothing while a job has the site, and reads nothing of a site being made', async () => {
    const { app, headers, world } = await signedIn();
    const alpha = addSite(world, 'alpha');
    addSite(world, 'gamma', { status: 'provisioning' });
    world.worker.enqueue('site.restart', { siteId: alpha.id }, alpha);
    const busy = await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/query', headers, payload: { sql: 'SELECT 1' } });
    expect(busy.statusCode).toBe(409);
    const making = await app.inject({ method: 'GET', url: '/api/sites/gamma/databases/wp_gamma/tables', headers });
    expect(making.statusCode).toBe(409);
  });
});

describe('export and import', () => {
  it('streams a gzipped dump, from the panel only', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const res = await app.inject({ method: 'GET', url: '/api/sites/alpha/databases/wp_alpha/export', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="wp_alpha-\d{8}-\d{4}\.sql\.gz"/);
    expect(zlib.gunzipSync(res.rawPayload).toString()).toContain('-- fake dump of wp_alpha');
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/sites/alpha/databases/wp_alpha/export',
      headers: { ...headers, 'sec-fetch-site': 'same-site' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('takes an upload chunk by chunk, then imports it as the site’s user after a backup', async () => {
    // Real commands: the backup archives the site, and the job checks and measures the dump with gzip.
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    const dump = zlib.gzipSync('DROP TABLE IF EXISTS `wp_options`;\nCREATE TABLE `wp_options` (a int);\n');
    const id = 'upload-0123456789abcdef';
    const half = Math.floor(dump.length / 2);
    const put = (offset: number, body: Buffer) =>
      app.inject({
        method: 'PUT',
        url: `/api/sites/alpha/database-uploads/${id}?offset=${offset}&size=${dump.length}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: body,
      });
    expect((await put(0, dump.subarray(0, half))).json()).toEqual({ received: half, complete: false });
    // A chunk sent again, from where the upload no longer is, is told where it is.
    const again = await put(0 + 1, dump.subarray(1, half));
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { details: { received: number } } }).error.details.received).toBe(half);
    expect((await put(half, dump.subarray(half))).json()).toEqual({ received: dump.length, complete: true });
    const staged = world.core.databases.uploadPath(world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!, id);
    expect(fs.readFileSync(staged).equals(dump)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/import',
      headers,
      payload: { uploadId: id, empty: true },
    });
    expect(res.statusCode, res.body).toBe(202);
    const done = await runJob(world, jobId(res));
    expect(done.status, done.error ?? '').toBe('succeeded');
    const ops = world.dbAdmin.calls.map((c) => c.method);
    expect(ops.indexOf('dumpTo')).toBeLessThan(ops.indexOf('importFromAs'));
    expect(world.dbAdmin.calls).toContainEqual({ method: 'recreateDb', args: ['wp_alpha'] });
    expect(world.dbAdmin.calls).toContainEqual({ method: 'importFromAs', args: [staged, 'wp_alpha', 'wp_alpha', 'pw-alpha'] });
    expect(world.db.select().from(backups).all().map((b) => [b.type, b.note])).toEqual([['pre_restore', 'Before importing into wp_alpha']]);
    expect(fs.existsSync(staged)).toBe(false);
    // The site was stopped for it, its database asked whether WordPress finds itself there, and
    // only then was the site started again.
    const docker = world.docker.calls.map((c) => c.method);
    expect(docker.lastIndexOf('stopContainer')).toBeGreaterThan(-1);
    expect(docker.lastIndexOf('startContainer')).toBeGreaterThan(docker.lastIndexOf('stopContainer'));
    expect(world.dbBrowser.calls.some((c) => c.method === 'rows' && c.args[0] === 'wp_options')).toBe(true);
    expect(world.docker.containers.get('wp-alpha')).toBe('running');
  });

  /** An upload staged on the fake disk as the routes would leave it, ready for an import. */
  const staged = (world: TestWorld, sql: string | Buffer, id = 'upload-0123456789abcdef') => {
    const file = world.core.databases.uploadPath(world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(sql));
    return id;
  };
  const importInto = async (app: Awaited<ReturnType<typeof signedIn>>['app'], headers: Record<string, string>, db: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/sites/alpha/databases/${db}/import`, headers, payload });

  it('refuses a dump that would switch to another database, a binary file, and an empty-first dump without WordPress', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    const alpha = addSite(world, 'alpha');
    world.db.insert(siteDatabases).values({ siteId: alpha.id, name: 'alpha_crm', createdAt: Date.now() }).run();
    world.dbAdmin.databases.add('alpha_crm');
    const cases: [string, string | Buffer, object, RegExp][] = [
      ['alpha_crm', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `wp_alpha`;\nUSE `wp_alpha`;\nCREATE TABLE t (a int);\n', {}, /switches to the database wp_alpha \(line 1\)/],
      ['alpha_crm', Buffer.from('PK\u0003\u0004\u0000\u0000zip'), {}, /not an SQL dump/],
      ['wp_alpha', 'CREATE TABLE `wp_posts` (a int);\n', { empty: true }, /no wp_options table/],
    ];
    for (const [db, sql, extra, error] of cases) {
      const res = await importInto(app, headers, db, { uploadId: staged(world, sql), ...extra });
      expect(res.statusCode, res.body).toBe(202);
      const done = await runJob(world, jobId(res));
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(error);
    }
    // Refused before anything changed: no backup, no database touched, the site never stopped.
    expect(world.db.select().from(backups).all()).toEqual([]);
    expect(world.dbAdmin.calls.filter((c) => ['recreateDb', 'importFromAs'].includes(c.method))).toEqual([]);
    expect(world.docker.calls.some((c) => c.method === 'stopContainer')).toBe(false);
  });

  it('loads a dump that names its own database, and keeps the site running for an added one', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    const alpha = addSite(world, 'alpha');
    world.db.insert(siteDatabases).values({ siteId: alpha.id, name: 'alpha_crm', createdAt: Date.now() }).run();
    world.dbAdmin.databases.add('alpha_crm');
    const res = await importInto(app, headers, 'alpha_crm', {
      uploadId: staged(world, 'USE `alpha_crm`;\nCREATE TABLE t (a int);\n'),
      backupFirst: false,
    });
    const done = await runJob(world, jobId(res));
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(world.docker.calls.some((c) => c.method === 'stopContainer')).toBe(false);
  });

  /** Whether the site was started at any point after it was stopped for the import. */
  const startedAfterStop = (world: TestWorld) => {
    const calls = world.docker.calls.map((c) => c.method);
    return calls.lastIndexOf('startContainer') > calls.lastIndexOf('stopContainer');
  };

  it('keeps the site stopped when the imported database holds no installation, never starting it', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    // The dump's tables have another prefix: no wp_options after it.
    world.dbBrowser.dropTable('wp_alpha', 'wp_options');
    const res = await importInto(app, headers, 'wp_alpha', {
      uploadId: staged(world, 'CREATE TABLE `other_options` (a int);\n'),
      backupFirst: false,
    });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/finds no installation.*The site stays stopped.*Restore a backup/);
    expect(startedAfterStop(world)).toBe(false);
    expect(world.docker.containers.get('wp-alpha')).not.toBe('running');
  });

  it('keeps the site stopped when a failed import left no installation', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    // Emptied first, then the load failed before the options table came back.
    world.dbBrowser.dropTable('wp_alpha', 'wp_options');
    world.dbAdmin.failOn.set('importFromAs', 'ERROR 1064 (42000) at line 9: You have an error in your SQL syntax');
    const res = await importInto(app, headers, 'wp_alpha', {
      uploadId: staged(world, 'CREATE TABLE `wp_options` (a int);\n'),
      empty: true,
    });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/The import failed, and left no WordPress installation.*Restore the backup taken before the import/);
    expect(startedAfterStop(world)).toBe(false);
  });

  it('starts the site again after a failed import that left its installation alone', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    world.dbAdmin.failOn.set('importFromAs', 'ERROR 1064 (42000) at line 1: You have an error in your SQL syntax');
    const res = await importInto(app, headers, 'wp_alpha', { uploadId: staged(world, 'CREATE TABLE `wp_options` (a int);\n') });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/ERROR 1064/);
    expect(world.docker.containers.get('wp-alpha')).toBe('running');
  });

  it('asks WordPress, and stops the site again, when the database cannot be asked', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    world.dbBrowser.failOn.set('rows', Object.assign(new Error('relay down'), { statusCode: 502 }));
    world.servers.handleFor(1).wp.isInstalled = async () => false;
    const res = await importInto(app, headers, 'wp_alpha', {
      uploadId: staged(world, 'CREATE TABLE `wp_options` (a int);\n'),
      backupFirst: false,
    });
    const done = await runJob(world, jobId(res));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/finds no installation.*The site is stopped/);
    expect(world.docker.containers.get('wp-alpha')).not.toBe('running');
  });

  it('clears day-old uploads and nothing else: not the files of a site called db-uploads, not an upload an import needs', async () => {
    const { app, headers, world } = await signedIn({ exec: hostExec });
    addSite(world, 'alpha');
    addSite(world, 'db-uploads');
    const root = world.config.paths.sites;
    const dayOld = (file: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, zlib.gzipSync('SELECT 1;\n'));
      const t = Date.now() / 1000 - 2 * 86_400;
      fs.utimesSync(file, t, t);
      return file;
    };
    const wpConfig = dayOld(path.join(sitePaths(world.config, 'db-uploads').wordpress, 'wp-config.php'));
    const stale = dayOld(path.join(root, 'alpha', 'db-uploads', `upload-${'a'.repeat(16)}.sql.gz`));
    const ownStale = dayOld(path.join(root, 'db-uploads', 'db-uploads', `upload-${'b'.repeat(16)}.sql.gz`));
    const needed = dayOld(path.join(root, 'alpha', 'db-uploads', `upload-${'c'.repeat(16)}.sql.gz`));
    const fresh = path.join(root, 'alpha', 'db-uploads', `upload-${'d'.repeat(16)}.sql.gz`);
    fs.writeFileSync(fresh, 'x');
    // Queued, not run: the import still needs its upload.
    const queued = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/import',
      headers,
      payload: { uploadId: `upload-${'c'.repeat(16)}` },
    });
    expect(queued.statusCode, queued.body).toBe(202);

    expect(await world.core.databases.pruneUploads()).toBe(2);
    expect([stale, ownStale].map((f) => fs.existsSync(f))).toEqual([false, false]);
    expect([wpConfig, needed, fresh].map((f) => fs.existsSync(f))).toEqual([true, true, true]);
    // Nor can it be deleted, or written to, while the import waits.
    const del = await app.inject({ method: 'DELETE', url: `/api/sites/alpha/database-uploads/upload-${'c'.repeat(16)}`, headers });
    expect(del.statusCode).toBe(409);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/sites/alpha/database-uploads/upload-${'c'.repeat(16)}?offset=0&size=3`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    });
    expect(put.statusCode).toBe(409);
    expect(fs.existsSync(needed)).toBe(true);
  });

  it('refuses an import of an upload that is not there', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/import',
      headers,
      payload: { uploadId: 'upload-ffffffffffffffff' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('table structure', () => {
  const column = { nullable: false, default: { kind: 'none' } };

  it('previews a change as SQL, then runs it as a job, as the site’s user', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const url = '/api/sites/alpha/databases/wp_alpha/tables/wp_options/alter';
    const changes = [{ op: 'addColumn', column: { ...column, name: 'note', type: 'varchar(100)' }, position: { after: 'option_name' } }];
    const preview = await app.inject({ method: 'POST', url, headers, payload: { changes, preview: true } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({ statements: ['ALTER TABLE `wp_options` ADD COLUMN `note` varchar(100) NOT NULL AFTER `option_name`'] });
    expect(world.dbBrowser.executed).toEqual([]);

    const res = await app.inject({ method: 'POST', url, headers, payload: { changes } });
    expect(res.statusCode, res.body).toBe(202);
    const done = await runJob(world, jobId(res));
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(world.dbBrowser.executed).toEqual(['ALTER TABLE `wp_options` ADD COLUMN `note` varchar(100) NOT NULL AFTER `option_name`']);
    const call = world.dbBrowser.calls.find((c) => c.method === 'execute')!;
    expect(call.target).toEqual({ database: 'wp_alpha', user: 'wp_alpha', password: 'pw-alpha' });
    expect(call.args[1]).toMatchObject({ lockWaitSeconds: 10 });
    expect(JSON.parse(done.payload).summary).toBe('Add column note to wp_options');
  });

  it('creates, empties and drops tables', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const create = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/tables',
      headers,
      payload: { name: 'shop_orders', columns: [{ ...column, name: 'id', type: 'bigint unsigned', autoIncrement: true }], primaryKey: ['id'] },
    });
    expect(create.statusCode, create.body).toBe(202);
    expect((await runJob(world, jobId(create))).status).toBe('succeeded');
    const empty = await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/tables/wp_posts/truncate', headers });
    expect((await runJob(world, jobId(empty))).status).toBe('succeeded');
    const drop = await app.inject({ method: 'DELETE', url: '/api/sites/alpha/databases/wp_alpha/tables/wp_posts?preview=true', headers });
    expect(drop.json()).toEqual({ statements: ['DROP TABLE `wp_posts`'] });
    expect(world.dbBrowser.executed).toEqual([
      'CREATE TABLE `shop_orders` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB',
      'TRUNCATE TABLE `wp_posts`',
    ]);
  });

  it('says what is wrong before queuing anything', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const url = '/api/sites/alpha/databases/wp_alpha/tables/wp_options/alter';
    const bad = await app.inject({ method: 'POST', url, headers, payload: { changes: [{ op: 'dropColumn', name: 'nope' }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/no column "nope"/);
    const type = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { changes: [{ op: 'addColumn', column: { ...column, name: 'x', type: 'int) ; DROP TABLE wp_users; --' }, position: null }] },
    });
    expect(type.statusCode).toBe(400);
    const missing = await app.inject({ method: 'DELETE', url: '/api/sites/alpha/databases/wp_alpha/tables/nope', headers });
    expect(missing.statusCode).toBe(404);
    expect(world.db.select().from(jobs).all().filter((j) => j.type === 'database.alter')).toEqual([]);
  });

  it('tries a change on an empty copy of the table first, and takes no name that is taken', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    const url = '/api/sites/alpha/databases/wp_alpha/tables/wp_options/alter';
    const changes = [{ op: 'addColumn', column: { ...column, name: 'n', type: 'int', default: { kind: 'value', value: 'abc' } }, position: null }];
    world.dbBrowser.tryAnswer = () => {
      throw badRequest("MariaDB would refuse this: Invalid default value for 'n'");
    };
    for (const preview of [true, false]) {
      const refused = await app.inject({ method: 'POST', url, headers, payload: { changes, preview } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toBe("MariaDB would refuse this: Invalid default value for 'n'");
    }
    expect(world.dbBrowser.calls.filter((c) => c.method === 'tryDdl').at(-1)!.args).toEqual([
      'wp_options',
      "ALTER TABLE `wpl7_try_fake` ADD COLUMN `n` int NOT NULL DEFAULT 'abc'",
    ]);
    // A temporary table takes no foreign key: a change of nothing else is not tried.
    world.dbBrowser.calls = [];
    const fk = { op: 'addForeignKey', foreignKey: { columns: ['option_id'], refTable: 'wp_posts', refColumns: ['ID'] } };
    expect((await app.inject({ method: 'POST', url, headers, payload: { changes: [fk], preview: true } })).statusCode).toBe(200);
    expect(world.dbBrowser.calls.filter((c) => c.method === 'tryDdl')).toEqual([]);
    world.dbBrowser.tryAnswer = () => true;

    const rename = await app.inject({ method: 'POST', url, headers, payload: { changes: [{ op: 'rename', name: 'wp_posts' }], preview: true } });
    expect(rename.statusCode).toBe(400);
    expect(rename.json().error.message).toMatch(/called "wp_posts" already/);
    const create = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/databases/wp_alpha/tables',
      headers,
      payload: { name: 'wp_posts', columns: [{ ...column, name: 'id', type: 'int' }], primaryKey: [], preview: true },
    });
    expect(create.statusCode).toBe(400);
    // What would not fit a job is refused here, not when the job starts.
    const long = Array.from({ length: 4 }, (_, i) => ({
      op: 'addColumn',
      column: { ...column, name: `c${i}`, type: 'text', default: { kind: 'value', value: 'x'.repeat(60_000) } },
      position: null,
    }));
    const tooLong = await app.inject({ method: 'POST', url, headers, payload: { changes: long } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toMatch(/at most 200,000/);
    expect(world.db.select().from(jobs).all().filter((j) => j.type === 'database.alter')).toEqual([]);
  });
});

describe('every database', () => {
  it('lists each server’s databases with who they belong to, and what is missing', async () => {
    const { app, headers, world } = await signedIn();
    const alpha = addSite(world, 'alpha');
    addSite(world, 'beta');
    world.db.insert(siteDatabases).values({ siteId: alpha.id, name: 'alpha_crm', createdAt: Date.now() }).run();
    world.dbAdmin.databases.add('alpha_crm');
    world.dbAdmin.databases.add('old_shop');
    world.dbAdmin.databases.delete('wp_beta');
    const list = (await app.inject({ method: 'POST', url: '/api/databases/scan', headers })).json() as DatabaseListDto;
    const byName = new Map(list.databases.map((d) => [d.name, d]));
    expect(byName.get('wp_alpha')!.use).toMatchObject({ kind: 'site', slug: 'alpha' });
    expect(byName.get('alpha_crm')!.use).toMatchObject({ kind: 'extra', slug: 'alpha' });
    expect(byName.get('old_shop')!.use).toEqual({ kind: 'unused' });
    expect(byName.get('wp_beta')).toMatchObject({ missing: true, size: null, use: { kind: 'site', slug: 'beta' } });
    expect(list.servers[0]).toMatchObject({ id: 1, error: null });
    expect(list.servers[0]!.scannedAt).not.toBeNull();
  });

  it('records why a server could not be read', async () => {
    const { app, headers, world } = await signedIn();
    world.dbAdmin.failOn.set('inventory', 'MariaDB is down');
    const list = (await app.inject({ method: 'POST', url: '/api/databases/scan', headers })).json() as DatabaseListDto;
    expect(list.servers[0]).toMatchObject({ scannedAt: null, error: 'MariaDB is down' });
  });

  it('drops a database no site uses, and only such a one', async () => {
    const { app, headers, world } = await signedIn();
    addSite(world, 'alpha');
    world.dbAdmin.databases.add('old_shop');
    world.dbAdmin.databases.add('wp_gone');
    world.dbAdmin.users.set('wp_gone', 'pw');
    await app.inject({ method: 'POST', url: '/api/databases/scan', headers });
    expect((await app.inject({ method: 'DELETE', url: '/api/databases/1/wp_alpha', headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/databases/1/never_seen', headers })).statusCode).toBe(404);
    const res = await app.inject({ method: 'DELETE', url: '/api/databases/1/wp_gone', headers });
    expect(res.statusCode).toBe(202);
    expect((await runJob(world, jobId(res))).status).toBe('succeeded');
    expect(world.dbAdmin.databases.has('wp_gone')).toBe(false);
    // Its user, which no site has, went with it.
    expect(world.dbAdmin.users.has('wp_gone')).toBe(false);
    expect(world.dbAdmin.databases.has('old_shop')).toBe(true);
  });

  it('keeps rows, dumps and the unused list to the levels that may have them', async () => {
    const { app, world, keyOf } = await signedIn();
    addSite(world, 'alpha');
    world.dbAdmin.databases.add('old_shop');
    const read = await keyOf('read');
    const manage = await keyOf('manage');
    expect((await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers: read })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sites/alpha/databases/wp_alpha/tables', headers: read })).statusCode).toBe(200);
    const rows = '/api/sites/alpha/databases/wp_alpha/tables/wp_options/rows';
    expect((await app.inject({ method: 'GET', url: rows, headers: read })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: rows, headers: manage })).statusCode).toBe(200);
    const reveal = '/api/sites/alpha/database-password/reveal';
    expect((await app.inject({ method: 'POST', url: reveal, headers: read })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: reveal, headers: manage })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/databases/scan', headers: manage });
    expect((await app.inject({ method: 'DELETE', url: '/api/databases/1/old_shop', headers: manage })).statusCode).toBe(403);
  });
});
