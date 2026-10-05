import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  backupCopies,
  backups,
  jobs,
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
 * Backup kinds the retention setting applies to. Everything else - manual, final,
 * pre_restore, move - is kept until somebody deletes it, because each of those exists
 * because a person or an operation asked for it.
 */
export const PRUNED_BACKUP_TYPES = ['scheduled', 'panel'] as const;

/** Job types that read or write a site's backup files while they run. */
const BACKUP_USING_JOB_TYPES = ['backup.create', 'backup.restore', 'site.move', 'site.delete'] as const;
/** Job types that read or write ONE backup's files, outside the site's job lane. */
const COPY_JOB_TYPES = ['backup.offsite', 'backup.fetch'] as const;

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
        tablePrefix: 'wp_',
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
   */
  activeJobFor(row: BackupRow): JobRow | undefined {
    const siteJob = this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.siteSlug, row.siteSlug),
          inArray(jobs.status, ['queued', 'running']),
          inArray(jobs.type, [...BACKUP_USING_JOB_TYPES]),
        ),
      )
      .get();
    return siteJob ?? this.activeCopyJobFor(row.id);
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

  /** 409 when the backup is still being written or a job may be using it. */
  assertDeletable(row: BackupRow): void {
    if (row.status === 'creating') throw conflict(`Backup #${row.id} is still being created`);
    const uploading = this.copiesOf(row.id).find((c) => c.status === 'uploading');
    if (uploading) {
      throw conflict(
        `Backup #${row.id} is being copied to a remote destination right now; wait for that copy to finish`,
      );
    }
    const job = this.activeJobFor(row);
    if (job) {
      throw conflict(
        `Backup #${row.id} cannot be deleted while job #${job.id} (${job.type}) for "${row.siteSlug}" is ${job.status}; ` +
          `wait for it to finish`,
      );
    }
  }

  /**
   * Apply retention to scheduled backups. Manual/final/pre_restore/move are kept until
   * deleted explicitly.
   *
   * Local retention never destroys the last copy of anything: a backup that already exists
   * at an offsite destination gives up its local files and stays listed as offsite-only,
   * so a short local retention next to a long offsite one is a sensible thing to configure
   * rather than a way to lose last month.
   */
  async prune(retention: number): Promise<{ deleted: number; offsiteOnly: number }> {
    let deleted = 0;
    let offsiteOnly = 0;
    const slugs = this.db
      .selectDistinct({ slug: backups.siteSlug })
      .from(backups)
      .all()
      .map((r) => r.slug);
    for (const slug of slugs) {
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
        .all();
      for (const row of rows.slice(retention)) {
        if (this.activeJobFor(row)) continue; // a restore/move/backup of this site is in flight; next run
        const copies = this.copiesOf(row.id);
        // An upload that has not happened yet would lose its source. Skipping costs one
        // night of retention; not skipping costs the offsite copy entirely.
        if (copies.some((c) => c.status === 'pending' || c.status === 'uploading')) continue;
        try {
          if (copies.some((c) => c.status === 'complete')) {
            if (row.filesPresent === 1) {
              await this.removeLocalFiles(row);
              offsiteOnly++;
            }
          } else {
            await this.deleteBackup(row);
            deleted++;
          }
        } catch {
          // Owning server unreachable - keep the row so the files aren't orphaned silently.
        }
      }
    }
    return { deleted, offsiteOnly };
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

  /** rm -rf the backup's files, keeping the row (it may still exist offsite). */
  async removeLocalFiles(row: BackupRow): Promise<void> {
    if (row.filesPresent === 0) return;
    const h = this.handleForBackup(row);
    await h.files.rm(this.backupDir(row));
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
