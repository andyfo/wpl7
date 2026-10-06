// @docs sites/bulk
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  batches,
  jobs,
  sites,
  type BatchRow,
  type JobRow,
  type SiteRow,
  type SiteWpComponentRow,
} from '../db/schema.js';
import type { JobStatus, WpBulkAction, WpComponentAction, WpComponentKind } from '../../shared/schemas.js';
import type { BatchDto } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { JobWorker } from '../jobs/worker.js';
import type { CoreServices } from './index.js';
import { actionsFor, type WpInventoryService } from './wpInventory.js';

/**
 * A `wp.scanAll` over the whole fleet - not one over the sites a custom schedule names
 * (`siteIds`). Only a fleet pass is "the" scan: an hourly scan of one site must neither put
 * off the automatic scan of every other site (Schedulers.wpScanIsDue) nor stand in for it as
 * the Bulk page's last scan.
 */
export const fleetScanPass = (): SQL =>
  and(eq(jobs.type, 'wp.scanAll'), sql`json_extract(${jobs.payload}, '$.siteIds') IS NULL`)!;

export interface BulkTarget {
  siteSlug: string;
  kind: WpComponentKind;
  slug?: string;
}

export interface BulkSkip {
  siteSlug: string;
  reason: string;
}

/** One operation as the job payload carries it. */
export interface BulkOp {
  kind: WpComponentKind;
  slug?: string;
  action: WpComponentAction;
}

export interface BulkOptions {
  backupFirst: boolean;
  healthCheck: boolean;
}

/** Which per-component action a fleet-wide action means. */
const ACTION_MAP: Record<WpBulkAction, WpComponentAction> = {
  update: 'update',
  activate: 'activate',
  deactivate: 'deactivate',
  delete: 'delete',
  'core-update': 'update',
};

/**
 * Turns a selection on the fleet page into work the existing queue can run.
 *
 * The unit of work is deliberately one job per site rather than one giant job: that is
 * what keeps the guarantees the panel already makes - at most one active job per site, one
 * running job per server, a log and a cancel button per site, and a failure that is
 * attributable to the site it happened on. The `batches` row exists only to tie those jobs
 * together for the progress view.
 */
export class WpBulkService {
  constructor(
    private readonly s: CoreServices,
    private readonly worker: JobWorker,
    private readonly inventory: WpInventoryService,
  ) {}

  private get db() {
    return this.s.db;
  }

  /**
   * Per-site component lookup, memoized for one request. A fleet selection can carry a
   * couple of thousand targets over a few dozen sites, and every one of them needs that
   * site's snapshot - re-reading it per target turned validation into thousands of queries.
   */
  private componentCache(): (siteId: number) => Map<string, SiteWpComponentRow> {
    const cache = new Map<number, Map<string, SiteWpComponentRow>>();
    return (siteId) => {
      let hit = cache.get(siteId);
      if (!hit) {
        hit = this.inventory.componentsFor(siteId);
        cache.set(siteId, hit);
      }
      return hit;
    };
  }

