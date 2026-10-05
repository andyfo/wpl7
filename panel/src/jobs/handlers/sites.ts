import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { moveCleanups, sites, type SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { Config } from '../../config.js';
import type { JobContext } from '../context.js';
import {
  buildSiteContainerSpec,
  siteImage,
  sitePaths,
  siteRuntimeFrom,
  type SiteRuntime,
} from '../../services/siteSpec.js';
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
  restartSiteContainer,
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

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What buildSiteContainerSpec needs to know about a site (a row, or a row with in-memory edits). */
type SpecSite = Parameters<typeof buildSiteContainerSpec>[1];

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
    await server.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, site, domains, server.row, siteRuntimeFrom(s.settings), { routing: false }),
    );
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
    await server.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, site, domains, server.row, siteRuntimeFrom(s.settings)),
    );
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
 * The dev wildcard record points at the wildcard server; sites elsewhere need an
 * explicit per-site A record (specific beats wildcard). No-op when DNS management
 * is off or the site lands on the wildcard server.
 */
export async function ensureDevDnsRecord(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  devHostname: string | null,
): Promise<void> {
  if (!devHostname || !s.dns.enabled) return;
  const wildcardServerId = s.settings.get('dnsWildcardServerId') ?? 1;
  if (server.id === wildcardServerId) return;
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
});

export async function siteDelete(ctx: JobContext<z.infer<typeof siteDeletePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
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
      await s.backup.create(site, 'final', { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m) });
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
  ctx.setResult({ slug: site.slug, finalBackup: ctx.payload.finalBackup });
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

/**
 * Replace a site's container with one built from `next`. When creating or starting the
 * replacement fails, the `previous` spec is put back (and started when the site should be
 * running) before the error is rethrown - a Docker hiccup must never leave the site with no
 * container at all.
 *
 * `row` is the registry row behind both specs; `next`/`previous` only differ from it in the
 * PHP version or the domain list. It is what the bind-mounted files are written from, which
 * has to happen before the create and not after: see ensureSiteMountSources for what a
 * missing one costs.
 */
