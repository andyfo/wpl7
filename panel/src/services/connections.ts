// @docs security/privacy, sites/external
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { siteConnections, sites, type JobRow, type SiteConnectionRow, type SiteRow } from '../db/schema.js';
import type { ConnectionAddBody, ConnectionCreateBody, ConnectionStatus, SiteConnectionPatchBody } from '../../shared/schemas.js';
import type {
  ConnectionCodeDto,
  ConnectionDto,
  ConnectionSummaryDto,
  ConnectWarning,
  ExternalSiteDto,
  ExternalSiteSummary,
} from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { sameSecret, sha256Hex } from '../lib/crypto.js';
import { panelUrl } from '../lib/panelUrl.js';
import { PANEL_VERSION } from '../lib/version.js';
import { compareVersions } from '../lib/wpVersions.js';
import { isValidSlug } from '../lib/slug.js';
import { externalSites, isExternal } from '../lib/siteKind.js';
import { pluginFolderZip } from '../lib/zipWriter.js';
import { OutboundRefusedError, assertAllowedSource, type LookupFn } from '../lib/outboundGuard.js';
import { probeExternal, type ExternalProbe } from '../lib/httpProbe.js';
import type { JobWorker } from '../jobs/worker.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import { assertDomainsFree } from './domainGuard.js';
import { resolveTargetServer } from './sites.js';
import { PluginRefusal, phpString } from './imports.js';
import { PluginSourceError, type PullTransport } from './pluginClient.js';
import { CONNECT_PROTOCOL, ConnectClient, connectKeyPair, type ConnectPing } from './connectClient.js';
import {
  blockingReason,
  connectReportSchema,
  connectSourceOf,
  connectWarnings,
  hostOf,
  phpMinor,
  suggestSlug,
  type ConnectReport,
} from './connectInspect.js';

/**
 * Sites hosted elsewhere, connected through the WPL7 Connect plugin
 * (docs/internal/connect-protocol.md): each connection's record and keys, the personalised
 * plugin it hands out, the plugin's one call back (enroll), adding the site, and the hourly
 * check that the plugin still answers.
 *
 * Each connection has its own Ed25519 key pair. The plugin holds only the public half; the
 * private half signs every request the panel makes and never leaves this service, a DTO or a
 * log line. The enrollment token is the plugin's way in, once: it is dropped when the site is
 * added.
 */

/** How long a connection waits for its plugin, and for Add site after that. */
export const CONNECTION_TTL_MS = 24 * 3600_000;
/** An expired connection's record goes this long after it expired. */
const EXPIRED_KEEP_MS = 24 * 3600_000;
/** Add site needs the panel to have reached the plugin this recently. */
const CHECK_FRESH_MS = 10 * 60_000;
/** The package link a ping offers lives this long; a ping every hour renews it. */
const PACKAGE_LINK_MS = 2 * 3600_000;
/** A catalog link for one install lives this long. */
const CATALOG_LINK_MS = 10 * 60_000;
/** Hourly checks at a time. */
const HEARTBEAT_CONCURRENCY = 4;
/** The header the plugin carries its enrollment token in. */
export const CONNECT_TOKEN_HEADER = 'x-wpl7-connect-token';

const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the hourly check found, for the schedule's run record. */
export interface HeartbeatResult {
  checked: number;
  reachable: number;
  failed: number;
}

/** What the alerts need to hear from the hourly check (services/alerts.ts). */
export interface ConnectionEvents {
  checked(site: SiteRow, conn: SiteConnectionRow): Promise<void>;
}

