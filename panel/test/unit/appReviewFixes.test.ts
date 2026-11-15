/**
 * What the reviews of container apps found, held here: a registry login stays with its registry,
 * by the rule a pull keeps, each new path of another site's domain asks Full, a failed deploy's
 * last lines are Manage's, a roll back or a restore is not undone by app-updates, an upload a
 * refused create or deploy took is let go and a mount's is cleared, a host another app routes on
 * stays, a new port is staged for the next image deployed or Recreate container and waits for a
 * deploy or recreate under way, a new user goes in with its container, the hook waits only for a
 * deploy of the tag, data paths keep clear of the mounts and the image's VOLUMEs stay, the
 * recreate is told nothing of a mount taken off, a move needs a Traefik that answers plain http
 * and the routes wait for it, an image copied to another repository is deployed from there, what
 * Traefik refused is on the app's page, a health path may carry a query, and the image's own user
 * is on the page beside the one the app runs as.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { AccessLevel } from '../../shared/access.js';
import { siteCreateBody, type AppDeployOrigin } from '../../shared/schemas.js';
import { appDeploys, appMounts, appRoutes, appSettings, jobs, servers, sites } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { UPLOAD_KEEP_MS } from '../../src/services/apps.js';
import { pullAuthFor } from '../../src/services/appImages.js';
import { appPaths } from '../../src/services/appSpec.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { addContainerApp, addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
/** A Traefik whose redirect a router on web can beat: one from this release's compose file. */
const PLAIN_HTTP_TRAEFIK = { cmd: ['--entrypoints.web.http.redirections.entrypoint.priority=1'], envSet: [] };

async function world(env: Record<string, string> = {}): Promise<TestWorld> {
  const w = await makeWorld({ env });
  w.deps.settings.set('backupBeforeUpdates', 'never');
  w.docker.containers.set(TRAEFIK_CONTAINER, 'running');
  w.docker.containerConfigs.set(TRAEFIK_CONTAINER, PLAIN_HTTP_TRAEFIK);
  return w;
}

/** Deploys a step apart, in the order they are written: what "newer" means here. */
let clock = Date.now() - 3600_000;
function deployRow(w: TestWorld, siteId: number, row: { digest: string; origin: AppDeployOrigin; result?: 'ok' | 'failed'; logTail?: string; reference?: string }) {
  clock += 1000;
  return w.db
    .insert(appDeploys)
    .values({ siteId, reference: row.reference ?? REF, digest: row.digest, imageId: '', startedAt: clock, result: row.result ?? 'ok', origin: row.origin, logTail: row.logTail ?? null })
    .returning()
    .get();
}

/** The app "shop" as its create leaves it: image 1 runs, deployed by the create. */
function shop(w: TestWorld, opts: Parameters<typeof addContainerApp>[2] = {}) {
  const site = addContainerApp(w, 'shop', { ...opts, settings: { reference: REF, digest: digest(1), imageId: 'sha256:img1', ...opts.settings } });
  deployRow(w, site.id, { digest: digest(1), origin: 'create' });
  return site;
}

/** The API, with a key of each level. */
async function api(w: TestWorld) {
  const { app } = await makeApp(w);
  const key = (access: AccessLevel) => ({ authorization: `Bearer ${w.deps.apiKeys.create(access, access).token}` });
  return { app, read: key('read'), manage: key('manage'), full: key('full') };
}

const settingsOf = (w: TestWorld, siteId: number) => w.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get()!;
const deployJobs = (w: TestWorld) => w.db.select().from(jobs).where(eq(jobs.type, 'app.deploy')).all();
const routesFile = (w: TestWorld, slug = 'shop') => path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName(slug));

function mailbox(w: TestWorld): string[] {
  const sent: string[] = [];
  w.core.settings.set('alertEmail', 'ops@example.com');
  w.core.mail.notifyOperator = async (subject) => {
    sent.push(subject);
    return true;
  };
  return sent;
}

describe('a registry login', () => {
  it('stays with its registry: a reference on another one drops it, Docker Hub by any of its names keeps it', async () => {
    const w = await world();
    const site = shop(w, { settings: { registryUser: 'ci', registryToken: 'reg-token-secret' } });
    const login = () => [settingsOf(w, site.id).registryUser, settingsOf(w, site.id).registryToken];
    w.deps.apps.patch('shop', { reference: 'ghcr.io/example/shop:next' });
    expect(login()).toEqual(['ci', 'reg-token-secret']);
    w.deps.apps.patch('shop', { reference: 'registry.example.com/example/shop:stable' });
    expect(login()).toEqual(['', '']);
    expect(w.deps.apps.detail(site)).toMatchObject({ registryUser: '', registryToken: { secret: true, set: false } });
    // The next check asks the new registry without it.
    w.docker.publish('registry.example.com/example/shop:stable', digest(2));
    await w.deps.apps.updatesTick();
    expect(w.docker.calls.filter((c) => c.method === 'distribution').map((c) => c.args)).toEqual([['registry.example.com/example/shop:stable']]);

    w.db.update(appSettings).set({ reference: 'example/shop:stable', registryUser: 'ci', registryToken: 'hub-token' }).where(eq(appSettings.siteId, site.id)).run();
    for (const reference of ['docker.io/example/shop:stable', 'index.docker.io/example/shop:2', 'registry-1.docker.io/example/shop:3', 'example/shop:4']) {
      w.deps.apps.patch('shop', { reference });
      expect(login(), reference).toEqual(['ci', 'hub-token']);
    }
    w.deps.apps.patch('shop', { reference: 'localhost:5000/example/shop:1' });
    expect(login()).toEqual(['', '']);
  });

  it('is kept by a new reference exactly when a pull by that reference sends it: one rule for both', async () => {
    const w = await world();
    const site = shop(w);
    const references = [
      'ghcr.io/example/shop:next',
      'ghcr.io:443/example/shop:next',
      'registry.example.com/example/shop:1',
      'localhost:5000/example/shop:1',
      'example/shop:1',
      'nginx:1',
      'docker.io/library/nginx:1',
      'index.docker.io/example/shop:1',
      'registry-1.docker.io/example/shop:1',
    ];
    for (const from of [REF, 'example/shop:stable', 'localhost:5000/example/shop:stable']) {
      for (const reference of references) {
        const app = { reference: from, registryUser: 'ci', registryToken: 'reg-token-secret' };
        w.db.update(appSettings).set(app).where(eq(appSettings.siteId, site.id)).run();
        w.deps.apps.patch('shop', { reference });
        expect(settingsOf(w, site.id).registryToken !== '', `${from} -> ${reference}`).toBe(pullAuthFor(app, reference) !== undefined);
      }
    }
  });
});

