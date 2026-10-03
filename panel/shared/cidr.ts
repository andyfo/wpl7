/**
 * Addresses and address ranges: which proxy a request came through, whether an address is on
 * a list, what a block covers. Pure and free of Node's `net`, because the web dialogs check
 * what an operator types with the same code the panel enforces it with.
 *
 * Canonical text is what gets stored and compared: IPv4 as a dotted quad without leading
 * zeros, IPv6 lower-case and compressed (RFC 5952), a single address without its /32 or /128,
 * and a range as its network address - `203.0.113.7/24` is `203.0.113.0/24`. An IPv4 address
 * wearing an IPv6 hat (`::ffff:203.0.113.7`, what a dual-stack socket reports) is IPv4.
 */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  /** 4 or 16 bytes, network order. */
  bytes: Uint8Array;
}

export interface Cidr {
  family: IpFamily;
  /** The network address: every bit past `prefix` is zero. */
  bytes: Uint8Array;
  prefix: number;
  /** Canonical, see the top of this file. */
  text: string;
}

const bitsOf = (family: IpFamily) => (family === 4 ? 32 : 128);

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // No leading zeros: `010` is octal to some parsers and decimal to others, and an address
    // two programs read differently is not one to put on a block list.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(text: string): Uint8Array | null {
  let head = text;
  let tailV4: Uint8Array | null = null;
  const lastColon = head.lastIndexOf(':');
  if (lastColon !== -1 && head.slice(lastColon + 1).includes('.')) {
    tailV4 = parseIpv4(head.slice(lastColon + 1));
    if (!tailV4) return null;
    head = `${head.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s: string) => (s === '' ? [] : s.split(':'));
  const left = groupsOf(halves[0]!);
  const right = halves.length === 2 ? groupsOf(halves[1]!) : [];
  // `::` stands for one or more zero groups, never for none.
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  const groups = halves.length === 2 ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tailV4) out.set(tailV4, 12);
  return out;
}

/** `::ffff:0:0/96` - an IPv4 address carried in IPv6. */
function isV4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * One address. Accepts `[2001:db8::1]` and a zone (`fe80::1%eth0`, dropped), as Traefik and
 * Node write them; null for anything else, a range included.
 */
export function parseIp(input: string): ParsedIp | null {
  let text = input.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '') return null;
  if (!text.includes(':')) {
    const v4 = parseIpv4(text);
    return v4 ? { family: 4, bytes: v4 } : null;
  }
  const v6 = parseIpv6(text);
  if (!v6) return null;
  return isV4Mapped(v6) ? { family: 4, bytes: v6.slice(12) } : { family: 6, bytes: v6 };
}

export function formatIp(ip: ParsedIp): string {
  const b = ip.bytes;
  if (ip.family === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((b[i]! << 8) | b[i + 1]!);
  // The longest run of two or more zero groups becomes `::`; the first one on a tie.
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Canonical text of an address; null when it is not one. */
export function normalizeIp(input: string): string | null {
  const ip = parseIp(input);
  return ip ? formatIp(ip) : null;
}

function maskBytes(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < out.length; i++) {
    const keep = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = out[i]! & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  }
  return out;
}

function cidrOf(family: IpFamily, bytes: Uint8Array, prefix: number): Cidr {
  const network = maskBytes(bytes, prefix);
  const address = formatIp({ family, bytes: network });
  return { family, bytes: network, prefix, text: prefix === bitsOf(family) ? address : `${address}/${prefix}` };
}

/**
 * An address or a range: `203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`. Bits past the prefix
 * are dropped, so `203.0.113.7/24` reads as the /24 it names. A mapped IPv4 range keeps its
 * meaning: `::ffff:203.0.113.0/120` is `203.0.113.0/24`.
 */
export function parseCidr(input: string): Cidr | null {
  const text = input.trim();
  const slash = text.indexOf('/');
  if (slash === -1) {
    const ip = parseIp(text);
    return ip ? cidrOf(ip.family, ip.bytes, bitsOf(ip.family)) : null;
  }
  const lenText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(lenText)) return null;
  let prefix = Number(lenText);
  const addrText = text.slice(0, slash);
  let ip: ParsedIp | null;
  if (addrText.includes(':')) {
    const v6 = parseIpv6(addrText.startsWith('[') && addrText.endsWith(']') ? addrText.slice(1, -1) : addrText);
    if (!v6 || prefix > 128) return null;
    if (isV4Mapped(v6) && prefix >= 96) {
      ip = { family: 4, bytes: v6.slice(12) };
      prefix -= 96;
    } else {
      ip = { family: 6, bytes: v6 };
    }
  } else {
    const v4 = parseIpv4(addrText);
    if (!v4 || prefix > 32) return null;
    ip = { family: 4, bytes: v4 };
  }
  return cidrOf(ip.family, ip.bytes, prefix);
}

/** Canonical text of an address or range; null when it is neither. */
export function normalizeCidr(input: string): string | null {
  return parseCidr(input)?.text ?? null;
}

function toBig(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function fromBig(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** First and last address of a range, as integers. */
export function cidrBounds(cidr: Cidr): { start: bigint; end: bigint } {
  const start = toBig(cidr.bytes);
  const hostBits = BigInt(bitsOf(cidr.family) - cidr.prefix);
  return { start, end: start + (1n << hostBits) - 1n };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp | string): boolean {
  const addr = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!addr || addr.family !== cidr.family) return false;
  const value = toBig(addr.bytes);
  const { start, end } = cidrBounds(cidr);
  return value >= start && value <= end;
}

/** Does `outer` cover every address of `inner`? */
export function cidrCovers(outer: Cidr, inner: Cidr): boolean {
  if (outer.family !== inner.family || outer.prefix > inner.prefix) return false;
  const a = cidrBounds(outer);
  const b = cidrBounds(inner);
  return b.start >= a.start && b.end <= a.end;
}

/** Do two ranges share an address? Ranges nest or are apart, so one then covers the other. */
export function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  return cidrCovers(a, b) || cidrCovers(b, a);
}

/**
 * The smallest list of ranges covering exactly the same addresses: duplicates and ranges
 * inside another go, and two halves of one range become that range. Sorted, IPv4 first.
 * nftables refuses an interval set whose elements overlap, which is what this is for.
 */
export function mergeCidrs(list: readonly Cidr[]): Cidr[] {
  const out: Cidr[] = [];
  for (const family of [4, 6] as const) {
    const bits = bitsOf(family);
    let ranges = list
      .filter((c) => c.family === family)
      .map((c) => ({ ...cidrBounds(c), cidr: c }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end > b.end ? -1 : a.end < b.end ? 1 : 0));
    // Drop what the range before it already covers.
    const kept: typeof ranges = [];
    for (const r of ranges) {
      const last = kept[kept.length - 1];
      if (last && r.start >= last.start && r.end <= last.end) continue;
      kept.push(r);
    }
    ranges = kept;
    // Join sibling halves until nothing changes; each pass can only shorten the list.
    let merged = true;
    while (merged) {
      merged = false;
      const next: typeof ranges = [];
      for (const r of ranges) {
        const last = next[next.length - 1];
        if (last && last.cidr.prefix === r.cidr.prefix && r.cidr.prefix > 0 && last.end + 1n === r.start) {
          const parent = cidrOf(family, fromBig(last.start, bits / 8), r.cidr.prefix - 1);
          const bounds = cidrBounds(parent);
          if (bounds.start === last.start && bounds.end === r.end) {
            next[next.length - 1] = { ...bounds, cidr: parent };
            merged = true;
            continue;
          }
        }
        next.push(r);
      }
      ranges = next;
    }
    out.push(...ranges.map((r) => r.cidr));
  }
  return out;
}

/**
 * A fixed set of ranges to test addresses against, fast: a binary search over sorted,
 * merged bounds. Every access-log line is checked against the trusted proxies' ranges, which
 * is tens of thousands of lookups a minute on a busy server.
 */
export class CidrSet {
  private readonly starts: Record<IpFamily, bigint[]> = { 4: [], 6: [] };
  private readonly ends: Record<IpFamily, bigint[]> = { 4: [], 6: [] };
  readonly cidrs: readonly Cidr[];

  constructor(entries: Iterable<Cidr | string> = []) {
    const parsed: Cidr[] = [];
    for (const entry of entries) {
      const cidr = typeof entry === 'string' ? parseCidr(entry) : entry;
      if (cidr) parsed.push(cidr);
    }
    this.cidrs = mergeCidrs(parsed);
    for (const cidr of this.cidrs) {
      const { start, end } = cidrBounds(cidr);
      this.starts[cidr.family].push(start);
      this.ends[cidr.family].push(end);
    }
  }

  get size(): number {
    return this.cidrs.length;
  }

  has(ip: ParsedIp | string | null | undefined): boolean {
    const addr = typeof ip === 'string' ? parseIp(ip) : ip;
    if (!addr) return false;
    const starts = this.starts[addr.family];
    const ends = this.ends[addr.family];
    const value = toBig(addr.bytes);
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (value < starts[mid]!) hi = mid - 1;
      else if (value > ends[mid]!) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

/**
 * Networks that are never a visitor on the internet: loopback, RFC 1918, carrier-grade NAT,
 * link-local, unique-local IPv6 and the unspecified addresses. Docker's own bridges live in
 * here too - which is what an IPv6 visitor looks like to Traefik when Docker has no IPv6
 * networking and its proxy forwards the connection from the bridge's gateway.
 */
export const PRIVATE_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

const PRIVATE = new CidrSet(PRIVATE_RANGES);

export function isPrivateIp(ip: ParsedIp | string): boolean {
  return PRIVATE.has(ip);
}

/**
 * What one visitor is counted as. An IPv4 address is one visitor; an IPv6 visitor is its /64,
 * because a single home or server is handed at least that much and rotates through it freely -
 * counting single IPv6 addresses would let one attacker be thousands of fresh ones.
 */
export function visitorKey(ip: ParsedIp | string): Cidr | null {
  const addr = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!addr) return null;
  return cidrOf(addr.family, addr.bytes, addr.family === 4 ? 32 : 64);
}

/**
 * The widest range an operator may block or trust by hand. A typo that blocks a /4 takes a
 * continent off every site in the fleet; nothing legitimate needs more than these.
 */
export const WIDEST_PREFIX: Record<IpFamily, number> = { 4: 8, 6: 16 };

/** Why an address or range typed into a form cannot be used; null when it can. */
export function cidrInputProblem(input: string): string | null {
  const text = input.trim();
  if (!text) return 'Enter an address or a range';
  const cidr = parseCidr(text);
  if (!cidr) return `"${text}" is not an IP address or a range like 203.0.113.0/24`;
  if (cidr.prefix < WIDEST_PREFIX[cidr.family]) {
    return `/${cidr.prefix} is too wide; the widest range allowed is /${WIDEST_PREFIX[cidr.family]} for IPv${cidr.family}`;
  }
  return null;
}