async function replaceContainer(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  s: CoreServices,
  runtime: SiteRuntime,
  row: SiteRow,
  next: { site: SpecSite; domains: string[] },
  previous: { site: SpecSite; domains: string[] },
  run: boolean,
): Promise<void> {
  const name = next.site.containerName;
  await ensureSiteMountSources(server, s, row, ctx);
  // Idempotent, and the reason a site created before per-site networking gets one the first
  // time anything recreates its container.
  await ensureSiteNetwork(server.docker, next.site.slug);
  await server.docker.removeContainer(name);
  try {
    await server.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, next.site, next.domains, server.row, runtime),
    );
    if (run) await startSiteContainer(server, s, row, ctx);
  } catch (err) {
    ctx.error(`Replacing the container failed (${errMsg(err)}); putting the previous one back…`);
    try {
      await server.docker.removeContainer(name);
      await server.docker.createSiteContainer(
        buildSiteContainerSpec(s.config, previous.site, previous.domains, server.row, runtime),
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
  await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings), site, { site: candidate, domains }, { site, domains }, shouldRun);

  let up = true;
  if (shouldRun) {
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
      buildSiteContainerSpec(s.config, site, domains, server.row, siteRuntimeFrom(s.settings)),
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

export const siteReconcilePayload = z.object({ siteId: z.number().int() });

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
 * There is no rollback on a failed smoke check, and there is nothing to roll back TO: the
 * `next` and `previous` specs handed to replaceContainer are the same site row, so putting
 * "the previous one" back would rebuild the identical container. replaceContainer's rollback
 * covers the other failure - Docker refusing to create or start the replacement. A container
 * that starts and then does not answer is left in place with a warning, so this job can
 * finish successfully on a site that is still not serving.
 */
export async function siteReconcile(ctx: JobContext<z.infer<typeof siteReconcilePayload>>, s: CoreServices): Promise<void> {
  let site = loadSite(s.db, ctx.payload.siteId);
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
  await replaceContainer(
    ctx,
    server,
    s,
    siteRuntimeFrom(s.settings),
    site,
    { site, domains },
    { site, domains },
    shouldRun,
  );

  const after = await server.docker.containerNetworks(site.containerName);
  if (before.join() !== after.join()) changed.push(`networks ${before.join('+') || 'none'} -> ${after.join('+')}`);

  // LEGACY(ceo) - delete in 0.3.0. The container has just been recreated on wpl7_site_<slug>,
  // so the pre-rename network is down to its infrastructure endpoints and can go. Last,
  // because until the new container answers the old network is still the rollback target.
  if (await removeLegacySiteNetwork(server.docker, site.slug)) {
    changed.push(`removed ${legacySiteNetworkName(site.slug)}`);
  }

  if (shouldRun) {
    const up =
      s.config.nodeEnv === 'test'
        ? (await server.docker.containerState(site.containerName)) === 'running'
        : await probeSite(server, site.containerName, domains[0]!, s.config.probeTimeoutMs);
    // Not fatal and not rolled back - see the note on this function for why there is no
    // earlier container to return to. The job's own log is where this has to be visible.
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
  await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings), site, { site, domains: transition }, { site, domains: oldDomains }, true);

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
    await server.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, site, oldDomains, server.row, siteRuntimeFrom(s.settings)),
    );
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
  await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings), site, { site: finalSite, domains: newList }, { site, domains: transition }, wasRunning);

  const newUrl = siteUrl(s.config, newPrimary);
  // Running sites are always asked what URL WordPress currently uses (an earlier, partially
  // applied attempt may have left the database ahead of or behind the row); a stopped site
  // is only started for the rewrite when the primary actually changes.
  if (wasRunning || newPrimary !== oldPrimary) {
    try {
      await rewriteWordPressUrls(ctx, s, server, site, siteUrl(s.config, oldPrimary), newUrl, wasRunning);
    } catch (err) {
      ctx.error(
        `WordPress URL rewrite failed (${errMsg(err)}); restoring the transition router so the old canonical ` +
          `keeps working. Re-run the domain change to retry.`,
      );
      await replaceContainer(ctx, server, s, siteRuntimeFrom(s.settings), site, { site, domains: transition }, { site, domains: transition }, wasRunning).catch(
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

/**
 * Point WordPress (home/siteurl + content) at `newUrl`. The current URL is read from
 * WordPress itself rather than derived from the registry row, so the rewrite is resumable:
 * whatever an earlier attempt left behind, it converges on `newUrl`.
 */
async function rewriteWordPressUrls(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  site: SiteRow,
  fallbackOldUrl: string,
  newUrl: string,
  wasRunning: boolean,
): Promise<void> {
  // wp-cli runs via `docker exec`, so the container has to be up. Skipping the rewrite
  // for a stopped site left it flagged live while WordPress still redirected every
  // request to the old dev URL - visible only once someone started it again.
  if (!wasRunning) {
    ctx.info('Site is stopped; starting it briefly to rewrite the WordPress URLs…');
    await startSiteContainer(server, s, site, ctx);
  }
  try {
    const currentUrl = (await server.wp.optionGet(site.containerName, 'home')) || fallbackOldUrl;
    if (currentUrl === newUrl) {
      ctx.info(`WordPress already uses ${newUrl}; no URL rewrite needed.`);
      return;
    }
    ctx.info(`Updating WordPress URLs (${currentUrl} -> ${newUrl})…`);
    await server.wp.optionUpdate(site.containerName, 'home', newUrl);
    await server.wp.optionUpdate(site.containerName, 'siteurl', newUrl);
    ctx.info('Running search-replace across all tables (guids preserved)…');
    const res = await server.wp.searchReplace(site.containerName, currentUrl, newUrl);
    ctx.info(res.stdout.trim().split('\n').slice(-1)[0] ?? 'search-replace done');
    // Still inside the started-if-needed window: licensed plugins tie their activation to
    // the URL, and Breakdance keeps URLs in JSON that search-replace does not reach.
    await runLicenseHook(ctx, s, server, site, 'afterUrlChange', { url: newUrl, oldUrl: currentUrl, newUrl });
  } finally {
    if (!wasRunning) {
      ctx.info('Stopping the site again (it was stopped before the domain change).');
      await server.docker.stopContainer(site.containerName).catch((err) => {
        ctx.warn(`Could not stop the site again: ${errMsg(err)}`);
      });
    }
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
