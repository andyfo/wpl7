import { asc } from 'drizzle-orm';
import { sites } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { CoreServices } from './index.js';
import type { DockerPort } from './docker.js';
import {
  listLegacySiteNetworks,
  removeLegacyEgressNetwork,
  slugFromLegacySiteNetwork,
} from './siteNetwork.js';
import { hostedSites } from '../lib/siteKind.js';

/**
 * LEGACY(ceo) - delete in 0.3.0. Finish the rename for sites that predate it.
 *
 * `provision/migrate-rename.sh` moves the host: the checkout, the compose project and the
 * five stack containers. It deliberately leaves site containers running and untouched,
 * because stopping them is downtime and recreating them is a job with a rollback - which is
 * what `site.reconcile` already is. So the first panel of the new generation boots into a
 * server where the infrastructure is `wpl7-*` and every site is still on `ceo_site_<slug>`
 * with `ceo.*` labels, an image alias that no longer exists and a `@ceo` relay login.
 *
 * This sweep queues one `site.reconcile` per such site and lets the job queue do the rest,
 * one site at a time in its server's lane, each rolling back on its own if the new container
 * does not answer. A site that is busy is skipped rather than fought over: the next boot
 * picks it up, and so does Sites -> Re-apply security policy.
 *
 * Detection is by network name rather than container label. A site is on exactly one
 * per-site network for its whole life, including while stopped, and that network is created
 * by the panel - so its name is the one piece of a site's identity that cannot be stale.
 */
export interface LegacyRenameSweep {
  /** Slugs a reconcile was queued for. */
  queued: string[];
  /** Slugs that still carry the old generation but could not be queued right now. */
  skipped: string[];
  /** Servers whose pre-rename egress network was empty and has been dropped. */
  egressRemoved: string[];
}

export async function sweepLegacyRename(s: CoreServices, worker: JobWorker): Promise<LegacyRenameSweep> {
  const sweep: LegacyRenameSweep = { queued: [], skipped: [], egressRemoved: [] };
  const rows = s.db.select().from(sites).where(hostedSites()).orderBy(asc(sites.id)).all();

  for (const server of s.servers.listRows()) {
    if (server.status === 'unreachable') continue;
    let legacy: string[];
    let docker: DockerPort;
    try {
      docker = s.servers.handleFor(server.id).docker;
      legacy = await listLegacySiteNetworks(docker);
    } catch (err) {
      s.log.warn(`Rename sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    for (const network of legacy) {
      const slug = slugFromLegacySiteNetwork(network);
      const site = rows.find((r) => r.slug === slug && r.serverId === server.id);
      if (!site) {
        // A network whose site this panel does not know about: a half-finished move, or a
        // site deleted while the old stack was down. Left alone - removing a network the
        // panel cannot explain is how a running site loses its database.
        s.log.warn(`Rename sweep: ${network} on "${server.name}" has no matching site; leaving it in place`);
        sweep.skipped.push(slug);
        continue;
      }
      if (site.status === 'provisioning' || site.status === 'deleting') {
        sweep.skipped.push(slug);
        continue;
      }
      try {
        worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug, serverId: site.serverId });
        sweep.queued.push(slug);
        s.log.info(`Rename: queued a reconcile for "${slug}" (still on ${network})`);
      } catch {
        // Another job holds the site's lane. The next boot sweeps again.
        sweep.skipped.push(slug);
      }
    }

    try {
      if (await removeLegacyEgressNetwork(docker)) sweep.egressRemoved.push(server.name);
    } catch (err) {
      s.log.warn(`Rename sweep: could not drop ceo_egress on "${server.name}": ${err instanceof Error ? err.message : err}`);
    }
  }

  if (sweep.skipped.length > 0) {
    s.log.warn(`Rename: ${sweep.skipped.length} site(s) still on the old generation were busy; they will be swept again on the next boot`);
  }
  return sweep;
}
