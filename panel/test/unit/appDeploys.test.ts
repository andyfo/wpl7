/**
 * A container app's deploys and recreates past their happy path, in the fake world: what Read only
 * reads of a failed one's log, the images that run after the app's reference has moved to another
 * repository, a new port or user, the order its folders change hands in, the images it leaves
 * behind, a step after the swap that fails, the gap, a hold that cannot be written, an upload whose
 * job was canceled before it ran, and one a create's job names out of the uploads folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appDeploys, appSettings, jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import type { ExecPort } from '../../src/lib/exec.js';
import { TarWriter } from '../../src/lib/tarWriter.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
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
const reconcile = (w: TestWorld, site: SiteRow, extra: { appPort?: number; appRunAs?: string } = {}) =>
  finish(w, w.worker.enqueue('site.reconcile', { siteId: site.id, ...extra }, { id: site.id, slug: 'shop', serverId: 1 }).id);
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
  it('goes into the new container, and into the app’s row once that has passed, routes and all', async () => {
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
    const done = await reconcile(w, site, { appPort: 9000, appRunAs: '1000:1000' });
    expect(done.status, done.error ?? '').toBe('succeeded');
    // The health gate asked the new port while the row still said the old one.
    expect(asked[0]).toEqual({ port: 9000, row: 8000 });
    expect(settingsOf(w, site.id)).toMatchObject({ port: 9000, runAs: '1000:1000' });
    expect(creates(w).at(-1)!.user).toBe('1000:1000');
    // Released onto the new port: never onto the old one, which nothing listens on any more.
    expect(atRelease).toEqual(['url: "http://wp-shop:9000"']);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:9000"');
    // The row's old user is what showed the folders had to change hands: once the old container stopped.
    expect(w.chowns).toEqual([{ owner: '1000:1000', old: 'exited' }]);
  });

  it('changes nothing when the new container does not pass', async () => {
    const w = await world();
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    w.docker.appHttp = (req) => (req.port === 8000 ? 200 : null);
    const done = await reconcile(w, site, { appPort: 9000, appRunAs: '1000:1000' });
    expect(done.status).toBe('failed');
    expect(settingsOf(w, site.id)).toMatchObject({ port: 8000, runAs: '' });
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(w.docker.containers.has('wp-shop.previous')).toBe(false);
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routesFile(w), 'utf8')).toContain('url: "http://wp-shop:8000"');
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
    // What runs and the two before it stay.
    expect(removed(w)).toEqual(['sha256:img1']);
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
    expect(removed(w)).toEqual(['sha256:img1', 'sha256:img2']);
    const gone = await finish(w, w.deps.sites.delete('shop', false).id);
    expect(gone.status, gone.error ?? '').toBe('succeeded');
    expect(removed(w).slice(2).sort()).toEqual(['sha256:img5', 'sha256:img6', 'sha256:img7']);
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
    expect(removed(w)).toEqual(['sha256:img2']);
    expect(backFirst).toEqual([true]);
    expect(w.docker.images.has(`${REPO}@${digest(2)}`)).toBe(false);
    expect(w.docker.images.has(`${REPO}@${digest(1)}`)).toBe(true);
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
    const failedRecreate = await reconcile(w, site, { appPort: 9000 });
    expect(failedRecreate.error).toMatch(/^Could not hold the app's routes/);
    expect(w.docker.calls.filter((c) => c.method === 'renameContainer')).toEqual([]);
    expect(released).toBe(0);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(settingsOf(w, site.id)).toMatchObject({ digest: digest(1), port: 8000 });
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
