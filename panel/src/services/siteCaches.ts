// @docs sites/caching
import path from 'node:path';
import crypto from 'node:crypto';
import { noCacheRules, parseSiteCacheRules, siteKeepSeconds, type SiteCacheRules } from '../../shared/cacheRules.js';
import type { SiteCacheCheck } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { SiteRow } from '../db/schema.js';
import { isExternal } from '../lib/siteKind.js';
import type { ServerHandle } from '../servers/registry.js';
import { fitCpus, type DockerPort } from './docker.js';
import { siteScheme } from './labels.js';
import type { PanelSettings } from './settings.js';
import {
  PAGE_CACHE_DIR_IN_CONTAINER,
  REDIS_SOCKET_IN_CONTAINER,
  SITE_STACK_PORT,
  renderFpmPool,
  renderNginxSite,
  renderPhpIni,
  renderRedisConf,
  siteBodyLimitMb,
  stackSizing,
  type SiteStack,
} from './siteStack.js';
import { sitePaths, siteRuntimeFrom } from './siteSpec.js';
import { asSiteUser } from './wp.js';
import { renderWpCachePhp } from './wpCachePhp.js';

/**
 * A site's caches, as they reach its server: the files in `config/runtime/`, which a stack 2
 * container mounts read-only at /etc/wpl7-runtime (services/siteStack.ts says what they hold).
 *
 * They are written before every create and start (ensureSiteMountSources), for a stack 1 container
 * too: it doesn't mount them, and the day it is replaced by a stack 2 one they are already right.
 * So nothing depends on a copy of them: they do travel in a backup's archive, as part of config/, but
 * a restore takes only wordpress/ and uploads.ini out of that, and a move's arrival deletes them.
 */

type CacheSettings = Pick<PanelSettings, 'sitePageCache' | 'sitePageCacheSeconds' | 'siteCpuLimit' | 'siteMemoryLimitMb' | 'sitePidsLimit'>;
export type CacheSettingsReader = { get<K extends keyof CacheSettings>(key: K): CacheSettings[K] };

/** What the files are worked out from. */
export type SiteCacheRow = Pick<SiteRow, 'slug' | 'pageCache' | 'objectCache' | 'cacheRules' | 'cpuLimit' | 'memoryLimitMb' | 'pidsLimit'>;

/** Whether the site keeps a page cache: what it says for itself, or what Settings says. */
export function effectivePageCache(settings: CacheSettingsReader, site: Pick<SiteRow, 'pageCache'>): boolean {
  if (site.pageCache === 'on') return true;
  if (site.pageCache === 'off') return false;
  return settings.get('sitePageCache') ?? true;
}

/** How long the site keeps a page, in seconds. */
export function effectiveKeepSeconds(settings: CacheSettingsReader, rules: Pick<SiteCacheRules, 'keepSeconds'>): number {
  return siteKeepSeconds(rules, Number(settings.get('sitePageCacheSeconds')));
}

/**
 * What a container's PHP and Redis get sized from. A site with no CPU cap can use every core the
 * host has, and one with a cap above them is fitted to them when its container is made, so the
 * workers follow the host in both cases. When the host can't be asked, what the site says will do.
 */
export async function runtimeSizes(docker: Pick<DockerPort, 'hostCpus'>, settings: CacheSettingsReader, site: SiteCacheRow): Promise<{ memoryMb: number; cpus: number | null }> {
  const host = await docker.hostCpus();
  const { memoryMb, cpus } = stackSizing(fitCpus(siteRuntimeFrom(settings, site), host));
  return { memoryMb, cpus: cpus ?? host };
}

/** Where a site's runtime files are on its server. */
export function runtimeFilePaths(config: Config, slug: string) {
  const dir = sitePaths(config, slug).runtimeDir;
  return {
    nginx: path.join(dir, 'nginx-site.conf'),
    fpmPool: path.join(dir, 'php-fpm-pool.conf'),
    phpIni: path.join(dir, 'php.ini'),
    wpCache: path.join(dir, 'wp-cache.php'),
    redis: path.join(dir, 'redis.conf'),
  };
}

