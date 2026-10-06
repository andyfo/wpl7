/**
 * Attack detection: who is attacking the fleet, from the access logs every server already
 * writes - one address across every site and server, so a scanner that visits forty sites a
 * little each is seen for what it is.
 *
 * Every request the ingest reads is fed in (services/traffic.ts), classified by
 * lib/attackSignals.ts and counted per visitor - an address, or an IPv6 visitor's /64 - in
 * buckets held in memory, one per rule: the count of the rule's current window plus the
 * previous window's, weighted by how much of it still overlaps the last `window` minutes.
 * That is "20 in 10 minutes" to within a rounding, in two numbers per rule however busy the
 * address - a bucket that leaked evenly would forgive part of a burst while it happened. The
 * minute tick then decides what to do about the ones that overflowed.
 *
 * What it never does: block a protected address (services/blocklist.ts says which), block a
 * search engine's verified crawler, or block an address that looks like a proxy for others -
 * three different visitors behind one unknown address are a notice, not a block. After a
 * restart the buckets are rebuilt from the last ten minutes of log, so a restart is no pause
 * for an attacker.
 */
// @docs security/blocked-addresses
import { CidrSet, isPrivateIp, parseCidr, visitorKey } from '../../shared/cidr.js';
import {
  DEFAULT_DETECTION_RULES,
  DETECTION_RULE_INFO,
  type AutoBlockMode,
  type DetectionRuleId,
  type DetectionRules,
} from '../../shared/security.js';
import type { SecurityDecisionDto, SecurityDetectionDto } from '../../shared/types.js';
import type { AccessEvent } from '../lib/accessLog.js';
import { signalsOf } from '../lib/attackSignals.js';
import { verifyCrawler, type CrawlerResolver, systemResolver, claimedCrawler } from '../lib/crawlerVerify.js';
import type { BlocklistService } from './blocklist.js';
import { blockedRule } from './securityEvents.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';

/** Addresses watched at once; the one seen longest ago makes room. */
export const MAX_TRACKED = 20_000;
/**
 * Paths remembered per address and rule for the "distinct paths" rules - as 32-bit hashes, so
 * a flood from thousands of addresses stays a few megabytes. Past this, the oldest path may
 * count again, which only ever makes detection keener.
 */
const MAX_PATHS = 64;
/** How far back the buckets are rebuilt after a restart. */
export const REBUILD_MS = 10 * 60_000;
/** A decision not to block an address is not repeated for this long. */
const QUIET_MS = 60 * 60_000;
/** Decisions kept for the Detection tab. */
const MAX_DECISIONS = 100;
/** Distinct user agents behind one address that make it look like a proxy for others. */
const PROXY_AGENTS = 3;
const DECISIONS_KEY = 'security.decisions';

interface Bucket {
  /** Start of the current fixed window. */
  start: number;
  current: number;
  previous: number;
  /** The estimate at the last event: what overflowed, for the reason. */
  level: number;
}

/** Add to a bucket, and estimate the last `windowMs` as of `ts`. */
export function fillBucket(bucket: Bucket, ts: number, points: number, windowMs: number): number {
  const start = Math.floor(ts / windowMs) * windowMs;
  if (start > bucket.start) {
    bucket.previous = start - bucket.start === windowMs ? bucket.current : 0;
    bucket.current = 0;
    bucket.start = start;
  } else if (start < bucket.start) {
    // A server's log read after another's can be older than what was counted already.
    if (start === bucket.start - windowMs) bucket.previous += points;
    return bucket.level;
  }
  bucket.current += points;
  const overlap = 1 - (ts - bucket.start) / windowMs;
  bucket.level = bucket.previous * overlap + bucket.current;
  return bucket.level;
}

interface Tracked {
  key: string;
  /** Leaky buckets, per rule. */
  buckets: Partial<Record<DetectionRuleId, Bucket>>;
  /** Per rule: the paths already counted (hashed), and when. */
  seen: Partial<Record<DetectionRuleId, Map<number, number>>>;
  sites: Map<string, number>;
  servers: Map<number, number>;
  paths: string[];
  agents: Set<string>;
  lastAgent: string;
  /** The address `lastAgent` came from - the key of an IPv6 visitor is its whole /64. */
  lastIp: string;
  via: string | null;
  lastAt: number;
  /** Rules that overflowed and wait for the tick. */
  pending: Set<DetectionRuleId>;
}

interface Candidate {
  key: string;
  rule: DetectionRuleId;
  level: number;
  tracked: Tracked;
}

