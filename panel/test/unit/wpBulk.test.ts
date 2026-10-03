import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, batches, jobLogs, jobs, siteWpComponents, sites, type SiteRow } from '../../src/db/schema.js';
import type { WpBulkOpResult } from '../../shared/types.js';
import { AppError } from '../../src/lib/errors.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { sortOps } from '../../src/services/wpBulk.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, stdout = '') => ({ stdout, stderr, exitCode: 1 });

function addRunningSite(w: TestWorld, slug: string, opts: { serverId?: number; files?: boolean } = {}): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      serverId: opts.serverId ?? 1,
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
  const docker = opts.serverId && opts.serverId !== 1 ? w.remote(opts.serverId).docker : w.docker;
  docker.containers.set(site.containerName, 'running');
  if (opts.files) {
    // Enough of a site on disk for a real backup (tar + manifest) to run.
    const p = sitePaths(w.config, slug);
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.mkdirSync(p.configDir, { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // wp');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.8.2';");
    fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  }
  return site;
}

/** The per-target reasons a rejected batch carries in `error.details`. */
function rejectionReasons(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).details as string[];
  }
  throw new Error('expected the batch to be rejected');
}

const PLUGIN_LIST = JSON.stringify([
  { name: 'cf7', title: 'Contact Form 7', status: 'active', version: '5.3.1', update: 'available', update_version: '6.0.1', auto_update: 'off', file: 'cf7/cf7.php' },
  { name: 'seo', title: 'SEO', status: 'inactive', version: '1.0', update: 'available', update_version: '1.1', auto_update: 'off', file: 'seo/seo.php' },
  { name: 'ceo-login', title: 'Panel login', status: 'must-use', version: '1.0', update: 'none', update_version: null, auto_update: 'off', file: 'ceo-login.php' },
]);
const THEME_LIST = JSON.stringify([
  { name: 'child', title: 'Child', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off' },
  { name: 'old', title: 'Old', status: 'inactive', version: '1.0', update: 'available', update_version: '2.0', auto_update: 'off' },
]);

/** Queue the four answers one inventory scan consumes. */
function scriptScan(w: TestWorld, serverId = 1): void {
  const docker = serverId === 1 ? w.docker : w.remote(serverId).docker;
  docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
}

async function seedSnapshot(w: TestWorld, site: SiteRow): Promise<void> {
  scriptScan(w, site.serverId);
  await w.core.wpInventory.scanSite(site, w.servers.handleFor(site.serverId), { refreshFeed: false });
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const resultOps = (job: { result: string | null }): WpBulkOpResult[] =>
  ((JSON.parse(job.result ?? '{}') as { ops?: WpBulkOpResult[] }).ops ?? []);

const execLines = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));