describe('a path of another site’s domain', () => {
  const own = { host: 'shop.example.com' };
  const lent = (over: Record<string, unknown> = {}) => ({ host: 'blog.example.com', match: 'prefix', path: '/api', scheme: 'both', ...over });

  async function borrowing() {
    const w = await world();
    addPhpSite(w, 'blog', { domains: ['blog.example.com'] });
    shop(w, { domains: ['shop.example.com', 'shop.dev.example.test'], routes: [own, { host: 'blog.example.com', match: 'prefix', path: '/api', scheme: 'both' }] });
    const keys = await api(w);
    const put = (headers: Record<string, string>, routes: unknown[]) => keys.app.inject({ method: 'PUT', url: '/api/sites/shop/app/routes', headers, payload: { routes } });
    return { w, ...keys, put };
  }

  it('asks Full for each new or changed route there, not once for the host', async () => {
    const { put, manage, full } = await borrowing();
    // Switched off, or narrowed: nothing of the blog's it did not have.
    expect((await put(manage, [own, lent({ enabled: false })])).statusCode).toBe(200);
    expect((await put(manage, [own, lent({ scheme: 'https' })])).statusCode).toBe(200);
    for (const routes of [
      [own, lent({ scheme: 'both' })],
      [own, lent({ scheme: 'https', path: '/api/v2' })],
      [own, lent({ scheme: 'https', match: 'exact' })],
      [own, lent({ scheme: 'https' }), lent({ scheme: 'https', path: '/shop' })],
    ]) {
      const res = await put(manage, routes);
      expect([res.statusCode, res.json().error?.message], JSON.stringify(routes)).toEqual([403, expect.stringContaining("a route on another site's domain (blog.example.com) needs Full")]);
    }
    expect((await put(full, [own, lent({ path: '/api/v2' })])).statusCode).toBe(200);
  });

  it('is never all of it: a prefix of / there is refused at any level, as it is at a create', async () => {
    const { put, app, manage, full } = await borrowing();
    const res = await put(full, [own, lent({ path: '/' })]);
    expect([res.statusCode, res.json().error.message]).toEqual([409, 'blog.example.com belongs to "blog": a route there takes a path of it, not all of it.']);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: full,
      payload: { title: 'Other', slug: 'other', app: 'container', image: { reference: REF }, routes: [{ host: 'blog.example.com', match: 'prefix', path: '/' }] },
    });
    expect([created.statusCode, created.json().error.message]).toEqual([409, 'blog.example.com belongs to "blog": a route there takes a path of it, not all of it.']);
    // A prefix of / on a host of its own is its own business.
    expect((await put(manage, [{ ...own, match: 'prefix', path: '/' }])).statusCode).toBe(200);
  });
});

describe('a failed deploy’s last lines', () => {
  it('are on every answer that lists deploys from Manage up, and on none below', async () => {
    const w = await world();
    const site = shop(w);
    deployRow(w, site.id, { digest: digest(2), origin: 'user', result: 'failed', logTail: 'connecting to mysql://shop:db-secret@mariadb/shop' });
    const { app, read, manage, full } = await api(w);
    type Listed = { result: string; logTail: string | null }[];
    const lists: [string, (body: { container: { deploys: Listed }; deploys: Listed; items: Listed }) => Listed][] = [
      ['/api/sites/shop', (b) => b.container.deploys],
      ['/api/sites/shop/app', (b) => b.deploys],
      ['/api/sites/shop/app/deploys', (b) => b.items],
    ];
    for (const [url, deploys] of lists) {
      const asRead = await app.inject({ method: 'GET', url, headers: read });
      expect(asRead.statusCode, url).toBe(200);
      expect(asRead.body, url).not.toContain('db-secret');
      expect(deploys(asRead.json())[0], url).toMatchObject({ result: 'failed', logTail: null });
      for (const headers of [manage, full]) {
        expect(deploys((await app.inject({ method: 'GET', url, headers })).json())[0]!.logTail, url).toContain('db-secret');
      }
    }
    // Asked for nothing, the service gives none.
    expect(w.deps.apps.detail(site).deploys[0]!.logTail).toBeNull();
    expect(w.deps.apps.deploys(site)[0]!.logTail).toBeNull();
  });
});

