// @docs sites/import
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { imports, jobs, sites, type ImportRow, type JobRow, type SiteRow } from '../db/schema.js';
import type { ImportCreateBody, ImportRunBody, ImportStatus } from '../../shared/schemas.js';
import type {
  ImportConnectionCodeDto,
  ImportDto,
  ImportProgressDto,
  ImportSourceDto,
  ImportSummaryDto,
  MigrateStatusDto,
  SiteDetail,
} from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateSecret, sameSecret, sha256Hex } from '../lib/crypto.js';
import { panelUrl } from '../lib/panelUrl.js';
import { PANEL_VERSION } from '../lib/version.js';
import { containerName, dbIdentifier, isValidSlug, safeJoin } from '../lib/slug.js';
import { zipOf, type ZipEntry } from '../lib/zipWriter.js';
import { OutboundRefusedError, assertAllowedSource, type LookupFn } from '../lib/outboundGuard.js';
import { importLane } from '../jobs/lanes.js';
import type { JobWorker } from '../jobs/worker.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import { assertDomainsFree } from './domainGuard.js';
import { resolveTargetServer } from './sites.js';
import {
  MIGRATE_PROTOCOL,
  blockingReason,
  checkChoices,
  inspectReport,
  migrateReportSchema,
  type MigrateReport,
} from './importInspect.js';
import { ImportListings } from './importListing.js';
import { ImportPullClient, type PullState, type PullTransport, type RangeEncoding, type Transport } from './importPull.js';

/**
 * Imports of existing WordPress sites (docs/internal/import-protocol.md): the record of each one,
 * the personalised migration plugin it hands out, the two calls that plugin makes back - its
 * report when it connects, and the progress its admin page shows - and the bookkeeping of the
 * two jobs that do the work (jobs/handlers/import.ts).
 *
 * Every import has its own token, 32 random bytes: the plugin presents it to the panel, and the
 * panel signs its requests to the plugin with it. It is the only thing that lets anyone pull the
 * site, so it is never in a DTO or a log line, and it is dropped the moment the import no longer
 * needs the plugin (Disconnect, expiry).
 */

/** How long an import may sit in each state before it expires. */
export const IMPORT_TTL_MS = {
  /** Created, the plugin not yet heard from. */
  pending: 24 * 3600_000,
  /** Connected, Start import not yet chosen. */
  connected: 7 * 24 * 3600_000,
  /** Failed, and nobody chose Continue: its staging folder is cleared away. */
  failed: 7 * 24 * 3600_000,
  /** Expired, before the record itself goes. */
  expired: 30 * 24 * 3600_000,
} as const;

/** The states in which a job owns the import: it can be neither deleted nor disconnected. */
export const IMPORT_BUSY: readonly ImportStatus[] = ['queued', 'pulling', 'pulled', 'finishing'];

/** The states a site's import has not finished in: the site cannot be deleted but through it. */
const IMPORT_UNFINISHED: readonly ImportStatus[] = [...IMPORT_BUSY, 'failed'];

/** What a plugin route answers instead of the panel's usual error: the plugin acts on the status. */
export class PluginRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PluginRefusal';
  }
}

/**
 * How far an import has got: the pull job keeps it in `imports.cursor` and, as its twin, in the
 * staging folder's `import.json`, so a job that stopped - a restart, a failure, Stop - goes on
 * from the last batch that was safely written.
 */
export interface ImportCursor {
  phase: 'snapshot' | 'files' | 'db' | 'done';
  snapshotId: string | null;
  transport: Transport | null;
  encoding: RangeEncoding;
  skewS: number;
  /** Paths left behind on purpose: wp-config.php, and the drop-ins and must-use plugins chosen. */
  skip: string[];
  /** The last snapshot entry written. */
  filesAfterId: number;
  filesDone: number;
  bytesDone: number;
  filesTotal: number;
  bytesTotal: number;
  /** Entries that changed while they were read, to read again; how often each was. */
  retry: number[];
  retried: Record<string, number>;
  /** What was left out, for the warnings at the end. */
  skipped: { links: number; unreadable: number; changed: string[]; rows: number };
  /** The tables to pull, fixed when the database part starts. */
  tables: string[] | null;
  /** The table being pulled, and where in it. */
  dbTable: string | null;
  dbCursor: string;
  /** db.sql.gz's size after the last page that was safely written. */
  dbBytesCommitted: number;
  /** The longest statement in db.sql.gz, in bytes: the database server has to take it whole. */
  longestStatement: number;
  tablesDone: number;
  tablesTotal: number;
  /**
   * When the listing began, by the old site's clock (unix seconds). A file changed after that may
   * have been read before it changed; a refresh copies everything changed from then on.
   */
  listedAt?: number;
  /** The finish job has moved the files into the site's folder. */
  materialized: boolean;
}

