// @docs automations/jobs, get-started/how-it-works, help/troubleshooting
import { EventEmitter } from 'node:events';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { backups, jobs, servers, sites, type JobRow } from '../db/schema.js';
import type { JobType } from '../../shared/schemas.js';
import { jobConflict } from '../lib/errors.js';
import { JobCanceledError } from '../lib/errors.js';
import type { CoreServices } from '../services/index.js';
import { currentActor, withoutActor } from './actor.js';
import { JobContext } from './context.js';
import { SECRET_PAYLOAD_KEYS, SITE_INTERRUPTING_JOBS, getRegistry } from './registry.js';
import { summarizeJob } from './summaries.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_PARALLEL_JOBS = 8;
const STOP_GRACE_MS = 20_000;
/**
 * A site hold (holdSite) older than this is let go. Every change that takes one ends well
 * inside it - its commands have deadlines - so an older hold can only have leaked, and a
 * leaked one would keep the site's backups and updates from ever starting.
 */
const MAX_SITE_HOLD_MS = 15 * 60_000;

export { execLane, laneServerId } from './lanes.js';

/**
 * Single in-process worker with per-SERVER lanes: at most one running job per server,
 * so all Docker/MariaDB mutations on one machine stay sequential (the original
 * correctness argument), while servers no longer block each other. Jobs without a
 * lane (e.g. demo) serialize among themselves. Two-server jobs (site.move) occupy
 * both their lanes via auxServerId.
 *
 * A job may instead take a NAMED lane (`jobs.lane`), which is orthogonal to the server
 * lanes: offsite uploads run in `offsite:<serverId>`, so at most one upload per server is
 * in flight, while that server's Docker and MariaDB work carries on beside it. An upload
 * can take hours; making it hold the server lane would mean no site on that machine could
 * be restarted until the bucket had caught up.
 */
export class JobWorker {
  private emitter = new EventEmitter();
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private running = new Map<number, { ctx: JobContext; promise: Promise<void> }>();
  /**
   * Handlers whose job row already went `failed` (timeout) but that are still executing.
   * Their rows no longer say 'running', so the SQL lane check cannot see them - they are
   * tracked here and excluded in claimNext() until the handler actually settles.
   */
  private zombieLanes = new Map<number, { serverId: number | null; auxServerId: number | null; lane: string | null }>();
  /** Changes to a site made outside the queue that are still under way, per site (see holdSite). */
  private siteHolds = new Map<number, Set<{ since: number }>>();

  constructor(
    private readonly db: Db,
    private readonly services: CoreServices,
  ) {
    // See CoreServices.worker: handlers get `services`, and some of them (system.postUpdate)
    // need to queue follow-up jobs.
    this.services.worker = this;
  }

  /** The site's queued or running job, if it has one (there is never more than one). */
  activeSiteJob(siteId: number): { id: number; type: string } | null {
    return (
      this.db
        .select({ id: jobs.id, type: jobs.type })
        .from(jobs)
        .where(and(eq(jobs.siteId, siteId), inArray(jobs.status, ['queued', 'running'])))
        .limit(1)
        .get() ?? null
    );
  }

