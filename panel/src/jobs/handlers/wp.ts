import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { plugins, sites, type SiteRow } from '../../db/schema.js';
import { wpComponentActions, wpComponentKinds } from '../../../shared/schemas.js';
import type { WpBulkOpResult } from '../../../shared/types.js';
import { policyOps } from '../../../shared/wpOps.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { loadSite, probeSite, siteDomains, siteUrl, startSiteContainer, type MountServices } from './shared.js';

export const wpCoreUpdatePayload = z.object({ siteId: z.number().int() });

export async function wpCoreUpdate(ctx: JobContext<z.infer<typeof wpCoreUpdatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    const before = await server.wp.coreVersion(site.containerName);
    ctx.info(`Updating WordPress core (current: ${before ?? 'unknown'})…`);
    const { update } = await server.wp.coreUpdate(site.containerName);
    ctx.info(update.stdout.trim().split('\n').slice(-1)[0] ?? 'Core update finished');
    const after = await server.wp.coreVersion(site.containerName);
    ctx.info(`Core version now: ${after ?? 'unknown'}`);
    ctx.setResult({ from: before, to: after });
  } finally {
    // Every WordPress job leaves the snapshot current - the panel reads that snapshot
    // everywhere now, so a job that changes a site without re-reading it makes the UI lie
    // until the next scheduled scan.
    await rescanQuietly(ctx, s, site, server);
    await restoreState();
  }
}

export const wpPluginTaskPayload = z.object({
  siteId: z.number().int(),
  action: z.enum(['install', 'activate', 'deactivate', 'update', 'delete']),
  // install-only:
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('wporg'), slug: z.string() }),
      z.object({ kind: z.literal('catalog'), id: z.number().int() }),
    ])
    .optional(),
  name: z.string().optional(),
  activate: z.boolean().default(true),
});

export async function wpPluginTask(ctx: JobContext<z.infer<typeof wpPluginTaskPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    await runPluginTask(ctx, s, site, server);
  } finally {
    // See wpCoreUpdate: the inventory snapshot is what the site page renders, so an
    // install/activate/deactivate/delete has to be reflected in it before the job ends.
    await rescanQuietly(ctx, s, site, server);
    await restoreState();
  }
}

/**
 * The WordPress user a plugin or theme change runs as: the site's administrator, as when an admin
 * makes it in wp-admin (services/wp.ts actingAs says why). A site without one - or whose users
 * cannot be listed - gets the change as nobody, as before, with a word in the log.
 */
async function actorFor(ctx: JobContext<unknown>, server: ServerHandle, site: SiteRow): Promise<string | undefined> {
  try {
    const admin = await server.wp.siteAdministrator(site.containerName, site.wpAdminUser);
    if (admin) return String(admin.id);
    ctx.warn('This site has no administrator account, so the change runs as no WordPress user.');
  } catch (err) {
    ctx.warn(`Could not find the site's administrator (${errorText(err)}); the change runs as no WordPress user.`);
  }
  return undefined;
}

async function runPluginTask(
  ctx: JobContext<z.infer<typeof wpPluginTaskPayload>>,
  s: CoreServices,
  site: ReturnType<typeof loadSite>,
  server: ServerHandle,
): Promise<void> {
  const actor = await actorFor(ctx, server, site);
  if (ctx.payload.action === 'install') {
    const source = ctx.payload.source;
    if (!source) throw new Error('install requires a source');
    if (source.kind === 'wporg') {
      ctx.info(`Installing plugin ${source.slug} from wordpress.org…`);
      await server.wp.installPluginSlug(site.containerName, source.slug, ctx.payload.activate, actor);
      ctx.setResult({ installed: source.slug });
    } else {
      const row = s.db.select().from(plugins).where(eq(plugins.id, source.id)).get();
      if (!row) throw new Error(`Catalog plugin #${source.id} not found`);
      if (row.kind === 'zip') {
        if (!row.zipPath) throw new Error('Catalog entry has no zip file');
        ctx.info(`Installing plugin "${row.name}" from uploaded zip…`);
        const { PluginSyncService } = await import('../../services/pluginSync.js');
        await new PluginSyncService(s.db, s.config, s.servers).ensureZipOnServer(server, row.zipPath);
        await server.wp.installPluginZip(site.containerName, row.zipPath, ctx.payload.activate, actor);
      } else {
        ctx.info(`Installing plugin ${row.slug} from wordpress.org…`);
        await server.wp.installPluginSlug(site.containerName, row.slug, ctx.payload.activate, actor);
      }
      ctx.setResult({ installed: row.slug });
    }
    return;
  }

  const name = ctx.payload.name;
  if (!name) throw new Error(`${ctx.payload.action} requires a plugin name`);
  if (ctx.payload.action === 'delete') {
    ctx.info(`Deactivating and deleting plugin ${name}…`);
    try {
      await server.wp.pluginAction(site.containerName, name, 'deactivate', actor);
    } catch {
      ctx.warn(`Deactivate failed (plugin may already be inactive); continuing with delete.`);
    }
    await server.wp.pluginAction(site.containerName, name, 'delete', actor);
  } else {
    ctx.info(`Running plugin ${ctx.payload.action} for ${name}…`);
    await server.wp.pluginAction(site.containerName, name, ctx.payload.action, actor);
  }
  ctx.setResult({ [ctx.payload.action]: name });
}

