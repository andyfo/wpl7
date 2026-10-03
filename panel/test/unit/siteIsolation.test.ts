import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobLogs, jobs, sites } from '../../src/db/schema.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { limitsChange, sitePaths, type SiteRuntime } from '../../src/services/siteSpec.js';
import { Schedulers } from '../../src/jobs/schedulers.js';
import { ServerUnreachableError } from '../../src/servers/sshConnection.js';
import type { JobDto } from '../../shared/types.js';
import {
  bindToMount,
  DockerService,
  SITE_CAP_DROP,
  SITE_SECURITY_OPT,
  type SiteContainerSpec,
} from '../../src/services/docker.js';
import {
  EGRESS_NETWORK,
  ensureSiteNetwork,
  reconcileSiteNetworks,
  removeSiteNetwork,
  siteNetworkName,
} from '../../src/services/siteNetwork.js';

/** Simulate the wordpress image entrypoint: seed core files once the container starts. */
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

async function runJob(w: TestWorld, jobId: number): Promise<{ status: string; error: string | null }> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  return { status: row.status, error: row.error };
}

const baseBody = {
  title: 'Demo Site',
  domainMode: 'dev' as const,
  adminUser: 'boss',
  adminEmail: 'boss@example.com',
  plugins: { catalogIds: [], extraWporgSlugs: [] },
};

async function createSite(w: TestWorld, body = baseBody) {
  seedCoreFilesOnStart(w);
  const { site, job } = w.deps.sites.create(body);
  const done = await runJob(w, job.id);
  expect(done.status).toBe('succeeded');
  return site;
}

const specs = (w: TestWorld): SiteContainerSpec[] =>
  w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as SiteContainerSpec);

