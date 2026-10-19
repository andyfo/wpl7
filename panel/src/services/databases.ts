// @docs databases/overview, sites/database
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  jobs,
  moveCleanups,
  serverDatabaseScans,
  serverDatabases,
  servers,
  siteDatabases,
  sites,
  type SiteDatabaseRow,
  type SiteRow,
} from '../db/schema.js';
import type { Config } from '../config.js';
import type { DatabaseListDto, DatabaseListItemDto, DatabaseUseDto, SiteDatabaseDto } from '../../shared/types.js';
import { conflict, notFound } from '../lib/errors.js';
import { hostedSites } from '../lib/siteKind.js';
import { safeJoin } from '../lib/slug.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { DbTarget } from './dbBrowser.js';
import type { Logger } from './index.js';

/** Who claims a database: a site (its own, or another of its), or a move's old copy. */
export type DatabaseClaim = Exclude<DatabaseUseDto, { kind: 'unused' }>;

/** How often each server's databases are read on the timer; jobs that change one read it at once. */
export const INVENTORY_EVERY_MS = 3600_000;

/** Where an import's upload waits on the site's server: beside its files, out of the container's reach. */
export const DB_UPLOADS_DIR = 'db-uploads';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A site's databases - its own and the others it was given - and every server's databases as the
 * last inventory found them.
 *
 * Who a database belongs to is never stored with the inventory: it is worked out each time from
 * the sites (their own database is `wp_<slug>` on the server they run on), their other databases
 * (site_databases) and the moves still waiting to drop an old copy. A database none of those
 * claims is unused, and only such a one may be deleted from the Databases page.
 */
