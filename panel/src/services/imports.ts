import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { imports, sites, type ImportRow, type SiteRow } from '../db/schema.js';
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
import { conflict, notFound } from '../lib/errors.js';
import { sameSecret, sha256Hex } from '../lib/crypto.js';
import { panelUrl } from '../lib/panelUrl.js';
import { PANEL_VERSION } from '../lib/version.js';
import { zipOf, type ZipEntry } from '../lib/zipWriter.js';
import { OutboundRefusedError, assertAllowedSource, type LookupFn } from '../lib/outboundGuard.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import {
  MIGRATE_PROTOCOL,
  blockingReason,
  inspectReport,
  migrateReportSchema,
  type MigrateReport,
} from './importInspect.js';

/**
 * Imports of existing WordPress sites (docs/internal/import-protocol.md): the record of each one,
 * the personalised migration plugin it hands out, and the two calls that plugin makes back - its
 * report when it connects, and the progress its admin page shows.
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
} as const;

/** The states in which a job owns the import: it can be neither deleted nor disconnected. */
export const IMPORT_BUSY: readonly ImportStatus[] = ['queued', 'pulling', 'pulled', 'finishing'];

/** The states a pull can still go on from, for a site whose import has not finished. */
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

/** The pull's bookkeeping, as the pull job keeps it (`imports.cursor`); C2 fills in the rest. */
export interface ImportCursor {
  phase: ImportProgressDto['phase'];
  filesDone?: number;
  filesTotal?: number;
  bytesDone?: number;
  bytesTotal?: number;
  tablesDone?: number;
  tablesTotal?: number;
  [key: string]: unknown;
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

export class ImportService {
  /** How the old site's address is resolved before the panel calls it; tests swap it. */
  lookup: LookupFn | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
  ) {}

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
   * Remove an import's record. Refused while a job works on it; the job has to be stopped first.
   * The site an import made is not touched: it is a site like any other by then.
   */
  delete(id: number): void {
    const row = this.get(id);
    if (IMPORT_BUSY.includes(row.status as ImportStatus)) {
      throw conflict('The import is running. Stop its job first.');
    }
    this.db.delete(imports).where(eq(imports.id, row.id)).run();
  }

  /**
   * Stop the old site's plugin answering this import: the token goes, so the panel can no longer
   * sign a request with it and the plugin's calls are refused. An import that had not started
   * cannot go on without it, and expires.
   */
  disconnect(id: number): ImportRow {
    const row = this.get(id);
    if (IMPORT_BUSY.includes(row.status as ImportStatus)) {
      throw conflict('The import is running. Stop its job first.');
    }
    const now = Date.now();
    const waiting = row.status === 'pending' || row.status === 'connected';
    return this.db
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
    };
  }

  /** Start the pull. Not in this version: the Confirm step shows why. */
  run(id: number, _choices: ImportRunBody): never {
    this.get(id);
    throw conflict('Available in the next version');
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
    const updated = this.db
      .update(imports)
      .set({
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
        updatedAt: now,
      })
      .where(eq(imports.id, row.id))
      .returning()
      .get();
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
    const cursor = parseJson<ImportCursor>(row.cursor);
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

  private siteUrlOf(siteId: number): string | undefined {
    const site: Pick<SiteRow, 'domains'> | undefined = this.db
      .select({ domains: sites.domains })
      .from(sites)
      .where(eq(sites.id, siteId))
      .get();
    const primary = site ? (JSON.parse(site.domains) as string[])[0] : undefined;
    return primary ? `${this.config.tlsMode === 'none' ? 'http' : 'https'}://${primary}` : undefined;
  }

  /** An import waiting past its time expires, and its token goes with it. */
  private expireIfDue(row: ImportRow): ImportRow {
    if ((row.status !== 'pending' && row.status !== 'connected') || !row.expiresAt || row.expiresAt > Date.now()) return row;
    return this.db
      .update(imports)
      .set({ status: 'expired', token: null, updatedAt: Date.now() })
      .where(eq(imports.id, row.id))
      .returning()
      .get();
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
