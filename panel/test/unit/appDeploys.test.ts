/**
 * A container app's deploys and recreates past their happy path, in the fake world: what Read only
 * reads of a failed one's log, the images that run after the app's reference has moved to another
 * repository, a new port or user, a port staged for the next container and the deploys, recreates,
 * starts and restarts that try it (a restart in the time its job has left), a roll back across a
 * port change (of a stopped app too, whose start asks), the order its folders change hands in, the
 * images it leaves behind, the image VOLUMEs it keeps, the ones it cannot and one a mount gave
 * back, a step after the swap that fails, the gap, a hold that cannot be written, an upload whose
 * job was canceled before it ran, and one a create's job names out of the uploads folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appDeploys, appSettings, jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import type { ExecPort } from '../../src/lib/exec.js';
import { TarWriter } from '../../src/lib/tarWriter.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
import { appPaths } from '../../src/services/appSpec.js';
import type { SiteContainerSpec } from '../../src/services/docker.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { fakeExecOk, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const REPO = 'ghcr.io/example/shop';
/** What the app's reference names once it has been changed: another repository. */
const NEW_REF = 'ghcr.io/example/store:stable';
const NEW_REPO = 'ghcr.io/example/store';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const PASSWD = 'root:x:0:0::/root:/bin/sh\napp:x:10001:10001::/home/app:/bin/sh\n';

/** Image n under a tag, as a push from the app's CI leaves it; it runs as root unless `user` says. */
function push(w: TestWorld, n: number, opts: { ref?: string; user?: string } = {}): void {
  w.docker.publish(opts.ref ?? REF, digest(n), { imageId: `sha256:img${n}`, config: { exposedPorts: ['8000/tcp'], ...(opts.user ? { user: opts.user } : {}) } });
  w.docker.imageFiles.set(`sha256:img${n}`, new Map([['/etc/passwd', PASSWD]]));
}

/** A `chown -R` of the app's folders: to whom, and what the old container was doing then. */
interface Chown {
  owner: string;
  old: string;
}

async function world(): Promise<TestWorld & { chowns: Chown[] }> {
  const chowns: Chown[] = [];
  let docker: TestWorld['docker'] | null = null;
  const exec: ExecPort = {
    ...fakeExecOk,
    run: (cmd, args, opts) => {
      if (cmd === 'chown' && args[0] === '-R') chowns.push({ owner: args[1]!, old: docker?.containers.get('wp-shop.previous') ?? 'gone' });
      return fakeExecOk.run(cmd, args, opts);
    },
  };
  const w = await makeWorld({ exec });
  docker = w.docker;
  w.deps.settings.set('backupBeforeUpdates', 'never');
  w.docker.containers.set(TRAEFIK_CONTAINER, 'running');
  push(w, 1);
  return Object.assign(w, { chowns });
}

async function finish(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const parsed = (body: Record<string, unknown>) => siteCreateBody.parse(body);

async function createShop(w: TestWorld, extra: Record<string, unknown> = {}) {
  const { job } = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF }, ...extra }));
  const done = await finish(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
}

const deploy = async (w: TestWorld, body: { deployId?: number } = {}) => finish(w, (await w.deps.apps.deploy('shop', body)).id);
/** A recreate a sweep or a CPU cap queues, or a settings change's with `appRunAs`. */
const reconcile = (w: TestWorld, site: SiteRow, extra: { appRunAs?: string } = {}) =>
  finish(w, w.worker.enqueue('site.reconcile', { siteId: site.id, ...extra }, { id: site.id, slug: 'shop', serverId: 1 }).id);
/** Recreate container on the app's page. */
const recreate = (w: TestWorld) => finish(w, w.deps.sites.reconcile('shop').id);
/** What PATCH port does to an app whose container runs: the port waits on its row for the next start, deploy or recreate. */
const stage = (w: TestWorld, site: SiteRow, port: number) => w.db.update(appSettings).set({ nextPort: port }).where(eq(appSettings.siteId, site.id)).run();
const creates = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);
const pulls = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'pullImage').map((c) => c.args[0] as string);
const removed = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0] as string);
const settingsOf = (w: TestWorld, siteId: number) => w.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get()!;
const deploysOf = (w: TestWorld, siteId: number) => w.db.select().from(appDeploys).where(eq(appDeploys.siteId, siteId)).orderBy(appDeploys.id).all();
const routesFile = (w: TestWorld) => path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName('shop'));
const jobLog = (w: TestWorld, jobId: number) => w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');
/** What PATCH reference does to the row: the app watches another repository from now on. */
const changeReference = (w: TestWorld, site: SiteRow, reference: string) =>
  w.db.update(appSettings).set({ reference, pendingDigest: '' }).where(eq(appSettings.siteId, site.id)).run();

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function mailbox(w: TestWorld): string[] {
  const sent: string[] = [];
  w.core.settings.set('alertEmail', 'ops@example.com');
  w.core.mail.notifyOperator = async (subject) => {
    sent.push(subject);
    return true;
  };
  return sent;
}

/** As Docker answers the removal of an image with two names by its id. */
function refuseIdOfTwoNames(w: TestWorld): void {
  const remove = w.docker.removeImage.bind(w.docker);
  w.docker.removeImage = async (ref) => {
    const image = (await w.docker.listImages()).find((i) => i.id === ref);
    if (image && image.tags.length > 1) {
      throw Object.assign(new Error(`conflict: unable to delete ${ref.slice(7, 19)} (must be forced) - image is referenced in multiple repositories`), { statusCode: 409 });
    }
    return remove(ref);
  };
}

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

