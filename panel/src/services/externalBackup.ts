// @docs backups/overview, backups/restore, sites/external
import path from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, sites, type BackupRow, type SiteRow } from '../db/schema.js';
import type { BackupType } from '../../shared/schemas.js';
import { safeJoin } from '../lib/slug.js';
import { externalSites } from '../lib/siteKind.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import type { JobContext } from '../jobs/context.js';
import { initialCursor } from './imports.js';
import { ImportListings, NOT_READ, type ListedFile } from './importListing.js';
import { DUMP_PREAMBLE, DUMP_TRAILER, checkSqlPage } from './importSql.js';
import type { PingAnswer, PluginClient } from './pluginClient.js';
import type { BackupService } from './backup.js';
import type { ConnectionsService } from './connections.js';
import type { Logger } from './index.js';
import { bytesText, importPathProblem, listFiles, pullFiles, shq } from '../jobs/handlers/import.js';
import { listedGone } from '../jobs/handlers/importRefresh.js';

/**
 * Backups of sites hosted elsewhere (sites.kind external), pulled through WPL7 Connect.
 *
 * The storage server keeps a copy of the site's files - the mirror, `<SRV_ROOT>/external/<slug>/
 * wordpress` - and each backup brings it up to date the way an import's refresh does: it lists
 * the site's files from when the last listing began, copies what changed, and removes what is
 * gone. The database is pulled whole, page by page, through one gzip stream. From the two an
 * ordinary WPL7 backup is packed - `files.tar.gz`, `db.sql.gz`, `manifest.json`, `sha256sums` -
 * so retention, offsite copies, downloads and relocation treat it like any other.
 *
 * What was listed is written down on the panel (the import's ImportListings, a folder of its
 * own, keyed by site id) and advances only when a backup succeeds: a failed one leaves the
 * record as it was, and the next run copies everything changed since the last good one.
 */

/**
 * Removes, in the copy's folder (`$1`), the files the rest of its arguments name - size, mtime,
 * path, three at a time - that are still regular files of exactly that size and mtime, and prints
 * how many it removed and how many it kept. The import refresh's script (REMOVE_UNCHANGED_SCRIPT),
 * with BSD stat as well, for a panel on macOS.
 */
export const REMOVE_GONE_SCRIPT = `cd -- "$1" || exit 2; shift
removed=0; kept=0
while [ $# -ge 3 ]; do
  size=$1; mtime=$2; file=$3; shift 3
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    now=$(stat -c '%s %Y' -- "$file" 2>/dev/null || stat -f '%z %m' -- "$file")
    if [ "$now" = "$size $mtime" ]; then
      rm -f -- "$file" && removed=$((removed + 1))
    else
      kept=$((kept + 1))
    fi
  fi
done
echo "$removed $kept"`;

/** Removes the folders its arguments name, in the copy's folder (`$1`), where they are empty. */
const REMOVE_EMPTY_DIRS = `cd -- "$1" || exit 2; shift
for dir in "$@"; do rmdir -- "$dir" 2>/dev/null; done
true`;

/** A copy whose site is gone is kept this long after it last changed. */
const ORPHAN_KEEP_MS = 7 * 24 * 3600_000;

/** The flags of a folder the site listed without looking inside it. */
const NOT_LOOKED_INTO = ['unreadable', 'too_deep', 'cycle'];

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ExternalBackupDeps {
  db: Db;
  config: Config;
  servers: ServerRegistry;
  backup: BackupService;
  connections: ConnectionsService;
  log: Logger;
}

export class ExternalBackupService {
  /** The site's files as the last good backup listed them. */
  readonly listings: ImportListings;

  constructor(private readonly s: ExternalBackupDeps) {
    this.listings = new ImportListings(path.join(s.config.paths.panel, 'external', 'listings'));
  }

  /** Where the site's copy is kept on its storage server. */
  mirrorOf(site: Pick<SiteRow, 'slug'>): { root: string; wordpress: string } {
    const base = path.join(this.s.config.srvRoot, 'external');
    const root = safeJoin(base, site.slug);
    return { root, wordpress: path.join(root, 'wordpress') };
  }

  /** Remove the site's copy and its record: the next backup starts over. */
  async forgetMirror(site: SiteRow): Promise<void> {
    this.listings.drop(site.id);
    if (!this.s.servers.rowById(site.serverId)) return;
    await this.s.servers.handleFor(site.serverId).files.rm(this.mirrorOf(site).root);
  }

