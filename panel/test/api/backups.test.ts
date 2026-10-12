import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupCopies, backupDestinations, backups, jobs, servers, sites } from '../../src/db/schema.js';
import type { BackupIdsDto, BackupListDto, JobDto } from '../../shared/types.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  return { app, world, headers };
}

function addSite(w: TestWorld, slug: string, title = slug): number {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

/** A backup row only - nothing here reads the files. */
function addBackup(
  w: TestWorld,
  slug: string,
  values: Partial<typeof backups.$inferInsert> & { createdAt: number },
) {
  return w.db
    .insert(backups)
    .values({
      siteId: null,
      siteSlug: slug,
      serverId: 1,
      type: 'scheduled',
      status: 'complete',
      path: `${w.config.paths.backups}/${slug}/${values.createdAt}`,
      rootPath: w.config.paths.backups,
      sizeBytes: 1000,
      ...values,
    })
    .returning()
    .get();
}

const list = async (ctx: Awaited<ReturnType<typeof authedApp>>, query = ''): Promise<BackupListDto> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/backups${query}`, headers: ctx.headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as BackupListDto;
};

describe('GET /api/backups', () => {
  it("lists every backup newest first - a deleted site's and the panel's own too", async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const shop = addSite(w, 'shop', 'The Shop');
    const kept = addBackup(w, 'shop', { siteId: shop, type: 'manual', createdAt: 3000 });
    const final = addBackup(w, 'gone', { type: 'final', createdAt: 2000, sizeBytes: 5000 });
    const older = addBackup(w, 'gone', { createdAt: 1000, sizeBytes: 2000 });
    const failed = addBackup(w, 'gone', { createdAt: 500, status: 'failed', sizeBytes: null });
    const panel = addBackup(w, 'panel', { type: 'panel', createdAt: 2500 });

    const all = await list(ctx);
    expect(all.total).toBe(5);
    expect(all.items.map((b) => b.id)).toEqual([kept.id, panel.id, final.id, older.id, failed.id]);
    expect(all.items[0]).toMatchObject({ siteSlug: 'shop', siteTitle: 'The Shop', siteDeleted: false, type: 'manual' });
    expect(all.items[1]).toMatchObject({ siteSlug: 'panel', siteTitle: null, siteDeleted: false, type: 'panel' });
    expect(all.items[2]).toMatchObject({ siteSlug: 'gone', siteTitle: null, siteDeleted: true, type: 'final' });
    // A deleted site is named here and nowhere else, so it is listed whatever the filters. The
    // failed attempt is a row of the list, but not a backup anybody could restore.
    expect(all.deletedSites).toEqual([{ slug: 'gone', backups: 3, complete: 2, lastBackupAt: 2000, sizeBytes: 7000 }]);
    expect((await list(ctx, '?type=manual')).deletedSites).toEqual(all.deletedSites);
  });

  it('filters by site, deleted or not, kind and server', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    w.db.insert(servers).values({ id: 2, name: 'fra', kind: 'ssh', sshHost: '10.0.0.2', createdAt: now, updatedAt: now }).run();
    const shop = addSite(w, 'shop');
    const onOne = addBackup(w, 'shop', { siteId: shop, createdAt: 4000 });
    const onTwo = addBackup(w, 'shop', { siteId: shop, serverId: 2, type: 'move', createdAt: 3000 });
    const gone = addBackup(w, 'gone', { type: 'final', createdAt: 2000 });
    const panel = addBackup(w, 'panel', { type: 'panel', createdAt: 1000 });

    const ids = async (query: string) => (await list(ctx, query)).items.map((b) => b.id);
    expect(await ids('?siteSlug=shop')).toEqual([onOne.id, onTwo.id]);
    expect(await ids('?siteSlug=gone')).toEqual([gone.id]);
    expect(await ids('?siteSlug=panel')).toEqual([panel.id]);
    expect(await ids('?deleted=true')).toEqual([gone.id]);
    // The complement: the sites there are, and the panel, which was never a site to delete.
    expect(await ids('?deleted=false')).toEqual([onOne.id, onTwo.id, panel.id]);
    expect(await ids('?type=final,move')).toEqual([onTwo.id, gone.id]);
    expect(await ids('?serverId=2')).toEqual([onTwo.id]);
    expect(await ids('?deleted=true&type=manual')).toEqual([]);
  });

  it('pages, with the total of the whole selection', async () => {
    const ctx = await authedApp();
    for (let i = 1; i <= 5; i++) addBackup(ctx.world, 'gone', { createdAt: i * 1000 });
    const page = await list(ctx, '?limit=2&offset=2');
    expect(page.total).toBe(5);
    expect(page.items.map((b) => b.createdAt)).toEqual([3000, 2000]);
  });

  it('carries each backup’s offsite copies', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    const dest = w.db
      .insert(backupDestinations)
      .values({
        name: 'bucket',
        provider: 's3',
        config: '{}',
        secrets: '{}',
        copyTypes: '["final"]',
        copyFromTs: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const gone = addBackup(w, 'gone', { type: 'final', createdAt: 1000, filesPresent: 0 });
    w.db
      .insert(backupCopies)
      .values({ backupId: gone.id, destinationId: dest.id, status: 'complete', remotePath: 'b/gone/1', completedAt: now, createdAt: now })
      .run();
    const [item] = (await list(ctx, '?deleted=true')).items;
    expect(item).toMatchObject({ filesPresent: false, siteDeleted: true });
    expect(item!.copies).toMatchObject([{ destinationName: 'bucket', status: 'complete' }]);
  });

  it('refuses a kind it does not know', async () => {
    const ctx = await authedApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/backups?type=nightly', headers: ctx.headers });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/backups/:id', () => {
  it("refuses a deleted site's backup while a site that took its name restores it", async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    // The site the backup was taken of is gone (site_id went NULL with it); a new one has the slug.
    const old = addBackup(w, 'shop', { type: 'final', createdAt: 1000 });
    const shop = addSite(w, 'shop');
    const restore = w.worker.enqueue(
      'backup.restore',
      { backupId: old.id, skipPreRestoreBackup: true },
      { id: shop, slug: 'shop', serverId: 1 },
    );
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/backups/${old.id}`, headers: ctx.headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain(`#${restore.id}`);
  });
});

