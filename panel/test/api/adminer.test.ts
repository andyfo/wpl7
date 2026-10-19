/**
 * "Open in Adminer": the link, the front door, and the Adminer behind it - here an HTTP handler
 * the fake Docker answers the relay with (FakeDocker.adminerHttp), standing in for PHP's server.
 */
import fs from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { jobs, sessions as panelSessions, sites } from '../../src/db/schema.js';
import { createFrontDoor } from '../../src/adminer/frontDoor.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function signedIn() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const keyOf = async (access: AccessLevel) => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: `key-${access}`, access } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, world, headers, keyOf };
}

function addSite(w: TestWorld, slug: string): void {
  const now = Date.now();
  w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: `pw-${slug}`,
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  w.dbAdmin.databases.add(`wp_${slug}`);
}

/** What the stand-in Adminer was asked, and its answers: a sign-in, then pages; `/hang` never answers. */
function fakeAdminer(world: TestWorld) {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  world.docker.adminerHttp = (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url?.startsWith('/hang')) return;
      if (req.method === 'POST' && body.includes('auth%5Busername%5D')) {
        res.writeHead(302, { location: '?server=mariadb&username=wp_alpha&db=wp_alpha', 'set-cookie': 'adminer_sid=s1; path=/; HttpOnly' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'adminer_version=6; path=/', 'x-powered-by': 'PHP' });
      res.end('<h2>wp_alpha</h2>');
    });
  };
  return seen;
}

const doors: http.Server[] = [];
afterEach(() => {
  for (const d of doors.splice(0)) d.close();
});

async function frontDoor(world: TestWorld) {
  const door = createFrontDoor(world.core.adminer, { host: 'db.test', secure: true, panelUrl: 'https://panel.test' });
  doors.push(door);
  await new Promise<void>((r) => door.listen(0, '127.0.0.1', r));
  const port = (door.address() as AddressInfo).port;
  const request = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: 'db.test', ...headers } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  return Object.assign(request, { port });
}

