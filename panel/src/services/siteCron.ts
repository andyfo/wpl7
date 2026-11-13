// @docs sites/php
import { Writable } from 'node:stream';
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { describeCron } from '../../shared/cron.js';
import type { SiteCronLineInput } from '../../shared/schemas.js';
import type { SiteCronLineDto } from '../../shared/types.js';
import { siteCron, sites, type SiteCronRow, type SiteRow } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { hostedSites, isPhpSite } from '../lib/siteKind.js';
import type { CoreServices } from './index.js';
import { cronRunProblem, nextCronRun } from './schedules.js';
import { asSiteUser } from './wp.js';

/**
 * A PHP site's cron lines (site_cron): a command run in its container on a schedule, as www-data
 * in the site's folder. Not jobs, though a custom schedule could run a command too: a job holds its
 * site, so a line that runs every minute would hold off backups and Files tab saves, and custom
 * schedules run at most every five minutes for that reason.
 *
 * The built-in task `site-cron` ticks once a minute. It starts what is due and does not wait for
 * it: the scheduler lets one run of a task exist at a time, so a tick that waited on a long command
 * would hold up every other site's lines. What a run printed and how it ended is kept on its line
 * once it is over. Its deadline is enforced inside the container (DockerService's `timeout`), so a
 * command outlives a panel restart, or a lost connection to its server, only until its stop-after
 * time. Until then such a run counts as running: its line doesn't start again, and it counts
 * toward its server's CRON_PER_SERVER.
 */

/** What is kept of a run's output: the end of it, where a failing command says why. */
export const CRON_OUTPUT_KEEP = 4096;
/** Commands running at once per server; the rest wait for the next tick. */
export const CRON_PER_SERVER = 2;
/**
 * After its stop-after time, how long a run the panel lost sight of (a restart, a lost connection)
 * may still be going: `timeout` gives it 5 s after its deadline before it kills it, and Docker a
 * moment more.
 */
const LOST_RUN_GRACE_MS = 15_000;

/**
 * What runs a line in its container: the line is the inner shell's $1, never spliced into a
 * script, and the outer one puts its errors in among what it prints. DockerService wraps it in the
 * line's `timeout`.
 */
export const cronExec = (command: string): string[] => ['sh', '-c', 'sh -c "$1" 2>&1', 'sh', command];

/** The end of what a command printed, at most CRON_OUTPUT_KEEP bytes of it. */
class OutputTail extends Writable {
  private kept = Buffer.alloc(0);

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.kept = Buffer.concat([this.kept, chunk]);
    if (this.kept.length > CRON_OUTPUT_KEEP) this.kept = this.kept.subarray(this.kept.length - CRON_OUTPUT_KEEP);
    done();
  }

  /** As text; a character cut in two at the start goes. */
  text(): string {
    return this.kept.toString('utf8').replace(/^�+/, '');
  }
}

interface Running {
  siteId: number;
  serverId: number;
  startedAt: number;
}

