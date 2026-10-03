import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  siteWpComponents,
  siteWpStatus,
  sites,
  type SiteRow,
  type SiteWpComponentRow,
  type VulnFeedRow,
} from '../db/schema.js';
import type { WpComponentKind, WpInventoryQuery } from '../../shared/schemas.js';
import type {
  FeedCoverage,
  SiteWpStatusDto,
  VulnSeverity,
  WpComponentActions,
  WpComponentDto,
  WpInventoryDto,
  WpInventoryRow,
  WpInventorySiteRow,
  WpCoreStatusDto,
  SiteWpSummary,
} from '../../shared/types.js';
import type { SiteStatus } from '../../shared/schemas.js';
import { compareVersions } from '../lib/wpVersions.js';
import type { ServerHandle } from '../servers/registry.js';
import type { CoreServices } from './index.js';
import { refKey, worseSeverity, type VulnerabilityFeedService, type VulnRef } from './vulnerabilities.js';

export type ScanLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** One parsed row of `wp plugin list` / `wp theme list`. */
export interface ParsedComponent {
  kind: 'plugin' | 'theme';
  slug: string;
  title: string;
  status: string;
  version: string;
  updateVersion: string | null;
  updateState: 'none' | 'available' | 'higher';
  autoUpdate: boolean;
  file: string | null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/**
 * wp-cli reports `auto_update` as a boolean in JSON and as on/off in a table, and older
 * builds have shipped both - so accept either rather than silently reading "off".
 */
function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === 'on' || value === '1' || value === 'true';
}

/**
 * `update` is a word, not a boolean: 'none', 'available', or 'version higher than
 * expected' for an install that is newer than what the directory offers (a beta, a
 * hand-patched copy). The last one must not be offered as an update - `wp plugin update`
 * would refuse it - so it gets its own state.
 */
function updateStateOf(raw: unknown, updateVersion: string | null): 'none' | 'available' | 'higher' {
  const value = str(raw).toLowerCase();
  if (value.includes('higher')) return 'higher';
  if (value === 'available' || value === 'true' || (value === '' && updateVersion)) {
    return updateVersion ? 'available' : 'none';
  }
  if (truthy(raw) && updateVersion) return 'available';
  return 'none';
}

/** Turn raw wp-cli rows into snapshot rows, dropping anything without a name. */
export function parseComponents(kind: 'plugin' | 'theme', rows: Record<string, unknown>[]): ParsedComponent[] {
  const out: ParsedComponent[] = [];
  for (const row of rows) {
    const slug = str(row.name).trim();
    if (!slug) continue;
    const updateVersion = str(row.update_version).trim() || null;
    out.push({
      kind,
      slug,
      title: str(row.title).trim() || slug,
      status: str(row.status).trim() || 'unknown',
      version: str(row.version).trim(),
      updateVersion,
      updateState: updateStateOf(row.update, updateVersion),
      autoUpdate: truthy(row.auto_update),
      file: kind === 'plugin' ? str(row.file).trim() || null : null,
    });
  }
  return out;
}

/**
 * Which actions a component will accept, and why not when it will not.
 *
 * These rules are the safety rails from the plan, enforced here so the API and the buttons
 * cannot disagree: the panel's own `ceo-login.php` lives in mu-plugins, drop-ins are not
 * plugins WordPress can deactivate, and wp-cli refuses to delete the active theme or its
 * parent (which is exactly the refusal we want, just stated up front).
 */
export function actionsFor(component: {
  kind: 'plugin' | 'theme';
  status: string;
  updateState: 'none' | 'available' | 'higher';
  updateVersion: string | null;
}): { actionable: WpComponentActions; blockedReason: string | null } {
  const canUpdate = component.updateState === 'available' && !!component.updateVersion;
  if (component.kind === 'plugin') {
    if (component.status === 'must-use') {
      return {
        actionable: { activate: false, deactivate: false, update: false, delete: false },
        blockedReason: 'Must-use plugins are loaded by the platform and cannot be managed from here.',
      };
    }
    if (component.status === 'dropin') {
      return {
        actionable: { activate: false, deactivate: false, update: false, delete: false },
        blockedReason: 'Drop-ins are single files WordPress loads directly; they are not installable plugins.',
      };
    }
    const active = component.status === 'active' || component.status === 'active-network';
    return {
      actionable: { activate: !active, deactivate: active, update: canUpdate, delete: true },
      blockedReason: null,
    };
  }
  if (component.status === 'active') {
    return {
      actionable: { activate: false, deactivate: false, update: canUpdate, delete: false },
      blockedReason: 'This is the active theme. Activate another one before deleting it.',
    };
  }
  if (component.status === 'parent') {
    return {
      actionable: { activate: true, deactivate: false, update: canUpdate, delete: false },
      blockedReason: 'The active theme is a child of this one; deleting it would break the site.',
    };
  }
  return { actionable: { activate: true, deactivate: false, update: canUpdate, delete: true }, blockedReason: null };
}