describe('a failed deploy’s log', () => {
  const SECRET_LINE = 'DATABASE_URL=mysql://shop:db-secret@db/shop';

  it('shows its container’s last lines at Manage only, as the app’s own log is', async () => {
    const w = await world();
    w.docker.appHttp = () => 503;
    w.docker.logs.set('wp-shop', `booting\n${SECRET_LINE}\n`);
    const { site: first, job } = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF } }));
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, first.id)).run();
    const create = await finish(w, job.id);
    expect(create.status).toBe('failed');

    w.docker.appHttp = null;
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    w.docker.appHttp = () => 500;
    w.docker.onStart = (name) => {
      if (name === 'wp-shop') w.docker.logs.set('wp-shop', `booting\n${SECRET_LINE}\n`);
    };
    push(w, 2);
    const failedDeploy = await deploy(w);
    expect(failedDeploy.status).toBe('failed');
    const failedRecreate = await reconcile(w, site);
    expect(failedRecreate.status).toBe('failed');

    const { app, headers } = await authed(w);
    const read = w.deps.apiKeys.create('read', 'read');
    const logOf = async (jobId: number, h: Record<string, string>) =>
      ((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: h })).json() as { logs: { message: string }[] }).logs.map((l) => l.message).join('\n');
    for (const [jobId, what] of [
      [create.id, "The container's last lines"],
      [failedDeploy.id, "The new container's last lines"],
      [failedRecreate.id, "The new container's last lines"],
    ] as const) {
      const asRead = await logOf(jobId, { authorization: `Bearer ${read.token}` });
      expect(asRead).not.toContain('db-secret');
      expect(asRead).toContain(`${what}: what it printed is not shown at Read only access.`);
      expect(await logOf(jobId, headers)).toContain(`${what}:\nbooting\n${SECRET_LINE}`);
    }
    // The deploy keeps them, for its page at Manage.
    expect(deploysOf(w, site.id).at(-1)!.logTail).toBe(`booting\n${SECRET_LINE}`);
  });
});

describe('after the app’s reference names another repository', () => {
  it('recreates and rolls back from the repository each image came by', async () => {
    const w = await world();
    const site = await createShop(w);
    changeReference(w, site, NEW_REF);

    // Recreate container, its image gone from the server: pulled again where it came from.
    w.docker.images.delete(`${REPO}@${digest(1)}`);
    const recreated = await reconcile(w, site);
    expect(recreated.status, recreated.error ?? '').toBe('succeeded');
    expect(pulls(w).at(-1)).toBe(`${REPO}@${digest(1)}`);
    expect(creates(w).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);

    // A deploy takes the new repository's image, and a roll back the old one's, by its old reference.
    push(w, 5, { ref: NEW_REF });
    expect((await deploy(w)).status).toBe('succeeded');
    expect(creates(w).at(-1)!.image).toBe(`${NEW_REPO}@${digest(5)}`);
    const first = deploysOf(w, site.id)[0]!;
    w.docker.images.delete(`${REPO}@${digest(1)}`);
    const back = await deploy(w, { deployId: first.id });
    expect(back.status, back.error ?? '').toBe('succeeded');
    expect(pulls(w).at(-1)).toBe(`${REPO}@${digest(1)}`);
    expect(creates(w).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'rollback', result: 'ok', reference: REF, digest: digest(1) });

    // What runs goes by that reference from then on.
    expect((await reconcile(w, site)).status).toBe('succeeded');
    expect(creates(w).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);
  });

  it('deploys the image that runs again when the new repository holds it too, and goes by that one from then on', async () => {
    const w = await world();
    const site = await createShop(w);
    // The image copied to another repository: it keeps its digest.
    push(w, 1, { ref: NEW_REF });
    changeReference(w, site, NEW_REF);
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(JSON.parse(done.result!)).not.toHaveProperty('unchanged');
    expect(jobLog(w, done.id)).toContain(`${digest(1).slice(0, 19)}… runs already, from ${REPO}: deploying it from ${NEW_REPO}.`);
    expect(pulls(w).at(-1)).toBe(`${NEW_REPO}@${digest(1)}`);
    expect(creates(w).at(-1)!.image).toBe(`${NEW_REPO}@${digest(1)}`);
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'user', result: 'ok', reference: NEW_REF, digest: digest(1) });

    // Its image gone from the server, Recreate container pulls it from the new repository.
    w.docker.images.delete(`${REPO}@${digest(1)}`);
    w.docker.images.delete(`${NEW_REPO}@${digest(1)}`);
    expect((await reconcile(w, site)).status).toBe('succeeded');
    expect(pulls(w).at(-1)).toBe(`${NEW_REPO}@${digest(1)}`);

    // Now that it goes by the new one, there is nothing to deploy.
    const again = await deploy(w);
    expect(JSON.parse(again.result!)).toEqual({ slug: 'shop', unchanged: true, digest: digest(1) });
    expect(deploysOf(w, site.id)).toHaveLength(2);
  });
});

