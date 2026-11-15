/**
 * A container app's files: what its backups hold, what a restore puts back (its image too), its
 * final backup, a mount filled from an archive (a new app's before it first runs), a mount taken
 * off, and a move to another server.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appDeploys, appMounts, appSettings, backups, jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { appPaths } from '../../src/services/appSpec.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
import type { EphemeralOpts, SiteContainerSpec } from '../../src/services/docker.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { mountEntryProblem, zipListNames } from '../../src/jobs/handlers/apps.js';
import { proxyConfigYaml } from '../../src/jobs/handlers/moveHelpers.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const REPO = 'ghcr.io/example/shop';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const LOGIN = { username: 'ci', password: 'reg-token-secret' };

function push(docker: TestWorld['docker'], n: number): void {
  docker.publish(REF, digest(n), { login: LOGIN, imageId: `sha256:img${n}`, config: { exposedPorts: ['8000/tcp'], volumes: ['/var/lib/shop'] } });
}

function prepare(docker: TestWorld['docker']): void {
  docker.containers.set(TRAEFIK_CONTAINER, 'running');
  docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: ['--entrypoints.web.http.redirections.entrypoint.priority=1'], envSet: [] });
  push(docker, 1);
}

/**
 * No `chown` is run: on a test machine it would fail for any user but the one the tests run as.
 * Each `chown -R` of the app's folders is noted in `chowns`, by owner; one of a single file (a
 * mount's archive) in `handed`, as its arguments.
 */