const isInactive = (row: { kind: string; status: string }): boolean =>
  row.kind === 'plugin' ? row.status === 'inactive' : row.status === 'inactive';

/**
 * The per-site WordPress snapshot: what is installed, what has an update, and what the
 * vulnerability feed says about it.
 *
 * Writing happens in `scanSite` (a job, or an explicit "Check now"); every read is SQLite
 * plus the cached feed, which is what lets the fleet page exist at all.
 */
export class WpInventoryService {
  constructor(
    private readonly s: CoreServices,
    private readonly feed: VulnerabilityFeedService,
  ) {}

  private get db() {
    return this.s.db;
  }

  /**
   * Re-read one site's plugins, themes and core state into the snapshot.
   *
   * Needs a running container - the caller decides what to do about a stopped site (the
   * scheduler skips it, the per-site route answers 409, the bulk job starts it). A scan
   * that fails is recorded on the row rather than thrown away, so the page can say why it
   * has nothing to show.
   */
  async scanSite(
    site: SiteRow,
    server: ServerHandle,
    opts: { log?: ScanLog; refreshFeed?: boolean } = {},
  ): Promise<void> {
    const log = opts.log ?? (() => undefined);
    const previous = this.statusRowFor(site.id);
    let partial = false;
    let components: ParsedComponent[] = [];
    try {
      for (const kind of ['plugin', 'theme'] as const) {
        let rows: Record<string, unknown>[];
        try {
          rows = await server.wp.listComponents(site.containerName, kind, { skipExtensions: partial });
        } catch (err) {
          // A plugin that fatals under wp-cli takes the whole listing with it. Retrying
          // without the extensions loaded still yields the inventory; it just cannot see
          // updates that a premium plugin's own updater would have reported.
          log('warn', `wp ${kind} list failed (${message(err)}); retrying with plugins and themes not loaded`);
          rows = await server.wp.listComponents(site.containerName, kind, { skipExtensions: true });
          partial = true;
        }
        components = components.concat(parseComponents(kind, rows));
      }
    } catch (err) {
      // Only the error is written: a container that could not be read for thirty seconds is
      // no reason to forget the version it was running, and the components stay too. The
      // page shows the previous snapshot with the failure next to it.
      this.recordScanError(site.id, message(err));
      log('error', `Inventory scan of "${site.slug}" failed: ${message(err)}`);
      throw err;
    }

    // The core read is its own failure domain. `core check-update` boots WordPress like the
    // listings do, so the plugin that broke them breaks it too - and losing the core version
    // is no reason to throw away an inventory that was successfully recovered.
    let core = await this.readCore(site, server, { skipExtensions: partial, log });
    if (!core) {
      partial = true;
      core = {
        version: previous?.coreVersion ?? null,
        updateVersion: previous?.coreUpdateVersion ?? null,
        updateType: (previous?.coreUpdateType as 'major' | 'minor' | null) ?? null,
      };
    }

    const now = Date.now();
    this.db.transaction(() => {
      for (const component of components) {
        const values = {
          siteId: site.id,
          kind: component.kind,
          slug: component.slug,
          title: component.title,
          status: component.status,
          version: component.version,
          updateVersion: component.updateVersion,
          updateState: component.updateState,
          autoUpdate: component.autoUpdate ? 1 : 0,
          file: component.file,
          seenAt: now,
        };
        this.db
          .insert(siteWpComponents)
          .values(values)
          .onConflictDoUpdate({
            target: [siteWpComponents.siteId, siteWpComponents.kind, siteWpComponents.slug],
            set: values,
          })
          .run();
      }
      // Anything the scan did not see has been deleted on the site; the snapshot is an
      // inventory of what is installed now, not a history of what once was.
      this.db
        .delete(siteWpComponents)
        .where(and(eq(siteWpComponents.siteId, site.id), sql`${siteWpComponents.seenAt} < ${now}`))
        .run();
      this.writeStatus(site.id, { ...core, partial, scannedAt: now });
    });

    log(
      'info',
      `"${site.slug}": ${components.filter((c) => c.kind === 'plugin').length} plugins, ` +
        `${components.filter((c) => c.kind === 'theme').length} themes, core ${core.version ?? 'unknown'}` +
        `${core.updateVersion ? ` (update to ${core.updateVersion})` : ''}${partial ? ' — partial scan' : ''}`,
    );

    const touched = new Set([site.id]);
    if (opts.refreshFeed !== false) {
      const { refreshed } = await this.feed.refresh(this.refsForSites([site.id]));
      // A feed entry is shared by every site that has the slug installed, so a lookup this
      // scan happened to trigger can change another site's verdict. Recount those too, or
      // the site list keeps reporting zero for a site whose own page says otherwise.
      for (const siteId of this.siteIdsReferencing(refreshed)) touched.add(siteId);
    }
    this.recount([...touched]);
  }