describe('a new port or user', () => {
  it('a staged port goes into the new container of a recreate that it answers on, and into the app’s row once that has passed, routes and all', async () => {
    const w = await world();
    const site = await createShop(w);
    const asked: { port: number; row: number }[] = [];
    w.docker.appHttp = (req) => {
      asked.push({ port: req.port, row: settingsOf(w, site.id).port });
      return req.port === 9000 ? 200 : null;
    };
    // Where the routes send once their release has written them. The job's last kick writes them from
    // the row again, so the file at the end would not show a row saved after the release.
    const routes = w.deps.appRoutes;
    const release = routes.release.bind(routes);
    const atRelease: string[] = [];
    routes.release = async (s) => {
      await release(s);
      atRelease.push(/url: "http:\/\/wp-shop:\d+"/.exec(fs.readFileSync(routesFile(w), 'utf8'))?.[0] ?? 'no url');
    };
    stage(w, site, 9000);
    const done = await recreate(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    // The health gate asked the new port while the row still said the old one.
    expect(asked[0]).toEqual({ port: 9000, row: 8000 });
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    // Released onto the new port: never onto the old one, which nothing listens on any more.
    expect(atRelease).toEqual(['url: "http://wp-shop:9000"']);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
  });

  it('a user goes into the new container of the recreate its change queued, and into the row once that has passed; a staged port it does not answer on waits', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    const asked: number[] = [];
    w.docker.appHttp = (req) => {
      asked.push(req.port);
      return req.port === 8000 ? 200 : null;
    };
    stage(w, site, 9000);
    const done = await reconcile(w, site, { appRunAs: '1000:1000' });
    expect(done.status, done.error ?? '').toBe('succeeded');
    // The staged port first, then the one it runs on, in the same round (the uptime check at the job's end asks 8000 again).
    expect([...new Set(asked)]).toEqual([9000, 8000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000, runAs: '1000:1000' });
    expect(jobLog(w, done.id)).toContain('Port 9000 did not answer: the app runs on 8000, and the next start, deploy or recreate tries 9000 again.');
    expect(creates(w).at(-1)!.user).toBe('1000:1000');
    // The row's old user is what showed the folders had to change hands: once the old container stopped.
    expect(w.chowns).toEqual([{ owner: '1000:1000', old: 'exited' }]);
  });

  it('changes nothing when the new container does not pass, and the port stays staged', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    // The old container answered on 8000; the new one answers on neither port it is asked on.
    w.docker.appHttp = () => null;
    stage(w, site, 9000);
    const done = await recreate(w);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^\/ did not answer 2xx on port 9000 or 8000 within 1 s/);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(w.docker.containers.has('wp-shop.previous')).toBe(false);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
    // A new user's recreate that does not pass saves no user, and hands the folders back.
    w.docker.appHttp = () => 500;
    expect((await reconcile(w, site, { appRunAs: '1000:1000' })).status).toBe('failed');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000, runAs: '' });
    expect(w.chowns).toEqual([
      { owner: '1000:1000', old: 'exited' },
      { owner: '0:0', old: 'gone' },
    ]);
  });

  it('is refused in the job as the patch refuses it', async () => {
    const w = await world();
    const site = await createShop(w);
    const done = await reconcile(w, site, { appRunAs: 'root' });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^Invalid job payload/);
    expect(settingsOf(w, site.id).runAs).toBe('');
  });
});

/** Image 1 answers on 8000 and image 2 on 9000, nothing else; the ports asked are noted. */
function listen(w: TestWorld): number[] {
  const on = new Map([
    ['sha256:img1', 8000],
    ['sha256:img2', 9000],
  ]);
  const asked: number[] = [];
  w.docker.appHttp = (req) => {
    asked.push(req.port);
    return on.get(w.docker.imageByContainer.get(req.container) ?? '') === req.port ? 200 : null;
  };
  return asked;
}

