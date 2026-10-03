import { z } from 'zod';
import type { CoreServices } from '../../services/index.js';
import { runInventory } from '../../services/scanEngines.js';
import { siteImage, sitePaths } from '../../services/siteSpec.js';
import type { JobContext } from '../context.js';
import { loadSite } from './shared.js';
import { requireRunning } from './wp.js';

export const siteMalwareScanPayload = z.object({
  siteId: z.number().int(),
  trigger: z.enum(['schedule', 'manual', 'rescan']).default('manual'),
});

/**
 * One site's malware scan (services/malwareScan.ts). Its own lane, `scan:<serverId>`, and no
 * site id on the job: an hour of scanning must not keep that site's other jobs waiting.
 *
 * Red only when nothing could be scanned at all. A scan that got part of the way is a green
 * job with its gaps in the log and on the site's Security tab - where "incomplete" is shown
 * instead of "clean".
 */
export async function siteMalwareScan(ctx: JobContext<z.infer<typeof siteMalwareScanPayload>>, s: CoreServices): Promise<void> {
  const result = await s.malwareScan.scan(ctx, ctx.payload.siteId, ctx.payload.trigger, ctx.jobId);
  // The site's on-finding setting, and the alert - before a failure turns the job red, so
  // three failed scans in a row are still mailed about.
  const after = await s.malwareScan.followUp(ctx, s.worker, ctx.payload.siteId, result);
  ctx.setResult({
    scanId: result.scanId,
    outcome: result.outcome,
    open: result.open,
    new: result.newFindings.length,
    files: result.files,
    quarantined: after.moved.length,
    alerted: after.alerted,
  });
  if (result.problem) ctx.warn(result.problem);
  if (result.outcome === 'failed') throw new Error(result.problem ?? 'The scan failed');
  const found = result.newFindings.length;
  ctx.info(
    result.outcome === 'clean'
      ? 'Nothing found.'
      : result.outcome === 'superseded'
        ? 'Superseded; it runs again shortly.'
        : `${result.open} open finding(s)${found > 0 ? `, ${found} new` : ''}.`,
  );
}

export const pluginZipCheckPayload = z.object({ pluginId: z.number().int() });

/**
 * One catalog zip's malware check (services/pluginZipChecks.ts), in the panel server's scan
 * lane. Red when nothing could be checked; a check with gaps is green, with them in the log.
 */
export async function pluginZipCheck(ctx: JobContext<z.infer<typeof pluginZipCheckPayload>>, s: CoreServices): Promise<void> {
  const result = await s.pluginZipChecks.run(ctx, ctx.payload.pluginId);
  ctx.setResult(result);
}

export const wpReinstallPayload = z.object({
  siteId: z.number().int(),
  /** 'core', or 'plugin:<slug>' of a plugin from the wordpress.org directory. */
  package: z.string().regex(/^(core|plugin:[a-z0-9][a-z0-9_.-]{0,99})$/),
});

/**
 * "Reinstall original" for a package whose files a scan found changed: the same version,
 * downloaded again from wordpress.org over the site's own copy. The version comes from the
 * files' headers, read in a throwaway container - never from running the site's code - and
 * WP-CLI itself runs with every plugin and theme skipped. A scan is queued to show the result.
 */
export async function wpReinstall(ctx: JobContext<z.infer<typeof wpReinstallPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const inventory = await runInventory(server, siteImage(site.phpVersion), sitePaths(s.config, site.slug).wordpress, 2 * 60_000);
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    if (ctx.payload.package === 'core') {
      if (!inventory.core) throw new Error("No WordPress was found in the site's folder");
      const { version, locale } = inventory.core;
      ctx.info(`Downloading WordPress ${version}${locale ? ` (${locale})` : ''} again from wordpress.org…`);
      await server.wp.runOk(
        site.containerName,
        ['core', 'download', `--version=${version}`, ...(locale ? [`--locale=${locale}`] : []), '--force', '--skip-content'],
        10 * 60_000,
      );
      ctx.setResult({ package: 'core', version });
    } else {
      const slug = ctx.payload.package.slice('plugin:'.length);
      const plugin = inventory.plugins.find((p) => p.slug === slug && !p.single);
      if (!plugin?.version) throw new Error(`The plugin "${slug}" is not installed, or does not say which version it is`);
      ctx.info(`Downloading ${slug} ${plugin.version} again from wordpress.org…`);
      await server.wp.runOk(
        site.containerName,
        ['plugin', 'install', slug, `--version=${plugin.version}`, '--force', '--skip-plugins', '--skip-themes'],
        10 * 60_000,
      );
      ctx.setResult({ package: ctx.payload.package, version: plugin.version });
    }
  } finally {
    await restoreState();
  }
  const { job } = s.malwareScan.request(s.worker, site, 'rescan');
  ctx.info(`Queued a scan to confirm the files are the published ones (job #${job.id}).`);
}