describe('site container isolation', () => {
  it('confines a new site to its own network plus the shared egress one', async () => {
    const w = await makeWorld();
    await createSite(w);

    const spec = specs(w).at(-1)!;
    expect(spec.networks).toEqual([siteNetworkName('demo-site'), EGRESS_NETWORK]);
    // The flat networks are what one compromised site used to reach every other site and
    // the panel; membership of them is the regression this guards.
    expect(spec.networks).not.toContain('wpl7_proxy');
    expect(spec.networks).not.toContain('wpl7_db');

    const site = await w.docker.inspectNetwork(siteNetworkName('demo-site'));
    expect(site!.internal).toBe(true);
    expect(site!.containers).toEqual(expect.arrayContaining(['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb']));

    const egress = await w.docker.inspectNetwork(EGRESS_NETWORK);
    expect(egress!.internal).toBe(false);
    // Without this the shared network would hand back the lateral reach the per-site
    // networks just removed.
    expect(egress!.options['com.docker.network.bridge.enable_icc']).toBe('false');
  });

  it('never puts two sites on the same network', async () => {
    const w = await makeWorld();
    await createSite(w);
    w.docker.calls.length = 0;
    await createSite(w, { ...baseBody, title: 'Second Site' });

    const second = specs(w).at(-1)!;
    expect(second.networks).toEqual([siteNetworkName('second-site'), EGRESS_NETWORK]);
    const shared = second.networks.filter((n) => n !== EGRESS_NETWORK && n === siteNetworkName('demo-site'));
    expect(shared).toEqual([]);
  });

  it('sizes a new site container from the settings', async () => {
    const w = await makeWorld();
    await createSite(w);

    const spec = specs(w).at(-1)!;
    expect(spec.memoryBytes).toBe(512 * 1024 * 1024);
    expect(spec.nanoCpus).toBe(2 * 1e9);
    expect(spec.pidsLimit).toBe(512);
  });

  it('hands Docker the hardened HostConfig', async () => {
    // Straight at DockerService: capability drops and security options are applied there,
    // not carried in the spec, so this is the only place the wire format can be checked.
    const created: { HostConfig: Record<string, unknown>; NetworkingConfig: unknown }[] = [];
    const connected: { network: string; container: string }[] = [];
    const fakeDockerode = {
      createContainer: async (opts: { HostConfig: Record<string, unknown>; NetworkingConfig: unknown }) => {
        created.push(opts);
        return { id: 'abc123' };
      },
      getNetwork: (network: string) => ({
        connect: async ({ Container }: { Container: string }) => {
          connected.push({ network, container: Container });
        },
      }),
    };
    const docker = new DockerService('wpl7_proxy', 'wpl7_db', fakeDockerode as never);
    await docker.createSiteContainer({
      name: 'wp-demo',
      image: 'wpl7-wordpress:php8.3',
      env: {},
      labels: {},
      binds: [],
      networks: ['wpl7_site_demo', EGRESS_NETWORK],
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 1.5e9,
      pidsLimit: 256,
    });

    const host = created[0]!.HostConfig;
    // NET_RAW is the one with teeth: it is what lets root in a compromised container forge
    // packets and poison ARP caches on the bridges it shares with the stack.
    expect(host.CapDrop).toContain('NET_RAW');
    expect(host.CapDrop).toEqual(SITE_CAP_DROP);
    expect(host.SecurityOpt).toEqual(SITE_SECURITY_OPT);
    expect(host.SecurityOpt).toContain('no-new-privileges:true');
    expect(host.PidsLimit).toBe(256);
    expect(host.NanoCpus).toBe(1.5e9);
    expect(host.Memory).toBe(256 * 1024 * 1024);
    // First network at creation, the rest connected before start - Docker accepts only one.
    expect(created[0]!.NetworkingConfig).toEqual({ EndpointsConfig: { wpl7_site_demo: {} } });
    expect(connected).toEqual([{ network: EGRESS_NETWORK, container: 'abc123' }]);
  });

  it('sends bind mounts as Mounts, so a missing source fails the create instead of becoming a directory', async () => {
    const created: { HostConfig: Record<string, unknown> }[] = [];
    const docker = new DockerService('wpl7_proxy', 'wpl7_db', {
      createContainer: async (opts: { HostConfig: Record<string, unknown> }) => {
        created.push(opts);
        return { id: 'x' };
      },
      getNetwork: () => ({ connect: async () => undefined }),
    } as never);
    await docker.createSiteContainer({
      name: 'wp-demo',
      image: 'i',
      env: {},
      labels: {},
      binds: ['/srv/sites/demo/wordpress:/var/www/html', '/srv/sites/demo/config/msmtprc:/etc/msmtprc:ro'],
      networks: ['wpl7_site_demo'],
      memoryBytes: 512 * 1024 * 1024,
    });
    // Binds is the `-v` form, which invents a directory for a missing source; Mounts refuses.
    expect(created[0]!.HostConfig.Binds).toBeUndefined();
    expect(created[0]!.HostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/srv/sites/demo/wordpress', Target: '/var/www/html', ReadOnly: false },
      { Type: 'bind', Source: '/srv/sites/demo/config/msmtprc', Target: '/etc/msmtprc', ReadOnly: true },
    ]);
  });

  it('refuses a bind it cannot parse rather than guessing', () => {
    expect(bindToMount('/a:/b')).toEqual({ Type: 'bind', Source: '/a', Target: '/b', ReadOnly: false });
    expect(bindToMount('/a:/b:ro')).toEqual({ Type: 'bind', Source: '/a', Target: '/b', ReadOnly: true });
    expect(() => bindToMount('/a')).toThrow(/Unparseable/);
    // Silently dropping an option would quietly widen a read-only mount to read-write.
    expect(() => bindToMount('/a:/b:rw')).toThrow(/Unsupported bind mount option/);
    expect(() => bindToMount('/a:/b:ro:z')).toThrow(/Unparseable/);
  });

  it('leaves out limits that are configured as uncapped', async () => {
    const created: { HostConfig: Record<string, unknown> }[] = [];
    const docker = new DockerService('wpl7_proxy', 'wpl7_db', {
      createContainer: async (opts: { HostConfig: Record<string, unknown> }) => {
        created.push(opts);
        return { id: 'x' };
      },
      getNetwork: () => ({ connect: async () => undefined }),
    } as never);
    await docker.createSiteContainer({
      name: 'wp-demo',
      image: 'i',
      env: {},
      labels: {},
      binds: [],
      networks: ['wpl7_site_demo'],
      memoryBytes: 512 * 1024 * 1024,
    });
    expect(created[0]!.HostConfig.NanoCpus).toBeUndefined();
    expect(created[0]!.HostConfig.PidsLimit).toBeUndefined();
    // Hardening is not optional, so it is applied even when every limit is off.
    expect(created[0]!.HostConfig.CapDrop).toEqual(SITE_CAP_DROP);
  });

  it('applies changed limits to the next container it builds', async () => {
    const w = await makeWorld();
    await createSite(w);
    w.deps.settings.update({ siteCpuLimit: 0.5, siteMemoryLimitMb: 1024, sitePidsLimit: 0 });

    const job = w.deps.sites.reconcile('demo-site');
    expect((await runJob(w, job.id)).status).toBe('succeeded');

    const spec = specs(w).at(-1)!;
    expect(spec.nanoCpus).toBe(0.5 * 1e9);
    expect(spec.memoryBytes).toBe(1024 * 1024 * 1024);
    // 0 means uncapped, which must come through as "no limit" rather than a limit of zero.
    expect(spec.pidsLimit).toBeUndefined();
  });

  it('gives the site container its own relay credential on disk', async () => {
    const w = await makeWorld();
    const site = await createSite(w);

    const p = sitePaths(w.config, 'demo-site');
    const spec = specs(w).at(-1)!;
    expect(spec.binds).toContain(`${p.msmtprc}:/etc/msmtprc:ro`);

    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    const msmtprc = fs.readFileSync(p.msmtprc, 'utf8');
    expect(msmtprc).toContain('user demo-site@wpl7');
    expect(msmtprc).toContain(`password ${row.mailPassword}`);
    expect(row.mailPassword).toBeTruthy();
  });

  it('removes the site network when the site is deleted', async () => {
    const w = await makeWorld();
    await createSite(w);
    expect(await w.docker.inspectNetwork(siteNetworkName('demo-site'))).not.toBeNull();

    const job = w.deps.sites.delete('demo-site', false);
    expect((await runJob(w, job.id)).status).toBe('succeeded');

    expect(await w.docker.inspectNetwork(siteNetworkName('demo-site'))).toBeNull();
  });

  it('re-attaches the stack to site networks after a compose redeploy drops them', async () => {
    const w = await makeWorld();
    await createSite(w);
    const network = siteNetworkName('demo-site');

    // What `docker compose up -d` does to Traefik: a new container, with only the networks
    // compose knows about - which does not include any site network.
    for (const c of ['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb']) {
      await w.docker.disconnectContainer(network, c);
    }
    expect((await w.docker.inspectNetwork(network))!.containers).not.toContain('wpl7-traefik');

    const { repaired } = await reconcileSiteNetworks(w.docker);
    expect(repaired).toBe(3);
    expect((await w.docker.inspectNetwork(network))!.containers).toEqual(
      expect.arrayContaining(['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb']),
    );

    // Second pass is a no-op: the reconciler must not thrash endpoints every minute.
    expect((await reconcileSiteNetworks(w.docker)).repaired).toBe(0);
  });

  it('routes through the site network label so Traefik picks the right endpoint', async () => {
    const w = await makeWorld();
    await createSite(w);
    const published = specs(w).at(-1)!;
    // Traefik is attached to many networks; without this it can pick the egress one, where
    // container-to-container traffic is dropped, and every request 502s.
    expect(published.labels['traefik.docker.network']).toBe(siteNetworkName('demo-site'));
    // The unrouted install container has no router at all, so it needs no network hint.
    expect(specs(w)[0]!.labels['traefik.docker.network']).toBeUndefined();
  });

  it('puts the site back on its network when the network has to be rebuilt', async () => {
    const w = await makeWorld();
    await createSite(w);
    const network = siteNetworkName('demo-site');

    // A network that predates the isolation policy: same name, but not internal. Rebuilding
    // it must not leave the running site container stranded off its own network.
    await w.docker.removeNetwork(network);
    await w.docker.ensureNetwork({ name: network, internal: false });
    await w.docker.connectContainer(network, 'wp-demo-site');

    await ensureSiteNetwork(w.docker, 'demo-site');

    const info = (await w.docker.inspectNetwork(network))!;
    expect(info.internal).toBe(true);
    expect(info.containers).toContain('wp-demo-site');
    expect(info.containers).toEqual(expect.arrayContaining(['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb']));
  });

  it('detaches members before removing a network Docker would otherwise refuse to drop', async () => {
    const w = await makeWorld();
    await createSite(w);
    const network = siteNetworkName('demo-site');

    await removeSiteNetwork(w.docker, network.replace('wpl7_site_', ''));
    const disconnects = w.docker.calls.filter((c) => c.method === 'disconnectContainer');
    const removes = w.docker.calls.filter((c) => c.method === 'removeNetwork');
    expect(disconnects.length).toBeGreaterThan(0);
    expect(w.docker.calls.indexOf(disconnects[0]!)).toBeLessThan(w.docker.calls.indexOf(removes.at(-1)!));
  });
});

