/**
 * The requests each site's protection blocked, read from the same access-log pass the visitor
 * statistics use (services/traffic.ts calls `fold` with every batch).
 *
 * Nothing is asked of Traefik: the router that answered names the rule (`wpl7sec_deny-files_x`
 * refused a secret file, `wpl7sec_login_x` with a 429 was the login limit), and the site's own
 * answer - `OriginStatus` - is 0 when Traefik answered for it, which is what tells the panel's
 * limit apart from a plugin that sends 429 itself.
 *
 * Kept: a count per site, day and rule, and the last 500 requests of each site. The address in
 * those follows the visitor statistics' rules - not written while addresses are not stored,
 * blanked after their retention.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { siteBlocked, siteBlockedRecent, sites } from '../db/schema.js';
import { normalizePath, type AccessEvent } from '../lib/accessLog.js';
import { BLOCKED_ROUTER_PREFIX, parseSecurityName } from '../../shared/security.js';
import type { BlockedRequestDto } from '../../shared/types.js';
import type { BlocklistService } from './blocklist.js';
import type { GeoIpService } from './geoip.js';
import type { SettingsService } from './settings.js';

const DAY_MS = 24 * 3600_000;
/** Turned-away requests kept per site. */
export const RECENT_PER_SITE = 500;

const LIMIT_RULES: Record<string, string> = {
  login: 'limit-login',
  xmlrpc: 'limit-xmlrpc',
  static: 'limit-assets',
  main: 'limit-requests',
};

/**
 * Which rule turned a request away, or null for one that was served. A refusal is always a 403
 * from Traefik itself; a limit a 429 from Traefik itself.
 */
export function blockedRule(event: Pick<AccessEvent, 'router' | 'status' | 'originStatus'>): string | null {
  if (event.originStatus !== 0) return null;
  if (event.router.startsWith(`${BLOCKED_ROUTER_PREFIX}_`)) return event.status === 403 ? 'blocked-address' : null;
  const name = parseSecurityName(event.router);
  if (!name) return null;
  if (name.kind.startsWith('deny-')) return event.status === 403 ? name.kind.slice('deny-'.length) : null;
  if (name.kind.startsWith('block-')) return event.status === 403 ? name.kind : null;
  if (event.status === 429) return LIMIT_RULES[name.kind.replace(/-p\d+$/, '')] ?? null;
  return null;
}

export { blockedRuleLabel } from '../../shared/security.js';