describe('app-updates after a roll back or a restore', () => {
  const due = (w: TestWorld, siteId: number, v: Partial<typeof appSettings.$inferInsert> = {}) =>
    w.db.update(appSettings).set({ checkedAt: null, ...v }).where(eq(appSettings.siteId, siteId)).run();

  it('leaves what a roll back put back in place, and goes on with the next image the tag names', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = shop(w);
    deployRow(w, site.id, { digest: digest(2), origin: 'auto' });
    deployRow(w, site.id, { digest: digest(1), origin: 'rollback' });
    w.docker.publish(REF, digest(2));
    due(w, site.id, { updateMode: 'auto' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    // Ask first offers it neither, and an offer of it is taken back.
    due(w, site.id, { updateMode: 'ask', pendingDigest: digest(2) });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect(settingsOf(w, site.id).pendingDigest).toBe('');
    expect(sent).toEqual([]);
    expect(deployJobs(w)).toEqual([]);
    // Deploy now deploys what the tag names all the same.
    const now = await w.deps.apps.deploy('shop', {});
    expect(JSON.parse(now.payload)).toMatchObject({ origin: 'user' });
    w.db.delete(jobs).where(eq(jobs.id, now.id)).run();
    // A new image under the tag is offered, and deployed, as any is.
    w.docker.publish(REF, digest(3));
    due(w, site.id, { updateMode: 'ask' });
    await w.deps.apps.updatesTick();
    expect([settingsOf(w, site.id).pendingDigest, sent.length]).toEqual([digest(3), 1]);
    due(w, site.id, { updateMode: 'auto' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 1 });
    expect(JSON.parse(deployJobs(w)[0]!.payload)).toMatchObject({ origin: 'auto' });
  });

  it('leaves an image a restore put back in place too', async () => {
    const w = await world();
    const site = shop(w);
    deployRow(w, site.id, { digest: digest(2), origin: 'hook' });
    deployRow(w, site.id, { digest: digest(1), origin: 'restore' });
    w.docker.publish(REF, digest(2));
    due(w, site.id);
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    // Once the image went in again after it, by Deploy now, it is no longer put back.
    deployRow(w, site.id, { digest: digest(2), origin: 'user' });
    deployRow(w, site.id, { digest: digest(1), origin: 'user' });
    due(w, site.id);
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 1 });
  });

  it('offers no image whose deploy failed, for an app that asks first', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = shop(w);
    deployRow(w, site.id, { digest: digest(2), origin: 'user', result: 'failed' });
    w.docker.publish(REF, digest(2));
    due(w, site.id, { updateMode: 'ask' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect([settingsOf(w, site.id).pendingDigest, sent]).toEqual(['', []]);
  });
});

describe('an uploaded archive', () => {
  const ID = 'upload-0123456789abcdef';

  function uploaded(w: TestWorld): void {
    fs.mkdirSync(w.deps.apps.uploadDir(), { recursive: true });
    fs.writeFileSync(w.deps.apps.uploadPath(ID), 'archive');
  }

  it('is let go by a create that is refused, for another to take', async () => {
    const w = await world();
    uploaded(w);
    // A name a site has that holds no dev hostname: only the insert itself finds it taken.
    addPhpSite(w, 'shop', { domains: ['shop.example.org'] });
    expect(() => w.deps.sites.create(siteCreateBody.parse({ title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: ID } }))).toThrow(
      'Site name "shop" is already taken',
    );
    expect(() => w.deps.apps.assertUploadFree(ID)).not.toThrow();
    expect(() => w.deps.sites.create(siteCreateBody.parse({ title: 'Shop', slug: 'shop-2', app: 'container', image: { uploadId: ID } }))).not.toThrow();
  });

  it('is let go by a deploy the queue refuses', async () => {
    const w = await world();
    uploaded(w);
    addContainerApp(w, 'pics', { settings: { source: 'upload', reference: '', updateMode: 'pinned', imageId: 'sha256:upl1' } });
    w.deps.sites.action('pics', 'restart');
    await expect(w.deps.apps.deployUpload('pics', ID)).rejects.toThrow(/already has an active job/);
    expect(() => w.deps.apps.assertUploadFree(ID)).not.toThrow();
  });

  it('for a mount is cleared once a day has passed and no fill has taken it, on each server that answers', async () => {
    const w = await world();
    addContainerApp(w, 'shop');
    const far = w.addSshServer('far-box', { publicIp: '203.0.113.20' });
    addContainerApp(w, 'far', { serverId: far.id });
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, far.id)).run();
    const p = appPaths(w.config, 'shop');
    const [stale, taken, fresh] = ['mount-upload-0000000001', 'mount-upload-0000000002', 'mount-upload-0000000003'];
    const dir = path.dirname(p.mountUpload(stale));
    const farUpload = appPaths(w.config, 'far').mountUpload(stale);
    for (const file of [p.mountUpload(stale), p.mountUpload(taken), p.mountUpload(fresh), path.join(dir, 'notes.txt'), farUpload]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'archive');
    }
    const dayAgo = (Date.now() - UPLOAD_KEEP_MS - 60_000) / 1000;
    for (const file of [p.mountUpload(stale), p.mountUpload(taken), path.join(dir, 'notes.txt'), farUpload]) fs.utimesSync(file, dayAgo, dayAgo);
    w.deps.apps.claimUpload(`mount:${taken}`);

    expect(await w.deps.apps.removeStaleMountUploads()).toBe(1);
    expect([stale, taken, fresh].map((id) => fs.existsSync(p.mountUpload(id)))).toEqual([false, true, true]);
    expect([fs.existsSync(path.join(dir, 'notes.txt')), fs.existsSync(farUpload)]).toEqual([true, true]);
    // app-updates clears them, as it clears the image uploads.
    w.deps.apps.releaseUpload(`mount:${taken}`);
    await w.deps.schedulers.runNow('app-updates', 'full');
    expect(fs.existsSync(p.mountUpload(taken))).toBe(false);
  });
});

