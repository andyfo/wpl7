import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, servers, sites } from '../../src/db/schema.js';
import type { JobDto, JobListDto, JobTypeInfoDto } from '../../shared/types.js';
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
  const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'mcp' } });
  const { token } = created.json() as { token: string };
  return { app, world, headers, bearer: { authorization: `Bearer ${token}` } };
}

function addSite(w: TestWorld, slug: string, serverId = 1): number {
  const now = Date.now();
  const id = w.db
    .insert(sites)
    .values({
      slug,
      serverId,
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
    .get().id;
  (serverId === 1 ? w.docker : w.remote(serverId).docker).containers.set(`wp-${slug}`, 'running');
  return id;
}

const list = async (ctx: Awaited<ReturnType<typeof authedApp>>, query: string): Promise<JobListDto> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/jobs${query}`, headers: ctx.headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as JobListDto;
};

describe('GET /api/jobs', () => {
  it('records who queued a job: the admin in the panel, or the API key', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const bySession = await ctx.app.inject({ method: 'POST', url: '/api/sites/alpha/restart', headers: ctx.headers });
    expect(bySession.statusCode).toBe(202);
    ctx.world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
    const byKey = await ctx.app.inject({ method: 'POST', url: '/api/sites/alpha/restart', headers: ctx.bearer });
    expect(byKey.statusCode).toBe(202);

    const { items } = await list(ctx, '');
    expect(items.map((j) => [j.origin, j.createdBy])).toEqual([
      ['api', 'API key "mcp"'],
      ['user', 'admin'],
    ]);
  });

  it('filters by several statuses, and counts every status within the other filters', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const mk = (type: string, status: string, siteSlug: string | null = null) =>
      w.db.insert(jobs).values({ type, status, siteSlug, payload: '{}', createdAt: Date.now() }).returning().get();
    mk('site.restart', 'failed', 'alpha');
    mk('site.restart', 'succeeded', 'alpha');
    mk('backup.create', 'failed', 'beta');
    mk('backup.create', 'canceled', 'alpha');

    const failed = await list(ctx, '?status=failed');
    expect(failed.items).toHaveLength(2);
    expect(failed.total).toBe(2);
    // The chips count as if no status were chosen.
    expect(failed.counts).toEqual({ queued: 0, running: 0, succeeded: 1, failed: 2, canceled: 1 });

    const several = await list(ctx, '?status=failed,canceled&siteSlug=alpha');
    expect(several.items.map((j) => j.status).sort()).toEqual(['canceled', 'failed']);
    expect(several.counts).toEqual({ queued: 0, running: 0, succeeded: 1, failed: 1, canceled: 1 });

    const bad = await ctx.app.inject({ method: 'GET', url: '/api/jobs?status=failed,exploded', headers: ctx.headers });
    expect(bad.statusCode).toBe(400);
    expect((await list(ctx, '')).retentionDays).toBe(90);
  });

  it('filters by type, category, origin, schedule and time', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    const mk = (values: Partial<typeof jobs.$inferInsert>) =>
      w.db.insert(jobs).values({ type: 'demo', status: 'succeeded', payload: '{}', createdAt: now, ...values }).returning().get();
    const scan = mk({ type: 'wp.scanAll', origin: 'schedule', scheduleId: 7 });
    const backup = mk({ type: 'backup.create', origin: 'user', createdAt: now - 3 * 24 * 3600_000 });
    const offsite = mk({ type: 'backup.offsite', origin: 'schedule', scheduleId: 3 });

    expect((await list(ctx, '?type=wp.scanAll')).items.map((j) => j.id)).toEqual([scan.id]);
    expect((await list(ctx, '?category=backups')).items.map((j) => j.id)).toEqual([offsite.id, backup.id]);
    expect((await list(ctx, '?category=backups&type=backup.create')).items.map((j) => j.id)).toEqual([backup.id]);
    expect((await list(ctx, '?origin=user')).items.map((j) => j.id)).toEqual([backup.id]);
    expect((await list(ctx, '?scheduleId=3')).items.map((j) => j.id)).toEqual([offsite.id]);
    expect((await list(ctx, `?since=${now - 3600_000}`)).items).toHaveLength(2);
    expect((await list(ctx, `?until=${now - 3600_000}`)).items.map((j) => j.id)).toEqual([backup.id]);
  });

  // Regression: an empty number was coerced to 0 - `?until=` was a bound no job passes, so a form
  // that sent its blank fields got an empty list.
  it('reads a number left empty or blank as not given', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const job = w.db.insert(jobs).values({ type: 'demo', status: 'succeeded', payload: '{}', createdAt: Date.now() }).returning().get();
    const blank = await list(ctx, '?since=&until=%20&serverId=&scheduleId=&batchId=&limit=&offset=');
    expect(blank.items.map((j) => j.id)).toEqual([job.id]);
    // A number that is there is still checked.
    const res = await ctx.app.inject({ method: 'GET', url: '/api/jobs?until=soon', headers: ctx.headers });
    expect(res.statusCode).toBe(400);
  });

  it('searches ids, summaries, sites, errors and type labels', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const mk = (values: Partial<typeof jobs.$inferInsert>) =>
      w.db.insert(jobs).values({ type: 'demo', status: 'succeeded', payload: '{}', createdAt: Date.now(), ...values }).returning().get();
    const plugin = mk({ type: 'wp.pluginTask', summary: 'Update plugin Akismet', siteSlug: 'shop' });
    const broken = mk({ type: 'backup.create', status: 'failed', error: 'Disk full on /srv', siteSlug: 'blog' });
    const scan = mk({ type: 'wp.scanAll' });

    expect((await list(ctx, '?q=akismet')).items.map((j) => j.id)).toEqual([plugin.id]);
    expect((await list(ctx, '?q=DISK%20FULL')).items.map((j) => j.id)).toEqual([broken.id]);
    expect((await list(ctx, '?q=shop')).items.map((j) => j.id)).toEqual([plugin.id]);
    // Nobody types `wp.scanAll`; "inventory" is what the list calls it.
    expect((await list(ctx, '?q=inventory')).items.map((j) => j.id)).toEqual([scan.id]);
    expect((await list(ctx, `?q=%23${broken.id}`)).items.map((j) => j.id)).toEqual([broken.id]);
    expect((await list(ctx, `?q=${plugin.id}`)).items.map((j) => j.id)).toEqual([plugin.id]);
  });

  it("finds a server's jobs, including the ones in its named lanes", async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const now = Date.now();
    w.db.insert(servers).values({ id: 2, name: 'fra', kind: 'ssh', sshHost: '10.0.0.2', createdAt: now, updatedAt: now }).run();
    const mk = (values: Partial<typeof jobs.$inferInsert>) =>
      w.db.insert(jobs).values({ type: 'demo', status: 'succeeded', payload: '{}', createdAt: now, ...values }).returning().get();
    const onTwo = mk({ serverId: 2 });
    const laned = mk({ type: 'wp.cli', lane: 'exec:2' });
    const moveAux = mk({ type: 'site.move', serverId: 1, auxServerId: 2 });
    mk({ serverId: 1 });
    mk({ type: 'backup.offsite', lane: 'offsite:12' });

    const onServer2 = await list(ctx, '?serverId=2');
    expect(onServer2.items.map((j) => j.id).sort()).toEqual([onTwo.id, laned.id, moveAux.id].sort());
    expect(onServer2.items.find((j) => j.id === laned.id)!.serverId).toBe(2);
  });

  it('carries the new fields, and nothing from the payload', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers: ctx.headers,
      payload: { args: ['user', 'update', 'admin', '--user_pass=hunter2'], async: true },
    });
    expect(res.statusCode).toBe(202);
    const job = (res.json() as { job: JobDto }).job;
    expect(job).toMatchObject({
      type: 'wp.cli',
      summary: 'wp user update admin --user_pass=•••',
      origin: 'user',
      createdBy: 'admin',
      scheduleId: null,
      serverId: 1,
      cancelRequested: false,
    });
    expect(JSON.stringify(job)).not.toContain('hunter2');
  });
});

describe('GET /api/jobs/types', () => {
  it('lists every type with its name, description and time limit', async () => {
    const ctx = await authedApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/jobs/types', headers: ctx.bearer });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: JobTypeInfoDto[] };
    expect(items.find((t) => t.type === 'wp.scanAll')).toEqual({
      type: 'wp.scanAll',
      label: 'WordPress inventory scan',
      description: expect.stringContaining('running site'),
      category: 'wordpress',
      internal: false,
      timeoutMs: 3600_000,
    });
    expect(items.find((t) => t.type === 'demo')!.internal).toBe(true);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('tells a request to stop a running job apart from a refusal', async () => {
    const ctx = await authedApp();
    const w = ctx.world;
    const done = w.db.insert(jobs).values({ type: 'demo', status: 'succeeded', payload: '{}', createdAt: Date.now() }).returning().get();
    const refused = await ctx.app.inject({ method: 'POST', url: `/api/jobs/${done.id}/cancel`, headers: ctx.headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toBeUndefined();

    // A job the worker is running right now.
    // A second's worth of steps: running for as long as the test needs, and canceled at the next.
    const running = w.worker.enqueue('demo', { steps: 20, stepMs: 50 });
    // start() claims it before returning.
    w.worker.start();
    try {
      expect(w.db.select().from(jobs).where(eq(jobs.id, running.id)).get()!.status).toBe('running');
      const asked = await ctx.app.inject({ method: 'POST', url: `/api/jobs/${running.id}/cancel`, headers: ctx.headers });
      expect(asked.statusCode).toBe(409);
      expect(asked.json().error.details).toEqual({ cancelRequested: true });
      const detail = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${running.id}`, headers: ctx.headers });
      const status = (detail.json() as { job: JobDto }).job;
      expect(status.cancelRequested || status.status === 'canceled').toBe(true);
    } finally {
      await w.worker.stop();
    }
  });
});
