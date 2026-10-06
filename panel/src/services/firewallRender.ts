/**
 * The two files that put blocked addresses in force on a server (services/firewallSync.ts
 * decides where they go). Pure.
 *
 * - `wpl7-firewall/wpl7.nft`: the network layer. A table of its own, `inet wpl7`, whose one
 *   chain hooks `prerouting` at priority -310 - before Docker forwards the published ports -
 *   and drops only TCP 80 and 443 from a blocked address. SSH and FTP keep their own
 *   protection. Allow sets first; timed blocks carry their timeout into the kernel, which lets
 *   them go on time whether or not the panel is running. Loaded by `wpl7-firewall apply` in
 *   one transaction.
 *
 * - `traefik/dynamic/wpl7-blocked.yml`: the HTTP layer, for what the network layer cannot see.
 *   A visitor behind Cloudflare connects from Cloudflare, so their address is only in a header;
 *   one router per trusted proxy matches that header against the list. And where the network
 *   layer is missing, a router refuses direct visitors too. The panel's own host is left out.
 */
// @docs security/blocked-addresses
import crypto from 'node:crypto';
import { cidrBounds, cidrCovers, mergeCidrs, type Cidr } from '../../shared/cidr.js';
import { BLOCKED_ROUTER_PREFIX } from '../../shared/security.js';
import { headerRegex } from '../lib/addressRegex.js';
import type { TrustedProxy } from '../lib/clientIp.js';
import { PRIORITY, guard, type DynamicConfig, type TraefikRouter } from './securityConfig.js';

/** Most blocks matched through a proxy's header; the newest win past it. */
export const MAX_PROXIED = 5_000;
/** Most blocks the HTTP fallback refuses to direct visitors. */
export const MAX_DIRECT = 2_000;

// ---------------------------------------------------------------------------
// The network layer

export interface NftPlan {
  allow: Cidr[];
  /** Blocks until lifted. */
  permanent: Cidr[];
  /** Blocks with an end, which the kernel enforces. */
  timed: { cidr: Cidr; expiresAt: number }[];
}

export interface BlockForRender {
  cidr: Cidr;
  /** null = until lifted. */
  expiresAt: number | null;
  createdAt: number;
}

/**
 * What the network layer should hold. nftables refuses an interval set whose elements overlap,
 * so the lists are merged; a timed block inside a permanent one is left out, and of two timed
 * blocks where one covers the other the one that lasts longer stays.
 */
export function planNft(blocks: readonly BlockForRender[], allow: readonly Cidr[], now: number): NftPlan {
  const permanent = mergeCidrs(blocks.filter((b) => b.expiresAt === null).map((b) => b.cidr));
  const candidates = blocks
    // Under a second left: the kernel would get a timeout of 0, which means none at all.
    .filter((b): b is BlockForRender & { expiresAt: number } => b.expiresAt !== null && b.expiresAt - now >= 1000)
    .filter((b) => !permanent.some((p) => cidrCovers(p, b.cidr)))
    .sort((a, b) => b.expiresAt - a.expiresAt);
  const timed: NftPlan['timed'] = [];
  for (const b of candidates) {
    if (timed.some((t) => cidrCovers(t.cidr, b.cidr) || cidrCovers(b.cidr, t.cidr))) continue;
    timed.push({ cidr: b.cidr, expiresAt: b.expiresAt });
  }
  timed.sort((a, b) => compareCidr(a.cidr, b.cidr));
  return { allow: mergeCidrs(allow), permanent, timed };
}

function compareCidr(a: Cidr, b: Cidr): number {
  if (a.family !== b.family) return a.family - b.family;
  const x = cidrBounds(a).start;
  const y = cidrBounds(b).start;
  return x < y ? -1 : x > y ? 1 : a.prefix - b.prefix;
}

/**
 * What the plan means, independent of when it is written: the timeouts in the file count down
 * from the moment it is rendered, so the file itself changes every time. A server is only
 * loaded again when this changes (or its table is gone, or it rebooted).
 */
export function nftMeaning(plan: NftPlan): string {
  const text = JSON.stringify({
    allow: plan.allow.map((c) => c.text),
    permanent: plan.permanent.map((c) => c.text),
    timed: plan.timed.map((t) => [t.cidr.text, t.expiresAt]),
  });
  return crypto.createHash('sha256').update(text).digest('hex');
}

function elements(items: string[]): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 8) {
    const chunk = items.slice(i, i + 8).join(', ');
    lines.push(i + 8 < items.length ? `${chunk},` : chunk);
  }
  return ['\t\telements = {', ...lines.map((l) => `\t\t\t${l}`), '\t\t}'];
}

function set(name: string, family: 4 | 6, flags: string, items: string[]): string[] {
  return [`\tset ${name} {`, `\t\ttype ${family === 4 ? 'ipv4_addr' : 'ipv6_addr'}`, `\t\tflags ${flags}`, ...elements(items), '\t}'];
}

