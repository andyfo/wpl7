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
import { PhpUpdatesService, baseImage, imagesLane, weekStart } from '../../src/services/phpUpdates.js';
import { imagesToRemove } from '../../src/services/dockerCleanup.js';
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
function siteRow(w: TestWorld, slug: string, release: string | null, phpVersion = '8.3', serverId = 1) {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      serverId,
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

  it('follows, on edge, the images of the commit it runs, not the moving edge tag', async () => {
    const w = await makeWorld({ env: { WPL7_CHANNEL: 'edge', WPL7_IMAGE_TAG: 'edge' } });
    const php = new PhpUpdatesService(w.core, undefined, '0123456789abcdef0123456789abcdef01234567');
    expect(php.publishedImage('8.4')).toBe('ghcr.io/andyfo/wpl7/wordpress:php8.4-sha-0123456');
    // A build that does not know its commit falls back to the edge tag.
    expect(new PhpUpdatesService(w.core, undefined, 'unknown').publishedImage('8.4')).toBe('ghcr.io/andyfo/wpl7/wordpress:php8.4-edge');
  });

  // What Docker 28 and dockerode say: neither is a tag the registry does not have.
  it.each([
    ['a registry it cannot reach', 500, 'server error - Get "https://registry.example.invalid/v2/": dial tcp: lookup registry.example.invalid: no such host'],
    ['a registry that refuses it', 401, 'no such image - unauthorized: authentication required'],
  ])('says why a server could not be checked, for %s, and still plans the branches it could', async (_, status, message) => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    w.docker.images.add(siteImage('8.4'));
    w.docker.recordDigests = true;
    w.docker.publish(w.core.phpUpdates.publishedImage('8.3'), DIGEST('a'), { imageId: 'sha256:patched' });
    const distribution = w.docker.distribution.bind(w.docker);
    w.docker.distribution = async (ref, auth) => {
      if (ref === w.core.phpUpdates.publishedImage('8.4')) throw Object.assign(new Error(`(HTTP code ${status}) ${message} `), { statusCode: status });
      return distribution(ref, auth);
    };
    const result = await w.core.phpUpdates.tick();
    expect(result.error).toBe('Could not check local');
    expect(w.core.phpUpdates.status().serverErrors).toEqual([{ serverId: 1, serverName: 'local', error: expect.stringContaining(message) }]);
    expect(JSON.parse(refreshJobs(w)[0]!.payload)).toMatchObject({ versions: ['8.3'] });
  });

  it('waits an hour after a refresh that failed before it tries again', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    w.docker.publish(w.core.phpUpdates.publishedImage('8.3'), DIGEST('a'), { imageId: 'sha256:patched' });
    w.docker.pullImage = async () => {
      throw new Error('no space left on device');
    };
    await w.core.phpUpdates.tick();
    expect(await runJob(w, refreshJobs(w)[0]!.id)).toBe('failed');
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(2);
  });

  it("leaves the image an update brought while the pull ran", async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const ref = w.core.phpUpdates.publishedImage('8.3');
    w.docker.publish(ref, DIGEST('a'), { imageId: 'sha256:patched' });
    const pull = w.docker.pullImage.bind(w.docker);
    w.docker.pullImage = async (tag, onProgress, opts) => {
      await pull(tag, onProgress, opts);
      // update.sh retags the site image to its new release's meanwhile.
      w.docker.imageIds.set(siteImage('8.3'), 'sha256:next-release');
    };
    await w.core.phpUpdates.tick();
    expect(await runJob(w, refreshJobs(w)[0]!.id)).toBe('succeeded');
    expect(await w.docker.imageId(siteImage('8.3'))).toBe('sha256:next-release');
    expect(reconciles(w)).toHaveLength(0);
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

  it('tells an edge install behind the newest edge build that a WPL7 update brings the new PHP', async () => {
    const w = await makeWorld({ env: { WPL7_CHANNEL: 'edge', WPL7_IMAGE_TAG: 'edge' }, phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const edge = {
      version: '99.0.0-edge.abcdef1',
      channel: 'edge',
      gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      publishedAt: '2026-11-19T12:00:00Z',
      notesUrl: 'https://example.test/releases/edge',
      images: { panel: 'ghcr.io/example/wpl7/panel:edge', wordpress: { '8.3': 'ghcr.io/example/wpl7/wordpress:php8.3-edge' } },
    };
    // What the build before this one was told says nothing of this one: the deploy may have brought that commit.
    w.core.settings.setRaw('updates.latest', { manifest: edge, checkedAt: Date.now(), attemptedBy: 'the build before', checkedBy: 'the build before' });
    expect(w.core.phpUpdates.status().updateNeeded).toBe(false);
    // Its own check names another commit. CI refreshes that commit's images, not this one's.
    w.github.release(edge);
    await w.core.updates.check();
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

  it('tries a build again after one that failed, though it pulled the new base', async () => {
    const { w } = await building({ remoteBase: DIGEST('b'), localBase: DIGEST('a') });
    w.docker.buildFails = 'E: Failed to fetch http://deb.debian.org/debian/pool/main/a/apache2/apache2_2.4.71.deb';
    await w.core.phpUpdates.tick();
    const [first] = refreshJobs(w);
    expect(JSON.parse(first!.payload)).toMatchObject({ reason: 'php' });
    // The build pulled the new base before its apt step failed.
    w.docker.imageDigests.set(`sha256:${baseImage('8.3')}`, [`wordpress@${DIGEST('b')}`]);
    expect(await runJob(w, first!.id)).toBe('failed');
    expect(w.docker.calls.find((c) => c.method === 'buildImage')!.args[3]).toEqual({ noCache: true });
    w.docker.buildFails = null;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(2);
  });

  it('knows the base it built on when Docker pulled the same image again under a new digest', async () => {
    const { w } = await building({ remoteBase: DIGEST('b'), localBase: DIGEST('a'), same: true });
    const build = w.docker.buildImage.bind(w.docker);
    w.docker.buildImage = async (tag, context, args, onProgress, opts) => {
      await build(tag, context, args, onProgress, opts);
      // The classic store lists both digests of the unchanged base, sorted: the old one first.
      w.docker.imageDigests.set(`sha256:${baseImage('8.3')}`, [`wordpress@${DIGEST('a')}`, `wordpress@${DIGEST('b')}`]);
    };
    await w.core.phpUpdates.tick();
    expect(await runJob(w, refreshJobs(w)[0]!.id)).toBe('succeeded');
    // Its PHP is still behind php.net's, on the very base the registry names: nothing to build.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31 * 60_000 });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(1);
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

  it('tries a weekly rebuild that failed again an hour later, though PHP is current', async () => {
    const { w } = await building({ remoteBase: DIGEST('a'), localBase: DIGEST('a') });
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(0);
    vi.useFakeTimers({ toFake: ['Date'], now: weekStart(Date.now()) + 7 * 24 * 3600_000 + 60_000 });
    w.docker.buildFails = 'E: Failed to fetch http://deb.debian.org/debian/pool/main/n/nginx/nginx_1.26.3.deb';
    await w.core.phpUpdates.tick();
    const [first] = refreshJobs(w);
    expect(JSON.parse(first!.payload)).toMatchObject({ reason: 'weekly', versions: ['8.3'] });
    expect(await runJob(w, first!.id)).toBe('failed');
    w.docker.buildFails = null;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    await w.core.phpUpdates.tick();
    const second = refreshJobs(w)[1];
    expect(JSON.parse(second!.payload)).toMatchObject({ reason: 'weekly', versions: ['8.3'] });
    expect(await runJob(w, second!.id)).toBe('succeeded');
    // Done for the week now.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    await w.core.phpUpdates.tick();
    expect(refreshJobs(w)).toHaveLength(2);
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
    expect(sent.map((m) => m.subject)).toEqual(['PHP security release on Wed 21 Oct, 14:00 UTC']);
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

  it.each([
    ['its image is late', false],
    ['this install gets it with a WPL7 update', true],
  ])('emails nothing about the sites behind a release no server has an image of: %s', async (_, update) => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    if (update) {
      w.core.settings.setRaw('updates.latest', {
        manifest: { version: '99.0.0', channel: 'stable', publishedAt: '', notesUrl: '', images: { panel: '', wordpress: {} } },
        checkedAt: Date.now(),
      });
    }
    expect(w.core.phpUpdates.status().updateNeeded).toBe(update);
    siteRow(w, 'blog', '8.3.36');
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    await w.core.phpUpdates.tick();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 3600_000 });
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes']);
  });

  it('gives the sites time to move when their image came with a WPL7 update, not with a refresh', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    siteRow(w, 'blog', '8.3.36');
    w.docker.phpOf(siteImage('8.3'), '8.3.36');
    await w.core.phpUpdates.tick();
    // Hours later an update puts the image on the server. The sweep at boot, or its hourly pass, moves the site.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 3600_000 });
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes']);
    // Still on the old release once the sweep had its chance: that site did not move.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 91 * 60_000 });
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes', '1 site still runs an older PHP than 8.3.37']);
  });

  it('tells the sites waiting for an image on their server apart from those that did not move', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    const web2 = w.addSshServer('web2');
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    web2.docker.phpOf(siteImage('8.3'), '8.3.36');
    siteRow(w, 'blog', '8.3.36');
    siteRow(w, 'shop', '8.3.36', '8.3', web2.id);
    siteRow(w, 'docs', '8.3.37');
    await w.core.phpUpdates.tick();
    // A server without the image keeps it waiting for a day.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 23 * 3600_000 });
    await w.core.phpUpdates.tick();
    expect(sent).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3600_000 });
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes', '2 sites still run an older PHP than 8.3.37']);
    expect(sent[1]!.body).toBe(
      [
        '2 of 3 sites on PHP 8.3 still run an older release:',
        '',
        '  - BLOG: PHP 8.3.36, http://panel.example.test/sites/blog',
        '',
        "A site's page says why it did not move, and offers to try again.",
        '',
        '  - SHOP: PHP 8.3.36, http://panel.example.test/sites/shop',
        '',
        'web2 has no image with PHP 8.3.37 yet. Its sites move once it has one.',
      ].join('\n'),
    );
  });

  it("does not call a rollout done while a site's PHP is not known", async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    const site = siteRow(w, 'blog', null);
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')).toMatchObject({ current: 0, behindCount: 0, doneRecently: false });
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes']);
    w.db.update(sites).set({ phpRelease: '8.3.37' }).where(eq(sites.id, site.id)).run();
    await w.core.phpUpdates.tick();
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes', 'All sites run PHP 8.3.37']);
  });

  it('says when every site moved onto the newest release, for a day', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', today())).fetch });
    const sent = capture(w);
    const site = siteRow(w, 'blog', '8.3.36');
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    w.db.update(sites).set({ phpRelease: '8.3.37' }).where(eq(sites.id, site.id)).run();
    await w.core.phpUpdates.tick();
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')!.doneRecently).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual(['PHP 8.3.37 is out, with security fixes', 'All sites run PHP 8.3.37']);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 3600_000 });
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')!.doneRecently).toBe(false);
  });

  it('shows nothing done for sites that ran the newest release from the start, as after an install', async () => {
    const w = await makeWorld({ phpFetch: phpNet(php83('8.3.37', '21 Oct 2026')).fetch });
    siteRow(w, 'blog', '8.3.37');
    w.docker.phpOf(siteImage('8.3'), '8.3.37');
    await w.core.phpUpdates.tick();
    expect(w.core.phpUpdates.status().branches.find((b) => b.branch === '8.3')!.doneRecently).toBe(false);
  });
});

describe("what the nightly clean-up does with Docker's old bases", () => {
  const image = (id: string, tags: string[], digests: string[]) => ({ id, tags, digests, created: 0 });
  it('removes a base no name points at any more, and leaves a tagged one alone', () => {
    const plan = imagesToRemove({
      images: [
        image('sha256:old', [], ['wordpress@sha256:aaa']),
        image('sha256:current', ['wordpress:php8.4-fpm'], ['wordpress@sha256:bbb']),
        image('sha256:mine', ['wordpress:latest'], ['wordpress@sha256:ccc']),
      ],
      inUse: new Set(),
      needed: new Set(),
      repos: new Set(['wpl7-wordpress']),
      panelRepos: new Set(),
      untaggedRepos: new Set(['wordpress', 'docker.io/library/wordpress']),
    });
    expect(plan.map((i) => i.id)).toEqual(['sha256:old']);
  });
});
