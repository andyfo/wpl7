// @docs servers/overview, sites/overview
import { eq } from 'drizzle-orm';
import { sites, type SiteRow } from '../db/schema.js';
import { hostedSites, isExternal } from '../lib/siteKind.js';
import { compareVersions } from '../lib/wpVersions.js';
import type { DockerPort } from './docker.js';
import type { CoreServices } from './index.js';
import { SITE_IMAGE_REPO } from './siteSpec.js';

/**
 * The PHP release each hosted site runs (`sites.php_release`), which every page that shows a
 * site's PHP reads.
 *
 * `php_version` only names the branch a site is set to. The release is whatever its container's
 * image carried when the container was made, and the container keeps it until it is rebuilt, so
 * it is read off the container and never worked out from the branch. It is read again as a job
 * that starts, stops or rebuilds a site's container ends (the worker), and for every site at boot
 * and hourly (the schedulers), which also catches a container replaced outside the panel. A site
 * hosted elsewhere reports its own through WPL7 Connect (services/connections.ts).
 */

/** Read one hosted site's release again. */
export async function readSitePhp(s: CoreServices, siteId: number): Promise<void> {
  const site = s.db.select().from(sites).where(eq(sites.id, siteId)).get();
  if (!site || isExternal(site)) return;
  store(s, site, await s.servers.handleFor(site.serverId).docker.containerPhpVersion(site.containerName));
}

/** Read every hosted site's release, a server at a time. One that cannot be reached keeps what it had. */
export async function sweepPhpReleases(s: CoreServices): Promise<void> {
  const rows = s.db.select().from(sites).where(hostedSites()).all();
  for (const server of s.servers.listRows()) {
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    const mine = rows.filter((site) => site.serverId === server.id);
    if (mine.length === 0) continue;
    try {
      const docker = s.servers.handleFor(server.id).docker;
      for (const site of mine) store(s, site, await docker.containerPhpVersion(site.containerName));
    } catch (err) {
      s.log.warn(`PHP release sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** A reading, like the disk use: it does not count as a change to the site. */
function store(s: CoreServices, site: SiteRow, release: string | null): void {
  if (site.phpRelease === release) return;
  s.db.update(sites).set({ phpRelease: release }).where(eq(sites.id, site.id)).run();
}

/** The site images a server has, oldest branch first, with the release in each: what a site built there gets. */
export async function siteImagePhp(docker: DockerPort): Promise<{ version: string; release: string | null }[]> {
  const images: { version: string; release: string | null }[] = [];
  for (const tag of await docker.imageTags(SITE_IMAGE_REPO)) {
    const version = /:php(\d+\.\d+)$/.exec(tag)?.[1];
    if (version) images.push({ version, release: await docker.imagePhpVersion(tag) });
  }
  return images.sort((a, b) => compareVersions(a.version, b.version));
}
