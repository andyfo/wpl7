import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { buildSiteContainerSpec, sitePaths, siteRuntimeFrom, siteTlsFor } from '../../src/services/siteSpec.js';
import { JobContext } from '../../src/jobs/context.js';
import { restoreSiteOnServer, type ProtectionHold } from '../../src/jobs/handlers/restoreSite.js';
import { siteDomains } from '../../src/jobs/handlers/shared.js';
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

/** A running site whose tables start with `prefix`, the way an imported one's do. */
function makeSite(w: TestWorld, prefix: string, slug = 'acme'): SiteRow {
  const row = w.db
    .insert(sites)
    .values({
      slug,
      title: 'Acme',
      domains: JSON.stringify([`${slug}.dev.example.test`]),
      devHostname: `${slug}.dev.example.test`,
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'pw',
      containerName: `wp-${slug}`,
      tablePrefix: prefix,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
  fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
  fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '7.1.2';");
  w.docker.containers.set(`wp-${slug}`, 'running');
  return row;
}

/** The table prefix the container was last created with. */
function prefixOfLastContainer(calls: { method: string; args: unknown[] }[], name: string): string | undefined {
  const created = calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as { name: string; env: Record<string, string> });
  return created.filter((spec) => spec.name === name).at(-1)?.env.WORDPRESS_TABLE_PREFIX;
}

describe('table prefix', () => {
  it('is wp_ for a new site and is what the container is given', async () => {
    const w = await makeWorld();
    const fresh = makeSite(w, 'wp_', 'plain');
    expect(w.db.select().from(sites).where(eq(sites.id, fresh.id)).get()!.tablePrefix).toBe('wp_');
    const spec = buildSiteContainerSpec(
      w.config,
      { ...fresh, tablePrefix: 'wpx_' },
      siteDomains(fresh),
      siteTlsFor(w.core.dns, w.servers.rowById(1)!),
      siteRuntimeFrom(w.core.settings),
    );
    expect(spec.env.WORDPRESS_TABLE_PREFIX).toBe('wpx_');
  });

  it("goes into a backup's manifest, and a move keeps it", async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w, 'wpx_');
    const backup = await w.core.backup.create(site, 'manual', {});
    expect(JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8')).tablePrefix).toBe('wpx_');

    const s2 = w.addSshServer('s2', { real: true });
    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.error).toBeNull();
    expect(prefixOfLastContainer(s2.docker.calls, site.containerName)).toBe('wpx_');
    const siteJson = JSON.parse(fs.readFileSync(path.join(s2.root!, 'sites', site.slug, 'site.json'), 'utf8'));
    expect(siteJson.tablePrefix).toBe('wpx_');
  });

  /** Restore `site` from a fresh backup of it, its manifest edited by `edit` first. */
  async function restoreFrom(w: TestWorld, site: SiteRow, edit: (manifest: Record<string, unknown>) => void = () => undefined) {
    const backup = await w.core.backup.create(site, 'manual', {});
    const manifestPath = path.join(backup.path, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    edit(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, {
      id: site.id,
      slug: site.slug,
      serverId: 1,
    });
    return runJob(w, job.id);
  }

  it('is kept by a restore', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w, 'wpx_');
    expect((await restoreFrom(w, site)).error).toBeNull();
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.tablePrefix).toBe('wpx_');
    // Nothing to change, so the container is left as it was.
    expect(prefixOfLastContainer(w.docker.calls, site.containerName)).toBeUndefined();
  });

  it("follows a restored backup whose tables are named differently", async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w, 'wp_');
    // A backup of an earlier site under the same name, whose tables were named differently.
    expect((await restoreFrom(w, site, (m) => (m.tablePrefix = 'old_'))).error).toBeNull();
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.tablePrefix).toBe('old_');
    expect(prefixOfLastContainer(w.docker.calls, site.containerName)).toBe('old_');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });

  it('ignores a prefix in a manifest that is not one', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w, 'wp_');
    expect((await restoreFrom(w, site, (m) => (m.tablePrefix = "x'; DROP"))).error).toBeNull();
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.tablePrefix).toBe('wp_');
  });
});