/** A throwaway HTTP server the health check can actually reach. */
const servers: http.Server[] = [];
async function probeTarget(w: TestWorld, status: number): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = w.servers.handleFor(1);
  // The real probeUrlFor goes through Traefik on :80, which no test can bind.
  handle.probeUrlFor = () => `http://127.0.0.1:${port}/`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('wp.bulkTask', () => {
  it('coalesces updates per kind and splits the JSON back per slug', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);

    w.docker.execQueue.push(
      ok(JSON.stringify([
        { name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' },
        { name: 'seo', old_version: '1.0', new_version: '1.1', status: 'Updated' },
      ])),
      ok(JSON.stringify([{ name: 'old', old_version: '1.0', new_version: '2.0', status: 'Updated' }])),
    );
    scriptScan(w); // the rescan at the end of the job

    const job = w.worker.enqueue(
      'wp.bulkTask',
      {
        siteId: site.id,
        ops: [
          { kind: 'plugin', slug: 'cf7', action: 'update' },
          { kind: 'plugin', slug: 'seo', action: 'update' },
          { kind: 'theme', slug: 'old', action: 'update' },
        ],
        backupFirst: false,
        healthCheck: false,
      },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    const lines = execLines(w);
    // One call for both plugins, one for the theme - not one per slug - as the site's administrator.
    expect(lines).toContain('wp plugin update cf7 seo --format=json --user=1');
    expect(lines).toContain('wp theme update old --format=json --user=1');
    const ops = resultOps(done);
    expect(ops).toHaveLength(3);
    expect(ops.find((o) => o.slug === 'cf7')).toMatchObject({ ok: true, from: '5.3.1', to: '6.0.1' });
    expect(ops.every((o) => o.ok)).toBe(true);
  });

  it('fails the job with per-op detail when wp-cli reports one item as an error', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);

    // Exit code 1 with a JSON body: most items fine, one errored. Reading the exit code
    // alone would throw the successes away.
    w.docker.execQueue.push(
      fail(
        'Error: Plugin update failed.',
        JSON.stringify([
          { name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' },
          { name: 'seo', old_version: '1.0', new_version: '', status: 'Error' },
        ]),
      ),
    );
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      {
        siteId: site.id,
        ops: [
          { kind: 'plugin', slug: 'cf7', action: 'update' },
          { kind: 'plugin', slug: 'seo', action: 'update' },
        ],
        backupFirst: false,
        healthCheck: false,
      },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('failed');
    expect(done.error).toContain('1 of 2 operations failed');
    const ops = resultOps(done);
    expect(ops.find((o) => o.slug === 'cf7')!.ok).toBe(true);
    expect(ops.find((o) => o.slug === 'seo')).toMatchObject({ ok: false, error: 'wp-cli reported "Error"' });
  });

  it('carries on after a failed operation instead of abandoning the rest', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);

    w.docker.execQueue.push(
      fail('Error: plugin not found'), // deactivate cf7 fails
      ok('Success: Activated 1 of 1 plugins.'), // activate seo still runs
    );
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      {
        siteId: site.id,
        ops: [
          { kind: 'plugin', slug: 'cf7', action: 'deactivate' },
          { kind: 'plugin', slug: 'seo', action: 'activate' },
        ],
        backupFirst: false,
        healthCheck: false,
      },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('failed');
    const ops = resultOps(done);
    expect(ops.find((o) => o.slug === 'cf7')!.ok).toBe(false);
    expect(ops.find((o) => o.slug === 'seo')!.ok).toBe(true);
  });

  it('deactivates a plugin before deleting it', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);
    w.docker.execQueue.push(ok('Success: Deactivated.'), ok('Success: Deleted.'));
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'seo', action: 'delete' }], backupFirst: false, healthCheck: false },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    await runJob(w, job.id);

    const lines = execLines(w);
    expect(lines.indexOf('wp plugin deactivate seo --user=1')).toBeGreaterThan(-1);
    expect(lines.indexOf('wp plugin deactivate seo --user=1')).toBeLessThan(lines.indexOf('wp plugin delete seo --user=1'));
  });

  it('takes a pre-update backup first and records its id', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = addRunningSite(w, 'blog', { files: true });
    await seedSnapshot(w, site);
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' }])));
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }], backupFirst: true, healthCheck: false },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    const row = w.db.select().from(backups).where(eq(backups.siteSlug, 'blog')).get()!;
    expect(row.type).toBe('pre_update');
    expect((JSON.parse(done.result!) as { backupId: number }).backupId).toBe(row.id);
  });

  it('fails when the site stops answering, and points at the backup to restore', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = addRunningSite(w, 'blog', { files: true });
    await seedSnapshot(w, site);
    await probeTarget(w, 500); // the site answers, but with a server error
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' }])));
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }], backupFirst: true, healthCheck: true },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/stopped answering/);
    const result = JSON.parse(done.result!) as { healthy: boolean; backupId: number; ops: WpBulkOpResult[] };
    expect(result.healthy).toBe(false);
    expect(result.backupId).toBeGreaterThan(0);
    // The update itself worked - the job fails because the site does not answer.
    expect(result.ops[0]!.ok).toBe(true);
    expect(done.error).toContain(`#${result.backupId}`);
  });

  it('succeeds when the health check passes', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);
    await probeTarget(w, 200);
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' }])));
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }], backupFirst: false, healthCheck: true },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    expect((JSON.parse(done.result!) as { healthy: boolean }).healthy).toBe(true);
  });

  it('refreshes the snapshot at the end, so the page shows the new versions', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);
    expect(w.core.wpInventory.statusFor(site).plugins.find((p) => p.slug === 'cf7')!.version).toBe('5.3.1');

    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' }])));
    // The rescan sees the updated version with no update pending any more.
    const updated = JSON.parse(PLUGIN_LIST).map((p: Record<string, unknown>) =>
      p.name === 'cf7' ? { ...p, version: '6.0.1', update: 'none', update_version: null } : p,
    );
    w.docker.execQueue.push(ok(JSON.stringify(updated)), ok(THEME_LIST), ok('6.8.2\n'), ok(''));

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }], backupFirst: false, healthCheck: false },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    await runJob(w, job.id);

    const after = w.core.wpInventory.statusFor(site);
    expect(after.plugins.find((p) => p.slug === 'cf7')).toMatchObject({ version: '6.0.1', updateVersion: null });
  });

  it('starts a stopped site, then stops it again', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);
    w.docker.containers.set(site.containerName, 'exited');
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '5.3.1', new_version: '6.0.1', status: 'Updated' }])));
    scriptScan(w);

    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }], backupFirst: false, healthCheck: false },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    expect(w.docker.calls.some((c) => c.method === 'startContainer')).toBe(true);
    expect(w.docker.calls.some((c) => c.method === 'stopContainer')).toBe(true);
    expect(await w.docker.containerState(site.containerName)).toBe('exited');
  });

  it('runs core last, after the plugins that may need updating for it', () => {
    const ops = sortOps([
      { kind: 'core', action: 'update' },
      { kind: 'theme', slug: 'b', action: 'update' },
      { kind: 'plugin', slug: 'z', action: 'update' },
      { kind: 'plugin', slug: 'a', action: 'update' },
    ]);
    expect(ops.map((o) => o.slug ?? 'core')).toEqual(['a', 'z', 'b', 'core']);
  });
});