describe('a port staged for the next container', () => {
  it('goes in with a new image that listens on it, behind the one gate of its deploy', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    const asked = listen(w);
    push(w, 2);
    // The image first: asked on the port that runs, which it does not listen on.
    expect((await deploy(w)).status).toBe('failed');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, digest: digest(1) });
    // With its port staged, the deploy asks it there, and saves the port with the rest.
    stage(w, site, 9000);
    asked.length = 0;
    const made = creates(w).length;
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9000]);
    expect(creates(w)).toHaveLength(made + 1);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0, digest: digest(2) });
    // Each deploy that went in keeps the port it passed on: the create's, then this one's.
    expect(deploysOf(w, site.id).map((d) => [d.origin, d.result, d.port])).toEqual([
      ['create', 'ok', 8000],
      ['user', 'failed', 0],
      ['user', 'ok', 9000],
    ]);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
  });

  it('is tried by Recreate container on an image that does not listen on it: the app stays on the port it runs on, and the port stays staged', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    const asked = listen(w);
    stage(w, site, 9000);
    // Nothing new under the tag: nothing goes in, and the log says what tries the port.
    const same = await deploy(w);
    expect(JSON.parse(same.result!)).toMatchObject({ unchanged: true });
    expect(jobLog(w, same.id)).toContain('The next start, deploy or recreate tries port 9000.');
    asked.length = 0;
    const done = await recreate(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9000, 8000]);
    expect(jobLog(w, done.id)).toContain('Port 9000 did not answer: the app runs on 8000, and the next start, deploy or recreate tries 9000 again.');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
  });

  it('goes in with an environment change that moves the port the app listens on, saved apart from the port', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    // The app listens where its PORT says, 8000 without one.
    const asked: number[] = [];
    w.docker.appHttp = (req) => {
      asked.push(req.port);
      const made = creates(w).filter((c) => c.name === req.container).at(-1);
      return Number(made?.env.PORT ?? 8000) === req.port ? 200 : null;
    };
    const { app, headers } = await authed(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers, payload });
    // How it runs: the port alone, staged.
    const port = await patch({ port: 9000 });
    expect([port.statusCode, port.json().job]).toEqual([200, null]);
    // Environment, saved apart: its recreate tries 9000, where the new container listens.
    const env = await patch({ env: [{ name: 'PORT', value: '9000' }] });
    expect(env.statusCode).toBe(202);
    const done = await finish(w, env.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    expect(jobLog(w, done.id)).toContain('Recreated: port 8000 -> 9000.');
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
  });

  it('waits through the deploy of an app that is stopped, which no gate asks, and Start tries it before the routes are written', async () => {
    const w = await world();
    const site = await createShop(w);
    const asked = listen(w);
    stage(w, site, 9000);
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    push(w, 2);
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.docker.containers.get('wp-shop')).toBe('created');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000, digest: digest(2) });
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'user', result: 'ok', port: 8000 });
    expect(jobLog(w, done.id)).toContain('Port 9000 is tried when the app starts.');
    // Nor does a recreate of the stopped app ask it.
    const recreated = await recreate(w);
    expect(recreated.status, recreated.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    expect(jobLog(w, recreated.id)).toContain('Port 9000 is tried when the app starts.');

    // Image 2 listens on 9000: Start keeps it, and the routes and the uptime check go there.
    asked.length = 0;
    const started = await finish(w, w.deps.sites.action('shop', 'start').id);
    expect(started.status, started.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    expect(jobLog(w, started.id)).toContain('The app runs on 9000 from now on, not 8000.');
    // The deploy of image 2 says so too: a roll back to it asks 9000.
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'user', result: 'ok', port: 9000 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: true, httpStatus: 200 });
  });

  it('stays staged through a Start it does not answer at, which warns and runs the app on its port; a Restart once it answers there takes it', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    stage(w, site, 9000);
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    const asked: number[] = [];
    w.docker.appHttp = (req) => {
      asked.push(req.port);
      return null;
    };
    const started = await finish(w, w.deps.sites.action('shop', 'start').id);
    expect(started.status, started.error ?? '').toBe('succeeded');
    expect([w.docker.containers.get('wp-shop'), w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status]).toEqual(['running', 'running']);
    expect([...new Set(asked)]).toEqual([9000, 8000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    const warned = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, started.id)).all().filter((l) => l.level === 'warn');
    expect(warned.map((l) => l.message)).toEqual([
      expect.stringMatching(/^The app did not pass its health check \(\/ did not answer 2xx on port 9000 or 8000 within 1 s .*\): it runs on 8000, and the next start, deploy or recreate tries 9000 again\.$/),
    ]);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');

    // It answers on 9000 now (it was slow to come up): a Restart keeps that one.
    w.docker.appHttp = (req) => (req.port === 9000 ? 200 : null);
    const restarted = await finish(w, w.deps.sites.action('shop', 'restart').id);
    expect(restarted.status, restarted.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');

    // With nothing staged, a Restart asks nothing before its routes, as before.
    const again = await finish(w, w.deps.sites.action('shop', 'restart').id);
    expect(again.status).toBe('succeeded');
    expect(jobLog(w, again.id)).toBe('Restarting wp-shop…');
  });

  it('stays staged for a future image through a new database password, a sweep’s recreate and a settings change’s, which pass on the port that runs', async () => {
    const w = await world();
    const withDb = { database: true, env: [{ name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}/{{db.name}}' }] };
    const site = await createShop(w, withDb);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    // Image 1 listens on 8000 only: 9000 is staged for an image that is not out yet.
    const asked = listen(w);
    stage(w, site, 9000);
    const { app, headers } = await authed(w);
    const passwordBefore = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.dbPassword;
    const queued = [
      async () => w.worker.enqueue('database.password', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 }).id,
      async () => w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 }).id,
      async () => {
        const res = await app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers, payload: { env: [...withDb.env, { name: 'MODE', value: 'live' }] } });
        expect(res.statusCode).toBe(202);
        return res.json().job.id as number;
      },
    ];
    for (const queue of queued) {
      asked.length = 0;
      const id = await queue();
      const done = await finish(w, id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect([...new Set(asked)]).toEqual([9000, 8000]);
      expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
      expect(jobLog(w, id)).toContain('Port 9000 did not answer: the app runs on 8000, and the next start, deploy or recreate tries 9000 again.');
    }
    // The new password went in with its container.
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.dbPassword).not.toBe(passwordBefore);
    expect(creates(w).at(-1)!.env).toMatchObject({ MODE: 'live' });

    // The image that listens on 9000 is out: its deploy takes the port.
    push(w, 2);
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0, digest: digest(2) });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
  });
});

describe('a Restart’s try of a staged port', () => {
  /** finish, counting its waits rather than the clock: these tests move Date.now, which would end waitFor's at once. */
  async function settle(w: TestWorld, jobId: number) {
    const row = () => w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    w.worker.start();
    for (let i = 0; i < 4000 && ['queued', 'running'].includes(row().status); i++) await new Promise((r) => setTimeout(r, 5));
    await w.worker.stop();
    return row();
  }

  /**
   * A Restart of "shop" with 9000 staged, on a clock that moves only as the app takes `stopMs` to
   * stop and each question to it 10 s; `answers` says whether a port answers that far in.
   */
  async function slowRestart(w: TestWorld, site: SiteRow, stopMs: number, answers: (port: number, at: number) => boolean) {
    w.db.update(appSettings).set({ healthTimeoutSec: 600, stopGraceSec: 300 }).where(eq(appSettings.siteId, site.id)).run();
    stage(w, site, 9000);
    const from = Date.now();
    let at = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => from + at);
    const restart = w.docker.restartContainer.bind(w.docker);
    w.docker.restartContainer = async (name, grace) => {
      at += stopMs;
      return restart(name, grace);
    };
    w.docker.appHttp = (req) => {
      at += 10_000;
      return answers(req.port, at) ? 200 : null;
    };
    try {
      return await settle(w, w.deps.sites.action('shop', 'restart').id);
    } finally {
      clock.mockRestore();
    }
  }
  const warnings = (w: TestWorld, jobId: number) =>
    w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().filter((l) => l.level === 'warn').map((l) => l.message);

  it('asks it for what is left of the job’s 5 minutes, less a margin, once the app has taken most of them to stop', async () => {
    const w = await world();
    const site = await createShop(w);
    const done = await slowRestart(w, site, 200_000, () => false);
    expect(done.status, done.error ?? '').toBe('succeeded');
    // 300 s, less the 200 s its stop took, less 30 s for the routes and the rest after it.
    expect(warnings(w, done.id)).toEqual([
      expect.stringMatching(/^The app did not pass its health check \(\/ did not answer 2xx on port 9000 or 8000 within 70 s /),
    ]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
  });

  it('asks it for 30 s however little is left, and saves no port that answers once the job is out of time', async () => {
    const w = await world();
    const site = await createShop(w);
    // 9000 answers 305 s in: past the job's 5 minutes, which the worker fails it at.
    const done = await slowRestart(w, site, 290_000, (port, at) => port === 9000 && at >= 305_000);
    expect(jobLog(w, done.id)).toContain('/ answered 200 OK on port 9000.');
    expect(warnings(w, done.id)).toEqual([
      'Port 9000 answered once this job was out of time: the app runs on 8000, and the next start, deploy or recreate tries 9000 again.',
    ]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9000 });
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'create', port: 8000 });
  });
});