  /**
   * Hold a site for a change made outside the queue - a Web FTP save, move or delete - until
   * the returned function is called. Refused (job_conflict) while the site has a queued or
   * running job whose type `beside` does not name; and while the hold lasts, no job for the
   * site starts. One queued meanwhile waits for the change rather than running beside it: a
   * restore would otherwise replace the folder under a save that then reports success.
   * Synchronous, like enqueue() and claimNext(), so nothing can come between the check and
   * the hold.
   */
  holdSite(site: { id: number; slug: string }, beside: ReadonlySet<string> = new Set()): () => void {
    const job = this.activeSiteJob(site.id);
    if (job && !beside.has(job.type)) {
      throw jobConflict(`Site "${site.slug}" is busy with job #${job.id} (${job.type}); try again once it has finished`);
    }
    const hold = { since: Date.now() };
    const holds = this.siteHolds.get(site.id) ?? new Set();
    holds.add(hold);
    this.siteHolds.set(site.id, holds);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds.delete(hold);
      if (holds.size === 0 && this.siteHolds.get(site.id) === holds) this.siteHolds.delete(site.id);
      // A job that waited for this site may start now rather than at the next idle poll.
      this.emitter.emit('job');
    };
  }

  /** Sites with a change under way. A hold past MAX_SITE_HOLD_MS is let go, loudly. */
  private heldSites(): number[] {
    const now = Date.now();
    const held: number[] = [];
    for (const [siteId, holds] of this.siteHolds) {
      for (const hold of holds) {
        if (now - hold.since <= MAX_SITE_HOLD_MS) continue;
        holds.delete(hold);
        this.services.log.warn(
          `Site #${siteId} was held for a change for over ${MAX_SITE_HOLD_MS / 60_000} minutes; letting its jobs start`,
        );
      }
      if (holds.size > 0) held.push(siteId);
      else this.siteHolds.delete(siteId);
    }
    return held;
  }

  /**
   * Insert a queued job. Enforces at most one queued/running job per site.
   * Callers may wrap this in a db.transaction together with related row inserts.
   * The lane defaults to the site's server; `opts` overrides for server-scoped jobs.
   * `opts.batchId` ties the job to a bulk run (see services/wpBulk.ts).
   */
  enqueue(
    type: JobType,
    payload: unknown,
    site?: { id: number; slug: string; serverId?: number },
    opts?: {
      serverId?: number;
      auxServerId?: number;
      /**
       * A named lane instead of the server lanes. Jobs in one named lane serialize with
       * each other and with nothing else - which is what lets a twelve-hour upload run
       * without holding up every site operation on that machine.
       */
      lane?: string;
      /** Shown on the Jobs page for lane jobs, which deliberately carry no siteId. */
      siteSlug?: string;
      /** Ties this job to a bulk WordPress run (see services/wpBulk.ts). */
      batchId?: number;
    },
  ): JobRow {
    if (site) {
      const existing = this.activeSiteJob(site.id);
      if (existing) {
        throw jobConflict(
          `Site "${site.slug}" already has an active job (#${existing.id} ${existing.type}); wait for it to finish`,
        );
      }
    }
    let serverId = opts?.serverId ?? site?.serverId ?? null;
    if (serverId === null && site) {
      serverId =
        this.db.select({ serverId: sites.serverId }).from(sites).where(eq(sites.id, site.id)).get()?.serverId ?? null;
    }
    // A job occupies either the server lanes or a named one, never both: a laned job that
    // also held a server lane would be exactly the blocking the lane exists to avoid.
    const lane = opts?.lane ?? null;
    if (lane !== null) serverId = null;
    // Who asked (src/jobs/actor.ts): the request, the schedule, or - with neither - the panel.
    const actor = currentActor();
    const row = this.db
      .insert(jobs)
      .values({
        type,
        siteId: site?.id ?? null,
        siteSlug: site?.slug ?? opts?.siteSlug ?? null,
        serverId,
        auxServerId: lane !== null ? null : (opts?.auxServerId ?? null),
        lane,
        batchId: opts?.batchId ?? null,
        payload: JSON.stringify(payload ?? {}),
        status: 'queued',
        createdAt: Date.now(),
        origin: actor?.origin ?? 'system',
        createdBy: actor?.createdBy ?? null,
        scheduleId: actor?.scheduleId ?? null,
        summary: this.summaryOf(type, payload),
      })
      .returning()
      .get();
    actor?.jobs?.push(row);
    queueMicrotask(() => this.emitter.emit('job'));
    return row;
  }

  /** Never lets a summary that cannot be written stop the job it describes from being queued. */
  private summaryOf(type: JobType, payload: unknown): string | null {
    try {
      return summarizeJob(type, payload, {
        server: (id) => this.db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).get()?.name ?? null,
      });
    } catch (err) {
      this.services.log.warn(`Could not summarize a ${type} job: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A running job that was asked to stop and has not reached its next checkpoint yet. */
  cancelRequested(jobId: number): boolean {
    return this.running.get(jobId)?.ctx.cancelRequested === true;
  }

  /**
   * queued -> canceled. Running jobs get a best-effort flag checked between steps.
   *
   * A queued job's handler never ran, so neither did its compensations - but the request
   * that queued it may already have reserved state (a `provisioning` site row, a
   * `provisioning` server row). Registry entries undo that via `onQueuedCancel`, in the same
   * transaction as the status flip.
   */
  cancel(jobId: number): 'canceled' | 'requested' | 'not_cancelable' {
    const canceled = this.db.transaction(() => {
      const updated = this.db
        .update(jobs)
        .set({ status: 'canceled', finishedAt: Date.now() })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
        .returning({ id: jobs.id, type: jobs.type, payload: jobs.payload })
        .all();
      const job = updated[0];
      if (!job) return false;
      const entry = getRegistry()[job.type as JobType];
      if (entry?.onQueuedCancel) {
        const parsed = entry.payloadSchema.safeParse(JSON.parse(job.payload));
        if (parsed.success) entry.onQueuedCancel(parsed.data, this.services);
      }
      this.forgetSecrets(job);
      return true;
    });
    if (canceled) return 'canceled';
    const entry = this.running.get(jobId);
    if (entry) {
      entry.ctx.cancelRequested = true;
      return 'requested';
    }
    return 'not_cancelable';
  }

  /**
   * Crash recovery: interrupted jobs -> failed, and the secrets of every ended job dropped;
   * orphaned transitional sites -> error; backups cut off half-written -> failed.
   */
  reconcileOnBoot(): void {
    const interrupted = this.db
      .update(jobs)
      .set({ status: 'failed', error: 'Interrupted by panel restart', finishedAt: Date.now() })
      .where(eq(jobs.status, 'running'))
      .returning({ id: jobs.id, type: jobs.type })
      .all();
    this.forgetOldSecrets();
    for (const job of interrupted) {
      this.services.log.warn(`Job #${job.id} was running at shutdown; marked failed`);
      if (job.type === 'site.move') {
        this.services.log.warn(
          `Job #${job.id} was a site move - re-run the move; leftovers on the target are cleaned automatically by its preflight`,
        );
      }
    }
    const orphaned = this.db
      .update(sites)
      .set({ status: 'error', updatedAt: Date.now() })
      .where(inArray(sites.status, ['provisioning', 'deleting']))
      .returning({ slug: sites.slug })
      .all();
    for (const site of orphaned) {
      this.services.log.warn(`Site "${site.slug}" was mid-transition at shutdown; marked error`);
    }
    // A backup is only ever written inside a job, so one still "creating" now went down with
    // it. Left as it was, it could never be deleted (a backup being written is refused); failed,
    // it can - and deleting it removes whatever it had written.
    const halfWritten = this.db
      .update(backups)
      .set({ status: 'failed' })
      .where(eq(backups.status, 'creating'))
      .returning({ id: backups.id, siteSlug: backups.siteSlug })
      .all();
    for (const backup of halfWritten) {
      this.services.log.warn(`Backup #${backup.id} of "${backup.siteSlug}" was being written at shutdown; marked failed`);
    }
  }

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.emitter.emit('job');
    // Give running jobs a grace window; compose stop_grace_period exceeds this. Every job that
    // ends signals 'job', so this returns as soon as the last one is done rather than on a tick.
    const deadline = Date.now() + STOP_GRACE_MS;
    while (this.running.size > 0 && Date.now() < deadline) await this.waitForWork(deadline - Date.now());
    // The loop's own final drain has no deadline, so awaiting it unconditionally made
    // the grace window above meaningless - shutdown just waited for every job, then got
    // SIGKILLed. Race it against whatever is left of the window instead.
    await Promise.race([
      this.loopPromise?.catch(() => undefined) ?? Promise.resolve(),
      sleep(Math.max(0, deadline - Date.now())),
    ]);
    if (this.running.size > 0) {
      this.services.log.warn(
        `Shutdown grace elapsed with ${this.running.size} job(s) still running ` +
          `(#${[...this.running.keys()].join(', #')}); they are marked failed on the next boot`,
      );
    }
    // Restartable (tests start/stop repeatedly; production exits after stop anyway).
    this.loopPromise = null;
    this.stopping = false;
  }

  /**
   * Claim the oldest runnable queued job. A job is runnable when every server lane it
   * occupies (serverId, auxServerId) is free of running jobs; lane-less jobs form their
   * own single lane. better-sqlite3 is synchronous, so claims can't race each other.
   *
   * Lanes held by a timed-out-but-still-unwinding handler live in `zombieLanes` (their
   * rows no longer say 'running'), so they are excluded here as an extra SQL predicate.
   * So are the jobs of sites with a change under way outside the queue (holdSite).
   */
  private claimNext(maintenance = false): JobRow | null {
    const zombies = [...this.zombieLanes.values()];
    const blockedServers = [
      ...new Set(zombies.flatMap((z) => [z.serverId, z.auxServerId]).filter((id): id is number => id !== null)),
    ];
    const blockedNamed = [...new Set(zombies.map((z) => z.lane).filter((l): l is string => l !== null))];
    const blockedLaneless = zombies.some((z) => z.serverId === null && z.auxServerId === null && z.lane === null);

    let extra = '';
    const params: unknown[] = [Date.now()];
    if (blockedServers.length > 0) {
      const ph = blockedServers.map(() => '?').join(',');
      extra += ` AND (j.server_id IS NULL OR j.server_id NOT IN (${ph}))`;
      extra += ` AND (j.aux_server_id IS NULL OR j.aux_server_id NOT IN (${ph}))`;
      params.push(...blockedServers, ...blockedServers);
    }
    if (blockedNamed.length > 0) {
      extra += ` AND (j.lane IS NULL OR j.lane NOT IN (${blockedNamed.map(() => '?').join(',')}))`;
      params.push(...blockedNamed);
    }
    if (blockedLaneless) {
      extra += ' AND NOT (j.server_id IS NULL AND j.aux_server_id IS NULL AND j.lane IS NULL)';
    }
    // Mid-update, one job type is still allowed: the one that finishes the update and turns
    // maintenance back off. Everything else would be started only to be killed part-way
    // through the panel's own container recreate.
    if (maintenance) extra += " AND j.type = 'system.postUpdate'";
    const held = this.heldSites();
    if (held.length > 0) {
      extra += ` AND (j.site_id IS NULL OR j.site_id NOT IN (${held.map(() => '?').join(',')}))`;
      params.push(...held);
    }

    const claimed = this.db.$client
      .prepare(
        `UPDATE jobs SET status='running', started_at=?, attempts=attempts+1
         WHERE id = (
           SELECT j.id FROM jobs j
           WHERE j.status='queued' AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.status='running' AND (
               (j.lane IS NOT NULL AND r.lane = j.lane) OR
               (j.lane IS NULL AND (
                 (j.server_id IS NOT NULL AND (r.server_id = j.server_id OR r.aux_server_id = j.server_id)) OR
                 (j.aux_server_id IS NOT NULL AND (r.server_id = j.aux_server_id OR r.aux_server_id = j.aux_server_id)) OR
                 (j.server_id IS NULL AND j.aux_server_id IS NULL
                  AND r.lane IS NULL AND r.server_id IS NULL AND r.aux_server_id IS NULL)
               ))
             )
           )${extra}
           ORDER BY j.id LIMIT 1
         ) RETURNING id`,
      )
      .get(...params) as { id: number } | undefined;
    if (!claimed) return null;
    return this.db.select().from(jobs).where(eq(jobs.id, claimed.id)).get() ?? null;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimedAny = false;
      // Mid-update the panel is about to be replaced. Jobs already running are left to
      // finish (they hold a lane and a rollback), but starting another one that would be
      // killed halfway through its own container recreate helps nobody - except
      // system.postUpdate, which is what ends the update and clears this flag.
      const maintenance = this.services.settings.getRaw('system.maintenance') != null;
      while (this.running.size < MAX_PARALLEL_JOBS) {
        const job = this.claimNext(maintenance);
        if (!job) break;
        claimedAny = true;
        const ctx = new JobContext(job.id, {}, this.db);
        // Outside any actor: what a handler queues is the panel's own doing (src/jobs/actor.ts).
        const promise = withoutActor(() => this.execute(job, ctx)).finally(() => {
          this.running.delete(job.id);
          this.emitter.emit('job');
        });
        this.running.set(job.id, { ctx, promise });
      }
      if (!claimedAny || this.running.size >= MAX_PARALLEL_JOBS) {
        await this.waitForWork(1000);
      }
    }
    await Promise.all([...this.running.values()].map((e) => e.promise.catch(() => undefined)));
  }

  /**
   * Resolve on the next 'job' signal or after `ms`, always removing the listener:
   * `emitter.once()` inside a Promise.race leaks its listener every time the timer wins,
   * which on an idle worker is once per second.
   */
  private waitForWork(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const onJob = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        this.emitter.off('job', onJob);
        resolve();
      }, ms);
      this.emitter.once('job', onJob);
    });
  }

  /**
   * A timed-out handler keeps running (it only stops at its next checkpoint) and keeps
   * touching that server's Docker/MariaDB while it unwinds. Its job row is already
   * 'failed', so the SQL lane check would let a retry - or any other job for the same
   * server - start alongside it. Reserve the lane in memory until the handler settles
   * (`handler` includes the uptime check that ends its site's hold, when it has one).
   */
  private holdLaneUntilSettled(job: JobRow, handler: Promise<unknown>): void {
    this.zombieLanes.set(job.id, { serverId: job.serverId, auxServerId: job.auxServerId, lane: job.lane });
    this.services.log.warn(
      `Job #${job.id} (${job.type}) timed out but is still unwinding; ` +
        `holding its ${job.lane ?? 'server'} lane until it stops`,
    );
    const release = () => {
      this.zombieLanes.delete(job.id);
      this.services.log.info(`Job #${job.id} finished unwinding; ${job.lane ?? 'server'} lane released`);
      this.emitter.emit('job');
    };
    handler.then(release, release);
  }

  /** Drop the payload fields an ended job no longer needs (SECRET_PAYLOAD_KEYS, registry.ts). */
  private forgetSecrets(job: { id: number; type: string; payload: string }): void {
    const keys = SECRET_PAYLOAD_KEYS[job.type as JobType];
    if (!keys) return;
    let payload: unknown;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || !keys.some((key) => key in payload)) return;
    const kept = { ...(payload as Record<string, unknown>) };
    for (const key of keys) delete kept[key];
    this.db.update(jobs).set({ payload: JSON.stringify(kept) }).where(eq(jobs.id, job.id)).run();
  }

  /**
   * The secrets of every job that has ended: those a restart cut short, and - LEGACY(job-secrets) -
   * those that ended before the worker dropped them, a REST job's application password among them,
   * kept for as long as finished jobs are. Once per boot; a no-op once they are gone.
   */
  private forgetOldSecrets(): void {
    for (const [type, keys] of Object.entries(SECRET_PAYLOAD_KEYS)) {
      for (const key of keys ?? []) {
        const path = `$.${key}`;
        this.db
          .update(jobs)
          .set({ payload: sql`json_remove(${jobs.payload}, ${path})` })
          .where(
            and(
              eq(jobs.type, type),
              inArray(jobs.status, ['succeeded', 'failed', 'canceled']),
              sql`json_type(${jobs.payload}, ${path}) IS NOT NULL`,
            ),
          )
          .run();
      }
    }
  }

  /**
   * End a job's hold on its site's uptime check (holdChecks), which checks the site first. The
   * check is the monitor's business: it never decides how the job went.
   */
  private async releaseChecks(job: JobRow, release: (() => Promise<void>) | null): Promise<void> {
    await release?.().catch((err: unknown) => {
      this.services.log.warn(
        `Job #${job.id}: could not check site #${job.siteId} afterwards: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async execute(job: JobRow, ctx: JobContext): Promise<void> {
    const registry = getRegistry();
    const entry = registry[job.type as JobType];
    // A job that takes its site down on purpose (SITE_INTERRUPTING_JOBS) holds the uptime check
    // off it. The hold ends with a check of the site, after the handler and outside its
    // deadline, and before the status is written: a page that reloads as the job ends then
    // shows what the job left.
    let release: (() => Promise<void>) | null = null;
    try {
      if (!entry) throw new Error(`Unknown job type: ${job.type}`);
      const parsed = entry.payloadSchema.safeParse(JSON.parse(job.payload));
      if (!parsed.success) throw new Error(`Invalid job payload: ${parsed.error.message}`);
      (ctx as { payload: unknown }).payload = parsed.data;

      const timeoutMs = entry.timeoutMs ?? 30 * 60_000;
      if (job.siteId !== null && SITE_INTERRUPTING_JOBS.has(job.type as JobType)) {
        release = this.services.monitor.holdChecks(job.siteId);
      }
      const handlerPromise = entry.handler(ctx as never, this.services);
      let timer!: NodeJS.Timeout;
      let timedOut = false;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Job timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
        }, timeoutMs);
      });
      try {
        await Promise.race([handlerPromise, timeout]);
      } catch (err) {
        // If the handler is still running (timeout won), ask it to stop at the next
        // checkpoint and swallow its eventual rejection to avoid an unhandled rejection.
        ctx.cancelRequested = true;
        handlerPromise.catch(() => undefined);
        if (timedOut) {
          // Still at work on the site: it stays held until the handler stops, and is checked
          // then. The lane waits for that check too - a retry that started beside it would
          // overtake it, and neither job's reading would stand.
          const late = release;
          release = null;
          this.holdLaneUntilSettled(job, handlerPromise.catch(() => undefined).then(() => this.releaseChecks(job, late)));
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      await this.releaseChecks(job, release);
      this.db
        .update(jobs)
        .set({
          status: 'succeeded',
          finishedAt: Date.now(),
          result: ctx.getResult() ? JSON.stringify(ctx.getResult()) : null,
        })
        .where(eq(jobs.id, job.id))
        .run();
      this.forgetSecrets(job);
    } catch (err) {
      await this.releaseChecks(job, release);
      const canceled = err instanceof JobCanceledError;
      const message = err instanceof Error ? err.message : String(err);
      if (!canceled) {
        ctx.error(`Job failed: ${message}`);
        this.services.log.error(`Job #${job.id} (${job.type}) failed: ${message}`);
      } else {
        ctx.warn('Job canceled');
      }
      this.db
        .update(jobs)
        .set({
          status: canceled ? 'canceled' : 'failed',
          error: canceled ? null : message,
          finishedAt: Date.now(),
          result: ctx.getResult() ? JSON.stringify(ctx.getResult()) : null,
        })
        .where(eq(jobs.id, job.id))
        .run();
      this.forgetSecrets(job);
    }
  }
}
