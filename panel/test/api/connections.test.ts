import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, siteConnections, sites } from '../../src/db/schema.js';
import { zipEntries } from '../../src/lib/pluginZip.js';
import { PANEL_VERSION } from '../../src/lib/version.js';
import type { ConnectionDto, SiteDetail, SiteSummary } from '../../shared/types.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { FakeConnectedSite } from '../connectFake.js';

/** A stand-in for panel/connect-plugin: the files the zip is built from. */
function stubPlugin(world: TestWorld): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-connect-src-'));
  const dir = path.join(root, 'wpl7-connect');
  fs.mkdirSync(path.join(dir, 'includes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wpl7-connect.php'), "<?php\n/*\n * Plugin Name: WPL7 Connect\n * Version: 0.0.0-dev\n */\n");
  fs.writeFileSync(path.join(dir, 'includes', 'class-wpl7-connect-server.php'), '<?php // server\n');
  fs.writeFileSync(path.join(dir, 'connection.php'), "<?php return array('token' => 'stale');\n");
  (world.config as { connectPluginDir: string }).connectPluginDir = root;
}

export async function connectWorld() {
  const world = await makeWorld();
  stubPlugin(world);
  const { app } = await makeApp(world);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const create = async (body: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/api/connections', headers, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as ConnectionDto;
    const row = world.db.select().from(siteConnections).where(eq(siteConnections.id, dto.id)).get()!;
    return { dto, token: row.token!, publicKey: row.publicKey };
  };
  const enroll = (token: string, report: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/connect/enroll', headers: { 'x-wpl7-connect-token': token }, payload: report });
  /** A connection with a fake site enrolled and checked: ready for Add site. */
  const ready = async (opts: ConstructorParameters<typeof FakeConnectedSite>[0] extends infer T ? Partial<T> : never = {}) => {
    const { dto, token, publicKey } = await create();
    const fake = new FakeConnectedSite({ connectionId: dto.id, publicKey, ...opts });
    world.core.connections.transport = fake.transport;
    world.core.connections.probe = fake.probe;
    const res = await enroll(token, fake.report());
    expect(res.statusCode, res.body).toBe(200);
    const check = await app.inject({ method: 'POST', url: `/api/connections/${dto.id}/check`, headers });
    expect(check.statusCode, check.body).toBe(200);
    return { id: dto.id, token, fake };
  };
  const add = (id: number, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/connections/${id}/add`, headers, payload: body });
  return { app, world, headers, create, enroll, ready, add };
}

describe('connecting a site hosted elsewhere', () => {
  it('creates a connection that waits for the site, and never shows its token or key', async () => {
    const { app, world, headers, create } = await connectWorld();
    const { dto, token } = await create({ sourceUrl: 'https://shop.example.org' });
    expect(dto).toMatchObject({ status: 'pending', source: 'https://shop.example.org', canDownload: true, report: null });
    const row = world.db.select().from(siteConnections).where(eq(siteConnections.id, dto.id)).get()!;
    expect(row.privateKey).toMatch(/BEGIN PRIVATE KEY/);
    const list = await app.inject({ method: 'GET', url: '/api/connections', headers });
    for (const body of [JSON.stringify(dto), list.body]) {
      expect(body).not.toContain(token);
      expect(body).not.toContain(row.privateKey!.split('\n')[1]);
    }
  });

  it('hands out the plugin with the panel, the token and the public key in its connection file', async () => {
    const { app, headers, create } = await connectWorld();
    const { dto, token, publicKey } = await create();
    const res = await app.inject({ method: 'GET', url: `/api/connections/${dto.id}/plugin`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-zip-')), 'p.zip');
    fs.writeFileSync(file, res.rawPayload);
    const names = zipEntries(file)!.map((e) => e.name);
    expect(names).toEqual([
      'wpl7-connect/',
      'wpl7-connect/includes/',
      'wpl7-connect/includes/class-wpl7-connect-server.php',
      'wpl7-connect/wpl7-connect.php',
      'wpl7-connect/connection.php',
    ]);
    const unzip = (name: string) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
    expect(unzip('wpl7-connect/wpl7-connect.php')).toContain(`Version: ${PANEL_VERSION}`);
    const connection = unzip('wpl7-connect/connection.php');
    expect(connection).toContain(`'panel' => 'http://panel.example.test', 'connection' => ${dto.id}, 'token' => '${token}', 'key' => '${publicKey}'`);
    expect(connection).not.toContain('stale');
    const code = await app.inject({ method: 'GET', url: `/api/connections/${dto.id}/code`, headers });
    expect(code.json()).toEqual({ panel: 'http://panel.example.test', code: `${token}.${publicKey}` });
  });

  it('takes the report of the site the token was given to, and refuses another', async () => {
    const { world, create, enroll } = await connectWorld();
    const { dto, token, publicKey } = await create();
    const fake = new FakeConnectedSite({ connectionId: dto.id, publicKey });
    expect((await enroll('x'.repeat(43), fake.report())).statusCode).toBe(401);
    expect((await enroll(token, { ...fake.report(), protocol: 9 })).statusCode).toBe(426);
    const ok = await enroll(token, fake.report());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, connection: { id: dto.id, status: 'enrolled' } });
    expect((await enroll(token, fake.report())).statusCode).toBe(200);
    const other = await enroll(token, fake.report({ home: 'https://another.example.org', endpoint: 'https://another.example.org/wp-json/wpl7-connect/v1/' }));
    expect(other.statusCode).toBe(409);
    expect(world.db.select().from(siteConnections).where(eq(siteConnections.id, dto.id)).get()!.homeUrl).toBe('https://shop.example.org');
  });

  it('refuses a site without HTTPS unless the connection allows it', async () => {
    const { create, enroll } = await connectWorld();
    const { dto, token, publicKey } = await create();
    const fake = new FakeConnectedSite({ connectionId: dto.id, publicKey });
    const res = await enroll(token, fake.report({ home: 'http://shop.example.org', endpoint: 'http://shop.example.org/wp-json/wpl7-connect/v1/' }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'unreachable' } });
  });

  it('adds the site once the panel reaches it, as an external site with its first jobs queued', async () => {
    const { app, world, headers, ready, add } = await connectWorld();
    const { id, fake } = await ready();
    const dto = (await app.inject({ method: 'GET', url: `/api/connections/${id}`, headers })).json() as ConnectionDto;
    expect(dto.check).toMatchObject({ reachable: true, transport: 'rest' });
    expect(dto.suggestions).toMatchObject({ slug: 'shop', title: 'Example Shop', actAs: 1 });
    expect(fake.count('ping')).toBe(1);

    const res = await add(id, { actAs: 7 });
    expect(res.statusCode, res.body).toBe(201);
    const site = world.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    expect(site).toMatchObject({ kind: 'external', status: 'connected', containerName: '', dbName: '', mailPassword: null, wpAdminUser: 'editor-in-chief', serverId: 1 });
    expect(JSON.parse(site.domains)).toEqual(['shop.example.org']);
    const conn = world.db.select().from(siteConnections).where(eq(siteConnections.siteId, site.id)).get()!;
    expect(conn).toMatchObject({ status: 'active', token: null, actAsLogin: 'editor-in-chief' });
    const queued = world.db.select().from(jobs).where(eq(jobs.siteSlug, 'shop')).all();
    expect(queued.map((j) => [j.type, j.lane])).toEqual([
      ['wp.scanAll', null],
      ['backup.create', `external-${site.id % 2}`],
    ]);
    expect((await add(id)).statusCode).toBe(409);

    const list = (await app.inject({ method: 'GET', url: '/api/sites', headers })).json() as { items: SiteSummary[] };
    expect(list.items.find((s) => s.slug === 'shop')).toMatchObject({ kind: 'external', external: { home: 'https://shop.example.org', pluginVersion: '0.4.0' } });
    const detail = (await app.inject({ method: 'GET', url: '/api/sites/shop', headers })).json() as SiteDetail;
    expect(detail).toMatchObject({ kind: 'external', containerState: 'missing', url: 'https://shop.example.org' });
    expect(detail.external).toMatchObject({ actAs: { id: 7, login: 'editor-in-chief' }, storageServerName: 'local', warnings: [] });
  });

  it('refuses Add site before the panel reached the plugin, and for a multisite network', async () => {
    const { app, headers, create, enroll, add, world } = await connectWorld();
    const { dto, token, publicKey } = await create();
    const fake = new FakeConnectedSite({ connectionId: dto.id, publicKey });
    world.core.connections.transport = fake.transport;
    await enroll(token, fake.report());
    expect((await add(dto.id)).json()).toMatchObject({ error: { message: 'Check that the panel reaches the site first.' } });

    const second = await create();
    const network = new FakeConnectedSite({ connectionId: second.dto.id, publicKey: second.publicKey, host: 'network.example.org' });
    world.core.connections.transport = network.transport;
    await enroll(second.token, network.report({ multisite: true }));
    await app.inject({ method: 'POST', url: `/api/connections/${second.dto.id}/check`, headers });
    const refused = await add(second.dto.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { message: expect.stringMatching(/multisite/) } });
  });

  it('keeps an external site away from everything only a hosted site has', async () => {
    const { app, headers, ready, add } = await connectWorld();
    const { id } = await ready();
    await add(id);
    for (const [method, url, payload] of [
      ['POST', '/api/sites/shop/start', undefined],
      ['POST', '/api/sites/shop/restart', undefined],
      ['PUT', '/api/sites/shop/php', { phpVersion: '8.3' }],
      ['POST', '/api/sites/shop/go-live', { domains: ['shop.example.org'] }],
      ['GET', '/api/sites/shop/files?path=/', undefined],
      ['GET', '/api/sites/shop/ftp', undefined],
      ['GET', '/api/sites/shop/security', undefined],
      ['POST', '/api/sites/shop/shell', { command: 'ls' }],
      ['POST', '/api/sites/shop/move', { targetServerId: 1 }],
      ['GET', '/api/sites/shop/traffic', undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect([res.statusCode, url]).toEqual([409, url]);
      expect(res.json()).toMatchObject({ error: { message: '"shop" is an external site: this works only for sites the panel hosts.' } });
    }
  });

  it('reconnects with a new key, and disconnects, keeping the site', async () => {
    const { app, world, headers, ready, add, enroll } = await connectWorld();
    const { id, fake } = await ready();
    await add(id);
    const re = await app.inject({ method: 'POST', url: '/api/sites/shop/connection/reconnect', headers });
    expect(re.statusCode, re.body).toBe(201);
    const pending = re.json() as ConnectionDto;
    expect(pending.forSite).toEqual({ slug: 'shop', title: 'Example Shop' });
    const row = world.db.select().from(siteConnections).where(eq(siteConnections.id, pending.id)).get()!;
    // The new download: the plugin takes the new key, and enrolls with the new token.
    fake.connection = { id: pending.id, publicKey: row.publicKey };
    expect((await enroll(row.token!, fake.report())).statusCode).toBe(200);
    const site = world.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    const conn = world.db.select().from(siteConnections).where(eq(siteConnections.siteId, site.id)).all();
    expect(conn.map((c) => c.id)).toEqual([pending.id]);
    expect(world.db.select().from(siteConnections).where(eq(siteConnections.id, id)).get()).toBeUndefined();
    // The panel signs with the new key, and the site answers.
    expect(await world.core.connections.checkSite(site)).toBe(true);

    const off = await app.inject({ method: 'POST', url: '/api/sites/shop/connection/disconnect', headers });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ status: 'disconnected' });
    expect(fake.connection).toBeNull();
    expect(world.db.select().from(siteConnections).where(eq(siteConnections.id, pending.id)).get()!.privateKey).toBeNull();
  });

  it('removes an external site from the panel, leaving it running elsewhere', async () => {
    const { app, world, headers, ready, add } = await connectWorld();
    const { id, fake } = await ready();
    await add(id);
    // The first jobs are not this test's business.
    world.db.update(jobs).set({ status: 'canceled' }).run();
    const res = await app.inject({ method: 'DELETE', url: '/api/sites/shop?deleteBackups=true', headers });
    expect(res.statusCode, res.body).toBe(202);
    world.worker.start();
    try {
      await waitFor(() => world.db.select().from(sites).where(eq(sites.slug, 'shop')).get() === undefined);
    } finally {
      await world.worker.stop();
    }
    expect(fake.connection).toBeNull();
    expect(world.db.select().from(siteConnections).all()).toEqual([]);
  });
});
