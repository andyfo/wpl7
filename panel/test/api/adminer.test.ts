/**
 * "Open in Adminer": the link, the front door, and the Adminer behind it - here an HTTP handler
 * the fake Docker answers the relay with (FakeDocker.adminerHttp), standing in for PHP's server.
 */
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobs, servers as serverRows, sessions as panelSessions, sites } from '../../src/db/schema.js';
import { createFrontDoor } from '../../src/adminer/frontDoor.js';
import { adminerLockName } from '../../src/adminer/index.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>['app'];

async function signIn(app: App) {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
}

async function signedIn() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const headers = await signIn(app);
  const keyOf = async (access: AccessLevel) => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: `key-${access}`, access } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  // Settling a change waits in seconds; here in milliseconds.
  world.core.adminer.settleTiming = { lookMs: 60, graceMs: 120, pollMs: 20, maxMs: 5_000 };
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

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * What the stand-in Adminer was asked, and its answers: a sign-in, then pages naming the user
 * they were asked for. `/hang` never answers; `change`, when set, answers the changes.
 */
function fakeAdminer(world: TestWorld) {
  const seen: Seen[] = [];
  const fake = {
    seen,
    change: null as ((req: Seen, res: ServerResponse, raw: IncomingMessage) => void) | null,
    /** Held until let go: the readiness check of a starting Adminer. */
    starting: null as Promise<void> | null,
  };
  world.docker.adminerHttp = (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(r);
      if (req.url?.startsWith('/hang')) return;
      if (req.method === 'GET' && req.url === '/' && fake.starting) {
        void fake.starting.then(() => res.end('<p>Adminer</p>'));
        return;
      }
      const params = new URLSearchParams(body);
      if (req.method === 'POST' && params.has('auth[username]')) {
        const user = params.get('auth[username]')!;
        res.writeHead(302, { location: `?server=mariadb&username=${user}&db=${user}`, 'set-cookie': `adminer_sid=s-${user}; path=/; HttpOnly` });
        res.end();
        return;
      }
      if (req.method === 'POST' && fake.change) return fake.change(r, res, req);
      const user = new URL(req.url!, 'http://adminer').searchParams.get('username') ?? '';
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'adminer_version=6; path=/', 'x-powered-by': 'PHP' });
      res.end(`<h2>${user}</h2>`);
    });
  };
  return fake;
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

type Door = Awaited<ReturnType<typeof frontDoor>>;

/** The session id the starting page asks about. */
const sessionIdOf = (page: string) => /\/\.wpl7\/state\?s=([\w%-]+)/.exec(page)![1]!;

/**
 * A database opened from a fresh link the way a browser does it: the link from another site
 * (so with no cookie), then the starting page's own questions with the browser's cookie, if it
 * has one. Returns the cookie the browser then holds, whether it was new, and where Adminer opens.
 */