describe('restoreSiteOnServer from a staged tree', () => {
  /** A site row with nothing of it on the server yet, and its WordPress folder laid out in staging. */
  function staged(w: TestWorld) {
    const now = Date.now();
    const site = w.db
      .insert(sites)
      .values({
        slug: 'moved-in',
        title: 'Moved in',
        domains: JSON.stringify(['moved-in.dev.example.test']),
        devHostname: 'moved-in.dev.example.test',
        phpVersion: '8.3',
        status: 'provisioning',
        dbName: 'wp_moved_in',
        dbUser: 'wp_moved_in',
        dbPassword: 'site-pw',
        mailPassword: 'mail-pw',
        containerName: 'wp-moved-in',
        tablePrefix: 'mi_',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const staging = path.join(w.config.srvRoot, 'wpl7-import', '1');
    fs.mkdirSync(path.join(staging, 'wordpress', 'wp-content'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'wordpress', 'index.php'), '<?php // old host');
    fs.writeFileSync(path.join(staging, 'db.sql.gz'), 'dump');
    return { site, staging };
  }

  it('moves the files into place, imports as the site user and leaves the router off', async () => {
    const w = await makeWorld();
    const { site, staging } = staged(w);
    const ctx = new JobContext(w.worker.enqueue('demo', {}).id, {}, w.db);
    const protection: ProtectionHold = { release: null };
    await restoreSiteOnServer(
      ctx,
      w.core,
      w.servers.handleFor(1),
      site,
      siteDomains(site),
      { kind: 'tree', wordpressDir: path.join(staging, 'wordpress'), dbSqlGz: path.join(staging, 'db.sql.gz') },
      { routing: false, requireWpConfig: false, protection, probe: null },
    );
    const p = sitePaths(w.config, site.slug);
    expect(fs.readFileSync(path.join(p.wordpress, 'index.php'), 'utf8')).toBe('<?php // old host');
    expect(fs.existsSync(path.join(staging, 'wordpress'))).toBe(false);
    expect(w.dbAdmin.calls.find((c) => c.method === 'importFromAs')?.args).toEqual([
      path.join(staging, 'db.sql.gz'),
      'wp_moved_in',
      'wp_moved_in',
      'site-pw',
    ]);
    expect(w.dbAdmin.calls.some((c) => c.method === 'importFrom')).toBe(false);
    const spec = w.docker.calls.find((c) => c.method === 'createSiteContainer')!.args[0] as {
      labels: Record<string, string>;
      env: Record<string, string>;
    };
    expect(spec.labels['traefik.enable']).toBe('false');
    expect(spec.env.WORDPRESS_TABLE_PREFIX).toBe('mi_');
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(protection.release).not.toBeNull();
    protection.release?.();
  });

  it('puts the files back in staging when a later step fails', async () => {
    const w = await makeWorld();
    const { site, staging } = staged(w);
    w.docker.failAfter.set('createSiteContainer', 'network attach failed');
    const ctx = new JobContext(w.worker.enqueue('demo', {}).id, {}, w.db);
    const protection: ProtectionHold = { release: null };
    await expect(
      restoreSiteOnServer(
        ctx,
        w.core,
        w.servers.handleFor(1),
        site,
        siteDomains(site),
        { kind: 'tree', wordpressDir: path.join(staging, 'wordpress'), dbSqlGz: path.join(staging, 'db.sql.gz') },
        { routing: false, requireWpConfig: false, protection, probe: null },
      ),
    ).rejects.toThrow(/network attach failed/);
    expect(await ctx.runCompensations()).toBe(true);
    protection.release?.();

    expect(fs.readFileSync(path.join(staging, 'wordpress', 'index.php'), 'utf8')).toBe('<?php // old host');
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(false);
    expect(w.dbAdmin.calls.some((c) => c.method === 'dropSiteDb')).toBe(true);
    expect(w.docker.containers.has(site.containerName)).toBe(false);
  });
});
