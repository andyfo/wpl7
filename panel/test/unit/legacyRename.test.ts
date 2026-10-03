import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, sites } from '../../src/db/schema.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { sweepLegacyRename } from '../../src/services/legacyRename.js';
import {
  LEGACY_EGRESS_NETWORK,
  LEGACY_SITE_NETWORK_LABEL,
  legacySiteNetworkName,
  reconcileSiteNetworks,
  siteNetworkName,
} from '../../src/services/siteNetwork.js';

/**
 * LEGACY(ceo) - delete these with the shims in 0.3.0.
 *
 * What the panel wakes up to after provision/migrate-rename.sh: the stack is `wpl7-*` and
 * the compose networks have been recreated, but every site container is the one that was
 * already running - still on `ceo_site_<slug>`, still labelled `ceo.*`. Nothing here may
 * depend on those containers being restarted first; that is the job being queued.
 */

const INFRA = ['wpl7-traefik', 'wpl7-mail', 'wpl7-mariadb'];

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

async function runJob(w: TestWorld, jobId: number): Promise<string> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status;
}

async function createSite(w: TestWorld) {
  seedCoreFilesOnStart(w);
  const { site, job } = w.deps.sites.create({
    title: 'Demo Site',
    domainMode: 'dev' as const,
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  expect(await runJob(w, job.id)).toBe('succeeded');
  return site;
}

/** Put a site back on the generation migrate-rename.sh leaves behind. */
async function demoteToLegacy(w: TestWorld, slug: string): Promise<string> {
  const current = siteNetworkName(slug);
  const legacy = legacySiteNetworkName(slug);
  for (const c of [...INFRA, `wp-${slug}`]) await w.docker.disconnectContainer(current, c);
  await w.docker.removeNetwork(current);
  const [key, value] = LEGACY_SITE_NETWORK_LABEL.split('=') as [string, string];
  await w.docker.ensureNetwork({ name: legacy, internal: true, labels: { [key]: value } });
  for (const c of [...INFRA, `wp-${slug}`]) await w.docker.connectContainer(legacy, c);
  return legacy;
}

describe('rename sweep', () => {
  it('queues a reconcile for a site still on its pre-rename network', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const legacy = await demoteToLegacy(w, site.slug);

    const sweep = await sweepLegacyRename(w.core, w.worker);

    expect(sweep.queued).toEqual([site.slug]);
    const queued = w.db.select().from(jobs).where(eq(jobs.status, 'queued')).all();
    expect(queued.map((j) => j.type)).toEqual(['site.reconcile']);
    // The network is still there: only the job that recreates the container may remove it.
    expect(await w.docker.inspectNetwork(legacy)).not.toBeNull();
  });

  it('leaves a pre-rename network it cannot match to a site alone', async () => {
    const w = await makeWorld();
    const [key, value] = LEGACY_SITE_NETWORK_LABEL.split('=') as [string, string];
    await w.docker.ensureNetwork({
      name: legacySiteNetworkName('ghost'),
      internal: true,
      labels: { [key]: value },
    });

    const sweep = await sweepLegacyRename(w.core, w.worker);

    expect(sweep.queued).toEqual([]);
    expect(sweep.skipped).toEqual(['ghost']);
    // Removing a network whose site the panel cannot explain is how a running site loses
    // its database; an operator decides, not the sweep.
    expect(await w.docker.inspectNetwork(legacySiteNetworkName('ghost'))).not.toBeNull();
  });

  it('skips a site whose lane is already busy and reports it', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await demoteToLegacy(w, site.slug);
    w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: 1 });

    const sweep = await sweepLegacyRename(w.core, w.worker);

    expect(sweep.queued).toEqual([]);
    expect(sweep.skipped).toEqual([site.slug]);
  });

  it('drops the pre-rename egress network only once nothing is on it', async () => {
    const w = await makeWorld();
    await w.docker.ensureNetwork({ name: LEGACY_EGRESS_NETWORK, internal: false });
    await w.docker.connectContainer(LEGACY_EGRESS_NETWORK, 'wp-straggler');

    expect((await sweepLegacyRename(w.core, w.worker)).egressRemoved).toEqual([]);

    await w.docker.disconnectContainer(LEGACY_EGRESS_NETWORK, 'wp-straggler');
    const sweep = await sweepLegacyRename(w.core, w.worker);

    expect(sweep.egressRemoved).toEqual(['local']);
    expect(await w.docker.inspectNetwork(LEGACY_EGRESS_NETWORK)).toBeNull();
  });
});

describe('rename reconcile', () => {
  it('re-attaches the stack to pre-rename networks too', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const legacy = await demoteToLegacy(w, site.slug);
    for (const c of INFRA) await w.docker.disconnectContainer(legacy, c);

    // Until every site has been through its reconcile, this is the only thing keeping the
    // un-migrated ones routable after the stack came back up under a new compose project.
    const { repaired } = await reconcileSiteNetworks(w.docker);

    expect(repaired).toBe(3);
    expect((await w.docker.inspectNetwork(legacy))!.containers).toEqual(expect.arrayContaining(INFRA));
  });

  it('moves the site to its new network and drops the old one', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const legacy = await demoteToLegacy(w, site.slug);

    const job = w.deps.sites.reconcile(site.slug);
    expect(await runJob(w, job.id)).toBe('succeeded');

    expect(await w.docker.inspectNetwork(legacy)).toBeNull();
    // The replacement container is built against the new network, with the stack already
    // attached to it - the site is routable the moment it starts.
    const spec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!
      .args[0] as { networks: string[] };
    expect(spec.networks[0]).toBe(siteNetworkName(site.slug));
    expect((await w.docker.inspectNetwork(siteNetworkName(site.slug)))!.containers).toEqual(
      expect.arrayContaining(INFRA),
    );
    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(row.status).toBe('running');
  });
});