/**
 * One runtime file. Replaced, not rewritten: the folder is what the container mounts, so what reads
 * the file sees the old one or the new one, never part of one. World-readable, because nginx's
 * workers, PHP-FPM's and Redis all read them as www-data.
 */
export function writeRuntimeFile(server: Pick<ServerHandle, 'files'>, file: string, content: string): Promise<void> {
  return server.files.writeFile(file, content, { atomic: true, mode: 0o644 });
}

/** The nginx file for a site as it is now. `warn` hears about each stored rule left out. */
export async function renderSiteNginx(
  server: Pick<ServerHandle, 'files'>,
  s: { config: Config; settings: CacheSettingsReader },
  site: SiteCacheRow,
  rules: SiteCacheRules,
  warn: (message: string) => void,
): Promise<string> {
  const uploadsIni = await server.files.readOptional(sitePaths(s.config, site.slug).uploadsIni);
  return renderNginxSite({ pageCache: effectivePageCache(s.settings, site), rules, warn, maxBodyMb: siteBodyLimitMb(uploadsIni ?? '') });
}

/** The WordPress side of the site's caches as it is now. */
export function renderSiteWpCache(settings: CacheSettingsReader, site: SiteCacheRow, rules: SiteCacheRules, warn: (message: string) => void): string {
  return renderWpCachePhp({ pageCache: effectivePageCache(settings, site), keepSeconds: effectiveKeepSeconds(settings, rules), rules, warn });
}

/** Redis's file while the object cache is on, and none otherwise: the image starts Redis when it finds one. */
export async function writeRedisConf(server: Pick<ServerHandle, 'files'>, config: Config, site: Pick<SiteRow, 'slug' | 'objectCache'>, memoryMb: number): Promise<void> {
  const file = runtimeFilePaths(config, site.slug).redis;
  if (site.objectCache) await writeRuntimeFile(server, file, renderRedisConf(memoryMb));
  else await server.files.rm(file);
}

/**
 * Write every runtime file of a site from what the panel says now. Nothing reads them until the
 * container that mounts them starts, or until it is told to reload.
 *
 * Both renderers leave out the same stored rule that can't be used, so `ctx` hears of it once.
 */
export async function writeSiteRuntimeFiles(
  server: Pick<ServerHandle, 'files' | 'docker'>,
  s: { config: Config; settings: CacheSettingsReader },
  site: SiteCacheRow,
  ctx?: { warn(message: string): void },
): Promise<void> {
  const told = new Set<string>();
  const warn = (message: string) => {
    if (told.has(message)) return;
    told.add(message);
    ctx?.warn(message);
  };
  const rules = parseSiteCacheRules(site.cacheRules);
  const files = runtimeFilePaths(s.config, site.slug);
  const { memoryMb, cpus } = await runtimeSizes(server.docker, s.settings, site);
  await server.files.mkdirp(sitePaths(s.config, site.slug).runtimeDir, { mode: 0o755 });
  await writeRuntimeFile(server, files.nginx, await renderSiteNginx(server, s, site, rules, warn));
  await writeRuntimeFile(server, files.fpmPool, renderFpmPool(memoryMb, cpus));
  await writeRuntimeFile(server, files.phpIni, renderPhpIni(memoryMb));
  await writeRuntimeFile(server, files.wpCache, renderSiteWpCache(s.settings, site, rules, warn));
  await writeRedisConf(server, s.config, site, memoryMb);
}

/**
 * What a site's container runs, for what only works on one stack: a cache clear has nothing to
 * clear on stack 1, and the object cache has no Redis there. Null when it has no container.
 */
export async function siteContainerStack(docker: Pick<DockerPort, 'containerStack'>, containerName: string): Promise<SiteStack | null> {
  return (await docker.containerStack(containerName))?.stack ?? null;
}

// ---------------------------------------------------------------------------
// Applying a change to a running container

/** A service in the container refused what the panel wrote. What it runs stays as it was. */
export class RuntimeRefusedError extends Error {}

/**
 * How long PHP may keep reading the old wp-cache.php after it is replaced: OPcache checks a file
 * every 2 seconds, and a request can be drawing a page under the old rules for a moment longer.
 */
