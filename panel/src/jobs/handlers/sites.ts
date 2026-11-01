// @docs backups/delete, get-started/first-site, integrations/cloudflare, integrations/dns, panel/updating, sites/create, sites/domains, sites/settings
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { siteConnections, backups, moveCleanups, sites, type SiteRow } from '../../db/schema.js';
import { BACKUP_DELETE_LANE } from '../../services/backup.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { Config } from '../../config.js';
import type { JobContext } from '../context.js';
import {
  siteContainerSpec,
  siteImage,
  sitePaths,
  siteRollbackImage,
  siteRuntimeFrom,
  type SiteRuntime,
  type SpecSite,
} from '../../services/siteSpec.js';
import type { SiteStack } from '../../services/siteStack.js';
import { migrateArrivedFiles, migrateSiteForStack2, undoSiteMigration } from '../../services/siteMigration.js';
import {
  ensureSiteNetwork,
  legacySiteNetworkName,
  removeLegacySiteNetwork,
  removeSiteNetwork,
} from '../../services/siteNetwork.js';
import { mailLogin } from '../../services/mailAuth.js';
import { generateSecret } from '../../lib/crypto.js';
import { PluginSyncService } from '../../services/pluginSync.js';
import { assertDomainsFree } from '../../services/domainGuard.js';
import { safeJoin } from '../../lib/slug.js';
import {
  attachSiteNetwork,
  dnsPreflight,
  ensureSiteMountSources,
  loadSite,
  probeSite,
  probeSiteAttempt,
  restartSiteContainer,
  rewriteWordPressUrls,
  runLicenseHook,
  shouldSiteRun,
  siteDomains,
  siteUrl,
  startSiteContainer,
  syncRelayAuth,
  updateSiteRow,
  waitForWordPressFiles,
  writeSiteJson,
} from './shared.js';
import { requireRunning } from './wp.js';
import { isExternal } from '../../lib/siteKind.js';
import { parseSiteCacheRules } from '../../../shared/cacheRules.js';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------

export const siteCreatePayload = z.object({
  siteId: z.number().int(),
  adminPassword: z.string(),
  passwordGenerated: z.boolean(),
  pluginSlugs: z.array(z.string()),
  pluginZipPaths: z.array(z.string()),
  /** Default for jobs enqueued before the option existed - same answer the form gives. */
  discourageSearchEngines: z.boolean().default(true),
});

