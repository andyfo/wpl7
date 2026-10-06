// @docs automations/custom-jobs
import { and, eq, inArray } from 'drizzle-orm';
import { jobs, sites, type JobRow, type SiteRow } from '../db/schema.js';
import { GODMODE_WAIT_REFUSAL, waitsOnGodmode, type JobType } from '../../shared/schemas.js';
import {
  SCHEDULE_ACTION_INFO,
  type ScheduleAction,
  type ScheduleActionParams,
  type ScheduleTarget,
} from '../../shared/scheduleActions.js';
import type { ScheduleSkip } from '../../shared/types.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { CoreServices } from '../services/index.js';
import { execLane } from './lanes.js';
import type { JobWorker } from './worker.js';

/**
 * What a custom schedule does when it fires: turn (action, target, params) into jobs.
 *
 * Synchronous from start to finish, like `JobWorker.enqueue`, so nothing can come between
 * the eligibility check and the enqueue. A site that cannot take part - busy with another
 * job, stopped, deleted since the schedule was made - is *skipped* with a reason, never an
 * error: one busy site must not cost the other forty their nightly update.
 */

export interface ActionOutcome {
  jobs: JobRow[];
  skipped: ScheduleSkip[];
  /** A sentence for a run that queued nothing on purpose. */
  message: string | null;
}

/**
 * Refuse a target that cannot work at all (400) - checked when a schedule is saved. `before` is
 * the target the schedule already has: a site it names that has been deleted since is skipped
 * by every run, and must not stop the schedule from being paused, renamed or given another
 * site. Only what a change brings in has to exist.
 */