const OLD_RULES_LINGER_MS = 3000;

type RuntimeServices = { config: Config; settings: CacheSettingsReader; log: { warn(message: string): void } };

async function reload(server: Pick<ServerHandle, 'docker'>, container: string, service: 'nginx' | 'php' | 'redis'): Promise<string | null> {
  const res = await server.docker.exec(container, ['wpl7-reload', service], { timeoutMs: 45_000 });
  if (res.exitCode === 0) return null;
  return (`${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-3).join(' ') || `exit code ${res.exitCode}`).slice(0, 300);
}

async function restore(server: Pick<ServerHandle, 'files'>, file: string, previous: string | null): Promise<void> {
  if (previous === null) await server.files.rm(file);
  else await writeRuntimeFile(server, file, previous);
}

/**
 * Bring a site's runtime files to what the panel says now and, on a running stack 2 container, have
 * what reads them take them, without a restart. Only what changed gets reloaded: a PHP-FPM reload
 * empties OPcache and ends long requests after 10 s, so nothing causes one unless the sizes changed.
 *
 * A file a service refuses is put back and the call fails, leaving the site as it was: the rule
 * values are checked before they get this far, so that would be a bug, and a site must outlive it.
 *
 * A change to the nginx file or to wp-cache.php can mean anything for what was stored, so it empties
 * the page cache: an expired page whose refresh is no longer stored would otherwise go on being
 * served, and a page's key may have changed. Switching the cache back on is no exception, because
 * the files outlive Off. It clears a second time once PHP can no longer hold the old rules.
 */
export async function applySiteCaches(
  server: Pick<ServerHandle, 'files' | 'docker'>,
  s: RuntimeServices,
  site: SiteRow,
  ctx?: { warn(message: string): void },
): Promise<{ reloaded: string[]; cleared: boolean }> {
  const live = (await siteContainerStack(server.docker, site.containerName)) === 2 && (await server.docker.containerState(site.containerName)) === 'running';
  // Nothing reads them until the next start, which is what they are for.
  if (!live) {
    await writeSiteRuntimeFiles(server, s, site, ctx);
    return { reloaded: [], cleared: false };
  }

  const told = new Set<string>();
  const warn = (message: string) => {
    if (told.has(message)) return;
    told.add(message);
    ctx?.warn(message);
  };
  const rules = parseSiteCacheRules(site.cacheRules);
  const files = runtimeFilePaths(s.config, site.slug);
  const { memoryMb, cpus } = await runtimeSizes(server.docker, s.settings, site);
  await server.files.mkdirp(sitePaths(s.config, site.slug).runtimeDir, { mode: 0o755 });
  const reloaded: string[] = [];

  const nginx = await renderSiteNginx(server, s, site, rules, warn);
  const oldNginx = await server.files.readOptional(files.nginx);
  if (nginx !== oldNginx) {
    await writeRuntimeFile(server, files.nginx, nginx);
    const refused = await reload(server, site.containerName, 'nginx');
    if (refused) {
      await restore(server, files.nginx, oldNginx);
      throw new RuntimeRefusedError(`nginx refused this site's caching settings: ${refused}`);
    }
    reloaded.push('nginx');
  }

  // PHP reads this one by itself, on its next request.
  const wpCache = renderSiteWpCache(s.settings, site, rules, warn);
  const oldWpCache = await server.files.readOptional(files.wpCache);
  if (wpCache !== oldWpCache) await writeRuntimeFile(server, files.wpCache, wpCache);

  const pool = renderFpmPool(memoryMb, cpus);
  const ini = renderPhpIni(memoryMb);
  const oldPool = await server.files.readOptional(files.fpmPool);
  const oldIni = await server.files.readOptional(files.phpIni);
  if (pool !== oldPool || ini !== oldIni) {
    await writeRuntimeFile(server, files.fpmPool, pool);
    await writeRuntimeFile(server, files.phpIni, ini);
    const refused = await reload(server, site.containerName, 'php');
    if (refused) {
      await restore(server, files.fpmPool, oldPool);
      await restore(server, files.phpIni, oldIni);
      throw new RuntimeRefusedError(`PHP-FPM refused this site's sizes: ${refused}`);
    }
    reloaded.push('PHP-FPM');
  }

  const redis = site.objectCache ? renderRedisConf(memoryMb) : null;
  const oldRedis = await server.files.readOptional(files.redis);
  if (redis !== oldRedis) {
    await restore(server, files.redis, redis);
    const refused = await reload(server, site.containerName, 'redis');
    if (refused) {
      await restore(server, files.redis, oldRedis);
      throw new RuntimeRefusedError(`Redis refused this site's settings: ${refused}`);
    }
    reloaded.push('Redis');
  }

  const stale = nginx !== oldNginx || wpCache !== oldWpCache;
  if (stale) {
    await clearSiteCaches(server, site);
    clearAgainSoon(server, s, site);
  }
  return { reloaded, cleared: stale };
}

