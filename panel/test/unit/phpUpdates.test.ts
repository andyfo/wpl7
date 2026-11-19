/**
 * PHP patch releases reach the sites by themselves (services/phpUpdates.ts): a server whose site
 * image is not the newest gets the published one, or builds one when it builds its own, and the
 * sites move onto it. What php.net says is what the Overview and the emails tell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { PHP_ACTIVE_URL, PHP_ADVISORIES_URL, PHP_CANDIDATES_URL, PHP_NEWS_URL } from '../../src/services/phpUpstream.js';
import { baseImage, imagesLane, weekStart } from '../../src/services/phpUpdates.js';
import { siteImage, sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { ACTIVE, ADVISORIES, CANDIDATES, NOTICE, feed, phpNet, release } from '../phpFixtures.js';

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const today = () => new Date().toUTCString().slice(5, 16);

/** php.net with 8.3's newest release dated `date` (php.net's format), and GitHub's advisories. */
function php83(version: string, date = '21 Oct 2026', security = true) {
  return {
    [PHP_ACTIVE_URL]: {
      status: 200,
      body: { '8': { ...ACTIVE['8'], '8.3': { tags: security ? ['security'] : [], date, version, source: [] } } },
    },
    [PHP_CANDIDATES_URL]: { status: 200, body: CANDIDATES },
    [PHP_NEWS_URL]: { status: 200, body: feed() },
    [PHP_ADVISORIES_URL]: {
      status: 200,
      body: [
        ...ADVISORIES,
        {
          ghsa_id: 'GHSA-aaaa-bbbb-cccc',
          cve_id: 'CVE-2026-115560',
          severity: 'high',
          summary: 'Session upload progress',
          html_url: 'https://github.com/php/php-src/security/advisories/GHSA-aaaa-bbbb-cccc',
          vulnerabilities: [{ patched_versions: version }],
        },
      ],
    },
  };
}

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
    phpVersion: '8.3',
  });
  expect(await runJob(w, job.id)).toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

/** A site row, without a container: what the status and the emails count. */
function siteRow(w: TestWorld, slug: string, release: string | null, phpVersion = '8.3') {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: slug.toUpperCase(),
      domains: JSON.stringify([`${slug}.example.org`]),
      phpVersion,
      phpRelease: release,
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

function capture(w: TestWorld) {
  const sent: { subject: string; body: string }[] = [];
  w.core.settings.set('alertEmail', 'ops@example.com');
  w.core.mail.notifyOperator = async (subject, body) => {
    sent.push({ subject, body });
    return true;
  };
  return sent;
}

const refreshJobs = (w: TestWorld) => w.db.select().from(jobs).where(eq(jobs.type, 'server.refreshSiteImages')).all();
const reconciles = (w: TestWorld) => w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all();

afterEach(() => {
  vi.useRealTimers();
});

describe('an install that pulls its site images', () => {
  it('pulls the published image when it is not the one the server has, and moves the sites onto it', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const site = await createSite(w);
    const ref = w.core.phpUpdates.publishedImage('8.3');
    w.docker.recordDigests = true;
    w.docker.publish(ref, DIGEST('a'), { imageId: 'sha256:patched' });
    w.docker.imagePhp.set('sha256:patched', '8.3.37');

    await w.core.phpUpdates.tick();
    const [job] = refreshJobs(w);
    expect(job).toMatchObject({ lane: imagesLane(1), serverId: null, status: 'queued' });
    expect(JSON.parse(job!.payload)).toEqual({ serverId: 1, versions: ['8.3'], reason: 'published' });
    // One at a time: a second pass while it waits queues no other.
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(1);

    expect(await runJob(w, job!.id)).toBe('succeeded');
    expect(await w.docker.imageId(siteImage('8.3'))).toBe('sha256:patched');
    expect(w.db.select().from(jobs).where(eq(jobs.id, job!.id)).get()!.summary).toBe('PHP 8.3');
    // The worker ran the move it queued, too.
    expect(reconciles(w).map((j) => j.siteId)).toEqual([site.id]);

    // The server has it now: nothing more to pull.
    w.docker.calls.length = 0;
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(1);
    expect(w.docker.calls.filter((c) => c.method === 'pullImage')).toHaveLength(0);
  });

  it('leaves a branch alone that its release does not publish', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37')).fetch });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(0);
    expect(w.core.phpUpdates.status().serverErrors).toEqual([]);
  });

  it("tells an install on an older release that a WPL7 update brings the new PHP", async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    expect(w.core.phpUpdates.status().updateNeeded).toBe(false);
    w.core.settings.setRaw('updates.latest', {
      manifest: { version: '99.0.0', channel: 'stable', publishedAt: '', notesUrl: '', images: { panel: '', wordpress: {} } },
      checkedAt: Date.now(),
    });
    expect(w.core.phpUpdates.status().updateNeeded).toBe(true);
  });
});