describe('site.reconcile', () => {
  it('brings a site created under the old flat topology up to policy', async () => {
    const w = await makeWorld();
    const site = await createSite(w);

    // Wind the site back to what an upgrade finds: no credential, no network, and a
    // container that was built without either.
    w.db.update(sites).set({ mailPassword: null }).where(eq(sites.id, site.id)).run();
    await removeSiteNetwork(w.docker, 'demo-site');
    fs.rmSync(sitePaths(w.config, 'demo-site').msmtprc, { force: true });
    w.docker.calls.length = 0;

    const job = w.deps.sites.reconcile('demo-site');
    expect((await runJob(w, job.id)).status).toBe('succeeded');

    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(row.mailPassword).toBeTruthy();
    expect(fs.readFileSync(sitePaths(w.config, 'demo-site').msmtprc, 'utf8')).toContain('user demo-site@wpl7');
    const network = await w.docker.inspectNetwork(siteNetworkName('demo-site'));
    expect(network!.containers).toEqual(expect.arrayContaining(['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb']));
    expect(specs(w).at(-1)!.networks).toEqual([siteNetworkName('demo-site'), EGRESS_NETWORK]);
  });

  it('leaves a running site running', async () => {
    const w = await makeWorld();
    await createSite(w);
    expect(await w.docker.containerState('wp-demo-site')).toBe('running');

    const job = w.deps.sites.reconcile('demo-site');
    expect((await runJob(w, job.id)).status).toBe('succeeded');

    expect(await w.docker.containerState('wp-demo-site')).toBe('running');
    expect(w.db.select().from(sites).where(eq(sites.slug, 'demo-site')).get()!.status).toBe('running');
  });
});