describe('the older single-action jobs keep the snapshot current', () => {
  it('refreshes the inventory after a plugin task', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);
    expect(w.core.wpInventory.statusFor(site).plugins.find((p) => p.slug === 'seo')!.status).toBe('inactive');

    w.docker.execQueue.push(ok('Success: Plugin activated.'));
    // The rescan sees it active now.
    const activated = JSON.parse(PLUGIN_LIST).map((p: Record<string, unknown>) =>
      p.name === 'seo' ? { ...p, status: 'active' } : p,
    );
    w.docker.execQueue.push(ok(JSON.stringify(activated)), ok(THEME_LIST), ok('6.8.2\n'), ok(''));

    const job = w.worker.enqueue(
      'wp.pluginTask',
      { siteId: site.id, action: 'activate', name: 'seo', activate: true },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    // Without the rescan the page - which reads the snapshot, not the container - kept
    // offering "Activate" for a plugin that was already active.
    expect(w.core.wpInventory.statusFor(site).plugins.find((p) => p.slug === 'seo')!.status).toBe('active');
  });

  it('refreshes the inventory after a core update', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    await seedSnapshot(w, site);

    w.docker.execQueue.push(
      ok('6.8.2\n'), // version before
      ok('Success: WordPress updated successfully.'),
      ok('Success: WordPress database upgraded.'),
      ok('6.8.3\n'), // version after
    );
    w.docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.3\n'), ok(''));

    const job = w.worker.enqueue('wp.coreUpdate', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: 1 });
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    expect(w.core.wpInventory.statusFor(site).core.version).toBe('6.8.3');
  });
});

