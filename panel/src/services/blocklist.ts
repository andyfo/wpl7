/**
 * The fleet's blocked addresses: who is blocked and until when, who never is, and why.
 *
 * A block is fleet-wide - detected on one site, refused on every server - and covers web
 * traffic only (services/firewallSync.ts puts it there). This is the list and its rules:
 *
 * - one block in force per address (a partial unique index says so too);
 * - an automatic block lasts `securityBlockMinutes`, and each repeat within 30 days
 *   `securityBlockMultiplier` times the one before, never more than `securityBlockMaxDays`. A
 *   block lifted by hand was a mistake, not a repeat, so it does not count;
 * - some addresses are never blocked, by the detector or by hand: private ones, the fleet's
 *   servers, the panel as its workers see it, the trusted proxies, Jetpack, the AI assistants'
 *   published addresses, the never-block list, and every address an administrator used the
 *   panel from in the last 30 days. Locking out the person who would lift the block is the
 *   failure that matters most.
 */
import { and, count, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  securityAdminAddresses,
  securityBlocks,
  securityNeverBlock,
  servers as serversTable,
  sites,
  type SecurityBlockRow,
  type SecurityNeverBlockRow,
} from '../db/schema.js';
import {
  CidrSet,
  PRIVATE_RANGES,
  cidrInputProblem,
  cidrOverlaps,
  parseCidr,
  type Cidr,
} from '../../shared/cidr.js';
import type { BlockSource, DetectionRuleId } from '../../shared/security.js';
import type {
  AdminAddressDto,
  NeverBlockDto,
  SecurityBlockDto,
  SecurityBlockEvidence,
  SecurityBlockListDto,
} from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { GeoIpService } from './geoip.js';
import type { ProxyRangesService } from './proxyRanges.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';

const DAY_MS = 24 * 3600_000;
/** An address that used the panel this recently is never blocked. */
export const ADMIN_PROTECT_MS = 30 * DAY_MS;
/** Repeats counted this far back. */
const STRIKE_WINDOW_MS = 30 * DAY_MS;
/** How often the same admin address is written down at most. */
const ADMIN_RECORD_EVERY_MS = 5 * 60_000;

export interface BlockRequest {
  address: string;
  source: BlockSource;
  reason: string;
  rule?: DetectionRuleId | null;
  evidence?: SecurityBlockEvidence | null;
  siteId?: number | null;
  /** Instead of `siteId`: the site the address was seen on most. */
  siteSlug?: string | null;
  serverId?: number | null;
  note?: string | null;
  createdBy?: string | null;
  /** By hand: how long, in ms, or null = until lifted. Left out: the length its strike earns. */
  durationMs?: number | null;
  /** Observe mode: record what would have happened, block nothing. */
  observe?: boolean;
}

export class BlocklistService {
  /** `<address>|<who>` -> when it was last written down. */
  private readonly adminSeen = new Map<string, number>();
  /** Told when the set of blocks in force changes; the firewall sync listens. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly servers: ServerRegistry,
    private readonly proxyRanges: ProxyRangesService,
    private readonly geoip: GeoIpService,
    private readonly log: Logger,
  ) {}

  private changed(): void {
    try {
      this.onChange?.();
    } catch (err) {
      this.log.warn(`Blocked addresses: could not pass a change on: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------------ what is protected

  /**
   * Why an address or range must never be blocked, or null when it may be. A range is
   * protected when it overlaps anything protected: blocking a /24 must not take a fleet
   * server with it.
   */
  protection(target: Cidr, now = Date.now()): string | null {
    const hits = (ranges: Iterable<string | Cidr>) => {
      for (const r of ranges) {
        const cidr = typeof r === 'string' ? parseCidr(r) : r;
        if (cidr && cidrOverlaps(cidr, target)) return cidr;
      }
      return null;
    };
    if (hits(PRIVATE_RANGES)) return 'it is a private address, which is never a visitor on the internet';
    for (const row of this.servers.listRows()) {
      if (row.publicIp && hits([row.publicIp])) return `it is the address of the server "${row.name}"`;
    }
    for (const [serverId, address] of Object.entries(this.panelAddresses())) {
      if (hits([address])) return `it is the panel's own address, as server #${serverId} sees it`;
    }
    for (const proxy of this.proxyRanges.trusted()) {
      if (hits(proxy.ranges.cidrs)) return `it belongs to ${proxy.name === 'cloudflare' ? 'Cloudflare' : `the proxy "${proxy.name}"`}, a trusted proxy - block the visitor behind it instead`;
    }
    if (hits(this.proxyRanges.jetpack().cidrs)) return "it is one of Jetpack's servers";
    for (const ai of this.proxyRanges.aiAssistants()) {
      if (hits(ai.set.cidrs)) return `it is an address of ${ai.label}, and AI assistants are never blocked`;
    }
    for (const row of this.neverBlockRows()) {
      if (hits([row.address])) return `it is on the never-block list${row.note ? ` (${row.note})` : ''}`;
    }
    for (const row of this.adminRows(now)) {
      const cidr = parseCidr(row.address);
      if (cidr && cidrOverlaps(cidr, target)) {
        return `${row.username} used the panel from it ${agoText(now - row.lastSeenAt)}`;
      }
    }
    return null;
  }