export const wpRecipesPayload = z.object({
  siteId: z.number().int(),
  /** `afterInstall` is what "Activate" on the site page means; `verify` only checks. */
  hook: z.enum(['afterInstall', 'verify']).default('afterInstall'),
  /** One recipe, or every recipe whose plugin is on the site. */
  recipeId: z.string().optional(),
});

/**
 * Run plugin recipes on demand (site page → Recipes). The job fails when a recipe does,
 * so the outcome is red on the Jobs page rather than a warning nobody reads - unlike the
 * same hook inside site creation, where the site is the deliverable and the license a
 * detail to fix afterwards.
 */
export async function wpRecipes(ctx: JobContext<z.infer<typeof wpRecipesPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    ctx.info(ctx.payload.hook === 'verify' ? 'Checking plugin licenses…' : 'Activating plugin licenses…');
    const outcomes = await s.licenses.runHook(
      server,
      site,
      ctx.payload.hook,
      { url: siteUrl(s.config, siteDomains(site)[0]!) },
      { info: (m) => ctx.info(m), warn: (m, w) => ctx.warn(m, w) },
      ctx.payload.recipeId ? { only: ctx.payload.recipeId } : {},
    );
    if (outcomes.length === 0) ctx.info('No plugin with a recipe is installed on this site.');
    ctx.setResult({ outcomes });
    const failed = outcomes.filter((o) => o.status === 'failed' || o.status === 'not-set-up');
    if (failed.length > 0) {
      throw new Error(`${failed.map((o) => o.name).join(', ')}: not activated - see the log above`);
    }
  } finally {
    // Install hooks update their plugin (the bundled ones end with `wp plugin update`), and
    // the site page reads plugin versions from the snapshot - re-read it like every other
    // WordPress job does, failed run or not, before a stopped site is stopped again.
    await rescanQuietly(ctx, s, site, server);
    await restoreState();
  }
}

export const wpThemeTaskPayload = z.object({
  siteId: z.number().int(),
  action: z.enum(['activate', 'update', 'delete']),
  name: z.string(),
});

/**
 * Themes get the same treatment plugins already had. Deliberately no `install`: putting a
 * theme on a site is a design decision that belongs in the site's own admin, while
 * activating, updating and removing one is fleet maintenance.
 */
export async function wpThemeTask(ctx: JobContext<z.infer<typeof wpThemeTaskPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    const actor = await actorFor(ctx, server, site);
    ctx.info(`Running theme ${ctx.payload.action} for ${ctx.payload.name}…`);
    // wp-cli refuses to delete the active theme or the active theme's parent without
    // --force, which the panel never passes - that refusal is the safety rail.
    await server.wp.themeAction(site.containerName, ctx.payload.name, ctx.payload.action, actor);
    ctx.setResult({ [ctx.payload.action]: ctx.payload.name });
  } finally {
    // Before restoreState(), not after: a stopped site is stopped again in there, and a scan
    // needs the container up.
    await rescanQuietly(ctx, s, site, server);
    await restoreState();
  }
}