const bulkDelete = (ctx: Awaited<ReturnType<typeof authedApp>>, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/api/backups/bulk-delete', headers: ctx.headers, payload });

/** The queued deletion: its lane, the site it shows under, and the ids it was handed. */
const queued = (w: TestWorld, job: JobDto) => {
  const row = w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
  return { type: row.type, lane: row.lane, siteSlug: row.siteSlug, ids: (JSON.parse(row.payload) as { backupIds: number[] }).backupIds };
};

describe('POST /api/backups/bulk-delete', () => {

  it('queues one deletion job for the backups named, oldest first, leaving out ids that do not exist', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const newer = addBackup(w, 'gone', { createdAt: 3000 });
    const older = addBackup(w, 'gone', { type: 'final', createdAt: 1000 });
    const res = await bulkDelete(ctx, { ids: [newer.id, 999, older.id, newer.id] });
    expect(res.statusCode, res.body).toBe(202);
    const { job, count } = res.json() as { job: JobDto; count: number };
    expect(count).toBe(2);
    expect(res.headers.location).toBe(`/api/jobs/${job.id}`);
    // Its own lane, beside the servers' work; shown under the one site it is about.
    expect(queued(w, job)).toEqual({ type: 'backup.delete', lane: 'backup-delete', siteSlug: 'gone', ids: [older.id, newer.id] });
    expect(job.summary).toBe('2 backups');
  });

  it('passes on keeping each site’s newest, for the job to check as it goes', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const a = addBackup(w, 'gone', { createdAt: 1000 });
    const res = await bulkDelete(ctx, { ids: [a.id], keepNewest: true });
    expect(res.statusCode, res.body).toBe(202);
    const job = w.db.select().from(jobs).where(eq(jobs.id, (res.json() as { job: JobDto }).job.id)).get()!;
    expect(JSON.parse(job.payload)).toEqual({ backupIds: [a.id], keepNewest: true });
  });

  it('names no site for backups of several, and answers 404 when none of the ids exist', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const a = addBackup(w, 'one', { createdAt: 1000 });
    const b = addBackup(w, 'panel', { type: 'panel', createdAt: 2000 });
    const res = await bulkDelete(ctx, { ids: [a.id, b.id] });
    expect(res.statusCode).toBe(202);
    expect(queued(w, res.json().job).siteSlug).toBeNull();

    const none = await bulkDelete(ctx, { ids: [404] });
    expect(none.statusCode).toBe(404);
  });

  it('takes ids only: never a filter, which would be read again when the request arrives', async () => {
    const ctx = await authedApp();
    addBackup(ctx.world, 'gone', { createdAt: 1000 });
    for (const payload of [
      {},
      { ids: [] },
      // Regression: by filter, a site deleted after the list was read joined "deleted" and lost
      // backups nobody had been shown.
      { filter: { deleted: true } },
      { ids: [1], filter: { siteSlug: 'gone' } },
      { ids: [1], asOf: 5 },
      { ids: Array.from({ length: 5001 }, (_, i) => i + 1) },
    ]) {
      const res = await bulkDelete(ctx, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
  });

  it('keeps a backup it is deleting from being restored, copied, fetched or deleted beside it', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const shop = addSite(w, 'shop');
    const backup = addBackup(w, 'shop', { siteId: shop, type: 'manual', createdAt: 1000 });
    const res = await bulkDelete(ctx, { ids: [backup.id] });
    const jobId = (res.json() as { job: JobDto }).job.id;

    const tries = [
      { method: 'POST' as const, url: `/api/backups/${backup.id}/restore`, payload: {} },
      { method: 'POST' as const, url: `/api/backups/${backup.id}/offsite`, payload: {} },
      { method: 'DELETE' as const, url: `/api/backups/${backup.id}` },
    ];
    for (const t of tries) {
      const answer = await ctx.app.inject({ ...t, headers: ctx.headers });
      expect(answer.statusCode, t.url).toBe(409);
      expect(answer.json().error.message, t.url).toContain(`job #${jobId}`);
    }
  });
});