export function checkTarget(
  s: CoreServices,
  action: ScheduleAction,
  target: ScheduleTarget,
  before: ScheduleTarget | null = null,
): void {
  const allowed: readonly string[] = SCHEDULE_ACTION_INFO[action].targets;
  if (!allowed.includes(target.kind)) {
    throw badRequest(`"${action}" does not run on a "${target.kind}" target`);
  }
  if (target.kind === 'sites') {
    const kept = new Set(before?.kind === 'sites' ? before.slugs : []);
    const added = target.slugs.filter((slug) => !kept.has(slug));
    const known = new Set(
      added.length === 0
        ? []
        : s.db.select({ slug: sites.slug }).from(sites).where(inArray(sites.slug, added)).all().map((r) => r.slug),
    );
    const unknown = added.filter((slug) => !known.has(slug));
    if (unknown.length > 0) throw badRequest(`No such site: ${unknown.map((u) => `"${u}"`).join(', ')}`);
  }
  const sameServer = before?.kind === 'server' && target.kind === 'server' && before.serverId === target.serverId;
  if (target.kind === 'server' && !sameServer && !s.servers.rowById(target.serverId)) {
    throw badRequest(`No such server: #${target.serverId}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A schedule's params as the API shows them. A REST request's application password is stored
 * with the schedule - each run needs it - and never read back out, like every other credential
 * the panel holds: `auth` keeps only the username.
 */
export function publicParams(action: string | null, params: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'wp.rest' || !isRecord(params.auth)) return params;
  const { applicationPassword: _secret, ...auth } = params.auth;
  return { ...params, auth };
}

/**
 * A change that leaves the application password out keeps the stored one, since nobody can
 * send back what they were never shown - but only for the same user: another user's password
 * cannot sign in the new one, so a new username needs its own.
 */
export function withStoredSecrets(
  action: string,
  params: Record<string, unknown>,
  stored: { action: string; params: Record<string, unknown> },
): Record<string, unknown> {
  if (action !== 'wp.rest' || stored.action !== 'wp.rest') return params;
  const auth = params.auth;
  const before = stored.params.auth;
  if (!isRecord(auth) || !isRecord(before) || auth.applicationPassword !== undefined) return params;
  if (typeof auth.username !== 'string' || auth.username.trim() !== before.username) return params;
  return { ...params, auth: { ...auth, applicationPassword: before.applicationPassword } };
}

const busy = (err: unknown): string =>
  err instanceof AppError && err.code === 'job_conflict' ? err.message : err instanceof Error ? err.message : String(err);

interface Resolved {
  sites: SiteRow[];
  skipped: ScheduleSkip[];
}

/**
 * The sites a target means right now. `server` and `all` are the running sites - the stopped
 * ones, for "start" - and, for backups, only those taking part in scheduled backups: the
 * per-site switch applies to any run that picks sites for itself. A `sites` list is taken as
 * written, and each site on it is then checked for what the action needs.
 */
function resolveSites(s: CoreServices, action: ScheduleAction, target: ScheduleTarget): Resolved {
  if (target.kind === 'panel') return { sites: [], skipped: [] };
  if (target.kind === 'sites') {
    const rows = s.db.select().from(sites).where(inArray(sites.slug, target.slugs)).all();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const skipped: ScheduleSkip[] = [];
    const found: SiteRow[] = [];
    for (const slug of target.slugs) {
      const site = bySlug.get(slug);
      if (site) found.push(site);
      else skipped.push({ siteSlug: slug, reason: 'no longer exists' });
    }
    return { sites: found, skipped };
  }
  const conditions = [eq(sites.status, action === 'site.start' ? 'stopped' : 'running')];
  if (target.kind === 'server') conditions.push(eq(sites.serverId, target.serverId));
  if (action === 'backup') conditions.push(eq(sites.backupsEnabled, 1));
  return { sites: s.db.select().from(sites).where(and(...conditions)).all(), skipped: [] };
}

/** Why this site cannot take this action now, or null. */
function ineligible(action: ScheduleAction, site: SiteRow): string | null {
  if (site.status === 'provisioning') return 'is still being created';
  if (site.status === 'deleting') return 'is being deleted';
  switch (action) {
    case 'backup':
      return null;
    case 'site.start':
      return site.status === 'running' ? 'is already running' : null;
    case 'site.stop':
      return site.status === 'running' ? null : 'is not running';
    default:
      // Restarts, scans, updates and commands need a running site, and never start one:
      // waking a stopped site is a decision, not a side effect of a schedule.
      return site.status === 'running' ? null : `is ${site.status}`;
  }
}

export function fireAction(
  s: CoreServices,
  worker: JobWorker,
  action: ScheduleAction,
  target: ScheduleTarget,
  params: Record<string, unknown>,
  opts: { name: string },
): ActionOutcome {
  const created: JobRow[] = [];
  const { sites: candidates, skipped } = resolveSites(s, action, target);

  if (action === 'panel.snapshot') {
    // Server 1's lane, exactly as the scheduled backups take it.
    created.push(worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 }));
    return { jobs: created, skipped, message: null };
  }

  const eligible: SiteRow[] = [];
  for (const site of candidates) {
    const why = ineligible(action, site);
    if (why) skipped.push({ siteSlug: site.slug, reason: why });
    else eligible.push(site);
  }

  if (action === 'wp.scan') {
    // One fleet pass over the chosen sites, not one job per site: the scan is lane-less and
    // read-only, and wp.scanAll already walks servers in parallel and sites in sequence.
    const active = s.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, 'wp.scanAll'), inArray(jobs.status, ['queued', 'running'])))
      .get();
    if (active) {
      return { jobs: [], skipped, message: `A WordPress scan is already queued or running (job #${active.id})` };
    }
    if (eligible.length === 0) return { jobs: [], skipped, message: 'No running site to scan' };
    const payload = target.kind === 'all' ? {} : { siteIds: eligible.map((site) => site.id) };
    created.push(worker.enqueue('wp.scanAll', payload));
    return { jobs: created, skipped, message: null };
  }

  const p = params as Partial<ScheduleActionParams[ScheduleAction]> & Record<string, unknown>;
  // Saving refuses one (shared/scheduleActions.ts); a schedule saved before that rule is stopped here.
  if (action === 'wp.cli' && Array.isArray(p.args) && waitsOnGodmode(p.args as string[])) {
    return { jobs: [], skipped, message: GODMODE_WAIT_REFUSAL };
  }
  for (const site of eligible) {
    const ref = { id: site.id, slug: site.slug, serverId: site.serverId };
    try {
      created.push(enqueueFor(worker, action, site, ref, p, opts.name));
    } catch (err) {
      skipped.push({ siteSlug: site.slug, reason: busy(err) });
    }
  }
  const message =
    created.length === 0 && eligible.length === 0 && skipped.length === 0 ? 'No site matched the target' : null;
  return { jobs: created, skipped, message };
}

function enqueueFor(
  worker: JobWorker,
  action: ScheduleAction,
  site: SiteRow,
  ref: { id: number; slug: string; serverId: number },
  p: Record<string, unknown>,
  scheduleName: string,
): JobRow {
  const exec = { lane: execLane(site.serverId), siteSlug: site.slug };
  switch (action) {
    case 'backup':
      // Type `scheduled`, so the same retention that bounds the nightly backups bounds these.
      return worker.enqueue(
        'backup.create',
        { siteId: site.id, type: 'scheduled', note: typeof p.note === 'string' && p.note ? p.note : scheduleName },
        ref,
      );
    case 'site.restart':
    case 'site.start':
    case 'site.stop':
      return worker.enqueue(action satisfies JobType, { siteId: site.id }, ref);
    case 'wp.update':
      return worker.enqueue(
        'wp.bulkTask',
        {
          siteId: site.id,
          policy: {
            plugins: p.plugins === true,
            themes: p.themes === true,
            core: p.core === true,
            onlyVulnerable: p.onlyVulnerable === true,
          },
          backupFirst: p.backupFirst === true,
          healthCheck: p.healthCheck !== false,
        },
        ref,
      );
    case 'wp.cli':
      return worker.enqueue('wp.cli', { siteId: site.id, args: p.args, timeoutMin: p.timeoutMin }, ref, exec);
    case 'site.shell':
      return worker.enqueue('site.shell', { siteId: site.id, command: p.command, timeoutMin: p.timeoutMin }, ref, exec);
    case 'wp.rest':
      return worker.enqueue(
        'wp.rest',
        { siteId: site.id, method: p.method, route: p.route, body: p.body, auth: p.auth, timeoutMin: p.timeoutMin },
        ref,
        exec,
      );
    case 'wp.scan':
    case 'panel.snapshot':
      throw new Error(`${action} is not a per-site action`);
  }
}