export async function siteCreate(ctx: JobContext<z.infer<typeof siteCreatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const domains = siteDomains(site);
  const primary = domains[0]!;
  const url = siteUrl(s.config, primary);
  const p = sitePaths(s.config, site.slug);
  const adminUser = site.wpAdminUser ?? 'admin';
  // Held from the moment the site gets a router until the row says it is running: its rules
  // file has to be there before the router is, and the row still says "provisioning" then.
  let releaseProtection: (() => void) | null = null;

  try {
    ctx.info(`Creating site "${site.slug}" at ${url} on server "${server.name}"`);
    await ensureDevDnsRecord(ctx, s, server, site.devHostname);
    await dnsPreflight(s.config, server.row, domains, ctx);
    ctx.checkCanceled();

    // Every compensation below is armed BEFORE the step it undoes, and every one of them
    // tolerates the resource not existing. Arming them afterwards meant a step that failed
    // half-way - createSiteContainer creates the container and then fails attaching the DB
    // network, createSiteDb creates the database and then fails creating the user - left
    // that resource behind with nothing registered to remove it. The rollback then looked
    // "clean", the site row was deleted to free the slug, and re-creating the same slug hit
    // a name conflict against the orphan.
    ctx.info('Preparing directories…');
    ctx.pushCompensation('remove site directory', async () => {
      await server.files.rm(safeJoin(s.config.paths.sites, site.slug));
    });
    await server.files.mkdirp(p.wordpress);
    await ensureSiteMountSources(server, s, site, ctx);
    await writeSiteJson(server, s.config, site);

    // The container is only ever a member of its own network plus the shared egress one, so
    // the network has to exist before it is created. Traefik, the relay and MariaDB are
    // attached here too - they are the only things a site is allowed to reach.
    ctx.info('Creating the site network…');
    ctx.pushCompensation('remove site network', () => removeSiteNetwork(server.docker, site.slug));
    await attachSiteNetwork(ctx, server, site.slug);

    ctx.info(`Creating database ${site.dbName}…`);
    ctx.pushCompensation('drop database and user', () => server.dbAdmin.dropSiteDb(site.dbName, site.dbUser));
    await server.dbAdmin.createSiteDb(site.dbName, site.dbUser, site.dbPassword);
    ctx.checkCanceled();

    await ensureSiteImage(ctx, server, s.config, site.phpVersion);
    ctx.checkCanceled();

    // Before the container starts, not after: `wp core install` sends the welcome mail, and
    // the relay refuses mail from a login it does not know yet.
    ctx.info('Registering the site with the mail relay…');
    await syncRelayAuth(ctx, s, site.slug);
    ctx.checkCanceled();

    // The container starts WITHOUT a Traefik router. Until `wp core install` has created our
    // administrator, WordPress serves its web installer to whoever reaches the hostname first,
    // and that visitor - not the panel - would own the site: wp-cli treats an already-installed
    // database as success, so the job would still report our (useless) credentials. Routing
    // is switched on further down, once the expected administrator verifiably exists.
    ctx.info('Creating and starting container (unrouted until WordPress is installed)…');
    ctx.pushCompensation('remove container', () => server.docker.removeContainer(site.containerName));
    await server.docker.createSiteContainer(await siteContainerSpec(s, server, site, domains, siteRuntimeFrom(s.settings, site), { routing: false }));
    await startSiteContainer(server, s, site, ctx);

    ctx.info('Waiting for WordPress files…');
    await waitForWordPressFiles(server.files, p.wordpress, ctx);
    ctx.checkCanceled();

    ctx.info('Installing WordPress…');
    await server.wp.coreInstall(site.containerName, {
      url,
      title: site.title,
      adminUser,
      adminPassword: ctx.payload.adminPassword,
      adminEmail: site.wpAdminEmail ?? 'admin@example.com',
    });
    if (!(await server.wp.userExists(site.containerName, adminUser))) {
      throw new Error(
        `WordPress reported a successful install, but the administrator "${adminUser}" does not exist - refusing to publish the site`,
      );
    }

    // WordPress leaves a site that was installed behind an unrouted container on plain
    // permalinks (see DEFAULT_PERMALINK_STRUCTURE), which looks like a working site right up
    // to the moment something asks it for /wp-json/. Done before the plugins, so any that
    // register rewrite rules of their own are activated against the final structure.
    ctx.info('Setting pretty permalinks…');
    try {
      await server.wp.rewriteStructure(site.containerName);
    } catch (err) {
      ctx.warn(
        `Could not set pretty permalinks (${errMsg(err)}); until they are set in Settings -> Permalinks, ` +
          'the REST API under /wp-json/ answers with the home page.',
      );
    }

    // A fresh install is public, and this one is about to answer on a dev hostname. Set
    // before the plugins so an SEO plugin sees the final value when it is activated.
    if (ctx.payload.discourageSearchEngines) {
      ctx.info('Asking search engines not to index this site…');
      try {
        await server.wp.searchEngineVisibility(site.containerName, false);
      } catch (err) {
        ctx.warn(`Could not discourage search engines (${errMsg(err)}); set it in Settings -> Reading.`);
      }
    }

    // Before the requested plugins, not after: a catalog that deliberately contains akismet
    // then puts it back, at the current wp.org version.
    ctx.info('Removing the plugins WordPress bundles (Akismet, Hello Dolly)…');
    try {
      const removed = await server.wp.deleteBundledPlugins(site.containerName, adminUser);
      ctx.info(removed.length > 0 ? `Removed ${removed.join(', ')}.` : 'None of them were present.');
    } catch (err) {
      ctx.warn(`Could not remove the bundled plugins (${errMsg(err)}); remove them from the site's WordPress tab.`);
    }

    if (site.locale && site.locale !== 'en_US') {
      ctx.info(`Installing language pack ${site.locale}…`);
      try {
        await server.wp.installLocale(site.containerName, site.locale);
      } catch (err) {
        ctx.warn(`Language install failed (site stays in English): ${errMsg(err)}`);
      }
    }

    for (const slug of ctx.payload.pluginSlugs) {
      ctx.checkCanceled();
      ctx.info(`Installing plugin ${slug}…`);
      try {
        await server.wp.installPluginSlug(site.containerName, slug, true, adminUser);
      } catch (err) {
        ctx.warn(`Plugin "${slug}" failed to install: ${errMsg(err)}`);
      }
    }
    for (const zipPath of ctx.payload.pluginZipPaths) {
      ctx.checkCanceled();
      ctx.info(`Installing plugin from ${zipPath}…`);
      try {
        await new PluginSyncService(s.db, s.config, s.servers).ensureZipOnServer(server, zipPath);
        await server.wp.installPluginZip(site.containerName, zipPath, true, adminUser);
      } catch (err) {
        ctx.warn(`Plugin zip "${zipPath}" failed to install: ${errMsg(err)}`);
      }
    }

    // Licensed plugins: hand over the keys and activate, now that every plugin is in place.
    // The container is still unrouted but already has its way out (the activation is a call
    // from the site to the vendor), and the URL it activates for is the dev hostname - the
    // go-live re-runs the recipes for the customer's domain.
    ctx.checkCanceled();
    await runLicenseHook(ctx, s, server, site, 'afterInstall', { url });

    ctx.info('Publishing the site (enabling its router)…');
    // Protection first (docs/security.md): the rules arrive before the router they guard.
    releaseProtection = s.security.pin(server.id, site.id);
    await s.security.kick(server.id);
    await server.docker.removeContainer(site.containerName);
    await server.docker.createSiteContainer(await siteContainerSpec(s, server, site, domains, siteRuntimeFrom(s.settings, site)));
    await startSiteContainer(server, s, site, ctx);

    ctx.info('Verifying site responds…');
    const up = await probeSite(server, site.containerName, primary, s.config.probeTimeoutMs);
    if (!up) ctx.warn('Site did not answer the smoke check yet - check container logs if it stays down.');
    if (s.config.tlsMode === 'letsencrypt') {
      ctx.info('HTTPS certificate is issued on first request; allow up to a minute after DNS is in place.');
    }

    updateSiteRow(s.db, site.id, { status: 'running' });
    releaseProtection?.();
    await writeSiteJson(server, s.config, loadSite(s.db, site.id));
    const result: Record<string, unknown> = { url, slug: site.slug };
    if (ctx.payload.passwordGenerated) result.adminPassword = ctx.payload.adminPassword;
    ctx.setResult(result);
    ctx.info(`Site created: ${url}`);
  } catch (err) {
    ctx.error(`Provisioning failed: ${errMsg(err)}`);
    const clean = await ctx.runCompensations();
    if (clean) {
      // Everything rolled back - remove the reservation so the slug can be retried immediately.
      s.db.delete(sites).where(eq(sites.id, site.id)).run();
      // Compensations run while the row still exists, so the relay credential can only be
      // pruned here - a login nobody holds is harmless, but leaving it is untidy.
      await s.mail.syncMailAuthEverywhere().catch(() => undefined);
      ctx.info('All resources rolled back; site removed.');
    } else {
      updateSiteRow(s.db, site.id, { status: 'error' });
      ctx.error('Some rollback steps failed - resolve via site Delete, which is safe to repeat.');
    }
    // A site that never came up has no rules to keep.
    if (releaseProtection) {
      releaseProtection();
      await s.security.kick(server.id);
    }
    throw err;
  }
}

/**
 * A create that was canceled while still queued never ran: nothing exists yet except the
 * row that reserves the slug. Without this the site stayed `provisioning` for ever - the
 * slug taken, start/stop refused - until someone worked out that Delete was the way out.
 */
export function siteCreateQueuedCancel(payload: z.infer<typeof siteCreatePayload>, s: CoreServices): void {
  const site = s.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
  if (!site || site.status !== 'provisioning') return;
  s.db.delete(sites).where(eq(sites.id, site.id)).run();
  s.log.info(`Site "${site.slug}": creation canceled before it started; the reservation was released`);
}

/**
 * Whether the dev wildcard record already sends `hostname` to this server, so it needs no record
 * of its own there. That record is `*.<DEV_DOMAIN>`, and it points at the wildcard server. A site
 * keeps the dev hostname it was created with wherever it moves, so one created on a server with a
 * dev domain of its own stays under that domain, which no record the panel knows of covers.
 */
export function wildcardCovers(
  s: Pick<CoreServices, 'settings' | 'config'>,
  serverId: number,
  hostname: string,
): boolean {
  const devDomain = s.config.devDomain.toLowerCase();
  if (!devDomain || !hostname.toLowerCase().endsWith(`.${devDomain}`)) return false;
  return serverId === (s.settings.get('dnsWildcardServerId') ?? 1);
}

/**
 * The dev wildcard record points at the wildcard server; a site it does not cover needs an
 * explicit per-site A record (specific beats wildcard). No-op when DNS management is off or
 * the wildcard covers the site where it lands.
 */
