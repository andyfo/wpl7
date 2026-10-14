import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import type { BatchDto, MetaDto, SiteDetail, SiteSummary } from '../../shared/types.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp() {
  const w = await makeWorld();
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world: w, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

const PLUGIN_LIST = JSON.stringify([
  { name: 'cf7', title: 'Contact Form 7', status: 'active', version: '5.3.1', update: 'available', update_version: '6.0.1', auto_update: 'off', file: 'cf7/cf7.php' },
]);
const THEME_LIST = JSON.stringify([
  { name: 'child', title: 'Child', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off' },
]);

/** A running site whose snapshot has a plugin update and a core update waiting. */
async function addScannedSite(w: TestWorld, slug: string): Promise<SiteRow> {
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
  w.docker.execQueue.push(
    ok(PLUGIN_LIST),
    ok(THEME_LIST),
    ok('6.8.2\n'),
    ok(JSON.stringify([{ version: '6.8.3', update_type: 'minor' }])),
  );
  await w.core.wpInventory.scanSite(site, w.servers.handleFor(site.serverId), { refreshFeed: false });
  return site;
}

/** What the site's newest job was queued with. */
function queued(w: TestWorld, site: SiteRow): { type: string; backupFirst: boolean } {
  const job = w.db.select().from(jobs).where(eq(jobs.siteId, site.id)).orderBy(desc(jobs.id)).get()!;
  return { type: job.type, backupFirst: (JSON.parse(job.payload) as { backupFirst: boolean }).backupFirst };
}

/** One active job per site: end them all, so the next request can queue another. */
const settle = (w: TestWorld) => w.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();

const errorOf = (res: { json: () => unknown }) => (res.json() as { error: { message: string; details?: unknown } }).error;

const UPDATE_CF7 = { ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }] };

