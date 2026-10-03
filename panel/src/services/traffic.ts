import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  siteTraffic,
  siteTrafficCrawlers,
  siteTrafficIps,
  siteTrafficPaths,
  siteTrafficReferrers,
  siteVisitors,
  sites,
} from '../db/schema.js';
import { generateSecret, sha256Hex } from '../lib/crypto.js';
import {
  crawlerName,
  isBotUserAgent,
  isPageView,
  normalizePath,
  parseAccessLog,
  type AccessEvent,
} from '../lib/accessLog.js';
import { isPrivateAddress } from '../lib/ip.js';
import type { TrustedProxy } from '../lib/clientIp.js';
import type { GeoIpService } from './geoip.js';
import type { ServerRegistry } from '../servers/registry.js';
import { TRAEFIK_CONTAINER } from './stack.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import type { SiteTrafficDto, SiteTrafficPoint } from '../../shared/types.js';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** `docker logs --since` has one-second resolution, so re-read a few seconds every tick. */
const INGEST_OVERLAP_MS = 5_000;
/** First-ever ingest for a server reaches back this far, so a fresh panel is not empty. */
const INGEST_COLD_START_MS = 6 * HOUR_MS;
/** Hard cap per tick so a traffic spike cannot blow up panel memory. */
const INGEST_MAX_LINES = 50_000;
/**
 * Distinct paths kept per site per day. A vulnerability scanner walks thousands of URLs
 * that exist nowhere; without a ceiling the "top pages" table would be mostly its work.
 */
const MAX_PATHS_PER_DAY = 500;
const MAX_REFERRERS_PER_DAY = 200;
const MAX_CRAWLERS_PER_DAY = 200;
/**
 * Distinct addresses kept per site per day. Higher than the other ceilings because the
 * list's whole purpose is spotting an address that stands out, and a botnet spraying from
 * thousands of sources is exactly the case it has to survive.
 */
const MAX_IPS_PER_DAY = 2_000;

const floorTo = (ts: number, size: number) => Math.floor(ts / size) * size;

interface IpRow {
  siteId: number;
  day: number;
  ip: string;
  requests: number;
  pageViews: number;
  botRequests: number;
  errors: number;
  country: string | null;
  lastSeenAt: number;
}

/** Per-server ingest position: the last event consumed, so the overlap replays nothing. */
interface TrafficCursor {
  ts: number;
  /** Traefik's request counter at `ts`; disambiguates events sharing a timestamp. */
  count: number;
}

/**
 * Per-site visitor statistics, reconstructed from each server's Traefik access log.
 *
 * Shaped after MailService: a scheduler tick pulls new log lines through `docker logs`,
 * parses them (lib/accessLog.ts) and folds them into counters - never a row per request.
 *
 * The audience half is anonymous by construction: visitors are salted hashes that cannot be
 * reversed and are re-salted nightly (see `visitorId`). The operational half - the per-address
 * counters behind "top addresses" - is the exception, deliberately kept on its own short
 * retention and switchable off (`trafficStoreIps`), because "who is hammering this site" is
 * not a question an anonymised counter can answer.
 */