describe('a host of an app’s own', () => {
  it('stays in its routes while another app borrows a path of it', async () => {
    const w = await world();
    addContainerApp(w, 'shop', { domains: ['shop.example.com', 'shop.dev.example.test'], routes: [{ host: 'shop.example.com' }] });
    addContainerApp(w, 'orders', {
      domains: ['orders.dev.example.test'],
      routes: [{ host: 'orders.dev.example.test' }, { host: 'shop.example.com', match: 'prefix', path: '/orders' }],
    });
    const { app, full } = await api(w);
    const put = (routes: unknown[]) => app.inject({ method: 'PUT', url: '/api/sites/shop/app/routes', headers: full, payload: { routes } });
    const res = await put([{ host: 'shop.dev.example.test' }]);
    expect([res.statusCode, res.json().error.message]).toEqual([
      409,
      'The container app "orders" has routes on shop.example.com, which belongs to "shop": change its routes first.',
    ]);
    expect((await put([{ host: 'shop.example.com' }, { host: 'shop.dev.example.test' }])).statusCode).toBe(200);
  });
});

describe('a new port or user', () => {
  it('a port of an app that runs is staged for the next image deployed or Recreate container, queues nothing, and the routes keep the port that answers', async () => {
    const w = await world();
    const site = shop(w);
    const { app, manage, read } = await api(w);
    const res = await app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload: { port: 9000 } });
    expect([res.statusCode, res.json().job]).toEqual([200, null]);
    expect(w.db.select().from(jobs).all()).toEqual([]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    expect(res.json().app).toMatchObject({ port: 8000, pending: { port: 9000 } });
    expect((await app.inject({ method: 'GET', url: '/api/sites/shop/app', headers: read })).json().pending).toEqual({ port: 9000 });
    await w.deps.appRoutes.idle();
    await w.deps.appRoutes.syncServer(1);
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
    // Another change's recreate carries no port, and the port stays staged.
    const env = await app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload: { env: [{ name: 'MODE', value: 'live' }] } });
    expect(env.statusCode).toBe(202);
    const job = w.db.select().from(jobs).where(eq(jobs.id, env.json().job.id)).get()!;
    expect([job.type, JSON.parse(job.payload)]).toEqual(['site.reconcile', { siteId: site.id }]);
    expect([settingsOf(w, site.id).nextPort, w.deps.apps.detail(site).pending]).toEqual([9000, { port: 9000 }]);
  });

  it('goes back to none with the running port sent back; a user is a change from the one the recreate carries', async () => {
    const w = await world();
    const site = shop(w);
    const { app, manage } = await api(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload });
    expect((await patch({ port: 9000 })).json().app.pending).toEqual({ port: 9000 });
    // The running port back: nothing is staged.
    const back = await patch({ port: 8000 });
    expect([back.statusCode, back.json().job, back.json().app.pending]).toEqual([200, null, null]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 0 });
    // Beside a user, the port is staged and the user goes to the recreate.
    const first = await patch({ port: 9000, hardening: { runAs: '1000:1000' } });
    expect(first.statusCode).toBe(202);
    const job = w.db.select().from(jobs).where(eq(jobs.id, first.json().job.id)).get()!;
    expect([job.type, JSON.parse(job.payload)]).toEqual(['site.reconcile', { siteId: site.id, appRunAs: '1000:1000' }]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000, runAs: '' });
    expect(first.json().app).toMatchObject({ port: 8000, hardening: { runAs: '' }, pending: { port: 9000, runAs: '1000:1000' } });
    // The saved user back is a change, which waits for that job; the staged port again is none.
    const user = await patch({ hardening: { runAs: '' } });
    expect([user.statusCode, user.json().error?.code]).toEqual([409, 'job_conflict']);
    const again = await patch({ port: 9000 });
    expect([again.statusCode, again.json().job]).toEqual([200, null]);
    expect(w.db.select().from(jobs).all().map((j) => j.id)).toEqual([job.id]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000, runAs: '' });
    expect(w.deps.apps.detail(site).pending).toEqual({ port: 9000, runAs: '1000:1000' });
  });

  it('a port is saved at once on an app that is stopped, and one staged before goes', async () => {
    const w = await world();
    const site = shop(w, { status: 'stopped', settings: { nextPort: 7000 } });
    expect(w.deps.apps.patch('shop', { port: 9000 })).toEqual({ job: null });
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    expect(w.deps.apps.detail(site).pending).toBeNull();
    // A user still goes in with the recreate, and the port does not go with it.
    const { job } = w.deps.apps.patch('shop', { port: 9100, hardening: { runAs: '1000:1000' } });
    expect(JSON.parse(job!.payload)).toEqual({ siteId: site.id, appRunAs: '1000:1000' });
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9100, nextPort: 0, runAs: '' });
  });

  it('is saved at once for an app that has no container to put it into', async () => {
    const w = await world();
    const site = shop(w, { status: 'error' });
    expect(w.deps.apps.patch('shop', { port: 9000, hardening: { runAs: '1000:1000' } })).toEqual({ job: null });
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0, runAs: '1000:1000' });
  });

  /**
   * Runs `check` while a deploy of "shop", then its Recreate container, is queued and then running.
   * Each is over before the next is queued, as one job per site has it.
   */
  async function underWay(w: TestWorld, check: (job: { id: number; type: string }, status: string) => Promise<void>) {
    for (const start of [() => w.deps.apps.deploy('shop', {}), async () => w.deps.sites.reconcile('shop')]) {
      const job = await start();
      for (const status of ['queued', 'running']) {
        w.db.update(jobs).set({ status }).where(eq(jobs.id, job.id)).run();
        await check(job, status);
      }
      w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, job.id)).run();
    }
  }
  const busy = (job: { id: number; type: string }) => ({ code: 'job_conflict', message: `Site "shop" already has an active job (#${job.id} ${job.type}); wait for it to finish` });

  it('is refused on an app that does not run while a deploy or recreate is under way, which read the port as it started', async () => {
    for (const status of ['stopped', 'error']) {
      const w = await world();
      const site = shop(w, { status });
      const { app, manage } = await api(w);
      const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload });
      await underWay(w, async (job, jobStatus) => {
        const res = await patch({ port: 9000 });
        expect([res.statusCode, res.json().error], `${status} app, ${job.type} ${jobStatus}`).toEqual([409, busy(job)]);
        // The port it has is no change, and is not refused.
        expect((await patch({ port: 8000 })).statusCode).toBe(200);
        expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 0 });
      });
      const res = await patch({ port: 9000 });
      expect([res.statusCode, settingsOf(w, site.id).port], `${status} app`).toEqual([200, 9000]);
    }
  });

  it('is refused on an app that runs while a deploy or recreate is under way, a port taken back as well as a new one', async () => {
    const w = await world();
    const site = shop(w, { settings: { nextPort: 9000 } });
    const { app, manage } = await api(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload });
    await underWay(w, async (job, jobStatus) => {
      // The running port back would be undone by the job's save of the staged one.
      for (const port of [8000, 9100]) {
        const res = await patch({ port });
        expect([res.statusCode, res.json().error], `${job.type} ${jobStatus}, port ${port}`).toEqual([409, busy(job)]);
      }
      // The staged one again is no change.
      expect((await patch({ port: 9000 })).statusCode).toBe(200);
      expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    });
    const back = await patch({ port: 8000 });
    expect([back.statusCode, settingsOf(w, site.id).nextPort]).toEqual([200, 0]);
  });

  it('refuses data folders and mounts of an app with no container while a deploy is under way, which would write its own over them', async () => {
    const w = await world();
    const site = shop(w, { status: 'error' });
    const { app, manage } = await api(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload });
    await underWay(w, async (job, jobStatus) => {
      for (const payload of [{ dataPaths: ['/var/lib/shop'] }, { mounts: [{ name: 'keys', path: '/run/keys', writable: false, inBackups: true }] }]) {
        const res = await patch(payload);
        expect([res.statusCode, res.json().error], `${job.type} ${jobStatus}, ${Object.keys(payload)[0]}`).toEqual([409, busy(job)]);
      }
    });
    expect([settingsOf(w, site.id).dataPaths, w.db.select().from(appMounts).where(eq(appMounts.siteId, site.id)).all()]).toEqual(['[]', []]);
    expect((await patch({ dataPaths: ['/var/lib/shop'] })).statusCode).toBe(200);
  });
});