export async function ensureDevDnsRecord(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  devHostname: string | null,
): Promise<void> {
  if (!devHostname || !s.dns.enabled) return;
  if (wildcardCovers(s, server.id, devHostname)) return;
  if (!server.row.publicIp) {
    ctx.warn(`Server "${server.name}" has no public IP recorded; cannot create the DNS record for ${devHostname}.`);
    return;
  }
  try {
    const res = await s.dns.upsertA(devHostname, server.row.publicIp);
    if (res === 'updated') {
      ctx.info(`DNS: ${devHostname} -> ${server.row.publicIp} (managed record)`);
      ctx.pushCompensation('remove DNS record', async () => {
        await s.dns.deleteA(devHostname);
      });
    } else {
      ctx.warn(
        `DNS: the zone for ${devHostname} is not in the configured DNS account - ` +
          `create an A record to ${server.row.publicIp} manually.`,
      );
    }
  } catch (err) {
    ctx.warn(`DNS record update for ${devHostname} failed: ${errMsg(err)}`);
  }
}

export async function ensureSiteImage(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  config: Config,
  phpVersion: string,
): Promise<void> {
  const tag = siteImage(phpVersion);
  if (await server.docker.imageExists(tag)) return;
  ctx.info(`Building image ${tag} on "${server.name}" (first use of PHP ${phpVersion} - this pulls the WordPress base image)…`);
  // The build context is read panel-side by dockerode and shipped to the server's daemon.
  await server.docker.buildImage(tag, config.wpImageContext, { PHP_TAG: `php${phpVersion}` }, (line) =>
    ctx.info(line),
  );
  ctx.info(`Image ${tag} ready.`);
}

// ---------------------------------------------------------------------------

export const siteDeletePayload = z.object({
  siteId: z.number().int(),
  finalBackup: z.boolean(),
  /** Delete the backups the site already has, too - all but the final one, when one is taken. */
  deleteBackups: z.boolean().default(false),
});

export async function siteDelete(ctx: JobContext<z.infer<typeof siteDeletePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  if (isExternal(site)) return removeExternalSite(ctx, s, site);
  const server = s.servers.handleFor(site.serverId);
  updateSiteRow(s.db, site.id, { status: 'deleting' });
  // A site being deleted has no rules file: its routers would only point at a container
  // that is about to go.
  await s.security.kick(server.id);

  // A recently-moved site may still have its old copy parked on the source server.
  const { pendingCleanupFor, finalizeCleanup } = await import('./move.js');
  const pendingCleanup = pendingCleanupFor(s, site.id);
  if (pendingCleanup) {
    if (!s.servers.rowById(pendingCleanup.sourceServerId)) {
      ctx.warn(
        `The old copy from the last move was parked on server #${pendingCleanup.sourceServerId}, ` +
          `which no longer exists - nothing left to clean there.`,
      );
      s.db
        .update(moveCleanups)
        .set({ status: 'done', finalizedAt: Date.now() })
        .where(eq(moveCleanups.id, pendingCleanup.id))
        .run();
    } else {
      ctx.info('Cleaning up the parked copy from the last move first…');
      try {
        await finalizeCleanup(ctx, s, pendingCleanup);
      } catch (err) {
        // The row keeps the slug reserved until every resource this site owns is gone.
        // Deleting it while the parked copy survived meant the pending cleanup outlived the
        // site - and a later site that re-used the slug inherited it: the daily finalize then
        // tore down the NEW site's container, database and files, which carry the same names.
        updateSiteRow(s.db, site.id, { status: 'error' });
        throw new Error(`Move cleanup on the old server failed - site NOT deleted; re-run delete to retry: ${errMsg(err)}`);
      }
    }
  }

  const p = sitePaths(s.config, site.slug);
  let finalBackupId: number | null = null;
  // Not there means nothing to back up. A check that failed means nothing at all: taken for
  // "not there", it would delete the site without the backup that was asked for.
  const hasFiles =
    ctx.payload.finalBackup &&
    (await server.files.exists(p.wordpress).catch((err: unknown) => {
      updateSiteRow(s.db, site.id, { status: 'error' });
      throw new Error(`Could not check the site's files for its final backup - site NOT deleted: ${errMsg(err)}`);
    }));
  if (hasFiles) {
    ctx.info('Taking final backup…');
    s.monitor.busySlugs.add(site.slug);
    try {
      finalBackupId = (await s.backup.create(site, 'final', { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m) })).id;
    } catch (err) {
      updateSiteRow(s.db, site.id, { status: 'error' });
      throw new Error(`Final backup failed - site NOT deleted: ${errMsg(err)}`);
    } finally {
      s.monitor.busySlugs.delete(site.slug);
    }
  }

  // What the site's plugins want done before it goes: release their activations (Breakdance
  // counts sites, ACF PRO counts production URLs). Best effort - a vendor that cannot be
  // reached must not keep a site from being deleted.
  await releaseLicenses(ctx, s, server, site);

  // Teardown is absence-tolerant and safe to repeat, but any of these can still fail
  // (server unreachable mid-delete). Leaving the row on 'deleting' would then wedge the
  // site for good: every action route refuses while a site is deleting, so not even a
  // retry is possible. 'error' is retryable.
  const hadFtp = s.ftp.hasLogins(site.id);
  try {
    ctx.info('Removing container…');
    await server.docker.removeContainer(site.containerName);
    if (hadFtp) {
      // Before the files go: its FTP file server has them mounted.
      ctx.info('Removing FTP/SFTP access…');
      await s.ftp.removeSite(server.id, site.slug);
    }

    ctx.info(`Dropping database ${site.dbName}…`);
    await server.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
    for (const name of s.databases.extraNames(site.id)) {
      ctx.info(`Dropping database ${name}…`);
      await server.dbAdmin.dropDb(name);
    }

    ctx.info('Removing site files…');
    await server.files.rm(safeJoin(s.config.paths.sites, site.slug));

    ctx.info('Removing the site network…');
    await removeSiteNetwork(server.docker, site.slug);
  } catch (err) {
    updateSiteRow(s.db, site.id, { status: 'error' });
    ctx.error('Teardown failed part-way; the site is marked "error". Delete is safe to re-run.');
    throw err;
  }

  if (site.devHostname && s.dns.enabled) {
    // Best-effort: the explicit record only exists for sites off the wildcard server.
    await s.dns
      .deleteA(site.devHostname)
      .then((res) => res === 'deleted' && ctx.info(`DNS: removed record for ${site.devHostname}`))
      .catch((err) => ctx.warn(`DNS record cleanup failed: ${errMsg(err)}`));
  }

  s.db.delete(sites).where(eq(sites.id, site.id)).run();
  // Revokes the relay credential and drops the site's domains from the sender map, so the
  // login cannot outlive the site that owned it.
  await s.mail.syncMailAuthEverywhere().catch((err: unknown) => ctx.warn(`Mail relay cleanup failed: ${errMsg(err)}`));
  // Its FTP logins went with the row (cascade); the gateway forgets them - and goes, if they
  // were the last on the server.
  if (hadFtp) await s.ftp.kick(server.id);
  ctx.info(`Site "${site.slug}" deleted.`);
  // Last, once the site is really gone: a teardown that fails part-way leaves its backups as
  // they were, for a site that still exists.
  const backupDeleteJobId = ctx.payload.deleteBackups ? queueBackupDeletion(ctx, s, site, finalBackupId) : null;
  ctx.setResult({
    slug: site.slug,
    finalBackup: ctx.payload.finalBackup,
    ...(finalBackupId !== null ? { finalBackupId } : {}),
    ...(backupDeleteJobId !== null ? { backupDeleteJobId } : {}),
  });
}

