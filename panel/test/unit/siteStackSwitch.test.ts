/**
 * A site's container follows the image on its server (services/siteSpec.ts siteContainerSpec), and a
 * site moving from stack 1 to stack 2 gets its old container back when it doesn't come up there
 * (jobs/handlers/sites.ts). The real Docker's side of this: test/engine/siteSwitch.test.ts, and the last
 * part of test/engine/siteStack.test.ts.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostExec } from '../../src/lib/exec.js';
import { jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { GEOLOCATE_OFF_REASON } from '../../src/jobs/handlers/sites.js';
import type { SiteContainerSpec } from '../../src/services/docker.js';
import * as siteMigration from '../../src/services/siteMigration.js';
import { sweepSiteImages } from '../../src/services/siteImages.js';
import { siteContainerStack } from '../../src/services/siteCaches.js';
import { RUNTIME_DIR_IN_CONTAINER, SITE_STACK_LABEL } from '../../src/services/siteStack.js';
import { asideContainerName, siteContainerSpec, siteImage, sitePaths, siteRuntimeFrom } from '../../src/services/siteSpec.js';
import { parseSiteCacheRules } from '../../shared/cacheRules.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { HAS_PHP, useRealMigration } from '../realMigration.js';

const TAG = siteImage('8.3');
const OLD_ID = `sha256:${TAG}`;
const NEW_ID = 'sha256:new-image';
const portLabel = (slug: string) => `traefik.http.services.wp-${slug}.loadbalancer.server.port`;

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const logOf = (w: TestWorld, jobId: number) =>
  w.db
    .select()
    .from(jobLogs)
    .where(eq(jobLogs.jobId, jobId))
    .all()
    .map((l) => l.message);

const specs = (w: TestWorld): SiteContainerSpec[] =>
  w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);

const rowOf = (w: TestWorld, site: SiteRow) => w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;

async function createSite(w: TestWorld): Promise<SiteRow> {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
  const { site, job } = w.deps.sites.create({
    title: 'Demo Site',
    domainMode: 'dev' as const,
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  const done = await runJob(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

/**
 * A site that has run stack 1 until now, on a server whose update has just moved its tag: the image
 * it runs has no name any more, and the tag names a stack 2 image. With `deleted`, Docker has
 * deleted the old image too, as a `docker build` does on the containerd store.
 */
async function siteOnOldImage(w: TestWorld, opts: { deleted?: boolean } = {}): Promise<SiteRow> {
  w.docker.stackOf(TAG, 1);
  const site = await createSite(w);
  expect(await siteContainerStack(w.docker, site.containerName)).toBe(1);
  if (opts.deleted) w.docker.rebuild(TAG, NEW_ID);
  else w.docker.imageIds.set(TAG, NEW_ID);
  w.docker.calls.length = 0;
  return site;
}

/** The order some calls were made in, by method. */
const order = (w: TestWorld, methods: string[]) => w.docker.calls.map((c) => c.method).filter((m) => methods.includes(m));

const SWITCH_CALLS = ['renameContainer', 'stopContainer', 'removeContainer', 'createSiteContainer', 'startContainer'];

const asideOf = (site: SiteRow) => asideContainerName(site.containerName);

/** The site's own old container has its name back: not one made again, which its image may not allow. */
function expectOldContainerBack(w: TestWorld, site: SiteRow, state: 'running' | 'exited' = 'running') {
  expect(w.docker.imageByContainer.get(site.containerName)).toBe(OLD_ID);
  const labels = w.docker.labelsByContainer.get(site.containerName)!;
  expect(labels).not.toHaveProperty(SITE_STACK_LABEL);
  expect(labels[portLabel(site.slug)]).toBe('80');
  expect(w.docker.containers.get(site.containerName)).toBe(state);
  expect(w.docker.containers.has(asideOf(site))).toBe(false);
  expect(w.docker.calls.filter((c) => c.method === 'renameContainer').at(-1)!.args).toEqual([asideOf(site), site.containerName]);
}