const MB = 1024 * 1024;

/** Run the queue until nothing is left in it - including jobs queued by the ones running. */
async function runAll(w: TestWorld): Promise<void> {
  w.worker.start();
  await waitFor(() => w.db.select().from(jobs).all().every((j) => j.status !== 'queued' && j.status !== 'running'), 15_000);
  await w.worker.stop();
}

const jobRow = (w: TestWorld, id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;

/** PUT /api/settings as a signed-in admin. */
async function settingsApi(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  return async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
    expect(res.statusCode).toBe(200);
    return res.json() as { jobs: JobDto[] };
  };
}

const LIFECYCLE = ['createSiteContainer', 'removeContainer', 'startContainer', 'stopContainer', 'restartContainer'];

describe('changed container limits', () => {
  it('reach the sites that already exist, in place, when saved in Settings', async () => {
    const w = await makeWorld();
    await createSite(w);
    await createSite(w, { ...baseBody, title: 'Second Site' });
    // Stopped on purpose: it gets the new limits for when it next starts, and stays stopped.
    await w.docker.stopContainer('wp-second-site');
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.slug, 'second-site')).run();
    const put = await settingsApi(w);
    w.docker.calls.length = 0;

    const { jobs: queued } = await put({ siteCpuLimit: 1, siteMemoryLimitMb: 1024, sitePidsLimit: 0 });
    expect(queued.map((j) => j.type)).toEqual(['server.applySiteLimits']);
    await runAll(w);

    expect(jobRow(w, queued[0]!.id).status).toBe('succeeded');
    expect(w.docker.limits.get('wp-demo-site')).toEqual({ memoryBytes: 1024 * MB, nanoCpus: 1e9 });
    expect(w.docker.limits.get('wp-second-site')).toEqual({ memoryBytes: 1024 * MB, nanoCpus: 1e9 });
    // No site went down for it: nothing was rebuilt, stopped or restarted.
    expect(w.docker.calls.filter((c) => LIFECYCLE.includes(c.method))).toEqual([]);
    expect(await w.docker.containerState('wp-demo-site')).toBe('running');
    expect(await w.docker.containerState('wp-second-site')).toBe('exited');
  });

  it('queue nothing when no limit changed', async () => {
    const w = await makeWorld();
    await createSite(w);
    const put = await settingsApi(w);
    const before = w.db.select().from(jobs).all().length;

    expect((await put({ backupRetention: 5 })).jobs).toEqual([]);
    // The values they already have are not a change either.
    expect((await put({ siteCpuLimit: 2, siteMemoryLimitMb: 512 })).jobs).toEqual([]);
    expect(w.db.select().from(jobs).all()).toHaveLength(before);
  });

  it('take a CPU cap off by recreating the container, the one change Docker cannot make in place', async () => {
    const w = await makeWorld();
    await createSite(w);
    const put = await settingsApi(w);
    w.docker.calls.length = 0;

    await put({ siteCpuLimit: 0 });
    await runAll(w);

    const reconciles = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all();
    expect(reconciles.map((j) => j.status)).toEqual(['succeeded']);
    expect(specs(w).at(-1)!.nanoCpus).toBeUndefined();
    expect(w.docker.limits.get('wp-demo-site')).toEqual({ memoryBytes: 512 * MB, pidsLimit: 512 });
    // An in-place update first would have "succeeded" and left the cap where it was.
    expect(w.docker.calls.filter((c) => c.method === 'updateContainerLimits')).toEqual([]);
  });

  it('lift a CPU cap after the job a site already had waiting, instead of giving up on it', async () => {
    const w = await makeWorld();
    await createSite(w);
    const put = await settingsApi(w);
    const schedulers = new Schedulers(w.core, w.worker);

    const { jobs: queued } = await put({ siteCpuLimit: 0 });
    // Queued behind the limits pass, in the same lane - so while the pass runs, the site
    // already has a job and cannot be given the reconcile that lifts its cap.
    const restart = w.deps.sites.action('demo-site', 'restart');
    await runAll(w);

    expect(jobRow(w, restart.id).status).toBe('succeeded');
    expect(jobRow(w, queued[0]!.id).status).toBe('succeeded');
    expect(w.docker.limits.get('wp-demo-site')!.nanoCpus).toBe(2e9);

    // Saving 0 again is no change, so it is the scheduler that has to come back for it.
    await schedulers.siteLimitsTick();
    await runAll(w);
    expect(w.docker.limits.get('wp-demo-site')).toEqual({ memoryBytes: 512 * MB, pidsLimit: 512 });

    // Done, so the next tick has nothing to queue.
    const count = w.db.select().from(jobs).all().length;
    await schedulers.siteLimitsTick();
    expect(w.db.select().from(jobs).all()).toHaveLength(count);
    schedulers.stop();
  });

  it('wait for a deferred site to be free before coming back for it', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const put = await settingsApi(w);
    const schedulers = new Schedulers(w.core, w.worker);
    const passes = () => w.db.select().from(jobs).where(eq(jobs.type, 'server.applySiteLimits')).all();
    const finished = (id: number) => !['queued', 'running'].includes(jobRow(w, id).status);

    const { jobs: queued } = await put({ siteCpuLimit: 0 });
    const restart = w.deps.sites.action('demo-site', 'restart');
    // A Web FTP save in progress: the restart cannot start, while the pass - which is not a
    // job of the site's own - can. Coming back for the site now would find it just as busy.
    const release = w.worker.holdSite(site, new Set(['site.restart']));
    w.worker.start();
    await waitFor(() => finished(queued[0]!.id), 15_000);

    await schedulers.siteLimitsTick();
    expect(passes()).toHaveLength(1);
    expect(jobRow(w, restart.id).status).toBe('queued');

    release();
    await waitFor(() => finished(restart.id), 15_000);
    await schedulers.siteLimitsTick();
    expect(passes()).toHaveLength(2);
    await waitFor(() => w.db.select().from(jobs).all().every((j) => finished(j.id)), 15_000);
    await w.worker.stop();

    expect(w.docker.limits.get('wp-demo-site')!.nanoCpus).toBeUndefined();
    schedulers.stop();
  });

  it('give each server with sites a job of its own, which a second save reuses while it waits', async () => {
    const w = await makeWorld();
    await createSite(w);
    const web2 = w.addSshServer('web-2');
    const now = Date.now();
    w.db
      .insert(sites)
      .values({
        slug: 'far-site',
        title: 'Far Site',
        domains: JSON.stringify(['far-site.test']),
        phpVersion: '8.3',
        status: 'running',
        dbName: 'far_site',
        dbUser: 'far_site',
        dbPassword: 'x',
        containerName: 'wp-far-site',
        serverId: web2.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    web2.docker.containers.set('wp-far-site', 'running');
    web2.docker.limits.set('wp-far-site', { memoryBytes: 512 * MB, nanoCpus: 2e9, pidsLimit: 512 });
    // No sites, so nothing to apply there.
    w.addSshServer('web-3');
    const put = await settingsApi(w);

    const first = await put({ siteMemoryLimitMb: 1024 });
    expect(first.jobs.map((j) => jobRow(w, j.id).serverId).sort()).toEqual([1, web2.id].sort());
    // Those jobs read the settings when they start, so they carry this save too.
    const second = await put({ siteMemoryLimitMb: 2048 });
    expect(second.jobs.map((j) => j.id).sort()).toEqual(first.jobs.map((j) => j.id).sort());
    await runAll(w);

    expect(w.docker.limits.get('wp-demo-site')!.memoryBytes).toBe(2048 * MB);
    expect(web2.docker.limits.get('wp-far-site')!.memoryBytes).toBe(2048 * MB);
  });

  it('fail loudly, naming the sites that kept their previous limits', async () => {
    const w = await makeWorld();
    await createSite(w);
    const put = await settingsApi(w);
    w.docker.failOn.set('updateContainerLimits', 'Cannot update container: device or resource busy');

    const { jobs: queued } = await put({ siteMemoryLimitMb: 256 });
    await runAll(w);

    const row = jobRow(w, queued[0]!.id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('demo-site');
    const logs = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, row.id)).all();
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('device or resource busy'))).toBe(true);
  });

  it('stop at the first sign of an unreachable server rather than timing out once per site', async () => {
    const w = await makeWorld();
    const web2 = w.addSshServer('web-2');
    const now = Date.now();
    for (const slug of ['far-one', 'far-two']) {
      w.db
        .insert(sites)
        .values({
          slug,
          title: slug,
          domains: JSON.stringify([`${slug}.test`]),
          phpVersion: '8.3',
          status: 'running',
          dbName: slug.replace('-', '_'),
          dbUser: slug.replace('-', '_'),
          dbPassword: 'x',
          containerName: `wp-${slug}`,
          serverId: web2.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    let reads = 0;
    web2.docker.containerLimits = async () => {
      reads++;
      throw new ServerUnreachableError(web2.id, 'web-2', new Error('connect ETIMEDOUT'));
    };
    const put = await settingsApi(w);

    const { jobs: queued } = await put({ siteMemoryLimitMb: 1024 });
    await runAll(w);

    const row = jobRow(w, queued[0]!.id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('far-one, far-two');
    expect(reads).toBe(1);
  });

  it('are sent to Docker with swap alongside memory, and a CPU cap only when there is one', async () => {
    const updates: Record<string, unknown>[] = [];
    const docker = new DockerService('wpl7_proxy', 'wpl7_db', {
      getContainer: () => ({
        update: async (opts: Record<string, unknown>) => {
          updates.push(opts);
        },
      }),
    } as never);
    await docker.updateContainerLimits('wp-demo', { memoryBytes: 1024 * MB, nanoCpus: 1.5e9, pidsLimit: 256 });
    await docker.updateContainerLimits('wp-demo', { memoryBytes: 256 * MB });

    // Docker refuses a memory limit above the swap limit already set unless both move.
    expect(updates[0]).toEqual({ Memory: 1024 * MB, MemorySwap: 2048 * MB, NanoCpus: 1.5e9, PidsLimit: 256 });
    // PidsLimit 0 lifts the process cap; NanoCpus 0 would mean "unchanged", so it is not sent.
    expect(updates[1]).toEqual({ Memory: 256 * MB, MemorySwap: 512 * MB, PidsLimit: 0 });
  });

  it('are read back from Docker in the form the panel writes them', async () => {
    const hostConfigs: Record<string, Record<string, unknown>> = {
      'wp-capped': { Memory: 512 * MB, NanoCpus: 2e9, PidsLimit: 512 },
      'wp-open': { Memory: 512 * MB, NanoCpus: 0, PidsLimit: null },
      'wp-old': { Memory: 0, PidsLimit: -1 },
    };
    const docker = new DockerService('wpl7_proxy', 'wpl7_db', {
      getContainer: (name: string) => ({
        inspect: async () => {
          const host = hostConfigs[name];
          if (!host) throw Object.assign(new Error('No such container'), { statusCode: 404 });
          return { HostConfig: host };
        },
      }),
    } as never);

    expect(await docker.containerLimits('wp-capped')).toEqual({ memoryBytes: 512 * MB, nanoCpus: 2e9, pidsLimit: 512 });
    expect(await docker.containerLimits('wp-open')).toEqual({ memoryBytes: 512 * MB });
    expect(await docker.containerLimits('wp-old')).toEqual({ memoryBytes: 0 });
    expect(await docker.containerLimits('wp-gone')).toBeNull();
  });

  it('only need a new container to lose a CPU cap', () => {
    const at = (memMb: number, cpus?: number, pids?: number): SiteRuntime => ({
      memoryBytes: memMb * MB,
      ...(cpus ? { nanoCpus: cpus * 1e9 } : {}),
      ...(pids ? { pidsLimit: pids } : {}),
    });
    expect(limitsChange(at(512, 2, 512), at(512, 2, 512))).toBe('none');
    expect(limitsChange(at(512, 2, 512), at(1024, 2, 512))).toBe('in-place');
    expect(limitsChange(at(512, 2, 512), at(512, 0.5, 512))).toBe('in-place');
    expect(limitsChange(at(512, undefined, 512), at(512, 1, 512))).toBe('in-place');
    expect(limitsChange(at(512, 2, 512), at(512, 2))).toBe('in-place');
    expect(limitsChange(at(512, 2, 512), at(512, undefined, 512))).toBe('recreate');
    expect(limitsChange(at(512, 2, 512), at(1024))).toBe('recreate');
  });
});