export class TrafficService {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly geoip: GeoIpService,
    /**
     * The proxies whose visitor header is believed (services/proxyRanges.ts). Behind one, the
     * visitor is the address the proxy vouched for - without this, every visitor of a site
     * behind Cloudflare was one of a few dozen Cloudflare servers, in any country Cloudflare
     * happened to route them through.
     */
    private readonly proxies: () => readonly TrustedProxy[] = () => [],
  ) {
    this.bootCursors = this.cursors();
  }

  /** Where the ingest stood when this panel started: what it had read before the restart. */
  private readonly bootCursors: Record<string, TrafficCursor>;

  /**
   * Told about every batch of requests read from a server's log, with the raw chunk: the
   * requests Security blocked are counted from the same read, and so is attack detection.
   * A listener that throws is logged and skipped - never the statistics' problem.
   */
  private readonly listeners: ((serverId: number, events: AccessEvent[], chunk: string) => void)[] = [];

  onEvents(listener: (serverId: number, events: AccessEvent[], chunk: string) => void): void {
    this.listeners.push(listener);
  }

  /** False = addresses are not written down at all; the rest of the statistics carry on. */
  private get storeIps(): boolean {
    return this.settings.get('trafficStoreIps') !== false;
  }

  // -------------------------------------------------------------- visitor identity

  /**
   * Stable-for-a-day, anonymous id for one visitor of one site.
   *
   * The salt is random, per day, and never leaves the panel database, so the hash cannot be
   * reversed to an address even by whoever holds the file - and because it changes at
   * midnight, the same person on two days is two unrelated ids. The site slug is mixed in
   * as well, so a visitor cannot be followed from one customer's site to another's. That is
   * what makes this countable without asking anybody for consent.
   */
  private saltCache = new Map<number, string>();

  private saltFor(dayMs: number): string {
    // Memoized: this is called once per page view, and a busy minute is thousands of them.
    const cached = this.saltCache.get(dayMs);
    if (cached) return cached;
    const store = (this.settings.getRaw('traffic.visitorSalts') as Record<string, string> | undefined) ?? {};
    const key = String(dayMs);
    const existing = store[key];
    if (existing) {
      this.saltCache.set(dayMs, existing);
      return existing;
    }
    const salt = generateSecret(32);
    // Yesterday is kept so a tick that crosses midnight still hashes late events under the
    // salt their own day used; everything older is dropped, which is the point of rotating.
    const keep: Record<string, string> = { [key]: salt };
    const yesterday = String(dayMs - DAY_MS);
    if (store[yesterday]) keep[yesterday] = store[yesterday];
    this.settings.setRaw('traffic.visitorSalts', keep);
    // The rotation dropped everything but today and yesterday; the cache has to follow, or
    // a long-running panel would keep hashing under a salt the database no longer holds.
    for (const day of [...this.saltCache.keys()]) {
      if (day !== dayMs && day !== dayMs - DAY_MS) this.saltCache.delete(day);
    }
    this.saltCache.set(dayMs, salt);
    return salt;
  }

  private visitorId(slug: string, event: AccessEvent, dayMs: number): string {
    return sha256Hex(`${this.saltFor(dayMs)}|${slug}|${event.clientIp}|${event.userAgent}`).slice(0, 16);
  }

  // ------------------------------------------------------------------- log ingest

  private cursors(): Record<string, TrafficCursor> {
    return (this.settings.getRaw('traffic.logCursor') as Record<string, TrafficCursor> | undefined) ?? {};
  }

  private setCursor(serverId: number, cursor: TrafficCursor): void {
    this.settings.setRaw('traffic.logCursor', { ...this.cursors(), [serverId]: cursor });
  }

  /** Last time an access-log line was actually seen, per server; drives `collecting`. */
  private seenAt(): Record<string, number> {
    return (this.settings.getRaw('traffic.accessLogSeenAt') as Record<string, number> | undefined) ?? {};
  }

  /**
   * Read every server's new log lines. `stats: false` reads them for the listeners alone -
   * what Security does while Visitor statistics is paused, so detection keeps working.
   */
  async ingestTick(opts: { stats?: boolean } = {}): Promise<void> {
    for (const row of this.servers.listRows()) {
      if (row.status === 'unreachable') continue;
      try {
        await this.ingestServer(row.id, opts);
      } catch (err) {
        this.log.warn(
          `Access log ingest for server "${row.name}" failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * The requests a server's log holds since `sinceMs` that the ingest had consumed before this
   * panel started - for attack detection to rebuild its counts after a restart, without
   * counting anything twice. Reads, never moves the cursor.
   */
  async readBeforeBoot(serverId: number, sinceMs: number): Promise<AccessEvent[]> {
    const cursor = this.bootCursors[serverId];
    if (!cursor) return [];
    const handle = this.servers.handleFor(serverId);
    if ((await handle.docker.containerState(TRAEFIK_CONTAINER)) !== 'running') return [];
    const chunk = await handle.docker.containerLogs(TRAEFIK_CONTAINER, { sinceSec: Math.floor(sinceMs / 1000), tail: INGEST_MAX_LINES });
    return parseAccessLog(chunk, Date.now(), this.proxies()).filter(
      (e) => e.ts >= sinceMs && (e.ts < cursor.ts || (e.ts === cursor.ts && e.requestCount <= cursor.count)),
    );
  }

  async ingestServer(serverId: number, opts: { stats?: boolean } = {}): Promise<{ events: number }> {
    const handle = this.servers.handleFor(serverId);
    if ((await handle.docker.containerState(TRAEFIK_CONTAINER)) !== 'running') return { events: 0 };

    const readAt = Date.now();
    const cursor = this.cursors()[serverId] ?? { ts: readAt - INGEST_COLD_START_MS, count: 0 };
    // The cursor only moves when an event is consumed, so on a site nobody visits it stands
    // still - and reading `--since <last request>` would ask for a window that grows by a
    // minute every minute, forever. Cap the look-back at the cold-start bound: past that
    // there is nothing to catch up on anyway, and the read stays cheap.
    const sinceMs = Math.max(cursor.ts - INGEST_OVERLAP_MS, readAt - INGEST_COLD_START_MS);
    const sinceSec = Math.max(0, Math.floor(sinceMs / 1000));

    const chunk = await handle.docker.containerLogs(TRAEFIK_CONTAINER, { sinceSec, tail: INGEST_MAX_LINES });
    const all = parseAccessLog(chunk, readAt, this.proxies());
    if (all.length > 0) {
      this.settings.setRaw('traffic.accessLogSeenAt', { ...this.seenAt(), [serverId]: readAt });
    }

    // Counters are incremented, not upserted by key, so replaying a line would inflate them.
    // Within one Traefik process RequestCount strictly increases and StartUTC never goes
    // backwards, so this pair identifies exactly the events not yet consumed. A restarted
    // Traefik counts from zero again, which the timestamp half still orders correctly.
    const fresh = all.filter(
      (e) => e.ts > cursor.ts || (e.ts === cursor.ts && e.requestCount > cursor.count),
    );
    if (fresh.length > 0) {
      const last = fresh.reduce((a, b) => (b.ts > a.ts || (b.ts === a.ts && b.requestCount > a.requestCount) ? b : a));
      if (opts.stats !== false) this.apply(fresh);
      this.setCursor(serverId, { ts: last.ts, count: last.requestCount });
    } else if (all.length === 0) {
      // Nothing was logged at all (an idle server, or access logging not switched on yet).
      // Move the cursor up anyway so the next read does not re-scan a growing window.
      this.setCursor(serverId, { ts: readAt, count: 0 });
    }
    for (const listener of this.listeners) {
      try {
        listener(serverId, fresh, chunk);
      } catch (err) {
        this.log.warn(`Access log listener failed for server #${serverId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { events: fresh.length };
  }

  /** Fold a batch of parsed requests into the rollup tables, in one transaction. */
  private apply(events: AccessEvent[]): void {
    const siteIdBySlug = new Map(
      this.db.select({ id: sites.id, slug: sites.slug }).from(sites).all().map((r) => [r.slug, r.id]),
    );

    interface Bucket {
      requests: number;
      pageViews: number;
      botRequests: number;
      errors: number;
      bytes: number;
      durationMsSum: number;
    }
    const hours = new Map<string, Bucket & { siteId: number; ts: number }>();
    const visitors = new Map<string, { siteId: number; ts: number; visitor: string; country: string | null }>();
    const paths = new Map<string, { siteId: number; day: number; path: string; views: number }>();
    const referrers = new Map<string, { siteId: number; day: number; referrer: string; views: number }>();
    const crawlers = new Map<string, { siteId: number; day: number; crawler: string; requests: number; lastSeenAt: number }>();
    const ips = new Map<string, IpRow>();
    const storeIps = this.storeIps;

    for (const event of events) {
      if (!event.slug) continue; // the panel, the dashboard, a host matching no router
      const siteId = siteIdBySlug.get(event.slug);
      if (siteId === undefined) continue; // a site deleted since it was served
      const bot = isBotUserAgent(event.userAgent);
      // The panel's own uptime probe is not traffic; it is the panel looking at itself.
      // LEGACY(ceo) - delete `ceo-panel-probe` in 0.3.0, once no unread access log predates
      // the rename.
      if (bot && /wpl7-probe|ceo-panel-probe/i.test(event.userAgent)) continue;

      const hour = floorTo(event.ts, HOUR_MS);
      const day = floorTo(event.ts, DAY_MS);
      const hourKey = `${siteId}:${hour}`;
      let bucket = hours.get(hourKey);
      if (!bucket) {
        bucket = { siteId, ts: hour, requests: 0, pageViews: 0, botRequests: 0, errors: 0, bytes: 0, durationMsSum: 0 };
        hours.set(hourKey, bucket);
      }
      bucket.requests++;
      bucket.bytes += event.bytes;
      bucket.durationMsSum += event.durationMs;
      const serverError = event.status >= 500;
      if (serverError) bucket.errors++;

      // Resolved once per request and reused for the visitor row and the address row.
      const country = this.geoip.lookup(event.clientIp);
      const page = !bot && isPageView(event);

      if (storeIps && event.clientIp && !isPrivateAddress(event.clientIp)) {
        const ipKey = `${siteId}:${day}:${event.clientIp}`;
        let row = ips.get(ipKey);
        if (!row) {
          row = { siteId, day, ip: event.clientIp, requests: 0, pageViews: 0, botRequests: 0, errors: 0, country, lastSeenAt: 0 };
          ips.set(ipKey, row);
        }
        row.requests++;
        if (page) row.pageViews++;
        if (bot) row.botRequests++;
        if (serverError) row.errors++;
        if (event.ts > row.lastSeenAt) row.lastSeenAt = event.ts;
      }

      if (bot) {
        bucket.botRequests++;
        const name = crawlerName(event.userAgent);
        const crawlerKey = `${siteId}:${day}:${name}`;
        const row = crawlers.get(crawlerKey);
        if (row) {
          row.requests++;
          if (event.ts > row.lastSeenAt) row.lastSeenAt = event.ts;
        } else {
          crawlers.set(crawlerKey, { siteId, day, crawler: name, requests: 1, lastSeenAt: event.ts });
        }
        continue; // a crawler is not a visitor, a page view or a referral
      }
      if (!page) continue;

      bucket.pageViews++;
      const visitor = this.visitorId(event.slug, event, day);
      const visitorKey = `${siteId}:${hour}:${visitor}`;
      // First sighting in the hour wins the country; the same person does not move between
      // requests, and a later unresolved lookup must not blank an earlier resolved one.
      if (!visitors.has(visitorKey)) visitors.set(visitorKey, { siteId, ts: hour, visitor, country });

      const pathKey = `${siteId}:${day}:${normalizePath(event.path)}`;
      const pathRow = paths.get(pathKey);
      if (pathRow) pathRow.views++;
      else paths.set(pathKey, { siteId, day, path: normalizePath(event.path), views: 1 });

      const refKey = `${siteId}:${day}:${event.referrerHost}`;
      const refRow = referrers.get(refKey);
      if (refRow) refRow.views++;
      else referrers.set(refKey, { siteId, day, referrer: event.referrerHost, views: 1 });
    }

    if (hours.size === 0) return;

    this.db.transaction(() => {
      for (const b of hours.values()) {
        this.db
          .insert(siteTraffic)
          .values(b)
          .onConflictDoUpdate({
            target: [siteTraffic.siteId, siteTraffic.ts],
            set: {
              requests: sql`${siteTraffic.requests} + ${b.requests}`,
              pageViews: sql`${siteTraffic.pageViews} + ${b.pageViews}`,
              botRequests: sql`${siteTraffic.botRequests} + ${b.botRequests}`,
              errors: sql`${siteTraffic.errors} + ${b.errors}`,
              bytes: sql`${siteTraffic.bytes} + ${b.bytes}`,
              durationMsSum: sql`${siteTraffic.durationMsSum} + ${b.durationMsSum}`,
            },
          })
          .run();
      }
      for (const v of visitors.values()) {
        this.db.insert(siteVisitors).values(v).onConflictDoNothing().run();
      }
      this.applyPaths([...paths.values()]);
      this.applyReferrers([...referrers.values()]);
      this.applyCrawlers([...crawlers.values()]);
      this.applyIps([...ips.values()]);
    });
  }

  /** Same ceiling rule as `applyPaths`, for crawler names. */
  private applyCrawlers(rows: { siteId: number; day: number; crawler: string; requests: number; lastSeenAt: number }[]): void {
    const known = this.knownKeys(rows, (siteId, day) =>
      this.db
        .select({ crawler: siteTrafficCrawlers.crawler })
        .from(siteTrafficCrawlers)
        .where(and(eq(siteTrafficCrawlers.siteId, siteId), eq(siteTrafficCrawlers.day, day)))
        .all()
        .map((r) => r.crawler),
    );
    for (const row of rows) {
      const seen = known.get(`${row.siteId}:${row.day}`)!;
      if (!seen.has(row.crawler)) {
        if (seen.size >= MAX_CRAWLERS_PER_DAY) continue;
        seen.add(row.crawler);
      }
      this.db
        .insert(siteTrafficCrawlers)
        .values(row)
        .onConflictDoUpdate({
          target: [siteTrafficCrawlers.siteId, siteTrafficCrawlers.day, siteTrafficCrawlers.crawler],
          set: {
            requests: sql`${siteTrafficCrawlers.requests} + ${row.requests}`,
            lastSeenAt: sql`max(${siteTrafficCrawlers.lastSeenAt}, ${row.lastSeenAt})`,
          },
        })
        .run();
    }
  }

  /** Same ceiling rule again, for client addresses. */
  private applyIps(rows: IpRow[]): void {
    const known = this.knownKeys(rows, (siteId, day) =>
      this.db
        .select({ ip: siteTrafficIps.ip })
        .from(siteTrafficIps)
        .where(and(eq(siteTrafficIps.siteId, siteId), eq(siteTrafficIps.day, day)))
        .all()
        .map((r) => r.ip),
    );
    for (const row of rows) {
      const seen = known.get(`${row.siteId}:${row.day}`)!;
      if (!seen.has(row.ip)) {
        if (seen.size >= MAX_IPS_PER_DAY) continue;
        seen.add(row.ip);
      }
      this.db
        .insert(siteTrafficIps)
        .values(row)
        .onConflictDoUpdate({
          target: [siteTrafficIps.siteId, siteTrafficIps.day, siteTrafficIps.ip],
          set: {
            requests: sql`${siteTrafficIps.requests} + ${row.requests}`,
            pageViews: sql`${siteTrafficIps.pageViews} + ${row.pageViews}`,
            botRequests: sql`${siteTrafficIps.botRequests} + ${row.botRequests}`,
            errors: sql`${siteTrafficIps.errors} + ${row.errors}`,
            lastSeenAt: sql`max(${siteTrafficIps.lastSeenAt}, ${row.lastSeenAt})`,
            // A country only ever goes from unknown to known: a table refreshed after the
            // first sighting should fill the gap, not a failed lookup blank it.
            country: sql`coalesce(${siteTrafficIps.country}, ${row.country})`,
          },
        })
        .run();
    }
  }

  /**
   * Keys already stored for each site-day in the batch. Read once per day rather than per
   * row: the cap below needs to know both how full a day is and whether a key is new.
   */
  private knownKeys(
    rows: { siteId: number; day: number }[],
    read: (siteId: number, day: number) => string[],
  ): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const dayKey = `${row.siteId}:${row.day}`;
      if (!out.has(dayKey)) out.set(dayKey, new Set(read(row.siteId, row.day)));
    }
    return out;
  }

  /**
   * A *new* path is refused once a site-day is at its ceiling, while paths already on the
   * list keep counting — so a scanner's thousands of one-hit URLs get shed without the real
   * pages freezing the moment it shows up.
   */
  private applyPaths(rows: { siteId: number; day: number; path: string; views: number }[]): void {
    const known = this.knownKeys(rows, (siteId, day) =>
      this.db
        .select({ path: siteTrafficPaths.path })
        .from(siteTrafficPaths)
        .where(and(eq(siteTrafficPaths.siteId, siteId), eq(siteTrafficPaths.day, day)))
        .all()
        .map((r) => r.path),
    );
    for (const row of rows) {
      const seen = known.get(`${row.siteId}:${row.day}`)!;
      if (!seen.has(row.path)) {
        if (seen.size >= MAX_PATHS_PER_DAY) continue;
        seen.add(row.path);
      }
      this.db
        .insert(siteTrafficPaths)
        .values(row)
        .onConflictDoUpdate({
          target: [siteTrafficPaths.siteId, siteTrafficPaths.day, siteTrafficPaths.path],
          set: { views: sql`${siteTrafficPaths.views} + ${row.views}` },
        })
        .run();
    }
  }

  /** Same ceiling rule as `applyPaths`, for referring hosts. */
  private applyReferrers(rows: { siteId: number; day: number; referrer: string; views: number }[]): void {
    const known = this.knownKeys(rows, (siteId, day) =>
      this.db
        .select({ referrer: siteTrafficReferrers.referrer })
        .from(siteTrafficReferrers)
        .where(and(eq(siteTrafficReferrers.siteId, siteId), eq(siteTrafficReferrers.day, day)))
        .all()
        .map((r) => r.referrer),
    );
    for (const row of rows) {
      const seen = known.get(`${row.siteId}:${row.day}`)!;
      if (!seen.has(row.referrer)) {
        if (seen.size >= MAX_REFERRERS_PER_DAY) continue;
        seen.add(row.referrer);
      }
      this.db
        .insert(siteTrafficReferrers)
        .values(row)
        .onConflictDoUpdate({
          target: [siteTrafficReferrers.siteId, siteTrafficReferrers.day, siteTrafficReferrers.referrer],
          set: { views: sql`${siteTrafficReferrers.views} + ${row.views}` },
        })
        .run();
    }
  }

  // ---------------------------------------------------------------------- reading

  /**
   * Everything the site traffic view needs, in one read. Buckets by hour for short ranges
   * and by day beyond two, so the series stays a readable number of points either way.
   */
  siteTraffic(siteId: number, serverId: number, days: number): SiteTrafficDto {
    const bucket: 'hour' | 'day' = days <= 2 ? 'hour' : 'day';
    const size = bucket === 'hour' ? HOUR_MS : DAY_MS;
    const since = floorTo(Date.now() - days * DAY_MS, size);
    // Top pages and referrers are kept per calendar day, so an hour-floored bound would cut
    // off the day the window starts inside - a 24h view would list only today's pages.
    const sinceDay = floorTo(since, DAY_MS);

    const rows = this.db
      .select()
      .from(siteTraffic)
      .where(and(eq(siteTraffic.siteId, siteId), gte(siteTraffic.ts, since)))
      .orderBy(siteTraffic.ts)
      .all();

    // Daily uniques are the number that survives a long range: the hashing salt rotates at
    // midnight, so the same person on two days is two ids and cannot be - or be meant to
    // be - collapsed. Hour buckets count rows, which are already one per visitor per hour.
    const dailyUniques = this.dailyUniques(siteId, since);
    const perBucketVisitors = bucket === 'day' ? dailyUniques : this.hourlyUniques(siteId, since);

    const byBucket = new Map<number, { point: SiteTrafficPoint; durationSum: number }>();
    for (const row of rows) {
      const ts = floorTo(row.ts, size);
      let slot = byBucket.get(ts);
      if (!slot) {
        slot = { point: emptyPoint(ts), durationSum: 0 };
        byBucket.set(ts, slot);
      }
      slot.point.requests += row.requests;
      slot.point.pageViews += row.pageViews;
      slot.point.botRequests += row.botRequests;
      slot.point.errors += row.errors;
      slot.point.bytes += row.bytes;
      slot.durationSum += row.durationMsSum;
    }

    // Empty buckets are real information ("nobody came"), so the series is dense.
    const series: SiteTrafficPoint[] = [];
    for (let ts = since; ts <= floorTo(Date.now(), size); ts += size) {
      const slot = byBucket.get(ts);
      const point = slot?.point ?? emptyPoint(ts);
      point.visitors = perBucketVisitors.get(ts) ?? 0;
      if (slot && point.requests > 0) point.avgMs = Math.round(slot.durationSum / point.requests);
      series.push(point);
    }

    const sum = (pick: (p: SiteTrafficPoint) => number) => series.reduce((a, p) => a + pick(p), 0);
    const requests = sum((p) => p.requests);
    const durationSum = rows.reduce((a, r) => a + r.durationMsSum, 0);

    const seenAt = this.seenAt()[serverId];
    return {
      days,
      bucket,
      since,
      // "Has this server's Traefik ever emitted an access log line" - which separates a
      // genuinely quiet site from a stack that predates access logging being switched on.
      collecting: seenAt !== undefined || rows.length > 0,
      totals: {
        requests,
        pageViews: sum((p) => p.pageViews),
        // Daily uniques added up: across days the salt has rotated, so the same person on
        // two days is deliberately two ids and cannot be deduplicated - by design.
        visitors: [...dailyUniques.values()].reduce((a, b) => a + b, 0),
        botRequests: sum((p) => p.botRequests),
        errors: sum((p) => p.errors),
        bytes: sum((p) => p.bytes),
        avgMs: requests > 0 ? Math.round(durationSum / requests) : null,
      },
      series,
      topPages: this.db
        .select({ path: siteTrafficPaths.path, views: sql<number>`sum(${siteTrafficPaths.views})` })
        .from(siteTrafficPaths)
        .where(and(eq(siteTrafficPaths.siteId, siteId), gte(siteTrafficPaths.day, sinceDay)))
        .groupBy(siteTrafficPaths.path)
        .orderBy(desc(sql`sum(${siteTrafficPaths.views})`))
        .limit(10)
        .all(),
      topReferrers: this.db
        .select({ referrer: siteTrafficReferrers.referrer, views: sql<number>`sum(${siteTrafficReferrers.views})` })
        .from(siteTrafficReferrers)
        .where(
          and(
            eq(siteTrafficReferrers.siteId, siteId),
            gte(siteTrafficReferrers.day, sinceDay),
            // '' is the direct/unknown bucket; it is not a referrer and would top every list.
            sql`${siteTrafficReferrers.referrer} <> ''`,
          ),
        )
        .groupBy(siteTrafficReferrers.referrer)
        .orderBy(desc(sql`sum(${siteTrafficReferrers.views})`))
        .limit(10)
        .all(),
      topCountries: this.topCountries(siteId, since),
      topCrawlers: this.db
        .select({
          crawler: siteTrafficCrawlers.crawler,
          requests: sql<number>`sum(${siteTrafficCrawlers.requests})`,
          lastSeenAt: sql<number>`max(${siteTrafficCrawlers.lastSeenAt})`,
        })
        .from(siteTrafficCrawlers)
        .where(and(eq(siteTrafficCrawlers.siteId, siteId), gte(siteTrafficCrawlers.day, sinceDay)))
        .groupBy(siteTrafficCrawlers.crawler)
        .orderBy(desc(sql`sum(${siteTrafficCrawlers.requests})`))
        .limit(15)
        .all(),
      topIps: this.storeIps
        ? this.db
            .select({
              ip: siteTrafficIps.ip,
              requests: sql<number>`sum(${siteTrafficIps.requests})`,
              pageViews: sql<number>`sum(${siteTrafficIps.pageViews})`,
              botRequests: sql<number>`sum(${siteTrafficIps.botRequests})`,
              errors: sql<number>`sum(${siteTrafficIps.errors})`,
              country: sql<string | null>`max(${siteTrafficIps.country})`,
              lastSeenAt: sql<number>`max(${siteTrafficIps.lastSeenAt})`,
            })
            .from(siteTrafficIps)
            .where(and(eq(siteTrafficIps.siteId, siteId), gte(siteTrafficIps.day, sinceDay)))
            .groupBy(siteTrafficIps.ip)
            .orderBy(desc(sql`sum(${siteTrafficIps.requests})`))
            .limit(20)
            .all()
        : [],
      ipsCollected: this.storeIps,
      ipRetentionDays: this.settings.get('trafficIpRetentionDays') || 7,
      countryData: this.geoip.status().available,
    };
  }

  /**
   * Visitors per country. `count(distinct visitor)` over the visitor rows, so a reader who
   * came back every hour for a week is one person from one country - not 168 of them.
   * Unresolved addresses are left out rather than shown as a nameless bar.
   */
  private topCountries(siteId: number, since: number): { country: string; visitors: number }[] {
    return this.db
      .select({ country: siteVisitors.country, visitors: sql<number>`count(distinct ${siteVisitors.visitor})` })
      .from(siteVisitors)
      .where(and(eq(siteVisitors.siteId, siteId), gte(siteVisitors.ts, since), sql`${siteVisitors.country} is not null`))
      .groupBy(siteVisitors.country)
      .orderBy(desc(sql`count(distinct ${siteVisitors.visitor})`))
      .limit(15)
      .all()
      .map((r) => ({ country: r.country ?? '', visitors: Number(r.visitors) }));
  }

  /**
   * Distinct visitors per day, keyed by the start of the day. `count(distinct)` matters:
   * the table holds a row per hour a visitor was active, so somebody reading for three
   * hours is three rows and one person.
   */
  private dailyUniques(siteId: number, since: number): Map<number, number> {
    // CAST, not a bare `/`: better-sqlite3 binds every JavaScript number as a double, so
    // `ts / 86400000` is floating-point division and `(ts / 86400000) * 86400000` hands back
    // the timestamp it started with - a grouping that silently does nothing.
    const day = sql<number>`cast(${siteVisitors.ts} / ${DAY_MS} as integer) * ${DAY_MS}`;
    const out = new Map<number, number>();
    for (const row of this.db
      .select({ day, n: sql<number>`count(distinct ${siteVisitors.visitor})` })
      .from(siteVisitors)
      .where(and(eq(siteVisitors.siteId, siteId), gte(siteVisitors.ts, since)))
      .groupBy(day)
      .all()) {
      out.set(Number(row.day), Number(row.n));
    }
    return out;
  }

  /** Distinct visitors per hour. One row per (visitor, hour) already, so a plain count. */
  private hourlyUniques(siteId: number, since: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of this.db
      .select({ ts: siteVisitors.ts, n: sql<number>`count(*)` })
      .from(siteVisitors)
      .where(and(eq(siteVisitors.siteId, siteId), gte(siteVisitors.ts, since)))
      .groupBy(siteVisitors.ts)
      .all()) {
      out.set(Number(row.ts), Number(row.n));
    }
    return out;
  }

  /** Visitors and page views over the last 24h for every site, for the sites list. */
  recentBySite(): Map<number, { visitors: number; pageViews: number }> {
    const since = Date.now() - DAY_MS;
    const out = new Map<number, { visitors: number; pageViews: number }>();
    for (const row of this.db
      .select({ siteId: siteTraffic.siteId, pageViews: sql<number>`sum(${siteTraffic.pageViews})` })
      .from(siteTraffic)
      .where(gte(siteTraffic.ts, since))
      .groupBy(siteTraffic.siteId)
      .all()) {
      out.set(row.siteId, { visitors: 0, pageViews: Number(row.pageViews) });
    }
    for (const row of this.db
      .select({ siteId: siteVisitors.siteId, n: sql<number>`count(distinct ${siteVisitors.visitor})` })
      .from(siteVisitors)
      .where(gte(siteVisitors.ts, since))
      .groupBy(siteVisitors.siteId)
      .all()) {
      const entry = out.get(row.siteId) ?? { visitors: 0, pageViews: 0 };
      entry.visitors = Number(row.n);
      out.set(row.siteId, entry);
    }
    return out;
  }

  /**
   * Drop rollups older than the retention window. Returns rows removed.
   *
   * Addresses get their own, much shorter window: they are the only personal data here, so
   * they are kept for as long as answering "who was hammering us last week" needs and not
   * a day longer, while the anonymous counters stay for the yearly comparison.
   */
  prune(days: number, ipDays = days): number {
    const hourCutoff = Date.now() - days * DAY_MS;
    const dayCutoff = floorTo(hourCutoff, DAY_MS);
    const ipCutoff = floorTo(Date.now() - ipDays * DAY_MS, DAY_MS);
    let removed = 0;
    removed += this.db.delete(siteTraffic).where(lt(siteTraffic.ts, hourCutoff)).run().changes;
    removed += this.db.delete(siteVisitors).where(lt(siteVisitors.ts, hourCutoff)).run().changes;
    removed += this.db.delete(siteTrafficPaths).where(lt(siteTrafficPaths.day, dayCutoff)).run().changes;
    removed += this.db.delete(siteTrafficReferrers).where(lt(siteTrafficReferrers.day, dayCutoff)).run().changes;
    removed += this.db.delete(siteTrafficCrawlers).where(lt(siteTrafficCrawlers.day, dayCutoff)).run().changes;
    removed += this.db.delete(siteTrafficIps).where(lt(siteTrafficIps.day, ipCutoff)).run().changes;
    return removed;
  }

  /** Forget every stored address immediately - what turning the setting off has to mean. */
  forgetIps(): number {
    return this.db.delete(siteTrafficIps).run().changes;
  }
}

const emptyPoint = (ts: number): SiteTrafficPoint => ({
  ts,
  requests: 0,
  pageViews: 0,
  visitors: 0,
  botRequests: 0,
  errors: 0,
  bytes: 0,
  avgMs: null,
});