const bulkOp = z.object({
  kind: z.enum(wpComponentKinds),
  slug: z.string().optional(),
  action: z.enum(wpComponentActions),
});
type BulkOp = z.infer<typeof bulkOp>;

export const wpBulkTaskPayload = z
  .object({
    siteId: z.number().int(),
    /** Set when this job is one site's share of a fleet-wide run. */
    batchId: z.number().int().optional(),
    /** What to do, decided when the job was queued (the bulk page, the site page). */
    ops: z.array(bulkOp).min(1).optional(),
    /**
     * Or an update schedule's policy: which kinds of update to apply, decided from a fresh scan
     * when the job runs. A list written into the schedule would be stale by the second night -
     * and one written at enqueue time is already wrong if WordPress auto-updated in between.
     */
    policy: z
      .object({ plugins: z.boolean(), themes: z.boolean(), core: z.boolean(), onlyVulnerable: z.boolean() })
      .optional(),
    backupFirst: z.boolean().default(false),
    healthCheck: z.boolean().default(true),
  })
  .refine((p) => (p.ops === undefined) !== (p.policy === undefined), { message: 'give either "ops" or "policy"' });

type BulkPayload = z.infer<typeof wpBulkTaskPayload>;

/**
 * Every WordPress operation this site owes, in one container, in one job.
 *
 * One job per site rather than one job per operation: a site can only have one active job
 * anyway, and doing the whole list inside a single lane means the container is started once,
 * the pre-update backup covers everything that follows it, and the health check at the end
 * is checking the state the operator actually asked for.
 *
 * The job FAILS when any operation failed or the site stopped answering - with the per-op
 * outcomes and the backup id in its result. A half-succeeded run that reports success is
 * how a fleet quietly rots.
 */
