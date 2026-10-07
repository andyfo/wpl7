import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apiEvents, imports, sites } from '../../src/db/schema.js';
import { ImportService } from '../../src/services/imports.js';
import { zipEntries } from '../../src/lib/pluginZip.js';
import { PANEL_VERSION } from '../../src/lib/version.js';
import type { ImportDto, ImportSummaryDto, MigrateStatusDto, SiteDetail } from '../../shared/types.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';
import { sampleReport } from '../importFixtures.js';

/** A stand-in for panel/migrate-plugin: the files the zip is built from. */
function stubPlugin(world: TestWorld): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-migrate-src-'));
  const dir = path.join(root, 'wpl7-migrate');
  fs.mkdirSync(path.join(dir, 'includes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'wpl7-migrate.php'),
    "<?php\n/*\n * Plugin Name: WPL7 Migrate\n * Version: 0.0.0-dev\n */\ndefine( 'WPL7_MIGRATE_VERSION', '0.0.0-dev' );\n",
  );
  fs.writeFileSync(path.join(dir, 'includes', 'class-wpl7-migrate-server.php'), '<?php // server\n');
  // One left over from testing by hand: never shipped.
  fs.writeFileSync(path.join(dir, 'connection.php'), "<?php return array('token' => 'stale');\n");
  (world.config as { migratePluginDir: string }).migratePluginDir = root;
  return root;
}

async function authedApp() {
  const world = await makeWorld();
  stubPlugin(world);
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
  const create = async (body: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/api/imports', headers, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as ImportDto;
    const token = world.db.select().from(imports).where(eq(imports.id, dto.id)).get()!.token!;
    return { dto, token };
  };
  const connect = (token: string, report: Record<string, unknown> = sampleReport()) =>
    app.inject({ method: 'POST', url: '/api/migrate/connect', headers: { 'x-wpl7-import-token': token }, payload: report });
  return { app, world, headers, keyOf, create, connect };
}

