/**
 * What the Security pages and the API show, put together from the services that keep each
 * part: protection (security.ts), blocked requests (securityEvents.ts), blocked addresses
 * (blocklist.ts), scans and their findings (malwareScan.ts), quarantine (quarantine.ts).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  jobs,
  servers,
  siteScanFindings,
  siteScanStatus,
  siteScans,
  sites,
  type SiteQuarantineRow,
  type SiteRow,
  type SiteScanFindingRow,
  type SiteScanRow,
  type SiteSecurityRow,
} from '../db/schema.js';
import {
  countOverrides,
  effectivePolicy,
  hasOverrides,
  type FindingConfidence,
  type FindingKind,
  type FindingSeverity,
  type FindingStatus,
  type ScanOnFinding,
  type ScanOutcome,
} from '../../shared/security.js';
import type {
  FindingDto,
  QuarantineItemDto,
  ScanDto,
  SecurityOverviewDto,
  SecuritySiteRowDto,
  SiteScanDto,
  SiteSecurityDto,
} from '../../shared/types.js';
import type { JobStatus } from '../../shared/schemas.js';
import { canPutBack, canReinstall, manualQuarantineProblem } from './scanPolicy.js';
import type { ZipFlag } from './pluginZipChecks.js';
import type { CoreServices } from './index.js';
import { hostedSites } from '../lib/siteKind.js';

type Deps = Pick<CoreServices, 'db' | 'security' | 'securityEvents' | 'blocklist' | 'malwareScan' | 'pluginZipChecks' | 'servers' | 'settings'>;

const DAY = 86_400_000;

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function scanDto(row: SiteScanRow): ScanDto {
  const engines = json<Record<string, unknown>>(row.engines, {});
  const signatures = (engines.signatures ?? {}) as { partial?: unknown; partialCount?: unknown };
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status as ScanOutcome,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    filesScanned: row.filesScanned,
    findingsTotal: row.findingsTotal,
    findingsNew: row.findingsNew,
    noChecksums: json<string[]>(row.noChecksums, []),
    error: row.error,
    engines,
    partlyScanned: {
      count: typeof signatures.partialCount === 'number' ? signatures.partialCount : 0,
      files: Array.isArray(signatures.partial) ? (signatures.partial as ScanDto['partlyScanned']['files']) : [],
    },
    jobId: row.jobId,
  };
}

/** A site's own scan settings; null = the default's. */
function ownScanSettings(row: SiteSecurityRow | undefined): { enabled: boolean | null; onFinding: ScanOnFinding | null } {
  return {
    enabled: row?.scanEnabled === null || row?.scanEnabled === undefined ? null : row.scanEnabled === 1,
    onFinding: (row?.scanOnFinding as ScanOnFinding | null | undefined) ?? null,
  };
}

export function siteScanDto(s: Deps, site: SiteRow): SiteScanDto {
  const own = ownScanSettings(s.security.siteRow(site.id));
  const effective = s.malwareScan.settingsFor(site.id);
  const status = s.db.select().from(siteScanStatus).where(eq(siteScanStatus.siteId, site.id)).get();
  const last = status?.lastScanId ? s.db.select().from(siteScans).where(eq(siteScans.id, status.lastScanId)).get() : undefined;
  const active = s.malwareScan.activeJob(site.id);
  return {
    enabled: own.enabled,
    onFinding: own.onFinding,
    effective: { enabled: effective.enabled, onFinding: effective.onFinding, signatures: effective.signatures },
    defaults: s.malwareScan.defaults(),
    last: last ? scanDto(last) : null,
    active: active ? { jobId: active.id, status: active.status as JobStatus } : null,
    nextDueAt: s.malwareScan.nextDueAt(site.id),
    requestedAt: status?.requestedAt ?? null,
    openFindings: status?.openFindings ?? 0,
    openConfirmed: status?.openConfirmed ?? 0,
    quarantined: status?.quarantined ?? 0,
    failures: status?.failures ?? 0,
  };
}