describe('the deploy hook', () => {
  it('waits only for a deploy of the tag: a roll back that waits gets the call noted', async () => {
    const w = await world();
    const site = shop(w);
    const created = w.db.select().from(appDeploys).where(eq(appDeploys.siteId, site.id)).get()!;
    const token = w.deps.apps.makeDeployToken('shop');
    const back = await w.deps.apps.deploy('shop', { deployId: created.id });
    expect(w.deps.apps.hook(token)).toMatchObject({ outcome: 'noted', job: null });
    expect(settingsOf(w, site.id).deployWantedAt).not.toBeNull();
    // Once the roll back is over, the tag is deployed; a call meanwhile waits for that deploy.
    w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, back.id)).run();
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 1 });
    const hooked = deployJobs(w).find((j) => j.id !== back.id)!;
    expect(JSON.parse(hooked.payload)).toEqual({ siteId: site.id, origin: 'hook', backupFirst: false });
    expect(w.deps.apps.hook(token)).toMatchObject({ outcome: 'waiting', job: { id: hooked.id } });
  });

  it('waits for no upload’s deploy either', async () => {
    const w = await world();
    const site = shop(w);
    const token = w.deps.apps.makeDeployToken('shop');
    w.worker.enqueue('app.deploy', { siteId: site.id, origin: 'upload', uploadId: 'upload-0123456789abcdef' }, { id: site.id, slug: 'shop', serverId: 1 });
    expect(w.deps.apps.hook(token)).toMatchObject({ outcome: 'noted', job: null });
  });

  it('is for no app that runs an uploaded image, which has no tag', async () => {
    const w = await world();
    const pics = addContainerApp(w, 'pics', { settings: { source: 'upload', reference: '', updateMode: 'pinned', imageId: 'sha256:upl1' } });
    const { app, full } = await api(w);
    const res = await app.inject({ method: 'POST', url: '/api/sites/pics/app/deploy-token', headers: full });
    expect([res.statusCode, res.json().error.message]).toEqual([409, '"pics" runs an uploaded image, which has no tag for a hook to deploy: upload a new one to deploy it.']);
    // A token made before that opens nothing, and a call noted then deploys nothing.
    const token = `wpl7d_${'a'.repeat(43)}`;
    w.db.update(appSettings).set({ deployTokenHash: sha256Hex(token), deployWantedAt: Date.now() }).where(eq(appSettings.siteId, pics.id)).run();
    expect(w.deps.apps.hook(token)).toBeNull();
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 0 });
    expect(settingsOf(w, pics.id).deployWantedAt).toBeNull();
    expect(deployJobs(w)).toEqual([]);
  });
});