async function world(): Promise<TestWorld & { chowns: string[]; handed: string[] }> {
  const chowns: string[] = [];
  const handed: string[] = [];
  const exec: ExecPort = {
    ...hostExec,
    run: async (cmd, args, o) => {
      if (cmd !== 'chown') return hostExec.run(cmd, args, o);
      if (args[0] === '-R') chowns.push(args[1]!);
      else handed.push(args.join(' '));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const w = await makeWorld({ exec });
  w.deps.settings.set('backupBeforeUpdates', 'never');
  prepare(w.docker);
  return Object.assign(w, { chowns, handed });
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

const body = {
  title: 'Shop',
  slug: 'shop',
  app: 'container',
  image: { reference: REF, registryUser: LOGIN.username, registryToken: LOGIN.password },
  env: [{ name: 'API_KEY', value: 'env-secret-value', secret: true }],
  database: true,
  mounts: [
    { name: 'uploads', path: '/srv/uploads', writable: true },
    { name: 'secrets', path: '/run/secrets/app', inBackups: false },
  ],
  routes: [{ host: 'shop.example.com', scheme: 'both' }, { host: 'shop.dev.example.test' }],
};

/** Made, then started: an app with mounts is made stopped, for its mounts to be filled first. */
async function createShop(w: TestWorld, extra: Record<string, unknown> = {}) {
  const { job } = w.deps.sites.create(siteCreateBody.parse({ ...body, ...extra }));
  const done = await finish(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  const started = await finish(w, w.deps.sites.action('shop', 'start').id);
  expect(started.status, started.error ?? '').toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
}

/** The app's files, as it would have written them. */
function fill(w: TestWorld, root = appPaths(w.config, 'shop').root, mark = 'v1') {
  fs.writeFileSync(path.join(root, 'data', 'var-lib-shop', 'orders.db'), `orders ${mark}`);
  fs.writeFileSync(path.join(root, 'mounts', 'uploads', 'logo.png'), `logo ${mark}`);
  fs.writeFileSync(path.join(root, 'mounts', 'secrets', 'key.pem'), `key ${mark}`);
}

const tarNames = (file: string) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
const creates = (docker: TestWorld['docker']) => docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);
const jobLog = (w: TestWorld, jobId: number) => w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');
const settingsOf = (w: TestWorld, siteId: number) => w.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get()!;
/** What PATCH reference does to the row: the app watches another repository from now on. */
const watch = (w: TestWorld, site: SiteRow, reference: string) =>
  w.db.update(appSettings).set({ reference, pendingDigest: '' }).where(eq(appSettings.siteId, site.id)).run();

describe('a container app’s backups', () => {
  it('hold its data and the mounts kept in backups, and name its image with no secret', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const backup = await w.core.backup.create(site, 'manual');
    expect(backup.status).toBe('complete');
    const names = tarNames(path.join(backup.path, 'files.tar.gz'));
    expect(names).toContain('data/var-lib-shop/orders.db');
    expect(names).toContain('mounts/uploads/logo.png');
    expect(names).toContain('site.json');
    expect(names.some((n) => n.startsWith('mounts/secrets'))).toBe(false);
    expect(names.some((n) => n.startsWith('wordpress'))).toBe(false);
    const manifestText = fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8');
    expect(JSON.parse(manifestText)).toMatchObject({
      app: 'container',
      wpVersion: null,
      database: true,
      container: { source: 'registry', reference: REF, digest: digest(1), imageId: 'sha256:img1', port: 8000, mounts: ['uploads'] },
    });
    const siteJson = fs.readFileSync(appPaths(w.config, 'shop').siteJson, 'utf8');
    expect(JSON.parse(siteJson).container).toMatchObject({ source: 'registry', digest: digest(1), port: 8000 });
    for (const text of [manifestText, siteJson]) expect(text).not.toMatch(/reg-token-secret|env-secret-value/);
  });

  it('name the image by the reference it came by, which the app’s own may no longer be', async () => {
    const w = await world();
    const site = await createShop(w);
    watch(w, site, 'ghcr.io/example/store:stable');
    // Recreate container writes its site.json again, which the backup holds beside its manifest.
    const recreate = w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });
    expect((await finish(w, recreate.id)).status).toBe('succeeded');
    const backup = await w.core.backup.create(site, 'manual');
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8'));
    expect(manifest.container).toMatchObject({ reference: REF, digest: digest(1) });
    const siteJson = JSON.parse(execFileSync('tar', ['-xzOf', path.join(backup.path, 'files.tar.gz'), 'site.json'], { encoding: 'utf8' }));
    expect(siteJson.container).toMatchObject({ reference: REF, digest: digest(1) });
  });

  it('restore its data and the mounts they hold, and leave the others as they are', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w, undefined, 'v1');
    const backup = await w.core.backup.create(site, 'manual');
    fill(w, undefined, 'v2');
    const lines: string[] = [];
    const safety = await w.core.backup.restoreFiles(backup, site, (_l, m) => lines.push(m));
    const root = appPaths(w.config, 'shop').root;
    expect(fs.readFileSync(path.join(root, 'data', 'var-lib-shop', 'orders.db'), 'utf8')).toBe('orders v1');
    expect(fs.readFileSync(path.join(root, 'mounts', 'uploads', 'logo.png'), 'utf8')).toBe('logo v1');
    // Not in backups: it stays as it was.
    expect(fs.readFileSync(path.join(root, 'mounts', 'secrets', 'key.pem'), 'utf8')).toBe('key v2');
    expect(lines).toContain('secrets is not in this backup: it stays as it is.');
    expect(path.basename(safety!)).toMatch(/^app\.pre-restore-\d{8}-\d{6}$/);
    expect(fs.readFileSync(path.join(safety!, 'data', 'var-lib-shop', 'orders.db'), 'utf8')).toBe('orders v2');
  });

  it('a restore puts back the image the backup was taken with, pulled by digest when it is gone', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const backup = await w.core.backup.create(site, 'manual');
    push(w.docker, 2);
    expect((await finish(w, (await w.deps.apps.deploy('shop', {})).id)).status).toBe('succeeded');
    w.docker.images.delete(`${REPO}@${digest(1)}`);
    const restore = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: 'shop', serverId: 1 });
    const done = await finish(w, restore.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(jobLog(w, restore.id)).toContain(`The backup's image, ${digest(1).slice(0, 19)}…, is no longer on the server: pulling it by its digest…`);
    expect(creates(w.docker).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);
    const settings = w.db.select().from(appSettings).where(eq(appSettings.siteId, site.id)).get()!;
    expect([settings.digest, settings.imageId]).toEqual([digest(1), 'sha256:img1']);
    // Its own settings and secrets are as they are now; its routes are back.
    expect(settings.registryToken).toBe(LOGIN.password);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
    expect(fs.existsSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName('shop')))).toBe(true);
  });

  it('a restore onto an image that runs as another user hands it the folders, and is a deploy from then on', async () => {
    const w = await world();
    const { chowns } = w;
    const site = await createShop(w);
    fill(w);
    const backup = await w.core.backup.create(site, 'manual');
    // Taken on an older image, of a repository the app has left since, that runs as a user of its own.
    const OLD = 'ghcr.io/example/shop-legacy:1';
    w.docker.publish(OLD, digest(8), { login: LOGIN, imageId: 'sha256:img8', config: { exposedPorts: ['8000/tcp'], user: 'app' } });
    w.docker.imageFiles.set('sha256:img8', new Map([['/etc/passwd', 'root:x:0:0::/root:/bin/sh\napp:x:10001:10001::/srv:/bin/sh\n']]));
    const manifestFile = path.join(backup.path, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...m, container: { ...m.container, reference: OLD, digest: digest(8), imageId: 'sha256:img8' } }));

    const restore = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: 'shop', serverId: 1 });
    const done = await finish(w, restore.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(creates(w.docker).at(-1)!.image).toBe(`ghcr.io/example/shop-legacy@${digest(8)}`);
    expect(settingsOf(w, site.id)).toMatchObject({ digest: digest(8), imageId: 'sha256:img8', imageUid: 10001, imageGid: 10001, reference: REF });
    // The files came back to the user the app ran as, then went to the one it runs as now.
    expect(chowns).toEqual(['0:0', '10001:10001']);
    const deploys = w.db.select().from(appDeploys).where(eq(appDeploys.siteId, site.id)).orderBy(appDeploys.id).all();
    expect(deploys.at(-1)).toMatchObject({ origin: 'restore', result: 'ok', reference: OLD, digest: digest(8), imageId: 'sha256:img8', jobId: restore.id });

    // What runs goes by the backup's reference from then on.
    const recreate = w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });
    expect((await finish(w, recreate.id)).status).toBe('succeeded');
    expect(creates(w.docker).at(-1)!.image).toBe(`ghcr.io/example/shop-legacy@${digest(8)}`);
  });

  it('refuses to restore an uploaded image that is gone, before anything is touched', async () => {
    const w = await world();
    const site = await createShop(w);
    const backup = await w.core.backup.create(site, 'manual');
    const manifest = path.join(backup.path, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ ...m, container: { source: 'upload', reference: '', digest: '', imageId: 'sha256:gone' } }));
    const restore = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: 'shop', serverId: 1 });
    const done = await finish(w, restore.id);
    expect(done.error).toBe('The image this backup was taken with is no longer on the server, and an uploaded image cannot be pulled again. Upload it again, then restore. Nothing was changed.');
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer')).toEqual([]);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
  });

  it('takes a final backup of an app that is deleted with one', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const done = await finish(w, w.deps.sites.delete('shop', true).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const final = w.db.select().from(backups).where(and(eq(backups.siteSlug, 'shop'), eq(backups.type, 'final'))).get()!;
    expect(final.status).toBe('complete');
    expect(tarNames(path.join(final.path, 'files.tar.gz'))).toContain('data/var-lib-shop/orders.db');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
  });
});