/**
 * Remove a site hosted elsewhere from the panel. The site itself keeps running where it is: its
 * plugin is told to forget the panel (when it answers), the panel forgets its key, and its copy
 * on the backup server goes. Its backups stay, as a deleted site's do, unless asked otherwise. No
 * final backup: nothing is lost that the site does not still have.
 */
async function removeExternalSite(ctx: JobContext<z.infer<typeof siteDeletePayload>>, s: CoreServices, site: SiteRow): Promise<void> {
  updateSiteRow(s.db, site.id, { status: 'deleting' });
  const conn = s.connections.findForSite(site.id);
  if (conn?.privateKey && conn.status === 'active') {
    ctx.info('Disconnecting WPL7 Connect on the site…');
    const client = s.connections.clientFor(conn, { attempts: 2 });
    try {
      await client.disconnect();
      ctx.info('The plugin forgot the panel. It stays installed on the site until someone removes it there.');
    } catch (err) {
      ctx.warn(`The site did not answer (${errMsg(err)}); its plugin still holds the panel's public key, which nothing can sign for any more.`);
    } finally {
      client.close();
    }
  }
  try {
    ctx.info("Removing the site's copy from the backup server…");
    await s.externalBackups.forgetMirror(site);
  } catch (err) {
    // Housekeeping removes a copy whose site is gone; it is no reason to keep the site listed.
    ctx.warn(`Could not remove the copy (${errMsg(err)}); it is cleared away within a week.`);
  }
  s.db.transaction(() => {
    if (conn) s.db.delete(siteConnections).where(eq(siteConnections.id, conn.id)).run();
    s.db.delete(sites).where(eq(sites.id, site.id)).run();
  });
  ctx.info(`"${site.slug}" was removed from the panel. The site keeps running elsewhere.`);
  const backupDeleteJobId = ctx.payload.deleteBackups ? queueBackupDeletion(ctx, s, site, null) : null;
  ctx.setResult({ slug: site.slug, removed: true, ...(backupDeleteJobId !== null ? { backupDeleteJobId } : {}) });
}

/**
 * Queue the deletion of the backups a deleted site already had - all but the one it is left
 * with, which is the final backup just taken. When one was asked for and could not be taken
 * (the files were already gone: a second attempt after a teardown that failed half-way), the
 * newest complete backup stays in its place, rather than nothing being left of a site whose
 * owner asked for a last backup.
 *
 * Queued rather than done here: removing remote copies is minutes of rclone, and this job
 * holds the server's lane - every other site on the machine would wait for the bucket.
 */
