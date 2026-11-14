/**
 * A container app from New site to Delete, in the fake world: its create, its deploys behind the
 * health gate, the hook, app-updates, an uploaded image, start, stop and delete, the hosts other
 * sites lend it, and the way back after a panel that stopped half-way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appDeploys, appSettings, jobLogs, jobs, sites } from '../../src/db/schema.js';
import { TarWriter } from '../../src/lib/tarWriter.js';
import { appLabels, appPaths } from '../../src/services/appSpec.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import type { SiteContainerSpec } from '../../src/services/docker.js';
import { addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const REPO = 'ghcr.io/example/shop';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const LOGIN = { username: 'ci', password: 'reg-token-secret' };
const PASSWD = 'root:x:0:0::/root:/bin/sh\napp:x:10001:10001::/home/app:/bin/sh\n';

/** Publish image n under the tag: what a push from the app's CI leaves in the registry. */
function push(w: TestWorld, n: number, config: Record<string, unknown> = {}): void {
  w.docker.publish(REF, digest(n), {
    login: LOGIN,
    imageId: `sha256:img${n}`,
    config: { exposedPorts: ['8000/tcp'], user: 'app', volumes: ['/var/lib/shop'], ...config },
  });
  w.docker.imageFiles.set(`sha256:img${n}`, new Map([['/etc/passwd', PASSWD]]));
}

async function world(env: Record<string, string> = {}): Promise<TestWorld> {
  const w = await makeWorld({ env });
  // A backup of an app is another step's (backups); these deploys go without one.
  w.deps.settings.set('backupBeforeUpdates', 'never');
  w.docker.containers.set(TRAEFIK_CONTAINER, 'running');
  w.docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: ['--entrypoints.web.http.redirections.entrypoint.priority=1'], envSet: [] });
  push(w, 1);
  return w;
}

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

/** Run the worker until the job has ended. */
async function finish(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const shopBody = {
  title: 'Shop',
  slug: 'shop',
  app: 'container' as const,
  image: { reference: REF, registryUser: LOGIN.username, registryToken: LOGIN.password },
  env: [
    { name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}/{{db.name}}' },
    { name: 'API_KEY', value: 'env-secret-value', secret: true },
  ],
  database: true,
  mounts: [{ name: 'secrets', path: '/run/secrets/app' }],
  routes: [{ host: 'shop.example.com' }, { host: 'shop.dev.example.test' }],
};

/** As the API takes a body: parsed, its defaults filled. */
const parsed = (body: Record<string, unknown>) => siteCreateBody.parse(body);

async function createShop(w: TestWorld, body: Record<string, unknown> = shopBody) {
  const { job } = w.deps.sites.create(parsed(body));
  const done = await finish(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
}

const creates = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);
const settingsOf = (w: TestWorld, siteId: number) => w.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get()!;
const deploysOf = (w: TestWorld, siteId: number) => w.db.select().from(appDeploys).where(eq(appDeploys.siteId, siteId)).orderBy(appDeploys.id).all();
const routesFile = (w: TestWorld, slug = 'shop') => path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName(slug));
const jobLog = (w: TestWorld, jobId: number) => w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');