describe('a mount filled from an archive', () => {
  it('reads the archive’s names as an import does', () => {
    expect(mountEntryProblem('./')).toBeNull();
    expect(mountEntryProblem('./assets/logo.png')).toBeNull();
    expect(mountEntryProblem('assets/')).toBeNull();
    expect(mountEntryProblem('../etc/passwd')).toBe('"../etc/passwd" has an empty, "." or ".." segment');
    expect(mountEntryProblem('/etc/passwd')).toBe('"/etc/passwd" has an absolute path');
    // A name in any script, by the bytes the archive holds: one byte a character made 一 a NUL and Я a /.
    expect(mountEntryProblem('./文档/一.txt')).toBeNull();
    expect(mountEntryProblem('Яблоко.txt')).toBeNull();
    expect(mountEntryProblem('文档/../../etc/passwd')).toBe('"文档/../../etc/passwd" has an empty, "." or ".." segment');
    expect(mountEntryProblem('/Яблоко.txt')).toBe('"/Яблоко.txt" has an absolute path');
    expect(mountEntryProblem('a\u0000b')).toBe('"a\\u0000b" has a NUL byte');
    expect(zipListNames('Archive:  /in/archive\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n       12  11-14-2026 20:00   a.txt\n        0  11-14-2026 20:00   dir/\n---------                     -------\n       12                     2 files\n')).toEqual(['a.txt', 'dir/']);
  });

  /**
   * The unpacker, as busybox in Traefik's image runs it: the listing, then the files in /out. Each
   * run notes the files handed to another owner by then.
   */
  function unpacker(w: Awaited<ReturnType<typeof world>>, names: string[], files: Record<string, string>, opts: { links?: boolean } = {}) {
    const runs: (EphemeralOpts & { handed: string[] })[] = [];
    w.docker.ephemeral = (o) => {
      runs.push({ ...o, handed: [...w.handed] });
      const script = o.cmd[0]!;
      if (script.startsWith('exec tar -tzf')) return { stdout: names.join('\n') + '\n', stderr: '', exitCode: 0 };
      const out = o.binds!.find((b) => b.endsWith(':/out'))!.slice(0, -':/out'.length);
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
        fs.writeFileSync(path.join(out, name), content);
      }
      if (opts.links) return { stdout: '', stderr: 'links or special files: link-to-etc \n', exitCode: 3 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    return runs;
  }

  async function upload(w: TestWorld, bytes: Buffer) {
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
    const id = 'mount-upload-000000001';
    const put = await app.inject({
      method: 'PUT',
      url: `/api/sites/shop/app/mount-uploads/${id}?offset=0&size=${bytes.length}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect([put.statusCode, put.json()]).toEqual([200, { received: bytes.length, complete: true }]);
    const fillRes = await app.inject({ method: 'PUT', url: '/api/sites/shop/app/mounts/uploads', headers, payload: { uploadId: id } });
    expect(fillRes.statusCode).toBe(202);
    return { id, jobId: fillRes.json().job.id as number };
  }

  const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]);

  it('is filled before the app first runs: an app made with mounts is made stopped, with no gate and no routes', async () => {
    const w = await world();
    const routes = path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName('shop'));
    const { site, job } = w.deps.sites.create(siteCreateBody.parse(body));
    const done = await finish(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('stopped');
    // Made, never started, never asked.
    expect(w.docker.containers.get('wp-shop')).toBe('created');
    expect(w.docker.calls.filter((c) => c.method === 'startContainer' && c.args[0] === 'wp-shop')).toEqual([]);
    expect(w.docker.calls.filter((c) => c.method === 'runEphemeral' && (c.args[0] as EphemeralOpts).labels?.['wpl7.probe'])).toEqual([]);
    await w.deps.appRoutes.idle();
    expect(fs.existsSync(routes)).toBe(false);
    expect(w.db.select().from(appDeploys).where(eq(appDeploys.siteId, site.id)).all()).toMatchObject([{ origin: 'create', result: 'ok', digest: digest(1) }]);
    const lines = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).orderBy(jobLogs.id).all();
    expect(lines.at(-1)!.message).toBe('Created stopped: fill its mounts on the Settings tab, then Start it.');

    // Filled while it is stopped, then started: it runs on its files, with its routes.
    unpacker(w, ['./logo.png'], { 'logo.png': 'logo' });
    const filled = await finish(w, (await upload(w, GZIP)).jobId);
    expect(filled.status, filled.error ?? '').toBe('succeeded');
    expect(jobLog(w, filled.id)).toContain('The app is not running: it gets the new files when it starts.');
    expect((await finish(w, w.deps.sites.action('shop', 'start').id)).status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routes, 'utf8')).toContain('url: "http://wp-shop:8000"');
  });

  it('unpacks as the app’s user in a locked-down container, swaps it in and restarts the app', async () => {
    const w = await world();
    const site = await createShop(w, { hardening: { runAs: '10001:10001' } });
    fill(w);
    const runs = unpacker(w, ['./', './logo.png', './css/site.css'], { 'logo.png': 'new logo', 'css/site.css': 'body{}' });
    const { id, jobId } = await upload(w, GZIP);
    const done = await finish(w, jobId);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(JSON.parse(done.result!)).toEqual({ slug: 'shop', mount: 'uploads', entries: 3 });
    const dir = appPaths(w.config, 'shop').mountDir('uploads');
    expect(fs.readdirSync(dir).sort()).toEqual(['css', 'logo.png']);
    expect(fs.readFileSync(path.join(dir, 'logo.png'), 'utf8')).toBe('new logo');
    // No network, no capability, only the archive and the fresh folder, as the app's user.
    expect(runs).toHaveLength(2);
    const archive = appPaths(w.config, 'shop').mountUpload(id);
    for (const r of runs) {
      expect(r.lockdown).toMatchObject({ pidsLimit: 64 });
      expect(r.lockdown!.network).toBeUndefined();
      expect(r.user).toBe('10001:10001');
      expect(r.binds).toEqual([`${archive}:/in/archive:ro`, expect.stringMatching(/mounts\/\.uploads\.new-\d+:\/out$/)]);
      // The upload left it root's, 0600: that user reads it only once it is the user's, handed over never through a link.
      expect(r.handed).toEqual([`-h -- 10001:10001 ${archive}`]);
    }
    expect(runs[1]!.cmd[0]).toContain('find /out -type d -exec chmod 700');
    expect(w.docker.calls.filter((c) => c.method === 'restartContainer').map((c) => c.args)).toEqual([['wp-shop', 20]]);
    expect(w.db.select().from(appMounts).where(and(eq(appMounts.siteId, site.id), eq(appMounts.name, 'uploads'))).get()!.filledAt).not.toBeNull();
    // The upload and the leftovers are gone.
    expect(fs.existsSync(appPaths(w.config, 'shop').mountUpload(id))).toBe(false);
    expect(fs.readdirSync(appPaths(w.config, 'shop').mounts).sort()).toEqual(['secrets', 'uploads']);
  });

  it('refuses an archive with a .. path before unpacking it, and one with a link after, leaving the mount as it was', async () => {
    const w = await world();
    await createShop(w);
    fill(w);
    const dir = appPaths(w.config, 'shop').mountDir('uploads');
    unpacker(w, ['./ok.txt', '../outside.txt'], {});
    const first = await finish(w, (await upload(w, GZIP)).jobId);
    expect(first.error).toBe('The archive is refused: "../outside.txt" has an empty, "." or ".." segment.');
    unpacker(w, ['./ok.txt', './link-to-etc'], { 'ok.txt': 'x' }, { links: true });
    const second = await finish(w, (await upload(w, GZIP)).jobId);
    expect(second.error).toBe('The archive is refused: it holds links or special files: link-to-etc');
    expect(fs.readFileSync(path.join(dir, 'logo.png'), 'utf8')).toBe('logo v1');
    expect(fs.readdirSync(appPaths(w.config, 'shop').mounts).sort()).toEqual(['secrets', 'uploads']);
  });

  it('lets go of the archive of a fill canceled before it ran, and removes it from the server', async () => {
    const w = await world();
    await createShop(w);
    const { id, jobId } = await upload(w, GZIP);
    expect(w.worker.cancel(jobId)).toBe('canceled');
    expect(() => w.deps.apps.assertUploadFree(`mount:${id}`)).not.toThrow();
    await waitFor(() => !fs.existsSync(appPaths(w.config, 'shop').mountUpload(id)));
  });
});

describe('a mount taken off the app', () => {
  /** What PATCH mounts does with one it leaves out: the row goes at once, and a recreate is queued. */
  function takeOff(w: TestWorld, site: SiteRow, name: string) {
    w.db.delete(appMounts).where(and(eq(appMounts.siteId, site.id), eq(appMounts.name, name))).run();
    return w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });
  }
  /** A recreate no one asked for: the hourly sweep's, a CPU cap's. */
  const sweep = (w: TestWorld, site: SiteRow) => finish(w, w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 }).id);
  /** Folders of a fill that is swapping one in, and one no mount could be called: never a mount's. */
  function notMounts(w: TestWorld): string[] {
    const names = ['.secrets.new-7', '.uploads.old-8', 'Notes'];
    for (const name of names) fs.mkdirSync(path.join(appPaths(w.config, 'shop').mounts, name), { recursive: true });
    return names;
  }
  const mountFolders = (w: TestWorld) => fs.readdirSync(appPaths(w.config, 'shop').mounts).sort();
  const failing = (w: TestWorld, site: SiteRow) => {
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    w.docker.appHttp = () => 500;
  };

  it('takes its files with it once the new container is in, and no other folder', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const others = notMounts(w);
    const done = await finish(w, takeOff(w, site, 'secrets').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(creates(w.docker).at(-1)!.binds.some((b) => b.includes('/mounts/secrets'))).toBe(false);
    expect(mountFolders(w)).toEqual([...others, 'uploads'].sort());
    expect(jobLog(w, done.id)).toContain('Removed the files of secrets, which is no longer a mount.');
    expect(fs.readFileSync(path.join(appPaths(w.config, 'shop').mountDir('uploads'), 'logo.png'), 'utf8')).toBe('logo v1');
  });

  it('leaves them to the old container when the new one does not pass, and the next recreate that passes takes them, whatever queued it', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const others = notMounts(w);
    failing(w, site);
    const done = await finish(w, takeOff(w, site, 'secrets').id);
    expect(done.status).toBe('failed');
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(fs.readFileSync(path.join(appPaths(w.config, 'shop').mountDir('secrets'), 'key.pem'), 'utf8')).toBe('key v1');
    w.docker.appHttp = null;
    const next = await sweep(w, site);
    expect(next.status, next.error ?? '').toBe('succeeded');
    expect(mountFolders(w)).toEqual([...others, 'uploads'].sort());
    expect(jobLog(w, next.id)).toContain('Removed the files of secrets, which is no longer a mount.');
  });

  it('leaves them while the old container, which has them, could not be removed', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    w.docker.failOn.set('removeContainer', 'the daemon did not answer');
    const done = await finish(w, takeOff(w, site, 'secrets').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.docker.containers.has('wp-shop.previous')).toBe(true);
    expect(fs.readFileSync(path.join(appPaths(w.config, 'shop').mountDir('secrets'), 'key.pem'), 'utf8')).toBe('key v1');
    expect(jobLog(w, done.id)).toContain(`The files of secrets stay in ${appPaths(w.config, 'shop').mounts}: the old container, which has them, is still there.`);
  });

  it('takes its files with a deploy too, of an app that is stopped, after a recreate that never ran', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    expect(w.worker.cancel(takeOff(w, site, 'uploads').id)).toBe('canceled');
    expect(mountFolders(w)).toEqual(['secrets', 'uploads']);
    push(w.docker, 2);
    const deployed = await finish(w, (await w.deps.apps.deploy('shop', {})).id);
    expect(deployed.status, deployed.error ?? '').toBe('succeeded');
    expect(w.docker.containers.get('wp-shop')).toBe('created');
    expect(mountFolders(w)).toEqual(['secrets']);
    expect(jobLog(w, deployed.id)).toContain('Removed the files of uploads, which is no longer a mount.');
  });

  it('keeps the files of one that is on the app again by then', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const again = () => w.db.insert(appMounts).values({ siteId: site.id, name: 'secrets', containerPath: '/run/secrets/app', inBackups: 0 }).run();
    // Back before its recreate ran.
    const job = takeOff(w, site, 'secrets');
    again();
    expect((await finish(w, job.id)).status).toBe('succeeded');
    expect(fs.readFileSync(path.join(appPaths(w.config, 'shop').mountDir('secrets'), 'key.pem'), 'utf8')).toBe('key v1');
    // Back after its recreate failed, before the next one passed.
    failing(w, site);
    expect((await finish(w, takeOff(w, site, 'secrets').id)).status).toBe('failed');
    again();
    w.docker.appHttp = null;
    const next = await sweep(w, site);
    expect(next.status, next.error ?? '').toBe('succeeded');
    expect(creates(w.docker).at(-1)!.binds).toContain(`${appPaths(w.config, 'shop').mountDir('secrets')}:/run/secrets/app:ro`);
    expect(fs.readFileSync(path.join(appPaths(w.config, 'shop').mountDir('secrets'), 'key.pem'), 'utf8')).toBe('key v1');
    expect(jobLog(w, next.id)).not.toContain('Removed the files');
  });
});

describe('moving a container app', () => {
  it('forwards its plain http routes on port 80 too', () => {
    const yaml = proxyConfigYaml({ slug: 'shop', hosts: ['shop.example.com'], httpHosts: ['shop.example.com'], targetIp: '203.0.113.9', tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt' });
    expect(yaml).toContain('    move-shop-http:\n      rule: "Host(`shop.example.com`)"\n      entryPoints: [web]\n      service: move-shop-http');
    expect(yaml).toContain('    move-shop-http:\n      loadBalancer:\n        servers:\n          - url: "http://203.0.113.9:80"');
    expect(proxyConfigYaml({ slug: 'shop', hosts: ['shop.example.com'], targetIp: '203.0.113.9', tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt' })).not.toContain('move-shop-http');
  });

  it('takes its image, its files and the mounts kept out of backups, and its routes, to the target', async () => {
    const w = await world();
    const site = await createShop(w);
    fill(w);
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    prepare(s2.docker);
    const job = w.deps.sites.move('shop', { targetServerId: s2.id });
    const done = await finish(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    // Pulled there by its digest, with its login; the container made from it, pinned.
    expect(s2.docker.calls.filter((c) => c.method === 'pullImage').map((c) => c.args)).toEqual([[`${REPO}@${digest(1)}`, { auth: 'ci' }]]);
    expect(creates(s2.docker).at(-1)).toMatchObject({ image: `${REPO}@${digest(1)}`, labels: { 'traefik.enable': 'false', 'wpl7.role': 'app' } });
    const target = path.join(s2.root!, 'sites', 'shop');
    expect(fs.readFileSync(path.join(target, 'data', 'var-lib-shop', 'orders.db'), 'utf8')).toBe('orders v1');
    expect(fs.readFileSync(path.join(target, 'mounts', 'uploads', 'logo.png'), 'utf8')).toBe('logo v1');
    // Not in the snapshot, carried by a pipe of its own.
    expect(fs.readFileSync(path.join(target, 'mounts', 'secrets', 'key.pem'), 'utf8')).toBe('key v1');
    // It was stopped while it was copied: a worker in it never runs twice.
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer').map((c) => c.args)).toContainEqual(['wp-shop', 20]);
    // Its routes are the target's now, and the source forwards its own hosts there (without TLS,
    // on web alone: the https case is the test above).
    await w.deps.appRoutes.idle();
    expect(fs.existsSync(path.join(s2.root!, 'traefik', 'dynamic', appRoutesFileName('shop')))).toBe(true);
    expect(fs.existsSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName('shop')))).toBe(false);
    const forwarder = fs.readFileSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', 'move-shop.yml'), 'utf8');
    expect(forwarder).toContain('rule: "Host(`shop.example.com`) || Host(`shop.dev.example.test`)"');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.serverId).toBe(s2.id);
  });

  it('leaves a stopped app stopped on the source when its move fails after the stop', async () => {
    const w = await world();
    const site = await createShop(w);
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    prepare(s2.docker);
    // The snapshot fails: after the source has stopped, before anything reached the target.
    w.core.backup.createOn = async () => {
      throw new Error('the disk is full');
    };
    const starts = () => w.docker.calls.filter((c) => c.method === 'startContainer' && c.args[0] === 'wp-shop').length;
    const before = starts();
    const done = await finish(w, w.deps.sites.move('shop', { targetServerId: s2.id }).id);
    expect(done.error).toBe('the disk is full');
    expect(w.docker.calls.filter((c) => c.method === 'stopContainer').map((c) => c.args).at(-1)).toEqual(['wp-shop', 20]);
    expect(starts()).toBe(before);
    expect(w.docker.containers.get('wp-shop')).toBe('exited');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!).toMatchObject({ status: 'stopped', serverId: 1 });
    // And the log says so.
    expect(jobLog(w, done.id)).toContain('Target rolled back; the site stays stopped on the source. Re-running the move is safe.');
    expect(jobLog(w, done.id)).not.toContain('keeps running');
  });

  it('says a running app keeps running on the source when its move fails', async () => {
    const w = await world();
    await createShop(w);
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    prepare(s2.docker);
    w.core.backup.createOn = async () => {
      throw new Error('the disk is full');
    };
    const done = await finish(w, w.deps.sites.move('shop', { targetServerId: s2.id }).id);
    expect(done.error).toBe('the disk is full');
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    expect(jobLog(w, done.id)).toContain('Target rolled back; the site keeps running on the source. Re-running the move is safe.');
  });

  it('pulls its image on the target from the repository it came by, after the app’s reference has changed', async () => {
    const w = await world();
    const site = await createShop(w);
    watch(w, site, 'ghcr.io/example/store:stable');
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    prepare(s2.docker);
    const done = await finish(w, w.deps.sites.move('shop', { targetServerId: s2.id }).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(s2.docker.calls.filter((c) => c.method === 'pullImage').map((c) => c.args)).toEqual([[`${REPO}@${digest(1)}`, { auth: 'ci' }]]);
    expect(creates(s2.docker).at(-1)!.image).toBe(`${REPO}@${digest(1)}`);
  });
});