function clearAgainSoon(server: Pick<ServerHandle, 'docker'>, s: RuntimeServices, site: SiteRow): void {
  const again = () =>
    clearSiteCaches(server, site).catch((err: unknown) => {
      s.log.warn(`Page cache of "${site.slug}": a second clear failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  // A timer in a test outlives the world it was made for.
  if (s.config.nodeEnv === 'test') void again();
  else setTimeout(again, OLD_RULES_LINGER_MS).unref();
}

// ---------------------------------------------------------------------------
// Clearing

/** `find` complains when nginx removes a file first, which is no failure. */
export const CLEAR_PAGE_CACHE = ['sh', '-c', `find ${PAGE_CACHE_DIR_IN_CONTAINER} -mindepth 1 -type f -delete 2>/dev/null; exit 0`];
export const FLUSH_REDIS = ['redis-cli', '-s', REDIS_SOCKET_IN_CONTAINER, 'FLUSHALL'];

/**
 * Empty what a site's container has stored, as the site's own user: the page cache's files, and
 * Redis when it runs. Deleting a file is all a purge takes: nginx treats a missing one as a miss.
 * False when there was nothing to clear: stack 1 has no caches, and a stopped container empties
 * them when it starts.
 */
export async function clearSiteCaches(server: Pick<ServerHandle, 'docker'>, site: Pick<SiteRow, 'containerName' | 'objectCache'>): Promise<boolean> {
  const { docker } = server;
  if ((await siteContainerStack(docker, site.containerName)) !== 2) return false;
  if ((await docker.containerState(site.containerName)) !== 'running') return false;
  await docker.exec(site.containerName, CLEAR_PAGE_CACHE, asSiteUser(60_000));
  if (site.objectCache) await docker.exec(site.containerName, FLUSH_REDIS, asSiteUser(30_000));
  return true;
}

/**
 * The same after something changed what visitors see. Never a reason to fail what caused it: a
 * page stays stale for at most its keep time, and there is a button.
 */
export async function clearAfterChange(s: { servers: { handleFor(id: number): Pick<ServerHandle, 'docker'> }; log: { warn(message: string): void } }, site: SiteRow): Promise<void> {
  if (isExternal(site)) return;
  try {
    await clearSiteCaches(s.servers.handleFor(site.serverId), site);
  } catch (err) {
    s.log.warn(`Could not clear the caches of "${site.slug}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** WP-CLI's words that only look, whichever group they follow. */
const READ_ONLY_VERBS = new Set(['list', 'get', 'status', 'exists', 'is-active', 'is-installed', 'path', 'version', 'search', 'count', 'pluck', 'has', 'check-update', 'verify-checksums', 'size', 'tables', 'type']);
/** Groups with groups in them: `cron event list`, `post meta get`, `language core list`. */
const NESTED_GROUPS = new Set(['event', 'schedule', 'core', 'plugin', 'theme', 'meta', 'term', 'session', 'application-password', 'option', 'item', 'location', 'auto-updates', 'mod']);

/**
 * Whether a WP-CLI command only reads, so an AI session looking around a site doesn't empty its
 * cache. Anything not known to read counts as a change: an unneeded clear costs a few page loads,
 * and a missed one shows visitors an old page.
 */
export function wpCliOnlyReads(args: readonly string[]): boolean {
  const words = args.filter((arg) => !arg.startsWith('-'));
  const [group, verb, nested] = words;
  if (group === undefined) return true;
  if (group === 'help' || group === 'cli') return true;
  if (verb === undefined) return false;
  if (READ_ONLY_VERBS.has(verb)) return true;
  return NESTED_GROUPS.has(verb) && nested !== undefined && READ_ONLY_VERBS.has(nested);
}

// ---------------------------------------------------------------------------
// Check a URL

function responseHeaders(text: string): { status: number | null; headers: Map<string, string> } {
  const lines = text.split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? '');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return { status: status ? Number(status[1]) : null, headers };
}

/**
 * Ask a site's nginx for a page, the way a visitor with no cookies would, and say what the cache did
 * with it. A page that wasn't stored yet is asked for a second time, because only that shows whether
 * it would be. The answers come from the headers every page carries (services/siteStack.ts).
 */
export async function checkSiteUrl(server: Pick<ServerHandle, 'docker'>, config: Pick<Config, 'tlsMode'>, site: Pick<SiteRow, 'containerName' | 'domains'>, path: string): Promise<SiteCacheCheck> {
  const [host] = JSON.parse(site.domains) as string[];
  const ask = async () => {
    const res = await server.docker.exec(
      site.containerName,
      [
        'curl', '-sS', '-g', '--path-as-is', '--max-time', '30', '-o', '/dev/null', '-D', '-',
        '-A', 'Mozilla/5.0 (compatible; wpl7-check/1)',
        '-H', `Host: ${host}`,
        '-H', `X-Forwarded-Proto: ${siteScheme(config.tlsMode)}`,
        `http://127.0.0.1:${SITE_STACK_PORT}${path.replace(/[^\x21-\x7e]/gu, encodeURIComponent)}`,
      ],
      asSiteUser(45_000),
    );
    if (res.exitCode !== 0) throw new Error((res.stderr.trim() || `curl exited with ${res.exitCode}`).slice(0, 300));
    return responseHeaders(res.stdout);
  };

  let answer = await ask();
  const cache = () => answer.headers.get('x-cache-status')?.toUpperCase() ?? '';
  const reason = () => answer.headers.get('x-cache-skipped') ?? null;
  if (cache() === 'BYPASS') {
    return reason() === 'off' ? { state: 'off', reason: null, status: answer.status } : { state: 'skipped', reason: reason(), status: answer.status };
  }
  if (cache() === 'MISS' || cache() === 'EXPIRED') {
    if (reason() === null) answer = await ask();
    if (cache() !== 'HIT') return { state: 'not-stored', reason: reason() ?? 'not a WordPress page', status: answer.status };
  }
  if (cache() === 'STALE') return { state: 'stale', reason: null, status: answer.status };
  return { state: 'cached', reason: null, status: answer.status };
}

// ---------------------------------------------------------------------------
// A panel update

const RUNTIME_DIGEST_KEY = 'site.runtimeDigest';

/** What the renderers make of a site that changed nothing, so a release that changes them shows. */
function runtimeDigest(): string {
  const rules = noCacheRules();
  const hash = crypto.createHash('sha256');
  for (const pageCache of [true, false]) {
    hash.update(renderNginxSite({ pageCache, rules }));
    hash.update(renderWpCachePhp({ pageCache, keepSeconds: 3600, rules }));
  }
  hash.update(renderFpmPool(512, 2)).update(renderPhpIni(512)).update(renderRedisConf(512));
  return hash.digest('hex');
}

/**
 * Whether this panel renders runtime files differently from the one that last applied them. A release
 * improves the built-in rules, and a site that didn't touch them is meant to get that, not only at its
 * next restart. At boot rather than in an update hook: a box that builds from its own checkout gets no
 * hooks. The caller queues the work and then calls the function this returns.
 */
export function runtimeChangedSinceLastApply(settings: { getRaw(key: string): unknown; setRaw(key: string, value: unknown): void }): (() => void) | null {
  const digest = runtimeDigest();
  if (settings.getRaw(RUNTIME_DIGEST_KEY) === digest) return null;
  return () => settings.setRaw(RUNTIME_DIGEST_KEY, digest);
}