describe('a roll back across a port change', () => {
  it('asks the old image where it passed, and saves that port; a port staged for another image stays staged', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    const asked = listen(w);
    // Image 2 moves the app to 9000.
    push(w, 2);
    stage(w, site, 9000);
    expect((await deploy(w)).status).toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 0 });
    // 9100 is staged for image 3, which is not out yet. Roll back to the create's image 1.
    stage(w, site, 9100);
    const first = deploysOf(w, site.id)[0]!;
    expect([first.origin, first.port]).toEqual(['create', 8000]);
    asked.length = 0;
    const back = await deploy(w, { deployId: first.id });
    expect(back.status, back.error ?? '').toBe('succeeded');
    // The staged port, then where image 1 passed: there it answers.
    expect([...new Set(asked)]).toEqual([9100, 8000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 9100, digest: digest(1) });
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'rollback', result: 'ok', port: 8000 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');

    // Forward again to the deploy of image 2: it passed on 9000.
    const second = deploysOf(w, site.id)[1]!;
    asked.length = 0;
    expect((await deploy(w, { deployId: second.id })).status).toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9100, 9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 9100, digest: digest(2) });
  });

  it('of a deploy from before the port was kept asks the ports it has, as a deploy does', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    const asked = listen(w);
    push(w, 2);
    stage(w, site, 9000);
    expect((await deploy(w)).status).toBe('succeeded');
    const first = deploysOf(w, site.id)[0]!;
    w.db.update(appDeploys).set({ port: 0 }).where(eq(appDeploys.id, first.id)).run();
    asked.length = 0;
    const back = await deploy(w, { deployId: first.id });
    expect(back.status).toBe('failed');
    expect(back.error).toMatch(/^\/ did not answer 2xx within 1 s/);
    expect([...new Set(asked)]).toEqual([9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, digest: digest(2) });
  });

  it('of an app that is stopped keeps its port and stages the one the old image passed on, which Start asks first', async () => {
    const w = await world();
    const site = await createShop(w);
    const asked = listen(w);
    push(w, 2);
    stage(w, site, 9000);
    expect((await deploy(w)).status).toBe('succeeded');
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    const back = await deploy(w, { deployId: deploysOf(w, site.id)[0]!.id });
    expect(back.status, back.error ?? '').toBe('succeeded');
    expect(w.docker.containers.get('wp-shop')).toBe('created');
    // No gate asked image 1 anything: the app keeps 9000 until it answers on 8000.
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 8000, digest: digest(1) });
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'rollback', result: 'ok', port: 9000 });
    expect(jobLog(w, back.id)).toContain('Port 8000 is tried when the app starts.');

    // Image 1 answers on 8000: Start keeps it, and the roll back's deploy says so.
    asked.length = 0;
    const started = await finish(w, w.deps.sites.action('shop', 'start').id);
    expect(started.status, started.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([8000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, nextPort: 0 });
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ origin: 'rollback', port: 8000 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
  });

  it('of an app that is stopped goes where its image answers at Start, when the app’s PORT has moved it since its deploy passed', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    // Both images listen where PORT says, 8000 without one.
    const asked: number[] = [];
    w.docker.appHttp = (req) => {
      asked.push(req.port);
      if (w.docker.containers.get(req.container) !== 'running') return null;
      const made = creates(w).filter((c) => c.name === req.container).at(-1);
      return Number(made?.env.PORT ?? 8000) === req.port ? 200 : null;
    };
    const { app, headers } = await authed(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers, payload });
    const action = (what: 'start' | 'stop') => finish(w, w.deps.sites.action('shop', what).id);
    // Stopped, the app takes PORT=9000 (its recreate leaves it stopped) and the port 9000 as it is saved; image 2 goes in on them.
    expect((await action('stop')).status).toBe('succeeded');
    const env = await patch({ env: [{ name: 'PORT', value: '9000' }] });
    expect(env.statusCode).toBe(202);
    expect((await finish(w, env.json().job.id)).status).toBe('succeeded');
    expect((await patch({ port: 9000 })).statusCode).toBe(200);
    push(w, 2);
    expect((await deploy(w)).status).toBe('succeeded');
    expect((await action('start')).status).toBe('succeeded');
    expect(deploysOf(w, site.id).map((d) => [d.origin, d.port])).toEqual([
      ['create', 8000],
      ['user', 9000],
    ]);

    // Stopped again, back to image 1, whose deploy passed on 8000 before PORT was set.
    expect((await action('stop')).status).toBe('succeeded');
    const back = await deploy(w, { deployId: deploysOf(w, site.id)[0]!.id });
    expect(back.status, back.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 8000, digest: digest(1) });
    expect(jobLog(w, back.id)).toContain('Port 8000 is tried when the app starts.');

    // Start asks both: image 1, given PORT=9000, answers on 9000, and the routes go there.
    asked.length = 0;
    const started = await action('start');
    expect(started.status, started.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([8000, 9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, nextPort: 8000 });
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
    // Recreate container passes there too: it asks 8000, then 9000.
    const recreated = await recreate(w);
    expect(recreated.status, recreated.error ?? '').toBe('succeeded');
    expect(settingsOf(w, site.id).port).toBe(9000);
  });

  it('to an image a recreate moved to another port asks it where it went, not where its deploy passed', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    // Image 1 listens where its PORT says, 8000 without one; image 2 on 5000 whatever it says.
    const asked: number[] = [];
    w.docker.appHttp = (req) => {
      asked.push(req.port);
      const made = creates(w).filter((c) => c.name === req.container).at(-1);
      const on = w.docker.imageByContainer.get(req.container) === 'sha256:img2' ? 5000 : Number(made?.env.PORT ?? 8000);
      return on === req.port ? 200 : null;
    };
    const { app, headers } = await authed(w);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers, payload });
    expect((await patch({ port: 9000 })).statusCode).toBe(200);
    const env = await patch({ env: [{ name: 'PORT', value: '9000' }] });
    expect((await finish(w, env.json().job.id)).status).toBe('succeeded');
    // The recreate moved image 1 to 9000: the deploy it runs from says so.
    expect(deploysOf(w, site.id).map((d) => [d.origin, d.port])).toEqual([['create', 9000]]);

    push(w, 2);
    stage(w, site, 5000);
    expect((await deploy(w)).status).toBe('succeeded');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 5000, digest: digest(2) });
    asked.length = 0;
    const back = await deploy(w, { deployId: deploysOf(w, site.id)[0]!.id });
    expect(back.status, back.error ?? '').toBe('succeeded');
    expect([...new Set(asked)]).toEqual([9000]);
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, digest: digest(1) });
  });
});

