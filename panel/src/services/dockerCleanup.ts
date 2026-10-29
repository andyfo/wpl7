// @docs servers/resources
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import { sites } from '../db/schema.js';
import { hostedSites } from '../lib/siteKind.js';
import type { ServerHandle } from '../servers/registry.js';
import { formatBytes } from '../../shared/bytes.js';
import type { ImageSummary } from './docker.js';
import type { HousekeepingLog } from './housekeeping.js';
import type { CoreServices } from './index.js';
import { SCANNER_IMAGE } from './scanEngines.js';
import { SITE_IMAGE_REPO, siteImage } from './siteSpec.js';
import { DKIM_CONTAINER, MAIL_CONTAINER, MARIADB_CONTAINER, PANEL_CONTAINER, TRAEFIK_CONTAINER } from './stack.js';

/**
 * Docker's part of the nightly housekeeping, on every server: the images nothing runs or needs
 * any more, and the build cache.
 *
 * Nothing else removes an image. An update pulls each release's panel and site images and keeps
 * the previous ones. A server that builds from source tags a new panel image for every version.
 * A pull that moves a tag such as `traefik:v3.7` keeps the image it moved from, and so does a
 * rebuild through the Docker API, which is how the panel builds: the image it replaced stays,
 * without a name.
 *
 * An image goes when no container uses it, running or stopped, no name the panel needs points
 * at it, and it is WPL7's: every name it has is in a repository WPL7 pulls or builds into, or it
 * has no name at all. A server's own images, under names of their own, are left alone. Of the
 * panel's images, the newest one no container runs stays too, for a rollback. An update of the
 * panel and the removal of images on its server take turns (removeUnusedImages says how).
 *
 * Docker trims the build cache only once free space falls under a fifth of the disk, and then
 * only down to a tenth of it. Here it keeps BUILD_CACHE_KEEP_BYTES of what no image shares, the
 * most recently used, which is enough for the next build of the panel to reuse its dependencies.
 */

export const BUILD_CACHE_KEEP_BYTES = 1024 ** 3;

/** The registry setup.sh pulls site images from when `WPL7_WORDPRESS_IMAGE` names none. */
const SETUP_WORDPRESS_IMAGE = 'ghcr.io/andyfo/wpl7/wordpress';

/** `traefik:v3.7` and `traefik@sha256:…` are both `traefik`; a registry's port is not a tag. */
export function repositoryOf(ref: string): string {
  const at = ref.indexOf('@');
  if (at >= 0) return ref.slice(0, at);
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
}

export interface ImagePlanInput {
  images: ImageSummary[];
  /** Images a container was created from. */
  inUse: Set<string>;
  /** Images a name the panel needs points at now. */
  needed: Set<string>;
  /** Repositories WPL7 pulls or builds into. */
  repos: Set<string>;
  /** The panel's own repositories, among `repos`. */
  panelRepos: Set<string>;
}

/** The images to remove, by the rules above. */
export function imagesToRemove(input: ImagePlanInput): ImageSummary[] {
  const reposOf = (image: ImageSummary) => new Set([...image.tags, ...image.digests].map(repositoryOf));
  const unused = input.images.filter((image) => !input.inUse.has(image.id) && !input.needed.has(image.id));
  // What a rollback would start: the newest panel image no container runs.
  const rollback = unused
    .filter((image) => [...reposOf(image)].some((repo) => input.panelRepos.has(repo)))
    .sort((a, b) => b.created - a.created)[0];
  return unused.filter((image) => {
    if (image === rollback) return false;
    const repos = reposOf(image);
    return [...repos].every((repo) => input.repos.has(repo));
  });
}

/** What the panel needs on this server, and where its images come from. */
async function needsOn(s: CoreServices, handle: ServerHandle): Promise<{ needed: string[]; repos: string[]; panelRepos: string[] }> {
  const { config } = s;
  const offered = s.settings.get('phpVersions');
  const running = s.db
    .select({ phpVersion: sites.phpVersion })
    .from(sites)
    .where(and(hostedSites(), eq(sites.serverId, handle.id)))
    .all()
    .map((site) => site.phpVersion);
  const wordpressRepos = [
    ...new Set([config.wordpressImage || SETUP_WORDPRESS_IMAGE, `ghcr.io/${config.updateRepo.toLowerCase()}/wordpress`]),
  ];
  // The names the stack's containers were created from: a container still on an older image is
  // recreated onto the one its name points at now, so that one stays.
  const stack = new Map<string, string>();
  for (const name of [TRAEFIK_CONTAINER, MARIADB_CONTAINER, MAIL_CONTAINER, DKIM_CONTAINER, PANEL_CONTAINER]) {
    const ref = await handle.docker.containerImage(name);
    if (ref && !ref.startsWith('sha256:')) stack.set(name, ref);
  }
  const panelRef = stack.get(PANEL_CONTAINER);
  const panelRepos = [
    'wpl7-panel',
    `ghcr.io/${config.updateRepo.toLowerCase()}/panel`,
    ...(panelRef ? [repositoryOf(panelRef)] : []),
  ];
  const needed = [
    ...[...new Set([...offered, ...running])].map(siteImage),
    // During an update the release's images are pulled before they get their local names.
    ...(config.imageTag ? offered.flatMap((v) => wordpressRepos.map((repo) => `${repo}:php${v}-${config.imageTag}`)) : []),
    ...stack.values(),
    config.sftpgoImage,
    ...(config.sftpgoImagePinned ? [] : [config.sftpgoPublishedImage]),
    SCANNER_IMAGE,
    config.rcloneImage,
    config.mariadb.clientImage,
  ];
  const repos = [
    SITE_IMAGE_REPO,
    ...wordpressRepos,
    ...panelRepos,
    // A pinned SFTPGo image is the operator's, and so are its other versions.
    ...(config.sftpgoImagePinned ? [] : [repositoryOf(config.sftpgoImage), repositoryOf(config.sftpgoPublishedImage)]),
    repositoryOf(SCANNER_IMAGE),
    repositoryOf(config.rcloneImage),
    repositoryOf(config.mariadb.clientImage),
    ...[...stack.values()].map(repositoryOf),
  ];
  return { needed, repos, panelRepos };
}

