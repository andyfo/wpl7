import { Cron } from 'croner';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { jobs, siteWpStatus, sites, type JobRow, type ScheduleRow } from '../db/schema.js';
import type { CoreServices } from '../services/index.js';
import type { JobWorker } from './worker.js';
import { reconcileSiteNetworks } from '../services/siteNetwork.js';
import { siteRuntimeFrom } from '../services/siteSpec.js';
import { sweepLegacyRename } from '../services/legacyRename.js';
import { sweepHardening } from '../services/siteHardening.js';
import { FIRST_CHECK_DELAY_MS } from '../services/updates.js';
import { fleetScanPass } from '../services/wpBulk.js';
import { ScheduleStore, customCronProblem, graceMs, nextCronRun } from '../services/schedules.js';
import { describeCron } from '../../shared/cron.js';
import { JOB_TYPE_INFO } from '../../shared/jobTypes.js';
import {
  MAX_CUSTOM_SCHEDULES,
  scheduleCreateBody,
  scheduleTargetSchema,
  type ScheduleAction,
  type ScheduleCreateBody,
  type ScheduleTarget,
  type ScheduleUpdateBody,
} from '../../shared/scheduleActions.js';
import type { JobStatus } from '../../shared/schemas.js';
import type { ScheduleDto, ScheduleOutcome, ScheduleRunDto, ScheduleRunResult, ScheduleSkip } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { jobToDto } from '../lib/dto.js';
import type { AccessLevel } from '../../shared/access.js';
import { currentActor, runAs, type JobActor } from './actor.js';
import { checkTarget, fireAction, publicParams, withStoredSecrets } from './actions.js';

/** How long a maintenance flag is left alone before it is treated as possibly stale. */
const MAINTENANCE_GRACE_MS = 60_000;
const HOUSEKEEPING_CRON = '0 4 * * *';
const MIN = 60_000;
/** How often due custom schedules are looked for; cron has minute resolution. */
const CUSTOM_TICK_MS = 30_000;
/** Skips kept with a run (the DTO, the Schedules page): enough to see the pattern. */
const MAX_SKIPS_KEPT = 20;
/** "Mon 28 Sep, 07:06" on the panel's clock - the one cron expressions run on too. */
const ONCE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Why a run started: a timer, the panel booting, an event that kicks it, or a person. */
export type RunHow = 'timer' | 'boot' | 'kick' | 'manual';

/** What a task's tick reports. Nothing at all means "ran, fine". */
export interface TaskResult {
  /**
   * Nothing to do this time (not due, nothing outstanding). Not recorded, so "last run"
   * keeps meaning the last time the task actually did something - a wp-scan check that finds
   * nothing due every ten minutes would otherwise always read "a minute ago".
   */
  idle?: boolean;
  outcome?: ScheduleOutcome;
  message?: string | null;
  error?: string | null;
  skipped?: ScheduleSkip[];
}

export interface TaskCadence {
  cron?: string;
  everyMs?: number;
  text: string;
  settingsHref?: string;
}

interface BuiltinTask {
  key: string;
  /** `jobs`: queues jobs you can open; `background`: works inside the panel process. */
  group: 'jobs' | 'background';
  name: string;
  description: string;
  pausable: boolean;
  /** Why it cannot be paused. */
  lockedReason?: string;
  /** What stops while it is paused. */
  pauseWarning?: string;
  cadence(): TaskCadence;
  /** Defaults to the cron's next time, or the last tick plus the interval. */
  nextRunAt?(): number | null;
  /** Synchronous where it can be: an offsite kick must have queued its uploads when it returns. */
  tick(how: RunHow): TaskResult | void | Promise<TaskResult | void>;
}