describe('data paths', () => {
  it('are checked against the mounts the app keeps when they change alone', async () => {
    const w = await world();
    const site = shop(w);
    w.db.insert(appMounts).values({ siteId: site.id, name: 'secrets', containerPath: '/run/secrets/app' }).run();
    expect(() => w.deps.apps.patch('shop', { dataPaths: ['/var/lib/shop', '/run/secrets/app'] })).toThrow('/run/secrets/app is mounted twice.');
    expect(settingsOf(w, site.id).dataPaths).toBe('[]');
    expect(w.db.select().from(jobs).all()).toEqual([]);
    expect(w.deps.apps.patch('shop', { dataPaths: ['/var/lib/shop'] }).job).not.toBeNull();
  });

  /** "shop" with a VOLUME of its image's, one its image no longer declares, and one of its own. */
  function withImageVolume(w: TestWorld) {
    return shop(w, {
      settings: {
        dataPaths: JSON.stringify([
          { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true },
          { path: '/var/cache/shop', dir: 'var-cache-shop', fromImage: false },
          { path: '/srv/uploads', dir: 'srv-uploads', fromImage: false },
        ]),
      },
    });
  }
  /** The recreate a change queued, over: the next change may queue its own. */
  const over = (w: TestWorld, job: { id: number } | null) => w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, job!.id)).run();
  const IMAGE_VOLUME = { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true };

  it('keep a VOLUME of the image’s that a list leaves out, and drop one its image no longer declares', async () => {
    const w = await world();
    const site = withImageVolume(w);
    over(w, w.deps.apps.patch('shop', { dataPaths: ['/srv/uploads', '/srv/reports'] }).job);
    expect(w.deps.apps.detail(site).dataPaths).toEqual([
      { path: '/srv/uploads', dir: 'srv-uploads', fromImage: false },
      { path: '/srv/reports', dir: 'srv-reports', fromImage: false },
      IMAGE_VOLUME,
    ]);
    over(w, w.deps.apps.patch('shop', { dataPaths: [] }).job);
    expect(w.deps.apps.detail(site).dataPaths).toEqual([IMAGE_VOLUME]);
    // Named, it stays where the list puts it, with its folder.
    w.deps.apps.patch('shop', { dataPaths: ['/var/lib/shop', '/srv/uploads'] });
    expect(w.deps.apps.detail(site).dataPaths).toEqual([IMAGE_VOLUME, { path: '/srv/uploads', dir: 'srv-uploads', fromImage: false }]);
  });

  it('let a mount take the place of a VOLUME of the image’s: the recreate has a bind there all the same', async () => {
    const w = await world();
    const site = withImageVolume(w);
    const seed = { name: 'seed', path: '/var/lib/shop', writable: true, inBackups: true };
    expect(() => w.deps.apps.patch('shop', { mounts: [seed] })).toThrow('/var/lib/shop is mounted twice.');
    expect(w.deps.apps.patch('shop', { dataPaths: ['/srv/uploads'], mounts: [seed] }).job).not.toBeNull();
    expect(w.deps.apps.detail(site)).toMatchObject({
      dataPaths: [{ path: '/srv/uploads', dir: 'srv-uploads', fromImage: false }],
      mounts: [{ name: 'seed', path: '/var/lib/shop' }],
    });
  });
});

describe('a mount taken off', () => {
  it('goes from the rows at once, and its recreate is told nothing of it: a swap that passes takes the folders no mount names', async () => {
    const w = await world();
    const site = shop(w);
    const p = appPaths(w.config, 'shop');
    for (const [name, containerPath] of [['secrets', '/run/secrets/app'], ['media', '/srv/media']] as const) {
      w.db.insert(appMounts).values({ siteId: site.id, name, containerPath }).run();
      fs.mkdirSync(p.mountDir(name), { recursive: true });
    }
    const { app, manage } = await api(w);
    const res = await app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload: { mounts: [{ name: 'media', path: '/srv/media', writable: true }] } });
    expect(res.statusCode).toBe(202);
    const job = w.db.select().from(jobs).where(eq(jobs.id, res.json().job.id)).get()!;
    expect([job.type, JSON.parse(job.payload)]).toEqual(['site.reconcile', { siteId: site.id }]);
    expect(res.json().app.mounts.map((m: { name: string }) => m.name)).toEqual(['media']);
    // Its folder is the old container's, the way back, until a new one has passed.
    expect(fs.existsSync(p.mountDir('secrets'))).toBe(true);
  });
});

