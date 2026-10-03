import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { ipv4ToInt, ipv6Top64, isPrivateAddress } from '../lib/ip.js';
import type { Logger } from './index.js';

/**
 * IP -> country, from the regional internet registries' own delegation files.
 *
 * Why these and not a commercial database: they are the registries' published record of
 * who holds which block, free of licence keys, attribution clauses and monthly sign-ins -
 * which matters for something self-hosted that ships as source. The trade is accuracy.
 * A delegation records the country of the *member* the block was issued to, so a consumer
 * ISP's customers resolve correctly while a multinational's ranges resolve to wherever it
 * registered them. Good enough to answer "which markets is this site read in", not good
 * enough to bill anybody by - and the UI says so rather than implying precision.
 *
 * Nothing is sent anywhere to do a lookup: the tables are downloaded once a week and every
 * lookup is a local binary search, so no visitor address ever leaves the box.
 */

const REGISTRIES: Record<string, string> = {
  ripencc: 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  arin: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  apnic: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  lacnic: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  afrinic: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
};

/** Refresh when the cache is older than this. Delegations move on the scale of weeks. */
export const GEOIP_MAX_AGE_MS = 7 * 24 * 3600_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
/**
 * Sanity floor on a freshly parsed table. A registry that answers 200 with an error page
 * parses to zero ranges, and overwriting a good cache with that would blank the map.
 */
const MIN_V4_RANGES = 50_000;

export interface GeoIpStatus {
  /** Lookups are answering; false means the cache is missing or could not be loaded. */
  available: boolean;
  fetchedAt: number | null;
  ranges: number;
  lastError: string | null;
}

/** One parsed delegation row. */
export interface DelegationRange {
  cc: string;
  /** IPv4: the first address as a uint32. IPv6: the top 64 bits. */
  start: bigint;
  /** Inclusive. */
  end: bigint;
}

/**
 * Sorted ranges in typed arrays rather than 330k objects: the same data costs ~5MB this
 * way and ~40MB as a `{start, end, cc}[]`, which is real money on the 4GB box this is
 * meant to run on beside MariaDB and every site.
 */
interface Table {
  start: BigUint64Array;
  end: BigUint64Array;
  /** Index into `codes`. */
  cc: Uint16Array;
  codes: string[];
}

const EMPTY: Table = { start: new BigUint64Array(0), end: new BigUint64Array(0), cc: new Uint16Array(0), codes: [] };

interface CacheMeta {
  fetchedAt: number;
  ranges: number;
}

/**
 * Parse one `registry|cc|type|start|value|date|status[|…]` line.
 *
 * `value` means different things per family, which is the trap: for ipv4 it is a *count of
 * addresses* (not a prefix length, and not always a power of two), for ipv6 it is the
 * prefix length.
 */
export function parseDelegationLine(line: string): (DelegationRange & { family: 'v4' | 'v6' }) | null {
  if (!line || line.startsWith('#')) return null;
  const f = line.split('|');
  if (f.length < 7) return null;
  const [, cc = '', type = '', start = '', value = '', , status = ''] = f;
  if (status !== 'allocated' && status !== 'assigned') return null;
  if (!/^[A-Z]{2}$/.test(cc)) return null;

  if (type === 'ipv4') {
    const base = ipv4ToInt(start);
    const count = Number(value);
    if (base === null || !Number.isInteger(count) || count < 1) return null;
    return { family: 'v4', cc, start: BigInt(base), end: BigInt(base + count - 1) };
  }
  if (type === 'ipv6') {
    const base = ipv6Top64(start);
    const len = Number(value);
    if (base === null || !Number.isInteger(len) || len < 1 || len > 128) return null;
    // Everything longer than /64 collapses to a single key - see ipv6Top64.
    const span = len >= 64 ? 0n : (1n << BigInt(64 - len)) - 1n;
    return { family: 'v6', cc, start: base, end: base + span };
  }
  return null;
}

/**
 * Sort, and make the ranges strictly non-overlapping.
 *
 * The binary search below is only correct on disjoint ranges, and the registry files do
 * occasionally hand back a block that overlaps an older, larger one. Truncating the later
 * range to start after the earlier one keeps the invariant without discarding a country.
 */
export function buildTable(ranges: DelegationRange[]): Table {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
  const kept: DelegationRange[] = [];
  let highest = -1n;
  for (const r of ranges) {
    const start = r.start > highest ? r.start : highest + 1n;
    if (start > r.end) continue; // entirely covered by something already kept
    kept.push({ cc: r.cc, start, end: r.end });
    highest = r.end;
  }

  const codes: string[] = [];
  const codeIndex = new Map<string, number>();
  const table: Table = {
    start: new BigUint64Array(kept.length),
    end: new BigUint64Array(kept.length),
    cc: new Uint16Array(kept.length),
    codes,
  };
  for (let i = 0; i < kept.length; i++) {
    const r = kept[i]!;
    let idx = codeIndex.get(r.cc);
    if (idx === undefined) {
      idx = codes.push(r.cc) - 1;
      codeIndex.set(r.cc, idx);
    }
    table.start[i] = r.start;
    table.end[i] = r.end;
    table.cc[i] = idx;
  }
  return table;
}

/** Binary search for the range containing `key`. */
function search(table: Table, key: bigint): string | null {
  let lo = 0;
  let hi = table.start.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key < table.start[mid]!) hi = mid - 1;
    else if (key > table.end[mid]!) lo = mid + 1;
    else return table.codes[table.cc[mid]!] ?? null;
  }
  return null;
}

