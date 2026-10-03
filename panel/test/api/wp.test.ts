import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import type { BatchDto, JobDto, SiteSummary, SiteWpStatusDto, WpInventoryDto } from '../../shared/types.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp(world?: TestWorld) {
  const w = world ?? (await makeWorld());
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world: w, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function addRunningSite(w: TestWorld, slug: string): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, 'running');
  return site;
}

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

const PLUGIN_LIST = JSON.stringify([
  { name: 'cf7', title: 'Contact Form 7', status: 'active', version: '5.3.1', update: 'available', update_version: '6.0.1', auto_update: 'off', file: 'cf7/cf7.php' },
  { name: 'seo', title: 'SEO', status: 'inactive', version: '1.0', update: 'none', update_version: null, auto_update: 'off', file: 'seo/seo.php' },
]);
const THEME_LIST = JSON.stringify([
  { name: 'child', title: 'Child', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off' },
  { name: 'old', title: 'Old', status: 'inactive', version: '1.0', update: 'available', update_version: '2.0', auto_update: 'off' },
]);

function scriptScan(w: TestWorld, checkUpdate = ''): void {
  w.docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(checkUpdate));
}

async function seedSnapshot(w: TestWorld, site: SiteRow, checkUpdate = ''): Promise<void> {
  scriptScan(w, checkUpdate);
  await w.core.wpInventory.scanSite(site, w.servers.handleFor(site.serverId), { refreshFeed: false });
}

describe('per-site WordPress status and scan', () => {
  it('serves the snapshot without touching the container', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'blog');
    await seedSnapshot(world, site, JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]));
    const execsBefore = world.docker.calls.filter((c) => c.method === 'exec').length;

    const res = await app.inject({ method: 'GET', url: '/api/sites/blog/wp/status', headers });

    expect(res.statusCode).toBe(200);
    const body = res.json() as SiteWpStatusDto;
    expect(body.plugins.map((p) => p.slug)).toEqual(['cf7', 'seo']);
    expect(body.themes.map((t) => t.slug)).toEqual(['child', 'old']);
    expect(body.core).toMatchObject({ version: '6.8.2', updateVersion: '6.8.3', updateType: 'minor' });
    expect(body.counts.updates).toBe(3);
    // Not one extra wp-cli call: this is a database read.
    expect(world.docker.calls.filter((c) => c.method === 'exec')).toHaveLength(execsBefore);
  });

  it('answers with an empty snapshot (scannedAt null) before the first scan', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'fresh');

    const res = await app.inject({ method: 'GET', url: '/api/sites/fresh/wp/status', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SiteWpStatusDto;
    expect(body.scannedAt).toBeNull();
    expect(body.plugins).toHaveLength(0);
    expect(body.feed.enabled).toBe(true);
  });

  it('scans on demand, and refuses when the container is not running', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'blog');
    scriptScan(world);

    const res = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/scan', headers });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SiteWpStatusDto).plugins).toHaveLength(2);

    world.docker.containers.set(site.containerName, 'exited');
    const stopped = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/scan', headers });
    expect(stopped.statusCode).toBe(409);
  });

  it('needs a session like every other panel route', async () => {
    const { app, world } = await authedApp();
    addRunningSite(world, 'blog');
    for (const url of ['/api/sites/blog/wp/status', '/api/wp/inventory', '/api/wp/batches']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/wp/scan' })).statusCode).toBe(401);
  });
});