  /** Every protected range the detector should know without asking row by row. */
  protectedSet(now = Date.now()): CidrSet {
    return new CidrSet([
      ...PRIVATE_RANGES,
      ...this.servers.listRows().map((r) => r.publicIp).filter(Boolean),
      ...Object.values(this.panelAddresses()),
      ...this.proxyRanges.trusted().flatMap((p) => p.ranges.cidrs),
      ...this.proxyRanges.jetpack().cidrs,
      ...this.proxyRanges.aiAssistants().flatMap((ai) => ai.set.cidrs),
      ...this.neverBlockRows().map((r) => r.address),
      ...this.adminRows(now).map((r) => r.address),
    ]);
  }

  /** The panel's address as each worker sees it (firewallSync records it). */
  panelAddresses(): Record<string, string> {
    return (this.settings.getRaw('security.panelAddresses') as Record<string, string> | undefined) ?? {};
  }

  setPanelAddress(serverId: number, address: string | null): void {
    const current = this.panelAddresses();
    if ((current[serverId] ?? null) === address) return;
    const next = { ...current };
    if (address) next[serverId] = address;
    else delete next[serverId];
    this.settings.setRaw('security.panelAddresses', next);
  }

  // ------------------------------------------------------------------ blocks

  /** Blocks in force at `now`. */
  active(now = Date.now()): SecurityBlockRow[] {
    return this.db
      .select()
      .from(securityBlocks)
      .where(and(isNull(securityBlocks.endedAt), or(isNull(securityBlocks.expiresAt), gt(securityBlocks.expiresAt, now))))
      .all();
  }

  activeCount(now = Date.now()): number {
    return (
      this.db
        .select({ n: count() })
        .from(securityBlocks)
        .where(and(isNull(securityBlocks.endedAt), or(isNull(securityBlocks.expiresAt), gt(securityBlocks.expiresAt, now))))
        .get()?.n ?? 0
    );
  }

  /** The block in force that covers an address or range, if any. */
  covering(target: Cidr, now = Date.now()): SecurityBlockRow | null {
    for (const row of this.active(now)) {
      const cidr = parseCidr(row.address);
      if (cidr && cidrOverlaps(cidr, target)) return row;
    }
    return null;
  }

  /** Which automatic block of this address the next one would be. */
  strikeFor(address: string, now = Date.now()): number {
    const previous = this.db
      .select({ n: count() })
      .from(securityBlocks)
      .where(
        and(
          eq(securityBlocks.address, address),
          eq(securityBlocks.source, 'detector'),
          gt(securityBlocks.createdAt, now - STRIKE_WINDOW_MS),
          or(isNull(securityBlocks.endReason), sql`${securityBlocks.endReason} not in ('lifted', 'observed')`),
        ),
      )
      .get()?.n ?? 0;
    return previous + 1;
  }

