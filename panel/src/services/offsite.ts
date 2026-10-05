import crypto from 'node:crypto';
import path from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  backupCopies,
  backupDestinations,
  backups,
  jobs,
  sites,
  type BackupCopyRow,
  type BackupDestinationRow,
  type BackupRow,
} from '../db/schema.js';
import type { Config } from '../config.js';
import {
  destinationProblems,
  providerByKey,
  RCLONE_CRYPT_REMOTE,
  RCLONE_REMOTE,
  rcloneRemoteFor,
  remoteJoin,
  remotePathFor,
  secretFieldKeys,
  type CryptKey,
} from '../../shared/backupProviders.js';
import { DEFAULT_COPY_TYPES, type BackupType } from '../../shared/schemas.js';
import type { BackupCopyDto, BackupDestinationDto, OffsiteOverviewDto, ServerCheck } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { shellQuote } from '../servers/sshExec.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import type { JobWorker } from '../jobs/worker.js';
import { PRUNED_BACKUP_TYPES, type BackupService, type LogFn } from './backup.js';
import type { MailService } from './mail.js';
import type { Logger } from './index.js';

/** How long a failed copy waits before the next attempt; after the last one it gives up. */
const RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
/** Jobs enqueued per reconciler tick per server, so a backfill does not flood the queue. */
const MAX_ENQUEUE_PER_TICK = 20;
/** Backups examined per destination per tick. */
const MAX_CANDIDATES_PER_TICK = 500;
const ALERT_INTERVAL_MS = 24 * 3600_000;

export const offsiteLane = (serverId: number) => `offsite:${serverId}`;

/** Marker the probe script prints, one per check, so one container answers everything. */
const CHECK_PREFIX = 'CEOCHECK';

export interface DestinationInput {
  name: string;
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  enabled?: boolean;
  copyTypes?: readonly string[];
  retentionScheduled?: number;
  retentionMode?: string;
  bwlimit?: string;
  /** 'crypt' encrypts everything before it leaves the server; 'none' (default) does not. */
  encryption?: string;
  /** Supply both to adopt an existing passphrase; omit them and the panel mints one. */
  cryptPassword?: string;
  cryptSalt?: string;
}

/** A job-shaped logger; the reconciler and the API pass a no-op. */
export interface CopyLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const silentLog: CopyLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Offsite copies of backups.
 *
 * One mechanism for every provider: rclone, in a container that lives for the length of one
 * transfer, on the server that holds the backup. The backup directory goes in as a
 * read-only bind, credentials as environment variables of that container (never argv,
 * never a config file on disk), and the data goes straight from that machine to the
 * destination — the panel is never in the path, and a worker needs nothing installed.
 *
 * Copies are driven by a reconciler rather than by hooks on backup creation. That survives
 * a restart mid-upload, catches up when a destination is added or re-enabled, and keeps the
 * backup code itself ignorant of whether offsite copies exist at all.
 */