  /**
   * Core version and the update on offer, or null when WordPress could not be booted at
   * all. Retries with the extensions unloaded for the same reason the listings do.
   */
  private async readCore(
    site: SiteRow,
    server: ServerHandle,
    opts: { skipExtensions: boolean; log: ScanLog },
  ): Promise<{ version: string | null; updateVersion: string | null; updateType: 'major' | 'minor' | null } | null> {
    for (const skipExtensions of opts.skipExtensions ? [true] : [false, true]) {
      try {
        const version = await server.wp.coreVersion(site.containerName, { skipExtensions });
        const update = await server.wp.coreCheckUpdate(site.containerName, { skipExtensions });
        return { version, updateVersion: update?.version ?? null, updateType: update?.updateType ?? null };
      } catch (err) {
        if (!skipExtensions) {
          opts.log('warn', `wp core check-update failed (${message(err)}); retrying with plugins and themes not loaded`);
          continue;
        }
        opts.log('warn', `Could not read the WordPress version of "${site.slug}": ${message(err)}`);
      }
    }
    return null;
  }

  /** Sites that have any of these components (or core versions) installed. */
  siteIdsReferencing(refs: VulnRef[]): number[] {
    if (refs.length === 0) return [];
    const ids = new Set<number>();
    const components = refs.filter((r) => r.kind !== 'core');
    if (components.length > 0) {
      const slugs = [...new Set(components.map((r) => r.slug))];
      for (const row of this.db
        .selectDistinct({ siteId: siteWpComponents.siteId, kind: siteWpComponents.kind, slug: siteWpComponents.slug })
        .from(siteWpComponents)
        .where(inArray(siteWpComponents.slug, slugs))
        .all()) {
        if (components.some((r) => r.kind === row.kind && r.slug === row.slug)) ids.add(row.siteId);
      }
    }
    const coreVersions = [...new Set(refs.filter((r) => r.kind === 'core').map((r) => r.slug))];
    if (coreVersions.length > 0) {
      for (const row of this.db
        .select({ siteId: siteWpStatus.siteId })
        .from(siteWpStatus)
        .where(inArray(siteWpStatus.coreVersion, coreVersions))
        .all()) {
        ids.add(row.siteId);
      }
    }
    return [...ids];
  }

  private writeStatus(
    siteId: number,
    patch: {
      version: string | null;
      updateVersion: string | null;
      updateType: 'major' | 'minor' | null;
      partial: boolean;
      scannedAt: number;
    },
  ): void {
    const values = {
      siteId,
      coreVersion: patch.version,
      coreUpdateVersion: patch.updateVersion,
      coreUpdateType: patch.updateType,
      partial: patch.partial ? 1 : 0,
      scanError: null,
      scannedAt: patch.scannedAt,
    };
    this.db
      .insert(siteWpStatus)
      .values(values)
      .onConflictDoUpdate({ target: siteWpStatus.siteId, set: values })
      .run();
  }