  /** How long an automatic block with this strike lasts, in ms. */
  durationFor(strike: number): number {
    const first = Math.max(5, this.settings.get('securityBlockMinutes') || 60) * 60_000;
    const multiplier = Math.max(1, this.settings.get('securityBlockMultiplier') || 4);
    const max = Math.max(1, this.settings.get('securityBlockMaxDays') || 30) * DAY_MS;
    return Math.min(max, first * multiplier ** Math.max(0, strike - 1));
  }

  /**
   * Block an address. Refused - with the reason - for a protected address, one already
   * blocked, a range too wide, and (for the detector) a full list.
   */
  block(req: BlockRequest, now = Date.now()): SecurityBlockRow {
    const problem = cidrInputProblem(req.address);
    if (problem) throw badRequest(problem);
    const cidr = parseCidr(req.address)!;
    const why = this.protection(cidr, now);
    if (why) throw badRequest(`${cidr.text} is never blocked: ${why}.`);
    const existing = this.covering(cidr, now);
    if (existing) {
      throw conflict(
        existing.address === cidr.text
          ? `${cidr.text} is already blocked${existing.expiresAt ? ` until ${new Date(existing.expiresAt).toISOString()}` : ''}`
          : `${cidr.text} is already covered by the block of ${existing.address}`,
      );
    }
    const strike = req.durationMs === undefined ? this.strikeFor(cidr.text, now) : 1;
    const durationMs: number | null = req.durationMs === undefined ? this.durationFor(strike) : req.durationMs;
    if (!req.observe) {
      const max = this.settings.get('securityMaxActiveBlocks') || 10_000;
      if (req.source === 'detector' && this.activeCount(now) >= max) {
        throw conflict(`${max.toLocaleString('en')} addresses are blocked already, the most the list holds`);
      }
    }
    const row = this.db.transaction((tx) => {
      // An expired block not yet swept up still holds the address's one slot.
      tx.update(securityBlocks)
        .set({ endedAt: now, endReason: 'expired' })
        .where(and(eq(securityBlocks.address, cidr.text), isNull(securityBlocks.endedAt), lte(securityBlocks.expiresAt, now)))
        .run();
      return tx
        .insert(securityBlocks)
        .values({
          address: cidr.text,
          family: cidr.family,
          source: req.source,
          rule: req.rule ?? null,
          reason: req.reason,
          evidence: req.evidence ? JSON.stringify(req.evidence) : null,
          siteId: req.siteId ?? (req.siteSlug ? (tx.select({ id: sites.id }).from(sites).where(eq(sites.slug, req.siteSlug)).get()?.id ?? null) : null),
          serverId: req.serverId ?? null,
          country: this.geoip.lookup(cidr.text.split('/')[0]!),
          note: req.note ?? null,
          createdBy: req.createdBy ?? null,
          createdAt: now,
          expiresAt: durationMs === null ? null : now + durationMs,
          // Observe mode writes down what it would have done and ends it on the spot, so it
          // never takes the address's one slot.
          endedAt: req.observe ? now : null,
          endReason: req.observe ? 'observed' : null,
          strike,
        })
        .returning()
        .get();
    });
    if (!req.observe) {
      this.log.info(
        `Blocked ${cidr.text} (${req.source}${req.rule ? `: ${req.rule}` : ''}) ${
          row.expiresAt ? `until ${new Date(row.expiresAt).toISOString()}` : 'until lifted'
        }`,
      );
      this.changed();
    }
    return row;
  }

  /** End a block by hand. Lifted blocks do not count as repeats. */
  lift(id: number, by: string | null, now = Date.now()): SecurityBlockRow {
    const row = this.db.select().from(securityBlocks).where(eq(securityBlocks.id, id)).get();
    if (!row) throw notFound(`Block #${id} not found`);
    if (row.endedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
      throw conflict(`The block of ${row.address} is no longer in force`);
    }
    const updated = this.db
      .update(securityBlocks)
      .set({ endedAt: now, endReason: 'lifted', endedBy: by })
      .where(eq(securityBlocks.id, id))
      .returning()
      .get();
    this.log.info(`Unblocked ${row.address}${by ? ` (${by})` : ''}`);
    this.changed();
    return updated;
  }