  /**
   * Copies of sites that are gone from the panel (or keep their backups on another server now):
   * removed once a week has passed since they last changed, in case a site comes back under the
   * same name. Their records go with them. Returns how many were removed.
   */
  async pruneOrphans(log: (line: string) => void, now = Date.now()): Promise<number> {
    let removed = 0;
    const base = path.join(this.s.config.srvRoot, 'external');
    const owners = this.s.db.select({ id: sites.id, slug: sites.slug, serverId: sites.serverId }).from(sites).where(externalSites()).all();
    for (const server of this.s.servers.listRows()) {
      if (server.status === 'unreachable') continue;
      const h = this.s.servers.handleFor(server.id);
      const names = await h.files.readdir(base).catch(() => [] as string[]);
      for (const slug of names) {
        if (owners.some((o) => o.slug === slug && o.serverId === server.id)) continue;
        const dir = safeJoin(base, slug);
        const stat = await h.files.stat(dir).catch(() => null);
        if (stat && now - stat.mtimeMs < ORPHAN_KEEP_MS) continue;
        await h.files.rm(dir);
        removed++;
        log(`Removed the copy of "${slug}" on "${server.name}": no site hosted elsewhere keeps its backups there any more.`);
      }
    }
    // The records of sites that are gone.
    for (const id of this.listings.ids()) {
      if (!owners.some((o) => o.id === id)) this.listings.drop(id);
    }
    return removed;
  }

  /**
   * One backup of an external site, in the job that asked for it: the copy brought up to date,
   * the database pulled, the backup packed. A failure leaves no backup and keeps the record.
   */
  async create(ctx: JobContext<unknown>, site: SiteRow, type: BackupType, opts: { note?: string } = {}): Promise<BackupRow> {
    const conn = this.s.connections.forSite(site);
    const client = this.s.connections.clientForSite(site, { canceled: () => ctx.cancelRequested, log: (line) => ctx.info(line) });
    const h = this.s.servers.handleFor(site.serverId);
    const mirror = this.mirrorOf(site);
    let row: BackupRow | null = null;
    let dir: string | null = null;
    try {
      const ping = await client.ping();
      ctx.info(`WPL7 Connect answers (version ${ping.plugin}).`);
      const report = this.s.connections.reportOf(conn);
      const need = ((site.diskBytes ?? report?.files.bytes ?? 0) + (report?.db.bytes ?? 0)) * 1.5;
      const disk = await h.files.statvfs(this.s.backup.rootFor(h)).catch(() => null);
      if (disk && need > 0 && disk.freeBytes < need) {
        throw new Error(`Not enough free disk on "${h.name}": ${bytesText(disk.freeBytes)} free, about ${bytesText(need)} needed.`);
      }

      await h.files.mkdirp(path.dirname(mirror.root), { mode: 0o700 });
      await h.files.mkdirp(mirror.root, { mode: 0o700 });
      await h.files.mkdirp(mirror.wordpress, { mode: 0o755 });
      await this.refreshMirror(ctx, client, ping, h, site, mirror.wordpress);
      ctx.checkCanceled();

      const claimed = await this.s.backup.claimBackupDir(h, site.slug);
      dir = claimed.dir;
      row = this.s.db
        .insert(backups)
        .values({
          siteId: site.id,
          siteSlug: site.slug,
          serverId: h.id,
          type,
          status: 'creating',
          path: claimed.dir,
          rootPath: claimed.root,
          note: opts.note ?? null,
          jobId: ctx.jobId,
          phpVersion: site.phpVersion,
          createdAt: Date.now(),
        })
        .returning()
        .get();

      const db = await this.pullDatabase(ctx, client, ping, h, path.join(claimed.dir, 'db.sql.gz'), site);
      ctx.checkCanceled();

      ctx.info('Packing the files…');
      const tar = await h.exec.run('tar', ['-C', mirror.root, '-czf', path.join(claimed.dir, 'files.tar.gz'), 'wordpress'], {
        timeoutMs: 4 * 3600_000,
      });
      if (tar.exitCode !== 0) throw new Error(`tar failed (exit ${tar.exitCode}): ${tar.stderr.slice(0, 500)}`);

      const fresh = this.s.connections.findForSite(site.id);
      const now = this.s.connections.reportOf(fresh ?? conn) ?? report;
      const wpVersion = (await this.wpVersionOf(h, mirror.wordpress)) ?? now?.wp ?? null;
      const manifest = {
        format: 1,
        kind: 'external',
        slug: site.slug,
        title: site.title,
        type,
        createdAt: new Date().toISOString(),
        home: conn.homeUrl,
        siteurl: now?.siteurl ?? null,
        domains: JSON.parse(site.domains) as string[],
        phpVersion: site.phpVersion,
        wpVersion,
        locale: site.locale,
        tablePrefix: db.prefix,
        // The tables were read one page at a time: not one moment of the database.
        consistency: 'paged',
        longestStatement: db.longestStatement,
        skipped: { rows: db.skippedRows, tables: db.otherTables },
        serverId: h.id,
        serverName: h.name,
      };
      await h.files.writeFile(path.join(claimed.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const sums: string[] = [];
      for (const f of ['db.sql.gz', 'files.tar.gz']) sums.push(`${await h.files.sha256(path.join(claimed.dir, f))}  ${f}`);
      await h.files.writeFile(path.join(claimed.dir, 'sha256sums'), `${sums.join('\n')}\n`);

      let sizeBytes = 0;
      for (const f of await h.files.readdir(claimed.dir)) {
        sizeBytes += (await h.files.stat(path.join(claimed.dir, f)).catch(() => null))?.sizeBytes ?? 0;
      }
      const updated = this.s.db
        .update(backups)
        .set({ status: 'complete', sizeBytes, wpVersion })
        .where(eq(backups.id, row.id))
        .returning()
        .get();

      // The record advances only now: the backup it describes is whole.
      this.listings.promote(site.id);
      const mirrorBytes = await this.mirrorBytes(h, mirror.wordpress);
      const done = Date.now();
      this.s.db
        .update(sites)
        .set({ ...(mirrorBytes !== null ? { diskBytes: mirrorBytes } : {}), ...(db.prefix !== site.tablePrefix ? { tablePrefix: db.prefix } : {}), updatedAt: done })
        .where(eq(sites.id, site.id))
        .run();
      this.s.connections.remember(site, client);
      const latest = this.s.connections.findForSite(site.id);
      if (latest) this.s.connections.mark(latest.id, { lastBackupAt: done });
      ctx.info(`Backup complete (${bytesText(sizeBytes)}).`);
      return updated;
    } catch (err) {
      if (row) this.s.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row.id)).run();
      if (dir) await h.files.rm(dir).catch(() => undefined);
      this.listings.reset(site.id, 'next');
      this.s.connections.remember(site, client, { ok: false, error: errMsg(err) });
      throw err;
    } finally {
      client.close();
    }
  }

