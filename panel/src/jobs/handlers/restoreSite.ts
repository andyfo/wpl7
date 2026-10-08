// @docs sites/move
import path from 'node:path';
import type { SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { buildSiteContainerSpec, sitePaths, siteRuntimeFrom, siteTlsFor } from '../../services/siteSpec.js';
import { ensureSiteNetwork, removeSiteNetwork } from '../../services/siteNetwork.js';
import { ensureSiteMountSources, probeSite, startSiteContainer, syncRelayAuth } from './shared.js';
import { rmOn } from './moveHelpers.js';

/**
 * Where a site that does not exist on a server yet comes from:
 * - `archive`: a backup's two files (the move's staged snapshot). The archive holds the site's
 *   whole folder, so it is unpacked into the site's root; the dump is the panel's own, imported
 *   as root.
 * - `tree`: a WordPress folder already laid out on that server (an import's pull), moved into
 *   place in one rename - the staging folder is on the same filesystem. The dump came from
 *   another host, so it is imported as the site's own database user.
 */
export type StagedSiteSource =
  | { kind: 'archive'; filesTarGz: string; dbSqlGz: string }
  | { kind: 'tree'; wordpressDir: string; dbSqlGz: string };

/**
 * The site's protection pin (SecurityService.pin), held from just before its container is created.
 * A holder rather than a return value: when a later step fails, the caller still has to release
 * it - after its rollback has removed the container, which is the order the move has always kept.
 */
export interface ProtectionHold {
  release: (() => void) | null;
}

/**
 * Bring a site up on a server it does not exist on yet, from staged files and a dump: files in
 * place, database, network, mail login, container, start - and a probe when asked. Every step
 * arms its compensation, so a caller that fails later rolls all of it back with
 * `ctx.runCompensations()`. Used by the move (`archive`) and by an import (`tree`).
 *
 * `routing: false` creates the container without a router, for a site that must not answer
 * before the caller has finished with it. `requireWpConfig` refuses a tree without
 * wp-config.php - a backup always has one; an import's never does (the image writes it at start).
 */
export async function restoreSiteOnServer(
  ctx: JobContext<unknown>,
  s: CoreServices,
  target: ServerHandle,
  site: SiteRow,
  domains: string[],
  source: StagedSiteSource,
  opts: {
    routing: boolean;
    requireWpConfig: boolean;
    protection: ProtectionHold;
    /** Runs once the files are in place and owned by the site, before the database. */
    afterFiles?: () => Promise<void>;
    /** Runs once the container has started, before the probe. */
    afterStart?: () => Promise<void>;
    /** The probe that gates the caller's next step, and the line logged before it; null = none. */
    probe: { host: string; timeoutMs: number; message: string } | null;
  },
): Promise<void> {
  const paths = sitePaths(s.config, site.slug);

  ctx.info('Restoring files on the target…');
  await target.files.mkdirp(paths.root);
  if (source.kind === 'archive') {
    ctx.pushCompensation('remove site files on target', async () => {
      await rmOn(target, s.config.paths.sites, site.slug);
    });
    const untar = await target.exec.run('tar', ['-xzf', source.filesTarGz, '-C', paths.root], {
      timeoutMs: 60 * 60_000,
    });
    if (untar.exitCode !== 0) throw new Error(`File extraction failed: ${untar.stderr.slice(0, 300)}`);
  } else {
    // Back where they came from on a rollback, so a retry does not have to pull them again.
    ctx.pushCompensation('move site files back to staging', async () => {
      if (await target.files.exists(paths.wordpress)) await target.files.rename(paths.wordpress, source.wordpressDir);
      await rmOn(target, s.config.paths.sites, site.slug);
    });
    await target.files.rename(source.wordpressDir, paths.wordpress);
  }
  if (opts.requireWpConfig && !(await target.files.exists(path.join(paths.wordpress, 'wp-config.php')))) {
    throw new Error('Extracted tree has no wordpress/wp-config.php');
  }
  // The archive carries the site's config directory, but one taken before these mounts
  // existed does not - and a bind mount with no source on the target costs the site its
  // container there (see ensureSiteMountSources).
  await ensureSiteMountSources(target, s, site, ctx);
  await s.backup.chownWordpress(target, site.slug, (l, m) => ctx.log(l, m));
  await opts.afterFiles?.();

  // Compensations from here on are armed before the step they undo, and each tolerates the
  // resource not existing: a step can fail half-way (the database created, its user not) and
  // must not leave what it did make behind (see site.create).
  ctx.info(`Creating database ${site.dbName} on the target…`);
  ctx.pushCompensation('drop database on target', async () => {
    await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
  });
  await target.dbAdmin.createSiteDb(site.dbName, site.dbUser, site.dbPassword);
  ctx.info('Importing the database…');
  if (source.kind === 'archive') await target.dbAdmin.importFrom(source.dbSqlGz, site.dbName);
  else await target.dbAdmin.importFromAs(source.dbSqlGz, site.dbName, site.dbUser, site.dbPassword);
  ctx.checkCanceled();

  ctx.info('Creating the site network on the target…');
  ctx.pushCompensation('remove site network on target', () => removeSiteNetwork(target.docker, site.slug));
  const attached = await ensureSiteNetwork(target.docker, site.slug);
  if (attached.missing.length > 0) {
    ctx.warn(`Not attached to the site network on "${target.name}": ${attached.missing.join(', ')}.`);
  }
  // A site the target has never seen has no SASL login there yet - without this, wp_mail()
  // authenticates against nothing.
  await syncRelayAuth(ctx, s, site.slug);

  ctx.info('Starting the site on the target…');
  opts.protection.release = s.security.pin(target.id, site.id);
  await s.security.kick(target.id);
  ctx.pushCompensation('remove container on target', async () => {
    await target.docker.removeContainer(site.containerName);
  });
  await target.docker.createSiteContainer(
    buildSiteContainerSpec(s.config, site, domains, siteTlsFor(s.dns, target.row), siteRuntimeFrom(s.settings), {
      routing: opts.routing,
    }),
  );
  await startSiteContainer(target, s, site, ctx);
  await opts.afterStart?.();

  if (opts.probe) {
    ctx.info(opts.probe.message);
    if (s.config.nodeEnv === 'test') {
      // No live HTTP in unit tests; the container state is the gate there.
      const state = await target.docker.containerState(site.containerName);
      if (state !== 'running') throw new Error('Site container is not running on the target - rolling back');
    } else {
      const up = await probeSite(target, site.containerName, opts.probe.host, opts.probe.timeoutMs);
      if (!up) throw new Error('Site did not answer on the target - rolling back (source untouched)');
    }
  }
  ctx.checkCanceled();
}