export class AttackDetector {
  /** Insertion order is recency: an update moves the address to the end. */
  private readonly tracked = new Map<string, Tracked>();
  private decisions: SecurityDecisionDto[];
  /** `<key>|<rule>` -> until when a "not blocked" is not said again. */
  private readonly quiet = new Map<string, number>();
  /** Verified crawlers and failed checks, by the crawler claimed and the address. */
  private readonly crawlers = new Map<string, { verified: boolean; host: string | null; until: number }>();
  private protectedCache: { set: CidrSet; until: number } | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly blocklist: BlocklistService,
    private readonly log: Logger,
    private readonly resolver: CrawlerResolver = systemResolver,
  ) {
    const stored = settings.getRaw(DECISIONS_KEY);
    this.decisions = Array.isArray(stored) ? (stored as SecurityDecisionDto[]).slice(0, MAX_DECISIONS) : [];
  }

  mode(): AutoBlockMode {
    return this.settings.get('securityAutoBlock') ?? 'on';
  }

  private rules(): DetectionRules {
    return { ...DEFAULT_DETECTION_RULES, ...(this.settings.get('securityRules') ?? {}) };
  }

  /** Protected ranges, refreshed every minute rather than read per request. */
  private protectedSet(now: number): CidrSet {
    if (!this.protectedCache || now > this.protectedCache.until) {
      this.protectedCache = { set: this.blocklist.protectedSet(now), until: now + 60_000 };
    }
    return this.protectedCache.set;
  }

  // ------------------------------------------------------------------ counting

  /** Count a batch of requests one server's log said. Synchronous and cheap. */
  feed(serverId: number, events: readonly AccessEvent[], now = Date.now()): void {
    if (this.mode() === 'off' || events.length === 0) return;
    const rules = this.rules();
    const protectedSet = this.protectedSet(now);
    for (const event of events) {
      if (!event.clientIp || isPrivateIp(event.clientIp) || protectedSet.has(event.clientIp)) continue;
      const signals = signalsOf(event, blockedRule(event));
      if (signals.length === 0) continue;
      const cidr = visitorKey(event.clientIp);
      if (!cidr) continue;
      const t = this.touch(cidr.text, event, serverId);
      for (const signal of signals) {
        const rule = rules[signal.rule];
        if (!rule?.enabled) continue;
        const windowMs = rule.windowMin * 60_000;
        if (signal.distinct !== undefined) {
          const seen = (t.seen[signal.rule] ??= new Map<number, number>());
          const hash = fnv1a(signal.distinct);
          const at = seen.get(hash);
          if (at !== undefined && event.ts - at < windowMs) continue;
          seen.delete(hash);
          seen.set(hash, event.ts);
          if (seen.size > MAX_PATHS) seen.delete(seen.keys().next().value!);
        }
        const bucket = (t.buckets[signal.rule] ??= { start: Math.floor(event.ts / windowMs) * windowMs, current: 0, previous: 0, level: 0 });
        if (fillBucket(bucket, event.ts, signal.points, windowMs) >= rule.threshold) t.pending.add(signal.rule);
      }
    }
  }

  private touch(key: string, event: AccessEvent, serverId: number): Tracked {
    let t = this.tracked.get(key);
    if (t) {
      this.tracked.delete(key);
    } else {
      t = {
        key,
        buckets: {},
        seen: {},
        sites: new Map(),
        servers: new Map(),
        paths: [],
        agents: new Set(),
        lastAgent: '',
        lastIp: '',
        via: null,
        lastAt: 0,
        pending: new Set(),
      };
      if (this.tracked.size >= MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
    }
    this.tracked.set(key, t);
    t.lastAt = Math.max(t.lastAt, event.ts);
    if (event.slug) t.sites.set(event.slug, (t.sites.get(event.slug) ?? 0) + 1);
    t.servers.set(serverId, (t.servers.get(serverId) ?? 0) + 1);
    const path = event.path.split('?')[0] ?? '/';
    if (!t.paths.includes(path)) {
      t.paths.push(path);
      if (t.paths.length > 5) t.paths.shift();
    }
    if (event.userAgent && t.agents.size < 10) t.agents.add(event.userAgent);
    t.lastAgent = event.userAgent;
    t.lastIp = event.clientIp;
    t.via = event.via;
    return t;
  }

  /** Addresses being watched: for the Detection tab, and the tests. */
  trackedCount(): number {
    return this.tracked.size;
  }

  // ------------------------------------------------------------------ deciding

  /** The minute tick: decide about every address whose bucket overflowed. */
  async evaluate(now = Date.now()): Promise<{ blocked: number; observed: number; skipped: number }> {
    const result = { blocked: 0, observed: 0, skipped: 0 };
    const mode = this.mode();
    if (mode === 'off') {
      for (const t of this.tracked.values()) t.pending.clear();
      return result;
    }
    const rules = this.rules();
    const candidates: Candidate[] = [];
    for (const t of this.tracked.values()) {
      for (const rule of t.pending) candidates.push({ key: t.key, rule, level: t.buckets[rule]?.level ?? 0, tracked: t });
      t.pending.clear();
    }
    // Stale watchers go: nothing left in their buckets, and not seen for a long while.
    for (const [key, t] of this.tracked) {
      if (now - t.lastAt > 2 * 60 * 60_000) this.tracked.delete(key);
    }
    for (const c of candidates) {
      const outcome = await this.decide(c, rules, mode, now);
      result[outcome]++;
    }
    if (candidates.length > 0) this.settings.setRaw(DECISIONS_KEY, this.decisions);
    return result;
  }

  private async decide(c: Candidate, rules: DetectionRules, mode: AutoBlockMode, now: number): Promise<'blocked' | 'observed' | 'skipped'> {
    const cidr = parseCidr(c.key)!;
    const rule = rules[c.rule];
    const info = DETECTION_RULE_INFO[c.rule];
    const count = Math.round(c.level);
    const sites = [...c.tracked.sites.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
    const reason = `${count} ${info.unit} in ${rule.windowMin} minutes: ${info.label.toLowerCase()}${
      sites.length > 0 ? ` on ${sites.slice(0, 3).join(', ')}${sites.length > 3 ? ` and ${sites.length - 3} more` : ''}` : ''
    }`;
    // The bucket is spent either way: whatever happens next, this overflow is dealt with.
    delete c.tracked.buckets[c.rule];

    if (this.blocklist.covering(cidr, now)) return 'skipped';

    const skip = (why: string): 'skipped' => {
      const quietKey = `${c.key}|${c.rule}`;
      if ((this.quiet.get(quietKey) ?? 0) > now) return 'skipped';
      this.quiet.set(quietKey, now + QUIET_MS);
      if (this.quiet.size > 5000) this.quiet.clear();
      this.record({ at: now, address: c.key, rule: c.rule, action: 'skipped', reason: `Not blocked: ${why}`, count, sites, blockId: null });
      return 'skipped';
    };

    const protectedBecause = this.blocklist.protection(cidr, now);
    if (protectedBecause) return skip(protectedBecause);

    const claims = claimedCrawler(c.tracked.lastAgent);
    if (claims) {
      // The address itself: a /64 has no reverse DNS to ask.
      const check = await this.crawlerCheck(c.tracked.lastIp, claims, c.tracked.lastAgent, now);
      if (check.verified) return skip(`it is ${claims}, verified by its reverse DNS (${check.host})`);
    }

    if (c.tracked.via === null && c.tracked.agents.size >= PROXY_AGENTS) {
      return skip(`${c.tracked.agents.size} different browsers came from it, so it looks like a proxy for other people - declare it as one in Settings, or block it by hand`);
    }

    const serverId = [...c.tracked.servers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    try {
      const row = this.blocklist.block(
        {
          address: c.key,
          source: 'detector',
          rule: c.rule,
          reason,
          evidence: {
            count,
            threshold: rule.threshold,
            windowMin: rule.windowMin,
            sites: sites.slice(0, 10),
            samplePaths: c.tracked.paths.slice(-5),
            userAgent: c.tracked.lastAgent.slice(0, 300) || null,
            via: c.tracked.via,
          },
          siteSlug: sites[0] ?? null,
          serverId,
          observe: mode === 'observe',
        },
        now,
      );
      const action = mode === 'observe' ? 'observed' : 'blocked';
      const length = row.expiresAt === null ? 'until lifted' : `for ${formatDuration(row.expiresAt - now)}`;
      this.record({
        at: now,
        address: c.key,
        rule: c.rule,
        action,
        reason: mode === 'observe' ? `Would have been blocked ${length} (observe mode): ${reason}` : `Blocked ${length}: ${reason}`,
        count,
        sites,
        blockId: row.id,
      });
      return action;
    } catch (err) {
      return skip(err instanceof Error ? err.message : String(err));
    }
  }

  private async crawlerCheck(ip: string, claims: string, ua: string, now: number): Promise<{ verified: boolean; host: string | null }> {
    // By the crawler claimed too: an address verified as Googlebot is no Bingbot.
    const key = `${claims} ${ip}`;
    const cached = this.crawlers.get(key);
    if (cached && cached.until > now) return cached;
    const check = await verifyCrawler(ip, ua, this.resolver).catch(() => ({ claims: null, verified: false, host: null }));
    const entry = { verified: check.verified, host: check.host, until: now + 24 * 60 * 60_000 };
    this.crawlers.set(key, entry);
    if (this.crawlers.size > 2000) this.crawlers.clear();
    return entry;
  }

  private record(decision: SecurityDecisionDto): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.length = MAX_DECISIONS;
    if (decision.action !== 'skipped') this.log.info(`Detection: ${decision.reason} (${decision.address})`);
  }

  status(): SecurityDetectionDto {
    return { mode: this.mode(), tracked: this.tracked.size, maxTracked: MAX_TRACKED, decisions: this.decisions };
  }

  /**
   * After a restart: count the last ten minutes of every server's log again, so an attack under
   * way is not forgotten because the panel was redeployed. Only what the ingest had already
   * read before the restart - it delivers everything after that itself.
   */
  async rebuild(read: (serverId: number, sinceMs: number) => Promise<AccessEvent[]>, serverIds: number[], now = Date.now()): Promise<number> {
    let fed = 0;
    for (const serverId of serverIds) {
      try {
        const events = await read(serverId, now - REBUILD_MS);
        this.feed(serverId, events, now);
        fed += events.length;
      } catch (err) {
        this.log.warn(`Detection: could not re-read server #${serverId}'s log after the restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return fed;
  }
}

/** FNV-1a, 32 bits: a path's stand-in in the "already counted" memory. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function formatDuration(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1.5) return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
