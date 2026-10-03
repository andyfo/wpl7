/**
 * Address parsing for the visitor statistics: numeric forms for range lookup, and the
 * "is this a real visitor's address at all" tests. Pure; no I/O.
 */

/** Dotted quad -> unsigned 32-bit integer. Null for anything that is not one. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/**
 * The top 64 bits of an IPv6 address, as a BigInt.
 *
 * Registry delegations are /48 or shorter in practice (/32 for most allocations), so the
 * first half of the address is all a country lookup needs - and halving the key keeps the
 * search arrays half the size.
 */
export function ipv6Top64(ip: string): bigint | null {
  const zone = ip.indexOf('%'); // fe80::1%eth0
  const bare = (zone === -1 ? ip : ip.slice(0, zone)).toLowerCase();
  if (!bare.includes(':')) return null;

  // ::ffff:203.0.113.7 and friends: a v4 address wearing a v6 hat.
  const lastColon = bare.lastIndexOf(':');
  const tail = bare.slice(lastColon + 1);
  let groups: string[];
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    groups = expandGroups(bare.slice(0, lastColon + 1) + '0:0');
    if (groups.length !== 8) return null;
    groups[6] = ((v4 >>> 16) & 0xffff).toString(16);
    groups[7] = (v4 & 0xffff).toString(16);
  } else {
    groups = expandGroups(bare);
    if (groups.length !== 8) return null;
  }

  let out = 0n;
  for (let i = 0; i < 4; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

/** Expand `::` into the zero groups it stands for. Returns [] when the address is malformed. */
function expandGroups(addr: string): string[] {
  const halves = addr.split('::');
  if (halves.length > 2) return [];
  if (halves.length === 1) return addr.split(':');
  const head = halves[0] ? halves[0]!.split(':') : [];
  const tail = halves[1] ? halves[1]!.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return [];
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

/**
 * Addresses no country lookup should be attempted for, and that are not worth listing as
 * "top visitors": loopback, RFC1918, link-local, CGNAT, and the v6 equivalents. On a
 * correctly configured stack these never appear - Traefik reports the real peer - but a
 * misconfigured proxy in front would turn every visitor into one internal address.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}