function queueBackupDeletion(
  ctx: JobContext<z.infer<typeof siteDeletePayload>>,
  s: CoreServices,
  site: SiteRow,
  finalBackupId: number | null,
): number | null {
  // By slug, as the site's Backups tab lists them; the panel's own snapshots are never a site's.
  const rows = s.db
    .select()
    .from(backups)
    .where(and(eq(backups.siteSlug, site.slug), ne(backups.type, 'panel')))
    .orderBy(desc(backups.createdAt), desc(backups.id))
    .all();
  let kept = finalBackupId === null ? undefined : rows.find((r) => r.id === finalBackupId);
  if (!kept && ctx.payload.finalBackup) {
    kept = rows.find((r) => r.status === 'complete');
    if (kept) {
      const when = new Date(kept.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      ctx.warn(
        `No final backup could be taken - the site's files were already gone - so its newest backup, ` +
          `#${kept.id} (${kept.type}, ${when} UTC), is the one kept instead.`,
      );
    }
  }
  // Oldest first, as a bulk delete goes: stopped half-way, it has spared the newest.
  const doomed = rows.filter((r) => r.id !== kept?.id).reverse();
  if (doomed.length === 0) {
    ctx.info(kept ? 'It had no other backups to delete.' : 'It had no backups to delete.');
    return null;
  }
  try {
    const job = s.worker.enqueue(
      'backup.delete',
      { backupIds: doomed.map((r) => r.id), parentJobId: ctx.jobId },
      undefined,
      { lane: BACKUP_DELETE_LANE, siteSlug: site.slug },
    );
    const n = doomed.length;
    ctx.info(
      `${kept ? `Its ${n} other backup${n === 1 ? '' : 's'}` : `Its ${n} backup${n === 1 ? '' : 's'}`} ` +
        `${n === 1 ? 'is' : 'are'} deleted next, remote copies included: job #${job.id}.`,
    );
    return job.id;
  } catch (err) {
    ctx.warn(`Could not queue the deletion of its backups (${errMsg(err)}); delete them under Backups instead.`);
    return null;
  }
}

// ---------------------------------------------------------------------------

export const siteIdPayload = z.object({ siteId: z.number().int() });

export async function siteStart(ctx: JobContext<z.infer<typeof siteIdPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  ctx.info(`Starting ${site.containerName}…`);
  await startSiteContainer(server, s, site, ctx);
  updateSiteRow(s.db, site.id, { status: 'running' });
  await s.security.kick(server.id);
}

export async function siteStop(ctx: JobContext<z.infer<typeof siteIdPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  ctx.info(`Stopping ${site.containerName}…`);
  await server.docker.stopContainer(site.containerName);
  updateSiteRow(s.db, site.id, { status: 'stopped' });
  await s.security.kick(server.id);
}

export async function siteRestart(ctx: JobContext<z.infer<typeof siteIdPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  ctx.info(`Restarting ${site.containerName}…`);
  await restartSiteContainer(server, s, site, ctx);
  updateSiteRow(s.db, site.id, { status: 'running' });
}

// ---------------------------------------------------------------------------

/** What replaceContainer took away, for a caller that has to be able to put it back itself. */
export interface ReplacedContainer {
  /** The image the old container ran, by id, and the stack it was; null when there was none. */
  previous: { imageId: string; stack: SiteStack } | null;
  /** It has just moved to stack 2, and when it should run, it has answered already. */
  switched: boolean;
}

/**
 * Replace a site's container with one built from `next`. When creating or starting the
 * replacement fails, the `previous` spec is put back (and started when the site should be
 * running) before the error is rethrown - a Docker hiccup must never leave the site with no
 * container at all.
 *
 * What goes back is what the old container ran: its own image, by id, and its own stack, read
 * before anything is removed. The tag the site's spec names may have moved since that container
 * was made, and the image sweep replaces a container exactly because it has, so a rollback by
 * tag would "restore" the very image that just failed. With no old container there is only the tag.
 *
 * Going from stack 1 to stack 2 takes more than a new container: see switchToStack2.
 *
 * `row` is the registry row behind both specs; `next`/`previous` only differ from it in the
 * PHP version or the domain list. It is what the bind-mounted files are written from, which
 * has to happen before the create and not after: see ensureSiteMountSources for what a
 * missing one costs.
 */
export async function replaceContainer(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  s: CoreServices,
  runtime: SiteRuntime,
  row: SiteRow,
  next: { site: SpecSite; domains: string[] },
  previous: { site: SpecSite; domains: string[] },
  run: boolean,
): Promise<ReplacedContainer> {
  const name = next.site.containerName;
  const old = await server.docker.containerStack(name);
  const tag = siteImage(next.site.phpVersion);
  // Set when this site has already failed to move to the image the tag names: going through that
  // again would only fail a change of domains or a new database password for a reason of its own.
  let stayOn: { imageId: string; stack: SiteStack } | undefined;
  if (old?.stack === 1 && (await server.docker.imageStack(tag)) === 2) {
    if (loadSite(s.db, row.id).stackSwitchImage === (await server.docker.imageId(tag))) {
      ctx.warn('This site stays on the old PHP setup, because it could not move to the new one. Retry on its page tries again.');
      stayOn = old;
    } else {
      await switchToStack2(ctx, server, s, runtime, row, next, previous, run, old.imageId);
      return { previous: old, switched: true };
    }
  }
  await ensureSiteMountSources(server, s, row, ctx);
  // Idempotent, and the reason a site created before per-site networking gets one the first
  // time anything recreates its container.
  await ensureSiteNetwork(server.docker, next.site.slug);
  await server.docker.removeContainer(name);
  try {
    await server.docker.createSiteContainer(await siteContainerSpec(s, server, next.site, next.domains, runtime, stayOn ? { from: stayOn } : {}));
    // With no old container there is nothing to say what these files were last run on. They may
    // well be a stack 1 site's: a switch that could not put its old container back leaves just that.
    if (!old) await migrateArrivedFiles(ctx, server, s, { ...row, phpVersion: next.site.phpVersion });
    if (run) await startSiteContainer(server, s, row, ctx);
  } catch (err) {
    ctx.error(`Replacing the container failed (${errMsg(err)}); putting the previous one back…`);
    try {
      await server.docker.removeContainer(name);
      await server.docker.createSiteContainer(
        await siteContainerSpec(s, server, previous.site, previous.domains, runtime, old ? { from: old } : {}),
      );
      if (run) await startSiteContainer(server, s, row, ctx);
      ctx.info('Previous container restored.');
    } catch (restoreErr) {
      ctx.error(
        `Could not restore the previous container either: ${errMsg(restoreErr)}. ` +
          `The site has no container right now - "Recreate container" on the site page rebuilds it.`,
      );
    }
    throw err;
  }
  return { previous: old, switched: false };
}

/** Why a site's page cache stays off from the moment it moves: shown on its Caching card. */
export const GEOLOCATE_OFF_REASON = "WooCommerce's Geolocate setting changes prices by country at the same address, so pages can't be stored.";

/**
 * A WooCommerce store set to plain Geolocate shows prices by the visitor's country at one and the
 * same address, with no cookie to skip on, so a stored page would show one country's prices to all.
 * Such a store gets the one explicit Off there is, and its card says why. Only a site that hasn't
 * chosen: an On it asked for is its own. wp-cache.php refuses to store such a page at run time too,
 * which is why a check that can't be made here counts for nothing.
 */
async function keepGeolocateStoreOff(ctx: JobContext<unknown>, server: ServerHandle, s: CoreServices, row: SiteRow): Promise<void> {
  const current = loadSite(s.db, row.id);
  if (current.pageCache !== null) return;
  try {
    const skip = ['--skip-plugins', '--skip-themes'];
    const active = await server.wp.run(row.containerName, ['plugin', 'is-active', 'woocommerce', ...skip], 30_000);
    if (active.exitCode !== 0) return;
    if ((await server.wp.optionGet(row.containerName, 'woocommerce_default_customer_address', { skipExtensions: true })) !== 'geolocation') return;
  } catch {
    return;
  }
  const rules = parseSiteCacheRules(current.cacheRules);
  updateSiteRow(s.db, row.id, { pageCache: 'off', cacheRules: JSON.stringify({ ...rules, offReason: GEOLOCATE_OFF_REASON }) });
  ctx.warn(`The page cache stays off for this site. ${GEOLOCATE_OFF_REASON}`);
}

/** What a failed step says about itself, one line of it. */
const failedStep = (what: string, err: unknown): string => `${what}: ${errMsg(err).split('\n')[0]!.slice(0, 300)}`;

/**
 * Move a site from Apache with mod_php to nginx, Apache and PHP-FPM. replaceContainer sends a stack
 * 1 site here when its image has become stack 2, so whatever recreates the container of a running
 * site does this: the image sweep, a change of PHP or of domains, a new database password.
 *
 * A site that doesn't come up on the new setup goes back to the container it had, on its own image
 * by id, and keeps working the way it did: the job fails saying why, and the site's page says it
 * too. From then on it stays on that image, through whatever else recreates its container, until
 * there is another image to try, or someone presses Retry (siteReconcile's retrySwitch).
 *
 * The old image gets a name first, because nothing else can be undone without it: it may have none
 * by now, and then nothing keeps it once its container has gone. The name comes off at the end
 * (dropRollbackName), on every path but one: when the old container could not be put back, that
 * image is what somebody would need.
 */
async function switchToStack2(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  s: CoreServices,
  runtime: SiteRuntime,
  row: SiteRow,
  next: { site: SpecSite; domains: string[] },
  previous: { site: SpecSite; domains: string[] },
  run: boolean,
  oldImageId: string,
): Promise<void> {
  const { docker } = server;
  const name = next.site.containerName;
  const failedOn = await docker.imageId(siteImage(next.site.phpVersion));
  const rollbackTag = siteRollbackImage(next.site.slug);
  const host = next.domains[0]!;
  ctx.info('Moving this site from Apache with mod_php to nginx, Apache and PHP-FPM. If it does not come up on them, its old container comes back.');

  const running = (await docker.containerState(name)) === 'running';
  // Only a site that answers now can be said to have stopped answering. A broken site is not the
  // new setup's fault, and would otherwise be kept on the old PHP for as long as it stays broken.
  // It gets as long as the check afterwards: taking a site that had a bad moment for a broken one
  // costs it its way back.
  const before = run && running ? await siteAnswers(server, s, name, host, s.config.probeTimeoutMs) : null;
  const answeredBefore = before?.ok === true;
  if (running) await keepGeolocateStoreOff(ctx, server, s, row);

  await ensureSiteMountSources(server, s, row, ctx);
  await ensureSiteNetwork(docker, next.site.slug);

  // Its script runs in the image the site is going to, which is there for certain and has the PHP
  // whose rules it has to follow. The old PHP's tag may have gone long ago.
  const toMigrate = { ...row, phpVersion: next.site.phpVersion };
  let tagged = false;
  let migrated = false;
  let removed = false;
  let oldNameStillNeeded = false;
  let failing = '';
  try {
    failing = 'the old image could not be kept for going back';
    await docker.tagImage(oldImageId, rollbackTag);
    tagged = true;
    ctx.info(`The old image is kept as ${rollbackTag} until this is over.`);

    failing = 'the PHP settings in its .htaccess files could not be moved';
    ctx.info('Moving the PHP settings in the .htaccess files…');
    // Before the call: one that fails half-way has changed some of them.
    migrated = true;
    await migrateSiteForStack2(ctx, server, s, toMigrate);

    failing = 'the old container could not be removed';
    ctx.info('Replacing the container…');
    await docker.removeContainer(name);
    removed = true;
    failing = 'the new container could not be created';
    await docker.createSiteContainer(await siteContainerSpec(s, server, next.site, next.domains, runtime));

    if (run) {
      failing = 'the new container could not start';
      await startSiteContainer(server, s, row, ctx);
      ctx.info('Checking that the site answers…');
      const answer = await siteAnswers(server, s, name, host, s.config.probeTimeoutMs);
      if (!answer.ok && answeredBefore) {
        failing = 'the check on the new setup failed';
        throw new Error(answer.saw);
      }
      if (!answer.ok) {
        const earlier = before ? ` (${before.saw})` : '';
        ctx.warn(`The site did not answer before this move${earlier} and does not now (${answer.saw}), so it stays on the new setup.`);
      }
      else ctx.info('The site answers on the new setup.');
    } else {
      ctx.info('The site is stopped, so it stays stopped, and has not been checked on the new setup.');
    }
    updateSiteRow(s.db, row.id, { stackSwitchError: null, stackSwitchImage: null });
  } catch (err) {
    const why = failedStep(failing, err);
    ctx.error(`This site could not move: ${why}.`);
    if (migrated) {
      ctx.info('Putting the .htaccess files back…');
      // Nothing here may stop the old container from coming back.
      await undoSiteMigration(ctx, server, s, toMigrate).catch((undoErr: unknown) => ctx.error(`Could not put the .htaccess files back: ${errMsg(undoErr)}.`));
    }
    let notBack: string | null = null;
    if (removed) {
      ctx.info('Putting the old container back, on its own image…');
      try {
        await docker.removeContainer(name);
        await docker.createSiteContainer(
          await siteContainerSpec(s, server, previous.site, previous.domains, runtime, { from: { imageId: oldImageId, stack: 1 } }),
        );
        if (run) await startSiteContainer(server, s, row, ctx);
        ctx.info('The old container is back.');
      } catch (restoreErr) {
        notBack = failedStep('the old container could not be put back', restoreErr);
        oldNameStillNeeded = true;
      }
    }
    updateSiteRow(s.db, row.id, { stackSwitchError: notBack ? `${why}, and ${notBack}` : why, stackSwitchImage: failedOn });
    if (notBack) {
      throw new Error(
        `This site could not move to the new PHP setup (${why}), and ${notBack}. ` +
          `It has no container right now - "Recreate container" on the site page rebuilds it.`,
      );
    }
    throw new Error(`This site still runs the old PHP setup: ${why}.`);
  } finally {
    if (tagged) await dropRollbackName(ctx, docker, rollbackTag, oldNameStillNeeded);
  }
}

/** Take the temporary name off the old image. Never a reason to fail: the housekeeping tries again. */
async function dropRollbackName(ctx: JobContext<unknown>, docker: ServerHandle['docker'], tag: string, stillNeeded: boolean): Promise<void> {
  if (stillNeeded) {
    ctx.info(`The old image stays as ${tag}, until the nightly clean-up finds nothing needs it.`);
    return;
  }
  try {
    if (await docker.untagImage(tag)) ctx.info(`The temporary name ${tag} is gone.`);
    else ctx.info(`The old image keeps the name ${tag} while only a stopped container uses it. The nightly clean-up takes it off when it can.`);
  } catch (err) {
    ctx.warn(`Could not remove the temporary name ${tag} (${errMsg(err)}). The nightly clean-up tries again.`);
  }
}

/**
 * How long one look at a site may take when a move hangs on it. The usual check gives up after 8 s,
 * but a slow home page is an answer, and all the more on a new setup whose OPcache is cold. Taken for
 * no answer, it would send back a site that was fine, or cost a slow site its way back.
 */
const MOVE_CHECK_ATTEMPT_MS = 30_000;

/**
 * Whether a site answers, and what the check saw when it doesn't. No live HTTP in unit tests: the
 * container state is the gate there, as in the handlers below.
 */
async function siteAnswers(server: ServerHandle, s: CoreServices, container: string, host: string, timeoutMs: number): Promise<{ ok: boolean; saw: string }> {
  if (s.config.nodeEnv === 'test') {
    const state = await server.docker.containerState(container);
    return { ok: state === 'running', saw: `its container is ${state}` };
  }
  const attempt = await probeSiteAttempt(server, container, host, timeoutMs, MOVE_CHECK_ATTEMPT_MS);
  return { ok: attempt.ok, saw: attempt.status === null ? 'nothing answered' : `it answered HTTP ${attempt.status}` };
}

export const siteChangePhpPayload = z.object({
  siteId: z.number().int(),
  phpVersion: z.string(),
});

export async function siteChangePhp(ctx: JobContext<z.infer<typeof siteChangePhpPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const oldVersion = site.phpVersion;
  const newVersion = ctx.payload.phpVersion;
  const domains = siteDomains(site);
  const state = await server.docker.containerState(site.containerName);

  // "Already on that version" is only true when the container actually exists: after an
  // interrupted switch the row may say one thing and Docker another.
  if (oldVersion === newVersion && state !== 'missing') {
    ctx.info(`Site already runs PHP ${newVersion}; nothing to do.`);
    return;
  }
  if (state === 'missing') ctx.warn('Site container is missing; it will be recreated.');
  // A container the panel lists as running comes back running unless it was stopped on
  // purpose (see shouldSiteRun).
  const shouldRun = shouldSiteRun(state, site);

  await ensureSiteImage(ctx, server, s.config, newVersion);
  ctx.checkCanceled();

  // The registry keeps the OLD version until the new container is up and answers. Writing
  // the new version first meant a failure while creating the container left the site with no
  // container and a row that claimed the new version - and a retry of that same version was
  // then short-circuited by the "already runs" check above.
  const candidate: SpecSite = { ...site, phpVersion: newVersion };
  ctx.info(`Recreating container with PHP ${newVersion} (files and database untouched)…`);
  const replaced = await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings, site), site, { site: candidate, domains }, { site, domains }, shouldRun);

  let up = true;
  if (shouldRun && !replaced.switched) {
    // No live HTTP in unit tests; the container state is the gate there (as in the move handler).
    up =
      s.config.nodeEnv === 'test'
        ? (await server.docker.containerState(site.containerName)) === 'running'
        : await probeSite(server, site.containerName, domains[0]!, s.config.probeTimeoutMs);
  }
  if (!up) {
    ctx.error(`Site is not responding on PHP ${newVersion}; rolling back to PHP ${oldVersion}.`);
    await server.docker.removeContainer(site.containerName);
    await server.docker.createSiteContainer(
      await siteContainerSpec(s, server, site, domains, siteRuntimeFrom(s.settings, site), replaced.previous ? { from: replaced.previous } : {}),
    );
    await startSiteContainer(server, s, site, ctx);
    throw new Error(`PHP ${newVersion} switch failed the smoke check; rolled back to ${oldVersion}`);
  }
  updateSiteRow(s.db, site.id, { phpVersion: newVersion });
  await writeSiteJson(server, s.config, loadSite(s.db, site.id));
  ctx.info(`Site now runs PHP ${newVersion}.`);
  ctx.setResult({ phpVersion: newVersion });
}