export class SecurityEventsService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly geoip: GeoIpService,
    private readonly blocklist: BlocklistService,
  ) {}

  /** Fold one server's new events. Returns how many were blocked. */
  fold(events: AccessEvent[]): number {
    const blocked = events
      .map((event) => ({ event, rule: blockedRule(event) }))
      .filter((b): b is { event: AccessEvent; rule: string } => b.rule !== null);
    if (blocked.length === 0) return 0;

    const siteRows = this.db.select({ id: sites.id, slug: sites.slug, domains: sites.domains }).from(sites).all();
    const bySlug = new Map(siteRows.map((r) => [r.slug, r.id]));
    // A blocked address is refused before any site's router, so the host is all that says
    // whose it was.
    const byHost = new Map<string, number>();
    for (const row of siteRows) {
      try {
        for (const host of JSON.parse(row.domains) as string[]) byHost.set(host.toLowerCase(), row.id);
      } catch {
        /* a row the panel did not write; its site is simply not attributed */
      }
    }
    const storeIps = this.settings.get('trafficStoreIps') !== false;
    const counts = new Map<string, { siteId: number; day: number; rule: string; requests: number }>();
    const recent: (typeof siteBlockedRecent.$inferInsert)[] = [];
    const hits = new Map<string, { count: number; lastAt: number }>();

    for (const { event, rule } of blocked) {
      if (rule === 'blocked-address' && event.clientIp) {
        const hit = hits.get(event.clientIp) ?? { count: 0, lastAt: 0 };
        hit.count++;
        hit.lastAt = Math.max(hit.lastAt, event.ts);
        hits.set(event.clientIp, hit);
      }
      const siteId = (event.slug ? bySlug.get(event.slug) : undefined) ?? byHost.get(event.host.toLowerCase().replace(/:\d+$/, ''));
      if (siteId === undefined) continue;
      const day = Math.floor(event.ts / DAY_MS) * DAY_MS;
      const key = `${siteId}:${day}:${rule}`;
      const row = counts.get(key) ?? { siteId, day, rule, requests: 0 };
      row.requests++;
      counts.set(key, row);
      recent.push({
        siteId,
        ts: event.ts,
        rule,
        ip: storeIps ? event.clientIp || null : null,
        country: this.geoip.lookup(event.clientIp),
        via: event.via,
        method: event.method.slice(0, 10),
        path: normalizePath(event.path),
        status: event.status,
      });
    }

    this.db.transaction((tx) => {
      for (const row of counts.values()) {
        tx.insert(siteBlocked)
          .values(row)
          .onConflictDoUpdate({
            target: [siteBlocked.siteId, siteBlocked.day, siteBlocked.rule],
            set: { requests: sql`${siteBlocked.requests} + ${row.requests}` },
          })
          .run();
      }
      // A flood is thousands a minute; only the newest few hundred of a batch would survive
      // the trim anyway.
      for (const row of recent.slice(-RECENT_PER_SITE * 4)) tx.insert(siteBlockedRecent).values(row).run();
      for (const siteId of new Set(recent.map((r) => r.siteId))) {
        tx.run(sql`delete from site_blocked_recent where site_id = ${siteId} and id not in (
          select id from site_blocked_recent where site_id = ${siteId} order by ts desc, id desc limit ${RECENT_PER_SITE})`);
      }
    });
    this.blocklist.recordHits(hits);
    return blocked.length;
  }

  /** Requests blocked, per rule, over the last `days` days. */
  countsBySite(siteId: number, days: number, now = Date.now()): Record<string, number> {
    const since = Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS;
    const out: Record<string, number> = {};
    for (const row of this.db
      .select({ rule: siteBlocked.rule, n: sql<number>`sum(${siteBlocked.requests})` })
      .from(siteBlocked)
      .where(and(eq(siteBlocked.siteId, siteId), gte(siteBlocked.day, since)))
      .groupBy(siteBlocked.rule)
      .all()) {
      out[row.rule] = Number(row.n);
    }
    return out;
  }

  /**
   * Per site, requests blocked since `since`. Counted from the recent list, which is exact
   * to the minute; a site whose list is full of that window has had more than it holds, and
   * gets its daily counts instead - the whole of each day that overlaps.
   */
  fleetCounts(since: number): Map<number, number> {
    const out = new Map<number, number>();
    const full: number[] = [];
    for (const row of this.db
      .select({ siteId: siteBlockedRecent.siteId, n: sql<number>`count(*)` })
      .from(siteBlockedRecent)
      .where(gte(siteBlockedRecent.ts, since))
      .groupBy(siteBlockedRecent.siteId)
      .all()) {
      out.set(row.siteId, Number(row.n));
      if (Number(row.n) >= RECENT_PER_SITE) full.push(row.siteId);
    }
    const sinceDay = Math.floor(since / DAY_MS) * DAY_MS;
    for (const siteId of full) {
      const total = this.db
        .select({ n: sql<number>`sum(${siteBlocked.requests})` })
        .from(siteBlocked)
        .where(and(eq(siteBlocked.siteId, siteId), gte(siteBlocked.day, sinceDay)))
        .get();
      out.set(siteId, Math.max(out.get(siteId) ?? 0, Number(total?.n ?? 0)));
    }
    return out;
  }

  /** Totals per day across the fleet (or one site), for a chart. */
  daily(days: number, siteId?: number, now = Date.now()): { day: number; requests: number }[] {
    const since = Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS;
    return this.db
      .select({ day: siteBlocked.day, requests: sql<number>`sum(${siteBlocked.requests})` })
      .from(siteBlocked)
      .where(siteId === undefined ? gte(siteBlocked.day, since) : and(gte(siteBlocked.day, since), eq(siteBlocked.siteId, siteId)))
      .groupBy(siteBlocked.day)
      .orderBy(siteBlocked.day)
      .all()
      .map((r) => ({ day: r.day, requests: Number(r.requests) }));
  }

  recent(opts: { siteId?: number; limit: number; rule?: string }): BlockedRequestDto[] {
    const conditions = [
      ...(opts.siteId !== undefined ? [eq(siteBlockedRecent.siteId, opts.siteId)] : []),
      ...(opts.rule ? [eq(siteBlockedRecent.rule, opts.rule)] : []),
    ];
    return this.db
      .select({
        ts: siteBlockedRecent.ts,
        rule: siteBlockedRecent.rule,
        ip: siteBlockedRecent.ip,
        country: siteBlockedRecent.country,
        via: siteBlockedRecent.via,
        method: siteBlockedRecent.method,
        path: siteBlockedRecent.path,
        status: siteBlockedRecent.status,
        siteSlug: sites.slug,
      })
      .from(siteBlockedRecent)
      .leftJoin(sites, eq(sites.id, siteBlockedRecent.siteId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(siteBlockedRecent.ts), desc(siteBlockedRecent.id))
      .limit(opts.limit)
      .all()
      .map((r) => ({ ...r, siteSlug: r.siteSlug ?? null }));
  }

  /**
   * Addresses follow the visitor statistics: blanked past their retention, and all at once
   * when storing them is switched off. The counts follow the statistics' own retention.
   */
  prune(now = Date.now()): number {
    const ipDays = this.settings.get('trafficIpRetentionDays') || 7;
    const days = this.settings.get('trafficRetentionDays') || 90;
    let changed = this.db
      .update(siteBlockedRecent)
      .set({ ip: null })
      .where(and(lt(siteBlockedRecent.ts, now - ipDays * DAY_MS), sql`${siteBlockedRecent.ip} is not null`))
      .run().changes;
    changed += this.db.delete(siteBlocked).where(lt(siteBlocked.day, now - days * DAY_MS)).run().changes;
    changed += this.db.delete(siteBlockedRecent).where(lt(siteBlockedRecent.ts, now - days * DAY_MS)).run().changes;
    return changed;
  }

  forgetIps(): number {
    return this.db.update(siteBlockedRecent).set({ ip: null }).where(sql`${siteBlockedRecent.ip} is not null`).run().changes;
  }
}