  /**
   * The copy brought up to date: listed from when the last good listing began (by the site's
   * clock, five minutes early for clocks that differ), what changed copied in, what is gone
   * removed. The first backup copies everything.
   */
  private async refreshMirror(ctx: JobContext<unknown>, client: PluginClient, ping: PingAnswer, h: ServerHandle, site: SiteRow, wordpress: string): Promise<void> {
    const before = this.listings.read(site.id);
    const since = before?.listedAt != null ? before.listedAt - 300 : undefined;
    const listedNow = new Map<string, 'folder' | 'other'>();
    const carried: [string, ListedFile][] = [];
    let unreadableListed = 0;
    // Nothing is left behind: wp-config.php is the site's, and a backup restored by hand needs it.
    const cursor = initialCursor([]);
    const nothing = async () => undefined;
    if (since === undefined) ctx.info(before ? 'The last listing has no time on it: every file is copied again.' : 'First backup: every file is copied.');
    const listing = await listFiles(ctx, client, cursor, nothing, since === undefined ? {} : { since });
    // Progress counts what is copied: the listing has every file, changed or not.
    cursor.filesTotal = 0;
    cursor.bytesTotal = 0;
    this.listings.reset(site.id, 'next', cursor.listedAt);
    await pullFiles(ctx, client, ping, h, wordpress, cursor, nothing, {
      onPage: (entries) => {
        for (const e of entries) {
          const flags = e.f ?? [];
          if (flags.includes('unreadable')) unreadableListed++;
          if (e.pb) continue;
          listedNow.set(e.p, e.t === 'd' && !flags.some((f) => NOT_LOOKED_INTO.includes(f)) ? 'folder' : 'other');
          const was = e.t === 'f' && flags.some((f) => NOT_READ.includes(f)) ? before?.files.get(e.p) : undefined;
          if (was) carried.push([e.p, was]);
        }
        this.listings.append(site.id, entries, 'next');
      },
      // Unchanged by its times is not enough: the files of a folder renamed on the site keep
      // theirs, and are new at their path.
      alreadyThere: (e) => {
        const was = e.pb ? undefined : before?.files.get(e.p);
        return was !== undefined && was.s === e.s && was.m === e.m;
      },
    });
    if ((listing.warnings?.find((w) => w.code === 'unreadable')?.count ?? 0) > unreadableListed) {
      throw new Error("The site's own folder could not be listed in full. Check its permissions on the host.");
    }
    const unlisted = before ? await this.removeDeleted(ctx, h, wordpress, before.files, listedNow) : [];
    this.listings.carry(site.id, [...carried, ...unlisted]);
    const { links, unreadable, changed } = cursor.skipped;
    if (links > 0) ctx.warn(`${links} symbolic link${links === 1 ? ' was' : 's were'} not copied.`);
    if (unreadable > 0) ctx.warn(`${unreadable} file${unreadable === 1 ? '' : 's'} could not be read on the site and ${unreadable === 1 ? 'is' : 'are'} not in the backup.`);
    if (changed.length > 0) {
      ctx.warn(`${changed.length} file${changed.length === 1 ? '' : 's'} kept changing while being copied: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}.`);
    }
    ctx.info(`Files: ${cursor.filesDone.toLocaleString('en-US')} new or changed, ${bytesText(cursor.bytesDone)}.`);
  }