export function siteSecurityDto(s: Deps, site: SiteRow): SiteSecurityDto {
  const input = s.security.siteInput(site.id);
  return {
    slug: site.slug,
    level: input.level,
    overrides: input.overrides,
    customRules: input.customRules,
    policy: s.security.policyFor(site.id),
    fleet: s.security.fleet(),
    status: s.security.siteStatus(site),
    rejections: s.security.rejections(site.slug),
    blocked7d: s.securityEvents.countsBySite(site.id, 7),
    scan: siteScanDto(s, site),
  };
}

/**
 * A finding as the Findings card shows it. `flags` are the catalog zips' unreviewed findings
 * (PluginZipChecks.unreviewedFlags): a finding on a file one of them flagged too points there.
 */
export function findingDto(row: SiteScanFindingRow, flags?: Map<string, Map<string, ZipFlag>>): FindingDto {
  const inPlugin = /^wp-content\/plugins\/([^/]+)\/(.+)$/.exec(row.path);
  const zipReview = inPlugin && row.engine === 'signatures' ? (flags?.get(inPlugin[1]!)?.get(inPlugin[2]!) ?? null) : null;
  return {
    id: row.id,
    engine: row.engine === 'signatures' ? 'signatures' : 'check',
    kind: row.kind as FindingKind,
    confidence: row.confidence as FindingConfidence,
    severity: row.severity as FindingSeverity,
    path: row.path,
    line: row.line,
    rule: row.rule,
    detail: row.detail,
    package: row.package,
    packageVersion: row.packageVersion,
    sha256: row.sha256,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    status: row.status as FindingStatus,
    statusAt: row.statusAt,
    statusBy: row.statusBy,
    canReinstall: canReinstall({ ...row, kind: row.kind as FindingKind }),
    canPutBack: canPutBack({ ...row, kind: row.kind as FindingKind }),
    quarantineProblem: manualQuarantineProblem({ ...row, kind: row.kind as FindingKind }),
    zipReview,
  };
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** A site's findings, the most serious first; `all` includes the ignored and the resolved. */
export function siteFindings(
  s: Pick<Deps, 'db' | 'pluginZipChecks'>,
  siteId: number,
  status: FindingStatus | 'all',
): { items: FindingDto[]; counts: Record<FindingStatus, number> } {
  const rows = s.db.select().from(siteScanFindings).where(eq(siteScanFindings.siteId, siteId)).all();
  const counts: Record<FindingStatus, number> = { open: 0, ignored: 0, resolved: 0, quarantined: 0 };
  for (const r of rows) counts[r.status as FindingStatus] = (counts[r.status as FindingStatus] ?? 0) + 1;
  const items = rows
    .filter((r) => status === 'all' || r.status === status)
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
        Number(b.confidence === 'confirmed') - Number(a.confidence === 'confirmed') ||
        a.path.localeCompare(b.path),
    );
  const flags = items.some((r) => r.path.startsWith('wp-content/plugins/')) ? s.pluginZipChecks.unreviewedFlags() : undefined;
  return { items: items.map((r) => findingDto(r, flags)), counts };
}

export function quarantineDto(row: SiteQuarantineRow): QuarantineItemDto {
  return {
    id: row.id,
    path: row.path,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    reason: row.reason,
    movedAt: row.movedAt,
    movedBy: row.movedBy,
    state: row.deletedAt !== null ? 'deleted' : row.restoredAt !== null ? 'restored' : 'kept',
    restoredAt: row.restoredAt,
    restoredBy: row.restoredBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
  };
}