  /** Mark the blocks whose time is up as ended. The kernel has already let them go. */
  expire(now = Date.now()): number {
    const ended = this.db
      .update(securityBlocks)
      .set({ endedAt: sql`${securityBlocks.expiresAt}`, endReason: 'expired' })
      .where(and(isNull(securityBlocks.endedAt), lte(securityBlocks.expiresAt, now)))
      .run().changes;
    if (ended > 0) this.changed();
    return ended;
  }

  /** Count each request the HTTP layer blocked against the block entry that covered it. */
  recordHits(hits: Map<string, { count: number; lastAt: number }>, now = Date.now()): void {
    if (hits.size === 0) return;
    const active = this.active(now).map((row) => ({ row, cidr: parseCidr(row.address) }));
    for (const [address, hit] of hits) {
      const ip = parseCidr(address);
      if (!ip) continue;
      const block = active.find((b) => b.cidr && cidrOverlaps(b.cidr, ip));
      if (!block) continue;
      this.db
        .update(securityBlocks)
        .set({ hits: sql`${securityBlocks.hits} + ${hit.count}`, lastHitAt: sql`max(coalesce(${securityBlocks.lastHitAt}, 0), ${hit.lastAt})` })
        .where(eq(securityBlocks.id, block.row.id))
        .run();
    }
  }

  list(opts: { state: 'active' | 'history'; q?: string; limit: number; offset: number }, now = Date.now()): SecurityBlockListDto {
    const inForce = and(isNull(securityBlocks.endedAt), or(isNull(securityBlocks.expiresAt), gt(securityBlocks.expiresAt, now)));
    const state = opts.state === 'active' ? inForce : sql`not (${inForce})`;
    const q = opts.q?.trim();
    const where = q
      ? and(
          state,
          or(
            sql`${securityBlocks.address} like ${`%${q}%`}`,
            sql`${securityBlocks.reason} like ${`%${q}%`}`,
            sql`coalesce(${securityBlocks.note}, '') like ${`%${q}%`}`,
          ),
        )
      : state;
    const rows = this.db
      .select()
      .from(securityBlocks)
      .where(where)
      .orderBy(desc(securityBlocks.createdAt), desc(securityBlocks.id))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
    const total = this.db.select({ n: count() }).from(securityBlocks).where(where).get()?.n ?? 0;
    return {
      items: rows.map((r) => this.toDto(r, now)),
      total,
      activeCount: this.activeCount(now),
      maxActive: this.settings.get('securityMaxActiveBlocks') || 10_000,
    };
  }

  byId(id: number): SecurityBlockRow | undefined {
    return this.db.select().from(securityBlocks).where(eq(securityBlocks.id, id)).get();
  }

  toDto(row: SecurityBlockRow, now = Date.now()): SecurityBlockDto {
    const site = row.siteId === null ? null : this.db.select({ slug: sites.slug }).from(sites).where(eq(sites.id, row.siteId)).get();
    const server =
      row.serverId === null ? null : this.db.select({ name: serversTable.name }).from(serversTable).where(eq(serversTable.id, row.serverId)).get();
    let evidence: SecurityBlockEvidence | null = null;
    try {
      evidence = row.evidence ? (JSON.parse(row.evidence) as SecurityBlockEvidence) : null;
    } catch {
      evidence = null;
    }
    return {
      id: row.id,
      address: row.address,
      family: row.family === 6 ? 6 : 4,
      source: row.source,
      rule: (row.rule as SecurityBlockDto['rule']) ?? null,
      reason: row.reason,
      evidence,
      siteSlug: site?.slug ?? null,
      serverName: server?.name ?? null,
      country: row.country,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      endedAt: row.endedAt,
      endReason: (row.endReason as SecurityBlockDto['endReason']) ?? null,
      endedBy: row.endedBy,
      strike: row.strike,
      hits: row.hits,
      lastHitAt: row.lastHitAt,
      active: row.endedAt === null && (row.expiresAt === null || row.expiresAt > now),
    };
  }