  /**
   * The files the last listing had and this one has not, removed from the copy where they are
   * still as they were pulled. One in a folder the site could not list this time stays, and its
   * record with it. Nothing in the copy is a link, so a plain `rm` on the server is safe.
   */
  private async removeDeleted(
    ctx: JobContext<unknown>,
    h: ServerHandle,
    wordpress: string,
    before: Map<string, ListedFile>,
    now: Map<string, 'folder' | 'other'>,
  ): Promise<[string, ListedFile][]> {
    const gone: string[] = [];
    const unlisted: [string, ListedFile][] = [];
    for (const [file, listed] of before) {
      if (now.has(file) || importPathProblem(Buffer.from(file, 'utf8'))) continue;
      if (!listedGone(file, now)) {
        unlisted.push([file, listed]);
        continue;
      }
      gone.push(String(listed.s), String(listed.m), file);
    }
    if (unlisted.length > 0) ctx.warn(`Kept ${unlisted.length} file${unlisted.length === 1 ? '' : 's'} in folders the site could not list.`);
    let removed = 0;
    for (let i = 0; i < gone.length; i += 600) {
      const res = await h.exec.run('sh', ['-c', REMOVE_GONE_SCRIPT, 'sh', wordpress, ...gone.slice(i, i + 600)], { timeoutMs: 5 * 60_000 });
      const [r] = res.stdout.trim().split(' ').map(Number);
      if (res.exitCode !== 0 || !Number.isFinite(r)) {
        throw new Error(`Removing the files the site deleted failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
      }
      removed += r!;
    }
    // The folders those files were in, where the site no longer has them: deepest first, and only
    // while empty.
    const folders = new Set<string>();
    for (let i = 2; i < gone.length; i += 3) {
      const file = gone[i]!;
      for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
        const dir = file.slice(0, slash);
        if (now.has(dir)) break;
        folders.add(dir);
      }
    }
    const deepestFirst = [...folders].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
    for (let i = 0; i < deepestFirst.length; i += 600) {
      await h.exec.run('sh', ['-c', REMOVE_EMPTY_DIRS, 'sh', wordpress, ...deepestFirst.slice(i, i + 600)], { timeoutMs: 5 * 60_000 });
    }
    if (removed > 0) ctx.info(`Removed ${removed} file${removed === 1 ? '' : 's'} the site deleted since the last backup.`);
    return unlisted;
  }

  /**
   * The database: the tables with the site's prefix, page by page, checked, through one
   * `gzip -c` into the backup. One gzip member, which phpMyAdmin and every other importer reads.
   */
  private async pullDatabase(
    ctx: JobContext<unknown>,
    client: PluginClient,
    ping: PingAnswer,
    h: ServerHandle,
    file: string,
    site: SiteRow,
  ): Promise<{ prefix: string; longestStatement: number; skippedRows: Record<string, unknown>[]; otherTables: string[] }> {
    ctx.info('Copying the database…');
    const answer = await client.tables();
    const prefix = answer.prefix || site.tablePrefix;
    const tables = answer.tables.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
    const otherTables = answer.tables.filter((t) => !t.name.startsWith(prefix)).map((t) => t.name);
    if (otherTables.length > 0) ctx.info(`${otherTables.length} table${otherTables.length === 1 ? '' : 's'} without the prefix ${prefix} left out.`);
    const maxBytes = Math.max(64 * 1024, ping.limits.max_bytes);
    const skippedRows: Record<string, unknown>[] = [];
    let longestStatement = 0;
    let collationsWarned = false;
    let failure: unknown = null;
    async function* dump(): AsyncGenerator<Buffer> {
      yield Buffer.from(`${DUMP_PREAMBLE}\n`, 'utf8');
      let done = 0;
      for (const table of tables) {
        let cursor = '';
        for (;;) {
          ctx.checkCanceled();
          const page = await client.sql(table, cursor, maxBytes);
          const checked = checkSqlPage(page.sql, table, { first: cursor === '' });
          for (const w of page.warnings) {
            ctx.warn(w.code === 'create_comment' ? `${table}: copied without ${w.detail ?? 'a comment'} from its definition.` : `${table}: ${w.detail ?? w.code}`);
          }
          if (checked.collations && !collationsWarned) {
            ctx.warn('MySQL 8 collations were written as their MariaDB equivalents.');
            collationsWarned = true;
          }
          for (const line of checked.lines) longestStatement = Math.max(longestStatement, Buffer.byteLength(line, 'utf8'));
          if (checked.lines.length > 0) yield Buffer.from(`${checked.lines.join('\n')}\n`, 'utf8');
          for (const r of page.skipped) skippedRows.push({ table, ...r });
          if (page.skipped.length > 0) ctx.warn(`${table}: ${page.skipped.length} row${page.skipped.length === 1 ? '' : 's'} too large to copy.`);
          if (page.next === null) break;
          cursor = page.next;
        }
        done++;
        if (done % 10 === 0 || done === tables.length) ctx.info(`… ${done} of ${tables.length} tables`);
      }
      yield Buffer.from(`${DUMP_TRAILER}\n`, 'utf8');
    }
    const input = Readable.from(
      (async function* () {
        try {
          yield* dump();
        } catch (err) {
          failure = err;
          throw err;
        }
      })(),
    );
    const res = await h.exec.runWithInput('sh', ['-c', `gzip -c > ${shq(file)}`], input, { timeoutMs: 6 * 3600_000 });
    if (failure) throw failure;
    if (res.exitCode !== 0) throw new Error(`Writing the database copy failed: ${res.stderr.trim().slice(0, 300)}`);
    const test = await h.exec.run('gzip', ['-t', file], { timeoutMs: 30 * 60_000 });
    if (test.exitCode !== 0) throw new Error(`The database copy is damaged: ${test.stderr.trim().slice(0, 300)}`);
    ctx.info(`Database copied: ${tables.length} tables.`);
    return { prefix, longestStatement, skippedRows, otherTables };
  }

  private async wpVersionOf(h: ServerHandle, wordpress: string): Promise<string | null> {
    const content = await h.files.readUntrusted(path.join(wordpress, 'wp-includes', 'version.php'), 64 * 1024).catch(() => null);
    return content === null ? null : (/\$wp_version\s*=\s*'([^']+)'/.exec(content)?.[1] ?? null);
  }

  private async mirrorBytes(h: ServerHandle, wordpress: string): Promise<number | null> {
    // -sk is portable (macOS du has no -b); KiB * 1024, as the monitor's disk usage does it.
    const res = await h.exec.run('du', ['-sk', wordpress], { timeoutMs: 10 * 60_000 }).catch(() => null);
    const kib = res && res.exitCode === 0 ? Number(res.stdout.trim().split(/\s+/)[0]) : NaN;
    return Number.isFinite(kib) ? kib * 1024 : null;
  }
}