const isConflict = (err: unknown) => typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 409;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How the log names an image: its first name, or its short id when it has none. */
const nameOf = (image: ImageSummary) => image.tags[0] ?? image.digests[0] ?? `untagged ${image.id.replace(/^sha256:/, '').slice(0, 12)}`;

/**
 * The mark the clean-up holds on the panel's own server while it removes images there.
 * provision/update.sh waits for it to go before it pulls anything (wpl7_wait_for_docker_cleanup in
 * provision/lib.sh), and the clean-up looks for a running update only once it holds the mark.
 */
export function cleanupMark(config: Config): string {
  return path.join(config.paths.panel, 'update', 'docker-cleanup');
}

/** At boot no clean-up can be running yet, and the mark of one a crash cut short would hold up an update. */
export function clearCleanupMark(config: Config): void {
  fs.rmSync(cleanupMark(config), { force: true });
}

/**
 * One server's images. Returns the names of those removed, or null when an update of the panel
 * is running on that server and they were left for the next run.
 */
export async function removeUnusedImages(s: CoreServices, handle: ServerHandle, log: HousekeepingLog): Promise<string[] | null> {
  if (handle.kind !== 'local') return removeFrom(s, handle, log);
  // update.sh runs on the panel's own server, started from the panel or by hand. It names the next
  // release's images only after pulling them, or after finding them left by an earlier try, and
  // this panel, which does not know that release, would take them for leftovers. So the two take
  // turns. This marks the time it removes images, then looks for an update. update.sh writes that
  // it is running, then waits for the mark. Whichever looks second sees the other.
  const mark = cleanupMark(s.config);
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, `${new Date().toISOString()}\n`);
  try {
    if (await s.system.isRunning()) return null;
    return await removeFrom(s, handle, log);
  } finally {
    fs.rmSync(mark, { force: true });
  }
}

async function removeFrom(s: CoreServices, handle: ServerHandle, log: HousekeepingLog): Promise<string[]> {
  const { docker } = handle;
  const images = await docker.listImages();
  const inUse = new Set(await docker.containerImageIds());
  const { needed: neededRefs, repos, panelRepos } = await needsOn(s, handle);
  const needed = new Set<string>();
  for (const ref of new Set(neededRefs)) {
    const id = await docker.imageId(ref);
    if (id) needed.add(id);
  }
  const removed: string[] = [];
  for (const image of imagesToRemove({ images, inUse, needed, repos: new Set(repos), panelRepos: new Set(panelRepos) })) {
    try {
      // By each of its names: Docker refuses to remove an image with two by its id. The last
      // one to go takes the image with it.
      for (const ref of image.tags.length > 0 ? image.tags : [image.id]) await docker.removeImage(ref);
      removed.push(nameOf(image));
    } catch (err) {
      // A container created from it since, or an image built on it: Docker keeps it, and so do we.
      if (!isConflict(err)) log.warn(`Docker on "${handle.name}": could not remove ${nameOf(image)}: ${errorText(err)}`);
    }
  }
  return removed;
}

/** Every reachable server's images and build cache. */
export async function cleanDocker(
  s: CoreServices,
  log: HousekeepingLog,
  checkCanceled: () => void = () => undefined,
): Promise<{ imagesRemoved: number; buildCacheFreedBytes: number }> {
  const total = { imagesRemoved: 0, buildCacheFreedBytes: 0 };
  for (const server of s.servers.listRows()) {
    // One being set up is pulling and building the very images this would weigh.
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    let handle: ServerHandle;
    try {
      handle = s.servers.handleFor(server.id);
    } catch {
      continue;
    }
    const said: string[] = [];
    try {
      const removed = await removeUnusedImages(s, handle, log);
      if (removed === null) said.push('an update of the panel is running here, so its images wait for the next run');
      else {
        total.imagesRemoved += removed.length;
        if (removed.length > 0) said.push(`removed ${removed.length} image(s) nothing uses: ${removed.join(', ')}`);
      }
    } catch (err) {
      log.warn(`Docker on "${server.name}": removing old images failed: ${errorText(err)}`);
    }
    try {
      const freed = await handle.docker.pruneBuildCache(BUILD_CACHE_KEEP_BYTES);
      total.buildCacheFreedBytes += freed;
      if (freed > 0) said.push(`freed ${formatBytes(freed)} of build cache`);
    } catch (err) {
      log.warn(`Docker on "${server.name}": trimming the build cache failed: ${errorText(err)}`);
    }
    log.info(`Docker on "${server.name}": ${said.length > 0 ? said.join('; ') : 'nothing to remove'}`);
    checkCanceled();
  }
  return total;
}
