/**
 * The visitor's own address, for a request that may have come through a CDN.
 *
 * Behind Cloudflare, Traefik's peer is one of Cloudflare's edge servers, and the visitor is
 * in a header Cloudflare added. Anybody can send that header, though, so it only counts when
 * the connection itself came from the proxy's published ranges: a forged `Cf-Connecting-Ip`
 * from anywhere else is ignored and the peer stays the visitor. Pure; the ranges and the
 * setting are resolved by services/proxyRanges.ts.
 */
import { CidrSet, normalizeIp, parseIp } from '../../shared/cidr.js';
import type { ProxyHeader } from '../../shared/security.js';

export interface TrustedProxy {
  /** `cloudflare`, or the name an operator gave a proxy of their own. */
  name: string;
  header: ProxyHeader;
  /** Where the proxy connects from. */
  ranges: CidrSet;
}

export type ProxyHeaders = Partial<Record<ProxyHeader, string>>;

export interface ResolvedClient {
  /** The visitor: the header's address through a trusted proxy, the peer otherwise. */
  clientIp: string;
  /** The proxy the visitor came through; null for a direct connection. */
  via: string | null;
}

/** The proxy a peer address belongs to, if it is one. */
export function proxyOf(peer: string, proxies: readonly TrustedProxy[]): TrustedProxy | null {
  const ip = parseIp(peer);
  if (!ip) return null;
  return proxies.find((p) => p.ranges.has(ip)) ?? null;
}

export function resolveClient(peer: string, headers: ProxyHeaders, proxies: readonly TrustedProxy[]): ResolvedClient {
  const direct = { clientIp: normalizeIp(peer) ?? peer, via: null };
  const proxy = proxyOf(peer, proxies);
  if (!proxy) return direct;
  // One address, as every one of these vendors sends it. Anything else - a list, a hostname,
  // nothing at all (a CDN's own health check) - leaves the proxy as the only address known,
  // which is never blocked (a trusted proxy is on the protected list).
  const value = headers[proxy.header];
  const visitor = value ? normalizeIp(value) : null;
  return visitor ? { clientIp: visitor, via: proxy.name } : direct;
}
