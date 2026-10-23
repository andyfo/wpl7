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
  const mark = s.monitor.changeMark();
  const site = s.db.select().from(sites).where(eq(sites.id, siteId)).get();
  if (!site || isExternal(site)) return;
  const release = await read(s, s.servers.handleFor(site.serverId).docker, site);
  if (release === NO_ANSWER) {
    s.log.warn(`Site "${site.slug}": Docker did not say which PHP it runs in time. The hourly sweep reads it again.`);
    return;
  }
  store(s, site, release, mark);
}

/**
 * Read every hosted site's release, a server at a time. A server that cannot be reached, or whose
 * Docker stops answering, keeps what it had.
 */
export async function sweepPhpReleases(s: CoreServices): Promise<void> {
  // Taken with the list, as the uptime check takes its own (MonitorService.tickUptime).
  const mark = s.monitor.changeMark();
  const rows = s.db.select().from(sites).where(hostedSites()).all();
  for (const server of s.servers.listRows()) {
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    const mine = rows.filter((site) => site.serverId === server.id);
    if (mine.length === 0) continue;
    try {
      const docker = s.servers.handleFor(server.id).docker;
      for (const site of mine) {
        // A job on the site reads it as it ends.
        if (s.monitor.changedSince(site.id, mark)) continue;
        const release = await read(s, docker, site);
        // Every other site on the server would wait as long.
        if (release === NO_ANSWER) throw new Error('Docker did not answer in time');
        store(s, site, release, mark);
      }
    } catch (err) {
      s.log.warn(`PHP release sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const NO_ANSWER = Symbol('no answer');

/**
 * What `asked` answers, or NO_ANSWER after `timeoutMs`. Docker can take a request and never answer
 * it, and nothing waiting on a reading here should wait for that.
 */
async function within<T>(asked: Promise<T>, timeoutMs: number): Promise<T | typeof NO_ANSWER> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      asked,
      new Promise<typeof NO_ANSWER>((resolve) => {
        timer = setTimeout(() => resolve(NO_ANSWER), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The release a site's container runs, or NO_ANSWER after `phpReadTimeoutMs`. */
function read(s: CoreServices, docker: DockerPort, site: SiteRow): Promise<string | null | typeof NO_ANSWER> {
  return within(docker.containerPhpVersion(site.containerName), s.config.phpReadTimeoutMs);
}

/**
 * Store a reading, unless a job has begun or ended on the site since `mark` (MonitorService.
 * changedSince): it may be of the container that job replaced, and the job reads the site again
 * as it ends. Like the disk use, a reading does not count as a change to the site.
 */
function store(s: CoreServices, site: SiteRow, release: string | null, mark: number): void {
  if (s.monitor.changedSince(site.id, mark) || site.phpRelease === release) return;
  s.db.update(sites).set({ phpRelease: release }).where(eq(sites.id, site.id)).run();
}

/**
 * The site images a server has, oldest branch first, with the release in each: what a site built
 * there gets. Throws when Docker has not answered within `timeoutMs`.
 */
export async function siteImagePhp(docker: DockerPort, timeoutMs: number): Promise<{ version: string; release: string | null }[]> {
  const images = await within(imagesOf(docker), timeoutMs);
  if (images === NO_ANSWER) throw new Error('Docker did not answer in time');
  return images;
}

async function imagesOf(docker: DockerPort): Promise<{ version: string; release: string | null }[]> {
  const images: { version: string; release: string | null }[] = [];
  for (const tag of await docker.imageTags(SITE_IMAGE_REPO)) {
    const version = /:php(\d+\.\d+)$/.exec(tag)?.[1];
    if (version) images.push({ version, release: await docker.imagePhpVersion(tag) });
  }
  return images.sort((a, b) => compareVersions(a.version, b.version));
}
