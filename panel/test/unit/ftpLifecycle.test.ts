import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobLogs, jobs, servers, siteFtp, siteFtpUsers, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { FTP_GATEWAY_CONTAINER, ftpFileServerContainer } from '../../src/services/ftpConfig.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

/**
 * What a restore, a move and a delete do to a site's FTP: its file server is gone before the
 * files are swapped, copied or removed, and comes back - on the right server - afterwards.
 */

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');

async function ftpWorld(): Promise<TestWorld> {
  const w = await makeWorld({ exec: hostExec });
  w.db.update(servers).set({ publicIp: '203.0.113.10' }).where(eq(servers.id, 1)).run();
  return w;
}

/** A site with real files on server 1, its container running. */
function makeSite(w: TestWorld, slug: string): SiteRow {
  const row = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.dev.example.test`]),
      devHostname: `${slug}.dev.example.test`,
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'pw',
      containerName: `wp-${slug}`,
      mailPassword: 'relay-pw',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // wp');
  fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
  fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9.1';");
  fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  w.docker.containers.set(row.containerName, 'running');
  return row;
}

async function withLogin(w: TestWorld, site: SiteRow, username: string): Promise<void> {
  await w.core.ftp.createUser(site, { username, folder: '', expiresAt: null }, null);
  await w.core.ftp.idle();
  expect(w.docker.containers.get(ftpFileServerContainer(site.slug))).toBe('running');
}

const ftpCalls = (calls: { method: string; args: unknown[] }[]) =>
  calls.filter((c) => JSON.stringify(c.args).includes('wpl7-ftp') || c.method === 'ensureServiceContainer');

describe('FTP through a restore', () => {
  it('is stopped while the folder is swapped, and serves the restored one after', async () => {
    const w = await ftpWorld();
    const site = makeSite(w, 'alpha');
    await withLogin(w, site, 'alpha');
    const backup = await w.core.backup.create(site, 'manual', {});
    const before = w.docker.serviceSpecs.get(ftpFileServerContainer('alpha'))!.hash;

    let runningDuringSwap: boolean | null = null;
    const restoreFiles = w.core.backup.restoreFiles.bind(w.core.backup);
    w.core.backup.restoreFiles = async (...args) => {
      runningDuringSwap = w.docker.containers.has(ftpFileServerContainer('alpha'));
      return restoreFiles(...args);
    };
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, {
      id: site.id,
      slug: site.slug,
      serverId: 1,
    });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');
    expect(runningDuringSwap).toBe(false);
    expect(logOf(w, job.id)).toContain('FTP/SFTP paused until the restore is over');

    await w.core.ftp.idle();
    expect(w.docker.containers.get(ftpFileServerContainer('alpha'))).toBe('running');
    // A new container: the one before had the folder the restore set aside.
    expect(w.docker.serviceSpecs.get(ftpFileServerContainer('alpha'))!.hash).not.toBe(before);
    expect(w.core.ftp.isPaused(site.id)).toBe(false);
  });

  it('leaves the site untouched when FTP cannot be paused', async () => {
    const w = await ftpWorld();
    const site = makeSite(w, 'alpha');
    await withLogin(w, site, 'alpha');
    const backup = await w.core.backup.create(site, 'manual', {});
    w.docker.failOn.set('removeContainer', 'docker is not answering');
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, {
      id: site.id,
      slug: site.slug,
      serverId: 1,
    });
    expect((await runJob(w, job.id)).status).toBe('failed');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
    expect(logOf(w, job.id)).toContain('Nothing was changed');
    expect(w.core.ftp.isPaused(site.id)).toBe(false);
  });

  it('comes back after a restore that failed, too', async () => {
    const w = await ftpWorld();
    const site = makeSite(w, 'alpha');
    await withLogin(w, site, 'alpha');
    const backup = await w.core.backup.create(site, 'manual', {});
    w.dbAdmin.failOn.set('recreateDb', 'database gone');
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, {
      id: site.id,
      slug: site.slug,
      serverId: 1,
    });
    expect((await runJob(w, job.id)).status).toBe('failed');
    await w.core.ftp.idle();
    expect(w.core.ftp.isPaused(site.id)).toBe(false);
    expect(w.docker.containers.get(ftpFileServerContainer('alpha'))).toBe('running');
  });
});

describe('FTP through a move', () => {
  function seedCoreFilesOnStart(w: TestWorld): void {
    w.docker.onStart = (name) => {
      if (!name.startsWith('wp-')) return;
      const p = sitePaths(w.config, name.slice(3));
      fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
      fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
      fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
    };
  }

  async function createdSite(w: TestWorld): Promise<SiteRow> {
    seedCoreFilesOnStart(w);
    const { site, job } = w.deps.sites.create({
      title: 'Mover',
      domainMode: 'dev',
      adminUser: 'boss',
      adminEmail: 'boss@example.com',
      plugins: { catalogIds: [], extraWporgSlugs: [] },
    } as never);
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    return w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
  }

  it('stops before the snapshot, and ends up on the target server only', async () => {
    const w = await ftpWorld();
    const site = await createdSite(w);
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    await withLogin(w, site, 'mover');

    let runningAtSnapshot: boolean | null = null;
    const dumpTo = w.dbAdmin.dumpTo.bind(w.dbAdmin);
    w.dbAdmin.dumpTo = async (db, dest) => {
      runningAtSnapshot = w.docker.containers.has(ftpFileServerContainer(site.slug));
      return dumpTo(db, dest);
    };
    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');
    expect(runningAtSnapshot).toBe(false);
    await w.core.ftp.idle();

    // The old server has no logins left: nothing FTP remains there.
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    expect(w.docker.containers.has(ftpFileServerContainer(site.slug))).toBe(false);
    // The new one serves the site's login, from the site's files there.
    expect(s2.docker.containers.get(FTP_GATEWAY_CONTAINER)).toBe('running');
    expect(s2.docker.containers.get(ftpFileServerContainer(site.slug))).toBe('running');
    const users = JSON.parse(fs.readFileSync(path.join(s2.root!, 'wpl7-ftp', 'gateway', 'users.json'), 'utf8')).users;
    expect(users.map((u: { username: string }) => u.username)).toEqual(['mover']);
    const view = w.core.ftp.siteView(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!);
    expect(view.serverName).toBe('s2');
    expect(view.endpoint.host).toBe('203.0.113.9');
  });

  it('comes back on the old server when the move is rolled back', async () => {
    const w = await ftpWorld();
    const site = await createdSite(w);
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    await withLogin(w, site, 'mover');
    s2.dbAdmin.failOn.set('importFrom', 'import failed');
    const done = await runJob(w, w.deps.sites.move(site.slug, { targetServerId: s2.id }).id);
    expect(done.status).toBe('failed');
    await w.core.ftp.idle();
    expect(w.docker.containers.get(ftpFileServerContainer(site.slug))).toBe('running');
    expect(ftpCalls(s2.docker.calls)).toEqual([]);
  });
});

describe('FTP through a delete', () => {
  it("removes the file server before the site's files, then the logins, then the gateway", async () => {
    const w = await ftpWorld();
    const site = makeSite(w, 'alpha');
    await withLogin(w, site, 'alpha');

    const files = w.servers.handleFor(1).files;
    let runningAtRm: boolean | null = null;
    const rm = files.rm.bind(files);
    files.rm = async (p: string) => {
      if (p === sitePaths(w.config, 'alpha').root) runningAtRm = w.docker.containers.has(ftpFileServerContainer('alpha'));
      return rm(p);
    };
    const done = await runJob(w, w.deps.sites.delete('alpha', false).id);
    expect(done.status).toBe('succeeded');
    expect(runningAtRm).toBe(false);
    expect(w.db.select().from(siteFtpUsers).all()).toEqual([]);
    expect(w.db.select().from(siteFtp).all()).toEqual([]);
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    expect(fs.existsSync(path.join(w.config.srvRoot, 'wpl7-ftp'))).toBe(false);
  });

  it('leaves a site without logins exactly as it was', async () => {
    const w = await ftpWorld();
    makeSite(w, 'alpha');
    const done = await runJob(w, w.deps.sites.delete('alpha', false).id);
    expect(done.status).toBe('succeeded');
    expect(ftpCalls(w.docker.calls)).toEqual([]);
  });
});