describe('GET /api/backups/ids', () => {
  const ids = async (ctx: Awaited<ReturnType<typeof authedApp>>, query = '') => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/backups/ids${query}`, headers: ctx.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as BackupIdsDto;
  };

  it('answers every backup the filters match, on every page, newest first', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const shop = addSite(w, 'shop');
    const made = Array.from({ length: 60 }, (_, i) => addBackup(w, 'shop', { siteId: shop, createdAt: 1000 + i }));
    const gone = addBackup(w, 'gone', { type: 'final', createdAt: 500 });
    addBackup(w, 'panel', { type: 'panel', createdAt: 700 });

    const all = await ids(ctx, '?siteSlug=shop');
    // The list pages fifty at a time; Select all reaches past that.
    expect((await list(ctx, '?siteSlug=shop')).items).toHaveLength(50);
    expect(all.total).toBe(60);
    expect(all.items.map((b) => b.id)).toEqual(made.map((b) => b.id).reverse());
    expect(all.items[0]).toEqual({
      id: made[59]!.id,
      siteSlug: 'shop',
      siteDeleted: false,
      status: 'complete',
      sizeBytes: 1000,
      remoteCopies: 0,
    });
    expect(await ids(ctx, '?deleted=true')).toEqual({
      items: [{ id: gone.id, siteSlug: 'gone', siteDeleted: true, status: 'complete', sizeBytes: 1000, remoteCopies: 0 }],
      total: 1,
      leavesNone: ['gone'],
    });
  });

  // Delete old backups: several sites at once, only what was taken before a time, and the
  // newest of each left out when asked.
  it('takes several sites and an age, and leaves out each one’s newest when asked', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const shop = addSite(w, 'shop');
    const blog = addSite(w, 'blog');
    const shop1 = addBackup(w, 'shop', { siteId: shop, createdAt: 1000 });
    const shop2 = addBackup(w, 'shop', { siteId: shop, type: 'manual', createdAt: 2000 });
    const shop3 = addBackup(w, 'shop', { siteId: shop, createdAt: 3000 });
    const blog1 = addBackup(w, 'blog', { siteId: blog, createdAt: 1500 });
    const blog2 = addBackup(w, 'blog', { siteId: blog, createdAt: 2500 });
    const gone = addBackup(w, 'gone', { type: 'final', createdAt: 500 });
    const panel1 = addBackup(w, 'panel', { type: 'panel', createdAt: 700 });
    const panel2 = addBackup(w, 'panel', { type: 'panel', createdAt: 800 });
    const idsOf = (res: BackupIdsDto) => res.items.map((b) => b.id);

    const old = await ids(ctx, '?siteSlugs=shop,gone&until=2500');
    expect(idsOf(old)).toEqual([shop2.id, shop1.id, gone.id]);
    // shop keeps the one from 3000; gone has nothing else.
    expect(old.leavesNone).toEqual(['gone']);

    const keeping = await ids(ctx, '?siteSlugs=shop,gone&until=2500&keepNewest=true');
    expect(idsOf(keeping)).toEqual([shop2.id, shop1.id]);
    expect(keeping.leavesNone).toEqual([]);

    // Everything, every site's newest and the panel's left out.
    expect(idsOf(await ids(ctx, '?keepNewest=true'))).toEqual([shop2.id, blog1.id, shop1.id, panel1.id]);
    const panel = await ids(ctx, '?siteSlug=panel');
    expect(idsOf(panel)).toEqual([panel2.id, panel1.id]);
    expect(panel.leavesNone).toEqual(['panel']);

    // The list takes the same filters.
    expect((await list(ctx, '?siteSlugs=blog,shop&until=2500')).items.map((b) => b.id)).toEqual([shop2.id, blog1.id, shop1.id]);
    expect(idsOf(await ids(ctx, '?siteSlugs=blog'))).toEqual([blog2.id, blog1.id]);
    expect(idsOf(await ids(ctx, `?siteSlugs=shop&until=${shop3.createdAt}`))).toEqual([shop2.id, shop1.id]);
  });

  it('refuses a site list that is not slugs, too long or empty, and an age that is not one', async () => {
    const ctx = await authedApp();
    for (const query of [
      '?siteSlugs=Not_A_Slug',
      '?siteSlugs=a',
      `?siteSlugs=${Array.from({ length: 201 }, (_, i) => `site-${i}`).join(',')}`,
      // Chosen sites that came out as none must not mean every site.
      '?siteSlugs=',
      '?siteSlugs=,',
      '?until=soon',
      '?olderThanDays=',
      '?olderThanDays=0',
      '?olderThanDays=3651',
      '?keepNewest=maybe',
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/backups/ids${query}`, headers: ctx.headers });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('counts an age in days by the panel’s clock, and matches nothing for a time given empty', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const day = 24 * 3600_000;
    const old = addBackup(w, 'gone', { createdAt: Date.now() - 40 * day });
    addBackup(w, 'gone', { createdAt: Date.now() - 10 * day });
    expect((await ids(ctx, '?olderThanDays=30')).items.map((b) => b.id)).toEqual([old.id]);
    expect((await ids(ctx, '?until=')).items).toEqual([]);
  });

  it('counts no remote copy at a destination that manages its own retention: a delete leaves those', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    const backup = addBackup(w, 'gone', { createdAt: 1000 });
    const dest = (name: string, retentionMode: string) =>
      w.db
        .insert(backupDestinations)
        .values({ name, provider: 's3', config: '{}', secrets: '{}', copyTypes: '["scheduled"]', copyFromTs: 0, retentionMode, createdAt: now, updatedAt: now })
        .returning()
        .get().id;
    w.db
      .insert(backupCopies)
      .values([
        { backupId: backup.id, destinationId: dest('panel-pruned', 'panel'), status: 'complete', remotePath: 'p/1', createdAt: now },
        { backupId: backup.id, destinationId: dest('locked', 'external'), status: 'complete', remotePath: 'l/1', createdAt: now },
      ])
      .run();
    expect((await ids(ctx, '?siteSlug=gone')).items[0]!.remoteCopies).toBe(1);
  });

  it('says which sites deleting them leaves with no backup, counting a deletion already under way', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const blog = addSite(w, 'blog');
    const older = addBackup(w, 'blog', { siteId: blog, createdAt: 1000 });
    const failed = addBackup(w, 'blog', { siteId: blog, createdAt: 1500, status: 'failed', sizeBytes: null });
    const newer = addBackup(w, 'blog', { siteId: blog, createdAt: 2000 });
    expect((await ids(ctx, '?siteSlug=blog&until=1600')).leavesNone).toEqual([]);

    // Its newest is on its way out already: the old one is all it has left.
    await bulkDelete(ctx, { ids: [newer.id] });
    const res = await ids(ctx, '?siteSlug=blog&until=1600');
    expect(res.items.map((b) => b.id)).toEqual([failed.id, older.id]);
    expect(res.leavesNone).toEqual(['blog']);
    // And it is the newest that stays, when the newest is kept.
    const keeping = await ids(ctx, '?siteSlug=blog&keepNewest=true');
    expect(keeping.items.map((b) => b.id)).toEqual([failed.id]);
    expect(keeping.leavesNone).toEqual([]);
  });

  it('leaves out what nothing could delete now, and counts the remote copies', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    const writing = addBackup(w, 'gone', { createdAt: 3000, status: 'creating' });
    const doomed = addBackup(w, 'gone', { createdAt: 2000 });
    const failed = addBackup(w, 'gone', { createdAt: 1500, status: 'failed', sizeBytes: null });
    const copied = addBackup(w, 'gone', { createdAt: 1000 });
    const dest = (name: string) =>
      w.db
        .insert(backupDestinations)
        .values({ name, provider: 's3', config: '{}', secrets: '{}', copyTypes: '["scheduled"]', copyFromTs: 0, createdAt: now, updatedAt: now })
        .returning()
        .get().id;
    // One copy made, one that never made it: only the first is something a delete removes.
    w.db
      .insert(backupCopies)
      .values([
        { backupId: copied.id, destinationId: dest('bucket'), status: 'complete', remotePath: 'b/gone/1', completedAt: now, createdAt: now },
        { backupId: copied.id, destinationId: dest('other'), status: 'failed', remotePath: 'o/gone/1', createdAt: now },
      ])
      .run();
    await bulkDelete(ctx, { ids: [doomed.id] });

    const res = await ids(ctx, '?siteSlug=gone');
    expect(res.items.map((b) => b.id)).toEqual([failed.id, copied.id]);
    expect(res.items.map((b) => b.id)).not.toContain(writing.id);
    expect(res.items.find((b) => b.id === copied.id)!.remoteCopies).toBe(1);
    expect(res.items.find((b) => b.id === failed.id)!.status).toBe('failed');
  });

  it('is what was selected, whatever the filters would match later', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    addBackup(w, 'gone', { type: 'final', createdAt: 1000 });
    const shop = addSite(w, 'shop');
    const shopsOld = addBackup(w, 'shop', { siteId: shop, createdAt: 500 });
    const selected = (await ids(ctx, '?deleted=true')).items.map((b) => b.id);
    // shop is deleted after "Select all": "deleted" now matches its backup as well...
    w.db.delete(sites).where(eq(sites.id, shop)).run();
    expect((await ids(ctx, '?deleted=true')).items.map((b) => b.id)).toContain(shopsOld.id);
    // ...but the deletion sent is the ids that were selected, and takes those only.
    const res = await bulkDelete(ctx, { ids: selected });
    expect(queued(w, res.json().job).ids).toEqual(selected);
    expect(queued(w, res.json().job).ids).not.toContain(shopsOld.id);
  });
});

