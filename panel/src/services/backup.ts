// @docs backups/delete, backups/delete-old, backups/overview, backups/restore, help/troubleshooting, reference/manual-recovery, servers/resources
import path from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  backupCopies,
  backups,
  jobs,
  sites,
  type BackupCopyRow,
  type BackupRow,
  type JobRow,
  type ServerRow,
  type SiteRow,
} from '../db/schema.js';
import type { Config } from '../config.js';
import type { BackupType } from '../../shared/schemas.js';
import { backupRootProblem } from '../../shared/backupRoot.js';
import { conflict } from '../lib/errors.js';
import { safeJoin } from '../lib/slug.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { sitePaths } from './siteSpec.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: LogFn = () => undefined;

/**
 * Backup kinds the retention setting - the newest N - applies to. Everything else is kept
 * until it is past its keep period (EXPIRING_BACKUP_TYPES) or somebody deletes it.
 */
export const PRUNED_BACKUP_TYPES = ['scheduled', 'panel'] as const;

/**
 * Backup kinds deleted once they are older than their keep period: `backupKeepDays` for a
 * site's, unless the site sets its own, and `panelBackupKeepDays` for the panel's. Manual and
 * final backups are not among them: a person asked for each of those, and keeps it until they
 * delete it.
 */
export const EXPIRING_BACKUP_TYPES = ['scheduled', 'pre_update', 'pre_restore', 'move', 'import', 'panel'] as const;

const DAY_MS = 24 * 3600_000;

/** How long a backup brought back with Fetch back keeps its files, whatever retention says. */
const FETCHED_STAYS_MS = 7 * DAY_MS;

/** Job types that read or write a site's backup files while they run. */
const BACKUP_USING_JOB_TYPES = ['backup.create', 'backup.restore', 'site.move', 'site.delete', 'site.importFinish', 'site.importRefresh'] as const;
/** Job types that read or write ONE backup's files, outside the site's job lane. */
const COPY_JOB_TYPES = ['backup.offsite', 'backup.fetch'] as const;

/**
 * The named lane `backup.delete` runs in: beside every server's work - purging remote copies
 * is minutes of rclone, which must not hold a server's sites up - and one deletion at a time,
 * so two of them naming the same backup take turns instead of racing.
 */
export const BACKUP_DELETE_LANE = 'backup-delete';

