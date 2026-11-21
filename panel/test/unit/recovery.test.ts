import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupCopies, backups, jobs, moveCleanups, servers, sites, type SiteRow } from '../../src/db/schema.js';
import { fakeExecOk, FakeDnsProvider, makeApp, makeWorld, waitFor, type FakeServerPorts, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { externalWorld } from '../connectWorld.js';
import { autoFinalizeMoves } from '../../src/services/housekeeping.js';
import { alertStates } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import { panelSnapshot } from '../../src/jobs/handlers/offsite.js';
import { seed } from '../../src/db/seed.js';
import { createTestDb, makeTestConfig } from '../helpers.js';
import type { EphemeralOpts, RunResult } from '../../src/services/docker.js';
import {
  queueDeletedSiteRestore,
  queueServerRecovery,
  queueSiteRecovery,
  serverRecoveryReport,
  siteRecoveryReport,
} from '../../src/services/recovery.js';

function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runJob(w: TestWorld, jobId: number, timeoutMs = 30_000) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, timeoutMs);
  await w.worker.stop();
  const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  if (row.status === 'failed' && process.env.DEBUG_JOB_LOGS) {
    const { jobLogs } = await import('../../src/db/schema.js');
    for (const l of w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all()) console.log(`[job ${jobId}] ${l.level}: ${l.message}`);
  }
  return row;
}

async function logOf(w: TestWorld, jobId: number): Promise<string> {
  const { jobLogs } = await import('../../src/db/schema.js');
  return w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');
}

async function makeSite(w: TestWorld): Promise<SiteRow> {
  seedCoreFilesOnStart(w);
  const { site, job } = w.deps.sites.create({
    title: 'Bakery',
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  } as never);
  expect((await runJob(w, job.id)).status).toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
}

/** A server whose SSH does not answer until `down` is cleared. */
function switchableExec(): ExecPort & { down: boolean } {
  const fail = () => new Error('connect ETIMEDOUT 203.0.113.66:22');
  const exec = {
    down: true,
    async run(cmd: string, args: string[], opts?: Parameters<ExecPort['run']>[2]) {
      if (exec.down) throw fail();
      return fakeExecOk.run(cmd, args, opts);
    },
    async runWithInput(...args: Parameters<ExecPort['runWithInput']>) {
      if (exec.down) {
        args[2].resume();
        throw fail();
      }
      return fakeExecOk.runWithInput(...args);
    },
    async runToStream(...args: Parameters<ExecPort['runToStream']>) {
      if (exec.down) throw fail();
      return fakeExecOk.runToStream(...args);
    },
  };
  return exec;
}

/** A destination with a complete copy of `backupId`, whose files are in `remote`; `server` downloads from it. */
function offsiteCopy(w: TestWorld, backupId: number, remote: string, server: FakeServerPorts | null): number {
  const dest = w.offsite.create({
    name: 'bucket',
    provider: 's3',
    config: { accessKeyId: 'AKIA', region: 'eu-central-1', bucket: 'b', prefix: 'panel.example.com' },
    secrets: { secretAccessKey: 'sekrit' },
  });
  w.db
    .insert(backupCopies)
    .values({ backupId, destinationId: dest.id, status: 'complete', remotePath: 'b/panel.example.com/x', createdAt: Date.now() })
    .run();
  const docker = server?.docker ?? w.docker;
  const real = docker.runEphemeral.bind(docker);
  docker.runEphemeral = async (opts: EphemeralOpts): Promise<RunResult> => {
    const res = await real(opts);
    if (opts.cmd.join(' ').includes('rclone copy DEST:')) {
      const bind = opts.binds![0]!.split(':')[0]!;
      const into = server?.root ? path.join(server.root, path.relative(w.config.srvRoot, bind)) : bind;
      fs.cpSync(remote, into, { recursive: true });
    }
    return res;
  };
  return dest.id;
}

/**
 * A site that lived on a server that is gone now: its row and its backup's row point there, the
 * server does not answer, and nothing of it is left anywhere but the backup's offsite copy.
 */