export class SiteCronService {
  /** Line id -> the run this panel started and has not yet seen end. */
  private readonly running = new Map<number, Running>();
  /** The runs out of the tick's hands, for a test to wait on. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly s: CoreServices) {}

  // ------------------------------------------------------------------ the lines

  rows(siteId: number): SiteCronRow[] {
    return this.s.db.select().from(siteCron).where(eq(siteCron.siteId, siteId)).orderBy(asc(siteCron.id)).all();
  }

  dto(row: SiteCronRow, now = Date.now()): SiteCronLineDto {
    return {
      id: row.id,
      expr: row.expr,
      schedule: describeCron(row.expr) ?? row.expr,
      command: row.command,
      enabled: row.enabled === 1,
      timeoutMin: row.timeoutMin,
      nextRunAt: row.nextRunAt,
      running: this.isRunning(row, now),
      last:
        row.lastStartedAt === null
          ? null
          : { startedAt: row.lastStartedAt, ms: row.lastMs, exitCode: row.lastExit, output: row.lastOutput, error: row.lastError },
    };
  }

  list(site: SiteRow): SiteCronLineDto[] {
    assertPhp(site);
    const now = Date.now();
    return this.rows(site.id).map((row) => this.dto(row, now));
  }

  /**
   * The site's lines as they are to be. A line with an id is that line, changed, and keeps its last
   * run; one without is new; a saved line left out is deleted. Its next run is worked out again for
   * a line whose schedule or switch changed. A schedule croner can't run, or that no date ever
   * matches, is refused: saved, it would be on and never run.
   */
  save(site: SiteRow, lines: SiteCronLineInput[]): SiteCronLineDto[] {
    assertPhp(site);
    const now = Date.now();
    lines.forEach((line, i) => {
      const problem = cronRunProblem(line.expr, new Date(now));
      if (problem) throw badRequest(`lines.${i}.expr: ${problem}`);
    });
    const current = new Map(this.rows(site.id).map((row) => [row.id, row]));
    for (const line of lines) {
      if (line.id !== undefined && !current.has(line.id)) throw notFound(`Cron line #${line.id} is not one of this site's`);
    }
    this.s.db.transaction((tx) => {
      const kept = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));
      for (const id of current.keys()) if (!kept.has(id)) tx.delete(siteCron).where(eq(siteCron.id, id)).run();
      for (const line of lines) {
        const before = line.id === undefined ? undefined : current.get(line.id);
        const scheduleChanged = !before || before.expr !== line.expr || before.enabled !== (line.enabled ? 1 : 0);
        const nextRunAt = !line.enabled ? null : scheduleChanged ? nextCronRun(line.expr, new Date(now)) : before.nextRunAt;
        const values = { expr: line.expr, command: line.command, enabled: line.enabled ? 1 : 0, timeoutMin: line.timeoutMin, nextRunAt, updatedAt: now };
        if (before) tx.update(siteCron).set(values).where(eq(siteCron.id, before.id)).run();
        else tx.insert(siteCron).values({ siteId: site.id, ...values, createdAt: now }).run();
      }
    });
    return this.list(site);
  }

  /** One line, now, as a tick would start it. Refused while it runs, or while its site can't run it. */
  runNow(site: SiteRow, lineId: number): SiteCronLineDto {
    assertPhp(site);
    const row = this.rows(site.id).find((r) => r.id === lineId);
    if (!row) throw notFound(`Cron line #${lineId} is not one of this site's`);
    const now = Date.now();
    if (this.isRunning(row, now)) throw conflict('This line is running already.');
    const why = this.cannotRun(site);
    if (why) throw conflict(why);
    if (this.runningOn(site.serverId, now) >= CRON_PER_SERVER) {
      throw conflict(`${CRON_PER_SERVER} cron commands are running on this site's server already; try again in a moment.`);
    }
    this.start(site, row, now, { advance: false });
    return this.dto(this.rows(site.id).find((r) => r.id === lineId)!, now);
  }

  // ------------------------------------------------------------------ the tick

  /**
   * Start every due line that can start, and nothing more: the runs end on their own. A line of a
   * site that is stopped, or busy with a backup, a restore, a move or a new container, stays due
   * and runs once when the site can run it. One still running is not started again, and that time
   * is skipped. Past CRON_PER_SERVER on a server, the rest stay due for the next minute.
   */
  tick(now = Date.now()): { started: number; waiting: number } {
    if (this.s.system.maintenance()) return { started: 0, waiting: 0 };
    const due = this.s.db
      .select({ line: siteCron, site: sites })
      .from(siteCron)
      .innerJoin(sites, eq(sites.id, siteCron.siteId))
      .where(and(hostedSites(), eq(sites.app, 'php'), eq(siteCron.enabled, 1), lte(siteCron.nextRunAt, now)))
      .orderBy(asc(siteCron.nextRunAt), asc(siteCron.id))
      .all();
    let started = 0;
    let waiting = 0;
    for (const { line, site } of due) {
      if (this.isRunning(line, now)) {
        // This time is skipped: the next one is when it runs again.
        this.advance(line, now);
        continue;
      }
      const server = this.s.servers.rowById(site.serverId);
      if (this.cannotRun(site) || !server || server.status === 'unreachable' || this.runningOn(site.serverId, now) >= CRON_PER_SERVER) {
        waiting++;
        continue;
      }
      this.start(site, line, now, { advance: true });
      started++;
    }
    return { started, waiting };
  }

  /** Every run this panel started has ended (tests; a clean shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  // ------------------------------------------------------------------ running

  /** Why the site can't run a command now, or null. */
  private cannotRun(site: SiteRow): string | null {
    if (site.status !== 'running') return `The site is ${site.status}.`;
    if (this.s.monitor.busySlugs.has(site.slug) || this.s.monitor.held(site.id)) return 'A job is working on the site; it runs once that is done.';
    return null;
  }

  /** The lines running on a server: this panel's runs, and those it lost sight of. */
  private runningOn(serverId: number, now: number): number {
    const ids = new Set<number>();
    for (const [id, run] of this.running) if (run.serverId === serverId) ids.add(id);
    const unseen = this.s.db
      .select({ line: siteCron })
      .from(siteCron)
      .innerJoin(sites, eq(sites.id, siteCron.siteId))
      .where(and(eq(sites.serverId, serverId), isNotNull(siteCron.lastStartedAt), isNull(siteCron.lastMs)))
      .all();
    for (const { line } of unseen) if (this.isRunning(line, now)) ids.add(line.id);
    return ids.size;
  }

  /**
   * Running: started by this panel and not yet seen to end, or started with no end seen (a panel
   * restart, a lost connection) and still inside its stop-after time, where the container may still
   * be running it. A run seen to end, or refused before it started, has its time (lastMs) recorded.
   * The stop-after time is the one the run started with: the line's may have been changed since,
   * and Docker's `timeout` still holds the run to its own.
   */
  private isRunning(row: SiteCronRow, now: number): boolean {
    if (this.running.has(row.id)) return true;
    if (row.lastStartedAt === null || row.lastMs !== null) return false;
    return now < row.lastStartedAt + (row.lastTimeoutMin ?? row.timeoutMin) * 60_000 + LOST_RUN_GRACE_MS;
  }

  private advance(row: SiteCronRow, now: number): void {
    this.s.db.update(siteCron).set({ nextRunAt: nextCronRun(row.expr, new Date(now)) }).where(eq(siteCron.id, row.id)).run();
  }

  private start(site: SiteRow, row: SiteCronRow, now: number, opts: { advance: boolean }): void {
    // The start is written first: a write that fails (a full disk) leaves nothing marked running,
    // and the next tick tries again.
    this.s.db
      .update(siteCron)
      .set({
        lastStartedAt: now,
        lastTimeoutMin: row.timeoutMin,
        lastMs: null,
        lastExit: null,
        lastOutput: null,
        lastError: null,
        ...(opts.advance ? { nextRunAt: nextCronRun(row.expr, new Date(now)) } : {}),
      })
      .where(eq(siteCron.id, row.id))
      .run();
    this.running.set(row.id, { siteId: site.id, serverId: site.serverId, startedAt: now });
    const run = this.execute(site, row, now).finally(() => {
      this.running.delete(row.id);
      this.inFlight.delete(run);
    });
    this.inFlight.add(run);
  }

  /**
   * The run itself; how it ended is written to its line, whatever it was. One whose end the panel
   * did not see keeps no time (lastMs), so it counts as running until its stop-after time.
   */
  private async execute(site: SiteRow, row: SiteCronRow, startedAt: number): Promise<void> {
    const tail = new OutputTail();
    const timeoutMs = row.timeoutMin * 60_000;
    const stopped = `Stopped after ${row.timeoutMin} ${row.timeoutMin === 1 ? 'minute' : 'minutes'}.`;
    let started = false;
    let end: { exit: number | null; error: string | null; seen: boolean };
    try {
      const docker = this.s.servers.handleFor(site.serverId).docker;
      const opts = { ...asSiteUser(timeoutMs), onStarted: () => (started = true) };
      const res = await docker.execToStream(site.containerName, cronExec(row.command), tail, opts);
      end = { exit: res.exitCode, error: null, seen: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AppError && err.code === 'timeout') {
        // `timeout` ended it at its time (DockerService reads its 124 as a timeout): what it
        // printed until then is in the tail all the same.
        end = { exit: 124, error: stopped, seen: true };
      } else if (!started) {
        end = { exit: null, error: `It did not start: ${message}`.slice(0, 500), seen: true };
      } else {
        // The connection went, not the command (DockerService says so): it runs on to its deadline.
        this.s.log.warn(`Cron line #${row.id} of "${site.slug}": lost sight of its run: ${message}`);
        const why = err instanceof AppError && err.code === 'bad_gateway' ? 'the connection to its server was lost while it ran.' : message;
        end = { exit: null, error: `How it ended is not known: ${why}`.slice(0, 500), seen: false };
      }
    }
    try {
      this.s.db
        .update(siteCron)
        .set({ lastMs: end.seen ? Date.now() - startedAt : null, lastExit: end.exit, lastOutput: tail.text(), lastError: end.error })
        // Not when the line was saved again with another command meanwhile: that is a run of the old one.
        .where(and(eq(siteCron.id, row.id), eq(siteCron.lastStartedAt, startedAt)))
        .run();
    } catch (err) {
      // The database is closing (a shutdown): the run happened, and its result is lost with it.
      this.s.log.warn(`Cron line #${row.id} of "${site.slug}": its result could not be kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function assertPhp(site: SiteRow): void {
  if (!isPhpSite(site)) throw conflict(`"${site.slug}" is a WordPress site: cron lines are for PHP sites. WordPress's own cron runs by itself.`);
}