export class DatabasesService {
  /** Servers a job asked to be read again, for the next kicked tick. */
  private kicked = new Set<number>();
  private kicker: (() => void) | null = null;
  /** The read in progress: reads run one at a time, so an older one is never written over a newer. */
  private reading: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
  ) {}

  // ---------------------------------------------------------------- a site's databases

  /** The site's other databases, by name. */
  extras(siteId: number): SiteDatabaseRow[] {
    return this.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, siteId)).orderBy(asc(siteDatabases.name)).all();
  }

  extraNames(siteId: number): string[] {
    return this.extras(siteId).map((d) => d.name);
  }

  /**
   * Who to connect as, to work in `database`: one of the site's, or a 404 - a request can never
   * reach a database the site does not own, whatever its name.
   */
  targetFor(site: SiteRow, database: string): DbTarget {
    if (database !== site.dbName && !this.extraNames(site.id).includes(database)) {
      throw notFound(`"${database}" is not one of this site's databases`);
    }
    return { database, user: site.dbUser, password: site.dbPassword };
  }

  /** Refuses a name already taken in the panel. The server is asked when the database is created. */
  assertNameFree(name: string): void {
    const taken = this.db
      .select({ slug: sites.slug })
      .from(siteDatabases)
      .innerJoin(sites, eq(sites.id, siteDatabases.siteId))
      .where(eq(siteDatabases.name, name))
      .get();
    if (taken) throw conflict(`"${name}" is taken: it is a database of ${taken.slug}`);
  }

  siteInfo(site: SiteRow): SiteDatabaseDto {
    const scan = this.scanOf(site.serverId);
    const sizes = this.sizesOn(site.serverId);
    const entry = (name: string, kind: 'site' | 'extra', createdAt: number | null) => {
      const size = sizes.get(name) ?? null;
      return { name, kind, size, missing: scan?.scannedAt != null && size === null, createdAt };
    };
    return {
      name: site.dbName,
      user: site.dbUser,
      host: this.config.mariadb.host,
      port: 3306,
      tablePrefix: site.tablePrefix,
      databases: [
        entry(site.dbName, 'site', null),
        ...this.extras(site.id).map((d) => entry(d.name, 'extra', d.createdAt)),
      ],
      serverName: this.servers.rowById(site.serverId)?.name ?? `#${site.serverId}`,
      scannedAt: scan?.scannedAt ?? null,
      scanError: scan?.error ?? null,
    };
  }

  /** Where an import's upload is staged on the site's server. */
  uploadPath(site: SiteRow, uploadId: string): string {
    return safeJoin(this.config.paths.sites, site.slug, DB_UPLOADS_DIR, `${uploadId}.sql.gz`);
  }

  uploadDir(site: SiteRow): string {
    return path.dirname(this.uploadPath(site, 'x'.repeat(16)));
  }

  /**
   * An added database's name, taken in the panel before the database is made on the server: the
   * unique name is the reservation, so two jobs never make the same one. The row's id, or `null`
   * when the name is taken already.
   */
  reserve(siteId: number, name: string, createdBy: string | null): number | null {
    const row = this.db
      .insert(siteDatabases)
      .values({ siteId, name, createdBy, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ id: siteDatabases.id })
      .get();
    return row?.id ?? null;
  }

  /** Uploads a queued or running import still needs: never pruned, deleted or written to. */
  uploadsInUse(): Set<string> {
    const rows = this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, 'database.import'), inArray(jobs.status, ['queued', 'running'])))
      .all();
    const ids = new Set<string>();
    for (const { payload } of rows) {
      try {
        const id = (JSON.parse(payload) as { uploadId?: unknown }).uploadId;
        if (typeof id === 'string') ids.add(id);
      } catch {
        // A payload that is not JSON names no upload.
      }
    }
    return ids;
  }

  assertUploadFree(uploadId: string): void {
    if (this.uploadsInUse().has(uploadId)) throw conflict('An import is using this upload; wait for it to end');
  }

  /**
   * Drop uploads older than a day: an import that was never started, or one that failed and was not
   * run again. One `find` per server, over every site's upload folder there, and nothing else: the
   * pattern names the folder at its place (`<sites>/<slug>/db-uploads/`), so a site whose slug is
   * `db-uploads` keeps its files.
   */
  async pruneUploads(): Promise<number> {
    let removed = 0;
    const hostsWithSites = new Set(
      this.db.select({ serverId: sites.serverId }).from(sites).where(hostedSites()).all().map((r) => r.serverId),
    );
    const root = this.config.paths.sites.replace(/\/+$/, '');
    const pattern = `${root.replace(/[*?[\]\\]/g, '\\$&')}/*/${DB_UPLOADS_DIR}/*.sql.gz`;
    const keep = [...this.uploadsInUse()].flatMap((id) => ['!', '-name', `${id}.sql.gz`]);
    for (const serverId of hostsWithSites) {
      const res = await this.servers
        .handleFor(serverId)
        .exec.run(
          'find',
          [root, '-mindepth', '3', '-maxdepth', '3', '-path', pattern, '-type', 'f', ...keep, '-mmin', '+1440', '-print', '-delete'],
          { timeoutMs: 5 * 60_000 },
        )
        .catch((err: unknown) => {
          this.log.warn(`Database uploads on server #${serverId}: ${errorText(err)}`);
          return null;
        });
      if (res?.exitCode === 0) removed += res.stdout.split('\n').filter(Boolean).length;
    }
    return removed;
  }

  // ---------------------------------------------------------------- every database

  list(): DatabaseListDto {
    const serverRows = this.db.select().from(servers).orderBy(asc(servers.id)).all();
    const names = new Map(serverRows.map((s) => [s.id, s.name]));
    const scans = new Map(this.db.select().from(serverDatabaseScans).all().map((s) => [s.serverId, s]));
    const claims = this.claims();
    const items: DatabaseListItemDto[] = [];
    const seen = new Set<string>();
    for (const row of this.db.select().from(serverDatabases).all()) {
      const k = `${row.serverId}\u0000${row.name}`;
      seen.add(k);
      items.push({
        serverId: row.serverId,
        serverName: names.get(row.serverId) ?? `#${row.serverId}`,
        name: row.name,
        size: { tables: row.tables, bytes: row.bytes },
        collation: row.collation,
        use: claims.get(k)?.use ?? { kind: 'unused' },
        missing: false,
      });
    }
    // What a site's record says should be on a server whose databases were read, and is not.
    for (const [k, claim] of claims) {
      if (seen.has(k) || !claim.expected) continue;
      if (!scans.get(claim.serverId)?.scannedAt) continue;
      items.push({
        serverId: claim.serverId,
        serverName: names.get(claim.serverId) ?? `#${claim.serverId}`,
        name: claim.name,
        size: null,
        collation: null,
        use: claim.use,
        missing: true,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name) || a.serverName.localeCompare(b.serverName));
    return {
      databases: items,
      servers: serverRows.map((s) => ({
        id: s.id,
        name: s.name,
        scannedAt: scans.get(s.id)?.scannedAt ?? null,
        error: scans.get(s.id)?.error ?? null,
      })),
    };
  }

  /**
   * Every database something claims, by server and name. `expected`: a site's record says it is
   * there - the old copy of a move is claimed (it is not unused) but not expected.
   */
  private claims(): Map<string, { serverId: number; name: string; use: DatabaseClaim; expected: boolean }> {
    const out = new Map<string, { serverId: number; name: string; use: DatabaseClaim; expected: boolean }>();
    const hosted = this.db.select().from(sites).where(hostedSites()).all();
    const byId = new Map(hosted.map((s) => [s.id, s]));
    // Still being made, or going: its database may not be there yet, or any more.
    const settled = (s: SiteRow) => s.status !== 'provisioning' && s.status !== 'deleting';
    for (const s of hosted) {
      out.set(`${s.serverId}\u0000${s.dbName}`, {
        serverId: s.serverId,
        name: s.dbName,
        use: { kind: 'site', siteId: s.id, slug: s.slug, title: s.title },
        expected: settled(s),
      });
    }
    for (const d of this.db.select().from(siteDatabases).all()) {
      const s = byId.get(d.siteId);
      if (!s) continue;
      out.set(`${s.serverId}\u0000${d.name}`, {
        serverId: s.serverId,
        name: d.name,
        use: { kind: 'extra', siteId: s.id, slug: s.slug, title: s.title },
        expected: settled(s),
      });
    }
    const pending = this.db.select().from(moveCleanups).where(eq(moveCleanups.status, 'pending')).all();
    for (const c of pending) {
      for (const name of [c.dbName, ...parseNames(c.extraDbs)]) {
        const k = `${c.sourceServerId}\u0000${name}`;
        if (!out.has(k)) out.set(k, { serverId: c.sourceServerId, name, use: { kind: 'moveCopy', slug: c.siteSlug }, expected: false });
      }
    }
    return out;
  }

  /** What claims a database on a server, if anything: a delete of an "unused" one checks this again. */
  claimOf(serverId: number, name: string): DatabaseClaim | null {
    return this.claims().get(`${serverId}\u0000${name}`)?.use ?? null;
  }

  /** Whether any site, on any server, still names this as its database user. */
  userClaimed(user: string): boolean {
    return !!this.db.select({ id: sites.id }).from(sites).where(and(hostedSites(), eq(sites.dbUser, user))).get();
  }

  // ---------------------------------------------------------------- the inventory

  attachKicker(kicker: () => void): void {
    this.kicker = kicker;
  }

  /** Read a server's databases again soon: a job just added, dropped or replaced one. */
  kick(serverId: number): void {
    this.kicked.add(serverId);
    if (this.kicker) this.kicker();
    else void this.scanKicked();
  }

  /**
   * The scheduler's tick: the kicked servers on a kick, every server on the timer. Either way it
   * ends with the servers kicked while it ran: the scheduler runs one tick at a time and drops a
   * kick that finds one running, so those would otherwise wait for the hour.
   */
  async tick(how: 'timer' | 'boot' | 'kick' | 'manual'): Promise<{ scanned: number; failed: number }> {
    let total = { scanned: 0, failed: 0 };
    if (how !== 'kick') {
      this.kicked.clear();
      total = await this.scanAll();
    }
    while (this.kicked.size > 0) {
      const more = await this.scanKicked();
      total = { scanned: total.scanned + more.scanned, failed: total.failed + more.failed };
    }
    return total;
  }

  async scanAll(): Promise<{ scanned: number; failed: number }> {
    return this.exclusive(() => {
      const ids = this.db
        .select({ id: servers.id, status: servers.status })
        .from(servers)
        .all()
        .filter((s) => s.status !== 'provisioning')
        .map((s) => s.id);
      return this.scanEach(ids);
    });
  }

  private async scanKicked(): Promise<{ scanned: number; failed: number }> {
    return this.exclusive(() => {
      const ids = [...this.kicked];
      this.kicked.clear();
      return this.scanEach(ids);
    });
  }

  /** One read at a time, in the order asked: Refresh and the scheduler never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.reading.then(fn, fn);
    this.reading = run.catch(() => undefined);
    return run;
  }

  private async scanEach(ids: number[]): Promise<{ scanned: number; failed: number }> {
    let failed = 0;
    // One at a time: a server's MariaDB answers in well under a second, and a slow one (an SSH
    // hop timing out) holds nobody up but the timer.
    for (const id of ids) {
      if (!(await this.scanServer(id))) failed++;
    }
    return { scanned: ids.length - failed, failed };
  }

  /** Read one server's databases into the snapshot. False when it could not be read; the reason is kept. */
  private async scanServer(serverId: number): Promise<boolean> {
    const attemptedAt = Date.now();
    try {
      const rows = await this.servers.handleFor(serverId).dbAdmin.inventory();
      this.db.transaction((tx) => {
        tx.delete(serverDatabases).where(eq(serverDatabases.serverId, serverId)).run();
        for (const r of rows) {
          tx.insert(serverDatabases)
            .values({ serverId, name: r.name, tables: r.tables, bytes: r.bytes, collation: r.collation })
            .run();
        }
        tx.insert(serverDatabaseScans)
          .values({ serverId, scannedAt: attemptedAt, attemptedAt, error: null })
          .onConflictDoUpdate({ target: serverDatabaseScans.serverId, set: { scannedAt: attemptedAt, attemptedAt, error: null } })
          .run();
      });
      return true;
    } catch (err) {
      const error = errorText(err).slice(0, 500);
      // The server may be gone (deleted meanwhile): nothing to record then.
      if (!this.servers.rowById(serverId)) return false;
      this.db
        .insert(serverDatabaseScans)
        .values({ serverId, scannedAt: null, attemptedAt, error })
        .onConflictDoUpdate({ target: serverDatabaseScans.serverId, set: { attemptedAt, error } })
        .run();
      this.log.warn(`Databases on server #${serverId}: could not read them (${error})`);
      return false;
    }
  }

  private scanOf(serverId: number) {
    return this.db.select().from(serverDatabaseScans).where(eq(serverDatabaseScans.serverId, serverId)).get();
  }

  private sizesOn(serverId: number): Map<string, { tables: number; bytes: number }> {
    return new Map(
      this.db
        .select()
        .from(serverDatabases)
        .where(eq(serverDatabases.serverId, serverId))
        .all()
        .map((r) => [r.name, { tables: r.tables, bytes: r.bytes }]),
    );
  }

  /** Sizes of the given databases on a server, for the site list's totals. */
  sizesOf(serverId: number, names: string[]): Map<string, { tables: number; bytes: number }> {
    if (names.length === 0) return new Map();
    return new Map(
      this.db
        .select()
        .from(serverDatabases)
        .where(and(eq(serverDatabases.serverId, serverId), inArray(serverDatabases.name, names)))
        .all()
        .map((r) => [r.name, { tables: r.tables, bytes: r.bytes }]),
    );
  }
}

/** The extra database names a move-cleanup row recorded; none for a row from before there were any. */
export function parseNames(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}