export function initialCursor(skip: string[]): ImportCursor {
  return {
    phase: 'snapshot',
    snapshotId: null,
    transport: null,
    encoding: 'raw',
    skewS: 0,
    skip,
    filesAfterId: 0,
    filesDone: 0,
    bytesDone: 0,
    filesTotal: 0,
    bytesTotal: 0,
    retry: [],
    retried: {},
    skipped: { links: 0, unreadable: 0, changed: [], rows: 0 },
    tables: null,
    dbTable: null,
    dbCursor: '',
    dbBytesCommitted: 0,
    longestStatement: 0,
    tablesDone: 0,
    tablesTotal: 0,
    materialized: false,
  };
}

const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** A PHP single-quoted string literal. */
const phpString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const hostOf = (url: string | null): string => {
  try {
    return url ? new URL(url).hostname : 'the old site';
  } catch {
    return 'the old site';
  }
};

export class ImportService {
  /** How the old site's address is resolved before the panel calls it; tests swap it. */
  lookup: LookupFn | undefined;
  /** How the panel's requests reach the old site; tests swap it for a fake old site. */
  transport: PullTransport | undefined;
  /** How the pull waits between retries; tests make it instant. */
  retrySleep: ((ms: number) => Promise<void>) | undefined;
  private worker: JobWorker | null = null;
  /** The old site's files as each import's last pull listed them (importListing.ts). */
  readonly listings: ImportListings;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
  ) {
    this.listings = new ImportListings(path.join(config.paths.panel, 'imports'));
  }

  /** The queue, once it exists: it is built from the bundle this service is in (see CoreServices.worker). */
  attachWorker(worker: JobWorker): void {
    this.worker = worker;
  }

  /**
   * Where the old site reaches the panel: PANEL_DOMAIN, as every link the panel sends out says it.
   * Outside production an install without one falls back to localhost, which a plugin on a
   * container on the same machine can be pointed at by hand.
   */
  origin(): string | null {
    const url = panelUrl(this.config);
    if (url) return url;
    return this.config.nodeEnv === 'production' ? null : `http://localhost:${this.config.port}`;
  }

  // ------------------------------------------------------------------ records

  create(body: ImportCreateBody, createdBy: string | null): ImportRow {
    if (!this.origin()) {
      throw conflict('Set PANEL_DOMAIN first: the old site connects to the panel at that address');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    return this.db
      .insert(imports)
      .values({
        token,
        tokenHash: sha256Hex(token),
        status: 'pending',
        sourceUrl: body.sourceUrl ?? null,
        allowHttp: body.allowHttp ? 1 : 0,
        createdBy,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + IMPORT_TTL_MS.pending,
      })
      .returning()
      .get();
  }

  /** The import, with an expiry that is due applied first. 404 when there is none. */
  get(id: number): ImportRow {
    const row = this.db.select().from(imports).where(eq(imports.id, id)).get();
    if (!row) throw notFound(`Import #${id} not found`);
    return this.expireIfDue(row);
  }

  list(): ImportSummaryDto[] {
    return this.db
      .select()
      .from(imports)
      .orderBy(desc(imports.id))
      .limit(200)
      .all()
      .map((row) => this.toSummary(this.expireIfDue(row)));
  }

  /**
   * Remove an import: its record, its staging folder, the site row it reserved when that never
   * became a site, and its hold on the old site (the plugin is told to stop, if it answers).
   * Refused while a job works on it. A site the import finished is not touched: it is a site
   * like any other by then.
   */
  async delete(id: number): Promise<void> {
    const row = this.get(id);
    this.assertIdle(row);
    // The token goes before anything is awaited: no job can start on the import meanwhile.
    if (row.token) this.mark(row.id, { token: null });
    if (row.token && row.status !== 'pending') await this.tellPluginToFinish(row);
    await this.clearStaging(row);
    this.listings.drop(row.id);
    this.db.transaction(() => {
      this.db.delete(imports).where(eq(imports.id, row.id)).run();
      this.releaseSiteRow(row);
    });
  }

  /**
   * Stop the old site's plugin answering this import: it is told to clean up and deactivate when
   * it can be reached, and the token goes either way, so the panel can no longer sign a request
   * with it. An import that had not started cannot go on without it, and expires.
   */
  async disconnect(id: number): Promise<ImportRow> {
    const row = this.get(id);
    this.assertIdle(row);
    // The token goes before anything is awaited: no refresh can start meanwhile.
    const now = Date.now();
    const waiting = row.status === 'pending' || row.status === 'connected';
    const updated = this.db
      .update(imports)
      .set({
        token: null,
        disconnectedAt: row.token ? now : row.disconnectedAt,
        ...(waiting ? { status: 'expired' } : {}),
        updatedAt: now,
      })
      .where(eq(imports.id, row.id))
      .returning()
      .get();
    this.listings.drop(row.id);
    if (row.token && row.status !== 'pending') await this.tellPluginToFinish(row);
    return updated;
  }

  /**
   * The queued or running refresh of this import, if any. The import stays `done` while one
   * runs, so its status does not show it.
   */
  activeRefresh(id: number): JobRow | undefined {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'site.importRefresh'), inArray(jobs.status, ['queued', 'running'])))
      .all()
      .find((job) => refreshedImport(job.payload) === id);
  }

  /** Refused while a job works on the import: one of its own, or a refresh. */
  private assertIdle(row: ImportRow): void {
    if (IMPORT_BUSY.includes(row.status as ImportStatus)) throw conflict('The import is running. Stop its job first.');
    if (this.activeRefresh(row.id)) throw conflict('A refresh from the old site is running. Stop its job first.');
  }

  /** The import that is making, or failed to make, this site; a site with one cannot be deleted. */
  activeForSite(siteId: number): ImportRow | undefined {
    return this.db
      .select()
      .from(imports)
      .where(and(eq(imports.siteId, siteId), inArray(imports.status, [...IMPORT_UNFINISHED])))
      .get();
  }

  /** For the site page: where the site came from. */
  sourceForSite(siteId: number): SiteDetail['importSource'] {
    const row = this.db.select().from(imports).where(eq(imports.siteId, siteId)).orderBy(desc(imports.id)).get();
    if (!row) return null;
    return {
      importId: row.id,
      url: row.homeUrl,
      status: row.status as ImportStatus,
      connected: row.token !== null,
      importedAt: row.importedAt,
      refreshJobId: row.status === 'done' && row.token ? (this.activeRefresh(row.id)?.id ?? null) : null,
    };
  }

  // ------------------------------------------------------------------ running it

  /**
   * Start the import with the Confirm step's choices: reserve the site - a row like a new site's,
   * `provisioning`, on its dev address - and queue the pull in the target server's import lane.
   * Nothing is created on the server yet; the jobs do that.
   */
  start(id: number, choices: ImportRunBody): { row: ImportRow; job: JobRow } {
    const worker = this.requireWorker();
    const row = this.get(id);
    if (row.status !== 'connected') {
      throw conflict(row.status === 'pending' ? 'The old site has not connected yet.' : `The import is ${row.status}.`);
    }
    if (!row.token) throw conflict('This import was disconnected.');
    const report = this.reportOf(row);
    if (!report) throw conflict('The old site has not reported itself yet.');
    const inspection = inspectReport(report, { offeredPhp: this.offeredPhp(), allowHttp: row.allowHttp === 1 });
    const blocked = blockingReason(inspection.warnings);
    if (blocked) throw conflict(blocked);
    const problem = checkChoices(report, choices, inspection.constants);
    if (problem) throw badRequest(problem);
    if (!isValidSlug(choices.slug)) throw badRequest(`"${choices.slug}" cannot be a site name`);
    const server = resolveTargetServer({ settings: this.settings, servers: this.servers }, choices.serverId);
    const phpVersion = choices.phpVersion ?? inspection.suggestions.phpVersion ?? this.settings.get('defaultPhpVersion');
    if (!this.offeredPhp().includes(phpVersion)) {
      throw badRequest(`PHP ${phpVersion} is not offered (available: ${this.offeredPhp().join(', ')})`);
    }
    const devHostname = `${choices.slug}.${server.devDomain || this.config.devDomain}`;
    assertDomainsFree({ db: this.db, config: this.config, servers: this.servers }, [devHostname], { allowDevHostname: devHostname });
    const skip = [
      'wp-config.php',
      ...choices.removeDropins.map((d) => `wp-content/${d}`),
      ...choices.removeMuPlugins.map((m) => `wp-content/mu-plugins/${m}`),
    ];
    const stored: ImportRunBody = { ...choices, serverId: server.id, phpVersion };
    const now = Date.now();
    try {
      return this.db.transaction(() => {
        const site = this.db
          .insert(sites)
          .values({
            slug: choices.slug,
            serverId: server.id,
            title: choices.title,
            domains: JSON.stringify([devHostname]),
            devHostname,
            isLive: 0,
            keepDevAlias: 1,
            phpVersion,
            // WordPress keeps the old site's language: it is in the database that comes along.
            locale: report.locale || 'en_US',
            status: 'provisioning',
            dbName: dbIdentifier(choices.slug),
            dbUser: dbIdentifier(choices.slug),
            dbPassword: generateSecret(24),
            mailPassword: generateSecret(24),
            // The old site's users came with it; the panel acts as its oldest administrator.
            wpAdminUser: null,
            wpAdminEmail: report.admin_email || null,
            containerName: containerName(choices.slug),
            tablePrefix: report.table_prefix,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const job = worker.enqueue('site.import', { importId: row.id, sourceHost: hostOf(row.homeUrl) }, undefined, {
          lane: importLane(server.id),
          siteSlug: site.slug,
        });
        const updated = this.db
          .update(imports)
          .set({
            status: 'queued',
            siteId: site.id,
            serverId: server.id,
            jobId: job.id,
            choices: JSON.stringify(stored),
            cursor: JSON.stringify(initialCursor(skip)),
            stagingPath: path.join(this.config.srvRoot, 'wpl7-import', String(row.id)),
            lastError: null,
            startedAt: now,
            expiresAt: null,
            updatedAt: now,
          })
          .where(eq(imports.id, row.id))
          .returning()
          .get();
        return { row: updated, job };
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: sites\.slug/.test(err.message)) {
        throw conflict(`Site name "${choices.slug}" is already taken`);
      }
      throw err;
    }
  }

  /** Go on with a failed import: the pull from where it stopped, or the set-up when the pull was done. */
  retry(id: number): { row: ImportRow; job: JobRow } {
    const worker = this.requireWorker();
    const row = this.get(id);
    if (row.status !== 'failed') throw conflict(`The import is ${row.status}; only a stopped one can go on.`);
    if (!row.token) throw conflict('This import was disconnected.');
    const site = row.siteId ? this.db.select().from(sites).where(eq(sites.id, row.siteId)).get() : undefined;
    if (!site || row.serverId === null) throw conflict('The site this import was making is gone. Delete the import and start again.');
    const cursor = this.cursorOf(row);
    const sourceHost = hostOf(row.homeUrl);
    return this.db.transaction(() => {
      const job =
        cursor?.phase === 'done'
          ? worker.enqueue('site.importFinish', { importId: row.id, sourceHost }, { id: site.id, slug: site.slug, serverId: site.serverId })
          : worker.enqueue('site.import', { importId: row.id, sourceHost }, undefined, {
              lane: importLane(row.serverId!),
              siteSlug: site.slug,
            });
      const updated = this.db
        .update(imports)
        .set({ status: cursor?.phase === 'done' ? 'pulled' : 'queued', jobId: job.id, lastError: null, updatedAt: Date.now() })
        .where(eq(imports.id, row.id))
        .returning()
        .get();
      return { row: updated, job };
    });
  }

  /**
   * Pull a finished import's database and changed files again (jobs/handlers/importRefresh.ts),
   * for a site whose old copy kept changing after the import.
   */
  refresh(id: number): JobRow {
    const worker = this.requireWorker();
    const row = this.get(id);
    if (row.status !== 'done') throw conflict('Only a finished import can be refreshed.');
    if (!row.token) throw conflict('The plugin on the old site was disconnected. Import the site again instead.');
    const site = row.siteId ? this.db.select().from(sites).where(eq(sites.id, row.siteId)).get() : undefined;
    if (!site) throw conflict('The site this import made is gone.');
    if (site.status !== 'running' && site.status !== 'stopped') throw conflict(`The site is ${site.status}; refresh it once that is over.`);
    if (this.activeRefresh(row.id)) throw conflict('A refresh from the old site is running already.');
    return worker.enqueue(
      'site.importRefresh',
      { importId: row.id, sourceHost: hostOf(row.homeUrl) },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
  }

  /** The pull's client for this import, carrying on with what an earlier run learned about the old host. */
  clientFor(
    row: ImportRow,
    opts: { state?: Partial<PullState>; canceled?: () => boolean; log?: (line: string) => void; attempts?: number } = {},
  ): ImportPullClient {
    if (!row.token || !row.homeUrl || !row.endpointUrl) throw new Error('This import is not connected to an old site');
    return new ImportPullClient({
      importId: row.id,
      token: row.token,
      home: row.homeUrl,
      endpoint: row.endpointUrl,
      allowHttp: row.allowHttp === 1,
      transport: this.transport,
      lookup: this.lookup,
      sleep: this.retrySleep,
      state: opts.state,
      canceled: opts.canceled,
      log: opts.log,
      attempts: opts.attempts,
    });
  }

  cursorOf(row: ImportRow): ImportCursor | null {
    return parseJson<ImportCursor>(row.cursor);
  }

  /** Change an import's record; `updatedAt` follows. */
  mark(id: number, patch: Partial<typeof imports.$inferInsert>): ImportRow {
    return this.db
      .update(imports)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(imports.id, id))
      .returning()
      .get();
  }

  writeCursor(id: number, cursor: ImportCursor): void {
    this.mark(id, { cursor: JSON.stringify(cursor) });
  }

  /**
   * After a restart: an import whose job died with the old process is marked failed, cursor
   * intact, so Continue goes on from there. A job that is still queued survives restarts, and
   * its import is left alone.
   */
  reconcileOnBoot(): number {
    const rows = this.db.select().from(imports).where(inArray(imports.status, ['queued', 'pulling', 'pulled', 'finishing'])).all();
    let failed = 0;
    for (const row of rows) {
      const job = row.jobId ? this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, row.jobId)).get() : undefined;
      if (job && (job.status === 'queued' || job.status === 'running')) continue;
      this.mark(row.id, { status: 'failed', lastError: 'Interrupted by panel restart' });
      this.log.warn(`Import #${row.id} was interrupted by the restart; Continue on Sites → Import site resumes it`);
      failed++;
    }
    return failed;
  }

  /**
   * The nightly clear-up: imports that waited too long expire; a failed one nobody continued for
   * a week loses its staging folder and the site row it reserved, and expires; an expired record
   * goes a month later.
   */
  async prune(now = Date.now()): Promise<number> {
    let cleared = 0;
    const waiting = this.db
      .select()
      .from(imports)
      .where(and(inArray(imports.status, ['pending', 'connected']), lt(imports.expiresAt, now)))
      .all();
    for (const row of waiting) {
      this.expireIfDue(row);
      cleared++;
    }
    const stale = this.db
      .select()
      .from(imports)
      .where(and(eq(imports.status, 'failed'), lt(imports.updatedAt, now - IMPORT_TTL_MS.failed)))
      .all();
    for (const row of stale) {
      try {
        await this.clearStaging(row);
      } catch (err) {
        this.log.warn(`Import #${row.id}: could not remove its staging folder (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      this.db.transaction(() => {
        this.mark(row.id, { status: 'expired', token: null });
        this.releaseSiteRow(row);
      });
      cleared++;
    }
    const old = this.db
      .delete(imports)
      .where(and(eq(imports.status, 'expired'), lt(imports.updatedAt, now - IMPORT_TTL_MS.expired)))
      .returning({ id: imports.id })
      .all();
    // A file listing is kept only while the import can still use it: to go on, or to refresh.
    for (const id of this.listings.ids()) {
      const row = this.db.select().from(imports).where(eq(imports.id, id)).get();
      const inUse = row?.token && (IMPORT_UNFINISHED.includes(row.status as ImportStatus) || (row.status === 'done' && row.siteId));
      if (!inUse) this.listings.drop(id);
    }
    return cleared + old.length;
  }

  // ------------------------------------------------------------------ the plugin

  /**
   * What the plugin's own form asks for when it came without its connection file: the panel's
   * address and the token. Refused when a plugin zip would be.
   */
  connectionCode(id: number): ImportConnectionCodeDto {
    const row = this.get(id);
    if (!row.token || row.status === 'done' || row.status === 'expired') {
      throw conflict(row.status === 'done' ? 'This import is done.' : 'This import has ended. Start a new one.');
    }
    const origin = this.origin();
    if (!origin) throw conflict('Set PANEL_DOMAIN first: the old site connects to the panel at that address');
    return { panel: origin, code: row.token };
  }

  /**
   * The migration plugin for this import: the folder the panel ships, its version set to the
   * panel's, and `connection.php` - where to connect and with what - added. Refused once the
   * import can no longer use one.
   */
  pluginZip(id: number): { name: string; data: Buffer } {
    const row = this.get(id);
    if (!row.token || row.status === 'done' || row.status === 'expired') {
      throw conflict(
        row.status === 'done' ? 'This import is done.' : 'This import has ended. Start a new one to get a plugin.',
      );
    }
    const origin = this.origin();
    if (!origin) throw conflict('Set PANEL_DOMAIN first: the old site connects to the panel at that address');
    const root = path.join(this.config.migratePluginDir, 'wpl7-migrate');
    if (!fs.existsSync(path.join(root, 'wpl7-migrate.php'))) {
      throw conflict(`The migration plugin is not in this build of the panel (${root})`);
    }
    const entries: ZipEntry[] = [{ name: 'wpl7-migrate/' }];
    const walk = (dir: string, rel: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = `${rel}${item.name}`;
        // Never a stray one from testing: this import's own is added below.
        if (relPath === 'connection.php') continue;
        if (item.isDirectory()) {
          entries.push({ name: `wpl7-migrate/${relPath}/` });
          walk(path.join(dir, item.name), `${relPath}/`);
        } else if (item.isFile()) {
          let data = fs.readFileSync(path.join(dir, item.name));
          if (/\.(php|txt)$/.test(item.name)) {
            data = Buffer.from(data.toString('utf8').replaceAll('0.0.0-dev', PANEL_VERSION), 'utf8');
          }
          entries.push({ name: `wpl7-migrate/${relPath}`, data });
        }
      }
    };
    walk(root, '');
    entries.push({
      name: 'wpl7-migrate/connection.php',
      data:
        '<?php\n' +
        '// WPL7 Migrate: the panel this download came from. Read once at activation, then deleted.\n' +
        "defined('ABSPATH') || exit;\n" +
        `return array('panel' => ${phpString(origin)}, 'import' => ${row.id}, 'token' => ${phpString(row.token)}, ` +
        `'issued' => ${Math.floor(Date.now() / 1000)});\n`,
      mode: 0o644,
    });
    return { name: `wpl7-migrate-${row.id}.zip`, data: zipOf(entries) };
  }

  /** The import a plugin's call names with its token; null for one that is unknown or disconnected. */
  byToken(token: string): ImportRow | null {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
    const row = this.db.select().from(imports).where(eq(imports.tokenHash, sha256Hex(token))).get();
    if (!row?.token || !sameSecret(row.token, token)) return null;
    return this.expireIfDue(row);
  }

  /**
   * The old site's plugin reporting in. Idempotent for the same site while the import waits; the
   * first site to connect binds the import, and another one is refused.
   */
  async connect(row: ImportRow, body: unknown): Promise<ImportRow> {
    if (row.status === 'expired') throw new PluginRefusal(410, 'gone', 'This import has expired. Start a new one in the panel.');
    const protocol = (body as { protocol?: unknown } | null)?.protocol;
    if (typeof protocol !== 'number' || protocol < MIGRATE_PROTOCOL.min || protocol > MIGRATE_PROTOCOL.max) {
      throw new PluginRefusal(426, 'protocol_unsupported', 'This plugin speaks a protocol the panel does not. Download the plugin again.', {
        ...MIGRATE_PROTOCOL,
      });
    }
    const parsed = migrateReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new PluginRefusal(422, 'invalid_report', 'The plugin sent a report the panel cannot read.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const report = parsed.data;
    if (row.status !== 'pending' && row.status !== 'connected') {
      throw new PluginRefusal(409, 'conflict', row.status === 'done' ? 'This import is done.' : 'The import is already running.');
    }
    if (row.homeUrl && row.homeUrl !== report.home) {
      throw new PluginRefusal(409, 'conflict', `This import belongs to another site (${row.homeUrl}).`);
    }
    let home: URL;
    let endpoint: URL;
    try {
      home = new URL(report.home);
      endpoint = new URL(report.endpoint);
    } catch {
      throw new PluginRefusal(422, 'invalid_report', 'The plugin reported an address that is not a URL.');
    }
    if (endpoint.hostname.toLowerCase() !== home.hostname.toLowerCase()) {
      throw new PluginRefusal(422, 'invalid_report', "The plugin's address is not on the site's own host.");
    }
    try {
      await assertAllowedSource(report.home, { allowHttp: row.allowHttp === 1, lookup: this.lookup });
    } catch (err) {
      if (!(err instanceof OutboundRefusedError)) throw err;
      throw new PluginRefusal(
        422,
        'unreachable',
        home.protocol === 'http:' && row.allowHttp !== 1
          ? 'The site has no HTTPS. In the panel, start a new import with "The old site has no HTTPS" switched on.'
          : `The panel will not connect to this site: ${err.message}.`,
      );
    }

    const inspection = inspectReport(report, { offeredPhp: this.offeredPhp(), allowHttp: row.allowHttp === 1 });
    const now = Date.now();
    const updated = this.mark(row.id, {
      status: 'connected',
      homeUrl: report.home,
      endpointUrl: report.endpoint,
      pluginVersion: report.plugin,
      protocol: report.protocol,
      wpVersion: report.wp,
      phpVersion: report.php,
      tablePrefix: report.table_prefix,
      multisite: report.multisite ? 1 : 0,
      blogPublic: report.blog_public,
      filesBytes: report.files.bytes,
      dbBytes: report.db.bytes,
      fileCount: report.files.count,
      tableCount: report.db.tables.length,
      report: JSON.stringify(report),
      warnings: JSON.stringify(inspection.warnings),
      connectedAt: row.connectedAt ?? now,
      expiresAt: now + IMPORT_TTL_MS.connected,
    });
    if (!row.connectedAt) this.log.info(`Import #${row.id}: ${report.home} connected`);
    return updated;
  }

  /** What the plugin's admin page shows. */
  statusForPlugin(row: ImportRow): MigrateStatusDto {
    const progress = this.progressOf(row);
    return {
      status: row.status as ImportStatus,
      phase: progress?.phase ?? null,
      filesDone: progress?.filesDone ?? 0,
      filesTotal: progress?.filesTotal ?? 0,
      bytesDone: progress?.bytesDone ?? 0,
      bytesTotal: progress?.bytesTotal ?? 0,
      tablesDone: progress?.tablesDone ?? 0,
      tablesTotal: progress?.tablesTotal ?? 0,
      ...(row.status === 'done' && row.siteId ? { siteUrl: this.siteUrlOf(row.siteId) } : {}),
      ...(row.status === 'failed' && row.lastError ? { message: row.lastError } : {}),
    };
  }

  // ------------------------------------------------------------------ DTOs

  toSummary(row: ImportRow): ImportSummaryDto {
    const site = row.siteId ? this.db.select({ slug: sites.slug }).from(sites).where(eq(sites.id, row.siteId)).get() : null;
    return {
      id: row.id,
      status: row.status as ImportStatus,
      source: row.homeUrl ?? row.sourceUrl,
      siteSlug: site?.slug ?? parseJson<ImportRunBody>(row.choices)?.slug ?? null,
      siteUrl: row.siteId ? (this.siteUrlOf(row.siteId) ?? null) : null,
      serverName: row.serverId ? (this.servers.rowById(row.serverId)?.name ?? null) : null,
      jobId: row.jobId,
      lastError: row.lastError,
      progress: this.progressOf(row),
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      importedAt: row.importedAt,
      expiresAt: row.expiresAt,
    };
  }

  toDto(row: ImportRow): ImportDto {
    const report = this.reportOf(row);
    const inspection = report ? inspectReport(report, { offeredPhp: this.offeredPhp(), allowHttp: row.allowHttp === 1 }) : null;
    return {
      ...this.toSummary(row),
      allowHttp: row.allowHttp === 1,
      connected: row.token !== null,
      canDownload: row.token !== null && row.status !== 'done' && row.status !== 'expired',
      connectedAt: row.connectedAt,
      report: report ? sourceOf(report) : null,
      warnings: inspection?.warnings ?? [],
      blockedReason: inspection ? blockingReason(inspection.warnings) : null,
      suggestions: inspection?.suggestions ?? null,
      constants: inspection?.constants ?? [],
      choices: parseJson<ImportRunBody>(row.choices),
    };
  }

  /** The report the plugin sent, as stored. */
  reportOf(row: ImportRow): MigrateReport | null {
    const raw = parseJson<unknown>(row.report);
    if (!raw) return null;
    const parsed = migrateReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private progressOf(row: ImportRow): ImportProgressDto | null {
    const cursor = this.cursorOf(row);
    if (!cursor) return null;
    return {
      phase: cursor.phase,
      filesDone: cursor.filesDone ?? 0,
      filesTotal: cursor.filesTotal ?? 0,
      bytesDone: cursor.bytesDone ?? 0,
      bytesTotal: cursor.bytesTotal ?? 0,
      tablesDone: cursor.tablesDone ?? 0,
      tablesTotal: cursor.tablesTotal ?? 0,
    };
  }

  private offeredPhp(): string[] {
    return this.settings.get('phpVersions') ?? [];
  }

  private requireWorker(): JobWorker {
    if (!this.worker) throw new Error('The import service has no job queue');
    return this.worker;
  }

  private siteUrlOf(siteId: number): string | undefined {
    const site: Pick<SiteRow, 'domains'> | undefined = this.db
      .select({ domains: sites.domains })
      .from(sites)
      .where(eq(sites.id, siteId))
      .get();
    const primary = site ? (JSON.parse(site.domains) as string[])[0] : undefined;
    return primary ? `${this.config.tlsMode === 'none' ? 'http' : 'https'}://${primary}` : undefined;
  }

  /** Best effort: the plugin cleans up and deactivates itself. One that cannot be reached is no reason to stop. */
  private async tellPluginToFinish(row: ImportRow): Promise<void> {
    if (!row.homeUrl || !row.endpointUrl) return;
    const client = this.clientFor(row);
    try {
      await client.finish();
    } catch (err) {
      this.log.warn(`Import #${row.id}: could not tell the old site's plugin to finish (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      client.close();
    }
  }

  /** Remove the import's staging folder, wherever it is. */
  private async clearStaging(row: ImportRow): Promise<void> {
    if (!row.stagingPath || row.serverId === null || !this.servers.rowById(row.serverId)) return;
    const base = path.join(this.config.srvRoot, 'wpl7-import');
    await this.servers.handleFor(row.serverId).files.rm(safeJoin(base, path.basename(row.stagingPath)));
  }

  /**
   * The site row an import reserved, released when nothing of the site was ever built from it:
   * still `provisioning` or `error`, and no materialised files (the finish job's rollback puts
   * them back in staging).
   */
  private releaseSiteRow(row: ImportRow): void {
    if (!row.siteId) return;
    const site = this.db.select().from(sites).where(eq(sites.id, row.siteId)).get();
    if (!site || (site.status !== 'provisioning' && site.status !== 'error')) return;
    if (this.cursorOf(row)?.materialized) return;
    this.db.delete(sites).where(eq(sites.id, site.id)).run();
  }

  /** An import waiting past its time expires, and its token goes with it. */
  private expireIfDue(row: ImportRow): ImportRow {
    if ((row.status !== 'pending' && row.status !== 'connected') || !row.expiresAt || row.expiresAt > Date.now()) return row;
    return this.mark(row.id, { status: 'expired', token: null });
  }
}

/** The import a `site.importRefresh` payload names; null for one that cannot be read. */
function refreshedImport(payload: string): number | null {
  try {
    const id = (JSON.parse(payload) as { importId?: unknown }).importId;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** The old site as the UI shows it: what the report says, without the constants' values. */
function sourceOf(r: MigrateReport): ImportSourceDto {
  return {
    home: r.home,
    siteurl: r.siteurl,
    title: r.title,
    wpVersion: r.wp,
    phpVersion: r.php,
    tablePrefix: r.table_prefix,
    locale: r.locale,
    searchEnginesAllowed: r.blog_public === 1,
    https: r.home.startsWith('https://'),
    abspath: r.abspath,
    files: { count: r.files.count, bytes: r.files.bytes, partial: r.files.partial },
    db: { server: r.db.server, bytes: r.db.bytes, tables: r.db.tables.length },
    plugins: r.plugins.map((p) => ({ slug: p.slug, name: p.name, version: p.version, active: p.active })),
    theme: r.theme ? { slug: r.theme.slug, name: r.theme.name, version: r.theme.version } : null,
    dropins: r.dropins,
    muPlugins: r.mu_plugins.map((m) => ({ file: m.file, name: m.name })),
    pluginVersion: r.plugin,
  };
}