async function siteOnLostServer(w: TestWorld, target: FakeServerPorts) {
  const site = await makeSite(w);
  const backup = await w.core.backup.create(site, 'scheduled', {});
  const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
  fs.cpSync(backup.path, remote, { recursive: true });
  const destinationId = offsiteCopy(w, backup.id, remote, target);
  const exec = switchableExec();
  const lost = w.addSshServer('lost', { exec, publicIp: '203.0.113.66' });
  w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, lost.id)).run();
  w.db.update(sites).set({ serverId: lost.id }).where(eq(sites.id, site.id)).run();
  w.db.update(backups).set({ serverId: lost.id }).where(eq(backups.id, backup.id)).run();
  // Nothing of it on server 1, which only stood in for the lost server while it was made.
  fs.rmSync(sitePaths(w.config, site.slug).root, { recursive: true, force: true });
  fs.rmSync(backup.path, { recursive: true, force: true });
  w.dbAdmin.databases.delete(site.dbName);
  w.docker.containers.delete(site.containerName);
  return { site: w.db.select().from(sites).where(eq(sites.id, site.id)).get()!, backup, destinationId, lost, exec };
}

describe('recovery', () => {
  it('brings a site back on another server from its offsite copy when its own does not answer', async () => {
    const dns = new FakeDnsProvider();
    dns.zones = ['dev.example.test'];
    const w = await makeWorld({ exec: hostExec, dnsProvider: dns });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.20' });
    const { site, backup, destinationId, lost } = await siteOnLostServer(w, s2);

    const report = await siteRecoveryReport(w.core, site);
    expect(report.state).toBe('unreachable');
    expect(report.refusal).toBeNull();
    expect(report.targets.map((t) => t.id)).toEqual([1, s2.id]);
    expect(report.backups[0]).toMatchObject({ id: backup.id, copies: [{ destinationId }] });

    const job = await queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: s2.id });
    expect(job.serverId).toBe(s2.id);
    expect(job.auxServerId).toBeNull();
    const done = await runJob(w, job.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('succeeded');

    const fresh = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(fresh.serverId).toBe(s2.id);
    expect(fresh.status).toBe('running');
    expect(fs.existsSync(path.join(s2.root!, 'sites', site.slug, 'wordpress', 'wp-config.php'))).toBe(true);
    expect(s2.dbAdmin.databases.has(site.dbName)).toBe(true);
    expect(s2.dbAdmin.users.get(site.dbUser)).toBe(site.dbPassword);
    expect(s2.docker.containers.get(site.containerName)).toBe('running');
    // The backup came down onto the target, and is a local backup there now.
    const fetched = w.db.select().from(backups).where(eq(backups.id, backup.id)).get()!;
    expect(fetched).toMatchObject({ serverId: s2.id, filesPresent: 1 });
    // The lost server is owed its handover.
    const cleanup = w.db.select().from(moveCleanups).all();
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ sourceServerId: lost.id, targetServerId: s2.id, status: 'pending', handover: 'pending' });
    expect(dns.records.get(site.devHostname!)).toBe('203.0.113.20');
    expect(await logOf(w, job.id)).toContain('"lost" does not answer');
  });

  it('stops the old copy once the lost server answers again, and keeps it a day from then', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.20' });
    const { site, backup, lost, exec } = await siteOnLostServer(w, s2);
    lost.docker.containers.set(site.containerName, 'running');
    const recovered = await queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: s2.id });
    expect((await runJob(w, recovered.id)).status).toBe('succeeded');

    // Too early for the nightly finalize: the old copy is not even stopped.
    w.db.update(moveCleanups).set({ createdAt: Date.now() - 48 * 3600_000 }).run();
    const resolvers = { resolve4: async () => ['203.0.113.20'], resolve6: async () => [] as string[] };
    expect(await autoFinalizeMoves(w.core, w.worker, w.core.log, resolvers)).toBe(0);

    exec.down = false;
    w.servers.markReachable(lost.id);
    const handover = w.db.select().from(jobs).where(eq(jobs.type, 'site.recoverHandover')).get()!;
    expect(handover.serverId).toBe(lost.id);
    expect((await runJob(w, handover.id)).status).toBe('succeeded');
    expect(lost.docker.containers.has(site.containerName)).toBe(false);
    const proxyFile = path.join(w.config.srvRoot, 'traefik', 'dynamic', `move-${site.slug}.yml`);
    expect(fs.readFileSync(proxyFile, 'utf8')).toContain('203.0.113.20');
    const cleanup = w.db.select().from(moveCleanups).get()!;
    expect(cleanup.handover).toBe('done');
    expect(cleanup.handedOverAt).not.toBeNull();

    // The day counts from the handover, not from the recovery two days ago.
    expect(await autoFinalizeMoves(w.core, w.worker, w.core.log, resolvers)).toBe(0);
    w.db.update(moveCleanups).set({ handedOverAt: Date.now() - 25 * 3600_000 }).run();
    expect(await autoFinalizeMoves(w.core, w.worker, w.core.log, resolvers)).toBe(1);
  });

  it('refuses a site that is still on its server, and one whose server answers', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const report = await siteRecoveryReport(w.core, site);
    expect(report.state).toBe('present');
    expect(report.refusal).toMatch(/still on "local".*Change server, or Restore/);
    const backup = await w.core.backup.create(site, 'manual', {});
    await expect(queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: 1 })).rejects.toThrow(/still on/);
  });

  it('brings a site back on its own server once it is gone from there, setting aside what was left', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const backup = await w.core.backup.create(site, 'manual', {});
    // A reinstalled server: no database, no container, and a WordPress folder a recreate seeded.
    w.dbAdmin.databases.delete(site.dbName);
    w.docker.containers.delete(site.containerName);
    const p = sitePaths(w.config, site.slug);
    fs.writeFileSync(path.join(p.wordpress, 'left-behind.txt'), 'was here');

    const report = await siteRecoveryReport(w.core, site);
    expect(report.state).toBe('missing');
    expect(report.targets[0]!.id).toBe(1);
    const job = await queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: 1 });
    const done = await runJob(w, job.id);
    expect(done.error).toBeNull();
    expect(w.dbAdmin.databases.has(site.dbName)).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    // What was there is kept a day beside the site, where the restore keeps what it replaces.
    const kept = fs.readdirSync(p.root).find((e) => e.startsWith('wordpress.pre-restore-'))!;
    expect(fs.readFileSync(path.join(p.root, kept, 'left-behind.txt'), 'utf8')).toBe('was here');
    expect(fs.readdirSync(w.config.paths.sites).some((e) => e.includes('.pre-recover-'))).toBe(false);
    expect(w.db.select().from(moveCleanups).all()).toHaveLength(0);
  });

  it('puts the set-aside folder back when the recovery fails, and changes nothing else', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const backup = await w.core.backup.create(site, 'manual', {});
    w.dbAdmin.databases.delete(site.dbName);
    w.docker.containers.delete(site.containerName);
    const p = sitePaths(w.config, site.slug);
    fs.writeFileSync(path.join(p.wordpress, 'left-behind.txt'), 'was here');
    const create = w.docker.createSiteContainer.bind(w.docker);
    w.docker.createSiteContainer = async (spec) => {
      if (spec.name === site.containerName) throw new Error('no space left on device');
      return create(spec);
    };

    const job = await queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: 1 });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(fs.readFileSync(path.join(p.wordpress, 'left-behind.txt'), 'utf8')).toBe('was here');
    expect(w.dbAdmin.databases.has(site.dbName)).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.serverId).toBe(1);
  });

  it('deletes a site whose server does not answer, and removes its copy once it does', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true });
    const { site, lost, exec } = await siteOnLostServer(w, s2);
    lost.dbAdmin.databases.add(site.dbName);
    lost.docker.containers.set(site.containerName, 'running');

    expect(() => w.deps.sites.delete(site.slug, true)).toThrow(/no final backup can be taken/);
    const job = w.deps.sites.delete(site.slug, false);
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.slug, site.slug)).get()).toBeUndefined();
    const cleanup = w.db.select().from(moveCleanups).get()!;
    expect(cleanup).toMatchObject({ sourceServerId: lost.id, targetServerId: 0, handover: 'pending', status: 'pending' });

    exec.down = false;
    w.servers.markReachable(lost.id);
    const handover = w.db.select().from(jobs).where(eq(jobs.type, 'site.recoverHandover')).get()!;
    expect((await runJob(w, handover.id)).status).toBe('succeeded');
    expect(lost.docker.containers.has(site.containerName)).toBe(false);
    expect(lost.dbAdmin.databases.has(site.dbName)).toBe(false);
    expect(w.db.select().from(moveCleanups).get()!.status).toBe('done');
  });

  it('recovers every site of a lost server in one go, and switches what it kept for sites hosted elsewhere', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.20' });
    const { site, lost } = await siteOnLostServer(w, s2);
    // A site hosted elsewhere whose backups the lost server kept.
    const { site: shop } = await externalWorld({ world: w });
    w.db.update(sites).set({ serverId: lost.id }).where(eq(sites.id, shop.id)).run();

    const report = await serverRecoveryReport(w.core, lost.id);
    expect(report.server.answers).toBe(false);
    expect(report.sites.map((r) => [r.slug, r.state, r.refusal])).toEqual([[site.slug, 'unreachable', null]]);
    expect(report.external.map((e) => e.slug)).toEqual(['shop']);
    expect(report.targets.map((t) => t.id)).toEqual([1, s2.id]);

    await expect(queueServerRecovery(w.core, lost.id, { targetServerId: lost.id })).rejects.toThrow(/"lost" is unreachable/);
    const result = await queueServerRecovery(w.core, lost.id, { targetServerId: s2.id });
    expect(result.skipped).toEqual([]);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.serverId).toBe(s2.id);
    expect(result.external).toEqual(['shop']);
    expect(w.db.select().from(sites).where(eq(sites.id, shop.id)).get()!.serverId).toBe(s2.id);
    expect((await runJob(w, result.jobs[0]!.id)).status).toBe('succeeded');
  });

  it('removes a lost server and keeps listing the backups that have an offsite copy', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.20' });
    const { site, backup, lost } = await siteOnLostServer(w, s2);
    // One more backup, kept only on the lost server.
    const onlyThere = w.db
      .insert(backups)
      .values({ siteSlug: site.slug, serverId: lost.id, type: 'manual', status: 'complete', path: '/srv/backups/x/1', createdAt: Date.now() })
      .returning()
      .get();
    // Its site was deleted elsewhere meanwhile: nothing keeps the server any more.
    w.db.delete(sites).where(eq(sites.id, site.id)).run();
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
    try {
      const refused = await app.inject({ method: 'DELETE', url: `/api/servers/${lost.id}`, headers });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/exist only on this server/);
      const removed = await app.inject({ method: 'DELETE', url: `/api/servers/${lost.id}?force=true`, headers });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ keptBackups: 1, droppedBackups: 1 });
    } finally {
      await app.close();
    }
    expect(w.db.select().from(backups).where(eq(backups.id, backup.id)).get()).toMatchObject({ serverId: 1, filesPresent: 0 });
    expect(w.db.select().from(backups).where(eq(backups.id, onlyThere.id)).get()).toBeUndefined();
    expect(w.db.select().from(backupCopies).where(eq(backupCopies.backupId, backup.id)).all()).toHaveLength(1);
  });

  it('makes a deleted site again from a backup kept only offsite', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const backup = await w.core.backup.create(site, 'final', {});
    const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
    fs.cpSync(backup.path, remote, { recursive: true });
    offsiteCopy(w, backup.id, remote, null);
    await w.core.backup.removeLocalFiles(backup);
    // Deleted: no row, no database, no container, no files. Its backup stays.
    w.db.delete(sites).where(eq(sites.id, site.id)).run();
    w.dbAdmin.databases.delete(site.dbName);
    w.dbAdmin.users.delete(site.dbUser);
    w.docker.containers.delete(site.containerName);
    fs.rmSync(sitePaths(w.config, site.slug).root, { recursive: true, force: true });

    const job = queueDeletedSiteRestore(w.core, backup.id, 1);
    expect(() => queueDeletedSiteRestore(w.core, backup.id, 1)).toThrow(/making "bakery" again already/);
    const done = await runJob(w, job.id);
    expect(done.error).toBeNull();
    const back = w.db.select().from(sites).where(eq(sites.slug, site.slug)).get()!;
    expect(back).toMatchObject({
      title: 'Bakery',
      domains: site.domains,
      devHostname: site.devHostname,
      dbName: site.dbName,
      status: 'running',
      serverId: 1,
      wpAdminEmail: 'boss@example.com',
    });
    expect(back.dbPassword).not.toBe(site.dbPassword);
    // Its own dev hostname is its own, not "another site's".
    expect(await logOf(w, job.id)).not.toContain("another site's now");
    expect(w.dbAdmin.databases.has(site.dbName)).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.siteId).toBe(back.id);
    expect(() => queueDeletedSiteRestore(w.core, backup.id, 1)).toThrow(/is a site already/);
  });

  it("gives a deleted site a dev address of its own when another site took all of the backup's", async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const backup = await w.core.backup.create(site, 'final', {});
    w.db.delete(sites).where(eq(sites.id, site.id)).run();
    w.dbAdmin.databases.delete(site.dbName);
    w.dbAdmin.users.delete(site.dbUser);
    w.docker.containers.delete(site.containerName);
    fs.rmSync(sitePaths(w.config, site.slug).root, { recursive: true, force: true });
    // Another site holds the old dev address now.
    w.db
      .insert(sites)
      .values({ ...site, id: undefined, slug: 'thief', containerName: 'wp-thief', dbName: 'wp_thief', dbUser: 'wp_thief', createdAt: Date.now(), updatedAt: Date.now() })
      .run();
    const { siteRowFromManifest } = await import('../../src/services/recovery.js');
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'manifest.json'), 'utf8'));
    const warnings: string[] = [];
    // Its old address taken, and the same name under the same dev domain with it: nothing to come back on.
    expect(() => siteRowFromManifest(w.core, site.slug, manifest, w.servers.rowById(1)!, () => undefined)).toThrow(/another site's now/);
    // On a server with a dev domain of its own, it gets an address there.
    const s2 = w.addSshServer('s2', { devDomain: 'dev2.example.test' });
    const row = siteRowFromManifest(w.core, site.slug, manifest, w.servers.rowById(s2.id)!, (m) => warnings.push(m));
    expect(JSON.parse(row.domains)).toEqual([`${site.slug}.dev2.example.test`]);
    expect(row.devHostname).toBe(`${site.slug}.dev2.example.test`);
    expect(warnings.join('\n')).toMatch(/another site's now/);
  });

  it('reads backups whose folder is gone as remote only, unless their whole backup root is', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const gone = await w.core.backup.create(site, 'manual', {});
    const kept = await w.core.backup.create(site, 'manual', {});
    fs.rmSync(gone.path, { recursive: true, force: true });
    expect(await w.core.backup.checkFiles(1)).toEqual({ gone: 1, back: 0 });
    expect(w.db.select().from(backups).where(eq(backups.id, gone.id)).get()!.filesPresent).toBe(0);
    expect(w.db.select().from(backups).where(eq(backups.id, kept.id)).get()!.filesPresent).toBe(1);

    // The folder returns (a disk mounted again): present again.
    fs.cpSync(kept.path, gone.path, { recursive: true });
    expect(await w.core.backup.checkFiles(1)).toEqual({ gone: 0, back: 1 });

    // A backup root that is not there at all says nothing about its backups.
    const elsewhere = path.join(w.config.srvRoot, 'not-mounted');
    w.db.update(backups).set({ rootPath: elsewhere, path: path.join(elsewhere, site.slug, 'x') }).where(eq(backups.id, kept.id)).run();
    expect(await w.core.backup.checkFiles(1)).toEqual({ gone: 0, back: 0 });
  });
});