describe('creating a container app', () => {
  it('pulls its image by digest with its login, and starts it from its own spec behind its health check', async () => {
    const w = await world();
    const site = await createShop(w);

    expect([site.status, site.app, site.phpVersion, site.dbName, site.isLive]).toEqual(['running', 'container', '', 'wp_shop', 1]);
    expect(JSON.parse(site.domains)).toEqual(['shop.example.com', 'shop.dev.example.test']);
    // Asked without a pull, then pulled by digest: no tag moved on the server.
    expect(w.docker.calls.filter((c) => c.method === 'distribution').map((c) => c.args)).toEqual([[REF, 'ci']]);
    expect(w.docker.calls.filter((c) => c.method === 'pullImage').map((c) => c.args)).toEqual([[`${REPO}@${digest(1)}`, { auth: 'ci' }]]);

    const [spec, ...more] = creates(w);
    expect(more).toEqual([]);
    const root = appPaths(w.config, 'shop').root;
    expect(spec).toMatchObject({
      name: 'wp-shop',
      image: `${REPO}@${digest(1)}`,
      labels: appLabels('shop'),
      env: { DATABASE_URL: `mysql://wp_shop:${site.dbPassword}@${w.config.mariadb.host}/wp_shop`, API_KEY: 'env-secret-value' },
      binds: [`${root}/data/var-lib-shop:/var/lib/shop`, `${root}/mounts/secrets:/run/secrets/app:ro`],
      networks: ['wpl7_site_shop', 'wpl7_egress'],
      stopTimeout: 20,
    });
    // It runs as the image's own user, who owns its folders.
    expect(spec!.user).toBeUndefined();
    const s = settingsOf(w, site.id);
    expect([s.port, s.imageUid, s.imageGid, s.digest, s.imageId]).toEqual([8000, 10001, 10001, digest(1), 'sha256:img1']);
    expect(fs.existsSync(`${root}/data/var-lib-shop`) && fs.existsSync(`${root}/mounts/secrets`)).toBe(true);
    expect(fs.existsSync(path.join(root, 'wordpress'))).toBe(false);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'createSiteDb').map((c) => c.args.slice(0, 2))).toEqual([['wp_shop', 'wp_shop']]);

    // Its routes, in a file of its own, to its container by name.
    const file = fs.readFileSync(routesFile(w), 'utf8');
    expect(file).toContain('Host(`shop.example.com`)');
    expect(file).toContain('url: "http://wp-shop:8000"');
    expect(deploysOf(w, site.id).map((d) => [d.origin, d.result, d.digest, d.imageId])).toEqual([['create', 'ok', digest(1), 'sha256:img1']]);
  });

  it('never gives a secret back, nor puts one in a job', async () => {
    const w = await world();
    await createShop(w);
    const { app, headers } = await authed(w);
    for (const url of ['/api/sites/shop', '/api/sites/shop/app', '/api/sites/shop/app/deploys', '/api/sites']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('reg-token-secret');
      expect(res.body, url).not.toContain('env-secret-value');
    }
    const dto = (await app.inject({ method: 'GET', url: '/api/sites/shop/app', headers })).json();
    expect(dto.registryToken).toEqual({ secret: true, set: true });
    expect(dto.env).toEqual([
      { name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}/{{db.name}}', secret: false, set: true },
      { name: 'API_KEY', value: null, secret: true, set: true },
    ]);
    for (const job of w.db.select().from(jobs).all()) {
      expect(`${job.payload} ${job.result ?? ''} ${job.error ?? ''}`).not.toMatch(/reg-token-secret|env-secret-value/);
    }
    expect(w.db.select().from(jobLogs).all().map((l) => l.message).join('\n')).not.toMatch(/reg-token-secret|env-secret-value/);
  });

  it('refuses what is not for a container app, before anything is made', async () => {
    const w = await world();
    addPhpSite(w, 'blog', { domains: ['blog.example.com'] });
    const far = w.addSshServer('far-box', { publicIp: '203.0.113.20' });
    addPhpSite(w, 'far', { domains: ['far.example.com'], serverId: far.id });
    const { app, headers } = await authed(w);
    const post = (extra: Record<string, unknown>, without: string[] = []) => {
      const body: Record<string, unknown> = { ...shopBody, ...extra };
      for (const k of without) delete body[k];
      return app.inject({ method: 'POST', url: '/api/sites', headers, payload: body });
    };
    const message = async (p: ReturnType<typeof post>) => {
      const res = await p;
      return [res.statusCode, res.json().error?.details?.[0]?.message ?? res.json().error?.message];
    };
    expect(await message(post({ adminUser: 'admin' }))).toEqual([400, 'adminUser is for WordPress sites only']);
    expect(await message(post({ phpVersion: '8.3' }))).toEqual([400, 'phpVersion is for sites on the site image only']);
    expect(await message(post({ domains: ['x.example.com'] }))).toEqual([400, 'a container app takes its hosts from its routes: leave domains out']);
    expect(await message(post({}, ['image']))).toEqual([400, 'image is required for a container app']);
    expect(await message(post({ env: [{ name: 'X', value: '{{site.url}}' }] }))).toEqual([400, expect.stringMatching(/^X: \{\{site\.url\}\} is not one the panel fills/)]);
    expect(await message(post({ database: false }))).toEqual([400, "DATABASE_URL: {{db.user}} needs the app's database, and it has none."]);
    expect(await message(post({ routes: [{ host: 'panel.example.test' }] }))).toEqual([409, "panel.example.test is the panel's own address."]);
    expect(await message(post({ routes: [{ host: 'far.example.com', match: 'prefix', path: '/api' }] }))).toEqual([409, 'far.example.com belongs to "far", on another server.']);
    expect(await message(post({ routes: [{ host: 'blog.example.com' }] }))).toEqual([409, 'blog.example.com belongs to "blog": a route there needs a path.']);
    expect(await message(post({ routes: [{ host: 'other.dev.example.test' }] }))).toEqual([409, 'other.dev.example.test is under a dev domain: an app\'s only dev hostname is its own.']);
    expect(await message(post({ routes: [{ host: 'shop.example.com' }, { host: 'shop.example.com' }] }))).toEqual([400, 'Two routes take shop.example.com.']);
    expect(await message(post({ mounts: [{ name: 'etc', path: '/etc/app' }] }))).toEqual([400, "Mount etc: /etc/app is in /etc, which belongs to the container's own system."]);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
    expect(w.db.select().from(jobs).all()).toEqual([]);
  });

  it('asks Full for a path of another site’s domain, and Manage is enough for its own hosts', async () => {
    const w = await world();
    addPhpSite(w, 'blog', { domains: ['blog.example.com'] });
    const { app } = await makeApp(w);
    const manage = w.deps.apiKeys.create('manage', 'manage');
    const full = w.deps.apiKeys.create('full', 'full');
    const body = { ...shopBody, routes: [{ host: 'shop.dev.example.test' }, { host: 'blog.example.com', match: 'prefix', path: '/api' }] };
    const asManage = await app.inject({ method: 'POST', url: '/api/sites', headers: { authorization: `Bearer ${manage.token}` }, payload: body });
    expect([asManage.statusCode, asManage.json().error.message]).toEqual([403, expect.stringContaining("a route on another site's domain (blog.example.com) needs Full")]);
    const own = await app.inject({ method: 'POST', url: '/api/sites', headers: { authorization: `Bearer ${manage.token}` }, payload: { ...shopBody, slug: 'own' , routes: [{ host: 'own.dev.example.test' }] } });
    expect(own.statusCode).toBe(202);
    const asFull = await app.inject({ method: 'POST', url: '/api/sites', headers: { authorization: `Bearer ${full.token}` }, payload: body });
    expect(asFull.statusCode).toBe(202);
    const shop = w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    // The borrowed host is never the app's own.
    expect(JSON.parse(shop.domains)).toEqual(['shop.dev.example.test']);
  });

  it('refuses plain http on a server whose Traefik still redirects every request on port 80', async () => {
    const w = await world({ TLS_MODE: 'letsencrypt' });
    w.docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: [], envSet: [] });
    const server = w.servers.rowById(1)!;
    await expect(w.deps.sites.assertCanCreate(parsed({ ...shopBody, routes: [{ host: 'shop.example.com', scheme: 'both' }] }))).rejects.toThrow(
      `Traefik on "${server.name}" is from before plain http routes. Update the server, then try again.`,
    );
    await expect(w.deps.sites.assertCanCreate(parsed(shopBody))).resolves.toBeUndefined();
    w.docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: ['--entrypoints.web.http.redirections.entrypoint.priority=1'], envSet: [] });
    await expect(w.deps.sites.assertCanCreate(parsed({ ...shopBody, routes: [{ host: 'shop.example.com', scheme: 'both' }] }))).resolves.toBeUndefined();
  });

  it('rolls everything back when the image is for another platform, or never answers its health path', async () => {
    const w = await world();
    w.docker.publish(REF, digest(7), { login: LOGIN, platforms: [{ os: 'linux', architecture: 'arm64' }] });
    const { job } = w.deps.sites.create(parsed(shopBody));
    const failed = await finish(w, job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(`${REF} has no image for linux/amd64, only for linux/arm64. Build it for linux/amd64.`);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
    expect(creates(w)).toEqual([]);

    push(w, 1);
    w.docker.appHttp = () => 503;
    w.docker.logs.set('wp-shop', 'listening on 8000\nError: no database\n');
    const second = w.deps.sites.create(parsed({ ...shopBody, health: { timeoutSec: 5 } }));
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, second.site.id)).run();
    const down = await finish(w, second.job.id);
    expect(down.status).toBe('failed');
    expect(down.error).toMatch(/^\/ did not answer 2xx within 1 s \(\d+ tries; last: 503 Error\)\.$/);
    expect(jobLog(w, second.job.id)).toContain("The container's last lines:\nlistening on 8000\nError: no database");
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
    expect(w.docker.containers.has('wp-shop')).toBe(false);
    expect(fs.existsSync(routesFile(w))).toBe(false);
    // The image it pulled went with it.
    expect(w.docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0])).toContain('sha256:img1');
  });

  it('takes its port from the image, and says so when the image has none to offer', async () => {
    const w = await world();
    push(w, 1, { exposedPorts: [] });
    const { job } = w.deps.sites.create(parsed(shopBody));
    const failed = await finish(w, job.id);
    expect(failed.error).toBe('The image exposes no port, and the app has none set: give the port it listens on.');
    const given = await createShop(w, { ...shopBody, port: 9000 });
    expect(settingsOf(w, given.id).port).toBe(9000);
  });
});

