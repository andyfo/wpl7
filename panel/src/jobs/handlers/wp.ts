// @docs plugins/overview, plugins/updates, sites/bulk
import { asc } from 'drizzle-orm';
import { z } from 'zod';
import { sites, type SiteRow } from '../../db/schema.js';
import { wpComponentActions, wpComponentKinds } from '../../../shared/schemas.js';
import type { WpBulkOpResult } from '../../../shared/types.js';
import { policyOps } from '../../../shared/wpOps.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { loadSite, requireRunning, siteDomains, siteUrl } from './shared.js';
import { backendFor, type SiteBackend } from '../../services/siteBackend.js';
import { isExternal } from '../../lib/siteKind.js';

export const wpCoreUpdatePayload = z.object({ siteId: z.number().int() });

export async function wpCoreUpdate(ctx: JobContext<z.infer<typeof wpCoreUpdatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  const backend = backendFor(s, site);
  const restoreState = await backend.prepare(ctx);
  try {
    const { from, to } = await backend.coreUpdate(ctx);
    ctx.setResult({ from, to });
  } finally {
    // Every WordPress job leaves the snapshot current - the panel reads that snapshot
    // everywhere now, so a job that changes a site without re-reading it makes the UI lie
    // until the next scheduled scan.
    await rescanQuietly(ctx, s, site, backend);
    await restoreState();
    backend.close();
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
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  const backend = backendFor(s, site);
  const restoreState = await backend.prepare(ctx);
  try {
    await runPluginTask(ctx, backend);
  } finally {
    // See wpCoreUpdate: the inventory snapshot is what the site page renders, so an
    // install/activate/deactivate/delete has to be reflected in it before the job ends.
    await rescanQuietly(ctx, s, site, backend);
    await restoreState();
    backend.close();
  }
}

/** One plugin or theme updated on its own, outside a bulk run: the update, or why it failed. */
async function updateOne(ctx: JobContext<unknown>, backend: SiteBackend, kind: 'plugin' | 'theme', name: string, actor: string | undefined): Promise<void> {
  if (backend.kind === 'hosted') {
    await backend.componentAction(kind, name, 'update', actor);
    return;
  }
  const [result] = await backend.updateMany(ctx, kind, [name], actor);
  if (!result?.ok) throw new Error(result?.error ?? 'The update failed');
}

async function runPluginTask(ctx: JobContext<z.infer<typeof wpPluginTaskPayload>>, backend: SiteBackend): Promise<void> {
  const actor = await backend.actor(ctx);
  if (ctx.payload.action === 'install') {
    const source = ctx.payload.source;
    if (!source) throw new Error('install requires a source');
    const installed = await backend.install(ctx, source, ctx.payload.activate, actor);
    ctx.setResult({ installed });
    return;
  }

  const name = ctx.payload.name;
  if (!name) throw new Error(`${ctx.payload.action} requires a plugin name`);
  if (ctx.payload.action === 'delete') {
    ctx.info(`Deactivating and deleting plugin ${name}…`);
    try {
      await backend.componentAction('plugin', name, 'deactivate', actor);
    } catch {
      ctx.warn(`Deactivate failed (plugin may already be inactive); continuing with delete.`);
    }
    await backend.componentAction('plugin', name, 'delete', actor);
  } else {
    ctx.info(`Running plugin ${ctx.payload.action} for ${name}…`);
    if (ctx.payload.action === 'update') await updateOne(ctx, backend, 'plugin', name, actor);
    else await backend.componentAction('plugin', name, ctx.payload.action, actor);
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
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  const backend = backendFor(s, site);
  const restoreState = await backend.prepare(ctx);
  try {
    const actor = await backend.actor(ctx);
    ctx.info(`Running theme ${ctx.payload.action} for ${ctx.payload.name}…`);
    // wp-cli refuses to delete the active theme or the active theme's parent without
    // --force, which the panel never passes - that refusal is the safety rail. WPL7 Connect
    // refuses the same.
    if (ctx.payload.action === 'update') await updateOne(ctx, backend, 'theme', ctx.payload.name, actor);
    else await backend.componentAction('theme', ctx.payload.name, ctx.payload.action, actor);
    ctx.setResult({ [ctx.payload.action]: ctx.payload.name });
  } finally {
    // Before restoreState(), not after: a stopped site is stopped again in there, and a scan
    // needs the container up.
    await rescanQuietly(ctx, s, site, backend);
    await restoreState();
    backend.close();
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
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  const backend = backendFor(s, site);
  const results: WpBulkOpResult[] = [];
  let backupId: number | null = null;
  let healthy: boolean | null = null;
  const rolledBack: string[] = [];
  let rollbackFailed: string | null = null;
  let answeredBefore: boolean | null = null;

  const restoreState = await backend.prepare(ctx);
  let nothingToDo = false;
  try {
    let ops: BulkOp[] = ctx.payload.ops ?? [];
    if (ctx.payload.policy) {
      ops = await opsForPolicy(ctx, s, site, backend, ctx.payload.policy);
      nothingToDo = ops.length === 0;
    }
    if (nothingToDo) return;

    if (ctx.payload.backupFirst) {
      ctx.info('Taking a pre-update backup…');
      // An update schedule's backups are `scheduled` ones: retention bounds them. A nightly
      // policy taking `pre_update` backups - which nothing ever prunes - fills the disk.
      const type = ctx.payload.policy ? 'scheduled' : 'pre_update';
      const row = await backend.backupFirst(ctx, type);
      backupId = row.id;
      ctx.info(`Pre-update backup #${row.id} complete.`);
    }
    ctx.checkCanceled();

    // A site hosted elsewhere that did not answer before the run is not the run's to roll back.
    answeredBefore = backend.kind === 'external' && ctx.payload.healthCheck ? await backend.healthy() : null;
    if (answeredBefore === false) ctx.warn('The site did not answer before the update; an update will not be rolled back for it.');

    await runOps(ctx, backend, ops, results);

    if (ctx.payload.healthCheck) {
      const host = backend.kind === 'hosted' ? (siteDomains(site)[0] ?? '') : (s.connections.homeOf(site.id) ?? '');
      if (!host) {
        ctx.warn('Health check skipped: the site has no hostname to ask for.');
      } else {
        ctx.info(`Checking that ${host} still answers…`);
        healthy = await backend.healthy();
        ctx.log(healthy ? 'info' : 'error', healthy ? `${host} answers.` : `${host} did not answer.`);
        if (!healthy && answeredBefore === true) {
          // WPL7 Connect kept a copy of every plugin and theme it updated: put them back, then ask again.
          const back = await backend.rollback(ctx);
          for (const item of back) {
            if (item.ok) {
              rolledBack.push(item.slug);
              ctx.info(`${item.slug}: put back as it was before the update.`);
            } else {
              rollbackFailed ??= item.error ?? 'no reason given';
              ctx.error(`${item.slug}: could not be put back: ${item.error ?? 'no reason given'}`);
            }
          }
          for (const r of results) if (r.slug !== null && rolledBack.includes(r.slug)) r.rolledBack = true;
          if (rolledBack.length > 0) {
            healthy = await backend.healthy();
            ctx.log(healthy ? 'info' : 'error', healthy ? `${host} answers again.` : `${host} still does not answer.`);
          }
        }
      }
    }
    // A run that left the site answering has no use for the copies a rollback would have used.
    if (healthy !== false) await backend.cleanup(ctx);
  } finally {
    // In the finally, so a cancelled or timed-out run still records what it managed to do
    // - the worker persists whatever the context holds on every exit path.
    ctx.setResult({
      ops: results,
      backupId,
      healthy,
      ...(answeredBefore === false ? { answeredBefore } : {}),
      ...(rolledBack.length > 0 ? { rolledBack } : {}),
      ...(nothingToDo ? { nothingToDo: true } : {}),
    });
    // The snapshot is re-read before the container is stopped again - a scan needs it up,
    // and the whole point of the run is that the panel now knows the new state. A policy run
    // with nothing to do scanned a moment ago.
    if (!nothingToDo) await rescanQuietly(ctx, s, site, backend);
    await restoreState();
    backend.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (rolledBack.length > 0) {
    throw new Error(
      `The site stopped answering after the update, so WPL7 Connect put back ${rolledBack.join(', ')}` +
        (healthy ? '; it answers again' : '; it still does not answer') +
        (backupId ? `. Backup #${backupId} holds the site as it was before` : ''),
    );
  }
  if (healthy === false && answeredBefore === false) {
    throw new Error(
      'The site did not answer before the update either; nothing was rolled back' +
        (failed.length > 0 ? `. ${failed.length} of ${results.length} operations also failed` : ''),
    );
  }
  if (healthy === false) {
    throw new Error(
      `The site stopped answering after the update` +
        (rollbackFailed ? ` and could not be rolled back (${rollbackFailed})` : '') +
        (backupId
          ? backend.kind === 'hosted'
            ? ` - restore backup #${backupId} from the Backups tab to go back`
            : ` - backup #${backupId} holds it as it was: restore it by hand from its download`
          : '') +
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
 * An update policy, turned into operations against a scan taken now: the same choice the
 * site page's "Update all" / "Fix vulnerable" makes (shared/wpOps.ts), filtered to the kinds
 * the policy covers.
 */
async function opsForPolicy(
  ctx: JobContext<BulkPayload>,
  s: CoreServices,
  site: SiteRow,
  backend: SiteBackend,
  policy: NonNullable<BulkPayload['policy']>,
): Promise<BulkOp[]> {
  ctx.info('Checking what has an update…');
  await s.wpInventory.scanSite(site, backend, { log: (l, m) => ctx.log(l, m) });
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

/**
 * Run the operations, collecting an outcome for each and carrying on after a failure.
 *
 * Updates of one kind go to the backend together: on a hosted site that is a single
 * `wp plugin update a b c --format=json` call - one WordPress bootstrap instead of twenty - split
 * back out per slug; WPL7 Connect takes them one at a time. Everything else is one call each,
 * because that is the only way a "deactivate" that fails can be told from the one after it.
 */
async function runOps(ctx: JobContext<BulkPayload>, backend: SiteBackend, ops: BulkOp[], results: WpBulkOpResult[]): Promise<void> {
  // Core updates are WordPress's own and run as nobody; plugins and themes run as the admin.
  const actor = ops.some((op) => op.kind !== 'core') ? await backend.actor(ctx) : undefined;
  const updates = {
    plugin: ops.filter((o) => o.kind === 'plugin' && o.action === 'update' && o.slug).map((o) => o.slug!),
    theme: ops.filter((o) => o.kind === 'theme' && o.action === 'update' && o.slug).map((o) => o.slug!),
  };
  for (const kind of ['plugin', 'theme'] as const) {
    if (updates[kind].length === 0) continue;
    ctx.checkCanceled();
    results.push(...(await backend.updateMany(ctx, kind, updates[kind], actor)));
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
            await backend.componentAction('plugin', slug, 'deactivate', actor);
          } catch {
            ctx.warn(`${slug}: deactivate before delete failed (already inactive?); continuing.`);
          }
        }
        ctx.info(`Plugin ${op.action}: ${slug}`);
        await backend.componentAction('plugin', slug, op.action, actor);
      } else {
        if (op.action === 'deactivate') throw new Error('themes cannot be deactivated; activate another one instead');
        ctx.info(`Theme ${op.action}: ${slug}`);
        await backend.componentAction('theme', slug, op.action, actor);
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
      const { from, to } = await backend.coreUpdate(ctx);
      result.from = from;
      result.to = to;
    } catch (err) {
      result.ok = false;
      result.error = errorText(err);
      ctx.error(`Core update failed - ${result.error}`);
    }
    results.push(result);
  }
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
  // Sites hosted elsewhere: asked through WPL7 Connect, one after another, beside the servers.
  const external: SiteRow[] = [];
  let skippedStopped = 0;
  let skippedBusy = 0;
  for (const site of candidates) {
    if (isExternal(site)) {
      if (site.status !== 'connected') skippedStopped++;
      // A backup pulling the site meanwhile changes nothing WordPress would list.
      else if (changingWordPress(s, site.id)) skippedBusy++;
      else external.push(site);
      continue;
    }
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
  const total = [...byServer.values()].reduce((n, list) => n + list.length, 0) + external.length;
  ctx.info(
    `Scanning ${total} site(s) across ${byServer.size} server(s)` +
      `${external.length > 0 ? ` and ${external.length} hosted elsewhere` : ''}` +
      `${skippedStopped > 0 ? `; ${skippedStopped} not running` : ''}` +
      `${skippedBusy > 0 ? `; ${skippedBusy} busy with another job` : ''}`,
  );

  let scanned = 0;
  let failed = 0;
  // Parallel across servers, sequential within one: the same shape wpCronTick uses, so a
  // fleet pass is bounded by its slowest server rather than by the sum of every site.
  await Promise.all([
    ...[...byServer.entries()].map(async ([serverId, list]) => {
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
    (async () => {
      for (const site of external) {
        ctx.checkCanceled();
        const backend = backendFor(s, site);
        try {
          await s.wpInventory.scanSite(site, backend, { log: (l, m) => ctx.log(l, m), refreshFeed: false });
          scanned++;
        } catch (err) {
          failed++;
          ctx.warn(`"${site.slug}" could not be scanned: ${errorText(err)}`);
        } finally {
          backend.close();
        }
      }
    })(),
  ]);

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
  // New findings go out by email (services/alerts.ts); a failure there is no failure of the scan.
  await s.alerts.vulnerabilities(ctx.payload.siteIds).catch((err: unknown) => ctx.warn(`Vulnerability alerts failed: ${errorText(err)}`));
  ctx.setResult({ scanned, failed, skippedStopped, skippedBusy });
  if (scanned === 0 && failed > 0) throw new Error(`Every site in the pass failed to scan (${failed})`);
}

/** Jobs that change a site's WordPress: an inventory taken while one runs would be stale at once. */
const WORDPRESS_CHANGES = ['wp.bulkTask', 'wp.pluginTask', 'wp.themeTask', 'wp.coreUpdate'];

function changingWordPress(s: CoreServices, siteId: number): boolean {
  const row = s.db.$client
    .prepare(`SELECT id FROM jobs WHERE site_id = ? AND status IN ('queued','running') AND type IN (${WORDPRESS_CHANGES.map(() => '?').join(',')}) LIMIT 1`)
    .get(siteId, ...WORDPRESS_CHANGES) as { id: number } | undefined;
  return row !== undefined;
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
async function rescanQuietly(ctx: JobContext<unknown>, s: CoreServices, site: SiteRow, via: ServerHandle | SiteBackend): Promise<void> {
  try {
    await s.wpInventory.scanSite(site, via, { log: (l, m) => ctx.log(l, m) });
  } catch (err) {
    ctx.warn(`Could not refresh the WordPress inventory afterwards: ${errorText(err)}`);
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Moved to shared.ts with the site backends (services/siteBackend.ts); still imported from here.
export { requireRunning } from './shared.js';