export class ConnectionsService {
  /** How the site's address is resolved before the panel calls it; tests swap it. */
  lookup: LookupFn | undefined;
  /** How the panel's requests reach the site; tests swap it for a fake site. */
  transport: PullTransport | undefined;
  /** How a client waits between retries; tests make it instant. */
  retrySleep: ((ms: number) => Promise<void>) | undefined;
  /** How the panel asks a site's home page whether it is up (the monitor, an update's health check); tests swap it. */
  probe: ExternalProbe = (url) => probeExternal(url, { lookup: this.lookup });
  private worker: JobWorker | null = null;
  private events: ConnectionEvents | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
  ) {}

  attachWorker(worker: JobWorker): void {
    this.worker = worker;
  }

  attachEvents(events: ConnectionEvents): void {
    this.events = events;
  }

  /** Where the site reaches the panel, as for an import (ImportService.origin). */
  origin(): string | null {
    const url = panelUrl(this.config);
    if (url) return url;
    return this.config.nodeEnv === 'production' ? null : `http://localhost:${this.config.port}`;
  }

  // ------------------------------------------------------------------ records

  create(body: ConnectionCreateBody, createdBy: string | null, forSite?: SiteRow): SiteConnectionRow {
    if (!this.origin()) throw conflict('Set PANEL_DOMAIN first: the site connects to the panel at that address');
    const token = crypto.randomBytes(32).toString('base64url');
    const keys = connectKeyPair();
    const now = Date.now();
    return this.db
      .insert(siteConnections)
      .values({
        forSiteId: forSite?.id ?? null,
        status: 'pending',
        token,
        tokenHash: sha256Hex(token),
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        allowHttp: body.allowHttp ? 1 : 0,
        sourceUrl: body.sourceUrl ?? null,
        createdBy,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + CONNECTION_TTL_MS,
      })
      .returning()
      .get();
  }

  /** A connection, with an expiry that is due applied first. 404 when there is none. */
  get(id: number): SiteConnectionRow {
    const row = this.db.select().from(siteConnections).where(eq(siteConnections.id, id)).get();
    if (!row) throw notFound(`Connection #${id} not found`);
    return this.expireIfDue(row);
  }

  /** The connections that are not a site yet, newest first. */
  list(): ConnectionSummaryDto[] {
    return this.db
      .select()
      .from(siteConnections)
      .where(isNull(siteConnections.siteId))
      .orderBy(desc(siteConnections.id))
      .limit(200)
      .all()
      .map((row) => this.toSummary(this.expireIfDue(row)));
  }

  /** Remove a connection that is not a site's: a pending or expired one. */
  delete(id: number): void {
    const row = this.get(id);
    if (row.siteId !== null) throw conflict('This connection belongs to a site. Remove the site instead.');
    this.db.delete(siteConnections).where(eq(siteConnections.id, row.id)).run();
  }

  /** The connection a site works through. */
  forSite(site: SiteRow): SiteConnectionRow {
    if (!isExternal(site)) throw conflict(`"${site.slug}" is hosted here: it has no connection.`);
    const row = this.db.select().from(siteConnections).where(eq(siteConnections.siteId, site.id)).get();
    if (!row) throw conflict(`"${site.slug}" has no connection. Reconnect it from its Settings tab.`);
    return row;
  }

  findForSite(siteId: number): SiteConnectionRow | undefined {
    return this.db.select().from(siteConnections).where(eq(siteConnections.siteId, siteId)).get();
  }

  /** Change a connection's record; `updatedAt` follows. */
  mark(id: number, patch: Partial<typeof siteConnections.$inferInsert>): SiteConnectionRow {
    return this.db
      .update(siteConnections)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(siteConnections.id, id))
      .returning()
      .get();
  }

  // ------------------------------------------------------------------ the plugin

  private pluginRoot(): string {
    const root = path.join(this.config.connectPluginDir, 'wpl7-connect');
    if (!fs.existsSync(path.join(root, 'wpl7-connect.php'))) {
      throw conflict(`WPL7 Connect is not in this build of the panel (${root})`);
    }
    return root;
  }

  private assertDownloadable(row: SiteConnectionRow): void {
    if (!row.token || (row.status !== 'pending' && row.status !== 'enrolled')) {
      throw conflict(row.siteId !== null ? 'This site was added already.' : 'This connection has ended. Start a new one.');
    }
  }

  /**
   * WPL7 Connect for this connection: the folder the panel ships, its version set to the
   * panel's, and `connection.php` - where to enroll, with what, and the panel's public key -
   * added (section 1).
   */
  pluginZip(id: number): { name: string; data: Buffer } {
    const row = this.get(id);
    this.assertDownloadable(row);
    const origin = this.origin();
    if (!origin) throw conflict('Set PANEL_DOMAIN first: the site connects to the panel at that address');
    const data = pluginFolderZip(this.pluginRoot(), 'wpl7-connect', PANEL_VERSION, [
      {
        name: 'connection.php',
        data:
          '<?php\n' +
          '// WPL7 Connect: the panel this download came from. Read once at activation, then deleted.\n' +
          "defined('ABSPATH') || exit;\n" +
          `return array('panel' => ${phpString(origin)}, 'connection' => ${row.id}, 'token' => ${phpString(row.token!)}, ` +
          `'key' => ${phpString(row.publicKey)}, 'issued' => ${Math.floor(Date.now() / 1000)});\n`,
        mode: 0o644,
      },
    ]);
    return { name: `wpl7-connect-${row.id}.zip`, data };
  }

  /** The plugin without a connection: what a site's self-update downloads (section 12). */
  pluginPackage(): { name: string; data: Buffer } {
    return { name: 'wpl7-connect.zip', data: pluginFolderZip(this.pluginRoot(), 'wpl7-connect', PANEL_VERSION) };
  }

  /** What the plugin's own form takes when it came without its connection file. */
  connectionCode(id: number): ConnectionCodeDto {
    const row = this.get(id);
    this.assertDownloadable(row);
    const origin = this.origin();
    if (!origin) throw conflict('Set PANEL_DOMAIN first: the site connects to the panel at that address');
    return { panel: origin, code: `${row.token}.${row.publicKey}` };
  }

  /** The connection a plugin's enroll names with its token; null for one that is unknown or ended. */
  byToken(token: string): SiteConnectionRow | null {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
    const row = this.db.select().from(siteConnections).where(eq(siteConnections.tokenHash, sha256Hex(token))).get();
    if (!row?.token || !sameSecret(row.token, token)) return null;
    return this.expireIfDue(row);
  }

  /**
   * The plugin reporting its site (section 4). Idempotent for the same site until it is added;
   * the first site to enroll binds the connection, and another is refused. A reconnect's enroll
   * replaces the keys its site's requests are signed with.
   */
  async enroll(row: SiteConnectionRow, body: unknown): Promise<SiteConnectionRow> {
    if (row.status === 'expired' || row.status === 'disconnected') {
      throw new PluginRefusal(410, 'gone', 'This connection has ended. Start again in the panel: Sites, Connect a site.');
    }
    const protocol = (body as { protocol?: unknown } | null)?.protocol;
    if (typeof protocol !== 'number' || protocol < CONNECT_PROTOCOL.min || protocol > CONNECT_PROTOCOL.max) {
      throw new PluginRefusal(426, 'protocol_unsupported', 'This plugin speaks a protocol the panel does not. Download the plugin again.', {
        ...CONNECT_PROTOCOL,
      });
    }
    const parsed = connectReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new PluginRefusal(422, 'invalid_report', 'The plugin sent a report the panel cannot read.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const report = parsed.data;
    if (row.status === 'active' || row.siteId !== null) throw new PluginRefusal(409, 'conflict', 'This site was added already.');
    if (row.homeUrl && row.homeUrl !== report.home) {
      throw new PluginRefusal(409, 'conflict', `This connection belongs to another site (${row.homeUrl}).`);
    }
    const target = row.forSiteId !== null ? this.db.select().from(sites).where(eq(sites.id, row.forSiteId)).get() : undefined;
    const current = target ? this.findForSite(target.id) : undefined;
    if (row.forSiteId !== null) {
      if (!target) throw new PluginRefusal(410, 'gone', 'The site this reconnect was for is gone from the panel.');
      const bound = current?.homeUrl ?? null;
      if (bound && bound !== report.home) {
        throw new PluginRefusal(409, 'conflict', `This download reconnects ${bound}, not ${report.home}.`);
      }
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
          ? 'The site has no HTTPS. In the panel, start again with "The site has no HTTPS" switched on.'
          : `The panel will not connect to this site: ${err.message}.`,
      );
    }
    const now = Date.now();
    const facts = {
      homeUrl: report.home,
      endpointUrl: report.endpoint,
      pluginVersion: report.plugin,
      protocol: report.protocol,
      report: JSON.stringify(report),
      warnings: JSON.stringify(connectWarnings(report, { allowHttp: row.allowHttp === 1 })),
      commands: JSON.stringify(report.commands),
      enrolledAt: row.enrolledAt ?? now,
    };
    if (target) {
      // A reconnect: this row takes the old one's place, with its choices, in one step.
      const admins = report.admins;
      const keep = current?.actAsUserId ? admins.find((a) => a.id === current.actAsUserId) : undefined;
      const actAs = keep ?? admins[0] ?? null;
      const updated = this.db.transaction(() => {
        if (current) this.db.delete(siteConnections).where(eq(siteConnections.id, current.id)).run();
        const replaced = this.mark(row.id, {
          ...facts,
          siteId: target.id,
          forSiteId: null,
          status: 'active',
          token: null,
          actAsUserId: actAs?.id ?? null,
          actAsLogin: actAs?.login ?? null,
          budgetMs: current?.budgetMs ?? null,
          lastBackupAt: current?.lastBackupAt ?? null,
          certExpiresAt: current?.certExpiresAt ?? null,
          lastContactAt: now,
          lastError: null,
          lastErrorAt: null,
          failCount: 0,
          addedAt: now,
          expiresAt: null,
        });
        this.db
          .update(sites)
          .set({ status: 'connected', wpAdminUser: actAs?.login ?? target.wpAdminUser, phpVersion: phpMinor(report.php), updatedAt: now })
          .where(eq(sites.id, target.id))
          .run();
        return replaced;
      });
      this.log.info(`Site "${target.slug}": reconnected (${report.home})`);
      return updated;
    }
    const updated = this.mark(row.id, { ...facts, status: 'enrolled', expiresAt: now + CONNECTION_TTL_MS });
    if (!row.enrolledAt) this.log.info(`Connection #${row.id}: ${report.home} enrolled`);
    return updated;
  }

  /** The report the plugin last sent, as stored. */
  reportOf(row: SiteConnectionRow): ConnectReport | null {
    const raw = parseJson<unknown>(row.report);
    if (!raw) return null;
    const parsed = connectReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Whether the panel reaches the plugin now (the Confirm step's Check again): a `ping`, through
   * whichever transport gets there, which is then remembered.
   */
  async check(id: number): Promise<{ reachable: boolean; transport: 'rest' | 'query' | null; error: string | null }> {
    const row = this.get(id);
    if (row.status !== 'enrolled') throw conflict(row.status === 'pending' ? 'The site has not connected yet.' : `The connection is ${row.status}.`);
    const client = this.clientFor(row, { attempts: 2 });
    try {
      await client.ping();
      this.mark(row.id, { checkedAt: Date.now(), transport: client.state.transport, skewS: client.state.skewS, lastError: null, lastErrorAt: null });
      return { reachable: true, transport: client.state.transport, error: null };
    } catch (err) {
      const error = errMsg(err);
      this.mark(row.id, { checkedAt: Date.now(), lastError: error, lastErrorAt: Date.now() });
      return { reachable: false, transport: null, error };
    } finally {
      client.close();
    }
  }

  /**
   * Add the site with the Confirm step's choices: its row in `sites` (kind external), the
   * connection made its own, and its first inventory and backup queued.
   */
  add(id: number, body: ConnectionAddBody): { site: SiteRow; jobs: JobRow[] } {
    const worker = this.requireWorker();
    const row = this.get(id);
    if (row.siteId !== null || row.status === 'active') throw conflict('This site was added already.');
    if (row.status !== 'enrolled') throw conflict(row.status === 'pending' ? 'The site has not connected yet.' : `The connection is ${row.status}.`);
    if (row.forSiteId !== null) throw conflict('This is a reconnect: it completes when the plugin on the site connects.');
    const report = this.reportOf(row);
    if (!report) throw conflict('The site has not reported itself yet.');
    const warnings = connectWarnings(report, { allowHttp: row.allowHttp === 1 });
    const blocked = blockingReason(warnings);
    if (blocked) throw conflict(blocked);
    if (!row.checkedAt || row.lastError || Date.now() - row.checkedAt > CHECK_FRESH_MS) {
      throw conflict('Check that the panel reaches the site first.');
    }
    const slug = body.slug ?? suggestSlug(report.home, (s) => this.slugTaken(s));
    if (!isValidSlug(slug)) throw badRequest(`"${slug}" cannot be a site name`);
    const server = resolveTargetServer({ settings: this.settings, servers: this.servers }, body.storageServerId);
    const actAs = body.actAs !== undefined ? report.admins.find((a) => a.id === body.actAs) : report.admins[0];
    if (!actAs) {
      throw badRequest(body.actAs !== undefined ? `User #${body.actAs} is not an administrator of the site` : 'The site has no administrator to act as');
    }
    const host = hostOf(report.home).toLowerCase();
    try {
      assertDomainsFree({ db: this.db, config: this.config, servers: this.servers }, [host]);
    } catch {
      throw conflict(`A site in the panel already uses ${host}.`);
    }
    const now = Date.now();
    try {
      return this.db.transaction(() => {
        const site = this.db
          .insert(sites)
          .values({
            slug,
            kind: 'external',
            serverId: server.id,
            title: body.title ?? (report.title.trim() || host),
            domains: JSON.stringify([host]),
            devHostname: null,
            isLive: 1,
            keepDevAlias: 0,
            phpVersion: phpMinor(report.php),
            locale: report.locale || 'en_US',
            status: 'connected',
            dbName: '',
            dbUser: '',
            dbPassword: '',
            mailPassword: null,
            wpAdminUser: actAs.login,
            wpAdminEmail: report.admin_email || null,
            containerName: '',
            tablePrefix: report.table_prefix,
            backupsEnabled: body.backups ? 1 : 0,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        this.mark(row.id, {
          siteId: site.id,
          status: 'active',
          token: null,
          actAsUserId: actAs.id,
          actAsLogin: actAs.login,
          lastContactAt: row.checkedAt,
          addedAt: now,
          expiresAt: null,
        });
        const ref = { id: site.id, slug: site.slug, serverId: site.serverId };
        const jobs = [worker.enqueue('wp.scanAll', { siteIds: [site.id] }, undefined, { siteSlug: site.slug })];
        if (body.backups) jobs.push(worker.enqueue('backup.create', { siteId: site.id, type: 'manual', note: 'First backup' }, ref));
        this.log.info(`Site "${site.slug}": connected (${report.home})`);
        return { site, jobs };
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: sites\.slug/.test(err.message)) {
        throw conflict(`Site name "${slug}" is already taken`);
      }
      throw err;
    }
  }

  private slugTaken(slug: string): boolean {
    return !isValidSlug(slug) || this.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).get() !== undefined;
  }

  /** A new download for a site whose plugin was replaced or disconnected: its keys change when that plugin enrolls. */
  reconnect(site: SiteRow, createdBy: string | null): SiteConnectionRow {
    if (!isExternal(site)) throw conflict(`"${site.slug}" is hosted here: there is nothing to reconnect.`);
    if (site.status === 'deleting') throw conflict(`"${site.slug}" is being removed.`);
    const current = this.findForSite(site.id);
    // One reconnect at a time: an older download for the same site stops working.
    this.db.delete(siteConnections).where(eq(siteConnections.forSiteId, site.id)).run();
    return this.create({ allowHttp: current?.allowHttp === 1, sourceUrl: current?.homeUrl ?? undefined }, createdBy, site);
  }

  /**
   * Let go of the site: the plugin is told to forget the panel (when it answers), and the panel
   * forgets its key either way. The site stays, with its backups, and can reconnect.
   */
  async disconnect(site: SiteRow): Promise<SiteConnectionRow> {
    const row = this.forSite(site);
    if (row.privateKey && row.status === 'active') {
      const client = this.clientFor(row, { attempts: 2 });
      try {
        await client.disconnect();
      } catch (err) {
        this.log.warn(`Site "${site.slug}": could not tell the plugin to disconnect (${errMsg(err)})`);
      } finally {
        client.close();
      }
    }
    const now = Date.now();
    return this.db.transaction(() => {
      this.db.update(sites).set({ status: 'disconnected', updatedAt: now }).where(eq(sites.id, site.id)).run();
      return this.mark(row.id, { status: 'disconnected', privateKey: null, token: null });
    });
  }

  /** The address a connected site is probed at: its bound home. */
  homeOf(siteId: number): string | null {
    return this.findForSite(siteId)?.homeUrl ?? null;
  }

  /** What the uptime probe read off the site's certificate. */
  recordCert(siteId: number, expiresAt: number | null): void {
    const row = this.findForSite(siteId);
    if (row && expiresAt !== null && row.certExpiresAt !== expiresAt) this.mark(row.id, { certExpiresAt: expiresAt });
  }

  /** Who updates and logins run as, and where the backups live. */
  async update(site: SiteRow, body: SiteConnectionPatchBody): Promise<SiteRow> {
    const row = this.forSite(site);
    const patch: Partial<typeof siteConnections.$inferInsert> = {};
    const sitePatch: Partial<typeof sites.$inferInsert> = {};
    if (body.actAs !== undefined) {
      const admin = this.reportOf(row)?.admins.find((a) => a.id === body.actAs);
      if (!admin) throw badRequest(`User #${body.actAs} is not an administrator of the site`);
      patch.actAsUserId = admin.id;
      patch.actAsLogin = admin.login;
      sitePatch.wpAdminUser = admin.login;
    }
    if (body.storageServerId !== undefined && body.storageServerId !== site.serverId) {
      const server = resolveTargetServer({ settings: this.settings, servers: this.servers }, body.storageServerId);
      sitePatch.serverId = server.id;
    }
    if (body.useNewHome) {
      const home = await this.currentHome(row);
      if (!home) throw conflict('The site answers at the address the connection is bound to.');
      const host = hostOf(home).toLowerCase();
      try {
        assertDomainsFree({ db: this.db, config: this.config, servers: this.servers }, [host], { excludeSiteId: site.id });
      } catch {
        throw conflict(`A site in the panel already uses ${host}.`);
      }
      const endpoint = new URL(row.endpointUrl!);
      const next = new URL(home);
      endpoint.protocol = next.protocol;
      endpoint.host = next.host;
      patch.homeUrl = home;
      patch.endpointUrl = endpoint.toString();
      patch.lastError = null;
      patch.lastErrorAt = null;
      patch.warnings = JSON.stringify(this.warningsOf(row).filter((w) => w.code !== 'home_changed'));
      sitePatch.domains = JSON.stringify([host]);
    }
    const now = Date.now();
    this.db.transaction(() => {
      if (Object.keys(patch).length > 0) this.mark(row.id, patch);
      if (Object.keys(sitePatch).length > 0) this.db.update(sites).set({ ...sitePatch, updatedAt: now }).where(eq(sites.id, site.id)).run();
    });
    return this.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
  }

  /** The address the site says it has now, when it is not the bound one. */
  private async currentHome(row: SiteConnectionRow): Promise<string | null> {
    const client = this.clientFor(row, { attempts: 2 });
    try {
      await client.ping();
      return null;
    } catch (err) {
      if (err instanceof PluginSourceError && err.code === 'home_changed' && typeof err.details?.home === 'string') return err.details.home;
      throw conflict(`The site did not answer: ${errMsg(err)}`);
    } finally {
      client.close();
    }
  }

  // ------------------------------------------------------------------ talking to the site

  /** A client for this connection, carrying on with what earlier requests learned. */
  clientFor(row: SiteConnectionRow, opts: { canceled?: () => boolean; log?: (line: string) => void; attempts?: number; timeoutMs?: number } = {}): ConnectClient {
    if (!row.privateKey || !row.homeUrl || !row.endpointUrl) throw conflict('The site is not connected. Reconnect it from its Settings tab.');
    return new ConnectClient({
      connectionId: row.id,
      privateKey: row.privateKey,
      home: row.homeUrl,
      endpoint: row.endpointUrl,
      allowHttp: row.allowHttp === 1,
      transport: this.transport,
      lookup: this.lookup,
      sleep: this.retrySleep,
      state: { transport: (row.transport as 'rest' | 'query' | null) ?? null, skewS: row.skewS, budgetMs: row.budgetMs },
      ...opts,
    });
  }

  /** A client for the site's connection; 409 when it has none that works. */
  clientForSite(site: SiteRow, opts: Parameters<ConnectionsService['clientFor']>[1] = {}): ConnectClient {
    const row = this.forSite(site);
    if (row.status !== 'active' || site.status !== 'connected') {
      throw conflict(`"${site.slug}" is disconnected. Reconnect it from its Settings tab.`);
    }
    return this.clientFor(row, opts);
  }

  /** After a client's work: what it learned, and that the site answered. */
  remember(site: SiteRow, client: ConnectClient, outcome: { ok: boolean; error?: string } = { ok: true }): void {
    const row = this.findForSite(site.id);
    if (!row) return;
    this.mark(row.id, {
      transport: client.state.transport ?? row.transport,
      skewS: client.state.skewS,
      budgetMs: client.state.budgetMs,
      ...(outcome.ok
        ? { lastContactAt: Date.now(), lastError: null, lastErrorAt: null }
        : { lastError: (outcome.error ?? 'No answer').slice(0, 1000), lastErrorAt: Date.now() }),
    });
  }

  /** The update offer a ping carries: the panel's own WPL7 Connect, when the site runs an older one. */
  offerFor(row: SiteConnectionRow): { version: string; package: string; expires: number } | null {
    const origin = this.origin();
    if (!origin || !row.pluginVersion || row.pluginVersion === PANEL_VERSION) return null;
    let newer: boolean;
    try {
      newer = compareVersions(PANEL_VERSION, row.pluginVersion) > 0;
    } catch {
      newer = false;
    }
    if (!newer) return null;
    return { version: PANEL_VERSION, package: `${origin}${this.packagePath()}`, expires: Math.floor((Date.now() + PACKAGE_LINK_MS) / 1000) };
  }

  /**
   * The hourly check (built-in schedule `external-check`): a ping of every connected site, with
   * the update offer, recording what it says. Not a job: four sites at a time, in the panel.
   */
  async heartbeat(): Promise<HeartbeatResult> {
    const rows = this.db
      .select()
      .from(sites)
      .where(and(externalSites(), eq(sites.status, 'connected')))
      .orderBy(asc(sites.id))
      .all();
    const result: HeartbeatResult = { checked: 0, reachable: 0, failed: 0 };
    let next = 0;
    const work = async () => {
      while (next < rows.length) {
        const site = rows[next++]!;
        const ok = await this.checkSite(site);
        result.checked++;
        if (ok) result.reachable++;
        else result.failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(HEARTBEAT_CONCURRENCY, rows.length) }, work));
    return result;
  }

  /** One site's hourly check. True when the plugin answered. */
  async checkSite(site: SiteRow): Promise<boolean> {
    const row = this.findForSite(site.id);
    if (!row || row.status !== 'active' || !row.privateKey) return false;
    const client = this.clientFor(row, { attempts: 2, timeoutMs: 30_000 });
    const offer = this.offerFor(row);
    let ok = false;
    try {
      const ping: ConnectPing = await client.ping(offer ? { offer } : {});
      ok = true;
      this.mark(row.id, {
        lastContactAt: Date.now(),
        lastError: null,
        lastErrorAt: null,
        failCount: 0,
        transport: client.state.transport,
        skewS: client.state.skewS,
        budgetMs: client.state.budgetMs,
        pluginVersion: ping.plugin,
        protocol: ping.protocol,
        commands: Array.isArray(ping.commands) ? JSON.stringify(ping.commands.filter((c) => typeof c === 'string').slice(0, 200)) : row.commands,
        warnings: JSON.stringify(this.pingWarnings(row, ping)),
        offeredVersion: offer?.version ?? null,
      });
      if (ping.php) this.db.update(sites).set({ phpVersion: phpMinor(ping.php), updatedAt: Date.now() }).where(eq(sites.id, site.id)).run();
    } catch (err) {
      const homeChanged = err instanceof PluginSourceError && err.code === 'home_changed' ? (err.details?.home as string | null) : null;
      this.mark(row.id, {
        lastError: errMsg(err).slice(0, 1000),
        lastErrorAt: Date.now(),
        failCount: row.failCount + 1,
        warnings: JSON.stringify(
          homeChanged
            ? [
                ...this.warningsOf(row).filter((w) => w.code !== 'home_changed'),
                { code: 'home_changed', blocking: false, message: `The site's address is now ${homeChanged}.`, value: homeChanged },
              ]
            : this.warningsOf(row),
        ),
      });
    } finally {
      client.close();
    }
    const fresh = this.findForSite(site.id);
    if (fresh) await this.events?.checked(site, fresh).catch((err: unknown) => this.log.warn(`Alert for "${site.slug}" failed: ${errMsg(err)}`));
    return ok;
  }

  /** The warnings a ping brings up to date: what changed on the site since it was added. */
  private pingWarnings(row: SiteConnectionRow, ping: ConnectPing): ConnectWarning[] {
    const report = this.reportOf(row);
    if (!report) return this.warningsOf(row).filter((w) => w.code !== 'home_changed');
    const now = {
      ...report,
      ...(typeof ping.loader === 'boolean' ? { loader: ping.loader } : {}),
      ...(typeof ping.fs_method === 'string' ? { fs_method: ping.fs_method } : {}),
      ...(typeof ping.file_mods === 'boolean' ? { file_mods: ping.file_mods } : {}),
    };
    return connectWarnings(now, { allowHttp: row.allowHttp === 1 }).filter((w) => !w.blocking);
  }

  private warningsOf(row: SiteConnectionRow): ConnectWarning[] {
    return parseJson<ConnectWarning[]>(row.warnings) ?? [];
  }

  // ------------------------------------------------------------------ signed links

  /** The key the panel signs its download links with: made on first use, never shown. */
  private urlKey(): Buffer {
    let key = this.settings.getRaw('connect.urlKey');
    if (typeof key !== 'string' || key.length < 32) {
      key = crypto.randomBytes(32).toString('base64url');
      this.settings.setRaw('connect.urlKey', key);
    }
    return Buffer.from(key as string, 'utf8');
  }

  /** The HMAC of a link: its path and its fields, in the order given. */
  private signLink(pathname: string, fields: [string, string][]): string {
    return crypto.createHmac('sha256', this.urlKey()).update(`${pathname}\n${JSON.stringify(fields)}`).digest('base64url');
  }

  private link(pathname: string, fields: [string, string][]): string {
    const query = fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `${pathname}?${query}&s=${this.signLink(pathname, fields)}`;
  }

  /** `/api/connect/package?v=…&e=…&s=…`: the plugin of this panel, for two hours. */
  packagePath(): string {
    const expires = String(Math.floor((Date.now() + PACKAGE_LINK_MS) / 1000));
    return this.link('/api/connect/package', [
      ['v', PANEL_VERSION],
      ['e', expires],
    ]);
  }

  /** `/api/connect/catalog/<id>?site=…&e=…&s=…`: one catalog zip, for one install on one site. */
  catalogUrl(pluginId: number, siteId: number): string {
    const origin = this.origin();
    if (!origin) throw conflict('Set PANEL_DOMAIN first: the site downloads the plugin from the panel at that address');
    const expires = String(Math.floor((Date.now() + CATALOG_LINK_MS) / 1000));
    return `${origin}${this.link(`/api/connect/catalog/${pluginId}`, [
      ['site', String(siteId)],
      ['e', expires],
    ])}`;
  }

  /**
   * Whether a link the panel made is intact and not expired: its path, and its fields in the
   * order they were signed, read back from the request's query.
   */
  verifyLink(pathname: string, query: Record<string, unknown>, keys: string[]): boolean {
    const s = query.s;
    const e = Number(query.e);
    if (typeof s !== 'string' || !Number.isInteger(e) || e * 1000 < Date.now()) return false;
    const fields = keys.map((k): [string, string] => [k, typeof query[k] === 'string' ? (query[k] as string) : '']);
    const a = Buffer.from(this.signLink(pathname, fields));
    const b = Buffer.from(s);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ------------------------------------------------------------------ housekeeping

  /** Connections that waited too long expire, and their records go a day later. */
  prune(now = Date.now()): number {
    let n = 0;
    const waiting = this.db
      .select()
      .from(siteConnections)
      .where(and(inArray(siteConnections.status, ['pending', 'enrolled']), isNotNull(siteConnections.expiresAt), lt(siteConnections.expiresAt, now)))
      .all();
    for (const row of waiting) {
      this.expireIfDue(row);
      n++;
    }
    const gone = this.db
      .delete(siteConnections)
      .where(
        and(
          isNull(siteConnections.siteId),
          or(eq(siteConnections.status, 'expired'), eq(siteConnections.status, 'disconnected')),
          lt(siteConnections.updatedAt, now - EXPIRED_KEEP_MS),
        ),
      )
      .returning({ id: siteConnections.id })
      .all();
    return n + gone.length;
  }

  private expireIfDue(row: SiteConnectionRow): SiteConnectionRow {
    if ((row.status !== 'pending' && row.status !== 'enrolled') || !row.expiresAt || row.expiresAt > Date.now()) return row;
    return this.mark(row.id, { status: 'expired', token: null, privateKey: null });
  }

  private requireWorker(): JobWorker {
    if (!this.worker) throw new Error('The connections service has no job queue');
    return this.worker;
  }

  // ------------------------------------------------------------------ DTOs

  toSummary(row: SiteConnectionRow): ConnectionSummaryDto {
    const named = (id: number | null) => (id !== null ? this.db.select({ slug: sites.slug, title: sites.title }).from(sites).where(eq(sites.id, id)).get() : undefined);
    return {
      id: row.id,
      status: row.status as ConnectionStatus,
      source: row.homeUrl ?? row.sourceUrl,
      forSite: named(row.forSiteId) ?? null,
      site: named(row.siteId) ?? null,
      createdAt: row.createdAt,
      enrolledAt: row.enrolledAt,
      expiresAt: row.expiresAt,
    };
  }

  toDto(row: SiteConnectionRow): ConnectionDto {
    const report = this.reportOf(row);
    const warnings = report ? connectWarnings(report, { allowHttp: row.allowHttp === 1 }) : [];
    return {
      ...this.toSummary(row),
      allowHttp: row.allowHttp === 1,
      canDownload: row.token !== null && (row.status === 'pending' || row.status === 'enrolled'),
      report: report ? connectSourceOf(report) : null,
      warnings,
      blockedReason: blockingReason(warnings),
      check: row.checkedAt
        ? {
            at: row.checkedAt,
            reachable: row.lastError === null,
            transport: (row.transport as 'rest' | 'query' | null) ?? null,
            error: row.lastError,
          }
        : null,
      suggestions: report
        ? {
            slug: suggestSlug(report.home, (s) => this.slugTaken(s)),
            title: report.title.trim() || hostOf(report.home),
            actAs: report.admins[0]?.id ?? null,
            storageServerId: this.settings.get('defaultServerId') ?? 1,
          }
        : null,
    };
  }

  /** An external site, as the site list shows it. */
  externalSummary(site: SiteRow, row = this.findForSite(site.id)): ExternalSiteSummary | null {
    if (!isExternal(site)) return null;
    return {
      home: row?.homeUrl ?? `https://${(JSON.parse(site.domains) as string[])[0] ?? ''}`,
      reachable: row?.lastContactAt || row?.lastErrorAt ? (row.lastErrorAt ?? 0) <= (row.lastContactAt ?? 0) : null,
      lastContactAt: row?.lastContactAt ?? null,
      lastBackupAt: row?.lastBackupAt ?? null,
      pluginVersion: row?.pluginVersion ?? null,
    };
  }

  /** An external site in full, for its page. */
  externalDto(site: SiteRow, extra: { wpVersion: string | null }): ExternalSiteDto | null {
    if (!isExternal(site)) return null;
    const row = this.findForSite(site.id);
    const summary = this.externalSummary(site, row)!;
    const report = row ? this.reportOf(row) : null;
    const warnings = row ? this.warningsOf(row) : [];
    const homeChanged = warnings.find((w) => w.code === 'home_changed');
    return {
      ...summary,
      connectionId: row?.id ?? 0,
      protocol: row?.protocol ?? null,
      wpVersion: extra.wpVersion ?? report?.wp ?? null,
      lastError: row?.lastError ?? null,
      actAs: row?.actAsUserId && row.actAsLogin ? { id: row.actAsUserId, login: row.actAsLogin } : null,
      admins: (report?.admins ?? []).map((a) => ({ id: a.id, login: a.login })),
      storageServerId: site.serverId,
      storageServerName: this.servers.rowById(site.serverId)?.name ?? `#${site.serverId}`,
      mirrorBytes: site.diskBytes,
      certExpiresAt: row?.certExpiresAt ?? null,
      warnings: warnings.filter((w) => w.code !== 'home_changed'),
      commands: parseJson<string[]>(row?.commands ?? null) ?? [],
      offer: row && row.status === 'active' ? (this.offerVersion(row) ? { version: PANEL_VERSION } : null) : null,
      homeChanged: homeChanged?.value ?? null,
      allowHttp: row?.allowHttp === 1,
    };
  }

  private offerVersion(row: SiteConnectionRow): boolean {
    if (!row.pluginVersion || row.pluginVersion === PANEL_VERSION) return false;
    try {
      return compareVersions(PANEL_VERSION, row.pluginVersion) > 0;
    } catch {
      return false;
    }
  }

}