describe('the stack of a container follows its image', () => {
  it('gives a stack 2 image nginx’s port, the label and the runtime folder', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    for (const spec of specs(w)) {
      expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
      expect(spec.binds.some((b) => b.endsWith(`:${RUNTIME_DIR_IN_CONTAINER}:ro`))).toBe(true);
    }
    expect(specs(w).at(-1)!.labels[portLabel(site.slug)]).toBe('8080');
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
  });

  it('gives an image from before stack 2 a container like the ones it always had', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    for (const spec of specs(w)) {
      expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
      expect(spec.binds.some((b) => b.includes(RUNTIME_DIR_IN_CONTAINER))).toBe(false);
    }
    expect(specs(w).at(-1)!.labels[portLabel(site.slug)]).toBe('80');
  });

  it('counts an image that is not there as stack 1, and asks the image, not the site', async () => {
    const w = await makeWorld();
    expect(await w.docker.imageStack('wpl7-wordpress:php9.9')).toBe(1);
    const site = await createSite(w);
    const handle = w.servers.handleFor(1);
    const spec = await siteContainerSpec(w.core, handle, { ...site, phpVersion: '9.9' }, ['a.example.com'], siteRuntimeFrom(w.core.settings, site));
    expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
    expect(spec.image).toBe('wpl7-wordpress:php9.9');
  });

  it('keeps building stack 1 on a server with only old images, with no move to attempt', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    const migrate = vi.spyOn(siteMigration, 'migrateSiteForStack2');
    // A patched image, from before stack 2 all the same.
    w.docker.imageIds.set(TAG, 'sha256:patched');
    w.docker.imageStacks.set('sha256:patched', 1);
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(specs(w).at(-1)!.labels).not.toHaveProperty(SITE_STACK_LABEL);
    expect(migrate).not.toHaveBeenCalled();
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(1);
  });

  it('follows the image when a change of PHP lands on a tag still from before stack 2', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const other = siteImage('8.4');
    w.docker.images.add(other);
    w.docker.stackOf(other, 1);
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const spec = specs(w).at(-1)!;
    expect(spec.image).toBe(other);
    expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
  });

  it('reads the stack after an image was built for the change, not before', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    expect(await w.docker.imageExists(siteImage('8.4'))).toBe(false);
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.docker.calls.some((c) => c.method === 'buildImage')).toBe(true);
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
  });

  it('follows the image on the server a site moves to', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    target.docker.stackOf(TAG, 1);
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const spec = target.docker.calls.find((c) => c.method === 'createSiteContainer')!.args[0] as SiteContainerSpec;
    expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
    expect(spec.labels[portLabel(site.slug)]).toBe('80');
  });

  it('refuses to move a site using the object cache to a server still on the old image, and says why', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.db.update(sites).set({ objectCache: 1 }).where(eq(sites.id, site.id)).run();
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    target.docker.stackOf(TAG, 1);
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/no object cache yet/);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('moves a stack 1 site onto stack 2 by going to a server that has it', async () => {
    const w = await makeWorld({ exec: hostExec });
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    const target = w.addSshServer('target', { real: true, publicIp: '203.0.113.9' });
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: target.id }).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const spec = target.docker.calls.find((c) => c.method === 'createSiteContainer')!.args[0] as SiteContainerSpec;
    expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
    expect(spec.labels[portLabel(site.slug)]).toBe('8080');
    expect(fs.existsSync(path.join(target.root!, 'sites', site.slug, 'config', 'runtime', 'nginx-site.conf'))).toBe(true);
  });

  it('keeps a site whose move failed on its old image through a restore that recreates its container', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    const backup = await w.core.backup.create(rowOf(w, site), 'manual', {});
    const manifestPath = path.join(backup.path, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), tablePrefix: 'other_' }));
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(specs(w).at(-1)).toMatchObject({ image: OLD_ID });
    expect(specs(w).at(-1)!.labels).not.toHaveProperty(SITE_STACK_LABEL);
  });

  it('builds a restore on the new image once Docker has deleted the old one', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await siteOnOldImage(w, { deleted: true });
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    const backup = await w.core.backup.create(rowOf(w, site), 'manual', {});
    const manifestPath = path.join(backup.path, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), tablePrefix: 'other_' }));
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(specs(w).some((spec) => spec.image === OLD_ID)).toBe(false);
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
  });

  it('follows the image a restore recreates a container on', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const other = siteImage('8.4');
    w.docker.images.add(other);
    w.docker.stackOf(other, 1);
    w.core.settings.set('phpVersions', ['8.3', '8.4']);
    const backup = await w.core.backup.create(site, 'manual', {});
    const manifestPath = path.join(backup.path, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), phpVersion: '8.4' }));
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const spec = specs(w).at(-1)!;
    expect(spec.image).toBe(other);
    expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
  });

  it('goes through one helper: nothing else can pick a stack', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /\bbuildSiteContainerSpec\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(path.relative(src, full));
      }
    };
    walk(src);
    expect(callers).toEqual(['services/siteSpec.ts']);
    const siteSpec = fs.readFileSync(path.join(src, 'services/siteSpec.ts'), 'utf8');
    // The definition, and the one call: in siteContainerSpec.
    expect(siteSpec.match(/\bbuildSiteContainerSpec\(/g)).toHaveLength(2);
  });
});