export async function wpBulkTask(ctx: JobContext<BulkPayload>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const results: WpBulkOpResult[] = [];
  let backupId: number | null = null;
  let healthy: boolean | null = null;

  const restoreState = await requireRunning(ctx, server, s, site);
  let nothingToDo = false;
  try {
    let ops: BulkOp[] = ctx.payload.ops ?? [];
    if (ctx.payload.policy) {
      ops = await opsForPolicy(ctx, s, site, server, ctx.payload.policy);
      nothingToDo = ops.length === 0;
    }
    if (nothingToDo) return;

    if (ctx.payload.backupFirst) {
      ctx.info('Taking a pre-update backup…');
      // The monitor's own probes and wp-cron are paused for the site while a backup runs,
      // the same way a manual backup does it.
      s.monitor.busySlugs.add(site.slug);
      try {
        // An update schedule's backups are `scheduled` ones: retention bounds them. A nightly
        // policy taking `pre_update` backups - which nothing ever prunes - fills the disk.
        const type = ctx.payload.policy ? 'scheduled' : 'pre_update';
        const row = await s.backup.create(site, type, { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m) });
        backupId = row.id;
        ctx.info(`Pre-update backup #${row.id} complete.`);
      } finally {
        s.monitor.busySlugs.delete(site.slug);
      }
    }
    ctx.checkCanceled();

    await runOps(ctx, server, site, ops, results);

    if (ctx.payload.healthCheck) {
      const host = siteDomains(site)[0] ?? '';
      if (!host) {
        ctx.warn('Health check skipped: the site has no hostname to ask for.');
      } else {
        ctx.info(`Checking that ${host} still answers…`);
        // Same retry window every other health check in the panel uses, so "the site
        // answers" means one thing across backups, moves, PHP switches and updates.
        healthy = await probeSite(server, site.containerName, host, s.config.probeTimeoutMs);
        ctx.log(healthy ? 'info' : 'error', healthy ? `${host} answers.` : `${host} did not answer.`);
      }
    }
  } finally {
    // In the finally, so a cancelled or timed-out run still records what it managed to do
    // - the worker persists whatever the context holds on every exit path.
    ctx.setResult({ ops: results, backupId, healthy, ...(nothingToDo ? { nothingToDo: true } : {}) });
    // The snapshot is re-read before the container is stopped again - a scan needs it up,
    // and the whole point of the run is that the panel now knows the new state. A policy run
    // with nothing to do scanned a moment ago.
    if (!nothingToDo) await rescanQuietly(ctx, s, site, server);
    await restoreState();
  }

  const failed = results.filter((r) => !r.ok);
  if (healthy === false) {
    throw new Error(
      `The site stopped answering after the update` +
        (backupId ? ` - restore backup #${backupId} from the Backups tab to go back` : '') +
        (failed.length > 0 ? `; ${failed.length} of ${results.length} operations also failed` : ''),
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${results.length} operations failed: ` +
        failed.map((r) => `${r.slug ?? r.kind} (${r.error ?? 'unknown error'})`).join(', '),
    );
  }
}

/**
 * Run the operations, collecting an outcome for each and carrying on after a failure.
 *
 * Updates of one kind are coalesced into a single `wp plugin update a b c --format=json`
 * call - one WordPress bootstrap instead of twenty - and the JSON array it prints is split
 * back out per slug. Everything else is one call each, because that is the only way a
 * "deactivate" that fails can be told from the one after it.
 */
/**
 * An update policy, turned into operations against a scan taken now: the same choice the
 * site page's "Update all" / "Fix vulnerable" makes (shared/wpOps.ts), filtered to the kinds
 * the policy covers.
 */
async function opsForPolicy(
  ctx: JobContext<BulkPayload>,
  s: CoreServices,
  site: SiteRow,
  server: ServerHandle,
  policy: NonNullable<BulkPayload['policy']>,
): Promise<BulkOp[]> {
  ctx.info('Checking what has an update…');
  await s.wpInventory.scanSite(site, server, { log: (l, m) => ctx.log(l, m) });
  const status = s.wpInventory.statusFor(site);
  if (status.partial) {
    ctx.warn('The scan was partial (a plugin failed to load), so some updates may not be listed.');
  }
  const ops: BulkOp[] = policyOps(status, policy);
  if (ops.length === 0) {
    ctx.info(policy.onlyVulnerable ? 'No update fixes a known vulnerability here. Nothing to do.' : 'Everything is up to date. Nothing to do.');
  } else {
    const names = ops.map((op) => (op.kind === 'core' ? 'WordPress' : op.slug)).join(', ');
    ctx.info(`To update: ${names}`);
  }
  return ops;
}

async function runOps(
  ctx: JobContext<BulkPayload>,
  server: ServerHandle,
  site: SiteRow,
  ops: BulkOp[],
  results: WpBulkOpResult[],
): Promise<void> {
  // Core updates are WordPress's own and run as nobody; plugins and themes run as the admin.
  const actor = ops.some((op) => op.kind !== 'core') ? await actorFor(ctx, server, site) : undefined;
  const updates = {
    plugin: ops.filter((o) => o.kind === 'plugin' && o.action === 'update' && o.slug).map((o) => o.slug!),
    theme: ops.filter((o) => o.kind === 'theme' && o.action === 'update' && o.slug).map((o) => o.slug!),
  };
  for (const kind of ['plugin', 'theme'] as const) {
    if (updates[kind].length === 0) continue;
    ctx.checkCanceled();
    results.push(...(await updateGroup(ctx, server, site, kind, updates[kind], actor)));
  }

  for (const op of ops) {
    if (op.kind === 'core' || op.action === 'update') continue;
    ctx.checkCanceled();
    const slug = op.slug!;
    const result: WpBulkOpResult = { kind: op.kind, slug, action: op.action, ok: true, from: null, to: null, error: null };
    try {
      if (op.kind === 'plugin') {
        if (op.action === 'delete') {
          // Deleting an active plugin leaves WordPress with a dangling active entry, so
          // deactivate first. An already-inactive plugin makes that step fail harmlessly.
          try {
            await server.wp.pluginAction(site.containerName, slug, 'deactivate', actor);
          } catch {
            ctx.warn(`${slug}: deactivate before delete failed (already inactive?); continuing.`);
          }
        }
        ctx.info(`Plugin ${op.action}: ${slug}`);
        await server.wp.pluginAction(site.containerName, slug, op.action, actor);
      } else {
        if (op.action === 'deactivate') throw new Error('themes cannot be deactivated; activate another one instead');
        ctx.info(`Theme ${op.action}: ${slug}`);
        await server.wp.themeAction(site.containerName, slug, op.action, actor);
      }
    } catch (err) {
      result.ok = false;
      result.error = errorText(err);
      ctx.error(`${slug}: ${op.action} failed - ${result.error}`);
    }
    results.push(result);
  }

  if (ops.some((o) => o.kind === 'core')) {
    ctx.checkCanceled();
    const result: WpBulkOpResult = { kind: 'core', slug: null, action: 'update', ok: true, from: null, to: null, error: null };
    try {
      result.from = await server.wp.coreVersion(site.containerName);
      ctx.info(`Updating WordPress core (current: ${result.from ?? 'unknown'})…`);
      await server.wp.coreUpdate(site.containerName);
      result.to = await server.wp.coreVersion(site.containerName);
      ctx.info(`Core version now: ${result.to ?? 'unknown'}`);
    } catch (err) {
      result.ok = false;
      result.error = errorText(err);
      ctx.error(`Core update failed - ${result.error}`);
    }
    results.push(result);
  }
}

/** One coalesced update call, split back into one outcome per slug. */
async function updateGroup(
  ctx: JobContext<BulkPayload>,
  server: ServerHandle,
  site: SiteRow,
  kind: 'plugin' | 'theme',
  slugs: string[],
  actor: string | undefined,
): Promise<WpBulkOpResult[]> {
  ctx.info(`Updating ${slugs.length} ${kind}${slugs.length === 1 ? '' : 's'}: ${slugs.join(', ')}`);
  let rows: Awaited<ReturnType<ServerHandle['wp']['updateMany']>>;
  try {
    rows = await server.wp.updateMany(site.containerName, kind, slugs, actor);
  } catch (err) {
    const error = errorText(err);
    ctx.error(`wp ${kind} update failed outright: ${error}`);
    return slugs.map((slug) => ({ kind, slug, action: 'update', ok: false, from: null, to: null, error }));
  }
  const byName = new Map(rows.rows.map((row) => [row.name, row]));
  return slugs.map((slug) => {
    const row = byName.get(slug);
    if (!row) {
      // wp-cli said nothing about this one: it was not in the list it acted on (a
      // concurrent update, or a slug that vanished since the scan).
      ctx.warn(`${slug}: wp ${kind} update reported no result`);
      return {
        kind,
        slug,
        action: 'update' as const,
        ok: false,
        from: null,
        to: null,
        error: `wp ${kind} update reported no result (exit ${rows.exitCode}): ${rows.output.slice(0, 200)}`,
      };
    }
    const ok = row.status.toLowerCase() === 'updated';
    if (ok) ctx.info(`${slug}: ${row.oldVersion ?? '?'} → ${row.newVersion ?? '?'}`);
    else ctx.error(`${slug}: update reported "${row.status}"`);
    return {
      kind,
      slug,
      action: 'update' as const,
      ok,
      from: row.oldVersion,
      to: row.newVersion,
      error: ok ? null : `wp-cli reported "${row.status}"`,
    };
  });
}

export const wpScanAllPayload = z.object({
  /** Limit the pass to specific sites; omitted means the whole fleet. */
  siteIds: z.array(z.number().int()).optional(),
});

/**
 * Re-read the WordPress inventory of every running site.
 *
 * Lane-less on purpose: the work is read-only (`wp plugin list`), one pass covers every
 * server, and holding a server lane for it would park backups and site operations behind a
 * housekeeping job. Sites that already have an active job are skipped rather than queued
 * behind it - the job that is running will refresh their snapshot when it finishes.
 */
export async function wpScanAll(ctx: JobContext<z.infer<typeof wpScanAllPayload>>, s: CoreServices): Promise<void> {
  const wanted = ctx.payload.siteIds ? new Set(ctx.payload.siteIds) : null;
  const all = s.db.select().from(sites).orderBy(asc(sites.id)).all();
  const candidates = all.filter((site) => (wanted ? wanted.has(site.id) : true));
  const byServer = new Map<number, SiteRow[]>();
  let skippedStopped = 0;
  let skippedBusy = 0;
  for (const site of candidates) {
    if (site.status !== 'running') {
      skippedStopped++;
      continue;
    }
    if (s.monitor.busySlugs.has(site.slug) || hasActiveJob(s, site.id)) {
      skippedBusy++;
      continue;
    }
    const list = byServer.get(site.serverId) ?? [];
    list.push(site);
    byServer.set(site.serverId, list);
  }
  const total = [...byServer.values()].reduce((n, list) => n + list.length, 0);
  ctx.info(
    `Scanning ${total} running site(s) across ${byServer.size} server(s)` +
      `${skippedStopped > 0 ? `; ${skippedStopped} not running` : ''}` +
      `${skippedBusy > 0 ? `; ${skippedBusy} busy with another job` : ''}`,
  );

  let scanned = 0;
  let failed = 0;
  // Parallel across servers, sequential within one: the same shape wpCronTick uses, so a
  // fleet pass is bounded by its slowest server rather than by the sum of every site.
  await Promise.all(
    [...byServer.entries()].map(async ([serverId, list]) => {
      let server: ServerHandle;
      try {
        server = s.servers.handleFor(serverId);
      } catch (err) {
        ctx.warn(`Server #${serverId} skipped: ${errorText(err)}`);
        return;
      }
      if (server.row.status === 'unreachable') {
        ctx.warn(`Server "${server.row.name}" is unreachable; its sites were skipped.`);
        return;
      }
      for (const site of list) {
        ctx.checkCanceled();
        try {
          // The feed is refreshed once for the whole pass below, not per site.
          await s.wpInventory.scanSite(site, server, { log: (l, m) => ctx.log(l, m), refreshFeed: false });
          scanned++;
        } catch (err) {
          failed++;
          ctx.warn(`"${site.slug}" could not be scanned: ${errorText(err)}`);
        }
      }
    }),
  );

  if (s.vulnerabilities.enabled) {
    const refs = s.wpInventory.refsForSites();
    const feed = await s.vulnerabilities.refresh(refs);
    ctx.info(
      `Vulnerability feed: ${feed.fetched} slug(s) fetched, ${feed.skipped} still fresh` +
        `${feed.failed > 0 ? `, ${feed.failed} failed` : ''}`,
    );
  } else {
    ctx.info('Vulnerability feed is switched off in Settings; installed versions were not checked.');
  }
  s.wpInventory.recount();
  ctx.setResult({ scanned, failed, skippedStopped, skippedBusy });
  if (scanned === 0 && failed > 0) throw new Error(`Every site in the pass failed to scan (${failed})`);
}