describe('backing up before an update', () => {
  it('asks by default: an update without an answer is refused, and nothing is queued', async () => {
    const { app, world, headers } = await authedApp();
    const site = await addScannedSite(world, 'blog');

    const meta = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect((meta.json() as MetaDto).backupBeforeUpdates).toBe('ask');

    const bulk = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: UPDATE_CF7 });
    expect(bulk.statusCode).toBe(400);
    expect(errorOf(bulk).message).toMatch(/"blog" is set to ask whether to back up before an update.*backupFirst/);
    expect(errorOf(bulk).details).toEqual({ sites: ['blog'] });

    for (const url of ['/api/sites/blog/wp/plugins/cf7/update', '/api/sites/blog/wp/themes/child/update', '/api/sites/blog/wp/core-update']) {
      const res = await app.inject({ method: 'POST', url, headers });
      expect(res.statusCode, url).toBe(400);
    }
    expect(world.db.select().from(jobs).all()).toHaveLength(0);

    // An answer is all it takes.
    const answered = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: { ...UPDATE_CF7, backupFirst: true } });
    expect(answered.statusCode).toBe(202);
    expect(queued(world, site)).toEqual({ type: 'wp.bulkTask', backupFirst: true });
    settle(world);

    const single = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/plugins/cf7/update', headers, payload: { backupFirst: false } });
    expect(single.statusCode).toBe(202);
    expect(queued(world, site)).toEqual({ type: 'wp.pluginTask', backupFirst: false });
  });

  it('a site set to always or never decides, whatever the request answers', async () => {
    const { app, world, headers } = await authedApp();
    const site = await addScannedSite(world, 'blog');

    const always = await app.inject({
      method: 'PUT',
      url: '/api/sites/blog/backup-before-updates',
      headers,
      payload: { value: 'always' },
    });
    expect(always.statusCode).toBe(200);
    expect((always.json() as SiteDetail).backupBeforeUpdates).toBe('always');

    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: { ...UPDATE_CF7, backupFirst: false } })).statusCode).toBe(202);
    expect(queued(world, site).backupFirst).toBe(true);
    settle(world);
    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/themes/child/update', headers })).statusCode).toBe(202);
    expect(queued(world, site)).toEqual({ type: 'wp.themeTask', backupFirst: true });
    settle(world);

    await app.inject({ method: 'PUT', url: '/api/sites/blog/backup-before-updates', headers, payload: { value: 'never' } });
    const core = await app.inject({ method: 'POST', url: '/api/sites/blog/wp/core-update', headers, payload: { backupFirst: true } });
    expect(core.statusCode).toBe(202);
    expect(queued(world, site)).toEqual({ type: 'wp.coreUpdate', backupFirst: false });
  });

  it("follows the panel's setting until the site sets its own", async () => {
    const { app, world, headers } = await authedApp();
    const site = await addScannedSite(world, 'blog');

    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { backupBeforeUpdates: 'never' } });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: UPDATE_CF7 })).statusCode).toBe(202);
    expect(queued(world, site).backupFirst).toBe(false);
    settle(world);

    await app.inject({ method: 'PUT', url: '/api/sites/blog/backup-before-updates', headers, payload: { value: 'ask' } });
    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: UPDATE_CF7 })).statusCode).toBe(400);
    const own = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect((own.json() as { ownBackupBeforeUpdates: unknown }).ownBackupBeforeUpdates).toEqual([{ slug: 'blog', value: 'ask' }]);
    const list = await app.inject({ method: 'GET', url: '/api/sites', headers });
    expect((list.json() as { items: SiteSummary[] }).items.find((s) => s.slug === 'blog')!.backupBeforeUpdates).toBe('ask');

    // null puts it back on the panel's setting.
    const reset = await app.inject({ method: 'PUT', url: '/api/sites/blog/backup-before-updates', headers, payload: { value: null } });
    expect((reset.json() as SiteDetail).backupBeforeUpdates).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: UPDATE_CF7 })).statusCode).toBe(202);
    expect(queued(world, site).backupFirst).toBe(false);
    expect(((await app.inject({ method: 'GET', url: '/api/settings', headers })).json() as { ownBackupBeforeUpdates: unknown[] }).ownBackupBeforeUpdates).toEqual([]);
  });

  it('backs up before any other change only when asked to', async () => {
    const { app, world, headers } = await authedApp();
    const site = await addScannedSite(world, 'blog');
    await app.inject({ method: 'PUT', url: '/api/sites/blog/backup-before-updates', headers, payload: { value: 'always' } });
    const deactivate = { ops: [{ kind: 'plugin', slug: 'cf7', action: 'deactivate' }] };

    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: deactivate })).statusCode).toBe(202);
    expect(queued(world, site).backupFirst).toBe(false);
    settle(world);
    expect((await app.inject({ method: 'POST', url: '/api/sites/blog/wp/bulk', headers, payload: { ...deactivate, backupFirst: true } })).statusCode).toBe(202);
    expect(queued(world, site).backupFirst).toBe(true);
  });

  it('a fleet run answers only the sites set to ask, and needs that answer before it queues anything', async () => {
    const { app, world, headers } = await authedApp();
    const alpha = await addScannedSite(world, 'alpha');
    const beta = await addScannedSite(world, 'beta');
    const gamma = await addScannedSite(world, 'gamma');
    for (const [slug, value] of [['alpha', 'always'], ['gamma', 'never']] as const) {
      await app.inject({ method: 'PUT', url: `/api/sites/${slug}/backup-before-updates`, headers, payload: { value } });
    }
    const targets = ['alpha', 'beta', 'gamma'].map((siteSlug) => ({ siteSlug, kind: 'plugin', slug: 'cf7' }));

    const unanswered = await app.inject({ method: 'POST', url: '/api/wp/bulk', headers, payload: { action: 'update', targets } });
    expect(unanswered.statusCode).toBe(400);
    expect(errorOf(unanswered).details).toEqual({ sites: ['beta'] });
    expect(world.db.select().from(jobs).all()).toHaveLength(0);

    const run = await app.inject({ method: 'POST', url: '/api/wp/bulk', headers, payload: { action: 'update', targets, backupFirst: false } });
    expect(run.statusCode).toBe(202);
    expect([alpha, beta, gamma].map((site) => queued(world, site).backupFirst)).toEqual([true, false, false]);
    expect((run.json() as { batch: BatchDto }).batch.options).toEqual({ backupFirst: false, healthCheck: true });
    settle(world);

    // Any other action backs up where it is asked to, whatever the sites are set to.
    const deactivate = await app.inject({ method: 'POST', url: '/api/wp/bulk', headers, payload: { action: 'deactivate', targets } });
    expect(deactivate.statusCode).toBe(202);
    expect([alpha, beta, gamma].map((site) => queued(world, site).backupFirst)).toEqual([false, false, false]);
    expect((deactivate.json() as { batch: BatchDto }).batch.options.backupFirst).toBeNull();
  });

  it('refuses a value it does not know', async () => {
    const { app, world, headers } = await authedApp();
    await addScannedSite(world, 'blog');
    for (const payload of [{ value: 'sometimes' }, {}, { value: true }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/sites/blog/backup-before-updates', headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const settings = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { backupBeforeUpdates: 'sometimes' } });
    expect(settings.statusCode).toBe(400);
  });
});
