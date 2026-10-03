/**
 * An address in a proxy's header, for Traefik's `HeaderRegexp` (Go's RE2). Behind a trusted
 * proxy the header is all a rule has of the visitor: blocked addresses are refused by it
 * (services/firewallRender.ts), and Jetpack is let through the XML-RPC rules by it
 * (services/securityConfig.ts). Pure.
 */
import { formatIp, type Cidr } from '../../shared/cidr.js';

const escapeRe = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const GROUP = '[0-9a-f]{1,4}';
/** One IPv4 octet, without leading zeros. */
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';

export interface PatternOpts {
  /**
   * The whole header, one address and nothing after it. Without it a pattern may match the
   * start of a longer value - good enough to refuse by, never to let anyone through by.
   */
  whole?: boolean;
}

/**
 * Regular expressions matching exactly the addresses of a range, written the way a proxy
 * writes one - IPv4 dotted, IPv6 as RFC 5952 compresses it, in any case. Each alternative is
 * anchored. Null when the range cannot be written that way in reasonable space: an IPv6 range
 * whose prefix is not a multiple of 16 bits (a /56, say). Direct visitors of such a range are
 * still refused by the network layer.
 */
export function addressPatterns(cidr: Cidr, opts: PatternOpts = {}): string[] | null {
  return cidr.family === 4 ? ipv4Patterns(cidr, opts.whole === true) : ipv6Patterns(cidr, opts.whole === true);
}

function ipv4Patterns(cidr: Cidr, whole: boolean): string[] | null {
  const octets = [...cidr.bytes];
  const full = Math.floor(cidr.prefix / 8);
  const rest = cidr.prefix - full * 8;
  const head = octets.slice(0, full).map(String);
  // The octets the range leaves free: whatever follows, or - whole - exactly that many.
  const free = (n: number) => (whole ? `${Array.from({ length: n }, () => OCTET).join('\\.')}$` : '');
  if (rest === 0) {
    if (full === 4) return [`^${escapeRe(head.join('.'))}$`];
    return [`^${escapeRe(head.join('.'))}${full > 0 ? '\\.' : ''}${free(4 - full)}`];
  }
  const count = 2 ** (8 - rest);
  if (count > 128) return null;
  const start = octets[full]!;
  const values = Array.from({ length: count }, (_, i) => String(start + i)).join('|');
  const lead = head.length > 0 ? `${escapeRe(head.join('.'))}\\.` : '';
  return [`^${lead}(?:${values})${full === 3 ? '$' : `\\.${free(3 - full)}`}`];
}

function ipv6Patterns(cidr: Cidr, whole: boolean): string[] | null {
  if (cidr.prefix === 128) return [`^${escapeRe(formatIp({ family: 6, bytes: cidr.bytes }))}$`];
  if (cidr.prefix % 16 !== 0 || cidr.prefix === 0) return null;
  const k = cidr.prefix / 16;
  const groups: string[] = [];
  for (let i = 0; i < k; i++) groups.push(((cidr.bytes[i * 2]! << 8) | cidr.bytes[i * 2 + 1]!).toString(16));
  const out: string[] = [];
  // Every group written out: the compressed run, if any, is later in the address. Whole, the
  // rest is held to the characters an address has - no list, no second address after it.
  out.push(`^${groups.join(':')}:${whole ? '[0-9a-f:]+$' : ''}`);
  // The zero groups the prefix ends with, compressed together with however many of the rest
  // are zero. The run is at least 2 groups and covers the whole zero tail, which caps what
  // can follow it.
  let tail = k;
  while (tail > 0 && groups[tail - 1] === '0') tail--;
  if (tail < k) {
    const maxAfter = Math.min(8 - k, 6 - tail);
    if (maxAfter >= 0) {
      const after = maxAfter === 0 ? '' : `(?:${GROUP}(?::${GROUP}){0,${maxAfter - 1}})?`;
      out.push(`^${groups.slice(0, tail).join(':')}::${after}$`);
    }
  }
  // A run of two or more zero groups inside the prefix, compressed there: the address is then
  // exactly as long as the run implies.
  for (let i = 0; i < k; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < k && groups[j + 1] === '0') j++;
    if (j < k - 1 && j - i + 1 >= 2) {
      const before = groups.slice(0, i).join(':');
      const between = groups.slice(j + 1, k).join(':');
      out.push(`^${before}::${between}(?::${GROUP}){${8 - k}}$`);
    }
    i = j + 1;
  }
  return out;
}

/** One case-insensitive pattern for a list of ranges, and what could not be put in it. */
export function headerRegex(cidrs: readonly Cidr[], opts: PatternOpts = {}): { regex: string | null; skipped: number } {
  const alternatives: string[] = [];
  let skipped = 0;
  for (const cidr of cidrs) {
    const patterns = addressPatterns(cidr, opts);
    if (!patterns) skipped++;
    else alternatives.push(...patterns);
  }
  return { regex: alternatives.length === 0 ? null : `(?i)(?:${alternatives.join('|')})`, skipped };
}
