import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, jobs, moveCleanups, sites } from '../../src/db/schema.js';
import { FakeDnsProvider, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { hostExec } from '../../src/lib/exec.js';
import { autoFinalizeMoves } from '../../src/services/housekeeping.js';

function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const slug = name.slice(3);
    const p = sitePaths(w.config, slug);
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runJob(w: TestWorld, jobId: number, timeoutMs = 20_000) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, timeoutMs);
  await w.worker.stop();
  const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  if (row.status === 'failed' && process.env.DEBUG_JOB_LOGS) {
    const { jobLogs } = await import('../../src/db/schema.js');
    for (const l of w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all()) {
      console.log(`[job ${jobId}] ${l.level}: ${l.message}`);
    }
  }
  return row;
}

async function makeSiteOnServer1(w: TestWorld) {
  seedCoreFilesOnStart(w);
  const { site, job } = w.deps.sites.create({
    title: 'Mover',
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  } as never);
  const done = await runJob(w, job.id);
  expect(done.status).toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
}

describe('site.move', () => {
  it('moves a dev site: files travel, row flips, source is cleaned, DNS record flips', async () => {
    const dns = new FakeDnsProvider();
    dns.zones = ['dev.example.test'];
    const w = await makeWorld({ exec: hostExec, dnsProvider: dns });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });
    const sourceRules = path.join(w.config.srvRoot, 'traefik', 'dynamic', `sec-${site.slug}.yml`);
    const targetRules = path.join(s2.root!, 'traefik', 'dynamic', `sec-${site.slug}.yml`);
    expect(fs.existsSync(sourceRules)).toBe(true);
    let startedProtected: boolean | null = null;
    s2.docker.onStart = (name) => {
      if (name === site.containerName && startedProtected === null) startedProtected = fs.existsSync(targetRules);
    };

    // Something in quarantine: it goes along, though it is in no backup.
    const quarantined = path.join(w.config.paths.sites, site.slug, 'quarantine', '1-abc.quarantined');
    fs.mkdirSync(path.dirname(quarantined), { recursive: true });
    fs.writeFileSync(quarantined, '<?php evil();');

    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    expect(job.serverId).toBe(1);
    expect(job.auxServerId).toBe(s2.id);
    const done = await runJob(w, job.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('succeeded');
    await w.core.security.idle();
    expect(fs.readFileSync(path.join(s2.root!, 'sites', site.slug, 'quarantine', '1-abc.quarantined'), 'utf8')).toBe('<?php evil();');

    // Its protection moved with it: on the target before the site started there, and gone
    // from the source, whose forwarding is not the site any more.
    expect(startedProtected).toBe(true);
    expect(fs.existsSync(targetRules)).toBe(true);
    expect(fs.existsSync(sourceRules)).toBe(false);

    // Row flipped; hostname unchanged.
    const fresh = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(fresh.serverId).toBe(s2.id);
    expect(fresh.devHostname).toBe(site.devHostname);

    // Files really extracted on the target root.
    const targetWp = path.join(s2.root!, 'sites', site.slug, 'wordpress', 'wp-config.php');
    expect(fs.existsSync(targetWp)).toBe(true);

    // Target container created with the site's hostnames and started.
    const createCall = s2.docker.calls.find((c) => c.method === 'createSiteContainer')!;
    const spec = createCall.args[0] as { labels: Record<string, string> };
    expect(spec.labels[`traefik.http.routers.wp-${site.slug}.rule`]).toContain(site.devHostname!);
    expect(s2.docker.containers.get(site.containerName)).toBe('running');
    expect(s2.dbAdmin.calls.some((c) => c.method === 'createSiteDb')).toBe(true);
    expect(s2.dbAdmin.calls.some((c) => c.method === 'importFrom')).toBe(true);

    // Source container removed; files + db stay parked until DNS has verifiably moved -
    // dev sites included (resolvers cache the old answer after the record change).
    expect(w.docker.calls.some((c) => c.method === 'removeContainer' && c.args[0] === site.containerName)).toBe(true);
    expect(w.dbAdmin.calls.some((c) => c.method === 'dropSiteDb')).toBe(false);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(true);
    const cleanup = w.db.select().from(moveCleanups).all();
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]!.status).toBe('pending');
    expect(JSON.parse(cleanup[0]!.verifyHosts)).toEqual([site.devHostname]);
    // The old server forwards the dev hostname meanwhile.
    const proxyFile = path.join(w.config.srvRoot, 'traefik', 'dynamic', `move-${site.slug}.yml`);
    expect(fs.readFileSync(proxyFile, 'utf8')).toContain(site.devHostname!);

    // Once DNS answers only with the target (and the move is old enough), the daily check finalizes.
    w.db.update(moveCleanups).set({ createdAt: Date.now() - 25 * 3600_000 }).run();
    await autoFinalizeMoves(w.core, w.worker, w.core.log, { resolve4: async () => ['203.0.113.9'], resolve6: async () => [] });
    const fin = w.db.select().from(jobs).where(eq(jobs.type, 'site.moveFinalize')).get()!;
    expect((await runJob(w, fin.id)).status).toBe('succeeded');
    expect(w.dbAdmin.calls.some((c) => c.method === 'dropSiteDb')).toBe(true);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(false);
    expect(fs.existsSync(proxyFile)).toBe(false);
    expect(w.db.select().from(moveCleanups).all()[0]!.status).toBe('done');

    // Snapshot on source + staged copy on target, both type 'move'.
    const rows = w.db.select().from(backups).where(eq(backups.siteSlug, site.slug)).all();
    const moveRows = rows.filter((b) => b.type === 'move');
    expect(moveRows.map((b) => b.serverId).sort()).toEqual([1, s2.id].sort());

    // DNS record flipped to the target IP (explicit record beats the wildcard).
    expect(dns.records.get(site.devHostname!)).toBe('203.0.113.9');
  });

  it('live site: keeps a pending cleanup, writes the forwarding config, lists manual DNS', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    // Simulate an earlier go-live: custom primary + dev alias.
    w.db
      .update(sites)
      .set({ domains: JSON.stringify(['customer.example.com', site.devHostname]), isLive: 1 })
      .where(eq(sites.id, site.id))
      .run();
    const s2 = w.addSshServer('s2', { real: true, publicIp: '203.0.113.9' });

    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');

    // Maintenance freeze happened on the source, cleared on the target.
    const srcExecs = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    expect(srcExecs.some((c) => c.includes('maintenance-mode activate'))).toBe(true);
    const tgtExecs = s2.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    expect(tgtExecs.some((c) => c.includes('maintenance-mode deactivate'))).toBe(true);

    // Source container removed, but files/db stay parked (deferred decommission).
    expect(w.docker.calls.some((c) => c.method === 'removeContainer' && c.args[0] === site.containerName)).toBe(true);
    expect(w.dbAdmin.calls.some((c) => c.method === 'dropSiteDb')).toBe(false);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(true);

    const cleanup = w.db.select().from(moveCleanups).all()[0]!;
    expect(cleanup.status).toBe('pending');
    expect(JSON.parse(cleanup.verifyHosts)).toEqual(['customer.example.com', site.devHostname]);

    // Forwarding config written on the source for the custom host.
    const proxyFile = path.join(w.config.srvRoot, 'traefik', 'dynamic', `move-${site.slug}.yml`);
    expect(fs.existsSync(proxyFile)).toBe(true);
    const yaml = fs.readFileSync(proxyFile, 'utf8');
    expect(yaml).toContain('customer.example.com');
    expect(yaml).toContain('203.0.113.9');

    // No DNS provider configured => the custom host lands on the manual list.
    const result = JSON.parse(done.result!) as { dns: { manual: { host: string }[] } };
    expect(result.dns.manual.map((m) => m.host)).toContain('customer.example.com');

    // Finalize tears the parked copy down and removes the proxy file.
    const fin = w.deps.worker.enqueue(
      'site.moveFinalize',
      { cleanupId: cleanup.id },
      { id: site.id, slug: site.slug, serverId: 1 },
      { serverId: 1 },
    );
    const finDone = await runJob(w, fin.id);
    expect(finDone.status).toBe('succeeded');
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(false);
    expect(fs.existsSync(proxyFile)).toBe(false);
    expect(w.db.select().from(moveCleanups).all()[0]!.status).toBe('done');
  });

  it('rolls the target back and resumes the source when a target step fails', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2', { real: true });
    s2.dbAdmin.failOn.set('createSiteDb', 'target db exploded');

    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('failed');

    // Site untouched on the source.
    const fresh = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(fresh.serverId).toBe(1);
    expect(fs.existsSync(sitePaths(w.config, site.slug).root)).toBe(true);
    // Target artifacts rolled back.
    expect(fs.existsSync(path.join(s2.root!, 'sites', site.slug))).toBe(false);
    expect(fs.existsSync(path.join(s2.root!, 'backups', site.slug))).toBe(true); // dir may remain
    expect(fs.readdirSync(path.join(s2.root!, 'backups', site.slug))).toEqual([]);
    // No staged backup row survived; only the source snapshot remains.
    const rows = w.db.select().from(backups).where(eq(backups.type, 'move')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.serverId).toBe(1);
    expect(w.db.select().from(moveCleanups).all()).toHaveLength(0);
  });

  it('takes its rules off the target again when the move fails there', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2', { real: true });
    const targetRules = path.join(s2.root!, 'traefik', 'dynamic', `sec-${site.slug}.yml`);
    // Past the point where the target got the site's rules, before the cutover.
    s2.docker.failAfter.set('createSiteContainer', 'target container exploded');

    const done = await runJob(w, (w.deps.sites.move(site.slug, { targetServerId: s2.id })).id);
    expect(done.status).toBe('failed');
    await w.core.security.idle();
    expect(fs.existsSync(targetRules)).toBe(false);
    // The source keeps serving, protected.
    expect(fs.existsSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', `sec-${site.slug}.yml`))).toBe(true);
  });

  it('preflight removes leftovers of a previous failed attempt on the target', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2', { real: true });
    // Simulate garbage from a crashed earlier attempt.
    s2.docker.containers.set(site.containerName, 'exited');
    fs.mkdirSync(path.join(s2.root!, 'sites', site.slug, 'wordpress'), { recursive: true });
    fs.mkdirSync(path.join(s2.root!, 'backups', site.slug, 'staging-old'), { recursive: true });

    const job = w.deps.sites.move(site.slug, { targetServerId: s2.id });
    const done = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');
    expect(fs.existsSync(path.join(s2.root!, 'backups', site.slug, 'staging-old'))).toBe(false);
    const removals = s2.docker.calls.filter((c) => c.method === 'removeContainer');
    expect(removals.length).toBeGreaterThanOrEqual(1);
  });

  it('validates move requests', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2');

    expect(() => w.deps.sites.move(site.slug, { targetServerId: 1 })).toThrow(/already on that server/);
    expect(() => w.deps.sites.move(site.slug, { targetServerId: 999 })).toThrow(/not found/);

    w.db.update(sites).set({ status: 'error' }).where(eq(sites.id, site.id)).run();
    expect(() => w.deps.sites.move(site.slug, { targetServerId: s2.id })).toThrow(/only running or stopped/);
    w.db.update(sites).set({ status: 'running' }).where(eq(sites.id, site.id)).run();

    w.db
      .insert(moveCleanups)
      .values({
        siteId: site.id,
        siteSlug: site.slug,
        sourceServerId: 1,
        targetServerId: s2.id,
        containerName: site.containerName,
        dbName: site.dbName,
        dbUser: site.dbUser,
        filesPath: sitePaths(w.config, site.slug).root,
        verifyHosts: '[]',
        targetIp: '203.0.113.9',
        status: 'pending',
        createdAt: Date.now(),
      })
      .run();
    expect(() => w.deps.sites.move(site.slug, { targetServerId: s2.id })).toThrow(/awaiting cleanup/);
  });

  it('auto-finalizes only when DNS points at the target and the move is old enough', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSiteOnServer1(w);
    const s2 = w.addSshServer('s2', { publicIp: '203.0.113.9' });
    const insert = (createdAt: number) =>
      w.db
        .insert(moveCleanups)
        .values({
          siteId: site.id,
          siteSlug: site.slug,
          sourceServerId: 1,
          targetServerId: s2.id,
          containerName: site.containerName,
          dbName: site.dbName,
          dbUser: site.dbUser,
          filesPath: sitePaths(w.config, site.slug).root,
          verifyHosts: JSON.stringify(['customer.example.com']),
          targetIp: '203.0.113.9',
          status: 'pending',
          createdAt,
        })
        .returning()
        .get();

    // Too fresh: no job even though DNS matches.
    const freshRow = insert(Date.now());
    let resolved: string[] = ['203.0.113.9'];
    const finalize = () =>
      autoFinalizeMoves(w.core, w.worker, w.core.log, { resolve4: async () => resolved, resolve6: async () => [] });
    await finalize();
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.moveFinalize')).all()).toHaveLength(0);
    w.db.delete(moveCleanups).where(eq(moveCleanups.id, freshRow.id)).run();

    // Old enough but DNS still points elsewhere: no job.
    const oldRow = insert(Date.now() - 25 * 3600_000);
    resolved = ['198.51.100.1'];
    await finalize();
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.moveFinalize')).all()).toHaveLength(0);

    // Old enough + DNS on target: finalize queued.
    resolved = ['203.0.113.9'];
    await finalize();
    const queued = w.db.select().from(jobs).where(eq(jobs.type, 'site.moveFinalize')).all();
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.payload)).toEqual({ cleanupId: oldRow.id });
  });
});