async function opened(app: App, headers: Record<string, string>, get: Door, slug = 'alpha', browserCookie?: string) {
  const link = new URL((await app.inject({ method: 'POST', url: `/api/sites/${slug}/databases/wp_${slug}/adminer`, headers })).json().url as string);
  const open = await get(`${link.pathname}${link.search}`);
  expect(open.status).toBe(200);
  expect(open.headers['set-cookie']).toBeUndefined();
  const id = sessionIdOf(open.body);
  let cookie = browserCookie;
  let isNew = false;
  let state: { state: string; location?: string; message?: string } = { state: 'starting' };
  for (let i = 0; i < 100 && state.state === 'starting'; i++) {
    const res = await get(`/.wpl7/state?s=${id}`, { ...(cookie ? { cookie } : {}), 'sec-fetch-site': 'same-origin' });
    if (res.headers['set-cookie']) {
      cookie = String(res.headers['set-cookie']).split(';')[0]!;
      isNew = true;
    }
    state = JSON.parse(res.body);
    if (state.state === 'starting') await new Promise((r) => setTimeout(r, 10));
  }
  expect(state, state.message).toMatchObject({ state: 'ready' });
  return { cookie: cookie!, isNew, location: state.location!, id };
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
    const { seen } = fakeAdminer(world);
    const get = await frontDoor(world);
    const link = new URL((await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/adminer', headers })).json().url as string);

    const open = await get(`${link.pathname}${link.search}`);
    expect(open.status).toBe(200);
    expect(open.body).toContain('Starting Adminer');
    // The link works once.
    expect((await get(`${link.pathname}${link.search}`)).status).toBe(410);
    // The page's first question claims the session, and gives the browser its key.
    const id = sessionIdOf(open.body);
    const first = await get(`/.wpl7/state?s=${id}`, { 'sec-fetch-site': 'same-origin' });
    expect(String(first.headers['set-cookie'])).toMatch(/^__Host-wpl7_adminer=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    const cookie = String(first.headers['set-cookie']).split(';')[0]!;
    // Claimed, the session answers only to that browser.
    expect(JSON.parse((await get(`/.wpl7/state?s=${id}`, { 'sec-fetch-site': 'same-origin' })).body)).toEqual({ state: 'ended' });

    let state: { state: string; location?: string; message?: string } = JSON.parse(first.body);
    for (let i = 0; i < 100 && state.state === 'starting'; i++) {
      state = JSON.parse((await get(`/.wpl7/state?s=${id}`, { cookie, 'sec-fetch-site': 'same-origin' })).body);
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
    expect(passed.headers.cookie).toMatch(/^adminer_key=[0-9a-f]{32}; adminer_sid=s-wp_alpha$/);
    expect(passed.headers['x-forwarded-prefix']).toBeUndefined();
    expect(passed.headers['x-wpl7-login-key']).toBeUndefined();
    // A read is not tagged: only a change takes a lock.
    expect(passed.headers['x-wpl7-request']).toBeUndefined();
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

  it('keeps a tab per site in one browser, and never joins a key the browser was not given by this sign-in', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    addSite(world, 'beta');
    const { seen } = fakeAdminer(world);
    const get = await frontDoor(world);
    const alpha = await opened(app, headers, get, 'alpha');
    expect(alpha.isNew).toBe(true);
    // The second site opens in the same browser: its key serves both, and is not set again.
    const beta = await opened(app, headers, get, 'beta', alpha.cookie);
    expect(beta.isNew).toBe(false);
    expect(beta.cookie).toBe(alpha.cookie);
    const own = { cookie: alpha.cookie, 'sec-fetch-site': 'same-origin' };
    // Each tab's requests go with its own sign-in.
    expect((await get(alpha.location, own)).body).toBe('<h2>wp_alpha</h2>');
    expect(seen.at(-1)!.headers.cookie).toContain('adminer_sid=s-wp_alpha');
    expect((await get(beta.location, own)).body).toBe('<h2>wp_beta</h2>');
    expect(seen.at(-1)!.headers.cookie).toContain('adminer_sid=s-wp_beta');
    // A site the browser did not open is not reached by naming its user.
    expect((await get('/?server=mariadb&username=wp_gamma&db=wp_gamma', own)).status).toBe(401);

    // Two tabs opened at once in a browser with no key yet: each gets one, and the tab whose key
    // the browser did not keep moves to the one it did.
    const fresh = await signIn(app);
    const link = async (slug: string) =>
      new URL((await app.inject({ method: 'POST', url: `/api/sites/${slug}/databases/wp_${slug}/adminer`, headers: fresh })).json().url as string);
    const [one, two] = [await link('alpha'), await link('beta')];
    const idOne = sessionIdOf((await get(`${one.pathname}${one.search}`)).body);
    const idTwo = sessionIdOf((await get(`${two.pathname}${two.search}`)).body);
    const keyOne = String((await get(`/.wpl7/state?s=${idOne}`, { 'sec-fetch-site': 'same-origin' })).headers['set-cookie']).split(';')[0]!;
    const keyTwo = String((await get(`/.wpl7/state?s=${idTwo}`, { 'sec-fetch-site': 'same-origin' })).headers['set-cookie']).split(';')[0]!;
    expect(keyTwo).not.toBe(keyOne);
    const moved = await get(`/.wpl7/state?s=${idOne}`, { cookie: keyTwo, 'sec-fetch-site': 'same-origin' });
    expect(JSON.parse(moved.body).state).not.toBe('ended');
    expect(moved.headers['set-cookie']).toBeUndefined();

    // A key from another sign-in - left from before, or planted - is never joined: a new one is given.
    const other = await opened(app, fresh, get, 'alpha', alpha.cookie);
    expect(other.isNew).toBe(true);
    expect(other.cookie).not.toBe(alpha.cookie);
    // ...and the sessions under the first key are untouched.
    expect((await get(beta.location, own)).body).toBe('<h2>wp_beta</h2>');
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

  it('switched off while it starts, stops once started and signs nobody in', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const fake = fakeAdminer(world);
    let started!: () => void;
    fake.starting = new Promise((r) => (started = r));
    const get = await frontDoor(world);
    const link = new URL((await app.inject({ method: 'POST', url: '/api/sites/alpha/databases/wp_alpha/adminer', headers })).json().url as string);
    await get(`${link.pathname}${link.search}`);
    await waitFor(() => fake.seen.some((r) => r.method === 'GET' && r.url === '/'));
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { adminerEnabled: false } })).statusCode).toBe(200);
    started();
    await waitFor(() => world.docker.containers.get('wpl7-adminer') === 'exited');
    await new Promise((r) => setTimeout(r, 50));
    expect(world.docker.containers.get('wpl7-adminer')).toBe('exited');
    expect(fake.seen.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('lets a read go when the browser does, refuses a body too large, and takes a change only from its own page', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const { seen } = fakeAdminer(world);
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

  it('runs a change Adminer has to its end when the browser goes, and holds the site until MariaDB has let it go', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const fake = fakeAdminer(world);
    const get = await frontDoor(world);
    const { cookie, location } = await opened(app, headers, get);
    const site = world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    const status = (id: number) => world.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;

    // Adminer takes the change and its lock, and is slow to answer.
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    fake.change = (r, res) => {
      world.dbBrowser.locks.set(adminerLockName(String(r.headers['x-wpl7-request'])), 41);
      void answered.then(() => {
        // PHP's request ends, and its connection with it.
        world.dbBrowser.locks.clear();
        res.end('<p>Query executed OK</p>');
      });
    };
    const req = http.request({
      host: '127.0.0.1',
      port: get.port,
      path: location,
      method: 'POST',
      headers: { host: 'db.test', cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    });
    req.on('error', () => undefined);
    req.end('query=UPDATE+wp_options+SET+autoload%3D%27no%27');
    await waitFor(() => world.dbBrowser.locks.size === 1);
    const tag = String(fake.seen.at(-1)!.headers['x-wpl7-request']);
    expect(tag).toMatch(/^[\w-]{16,40}$/);
    // The browser goes. The change carries on, and a job for the site waits for it.
    req.destroy();
    const job = world.worker.enqueue('demo', { steps: 1, stepMs: 0 }, site);
    world.worker.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(status(job.id)).toBe('queued');
      answer();
      await waitFor(() => status(job.id) === 'succeeded');
    } finally {
      await world.worker.stop();
    }
    // It ended by itself: nothing was killed.
    expect(world.dbBrowser.killed).toEqual([]);
    expect(world.dbBrowser.calls.some((c) => c.method === 'lockHolder' && c.args[0] === adminerLockName(tag))).toBe(true);
  });

  it('stops a change in MariaDB when its relay goes, and a change that outlives its request', async () => {
    const { app, world, headers } = await signedIn();
    addSite(world, 'alpha');
    const fake = fakeAdminer(world);
    const get = await frontDoor(world);
    const { cookie, location } = await opened(app, headers, get);
    const post = (body: string) => get(location, { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', body);

    // The relay dies under the change (PHP and its statement go on): its connection is killed.
    fake.change = (r, res) => {
      world.dbBrowser.locks.set(adminerLockName(String(r.headers['x-wpl7-request'])), 42);
      // The relay's end, as when its `docker exec` stops: no answer comes.
      res.socket?.end();
    };
    await post('query=DELETE+FROM+wp_options').catch(() => undefined);
    await waitFor(() => world.dbBrowser.killed.includes(42));
    await waitFor(() => world.dbBrowser.locks.size === 0);

    // Answered, but its connection is still there after the grace: killed all the same.
    fake.change = (r, res) => {
      world.dbBrowser.locks.set(adminerLockName(String(r.headers['x-wpl7-request'])), 43);
      res.end('<p>Query executed OK</p>');
    };
    expect((await post('query=SELECT+1')).status).toBe(200);
    await waitFor(() => world.dbBrowser.killed.includes(43));
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
    // Seen stopped, a server is not asked again until Adminer starts there.
    let asked = 0;
    const state = world.docker.containerState.bind(world.docker);
    world.docker.containerState = (name) => {
      if (name === 'wpl7-adminer') asked++;
      return state(name);
    };
    await world.core.adminer.containers.stopIdle(0, () => false);
    expect(asked).toBe(0);
  });

  it('looks again at a server it could not reach, until it has stopped an Adminer left from before a restart', async () => {
    const { world } = await signedIn();
    const warn = vi.spyOn(world.core.log, 'warn');
    // Left running by the panel before it restarted: the panel has no record of it.
    world.docker.containers.set('wpl7-adminer', 'running');
    const state = world.docker.containerState.bind(world.docker);
    let reachable = false;
    world.docker.containerState = async (name) => {
      if (!reachable) throw new Error('connect ETIMEDOUT');
      return state(name);
    };
    const containers = world.core.adminer.containers;
    expect(await containers.stopIdle(0, () => false)).toBe(0);
    expect(await containers.stopIdle(0, () => false)).toBe(0);
    // Logged once, not every minute.
    expect(warn.mock.calls.filter(([m]) => /could not stop it/.test(String(m)))).toHaveLength(1);
    // Not asked while the server is known to be unreachable.
    world.db.update(serverRows).set({ status: 'unreachable' }).where(eq(serverRows.id, 1)).run();
    reachable = true;
    expect(await containers.stopIdle(0, () => false)).toBe(0);
    expect(world.docker.containers.get('wpl7-adminer')).toBe('running');
    world.db.update(serverRows).set({ status: 'ok' }).where(eq(serverRows.id, 1)).run();
    expect(await containers.stopIdle(0, () => false)).toBe(1);
    expect(world.docker.containers.get('wpl7-adminer')).toBe('exited');
  });
});