/** Sites -> Security: the default, every site on one row, every server's rules folder. */
export function securityOverview(s: Deps, now = Date.now()): SecurityOverviewDto {
  const fleet = s.security.fleet();
  const serverRows = s.db.select().from(servers).all();
  const serverName = new Map(serverRows.map((r) => [r.id, r.name]));
  const blocked = s.securityEvents.fleetCounts(now - DAY);
  const statuses = new Map(s.db.select().from(siteScanStatus).all().map((r) => [r.siteId, r]));
  const lastScans = new Map(
    s.db
      .select({ id: siteScans.id, status: siteScans.status, finishedAt: siteScans.finishedAt, startedAt: siteScans.startedAt })
      .from(siteScans)
      .where(inArray(siteScans.id, [...statuses.values()].map((r) => r.lastScanId).filter((id): id is number => id !== null)))
      .all()
      .map((r) => [r.id, r]),
  );
  const activeScans = s.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, 'site.malwareScan'), inArray(jobs.status, ['queued', 'running'])))
    .all()
    .map((j) => json<{ siteId?: number }>(j.payload, {}).siteId);
  const rows: SecuritySiteRowDto[] = s.db
    .select()
    .from(sites)
    .where(hostedSites())
    .orderBy(sites.slug)
    .all()
    .map((site) => {
      const input = s.security.siteInput(site.id);
      const scanOwn = ownScanSettings(s.security.siteRow(site.id));
      const status = statuses.get(site.id);
      const last = status?.lastScanId ? lastScans.get(status.lastScanId) : undefined;
      return {
        slug: site.slug,
        title: site.title,
        status: site.status,
        serverName: serverName.get(site.serverId) ?? null,
        level: effectivePolicy(fleet, input).level,
        customised: input.level !== null || hasOverrides(input.overrides) || input.customRules.length > 0,
        own: {
          level: input.level,
          changes: countOverrides(input.overrides),
          customRules: input.customRules.length,
          scanEnabled: scanOwn.enabled,
          scanOnFinding: scanOwn.onFinding,
        },
        blocked24h: blocked.get(site.id) ?? 0,
        protection: s.security.siteStatus(site),
        scanEnabled: s.malwareScan.settingsFor(site.id).enabled,
        lastScanOutcome: last && last.status !== 'running' ? (last.status as ScanOutcome) : (status?.lastOutcome as ScanOutcome | undefined) ?? null,
        lastScanAt: last?.finishedAt ?? status?.lastFinishedAt ?? null,
        scanActive: activeScans.includes(site.id),
        openFindings: status?.openFindings ?? 0,
        openConfirmed: status?.openConfirmed ?? 0,
        quarantined: status?.quarantined ?? 0,
      };
    });
  return {
    fleet,
    fleetPolicy: effectivePolicy(fleet, { level: null, overrides: {}, customRules: [] }),
    sites: rows,
    servers: serverRows.map((r) => {
      const st = s.security.serverStatus(r.id);
      return { serverId: r.id, serverName: r.name, state: st.state, message: st.message, syncedAt: st.syncedAt };
    }),
    blocked24h: [...blocked.values()].reduce((a, b) => a + b, 0),
    activeBlocks: s.blocklist.activeCount(now),
    recentBlocked: s.securityEvents.recent({ limit: 50 }),
    scansInFlight: activeScans.length,
  };
}

/** Every site's scans, for the fleet's Scans list. */
export function fleetScans(s: Deps): { items: ({ slug: string; title: string; serverName: string | null } & SiteScanDto)[] } {
  const serverName = new Map(s.db.select({ id: servers.id, name: servers.name }).from(servers).all().map((r) => [r.id, r.name]));
  return {
    items: s.db
      .select()
      .from(sites)
      .where(hostedSites())
      .orderBy(sites.slug)
      .all()
      .map((site) => ({ slug: site.slug, title: site.title, serverName: serverName.get(site.serverId) ?? null, ...siteScanDto(s, site) })),
  };
}

/** The last scans of a site, newest first. */
export function scanHistory(s: Pick<Deps, 'db'>, siteId: number, limit = 20): ScanDto[] {
  return s.db.select().from(siteScans).where(eq(siteScans.siteId, siteId)).orderBy(desc(siteScans.startedAt)).limit(limit).all().map(scanDto);
}