describe('an install that builds its own site images', () => {
  /** A server whose base image was pulled as `digest`, and an image on 8.3.36. */
  async function building(opts: { remoteBase: string; localBase: string; same?: boolean }) {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' }, phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const site = await createSite(w);
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    w.docker.publish(baseImage('8.3'), opts.remoteBase);
    w.docker.images.add(baseImage('8.3'));
    w.docker.imageDigests.set(`sha256:${baseImage('8.3')}`, [`wordpress@${opts.localBase}`]);
    // The build: its PHP, and what it lists of its packages.
    w.docker.imagePhp.set(`sha256:${siteImage('8.3')}-next`, '8.3.37');
    w.docker.ephemeral = (run) => {
      if (!run.labels?.['wpl7.imageCheck']) return { stdout: '', stderr: '', exitCode: 0 };
      const next = run.image.endsWith('-next');
      return { stdout: `apache2=2.4.69\nphp=${next && !opts.same ? '8.3.37' : '8.3.36'}\n`, stderr: '', exitCode: 0 };
    };
    return { w, site };
  }

  it("builds when php.net has a newer release and Docker's base has changed, and moves the sites", async () => {
    const { w, site } = await building({ remoteBase: DIGEST('b'), localBase: DIGEST('a') });
    await w.core.phpUpdates.tick();
    const [job] = refreshJobs(w);
    expect(JSON.parse(job!.payload)).toEqual({ serverId: 1, versions: ['8.3'], reason: 'php' });
    expect(await runJob(w, job!.id)).toBe('succeeded');
    const build = w.docker.calls.find((c) => c.method === 'buildImage');
    expect(build?.args.slice(0, 1)).toEqual([`${siteImage('8.3')}-next`]);
    expect(build?.args[2]).toEqual({ PHP_TAG: 'php8.3' });
    expect(await w.docker.imagePhpVersion(siteImage('8.3'))).toBe('8.3.37');
    // The build's own name goes again.
    expect(w.docker.images.has(`${siteImage('8.3')}-next`)).toBe(false);
    expect(reconciles(w).map((j) => j.siteId)).toEqual([site.id]);
    expect(w.db.select().from(jobs).where(eq(jobs.id, job!.id)).get()!.summary).toBe('PHP 8.3');
  });

  it('keeps the image it has when a build changed nothing in it', async () => {
    const { w } = await building({ remoteBase: DIGEST('b'), localBase: DIGEST('a'), same: true });
    await w.core.phpUpdates.tick();
    const [job] = refreshJobs(w);
    expect(await runJob(w, job!.id)).toBe('succeeded');
    expect(await w.docker.imageId(siteImage('8.3'))).toBe(`sha256:${siteImage('8.3')}`);
    expect(reconciles(w)).toHaveLength(0);
    expect(w.docker.images.has(`${siteImage('8.3')}-next`)).toBe(false);
  });

  it("waits while Docker's base is the one the server has, and asks about it at most every half hour", async () => {
    const { w } = await building({ remoteBase: DIGEST('a'), localBase: DIGEST('a') });
    await w.core.phpUpdates.tick();
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(0);
    expect(w.docker.calls.filter((c) => c.method === 'distribution' && c.args[0] === baseImage('8.3'))).toHaveLength(1);
  });

  it('rebuilds every branch once a week, from Monday 03:00 UTC', async () => {
    const { w } = await building({ remoteBase: DIGEST('a'), localBase: DIGEST('a') });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(0);
    vi.useFakeTimers({ toFake: ['Date'], now: weekStart(Date.now()) + 7 * 24 * 3600_000 + 60_000 });
    await w.core.phpUpdates.tick();
    const [job] = refreshJobs(w);
    expect(JSON.parse(job!.payload)).toMatchObject({ reason: 'weekly', versions: ['8.3'] });
  });

  it('counts its weeks from Monday 03:00 UTC', () => {
    // Thursday 19 November 2026, 08:00 UTC.
    expect(new Date(weekStart(Date.parse('2026-11-19T08:00:00Z'))).toISOString()).toBe('2026-11-16T03:00:00.000Z');
    // Monday 02:59 belongs to the week before.
    expect(new Date(weekStart(Date.parse('2026-11-16T02:59:00Z'))).toISOString()).toBe('2026-11-09T03:00:00.000Z');
  });
});