/** The server a `server.relocateBackups` payload moves the backups of; null for one that cannot be read. */
function relocatedServer(payload: string): number | null {
  try {
    const id = (JSON.parse(payload) as { serverId?: unknown }).serverId;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** The backup ids a `backup.delete` payload names; none for one that cannot be read. */
function idsToDelete(payload: string): number[] {
  try {
    const ids = (JSON.parse(payload) as { backupIds?: unknown }).backupIds;
    return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

export const tsStamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15); // YYYYMMDD-HHMMSS (UTC)

/** The site's WordPress version, from the first lines of its own - untrusted - version.php. */
export async function readWpVersion(h: ServerHandle, wordpressDir: string): Promise<string | null> {
  const content = await h.files.readUntrusted(path.join(wordpressDir, 'wp-includes', 'version.php'), 64 * 1024);
  return content === null ? null : (/\$wp_version\s*=\s*'([^']+)'/.exec(content)?.[1] ?? null);
}

/**
 * Backups always live on the server that hosts the site; every filesystem/db operation
 * here goes through that server's handle. Rows carry serverId so delete/prune/download
 * keep working after the site moves elsewhere.
 */
export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
  ) {}

  /**
   * Where this server keeps its backups. One place, because five call sites used to
   * hard-code `config.paths.backups` and a per-server location has to move all of them
   * together - a claim under one root and a free-space check under another is worse than
   * no choice at all.
   */
  rootFor(server: ServerHandle | ServerRow): string {
    const row = 'row' in server ? server.row : server;
    return row.backupRoot || this.config.paths.backups;
  }

  rootForServerId(serverId: number): string {
    const row = this.servers.rowById(serverId);
    return row?.backupRoot || this.config.paths.backups;
  }

  /**
   * The root a backup was written under. Rows created before roots were selectable have no
   * `root_path`; the layout is fixed at `<root>/<slug>/<ts>`, so it is recoverable.
   */
  rootOf(row: BackupRow): string {
    return row.rootPath || path.dirname(path.dirname(row.path));
  }

  dirFor(root: string, slug: string, ts: string): string {
    return safeJoin(root, slug, ts);
  }

  handleForBackup(row: BackupRow): ServerHandle {
    return this.servers.handleFor(row.serverId);
  }

  /**
   * Claim a fresh snapshot directory. The timestamp has one-second resolution, so two
   * backups of the same site in the same second (e.g. pre_restore + restore) would
   * otherwise share a directory - and deleting either row would rm -rf the other's files.
   * mkdir without parents fails on EEXIST, which makes the claim atomic.
   */
  async claimBackupDir(h: ServerHandle, slug: string): Promise<{ ts: string; dir: string; root: string }> {
    const base = tsStamp(new Date());
    const root = this.rootFor(h);
    // 700 on the way up too: a root on a freshly mounted disk is created here, and a
    // world-readable one would expose every customer's database dump.
    await h.files.mkdirp(safeJoin(root, slug), { mode: 0o700 });
    for (let i = 0; i < 1000; i++) {
      const ts = i === 0 ? base : `${base}-${i + 1}`;
      const dir = this.dirFor(root, slug, ts);
      if ((await h.files.mkdirExclusive(dir)) === 'created') return { ts, dir, root };
    }
    throw new Error(`Could not allocate a backup directory for ${slug}`);
  }

  /**
   * Claim the directory a fetched backup lands in, plus the staging directory it is
   * downloaded into first. Its original location may be gone (the root moved, or the site
   * moved to another server), so the path is re-derived under whatever root that server
   * uses now and the row is updated to match.
   */
  async claimFetchDir(h: ServerHandle, row: BackupRow): Promise<{ dir: string; staging: string; root: string }> {
    const root = this.rootFor(h);
    const ts = path.basename(row.path);
    const dir = this.dirFor(root, row.siteSlug, ts);
    const staging = `${dir}.fetching`;
    await h.files.rm(staging);
    await h.files.mkdirp(staging, { mode: 0o700 });
    return { dir, staging, root };
  }

  /** Create a backup of a site's DB + files ON the site's server. */
  async create(
    site: SiteRow,
    type: BackupType,
    opts: { note?: string; jobId?: number; log?: LogFn } = {},
  ): Promise<BackupRow> {
    const h = this.servers.handleFor(site.serverId);
    return this.createOn(h, site, type, opts);
  }

  async createOn(
    h: ServerHandle,
    site: SiteRow,
    type: BackupType,
    opts: { note?: string; jobId?: number; log?: LogFn } = {},
  ): Promise<BackupRow> {
    const log = opts.log ?? noopLog;
    const { dir, root } = await this.claimBackupDir(h, site.slug);

    await this.assertFreeSpace(h, site);

    const row = this.db
      .insert(backups)
      .values({
        siteId: site.id,
        siteSlug: site.slug,
        serverId: h.id,
        type,
        status: 'creating',
        path: dir,
        rootPath: root,
        note: opts.note ?? null,
        jobId: opts.jobId ?? null,
        phpVersion: site.phpVersion,
        createdAt: Date.now(),
      })
      .returning()
      .get();

    try {
      log('info', `Dumping database ${site.dbName}…`);
      await h.dbAdmin.dumpTo(site.dbName, path.join(dir, 'db.sql.gz'));

      const p = sitePaths(this.config, site.slug);
      const candidates = ['wordpress', 'config', 'site.json'];
      // A check that fails fails the backup: taken for "not there", it would leave the site's
      // files out of an archive that still says complete.
      const entries: string[] = [];
      for (const e of candidates) {
        if (await h.files.exists(path.join(p.root, e))) entries.push(e);
      }
      log('info', `Archiving site files (${entries.join(', ')})…`);
      const tar = await h.exec.run(
        'tar',
        ['-C', p.root, '-czf', path.join(dir, 'files.tar.gz'), ...entries],
        { timeoutMs: 60 * 60_000 },
      );
      if (tar.exitCode !== 0) throw new Error(`tar failed (exit ${tar.exitCode}): ${tar.stderr.slice(0, 500)}`);

      const wpVersion = await readWpVersion(h, p.wordpress);
      const manifest = {
        format: 1,
        slug: site.slug,
        title: site.title,
        type,
        createdAt: new Date().toISOString(),
        domains: JSON.parse(site.domains) as string[],
        devHostname: site.devHostname,
        phpVersion: site.phpVersion,
        wpVersion,
        locale: site.locale,
        dbName: site.dbName,
        dbUser: site.dbUser,
        tablePrefix: site.tablePrefix,
        serverId: h.id,
        serverName: h.name,
      };
      await h.files.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      log('info', 'Writing checksums…');
      const sums: string[] = [];
      for (const f of ['db.sql.gz', 'files.tar.gz']) {
        sums.push(`${await h.files.sha256(path.join(dir, f))}  ${f}`);
      }
      await h.files.writeFile(path.join(dir, 'sha256sums'), sums.join('\n') + '\n');

      // A size that could not be read is counted as 0 rather than failing a finished backup.
      let sizeBytes = 0;
      for (const f of await h.files.readdir(dir)) {
        sizeBytes += (await h.files.stat(path.join(dir, f)).catch(() => null))?.sizeBytes ?? 0;
      }

      const updated = this.db
        .update(backups)
        .set({ status: 'complete', sizeBytes, wpVersion })
        .where(eq(backups.id, row.id))
        .returning()
        .get();
      log('info', `Backup complete (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB)`);
      return updated;
    } catch (err) {
      this.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row.id)).run();
      await h.files.rm(dir).catch(() => undefined);
      throw err;
    }
  }

  private async assertFreeSpace(h: ServerHandle, site: SiteRow): Promise<void> {
    const stat = await h.files.statvfs(this.rootFor(h)).catch(() => null);
    if (!stat) return; // statfs unsupported -> skip the preflight rather than block backups
    const need = (site.diskBytes ?? 0) * 1.5;
    if (need > 0 && stat.freeBytes < need) {
      throw new Error(
        `Not enough free disk space for backup: ${Math.round(stat.freeBytes / 1e6)}MB free, ~${Math.round(need / 1e6)}MB needed`,
      );
    }
  }

  /** A backup's manifest.json, or null when it cannot be read. */
  async readManifest(backup: BackupRow): Promise<{ kind?: string; tablePrefix?: string; phpVersion?: string } | null> {
    try {
      return JSON.parse(await this.handleForBackup(backup).files.readFile(path.join(backup.path, 'manifest.json'))) as {
        kind?: string;
      };
    } catch {
      return null;
    }
  }

  async verifyChecksums(backup: BackupRow): Promise<void> {
    const h = this.handleForBackup(backup);
    const sums = await h.files.readFile(path.join(backup.path, 'sha256sums'));
    for (const line of sums.split('\n').filter(Boolean)) {
      const [expected, file] = line.split(/\s+/);
      if (!expected || !file) continue;
      const actual = await h.files.sha256(path.join(backup.path, file));
      if (actual !== expected) throw new Error(`Checksum mismatch for ${file} - backup is corrupt`);
    }
  }

  /** Import db.sql.gz into the (recreated) site database, on the backup's server. */
  async importDatabase(backup: BackupRow, dbName: string): Promise<void> {
    const h = this.handleForBackup(backup);
    await h.dbAdmin.importFrom(path.join(backup.path, 'db.sql.gz'), dbName);
  }

  /** Swap in the files from a backup. Returns the path of the safety copy of the old tree. */
  async restoreFiles(backup: BackupRow, site: SiteRow, log: LogFn): Promise<string | null> {
    const h = this.servers.handleFor(site.serverId);
    const p = sitePaths(this.config, site.slug);
    const tmp = path.join(p.root, '.restore-tmp');
    await h.files.rm(tmp);
    await h.files.mkdirp(tmp);

    log('info', 'Extracting files archive…');
    const untar = await h.exec.run(
      'tar',
      ['-xzf', path.join(backup.path, 'files.tar.gz'), '-C', tmp],
      { timeoutMs: 60 * 60_000 },
    );
    if (untar.exitCode !== 0) throw new Error(`tar extract failed: ${untar.stderr.slice(0, 500)}`);
    if (!(await h.files.exists(path.join(tmp, 'wordpress')))) {
      throw new Error('Backup archive does not contain a wordpress/ directory');
    }

    let safety: string | null = null;
    if (await h.files.exists(p.wordpress)) {
      safety = `${p.wordpress}.pre-restore-${tsStamp(new Date())}`;
      await h.files.rename(p.wordpress, safety);
    }
    try {
      await h.files.rename(path.join(tmp, 'wordpress'), p.wordpress);
    } catch (err) {
      if (safety) {
        await h.files.rename(safety, p.wordpress).catch(() => undefined);
        log('error', 'File swap failed; previous files were moved back.');
      }
      throw err;
    }
    // Restore per-site php config when the archive carried one.
    const backedUpIni = path.join(tmp, 'config', 'uploads.ini');
    if (await h.files.exists(backedUpIni)) {
      await h.files.mkdirp(p.configDir);
      await h.files.writeFile(p.uploadsIni, await h.files.readFile(backedUpIni));
    }
    await h.files.rm(tmp);
    await this.chownWordpress(h, site.slug, log);
    return safety;
  }

  async chownWordpress(h: ServerHandle, slug: string, log: LogFn): Promise<void> {
    const p = sitePaths(this.config, slug);
    const res = await h.exec.run('chown', ['-R', '33:33', p.wordpress], { timeoutMs: 10 * 60_000 });
    if (res.exitCode !== 0) {
      log('warn', `chown -R 33:33 failed (${res.stderr.trim().slice(0, 200)}) - file ownership may be wrong`);
    }
  }

  /**
   * The queued/running job that may be reading or writing this backup's files, if any.
   * Restore holds the site's job lane, but deletion (API and retention alike) never
   * consulted it: a DELETE could remove a restore's input after the live database had
   * already been dropped, and the site came out of it empty.
   *
   * By slug, not site id, because that is how a restore finds its site: a deleted site's
   * backups keep its slug but lose its id, and a site that later takes the same name can
   * restore them - which the id would never have seen coming.
   *
   * `except` leaves out jobs that are done with the files: the deletion asking, and the site
   * deletion that queued it, which is still finishing up when the deletion starts.
   */
  activeJobFor(row: BackupRow, except: readonly number[] = []): JobRow | undefined {
    const siteJob = this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.siteSlug, row.siteSlug),
          inArray(jobs.status, ['queued', 'running']),
          inArray(jobs.type, [...BACKUP_USING_JOB_TYPES]),
          except.length > 0 ? notInArray(jobs.id, [...except]) : undefined,
        ),
      )
      .get();
    return siteJob ?? this.activeCopyJobFor(row.id);
  }

  /**
   * Queued and running `backup.delete` jobs, by the backup ids they name. Whatever one of them
   * names is as good as gone: it is not restored, fetched or copied offsite in the meantime,
   * and retention leaves it to the job.
   */
  pendingDeletion(): Map<number, JobRow> {
    const out = new Map<number, JobRow>();
    const active = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'backup.delete'), inArray(jobs.status, ['queued', 'running'])))
      .all();
    for (const job of active) {
      for (const id of idsToDelete(job.payload)) if (!out.has(id)) out.set(id, job);
    }
    return out;
  }

  /** The queued or running `backup.delete` job that names this backup, if any. */
  deletionJobFor(backupId: number): JobRow | undefined {
    return this.pendingDeletion().get(backupId);
  }

  /**
   * Backups being deleted right now, by id, with how many deletions of each are under way: a
   * Delete answered in its request, a deletion job's current one, retention's. Their rows are
   * still there meanwhile - for minutes, while remote copies are purged - so the database alone
   * would still count each as one a site has.
   */
  private readonly removing = new Map<number, number>();

  /** Runs `fn` with the backup counted as going away (goingAway) until it is done. */
  async whileRemoving<T>(id: number, fn: () => Promise<T>): Promise<T> {
    this.removing.set(id, (this.removing.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.removing.get(id) ?? 1) - 1;
      if (left > 0) this.removing.set(id, left);
      else this.removing.delete(id);
    }
  }

  /**
   * Every backup on its way out, by id: being deleted right now, or named by a queued or running
   * `backup.delete` - but for the one `exceptJob` names, the job asking.
   */
  goingAway(exceptJob?: number): Set<number> {
    const out = new Set(this.removing.keys());
    for (const [id, job] of this.pendingDeletion()) if (job.id !== exceptJob) out.add(id);
    return out;
  }

  /**
   * The running `server.relocateBackups` that may be moving this backup's files right now. It
   * copies a backup, points the row at the copy, then removes the original - one at a time, and
   * nothing marks which one it is on. Deleting any of that server's local backups meanwhile
   * could remove the files from under the copy, or delete the row after it was pointed at the
   * new place and leave the copy behind with nothing that knows of it. A queued relocation is
   * no reason: when it starts it leaves alone whatever a deletion names (serverRelocateBackups).
   */
  relocationJobFor(row: BackupRow): JobRow | undefined {
    if (row.filesPresent === 0) return undefined; // nothing local to move
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'server.relocateBackups'), eq(jobs.status, 'running')))
      .all()
      .find((job) => relocatedServer(job.payload) === row.serverId);
  }

  /**
   * Why deleting this backup right now would be unsafe, in words; null when nothing stands in
   * the way. `except` as for activeJobFor. Another deletion naming the same backup is not a
   * reason: the two take turns in their lane, and the second finds it gone.
   */
  deletionBlocker(row: BackupRow, except: readonly number[] = []): string | null {
    if (row.status === 'creating') return `Backup #${row.id} is still being created`;
    if (this.copiesOf(row.id).some((c) => c.status === 'uploading')) {
      return `Backup #${row.id} is being copied to a remote destination right now; wait for that copy to finish`;
    }
    const job = this.activeJobFor(row, except);
    if (job) {
      return (
        `Backup #${row.id} cannot be deleted while job #${job.id} (${job.type}) for "${row.siteSlug}" is ${job.status}; ` +
        `wait for it to finish`
      );
    }
    const relocation = this.relocationJobFor(row);
    if (relocation) {
      return `Backup #${row.id} cannot be deleted while job #${relocation.id} moves its server's backups to a new location; wait for it to finish`;
    }
    return null;
  }

  /**
   * An offsite upload or fetch in flight for exactly this backup. Those jobs run in their
   * own lane with no siteId (a slow upload must not block the site), so the site-lane
   * lookup above cannot see them - and deleting a backup rclone is reading would fail the
   * upload halfway and leave a partial object in the bucket.
   */
  private activeCopyJobFor(backupId: number): JobRow | undefined {
    const active = this.db
      .select()
      .from(jobs)
      .where(and(inArray(jobs.status, ['queued', 'running']), inArray(jobs.type, [...COPY_JOB_TYPES])))
      .all();
    return active.find((job) => {
      try {
        return (JSON.parse(job.payload) as { backupId?: number }).backupId === backupId;
      } catch {
        return false;
      }
    });
  }

  copiesOf(backupId: number): BackupCopyRow[] {
    return this.db.select().from(backupCopies).where(eq(backupCopies.backupId, backupId)).all();
  }

  /** 409 when the backup is still being written, a job may be using it, or one is deleting it. */
  assertDeletable(row: BackupRow): void {
    const blocker = this.deletionBlocker(row);
    if (blocker) throw conflict(blocker);
    this.assertNotBeingDeleted(row);
  }

  /** 409 when a `backup.delete` job names this backup: it is about to be gone. */
  assertNotBeingDeleted(row: BackupRow): void {
    const job = this.deletionJobFor(row.id);
    if (job) {
      throw conflict(`Backup #${row.id} is being deleted (job #${job.id}, ${job.status})`);
    }
  }

  /**
   * Apply retention to scheduled backups: the newest N of each site stay. The other kinds are
   * left to `expire` and to whoever deletes them.
   *
   * Local retention never destroys the last copy of anything: a backup that already exists
   * at an offsite destination gives up its local files and stays listed as offsite-only,
   * so a short local retention next to a long offsite one is a sensible thing to configure
   * rather than a way to lose last month.
   */
  async prune(retention: number): Promise<{ deleted: number; offsiteOnly: number }> {
    const out = { deleted: 0, offsiteOnly: 0 };
    const slugs = this.db
      .selectDistinct({ slug: backups.siteSlug })
      .from(backups)
      .orderBy(asc(backups.siteSlug))
      .all()
      .map((r) => r.slug);
    for (const slug of slugs) {
      // Read for each site as it is reached: a deletion queued while the sites before it were
      // pruned counts too. The ones it names are its to remove, and not among the newest N.
      const away = this.goingAway();
      const rows = this.db
        .select()
        .from(backups)
        .where(
          and(
            eq(backups.siteSlug, slug),
            inArray(backups.type, [...PRUNED_BACKUP_TYPES]),
            eq(backups.status, 'complete'),
          ),
        )
        .orderBy(desc(backups.createdAt))
        .all()
        // Counted among the ones staying: a backup a deletion job has is not one of the newest N,
        // or the job would leave the site with fewer than N.
        .filter((row) => !away.has(row.id));
      for (const row of rows.slice(retention)) {
        const done = await this.retire(row);
        if (done) out[done]++;
      }
    }
    return out;
  }

  /**
   * Delete the backups that are older than their keep period, in days: `keep.sites` for a site's,
   * unless the site sets its own, and `keep.panel` for the panel's. 0 keeps them. Only the kinds
   * EXPIRING_BACKUP_TYPES names, failed ones included, which hold nothing.
   *
   * A site's own keep period is its own backups', by site id: the ones a deleted site left behind
   * follow `keep.sites`, also once another site has taken its name.
   *
   * The newest complete backup of each site - deleted ones included - and of the panel stays
   * whatever its age (retire). A site that is stopped, or whose backups keep failing, takes no new
   * ones, and would otherwise lose its last a few weeks later with nobody having asked for that.
   *
   * Like `prune`, this is local retention: a backup with a complete offsite copy only gives up
   * its files here, and its copies follow their destination's own retention.
   */
  async expire(
    keep: { sites: number; panel: number },
    opts: { now?: number; checkCanceled?: () => void } = {},
  ): Promise<{ deleted: number; offsiteOnly: number }> {
    const now = opts.now ?? Date.now();
    const out = { deleted: 0, offsiteOnly: 0 };
    const own = new Map<number, number>();
    const sitesWithOwn = this.db
      .select({ id: sites.id, days: sites.backupKeepDays })
      .from(sites)
      .where(isNotNull(sites.backupKeepDays))
      .all();
    for (const site of sitesWithOwn) if (site.days !== null) own.set(site.id, site.days);
    const daysFor = (row: BackupRow) =>
      row.type === 'panel' ? keep.panel : row.siteId !== null ? (own.get(row.siteId) ?? keep.sites) : keep.sites;
    const shortest = Math.min(...[keep.sites, keep.panel, ...own.values()].filter((days) => days > 0));
    if (!Number.isFinite(shortest)) return out; // nothing is ever deleted by age

    // Offsite-only ones are left out: there is nothing of them here, and the destination's
    // retention is what removes them there.
    const rows = this.db
      .select()
      .from(backups)
      .where(
        and(
          inArray(backups.type, [...EXPIRING_BACKUP_TYPES]),
          inArray(backups.status, ['complete', 'failed']),
          eq(backups.filesPresent, 1),
          lt(backups.createdAt, now - shortest * DAY_MS),
        ),
      )
      .orderBy(asc(backups.createdAt), asc(backups.id))
      .all();
    for (const row of rows) {
      opts.checkCanceled?.();
      const days = daysFor(row);
      if (days <= 0 || row.createdAt >= now - days * DAY_MS) continue;
      const done = await this.retire(row);
      if (done) out[done]++;
    }
    return out;
  }

  /**
   * The newest complete backup of each site and of the panel, by id: what retention never takes,
   * and what "keep the newest" leaves out of a bulk delete.
   *
   * A site here is a slug and the site the backups were taken of. A site deleted and another
   * created under its name are two: the old backups lost their site id with the old site, and
   * the newest of them - quite likely what the new site was created to restore - is the deleted
   * site's newest. Not one on its way out already (`goingAway`): the newest that is staying is.
   */
  newestCompleteIds(goingAway: ReadonlySet<number> = new Set()): Set<number> {
    const leaveOut = [...goingAway];
    const ranked = this.db
      .select({
        id: backups.id,
        rank: sql<number>`row_number() over (partition by ${backups.siteSlug}, coalesce(${backups.siteId}, 0) order by ${backups.createdAt} desc, ${backups.id} desc)`.as(
          'rank',
        ),
      })
      .from(backups)
      .where(and(eq(backups.status, 'complete'), leaveOut.length > 0 ? notInArray(backups.id, leaveOut) : undefined))
      .as('ranked');
    return new Set(
      this.db
        .select({ id: ranked.id })
        .from(ranked)
        .where(eq(ranked.rank, 1))
        .all()
        .map((row) => row.id),
    );
  }

  /**
   * Whether `row` is the newest complete backup of its site, as newestCompleteIds groups them,
   * leaving out the ones `leaveOut` names. A bulk delete asked to keep each site's newest asks this
   * as it reaches each backup: the newest may have been deleted since it was counted.
   */
  isNewestOfItsSite(row: BackupRow, leaveOut: ReadonlySet<number>): boolean {
    if (row.status !== 'complete') return false;
    const newest = this.db
      .select({ id: backups.id })
      .from(backups)
      .where(
        and(
          eq(backups.siteSlug, row.siteSlug),
          row.siteId === null ? isNull(backups.siteId) : eq(backups.siteId, row.siteId),
          eq(backups.status, 'complete'),
          leaveOut.size > 0 ? notInArray(backups.id, [...leaveOut]) : undefined,
        ),
      )
      .orderBy(desc(backups.createdAt), desc(backups.id))
      .limit(1)
      .get();
    return newest?.id === row.id;
  }

  /**
   * Whether this backup was brought back with Fetch back within FETCHED_STAYS_MS. Somebody fetched
   * it on purpose, to restore or download it, and retention would otherwise take its files again
   * the next night - or, with the fetch done halfway through a run, within the minute.
   */
  private fetchedLately(backupId: number): boolean {
    const fetches = this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, 'backup.fetch'), eq(jobs.status, 'succeeded'), gte(jobs.finishedAt, Date.now() - FETCHED_STAYS_MS)))
      .all();
    return fetches.some((job) => {
      try {
        return (JSON.parse(job.payload) as { backupId?: unknown }).backupId === backupId;
      } catch {
        return false; // not a payload this version wrote: nothing to hold back
      }
    });
  }

  /**
   * Retention's part in one backup past it: deleted, or - with a complete offsite copy - its local
   * files removed, the row staying as offsite-only. Null when it is left for the next run.
   */
  private async retire(listed: BackupRow): Promise<'deleted' | 'offsiteOnly' | null> {
    // Everything here is read as each backup is reached, not once for the run: taking the ones
    // before it took a while, and a backup deleted, fetched back or on its way out meanwhile
    // changes what may be taken.
    const row = this.db.select().from(backups).where(eq(backups.id, listed.id)).get();
    if (!row) return null; // deleted meanwhile
    const away = this.goingAway();
    if (away.has(row.id)) return null; // its deletion is under way, or queued: it is that one's
    // The newest backup its site has left stays, whatever went meanwhile.
    if (this.isNewestOfItsSite(row, away)) return null;
    const copies = this.copiesOf(row.id);
    const copied = copies.some((c) => c.status === 'complete');
    if (row.filesPresent === 0 && copied) return null; // offsite-only already
    if (row.filesPresent === 1 && this.fetchedLately(row.id)) return null;
    if (this.activeJobFor(row)) return null; // a restore/move/backup of this site is in flight; next run
    if (this.relocationJobFor(row)) return null; // its files may be on their way to a new location
    // An upload that has not happened yet - or a failed one still to be retried - would lose its
    // source. Skipping costs a night of retention; not skipping costs the offsite copy entirely.
    const uploading = (c: BackupCopyRow) =>
      c.status === 'pending' || c.status === 'uploading' || (c.status === 'failed' && c.nextAttemptAt !== null);
    if (copies.some(uploading)) return null;
    try {
      if (copied) {
        await this.removeLocalFiles(row);
        // Copies that gave up have nothing left to upload from now, and would be alerted about for
        // good: dropped, as Delete with "Keep the remote copies" drops them.
        for (const c of copies) if (c.status === 'failed') this.db.delete(backupCopies).where(eq(backupCopies.id, c.id)).run();
        return 'offsiteOnly';
      }
      await this.whileRemoving(row.id, () => this.deleteBackup(row));
      return 'deleted';
    } catch {
      // Owning server unreachable - keep the row so the files aren't orphaned silently.
      return null;
    }
  }

  /**
   * The directory this row owns, proven to be `<root>/<slug>/<timestamp>` under a root that
   * is itself a legal backup location, before anything recursive happens to it.
   *
   * This used to re-derive the path under the one hard-coded root, which was only a real
   * guarantee while there was exactly one. With roots per server the check is against the
   * root the row was written under - which is why `root_path` is stored rather than looked
   * up: moving a server's location must not turn old rows into paths that fail the test.
   */
  backupDir(row: BackupRow): string {
    const root = this.rootOf(row);
    const problem = backupRootProblem(root, this.config.srvRoot);
    if (problem) {
      throw new Error(
        `Refusing to touch the files of backup #${row.id}: its recorded location ${root} is not a valid backup root (${problem})`,
      );
    }
    const expected = safeJoin(root, row.siteSlug, path.basename(row.path));
    if (expected !== path.resolve(row.path)) {
      throw new Error(
        `Refusing to delete backup #${row.id}: ${row.path} is not <root>/<site>/<timestamp> under ${root}`,
      );
    }
    return expected;
  }

  /**
   * rm -rf the backup's files, keeping the row (it may still exist offsite). Not while another
   * backup keeps its own files in the same folder: a backup that failed had its folder removed
   * there and then, and one taken in the same second can have claimed the same name since - the
   * files in it are that one's. A failed backup, or one whose files are gone, holds nothing
   * there: a folder left to one of those would be left for good.
   */
  async removeLocalFiles(row: BackupRow): Promise<void> {
    if (row.filesPresent === 0) return;
    const owner = this.db
      .select({ id: backups.id })
      .from(backups)
      .where(
        and(
          eq(backups.serverId, row.serverId),
          eq(backups.path, row.path),
          ne(backups.id, row.id),
          eq(backups.filesPresent, 1),
          inArray(backups.status, ['complete', 'creating']),
        ),
      )
      .get();
    if (!owner) await this.handleForBackup(row).files.rm(this.backupDir(row));
    this.db.update(backups).set({ filesPresent: 0, sizeBytes: row.sizeBytes }).where(eq(backups.id, row.id)).run();
  }

  /**
   * Remove the files and the row. Offsite copies are purged by the caller first (see
   * OffsiteService.purgeCopies); the copy rows themselves cascade away with the backup.
   */
  async deleteBackup(row: BackupRow): Promise<void> {
    await this.removeLocalFiles(row);
    this.db.delete(backups).where(eq(backups.id, row.id)).run();
  }

  /** GC wordpress.pre-restore-* safety copies older than 24h, on every reachable server. */
  async gcSafetyCopies(): Promise<void> {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const server of this.servers.listRows()) {
      let h: ServerHandle;
      try {
        h = this.servers.handleFor(server.id);
      } catch {
        continue;
      }
      const slugs = await h.files.readdir(this.config.paths.sites).catch(() => [] as string[]);
      for (const slug of slugs) {
        const entries = await h.files.readdir(path.join(this.config.paths.sites, slug)).catch(() => [] as string[]);
        for (const entry of entries) {
          if (!entry.startsWith('wordpress.pre-restore-')) continue;
          const full = safeJoin(this.config.paths.sites, slug, entry);
          try {
            const stat = await h.files.stat(full);
            if (stat && stat.mtimeMs < cutoff) await h.files.rm(full);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}