describe('a deploy of an image that runs as another user', () => {
  it('hands the app’s folders over only once the old container has stopped, and back when it fails', async () => {
    const w = await world();
    const site = await createShop(w);
    push(w, 2, { user: 'app' });
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.chowns).toEqual([{ owner: '10001:10001', old: 'exited' }]);
    expect(settingsOf(w, site.id)).toMatchObject({ imageUid: 10001, imageGid: 10001 });

    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    push(w, 3);
    w.docker.appHttp = () => 500;
    expect((await deploy(w)).status).toBe('failed');
    expect(w.chowns.slice(1)).toEqual([
      { owner: '0:0', old: 'exited' },
      { owner: '10001:10001', old: 'gone' },
    ]);
  });
});

describe('the images an app leaves behind', () => {
  it('are found by repository however Docker names them', async () => {
    const w = await world();
    const ref = 'docker.io/library/shop:1';
    push(w, 1, { ref });
    // As Docker lists Docker Hub's library images: by their short names.
    const list = w.docker.listImages.bind(w.docker);
    w.docker.listImages = async () => (await list()).map((i) => ({ ...i, tags: i.tags.map((t) => t.replace(/^docker\.io\/library\//, '')) }));
    await createShop(w, { image: { reference: ref } });
    for (const n of [2, 3, 4]) {
      push(w, n, { ref });
      expect((await deploy(w)).status).toBe('succeeded');
    }
    // What runs and the two before it stay. By the name Docker lists, which it reads as the long one.
    expect(removed(w)).toEqual([`shop@${digest(1)}`]);
  });

  it('are an earlier reference’s too, while the app runs and when it goes', async () => {
    const w = await world();
    const site = await createShop(w);
    push(w, 2);
    expect((await deploy(w)).status).toBe('succeeded');
    changeReference(w, site, NEW_REF);
    for (const n of [5, 6, 7]) {
      push(w, n, { ref: NEW_REF });
      expect((await deploy(w)).status).toBe('succeeded');
    }
    expect(removed(w)).toEqual([`${REPO}@${digest(1)}`, `${REPO}@${digest(2)}`]);
    const gone = await finish(w, w.deps.sites.delete('shop', false).id);
    expect(gone.status, gone.error ?? '').toBe('succeeded');
    expect(removed(w).slice(2).sort()).toEqual([5, 6, 7].map((n) => `${NEW_REPO}@${digest(n)}`));
  });

  it('go by each of their names in the app’s repositories, which Docker needs once there are two, and keep another’s', async () => {
    const w = await world();
    refuseIdOfTwoNames(w);
    const site = await createShop(w);
    // Image 1, deployed again from a second repository of the app's, and named in one that is not its.
    push(w, 1, { ref: NEW_REF });
    changeReference(w, site, NEW_REF);
    expect((await deploy(w)).status).toBe('succeeded');
    await w.docker.tagImage('sha256:img1', 'ghcr.io/example/other:kept');
    const later: number[] = [];
    for (const n of [5, 6, 7]) {
      push(w, n, { ref: NEW_REF });
      const done = await deploy(w);
      expect(done.status).toBe('succeeded');
      later.push(done.id);
    }
    expect(removed(w)).toEqual([`${REPO}@${digest(1)}`, `${NEW_REPO}@${digest(1)}`]);
    expect(await w.docker.imageId('ghcr.io/example/other:kept')).toBe('sha256:img1');
    for (const id of later) expect(jobLog(w, id)).not.toContain('Could not remove');
  });

  it('go by both names of a build uploaded twice', async () => {
    const w = await world();
    refuseIdOfTwoNames(w);
    fs.mkdirSync(w.deps.apps.uploadDir(), { recursive: true });
    const put = async (id: string) => fs.writeFileSync(w.deps.apps.uploadPath(id), await archive(['shop:1']));
    // The same build twice, then three others.
    w.docker.loadIds = ['sha256:same', 'sha256:same', 'sha256:up3', 'sha256:up4', 'sha256:up5'];
    await put('upload-same-build-0001');
    const made = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: 'upload-same-build-0001' }, port: 3000 }));
    expect((await finish(w, made.job.id)).status).toBe('succeeded');
    for (const id of ['upload-same-build-0002', 'upload-other-build-0003', 'upload-other-build-0004', 'upload-other-build-0005']) {
      await put(id);
      const done = await finish(w, (await w.deps.apps.deployUpload('shop', id)).id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(jobLog(w, done.id)).not.toContain('Could not remove');
    }
    expect(removed(w)).toEqual(['wpl7-app-shop:uupload-same-build-0001', 'wpl7-app-shop:uupload-same-build-0002']);
    expect(await w.docker.imageExists('sha256:same')).toBe(false);
  });

  it('are a failed deploy’s at once, once the old container is back', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    push(w, 2);
    w.docker.appHttp = () => 500;
    const backFirst: boolean[] = [];
    const removeImage = w.docker.removeImage.bind(w.docker);
    w.docker.removeImage = async (ref) => {
      backFirst.push(w.docker.containers.get('wp-shop') === 'running' && !w.docker.containers.has('wp-shop.previous'));
      return removeImage(ref);
    };
    expect((await deploy(w)).status).toBe('failed');
    expect(removed(w)).toEqual([`${REPO}@${digest(2)}`]);
    expect(backFirst).toEqual([true]);
    expect(w.docker.images.has(`${REPO}@${digest(2)}`)).toBe(false);
    expect(w.docker.images.has(`${REPO}@${digest(1)}`)).toBe(true);
  });
});

describe('an image’s VOLUMEs', () => {
  it('that the panel does not keep are named in the create’s log and each deploy’s; the kept ones say whether this image declares them', async () => {
    const w = await world();
    w.docker.publish(REF, digest(1), { imageId: 'sha256:img1', config: { exposedPorts: ['8000/tcp'], volumes: ['/var/lib/shop', '/usr/share/shop/data'] } });
    const { site, job } = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF }, dataPaths: ['/srv/cache'] }));
    const created = await finish(w, job.id);
    expect(created.status, created.error ?? '').toBe('succeeded');
    const warnings = (jobId: number) => w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().filter((l) => l.level === 'warn').map((l) => l.message);
    const unkept = "The image's VOLUME /usr/share/shop/data is not kept: it is in /usr, which belongs to the container's own system. What the app writes there is lost at each deploy.";
    expect(warnings(created.id)).toEqual([unkept]);
    expect(JSON.parse(settingsOf(w, site.id).dataPaths)).toEqual([
      { path: '/srv/cache', dir: 'srv-cache', fromImage: false },
      { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true },
    ]);
    // The next image declares /srv/cache and no longer /var/lib/shop: both stay, each marked as it is now.
    w.docker.publish(REF, digest(2), { imageId: 'sha256:img2', config: { exposedPorts: ['8000/tcp'], volumes: ['/srv/cache/', '/usr/share/shop/data'] } });
    const deployed = await deploy(w);
    expect(deployed.status, deployed.error ?? '').toBe('succeeded');
    expect(warnings(deployed.id)).toEqual([unkept]);
    expect(JSON.parse(settingsOf(w, site.id).dataPaths)).toEqual([
      { path: '/srv/cache', dir: 'srv-cache', fromImage: true },
      { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: false },
    ]);
  });

  it('that a mount took the place of get their folder back once the mount is taken off, not an anonymous volume', async () => {
    const w = await world();
    w.docker.publish(REF, digest(1), { imageId: 'sha256:img1', config: { exposedPorts: ['8000/tcp'], volumes: ['/var/lib/shop'] } });
    const site = await createShop(w);
    const { app, headers } = await authed(w);
    const patch = async (payload: Record<string, unknown>) => {
      const res = await app.inject({ method: 'PATCH', url: '/api/sites/shop/app', headers, payload });
      expect(res.statusCode, res.body).toBe(202);
      const done = await finish(w, res.json().job.id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      return done;
    };
    const root = appPaths(w.config, 'shop').root;
    const kept = `${root}/data/var-lib-shop:/var/lib/shop`;
    expect(creates(w).at(-1)!.binds).toEqual([kept]);
    // A mount takes the VOLUME's path: its data path goes.
    await patch({ dataPaths: [], mounts: [{ name: 'seed', path: '/var/lib/shop', writable: true }] });
    expect(creates(w).at(-1)!.binds).toEqual([`${root}/mounts/seed:/var/lib/shop`]);
    expect(JSON.parse(settingsOf(w, site.id).dataPaths)).toEqual([]);
    // The mount taken off, the VOLUME is the image's again: its folder is back, in the container and on the row.
    const off = await patch({ mounts: [] });
    expect(creates(w).at(-1)!.binds).toEqual([kept]);
    expect(JSON.parse(settingsOf(w, site.id).dataPaths)).toEqual([{ path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }]);
    expect(jobLog(w, off.id)).toContain("Recreated: the image's VOLUME /var/lib/shop kept in data/var-lib-shop.");
    expect(w.db.select().from(jobLogs).where(eq(jobLogs.jobId, off.id)).all().filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('that the panel cannot keep are named in a recreate’s log too', async () => {
    const w = await world();
    w.docker.publish(REF, digest(1), { imageId: 'sha256:img1', config: { exposedPorts: ['8000/tcp'], volumes: ['/usr/share/shop/data'] } });
    const site = await createShop(w);
    const done = await reconcile(w, site);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.db.select().from(jobLogs).where(eq(jobLogs.jobId, done.id)).all().filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      "The image's VOLUME /usr/share/shop/data is not kept: it is in /usr, which belongs to the container's own system. What the app writes there is lost at each deploy.",
    ]);
  });
});