describe('deploying a container app', () => {
  it('holds its routes, swaps the container behind the gate, records the gap and keeps three images', async () => {
    const w = await world();
    const site = await createShop(w);
    let whileStarting = '';
    w.docker.onStart = (name) => {
      if (name === 'wp-shop') whileStarting = fs.readFileSync(routesFile(w), 'utf8');
    };
    const { app, headers } = await authed(w);
    for (const n of [2, 3, 4]) {
      push(w, n);
      const res = await app.inject({ method: 'POST', url: '/api/sites/shop/app/deploy', headers, payload: {} });
      expect(res.statusCode).toBe(202);
      const done = await finish(w, res.json().job.id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(JSON.parse(done.result!)).toMatchObject({ digest: digest(n), imageId: `sha256:img${n}` });
    }
    // Held while the new one started: every router kept, Traefik answering 503 itself.
    expect(whileStarting).toContain('servers: []');
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
    expect(w.deps.appRoutes.isHeld(site.id)).toBe(false);
    // The old one aside with the app's grace, so a worker in it can finish.
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer').map((c) => c.args)).toContainEqual(['wp-shop.previous', 20]);
    expect(creates(w).map((c) => c.image)).toEqual([1, 2, 3, 4].map((n) => `${REPO}@${digest(n)}`));
    const deploys = deploysOf(w, site.id);
    expect(deploys.map((d) => [d.origin, d.result])).toEqual([['create', 'ok'], ['user', 'ok'], ['user', 'ok'], ['user', 'ok']]);
    expect(deploys.slice(1).every((d) => d.gapMs !== null && d.gapMs >= 0)).toBe(true);
    expect(deploys.at(-1)!.actor).toBe('admin');
    // What runs and the two before it stay: a roll back's images.
    expect(w.docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0])).toEqual(['sha256:img1']);
    expect(settingsOf(w, site.id).digest).toBe(digest(4));
  });

  it('deploys nothing when the tag still names what runs', async () => {
    const w = await world();
    const site = await createShop(w);
    const job = await w.deps.apps.deploy('shop', {});
    const done = await finish(w, job.id);
    expect(JSON.parse(done.result!)).toEqual({ slug: 'shop', unchanged: true, digest: digest(1) });
    expect(creates(w)).toHaveLength(1);
    expect(deploysOf(w, site.id)).toHaveLength(1);
  });

  it('puts the old container back when the new one fails its check, and keeps its last lines', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    push(w, 2);
    w.docker.appHttp = () => 500;
    // The new container's own log: the old one took its log along when it went aside.
    w.docker.onStart = (name) => {
      if (name === 'wp-shop') w.docker.logs.set('wp-shop', 'booting\nTypeError: boom\n');
    };
    const job = await w.deps.apps.deploy('shop', {});
    const done = await finish(w, job.id);
    expect(done.status).toBe('failed');
    const failed = deploysOf(w, site.id).at(-1)!;
    expect([failed.result, failed.digest]).toEqual(['failed', digest(2)]);
    expect(failed.error).toMatch(/^\/ did not answer 2xx within 1 s/);
    expect(failed.logTail).toBe('booting\nTypeError: boom');
    // The old container has its name back and runs; the routes go to it again.
    expect(w.docker.calls.filter((c) => c.method === 'renameContainer').map((c) => c.args)).toEqual([
      ['wp-shop', 'wp-shop.previous'],
      ['wp-shop.previous', 'wp-shop'],
    ]);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(w.docker.containers.has('wp-shop.previous')).toBe(false);
    expect(settingsOf(w, site.id).digest).toBe(digest(1));
    expect(w.deps.appRoutes.isHeld(site.id)).toBe(false);
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
  });

  it('rolls back to an earlier deploy by its digest', async () => {
    const w = await world();
    const site = await createShop(w);
    push(w, 2);
    await finish(w, (await w.deps.apps.deploy('shop', {})).id);
    const first = deploysOf(w, site.id)[0]!;
    const back = await w.deps.apps.deploy('shop', { deployId: first.id });
    const done = await finish(w, back.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(creates(w).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'rollback', result: 'ok', digest: digest(1) });
    // The tag still names image 2: a roll back is not undone by the next check.
    expect(settingsOf(w, site.id).digest).toBe(digest(1));
  });
});

