/**
 * Site containers follow their server's site image (services/siteImages.ts): an update or a
 * rebuild moves the `wpl7-wordpress:php<version>` tag, and the sweep rebuilds every container
 * still running the image it was created from - once, with the reconcile's own rollback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, type SiteRow } from '../../src/db/schema.js';
import { sweepSiteImages } from '../../src/services/siteImages.js';
import { siteImage, sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function runJob(w: TestWorld, jobId: number): Promise<string> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status;
}

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
  expect(await runJob(w, job.id)).toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

async function runningImage(w: TestWorld, site: SiteRow): Promise<string | undefined> {
  return (await w.docker.listManaged(['wpl7.role=wordpress'])).find((c) => c.name === site.containerName)?.imageId;
}

describe('site containers and their server image', () => {
  it('leave a site on its server\'s current image alone', async () => {
    const w = await makeWorld();
    await createSite(w);
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all()).toHaveLength(0);
  });

  it('rebuild a site whose tag has moved onto a new image, once', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const before = await runningImage(w, site);
    w.docker.imageIds.set(siteImage(site.phpVersion), 'sha256:patched');

    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
    // A second sweep before the job runs finds it waiting, and queues nothing more.
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
    const reconciles = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all();
    expect(reconciles).toHaveLength(1);
    expect(await runJob(w, reconciles[0]!.id)).toBe('succeeded');

    expect(before).not.toBe('sha256:patched');
    expect(await runningImage(w, site)).toBe('sha256:patched');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
  });

  it('leave a busy site for the next sweep', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.imageIds.set(siteImage(site.phpVersion), 'sha256:patched');
    w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [site.slug] });
  });

  it('leave a site alone when its server has no image to rebuild it onto', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.images.delete(siteImage(site.phpVersion));
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
  });

  it('leave a container the panel has no site for alone', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const spec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as Parameters<typeof w.docker.createSiteContainer>[0];
    await w.docker.createSiteContainer({ ...spec, name: 'wp-leftover' });
    w.docker.imageIds.set(siteImage(site.phpVersion), 'sha256:patched');
    expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
  });
});