// ---------------------------------------------------------------------------

export const siteReconcilePayload = z.object({
  siteId: z.number().int(),
  /** Someone asked for this: a site whose move to stack 2 failed tries again, on the same image. */
  retrySwitch: z.boolean().optional(),
});

/**
 * Bring one site up to the current isolation policy.
 *
 * Everything a site's security depends on outside its own files - which networks it is on,
 * which capabilities its container keeps, what it may claim as a sender - is applied when
 * the container is created. A site created before a policy change keeps the old one until
 * something recreates it, which is why this exists as an explicit, resumable job rather
 * than a surprise during an unrelated operation: it mints the relay credential if the site
 * predates per-site mail auth, writes its msmtp config, creates its network, and recreates
 * the container from the current spec.
 *
 * A container that doesn't come up goes back to what it was, in two ways. Docker refusing to create
 * or start the replacement puts the old one back, on its own image (replaceContainer), and so does
 * a site moving to stack 2 that then doesn't answer (switchToStack2). For a site that stays on its
 * stack there is no such check: the same row and the same image, or a newer one the site has to
 * move to anyway, so a container that starts and then does not answer is left in place with a
 * warning, and this job can finish successfully on a site that is still not serving.
 *
 * A site whose move failed tries again when someone asks: this job is what Retry and Recreate
 * container on its page run. A sweep's reconcile leaves such a site on its old image.
 */