  /** Record why a scan failed, leaving the last good snapshot in place. */
  private recordScanError(siteId: number, error: string): void {
    this.db
      .insert(siteWpStatus)
      .values({ siteId, scanError: error.slice(0, 1000) })
      .onConflictDoUpdate({ target: siteWpStatus.siteId, set: { scanError: error.slice(0, 1000) } })
      .run();
  }

  /** Every feed lookup the given sites (or the whole fleet) need. */
  refsForSites(siteIds?: number[]): VulnRef[] {
    const componentRows = this.db
      .selectDistinct({ kind: siteWpComponents.kind, slug: siteWpComponents.slug })
      .from(siteWpComponents)
      .where(siteIds ? inArray(siteWpComponents.siteId, siteIds) : undefined)
      .all();
    const coreRows = this.db
      .select({ version: siteWpStatus.coreVersion })
      .from(siteWpStatus)
      .where(
        siteIds
          ? and(inArray(siteWpStatus.siteId, siteIds), isNotNull(siteWpStatus.coreVersion))
          : isNotNull(siteWpStatus.coreVersion),
      )
      .all();
    const refs = componentRows.map((r) => ({ kind: r.kind as WpComponentKind, slug: r.slug }));
    for (const version of new Set(coreRows.map((r) => r.version).filter((v): v is string => !!v))) {
      refs.push({ kind: 'core', slug: version });
    }
    return refs;
  }

  /**
   * Recompute the denormalised counters on `site_wp_status`.
   *
   * Called after every scan and after every feed refresh - a new advisory has to change
   * what the site list shows without anybody re-reading a container.
   */
  recount(siteIds?: number[]): void {
    const statuses = this.db
      .select()
      .from(siteWpStatus)
      .where(siteIds ? inArray(siteWpStatus.siteId, siteIds) : undefined)
      .all();
    if (statuses.length === 0) return;
    const ids = statuses.map((s) => s.siteId);
    const components = this.db
      .select()
      .from(siteWpComponents)
      .where(inArray(siteWpComponents.siteId, ids))
      .all();
    const feedRows = this.feed.loadRows([
      ...components.map((c) => ({ kind: c.kind as WpComponentKind, slug: c.slug })),
      ...statuses.filter((s) => s.coreVersion).map((s) => ({ kind: 'core' as const, slug: s.coreVersion! })),
    ]);
    const byStatus = new Map(statuses.map((s) => [s.siteId, s]));
    const perSite = new Map<number, { updates: number; vulnerable: number; worst: VulnSeverity | null }>();
    for (const id of ids) perSite.set(id, { updates: 0, vulnerable: 0, worst: null });

    for (const component of components) {
      const acc = perSite.get(component.siteId)!;
      if (component.updateState === 'available' && component.updateVersion) acc.updates++;
      const verdict = this.feed.verdictFrom(
        feedRows.get(refKey(component.kind, component.slug)),
        component.version,
      );
      if (verdict.vulnerabilities.length > 0 || verdict.closedOnWporg) acc.vulnerable++;
      acc.worst = worseSeverity(acc.worst, verdict.worstSeverity);
    }
    for (const status of statuses) {
      const acc = perSite.get(status.siteId)!;
      if (status.coreUpdateVersion) acc.updates++;
      if (status.coreVersion) {
        const verdict = this.feed.verdictFrom(feedRows.get(refKey('core', status.coreVersion)), status.coreVersion);
        if (verdict.vulnerabilities.length > 0) acc.vulnerable++;
        acc.worst = worseSeverity(acc.worst, verdict.worstSeverity);
      }
    }
    for (const [siteId, acc] of perSite) {
      if (!byStatus.has(siteId)) continue;
      this.db
        .update(siteWpStatus)
        .set({ updatesCount: acc.updates, vulnerableCount: acc.vulnerable, worstSeverity: acc.worst })
        .where(eq(siteWpStatus.siteId, siteId))
        .run();
    }
  }

  /** The summary `GET /sites` carries, for every site in one query pair. */
  summaries(): Map<number, SiteWpSummary> {
    const out = new Map<number, SiteWpSummary>();
    for (const row of this.db.select().from(siteWpStatus).all()) {
      if (row.scannedAt === null) continue;
      out.set(row.siteId, {
        scannedAt: row.scannedAt,
        updates: row.updatesCount,
        vulnerable: row.vulnerableCount,
        worstSeverity: (row.worstSeverity as VulnSeverity | null) ?? null,
        coreUpdate: row.coreUpdateVersion,
      });
    }
    return out;
  }