describe('PUT /api/sites/:slug/backups-keep-days', () => {
  const put = (ctx: Awaited<ReturnType<typeof authedApp>>, slug: string, payload: unknown) =>
    ctx.app.inject({ method: 'PUT', url: `/api/sites/${slug}/backups-keep-days`, headers: ctx.headers, payload });

  it('sets a site’s own keep period, never, or the panel’s again', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'shop');
    expect((await ctx.world.deps.sites.detail('shop')).backupKeepDays).toBeNull();

    for (const days of [45, 0, null]) {
      const res = await put(ctx, 'shop', { days });
      expect(res.statusCode, res.body).toBe(200);
      // The fresh site detail, like the other per-site backup switches answer.
      expect(res.json().backupKeepDays).toBe(days);
    }
    await put(ctx, 'shop', { days: 90 });
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/sites', headers: ctx.headers });
    const items = (listed.json() as { items: { slug: string; backupKeepDays: number | null }[] }).items;
    expect(items.find((s) => s.slug === 'shop')?.backupKeepDays).toBe(90);
  });

  it('refuses what is not a number of days, and a site that does not exist', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'shop');
    for (const payload of [{}, { days: -1 }, { days: 3651 }, { days: 1.5 }, { days: '30' }]) {
      expect((await put(ctx, 'shop', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await put(ctx, 'nope', { days: 30 })).statusCode).toBe(404);
  });
});

describe('PUT /api/settings: how long backups are kept', () => {
  it('takes days for sites and for the panel, 0 for never', async () => {
    const ctx = await authedApp();
    const settings = async (payload: unknown) =>
      ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: ctx.headers, payload });
    // Off until somebody sets it: an update must not start deleting backups.
    const before = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: ctx.headers });
    expect(before.json().settings).toMatchObject({ backupKeepDays: 0, panelBackupKeepDays: 0 });

    const res = await settings({ backupKeepDays: 30, panelBackupKeepDays: 14 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toMatchObject({ backupKeepDays: 30, panelBackupKeepDays: 14 });
    for (const payload of [{ backupKeepDays: -1 }, { panelBackupKeepDays: 3651 }, { backupKeepDays: 2.5 }]) {
      expect((await settings(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
