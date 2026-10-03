import fs from 'node:fs';
import path from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { jobs, systemUpdates, type JobRow, type SystemUpdateRow } from '../db/schema.js';
import type { Config } from '../config.js';
import type { HostShell } from '../servers/hostShell.js';
import { badRequest, conflict, internal } from '../lib/errors.js';
import { shellQuote } from '../servers/sshExec.js';
import type { UpdateStateDto } from '../../shared/types.js';
import type { JobWorker } from '../jobs/worker.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';
import type { UpdateService } from './updates.js';

/**
 * The Update button.
 *
 * The panel cannot replace its own container from inside it - the process would be killed
 * half way through its own recreate - so the work belongs to systemd. The panel connects to
 * its own host over the root SSH the web terminal already uses, starts a transient unit, and
 * then has nothing more to do with the update than read the file it writes. Killing the
 * panel's container, or the SSH session, or both, does not touch the running update.
 *
 * The unit name is the second lock (systemd-run refuses to start a unit that is already
 * active), `--collect` frees it after a failure so a retry is possible, and
 * `journalctl -u wpl7-update` is the log of last resort if /srv is the thing that broke.
 */
const UNIT = 'wpl7-update';
/** Generous: an update pulls several images. systemd kills the unit past this. */
const RUNTIME_MAX_SEC = 1800;
const MAINTENANCE_KEY = 'system.maintenance';
const LOG_TAIL_LINES = 200;
/** How long to keep watching an update that has not recorded an outcome yet. */
const RECONCILE_TIMEOUT_MS = (RUNTIME_MAX_SEC + 120) * 1000;
/** Same cadence update.sh polls the health gate on; the file is local. */
const RECONCILE_POLL_MS = 3_000;

export interface Maintenance {
  reason: string;
  since: number;
}

