import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { siteWpComponents, siteWpStatus, vulnFeed, type VulnFeedRow } from '../db/schema.js';
import type { WpComponentKind } from '../../shared/schemas.js';
import type { FeedCoverage, VulnerabilityDto, VulnSeverity } from '../../shared/types.js';
import { matchRange, type VersionRange } from '../lib/wpVersions.js';
import { cleanText } from './wporg.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';

const API_BASE = 'https://www.wpvulnerability.net';
/** A slug's answer is good for a day; advisories are published, not streamed. */
const TTL_MS = 24 * 3600_000;
/** A failed lookup is retried sooner than that, but not on every scan. */
const ERROR_TTL_MS = 3600_000;
const TIMEOUT_MS = 15_000;
/**
 * Four at a time. The API is free, asks for no key and publishes no rate limit, only
 * "use it reasonably" - and a fleet needs a couple of hundred slugs a day, so there is
 * nothing to gain by going wider and a relationship to lose.
 */
const CONCURRENCY = 4;

export interface VulnRef {
  kind: WpComponentKind;
  /** For `core`, the WordPress version - that endpoint is version-scoped. */
  slug: string;
}

export const refKey = (kind: string, slug: string): string => `${kind}:${slug}`;

/** One advisory, reduced to what the panel renders and matches on. */
export interface StoredAdvisory {
  id: string;
  title: string;
  severity: VulnSeverity;
  cvss: number | null;
  range: VersionRange;
  /** The feed says no fixed release exists yet. */
  unfixed: boolean;
  /** First release carrying the fix, when the advisory's upper bound names one. */
  fixedIn: string | null;
  cves: string[];
  link: string | null;
  publishedAt: number | null;
}

export interface RefreshResult {
  fetched: number;
  failed: number;
  skipped: number;
  /**
   * The refs whose answer actually changed hands. A feed entry is shared by every site
   * with that slug installed, so the caller has to know which ones to recount.
   */
  refreshed: VulnRef[];
}

export interface FeedVerdict {
  vulnerabilities: VulnerabilityDto[];
  worstSeverity: VulnSeverity | null;
  closedOnWporg: boolean;
  closedReason: string | null;
  coverage: FeedCoverage;
}

const SEVERITY_RANK: Record<VulnSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/** The more serious of two severities, `null` meaning "nothing known". */
export function worseSeverity(a: VulnSeverity | null, b: VulnSeverity | null): VulnSeverity | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** `c`/`h`/`m`/`l` (cvss v2 style) and the spelled-out cvss3 words, plus a score fallback. */
function normalizeSeverity(impact: unknown): { severity: VulnSeverity; cvss: number | null } {
  // `impact` is an object when the advisory has scoring and an empty ARRAY when it has
  // none - PHP serializes an empty associative array as `[]` - so it cannot be trusted
  // to be indexable.
  const obj = impact && typeof impact === 'object' && !Array.isArray(impact) ? (impact as Record<string, unknown>) : {};
  const cvss3 = obj.cvss3 && typeof obj.cvss3 === 'object' ? (obj.cvss3 as Record<string, unknown>) : {};
  const cvss = obj.cvss && typeof obj.cvss === 'object' ? (obj.cvss as Record<string, unknown>) : {};
  const score = Number(cvss3.score ?? cvss.score);
  const scoreValue = Number.isFinite(score) && score > 0 ? Math.round(score * 10) / 10 : null;

  const word = String(cvss3.severity ?? '').toLowerCase();
  if (word === 'critical' || word === 'high' || word === 'medium' || word === 'low') {
    return { severity: word, cvss: scoreValue };
  }
  const letter = String(cvss.severity ?? '').toLowerCase();
  const byLetter: Record<string, VulnSeverity> = { c: 'critical', h: 'high', m: 'medium', l: 'low' };
  if (byLetter[letter]) return { severity: byLetter[letter]!, cvss: scoreValue };
  // No verdict, but a score: CVSS v3's own bands, so "9.8" never renders as "unknown".
  if (scoreValue !== null) {
    const derived: VulnSeverity =
      scoreValue >= 9 ? 'critical' : scoreValue >= 7 ? 'high' : scoreValue >= 4 ? 'medium' : 'low';
    return { severity: derived, cvss: scoreValue };
  }
  return { severity: 'unknown', cvss: null };
}

interface FeedSource {
  id?: unknown;
  name?: unknown;
  link?: unknown;
  date?: unknown;
}

