/**
 * The PHP release a site runs (services/phpReleases.ts): read off its container, not worked out
 * from its branch - as a job that rebuilds the container ends, and for every site at boot and
 * hourly - and what the server's Machine card shows of its site images.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, servers, sites, type SiteRow } from '../../src/db/schema.js';
import { phpReleaseOf } from '../../src/lib/phpRelease.js';
import { siteImagePhp, sweepPhpReleases } from '../../src/services/phpReleases.js';
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

const releaseOf = (w: TestWorld, site: SiteRow): string | null =>
  w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.phpRelease;

describe('the PHP release a site runs', () => {
  it('is read off a new site\'s container as its create job ends, and listed', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.35');
    const site = await createSite(w);
    expect(site.phpVersion).toBe('8.3');
    expect(releaseOf(w, site)).toBe('8.3.35');
    expect(w.deps.sites.list().find((s) => s.slug === site.slug)).toMatchObject({ phpVersion: '8.3', phpRelease: '8.3.35' });
  });

  it('is the new image\'s once a rebuild onto a moved tag ends', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.35');
    const site = await createSite(w);
    // An update pulls a patched image under the same tag.
    w.docker.imageIds.set(siteImage('8.3'), 'sha256:patched');
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    // Until the container is rebuilt, the site runs what it was created from.
    await sweepPhpReleases(w.core);
    expect(releaseOf(w, site)).toBe('8.3.35');

    await sweepSiteImages(w.core, w.worker);
    const reconcile = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).get()!;
    expect(await runJob(w, reconcile.id)).toBe('succeeded');
    expect(releaseOf(w, site)).toBe('8.3.36');
  });

  it('follows a PHP switch to the other branch\'s release', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    w.docker.images.add(siteImage('8.4'));
    w.docker.phpOf(siteImage('8.4'), '8.4.27');
    const site = await createSite(w);
    const job = w.deps.sites.changePhp(site.slug, '8.4');
    expect(await runJob(w, job.id)).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toMatchObject({ phpVersion: '8.4', phpRelease: '8.4.27' });
  });

  it('is read again for every site by the sweep, and is gone with the container', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    const site = await createSite(w);
    w.db.update(sites).set({ phpRelease: null }).where(eq(sites.id, site.id)).run();
    await sweepPhpReleases(w.core);
    expect(releaseOf(w, site)).toBe('8.3.36');

    w.docker.containers.delete(site.containerName);
    await sweepPhpReleases(w.core);
    expect(releaseOf(w, site)).toBeNull();
  });

  it('lets the job end when Docker never answers, and keeps the release it had', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.35');
    const site = await createSite(w);
    (w.config as { phpReadTimeoutMs: number }).phpReadTimeoutMs = 50;
    // Docker took the request and will never answer it.
    w.docker.containerPhpVersion = () => new Promise<string | null>(() => undefined);
    const job = w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    expect(await runJob(w, job.id)).toBe('succeeded');
    await sweepPhpReleases(w.core);
    expect(releaseOf(w, site)).toBe('8.3.35');
  });

  it('drops a sweep\'s reading of a site that a job changed while the reading was out', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.35');
    w.docker.images.add(siteImage('8.4'));
    w.docker.phpOf(siteImage('8.4'), '8.4.27');
    const site = await createSite(w);
    w.db.update(sites).set({ phpRelease: null }).where(eq(sites.id, site.id)).run();
    // The sweep reads the 8.3 container, and its answer comes back after a switch to 8.4.
    const docker = w.docker;
    const real = docker.containerPhpVersion.bind(docker);
    let answer!: (release: string) => void;
    docker.containerPhpVersion = () => {
      docker.containerPhpVersion = real;
      return new Promise((resolve) => (answer = resolve));
    };
    const sweep = sweepPhpReleases(w.core);
    const job = w.deps.sites.changePhp(site.slug, '8.4');
    expect(await runJob(w, job.id)).toBe('succeeded');
    answer('8.3.35');
    await sweep;
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toMatchObject({ phpVersion: '8.4', phpRelease: '8.4.27' });
  });

  it('keeps the last reading on a server that cannot be reached', async () => {
    const w = await makeWorld();
    w.docker.phpOf(siteImage('8.3'), '8.3.35');
    const site = await createSite(w);
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, site.serverId)).run();
    w.docker.containers.delete(site.containerName);
    await sweepPhpReleases(w.core);
    expect(releaseOf(w, site)).toBe('8.3.35');
  });
});

describe('a server\'s site images', () => {
  it('list each PHP branch with the release in it, oldest first, and nothing else', async () => {
    const w = await makeWorld();
    for (const tag of [siteImage('8.5'), siteImage('8.4'), 'wpl7-wordpress:latest', 'ghcr.io/example/wordpress:php8.4-0.3.2']) {
      w.docker.images.add(tag);
    }
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    w.docker.phpOf(siteImage('8.4'), '8.4.27');
    expect(await siteImagePhp(w.docker, 1000)).toEqual([
      { version: '8.3', release: '8.3.36' },
      { version: '8.4', release: '8.4.27' },
      // An image that does not say.
      { version: '8.5', release: null },
    ]);
  });
});

describe('phpReleaseOf', () => {
  it('keeps a release, a distribution\'s patch level included, and nothing else', () => {
    expect(phpReleaseOf('8.4.27')).toBe('8.4.27');
    expect(phpReleaseOf(' 8.3.6-0ubuntu0.24.04.13 ')).toBe('8.3.6-0ubuntu0.24.04.13');
    expect(phpReleaseOf('8.5.0RC1')).toBe('8.5.0RC1');
    for (const junk of ['8.4', '', 'PHP 8.4.27', '8.4.27 <script>', '8.4.27'.padEnd(60, 'x'), 84, null, undefined]) {
      expect(phpReleaseOf(junk)).toBeNull();
    }
  });
});