export async function siteReconcile(ctx: JobContext<z.infer<typeof siteReconcilePayload>>, s: CoreServices): Promise<void> {
  let site = loadSite(s.db, ctx.payload.siteId);
  if (ctx.payload.retrySwitch && site.stackSwitchImage !== null) {
    updateSiteRow(s.db, site.id, { stackSwitchImage: null });
    site = loadSite(s.db, site.id);
  }
  const server = s.servers.handleFor(site.serverId);
  const domains = siteDomains(site);
  const changed: string[] = [];

  if (!site.mailPassword) {
    ctx.info('Minting this site\'s mail relay credential…');
    updateSiteRow(s.db, site.id, { mailPassword: generateSecret(24) });
    site = loadSite(s.db, site.id);
    changed.push('relay credential');
  }

  ctx.info('Writing the files the container mounts (msmtp configuration, PHP limits)…');
  await ensureSiteMountSources(server, s, site, ctx);

  ctx.info('Creating/repairing the site network…');
  const before = await server.docker.containerNetworks(site.containerName);
  await attachSiteNetwork(ctx, server, site.slug);

  ctx.info('Registering the site with the mail relay…');
  await syncRelayAuth(ctx, s, site.slug);

  const state = await server.docker.containerState(site.containerName);
  const shouldRun = shouldSiteRun(state, site);
  ctx.info('Recreating the container with the current isolation policy…');
  const replaced = await replaceContainer(
    ctx,
    server,
    s,
    siteRuntimeFrom(s.settings, site),
    site,
    { site, domains },
    { site, domains },
    shouldRun,
  );
  if (replaced.switched) changed.push('moved to PHP-FPM');

  const after = await server.docker.containerNetworks(site.containerName);
  if (before.join() !== after.join()) changed.push(`networks ${before.join('+') || 'none'} -> ${after.join('+')}`);

  // LEGACY(ceo) - delete in 0.3.0. The container has just been recreated on wpl7_site_<slug>,
  // so the pre-rename network is down to its infrastructure endpoints and can go. Last,
  // because until the new container answers the old network is still the rollback target.
  if (await removeLegacySiteNetwork(server.docker, site.slug)) {
    changed.push(`removed ${legacySiteNetworkName(site.slug)}`);
  }

  if (replaced.switched && shouldRun) {
    // That move has just asked the site, with more patience, and said what it found.
  } else if (shouldRun) {
    const up =
      s.config.nodeEnv === 'test'
        ? (await server.docker.containerState(site.containerName)) === 'running'
        : await probeSite(server, site.containerName, domains[0]!, s.config.probeTimeoutMs);
    // Not fatal and not rolled back - see the note on this function. The job's own log is where
    // this has to be visible.
    if (!up) ctx.warn('Site did not answer the smoke check after reconciling; check its container logs.');
    else ctx.info('Site answered after reconciling.');
  } else {
    // Said out loud, because the container is rebuilt either way: a job that reports plain
    // success while leaving the site down is how a 404 goes unexplained.
    ctx.warn('The site was stopped before reconciling, so it has been left stopped. Use Start to bring it up.');
  }
  await writeSiteJson(server, s.config, loadSite(s.db, site.id));
  await s.security.kick(server.id);
  ctx.info(changed.length > 0 ? `Reconciled: ${changed.join('; ')}.` : 'Reconciled (already current).');
  ctx.setResult({ slug: site.slug, changed });
}

export const siteUpdateDomainsPayload = z.object({
  siteId: z.number().int(),
  domains: z.array(z.string()).min(1),
  keepDevAlias: z.boolean(),
  goLive: z.boolean(),
  manageDns: z.boolean().default(false),
  /**
   * Untick WordPress's "Discourage search engines" once the site answers on its real domains.
   * Go-live only. False for jobs queued before it existed, which left the setting alone.
   */
  allowSearchEngines: z.boolean().default(false),
});

/**
 * Domain change / go-live, ordered for zero downtime:
 * old hosts keep serving while the new ones are added and get their certificate,
 * then the canonical URL flips (option update + search-replace).
 */