describe('the deploy hook', () => {
  it('queues a deploy for the token in its header, answers that one while it waits, and nothing else', async () => {
    const w = await world();
    await createShop(w);
    const { app, headers } = await authed(w);
    const made = await app.inject({ method: 'POST', url: '/api/sites/shop/app/deploy-token', headers });
    const { token } = made.json() as { token: string };
    expect(token).toMatch(/^wpl7d_[A-Za-z0-9_-]{43}$/);
    // Only its hash is kept.
    expect(JSON.stringify(w.db.select().from(appSettings).all())).not.toContain(token);
    const hook = (h: Record<string, string>) => app.inject({ method: 'POST', url: '/api/hooks/app-deploy', headers: h });
    const first = await hook({ 'x-wpl7-deploy-token': token });
    expect([first.statusCode, first.json().outcome]).toEqual([202, 'queued']);
    const second = await hook({ 'x-wpl7-deploy-token': token });
    expect([second.statusCode, second.json().outcome, second.json().jobId]).toEqual([202, 'waiting', first.json().jobId]);
    expect((await hook({ 'x-wpl7-deploy-token': `${token}x` })).statusCode).toBe(401);
    expect((await hook({})).statusCode).toBe(401);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'app.deploy')).all()).toHaveLength(1);
    // A new token ends the old one.
    await app.inject({ method: 'POST', url: '/api/sites/shop/app/deploy-token', headers });
    expect((await hook({ 'x-wpl7-deploy-token': token })).statusCode).toBe(401);
  });

  it('notes a call while the app is busy, and app-updates deploys it once it is free', async () => {
    const w = await world();
    const site = await createShop(w);
    const token = w.deps.apps.makeDeployToken('shop');
    const restart = w.deps.sites.action('shop', 'restart');
    expect(w.deps.apps.hook(token)).toMatchObject({ outcome: 'noted', job: null });
    expect(settingsOf(w, site.id).deployWantedAt).not.toBeNull();
    await finish(w, restart.id);
    push(w, 2);
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 1 });
    const deploy = w.db.select().from(jobs).where(eq(jobs.type, 'app.deploy')).get()!;
    expect(JSON.parse(deploy.payload)).toMatchObject({ origin: 'hook' });
    expect(settingsOf(w, site.id).deployWantedAt).toBeNull();
    // The restart used the app's grace.
    expect(w.docker.calls.filter((c) => c.method === 'restartContainer').map((c) => c.args)).toEqual([['wp-shop', 20]]);
  });
});

