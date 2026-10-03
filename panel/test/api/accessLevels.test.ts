/**
 * API keys with a level: Read only, Manage and Full, held by the auth gate against the level
 * each endpoint names in the API catalog - and the few things a route's level alone cannot
 * say, held in the handlers.
 */
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apiKeys, backups, jobLogs, jobs, mailDkimKeys, siteLicenses, sites } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import type { ApiActivityDto, JobDto } from '../../shared/types.js';
import type { AccessLevel } from '../../shared/access.js';
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
  const keyOf = async (access?: AccessLevel) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers,
      payload: { name: `key-${access ?? 'default'}`, ...(access ? { access } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, world, headers, keyOf };
}

function addSite(w: TestWorld, slug: string): void {
  const now = Date.now();
  w.db
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
    .run();
  w.docker.containers.set(`wp-${slug}`, 'running');
}

describe('API key levels', () => {
  it('gives a key Full unless it is asked for less, and says what each key is', async () => {
    const { app, headers, keyOf } = await authedApp();
    await keyOf();
    await keyOf('read');
    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    const items = list.json().items as { name: string; access: AccessLevel }[];
    expect(items.map((k) => [k.name, k.access])).toEqual([
      ['key-default', 'full'],
      ['key-read', 'read'],
    ]);
  });

  it('keeps the keys from before there were levels at Full', async () => {
    const { world } = await authedApp();
    // What migration 0016 does to an existing row: the column's default.
    world.db.insert(apiKeys).values({ name: 'old', tokenHash: 'h', prefix: 'wpl7_old', createdAt: 1 }).run();
    expect(world.db.select().from(apiKeys).all().find((k) => k.name === 'old')!.access).toBe('full');
  });

  it('lets a Read only key read, and refuses it anything else with both sides named', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const read = await keyOf('read');

    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: read })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sites/alpha', headers: read })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: read })).statusCode).toBe(200);

    const restart = await app.inject({ method: 'POST', url: '/api/sites/alpha/restart', headers: read });
    expect(restart.statusCode).toBe(403);
    expect(restart.json().error).toMatchObject({
      code: 'forbidden',
      message: 'This key is Read only; POST /api/sites/:slug/restart needs Manage',
    });
    // Nothing was queued.
    expect(world.db.select().from(jobs).all()).toHaveLength(0);

    // A GET that returns secrets is Manage, not Read only.
    const file = await app.inject({ method: 'GET', url: '/api/sites/alpha/files/content?path=wp-config.php', headers: read });
    expect(file.statusCode).toBe(403);
    expect(file.json().error.message).toBe('This key is Read only; GET /api/sites/:slug/files/content needs Manage');
  });

  it('lets a Manage key change sites but not delete one', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');

    const restart = await app.inject({ method: 'POST', url: '/api/sites/alpha/restart', headers: manage });
    expect(restart.statusCode).toBe(202);
    expect((restart.json() as { job: JobDto }).job).toMatchObject({ origin: 'api', createdBy: 'API key "key-manage"' });

    const del = await app.inject({ method: 'DELETE', url: '/api/sites/alpha', headers: manage });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.message).toBe('This key is Manage; DELETE /api/sites/:slug needs Full');

    // Raised above the rule of thumb: switching backups off takes a safety net away.
    const backupsOff = await app.inject({
      method: 'PUT',
      url: '/api/sites/alpha/backups-enabled',
      headers: manage,
      payload: { enabled: false },
    });
    expect(backupsOff.statusCode).toBe(403);
    const jobId = (restart.json() as { job: JobDto }).job.id;
    const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: manage });
    expect(cancel.statusCode).toBe(200);
  });

  it('lets a Manage key do inside a site what its WordPress admin could, and nothing of the panel', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, headers: manage, ...(payload ? { payload } : {}) });

    // Inside the site: refused for whatever the fake world lacks, never for the level.
    const inside = [
      await call('POST', '/api/sites/alpha/wp/cli', { args: ['option', 'get', 'siteurl'] }),
      await call('POST', '/api/sites/alpha/shell', { command: 'ls' }),
      await call('GET', '/api/sites/alpha/files/content?path=wp-config.php'),
      await call('POST', '/api/sites/alpha/wp/users/reset-password', { user: 'admin' }),
      await call('POST', '/api/sites/alpha/ftp/users', { username: 'alpha-dev' }),
      await call('POST', '/api/sites/alpha/stop'),
    ];
    for (const res of inside) expect(res.statusCode, res.body).not.toBe(403);

    // The panel's own: refused, naming the level.
    const panel = [
      await call('PUT', '/api/settings', { jobsRetentionDays: 30 }),
      await call('POST', '/api/recipes/breakdance/install'),
      await call('POST', '/api/plugins', { kind: 'wporg', slug: 'akismet' }),
    ];
    for (const res of panel) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.message).toMatch(/^This key is Manage; .* needs Full$/);
    }
  });

  it("lets a Manage key download a site's backup, and never a panel snapshot", async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const backup = (slug: string, type: string) =>
      world.db
        .insert(backups)
        .values({ siteSlug: slug, type, status: 'complete', path: `/srv/backups/${slug}/20260928-120000`, filesPresent: 0, createdAt: Date.now() })
        .returning()
        .get();
    const site = backup('alpha', 'manual');
    const panel = backup('panel', 'panel');
    const manage = await keyOf('manage');

    // Past the level: refused only because its files are offsite.
    const ofSite = await app.inject({ method: 'GET', url: `/api/backups/${site.id}/download`, headers: manage });
    expect(ofSite.statusCode, ofSite.body).toBe(409);
    // panel.db holds every credential of the panel, far beyond any site's.
    const ofPanel = await app.inject({ method: 'GET', url: `/api/backups/${panel.id}/download`, headers: manage });
    expect(ofPanel.statusCode).toBe(403);
    expect(ofPanel.json().error.message).toBe('This key is Manage; downloading a panel snapshot needs Full');
    const full = await keyOf('full');
    const byFull = await app.inject({ method: 'GET', url: `/api/backups/${panel.id}/download`, headers: full });
    expect(byFull.statusCode, byFull.body).toBe(409);

    // Nor sent somewhere else: where panel.db may go, encrypted or not, is the admin's call.
    const copy = await app.inject({ method: 'POST', url: `/api/backups/${panel.id}/offsite`, headers: manage, payload: {} });
    expect(copy.statusCode).toBe(403);
    expect(copy.json().error.message).toBe('This key is Manage; copying a panel snapshot needs Full');
    const fetched = await app.inject({
      method: 'POST',
      url: `/api/backups/${panel.id}/fetch`,
      headers: manage,
      payload: { destinationId: 1 },
    });
    expect(fetched.statusCode).toBe(403);
    expect(fetched.json().error.message).toBe('This key is Manage; fetching a panel snapshot needs Full');
  });

  it('lets a Manage key cancel work in a site, but not a backup the panel took, nor its own jobs', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');
    const queued = (values: { type: string; siteSlug?: string; origin: string }) =>
      world.db.insert(jobs).values({ status: 'queued', payload: '{}', createdAt: Date.now(), ...values }).returning().get();

    // Cancelled night after night, these would be the backups switched off.
    const refused = [
      [queued({ type: 'backup.create', siteSlug: 'alpha', origin: 'schedule' }), 'cancelling a backup the panel took on its own'],
      [queued({ type: 'backup.offsite', siteSlug: 'alpha', origin: 'system' }), 'cancelling a backup the panel took on its own'],
      [queued({ type: 'panel.snapshot', origin: 'schedule' }), 'cancelling a job of the panel itself'],
      [queued({ type: 'backup.offsite', siteSlug: 'panel', origin: 'user' }), 'cancelling a job of the panel itself'],
    ] as const;
    for (const [job, what] of refused) {
      const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: manage });
      expect(res.statusCode, `${job.type}`).toBe(403);
      expect(res.json().error.message).toBe(`This key is Manage; ${what} needs Full`);
      expect(world.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('queued');
    }

    // Whoever pressed "Run now": what the backup policy starts is the policy's.
    const nightlyRun = queued({ type: 'backup.create', siteSlug: 'alpha', origin: 'api' });
    world.db.update(jobs).set({ scheduleId: world.deps.schedulers.get('backups').id }).where(eq(jobs.id, nightlyRun.id)).run();
    const ranNow = await app.inject({ method: 'POST', url: `/api/jobs/${nightlyRun.id}/cancel`, headers: manage });
    expect(ranNow.statusCode).toBe(403);
    expect(ranNow.json().error.message).toBe('This key is Manage; cancelling what a built-in schedule started needs Full');

    // Its own work, a site's or a fleet scan, is Manage's to stop.
    const asked = queued({ type: 'backup.create', siteSlug: 'alpha', origin: 'api' });
    const mine = await app.inject({ method: 'POST', url: `/api/jobs/${asked.id}/cancel`, headers: manage });
    expect(mine.statusCode, mine.body).toBe(200);
    const scan = queued({ type: 'wp.scanAll', origin: 'api' });
    const scanCancel = await app.inject({ method: 'POST', url: `/api/jobs/${scan.id}/cancel`, headers: manage });
    expect(scanCancel.statusCode, scanCancel.body).toBe(200);
    const full = await keyOf('full');
    const nightly = refused[0][0];
    const byFull = await app.inject({ method: 'POST', url: `/api/jobs/${nightly.id}/cancel`, headers: full });
    expect(byFull.statusCode, byFull.body).toBe(200);
  });

  it('lets a Manage key delete plugins in bulk, as it may delete one', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');

    // Refused for another reason (no snapshot here), never the level.
    const one = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/bulk',
      headers: manage,
      payload: { ops: [{ kind: 'plugin', slug: 'akismet', action: 'delete' }] },
    });
    expect(one.statusCode, one.body).not.toBe(403);

    const fleet = await app.inject({
      method: 'POST',
      url: '/api/wp/bulk',
      headers: manage,
      payload: { action: 'delete', targets: [{ siteSlug: 'alpha', kind: 'plugin', slug: 'akismet' }] },
    });
    expect(fleet.statusCode, fleet.body).not.toBe(403);
  });

  it('lets a Manage key go live, but not have the panel write DNS for it', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');
    const withDns = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/go-live',
      headers: manage,
      payload: { domains: ['alpha-shop.example'], manageDns: true },
    });
    expect(withDns.statusCode).toBe(403);
    expect(withDns.json().error.message).toBe('This key is Manage; writing DNS records (manageDns) needs Full');
    const without = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/go-live',
      headers: manage,
      payload: { domains: ['alpha-shop.example'] },
    });
    expect(without.statusCode).toBe(202);
  });

  it('lets a Manage key take a domain, but not one the panel signs mail for with a key of its own', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    // Kept after its site was deleted: whoever claims the domain sends mail signed as it.
    world.db
      .insert(mailDkimKeys)
      .values({ domain: 'old-client.example', selector: 's1', privateKeyPem: 'x', publicKeyB64: 'y', createdAt: Date.now() })
      .run();
    const manage = await keyOf('manage');
    for (const [method, url] of [
      ['POST', '/api/sites/alpha/go-live'],
      ['PUT', '/api/sites/alpha/domains'],
    ] as const) {
      const res = await app.inject({ method, url, headers: manage, payload: { domains: ['old-client.example'] } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(
        'This key is Manage; a domain whose mail would be signed with a DKIM key this site does not hold (old-client.example) needs Full',
      );
    }
    // A subdomain is signed with the key of the domain it is under.
    const under = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/go-live',
      headers: manage,
      payload: { domains: ['promo.old-client.example'] },
    });
    expect(under.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: manage,
      payload: {
        title: 'Old client',
        domainMode: 'custom',
        domains: ['old-client.example'],
        adminUser: 'admin',
        adminEmail: 'a@old-client.example',
      },
    });
    expect(created.statusCode).toBe(403);
    // Any other domain is the site's own business - a subdomain of one it holds included.
    const other = await app.inject({ method: 'POST', url: '/api/sites/alpha/go-live', headers: manage, payload: { domains: ['new-client.example'] } });
    expect(other.statusCode, other.body).toBe(202);
    world.db.update(sites).set({ domains: JSON.stringify(['new-client.example']) }).where(eq(sites.slug, 'alpha')).run();
    world.db
      .insert(mailDkimKeys)
      .values({ domain: 'new-client.example', selector: 's1', privateKeyPem: 'x', publicKeyB64: 'y', createdAt: Date.now() })
      .run();
    world.db.update(jobs).set({ status: 'succeeded' }).run();
    const ownSub = await app.inject({
      method: 'PUT',
      url: '/api/sites/alpha/domains',
      headers: manage,
      payload: { domains: ['new-client.example', 'shop.new-client.example'] },
    });
    expect(ownSub.statusCode, ownSub.body).not.toBe(403);
    const byFull = await app.inject({
      method: 'PUT',
      url: '/api/sites/alpha/domains',
      headers: await keyOf('full'),
      payload: { domains: ['old-client.example'] },
    });
    expect(byFull.statusCode, byFull.body).not.toBe(403);
  });

  it('refuses the terminal below Full, before the upgrade', async () => {
    const { app, keyOf } = await authedApp();
    const manage = await keyOf('manage');
    const res = await app.inject({ method: 'GET', url: '/api/servers/1/terminal', headers: manage });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('This key is Manage; GET /api/servers/:id/terminal needs Full');
  });

  it('logs a refusal as denied, under the key that was refused', async () => {
    const { app, headers, keyOf } = await authedApp();
    const read = await keyOf('read');
    await app.inject({ method: 'POST', url: '/api/wp/scan', headers: read });
    const activity = (await app.inject({ method: 'GET', url: '/api/api-keys/activity', headers })).json() as ApiActivityDto;
    expect(activity.items[0]).toMatchObject({
      keyName: 'key-read',
      route: '/api/wp/scan',
      status: 403,
      outcome: 'denied',
      errorCode: 'forbidden',
      via: null,
    });
  });

  it('leaves the browser session at Full', async () => {
    const { app, world, headers } = await authedApp();
    addSite(world, 'alpha');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/alpha/backups-enabled',
      headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('what a job shows a Read only caller', () => {
  it('masks a password in a job result, and shows it to Manage, which could reset it anyway', async () => {
    const { app, world, keyOf } = await authedApp();
    const job = world.db
      .insert(jobs)
      .values({
        type: 'site.create',
        siteSlug: 'alpha',
        status: 'succeeded',
        payload: '{}',
        result: JSON.stringify({ url: 'http://alpha.test', slug: 'alpha', adminPassword: 'Tr0ub4dor&3' }),
        createdAt: Date.now(),
        finishedAt: Date.now(),
      })
      .returning()
      .get();

    const read = await keyOf('read');
    const masked = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: read });
    expect(masked.json().job.result).toEqual({ url: 'http://alpha.test', slug: 'alpha', adminPassword: '•••' });
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: read });
    expect(list.body).not.toContain('Tr0ub4dor');

    for (const level of ['manage', 'full'] as const) {
      const one = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: await keyOf(level) });
      expect(one.json().job.result.adminPassword).toBe('Tr0ub4dor&3');
    }

    // A job of the panel itself, not of a site, keeps a credential masked below Full.
    const panelJob = world.db
      .insert(jobs)
      .values({
        type: 'server.add',
        status: 'succeeded',
        payload: '{}',
        result: JSON.stringify({ serverId: 2, token: 'p4nel-t0ken' }),
        createdAt: Date.now(),
        finishedAt: Date.now(),
      })
      .returning()
      .get();
    const byManage = await app.inject({ method: 'GET', url: `/api/jobs/${panelJob.id}`, headers: await keyOf('manage') });
    expect(byManage.json().job.result).toEqual({ serverId: 2, token: '•••' });
    // Nor is `panel` a site: the copies of a panel snapshot are filed under it.
    const snapshotCopy = world.db
      .insert(jobs)
      .values({
        type: 'backup.offsite',
        siteSlug: 'panel',
        status: 'succeeded',
        payload: '{}',
        result: JSON.stringify({ backupId: 9, token: 'p4nel-t0ken' }),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    const copyByManage = await app.inject({ method: 'GET', url: `/api/jobs/${snapshotCopy.id}`, headers: await keyOf('manage') });
    expect(copyByManage.json().job.result.token).toBe('•••');
    const byFull = await app.inject({ method: 'GET', url: `/api/jobs/${panelJob.id}`, headers: await keyOf('full') });
    expect(byFull.json().job.result.token).toBe('p4nel-t0ken');
  });

  it("withholds a command's summary and error at Read only, and will not search them either", async () => {
    const { app, world, keyOf } = await authedApp();
    const job = world.db
      .insert(jobs)
      .values({
        type: 'site.shell',
        status: 'failed',
        payload: '{}',
        summary: 'mysqldump -pS3cretPass shop',
        error: 'mysqldump: Got error: 1045: Access denied for user using password S3cretPass',
        createdAt: Date.now(),
      })
      .returning()
      .get();
    const read = await keyOf('read');
    const one = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: read });
    expect(one.json().job).toMatchObject({ summary: null, error: expect.stringContaining('Read only'), status: 'failed' });
    expect(one.body).not.toContain('S3cret');
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: read });
    expect(list.body).not.toContain('S3cret');
    // A search that would match the hidden text finds nothing - no yes/no answer to guess with.
    const probe = await app.inject({ method: 'GET', url: '/api/jobs?q=S3cretP', headers: read });
    expect(probe.json().total).toBe(0);

    // Manage could have run the command itself.
    const manage = await keyOf('manage');
    const found = await app.inject({ method: 'GET', url: '/api/jobs?q=S3cretP', headers: manage });
    expect(found.json().items.map((j: JobDto) => j.summary)).toEqual(['mysqldump -pS3cretPass shop']);
  });

  it("withholds a command's output at Read only, and hands it to Manage", async () => {
    const { app, world, keyOf } = await authedApp();
    const job = world.db
      .insert(jobs)
      .values({ type: 'wp.cli', status: 'succeeded', payload: '{}', createdAt: Date.now(), finishedAt: Date.now() })
      .returning()
      .get();
    world.db.insert(jobLogs).values({ jobId: job.id, ts: Date.now(), level: 'info', message: 'DB_PASSWORD=hunter2' }).run();

    const read = await keyOf('read');
    const withheld = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers: read });
    expect(withheld.statusCode).toBe(200);
    expect(withheld.json()).toMatchObject({ logs: [], lastSeq: 0, logsWithheld: true });
    expect(withheld.body).not.toContain('hunter2');

    const manage = await keyOf('manage');
    const shown = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers: manage });
    expect(shown.json().logs.map((l: { message: string }) => l.message)).toEqual(['DB_PASSWORD=hunter2']);

    // A recipe run is WP-CLI and PHP holding a licence key: the same.
    const recipes = world.db
      .insert(jobs)
      .values({ type: 'wp.recipes', status: 'succeeded', payload: '{}', createdAt: Date.now(), finishedAt: Date.now() })
      .returning()
      .get();
    world.db.insert(jobLogs).values({ jobId: recipes.id, ts: Date.now(), level: 'info', message: 'license LIC-1234-abcd accepted' }).run();
    const recipeLog = await app.inject({ method: 'GET', url: `/api/jobs/${recipes.id}?logAfter=0`, headers: read });
    expect(recipeLog.json()).toMatchObject({ logs: [], logsWithheld: true });
  });

  it('tells Read only that a recipe failed, never what its step printed: in the run, on the site, in another job', async () => {
    const { app, world, headers, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const site = world.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    await app.inject({ method: 'POST', url: '/api/recipes/breakdance/install', headers });
    // The vendor printed the key upper-cased; the runner hides it only where it is repeated exactly.
    const printed = 'Error: licence ABC123DEF456GHI7 not found';
    const run = world.db
      .insert(jobs)
      .values({
        type: 'wp.recipes',
        status: 'failed',
        siteSlug: 'alpha',
        payload: '{}',
        result: JSON.stringify({ outcomes: [{ recipeId: 'breakdance', name: 'Breakdance', status: 'failed', message: printed }] }),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    world.db.insert(siteLicenses).values({ siteId: site.id, recipeId: 'breakdance', status: 'failed', message: printed, checkedAt: Date.now() }).run();
    // Creating a site runs its recipes, and its log is shown at Read only.
    const created = world.db
      .insert(jobs)
      .values({ type: 'site.create', status: 'succeeded', siteSlug: 'alpha', payload: '{}', createdAt: Date.now() })
      .returning()
      .get();
    const withheld = 'what the step printed is not shown at Read only access';
    new JobContext(created.id, {}, world.db).warn(`Breakdance: FAILED - ${printed}`, `Breakdance: FAILED - ${withheld}`);

    const read = await keyOf('read');
    const result = (await app.inject({ method: 'GET', url: `/api/jobs/${run.id}`, headers: read })).json().job.result;
    expect(result.outcomes).toEqual([{ recipeId: 'breakdance', name: 'Breakdance', status: 'failed', message: withheld }]);
    const status = await app.inject({ method: 'GET', url: '/api/sites/alpha/wp/recipes', headers: read });
    expect(status.json().items).toMatchObject([{ recipeId: 'breakdance', status: 'failed', message: withheld }]);
    const log = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}?logAfter=0`, headers: read });
    expect(log.json().logs.map((l: { message: string }) => l.message)).toEqual([`Breakdance: FAILED - ${withheld}`]);
    const listed = await app.inject({ method: 'GET', url: '/api/jobs', headers: read });
    for (const res of [status, log, listed]) expect(res.body).not.toContain('ABC123');

    // Manage could have run the step itself.
    const manage = await keyOf('manage');
    const shown = (await app.inject({ method: 'GET', url: `/api/jobs/${run.id}`, headers: manage })).json().job.result;
    expect(shown.outcomes[0].message).toBe(printed);
    const shownStatus = (await app.inject({ method: 'GET', url: '/api/sites/alpha/wp/recipes', headers: manage })).json();
    expect(shownStatus.items[0].message).toBe(printed);
    const shownLog = (await app.inject({ method: 'GET', url: `/api/jobs/${created.id}?logAfter=0`, headers: manage })).json();
    expect(shownLog.logs[0].message).toBe(`Breakdance: FAILED - ${printed}`);
  });

  it('withholds it from what was logged before, too (migration 0017)', async () => {
    const { app, world, keyOf } = await authedApp();
    const job = world.db
      .insert(jobs)
      .values({ type: 'site.updateDomains', status: 'succeeded', payload: '{}', createdAt: Date.now() })
      .returning()
      .get();
    world.db
      .insert(jobLogs)
      .values([
        { jobId: job.id, ts: 1, level: 'warn', message: 'Breakdance: Replacing URLs inside Breakdance content did not succeed (Error: ABC123DEF456GHI7 (expired)); continuing.' },
        { jobId: job.id, ts: 2, level: 'warn', message: 'Breakdance: FAILED - Error: licence ABC123DEF456GHI7 not found' },
        { jobId: job.id, ts: 3, level: 'warn', message: 'ACF PRO: License key not entered yet (Plugins → Recipes)' },
      ])
      .run();
    // The migration's backfill, run again over lines written the way the runner always has.
    const migration = fs.readFileSync(new URL('../../src/db/migrations/0017_job_log_output.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').slice(1)) world.db.run(sql.raw(statement));

    const read = await keyOf('read');
    const log = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers: read });
    expect(log.json().logs.map((l: { message: string }) => l.message)).toEqual([
      'Breakdance: Replacing URLs inside Breakdance content did not succeed; continuing.',
      'Breakdance: FAILED - what the step printed is not shown at Read only access',
      'ACF PRO: License key not entered yet (Plugins → Recipes)',
    ]);
  });
});

describe('schedules at each level', () => {
  it('withholds what a command schedule runs at Read only, and shows it to Manage', async () => {
    const { app, world, headers, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers,
      payload: {
        name: 'Nightly export',
        action: 'site.shell',
        target: { kind: 'sites', slugs: ['alpha'] },
        params: { command: 'export-orders --token=s3cr3t-t0ken' },
        cron: '0 3 * * *',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().schedule.id as number;

    const read = await keyOf('read');
    const listed = await app.inject({ method: 'GET', url: '/api/schedules', headers: read });
    expect(listed.body).not.toContain('s3cr3t-t0ken');
    const one = await app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers: read });
    // Not masked but withheld: `mysqldump -pS3cret` has no `=` for a pattern to find.
    expect(one.json().schedule).toMatchObject({ action: 'site.shell', params: null });

    const manage = await keyOf('manage');
    const shown = await app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers: manage });
    expect(shown.json().schedule.params.command).toBe('export-orders --token=s3cr3t-t0ken');
  });

  it('holds the backup policy at Full: schedules that take backups, and every built-in one', async () => {
    const { app, world, headers, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');
    const target = { kind: 'sites', slugs: ['alpha'] };
    const create = (payload: object, h: Record<string, string> = manage) =>
      app.inject({ method: 'POST', url: '/api/schedules', headers: h, payload });

    // `scheduled` backups count toward retention: taken every five minutes, they would push the
    // real history out within hours.
    for (const payload of [
      { name: 'Often', action: 'backup', target, cron: '*/5 * * * *' },
      { name: 'Updates', action: 'wp.update', target, params: {}, cron: '0 3 * * *' },
      { name: 'Panel', action: 'panel.snapshot', target: { kind: 'panel' }, cron: '0 3 * * *' },
    ]) {
      const res = await create(payload);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.message).toBe('This key is Manage; a schedule that takes backups needs Full');
    }
    const noBackup = await create({ name: 'Updates', action: 'wp.update', target, params: { backupFirst: false }, cron: '0 3 * * *' });
    expect(noBackup.statusCode, noBackup.body).toBe(201);
    // Nor made into one.
    const cli = await create({ name: 'Flush', action: 'wp.cli', target, params: { args: ['cache', 'flush'] }, cron: '0 4 * * *' });
    expect(cli.statusCode, cli.body).toBe(201);
    const turned = await app.inject({
      method: 'PATCH',
      url: `/api/schedules/${cli.json().schedule.id}`,
      headers: manage,
      payload: { action: 'backup', params: {} },
    });
    expect(turned.statusCode).toBe(403);

    // One that takes backups is Full's to change, run and delete.
    const nightly = await create({ name: 'Nightly', action: 'backup', target, cron: '0 2 * * *' }, headers);
    expect(nightly.statusCode, nightly.body).toBe(201);
    const id = nightly.json().schedule.id as number;
    for (const [method, url, doing] of [
      ['PATCH', `/api/schedules/${id}`, 'changing'],
      ['POST', `/api/schedules/${id}/run`, 'running'],
      ['DELETE', `/api/schedules/${id}`, 'deleting'],
    ] as const) {
      const res = await app.inject({ method, url, headers: manage, ...(method === 'PATCH' ? { payload: { cron: '*/5 * * * *' } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(`This key is Manage; ${doing} a schedule that takes backups needs Full`);
    }

    // A built-in run now can prune: housekeeping runs even while it is paused.
    for (const key of ['backups', 'housekeeping', 'wp-scan']) {
      const res = await app.inject({ method: 'POST', url: `/api/schedules/${key}/run`, headers: manage });
      expect(res.statusCode, key).toBe(403);
      expect(res.json().error.message).toBe('This key is Manage; running a built-in schedule needs Full');
    }
  });

  it('lets Manage keep custom schedules, and only Full pause a built-in one', async () => {
    const { app, world, keyOf } = await authedApp();
    addSite(world, 'alpha');
    const manage = await keyOf('manage');
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: manage,
      payload: { name: 'Nightly scan', action: 'wp.scan', target: { kind: 'sites', slugs: ['alpha'] }, cron: '0 3 * * *' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().schedule.id as number;
    const paused = await app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, headers: manage, payload: { enabled: false } });
    expect(paused.statusCode, paused.body).toBe(200);

    // Pausing a built-in stops the backups for every site.
    const backups = await app.inject({ method: 'PATCH', url: '/api/schedules/backups', headers: manage, payload: { enabled: false } });
    expect(backups.statusCode).toBe(403);
    expect(backups.json().error.message).toBe('This key is Manage; pausing or resuming a built-in schedule needs Full');
    const full = await keyOf('full');
    const byFull = await app.inject({ method: 'PATCH', url: '/api/schedules/wp-scan', headers: full, payload: { enabled: false } });
    expect(byFull.statusCode, byFull.body).toBe(200);
  });
});

describe("what a caller below Full does not see: the panel's own secrets", () => {
  it("shows a custom rclone remote's own options by name only", async () => {
    const { app, headers, keyOf } = await authedApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/backup-destinations',
      headers,
      payload: { name: 'b2', provider: 'rclone', config: { type: 'b2', path: 'bucket/panel', account: 'acct-123', key: 'K0-sekrit' }, secrets: {} },
    });
    expect(created.statusCode, created.body).toBe(201);
    for (const level of ['read', 'manage'] as const) {
      const key = await keyOf(level);
      const listed = await app.inject({ method: 'GET', url: '/api/backup-destinations', headers: key });
      expect(listed.json().items[0].config).toEqual({ type: 'b2', path: 'bucket/panel', account: '•••', key: '•••' });
      const overview = await app.inject({ method: 'GET', url: '/api/backups/overview', headers: key });
      expect(overview.body).not.toContain('K0-sekrit');
    }
    const full = await keyOf('full');
    const shown = await app.inject({ method: 'GET', url: '/api/backup-destinations', headers: full });
    expect(shown.json().items[0].config.key).toBe('K0-sekrit');
  });

  it("says a licence key is set, without any of its characters", async () => {
    const { app, headers, keyOf } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/recipes/breakdance/install', headers });
    await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/key', headers, payload: { value: 'abc123def456ghi7' } });
    for (const level of ['read', 'manage'] as const) {
      const key = await keyOf(level);
      const recipe = (await app.inject({ method: 'GET', url: '/api/recipes', headers: key })).json().items.find((r: { id: string }) => r.id === 'breakdance');
      expect(recipe.inputs[0]).toMatchObject({ secret: true, set: true, display: null });
    }
    const full = await keyOf('full');
    const shown = (await app.inject({ method: 'GET', url: '/api/recipes', headers: full })).json().items.find((r: { id: string }) => r.id === 'breakdance');
    expect(shown.inputs[0].display).toMatch(/ghi7$/);
  });
});