describe('a step after the swap that fails', () => {
  it('only warns: the deploy went through, and no email says otherwise', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = await createShop(w);
    push(w, 2);
    // The release lets go and then reports a failure; the image list and site.json fail outright.
    const routes = w.deps.appRoutes;
    const release = routes.release.bind(routes);
    routes.release = async (s) => {
      await release(s);
      throw new Error('the routes file could not be written');
    };
    w.docker.listImages = async () => {
      throw new Error('the daemon did not answer');
    };
    const files = w.servers.handleFor(1).files;
    const writeFile = files.writeFile.bind(files);
    files.writeFile = async (file, content, opts) => {
      if (file.endsWith('/shop/site.json')) throw new Error('the disk is full');
      return writeFile(file, content, opts);
    };
    const done = await deploy(w);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ result: 'ok', digest: digest(2), error: null });
    expect(settingsOf(w, site.id).digest).toBe(digest(2));
    expect(sent).toEqual([]);
    const log = jobLog(w, done.id);
    expect(log).toContain("Could not release the app's routes (the routes file could not be written).");
    expect(log).toContain("Could not remove the app's old images (the daemon did not answer).");
    expect(log).toContain("Could not write the app's site.json (the disk is full).");
    expect(w.deps.appRoutes.isHeld(site.id)).toBe(false);
  });
});