describe('around a recovery', () => {
  it('emails once when an added server has not answered for ten minutes, and when it answers again', async () => {
    const w = await makeWorld();
    const sent: { subject: string; body: string }[] = [];
    w.core.settings.set('alertEmail', 'ops@example.com');
    w.core.mail.notifyOperator = async (subject: string, body: string) => {
      sent.push({ subject, body });
      return true;
    };
    const lost = w.addSshServer('lost');
    await w.core.alerts.serverChecked({ id: lost.id, name: 'lost' }, false, 'connect ETIMEDOUT');
    expect(sent).toHaveLength(0);
    w.db.update(alertStates).set({ since: Date.now() - 11 * 60_000 }).run();
    await w.core.alerts.serverChecked({ id: lost.id, name: 'lost' }, false, 'connect ETIMEDOUT');
    await w.core.alerts.serverChecked({ id: lost.id, name: 'lost' }, false, 'connect ETIMEDOUT');
    expect(sent.map((m) => m.subject)).toEqual(['lost does not answer']);
    expect(sent[0]!.body).toContain('Recover sites');

    // A site recovered elsewhere meanwhile: the email that it is back says its old copy goes.
    w.db
      .insert(moveCleanups)
      .values({
        siteId: 99,
        siteSlug: 'bakery',
        sourceServerId: lost.id,
        targetServerId: 1,
        containerName: 'wp-bakery',
        dbName: 'wp_bakery',
        dbUser: 'wp_bakery',
        filesPath: '/srv/sites/bakery',
        verifyHosts: '[]',
        targetIp: '203.0.113.1',
        status: 'pending',
        handover: 'pending',
        createdAt: Date.now(),
      })
      .run();
    await w.core.alerts.serverChecked({ id: lost.id, name: 'lost' }, true, null);
    expect(sent.map((m) => m.subject)).toEqual(['lost does not answer', 'lost answers again']);
    expect(sent[1]!.body).toMatch(/recovered on another server meanwhile: bakery/);
  });

  it("takes server 1's address from a changed SERVER_PUBLIC_IP, and keeps an edit while .env stays as it was", async () => {
    const db = createTestDb();
    await seed(db, makeTestConfig({ SERVER_PUBLIC_IP: '198.51.100.1' }));
    const ip = () => db.select().from(servers).where(eq(servers.id, 1)).get()!.publicIp;
    expect(ip()).toBe('198.51.100.1');
    db.update(servers).set({ publicIp: '198.51.100.9' }).where(eq(servers.id, 1)).run();
    await seed(db, makeTestConfig({ SERVER_PUBLIC_IP: '198.51.100.1' }));
    expect(ip()).toBe('198.51.100.9');
    // The panel database restored onto a machine whose setup.sh found another address.
    const result = await seed(db, makeTestConfig({ SERVER_PUBLIC_IP: '203.0.113.5' }));
    expect(ip()).toBe('203.0.113.5');
    expect(result.publicIpChanged).toEqual({ from: '198.51.100.9', to: '203.0.113.5' });
  });

  it('keeps what deploy/.env holds in the panel snapshot, for an install from it', async () => {
    const w = await makeWorld({
      exec: hostExec,
      env: { SMTP_RELAYHOST: '[smtp.example.com]:587', SMTP_USERNAME: 'relay', SMTP_PASSWORD: 'relay-secret', ACME_EMAIL: 'ops@example.com' },
    });
    fs.mkdirSync(path.join(w.config.srvRoot, 'mail'), { recursive: true });
    fs.writeFileSync(path.join(w.config.srvRoot, 'mail', 'relay.env'), 'POSTFIX_myhostname=mail.example.net\n');
    const job = w.worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 });
    await panelSnapshot(new JobContext(job.id, {}, w.db) as never, w.core);
    const row = w.db.select().from(backups).where(eq(backups.type, 'panel')).get()!;
    const manifest = JSON.parse(fs.readFileSync(path.join(row.path, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe(2);
    expect(typeof manifest.panelVersion).toBe('string');
    expect(manifest.env).toMatchObject({
      PANEL_DOMAIN: w.config.panelDomain,
      DEV_DOMAIN: w.config.devDomain,
      SMTP_RELAYHOST: '[smtp.example.com]:587',
      SMTP_USERNAME: 'relay',
      SMTP_PASSWORD: 'relay-secret',
      ACME_EMAIL: 'ops@example.com',
      MAIL_HOSTNAME: 'mail.example.net',
    });
  });

  it('refuses Finalize now while the old server has not answered since the site left it', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.20' });
    const { site, backup } = await siteOnLostServer(w, s2);
    const job = await queueSiteRecovery(w.core, site, { backupId: backup.id, targetServerId: s2.id });
    expect((await runJob(w, job.id)).status).toBe('succeeded');
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
    try {
      const detail = await app.inject({ method: 'GET', url: `/api/sites/${site.slug}`, headers });
      expect(detail.json().pendingMoveCleanup).toMatchObject({ sourceServerName: 'lost', handoverPending: true });
      const res = await app.inject({ method: 'POST', url: `/api/sites/${site.slug}/move/finalize`, headers });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/has not answered since the site left it/);
    } finally {
      await app.close();
    }
  });
});