describe('site imports API', () => {
  it('creates an import that waits for the old site, and never shows its token', async () => {
    const { app, headers, create } = await authedApp();
    const { dto, token } = await create({ sourceUrl: 'https://willow-pediatrics.example' });
    expect(dto).toMatchObject({ status: 'pending', source: 'https://willow-pediatrics.example', canDownload: true, connected: true });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(dto)).not.toContain(token);
    const list = await app.inject({ method: 'GET', url: '/api/imports', headers });
    expect((list.json() as { items: ImportSummaryDto[] }).items.map((i) => i.id)).toEqual([dto.id]);
    expect(list.body).not.toContain(token);
  });

  it('refuses to start one in production without PANEL_DOMAIN', async () => {
    const world = await makeWorld();
    const service = new ImportService(world.db, { ...world.config, nodeEnv: 'production', panelDomain: '' }, world.core.settings, world.servers, world.core.log);
    expect(() => service.create({ allowHttp: false }, 'admin')).toThrow(/PANEL_DOMAIN/);
  });

  it('hands out the plugin with its version and this import’s connection file', async () => {
    const { app, world, headers, create } = await authedApp();
    const { dto, token } = await create();
    const res = await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/plugin`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(`filename="wpl7-migrate-${dto.id}.zip"`);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-dl-')), 'plugin.zip');
    fs.writeFileSync(file, res.rawPayload);
    expect(zipEntries(file)!.map((e) => e.name)).toEqual([
      'wpl7-migrate/',
      'wpl7-migrate/includes/',
      'wpl7-migrate/includes/class-wpl7-migrate-server.php',
      'wpl7-migrate/wpl7-migrate.php',
      'wpl7-migrate/connection.php',
    ]);
    const unzip = (name: string) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
    const main = unzip('wpl7-migrate/wpl7-migrate.php');
    expect(main).toContain(`Version: ${PANEL_VERSION}`);
    expect(main).toContain(`define( 'WPL7_MIGRATE_VERSION', '${PANEL_VERSION}' );`);
    expect(main).not.toContain('0.0.0-dev');
    const connection = unzip('wpl7-migrate/connection.php');
    expect(connection).toContain("defined('ABSPATH') || exit;");
    expect(connection).toContain(`'panel' => 'http://panel.example.test'`);
    expect(connection).toContain(`'import' => ${dto.id}`);
    expect(connection).toContain(`'token' => '${token}'`);
    expect(connection).not.toContain('stale');
    expect(world.db.select().from(apiEvents).all()).toHaveLength(0);
  });

  it('builds the zip from the plugin this panel ships, with only its version and connection file changed', async () => {
    const world = await makeWorld();
    const { app } = await makeApp(world);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
    const created = await app.inject({ method: 'POST', url: '/api/imports', headers, payload: {} });
    const dto = created.json() as ImportDto;
    const res = await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/plugin`, headers });
    expect(res.statusCode).toBe(200);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-dl-')), 'plugin.zip');
    fs.writeFileSync(file, res.rawPayload);
    const names = zipEntries(file)!.map((e) => e.name);

    const root = path.join(world.config.migratePluginDir, 'wpl7-migrate');
    const shipped: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) walk(path.join(dir, item.name), `${rel}${item.name}/`);
        else if (item.name !== 'connection.php') shipped.push(`${rel}${item.name}`);
      }
    };
    walk(root, '');
    expect(shipped).toContain('wpl7-migrate.php');
    for (const rel of shipped) {
      const inZip = execFileSync('unzip', ['-p', file, `wpl7-migrate/${rel}`]);
      const onDisk = fs.readFileSync(path.join(root, rel));
      if (rel === 'wpl7-migrate.php') {
        expect(inZip.toString('utf8')).toBe(onDisk.toString('utf8').replaceAll('0.0.0-dev', PANEL_VERSION));
        expect(onDisk.toString('utf8').split('0.0.0-dev')).toHaveLength(3);
      } else {
        expect(inZip.equals(onDisk), rel).toBe(true);
      }
    }
    expect(names).toContain('wpl7-migrate/connection.php');
    expect(names.filter((n) => !n.endsWith('/')).sort()).toEqual([...shipped.map((r) => `wpl7-migrate/${r}`), 'wpl7-migrate/connection.php'].sort());
  });

  it('gives the panel address and the code for the plugin’s own form while the import waits', async () => {
    const { app, headers, create } = await authedApp();
    const { dto, token } = await create();
    const res = await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/code`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ panel: 'http://panel.example.test', code: token });
    await app.inject({ method: 'POST', url: `/api/imports/${dto.id}/disconnect`, headers });
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/code`, headers })).statusCode).toBe(409);
  });

  it('connects the old site with its token, and shows what it reported', async () => {
    const { app, headers, create, connect } = await authedApp();
    const { dto, token } = await create();
    const res = await connect(token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, import: { id: dto.id, status: 'connected' }, panel_version: PANEL_VERSION });

    const detail = (await app.inject({ method: 'GET', url: `/api/imports/${dto.id}`, headers })).json() as ImportDto;
    expect(detail.status).toBe('connected');
    expect(detail.source).toBe('https://willow-pediatrics.example');
    expect(detail.report).toMatchObject({ tablePrefix: 'wpx_', wpVersion: '7.1.2', searchEnginesAllowed: true });
    expect(detail.suggestions).toMatchObject({ slug: 'willow-pediatrics', phpVersion: '8.2', deactivatePlugins: ['redis-cache'] });
    expect(detail.constants.map((c) => [c.name, c.ticked])).toEqual([
      ['WP_MEMORY_LIMIT', true],
      ['WP_POST_REVISIONS', true],
      ['DISALLOW_FILE_MODS', false],
    ]);
    expect(detail.blockedReason).toBeNull();

    // The same site again is fine: the plugin's "Check again".
    expect((await connect(token)).statusCode).toBe(200);
    // Another site with the same token is not.
    const other = await connect(token, sampleReport({ home: 'https://other.example', siteurl: 'https://other.example', endpoint: 'https://other.example/wp-json/wpl7-migrate/v1/' }));
    expect(other.statusCode).toBe(409);
    expect(other.json().error.message).toContain('willow-pediatrics.example');
  });

  it('turns away a wrong token, and a key in place of one', async () => {
    const { app, world, create, connect, keyOf } = await authedApp();
    const { token } = await create();
    expect((await connect('x'.repeat(43))).statusCode).toBe(401);
    expect((await connect(token)).statusCode).toBe(200);
    // The plugin's calls are no API key's: nothing of them goes into the activity log.
    expect(world.db.select().from(apiEvents).all()).toHaveLength(0);
    // An API key is no import token: the route never looks at Authorization.
    const bearer = await keyOf('full');
    const res = await app.inject({ method: 'POST', url: '/api/migrate/connect', headers: bearer, payload: sampleReport() });
    expect(res.statusCode).toBe(401);
  });

  it('refuses what the panel cannot import from, in words the plugin shows', async () => {
    const { create, connect } = await authedApp();
    const { token } = await create();
    const old = await connect(token, sampleReport({ protocol: 2 }));
    expect(old.statusCode).toBe(426);
    expect(old.json().error).toMatchObject({ code: 'protocol_unsupported', details: { min: 1, max: 1 } });
    const broken = await connect(token, sampleReport({ multisite: 'yes' }));
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.code).toBe('invalid_report');
    const plain = await connect(token, sampleReport({ home: 'http://willow-pediatrics.example', siteurl: 'http://willow-pediatrics.example', endpoint: 'http://willow-pediatrics.example/wp-json/wpl7-migrate/v1/' }));
    expect(plain.statusCode).toBe(422);
    expect(plain.json().error.message).toMatch(/no HTTPS/);
    const elsewhere = await connect(token, sampleReport({ endpoint: 'https://attacker.example/wp-json/wpl7-migrate/v1/' }));
    expect(elsewhere.statusCode).toBe(422);
  });

  it('takes plain http when the import allows it', async () => {
    const { create, connect } = await authedApp();
    const { token } = await create({ allowHttp: true });
    const res = await connect(token, sampleReport({ home: 'http://willow-pediatrics.example', siteurl: 'http://willow-pediatrics.example', endpoint: 'http://willow-pediatrics.example/?rest_route=/wpl7-migrate/v1/' }));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('tells the plugin where the import stands', async () => {
    const { app, create, connect } = await authedApp();
    const { token } = await create();
    await connect(token);
    const res = await app.inject({ method: 'GET', url: '/api/migrate/status', headers: { 'x-wpl7-import-token': token } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json() as MigrateStatusDto).toEqual({
      status: 'connected',
      phase: null,
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      tablesDone: 0,
      tablesTotal: 0,
    });
  });

  it('cannot start an import in this version', async () => {
    const { app, headers, create, connect } = await authedApp();
    const { dto, token } = await create();
    await connect(token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/imports/${dto.id}/run`,
      headers,
      payload: { title: 'Willow Pediatrics', slug: 'willow-pediatrics' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Available in the next version');
  });

  it("keeps the old site's settings from a Read only key", async () => {
    const { app, create, keyOf } = await authedApp();
    const { dto } = await create();
    const read = await keyOf('read');
    expect((await app.inject({ method: 'GET', url: '/api/imports', headers: read })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}`, headers: read })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/plugin`, headers: read })).statusCode).toBe(403);
    const manage = await keyOf('manage');
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}`, headers: manage })).statusCode).toBe(200);
  });

  it('expires an import the old site never connected to', async () => {
    const { app, world, headers, create, connect } = await authedApp();
    const { dto, token } = await create();
    world.db.update(imports).set({ expiresAt: Date.now() - 1 }).where(eq(imports.id, dto.id)).run();
    const gone = await connect(token);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe('gone');
    const detail = (await app.inject({ method: 'GET', url: `/api/imports/${dto.id}`, headers })).json() as ImportDto;
    expect(detail).toMatchObject({ status: 'expired', connected: false, canDownload: false });
    expect(world.db.select().from(imports).where(eq(imports.id, dto.id)).get()!.token).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}/plugin`, headers })).statusCode).toBe(409);
  });

  it("disconnects: the token goes, and the site page says so", async () => {
    const { app, world, headers, create, connect } = await authedApp();
    const { dto, token } = await create();
    await connect(token);
    const now = Date.now();
    const site = world.db
      .insert(sites)
      .values({
        slug: 'willow-pediatrics',
        title: 'Willow Pediatrics',
        domains: JSON.stringify(['willow-pediatrics.dev.example.test']),
        phpVersion: '8.3',
        status: 'running',
        dbName: 'wp_willow_pediatrics',
        dbUser: 'wp_willow_pediatrics',
        dbPassword: 'x',
        containerName: 'wp-willow-pediatrics',
        tablePrefix: 'wpx_',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    world.db.update(imports).set({ status: 'done', siteId: site.id, importedAt: now }).where(eq(imports.id, dto.id)).run();
    const before = (await app.inject({ method: 'GET', url: '/api/sites/willow-pediatrics', headers })).json() as SiteDetail;
    expect(before.importSource).toMatchObject({ importId: dto.id, url: 'https://willow-pediatrics.example', status: 'done', connected: true });

    const res = await app.inject({ method: 'POST', url: `/api/imports/${dto.id}/disconnect`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ImportDto).connected).toBe(false);
    expect((await connect(token)).statusCode).toBe(401);
    const after = (await app.inject({ method: 'GET', url: '/api/sites/willow-pediatrics', headers })).json() as SiteDetail;
    expect(after.importSource!.connected).toBe(false);
  });

  it('keeps a site that is being imported from being deleted', async () => {
    const { app, world, headers, create } = await authedApp();
    const { dto } = await create();
    const now = Date.now();
    const site = world.db
      .insert(sites)
      .values({
        slug: 'half-there',
        title: 'Half there',
        domains: JSON.stringify(['half-there.dev.example.test']),
        phpVersion: '8.3',
        status: 'provisioning',
        dbName: 'wp_half_there',
        dbUser: 'wp_half_there',
        dbPassword: 'x',
        containerName: 'wp-half-there',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    world.db.update(imports).set({ status: 'failed', siteId: site.id }).where(eq(imports.id, dto.id)).run();
    const res = await app.inject({ method: 'DELETE', url: '/api/sites/half-there', headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Delete the import/);
  });

  it('deletes an import unless a job is working on it', async () => {
    const { app, world, headers, create } = await authedApp();
    const { dto } = await create();
    world.db.update(imports).set({ status: 'pulling' }).where(eq(imports.id, dto.id)).run();
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${dto.id}`, headers })).statusCode).toBe(409);
    world.db.update(imports).set({ status: 'connected' }).where(eq(imports.id, dto.id)).run();
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${dto.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${dto.id}`, headers })).statusCode).toBe(404);
  });
});
