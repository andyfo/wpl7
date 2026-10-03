import { describe, expect, it } from 'vitest';
import { backupCopies, backupDestinations, backups, servers, sites } from '../../src/db/schema.js';
import type { BackupListDto } from '../../shared/types.js';
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