describe('WpBulkService.createBatch', () => {
  it('enqueues one job per site, all sharing the batch', async () => {
    const w = await makeWorld();
    const alpha = addRunningSite(w, 'alpha');
    const beta = addRunningSite(w, 'beta');
    await seedSnapshot(w, alpha);
    await seedSnapshot(w, beta);

    const { batch, jobs: created, skipped } = w.deps.wpBulk.createBatch(
      'update',
      [
        { siteSlug: 'alpha', kind: 'plugin', slug: 'cf7' },
        { siteSlug: 'beta', kind: 'plugin', slug: 'cf7' },
        // Selecting the aggregate and the site row must not run it twice.
        { siteSlug: 'beta', kind: 'plugin', slug: 'cf7' },
      ],
      { backupFirst: true, healthCheck: true },
    );

    expect(created).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(batch.totalJobs).toBe(2);
    expect(batch.targetCount).toBe(2);
    expect(created.every((j) => j.batchId === batch.id)).toBe(true);
    expect(created.map((j) => j.siteSlug).sort()).toEqual(['alpha', 'beta']);
    const payload = JSON.parse(created[0]!.payload) as { ops: unknown[]; backupFirst: boolean };
    expect(payload.ops).toHaveLength(1);
    expect(payload.backupFirst).toBe(true);
  });

  it('reports a busy site as skipped rather than dropping it silently', async () => {
    const w = await makeWorld();
    const alpha = addRunningSite(w, 'alpha');
    const beta = addRunningSite(w, 'beta');
    await seedSnapshot(w, alpha);
    await seedSnapshot(w, beta);
    // Beta is already busy with something else.
    w.worker.enqueue('site.restart', { siteId: beta.id }, { id: beta.id, slug: beta.slug, serverId: 1 });

    const { batch, jobs: created, skipped } = w.deps.wpBulk.createBatch(
      'update',
      [
        { siteSlug: 'alpha', kind: 'plugin', slug: 'cf7' },
        { siteSlug: 'beta', kind: 'plugin', slug: 'cf7' },
      ],
      { backupFirst: false, healthCheck: true },
    );

    expect(created).toHaveLength(1);
    expect(skipped).toEqual([{ siteSlug: 'beta', reason: expect.stringContaining('already has an active job') }]);
    // Persisted, so the batch view can list them after a page reload.
    const row = w.db.select().from(batches).where(eq(batches.id, batch.id)).get()!;
    expect(JSON.parse(row.skipped)).toHaveLength(1);
    expect(row.totalJobs).toBe(1);
  });

  it('rejects the whole request when any target cannot run the action', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'alpha');
    await seedSnapshot(w, site);

    // must-use plugins are never deletable...
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('delete', [{ siteSlug: 'alpha', kind: 'plugin', slug: 'ceo-login' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/Must-use/);
    // ...the active theme is not deletable...
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('delete', [{ siteSlug: 'alpha', kind: 'theme', slug: 'child' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/active theme/);
    // ...and neither is something with no update available updatable.
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('update', [{ siteSlug: 'alpha', kind: 'theme', slug: 'child' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/no update available/);
    // A slug that is not installed at all is a stale browser, not a silent no-op.
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('update', [{ siteSlug: 'alpha', kind: 'plugin', slug: 'ghost' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/is not installed/);
    // Nothing was queued by any of them.
    expect(w.db.select().from(jobs).all()).toHaveLength(0);
    expect(w.db.select().from(batches).all()).toHaveLength(0);
  });

  it('refuses a site that has never been scanned', async () => {
    const w = await makeWorld();
    addRunningSite(w, 'fresh');
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('update', [{ siteSlug: 'fresh', kind: 'plugin', slug: 'cf7' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/has not been scanned/);
  });

  it('refuses a core update on a site that is already current', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'alpha');
    await seedSnapshot(w, site); // no core update in the fixture
    expect(
      rejectionReasons(() =>
        w.deps.wpBulk.createBatch('core-update', [{ siteSlug: 'alpha', kind: 'core' }], {
          backupFirst: false,
          healthCheck: true,
        }),
      )[0],
    ).toMatch(/already up to date/);
  });

  it('spreads a batch across servers, one job per site', async () => {
    const w = await makeWorld();
    const second = w.addSshServer('worker-2');
    const local = addRunningSite(w, 'alpha');
    const remote = addRunningSite(w, 'beta', { serverId: second.id });
    await seedSnapshot(w, local);
    await seedSnapshot(w, remote);

    const { jobs: created } = w.deps.wpBulk.createBatch(
      'update',
      [
        { siteSlug: 'alpha', kind: 'plugin', slug: 'cf7' },
        { siteSlug: 'beta', kind: 'plugin', slug: 'cf7' },
      ],
      { backupFirst: false, healthCheck: false },
    );
    expect(created.map((j) => j.serverId).sort()).toEqual([1, second.id]);
  });

  it('cleans the snapshot up with the site, so a deleted site leaves nothing behind', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'alpha');
    await seedSnapshot(w, site);
    expect(w.db.select().from(siteWpComponents).all().length).toBeGreaterThan(0);

    w.db.delete(sites).where(eq(sites.id, site.id)).run();
    expect(w.db.select().from(siteWpComponents).all()).toHaveLength(0);
  });
});

describe("plugin and theme changes act as the site's administrator", () => {
  // WP-CLI runs a plugin's own code - an activation hook that makes whoever activated it the
  // plugin's owner, an uninstall routine that checks that user may - as nobody unless told who.
  const run = async (w: TestWorld, site: SiteRow, type: 'wp.pluginTask' | 'wp.themeTask', payload: Record<string, unknown>) => {
    const job = w.worker.enqueue(type, { siteId: site.id, ...payload }, { id: site.id, slug: site.slug, serverId: 1 });
    return runJob(w, job.id);
  };
  const logOf = (w: TestWorld, jobId: number) =>
    w.db.select({ message: jobLogs.message }).from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message);

  it('the one the panel created, while it is one - however many are older', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.db.update(sites).set({ wpAdminUser: 'boss' }).where(eq(sites.id, site.id)).run();
    w.docker.administrators = [
      { ID: 1, user_login: 'agency' },
      { ID: 7, user_login: 'boss' },
    ];
    const done = await run(w, site, 'wp.pluginTask', { action: 'install', source: { kind: 'wporg', slug: 'wordpress-seo' }, activate: true });
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(execLines(w)).toContain('wp plugin install wordpress-seo --activate --user=7');

    await run(w, site, 'wp.pluginTask', { action: 'deactivate', name: 'wordpress-seo', activate: false });
    expect(execLines(w)).toContain('wp plugin deactivate wordpress-seo --user=7');
  });

  it('the oldest administrator once the one the panel created is gone', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.db.update(sites).set({ wpAdminUser: 'boss' }).where(eq(sites.id, site.id)).run();
    w.docker.administrators = [
      { ID: 3, user_login: 'customer' },
      { ID: 9, user_login: 'someone-else' },
    ];
    const done = await run(w, site, 'wp.themeTask', { action: 'activate', name: 'twentytwentyfive' });
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(execLines(w)).toContain('wp theme activate twentytwentyfive --user=3');
  });

  it('nobody, with a word in the log, on a site without an administrator', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.docker.administrators = [];
    const done = await run(w, site, 'wp.pluginTask', { action: 'activate', name: 'seo', activate: true });
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(execLines(w)).toContain('wp plugin activate seo');
    expect(logOf(w, done.id).some((line) => line.includes('no administrator account'))).toBe(true);
  });
});