/** A session opened from a fresh link, once Adminer is ready: its cookie and where it opens. */
async function opened(app: Awaited<ReturnType<typeof signedIn>>['app'], headers: Record<string, string>, get: Awaited<ReturnType<typeof frontDoor>>) {
  const link = new URL((await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/adminer', headers })).json().url as string);
  const open = await get(`${link.pathname}${link.search}`);
  const cookie = String(open.headers['set-cookie']).split(';')[0]!;
  let state: { state: string; location?: string; message?: string } = { state: 'starting' };
  for (let i = 0; i < 100 && state.state === 'starting'; i++) {
    state = JSON.parse((await get('/.wpl7/state', { cookie, 'sec-fetch-site': 'same-origin' })).body);
    if (state.state === 'starting') await new Promise((r) => setTimeout(r, 10));
  }
  expect(state, state.message).toMatchObject({ state: 'ready' });
  return { cookie, location: state.location! };
}

describe('Open in Adminer', () => {
  it('hands a one-time link to an admin in the browser, and to nobody else', async () => {
    const { app, world, headers, keyOf } = await signedIn();
    addSite(world, 'alpha');
    const url = '/api/sites/alpha/databases/wp_alpha/adminer';
    const res = await app.inject({ method: 'POST', url, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { url: string }).url).toMatch(/^https?:\/\/db\.[^/]+\/open\?ticket=[\w%-]{40,}$/);
    // An API key, even Full, gets no link: it hands over a database session.
    expect((await app.inject({ method: 'POST', url, headers: { ...(await keyOf('full')), 'x-csrf': '1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_beta/adminer', headers })).statusCode).toBe(404);
    world.core.settings.set('adminerEnabled', false);
    const off = await app.inject({ method: 'POST', url, headers });
    expect(off.statusCode).toBe(409);
    expect(((await app.inject({ method: 'GET', url: '/api/sites/alpha/databases', headers })).json() as { adminer: string | null }).adminer).toMatch(
      /turned off/,
    );
  });

  it("signs in as the site's user behind a ticket, then passes requests on with Adminer's own cookies only", async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const seen = fakeAdminer(world);
    const get = await frontDoor(world);
    const link = new URL((await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/adminer', headers })).json().url as string);

    const open = await get(`${link.pathname}${link.search}`);
    expect(open.status).toBe(200);
    expect(open.body).toContain('Starting Adminer');
    const cookie = String(open.headers['set-cookie']).split(';')[0]!;
    expect(String(open.headers['set-cookie'])).toMatch(/^__Host-wpl7_adminer=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    // The link works once.
    expect((await get(`${link.pathname}${link.search}`)).status).toBe(410);

    let state: { state: string; location?: string; message?: string } = { state: 'starting' };
    for (let i = 0; i < 100 && state.state === 'starting'; i++) {
      state = JSON.parse((await get('/.wpl7/state', { cookie, 'sec-fetch-site': 'same-origin' })).body);
      if (state.state === 'starting') await new Promise((r) => setTimeout(r, 10));
    }
    expect(state, state.message).toMatchObject({ state: 'ready', location: '/?server=mariadb&username=wp_alpha&db=wp_alpha' });
    // Started on demand, on its own network with MariaDB; signed in with the panel's key.
    const spec = world.docker.calls.find((c) => c.method === 'ensureServiceContainer')!.args[0] as { user: string; readOnlyRootfs: boolean; networks: string[] };
    expect(spec).toMatchObject({ user: '65534:65534', readOnlyRootfs: true, networks: ['wpl7_adminer'] });
    const signIn = seen.find((r) => r.method === 'POST')!;
    expect(signIn.headers['x-wpl7-login-key']).toBe(world.core.adminer.containers.loginKey(1));
    expect(new URLSearchParams(signIn.body).get('auth[password]')).toBe('pw-alpha');
    expect(new URLSearchParams(signIn.body).get('auth[server]')).toBe('mariadb');

    const page = await get(state.location!, {
      // Planted by a dev site on the shared domain, and headers no browser request may pass on.
      cookie: `${cookie}; adminer_sid=planted`,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-prefix': '/evil',
      'x-wpl7-login-key': 'guess',
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('wp_alpha');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.headers['x-powered-by']).toBeUndefined();
    const passed = seen.at(-1)!;
    expect(passed.headers.cookie).toMatch(/^adminer_key=[0-9a-f]{32}; adminer_sid=s1$/);
    expect(passed.headers['x-forwarded-prefix']).toBeUndefined();
    expect(passed.headers['x-wpl7-login-key']).toBeUndefined();
    // Adminer's cookie from that page went into the jar, not the browser.
    await get(state.location!, { cookie, 'sec-fetch-site': 'same-origin' });
    expect(seen.at(-1)!.headers.cookie).toContain('adminer_version=6');

    // Not from Adminer's own pages, not its address, or after signing out of the panel: nothing.
    expect((await get(state.location!, { cookie, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await get(state.location!, { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get(state.location!, { cookie, host: 'evil.test' })).status).toBe(404);
    world.db.delete(panelSessions).run();
    const ended = await get(state.location!, { cookie, 'sec-fetch-site': 'same-origin' });
    expect(ended.status).toBe(401);
    expect(ended.body).toContain('session has ended');
  });

  it('ends the sessions open when it is switched off in Settings', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    fakeAdminer(world);
    const get = await frontDoor(world);
    const { cookie, location } = await opened(app, headers, get);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { adminerEnabled: false } })).statusCode).toBe(200);
    expect((await get(location, { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(409);
    await waitFor(() => world.docker.containers.get('wpl7-adminer') === 'exited');
    // Back on, the session stays ended: it is opened again from the panel.
    await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { adminerEnabled: true } });
    expect((await get(location, { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(401);
  });

  it('lets a request go when the browser does, refuses one too large, and takes a change only from its own page', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const seen = fakeAdminer(world);
    const get = await frontDoor(world);
    const { cookie, location } = await opened(app, headers, get);
    const own = { cookie, 'sec-fetch-site': 'same-origin' };

    // More requests than a server's slots, each left by its browser while Adminer thinks: none keeps its slot.
    for (let i = 0; i < 6; i++) {
      const req = http.request({ host: '127.0.0.1', port: get.port, path: `/hang?${i}`, headers: { host: 'db.test', ...own } });
      req.on('error', () => undefined);
      req.end();
      await waitFor(() => seen.some((r) => r.url === `/hang?${i}`));
      req.destroy();
    }
    const started = Date.now();
    expect((await get(location, own)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);

    // Past the limit, a body sent in chunks with no length given: a 413, and the panel carries on.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: get.port, path: '/?import=', method: 'POST', headers: { host: 'db.test', ...own, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const more = () => {
        while (sent < 34) {
          sent++;
          if (!req.write(chunk)) return void req.once('drain', more);
        }
        req.end();
      };
      more();
    });
    expect(status).toBe(413);
    expect((await get(location, own)).status).toBe(200);

    // A change from a browser that sends no Sec-Fetch-Site needs the front door's own origin.
    const form = 'query=SELECT+1';
    const type = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await get(location, { cookie, ...type }, 'POST', form)).status).toBe(403);
    expect((await get(location, { cookie, ...type, origin: 'https://shop.dev.test' }, 'POST', form)).status).toBe(403);
    expect((await get(location, { cookie, ...type, origin: 'https://db.test' }, 'POST', form)).status).toBe(200);
    // A header with _ reaches PHP as if it had -: none is passed on.
    await get(location, { ...own, x_forwarded_for: '192.0.2.7', x_wpl7_login_key: 'guess' });
    expect(Object.keys(seen.at(-1)!.headers).filter((h) => h.includes('_'))).toEqual([]);
  });

  it('refuses a change while a job holds the site, and ends the session once the site has moved', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    fakeAdminer(world);
    const get = await frontDoor(world);
    const { cookie, location } = await opened(app, headers, get);
    const own = { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' };
    const site = world.db.select().from(sites).get()!;
    const job = world.db
      .insert(jobs)
      .values({ type: 'site.restore', siteId: site.id, siteSlug: site.slug, payload: '{}', status: 'running', createdAt: Date.now() })
      .returning()
      .get();
    const busy = await get(location, own, 'POST', 'query=DELETE+FROM+wp_options');
    expect(busy.status).toBe(409);
    expect(busy.body).toContain('site.restore');
    // Browsing goes on; a backup beside it does not stop a change.
    expect((await get(location, own)).status).toBe(200);
    world.db.update(jobs).set({ type: 'backup.create' }).where(eq(jobs.id, job.id)).run();
    expect((await get(location, own, 'POST', 'query=SELECT+1')).status).toBe(200);

    const second = world.addSshServer('second');
    world.db.update(sites).set({ serverId: second.id }).where(eq(sites.id, site.id)).run();
    const moved = await get(location, own);
    expect(moved.status).toBe(401);
    expect(moved.body).toContain('moved or is gone');
    world.db.update(sites).set({ serverId: 1 }).where(eq(sites.id, site.id)).run();
    expect((await get(location, own)).status).toBe(401);
  });

  it("writes the route that sends db.<dev domain> to the front door, on the panel's own server", async () => {
    const { world } = await signedIn();
    await world.core.adminer.writeRoute();
    const route = fs.readFileSync(path.join(world.config.srvRoot, 'traefik', 'dynamic', 'wpl7-adminer.yml'), 'utf8');
    expect(route).toContain(`rule: "Host(\`db.${world.config.devDomain}\`)"`);
    expect(route).toContain(`- url: "http://wpl7-panel:${world.config.adminer.port}"`);
    expect(route).toMatch(/entryPoints: \[(websecure|web)\]/);
  });

  it('stops an Adminer nobody uses, and keeps one a session needs', async () => {
    const { world } = await signedIn();
    addSite(world, 'alpha');
    fakeAdminer(world);
    await world.core.adminer.containers.ensure(1);
    expect(world.docker.containers.get('wpl7-adminer')).toBe('running');
    expect(await world.core.adminer.containers.stopIdle(0, () => true)).toBe(0);
    expect(await world.core.adminer.containers.stopIdle(60_000, () => false)).toBe(0);
    expect(await world.core.adminer.containers.stopIdle(0, () => false)).toBe(1);
    expect(world.docker.containers.get('wpl7-adminer')).toBe('exited');
    // Once every server has been looked at, only one it started Adminer on is asked again.
    let asked = 0;
    const state = world.docker.containerState.bind(world.docker);
    world.docker.containerState = (name) => {
      if (name === 'wpl7-adminer') asked++;
      return state(name);
    };
    await world.core.adminer.containers.stopIdle(0, () => false);
    expect(asked).toBe(0);
  });
});