/**
 * A readable headline. The entry's own `name` is machine-made ("Contact Form 7
 * [contact-form-7] < 5.3.2", or bare "6.8.2" for core), while the sources carry the
 * sentence a human wrote - so prefer a source name that is not just a CVE identifier.
 */
function advisoryTitle(entry: { name?: unknown }, sources: FeedSource[]): string {
  for (const source of sources) {
    const name = cleanText(typeof source.name === 'string' ? source.name : '');
    if (name && !/^CVE-\d{4}-\d+$/i.test(name)) return name.slice(0, 300);
  }
  const fallback = cleanText(typeof entry.name === 'string' ? entry.name : '');
  return (fallback || 'Known vulnerability').slice(0, 300);
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Turn one feed entry into the row the panel stores. Exported for the tests. */
export function normalizeAdvisory(entry: Record<string, unknown>, index: number): StoredAdvisory {
  const sources = Array.isArray(entry.source) ? (entry.source as FeedSource[]) : [];
  const operator =
    entry.operator && typeof entry.operator === 'object' ? (entry.operator as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const range: VersionRange = {
    minVersion: str(operator.min_version),
    minOperator: str(operator.min_operator),
    maxVersion: str(operator.max_version),
    maxOperator: str(operator.max_operator),
  };
  const unfixed = String(operator.unfixed ?? '0') === '1';
  // `max_operator: "lt"` means "affected below X", so X is the first release with the fix.
  // `le` only says the fix came after X, which is not a version anybody can install.
  const fixedIn: string | null = !unfixed && range.maxOperator === 'lt' ? range.maxVersion ?? null : null;
  const { severity, cvss } = normalizeSeverity(entry.impact);
  const cves = [
    ...new Set(
      sources
        .map((s) => (typeof s.id === 'string' ? s.id : ''))
        .filter((id) => /^CVE-\d{4}-\d+$/i.test(id))
        .map((id) => id.toUpperCase()),
    ),
  ];
  const link =
    sources.map((s) => (typeof s.link === 'string' ? s.link : '')).find((l) => l.startsWith('http')) ?? null;
  const dates = sources.map((s) => parseDate(s.date)).filter((d): d is number => d !== null);
  return {
    id: typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `advisory-${index}`,
    title: advisoryTitle(entry, sources),
    severity,
    cvss,
    range,
    unfixed,
    fixedIn,
    cves,
    link,
    publishedAt: dates.length > 0 ? Math.min(...dates) : null,
  };
}

interface FetchedSlug {
  known: boolean;
  closed: boolean;
  closedReason: string | null;
  latestReleaseAt: number | null;
  advisories: StoredAdvisory[];
}

function parseEnvelope(kind: WpComponentKind, body: unknown): FetchedSlug {
  const envelope = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (Number(envelope.error ?? 0) !== 0) {
    throw new Error(String(envelope.message ?? 'the feed reported an error'));
  }
  const data = envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : null;
  if (!data) throw new Error('the feed returned no data object');
  // A plugin/theme the feed has never heard of comes back with `name: null` - which is
  // "no data", not "no vulnerabilities". Core is keyed by version instead of by name.
  const known = kind === 'core' ? typeof data.core === 'string' : typeof data.name === 'string' && data.name !== '';
  const list = Array.isArray(data.vulnerability) ? (data.vulnerability as Record<string, unknown>[]) : [];
  const latest = Number(data.latest);
  return {
    known,
    closed: Boolean(Number(data.closed ?? 0)),
    closedReason: typeof data.closed_reason === 'string' ? data.closed_reason : null,
    // `latest` is a unix timestamp of the last release, not a version number.
    latestReleaseAt: Number.isFinite(latest) && latest > 0 ? latest * 1000 : null,
    advisories: list.map(normalizeAdvisory),
  };
}

export interface VulnerabilityFeedOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  ttlMs?: number;
  errorTtlMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

/**
 * The panel's cache of wpvulnerability.net, and the matcher that turns it into a verdict
 * for an installed version.
 *
 * What leaves the box: a plugin/theme slug or a WordPress version, once per slug per day.
 * Never a site name, a domain or an address - and not at all when `wp.vulnerabilityFeed`
 * is off, which is why that switch exists (docs/updates.md says so in the UI too).
 */
export class VulnerabilityFeedService {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    opts: VulnerabilityFeedOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.errorTtlMs = opts.errorTtlMs ?? ERROR_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.concurrency = opts.concurrency ?? CONCURRENCY;
    this.now = opts.now ?? Date.now;
  }

  /** Unset defaults to on; an operator who switched it off gets a hard `false`. */
  get enabled(): boolean {
    return this.settings.get('vulnerabilityFeed') !== false;
  }

  /** Newest successful fetch in the cache - what the UI calls "refreshed N ago". */
  refreshedAt(): number | null {
    const row = this.db
      .select({ latest: sql<number | null>`max(${vulnFeed.fetchedAt})` })
      .from(vulnFeed)
      .where(isNotNull(vulnFeed.fetchedAt))
      .get();
    return row?.latest ?? null;
  }

  loadRows(refs: VulnRef[]): Map<string, VulnFeedRow> {
    const out = new Map<string, VulnFeedRow>();
    const kinds = [...new Set(refs.map((r) => r.kind))];
    if (kinds.length === 0) return out;
    const slugs = [...new Set(refs.map((r) => r.slug))];
    // One query per kind with an IN list, rather than one per slug: a fleet read touches
    // a few hundred slugs and this is on the path of every page load.
    for (const kind of kinds) {
      const wanted = new Set(refs.filter((r) => r.kind === kind).map((r) => r.slug));
      for (const chunk of chunked(slugs.filter((s) => wanted.has(s)), 400)) {
        for (const row of this.db
          .select()
          .from(vulnFeed)
          .where(and(eq(vulnFeed.kind, kind), inArray(vulnFeed.slug, chunk)))
          .all()) {
          out.set(refKey(row.kind, row.slug), row);
        }
      }
    }
    return out;
  }

  /** Verdict for one component; `loadRows` + `verdictFrom` when doing many at once. */
  verdictFor(kind: WpComponentKind, slug: string, installedVersion: string | null): FeedVerdict {
    const row = this.db
      .select()
      .from(vulnFeed)
      .where(and(eq(vulnFeed.kind, kind), eq(vulnFeed.slug, slug)))
      .get();
    return this.verdictFrom(row, installedVersion);
  }

  /** Pure: a cached row plus an installed version become what the UI shows. */
  verdictFrom(row: VulnFeedRow | undefined, installedVersion: string | null): FeedVerdict {
    if (!this.enabled) {
      return { vulnerabilities: [], worstSeverity: null, closedOnWporg: false, closedReason: null, coverage: 'off' };
    }
    if (!row) {
      return {
        vulnerabilities: [],
        worstSeverity: null,
        closedOnWporg: false,
        closedReason: null,
        coverage: 'pending',
      };
    }
    let advisories: StoredAdvisory[] = [];
    try {
      advisories = JSON.parse(row.advisories) as StoredAdvisory[];
    } catch {
      advisories = [];
    }
    const vulnerabilities: VulnerabilityDto[] = [];
    let worst: VulnSeverity | null = null;
    for (const advisory of advisories) {
      const verdict = matchRange(installedVersion, advisory.range ?? {});
      if (verdict === 'no-match') continue;
      vulnerabilities.push({
        id: advisory.id,
        title: advisory.title,
        severity: advisory.severity,
        cvss: advisory.cvss,
        fixedIn: advisory.fixedIn,
        unfixed: advisory.unfixed,
        cves: advisory.cves ?? [],
        link: advisory.link,
        publishedAt: advisory.publishedAt,
        versionMatch: verdict === 'match' ? 'match' : 'unknown',
      });
      worst = worseSeverity(worst, advisory.severity);
    }
    vulnerabilities.sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.cvss ?? 0) - (a.cvss ?? 0),
    );
    return {
      vulnerabilities,
      worstSeverity: worst,
      closedOnWporg: row.closed === 1,
      closedReason: row.closedReason,
      coverage: this.coverageOf(row),
    };
  }

  private coverageOf(row: VulnFeedRow): FeedCoverage {
    if (row.fetchedAt === null) return 'error';
    if (row.error) return 'error';
    if (this.now() - row.fetchedAt > this.ttlMs) return 'stale';
    return row.known === 1 ? 'known' : 'unknown';
  }

  private isStale(row: VulnFeedRow | undefined): boolean {
    if (!row) return true;
    if (row.error || row.fetchedAt === null) return this.now() - row.attemptedAt > this.errorTtlMs;
    return this.now() - row.fetchedAt > this.ttlMs;
  }

  /**
   * Fetch the refs whose cached answer is missing or past its TTL. Failures are isolated
   * per slug (the rest of the refresh still lands) and never throw: a feed having a bad
   * afternoon must not fail the scan job it is attached to.
   */
  async refresh(refs: VulnRef[], opts: { force?: boolean } = {}): Promise<RefreshResult> {
    if (!this.enabled) return { fetched: 0, failed: 0, skipped: refs.length, refreshed: [] };
    const unique = new Map<string, VulnRef>();
    for (const ref of refs) {
      if (!ref.slug) continue;
      unique.set(refKey(ref.kind, ref.slug), ref);
    }
    const existing = this.loadRows([...unique.values()]);
    const due = [...unique.values()].filter(
      (ref) => opts.force || this.isStale(existing.get(refKey(ref.kind, ref.slug))),
    );
    let failed = 0;
    const refreshed: VulnRef[] = [];
    const queue = [...due];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
        try {
          const data = await this.fetchSlug(ref);
          this.upsertSuccess(ref, data);
          refreshed.push(ref);
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          this.upsertFailure(ref, message);
          this.log.warn(`Vulnerability feed: ${ref.kind} "${ref.slug}" lookup failed (${message})`);
        }
      }
    });
    await Promise.all(workers);
    return { fetched: refreshed.length, failed, skipped: unique.size - due.length, refreshed };
  }

  private async fetchSlug(ref: VulnRef): Promise<FetchedSlug> {
    const url = `${this.baseUrl}/${ref.kind}/${encodeURIComponent(ref.slug)}/`;
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'wpl7-panel' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    return parseEnvelope(ref.kind, body);
  }

  private upsertSuccess(ref: VulnRef, data: FetchedSlug): void {
    const now = this.now();
    const values = {
      kind: ref.kind,
      slug: ref.slug,
      fetchedAt: now,
      attemptedAt: now,
      error: null,
      known: data.known ? 1 : 0,
      closed: data.closed ? 1 : 0,
      closedReason: data.closedReason ?? null,
      latestReleaseAt: data.latestReleaseAt,
      advisories: JSON.stringify(data.advisories),
    };
    this.db
      .insert(vulnFeed)
      .values(values)
      .onConflictDoUpdate({ target: [vulnFeed.kind, vulnFeed.slug], set: values })
      .run();
  }

  /**
   * Record the failure without dropping the previous answer: stale-if-error. A slug that
   * has never been fetched gets a row anyway, so the next scan backs off instead of
   * re-trying a dead endpoint for every site that has the plugin installed.
   */
  private upsertFailure(ref: VulnRef, message: string): void {
    const now = this.now();
    this.db
      .insert(vulnFeed)
      .values({
        kind: ref.kind,
        slug: ref.slug,
        fetchedAt: null,
        attemptedAt: now,
        error: message.slice(0, 500),
        known: 0,
        closed: 0,
        closedReason: null,
        latestReleaseAt: null,
        advisories: '[]',
      })
      .onConflictDoUpdate({
        target: [vulnFeed.kind, vulnFeed.slug],
        set: { attemptedAt: now, error: message.slice(0, 500) },
      })
      .run();
  }

  /** Every slug the snapshot currently references, including each distinct core version. */
  referencedRefs(): VulnRef[] {
    const components = this.db
      .selectDistinct({ kind: siteWpComponents.kind, slug: siteWpComponents.slug })
      .from(siteWpComponents)
      .all();
    const cores = this.db
      .selectDistinct({ version: siteWpStatus.coreVersion })
      .from(siteWpStatus)
      .where(isNotNull(siteWpStatus.coreVersion))
      .all();
    return [
      ...components.map((c) => ({ kind: c.kind as WpComponentKind, slug: c.slug })),
      ...cores.filter((c) => c.version).map((c) => ({ kind: 'core' as const, slug: c.version! })),
    ];
  }

  /** Refresh whatever the fleet still has installed; used by the nightly maintenance run. */
  async refreshReferenced(opts: { force?: boolean } = {}): Promise<RefreshResult> {
    return this.refresh(this.referencedRefs(), opts);
  }

  /** Drop cached answers for slugs no site has any more. Returns how many rows went. */
  pruneUnreferenced(): number {
    const keep = new Set(this.referencedRefs().map((r) => refKey(r.kind, r.slug)));
    let removed = 0;
    for (const row of this.db.select({ kind: vulnFeed.kind, slug: vulnFeed.slug }).from(vulnFeed).all()) {
      if (keep.has(refKey(row.kind, row.slug))) continue;
      this.db.delete(vulnFeed).where(and(eq(vulnFeed.kind, row.kind), eq(vulnFeed.slug, row.slug))).run();
      removed++;
    }
    return removed;
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