export class OffsiteService {
  private worker: JobWorker | null = null;
  private kicker: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly backup: BackupService,
    private readonly mail: MailService,
    private readonly log: Logger,
  ) {}

  /**
   * The worker is built after the service bundle it belongs to, so it is attached rather
   * than injected. Until it is, the reconciler simply creates copy rows and enqueues
   * nothing — which is also what tests that do not run jobs want.
   */
  attachWorker(worker: JobWorker): void {
    this.worker = worker;
  }

  // ------------------------------------------------------------------ registry

  list(): BackupDestinationRow[] {
    return this.db.select().from(backupDestinations).orderBy(asc(backupDestinations.id)).all();
  }

  byId(id: number): BackupDestinationRow {
    const row = this.db.select().from(backupDestinations).where(eq(backupDestinations.id, id)).get();
    if (!row) throw notFound(`Backup destination #${id} not found`);
    return row;
  }

  configOf(row: BackupDestinationRow): Record<string, string> {
    return JSON.parse(row.config) as Record<string, string>;
  }

  secretsOf(row: BackupDestinationRow): Record<string, string> {
    return JSON.parse(row.secrets) as Record<string, string>;
  }

  copyTypesOf(row: BackupDestinationRow): string[] {
    return JSON.parse(row.copyTypes) as string[];
  }

  /** The crypt keys for a destination, or null when it stores plaintext. */
  cryptOf(row: BackupDestinationRow): CryptKey | null {
    if (row.encryption !== 'crypt' || !row.cryptPassword || !row.cryptSalt) return null;
    return { password: row.cryptPassword, salt: row.cryptSalt };
  }

  /**
   * The passphrase, for the operator to put in a password manager. The one endpoint in the
   * panel that returns a stored secret, and deliberately so: without it, a bucket full of
   * encrypted backups is unreadable by anybody, including them. It is in `panel.db`
   * regardless, and the panel already hands out a root shell on every server.
   */
  revealCrypt(id: number): CryptKey {
    const key = this.cryptOf(this.byId(id));
    if (!key) throw badRequest('This destination is not encrypted');
    return key;
  }

  anyConfigured(): boolean {
    return this.db.select({ id: backupDestinations.id }).from(backupDestinations).limit(1).all().length > 0;
  }

  create(input: DestinationInput & { backfill?: 'none' | 'latest' | 'all' }): BackupDestinationRow {
    const problems = destinationProblems(input.provider, input.config, input.secrets);
    if (problems.length > 0) throw badRequest(problems[0]!, { problems });
    if (this.list().some((d) => d.name === input.name)) {
      throw conflict(`A destination called "${input.name}" already exists`);
    }
    const now = Date.now();
    const backfill = input.backfill ?? 'none';
    // Either both halves are supplied - re-adding a destination whose backups already exist,
    // which is the only way to read them after losing panel.db - or the panel mints a pair.
    const crypt = input.encryption === 'crypt' ? (adoptCryptKey(input) ?? generateCryptKey()) : null;
    const row = this.db
      .insert(backupDestinations)
      .values({
        name: input.name,
        provider: input.provider,
        config: JSON.stringify(input.config),
        secrets: JSON.stringify(stripEmpty(input.secrets)),
        enabled: input.enabled === false ? 0 : 1,
        copyTypes: JSON.stringify(input.copyTypes ?? DEFAULT_COPY_TYPES),
        // 'all' reaches back to the beginning; 'none' and 'latest' start from now, and
        // 'latest' seeds one copy row per site below so today's backup still goes up.
        copyFromTs: backfill === 'all' ? 0 : now,
        retentionScheduled: input.retentionScheduled ?? 30,
        retentionMode: input.retentionMode ?? 'panel',
        bwlimit: input.bwlimit || null,
        encryption: crypt ? 'crypt' : 'none',
        cryptPassword: crypt?.password ?? null,
        cryptSalt: crypt?.salt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (backfill === 'latest') this.seedLatest(row);
    this.log.info(
      `Offsite destination "${row.name}" (${row.provider}${crypt ? ', encrypted' : ''}) added`,
    );
    return row;
  }

  update(id: number, patch: Partial<DestinationInput>): BackupDestinationRow {
    const row = this.byId(id);
    const config = patch.config ? { ...this.configOf(row), ...patch.config } : this.configOf(row);
    // An omitted secret keeps its stored value; an explicit empty string clears it. That is
    // what lets the form show "•••••• set · Replace" without ever reading one back out.
    const secrets = patch.secrets ? stripEmpty({ ...this.secretsOf(row), ...patch.secrets }) : this.secretsOf(row);
    const problems = destinationProblems(row.provider, config, secrets);
    if (problems.length > 0) throw badRequest(problems[0]!, { problems });
    if (patch.name && patch.name !== row.name && this.list().some((d) => d.name === patch.name)) {
      throw conflict(`A destination called "${patch.name}" already exists`);
    }
    // Turning encryption on or off decides how everything at this destination is named and
    // written. Changing it with copies in place would leave them unreadable AND unfindable,
    // with no way back, so it is fixed from the first copy onwards.
    let crypt: CryptKey | null | undefined;
    if (patch.encryption !== undefined && patch.encryption !== row.encryption) {
      const copies = this.db
        .select({ id: backupCopies.id })
        .from(backupCopies)
        .where(eq(backupCopies.destinationId, id))
        .limit(1)
        .all();
      if (copies.length > 0) {
        throw conflict(
          `"${row.name}" already holds backups, so its encryption cannot be changed. ` +
            `Add a second destination with the setting you want instead.`,
        );
      }
      crypt = patch.encryption === 'crypt' ? (adoptCryptKey(patch) ?? generateCryptKey()) : null;
    }
    return this.db
      .update(backupDestinations)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
        ...(patch.copyTypes !== undefined ? { copyTypes: JSON.stringify(patch.copyTypes) } : {}),
        ...(patch.retentionScheduled !== undefined ? { retentionScheduled: patch.retentionScheduled } : {}),
        ...(patch.retentionMode !== undefined ? { retentionMode: patch.retentionMode } : {}),
        ...(patch.bwlimit !== undefined ? { bwlimit: patch.bwlimit || null } : {}),
        ...(crypt !== undefined
          ? {
              encryption: crypt ? 'crypt' : 'none',
              cryptPassword: crypt?.password ?? null,
              cryptSalt: crypt?.salt ?? null,
            }
          : {}),
        config: JSON.stringify(config),
        secrets: JSON.stringify(secrets),
        updatedAt: Date.now(),
      })
      .where(eq(backupDestinations.id, id))
      .returning()
      .get();
  }

  /** One pending copy per site for its newest complete backup — the "latest" backfill. */
  private seedLatest(dest: BackupDestinationRow): void {
    const types = this.copyTypesOf(dest);
    const slugs = this.db.selectDistinct({ slug: backups.siteSlug }).from(backups).all();
    for (const { slug } of slugs) {
      const newest = this.db
        .select()
        .from(backups)
        .where(and(eq(backups.siteSlug, slug), eq(backups.status, 'complete'), eq(backups.filesPresent, 1)))
        .orderBy(desc(backups.createdAt))
        .get();
      if (!newest || !types.includes(newest.type)) continue;
      this.insertCopyRow(newest, dest);
    }
  }

  private insertCopyRow(backup: BackupRow, dest: BackupDestinationRow): void {
    const ts = path.basename(backup.path);
    this.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'pending',
        remotePath: remotePathFor(dest.provider, this.configOf(dest), backup.siteSlug, ts),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  // ------------------------------------------------------------------ reconciler

  /**
   * Create the copy rows policy says should exist, then enqueue one upload job per backup
   * that has work outstanding. Idempotent, so running it every minute is the whole
   * scheduling mechanism.
   */
  tick(): { created: number; enqueued: number } {
    this.releaseOrphanedUploads();
    let created = 0;
    // Nothing is copied that a deletion job is about to remove: the upload would be reading
    // files on their way out, and an object it finished would be one more for the job to purge.
    const doomed = this.backup.pendingDeletion();
    const destinations = this.list().filter((d) => d.enabled === 1);
    for (const dest of destinations) created += this.reconcileDestination(dest, doomed);
    const enqueued = this.enqueueDue(doomed);
    return { created, enqueued };
  }

  /**
   * A copy says `uploading` while its job runs. If the panel is restarted mid-transfer the
   * job is marked failed on the next boot but the copy row is not - and an `uploading` row
   * is neither retried by the reconciler nor deletable, so the backup would be stuck for
   * good. Anything claiming to be uploading with no job behind it goes back to pending.
   */
  private releaseOrphanedUploads(): number {
    const uploading = this.db.select().from(backupCopies).where(eq(backupCopies.status, 'uploading')).all();
    if (uploading.length === 0) return 0;
    const live = new Set(this.activeUploadBackupIds());
    let released = 0;
    for (const copy of uploading) {
      if (live.has(copy.backupId)) continue;
      this.db
        .update(backupCopies)
        .set({ status: 'pending', nextAttemptAt: null, error: null })
        .where(eq(backupCopies.id, copy.id))
        .run();
      released++;
    }
    if (released > 0) this.log.warn(`Offsite: ${released} interrupted copy/copies reset to pending`);
    return released;
  }

  /** Backup ids with a queued or running `backup.offsite` job. */
  private activeUploadBackupIds(): number[] {
    return this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(inArray(jobs.status, ['queued', 'running']), eq(jobs.type, 'backup.offsite')))
      .all()
      .map((j) => {
        try {
          return (JSON.parse(j.payload) as { backupId?: number }).backupId ?? -1;
        } catch {
          return -1;
        }
      });
  }

  /**
   * Hand kicks to the scheduler (src/jobs/schedulers.ts), so a paused "Offsite copies" stays
   * paused however it is poked, and the uploads a kick queues are credited to that schedule.
   */
  attachKicker(kicker: () => void): void {
    this.kicker = kicker;
  }

  /** Run a tick right away (after a backup finishes) without waiting for the minute timer. */
  kick(): void {
    if (this.kicker) {
      this.kicker();
      return;
    }
    try {
      this.tick();
    } catch (err) {
      this.log.warn(`Offsite kick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private reconcileDestination(dest: BackupDestinationRow, doomed: ReadonlyMap<number, unknown>): number {
    const types = this.copyTypesOf(dest);
    if (types.length === 0) return 0;
    const already = new Set(
      this.db
        .select({ backupId: backupCopies.backupId })
        .from(backupCopies)
        .where(eq(backupCopies.destinationId, dest.id))
        .all()
        .map((r) => r.backupId),
    );
    const candidates = this.db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.status, 'complete'),
          eq(backups.filesPresent, 1),
          inArray(backups.type, types),
          sql`${backups.createdAt} >= ${dest.copyFromTs}`,
        ),
      )
      .orderBy(asc(backups.createdAt))
      .limit(MAX_CANDIDATES_PER_TICK)
      .all();

    let created = 0;
    for (const backup of candidates) {
      if (already.has(backup.id) || doomed.has(backup.id)) continue;
      // A deleted site's final backup is exactly the one most worth having offsite, so a
      // missing site row means eligible rather than skipped; only a living site that has
      // opted out is excluded.
      if (backup.siteId !== null) {
        const site = this.db.select().from(sites).where(eq(sites.id, backup.siteId)).get();
        if (site && site.offsiteEnabled === 0) continue;
      }
      this.insertCopyRow(backup, dest);
      created++;
    }
    return created;
  }

  /** Backups with a pending copy (or a failed one whose retry is due) and no job running. */
  private enqueueDue(doomed: ReadonlyMap<number, unknown>): number {
    if (!this.worker) return 0;
    const now = Date.now();
    const due = this.db
      .select({ backupId: backupCopies.backupId })
      .from(backupCopies)
      .where(
        sql`${backupCopies.status} = 'pending' OR (${backupCopies.status} = 'failed' AND ${backupCopies.nextAttemptAt} IS NOT NULL AND ${backupCopies.nextAttemptAt} <= ${now})`,
      )
      .all();
    const backupIds = [...new Set(due.map((r) => r.backupId))];
    if (backupIds.length === 0) return 0;

    const active = new Set(this.activeUploadBackupIds());

    const rows = this.db
      .select()
      .from(backups)
      .where(inArray(backups.id, backupIds))
      .orderBy(asc(backups.createdAt))
      .all();
    const perServer = new Map<number, number>();
    let enqueued = 0;
    for (const backup of rows) {
      if (active.has(backup.id) || doomed.has(backup.id)) continue;
      if (backup.filesPresent === 0) continue; // nothing left locally to upload
      const server = this.servers.rowById(backup.serverId);
      if (!server || server.status === 'unreachable') continue; // next tick
      const count = perServer.get(backup.serverId) ?? 0;
      if (count >= MAX_ENQUEUE_PER_TICK) continue;
      perServer.set(backup.serverId, count + 1);
      this.worker.enqueue('backup.offsite', { backupId: backup.id }, undefined, {
        lane: offsiteLane(backup.serverId),
        siteSlug: backup.siteSlug,
      });
      enqueued++;
    }
    return enqueued;
  }

  /** Copy rows this backup still owes, newest destination policy applied. */
  private outstandingCopies(backupId: number, destinationId?: number): BackupCopyRow[] {
    const now = Date.now();
    return this.db
      .select()
      .from(backupCopies)
      .where(eq(backupCopies.backupId, backupId))
      .all()
      .filter((c) => (destinationId === undefined ? true : c.destinationId === destinationId))
      .filter(
        (c) =>
          c.status === 'pending' ||
          c.status === 'uploading' ||
          (c.status === 'failed' && c.nextAttemptAt !== null && c.nextAttemptAt <= now),
      );
  }

  /**
   * Arm this backup for an immediate copy: create the copy rows that do not exist yet and
   * clear the backoff on ones that gave up. Returns how many are now due, so "Copy now" can
   * say "nothing to do" instead of queueing a job that finds nothing.
   */
  requeue(backup: BackupRow, destinationId?: number): number {
    const targets = this.list().filter((d) => d.enabled === 1 && (destinationId === undefined || d.id === destinationId));
    const existing = new Map(this.copiesOf(backup.id).map((c) => [c.destinationId, c] as const));
    let due = 0;
    for (const dest of targets) {
      const copy = existing.get(dest.id);
      if (!copy) {
        this.insertCopyRow(backup, dest);
        due++;
        continue;
      }
      if (copy.status === 'complete') continue;
      this.db
        .update(backupCopies)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: null, error: null })
        .where(eq(backupCopies.id, copy.id))
        .run();
      due++;
    }
    return due;
  }

  /** Drop copy rows that never completed; used when the local source goes away. */
  dropIncompleteCopies(backupId: number): number {
    const doomed = this.copiesOf(backupId).filter((c) => c.status !== 'complete');
    for (const copy of doomed) this.db.delete(backupCopies).where(eq(backupCopies.id, copy.id)).run();
    return doomed.length;
  }

  // ------------------------------------------------------------------ transfers

  /**
   * Copy one backup to every destination that is still waiting for it.
   *
   * Succeeds when at least one destination took it and logs the rest as warnings; fails
   * only when every destination failed, so a red job on the Jobs page means "this backup is
   * nowhere" rather than "one of four buckets was grumpy".
   */
  async uploadBackup(backupId: number, ctx: CopyLog = silentLog): Promise<{ ok: number; failed: number }> {
    const pending = this.outstandingCopies(backupId);
    if (pending.length === 0) return { ok: 0, failed: 0 };
    let ok = 0;
    let failed = 0;

    for (const copy of pending) {
      // Re-read per destination: a backup can be deleted while an earlier upload in this
      // same job was still running, and the row is the only thing that knows.
      const backup = this.db.select().from(backups).where(eq(backups.id, backupId)).get();
      if (!backup) {
        ctx.warn(`Backup #${backupId} was deleted while copying; stopping.`);
        break;
      }
      if (backup.filesPresent === 0) {
        ctx.warn(`Backup #${backupId} no longer has local files; nothing to upload.`);
        break;
      }
      const dest = this.db.select().from(backupDestinations).where(eq(backupDestinations.id, copy.destinationId)).get();
      if (!dest || dest.enabled === 0) continue;

      try {
        await this.uploadOne(backup, dest, copy, ctx);
        ok++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        ctx.error(`Copy to "${dest.name}" failed: ${message}`);
        this.recordFailure(copy, dest, message);
      }
    }
    if (failed > 0 && ok === 0) {
      throw new Error(`Offsite copy failed for every destination (${failed})`);
    }
    return { ok, failed };
  }

  private async uploadOne(
    backup: BackupRow,
    dest: BackupDestinationRow,
    copy: BackupCopyRow,
    ctx: CopyLog,
  ): Promise<void> {
    const handle = this.servers.handleFor(backup.serverId);
    const remote = this.remoteFor(dest, backup);
    this.db
      .update(backupCopies)
      .set({ status: 'uploading', startedAt: Date.now(), error: null })
      .where(eq(backupCopies.id, copy.id))
      .run();

    ctx.info(`Copying backup #${backup.id} to "${dest.name}" (${remote.display})…`);
    await this.ensureImage(handle, ctx);

    const flags = [
      '--transfers',
      '2',
      '--checkers',
      '4',
      '--retries',
      '3',
      '--low-level-retries',
      '10',
      '--stats',
      '30s',
      '--stats-one-line',
      '--stats-log-level',
      'NOTICE',
      ...(dest.bwlimit ? ['--bwlimit', dest.bwlimit] : []),
    ];
    await this.rclone(handle, dest, ['copy', '/data', remote.target, ...flags], {
      binds: [`${this.backup.backupDir(backup)}:/data:ro`],
      timeoutMs: 12 * 3600_000,
      onOutput: (line) => ctx.info(`rclone: ${line}`),
      what: `copy to ${dest.name}`,
    });

    // Verify rather than trust the exit code: `check --one-way` compares hashes where the
    // backend has them and sizes where it does not, which is the strongest statement that
    // can be made about "the bytes arrived".
    ctx.info('Verifying the uploaded copy…');
    // `cryptcheck` is `check` for an encrypted remote: it encrypts the local file's hash
    // and compares that, which is a real comparison rather than the size-only fallback a
    // plain `check` degrades to when the far side has no usable hash.
    const verb = dest.encryption === 'crypt' ? 'cryptcheck' : 'check';
    await this.rclone(handle, dest, [verb, '/data', remote.target, '--one-way'], {
      binds: [`${this.backup.backupDir(backup)}:/data:ro`],
      timeoutMs: 2 * 3600_000,
      what: `verify at ${dest.name}`,
    });

    const size = await this.rclone(handle, dest, ['size', remote.target, '--json'], {
      timeoutMs: 10 * 60_000,
      what: `size at ${dest.name}`,
      tolerateFailure: true,
    });
    let sizeBytes: number | null = null;
    try {
      sizeBytes = (JSON.parse(size.stdout.trim()) as { bytes?: number }).bytes ?? null;
    } catch {
      /* rclone size is a nicety; a copy that verified is complete either way */
    }

    const now = Date.now();
    this.db
      .update(backupCopies)
      .set({ status: 'complete', completedAt: now, error: null, nextAttemptAt: null, sizeBytes })
      .where(eq(backupCopies.id, copy.id))
      .run();
    this.db
      .update(backupDestinations)
      .set({ lastSuccessAt: now, lastError: null })
      .where(eq(backupDestinations.id, dest.id))
      .run();
    ctx.info(`Backup #${backup.id} is now at "${dest.name}".`);
  }

  private recordFailure(copy: BackupCopyRow, dest: BackupDestinationRow, message: string): void {
    const attempts = copy.attempts + 1;
    const backoff = RETRY_BACKOFF_MS[attempts - 1];
    this.db
      .update(backupCopies)
      .set({
        status: 'failed',
        attempts,
        // null = out of attempts. The row stays so the failures view can show it and a
        // manual "Retry" can reset it.
        nextAttemptAt: backoff === undefined ? null : Date.now() + backoff,
        error: message.slice(0, 1000),
      })
      .where(eq(backupCopies.id, copy.id))
      .run();
    this.db
      .update(backupDestinations)
      .set({ lastFailureAt: Date.now(), lastError: message.slice(0, 500) })
      .where(eq(backupDestinations.id, dest.id))
      .run();
  }

  /**
   * Bring the four files of an offsite-only backup back onto a server, verified.
   *
   * Fetching onto the site's *current* server is what quietly lifts the cross-server
   * restore limitation: a backup taken before a move can be brought to where the site
   * lives now, and the ordinary restore then works.
   */
  async fetchBackup(backupId: number, destinationId: number, ctx: CopyLog = silentLog): Promise<BackupRow> {
    const backup = this.db.select().from(backups).where(eq(backups.id, backupId)).get();
    if (!backup) throw notFound(`Backup #${backupId} not found`);
    const dest = this.byId(destinationId);
    const copy = this.db
      .select()
      .from(backupCopies)
      .where(and(eq(backupCopies.backupId, backupId), eq(backupCopies.destinationId, destinationId)))
      .get();
    if (!copy || copy.status !== 'complete') {
      throw badRequest(`Backup #${backupId} has no completed copy at "${dest.name}"`);
    }

    // Prefer the site's current server; fall back to the one the row remembers.
    const site = this.db.select().from(sites).where(eq(sites.slug, backup.siteSlug)).get();
    const targetServerId = site?.serverId ?? backup.serverId;
    const handle = this.servers.handleFor(targetServerId);
    // Download into a staging directory and swap it in only once the checksums agree: a
    // half-finished fetch must not be mistaken for a backup, and re-fetching one that is
    // already present must not destroy it on the way.
    const { dir, staging, root } = await this.backup.claimFetchDir(handle, backup);

    ctx.info(`Fetching backup #${backup.id} from "${dest.name}" onto "${handle.name}"…`);
    await this.ensureImage(handle, ctx);
    const remote = this.remoteFor(dest, backup, copy.remotePath);
    try {
      await this.rclone(
        handle,
        dest,
        ['copy', remote.target, '/data', '--transfers', '2', '--stats', '30s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        {
          binds: [`${staging}:/data`],
          timeoutMs: 12 * 3600_000,
          onOutput: (line) => ctx.info(`rclone: ${line}`),
          what: `fetch from ${dest.name}`,
        },
      );

      ctx.info('Verifying checksums…');
      const sums = await handle.exec.run(
        'sh',
        ['-c', `cd ${shellQuote([staging])} && exec sha256sum -c --strict sha256sums`],
        { timeoutMs: 60 * 60_000 },
      );
      if (sums.exitCode !== 0) {
        throw new Error(`Checksum verification failed: ${(sums.stderr || sums.stdout).slice(0, 300)}`);
      }
      if (!(await handle.files.exists(path.join(staging, 'manifest.json')))) {
        throw new Error('The fetched backup has no manifest.json');
      }
    } catch (err) {
      await handle.files.rm(staging).catch(() => undefined);
      throw err;
    }
    await handle.files.rm(dir);
    await handle.files.rename(staging, dir);

    const updated = this.db
      .update(backups)
      .set({ filesPresent: 1, path: dir, rootPath: root, serverId: handle.id })
      .where(eq(backups.id, backup.id))
      .returning()
      .get();
    ctx.info(`Backup #${backup.id} is back on "${handle.name}" and verified.`);
    return updated;
  }

  // ------------------------------------------------------------------ deletion

  /**
   * Delete a backup everywhere: its remote copies, then its files and its row. A copy that
   * cannot be removed keeps the backup - dropping the row would forget an object still in the
   * bucket, with nothing left that knows it is there. Whether the backup may be deleted at all
   * is the caller's to check first (BackupService.deletionBlocker).
   */
  async deleteEverywhere(row: BackupRow, ctx: CopyLog = silentLog): Promise<{ purgeFailed: number; keptByPolicy: number }> {
    const { failed, keptByPolicy } = await this.purgeCopies(this.copiesOf(row.id), ctx);
    if (failed > 0) return { purgeFailed: failed, keptByPolicy };
    // Read again: purging can take minutes, and it is the row as it is now that says where the
    // files are. One gone meanwhile is deleted already.
    const current = this.db.select().from(backups).where(eq(backups.id, row.id)).get();
    if (current) await this.backup.deleteBackup(current);
    return { purgeFailed: 0, keptByPolicy };
  }

  /**
   * Remove this panel's objects for the given copies, then the copy rows. Destination-level
   * work runs on server 1: it needs no access to the backup's files, and pinning it to one
   * machine keeps an unreachable worker from blocking a delete.
   */
  async purgeCopies(
    copies: BackupCopyRow[],
    ctx: CopyLog = silentLog,
  ): Promise<{ purged: number; failed: number; keptByPolicy: number }> {
    let purged = 0;
    let failed = 0;
    let keptByPolicy = 0;
    const handle = this.servers.localHandle();
    for (const copy of copies) {
      const dest = this.db.select().from(backupDestinations).where(eq(backupDestinations.id, copy.destinationId)).get();
      if (!dest) {
        this.db.delete(backupCopies).where(eq(backupCopies.id, copy.id)).run();
        continue;
      }
      if (dest.retentionMode === 'external') {
        ctx.info(`"${dest.name}" manages its own retention; leaving ${copy.remotePath} alone.`);
        this.db.delete(backupCopies).where(eq(backupCopies.id, copy.id)).run();
        keptByPolicy++;
        continue;
      }
      try {
        await this.ensureImage(handle, ctx);
        // `purge` on one backup's own directory, never on the prefix: the prefix may be
        // shared with another panel, and this is the one operation that cannot be undone.
        await this.rclone(handle, dest, ['purge', this.targetFor(dest, copy.remotePath)], {
          timeoutMs: 60 * 60_000,
          what: `purge at ${dest.name}`,
          tolerateMissing: true,
        });
        this.db.delete(backupCopies).where(eq(backupCopies.id, copy.id)).run();
        purged++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        ctx.error(`Could not remove ${copy.remotePath} from "${dest.name}": ${message}`);
      }
    }
    return { purged, failed, keptByPolicy };
  }

  copiesOf(backupId: number): BackupCopyRow[] {
    return this.db.select().from(backupCopies).where(eq(backupCopies.backupId, backupId)).all();
  }

  /** Forget a destination's copy rows without touching the objects. */
  forgetCopies(destinationId: number): number {
    return this.db.delete(backupCopies).where(eq(backupCopies.destinationId, destinationId)).returning().all().length;
  }

  /**
   * Backups that are now nothing but a row: no local files, no copies left. Called after a
   * purge so a destination removal does not leave phantom entries on the site page.
   */
  dropEmptyBackups(): number {
    const rows = this.db.select().from(backups).where(eq(backups.filesPresent, 0)).all();
    let dropped = 0;
    for (const row of rows) {
      if (this.copiesOf(row.id).length > 0) continue;
      this.db.delete(backups).where(eq(backups.id, row.id)).run();
      dropped++;
    }
    return dropped;
  }

  // ------------------------------------------------------------------ retention

  /**
   * Per-destination retention, applied after the local prune. Each destination keeps its
   * own count of scheduled backups per site, which is the point of having one: a week
   * locally and a year in the bucket is a sensible shape, and only works if the two
   * retentions are independent.
   */
  async applyRetention(ctx: CopyLog = silentLog): Promise<number> {
    let removed = 0;
    for (const dest of this.list()) {
      if (dest.retentionMode === 'external' || dest.retentionScheduled <= 0) continue;
      const rows = this.db
        .select({ copy: backupCopies, backup: backups })
        .from(backupCopies)
        .innerJoin(backups, eq(backups.id, backupCopies.backupId))
        .where(and(eq(backupCopies.destinationId, dest.id), eq(backupCopies.status, 'complete')))
        .all()
        .filter((r) => (PRUNED_BACKUP_TYPES as readonly string[]).includes(r.backup.type));

      const bySlug = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = bySlug.get(row.backup.siteSlug) ?? [];
        list.push(row);
        bySlug.set(row.backup.siteSlug, list);
      }
      for (const list of bySlug.values()) {
        list.sort((a, b) => b.backup.createdAt - a.backup.createdAt);
        const extra = list.slice(dest.retentionScheduled);
        if (extra.length === 0) continue;
        const result = await this.purgeCopies(extra.map((r) => r.copy), ctx);
        removed += result.purged;
      }
    }
    if (removed > 0) this.dropEmptyBackups();
    return removed;
  }

  /**
   * Email the operator at most once a day per destination when copies have run out of
   * retries. Silence here means "nothing is failing", which is only true if this is the
   * thing that breaks it.
   */
  async alertOnFailures(): Promise<void> {
    const since = Date.now() - ALERT_INTERVAL_MS;
    for (const dest of this.list()) {
      if (dest.enabled === 0) continue;
      if (dest.lastAlertAt && dest.lastAlertAt > since) continue;
      const stuck = this.db
        .select({ copy: backupCopies, backup: backups })
        .from(backupCopies)
        .innerJoin(backups, eq(backups.id, backupCopies.backupId))
        .where(and(eq(backupCopies.destinationId, dest.id), eq(backupCopies.status, 'failed')))
        .all()
        .filter((r) => r.copy.nextAttemptAt === null);
      if (stuck.length === 0) continue;

      const sites = [...new Set(stuck.map((r) => r.backup.siteSlug))];
      const body = [
        `${stuck.length} backup(s) could not be copied to the offsite destination "${dest.name}"`,
        'and have used up their retries.',
        '',
        `Sites affected: ${sites.join(', ')}`,
        '',
        `Last error: ${dest.lastError ?? stuck[0]?.copy.error ?? 'unknown'}`,
        '',
        'The backups themselves are fine on their server - only the offsite copy is missing.',
        'Open Backups -> Storage -> Recent failures in the panel to see each one and retry.',
      ].join('\n');
      const sent = await this.mail
        .notifyOperator(`Offsite copies failing on "${dest.name}"`, body)
        .catch(() => false);
      this.log.warn(`Offsite destination "${dest.name}": ${stuck.length} copy/copies gave up after retries`);
      if (sent || !dest.lastAlertAt) {
        this.db
          .update(backupDestinations)
          .set({ lastAlertAt: Date.now() })
          .where(eq(backupDestinations.id, dest.id))
          .run();
      }
    }
  }

  // ------------------------------------------------------------------ probing

  /**
   * Can this configuration reach the destination, list it, write to it and delete again?
   * Four checks in one container so a mistyped endpoint costs one round trip. The delete
   * check is allowed to fail loudly-but-benignly: an append-only key is a legitimate,
   * recommended setup, and the answer is information rather than an error.
   */
  async test(input: DestinationInput): Promise<{ ok: boolean; checks: ServerCheck[] }> {
    const problems = destinationProblems(input.provider, input.config, input.secrets);
    if (problems.length > 0) {
      return { ok: false, checks: problems.map((p) => ({ name: 'configuration', ok: false, detail: p })) };
    }
    // Probe through the crypt remote when encryption is on, so the check exercises exactly
    // the path uploads will take rather than a plaintext one beside it.
    const crypt = input.encryption === 'crypt' ? (adoptCryptKey(input) ?? generateCryptKey()) : null;
    const handle = this.servers.localHandle();
    const checks: ServerCheck[] = [];
    try {
      await this.ensureImage(handle, silentLog);
      checks.push({
        name: 'rclone',
        ok: true,
        detail: `${this.config.rcloneImage} present on "${handle.name}"${crypt ? ' · encryption on' : ''}`,
      });
    } catch (err) {
      return {
        ok: false,
        checks: [{ name: 'rclone', ok: false, detail: err instanceof Error ? err.message : String(err) }],
      };
    }

    const remote = rcloneRemoteFor(input.provider, input.config, input.secrets, crypt);
    const probeName = `.ceo-probe-${Math.random().toString(36).slice(2, 10)}`;
    const probePath = remoteJoin(remote.root, probeName);
    const script = [
      ...remote.prelude,
      'set -u',
      `report() { printf '${CHECK_PREFIX} %s %s %s\\n' "$1" "$2" "$3"; }`,
      'trim() { head -c 300 "$1" | tr "\\n" " "; }',
      'if rclone lsd "$WPL7_ROOT" >/tmp/out 2>/tmp/err; then report list ok "$(trim /tmp/out)"; else report list fail "$(trim /tmp/err)"; fi',
      'printf \'wpl7 offsite probe\\n\' > /tmp/probe',
      'if rclone copyto /tmp/probe "$WPL7_PROBE_PATH" >/tmp/out 2>/tmp/err; then report write ok "wrote $WPL7_PROBE"; else report write fail "$(trim /tmp/err)"; fi',
      'if rclone deletefile "$WPL7_PROBE_PATH" >/tmp/out 2>/tmp/err; then report delete ok "removed $WPL7_PROBE"; else report delete fail "$(trim /tmp/err)"; fi',
    ].join('\n');

    const res = await handle.docker.runEphemeral({
      image: this.config.rcloneImage,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', script],
      env: [...remote.env, `WPL7_ROOT=${remote.root}`, `WPL7_PROBE=${probeName}`, `WPL7_PROBE_PATH=${probePath}`],
      networks: [],
      timeoutMs: 5 * 60_000,
      labels: { 'ceo.role': 'offsite-probe' },
    });
    const redact = redactorFor([...Object.values(input.secrets), ...(crypt ? [crypt.password, crypt.salt] : [])]);
    for (const line of redact(res.stdout + '\n' + res.stderr).split('\n')) {
      const m = new RegExp(`^${CHECK_PREFIX} (\\S+) (ok|fail) ?(.*)$`).exec(line.trim());
      if (!m) continue;
      checks.push({ name: m[1]!, ok: m[2] === 'ok', detail: (m[3] ?? '').trim() || (m[2] === 'ok' ? 'ok' : 'failed') });
    }
    if (checks.length <= 1) {
      checks.push({
        name: 'probe',
        ok: false,
        detail: redact((res.stderr || res.stdout).trim()).slice(0, 300) || `rclone exited ${res.exitCode}`,
      });
    }
    const deleteCheck = checks.find((c) => c.name === 'delete');
    if (deleteCheck && !deleteCheck.ok) {
      // A key without Delete is the ransomware-resistant setup; say so instead of failing.
      deleteCheck.ok = true;
      deleteCheck.detail =
        `could not delete the probe file - fine if this key is append-only; ` +
        `set retention to "managed by the provider" so the panel never tries. (${deleteCheck.detail})`;
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  // ------------------------------------------------------------------ rclone plumbing

  private remoteFor(dest: BackupDestinationRow, backup: BackupRow, explicitPath?: string) {
    const config = this.configOf(dest);
    const ts = path.basename(backup.path);
    const remotePath = explicitPath ?? remotePathFor(dest.provider, config, backup.siteSlug, ts);
    return { target: this.targetFor(dest, remotePath), display: `${dest.name}:${remotePath}` };
  }

  /**
   * Where a stored `remote_path` actually lives, as rclone addresses it.
   *
   * `remote_path` is the *logical* path — `<bucket>/<prefix>/<site>/<timestamp>` — and stays
   * that way whether or not the destination is encrypted, so one column means one thing.
   * An encrypted destination's crypt remote is already anchored at `<bucket>/<prefix>`, so
   * only the part below it is addressed through `CRYPT:` (and what is actually written
   * there is ciphertext, names included).
   */
  private targetFor(dest: BackupDestinationRow, remotePath: string): string {
    if (dest.encryption !== 'crypt') return `${RCLONE_REMOTE}:${remotePath}`;
    const root = providerByKey(dest.provider)?.remoteRoot(this.configOf(dest)) ?? '';
    const relative = root && remotePath.startsWith(`${root}/`) ? remotePath.slice(root.length + 1) : remotePath;
    return remoteJoin(`${RCLONE_CRYPT_REMOTE}:`, relative);
  }

  private async ensureImage(handle: ServerHandle, ctx: CopyLog): Promise<void> {
    const tag = this.config.rcloneImage;
    if (await handle.docker.imageExists(tag)) return;
    ctx.info(`Pulling ${tag} on "${handle.name}"…`);
    await handle.docker.pullImage(tag, (line) => ctx.info(line));
  }

  /**
   * Run one rclone command in a throwaway container on `handle`.
   *
   * Credentials arrive as environment variables and the container is on no network but the
   * default bridge — it needs the internet and nothing of ours. The prelude lines (password
   * obscuring, a known_hosts file) run in the same shell, so no secret is ever an argument.
   */
  private async rclone(
    handle: ServerHandle,
    dest: BackupDestinationRow,
    args: string[],
    opts: {
      binds?: string[];
      timeoutMs: number;
      onOutput?: (line: string) => void;
      what: string;
      tolerateFailure?: boolean;
      tolerateMissing?: boolean;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const crypt = this.cryptOf(dest);
    const remote = rcloneRemoteFor(dest.provider, this.configOf(dest), this.secretsOf(dest), crypt);
    const script = [...remote.prelude, `exec rclone ${shellQuote(args)}`].join('\n');
    // Everything rclone prints is about to become a job log line the UI shows, or an error
    // stored on the copy row. rclone's own "obscured" form is reversible by design - its
    // documentation calls it protection against eyedropping, not encryption - so a
    // credential echoed back in a diagnostic is a credential leaked.
    const redact = redactorFor([
      ...Object.values(this.secretsOf(dest)),
      ...(crypt ? [crypt.password, crypt.salt] : []),
    ]);
    const res = await handle.docker.runEphemeral({
      image: this.config.rcloneImage,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', script],
      env: remote.env,
      binds: opts.binds,
      networks: [],
      labels: { 'ceo.role': 'offsite' },
      timeoutMs: opts.timeoutMs,
      onOutput: opts.onOutput ? (line) => opts.onOutput!(redact(line)) : undefined,
    });
    if (res.exitCode !== 0 && !opts.tolerateFailure) {
      const detail = (res.stderr || res.stdout).trim();
      // `purge` of a directory that is already gone is success as far as we are concerned.
      if (opts.tolerateMissing && /directory not found|not found|doesn't exist/i.test(detail)) return res;
      throw new Error(`rclone ${opts.what} failed (exit ${res.exitCode}): ${redact(detail).slice(0, 500)}`);
    }
    return res;
  }

  // ------------------------------------------------------------------ DTOs

  toDto(row: BackupDestinationRow): BackupDestinationDto {
    const stats = this.db
      .select({ status: backupCopies.status, n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${backupCopies.sizeBytes}), 0)` })
      .from(backupCopies)
      .where(eq(backupCopies.destinationId, row.id))
      .groupBy(backupCopies.status)
      .all();
    const by = (status: string) => Number(stats.find((s) => s.status === status)?.n ?? 0);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      providerLabel: providerByKey(row.provider)?.label ?? row.provider,
      config: this.configOf(row),
      // Which secrets exist, never what they are. That is what lets the form show
      // "•••••• set · Replace" and still never hand a password back to a browser.
      secretsSet: secretFieldKeys(row.provider).filter((k) => (this.secretsOf(row)[k] ?? '') !== ''),
      enabled: row.enabled === 1,
      copyTypes: this.copyTypesOf(row) as BackupType[],
      retentionScheduled: row.retentionScheduled,
      retentionMode: row.retentionMode as 'panel' | 'external',
      bwlimit: row.bwlimit,
      encryption: row.encryption as 'none' | 'crypt',
      stats: {
        complete: by('complete'),
        pending: by('pending') + by('uploading'),
        failed: by('failed'),
        bytes: Number(stats.find((s) => s.status === 'complete')?.bytes ?? 0),
      },
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };
  }

  copyToDto(copy: BackupCopyRow, destName: string, backup?: BackupRow): BackupCopyDto {
    return {
      id: copy.id,
      backupId: copy.backupId,
      destinationId: copy.destinationId,
      destinationName: destName,
      siteSlug: backup?.siteSlug ?? null,
      backupType: (backup?.type as BackupType) ?? null,
      backupCreatedAt: backup?.createdAt ?? null,
      status: copy.status as BackupCopyDto['status'],
      remotePath: copy.remotePath,
      sizeBytes: copy.sizeBytes,
      attempts: copy.attempts,
      nextAttemptAt: copy.nextAttemptAt,
      error: copy.error,
      completedAt: copy.completedAt,
      createdAt: copy.createdAt,
    };
  }

  /** Copy rows for one backup, for the site page's Offsite column. */
  copyDtosFor(backupIds: number[]): Map<number, BackupCopyDto[]> {
    const out = new Map<number, BackupCopyDto[]>();
    if (backupIds.length === 0) return out;
    const names = new Map(this.list().map((d) => [d.id, d.name] as const));
    for (const copy of this.db.select().from(backupCopies).where(inArray(backupCopies.backupId, backupIds)).all()) {
      const list = out.get(copy.backupId) ?? [];
      list.push(this.copyToDto(copy, names.get(copy.destinationId) ?? `#${copy.destinationId}`));
      out.set(copy.backupId, list);
    }
    return out;
  }

  /** The Storage page (Backups -> Storage) and the Dashboard line. */
  overview(): OffsiteOverviewDto {
    const destinations = this.list().map((d) => this.toDto(d));
    const since = Date.now() - 24 * 3600_000;
    const recent = this.db
      .select()
      .from(backupCopies)
      .where(sql`${backupCopies.createdAt} >= ${since} OR ${backupCopies.completedAt} >= ${since}`)
      .all();
    const names = new Map(this.list().map((d) => [d.id, d.name] as const));
    const failures = this.db
      .select({ copy: backupCopies, backup: backups })
      .from(backupCopies)
      .innerJoin(backups, eq(backups.id, backupCopies.backupId))
      .where(eq(backupCopies.status, 'failed'))
      .orderBy(desc(backupCopies.id))
      .limit(50)
      .all()
      .map((r) => this.copyToDto(r.copy, names.get(r.copy.destinationId) ?? `#${r.copy.destinationId}`, r.backup));
    return {
      destinations,
      lastSuccessAt: destinations.reduce<number | null>(
        (acc, d) => (d.lastSuccessAt && (!acc || d.lastSuccessAt > acc) ? d.lastSuccessAt : acc),
        null,
      ),
      last24h: {
        completed: recent.filter((c) => c.status === 'complete' && (c.completedAt ?? 0) >= since).length,
        failed: recent.filter((c) => c.status === 'failed').length,
        pending: recent.filter((c) => c.status === 'pending' || c.status === 'uploading').length,
      },
      failures,
    };
  }
}

/**
 * Replace every known credential with a mask, longest first so an overlapping pair cannot
 * leave a fragment behind.
 *
 * Values shorter than `minLength` (eight characters, unless the caller knows better) are left
 * alone: at that length a "secret" is as likely to be a substring of an ordinary word, and
 * mangling every diagnostic that happens to contain it costs more than it protects. This
 * catches what rclone echoes; it cannot catch a form of the value the panel never saw.
 */
export function redactorFor(values: (string | undefined)[], minLength = 8): (text: string) => string {
  const secrets = [...new Set(values.filter((v): v is string => !!v && v.length >= minLength))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return (text) => text;
  return (text) => secrets.reduce((acc, value) => acc.split(value).join('••••••'), text);
}

/**
 * A fresh crypt passphrase and salt. 32 bytes of CSPRNG each, base64url so they survive
 * being copied out of a terminal, pasted into a password manager and typed back in.
 */
function generateCryptKey(): CryptKey {
  const secret = () => crypto.randomBytes(32).toString('base64url');
  return { password: secret(), salt: secret() };
}

/**
 * Use the passphrase the caller supplied, if they supplied a whole one. This is how a
 * destination is re-added after `panel.db` is lost: same bucket, same passphrase, and the
 * existing backups become readable again. Half a pair is a mistake, not an intention.
 */
function adoptCryptKey(input: { cryptPassword?: string; cryptSalt?: string }): CryptKey | null {
  const password = (input.cryptPassword ?? '').trim();
  const salt = (input.cryptSalt ?? '').trim();
  if (!password && !salt) return null;
  if (!password || !salt) {
    throw badRequest('An existing passphrase needs both halves: the passphrase and its salt.');
  }
  return { password, salt };
}

/** Empty strings mean "clear this", so they never reach storage. */
function stripEmpty(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
}

export type { LogFn };