  /** Everything the site page's WordPress tab shows, straight out of the snapshot. */
  statusFor(site: SiteRow): SiteWpStatusDto {
    const status = this.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, site.id)).get();
    const components = this.db
      .select()
      .from(siteWpComponents)
      .where(eq(siteWpComponents.siteId, site.id))
      .orderBy(asc(siteWpComponents.kind), asc(siteWpComponents.slug))
      .all();
    const feedRows = this.feed.loadRows([
      ...components.map((c) => ({ kind: c.kind as WpComponentKind, slug: c.slug })),
      ...(status?.coreVersion ? [{ kind: 'core' as const, slug: status.coreVersion }] : []),
    ]);

    const dtos = components.map((row) => this.toComponentDto(row, feedRows.get(refKey(row.kind, row.slug))));
    const plugins = dtos.filter((c) => c.kind === 'plugin');
    const themes = dtos.filter((c) => c.kind === 'theme');
    const coreVerdict = this.feed.verdictFrom(
      status?.coreVersion ? feedRows.get(refKey('core', status.coreVersion)) : undefined,
      status?.coreVersion ?? null,
    );
    const core: WpCoreStatusDto = {
      version: status?.coreVersion ?? null,
      updateVersion: status?.coreUpdateVersion ?? null,
      updateType: (status?.coreUpdateType as 'major' | 'minor' | null) ?? null,
      vulnerabilities: coreVerdict.vulnerabilities,
      worstSeverity: coreVerdict.worstSeverity,
      feedCoverage: status?.coreVersion ? coreVerdict.coverage : 'pending',
    };
    return {
      siteSlug: site.slug,
      scannedAt: status?.scannedAt ?? null,
      partial: status?.partial === 1,
      scanError: status?.scanError ?? null,
      core,
      plugins,
      themes,
      counts: {
        updates: dtos.filter((c) => c.actionable.update).length + (core.updateVersion ? 1 : 0),
        vulnerable:
          dtos.filter((c) => c.vulnerabilities.length > 0 || c.closedOnWporg).length +
          (core.vulnerabilities.length > 0 ? 1 : 0),
        inactive: dtos.filter((c) => isInactive(c)).length,
        closed: dtos.filter((c) => c.closedOnWporg).length,
      },
      feed: { enabled: this.feed.enabled, refreshedAt: this.feed.refreshedAt() },
    };
  }

  private toComponentDto(row: SiteWpComponentRow, feedRow: VulnFeedRow | undefined): WpComponentDto {
    const kind = row.kind as 'plugin' | 'theme';
    const updateState = row.updateState as 'none' | 'available' | 'higher';
    const verdict = this.feed.verdictFrom(feedRow, row.version);
    const { actionable, blockedReason } = actionsFor({
      kind,
      status: row.status,
      updateState,
      updateVersion: row.updateVersion,
    });
    // Would the offered release actually clear what matches today? Re-running the same
    // matcher against the update version is the only honest way to answer: an advisory
    // "fixed in 2.0" is not fixed by the 1.1 the directory is offering.
    const updateFixes =
      actionable.update &&
      verdict.vulnerabilities.length > 0 &&
      this.feed.verdictFrom(feedRow, row.updateVersion).vulnerabilities.length === 0;
    return {
      kind,
      slug: row.slug,
      title: row.title || row.slug,
      status: row.status,
      version: row.version,
      updateVersion: row.updateVersion,
      updateState,
      autoUpdate: row.autoUpdate === 1,
      actionable,
      blockedReason,
      updateFixes,
      vulnerabilities: verdict.vulnerabilities,
      worstSeverity: verdict.worstSeverity,
      closedOnWporg: verdict.closedOnWporg,
      closedReason: verdict.closedReason,
      feedCoverage: verdict.coverage,
    };
  }

  /**
   * The fleet table: one row per component slug with its per-site rows underneath.
   *
   * Filters are applied to the per-site rows first and the aggregate is computed from what
   * survives, so "Vulnerable" + select-all + *Update* means exactly "update every
   * vulnerable install" and nothing more.
   */
  fleetInventory(query: WpInventoryQuery): Omit<WpInventoryDto, 'scanJob'> {
    const siteRows = this.db.select().from(sites).orderBy(asc(sites.title)).all();
    const serverNames = new Map(this.s.servers.listRows().map((r) => [r.id, r.name]));
    const considered = siteRows.filter((site) => {
      if (site.status === 'deleting' || site.status === 'provisioning') return false;
      if (!query.includeStopped && site.status !== 'running') return false;
      if (query.serverId !== undefined && site.serverId !== query.serverId) return false;
      if (query.siteSlug && site.slug !== query.siteSlug) return false;
      return true;
    });
    const siteById = new Map(considered.map((s) => [s.id, s]));
    const ids = considered.map((s) => s.id);
    const statuses = new Map(
      (ids.length > 0
        ? this.db.select().from(siteWpStatus).where(inArray(siteWpStatus.siteId, ids)).all()
        : []
      ).map((row) => [row.siteId, row]),
    );

    const wants = new Set(query.filter);
    const matchesText = (slug: string, title: string): boolean =>
      !query.q || `${slug} ${title}`.toLowerCase().includes(query.q.toLowerCase());

    const groups = new Map<string, WpInventoryRow>();
    const addSiteRow = (
      key: string,
      seed: () => Omit<WpInventoryRow, 'siteRows' | 'sites' | 'updates' | 'vulnerable' | 'inactive' | 'versions'>,
      row: WpInventorySiteRow,
    ): void => {
      let group = groups.get(key);
      if (!group) {
        group = { ...seed(), sites: 0, updates: 0, vulnerable: 0, inactive: 0, versions: [], siteRows: [] };
        groups.set(key, group);
      }
      group.siteRows.push(row);
      group.sites++;
      if (row.updateState === 'available' && row.updateVersion) group.updates++;
      if (row.worstSeverity || row.vulnerabilities.length > 0) group.vulnerable++;
      if (row.status === 'inactive') group.inactive++;
      if (row.version && !group.versions.includes(row.version)) group.versions.push(row.version);
      if (row.updateVersion && (!group.updateVersion || compareVersions(row.updateVersion, group.updateVersion) > 0)) {
        group.updateVersion = row.updateVersion;
      }
      group.worstSeverity = worseSeverity(group.worstSeverity, row.worstSeverity);
    };

    if (query.kind === 'core') {
      const coreRefs = [...statuses.values()]
        .filter((s) => s.coreVersion)
        .map((s) => ({ kind: 'core' as const, slug: s.coreVersion! }));
      const feedRows = this.feed.loadRows(coreRefs);
      for (const status of statuses.values()) {
        const site = siteById.get(status.siteId);
        if (!site || !status.coreVersion) continue;
        if (!matchesText(status.coreVersion, 'WordPress')) continue;
        const verdict = this.feed.verdictFrom(feedRows.get(refKey('core', status.coreVersion)), status.coreVersion);
        const hasUpdate = !!status.coreUpdateVersion;
        const vulnerable = verdict.vulnerabilities.length > 0;
        if (wants.has('updates') && !hasUpdate) continue;
        if (wants.has('vulnerable') && !vulnerable) continue;
        // Core is never inactive and never closed on wordpress.org, so those chips
        // deliberately match nothing here rather than pretending to.
        if (wants.has('inactive') || wants.has('closed')) continue;
        const coverage: FeedCoverage = verdict.coverage;
        addSiteRow(
          `core:${status.coreVersion}`,
          () => ({
            kind: 'core' as WpComponentKind,
            slug: status.coreVersion!,
            title: `WordPress ${status.coreVersion}`,
            updateVersion: null,
            worstSeverity: null,
            closedOnWporg: false,
            closedReason: null,
            feedCoverage: coverage,
          }),
          {
            siteSlug: site.slug,
            siteTitle: site.title,
            siteStatus: site.status as SiteStatus,
            serverId: site.serverId,
            serverName: serverNames.get(site.serverId) ?? `#${site.serverId}`,
            scannedAt: status.scannedAt,
            version: status.coreVersion,
            updateVersion: status.coreUpdateVersion,
            updateState: status.coreUpdateVersion ? 'available' : 'none',
            status: 'active',
            autoUpdate: false,
            worstSeverity: verdict.worstSeverity,
            vulnerabilities: verdict.vulnerabilities,
            actionable: { activate: false, deactivate: false, update: hasUpdate, delete: false },
            blockedReason: hasUpdate ? null : 'WordPress is already at the latest version on this site.',
          },
        );
      }
    } else {
      const components =
        ids.length > 0
          ? this.db
              .select()
              .from(siteWpComponents)
              .where(and(inArray(siteWpComponents.siteId, ids), eq(siteWpComponents.kind, query.kind)))
              .all()
          : [];
      const feedRows = this.feed.loadRows(
        components.map((c) => ({ kind: c.kind as WpComponentKind, slug: c.slug })),
      );
      for (const component of components) {
        const site = siteById.get(component.siteId);
        if (!site) continue;
        if (!matchesText(component.slug, component.title)) continue;
        const dto = this.toComponentDto(component, feedRows.get(refKey(component.kind, component.slug)));
        const vulnerable = dto.vulnerabilities.length > 0 || dto.closedOnWporg;
        if (wants.has('updates') && !dto.actionable.update) continue;
        if (wants.has('vulnerable') && !vulnerable) continue;
        if (wants.has('inactive') && !isInactive(dto)) continue;
        if (wants.has('closed') && !dto.closedOnWporg) continue;
        const status = statuses.get(component.siteId);
        addSiteRow(
          `${dto.kind}:${dto.slug}`,
          () => ({
            kind: dto.kind as WpComponentKind,
            slug: dto.slug,
            title: dto.title,
            updateVersion: null,
            worstSeverity: null,
            closedOnWporg: dto.closedOnWporg,
            closedReason: dto.closedReason,
            feedCoverage: dto.feedCoverage,
          }),
          {
            siteSlug: site.slug,
            siteTitle: site.title,
            siteStatus: site.status as SiteStatus,
            serverId: site.serverId,
            serverName: serverNames.get(site.serverId) ?? `#${site.serverId}`,
            scannedAt: status?.scannedAt ?? null,
            version: dto.version,
            updateVersion: dto.updateVersion,
            updateState: dto.updateState,
            status: dto.status,
            autoUpdate: dto.autoUpdate,
            worstSeverity: dto.worstSeverity,
            vulnerabilities: dto.vulnerabilities,
            actionable: dto.actionable,
            blockedReason: dto.blockedReason,
          },
        );
      }
    }

    const rows = [...groups.values()].map((group) => ({
      ...group,
      versions: [...group.versions].sort(compareVersions),
      siteRows: group.siteRows.sort((a, b) => a.siteTitle.localeCompare(b.siteTitle)),
    }));
    // Worst first, then the biggest fan-out: the row an operator has to act on is at the
    // top whichever filter they arrived with.
    rows.sort(
      (a, b) =>
        b.vulnerable - a.vulnerable || b.updates - a.updates || b.sites - a.sites || a.title.localeCompare(b.title),
    );

    const scanned = [...statuses.values()].filter((s) => s.scannedAt !== null);
    return {
      kind: query.kind,
      rows,
      fleet: {
        sites: considered.length,
        scanned: scanned.length,
        neverScanned: considered.length - scanned.length,
        sitesWithUpdates: scanned.filter((s) => s.updatesCount > 0).length,
        sitesVulnerable: scanned.filter((s) => s.vulnerableCount > 0).length,
        coreOutdated: scanned.filter((s) => s.coreUpdateVersion).length,
        lastScanAt: scanned.reduce<number | null>((max, s) => (s.scannedAt! > (max ?? 0) ? s.scannedAt! : max), null),
      },
      feed: { enabled: this.feed.enabled, refreshedAt: this.feed.refreshedAt() },
    };
  }

  /** The snapshot rows for one site, keyed `kind:slug` - what the bulk validator checks against. */
  componentsFor(siteId: number): Map<string, SiteWpComponentRow> {
    return new Map(
      this.db
        .select()
        .from(siteWpComponents)
        .where(eq(siteWpComponents.siteId, siteId))
        .all()
        .map((row) => [refKey(row.kind, row.slug), row]),
    );
  }

  statusRowFor(siteId: number) {
    return this.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, siteId)).get();
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