describe('what the Overview and the emails say', () => {
  it("lists each branch's newest release, its next one, and the sites behind it", async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    siteRow(w, 'blog', '8.3.36');
    siteRow(w, 'shop', '8.3.37');
    await w.core.phpUpdates.tick();
    const status = w.core.phpUpdates.status();
    const b83 = status.branches.find((b) => b.branch === '8.3')!;
    expect(b83).toMatchObject({
      latest: { version: '8.3.37', security: true },
      sites: 2,
      current: 1,
      behind: [{ slug: 'blog', title: 'BLOG', release: '8.3.36' }],
      behindCount: 1,
      updating: false,
    });
    expect(b83.latest!.advisories.map((a) => a.cve)).toEqual(['CVE-2026-115560']);
    expect(status.branches.find((b) => b.branch === '8.4')!.next).toMatchObject({ release: '8.4.28', expected: '2026-11-19' });
    expect(status.images).toBe('registry');
  });

  it('emails a new security release of a branch sites run, once', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    siteRow(w, 'blog', '8.3.36');
    await w.core.phpUpdates.tick();
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes']);
    expect(sent[0]!.body).toContain('PHP 8.3.37: fixes 1 high. 1 site runs its branch.');
    expect(sent[0]!.body).toContain('Session upload progress (CVE-2026-115560), high');
  });

  it('emails nothing about a release from before this install first read php.net', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.36', '21 Oct 2026')).fetch });
    const sent = capture(w);
    siteRow(w, 'blog', '8.3.35');
    await w.core.phpUpdates.tick();
    expect(sent).toEqual([]);
  });

  it('emails an advance notice while it is open, once, and shows it until its release is out', async () => {
    // The day before the release it announces: php.net's newest releases are September's.
    const script = php83('8.3.35', '24 Sep 2026');
    script[PHP_ACTIVE_URL] = { status: 200, body: { '8': { '8.3': release('8.3.35', '24 Sep 2026'), '8.4': release('8.4.26', '24 Sep 2026') } } };
    script[PHP_NEWS_URL] = { status: 200, body: feed(NOTICE) };
    const w = await makeWorld({ phpFetch: phpNet(script).fetch });
    const sent = capture(w);
    siteRow(w, 'blog', '8.3.35');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-20T21:00:00Z') });
    await w.core.phpUpdates.tick();
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP security release on Wed 21 Oct 2026, 14:00 UTC']);
    expect(w.core.phpUpdates.status().notice?.scheduledAt).toBe(Date.parse('2026-10-21T14:00:00Z'));
    // A day after the time it named, it is gone.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-22T14:01:00Z') });
    expect(w.core.phpUpdates.status().notice).toBeNull();
  });

  it('emails how a security release went, once its sites had their chance', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    const site = await createSite(w);
    const ref = w.core.phpUpdates.publishedImage('8.3');
    w.docker.recordDigests = true;
    w.docker.publish(ref, DIGEST('a'), { imageId: 'sha256:patched' });
    w.docker.imagePhp.set('sha256:patched', '8.3.37');
    await w.core.phpUpdates.tick();
    expect(await runJob(w, refreshJobs(w)[0]!.id)).toBe('succeeded');
    // The move failed, say: the site still runs 8.3.36.
    w.db.update(jobs).set({ status: 'failed' }).where(and(eq(jobs.type, 'site.reconcile'), eq(jobs.siteId, site.id))).run();
    w.db.update(sites).set({ phpRelease: '8.3.36' }).where(eq(sites.id, site.id)).run();
    await w.core.phpUpdates.tick();
    // Not yet: a busy site moves at the next hourly pass.
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes']);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 91 * 60_000 });
    await w.core.phpUpdates.tick();
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual([
      'PHP 8.3.37 is out, with security fixes',
      '1 site still runs an older PHP than 8.3.37',
    ]);
    expect(sent[1]!.body).toContain('1 of 1 site on PHP 8.3 still runs an older release:');
    expect(sent[1]!.body).toContain('Demo Site: PHP 8.3.36, http://panel.example.test/sites/demo-site');
  });

  it('says when every site is on the newest release, for a day', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    siteRow(w, 'blog', '8.3.37');
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')!.doneRecently).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes', 'All sites run PHP 8.3.37']);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 3600_000 });
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')!.doneRecently).toBe(false);
  });
});