describe('backing up before a deploy', () => {
  it('reads Ask each time as yes for the deploys nobody is asked about', async () => {
    const w = await world();
    w.deps.settings.set('backupBeforeUpdates', 'ask');
    const site = await createShop(w);
    const first = (origin: 'auto' | 'hook' | 'user' | 'rollback', answer?: boolean) => w.deps.apps.backupFirstFor(site, origin, answer);
    expect([first('auto'), first('hook'), first('user'), first('user', false), first('rollback', false)]).toEqual([true, true, true, false, false]);
    w.deps.settings.set('backupBeforeUpdates', 'never');
    expect([first('auto'), first('user', true)]).toEqual([false, false]);
    w.deps.settings.set('backupBeforeUpdates', 'always');
    expect([first('hook'), first('user', false)]).toEqual([true, true]);
  });
});

describe('app-updates', () => {
  it('offers, leaves or deploys a new image under the tag, by the app’s mode, and asks only when due', async () => {
    const w = await world();
    const site = await createShop(w);
    const set = (v: Partial<typeof appSettings.$inferInsert>) => w.db.update(appSettings).set(v).where(eq(appSettings.siteId, site.id)).run();
    push(w, 2);
    set({ updateMode: 'ask', checkedAt: null });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect(settingsOf(w, site.id).pendingDigest).toBe(digest(2));
    // Not due again until its interval has passed.
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 0 });
    set({ updateMode: 'pinned', checkedAt: null });
    const asked = w.docker.calls.filter((c) => c.method === 'distribution').length;
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 0 });
    expect(w.docker.calls.filter((c) => c.method === 'distribution')).toHaveLength(asked);
    set({ updateMode: 'auto', checkedAt: null });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 1 });
    const job = w.db.select().from(jobs).where(eq(jobs.type, 'app.deploy')).get()!;
    expect(JSON.parse(job.payload)).toMatchObject({ origin: 'auto', backupFirst: false });
    const done = await finish(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ digest: digest(2), pendingDigest: '' });
  });

  it('notes why the registry could not be asked', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ registryToken: 'wrong', checkedAt: null }).where(eq(appSettings.siteId, site.id)).run();
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect(settingsOf(w, site.id).checkError).toMatch(/no basic auth credentials/);
  });
});