/** The table, ready for `nft -f`: created if missing, then deleted and defined again - one transaction. */
export function renderNft(plan: NftPlan, now: number): string {
  const of = (list: Cidr[], family: 4 | 6) => list.filter((c) => c.family === family).map((c) => c.text);
  const timed = (family: 4 | 6) =>
    plan.timed
      .filter((t) => t.cidr.family === family)
      .map((t) => `${t.cidr.text} timeout ${Math.max(1, Math.ceil((t.expiresAt - now) / 1000))}s`);
  return [
    '#!/usr/sbin/nft -f',
    '# Written by the WPL7 panel (Security -> Blocked addresses) and loaded by `wpl7-firewall apply`.',
    '# Replaced on every change; an edit here lasts until the next one. `wpl7-firewall off` removes it.',
    'table inet wpl7',
    'delete table inet wpl7',
    'table inet wpl7 {',
    ...set('allow4', 4, 'interval', of(plan.allow, 4)),
    ...set('allow6', 6, 'interval', of(plan.allow, 6)),
    ...set('block4', 4, 'interval', of(plan.permanent, 4)),
    ...set('block6', 6, 'interval', of(plan.permanent, 6)),
    ...set('timed4', 4, 'interval, timeout', timed(4)),
    ...set('timed6', 6, 'interval, timeout', timed(6)),
    '\tchain prerouting {',
    // Before Docker forwards the published ports (nat at -100) and before connection tracking
    // (-200): a dropped packet here costs nothing and leaves no state behind.
    '\t\ttype filter hook prerouting priority -310; policy accept;',
    '\t\tip saddr @allow4 accept',
    '\t\tip6 saddr @allow6 accept',
    '\t\tip saddr @block4 tcp dport { 80, 443 } drop',
    '\t\tip6 saddr @block6 tcp dport { 80, 443 } drop',
    '\t\tip saddr @timed4 tcp dport { 80, 443 } drop',
    '\t\tip6 saddr @timed6 tcp dport { 80, 443 } drop',
    '\t}',
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The HTTP layer

export interface BlockedFileInput {
  proxies: readonly TrustedProxy[];
  /** Blocks in force. */
  blocks: readonly BlockForRender[];
  /** Refuse direct visitors here too: the network layer is missing or off on this server. */
  direct: boolean;
  /** The panel's own host, never refused here. */
  panelHost: string | null;
  tlsMode: 'letsencrypt' | 'staging' | 'none';
}

export interface BlockedFile {
  config: DynamicConfig | null;
  /** Blocks matched behind the proxies, and refused to direct visitors here. */
  proxied: number;
  direct: number;
  /** Left out: past a ceiling, or a range a header cannot be matched against. */
  skipped: number;
}

export function buildBlockedFile(input: BlockedFileInput): BlockedFile {
  const newest = [...input.blocks].sort((a, b) => b.createdAt - a.createdAt);
  const https = input.tlsMode !== 'none';
  const routers: Record<string, TraefikRouter> = {};
  const deny = `${BLOCKED_ROUTER_PREFIX}_deny`;
  const notPanel = input.panelHost ? `!Host(\`${guard(input.panelHost, 'host')}\`) && ` : '';
  const base = {
    priority: PRIORITY.blocked,
    entryPoints: [https ? 'websecure' : 'web'],
    service: 'wpl7-deny',
    middlewares: [deny],
    ...(https ? { tls: {} as Record<string, never> } : {}),
  };
  let skipped = 0;

  const proxiedBlocks = newest.slice(0, MAX_PROXIED);
  skipped += newest.length - proxiedBlocks.length;
  const { regex, skipped: unmatched } = headerRegex(proxiedBlocks.map((b) => b.cidr));
  skipped += input.proxies.length > 0 ? unmatched : 0;
  let proxied = 0;
  if (regex) {
    input.proxies.forEach((proxy, i) => {
      if (proxy.ranges.size === 0) return;
      const from = proxy.ranges.cidrs.map((c) => `ClientIP(\`${guard(c.text, 'address')}\`)`);
      routers[`${BLOCKED_ROUTER_PREFIX}_p${i}`] = {
        ...base,
        rule: `${notPanel}(${from.join(' || ')}) && HeaderRegexp(\`${guard(proxy.header, 'header')}\`, \`${guard(regex, 'addresses')}\`)`,
      };
    });
    if (input.proxies.length > 0) proxied = proxiedBlocks.length - unmatched;
  }

  let direct = 0;
  if (input.direct && newest.length > 0) {
    const directBlocks = newest.slice(0, MAX_DIRECT);
    skipped += newest.length - directBlocks.length;
    routers[`${BLOCKED_ROUTER_PREFIX}_direct`] = {
      ...base,
      rule: `${notPanel}(${directBlocks.map((b) => `ClientIP(\`${guard(b.cidr.text, 'address')}\`)`).join(' || ')})`,
    };
    direct = directBlocks.length;
  }

  if (Object.keys(routers).length === 0) return { config: null, proxied: 0, direct: 0, skipped };
  return {
    config: {
      http: {
        routers,
        middlewares: { [deny]: { ipAllowList: { sourceRange: ['255.255.255.255/32'] } } },
        // Never reached - the refusal answers first - but a router needs a real service to be
        // in the access log, which is how its refusals are counted.
        services: { 'wpl7-deny': { loadBalancer: { servers: [{ url: 'http://127.0.0.1:9' }] } } },
      },
    },
    proxied,
    direct,
    skipped,
  };
}

export const BLOCKED_FILE = 'wpl7-blocked.yml';