export async function siteUpdateDomains(
  ctx: JobContext<z.infer<typeof siteUpdateDomainsPayload>>,
  s: CoreServices,
): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const oldDomains = siteDomains(site);
  const oldPrimary = oldDomains[0]!;

  const newList = [...ctx.payload.domains];
  if (ctx.payload.keepDevAlias && site.devHostname && !newList.includes(site.devHostname)) {
    newList.push(site.devHostname);
  }
  const newPrimary = newList[0]!;

  if (ctx.payload.manageDns && s.dns.enabled && server.row.publicIp) {
    for (const domain of ctx.payload.domains) {
      try {
        const res = await s.dns.upsertA(domain, server.row.publicIp);
        ctx.info(
          res === 'updated'
            ? `DNS: ${domain} -> ${server.row.publicIp} (managed record)`
            : `DNS: zone for ${domain} is not in the configured account - point its A record at ${server.row.publicIp} yourself.`,
        );
      } catch (err) {
        ctx.warn(`DNS update for ${domain} failed: ${errMsg(err)}`);
      }
    }
  }

  await dnsPreflight(s.config, server.row, newList, ctx);
  ctx.checkCanceled();

  const wasRunning = shouldSiteRun(await server.docker.containerState(site.containerName), site);

  // Phase 1: serve old + new hosts together (old primary stays canonical while certs issue).
  const transition = [oldPrimary, ...new Set([...oldDomains.slice(1), ...newList.filter((d) => d !== oldPrimary)])];
  ctx.info(`Adding ${newList.join(', ')} to the router (old domains keep serving)…`);
  await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings, site), site, { site, domains: transition }, { site, domains: oldDomains }, true);

  if (s.config.tlsMode !== 'none' && newPrimary !== oldPrimary) {
    ctx.info(`Waiting for ${newPrimary} to answer over HTTPS (certificate issuance)…`);
    const ok = await waitForHttps(newPrimary, s.config.tlsMode === 'letsencrypt', 90_000);
    if (!ok) {
      ctx.warn(
        `${newPrimary} did not answer with a valid certificate within 90s. ` +
          `Continuing anyway - Traefik keeps retrying; verify DNS points at this server.`,
      );
    }
  }
  ctx.checkCanceled();

  // Phase 2: flip canonical.
  // Re-check now, not just at enqueue time: certificate issuance above can take minutes,
  // and two go-lives for the same customer domain would otherwise both pass their
  // enqueue-time check and both write it. The loser gives its transition router back so
  // it stops competing with the winner for the contested hostname.
  try {
    assertDomainsFree(s, newList, { excludeSiteId: site.id, allowDevHostname: site.devHostname });
  } catch (err) {
    ctx.error('A domain in this request was claimed by another site while certificates were issuing.');
    await server.docker.removeContainer(site.containerName);
    await server.docker.createSiteContainer(await siteContainerSpec(s, server, site, oldDomains, siteRuntimeFrom(s.settings, site)));
    if (wasRunning) await startSiteContainer(server, s, site, ctx);
    throw err;
  }

  // Authorize the new hostnames at the relay before WordPress starts sending from them.
  // The registry row still says "old domains" at this point (see below), so they are passed
  // explicitly rather than read back from it.
  await syncRelayAuth(ctx, s, site.slug, newList.map((domain) => ({ domain, login: mailLogin(site.slug) })));

  // The registry row (sites.domains / isLive) is written LAST, once the final container is up
  // and WordPress has been rewritten. Committing it first meant a Docker or wp-cli failure
  // left routing, the row and the WordPress URLs disagreeing - and a retry then read the
  // already-committed primary as the "old" one, computed "nothing changed", and skipped the
  // rewrite for good (stale home/siteurl plus the alias redirect = redirect loop).
  const finalSite: SpecSite = { ...site };
  ctx.info(`Switching canonical domain to ${newPrimary}…`);
  await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings, site), site, { site: finalSite, domains: newList }, { site, domains: transition }, wasRunning);

  const newUrl = siteUrl(s.config, newPrimary);
  // A site going live stops asking search engines to stay away (decided in the Go live dialog).
  // In the same started-if-needed window as the rewrite; never a reason to fail a go-live.
  const allowSearch = ctx.payload.goLive && ctx.payload.allowSearchEngines;
  const inside = allowSearch
    ? async (container: string) => {
        ctx.info('Allowing search engines to index the site…');
        try {
          await server.wp.searchEngineVisibility(container, true);
        } catch (err) {
          ctx.warn(`Could not allow search engines (${errMsg(err)}); untick Discourage search engines in Settings -> Reading.`);
        }
      }
    : undefined;
  // Running sites are always asked what URL WordPress currently uses (an earlier, partially
  // applied attempt may have left the database ahead of or behind the row); a stopped site
  // is only started for the rewrite when the primary actually changes, or to allow search engines.
  if (wasRunning || newPrimary !== oldPrimary || allowSearch) {
    try {
      await rewriteWordPressUrls(ctx, s, server, site, siteUrl(s.config, oldPrimary), newUrl, wasRunning, { inside });
    } catch (err) {
      ctx.error(
        `WordPress URL rewrite failed (${errMsg(err)}); restoring the transition router so the old canonical ` +
          `keeps working. Re-run the domain change to retry.`,
      );
      await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings, site), site, { site, domains: transition }, { site, domains: transition }, wasRunning).catch(
        (restoreErr) => ctx.error(`Could not restore the transition router: ${errMsg(restoreErr)}`),
      );
      throw err;
    }
  }

  updateSiteRow(s.db, site.id, {
    domains: JSON.stringify(newList),
    keepDevAlias: ctx.payload.keepDevAlias ? 1 : 0,
    isLive: ctx.payload.goLive ? 1 : site.isLive,
  });
  await writeSiteJson(server, s.config, loadSite(s.db, site.id));
  // Row is authoritative again: re-sync so domains dropped from the site stop being owned by it.
  await syncRelayAuth(ctx, s);
  // Its rules name its hosts, so they follow the new list.
  await s.security.kick(server.id);
  const up = !wasRunning || (await probeSite(server, site.containerName, newPrimary, s.config.probeTimeoutMs));
  if (!up) ctx.warn('Site did not answer the post-change smoke check.');
  ctx.info(ctx.payload.goLive ? `Site is live at ${newUrl}` : 'Domains updated.');
  ctx.setResult({ url: newUrl, domains: newList });
}

/**
 * Run the recipes' `beforeRemove` hook; the container is started for it if it has to be.
 * Nothing in here may throw: the row already says "deleting", and an exception before the
 * teardown's own error handling would leave it there for good.
 */
async function releaseLicenses(ctx: JobContext<unknown>, s: CoreServices, server: ServerHandle, site: SiteRow): Promise<void> {
  try {
    if ((await server.docker.containerState(site.containerName)) === 'missing') return;
    // No restore of the stopped state afterwards: the container is removed right after this.
    await requireRunning(ctx, server, s, site);
    await runLicenseHook(ctx, s, server, site, 'beforeRemove', { url: siteUrl(s.config, siteDomains(site)[0]!) });
  } catch (err) {
    ctx.warn(`Could not release plugin licenses before deleting (${errMsg(err)}); free them at the vendor if the license counts sites.`);
  }
}

async function waitForHttps(host: string, verifyCert: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://${host}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      await res.body?.cancel();
      return true;
    } catch {
      if (!verifyCert) return true; // staging certs never validate; do not block on them
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return false;
}