export interface RunReport {
  jobs: JobRow[];
  skipped: ScheduleSkip[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isPromise = <T>(v: unknown): v is Promise<T> => typeof (v as Promise<T> | null)?.then === 'function';

function everyText(ms: number): string {
  if (ms % 3600_000 === 0) return ms === 3600_000 ? 'Every hour' : `Every ${ms / 3600_000} hours`;
  if (ms % MIN === 0) return ms === MIN ? 'Every minute' : `Every ${ms / MIN} minutes`;
  return `Every ${Math.round(ms / 1000)} seconds`;
}

/**
 * Everything the panel runs on its own, and the one place it all goes through.
 *
 * The built-in tasks - scheduled backups, the WordPress scan, offsite copies, the nightly
 * housekeeping and a dozen monitoring ticks - are a registry; custom schedules (made on the
 * Schedules page or over the API) are rows. Either way a run goes through `run()`, which is
 * what makes a pause hold on every entry point (timer, boot, kick), keeps one run of a task
 * at a time, credits the jobs it queues to the schedule (src/jobs/actor.ts) and records how
 * the run went for the Schedules page.
 *
 * Constructed in tests too - without `start()`, which is the only thing that arms a timer.
 */
export class Schedulers {
  private backupCron: Cron | null = null;
  private housekeepingCron: Cron | null = null;
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  private backupPattern: string;
  private readonly store: ScheduleStore;
  private readonly tasks: Map<string, BuiltinTask>;
  /** Tasks (by key) and custom schedules (by id) with a run in progress. */
  private readonly runningTasks = new Set<string>();
  private readonly runningCustom = new Set<number>();
  /** Last time each interval task ticked at all - idle ticks included - for "next run". */
  private readonly lastTickAt = new Map<string, number>();
  private readonly bootedAt = Date.now();
  /** When the site-networks task last looked for containers without the protection mounts. */
  private hardeningSweptAt = 0;
  /** The intervals in force: read once, like the timers that use them. */
  private readonly uptimeMs: number;
  private readonly statsMs: number;
  private readonly duMin: number;
  private readonly duSliceMs: number;

  constructor(
    private readonly s: CoreServices,
    private readonly worker: JobWorker,
  ) {
    this.store = new ScheduleStore(s.db);
    this.backupPattern = s.settings.get('backupCron');
    this.uptimeMs = (s.settings.get('monitorUptimeIntervalSec') || 60) * 1000;
    this.statsMs = (s.settings.get('monitorStatsIntervalSec') || 60) * 1000;
    this.duMin = s.settings.get('monitorDuIntervalMin') || 30;
    // du staggers itself one site per tick; run a slice every duMin/10 so a full pass
    // over ~10 sites completes within the configured interval.
    this.duSliceMs = Math.max(MIN, (this.duMin * MIN) / 10);
    this.tasks = new Map(this.defineTasks().map((t) => [t.key, t]));
    this.store.ensureBuiltins([...this.tasks.values()]);
    // Offsite uploads are kicked by events (a backup finished, a destination was added) as
    // well as by the minute timer; through the runner, a pause holds for both.
    s.offsite.attachKicker(() => void this.run('offsite', 'kick'));
  }

  // ------------------------------------------------------------------ the registry

  private defineTasks(): BuiltinTask[] {
    const s = this.s;
    return [
      {
        key: 'backups',
        group: 'jobs',
        name: 'Scheduled backups',
        description:
          "Backs up every running site that has scheduled backups switched on, then takes a snapshot of the panel's own database.",
        pausable: true,
        pauseWarning:
          'No site is backed up on schedule until you resume. Manual backups, the safety copy before a restore and the final backup of a deleted site still happen.',
        cadence: () => ({
          cron: this.backupPattern,
          text: describeCron(this.backupPattern) ?? this.backupPattern,
          settingsHref: '/settings#backups',
        }),
        nextRunAt: () => nextCronRun(this.backupPattern),
        tick: () => this.backupTick(),
      },
      {
        key: 'wp-scan',
        group: 'jobs',
        name: 'WordPress inventory scan',
        description:
          "Re-reads what every running site has installed and what has an update, and checks it against the vulnerability feed. It is queued as soon as any site's snapshot is older than the interval.",
        pausable: true,
        pauseWarning:
          'Update counts and vulnerability warnings go stale until you resume. "Rescan all" and "Check now" still work.',
        cadence: () => {
          const hours = this.wpScanIntervalHours();
          return {
            everyMs: hours * 3600_000,
            text: `Every ${plural(hours, 'hour')} per site, checked every 10 minutes`,
            settingsHref: '/settings#wordpress',
          };
        },
        nextRunAt: () => this.wpScanNextDue(),
        tick: (how) => this.wpScanTick(how),
      },
      {
        key: 'malware-scan',
        group: 'jobs',
        name: 'Malware scans',
        description:
          "Queues each site's malware scan when it is due, the most overdue first: at most three at a time across all servers, one per server, and none on a server short of memory. Also checks the plugin catalog's zips that have not been checked with this AMWScan yet.",
        pausable: true,
        pauseWarning: 'No site is scanned for malware until you resume. "Scan now" on a site still works.',
        cadence: () => {
          const hours = Math.max(1, Number(s.settings.get('scanIntervalHours')) || 24);
          return {
            everyMs: hours * 3600_000,
            text: `Every ${plural(hours, 'hour')} per site, checked every 10 minutes`,
            settingsHref: '/settings#security',
          };
        },
        tick: () => {
          const { queued, deferred } = s.malwareScan.schedulePass(this.worker, (id) => s.monitor.memoryUsed(id));
          const zips = s.pluginZipChecks.sweep(this.worker);
          if (queued.length === 0 && deferred.length === 0 && zips.length === 0) return { idle: true };
          const said = [
            queued.length > 0 ? `Queued ${plural(queued.length, 'scan')}: ${queued.join(', ')}` : null,
            zips.length > 0 ? `Queued ${plural(zips.length, 'zip check')}: ${zips.join(', ')}` : null,
          ].filter(Boolean);
          return {
            message: said.length > 0 ? said.join('. ') : 'Nothing queued',
            ...(deferred.length > 0 ? { skipped: deferred } : {}),
          };
        },
      },
      {
        key: 'offsite',
        group: 'jobs',
        name: 'Offsite copies',
        description:
          'Queues an upload for every backup an offsite destination should hold and does not yet, and retries the failed ones when they are due.',
        pausable: true,
        pauseWarning:
          'No backup is copied offsite until you resume, so destinations fall behind. To stop a single destination, pause it under Backups -> Storage instead.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute, and right after each backup' }),
        tick: () => this.offsiteTick(),
      },
      {
        key: 'site-limits',
        group: 'jobs',
        name: 'Container limits follow-up',
        description:
          'New container limits reach each server as a pass that skips the sites busy at that moment. This queues another pass for a server once one of those sites is free.',
        pausable: true,
        pauseWarning: 'Sites that were busy when the limits changed keep their old limits until you resume.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute, after limits changed', settingsHref: '/settings#limits' }),
        tick: () => this.siteLimitsTick(),
      },
      {
        key: 'housekeeping',
        group: 'jobs',
        name: 'Nightly housekeeping',
        description: JOB_TYPE_INFO['system.housekeeping'].description,
        pausable: true,
        pauseWarning:
          'Old backups, statistics, logs and finished jobs stop being removed, so disks and the database keep growing until you resume.',
        cadence: () => ({ cron: HOUSEKEEPING_CRON, text: describeCron(HOUSEKEEPING_CRON) ?? HOUSEKEEPING_CRON }),
        nextRunAt: () => nextCronRun(HOUSEKEEPING_CRON),
        tick: () => this.housekeepingTick(),
      },
      {
        key: 'wp-cron',
        group: 'background',
        name: 'WordPress cron',
        description:
          "Runs the due WP-Cron events of every running site - scheduled posts, plugin tasks, WooCommerce emails. Sites have WordPress's visitor-triggered cron switched off, so this is what runs them.",
        pausable: true,
        pauseWarning: 'Scheduled posts, plugin tasks and WooCommerce emails stop running on every site until you resume.',
        cadence: () => ({ everyMs: 5 * MIN, text: 'Every 5 minutes' }),
        tick: () => this.wpCronTick(),
      },
      {
        key: 'uptime',
        group: 'background',
        name: 'Uptime checks',
        description: 'Asks every running site for its home page and records whether it answered.',
        pausable: true,
        pauseWarning: 'A site that goes down is not noticed until you resume.',
        cadence: () => ({ everyMs: this.uptimeMs, text: everyText(this.uptimeMs), settingsHref: '/settings#monitoring' }),
        tick: () => s.monitor.tickUptime(),
      },
      {
        key: 'site-stats',
        group: 'background',
        name: 'Site resource stats',
        description: "Records each site container's CPU and memory use for the charts.",
        pausable: true,
        pauseWarning: 'The site charts get a gap until you resume.',
        cadence: () => ({ everyMs: this.statsMs, text: everyText(this.statsMs), settingsHref: '/settings#monitoring' }),
        tick: () => s.monitor.tickContainerStats(),
      },
      {
        key: 'server-stats',
        group: 'background',
        name: 'Server resource stats',
        description: "Records each server's load, memory and disk for the dashboard and its charts.",
        pausable: true,
        pauseWarning: 'The dashboard and the server charts stop updating until you resume.',
        cadence: () => ({ everyMs: this.statsMs, text: everyText(this.statsMs), settingsHref: '/settings#monitoring' }),
        tick: () => s.monitor.tickServerStats(),
      },
      {
        key: 'disk-usage',
        group: 'background',
        name: 'Disk usage',
        description: "Measures how much disk each site's files take, a few sites at a time.",
        pausable: true,
        pauseWarning: 'Disk sizes on the site pages stop updating until you resume.',
        cadence: () => ({
          everyMs: this.duSliceMs,
          text: `A few sites ${everyText(this.duSliceMs).toLowerCase()}; each site about every ${this.duMin} minutes`,
          settingsHref: '/settings#monitoring',
        }),
        tick: () => s.monitor.tickDiskUsage(),
      },
      {
        key: 'traffic-ingest',
        group: 'background',
        name: 'Visitor statistics',
        description: "Reads each server's Traefik access log into the visitor statistics.",
        pausable: true,
        pauseWarning: 'Visitor statistics stop updating, and visits made while it is paused may not be counted.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute' }),
        tick: () => s.traffic.ingestTick(),
      },
      {
        key: 'update-check',
        group: 'background',
        name: 'Update check',
        description: "Asks GitHub whether a newer panel release is out on this install's channel.",
        pausable: true,
        pauseWarning: 'The panel stops noticing new releases until you resume. "Check now" on the Updates card still works.',
        cadence: () => ({ everyMs: 3600_000, text: 'Every hour', settingsHref: '/settings#updates' }),
        nextRunAt: () => s.updates.status().nextCheckAt,
        tick: async (how) => {
          if (how === 'manual') {
            const status = await s.updates.check();
            return status.error ? { outcome: 'failed', error: status.error } : {};
          }
          return (await s.updates.tick()) ? {} : { idle: true };
        },
      },
      {
        key: 'catalog',
        group: 'background',
        name: 'Recipe catalog',
        description: 'Fetches the public recipe catalog and checks its signature.',
        pausable: true,
        pauseWarning: 'New and changed recipes stop arriving until you resume. "Fetch now" on the Recipes page still works.',
        cadence: () => ({ everyMs: 3600_000, text: 'Every hour' }),
        tick: async () => {
          const outcome = await s.catalogSync.refresh();
          if (outcome === 'failed') {
            return { outcome: 'failed', error: s.catalogSync.state().error ?? 'The catalog could not be fetched' };
          }
          if (outcome === 'disabled') return { message: 'Fetching the catalog is switched off on this install' };
          return { message: outcome === 'updated' ? 'The catalog changed' : null };
        },
      },
      {
        key: 'mail-ingest',
        group: 'background',
        name: 'Mail log',
        description:
          "Reads each server's mail relay log into Mail traffic and enforces the per-site sending limits. Also puts back the relay's hostname when a restart has changed it.",
        pausable: false,
        lockedReason: 'It is also what enforces the sending limits that suspend a site sending spam.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute' }),
        tick: () => s.mail.ingestTick(),
      },
      {
        key: 'site-networks',
        group: 'background',
        name: 'Site network repair',
        description:
          "Re-attaches Traefik, the mail relay and MariaDB to every site's network. Compose drops those connections whenever it recreates the stack. Also rebuilds, once, any site container made before its protection reached inside it.",
        pausable: false,
        lockedReason: 'Without it, a redeployed stack can leave sites unreachable.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute' }),
        tick: async (how) => {
          const result = await this.networkTick();
          // The rename sweep follows the boot repair rather than racing it - a site whose
          // endpoints have just been repaired is serving again before its reconcile takes
          // its container away.
          if (how === 'boot') await sweepLegacyRename(s, this.worker);
          // Containers built before the protection mounts: at boot for the same reason, then
          // hourly for the ones that were busy or on a server that was away. Once every
          // container carries the mounts, this is one container list per server an hour.
          if (how === 'boot' || Date.now() - this.hardeningSweptAt >= 60 * MIN) {
            this.hardeningSweptAt = Date.now();
            await sweepHardening(s, this.worker);
          }
          return result;
        },
      },
      {
        key: 'site-protection',
        group: 'background',
        name: 'Site protection',
        description:
          "Keeps each server's rules folder in line with every site's protection: writes what changed and removes the rules of sites that no longer run there.",
        pausable: false,
        lockedReason: 'It puts protection back on a server that lost it, and takes it off a site switched to Off.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute, and right after each change' }),
        tick: () => {
          const { kicked } = s.security.tick();
          return kicked > 0 ? { message: `Checking ${plural(kicked, 'server')}` } : { idle: true };
        },
      },
      {
        key: 'blocked-addresses',
        group: 'background',
        name: 'Blocked addresses',
        description:
          'Decides which attacking addresses to block, ends the blocks whose time is up, and puts the list in force on every server: in its network firewall, and in Traefik for visitors behind a trusted proxy.',
        pausable: false,
        lockedReason: 'It is what ends blocks on time and restores them on a server that rebooted.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute, and right after each change' }),
        tick: (how) => this.blockedAddressesTick(how),
      },
      {
        key: 'ftp',
        group: 'background',
        name: 'FTP upkeep',
        description: "Switches off FTP and SFTP logins when they expire and keeps each server's file gateway running.",
        pausable: false,
        lockedReason: 'It is what switches off expired FTP logins.',
        cadence: () => ({ everyMs: MIN, text: 'Every minute' }),
        tick: () => s.ftp.tick(),
      },
      {
        key: 'update-watchdog',
        group: 'background',
        name: 'Update watchdog',
        description: 'Lifts the read-only mode a panel update sets, once that update is over - including one that failed early.',
        pausable: false,
        lockedReason: 'A failed update would otherwise leave the panel read-only.',
        cadence: () => ({ everyMs: 30_000, text: 'Every 30 seconds' }),
        tick: () => this.maintenanceFlagTick(),
      },
    ];
  }

  // ------------------------------------------------------------------ timers

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleBackups(this.backupPattern);
    this.housekeepingCron = new Cron(HOUSEKEEPING_CRON, () => void this.run('housekeeping', 'timer'));

    const every = (key: string, ms: number) => setInterval(() => void this.run(key, 'timer'), ms);
    const after = (ms: number, fn: () => void) => setTimeout(fn, ms);
    this.timers = [
      every('uptime', this.uptimeMs),
      every('site-stats', this.statsMs),
      every('server-stats', this.statsMs),
      every('disk-usage', this.duSliceMs),
      every('wp-cron', 5 * MIN),
      // Traffic is reconstructed from each relay's log, so the view is only ever as fresh
      // as this tick; a minute keeps the abuse counters useful without hammering the
      // Docker API of every server.
      every('mail-ingest', MIN),
      // Visitor statistics are reconstructed from each Traefik's access log the same way,
      // and on the same cadence - a minute of resolution is plenty for a traffic chart.
      every('traffic-ingest', MIN),
      // Site networks are created by the panel, but Traefik, the relay and MariaDB are
      // recreated by compose - which knows nothing about them, and drops those endpoints
      // every time the stack is redeployed. Repairing them on a timer is what keeps a
      // `docker compose up` from quietly unrouting every site.
      every('site-networks', MIN),
      // New container limits reach every site from a job per server, which cannot queue a
      // site that is busy with a job of its own the recreate it may need. This comes back
      // for those once that job has run.
      every('site-limits', MIN),
      // Checked hourly, but the tick runs every minute so the service can pick its own
      // minute of the hour - every install asking GitHub at :00 is both rude and the
      // fastest way to have a whole fleet rate-limited together.
      every('update-check', MIN),
      // The WordPress inventory is a snapshot, so it is only ever as fresh as this tick.
      // Checked every ten minutes against `wp.scanIntervalHours` rather than on an interval
      // of its own, so changing the setting takes effect without a restart.
      every('wp-scan', 10 * MIN),
      // Malware scans: checked every ten minutes against `scan.intervalHours` and the fleet's
      // three-at-a-time ceiling, so a setting change or a finished scan needs no restart.
      every('malware-scan', 10 * MIN),
      // Offsite copies are reconciled rather than triggered: the tick creates the copy rows
      // policy says should exist and enqueues what is outstanding, so a restart mid-upload,
      // a newly added destination and a re-enabled one all just catch up on their own.
      every('offsite', MIN),
      // FTP logins: every change kicks its own server at once; the tick is for what changes
      // with time rather than an edit - a login expiring, a gateway that died, a server that
      // came back - and it leaves alone every server with nothing FTP to do.
      every('ftp', MIN),
      // Site protection: every change kicks its own server at once; the tick is for what the
      // panel did not do itself - a file deleted by hand, a server that was unreachable.
      every('site-protection', MIN),
      // Blocked addresses: blocks that ran out, and servers whose list changed or rebooted.
      every('blocked-addresses', MIN),
      // The public recipe catalog: a conditional GET an hour, so a recipe published there
      // reaches this install within the hour without a release (docs/licenses.md).
      every('catalog', 3600_000),
      // An update that dies before it ever gets as far as replacing the panel - a pull that
      // fails, a pre-flight that aborts - leaves this process running with the read-only
      // flag it set for itself and no boot to clear it on. Nothing else asks.
      every('update-watchdog', 30_000),
      setInterval(() => void this.runDueCustom(), CUSTOM_TICK_MS),
      // Not at boot: a panel that has just been replaced has migrations, a network reconcile
      // and a mail sync to get through first, and nothing about an update is urgent.
      after(FIRST_CHECK_DELAY_MS, () => void this.run('update-check', 'boot')),
      // Custom schedules missed while the panel was down: once the stack has settled.
      after(CUSTOM_TICK_MS, () => void this.runDueCustom()),
    ];
    // Half a minute after boot rather than now: a panel that just came up has a stack still
    // settling around it and a network that may not be there yet; and a failed fetch is
    // only ever a warning, since the last verified copy was loaded already.
    if (this.s.catalogSync.enabled) this.timers.push(after(30_000, () => void this.run('catalog', 'boot')));
    // A panel that was down over its scan interval should catch up - but not while the
    // stack is still coming up around it, hence two minutes rather than now.
    if (this.wpScanIsDue()) this.timers.push(after(2 * MIN, () => void this.run('wp-scan', 'boot')));
    for (const t of this.timers) t.unref();

    // Prime the dashboard immediately instead of waiting for the first interval.
    void this.run('server-stats', 'boot');
    void this.run('uptime', 'boot');
    void this.run('mail-ingest', 'boot');
    void this.run('traffic-ingest', 'boot');
    // Immediately, not in a minute: the panel itself has just been recreated, which is
    // exactly the situation where the infrastructure lost its site-network endpoints.
    void this.run('site-networks', 'boot');
    // Once at boot, on every server: brings up what logins need, and removes anything FTP
    // from a server that no longer has any - after that, only servers with work are visited.
    void this.run('ftp', 'boot');
    // Every server once at boot: a rules folder that drifted while the panel was down (or was
    // written by an older one) is put right, without rewriting what is already right.
    void this.run('site-protection', 'boot');
    void this.run('blocked-addresses', 'boot');
  }

  /** Called on start and whenever the backup cron setting changes. Arms nothing until started. */
  scheduleBackups(pattern: string): void {
    this.backupPattern = pattern;
    if (!this.started) return;
    this.backupCron?.stop();
    this.backupCron = new Cron(pattern, () => void this.run('backups', 'timer'));
  }

  stop(): void {
    this.started = false;
    this.backupCron?.stop();
    this.backupCron = null;
    this.housekeepingCron?.stop();
    this.housekeepingCron = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ------------------------------------------------------------------ the runner

  /**
   * Run a built-in task: the one door every timer, boot run, kick and "Run now" goes through.
   *
   * Skipped (null) while paused - unless a person asked - and while a run of the same task is
   * still going. A synchronous tick completes, recording included, before this returns; an
   * offsite kick has queued its uploads by then, exactly as the direct call used to.
   */
  run(key: string, how: RunHow): Promise<RunReport | null> {
    const task = this.tasks.get(key);
    if (!task) return Promise.reject(notFound(`No task "${key}"`));
    const row = this.store.byKey(key);
    if (!row) return Promise.resolve(null);
    if (how !== 'manual' && row.enabled === 0) return Promise.resolve(null);
    if (this.runningTasks.has(key)) return Promise.resolve(null);

    this.lastTickAt.set(key, Date.now());
    const actor = this.actorFor(row, task.name, how);
    const startedAt = Date.now();
    this.runningTasks.add(key);
    const settle = (result: TaskResult | void, err?: unknown): RunReport => {
      this.runningTasks.delete(key);
      const report = { jobs: actor.jobs ?? [], skipped: result?.skipped ?? [] };
      if (err !== undefined) this.s.log.warn(`${key} tick failed: ${errorText(err)}`);
      if (err === undefined && result?.idle && how !== 'manual') return report;
      this.recordRun(row.id, startedAt, actor.jobs ?? [], result ?? {}, err);
      return report;
    };
    let out: TaskResult | void | Promise<TaskResult | void>;
    try {
      out = runAs(actor, () => task.tick(how));
    } catch (err) {
      return Promise.resolve(settle(undefined, err));
    }
    if (!isPromise<TaskResult | void>(out)) return Promise.resolve(settle(out));
    return out.then(
      (result) => settle(result),
      (err: unknown) => settle(undefined, err),
    );
  }

  /**
   * Scheduled runs are the schedule's; "Run now" keeps who pressed it (the request's actor)
   * and adds which schedule it ran.
   */
  private actorFor(row: ScheduleRow, name: string, how: RunHow): JobActor {
    const caller = currentActor();
    if (how === 'manual' && caller && caller.origin !== 'schedule') {
      return { origin: caller.origin, createdBy: caller.createdBy, scheduleId: row.id, jobs: [] };
    }
    return { origin: 'schedule', createdBy: name, scheduleId: row.id, jobs: [] };
  }

  private recordRun(id: number, startedAt: number, created: JobRow[], result: TaskResult, err: unknown): void {
    const skipped = result.skipped ?? [];
    const outcome: ScheduleOutcome =
      err !== undefined || result.error ? 'failed' : (result.outcome ?? (created.length === 0 && skipped.length > 0 ? 'skipped' : 'ok'));
    try {
      this.store.record(id, {
        at: startedAt,
        durationMs: Date.now() - startedAt,
        outcome,
        error: err !== undefined ? errorText(err) : (result.error ?? null),
        result: { jobs: created.length, skipped: skipped.slice(0, MAX_SKIPS_KEPT), message: result.message ?? null },
      });
    } catch (recordErr) {
      // Shutting down (the database is closing), or a row deleted mid-run: the run happened
      // either way, and a bookkeeping failure must not become the task's failure.
      this.s.log.warn(`Could not record the run of schedule #${id}: ${errorText(recordErr)}`);
    }
  }

  // ------------------------------------------------------------------ built-in ticks

  private backupTick(): TaskResult {
    // Sites with backups switched off are skipped here and only here: a manual backup,
    // the pre-restore safety copy, the copy a move takes and the final backup on delete
    // all still run for them (services/backup.ts). "Here" is whatever `backup.cron`
    // says - the operator can make it hourly or weekly, so nothing may call it nightly.
    const running = this.s.db
      .select()
      .from(sites)
      .where(and(eq(sites.status, 'running'), eq(sites.backupsEnabled, 1)))
      .all();
    const skipped: ScheduleSkip[] = [];
    for (const site of running) {
      try {
        this.worker.enqueue('backup.create', { siteId: site.id, type: 'scheduled' }, { id: site.id, slug: site.slug });
      } catch (err) {
        this.s.log.warn(`Scheduled backup for "${site.slug}" skipped (another job is active)`);
        skipped.push({ siteSlug: site.slug, reason: errorText(err) });
      }
    }
    // The registry is what a fleet is rebuilt from: which servers exist, which domains
    // belong to which site, every DKIM key that has been published. Site backups
    // without it are restorable one at a time and by hand.
    try {
      this.worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 });
    } catch (err) {
      this.s.log.warn('Panel snapshot skipped (server 1 is busy)');
      skipped.push({ siteSlug: null, reason: `Panel snapshot: ${errorText(err)}` });
    }
    return { skipped, outcome: 'ok' };
  }

  private housekeepingTick(): TaskResult {
    const active = this.activeJob('system.housekeeping');
    if (active) return { outcome: 'skipped', message: `Housekeeping is already queued or running (job #${active})` };
    this.worker.enqueue('system.housekeeping', {}, undefined, { lane: 'housekeeping' });
    return {};
  }

  /**
   * A limits pass cannot queue the reconcile that lifts a site's CPU cap while the site already
   * has a job - usually one queued behind the pass in the same lane - so it records the site
   * as deferred. Once one of those sites is free, its server gets another pass, which reads the
   * settings afresh and leaves out only what is busy again. The job's own result is the
   * record, so a restart of the panel in between loses nothing.
   */
  siteLimitsTick(): TaskResult {
    // Lifting a CPU cap is the one change that needs a job of the site's own.
    if (siteRuntimeFrom(this.s.settings).nanoCpus) return { idle: true };
    let queued = 0;
    for (const server of this.s.servers.listRows()) {
      if (server.status === 'unreachable') continue; // next tick
      const last = this.s.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, 'server.applySiteLimits'), eq(jobs.serverId, server.id)))
        .orderBy(desc(jobs.id))
        .get();
      // A pass still to run sees those sites for itself.
      if (!last || last.status === 'queued' || last.status === 'running') continue;
      const deferred = (last.result ? (JSON.parse(last.result) as { deferred?: string[] }).deferred : null) ?? [];
      if (deferred.length === 0) continue;
      // Moved or deleted since, they are no longer this server's to wait for.
      const free = this.s.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.serverId, server.id), inArray(sites.slug, deferred)))
        .all()
        .some((site) => !this.worker.activeSiteJob(site.id));
      if (!free) continue;
      const job = this.worker.enqueue('server.applySiteLimits', { serverId: server.id }, undefined, { serverId: server.id });
      queued++;
      this.s.log.info(`Container limits: another pass queued for "${server.name}" (job #${job.id}), for ${deferred.join(', ')}`);
    }
    return queued > 0 ? {} : { idle: true };
  }

  private offsiteTick(): TaskResult {
    if (!this.s.offsite.anyConfigured()) return { idle: true };
    const { created, enqueued } = this.s.offsite.tick();
    if (created === 0 && enqueued === 0) return { idle: true };
    this.s.log.info(`Offsite: ${created} copy/copies queued, ${enqueued} upload job(s) started`);
    return { message: `${plural(created, 'copy', 'copies')} to make, ${plural(enqueued, 'upload')} started` };
  }

  /**
   * Lift the read-only flag once the update that set it is over.
   *
   * The grace period is the point. `start()` sets the flag and *then* hands the update to
   * systemd, so for a second or two the newest thing on disk is the PREVIOUS update's state
   * file - which is terminal, and would have this tick decide the update is finished before
   * it has begun. A flag younger than the grace belongs to an update that has not had the
   * chance to announce itself yet.
   */
  private async maintenanceFlagTick(): Promise<TaskResult> {
    const active = this.s.system.maintenance();
    if (!active || Date.now() - active.since < MAINTENANCE_GRACE_MS) return { idle: true };
    await this.s.system.clearStaleMaintenance();
    return this.s.system.maintenance() ? { idle: true } : { message: 'Lifted the read-only mode of an update that has ended' };
  }

  /**
   * Blocked addresses, every minute: end what ran out (the kernel already let it go), then
   * bring each server in line. A server is only loaded again when its list changed, its table
   * went missing or it rebooted (services/firewallSync.ts).
   */
  private async blockedAddressesTick(how: RunHow): Promise<TaskResult> {
    const s = this.s;
    // Detection must not stop because the statistics are paused: read the logs for it alone.
    if (this.store.byKey('traffic-ingest')?.enabled === 0) await s.traffic.ingestTick({ stats: false });
    // A restart is no pause for an attack under way: count its last ten minutes again.
    if (how === 'boot') {
      const servers = s.servers.listRows().filter((r) => r.status !== 'unreachable').map((r) => r.id);
      await s.detector.rebuild((id, since) => s.traffic.readBeforeBoot(id, since), servers);
    }
    const expired = s.blocklist.expire();
    const decided = await s.detector.evaluate();
    const { kicked } = s.firewall.tick();
    if (expired === 0 && kicked === 0 && decided.blocked + decided.observed === 0) return { idle: true };
    return {
      message: [
        decided.blocked > 0 ? `${plural(decided.blocked, 'address', 'addresses')} blocked` : null,
        decided.observed > 0 ? `${plural(decided.observed, 'address', 'addresses')} would have been blocked` : null,
        expired > 0 ? `${plural(expired, 'block')} ended` : null,
        kicked > 0 ? `checking ${plural(kicked, 'server')}` : null,
      ]
        .filter(Boolean)
        .join(', '),
    };
  }

  /** Re-attach Traefik, the relay and MariaDB to every site network, on every server. */
  private async networkTick(): Promise<TaskResult> {
    let total = 0;
    for (const row of this.s.servers.listRows()) {
      if (row.status === 'unreachable') continue;
      try {
        const handle = this.s.servers.handleFor(row.id);
        const { repaired, networks } = await reconcileSiteNetworks(handle.docker);
        if (repaired > 0) {
          total += repaired;
          this.s.log.info(`Site networks on "${row.name}": re-attached ${repaired} endpoint(s) across ${networks} network(s)`);
        }
      } catch (err) {
        this.s.log.warn(`Site network reconcile on "${row.name}" failed: ${errorText(err)}`);
      }
    }
    return { message: total > 0 ? `Re-attached ${plural(total, 'endpoint')}` : null };
  }

  /** DISABLE_WP_CRON pairs with this: run due WP cron events for every running site. */
  private async wpCronTick(): Promise<TaskResult> {
    const running = this.s.db.select().from(sites).where(eq(sites.status, 'running')).all();
    const byServer = new Map<number, typeof running>();
    for (const site of running) {
      const list = byServer.get(site.serverId) ?? [];
      list.push(site);
      byServer.set(site.serverId, list);
    }
    let ran = 0;
    await Promise.all(
      [...byServer.entries()].map(async ([serverId, list]) => {
        let handle;
        try {
          handle = this.s.servers.handleFor(serverId);
        } catch {
          return;
        }
        if (handle.row.status === 'unreachable') return; // skip; heartbeat re-enables it
        for (const site of list) {
          if (this.s.monitor.busySlugs.has(site.slug)) continue;
          try {
            await handle.wp.cronRunDue(site.containerName);
            ran++;
          } catch {
            /* site may be restarting; next tick catches up */
          }
        }
      }),
    );
    return { message: running.length === 0 ? 'No running site' : `Ran due events on ${plural(ran, 'site')}` };
  }

  private wpScanIntervalHours(): number {
    return Math.max(1, this.s.settings.get('wpScanIntervalHours') || 6);
  }

  /**
   * Is a fleet inventory scan overdue?
   *
   * Two conditions, and the first one is per site rather than fleet-wide: some RUNNING site
   * has a snapshot older than the interval (or none at all). Asking for the newest
   * `scanned_at` across the fleet was wrong in a way that got worse the busier the install
   * was - one "Check now", or any WordPress job on any site, reset the deadline for
   * everybody, so on a fleet with activity every few hours the other sites (and every newly
   * created one) were never scanned at all.
   *
   * The second condition is a floor: no fleet pass was STARTED within the interval. Without
   * it, a site that cannot be scanned - stopped server, permanently busy - would keep the
   * first condition true forever and enqueue a fresh pass every ten minutes. A scan a custom
   * schedule ran over some sites is not a fleet pass: counted, an hourly scan of one site
   * kept the floor up for good, and no other site was ever scanned again.
   */
  wpScanIsDue(): boolean {
    const intervalMs = this.wpScanIntervalHours() * 3600_000;
    const cutoff = Date.now() - intervalMs;
    const overdue = this.s.db
      .select({ id: sites.id })
      .from(sites)
      .leftJoin(siteWpStatus, eq(siteWpStatus.siteId, sites.id))
      .where(
        and(
          eq(sites.status, 'running'),
          or(isNull(siteWpStatus.scannedAt), lt(siteWpStatus.scannedAt, cutoff)),
        ),
      )
      .limit(1)
      .all();
    if (overdue.length === 0) return false;
    const lastPass = this.lastScanPassAt();
    return lastPass === null || lastPass < cutoff;
  }

  private lastScanPassAt(): number | null {
    return (
      this.s.db
        .select({ createdAt: jobs.createdAt })
        .from(jobs)
        .where(fleetScanPass())
        .orderBy(desc(jobs.id))
        .limit(1)
        .get()?.createdAt ?? null
    );
  }

  /** When wpScanIsDue() next turns true, by the same two conditions; null with nothing to scan. */
  private wpScanNextDue(): number | null {
    const intervalMs = this.wpScanIntervalHours() * 3600_000;
    const oldest = this.s.db
      .select({ at: sql<number>`min(coalesce(${siteWpStatus.scannedAt}, 0))` })
      .from(sites)
      .leftJoin(siteWpStatus, eq(siteWpStatus.siteId, sites.id))
      .where(eq(sites.status, 'running'))
      .get();
    if (oldest?.at === null || oldest?.at === undefined) return null;
    const lastPass = this.lastScanPassAt();
    return Math.max(oldest.at + intervalMs, lastPass === null ? 0 : lastPass + intervalMs, Date.now());
  }

  private wpScanTick(how: RunHow): TaskResult {
    if (how !== 'manual' && !this.wpScanIsDue()) return { idle: true };
    const active = this.activeJob('wp.scanAll');
    if (active) {
      return how === 'manual'
        ? { outcome: 'skipped', message: `A scan is already queued or running (job #${active})` }
        : { idle: true };
    }
    const job = this.worker.enqueue('wp.scanAll', {});
    this.s.log.info(`WordPress inventory scan queued (job #${job.id})`);
    return {};
  }

  private activeJob(type: string): number | null {
    return (
      this.s.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.type, type), inArray(jobs.status, ['queued', 'running'])))
        .orderBy(desc(jobs.id))
        .get()?.id ?? null
    );
  }

  // ------------------------------------------------------------------ custom schedules

  /**
   * Fire the custom schedules that are due. At most once each: a row is moved on before it
   * fires, several missed occurrences collapse into one, and one that is too late (the
   * panel was down past its grace) is recorded as missed rather than run hours afterwards.
   */
  async runDueCustom(now = Date.now()): Promise<void> {
    // Mid-update the panel is about to be replaced; whatever is due is still due afterwards,
    // and the grace rule decides then whether it is too late.
    if (this.s.system.maintenance()) return;
    for (const row of this.store.due(now)) {
      const scheduledFor = row.nextRunAt!;
      const late = now - scheduledFor > graceMs(row);
      this.store.advance(row, now);
      if (late) {
        this.recordRun(row.id, now, [], {
          outcome: 'skipped',
          message: `Missed the run due ${new Date(scheduledFor).toISOString()} while the panel was down`,
        }, undefined);
        continue;
      }
      try {
        this.fireCustom(row, 'timer');
      } catch (err) {
        this.s.log.warn(`Schedule "${row.name}" failed to run: ${errorText(err)}`);
      }
    }
  }

  private fireCustom(row: ScheduleRow, how: RunHow): RunReport {
    if (this.runningCustom.has(row.id)) throw conflict(`"${row.name}" is already running`);
    const actor = this.actorFor(row, row.name, how);
    const startedAt = Date.now();
    this.runningCustom.add(row.id);
    try {
      const outcome = runAs(actor, () =>
        fireAction(
          this.s,
          this.worker,
          row.action as ScheduleAction,
          scheduleTargetSchema.parse(JSON.parse(row.target ?? '{}')),
          JSON.parse(row.params ?? '{}') as Record<string, unknown>,
          { name: row.name },
        ),
      );
      this.recordRun(
        row.id,
        startedAt,
        outcome.jobs,
        // A run that queued nothing did not do its job, whatever the reason.
        { skipped: outcome.skipped, message: outcome.message, outcome: outcome.jobs.length > 0 ? 'ok' : 'skipped' },
        undefined,
      );
      return { jobs: outcome.jobs, skipped: outcome.skipped };
    } catch (err) {
      this.recordRun(row.id, startedAt, actor.jobs ?? [], {}, err);
      throw err;
    } finally {
      this.runningCustom.delete(row.id);
    }
  }

  /**
   * `POST /schedules`. `guard` sees the definition once it is valid, before anything is stored,
   * and throws to refuse it - what the caller's access allows (routes/schedules.ts).
   */
  createCustom(
    input: unknown,
    createdBy: string | null,
    now = Date.now(),
    guard: (definition: ScheduleCreateBody) => void = () => undefined,
  ): ScheduleDto {
    if (this.store.customCount() >= MAX_CUSTOM_SCHEDULES) {
      throw conflict(`There are already ${MAX_CUSTOM_SCHEDULES} custom schedules; delete one first`);
    }
    const body = this.validateDefinition(input, now, true);
    guard(body);
    const row = this.store.create(body, createdBy, body.enabled ? this.firstRun(body, now) : null, now);
    return this.toDto(row);
  }

  /**
   * `PATCH /schedules/:id`: a built-in takes `enabled` only; a custom schedule anything. `guard`
   * sees a custom schedule's definition as it would be after the change, as createCustom's does.
   */
  update(
    idOrKey: string,
    patch: ScheduleUpdateBody,
    now = Date.now(),
    guard: (definition: ScheduleCreateBody) => void = () => undefined,
  ): ScheduleDto {
    const row = this.store.resolve(idOrKey);
    if (!row) throw notFound(`No schedule "${idOrKey}"`);
    if (row.key) {
      const extra = Object.keys(patch).filter((k) => k !== 'enabled');
      if (extra.length > 0 || patch.enabled === undefined) {
        throw badRequest('A built-in schedule can only be paused or resumed; its timing is a setting');
      }
      return this.setEnabled(row, patch.enabled, now);
    }

    const stored = this.definitionOf(row);
    const action = patch.action ?? stored.action;
    const actionChanged = action !== stored.action;
    const merged: Record<string, unknown> = {
      name: patch.name ?? stored.name,
      description: patch.description === null ? undefined : (patch.description ?? stored.description),
      action,
      // A new action starts from its own defaults; the old action's params mean nothing to it.
      params: patch.params ? withStoredSecrets(action, patch.params, stored) : actionChanged ? {} : stored.params,
      target: patch.target ?? stored.target,
      cron: patch.cron === null ? undefined : (patch.cron ?? stored.cron),
      runAt: patch.runAt === null ? undefined : (patch.runAt ?? stored.runAt),
      enabled: patch.enabled ?? stored.enabled,
    };
    const resuming = patch.enabled === true && row.enabled === 0;
    // A time already past is only a problem when it is new, or when a one-off is being
    // switched back on: renaming a one-off that ran last week must still work.
    const checkRunAt = patch.runAt !== undefined || resuming;
    if (this.isFinished(row) && resuming && patch.runAt === undefined && patch.cron === undefined) {
      throw badRequest('This one-off has already run; give it a new "runAt" (or a "cron") to schedule it again');
    }
    const body = this.validateDefinition(merged, now, checkRunAt, stored.target);
    guard(body);
    const unchangedTiming =
      body.cron === (row.cron ?? undefined) && body.runAt === (row.runAt ?? undefined) && body.enabled === (row.enabled === 1);
    // Resuming - or changing when it runs - counts from now: no burst of the runs it missed.
    const nextRunAt = !body.enabled
      ? null
      : unchangedTiming && row.nextRunAt !== null
        ? row.nextRunAt
        : this.firstRun(body, now);
    return this.toDto(this.store.replace(row.id, body, nextRunAt, now));
  }

  /** `DELETE /schedules/:id`. */
  removeCustom(idOrKey: string): void {
    const row = this.store.resolve(idOrKey);
    if (!row) throw notFound(`No schedule "${idOrKey}"`);
    if (row.key) throw badRequest('A built-in schedule cannot be deleted; pause it instead');
    this.store.remove(row.id);
  }

  /** `POST /schedules/:id/run`: now, paused or not. `viewer` is who asked (lib/dto.ts jobToDto). */
  async runNow(idOrKey: string, viewer: AccessLevel): Promise<ScheduleRunDto> {
    const row = this.store.resolve(idOrKey);
    if (!row) throw notFound(`No schedule "${idOrKey}"`);
    if (!row.key) {
      const report = this.fireCustom(row, 'manual');
      return { jobs: report.jobs.map((job) => jobToDto(job, viewer)), skipped: report.skipped, running: false };
    }
    const task = this.tasks.get(row.key);
    if (!task) throw notFound(`No schedule "${idOrKey}"`);
    if (this.runningTasks.has(row.key)) throw conflict(`"${task.name}" is already running`);
    const run = this.run(row.key, 'manual');
    // A background task can take a while (WordPress cron across fifty sites); answer at once
    // and let the caller watch the schedule's `running` and `lastRunAt`.
    if (task.group === 'background') {
      run.catch(() => undefined);
      return { jobs: [], skipped: [], running: true };
    }
    const report = await run;
    return { jobs: (report?.jobs ?? []).map((job) => jobToDto(job, viewer)), skipped: report?.skipped ?? [], running: false };
  }

  private setEnabled(row: ScheduleRow, enabled: boolean, now: number): ScheduleDto {
    const task = row.key ? this.tasks.get(row.key) : null;
    if (task && !task.pausable && !enabled) {
      throw badRequest(`"${task.name}" cannot be paused. ${task.lockedReason ?? ''}`.trim());
    }
    return this.toDto(this.store.setEnabled(row.id, enabled, null, now));
  }

  /**
   * Validate a whole definition: shape, target, cadence, and a one-off's time. `storedTarget`
   * is what a change starts from - see checkTarget for what it lets through.
   */
  private validateDefinition(
    input: unknown,
    now: number,
    checkRunAt: boolean,
    storedTarget: ScheduleTarget | null = null,
  ): ScheduleCreateBody {
    const parsed = scheduleCreateBody.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw badRequest(
        first ? `${first.path.length > 0 ? `${first.path.join('.')}: ` : ''}${first.message}` : 'Invalid schedule',
        parsed.error.issues,
      );
    }
    const body = parsed.data;
    checkTarget(this.s, body.action, body.target, storedTarget);
    if (body.cron !== undefined) {
      const problem = customCronProblem(body.cron, new Date(now));
      if (problem) throw badRequest(`cron: ${problem}`);
    }
    if (checkRunAt && body.runAt !== undefined && body.runAt <= now) {
      throw badRequest('runAt: the time has already passed');
    }
    return body;
  }

  private firstRun(body: ScheduleCreateBody, now: number): number | null {
    return body.cron !== undefined ? nextCronRun(body.cron, new Date(now)) : (body.runAt ?? null);
  }

  private definitionOf(row: ScheduleRow): {
    name: string;
    description: string | undefined;
    action: ScheduleAction;
    params: Record<string, unknown>;
    target: ScheduleTarget;
    cron: string | undefined;
    runAt: number | undefined;
    enabled: boolean;
  } {
    return {
      name: row.name,
      description: row.description ?? undefined,
      action: row.action as ScheduleAction,
      params: JSON.parse(row.params ?? '{}') as Record<string, unknown>,
      target: JSON.parse(row.target ?? '{}') as ScheduleTarget,
      cron: row.cron ?? undefined,
      runAt: row.runAt ?? undefined,
      enabled: row.enabled === 1,
    };
  }

  /** A one-off that has run: off, but not paused - the Schedules page shows it as done. */
  private isFinished(row: ScheduleRow): boolean {
    return row.key === null && row.cron === null && row.enabled === 0 && row.pausedAt === null && row.lastRunAt !== null;
  }

  // ------------------------------------------------------------------ reading

  list(): ScheduleDto[] {
    const rows = this.store.list();
    const context = this.dtoContext(rows);
    const builtins = [...this.tasks.keys()]
      .map((key) => rows.find((r) => r.key === key))
      .filter((r): r is ScheduleRow => r !== undefined);
    const custom = rows.filter((r) => r.key === null);
    return [...builtins, ...custom].map((row) => this.toDto(row, context));
  }

  get(idOrKey: string): ScheduleDto {
    const row = this.store.resolve(idOrKey);
    if (!row || (row.key !== null && !this.tasks.has(row.key))) throw notFound(`No schedule "${idOrKey}"`);
    return this.toDto(row);
  }

  /** Whether the scheduled backup run is paused (GET /meta, for the pages that describe it). */
  backupsPaused(): boolean {
    return this.store.byKey('backups')?.enabled === 0;
  }

  private dtoContext(rows: ScheduleRow[]): { lastJobs: Map<number, Partial<Record<JobStatus, number>>>; slugs: Set<string> } {
    const lastJobs = new Map<number, Partial<Record<JobStatus, number>>>();
    const counted = rows.filter((r) => r.lastRunAt !== null);
    if (counted.length > 0) {
      // The jobs of each schedule's last run: queued by it, at or after that run began.
      const grouped = this.s.db.$client
        .prepare(
          `SELECT j.schedule_id AS id, j.status AS status, count(*) AS n
             FROM jobs j JOIN schedules s ON s.id = j.schedule_id
            WHERE s.last_run_at IS NOT NULL AND j.created_at >= s.last_run_at
            GROUP BY j.schedule_id, j.status`,
        )
        .all() as { id: number; status: JobStatus; n: number }[];
      for (const g of grouped) {
        const counts = lastJobs.get(g.id) ?? {};
        counts[g.status] = g.n;
        lastJobs.set(g.id, counts);
      }
    }
    const slugs = new Set(this.s.db.select({ slug: sites.slug }).from(sites).all().map((r) => r.slug));
    return { lastJobs, slugs };
  }

  private toDto(row: ScheduleRow, context = this.dtoContext([row])): ScheduleDto {
    const last = {
      lastRunAt: row.lastRunAt,
      lastDurationMs: row.lastDurationMs,
      lastOutcome: row.lastOutcome as ScheduleOutcome | null,
      lastError: row.lastError,
      lastResult: row.lastResult ? (JSON.parse(row.lastResult) as ScheduleRunResult) : null,
      lastJobs: context.lastJobs.get(row.id) ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      enabled: row.enabled === 1,
      pausedAt: row.pausedAt,
    };
    const task = row.key ? this.tasks.get(row.key) : null;
    if (task) {
      const cadence = task.cadence();
      const next = task.nextRunAt
        ? task.nextRunAt()
        : cadence.everyMs
          ? (this.lastTickAt.get(task.key) ?? this.bootedAt) + cadence.everyMs
          : null;
      return {
        id: row.id,
        key: task.key,
        kind: 'builtin',
        group: task.group,
        name: task.name,
        description: task.description,
        action: null,
        target: null,
        missing: [],
        params: null,
        cadence: { cron: cadence.cron ?? null, everyMs: cadence.everyMs ?? null, runAt: null, text: cadence.text },
        settingsHref: cadence.settingsHref ?? null,
        pausable: task.pausable,
        lockedReason: task.lockedReason ?? null,
        pauseWarning: task.pauseWarning ?? null,
        running: this.runningTasks.has(task.key),
        finished: false,
        nextRunAt: row.enabled === 1 && this.started ? next : null,
        ...last,
      };
    }
    const target = row.target ? (JSON.parse(row.target) as ScheduleTarget) : null;
    const action = row.action as ScheduleAction;
    return {
      id: row.id,
      key: null,
      kind: 'custom',
      group: 'custom',
      name: row.name,
      // Only what was written for it: an API client must be able to tell "no description"
      // from one that happens to repeat the action's (SCHEDULE_ACTION_INFO has that one).
      description: row.description ?? '',
      action,
      target,
      missing: target?.kind === 'sites' ? target.slugs.filter((slug) => !context.slugs.has(slug)) : [],
      params: row.params ? publicParams(action, JSON.parse(row.params) as Record<string, unknown>) : null,
      cadence: {
        cron: row.cron,
        everyMs: null,
        runAt: row.runAt,
        text: row.cron ? (describeCron(row.cron) ?? row.cron) : `Once, ${ONCE_FORMAT.format(new Date(row.runAt ?? 0))}`,
      },
      settingsHref: null,
      pausable: true,
      lockedReason: null,
      pauseWarning: null,
      running: this.runningCustom.has(row.id),
      finished: this.isFinished(row),
      nextRunAt: row.nextRunAt,
      ...last,
    };
  }
}