export class SystemUpdateService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly updates: UpdateService,
    private readonly host: HostShell,
    private readonly log: Logger,
  ) {}

  // ----------------------------------------------------------- maintenance

  maintenance(): Maintenance | null {
    const raw = this.settings.getRaw(MAINTENANCE_KEY);
    return raw && typeof raw === 'object' ? (raw as Maintenance) : null;
  }

  setMaintenance(value: Maintenance | null): void {
    this.settings.setRaw(MAINTENANCE_KEY, value);
  }

  /**
   * At boot: the flag is only meaningful while an update is actually running, and the panel
   * that set it has just been replaced. Anything else - a crash mid-update, a rollback, an
   * operator restarting the container - would otherwise leave the whole panel read-only with
   * nothing left alive to clear it.
   */
  async clearStaleMaintenance(): Promise<void> {
    if (!this.maintenance()) return;
    if (await this.isRunning()) return;
    this.setMaintenance(null);
    this.log.info('Maintenance mode cleared: no update is running.');
  }

  /**
   * Is an update actually running right now?
   *
   * Only the host can say, and the question is asked there rather than here: the pid in
   * state.json is a host pid and this panel has its own pid namespace, so checking it inside
   * the container would answer a question about some unrelated process. When the host cannot
   * be reached at all, the recorded phase is the fallback: it is written at every step, so a
   * `switched` or `failed` one is conclusive and anything else is a guess the operator can
   * override by restarting the panel.
   */
  async isRunning(): Promise<boolean> {
    const state = this.state();
    if (!state || state.phase === 'switched' || state.phase === 'failed') return false;
    const alive = await this.updaterAlive(state);
    if (alive === null) {
      this.log.warn('Could not ask the host whether the update is still running; assuming it is.');
      return true;
    }
    return alive;
  }

  /**
   * Is the process that writes state.json still there? `null` = the host could not be asked.
   *
   * Two questions, because there are two ways to start an update and only one of them is a
   * systemd unit. The Update button runs `systemd-run --unit=wpl7-update`; `update.sh` run by
   * hand is just a process, and so is deploy.sh's image-mode handoff - which is how every
   * edge build lands. Asking systemd alone calls those finished the instant they start, and
   * the panel then skips the per-version hooks and worker updates it owes them.
   *
   * A recycled pid would mean waiting a little longer for a deadline that is already bounded;
   * update.sh's own lock makes the same trade.
   */
  private async updaterAlive(state: UpdateStateDto): Promise<boolean | null> {
    const pid = typeof state.pid === 'number' && state.pid > 0 ? state.pid : 0;
    const probe = pid
      ? `systemctl is-active --quiet ${UNIT} || kill -0 ${pid} 2>/dev/null`
      : `systemctl is-active --quiet ${UNIT}`;
    try {
      const res = await this.host.run(probe, { timeoutMs: 20_000 });
      return res.exitCode === 0;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ state

  private updateDir(): string {
    return path.join(this.config.paths.panel, 'update');
  }

  /** What `provision/update.sh` has written, or null if it has never run here. */
  state(): UpdateStateDto | null {
    try {
      const raw = fs.readFileSync(path.join(this.updateDir(), 'state.json'), 'utf8');
      return JSON.parse(raw) as UpdateStateDto;
    } catch {
      return null;
    }
  }

  /**
   * The tail of the running (or last) update's log. Read from disk rather than streamed:
   * the writer is a process this panel does not own, and may well have started before this
   * container existed.
   */
  logTail(lines = LOG_TAIL_LINES): string[] {
    try {
      const text = fs.readFileSync(path.join(this.updateDir(), 'current.log'), 'utf8');
      return text.split('\n').filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------- post-update

  /** The record of what the panel did for itself after each update, newest first. */
  history(limit = 10): SystemUpdateRow[] {
    return this.db.select().from(systemUpdates).orderBy(desc(systemUpdates.startedAt)).limit(limit).all();
  }

  /**
   * Queue the work that only this panel can do, if an update just landed and nobody has.
   *
   * Called at boot, because that is when a new panel first exists. The record is keyed on
   * update.sh's own run id, so restarting the container ten times after an update queues the
   * job once - and `force` is the "Re-run post-update tasks" button, for the case where a
   * hook failed and the operator has fixed whatever it was complaining about.
   */
  enqueuePostUpdate(worker: JobWorker, opts: { force?: boolean } = {}): JobRow | null {
    const state = this.state();
    if (!state || state.phase !== 'switched') return null;
    if (state.to === state.from && !opts.force) return null;
    if (!opts.force && this.db.select().from(systemUpdates).where(eq(systemUpdates.id, state.id)).get()) {
      return null;
    }
    return worker.enqueue('system.postUpdate', { updateId: state.id, from: state.from, to: state.to });
  }

  /**
   * Finish the job an update started - once it has actually finished.
   *
   * The catch is the order of events. `update.sh` only records `switched` after the panel it
   * just installed answers the health check it is blocked on, and *this* is that panel: at
   * boot the state file still says `healthcheck`, so asking then gets "no update has landed"
   * for the one boot where an update definitely has. That is how a successful update ends up
   * with no post-update job, no worker fan-out and a maintenance flag with nothing left alive
   * to clear it. So this is called after listen(), and is allowed to wait for the answer.
   *
   * The wait is bounded by the same budget systemd gives the unit, and both outcomes end
   * here: after a rollback it is the OLD panel that boots, reads `failed`, and lifts the flag
   * the update set.
   */
  async reconcileHostUpdate(worker: JobWorker, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
    const state = this.state();
    if (state && state.phase !== 'switched' && state.phase !== 'failed') {
      this.log.info(`An update to ${state.to} is still in progress (${state.phase}); waiting for its outcome.`);
      await this.awaitHostUpdate(opts.timeoutMs ?? RECONCILE_TIMEOUT_MS, opts.pollMs ?? RECONCILE_POLL_MS);
    }
    await this.clearStaleMaintenance();
    try {
      const job = this.enqueuePostUpdate(worker);
      if (job) this.log.info(`Update applied; queued post-update tasks as job #${job.id}`);
    } catch (err) {
      this.log.warn(`Could not queue post-update tasks: ${String(err)}`);
    }
  }

  /** Poll until update.sh records an outcome, or the process writing it is gone. */
  private async awaitHostUpdate(timeoutMs: number, pollMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let warned = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs).unref());
      const state = this.state();
      if (!state || state.phase === 'switched' || state.phase === 'failed') return;
      // The file is the primary signal; the host is how an updater that was killed - by
      // RuntimeMaxSec, by the OOM killer - gets noticed rather than waited on forever.
      // "Could not ask" is not "finished", so keep waiting, but say so once and not 600 times.
      const alive = await this.updaterAlive(state);
      if (alive === false) return;
      if (alive === null && !warned) {
        warned = true;
        this.log.warn('Could not reach the host to ask about the update; watching the state file instead.');
      }
    }
    this.log.warn(`The update to ${this.state()?.to} never recorded an outcome; giving up on it.`);
  }

  // ----------------------------------------------------------------- start

  /**
   * Hand the update to systemd and return. Everything after this is observed through
   * `state()`, including the minutes when this process no longer exists.
   */
  async start(version: string): Promise<{ unit: string }> {
    if (this.config.source !== 'image') {
      throw badRequest(
        'This install builds its panel from a checkout (WPL7_SOURCE=build). Update it with ' +
          'provision/deploy.sh, or move it to image mode first - see docs/updating.md.',
      );
    }

    const latest = this.updates.status().latest;
    if (!latest) {
      throw badRequest('No release is known yet. Check for updates first.');
    }
    // Only ever the version the panel has actually resolved a manifest for. An arbitrary
    // string here would become an argument to a root-launched script.
    if (version !== latest.version) {
      throw badRequest(`${version} is not the release this install knows about (${latest.version}).`);
    }
    // What update.sh has to resolve, which on edge is not the version. An edge build calls
    // itself 0.3.0-edge.<commit> but deploy.yml publishes one moving release tagged `edge` -
    // asking for releases/tags/v0.3.0-edge.<commit> would 404 on every edge update. The
    // version is still what was offered and what was just checked; this is only the name the
    // release is published under.
    const target = latest.channel === 'edge' ? 'edge' : version;

    const active = this.db
      .select({ id: jobs.id, type: jobs.type })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
      .all();
    if (active.length > 0) {
      const list = active.slice(0, 5).map((j) => `#${j.id} ${j.type}`).join(', ');
      throw conflict(
        `${active.length} job(s) are still queued or running (${list}). ` +
          'An update recreates the panel, so wait for them or cancel them first.',
      );
    }

    if (await this.isRunning()) {
      throw conflict(`An update to ${this.state()?.to} is already running (${this.state()?.phase}).`);
    }

    // Set before the command goes out, not after: the panel may be gone by the time it
    // would have got around to it.
    this.setMaintenance({ reason: `Updating to ${version}`, since: Date.now() });

    const dir = this.config.installDir;
    const script = [
      'set -e',
      `dir=${shellQuote([dir])}`,
      '[ -x "$dir/provision/update.sh" ] || { echo "no update.sh at $dir" >&2; exit 1; }',
      // The unit runs as whoever owns the checkout, not as root: that is who deploy.sh and
      // a hand-run update are, and update.sh escalates to root itself with `sudo -n`. Going
      // in as root instead would leave root-owned files in a checkout its owner can no
      // longer edit.
      'owner=$(stat -c %U "$dir")',
      `exec systemd-run --unit=${UNIT} --collect -p RuntimeMaxSec=${RUNTIME_MAX_SEC} ` +
        `-p WorkingDirectory="$dir" --uid="$owner" ` +
        `"$dir/provision/update.sh" --to=${shellQuote([target])}`,
    ].join('\n');

    try {
      const res = await this.host.run(script, { timeoutMs: 60_000 });
      if (res.exitCode !== 0) {
        throw internal(`Could not start the update: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
      }
    } catch (err) {
      // Nothing is running, so the panel must not be left refusing writes.
      this.setMaintenance(null);
      throw err;
    }

    this.log.info(`Update to ${version} handed to systemd (${UNIT}).`);
    return { unit: UNIT };
  }
}
