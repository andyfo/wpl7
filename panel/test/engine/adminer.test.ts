/**
 * "Open in Adminer" against the real thing: the wpl7-adminer image built from
 * deploy/adminer-image, a MariaDB, and the panel's front door and container handling driving them
 * through Docker - the image, its router and plugin, the relay, the sign-in, and what a site's
 * user can see. Opt-in: needs Docker, and builds the image (a minute the first time). Run it when
 * the image or Adminer moves (docs/internal/watchlist.md):
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/adminer.test.ts
 *
 * It uses the names the panel uses (wpl7-mariadb, wpl7-adminer, wpl7_adminer) and refuses to run
 * where they exist already.
 */
import { spawnSync } from 'node:child_process';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminerService } from '../../src/adminer/index.js';
import { createFrontDoor } from '../../src/adminer/frontDoor.js';
import { adminerRequest, readAll } from '../../src/adminer/relay.js';
import { sessions as panelSessions, sites, users as userRows } from '../../src/db/schema.js';
import type { ServerRegistry } from '../../src/servers/registry.js';
import { DbBrowserService } from '../../src/services/dbBrowser.js';
import { DockerService } from '../../src/services/docker.js';
import { UsersService } from '../../src/services/users.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000 });
const rootSql = (sql: string) => {
  const res = spawnSync('docker', ['exec', '-i', 'wpl7-mariadb', 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B'], {
    input: sql,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout;
};

describe.skipIf(!ENABLED)('Adminer against MariaDB, through the front door', () => {
  const realDocker = new DockerService('none', 'none');
  let world: TestWorld;
  let service: AdminerService;
  let door: http.Server;
  let port = 0;
  let link = '';
  /** The browser's cookie and where Adminer opened, once the first test has signed in. */
  let cookie = '';
  let location = '';
  /** What the front door held of the site, and let go of. */
  const holds = { taken: 0, released: 0 };

  beforeAll(async () => {
    const taken = docker('ps', '-a', '--format', '{{.Names}}').stdout.split('\n');
    if (taken.includes('wpl7-mariadb') || taken.includes('wpl7-adminer')) {
      throw new Error('wpl7-mariadb or wpl7-adminer exists here already: not touching a real stack');
    }
    world = await makeWorld();
    const context = path.resolve(process.cwd(), '../deploy/adminer-image');
    const built = docker('build', '-q', '-t', world.config.adminer.image, context);
    if (built.status !== 0) throw new Error(built.stderr);
    const run = docker('run', '-d', '--name', 'wpl7-mariadb', '-e', 'MARIADB_ROOT_PASSWORD=engine-root', 'mariadb:11.4');
    if (run.status !== 0) throw new Error(run.stderr);
    for (let i = 0; i < 60; i++) {
      if (docker('exec', 'wpl7-mariadb', 'healthcheck.sh', '--connect', '--innodb_initialized').status === 0) break;
      spawnSync('sleep', ['1']);
    }
    rootSql(`
CREATE DATABASE wp_shop; CREATE DATABASE wp_other;
CREATE USER 'wp_shop'@'%' IDENTIFIED BY 'engine-site-pw';
GRANT ALL PRIVILEGES ON \`wp\\_shop\`.* TO 'wp_shop'@'%';
CREATE TABLE wp_shop.wp_options (option_id int PRIMARY KEY, option_name varchar(64));
CREATE TABLE wp_other.secret_table (s text);
`);
    const now = Date.now();
    const site = world.db
      .insert(sites)
      .values({
        slug: 'shop',
        title: 'Shop',
        domains: JSON.stringify(['shop.test']),
        phpVersion: '8.3',
        status: 'running',
        dbName: 'wp_shop',
        dbUser: 'wp_shop',
        dbPassword: 'engine-site-pw',
        containerName: 'wp-shop',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const owner = world.db.select().from(userRows).get()!;
    world.db.insert(panelSessions).values({ sid: 'engine-sid', data: '{}', expiresAt: now + 3600_000, userId: owner.id }).run();
    // Server 1 is this machine's Docker.
    const dbBrowser = new DbBrowserService(realDocker, () => 'the engine test');
    const servers = {
      handleFor: () => ({ id: 1, name: 'the engine test', docker: realDocker, dbBrowser }),
      listRows: () => [{ id: 1, status: 'ok' }],
    } as unknown as ServerRegistry;
    service = new AdminerService(world.db, world.config, servers, world.core.settings, new UsersService(world.db), world.core.databases, world.core.dns, console as never);
    service.attachWorker({
      holdSite: () => {
        holds.taken++;
        return Object.assign(() => void holds.released++, { renew: () => undefined });
      },
    });
    door = createFrontDoor(service, { host: 'db.test', secure: false, panelUrl: 'http://panel.test' });
    await new Promise<void>((r) => door.listen(0, '127.0.0.1', r));
    port = (door.address() as AddressInfo).port;
    link = service.open({ userId: owner.id, panelSid: 'engine-sid', siteId: site.id, database: 'wp_shop' });
  }, 600_000);

  afterAll(() => {
    door?.close();
    docker('rm', '-f', 'wpl7-adminer', 'wpl7-mariadb');
    docker('network', 'rm', 'wpl7_adminer');
  });

  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: 'db.test', 'sec-fetch-site': 'same-origin', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it("opens the site's database as its user, and shows that database alone", async () => {
    const url = new URL(link);
    const open = await get(`${url.pathname}${url.search}`, { 'sec-fetch-site': 'cross-site' });
    expect(open.status).toBe(200);
    const id = /\/\.wpl7\/state\?t=([\w%-]+)/.exec(open.body)![1]!;
    const claimed = await get(`/.wpl7/state?t=${id}`);
    cookie = String(claimed.headers['set-cookie']).split(';')[0]!;
    let state: { state: string; location?: string; message?: string } = JSON.parse(claimed.body);
    for (let i = 0; i < 240 && state.state === 'starting'; i++) {
      state = JSON.parse((await get(`/.wpl7/state?t=${id}`, { cookie })).body);
      if (state.state === 'starting') await new Promise((r) => setTimeout(r, 250));
    }
    expect(state, state.message).toMatchObject({ state: 'ready' });
    location = state.location!;

    const tables = await get(state.location!, { cookie });
    expect(tables.status).toBe(200);
    expect(tables.body).toContain('wp_options');
    expect(tables.headers['set-cookie']).toBeUndefined();
    const databases = await get('/?server=mariadb&username=wp_shop', { cookie });
    expect(databases.body).toContain('wp_shop');
    expect(databases.body).not.toContain('wp_other');
    // Its own styles come from the same page.
    expect((await get(`/?file=default.css&version=${world.config.adminer.version.split('-')[0]}`, { cookie })).status).toBe(200);

    // The container: unprivileged, read-only, on its own network, no port published.
    const inspect = JSON.parse(docker('inspect', 'wpl7-adminer').stdout)[0];
    expect(inspect.Config.User).toBe('65534:65534');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(Object.keys(inspect.NetworkSettings.Networks)).toEqual(['wpl7_adminer']);
    expect(inspect.HostConfig.PortBindings ?? {}).toEqual({});
  }, 300_000);

  it('refuses a sign-in without the panel’s key, any page but Adminer, and forwarded prefixes', async () => {
    const form = new URLSearchParams({
      'auth[driver]': 'server',
      'auth[server]': 'mariadb',
      'auth[username]': 'wp_shop',
      'auth[password]': 'engine-site-pw',
      'auth[db]': 'wp_shop',
    }).toString();
    const noKey = await adminerRequest(realDocker, {
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(form.length) },
      body: form,
    });
    await readAll(noKey);
    expect(noKey.statusCode).toBe(403);
    const wrongKey = await adminerRequest(realDocker, {
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(form.length), 'x-wpl7-login-key': 'guess' },
      body: form,
    });
    await readAll(wrongKey);
    expect(wrongKey.statusCode).toBe(403);
    const file = await adminerRequest(realDocker, { method: 'GET', path: '/adminer.php', headers: {} });
    await readAll(file);
    expect(file.statusCode).toBe(404);
    const prefixed = await adminerRequest(realDocker, { method: 'GET', path: '/', headers: { 'x-forwarded-prefix': '/evil' } });
    expect(await readAll(prefixed)).not.toContain('/evil');
  });

  it('runs a change to its end when the browser goes, and stops one whose relay dies, before letting the site go', async () => {
    const running = () =>
      rootSql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'wp_shop' AND INFO LIKE 'SELECT SLEEP(%'").trim();
    // Adminer's SQL command takes its form's token, and the browser's Sec-Fetch-Site.
    const sqlPage = `${location}&sql=`;
    const token = /name=["']token["'] value=["']([^"']+)["']/.exec((await get(sqlPage, { cookie })).body)![1]!;
    const send = (seconds: number) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: sqlPage,
        method: 'POST',
        headers: { host: 'db.test', cookie, 'sec-fetch-site': 'same-origin', origin: 'http://db.test', 'content-type': 'application/x-www-form-urlencoded' },
      });
      req.on('error', () => undefined);
      req.end(new URLSearchParams({ query: `SELECT SLEEP(${seconds})`, token }).toString());
      return req;
    };
    const until = async (check: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end && !check(); ) await new Promise((r) => setTimeout(r, 200));
      return check();
    };

    // The browser goes once Adminer has the change: it runs on, and the site stays held until it ends.
    const leaving = send(4);
    expect(await until(() => running() === '1', 10_000)).toBe(true);
    leaving.destroy();
    await new Promise((r) => setTimeout(r, 1000));
    expect(running()).toBe('1');
    expect(holds.taken).toBeGreaterThan(holds.released);
    expect(await until(() => running() === '0', 15_000)).toBe(true);
    expect(await until(() => holds.released === holds.taken, 10_000)).toBe(true);

    // The relay dies under a change (its `docker exec` stops; PHP and its statement do not): the
    // statement is killed in MariaDB well before its 30 seconds, and only then is the site let go.
    const released = holds.released;
    send(30);
    expect(await until(() => running() === '1', 10_000)).toBe(true);
    // As the relay's own user: the container keeps no capability that would let root signal it.
    expect(docker('exec', '-u', '65534:65534', 'wpl7-adminer', 'pkill', '-f', 'relay.php').status).toBe(0);
    const started = Date.now();
    expect(await until(() => running() === '0', 15_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await until(() => holds.released > released, 10_000)).toBe(true);

    // Every request was a `docker exec`: none left a process behind to count against the limit.
    const processes = docker('exec', 'wpl7-adminer', 'ps', '-o', 'stat,args').stdout.split('\n').slice(1).filter(Boolean);
    expect(processes.filter((p) => /^Z/.test(p.trim()))).toEqual([]);
    expect(processes.filter((p) => /timeout|relay\.php/.test(p) && !/ps -o/.test(p))).toEqual([]);
  }, 120_000);

  it("gives up at Adminer's gate a change it has not started, and tells of one it has", async () => {
    const key = service.containers.loginKey(1);
    const ask = async (tag: string) => {
      const res = await adminerRequest(realDocker, { method: 'POST', path: `/.wpl7/settle?tag=${tag}`, headers: { 'x-wpl7-login-key': key, 'content-length': '0' } });
      return { status: res.statusCode, body: await readAll(res) };
    };
    // Only with the panel's key.
    const noKey = await adminerRequest(realDocker, { method: 'POST', path: '/.wpl7/settle?tag=engineTagNoKeyxxxxxxx', headers: { 'content-length': '0' } });
    await readAll(noKey);
    expect(noKey.statusCode).toBe(403);
    // Asked first, a change is given up, and refuses to run when PHP gets to it.
    expect(JSON.parse((await ask('engineTagGivenUpxxxxx')).body)).toEqual({ state: 'canceled' });
    const late = await adminerRequest(realDocker, { method: 'GET', path: '/', headers: { 'x-wpl7-request': 'engineTagGivenUpxxxxx' } });
    expect(late.statusCode).toBe(409);
    expect(await readAll(late)).toMatch(/given up/);
    // Passed first, a change is started, then done once its request is over.
    const passed = await adminerRequest(realDocker, { method: 'GET', path: '/', headers: { 'x-wpl7-request': 'engineTagPassedxxxxxx' } });
    await readAll(passed);
    expect(passed.statusCode).not.toBe(409);
    expect(JSON.parse((await ask('engineTagPassedxxxxxx')).body)).toEqual({ state: 'done' });
  });

  it('stops once nobody uses it', async () => {
    expect(await service.containers.stopIdle(0, () => true)).toBe(0);
    expect(await service.containers.stopIdle(0, () => false)).toBe(1);
    expect(docker('inspect', '-f', '{{.State.Running}}', 'wpl7-adminer').stdout.trim()).toBe('false');
  }, 60_000);
});
