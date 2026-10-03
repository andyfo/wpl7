import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import type { WpBulkOpResult } from '../../shared/types.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

/**
 * `wp.bulkTask` in policy mode - what an update schedule queues: which updates to apply is
 * decided from a scan taken when the job runs, not from a list written when it was queued.
 */

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

function addRunningSite(w: TestWorld, slug: string, opts: { files?: boolean } = {}): SiteRow {
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
  if (opts.files) {
    const p = sitePaths(w.config, slug);
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.mkdirSync(p.configDir, { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // wp');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.8.2';");
    fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  }
  return site;
}

const plugin = (name: string, update: boolean) => ({
  name,
  title: name,
  status: 'active',
  version: '1.0',
  update: update ? 'available' : 'none',
  update_version: update ? '1.1' : null,
  auto_update: 'off',
  file: `${name}/${name}.php`,
});
const theme = (name: string, update: boolean) => ({
  name,
  title: name,
  status: 'inactive',
  version: '1.0',
  update: update ? 'available' : 'none',
  update_version: update ? '2.0' : null,
  auto_update: 'off',
});

/** The four answers one inventory scan consumes. */
function scriptScan(w: TestWorld, opts: { plugins: object[]; themes: object[]; coreUpdate?: boolean }): void {
  w.docker.execQueue.push(
    ok(JSON.stringify(opts.plugins)),
    ok(JSON.stringify(opts.themes)),
    ok('6.8.2\n'),
    ok(opts.coreUpdate ? JSON.stringify([{ version: '6.9', update_type: 'minor' }]) : ''),
  );
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

function queuePolicy(w: TestWorld, site: SiteRow, policy: Record<string, boolean>, opts: { backupFirst?: boolean } = {}) {
  return w.worker.enqueue(
    'wp.bulkTask',
    {
      siteId: site.id,
      policy: { plugins: true, themes: true, core: false, onlyVulnerable: false, ...policy },
      backupFirst: opts.backupFirst ?? false,
      healthCheck: false,
    },
    { id: site.id, slug: site.slug, serverId: 1 },
  );
}

const execLines = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
const resultOf = (job: { result: string | null }) =>
  JSON.parse(job.result ?? '{}') as { ops: WpBulkOpResult[]; backupId: number | null; nothingToDo?: boolean };

describe('update policies (wp.bulkTask with a policy)', () => {
  it('scans first, then updates what the fresh scan says is out of date', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, { plugins: [plugin('cf7', true), plugin('seo', false)], themes: [theme('old', true)] });
    w.docker.execQueue.push(
      ok(JSON.stringify([{ name: 'cf7', old_version: '1.0', new_version: '1.1', status: 'Updated' }])),
      ok(JSON.stringify([{ name: 'old', old_version: '1.0', new_version: '2.0', status: 'Updated' }])),
    );
    scriptScan(w, { plugins: [plugin('cf7', false), plugin('seo', false)], themes: [theme('old', false)] });

    const done = await runJob(w, queuePolicy(w, site, {}).id);
    expect(done.status).toBe('succeeded');
    const lines = execLines(w);
    expect(lines).toContain('wp plugin update cf7 --format=json --user=1');
    expect(lines).toContain('wp theme update old --format=json --user=1');
    expect(resultOf(done).ops.map((o) => o.slug).sort()).toEqual(['cf7', 'old']);
  });

  it('only touches the kinds the policy covers', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, { plugins: [plugin('cf7', true)], themes: [theme('old', true)] });
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '1.0', new_version: '1.1', status: 'Updated' }])));
    scriptScan(w, { plugins: [plugin('cf7', false)], themes: [theme('old', true)] });

    const done = await runJob(w, queuePolicy(w, site, { themes: false }).id);
    expect(done.status).toBe('succeeded');
    expect(execLines(w).some((l) => l.startsWith('wp theme update'))).toBe(false);
  });

  it('succeeds without a backup when there is nothing to update', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog', { files: true });
    scriptScan(w, { plugins: [plugin('cf7', false)], themes: [theme('old', false)] });

    const done = await runJob(w, queuePolicy(w, site, {}, { backupFirst: true }).id);
    expect(done.status).toBe('succeeded');
    expect(resultOf(done)).toMatchObject({ ops: [], backupId: null, nothingToDo: true });
    expect(w.db.select().from(backups).all()).toHaveLength(0);
  });

  it('does not fail on a snapshot gone stale - WordPress updated the plugin itself meanwhile', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    // The stored snapshot still says cf7 has an update; by the time the job runs it has none.
    scriptScan(w, { plugins: [plugin('cf7', true)], themes: [] });
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1), { refreshFeed: false });
    scriptScan(w, { plugins: [plugin('cf7', false)], themes: [] });

    const done = await runJob(w, queuePolicy(w, site, {}).id);
    expect(done.status).toBe('succeeded');
    expect(execLines(w).some((l) => l.includes('plugin update'))).toBe(false);
  });

  it('with onlyVulnerable, leaves alone updates that fix nothing known', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, { plugins: [plugin('cf7', true)], themes: [] });

    const done = await runJob(w, queuePolicy(w, site, { onlyVulnerable: true }).id);
    expect(done.status).toBe('succeeded');
    expect(resultOf(done).nothingToDo).toBe(true);
    expect(execLines(w).some((l) => l.includes('plugin update'))).toBe(false);
  });

  it('keeps its pre-update backup as a scheduled one, so retention bounds it', async () => {
    // A real tar on the host, for the backup's files archive.
    const w = await makeWorld({ exec: hostExec });
    const site = addRunningSite(w, 'blog', { files: true });
    scriptScan(w, { plugins: [plugin('cf7', true)], themes: [] });
    w.docker.execQueue.push(ok(JSON.stringify([{ name: 'cf7', old_version: '1.0', new_version: '1.1', status: 'Updated' }])));
    scriptScan(w, { plugins: [plugin('cf7', false)], themes: [] });

    const done = await runJob(w, queuePolicy(w, site, {}, { backupFirst: true }).id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('succeeded');
    const backup = w.db.select().from(backups).where(eq(backups.siteSlug, 'blog')).get()!;
    expect(backup.type).toBe('scheduled');
    expect(resultOf(done).backupId).toBe(backup.id);
  });

  it('refuses a payload with both a list and a policy', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    const job = w.worker.enqueue(
      'wp.bulkTask',
      {
        siteId: site.id,
        ops: [{ kind: 'plugin', slug: 'cf7', action: 'update' }],
        policy: { plugins: true, themes: true, core: false, onlyVulnerable: false },
      },
      { id: site.id, slug: site.slug, serverId: 1 },
    );
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/give either/);
  });
});