export class GeoIpService {
  private v4: Table = EMPTY;
  private v6: Table = EMPTY;
  private meta: CacheMeta | null = null;
  private lastError: string | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    /** Injectable for tests; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private get dir(): string {
    return path.join(this.config.paths.panel, 'geoip');
  }

  status(): GeoIpStatus {
    return {
      available: this.v4.start.length > 0,
      fetchedAt: this.meta?.fetchedAt ?? null,
      ranges: this.v4.start.length + this.v6.start.length,
      lastError: this.lastError,
    };
  }

  /** Read the cache into memory. Safe to call repeatedly; concurrent calls share one read. */
  async load(): Promise<void> {
    if (this.v4.start.length > 0) return;
    this.loading ??= this.readCache().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readCache(): Promise<void> {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir, 'meta.json'), 'utf8')) as CacheMeta;
      this.v4 = readCachedTable(await fsp.readFile(path.join(this.dir, 'ipv4.tsv'), 'utf8'));
      this.v6 = readCachedTable(await fsp.readFile(path.join(this.dir, 'ipv6.tsv'), 'utf8'));
      this.meta = meta;
      this.lastError = null;
    } catch (err) {
      // No cache yet is the normal state on a fresh install, not something to report.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /** True when the cache is missing or past its refresh age. */
  async isStale(): Promise<boolean> {
    await this.load();
    return this.meta === null || Date.now() - this.meta.fetchedAt > GEOIP_MAX_AGE_MS;
  }

  /**
   * Download every registry's delegation file and replace the cache.
   *
   * All five or nothing: a partial refresh would silently blank out whole continents, and
   * an existing cache staying a week stale is strictly better than that. The nightly
   * maintenance run retries, so a registry having a bad day costs nothing.
   */
  async refresh(): Promise<{ refreshed: boolean; detail: string }> {
    const v4: DelegationRange[] = [];
    const v6: DelegationRange[] = [];
    for (const [name, url] of Object.entries(REGISTRIES)) {
      try {
        const body = await this.fetchText(url);
        for (const line of body.split('\n')) {
          const row = parseDelegationLine(line.trim());
          if (!row) continue;
          (row.family === 'v4' ? v4 : v6).push({ cc: row.cc, start: row.start, end: row.end });
        }
      } catch (err) {
        const detail = `${name}: ${err instanceof Error ? err.message : err}`;
        this.lastError = detail;
        this.log.warn(`Country table refresh skipped - ${detail}`);
        return { refreshed: false, detail };
      }
    }
    if (v4.length < MIN_V4_RANGES) {
      const detail = `only ${v4.length} IPv4 ranges parsed; keeping the previous table`;
      this.lastError = detail;
      this.log.warn(`Country table refresh rejected - ${detail}`);
      return { refreshed: false, detail };
    }

    this.v4 = buildTable(v4);
    this.v6 = buildTable(v6);
    this.meta = { fetchedAt: Date.now(), ranges: this.v4.start.length + this.v6.start.length };
    this.lastError = null;
    await this.writeCache();
    const detail = `${this.v4.start.length} IPv4 and ${this.v6.start.length} IPv6 ranges`;
    this.log.info(`Country table refreshed from the regional registries (${detail})`);
    return { refreshed: true, detail };
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'wpl7-panel/1 (+visitor statistics country table)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private async writeCache(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    // Written beside and renamed: a panel restarting mid-write must not find half a table.
    for (const [file, table] of [['ipv4.tsv', this.v4], ['ipv6.tsv', this.v6]] as const) {
      const lines: string[] = [];
      for (let i = 0; i < table.start.length; i++) {
        lines.push(`${table.start[i]}\t${table.end[i]}\t${table.codes[table.cc[i]!]}`);
      }
      const tmp = path.join(this.dir, `${file}.tmp`);
      await fsp.writeFile(tmp, lines.join('\n'));
      await fsp.rename(tmp, path.join(this.dir, file));
    }
    await fsp.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta));
  }

  /** ISO 3166-1 alpha-2, or null for a private address, an unknown range or no table. */
  lookup(ip: string): string | null {
    if (!ip || isPrivateAddress(ip)) return null;
    const v4 = ipv4ToInt(ip);
    if (v4 !== null) return search(this.v4, BigInt(v4));
    const v6 = ipv6Top64(ip);
    return v6 === null ? null : search(this.v6, v6);
  }
}

/**
 * Read the cache straight into the typed arrays, without the intermediate
 * `DelegationRange[]` the refresh path builds.
 *
 * Worth the extra few lines: the objects cost ~100MB transiently for 330k ranges, and this
 * runs at every panel start - on a box that is also running MariaDB and every customer's
 * site, a 100MB spike per deploy is a real way to get OOM-killed. The file was written by
 * `buildTable`, so it is already sorted and disjoint and only needs copying in.
 */
function readCachedTable(text: string): Table {
  const lines = text.split('\n');
  const start = new BigUint64Array(lines.length);
  const end = new BigUint64Array(lines.length);
  const cc = new Uint16Array(lines.length);
  const codes: string[] = [];
  const codeIndex = new Map<string, number>();
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    const a = line.indexOf('\t');
    const b = line.indexOf('\t', a + 1);
    if (a < 1 || b < 0) continue;
    const code = line.slice(b + 1);
    let idx = codeIndex.get(code);
    if (idx === undefined) {
      idx = codes.push(code) - 1;
      codeIndex.set(code, idx);
    }
    start[n] = BigInt(line.slice(0, a));
    end[n] = BigInt(line.slice(a + 1, b));
    cc[n] = idx;
    n++;
  }
  // Trailing newline and any skipped line leave slack; hand back exactly what was filled.
  return n === lines.length
    ? { start, end, cc, codes }
    : { start: start.subarray(0, n), end: end.subarray(0, n), cc: cc.subarray(0, n), codes };
}