/** A `docker save` archive of one image that names itself `names`. */
async function archive(names: string[]): Promise<Buffer> {
  const tar = new TarWriter();
  const chunks: Buffer[] = [];
  tar.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise((r) => tar.on('end', r));
  await tar.addFile({ name: 'blobs/sha256/c', mode: 0o644, mtime: 0 }, Buffer.from('{}'));
  await tar.addFile({ name: 'manifest.json', mode: 0o644, mtime: 0 }, Buffer.from(JSON.stringify([{ Config: 'blobs/sha256/c', RepoTags: names, Layers: [] }])));
  await tar.finish();
  await ended;
  return Buffer.concat(chunks);
}

describe('an uploaded image', () => {
  it('is loaded under the panel’s own name, never one the archive gives itself, and used up', async () => {
    const w = await world();
    const { app, headers } = await authed(w);
    const bytes = await archive(['wpl7-wordpress:php8.3']);
    const id = 'upload-0123456789abcdef';
    const put = await app.inject({
      method: 'PUT',
      url: `/api/app-uploads/${id}?offset=0&size=${bytes.length}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect([put.statusCode, put.json()]).toEqual([200, { received: bytes.length, complete: true }]);
    w.docker.loadIds = ['sha256:upl1'];
    w.docker.imageConfigs.set('sha256:upl1', { exposedPorts: ['3000/tcp'] });
    const imageBefore = await w.docker.imageId('wpl7-wordpress:php8.3');
    const res = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: id } } });
    expect(res.statusCode).toBe(202);
    const done = await finish(w, res.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    // The site image keeps its name; the upload has the panel's.
    expect(await w.docker.imageId('wpl7-wordpress:php8.3')).toBe(imageBefore);
    expect(await w.docker.imageId(`wpl7-app-shop:u${id}`)).toBe('sha256:upl1');
    const site = w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    expect(settingsOf(w, site.id)).toMatchObject({ source: 'upload', updateMode: 'pinned', imageId: 'sha256:upl1', port: 3000, digest: '' });
    expect(creates(w).at(-1)!.image).toBe('sha256:upl1');
    expect(fs.existsSync(w.deps.apps.uploadPath(id))).toBe(false);
    // An upload goes once: it cannot be deployed again.
    const again = await app.inject({ method: 'POST', url: '/api/sites/shop/app/image', headers, payload: { uploadId: id } });
    expect([again.statusCode, again.json().error.message]).toEqual([409, 'No such upload: send the archive first.']);
  });

  it('refuses an archive of two images before a byte reaches the daemon', async () => {
    const w = await world();
    const id = 'upload-two-images-0001';
    fs.mkdirSync(w.deps.apps.uploadDir(), { recursive: true });
    const tar = new TarWriter();
    const chunks: Buffer[] = [];
    tar.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise((r) => tar.on('end', r));
    await tar.addFile({ name: 'manifest.json', mode: 0o644, mtime: 0 }, Buffer.from(JSON.stringify([{ Config: 'a', RepoTags: ['a:1'], Layers: [] }, { Config: 'b', RepoTags: ['b:1'], Layers: [] }])));
    await tar.finish();
    await ended;
    fs.writeFileSync(w.deps.apps.uploadPath(id), Buffer.concat(chunks));
    const { job } = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: id } }));
    const done = await finish(w, job.id);
    expect(done.error).toBe('The archive holds 2 images; upload one at a time.');
    expect(w.docker.calls.filter((c) => c.method === 'loadImage')).toEqual([]);
  });
});

describe('starting, stopping and deleting a container app', () => {
  it('stops with its grace and takes its routes away, and puts them back when it starts', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ stopGraceSec: 45 }).where(eq(appSettings.siteId, site.id)).run();
    await finish(w, w.deps.sites.action('shop', 'stop').id);
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer').map((c) => c.args)).toEqual([['wp-shop', 45]]);
    expect(fs.existsSync(routesFile(w))).toBe(false);
    await finish(w, w.deps.sites.action('shop', 'start').id);
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
  });

  it('goes with its routes file, container, images, database and folder', async () => {
    const w = await world();
    const site = await createShop(w);
    const done = await finish(w, w.deps.sites.delete('shop', false).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(fs.existsSync(routesFile(w))).toBe(false);
    expect(w.docker.containers.has('wp-shop')).toBe(false);
    expect(w.docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0])).toEqual(['sha256:img1']);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dropSiteDb').map((c) => c.args)).toEqual([['wp_shop', 'wp_shop']]);
    expect(fs.existsSync(appPaths(w.config, 'shop').root)).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    expect(w.db.select().from(appSettings).all()).toEqual([]);
  });

  it('keeps the site it borrows a path of from being deleted, moved or losing that domain', async () => {
    const w = await world();
    w.addSshServer('second', { publicIp: '203.0.113.21' });
    addPhpSite(w, 'blog', { domains: ['blog.example.com', 'www.blog.example.com'] });
    await createShop(w, { ...shopBody, routes: [{ host: 'shop.dev.example.test' }, { host: 'blog.example.com', match: 'prefix', path: '/api' }] });
    const refused = 'The container app "shop" has routes on blog.example.com, which belongs to "blog": change its routes first.';
    expect(() => w.deps.sites.delete('blog', false)).toThrow(refused);
    expect(() => w.deps.sites.move('blog', { targetServerId: w.servers.listRows().at(-1)!.id })).toThrow(refused);
    expect(() => w.deps.sites.updateDomains('blog', ['www.blog.example.com'], true, false)).toThrow(refused);
    // Another of its domains is its own business.
    expect(() => w.deps.sites.updateDomains('blog', ['blog.example.com'], true, false)).not.toThrow();
    expect(() => w.deps.sites.move('shop', { targetServerId: w.servers.listRows().at(-1)!.id })).toThrow('"shop" has routes on blog.example.com, which another site on this server holds: take them off first.');
  });
});

describe('after a panel that stopped half-way', () => {
  it('gives an app with its old container aside a recreate, which puts that one back first', async () => {
    const w = await world();
    const site = await createShop(w);
    await w.docker.renameContainer('wp-shop', 'wp-shop.previous');
    w.docker.containers.set('wp-shop.previous', 'exited');
    const sweep = await w.deps.apps.sweep(w.worker);
    expect(sweep.queued).toEqual(['shop']);
    const job = w.db.select().from(jobs).where(and(eq(jobs.type, 'site.reconcile'), eq(jobs.siteId, site.id))).get()!;
    const done = await finish(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(w.docker.containers.has('wp-shop.previous')).toBe(false);
    expect(creates(w).at(-1)).toMatchObject({ image: `${REPO}@${digest(1)}`, labels: appLabels('shop') });
    // A recreate is not a deploy.
    expect(deploysOf(w, site.id)).toHaveLength(1);
  });

  it('fails the deploy rows whose jobs a restart ended', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.insert(appDeploys).values({ siteId: site.id, startedAt: Date.now(), result: 'running', origin: 'auto', jobId: 999 }).run();
    expect(w.deps.apps.failInterruptedDeploys()).toBe(1);
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ result: 'failed', error: 'The panel stopped while this deploy ran.' });
  });
});