/** True when this site already has a queued or running job (other than the caller's). */
function hasActiveJob(s: CoreServices, siteId: number): boolean {
  const row = s.db.$client
    .prepare(`SELECT id FROM jobs WHERE site_id = ? AND status IN ('queued','running') LIMIT 1`)
    .get(siteId) as { id: number } | undefined;
  return row !== undefined;
}

/**
 * Refresh the snapshot after a WordPress job, without letting a scan failure turn a
 * successful operation into a failed job: the operation happened either way, and the next
 * scheduled pass picks the inventory up.
 */
async function rescanQuietly(
  ctx: JobContext<unknown>,
  s: CoreServices,
  site: SiteRow,
  server: ServerHandle,
): Promise<void> {
  try {
    await s.wpInventory.scanSite(site, server, { log: (l, m) => ctx.log(l, m) });
  } catch (err) {
    ctx.warn(`Could not refresh the WordPress inventory afterwards: ${errorText(err)}`);
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * wp-cli needs a running container. Starting a stopped site is fine, but leaving it
 * running afterwards contradicts the site's own `stopped` status - the panel then showed
 * "stopped" for a site that was serving traffic (and burning memory). Returns a restore
 * function the caller must run in a `finally`.
 */
export async function requireRunning(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  s: MountServices,
  site: SiteRow,
): Promise<() => Promise<void>> {
  const state = await server.docker.containerState(site.containerName);
  if (state === 'missing') throw new Error('Site container does not exist');
  if (state === 'running') return async () => undefined;
  ctx.info('Site is stopped; starting it for this operation…');
  await startSiteContainer(server, s, site, ctx);
  return async () => {
    ctx.info('Stopping the site again (it was stopped before this operation).');
    await server.docker.stopContainer(site.containerName).catch((err) => {
      ctx.warn(`Could not stop the site again: ${err instanceof Error ? err.message : err}`);
    });
  };
}
