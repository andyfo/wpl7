import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, plugins, sites } from '../../src/db/schema.js';
import { makeApp, makeWorld } from '../helpers.js';

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

/**
 * The worker never runs in these API tests. Settle the queued create by hand so the site is
 * free for another job - canceling it instead would (correctly) release the reservation and
 * delete the site row, see JobWorker.cancel / siteCreateQueuedCancel.
 */
function settleCreate(world: Awaited<ReturnType<typeof makeWorld>>): void {
  world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).where(eq(jobs.type, 'site.create')).run();
  world.db.update(sites).set({ status: 'running' }).run();
}

const createBody = {
  title: 'My Blog',
  domainMode: 'dev',
  adminUser: 'boss',
  adminEmail: 'boss@example.com',
};

describe('sites API: isolation controls', () => {
  it('suspends and resumes a site\'s mail, answering with the updated site', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);

    const suspend = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/mail-suspension',
      headers,
      payload: { suspended: true, reason: 'Sent 4212 messages in an hour' },
    });
    expect(suspend.statusCode).toBe(200);
    // Regression: the handler used to hand Fastify an unresolved promise, which serializes
    // as `{}` - the suspension took effect but the caller was told nothing.
    expect(suspend.json().mailSuspended).toMatchObject({ reason: 'Sent 4212 messages in an hour' });
    expect(world.db.select().from(sites).get()!.mailSuspendedAt).toBeTruthy();

    const resume = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/mail-suspension',
      headers,
      payload: { suspended: false },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().mailSuspended).toBeNull();
    expect(world.db.select().from(sites).get()!.mailSuspendedAt).toBeNull();
  });

  it('queues a reconcile for one site and for the whole fleet', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);

    const one = await app.inject({ method: 'POST', url: '/api/sites/my-blog/reconcile', headers });
    expect(one.statusCode).toBe(202);
    expect(one.json().job).toMatchObject({ type: 'site.reconcile', siteSlug: 'my-blog' });

    world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).where(eq(jobs.type, 'site.reconcile')).run();
    const all = await app.inject({ method: 'POST', url: '/api/sites/reconcile-all', headers });
    expect(all.statusCode).toBe(202);
    expect(all.json().jobs).toHaveLength(1);
  });

  it('refuses a mail suspension for a site that does not exist', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/nope/mail-suspension',
      headers,
      payload: { suspended: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('sites API', () => {
  it('validates the create body with a 400 envelope', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { title: '', adminEmail: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('accepts a create with 202 + Location and a queued job (worker not running)', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    expect(res.statusCode).toBe(202);
    const { job } = res.json();
    expect(res.headers.location).toBe(`/api/jobs/${job.id}`);
    expect(job.status).toBe('queued');
    expect(job.type).toBe('site.create');
    expect(job.siteSlug).toBe('my-blog');

    const list = await app.inject({ method: 'GET', url: '/api/sites', headers });
    const items = list.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].primaryDomain).toBe('my-blog.dev.example.test');
    expect(items[0].status).toBe('provisioning');

    const jobRes = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers });
    expect(jobRes.statusCode).toBe(200);
    expect(jobRes.json().lastSeq).toBe(0);
  });

  it('409s a second job for the same site and a duplicate slug', async () => {
    const { app, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/sites/my-blog/stop',
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    // 'conflict' (status guard on provisioning sites) or 'job_conflict' (per-site job guard)
    expect(['conflict', 'job_conflict']).toContain(conflict.json().error.code);

    const dupSlug = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    expect(dupSlug.statusCode).toBe(409);
  });

  it('takes a left-out admin email from Settings, and refuses the create while none is set', async () => {
    const { app, world, headers } = await authedApp();
    const { adminEmail: _given, ...noEmail } = createBody;

    const refused = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: noEmail });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/"adminEmail"/);
    expect(world.db.select().from(sites).all()).toHaveLength(0);

    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { defaultAdminEmail: 'nope' } });
    expect(bad.statusCode).toBe(400);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { defaultAdminEmail: 'agency@example.com' },
    });
    expect(saved.json().settings.defaultAdminEmail).toBe('agency@example.com');
    // The wizard prefills its field from here.
    const meta = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect(meta.json().defaultAdminEmail).toBe('agency@example.com');

    const created = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: noEmail });
    expect(created.statusCode).toBe(202);
    const given = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { ...createBody, title: 'Their Shop' },
    });
    expect(given.statusCode).toBe(202);
    const emails = world.db.select({ slug: sites.slug, email: sites.wpAdminEmail }).from(sites).all();
    expect(emails).toEqual([
      { slug: 'my-blog', email: 'agency@example.com' },
      { slug: 'their-shop', email: 'boss@example.com' },
    ]);

    // Emptied again: nothing to fall back on.
    await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { defaultAdminEmail: '' } });
    const again = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { ...noEmail, title: 'Later' } });
    expect(again.statusCode).toBe(400);
  });

  it('rejects custom domains colliding with the dev domain or panel host', async () => {
    const { app, headers } = await authedApp();
    const underDev = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { ...createBody, domainMode: 'custom', domains: ['x.dev.example.test'] },
    });
    expect(underDev.statusCode).toBe(400);
    const panelHost = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { ...createBody, domainMode: 'custom', domains: ['panel.example.test'] },
    });
    expect(panelHost.statusCode).toBe(409);
  });

  it('404s unknown sites with the envelope', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/sites/ghost', headers });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('go-live enqueues an updateDomains job with the right payload', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/my-blog/go-live',
      headers,
      payload: { domains: ['myblog.com', 'www.myblog.com'] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().job.type).toBe('site.updateDomains');
  });

  it('validates PHP versions against the offered list', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/php',
      headers,
      payload: { phpVersion: '8.9' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not offered/);
  });
});