  /**
   * Validate every target against the snapshot, then enqueue one job per site.
   *
   * Validation is strict on purpose: a stale browser tab must not be able to queue
   * operations that can only fail (updating something with no update available, deleting
   * the active theme), because a failed job looks like a broken site. Sites whose lane is
   * already busy are a different matter - they are reported as `skipped` so the operator
   * can retry them, rather than silently dropped.
   */
  createBatch(
    action: WpBulkAction,
    targets: BulkTarget[],
    options: BulkOptions,
  ): { batch: BatchRow; jobs: JobRow[]; skipped: BulkSkip[] } {
    const bySlug = new Map(this.db.select().from(sites).all().map((site) => [site.slug, site]));
    const componentsFor = this.componentCache();
    const problems: string[] = [];
    const perSite = new Map<number, { site: SiteRow; ops: BulkOp[] }>();

    for (const target of targets) {
      const site = bySlug.get(target.siteSlug);
      if (!site) {
        problems.push(`site "${target.siteSlug}" does not exist`);
        continue;
      }
      if (site.status === 'provisioning' || site.status === 'deleting') {
        problems.push(`site "${site.slug}" is ${site.status}`);
        continue;
      }
      const status = this.inventory.statusRowFor(site.id);
      if (!status || status.scannedAt === null) {
        problems.push(`site "${site.slug}" has not been scanned yet - run a scan first`);
        continue;
      }
      const op = this.resolveOp(site, target, action, status.coreUpdateVersion, componentsFor);
      if (typeof op === 'string') {
        problems.push(op);
        continue;
      }
      const entry = perSite.get(site.id) ?? { site, ops: [] };
      // The same component can be selected twice (aggregate checkbox plus its site row);
      // running it twice would report the second attempt as a failure.
      if (!entry.ops.some((o) => o.kind === op.kind && o.slug === op.slug && o.action === op.action)) {
        entry.ops.push(op);
      }
      perSite.set(site.id, entry);
    }

    if (problems.length > 0) {
      throw badRequest(
        `${problems.length} of ${targets.length} selected item(s) cannot run this action; nothing was queued`,
        problems.slice(0, 25),
      );
    }
    if (perSite.size === 0) throw badRequest('No targets to run');

    const skipped: BulkSkip[] = [];
    const created: JobRow[] = [];
    const batch = this.db.transaction(() => {
      const row = this.db
        .insert(batches)
        .values({
          kind: 'wp.bulk',
          action,
          options: JSON.stringify(options),
          skipped: '[]',
          targetCount: [...perSite.values()].reduce((n, e) => n + e.ops.length, 0),
          totalJobs: 0,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      for (const { site, ops } of perSite.values()) {
        try {
          created.push(
            this.worker.enqueue(
              'wp.bulkTask',
              {
                siteId: site.id,
                batchId: row.id,
                ops: sortOps(ops),
                backupFirst: options.backupFirst,
                healthCheck: options.healthCheck,
              },
              { id: site.id, slug: site.slug, serverId: site.serverId },
              { batchId: row.id },
            ),
          );
        } catch (err) {
          // jobConflict: another job holds this site's lane. Reported, not dropped.
          skipped.push({ siteSlug: site.slug, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return this.db
        .update(batches)
        .set({ totalJobs: created.length, skipped: JSON.stringify(skipped) })
        .where(eq(batches.id, row.id))
        .returning()
        .get();
    });
    return { batch, jobs: created, skipped };
  }

  /** A validated op, or the sentence explaining why this target cannot run the action. */
  private resolveOp(
    site: SiteRow,
    target: BulkTarget,
    action: WpBulkAction,
    coreUpdateVersion: string | null,
    componentsFor: (siteId: number) => Map<string, SiteWpComponentRow>,
  ): BulkOp | string {
    if (action === 'core-update' || target.kind === 'core') {
      if (action !== 'core-update') return `"${site.slug}": WordPress core only supports the core update action`;
      if (target.kind !== 'core') return `"${site.slug}": core-update cannot be applied to a ${target.kind}`;
    }
    const op: BulkOp =
      target.kind === 'core'
        ? { kind: 'core', action: 'update' }
        : { kind: target.kind, slug: target.slug, action: ACTION_MAP[action] };
    const problem = this.checkOp(site, op, coreUpdateVersion, componentsFor);
    return problem ?? op;
  }

  /**
   * Why this operation cannot run on this site, or null when it can.
   *
   * Both entry points go through here - the fleet page's action bar and the site page's
   * "Update all" / "Fix vulnerable" - so a stale browser tab gets a 400 that says what is
   * wrong instead of a job that runs and reports failures for things that were never
   * possible.
   */
  private checkOp(
    site: SiteRow,
    op: BulkOp,
    coreUpdateVersion: string | null,
    componentsFor: (siteId: number) => Map<string, SiteWpComponentRow>,
  ): string | null {
    if (op.kind === 'core') {
      if (op.action !== 'update') return `"${site.slug}": WordPress core only supports an update`;
      return coreUpdateVersion ? null : `"${site.slug}": WordPress is already up to date`;
    }
    if (!op.slug) return `"${site.slug}": a ${op.kind} operation needs a slug`;
    const component = componentsFor(site.id).get(`${op.kind}:${op.slug}`);
    if (!component) return `"${site.slug}": ${op.kind} "${op.slug}" is not installed (rescan the site)`;
    const { actionable, blockedReason } = actionsFor({
      kind: op.kind,
      status: component.status,
      updateState: component.updateState as 'none' | 'available' | 'higher',
      updateVersion: component.updateVersion,
    });
    if (actionable[op.action]) return null;
    if (op.action === 'update') return `"${site.slug}": ${op.slug} has no update available`;
    return `"${site.slug}": ${op.slug} cannot be ${op.action}d${blockedReason ? ` - ${blockedReason}` : ''}`;
  }

  /**
   * Validate the operations one site was asked to run (the site page's own bulk endpoint)
   * and put them in the order the job will run them. Throws a 400 listing every problem.
   */
  validateOps(site: SiteRow, ops: BulkOp[]): BulkOp[] {
    const status = this.inventory.statusRowFor(site.id);
    if (!status || status.scannedAt === null) {
      throw badRequest(`"${site.slug}" has not been scanned yet; check for updates first`);
    }
    const componentsFor = this.componentCache();
    const problems: string[] = [];
    const seen = new Set<string>();
    const validated: BulkOp[] = [];
    for (const op of ops) {
      const problem = this.checkOp(site, op, status.coreUpdateVersion, componentsFor);
      if (problem) {
        problems.push(problem);
        continue;
      }
      const key = `${op.kind}:${op.slug ?? ''}:${op.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      validated.push(op);
    }
    if (problems.length > 0) {
      throw badRequest(
        `${problems.length} of ${ops.length} operation(s) cannot run; nothing was queued`,
        problems.slice(0, 25),
      );
    }
    return sortOps(validated);
  }

  batchRow(id: number): BatchRow {
    const row = this.db.select().from(batches).where(eq(batches.id, id)).get();
    if (!row) throw notFound(`Batch #${id} not found`);
    return row;
  }

  jobsOf(batchId: number): JobRow[] {
    return this.db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(desc(jobs.id)).all();
  }

  toDto(row: BatchRow, jobRows?: JobRow[]): BatchDto {
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
    const relevant = jobRows ?? this.jobsOf(row.id);
    for (const job of relevant) {
      const status = job.status as JobStatus;
      if (counts[status] !== undefined) counts[status] += 1;
    }
    return {
      id: row.id,
      kind: 'wp.bulk',
      action: row.action as WpBulkAction,
      options: {
        backupFirst: false,
        healthCheck: true,
        ...(JSON.parse(row.options) as Partial<BulkOptions>),
      },
      targets: row.targetCount,
      totalJobs: row.totalJobs,
      skipped: JSON.parse(row.skipped) as BulkSkip[],
      counts,
      createdAt: row.createdAt,
    };
  }

  /** Recent batches with their progress, in one pass over their jobs. */
  list(limit: number): BatchDto[] {
    const rows = this.db.select().from(batches).orderBy(desc(batches.id)).limit(limit).all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const jobRows = this.db.select().from(jobs).where(inArray(jobs.batchId, ids)).all();
    const byBatch = new Map<number, JobRow[]>();
    for (const job of jobRows) {
      if (job.batchId === null) continue;
      const list = byBatch.get(job.batchId) ?? [];
      list.push(job);
      byBatch.set(job.batchId, list);
    }
    return rows.map((row) => this.toDto(row, byBatch.get(row.id) ?? []));
  }

  /**
   * Refuse a second fleet scan while one is queued or running: they would fight over the
   * same containers and the second one's numbers would be the first one's, late.
   */
  assertNoActiveScan(): void {
    const active = this.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, 'wp.scanAll'), inArray(jobs.status, ['queued', 'running'])))
      .get();
    if (active) throw conflict(`A fleet scan is already ${active.status} (job #${active.id})`);
  }

  activeScanJob(): JobRow | undefined {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'wp.scanAll'), inArray(jobs.status, ['queued', 'running'])))
      .orderBy(desc(jobs.id))
      .get();
  }

  /** The newest fleet scan, running or finished - what "last scan" in the UI means. */
  lastScanJob(): JobRow | undefined {
    return this.db.select().from(jobs).where(fleetScanPass()).orderBy(desc(jobs.id)).get();
  }
}

/**
 * Deterministic order: core last (it restarts PHP's view of the world and runs the database
 * upgrade), plugins before themes, then alphabetically. A repeatable order means a bulk run
 * that half-failed can be read against the one that follows it.
 */
export function sortOps(ops: BulkOp[]): BulkOp[] {
  const rank = (op: BulkOp): number => (op.kind === 'core' ? 2 : op.kind === 'theme' ? 1 : 0);
  return [...ops].sort((a, b) => rank(a) - rank(b) || (a.slug ?? '').localeCompare(b.slug ?? ''));
}
