/**
 * A site's other databases (site_databases) go wherever the site goes: into its backups, back out
 * of them on a restore, along on a move - and away with the site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, moveCleanups, siteDatabases, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

function makeSite(w: TestWorld, slug = 'demo'): SiteRow {
  const row = w.db
    .insert(sites)
    .values({
      slug,
      title: 'Demo',
      domains: JSON.stringify([`${slug}.dev.example.test`]),
      devHostname: `${slug}.dev.example.test`,
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'pw',
      containerName: `wp-${slug}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
  fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9.1';");
  fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  w.docker.containers.set(row.containerName, 'running');
  w.dbAdmin.databases.add(row.dbName);
  return row;
}

function addExtra(w: TestWorld, site: SiteRow, name: string): void {
  w.db.insert(siteDatabases).values({ siteId: site.id, name, createdAt: Date.now() }).run();
  w.dbAdmin.databases.add(name);
}

const restore = (w: TestWorld, site: SiteRow, backupId: number) =>
  w.worker.enqueue('backup.restore', { backupId, skipPreRestoreBackup: true }, { id: site.id, slug: site.slug, serverId: 1 });

describe("a site's other databases", () => {
  it('are in its backups: a dump each, in the manifest and the checksums', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    const backup = await w.core.backup.create(site, 'manual');
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dumpTo').map((c) => c.args[0])).toEqual(['wp_demo', 'demo_crm']);
    expect(fs.existsSync(path.join(backup.path, 'databases', 'demo_crm.sql.gz'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8'));
    expect(manifest.databases).toEqual(['demo_crm']);
    expect(fs.readFileSync(path.join(backup.path, 'sha256sums'), 'utf8')).toContain('  databases/demo_crm.sql.gz');
    await expect(w.core.backup.verifyChecksums(backup)).resolves.toBeUndefined();
    const extraBytes = fs.statSync(path.join(backup.path, 'databases', 'demo_crm.sql.gz')).size;
    expect(backup.sizeBytes!).toBeGreaterThan(extraBytes);
  });

  it('are left out of a backup, with a warning, when one is not on the server', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    addExtra(w, site, 'demo_gone');
    // Dropped by the site's own user, out of sight of the panel.
    w.dbAdmin.databases.delete('demo_gone');
    const lines: string[] = [];
    const backup = await w.core.backup.create(site, 'manual', { log: (level, message) => lines.push(`${level} ${message}`) });
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dumpTo').map((c) => c.args[0])).toEqual(['wp_demo', 'demo_crm']);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8'));
    expect(manifest.databases).toEqual(['demo_crm']);
    expect(lines).toContain('warn Database demo_gone is not on the server; this backup leaves it out.');
    await expect(w.core.backup.verifyChecksums(backup)).resolves.toBeUndefined();
  });

  it('come back on a restore: replaced when the site has them, made again when deleted since', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    addExtra(w, site, 'demo_logs');
    const backup = await w.core.backup.create(site, 'manual');
    // demo_logs is deleted after the backup; demo_new is added and is not in it.
    w.db.delete(siteDatabases).where(eq(siteDatabases.name, 'demo_logs')).run();
    w.dbAdmin.databases.delete('demo_logs');
    addExtra(w, site, 'demo_new');
    w.dbAdmin.calls = [];

    const done = await runJob(w, restore(w, site, backup.id).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const calls = w.dbAdmin.calls.map((c) => `${c.method} ${c.args.slice(0, 2).join(' ')}`);
    expect(calls).toContain('recreateDb demo_crm');
    expect(calls).toContain(`importFrom ${path.join(backup.path, 'databases', 'demo_crm.sql.gz')} demo_crm`);
    expect(calls).toContain('createExtraDb demo_logs wp_demo');
    expect(calls).toContain(`importFrom ${path.join(backup.path, 'databases', 'demo_logs.sql.gz')} demo_logs`);
    expect(calls.some((c) => c.includes('demo_new'))).toBe(false);
    expect(w.db.select().from(siteDatabases).all().map((d) => d.name).sort()).toEqual(['demo_crm', 'demo_logs', 'demo_new']);
  });

  it('stop a restore before it changes anything when a name went to another site', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const other = makeSite(w, 'other');
    addExtra(w, site, 'shared_name');
    const backup = await w.core.backup.create(site, 'manual');
    w.db.delete(siteDatabases).where(eq(siteDatabases.name, 'shared_name')).run();
    w.db.insert(siteDatabases).values({ siteId: other.id, name: 'shared_name', createdAt: Date.now() }).run();

    const done = await runJob(w, restore(w, site, backup.id).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/shared_name is another site's now/);
    expect(w.docker.calls.some((c) => c.method === 'stopContainer')).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
  });

  it('go with the site when it is deleted', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    const job = w.worker.enqueue('site.delete', { siteId: site.id, finalBackup: false, deleteBackups: false }, site);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.dbAdmin.calls).toContainEqual({ method: 'dropDb', args: ['demo_crm'] });
    expect(w.dbAdmin.databases.has('demo_crm')).toBe(false);
    expect(w.db.select().from(siteDatabases).all()).toEqual([]);
  });

  it('move with the site, and leave the old server when the move is finalized', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    // The target's site container starts with its files in place, as WordPress's would.
    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(s2.dbAdmin.calls.map((c) => `${c.method} ${c.args[0]}`)).toEqual(
      expect.arrayContaining(['createSiteDb wp_demo', 'createExtraDb demo_crm']),
    );
    expect(s2.dbAdmin.calls.find((c) => c.method === 'createExtraDb')!.args).toEqual(['demo_crm', 'wp_demo']);
    expect(s2.dbAdmin.calls.filter((c) => c.method === 'importFrom').map((c) => c.args[1])).toEqual(['wp_demo', 'demo_crm']);
    // Parked on the source until the move is finalized, then dropped there.
    expect(w.dbAdmin.databases.has('demo_crm')).toBe(true);
    const cleanup = w.db.select().from(moveCleanups).get()!;
    expect(JSON.parse(cleanup.extraDbs!)).toEqual(['demo_crm']);
    const fin = w.worker.enqueue('site.moveFinalize', { cleanupId: cleanup.id }, { id: site.id, slug: site.slug, serverId: 1 }, { serverId: 1 });
    expect((await runJob(w, fin.id)).status).toBe('succeeded');
    expect(w.dbAdmin.calls).toContainEqual({ method: 'dropDb', args: ['demo_crm'] });
  });

  it('stop a move before anything changes when the target already has the name', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addExtra(w, site, 'demo_crm');
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    s2.dbAdmin.databases.add('demo_crm');
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: s2.id }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/already has a database called demo_crm/);
    expect(s2.dbAdmin.calls.some((c) => c.method === 'createSiteDb')).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.serverId).toBe(1);
  });
});