describe('site delete query parsing', () => {
  // Regression: z.coerce.boolean() is Boolean(input), so "false" used to parse as true
  // and the "skip final backup" option could never be exercised.
  it('honours ?finalBackup=false', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);

    const res = await app.inject({ method: 'DELETE', url: '/api/sites/my-blog?finalBackup=false', headers });
    expect(res.statusCode).toBe(202);
    const row = world.db.select().from(jobs).where(eq(jobs.id, res.json().job.id)).get()!;
    expect(JSON.parse(row.payload).finalBackup).toBe(false);
  });

  it('defaults to a final backup and still accepts true', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);

    const def = await app.inject({ method: 'DELETE', url: '/api/sites/my-blog', headers });
    const defRow = world.db.select().from(jobs).where(eq(jobs.id, def.json().job.id)).get()!;
    expect(JSON.parse(defRow.payload).finalBackup).toBe(true);

    world.worker.cancel(def.json().job.id);
    const explicit = await app.inject({ method: 'DELETE', url: '/api/sites/my-blog?finalBackup=true', headers });
    const trueRow = world.db.select().from(jobs).where(eq(jobs.id, explicit.json().job.id)).get()!;
    expect(JSON.parse(trueRow.payload).finalBackup).toBe(true);
  });
});

describe('site delete: its backups', () => {
  it('keeps the backups unless ?deleteBackups=true asks otherwise', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/sites', headers, payload: createBody });
    settleCreate(world);

    const def = await app.inject({ method: 'DELETE', url: '/api/sites/my-blog', headers });
    const defRow = world.db.select().from(jobs).where(eq(jobs.id, def.json().job.id)).get()!;
    expect(JSON.parse(defRow.payload)).toMatchObject({ finalBackup: true, deleteBackups: false });

    world.worker.cancel(def.json().job.id);
    const both = await app.inject({ method: 'DELETE', url: '/api/sites/my-blog?finalBackup=true&deleteBackups=true', headers });
    expect(both.statusCode).toBe(202);
    const bothRow = world.db.select().from(jobs).where(eq(jobs.id, both.json().job.id)).get()!;
    expect(JSON.parse(bothRow.payload)).toMatchObject({ finalBackup: true, deleteBackups: true });
    expect(bothRow.summary).toBe('Keeping only a final backup');
  });
});

describe('site create: plugins', () => {
  /** A catalog of two defaults - a wordpress.org plugin and an upload - and one that is not. */
  function seedCatalog(world: Awaited<ReturnType<typeof makeWorld>>): void {
    const now = Date.now();
    world.db
      .insert(plugins)
      .values([
        { kind: 'wporg', slug: 'wordpress-seo', name: 'Yoast SEO', isDefault: 1, createdAt: now },
        { kind: 'wporg', slug: 'woocommerce', name: 'WooCommerce', isDefault: 0, createdAt: now },
        { kind: 'zip', slug: 'acf-pro', name: 'ACF PRO', zipPath: 'acf-pro-6.3.2.zip', isDefault: 1, createdAt: now },
      ])
      .run();
  }

  async function created(payload: Record<string, unknown>) {
    const { app, world, headers } = await authedApp();
    seedCatalog(world);
    const res = await app.inject({ method: 'POST', url: '/api/sites', headers, payload });
    expect(res.statusCode).toBe(202);
    const row = world.db.select().from(jobs).where(eq(jobs.id, res.json().job.id)).get()!;
    const { pluginSlugs, pluginZipPaths } = JSON.parse(row.payload) as { pluginSlugs: string[]; pluginZipPaths: string[] };
    return { pluginSlugs, pluginZipPaths };
  }

  // Regression: the defaults were only ticked by the New Site wizard, so a site an AI app made
  // over MCP - which sends no plugin choice - got no plugins, and so no recipes either.
  it("installs the catalog's defaults when the request makes no plugin choice", async () => {
    expect(await created(createBody)).toEqual({ pluginSlugs: ['wordpress-seo'], pluginZipPaths: ['acf-pro-6.3.2.zip'] });
  });

  it('adds wordpress.org extras to the defaults when catalogIds is left out', async () => {
    expect(await created({ ...createBody, plugins: { extraWporgSlugs: ['contact-form-7'] } })).toEqual({
      pluginSlugs: ['wordpress-seo', 'contact-form-7'],
      pluginZipPaths: ['acf-pro-6.3.2.zip'],
    });
  });

  it('installs exactly the catalog entries named, and none for an empty list', async () => {
    expect(await created({ ...createBody, plugins: { catalogIds: [2] } })).toEqual({
      pluginSlugs: ['woocommerce'],
      pluginZipPaths: [],
    });
    expect(await created({ ...createBody, plugins: { catalogIds: [] } })).toEqual({ pluginSlugs: [], pluginZipPaths: [] });
  });
});
