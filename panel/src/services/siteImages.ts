// @docs panel/updating, reference/architecture, security/overview
import { asc } from 'drizzle-orm';
import { sites } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { CoreServices } from './index.js';
import { hostedSites } from '../lib/siteKind.js';
import { queueReconcile, type HardeningSweep } from './siteHardening.js';
import { siteImage } from './siteSpec.js';

/**
 * Rebuild every site container that runs an older image than the one its server's
 * `wpl7-wordpress:php<version>` names now.
 *
 * An update, or a rebuild from source, only moves the tag. A running container keeps the image
 * it was created from until something recreates it, so without this a site kept the PHP of the
 * day it was made, however many security releases its server had pulled since.
 *
 * Runs at boot, which follows an update putting new images on the panel's own server, and then
 * hourly, which reaches a worker's sites once its own update has pulled the images, and the
 * sites that were busy. One `site.reconcile` per site, in its server's lane, each with its own
 * rollback, as the hardening sweep does. A site whose tag is missing on its server is left
 * alone: there is nothing to rebuild it onto.
 */
export async function sweepSiteImages(
  s: CoreServices,
  worker: Pick<JobWorker, 'enqueue' | 'activeSiteJob'>,
): Promise<HardeningSweep> {
  const sweep: HardeningSweep = { queued: [], busy: [] };
  const rows = s.db.select().from(sites).where(hostedSites()).orderBy(asc(sites.id)).all();
  for (const server of s.servers.listRows()) {
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    const docker = s.servers.handleFor(server.id).docker;
    // One lookup per PHP version and server, not one per site.
    const current = new Map<string, string | null>();
    try {
      for (const container of await docker.listManaged(['wpl7.role=wordpress'])) {
        const site = rows.find((r) => r.containerName === container.name && r.serverId === server.id);
        // A container the panel cannot explain is not the sweep's to rebuild.
        if (!site) continue;
        const tag = siteImage(site.phpVersion);
        if (!current.has(tag)) current.set(tag, await docker.imageId(tag));
        const id = current.get(tag);
        if (!id || id === container.imageId) continue;
        queueReconcile(worker, site, sweep);
      }
    } catch (err) {
      s.log.warn(`Site image sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (sweep.queued.length > 0) {
    s.log.info(`Site images: ${sweep.queued.length} site container(s) queued to be rebuilt on their server's current image`);
  }
  if (sweep.busy.length > 0) {
    s.log.warn(`Site images: ${sweep.busy.length} site(s) were busy and keep their old image until the next sweep: ${sweep.busy.join(', ')}`);
  }
  return sweep;
}
