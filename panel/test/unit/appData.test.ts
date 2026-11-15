/**
 * A container app's files: what its backups hold, what a restore puts back (its image too), its
 * final backup, a mount filled from an archive, and a move to another server.
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
 * `chowns`: each `chown -R` of the app's folders is noted there, by owner, and not run: on a test
 * machine it would fail for any user but the one the tests run as.
 */
async function world(opts: { chowns?: string[] } = {}): Promise<TestWorld> {
  const { chowns } = opts;
  const exec: ExecPort = chowns
    ? {
        ...hostExec,
        run: async (cmd, args, o) => {
          if (cmd !== 'chown') return hostExec.run(cmd, args, o);
          if (args[0] === '-R') chowns.push(args[1]!);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    : hostExec;
  const w = await makeWorld({ exec });
  w.deps.settings.set('backupBeforeUpdates', 'never');
  prepare(w.docker);
  return w;
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

async function createShop(w: TestWorld, extra: Record<string, unknown> = {}) {
  const { job } = w.deps.sites.create(siteCreateBody.parse({ ...body, ...extra }));
  const done = await finish(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
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
    const chowns: string[] = [];
    const w = await world({ chowns });
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
    expect(zipListNames('Archive:  /in/archive\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n       12  11-14-2026 20:00   a.txt\n        0  11-14-2026 20:00   dir/\n---------                     -------\n       12                     2 files\n')).toEqual(['a.txt', 'dir/']);
  });

  /** The unpacker, as busybox in Traefik's image runs it: the listing, then the files in /out. */
  function unpacker(w: TestWorld, names: string[], files: Record<string, string>, opts: { links?: boolean } = {}) {
    const runs: EphemeralOpts[] = [];
    w.docker.ephemeral = (o) => {
      runs.push(o);
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

  it('unpacks as the app’s user in a locked-down container, swaps it in and restarts the app', async () => {
    const w = await world();
    const site = await createShop(w);
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
    for (const r of runs) {
      expect(r.lockdown).toMatchObject({ pidsLimit: 64 });
      expect(r.lockdown!.network).toBeUndefined();
      expect(r.user).toBe('0:0');
      expect(r.binds).toEqual([`${appPaths(w.config, 'shop').mountUpload(id)}:/in/archive:ro`, expect.stringMatching(/mounts\/\.uploads\.new-\d+:\/out$/)]);
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