describe('putting a container back', () => {
  it('puts the old container itself back after the tag has moved, with the stack it was', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.imageIds.set(TAG, NEW_ID);
    w.docker.calls.length = 0;
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    // The create that failed is the spy's: the fake never saw it.
    expect(order(w, SWITCH_CALLS)).toEqual(['renameContainer', 'stopContainer', 'removeContainer', 'renameContainer', 'startContainer']);
    expect(await w.docker.containerStack(site.containerName)).toEqual({ imageId: OLD_ID, stack: 2 });
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
    const list = await w.docker.listManaged(['wpl7.role=wordpress']);
    expect(list.find((c) => c.name === site.containerName)!.imageId).toBe(OLD_ID);
    vi.restoreAllMocks();
  });

  it('puts it back when Docker has deleted its image, which nothing could be made from', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.rebuild(TAG, NEW_ID);
    w.docker.calls.length = 0;
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('OCI runtime create failed'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/OCI runtime create failed/);
    expect(specs(w).map((spec) => spec.image)).toEqual([TAG]);
    expect(w.docker.imageByContainer.get(site.containerName)).toBe(OLD_ID);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
    vi.restoreAllMocks();
  });

  it('keeps a stack 1 container stack 1 when its own image comes back', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    w.docker.imageIds.set(TAG, 'sha256:patched');
    w.docker.imageStacks.set('sha256:patched', 1);
    w.docker.calls.length = 0;
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    expectOldContainerBack(w, site);
    vi.restoreAllMocks();
  });

  it('builds from the tag when there was no container to read an image from', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await w.docker.removeContainer(site.containerName);
    w.docker.calls.length = 0;
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    expect(specs(w).at(-1)!.image).toBe(TAG);
    vi.restoreAllMocks();
  });

  it('puts the old container back when a change of PHP fails its check after the swap', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    // The tag has moved since the container was made, and its image is gone.
    w.docker.rebuild(TAG, NEW_ID);
    w.docker.images.add(siteImage('8.4'));
    let starts = 0;
    w.docker.onStart = (name) => {
      if (name === site.containerName && ++starts === 1) w.docker.containers.set(name, 'exited');
    };
    const job = w.deps.sites.changePhp(site.slug, '8.4');
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toBe('PHP 8.4 switch failed the smoke check');
    expect(logOf(w, job.id).join('\n')).toContain('the site is not responding on PHP 8.4');
    expect(specs(w).at(-1)!.image).toBe(siteImage('8.4'));
    expect(w.docker.imageByContainer.get(site.containerName)).toBe(OLD_ID);
    expect(rowOf(w, site).phpVersion).toBe('8.3');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
  });
});