describe('theme management routes', () => {
  it('queues a job for activate, update and delete', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'blog');

    for (const [method, url] of [
      ['POST', '/api/sites/blog/wp/themes/old/activate'],
      ['POST', '/api/sites/blog/wp/themes/old/update'],
      ['DELETE', '/api/sites/blog/wp/themes/old'],
    ] as const) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode, url).toBe(202);
      const job = (res.json() as { job: JobDto }).job;
      expect(job.type).toBe('wp.themeTask');
      // One active job per site: settle it before the next one.
      world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).where(eq(jobs.id, job.id)).run();
    }
    expect(world.db.select().from(jobs).all()).toHaveLength(3);
    expect(site.slug).toBe('blog');
  });

  it('rejects a path-traversal theme name before it reaches wp-cli', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'blog');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sites/blog/wp/themes/..%2F..%2Fetc',
      headers,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('single-site bulk route', () => {
  it('queues one job carrying every operation', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'blog');
    await seedSnapshot(world, site, JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/blog/wp/bulk',
      headers,
      payload: {
        ops: [
          { kind: 'plugin', slug: 'cf7', action: 'update' },
          { kind: 'core', action: 'update' },
        ],
        backupFirst: true,
      },
    });

    expect(res.statusCode).toBe(202);
    const job = world.db.select().from(jobs).where(eq(jobs.siteId, site.id)).get()!;
    expect(job.type).toBe('wp.bulkTask');
    const payload = JSON.parse(job.payload) as {
      ops: { kind: string; slug?: string }[];
      backupFirst: boolean;
      healthCheck: boolean;
    };
    expect(payload.ops).toHaveLength(2);
    // Core runs last, after the plugins that may be what makes it compatible.
    expect(payload.ops.map((o) => o.slug ?? 'core')).toEqual(['cf7', 'core']);
    expect(payload.backupFirst).toBe(true);
    expect(payload.healthCheck).toBe(true); // on unless switched off
  });

  it('refuses operations the snapshot says cannot run (a stale browser tab)', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'blog');
    await seedSnapshot(world, site); // no core update, and "seo" has no update either

    for (const ops of [
      [{ kind: 'plugin', slug: 'seo', action: 'update' }],
      [{ kind: 'core', action: 'update' }],
      [{ kind: 'theme', slug: 'child', action: 'delete' }],
      [{ kind: 'plugin', slug: 'ghost', action: 'update' }],
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: { ops } });
      expect(res.statusCode, JSON.stringify(ops)).toBe(400);
    }
    expect(world.db.select().from(jobs).all()).toHaveLength(0);
  });

  it('refuses a bulk run on a site that has never been scanned', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'fresh');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/fresh/wp/bulk',
      headers,
      payload: { ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/not been scanned/);
  });

  it('rejects an empty op list and a core op with an action other than update', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'blog');

    const empty = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: { ops: [] } });
    expect(empty.statusCode).toBe(400);

    const badCore = await app.inject({
      method: 'POST',
      url: '/api/sites/blog/wp/bulk',
      headers,
      payload: { ops: [{ kind: 'core', action: 'delete' }] },
    });
    expect(badCore.statusCode).toBe(400);

    const noSlug = await app.inject({
      method: 'POST',
      url: '/api/sites/blog/wp/bulk',
      headers,
      payload: { ops: [{ kind: 'plugin', action: 'update' }] },
    });
    expect(noSlug.statusCode).toBe(400);
  });
});

describe('fleet inventory', () => {
  it('aggregates a slug across sites and applies the filters', async () => {
    const { app, world, headers } = await authedApp();
    const alpha = addRunningSite(world, 'alpha');
    const beta = addRunningSite(world, 'beta');
    await seedSnapshot(world, alpha);
    await seedSnapshot(world, beta);

    const all = await app.inject({ method: 'GET', url: '/api/wp/inventory?kind=plugin', headers });
    expect(all.statusCode).toBe(200);
    const body = all.json() as WpInventoryDto;
    expect(body.rows.find((r) => r.slug === 'cf7')).toMatchObject({ sites: 2, updates: 2 });
    expect(body.fleet).toMatchObject({ sites: 2, scanned: 2, sitesWithUpdates: 2 });
    expect(body.feed.enabled).toBe(true);

    const updatesOnly = await app.inject({
      method: 'GET',
      url: '/api/wp/inventory?kind=plugin&filter=updates',
      headers,
    });
    expect((updatesOnly.json() as WpInventoryDto).rows.map((r) => r.slug)).toEqual(['cf7']);

    // Two chips at once are AND-ed; nothing is vulnerable in this fixture.
    const both = await app.inject({
      method: 'GET',
      url: '/api/wp/inventory?kind=plugin&filter=updates,vulnerable',
      headers,
    });
    expect((both.json() as WpInventoryDto).rows).toHaveLength(0);

    const themes = await app.inject({ method: 'GET', url: '/api/wp/inventory?kind=theme', headers });
    expect((themes.json() as WpInventoryDto).rows.map((r) => r.slug).sort()).toEqual(['child', 'old']);

    const bogus = await app.inject({ method: 'GET', url: '/api/wp/inventory?kind=plugin&filter=nonsense', headers });
    expect(bogus.statusCode).toBe(400);
  });
});