describe('moving an app', () => {
  it('is refused before anything is queued when the target’s Traefik cannot answer its plain http routes', async () => {
    const w = await world({ TLS_MODE: 'letsencrypt' });
    const target = w.addSshServer('second', { publicIp: '203.0.113.21' });
    target.docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: [], envSet: [] });
    const site = addContainerApp(w, 'shop', { routes: [{ host: 'shop.example.test', scheme: 'both' }] });
    const { app, full } = await api(w);
    const move = () => app.inject({ method: 'POST', url: '/api/sites/shop/move', headers: full, payload: { targetServerId: target.id } });
    const res = await move();
    expect([res.statusCode, res.json().error.message]).toEqual([409, 'Traefik on "second" is from before plain http routes. Update the server, then try again.']);
    expect(w.db.select().from(jobs).all()).toEqual([]);
    // A route that is switched off answers nothing there.
    w.db.update(appRoutes).set({ enabled: 0 }).where(and(eq(appRoutes.siteId, site.id), eq(appRoutes.scheme, 'both'))).run();
    expect((await move()).statusCode).toBe(202);
  });

  /** "shop", https only, about to move to a server whose Traefik cannot answer plain http. */
  async function leaving() {
    const w = await world({ TLS_MODE: 'letsencrypt' });
    const target = w.addSshServer('second', { publicIp: '203.0.113.21' });
    target.docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: [], envSet: [] });
    const site = addContainerApp(w, 'shop', { routes: [{ host: 'shop.example.test' }] });
    const { app, full } = await api(w);
    // Plain http passes the check of the server it leaves, which is where the app is until the cutover.
    const put = () => app.inject({ method: 'PUT', url: '/api/sites/shop/app/routes', headers: full, payload: { routes: [{ host: 'shop.example.test', scheme: 'both' }] } });
    const schemes = () => w.db.select({ scheme: appRoutes.scheme }).from(appRoutes).where(eq(appRoutes.siteId, site.id)).all().map((r) => r.scheme);
    return { w, target, app, full, put, schemes };
  }

  it('keeps the app’s routes as they are until it is done', async () => {
    const { w, target, app, full, put, schemes } = await leaving();
    const moved = await app.inject({ method: 'POST', url: '/api/sites/shop/move', headers: full, payload: { targetServerId: target.id } });
    expect(moved.statusCode).toBe(202);
    const moveId = moved.json().job.id as number;
    for (const status of ['queued', 'running']) {
      w.db.update(jobs).set({ status }).where(eq(jobs.id, moveId)).run();
      const res = await put();
      expect([res.statusCode, res.json().error], status).toEqual([409, { code: 'job_conflict', message: `"shop" is moving (job #${moveId}): change its routes once the move is done.` }]);
    }
    expect(schemes()).toEqual(['https']);
    // Once it is over, they change as ever.
    w.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, moveId)).run();
    expect((await put()).statusCode).toBe(200);
    expect(schemes()).toEqual(['both']);
  });

  it('keeps them from a change that was being checked when the move was queued', async () => {
    const { w, target, put, schemes } = await leaving();
    const ask = w.deps.apps.assertHttpRoutesOn.bind(w.deps.apps);
    vi.spyOn(w.deps.apps, 'assertHttpRoutesOn').mockImplementationOnce(async (serverId, routes) => {
      await ask(serverId, routes);
      // The move's own check read the routes as they were: https only.
      w.deps.sites.move('shop', { targetServerId: target.id });
    });
    const res = await put();
    const moveId = w.db.select().from(jobs).where(eq(jobs.type, 'site.move')).get()!.id;
    expect([res.statusCode, res.json().error?.message]).toEqual([409, `"shop" is moving (job #${moveId}): change its routes once the move is done.`]);
    expect(schemes()).toEqual(['https']);
  });

  it('stops before anything changes when a route saved while the request was asking needs plain http', async () => {
    const { w, target, schemes } = await leaving();
    const route = w.db.select().from(appRoutes).where(eq(appRoutes.host, 'shop.example.test')).get()!;
    // Queued after the request's own check, as the race leaves it: the route went in meanwhile.
    const job = w.deps.sites.move('shop', { targetServerId: target.id });
    w.db.update(appRoutes).set({ scheme: 'both' }).where(eq(appRoutes.id, route.id)).run();
    w.worker.start();
    await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 20_000);
    await w.worker.stop();
    const done = w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect([done.status, done.error]).toEqual(['failed', 'Traefik on "second" is from before plain http routes. Update the server, then try again.']);
    expect(schemes()).toEqual(['both']);
    expect(w.db.select({ serverId: sites.serverId }).from(sites).where(eq(sites.slug, 'shop')).get()).toEqual({ serverId: 1 });
    expect(target.docker.containers.has('wp-shop')).toBe(false);
  });
});