describe('moving to stack 2', () => {
  let migrate: ReturnType<typeof vi.spyOn<typeof siteMigration, 'migrateSiteForStack2'>>;
  let undo: ReturnType<typeof vi.spyOn<typeof siteMigration, 'undoSiteMigration'>>;

  beforeEach(() => {
    migrate = vi.spyOn(siteMigration, 'migrateSiteForStack2').mockResolvedValue(undefined);
    undo = vi.spyOn(siteMigration, 'undoSiteMigration').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** The site's row after a move that failed, and nothing left aside. */
  function expectFailedMove(w: TestWorld, site: SiteRow, done: { status: string; error: string | null }, reason: RegExp) {
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^This site still runs the old PHP setup: /);
    expect(done.error).toMatch(reason);
    const row = rowOf(w, site);
    expect(row.stackSwitchError).toMatch(reason);
    expect(done.error).toContain(row.stackSwitchError!);
    expect(row.stackSwitchImage).toBe(NEW_ID);
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
    expect(order(w, ['tagImage'])).toEqual([]);
  }

  it('moves a running site: files moved, old container aside, new container up, old one gone', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    // What an earlier try left.
    w.db.update(sites).set({ stackSwitchError: 'it did not answer', stackSwitchImage: 'sha256:older' }).where(eq(sites.id, site.id)).run();
    migrate.mockImplementation(async () => {
      expect(w.docker.containers.get(site.containerName)).toBe('running');
      expect(w.docker.containers.has(asideOf(site))).toBe(false);
    });
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(order(w, SWITCH_CALLS)).toEqual(['renameContainer', 'stopContainer', 'createSiteContainer', 'startContainer', 'removeContainer']);
    const args = (method: string) => w.docker.calls.find((c) => c.method === method)!.args;
    expect(args('renameContainer')).toEqual([site.containerName, asideOf(site)]);
    expect(args('stopContainer')).toEqual([asideOf(site), 0]);
    expect(args('removeContainer')).toEqual([asideOf(site)]);
    const spec = specs(w).at(-1)!;
    expect(spec.image).toBe(TAG);
    expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
    expect(spec.labels[portLabel(site.slug)]).toBe('8080');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    expect(order(w, ['tagImage'])).toEqual([]);
    expect(JSON.parse(done.result!).changed).toContain('moved to PHP-FPM');
    const log = logOf(w, job.id).join('\n');
    expect(log).toContain('mod_php');
    expect(log).toContain(asideOf(site));
    expect(log).toContain('.htaccess');
    expect(log).toContain('answers on the new setup');
  });

  it('moves a site whose old image Docker has deleted: the way back is its container', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w, { deleted: true });
    expect(await w.docker.imageExists(OLD_ID)).toBe(false);
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
  });

  it('goes back to a container whose image Docker has deleted', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w, { deleted: true });
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('OCI runtime create failed'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not start: OCI runtime create failed/);
    expectOldContainerBack(w, site);
    expect(specs(w).map((spec) => spec.image)).toEqual([TAG]);
  });

  it('runs once: the next recreate has nothing to move, and keeps the old container aside all the same', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    w.docker.calls.length = 0;
    migrate.mockClear();
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(migrate).not.toHaveBeenCalled();
    expect(order(w, SWITCH_CALLS)).toEqual(['renameContainer', 'stopContainer', 'createSiteContainer', 'startContainer', 'removeContainer']);
  });

  it('goes back when the new container cannot be created', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not be created: Docker unavailable/);
    expect(undo).toHaveBeenCalledTimes(1);
    expectOldContainerBack(w, site);
    expect(order(w, SWITCH_CALLS).slice(-3)).toEqual(['removeContainer', 'renameContainer', 'startContainer']);
  });

  it('goes back when the new container cannot start', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('OCI runtime create failed'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not start: OCI runtime create failed/);
    expect(undo).toHaveBeenCalledTimes(1);
    expectOldContainerBack(w, site);
  });

  it('goes back when the site does not answer, and says what the check saw', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    let starts = 0;
    w.docker.onStart = (name) => {
      if (name === site.containerName && ++starts === 1) w.docker.containers.set(name, 'exited');
    };
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /check on the new setup failed: its container is exited/);
    expect(undo).toHaveBeenCalledTimes(1);
    expectOldContainerBack(w, site);
    // Back up on its own image, and the tag has still moved on.
    expect(await w.docker.imageId(TAG)).toBe(NEW_ID);
    expect((await w.docker.containerStack(site.containerName))!.imageId).toBe(OLD_ID);
  });

  describe('with a real check of the site', () => {
    let edge: http.Server | null = null;
    afterEach(async () => {
      if (edge) await new Promise((r) => edge!.close(r));
      edge = null;
    });

    /** What the site answers through Traefik, and a world that asks it as a live panel would. */
    async function liveWorld(answer: () => number) {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      edge = http.createServer((_req, res) => res.writeHead(answer()).end(''));
      await new Promise<void>((r) => edge!.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(edge.address() as AddressInfo).port}/`;
      w.servers.handleFor(1).probeUrlFor = () => url;
      (w.core.config as { nodeEnv: string }).nodeEnv = 'production';
      return { w, site };
    }

    it('goes back from a site that answered before and answers HTTP 500 now, and says so', async () => {
      let status = 200;
      const { w, site } = await liveWorld(() => status);
      w.docker.onStart = () => {
        status = 500;
      };
      const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
      expectFailedMove(w, site, done, /check on the new setup failed: it answered HTTP 500/);
      expectOldContainerBack(w, site);
      expect(undo).toHaveBeenCalledTimes(1);
    });

    it('says so when nothing answers at all', async () => {
      let status = 200;
      const { w, site } = await liveWorld(() => status);
      w.docker.onStart = () => {
        status = 200;
        const url = 'http://127.0.0.1:1/';
        w.servers.handleFor(1).probeUrlFor = () => url;
      };
      const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
      expectFailedMove(w, site, done, /check on the new setup failed: nothing answered/);
    });

    it('moves a site that answers on the new setup', async () => {
      const { w, site } = await liveWorld(() => 200);
      const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
      expect(undo).not.toHaveBeenCalled();
    });

    it('does not hold a site that was broken before against the new setup', async () => {
      const { w, site } = await liveWorld(() => 500);
      const job = w.deps.sites.reconcile(site.slug);
      const done = await runJob(w, job.id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(undo).not.toHaveBeenCalled();
      expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
      expect(logOf(w, job.id).join('\n')).toContain('it answered HTTP 500');
      expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    });
  });

  it('undoes the migration before the new container goes, and after that puts the old one back', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    let atUndo: string[] = [];
    undo.mockImplementation(async () => {
      atUndo = order(w, ['removeContainer', 'renameContainer']);
    });
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    await runJob(w, w.deps.sites.reconcile(site.slug).id);
    // The old container is aside so far; the new one goes, and the old one comes back, after the undo.
    expect(atUndo).toEqual(['renameContainer']);
    expect(order(w, ['removeContainer', 'renameContainer'])).toEqual(['renameContainer', 'removeContainer', 'renameContainer']);
  });

  it('leaves the old container alone when the migration fails: nothing has been taken down', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    migrate.mockRejectedValueOnce(new Error('cannot write wp-content/.htaccess'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /\.htaccess files could not be moved: cannot write/);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(order(w, SWITCH_CALLS)).toEqual([]);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('starts the old container again when it could not be renamed: it never left', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'renameContainer').mockRejectedValueOnce(new Error('daemon busy'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /old container could not be renamed: daemon busy/);
    expect(order(w, ['removeContainer', 'createSiteContainer'])).toEqual([]);
    expect(w.docker.imageByContainer.get(site.containerName)).toBe(OLD_ID);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('says so when the old container could not be put back either, keeps it aside, and Recreate puts it back first', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    const rename = w.docker.renameContainer.bind(w.docker);
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(w.docker, 'renameContainer').mockImplementationOnce(rename).mockRejectedValueOnce(new Error('disk still full'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    expect(done.error).not.toContain('still runs');
    expect(done.error).toMatch(/could not be created: disk full.*could not be put back: disk still full/);
    expect(done.error).toContain(`kept, stopped, as ${asideOf(site)}`);
    expect(done.error).toContain('Recreate container');
    expect(rowOf(w, site).stackSwitchError).toMatch(/disk full.*disk still full/);
    expect(w.docker.containers.has(site.containerName)).toBe(false);
    expect(w.docker.containers.get(asideOf(site))).toBe('exited');
    vi.restoreAllMocks();
    migrate = vi.spyOn(siteMigration, 'migrateSiteForStack2').mockResolvedValue(undefined);

    w.docker.calls.length = 0;
    const job = w.deps.sites.reconcile(site.slug);
    const again = await runJob(w, job.id);
    expect(again.status, again.error ?? '').toBe('succeeded');
    expect(w.docker.calls.find((c) => c.method === 'renameContainer')!.args).toEqual([asideOf(site), site.containerName]);
    expect(logOf(w, job.id).join('\n')).toContain(`${asideOf(site)} is the container from before a change that did not finish`);
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
  });

  it('migrates a stopped site, without starting or checking it', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.containers.set(site.containerName, 'exited');
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(order(w, SWITCH_CALLS)).toEqual(['renameContainer', 'stopContainer', 'createSiteContainer', 'removeContainer']);
    expect(w.docker.containers.get(site.containerName)).toBe('created');
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    expect(w.docker.containers.has(asideOf(site))).toBe(false);
    expect(logOf(w, job.id).join('\n')).toContain('stays stopped');
  });

  it('puts a stopped site back stopped', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.containers.set(site.containerName, 'exited');
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/still runs the old PHP setup/);
    expect(order(w, ['startContainer'])).toEqual([]);
    expectOldContainerBack(w, site, 'exited');
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('goes back to its old container through a change of PHP, and the old tag stays', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    // A change of PHP: the old tag stays where it is, and the new one is stack 2.
    const other = siteImage('8.4');
    w.docker.images.add(other);
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/still runs the old PHP setup/);
    expectOldContainerBack(w, site);
    expect(w.docker.labelsByContainer.get(site.containerName)!['wpl7.php']).toBe('8.3');
    expect(w.docker.images.has(TAG)).toBe(true);
    expect(rowOf(w, site)).toMatchObject({ phpVersion: '8.3', stackSwitchImage: `sha256:${other}` });
  });

  it('moves a site through a change of PHP, without checking it twice', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    w.docker.images.add(siteImage('8.4'));
    // The move has asked the site already, and its old container is gone once the move is over:
    // a second check would have nothing to go back to.
    const remove = w.docker.removeContainer.bind(w.docker);
    vi.spyOn(w.docker, 'removeContainer').mockImplementation(async (name) => {
      if (name === asideOf(site)) vi.spyOn(w.docker, 'containerState').mockResolvedValue('exited');
      return remove(name);
    });
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(rowOf(w, site).phpVersion).toBe('8.4');
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('fails a domain change with the reason, and leaves the domains as they were', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    const before = rowOf(w, site).domains;
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    const done = await runJob(w, w.deps.sites.updateDomains(site.slug, ['customer.example.test'], true, true).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/still runs the old PHP setup/);
    expect(rowOf(w, site).domains).toBe(before);
    expect(rowOf(w, site).isLive).toBe(0);
    expectOldContainerBack(w, site);
  });

  it('does not send back a site that was not answering before', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    // Never started: a failed start parked it, and the row says it should run.
    w.docker.containers.set(site.containerName, 'created');
    w.docker.onStart = (name) => {
      if (name === site.containerName) w.docker.containers.set(name, 'exited');
    };
    const job = w.deps.sites.reconcile(site.slug);
    await runJob(w, job.id);
    expect(undo).not.toHaveBeenCalled();
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(logOf(w, job.id).join('\n')).toContain('stays on the new setup');
  });

  it('stays on the old image through a change of domains once it has failed on this image', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');

    const job = w.deps.sites.updateDomains(site.slug, ['customer.example.test'], true, true);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(specs(w).at(-1)).toMatchObject({ image: OLD_ID });
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBeUndefined();
    expect(logOf(w, job.id).join('\n')).toContain('stays on the old PHP setup');
    // Still something to fix: the error stays, and so does what it failed on.
    expect(rowOf(w, site).stackSwitchImage).toBe(NEW_ID);
    expect((await w.deps.sites.detail(site.slug)).stackSwitchError).toMatch(/could not start: no/);
  });

  it('tries the move again through a change of domains once Docker has deleted its old image', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w, { deleted: true });
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    expectOldContainerBack(w, site);

    const job = w.deps.sites.updateDomains(site.slug, ['customer.example.test'], true, true);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    // Nothing was made from the image Docker no longer has, which would have left the site with no container.
    expect(specs(w).some((spec) => spec.image === OLD_ID)).toBe(false);
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(logOf(w, job.id).join('\n')).not.toContain('stays on the old PHP setup');
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
  });

  it('does not claim a change of PHP on its old image: a failed one tries the move again', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    w.docker.imageIds.set(siteImage('8.4'), NEW_ID);
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(specs(w).at(-1)!.image).toBe(siteImage('8.4'));
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
  });

  it('tries again when someone asks, and clears the error when it works', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    expect(rowOf(w, site).stackSwitchImage).toBe(NEW_ID);
    expect((await w.deps.sites.detail(site.slug)).stackSwitchError).toMatch(/could not start: no/);
    expect((await w.deps.sites.detail(site.slug)).stack).toBe(1);

    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    expect((await w.deps.sites.detail(site.slug)).stack).toBe(2);
    expect((await w.deps.sites.detail(site.slug)).stackSwitchError).toBeNull();
  });

  describe('the image sweep', () => {
    it('repairs a container a panel from before stack 2 made on the new image', async () => {
      const w = await makeWorld();
      const site = await createSite(w);
      // What the old panel builds: Apache's port, no stack label, on the image the tag names now.
      w.docker.labelsByContainer.set(site.containerName, { 'wpl7.managed': 'true', 'wpl7.role': 'wordpress', 'wpl7.site': site.slug });
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
      const job = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all().at(-1)!;
      w.docker.calls.length = 0;
      const done = await runJob(w, job.id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
      // Nothing to go back to: it never worked, so it is not kept aside.
      expect(w.docker.calls.some((c) => c.method === 'renameContainer')).toBe(false);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    });

    it('brings back a running site whose container is gone, or never started', async () => {
      const w = await makeWorld();
      const site = await createSite(w);
      w.docker.containers.delete(site.containerName);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
      const job = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all().at(-1)!;
      expect((await runJob(w, job.id)).status).toBe('succeeded');
      expect(w.docker.containers.get(site.containerName)).toBe('running');

      w.docker.containers.set(site.containerName, 'created');
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
    });

    it('brings back a container a change left aside, which the reconcile puts back first', async () => {
      const w = await makeWorld();
      const site = await createSite(w);
      // What a panel that stopped half-way through a change leaves: the old container aside, none in its place.
      await w.docker.renameContainer(site.containerName, asideOf(site));
      await w.docker.stopContainer(asideOf(site), 0);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
      const job = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all().at(-1)!;
      w.docker.calls.length = 0;
      expect((await runJob(w, job.id)).status).toBe('succeeded');
      expect(w.docker.calls.find((c) => c.method === 'renameContainer')!.args).toEqual([asideOf(site), site.containerName]);
      expect(w.docker.containers.get(site.containerName)).toBe('running');
      expect(w.docker.containers.has(asideOf(site))).toBe(false);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    });

    it('leaves a container aside alone while its site has a job, which may be the change itself', async () => {
      const w = await makeWorld();
      const site = await createSite(w);
      w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: 1 });
      await w.docker.renameContainer(site.containerName, asideOf(site));
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [site.slug] });
      expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all()).toHaveLength(0);
    });

    it('leaves a stopped site without a container alone', async () => {
      const w = await makeWorld();
      const site = await createSite(w);
      w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, site.id)).run();
      w.docker.containers.delete(site.containerName);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    });

    it('leaves a failed site alone while the tag names the image it failed on, and tries a new one', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
      const first = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all();
      expect(first).toHaveLength(1);
      vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
      expect((await runJob(w, first[0]!.id)).status).toBe('failed');

      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });

      w.docker.imageIds.set(TAG, 'sha256:newer');
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
      const second = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all().at(-1)!;
      expect((await runJob(w, second.id)).status).toBe('succeeded');
      expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    });
  });

  describe('a WooCommerce store on plain Geolocate', () => {
    it('keeps its page cache off, with the reason, before the runtime files are written', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.db.update(sites).set({ cacheRules: JSON.stringify({ keepSeconds: 600, off: ['phones'], own: [] }) }).where(eq(sites.id, site.id)).run();
      w.docker.wooCustomerAddress = 'geolocation';
      let nginxAtCreate = '';
      const real = w.docker.createSiteContainer.bind(w.docker);
      vi.spyOn(w.docker, 'createSiteContainer').mockImplementation(async (spec) => {
        nginxAtCreate = fs.readFileSync(path.join(sitePaths(w.config, site.slug).runtimeDir, 'nginx-site.conf'), 'utf8');
        return real(spec);
      });
      const job = w.deps.sites.reconcile(site.slug);
      expect((await runJob(w, job.id)).status).toBe('succeeded');
      const row = rowOf(w, site);
      expect(row.pageCache).toBe('off');
      const rules = parseSiteCacheRules(row.cacheRules);
      expect(rules).toMatchObject({ keepSeconds: 600, off: ['phones'], offReason: GEOLOCATE_OFF_REASON });
      expect(nginxAtCreate).toContain('The page cache is off for this site');
      expect(logOf(w, job.id).join('\n')).toContain(GEOLOCATE_OFF_REASON);
    });

    it('takes the reason along when the rest of the rules are new', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.docker.wooCustomerAddress = 'geolocation';
      expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
      expect(parseSiteCacheRules(rowOf(w, site).cacheRules).offReason).toBe(GEOLOCATE_OFF_REASON);
    });

    it.each(['geolocation_ajax', 'base', ''])('leaves a store on %j as it was', async (address) => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.docker.wooCustomerAddress = address;
      expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
      expect(rowOf(w, site)).toMatchObject({ pageCache: null, cacheRules: null });
    });

    it('leaves a site without WooCommerce as it was, whatever its option says', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.docker.wooCustomerAddress = null;
      expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
      expect(rowOf(w, site)).toMatchObject({ pageCache: null, cacheRules: null });
    });

    it('does not touch a site that has chosen, and does not ask', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.db.update(sites).set({ pageCache: 'on' }).where(eq(sites.id, site.id)).run();
      w.docker.wooCustomerAddress = 'geolocation';
      expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
      expect(rowOf(w, site)).toMatchObject({ pageCache: 'on', cacheRules: null });
      const execs = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
      expect(execs.some((line) => line.includes('woocommerce'))).toBe(false);
    });

    it('moves on when the check itself fails: the guard in wp-cache.php covers it', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.docker.wooCheckFails = true;
      const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      expect(rowOf(w, site).pageCache).toBeNull();
      expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    });

    it('does not ask a site that is stopped: WP-CLI needs it running', async () => {
      const w = await makeWorld();
      const site = await siteOnOldImage(w);
      w.docker.containers.set(site.containerName, 'exited');
      w.docker.wooCustomerAddress = 'geolocation';
      expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
      expect(rowOf(w, site).pageCache).toBeNull();
    });
  });
});

describe('the migration, as the move runs it', () => {
  const runs = (w: TestWorld) =>
    w.docker.calls
      .filter((c) => c.method === 'runEphemeral')
      .map((c) => c.args[0] as { image: string; labels: Record<string, string> })
      .filter((run) => run.labels['wpl7.migration']);

  it('runs in the image the site is going to, before the old container goes, and the answer is its own', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.execQueue.push({ stdout: 'for a test', stderr: '', exitCode: 0 });
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(runs(w).map((run) => [run.image, run.labels['wpl7.migration']])).toEqual([[TAG, 'migrate']]);
    const methods = w.docker.calls.map((c) => c.method);
    expect(methods.indexOf('runEphemeral')).toBeLessThan(methods.indexOf('renameContainer'));
    expect(w.docker.execQueue).toHaveLength(1);
  });

  it('runs on a change of PHP in the image of the new one: the old one’s tag may have gone', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    w.docker.images.add(siteImage('8.4'));
    w.docker.images.delete(TAG);
    w.docker.calls.length = 0;
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(runs(w).map((run) => run.image)).toEqual([siteImage('8.4')]);
  });

  it('is undone in the same image when the new container fails', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    expect(runs(w).map((run) => [run.image, run.labels['wpl7.migration']])).toEqual([
      [TAG, 'migrate'],
      [TAG, 'undo'],
    ]);
    vi.restoreAllMocks();
  });

  it('stops the move when its script is cut short, and undoes what it did', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.migrationResult = { stdout: '', stderr: 'out of memory', exitCode: 137 };
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/still runs the old PHP setup: the PHP settings in its \.htaccess files could not be moved: its script failed \(exit 137\): out of memory/);
    expect(runs(w).map((run) => run.labels['wpl7.migration'])).toEqual(['migrate', 'undo']);
    expect(order(w, SWITCH_CALLS)).toEqual([]);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('runs for a stopped site, which has no container to run it in', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.containers.set(site.containerName, 'exited');
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(runs(w).map((run) => run.labels['wpl7.migration'])).toEqual(['migrate']);
    expect(w.docker.containers.get(site.containerName)).toBe('created');
  });
});

describe.skipIf(!HAS_PHP)('the real script in the job that moves a site', () => {
  /** What mod_php has been reading, in every shape a line comes in. */
  const HTACCESS = '# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\n</IfModule>\n# END WordPress\nphp_value max_input_vars 4321\n  php_flag session.use_strict_mode on\n';
  const WRAPPED = "<IfModule mod_php.c>\n\tphp_value auto_prepend_file 'waf.php'\n</IfModule>\n";
  const CRLF = 'php_value upload_max_filesize 77M\r\nOptions -Indexes\r\n';
  const ENGINE_OFF = 'php_flag engine off\n';
  const LEFTOVER = "open_basedir = /home/olduser/public_html\nauto_prepend_file = '/home/olduser/public_html/waf.php'\n";

  /** A stack 1 site with those files, and a way to read them. */
  async function siteWithLines(w: TestWorld) {
    const site = await siteOnOldImage(w);
    const wordpress = sitePaths(w.config, site.slug).wordpress;
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(wordpress, rel)), { recursive: true });
      fs.writeFileSync(path.join(wordpress, rel), text);
    };
    put('.htaccess', HTACCESS);
    put('firewall/.htaccess', WRAPPED);
    put('crlf/.htaccess', CRLF);
    put('no-php/.htaccess', ENGINE_OFF);
    put('.user.ini', LEFTOVER);
    useRealMigration(w.docker);
    return { site, read: (rel: string) => fs.readFileSync(path.join(wordpress, rel), 'utf8') };
  }

  /** Every .htaccess and .user.ini a run can touch, as it is now. */
  const snapshot = (read: (rel: string) => string) =>
    Object.fromEntries(['.htaccess', '.user.ini', 'firewall/.htaccess', 'firewall/.user.ini', 'crlf/.htaccess', 'crlf/.user.ini', 'no-php/.htaccess'].map((rel) => {
      try {
        return [rel, read(rel)];
      } catch {
        return [rel, null];
      }
    }));

  it('has moved the lines before the old container goes, and the job log says what it did', async () => {
    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    let atRemove = '';
    const rename = w.docker.renameContainer.bind(w.docker);
    vi.spyOn(w.docker, 'renameContainer').mockImplementation(async (name, to) => {
      atRemove ||= read('.htaccess');
      return rename(name, to);
    });
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    vi.restoreAllMocks();

    expect(atRemove).toContain('# Moved to .user.ini by WPL7: php_value max_input_vars 4321');
    expect(read('.htaccess')).toBe(atRemove);
    expect(read('.htaccess')).toContain('  # Moved to .user.ini by WPL7: php_flag session.use_strict_mode on\n');
    expect(read('.user.ini')).toContain("max_input_vars = '4321'");
    expect(read('.user.ini')).toContain('session.use_strict_mode = 1');
    // Word for word: Wordfence compares its block with what it would write.
    expect(read('firewall/.htaccess')).toBe(WRAPPED);
    expect(read('firewall/.user.ini')).toContain("auto_prepend_file = 'waf.php'");
    // Another line ending is kept, all the way through.
    expect(read('crlf/.htaccess')).toBe('# Moved to .user.ini by WPL7: php_value upload_max_filesize 77M\r\nOptions -Indexes\r\n');
    expect(read('no-php/.htaccess')).toContain('Require all denied');
    // What another host left is out of harm's way.
    expect(read('.user.ini')).toContain('; Not used by WPL7: open_basedir');
    expect(read('.user.ini')).toContain('; Not used by WPL7: auto_prepend_file');

    const log = logOf(w, job.id).join('\n');
    expect(log).toContain('.htaccess:6: php_value max_input_vars: moved to .user.ini');
    expect(log).toContain('open_basedir: commented out');
    expect(log).toMatch(/PHP settings: \d+ changes?, \d+ warnings?, in \d+ folders?\./);
  });

  it('shows what a file says only to a caller who may read a command’s output', async () => {
    const w = await makeWorld();
    const { site } = await siteWithLines(w);
    const job = w.deps.sites.reconcile(site.slug);
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    const lines = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all();
    const quoted = lines.find((l) => l.message.includes('php_value max_input_vars'))!;
    expect(quoted.message).not.toContain('4321');
    expect(quoted.withoutOutput).not.toContain('max_input_vars');
    expect(quoted.withoutOutput).toContain('.htaccess:6');
  });

  it('puts the lines back byte for byte when the new container fails, and leaves what mod_php does not read', async () => {
    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('OCI runtime create failed'));
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    vi.restoreAllMocks();
    expect(done.status).toBe('failed');
    expectOldContainerBack(w, site);

    expect(read('.htaccess')).toBe(HTACCESS);
    expect(read('firewall/.htaccess')).toBe(WRAPPED);
    expect(read('crlf/.htaccess')).toBe(CRLF);
    // The deny does what the line did, on both setups, with a 403 for the source it used to send.
    expect(read('no-php/.htaccess')).toContain('Require all denied');
    // mod_php doesn't read this, so what was done to it does no harm, and is not done twice.
    expect(read('.user.ini')).toContain("max_input_vars = '4321'");
    expect(logOf(w, job.id).join('\n')).toContain('.htaccess files put back: 3 lines.');
  });

  it('comes to the same files on a second try after a failed one, with nothing said twice in a .user.ini', async () => {
    const once = await makeWorld();
    const first = await siteWithLines(once);
    expect((await runJob(once, once.deps.sites.reconcile(first.site.slug).id)).status).toBe('succeeded');

    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('failed');
    vi.restoreAllMocks();
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');

    expect(snapshot(read)).toEqual(snapshot(first.read));
    expect(read('.user.ini').match(/max_input_vars =/g)).toHaveLength(1);
  });

  it('undoes a run that died half way, with the old container never touched', async () => {
    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    const real = w.docker.ephemeral!;
    w.docker.ephemeral = async (opts) => {
      const res = await real(opts);
      return opts.labels?.['wpl7.migration'] === 'migrate' ? { stdout: res.stdout.split('\n').slice(0, 2).join('\n'), stderr: 'Killed', exitCode: 137 } : res;
    };
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/could not be moved: its script failed \(exit 137\): Killed/);
    expect(read('.htaccess')).toBe(HTACCESS);
    expect(order(w, ['removeContainer', 'createSiteContainer'])).toEqual([]);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('moves the lines of a stopped site, which has no container running to do it in', async () => {
    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    w.docker.containers.set(site.containerName, 'exited');
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(read('.htaccess')).toContain('# Moved to .user.ini by WPL7: php_value max_input_vars 4321');
    expect(w.docker.containers.get(site.containerName)).toBe('created');
  });

  it('runs once: a recreate on stack 2 touches none of it', async () => {
    const w = await makeWorld();
    const { site, read } = await siteWithLines(w);
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    const after = snapshot(read);
    // A person adds a line over SFTP, which is theirs to answer for: the Files tab warns about it.
    fs.appendFileSync(path.join(sitePaths(w.config, site.slug).wordpress, 'crlf/.htaccess'), 'php_value memory_limit 1G\n');
    w.docker.calls.length = 0;
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(w.docker.calls.some((c) => c.method === 'runEphemeral')).toBe(false);
    expect(snapshot(read)).toEqual({ ...after, 'crlf/.htaccess': `${after['crlf/.htaccess']}php_value memory_limit 1G\n` });
  });
});

describe('a site’s page', () => {
  it('says what its container runs, and no old error once that is stack 2', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.db.update(sites).set({ stackSwitchError: 'an old reason', stackSwitchImage: 'sha256:x' }).where(eq(sites.id, site.id)).run();
    expect(await w.deps.sites.detail(site.slug)).toMatchObject({ stack: 2, stackSwitchError: null });
  });

  it('shows a reason on stack 1, and knows no stack without a container', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    w.db.update(sites).set({ stackSwitchError: 'it did not answer', stackSwitchImage: 'sha256:x' }).where(eq(sites.id, site.id)).run();
    expect(await w.deps.sites.detail(site.slug)).toMatchObject({ stack: 1, stackSwitchError: 'it did not answer' });
    await w.docker.removeContainer(site.containerName);
    expect((await w.deps.sites.detail(site.slug)).stack).toBeNull();
  });
});