describe('fleet bulk runs', () => {
  it('creates a batch with one job per site and reports busy sites as skipped', async () => {
    const { app, world, headers } = await authedApp();
    const alpha = addRunningSite(world, 'alpha');
    const beta = addRunningSite(world, 'beta');
    await seedSnapshot(world, alpha);
    await seedSnapshot(world, beta);
    // Beta's lane is taken.
    world.worker.enqueue('site.restart', { siteId: beta.id }, { id: beta.id, slug: beta.slug, serverId: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/wp/bulk',
      headers,
      payload: {
        action: 'update',
        targets: [
          { siteSlug: 'alpha', kind: 'plugin', slug: 'cf7' },
          { siteSlug: 'beta', kind: 'plugin', slug: 'cf7' },
        ],
        backupFirst: false,
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { batch: BatchDto; jobs: JobDto[]; skipped: { siteSlug: string }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.siteSlug).toBe('alpha');
    expect(body.jobs[0]!.batchId).toBe(body.batch.id);
    expect(body.skipped.map((s) => s.siteSlug)).toEqual(['beta']);
    expect(body.batch.totalJobs).toBe(1);

    // The batch endpoints drive the progress table.
    const detail = await app.inject({ method: 'GET', url: `/api/wp/batches/${body.batch.id}`, headers });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { batch: BatchDto; jobs: JobDto[] };
    expect(detailBody.jobs).toHaveLength(1);
    expect(detailBody.batch.counts.queued).toBe(1);
    expect(detailBody.batch.skipped).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/api/wp/batches', headers });
    expect((list.json() as { items: BatchDto[] }).items).toHaveLength(1);

    // …and so does the job list, filtered by batch.
    const byBatch = await app.inject({ method: 'GET', url: `/api/jobs?batchId=${body.batch.id}`, headers });
    expect((byBatch.json() as { items: JobDto[] }).items.map((j) => j.siteSlug)).toEqual(['alpha']);

    const missing = await app.inject({ method: 'GET', url: '/api/wp/batches/999', headers });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects the whole selection with the offending items listed', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'alpha');
    await seedSnapshot(world, site);

    const res = await app.inject({
      method: 'POST',
      url: '/api/wp/bulk',
      headers,
      payload: {
        action: 'update',
        targets: [
          { siteSlug: 'alpha', kind: 'plugin', slug: 'cf7' },
          { siteSlug: 'alpha', kind: 'plugin', slug: 'seo' }, // no update available
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const details = (res.json() as { error: { details: string[] } }).error.details;
    expect(details.join(' ')).toMatch(/seo/);
    expect(world.db.select().from(jobs).all()).toHaveLength(0);
  });

  it('refuses a target on a site that does not exist', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/wp/bulk',
      headers,
      payload: { action: 'update', targets: [{ siteSlug: 'ghost', kind: 'plugin', slug: 'cf7' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('fleet scan', () => {
  it('queues one lane-less scan job, and refuses a second while it is active', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');

    const first = await app.inject({ method: 'POST', url: '/api/wp/scan', headers });
    expect(first.statusCode).toBe(202);
    const job = (first.json() as { job: JobDto }).job;
    expect(job.type).toBe('wp.scanAll');
    const row = world.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    // No site and no server lane: a read-only pass must not park a server's queue.
    expect(row.siteId).toBeNull();
    expect(row.serverId).toBeNull();

    const second = await app.inject({ method: 'POST', url: '/api/wp/scan', headers });
    expect(second.statusCode).toBe(409);

    // Once it is done, a new one is allowed again.
    world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).where(eq(jobs.id, job.id)).run();
    const third = await app.inject({ method: 'POST', url: '/api/wp/scan', headers });
    expect(third.statusCode).toBe(202);
  });

  it('reports the newest scan job on the inventory response', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    await app.inject({ method: 'POST', url: '/api/wp/scan', headers });

    const res = await app.inject({ method: 'GET', url: '/api/wp/inventory', headers });
    expect((res.json() as WpInventoryDto).scanJob?.type).toBe('wp.scanAll');
  });
});

describe('sites whose name was reserved later', () => {
  it('stays fully manageable, while a new site cannot take the name', async () => {
    const { app, world, headers } = await authedApp();
    // A site created before "bulk" became a reserved name (the frontend page shadows its
    // detail URL, but nothing else may break - there is no rename).
    const site = addRunningSite(world, 'bulk');
    await seedSnapshot(world, site);

    for (const url of ['/api/sites/bulk', '/api/sites/bulk/wp/status', '/api/sites/bulk/backups']) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(200);
    }
    const action = await app.inject({ method: 'POST', url: '/api/sites/bulk/restart', headers });
    expect(action.statusCode).toBe(202);

    // …and it can still be a bulk-run target.
    world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
    const run = await app.inject({
      method: 'POST',
      url: '/api/wp/bulk',
      headers,
      payload: { action: 'update', targets: [{ siteSlug: 'bulk', kind: 'plugin', slug: 'cf7' }] },
    });
    expect(run.statusCode).toBe(202);

    // Creating a new one with that name is what is refused.
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { title: 'Nope', slug: 'bulk', domainMode: 'dev', adminUser: 'a', adminEmail: 'a@example.com' },
    });
    expect(created.statusCode).toBe(400);
  });
});

describe('site summary and settings', () => {
  it('carries the WordPress counters on GET /sites once a site is scanned', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'alpha');
    addRunningSite(world, 'fresh');
    await seedSnapshot(world, site, JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]));

    const res = await app.inject({ method: 'GET', url: '/api/sites', headers });
    const items = (res.json() as { items: SiteSummary[] }).items;
    expect(items.find((s) => s.slug === 'alpha')!.wp).toMatchObject({ updates: 3, vulnerable: 0, coreUpdate: '6.8.3' });
    expect(items.find((s) => s.slug === 'fresh')!.wp).toBeNull();
  });

  it('exposes the scan interval and the feed switch', async () => {
    const { app, headers } = await authedApp();
    const before = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(before.json().settings).toMatchObject({ wpScanIntervalHours: 6, vulnerabilityFeed: true });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { wpScanIntervalHours: 12, vulnerabilityFeed: false },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({ wpScanIntervalHours: 12, vulnerabilityFeed: false });

    const tooOften = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { wpScanIntervalHours: 0 },
    });
    expect(tooOften.statusCode).toBe(400);
  });

  it('stops rating components while the feed is off', async () => {
    const { app, world, headers } = await authedApp();
    const site = addRunningSite(world, 'alpha');
    await seedSnapshot(world, site);
    await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { vulnerabilityFeed: false } });

    const res = await app.inject({ method: 'GET', url: '/api/sites/alpha/wp/status', headers });
    const body = res.json() as SiteWpStatusDto;
    expect(body.feed.enabled).toBe(false);
    expect(body.plugins.every((p) => p.feedCoverage === 'off')).toBe(true);
  });
});