describe('an image copied to another repository', () => {
  const MOVED = 'registry.example.com/example/shop:stable';
  const due = (w: TestWorld, siteId: number, v: Partial<typeof appSettings.$inferInsert> = {}) =>
    w.db.update(appSettings).set({ checkedAt: null, ...v }).where(eq(appSettings.siteId, siteId)).run();

  it('is deployed from there by Automatic, once, and left to Deploy now by Ask first and Pinned', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = shop(w, { settings: { registryUser: 'ci', registryToken: 'reg-token-secret' } });
    // The same image under the new reference: what runs still comes from ghcr.io, whose login went with the old one.
    w.deps.apps.patch('shop', { reference: MOVED });
    w.docker.publish(MOVED, digest(1));
    due(w, site.id, { updateMode: 'ask' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect([settingsOf(w, site.id).pendingDigest, sent]).toEqual(['', []]);
    due(w, site.id, { updateMode: 'pinned' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 0, queued: 0 });
    due(w, site.id, { updateMode: 'auto' });
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 1 });
    const [job, ...more] = deployJobs(w);
    expect([JSON.parse(job!.payload), more]).toEqual([{ siteId: site.id, origin: 'auto', backupFirst: false }, []]);
    // Tried once: a deploy of it from there that failed is not tried again at every check.
    w.db.delete(jobs).where(eq(jobs.id, job!.id)).run();
    deployRow(w, site.id, { digest: digest(1), origin: 'auto', result: 'failed', reference: MOVED });
    due(w, site.id);
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    // Once it runs from there, there is nothing to move.
    deployRow(w, site.id, { digest: digest(1), origin: 'user', reference: MOVED });
    due(w, site.id);
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    expect(deployJobs(w)).toEqual([]);
  });

  it('is no move for another tag of the same repository, or Docker Hub by another of its names', async () => {
    const w = await world();
    const site = shop(w);
    for (const [from, to] of [
      [REF, 'ghcr.io/example/shop:next'],
      ['example/shop:stable', 'docker.io/example/shop:stable'],
      ['nginx:stable', 'docker.io/library/nginx:1'],
    ] as const) {
      deployRow(w, site.id, { digest: digest(1), origin: 'user', reference: from });
      w.docker.publish(to, digest(1));
      due(w, site.id, { reference: to, updateMode: 'auto' });
      expect(await w.deps.apps.updatesTick(), `${from} -> ${to}`).toEqual({ checked: 1, queued: 0 });
    }
  });
});

describe('what Traefik refused of an app’s routes', () => {
  it('is on the app’s page, router by router', async () => {
    const w = await world();
    const site = shop(w);
    const refused = [{ router: 'wpl7app_r1_shop', message: 'error while parsing rule', at: Date.now() }];
    const asked = vi.spyOn(w.core.security, 'appRouteRejections').mockReturnValue(refused);
    const { app, read } = await api(w);
    expect((await app.inject({ method: 'GET', url: '/api/sites/shop/app', headers: read })).json().routeErrors).toEqual(refused);
    expect(asked).toHaveBeenCalledWith(site.slug);
  });
});

describe('a health path', () => {
  const REFUSED = 'a path from / with letters, digits and . _ ~ - / % @ : + only, and after a ? also = & , ; ! * $';
  const NOT_PATHS = ['/health#x', '/health?deep=1#x', '/health check', '/health?q=a b', '/health?q="x"', "/health?q='x'", '/health"'];

  it('may end in a query, as a change and at a create, and nothing a URL would read otherwise', async () => {
    const w = await world();
    const site = shop(w);
    const { app, manage } = await api(w);
    const patch = (health: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers: manage, payload: { health } });
    const ok = await patch({ path: '/health?deep=1', deployCheckPath: '/ready?db=1&cache=on' });
    expect([ok.statusCode, ok.json().app.health]).toEqual([200, expect.objectContaining({ path: '/health?deep=1', deployCheckPath: '/ready?db=1&cache=on' })]);
    for (const path of NOT_PATHS) {
      for (const field of ['path', 'deployCheckPath']) {
        const res = await patch({ [field]: path });
        expect([res.statusCode, res.json().error.details?.[0]?.message], `${field} ${path}`).toEqual([400, REFUSED]);
      }
    }
    expect(settingsOf(w, site.id)).toMatchObject({ healthPath: '/health?deep=1', deployCheckPath: '/ready?db=1&cache=on' });

    const create = (health: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/sites', headers: manage, payload: { title: 'Orders', slug: 'orders', app: 'container', image: { reference: REF }, health } });
    const refused = await create({ path: '/health#x' });
    expect([refused.statusCode, refused.json().error.details?.[0]?.message]).toEqual([400, REFUSED]);
    expect((await create({ path: '/health?deep=1', deployCheckPath: '/ready?db=1' })).statusCode).toBe(202);
    const orders = w.db.select().from(sites).where(eq(sites.slug, 'orders')).get()!;
    expect(settingsOf(w, orders.id)).toMatchObject({ healthPath: '/health?deep=1', deployCheckPath: '/ready?db=1' });
  });

  it('is no route path: a route keeps to a path', async () => {
    const w = await world();
    shop(w);
    const { app, manage } = await api(w);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/shop/app/routes',
      headers: manage,
      payload: { routes: [{ host: 'shop.example.test', match: 'prefix', path: '/api?x=1' }] },
    });
    expect([res.statusCode, res.json().error.details?.[0]?.message]).toEqual([400, 'a path from / with letters, digits and . _ ~ - / % @ : + only']);
  });
});

describe('the image’s own user', () => {
  it('is on the app’s page beside the one it runs as, which Run as decides', async () => {
    const w = await world();
    const site = shop(w, { settings: { imageUid: 10001, imageGid: 10002, runAs: '1000:1000' } });
    const { app, read } = await api(w);
    const dto = (await app.inject({ method: 'GET', url: '/api/sites/shop/app', headers: read })).json();
    expect([dto.user, dto.imageUser]).toEqual([{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10002 }]);
    w.db.update(appSettings).set({ runAs: '' }).where(eq(appSettings.siteId, site.id)).run();
    expect(w.deps.apps.detail(site)).toMatchObject({ user: { uid: 10001, gid: 10002 }, imageUser: { uid: 10001, gid: 10002 } });
  });
});