  // ------------------------------------------------------------------ never block

  neverBlockRows(): SecurityNeverBlockRow[] {
    return this.db.select().from(securityNeverBlock).orderBy(securityNeverBlock.address).all();
  }

  neverBlockList(): NeverBlockDto[] {
    return this.neverBlockRows().map((r) => ({ id: r.id, address: r.address, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt }));
  }

  /** Add an address or range; a block in force that it overlaps is lifted with it. */
  addNeverBlock(address: string, note: string | null, by: string | null, now = Date.now()): NeverBlockDto {
    const problem = cidrInputProblem(address);
    if (problem) throw badRequest(problem);
    const cidr = parseCidr(address)!;
    if (this.db.select().from(securityNeverBlock).where(eq(securityNeverBlock.address, cidr.text)).get()) {
      throw conflict(`${cidr.text} is on the never-block list already`);
    }
    const row = this.db
      .insert(securityNeverBlock)
      .values({ address: cidr.text, note: note?.trim() || null, createdBy: by, createdAt: now })
      .returning()
      .get();
    for (const block of this.active(now)) {
      const blocked = parseCidr(block.address);
      if (!blocked || !cidrOverlaps(blocked, cidr)) continue;
      this.db
        .update(securityBlocks)
        .set({ endedAt: now, endReason: 'lifted', endedBy: by ?? 'never-block list' })
        .where(eq(securityBlocks.id, block.id))
        .run();
    }
    this.changed();
    return { id: row.id, address: row.address, note: row.note, createdBy: row.createdBy, createdAt: row.createdAt };
  }

  removeNeverBlock(id: number): void {
    const gone = this.db.delete(securityNeverBlock).where(eq(securityNeverBlock.id, id)).run().changes;
    if (gone === 0) throw notFound(`Never-block entry #${id} not found`);
    this.changed();
  }

  // ------------------------------------------------------------------ admin addresses

  /** Write down an address an administrator (or an API key) used; at most every few minutes. */
  recordAdmin(address: string, username: string, now = Date.now()): void {
    const cidr = parseCidr(address);
    if (!cidr || cidr.prefix !== (cidr.family === 4 ? 32 : 128)) return;
    const key = `${cidr.text}|${username}`;
    if (now - (this.adminSeen.get(key) ?? 0) < ADMIN_RECORD_EVERY_MS) return;
    this.adminSeen.set(key, now);
    if (this.adminSeen.size > 5000) this.adminSeen.clear();
    this.db
      .insert(securityAdminAddresses)
      .values({ address: cidr.text, username, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: securityAdminAddresses.address, set: { username, lastSeenAt: now } })
      .run();
    // An admin who got themselves blocked from a new address, signing in from elsewhere to lift
    // it, is protected from then on - but that block stays until they lift it.
  }

  private adminRows(now: number) {
    return this.db
      .select()
      .from(securityAdminAddresses)
      .where(gt(securityAdminAddresses.lastSeenAt, now - ADMIN_PROTECT_MS))
      .all();
  }

  adminAddresses(now = Date.now()): AdminAddressDto[] {
    return this.adminRows(now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((r) => ({ address: r.address, username: r.username, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt }));
  }

  // ------------------------------------------------------------------ housekeeping

  /** Ended blocks past the history window, and admin addresses nobody used for 30 days. */
  prune(now = Date.now()): number {
    const historyMs = Math.max(1, this.settings.get('securityHistoryDays') || 30) * DAY_MS;
    let removed = this.db
      .delete(securityBlocks)
      .where(and(sql`${securityBlocks.endedAt} is not null`, lt(securityBlocks.endedAt, now - historyMs)))
      .run().changes;
    removed += this.db.delete(securityAdminAddresses).where(lt(securityAdminAddresses.lastSeenAt, now - ADMIN_PROTECT_MS)).run().changes;
    return removed;
  }
}

function agoText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
