// @docs sites/caching
import { z } from 'zod';
import type { SiteRow } from '../../db/schema.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { CoreServices } from '../../services/index.js';
import { runtimeSizes, siteContainerStack, writeRedisConf } from '../../services/siteCaches.js';
import type { JobContext } from '../context.js';
import { loadSite, requireRunning, updateSiteRow } from './shared.js';

export const siteObjectCachePayload = z.object({
  siteId: z.number().int(),
  on: z.boolean(),
});

/** WP-CLI's calls here are quick, but installing a plugin is a download. */
const WP_MS = 3 * 60_000;

const said = (res: { stdout: string; stderr: string; exitCode: number }) => (`${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-2).join(' ') || `exit code ${res.exitCode}`).slice(0, 300);

async function wpOk(server: ServerHandle, site: SiteRow, args: string[]): Promise<string> {
  const res = await server.wp.run(site.containerName, args, WP_MS);
  if (res.exitCode !== 0) throw new Error(`wp ${args.join(' ')}: ${said(res)}`);
  return res.stdout;
}

/** Starts or stops Redis to match its file. wpl7-reload says why when it didn't. */
async function matchRedis(ctx: JobContext<unknown>, server: ServerHandle, s: CoreServices, site: SiteRow, on: boolean): Promise<void> {
  const { memoryMb } = await runtimeSizes(server.docker, s.settings, site);
  await writeRedisConf(server, s.config, { slug: site.slug, objectCache: on ? 1 : 0 }, memoryMb);
  const res = await server.docker.exec(site.containerName, ['wpl7-reload', 'redis'], { timeoutMs: 45_000 });
  if (res.exitCode !== 0) throw new Error(said(res));
  ctx.info(on ? 'Redis is running in the container.' : 'Redis has stopped.');
}

/**
 * A site's object cache, a job because it installs a plugin: Redis in its container, and the Redis
 * Object Cache plugin to talk to it, whose settings come from wp-cache.php (services/wpCachePhp.ts).
 * The plugin refuses to replace another object cache's drop-in, and then this fails saying so.
 */
export async function siteObjectCache(ctx: JobContext<z.infer<typeof siteObjectCachePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  if ((await siteContainerStack(server.docker, site.containerName)) !== 2) {
    throw new Error('This site still runs the old PHP setup, which has no object cache.');
  }
  const putBack = await requireRunning(ctx, server, s, site);
  try {
    if (ctx.payload.on) await switchOn(ctx, s, server, site);
    else await switchOff(ctx, s, server, site);
  } finally {
    await putBack();
  }
}

async function switchOn(ctx: JobContext<unknown>, s: CoreServices, server: ServerHandle, site: SiteRow): Promise<void> {
  try {
    await matchRedis(ctx, server, s, site, true);
    ctx.info('Installing the Redis Object Cache plugin…');
    await wpOk(server, site, ['plugin', 'install', 'redis-cache', '--activate']);
    await wpOk(server, site, ['redis', 'enable']);
    const status = await wpOk(server, site, ['redis', 'status']);
    if (!/^\s*Status:\s*Connected/im.test(status)) throw new Error('The plugin could not reach Redis.');
    updateSiteRow(s.db, site.id, { objectCache: 1 });
    ctx.info('The object cache is on.');
  } catch (err) {
    // Redis runs only on a site that uses it.
    await matchRedis(ctx, server, s, site, false).catch((stopErr: unknown) => {
      ctx.warn(`Could not stop Redis again: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
    });
    throw err;
  }
}

/** The plugin stays installed, switched off. A second go only needs to turn it on again. */
async function switchOff(ctx: JobContext<unknown>, s: CoreServices, server: ServerHandle, site: SiteRow): Promise<void> {
  // Each of these fails if someone removed the plugin by hand, which is no reason to keep Redis.
  for (const args of [['redis', 'disable'], ['plugin', 'deactivate', 'redis-cache']]) {
    const res = await server.wp.run(site.containerName, args, WP_MS);
    if (res.exitCode !== 0) ctx.warn(`wp ${args.join(' ')}: ${said(res)}`);
  }
  await matchRedis(ctx, server, s, site, false);
  updateSiteRow(s.db, site.id, { objectCache: 0 });
  ctx.info('The object cache is off.');
}
