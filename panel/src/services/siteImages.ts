// @docs panel/updating, reference/architecture, security/overview
import { asc } from 'drizzle-orm';
import { sites } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { CoreServices } from './index.js';
import { hostedSites } from '../lib/siteKind.js';
import { queueReconcile, type HardeningSweep } from './siteHardening.js';
import { containerOfAside, siteImage } from './siteSpec.js';
import { stackFromLabels, type SiteStack } from './siteStack.js';

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
 *
 * So is a site that went back to its old container from the image the tag names now: every hour
 * it would be taken down to fail the same way. It tries again by itself once there is a newer
 * image, so no site stays behind for good, and its page offers a Retry before that.
 *
 * A container kept aside by a change that never finished (replaceContainer) gets its site a
 * reconcile too, which puts it back first.
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
    const current = new Map<string, { id: string | null; stack: SiteStack }>();
    const tagged = async (tag: string) => {
      let image = current.get(tag);
      if (!image) {
        image = { id: await docker.imageId(tag), stack: await docker.imageStack(tag) };
        current.set(tag, image);
      }
      return image;
    };
    try {
      const containers = await docker.listManaged(['wpl7.role=wordpress']);
      const queued = new Set<number>();
      for (const container of containers) {
        const asideOf = containerOfAside(container.name);
        const site = rows.find((r) => r.containerName === (asideOf ?? container.name) && r.serverId === server.id);
        // A container the panel cannot explain is not the sweep's to rebuild.
        if (!site || queued.has(site.id)) continue;
        if (asideOf) {
          queued.add(site.id);
          queueReconcile(worker, site, sweep);
          continue;
        }
        const image = await tagged(siteImage(site.phpVersion));
        if (!image.id || image.id === site.stackSwitchImage) continue;
        // On the current image, yet made for the one before it: the panel that was running while an
        // update moved the tag built it, with Apache's port, which on this image nothing can reach.
        const madeForAnother = image.id === container.imageId && image.stack === 2 && stackFromLabels(container.labels) === 1;
        if (image.id === container.imageId && !madeForAnother) continue;
        queued.add(site.id);
        queueReconcile(worker, site, sweep);
      }
      // A panel that stopped between taking a container away and starting the next one leaves a
      // site that should run with none, or with one that never started, and nothing else returns
      // to it: Docker doesn't start a container that never ran.
      for (const site of rows) {
        if (site.serverId !== server.id || site.status !== 'running' || queued.has(site.id)) continue;
        const container = containers.find((c) => c.name === site.containerName);
        if (container && container.state !== 'created') continue;
        if (!(await tagged(siteImage(site.phpVersion))).id) continue;
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
