/**
 * A site's container follows the image on its server (services/siteSpec.ts siteContainerSpec), and a
 * site moving from stack 1 to stack 2 goes back to its own old image when it doesn't come up there
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
import { siteContainerSpec, siteImage, sitePaths, siteRollbackImage, siteRuntimeFrom } from '../../src/services/siteSpec.js';
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
 * it runs has no name any more, and the tag names a stack 2 image.
 */
async function siteOnOldImage(w: TestWorld): Promise<SiteRow> {
  w.docker.stackOf(TAG, 1);
  const site = await createSite(w);
  expect(await siteContainerStack(w.docker, site.containerName)).toBe(1);
  w.docker.imageIds.set(TAG, NEW_ID);
  w.docker.calls.length = 0;
  return site;
}

/** The order some calls were made in, by method. */
const order = (w: TestWorld, methods: string[]) => w.docker.calls.map((c) => c.method).filter((m) => methods.includes(m));

const SWITCH_CALLS = ['tagImage', 'removeContainer', 'createSiteContainer', 'startContainer', 'untagImage'];

function expectBackOnOldImage(w: TestWorld, site: SiteRow, state: 'running' | 'created' = 'running') {
  const spec = specs(w).at(-1)!;
  expect(spec.image).toBe(OLD_ID);
  expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
  expect(spec.labels[portLabel(site.slug)]).toBe('80');
  expect(spec.binds.some((b) => b.includes(RUNTIME_DIR_IN_CONTAINER))).toBe(false);
  expect(w.docker.containers.get(site.containerName)).toBe(state);
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
    expect(w.docker.calls.some((c) => c.method === 'tagImage')).toBe(false);
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
  it('uses the image it ran, by id, after the tag has moved, and the stack it was', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.imageIds.set(TAG, NEW_ID);
    w.docker.calls.length = 0;
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    const spec = specs(w).at(-1)!;
    expect(spec.image).toBe(OLD_ID);
    expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    const list = await w.docker.listManaged(['wpl7.role=wordpress']);
    expect(list.find((c) => c.name === site.containerName)!.imageId).toBe(OLD_ID);
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
    expectBackOnOldImage(w, site);
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

  it('uses the old image by id when a change of PHP fails its check after the swap', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    // The tag has moved since the container was made.
    w.docker.imageIds.set(TAG, NEW_ID);
    w.docker.images.add(siteImage('8.4'));
    let starts = 0;
    w.docker.onStart = (name) => {
      if (name === site.containerName && ++starts === 1) w.docker.containers.set(name, 'exited');
    };
    const done = await runJob(w, w.deps.sites.changePhp(site.slug, '8.4').id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/smoke check/);
    expect(specs(w).at(-1)!.image).toBe(OLD_ID);
    expect(rowOf(w, site).phpVersion).toBe('8.3');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
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

  /** The site's row and the temporary name after a move that failed. */
  function expectFailedMove(w: TestWorld, site: SiteRow, done: { status: string; error: string | null }, reason: RegExp) {
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^This site still runs the old PHP setup: /);
    expect(done.error).toMatch(reason);
    const row = rowOf(w, site);
    expect(row.stackSwitchError).toMatch(reason);
    expect(done.error).toContain(row.stackSwitchError!);
    expect(row.stackSwitchImage).toBe(NEW_ID);
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(false);
    expect(order(w, ['tagImage']).length).toBeLessThanOrEqual(1);
  }

  it('moves a running site: old image kept, files moved, new container up, name gone', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    // What an earlier try left.
    w.db.update(sites).set({ stackSwitchError: 'it did not answer', stackSwitchImage: 'sha256:older' }).where(eq(sites.id, site.id)).run();
    let tagAtMigration = false;
    migrate.mockImplementation(async () => {
      tagAtMigration = w.docker.images.has(siteRollbackImage(site.slug));
      expect(w.docker.containers.get(site.containerName)).toBe('running');
    });
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(tagAtMigration).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    expect(order(w, SWITCH_CALLS)).toEqual(['tagImage', 'removeContainer', 'createSiteContainer', 'startContainer', 'untagImage']);
    expect(w.docker.calls.find((c) => c.method === 'tagImage')!.args).toEqual([OLD_ID, siteRollbackImage(site.slug)]);
    const spec = specs(w).at(-1)!;
    expect(spec.image).toBe(TAG);
    expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
    expect(spec.labels[portLabel(site.slug)]).toBe('8080');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(await siteContainerStack(w.docker, site.containerName)).toBe(2);
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    // Nothing runs the old image now, and it had no other name.
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(false);
    expect(JSON.parse(done.result!).changed).toContain('moved to PHP-FPM');
    const log = logOf(w, job.id).join('\n');
    expect(log).toContain('mod_php');
    expect(log).toContain('wpl7-rollback:');
    expect(log).toContain('.htaccess');
    expect(log).toContain('answers on the new setup');
  });

  it('runs once: the next recreate has nothing to move', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    w.docker.calls.length = 0;
    migrate.mockClear();
    expect((await runJob(w, w.deps.sites.reconcile(site.slug).id)).status).toBe('succeeded');
    expect(migrate).not.toHaveBeenCalled();
    expect(w.docker.calls.some((c) => c.method === 'tagImage')).toBe(false);
  });

  it('goes back when the new container cannot be created', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not be created: Docker unavailable/);
    expect(undo).toHaveBeenCalledTimes(1);
    expectBackOnOldImage(w, site);
    expect(order(w, SWITCH_CALLS).at(-1)).toBe('untagImage');
  });

  it('goes back when the new container cannot start', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('OCI runtime create failed'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not start: OCI runtime create failed/);
    expect(undo).toHaveBeenCalledTimes(1);
    expectBackOnOldImage(w, site);
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
    expectBackOnOldImage(w, site);
    // Back up from its own image, and the tag has still moved on.
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
      expectBackOnOldImage(w, site);
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
    let removedAtUndo: number | null = null;
    undo.mockImplementation(async () => {
      removedAtUndo = order(w, ['removeContainer']).length;
    });
    vi.spyOn(w.docker, 'startContainer').mockRejectedValueOnce(new Error('no'));
    await runJob(w, w.deps.sites.reconcile(site.slug).id);
    // One remove of the old container so far; the one of the new container comes after the undo.
    expect(removedAtUndo).toBe(1);
    expect(order(w, ['removeContainer'])).toHaveLength(2);
  });

  it('leaves the old container alone when the migration fails: nothing has been taken down', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    migrate.mockRejectedValueOnce(new Error('cannot write wp-content/.htaccess'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /\.htaccess files could not be moved: cannot write/);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(order(w, ['removeContainer', 'createSiteContainer'])).toEqual([]);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('stops before the migration when the old image can’t be kept', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    vi.spyOn(w.docker, 'tagImage').mockRejectedValueOnce(Object.assign(new Error('No such image'), { statusCode: 404 }));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expectFailedMove(w, site, done, /could not be kept for going back: No such image/);
    expect(migrate).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(order(w, ['removeContainer', 'createSiteContainer', 'untagImage'])).toEqual([]);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('says so when the old container could not be put back either, and keeps its image by name', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    const create = vi.spyOn(w.docker, 'createSiteContainer');
    create.mockRejectedValueOnce(new Error('disk full'));
    create.mockRejectedValueOnce(new Error('disk still full'));
    const done = await runJob(w, w.deps.sites.reconcile(site.slug).id);
    expect(done.status).toBe('failed');
    expect(done.error).not.toContain('still runs');
    expect(done.error).toMatch(/could not be created: disk full.*could not be put back: disk still full.*Recreate container/);
    expect(rowOf(w, site).stackSwitchError).toMatch(/disk full.*disk still full/);
    expect(w.docker.containers.has(site.containerName)).toBe(false);
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(true);
    expect(order(w, ['untagImage'])).toEqual([]);
  });

  it('migrates a stopped site, without starting or checking it', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.containers.set(site.containerName, 'exited');
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(order(w, SWITCH_CALLS)).toEqual(['tagImage', 'removeContainer', 'createSiteContainer', 'untagImage']);
    expect(w.docker.containers.get(site.containerName)).toBe('created');
    expect(specs(w).at(-1)!.labels[SITE_STACK_LABEL]).toBe('2');
    expect(rowOf(w, site)).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(false);
    expect(logOf(w, job.id).join('\n')).toContain('stays stopped');
  });

  it('puts a stopped site back stopped, its image still named while nothing runs it', async () => {
    const w = await makeWorld();
    const site = await siteOnOldImage(w);
    w.docker.containers.set(site.containerName, 'exited');
    vi.spyOn(w.docker, 'createSiteContainer').mockRejectedValueOnce(new Error('Docker unavailable'));
    const job = w.deps.sites.reconcile(site.slug);
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/still runs the old PHP setup/);
    expect(order(w, ['startContainer'])).toEqual([]);
    expectBackOnOldImage(w, site, 'created');
    expect(undo).toHaveBeenCalledTimes(1);
    // Docker's classic image store deletes a stopped container's image if this name is forced off.
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(true);
    expect(await w.docker.imageId(siteRollbackImage(site.slug))).toBe(OLD_ID);
    expect(logOf(w, job.id).join('\n')).toContain('while only a stopped container uses it');
    // Once it runs, the name can go, and the image stays with the container.
    w.docker.containers.set(site.containerName, 'running');
    expect(await w.docker.untagImage(siteRollbackImage(site.slug))).toBe(true);
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(false);
    expect((await w.docker.containerStack(site.containerName))!.imageId).toBe(OLD_ID);
  });

  it('takes the name off when the old image still has its own tag', async () => {
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
    expect(specs(w).at(-1)!.image).toBe(OLD_ID);
    expect(specs(w).at(-1)!.labels['wpl7.php']).toBe('8.3');
    expect(w.docker.images.has(siteRollbackImage(site.slug))).toBe(false);
    expect(w.docker.images.has(TAG)).toBe(true);
    expect(rowOf(w, site)).toMatchObject({ phpVersion: '8.3', stackSwitchImage: `sha256:${other}` });
  });

  it('moves a site through a change of PHP, without checking it twice', async () => {
    const w = await makeWorld();
    w.docker.stackOf(TAG, 1);
    const site = await createSite(w);
    w.docker.images.add(siteImage('8.4'));
    // The old image may be gone by the time the move is over, so a second check, with a rollback
    // behind it, would have nothing to go back to.
    const untag = w.docker.untagImage.bind(w.docker);
    vi.spyOn(w.docker, 'untagImage').mockImplementation(async (tag) => {
      vi.spyOn(w.docker, 'containerState').mockResolvedValue('exited');
      return untag(tag);
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
    expectBackOnOldImage(w, site);
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
    expect(methods.indexOf('runEphemeral')).toBeLessThan(methods.indexOf('removeContainer'));
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
    expect(order(w, ['removeContainer', 'createSiteContainer'])).toEqual([]);
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
    const remove = w.docker.removeContainer.bind(w.docker);
    vi.spyOn(w.docker, 'removeContainer').mockImplementation(async (name) => {
      atRemove ||= read('.htaccess');
      return remove(name);
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
    expect(log).toContain('.htaccess:6: php_value max_input_vars 4321: moved to .user.ini');
    expect(log).toContain('open_basedir = /home/olduser/public_html: commented out');
    expect(log).toMatch(/PHP settings: \d+ changes?, \d+ warnings?, in \d+ folders?\./);
  });

  it('shows what a file says only to a caller who may read a command’s output', async () => {
    const w = await makeWorld();
    const { site } = await siteWithLines(w);
    const job = w.deps.sites.reconcile(site.slug);
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    const lines = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all();
    const quoted = lines.find((l) => l.message.includes('php_value max_input_vars 4321'))!;
    expect(quoted.withoutOutput).not.toContain('4321');
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
    expectBackOnOldImage(w, site);

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