describe('the gap a deploy records', () => {
  it('is the routes’ hold, from its start to the new container’s pass', async () => {
    const w = await world();
    const site = await createShop(w);
    // The old container takes its grace to stop: the routes answer 503 all that time.
    const stop = w.docker.stopContainer.bind(w.docker);
    w.docker.stopContainer = async (name, grace) => {
      if (name === 'wp-shop.previous') await new Promise((r) => setTimeout(r, 300));
      return stop(name, grace);
    };
    push(w, 2);
    expect((await deploy(w)).status).toBe('succeeded');
    expect(deploysOf(w, site.id).at(-1)!.gapMs).toBeGreaterThanOrEqual(300);
  });
});

describe('a hold that cannot be written', () => {
  it('fails a deploy and a recreate before anything changes, and nothing is released', async () => {
    const w = await world();
    const site = await createShop(w);
    const routes = w.deps.appRoutes;
    routes.hold = async () => {
      throw new Error('Could not hold the app\'s routes on "local": no space left on device');
    };
    let released = 0;
    const release = routes.release.bind(routes);
    routes.release = async (s) => {
      released++;
      return release(s);
    };
    push(w, 2);
    const failedDeploy = await deploy(w);
    expect(failedDeploy.error).toMatch(/^Could not hold the app's routes/);
    expect(deploysOf(w, site.id).at(-1)).toMatchObject({ result: 'failed', error: expect.stringMatching(/^Could not hold/) });
    stage(w, site, 9000);
    const failedRecreate = await reconcile(w, site);
    expect(failedRecreate.error).toMatch(/^Could not hold the app's routes/);
    expect(w.docker.calls.filter((c) => c.method === 'renameContainer')).toEqual([]);
    expect(released).toBe(0);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(settingsOf(w, site.id)).toMatchObject({ digest: digest(1), port: 8000, nextPort: 9000 });
  });
});

describe('an upload whose job was canceled before it ran', () => {
  it('is let go of and removed, a create’s and a deploy’s', async () => {
    const w = await world();
    fs.mkdirSync(w.deps.apps.uploadDir(), { recursive: true });
    const put = async (id: string, name: string) => fs.writeFileSync(w.deps.apps.uploadPath(id), await archive([name]));

    const forCreate = 'upload-canceled-create-01';
    await put(forCreate, 'shop:1');
    const created = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: forCreate }, port: 3000 }));
    expect(w.worker.cancel(created.job.id)).toBe('canceled');
    expect(fs.existsSync(w.deps.apps.uploadPath(forCreate))).toBe(false);
    expect(() => w.deps.apps.assertUploadFree(forCreate)).not.toThrow();
    expect(w.db.select().from(sites).where(eq(sites.id, created.site.id)).get()).toBeUndefined();

    const first = 'upload-first-image-00001';
    await put(first, 'shop:1');
    const made = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { uploadId: first }, port: 3000 }));
    expect((await finish(w, made.job.id)).status).toBe('succeeded');
    const forDeploy = 'upload-canceled-deploy-01';
    await put(forDeploy, 'shop:2');
    const job = await w.deps.apps.deployUpload('shop', forDeploy);
    expect(w.worker.cancel(job.id)).toBe('canceled');
    expect(fs.existsSync(w.deps.apps.uploadPath(forDeploy))).toBe(false);
    expect(() => w.deps.apps.assertUploadFree(forDeploy)).not.toThrow();
  });
});

describe('the upload a create’s job names', () => {
  it('is refused in the job as the form refuses it, before any file is read', async () => {
    const w = await world();
    // A name that reaches out of the uploads folder, to an archive there.
    const away = '../outside-the-uploads';
    fs.mkdirSync(w.deps.apps.uploadDir(), { recursive: true });
    fs.writeFileSync(w.deps.apps.uploadPath(away), await archive(['shop:1']));
    const { site, job } = w.deps.sites.create(parsed({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF }, port: 3000 }));
    w.db.update(jobs).set({ payload: JSON.stringify({ siteId: site.id, uploadId: away }) }).where(eq(jobs.id, job.id)).run();
    const done = await finish(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^Invalid job payload/);
    expect(w.docker.calls.filter((c) => c.method === 'loadImage')).toEqual([]);
    expect(fs.existsSync(w.deps.apps.uploadPath(away))).toBe(true);
  });
});
