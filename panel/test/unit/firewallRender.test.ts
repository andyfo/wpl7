import { describe, expect, it } from 'vitest';
import { CidrSet, cidrContains, formatIp, parseCidr, parseIp, type Cidr } from '../../shared/cidr.js';
import { addressPatterns, headerRegex } from '../../src/lib/addressRegex.js';
import type { TrustedProxy } from '../../src/lib/clientIp.js';
import { MAX_DIRECT, buildBlockedFile, nftMeaning, planNft, renderNft, type BlockForRender } from '../../src/services/firewallRender.js';
import { renderDynamicFile } from '../../src/services/securityConfig.js';
import { goRegex, ruleMatches } from '../traefikSim.js';

const c = (text: string) => parseCidr(text)!;
const block = (text: string, expiresAt: number | null = null, createdAt = 0): BlockForRender => ({ cidr: c(text), expiresAt, createdAt });
const NOW = 1_800_000_000_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the network layer', () => {
  it('keeps permanent and timed blocks apart, merged so no two overlap', () => {
    const plan = planNft(
      [
        block('198.18.0.0/25'),
        block('198.18.0.128/25'),
        block('198.18.0.7', NOW + 3600_000),
        block('198.18.5.5', NOW + 3600_000),
        block('198.18.5.0/24', NOW + 60_000),
        block('2001:db8:1:2::/64', NOW + 7200_000),
        block('198.18.9.9', NOW + 500),
      ],
      [c('10.0.0.0/8'), c('10.1.0.0/16'), c('203.0.113.10')],
      NOW,
    );
    expect(plan.permanent.map((x) => x.text)).toEqual(['198.18.0.0/24']);
    // Inside a permanent block: nothing to add. Of two timed ones that overlap, the longer
    // stays. Under a second left: the kernel would read a timeout of 0 as none at all.
    expect(plan.timed.map((t) => t.cidr.text)).toEqual(['198.18.5.5', '2001:db8:1:2::/64']);
    expect(plan.allow.map((x) => x.text)).toEqual(['10.0.0.0/8', '203.0.113.10']);
  });

  it('writes one table, replaced in one transaction, dropping only web traffic', () => {
    const plan = planNft([block('198.18.0.1'), block('2001:db8:1:2::/64', NOW + 3_599_400)], [c('203.0.113.10')], NOW);
    const text = renderNft(plan, NOW);
    expect(text.split('\n').slice(3, 6)).toEqual(['table inet wpl7', 'delete table inet wpl7', 'table inet wpl7 {']);
    expect(text).toContain('type filter hook prerouting priority -310; policy accept;');
    expect(text).toContain('ip saddr @block4 tcp dport { 80, 443 } drop');
    expect(text).toContain('2001:db8:1:2::/64 timeout 3600s');
    // An empty set has no elements line at all: `elements = { }` does not parse.
    expect(text).not.toMatch(/elements = \{\s*\}/);
    expect(text).not.toMatch(/flush ruleset/);
  });

  it('means the same thing whenever it is written, so nothing is loaded again for nothing', () => {
    const blocks = [block('198.18.0.1', NOW + 3600_000)];
    const a = planNft(blocks, [], NOW);
    const b = planNft(blocks, [], NOW + 60_000);
    expect(renderNft(a, NOW)).not.toBe(renderNft(b, NOW + 60_000));
    expect(nftMeaning(a)).toBe(nftMeaning(b));
    expect(nftMeaning(planNft([block('198.18.0.2', NOW + 3600_000)], [], NOW))).not.toBe(nftMeaning(a));
  });

  it('splits a long list over lines', () => {
    const many = Array.from({ length: 50 }, (_, i) => block(`198.18.${i}.1`));
    const text = renderNft(planNft(many, [], NOW), NOW);
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThan(200);
    expect(text.match(/198\.18\.\d+\.1/g)).toHaveLength(50);
  });
});

describe('matching a blocked address in a proxy header', () => {
  const matches = (cidr: Cidr, address: string) => {
    const { regex } = headerRegex([cidr]);
    return goRegex(regex!).test(address);
  };

  it('matches an address, a /24 and a range that is no whole octet', () => {
    expect(matches(c('198.18.9.9'), '198.18.9.9')).toBe(true);
    expect(matches(c('198.18.9.9'), '198.18.9.91')).toBe(false);
    expect(matches(c('198.18.9.0/24'), '198.18.9.200')).toBe(true);
    expect(matches(c('198.18.9.0/24'), '198.18.91.2')).toBe(false);
    expect(matches(c('198.18.16.0/20'), '198.18.31.4')).toBe(true);
    expect(matches(c('198.18.16.0/20'), '198.18.32.4')).toBe(false);
    expect(matches(c('198.18.9.16/28'), '198.18.9.31')).toBe(true);
    expect(matches(c('198.18.9.16/28'), '198.18.9.32')).toBe(false);
  });

  it('matches exactly the addresses of an IPv6 range, however they are compressed', () => {
    const r = rng(11);
    const prefixes = ['2001:db8:1:2::/64', '2001:db8:0:0::/64', '2001:0:0:5::/64', '2001:db8:0:5::/64', '2001:db8::/32', '2a02:0:0:0::/64', '2001:db8:ab00::/48'];
    for (const text of prefixes) {
      const cidr = c(text);
      const { regex } = headerRegex([cidr]);
      const re = goRegex(regex!);
      for (let i = 0; i < 400; i++) {
        // Inside: the prefix with a host part that is often zero; outside: one prefix group off.
        const bytes = new Uint8Array(cidr.bytes);
        for (let b = cidr.prefix / 8; b < 16; b++) bytes[b] = r() < 0.5 ? 0 : Math.floor(r() * 256);
        if (i % 2 === 1) {
          const g = Math.floor(r() * (cidr.prefix / 16)) * 2 + 1;
          bytes[g] = bytes[g]! ^ (1 + Math.floor(r() * 3));
        }
        const address = formatIp({ family: 6, bytes });
        expect(re.test(address), `${text} vs ${address}`).toBe(cidrContains(cidr, parseIp(address)!));
        expect(re.test(address.toUpperCase()), 'case').toBe(cidrContains(cidr, parseIp(address)!));
      }
    }
  });

  it('matches one whole address when asked to - never a list, or anything after it', () => {
    const whole = (cidr: Cidr, address: string) => goRegex(headerRegex([cidr], { whole: true }).regex!).test(address);
    const r = rng(7);
    for (const text of ['192.0.64.0/18', '195.234.108.0/22', '198.18.9.0/24', '198.18.9.16/28', '122.248.245.244', '10.0.0.0/8', '198.0.0.0/9']) {
      const cidr = c(text);
      const flip = (bytes: Uint8Array, bit: number) => (bytes[bit >> 3] = bytes[bit >> 3]! ^ (0x80 >> (bit & 7)));
      for (let i = 0; i < 400; i++) {
        // Inside: the range's own bits, any host part; outside: one of its bits flipped.
        const bytes = new Uint8Array(cidr.bytes);
        for (let bit = cidr.prefix; bit < 32; bit++) if (r() < 0.5) flip(bytes, bit);
        if (i % 2 === 1) flip(bytes, Math.floor(r() * cidr.prefix));
        const address = formatIp({ family: 4, bytes });
        expect(whole(cidr, address), `${text} vs ${address}`).toBe(cidrContains(cidr, parseIp(address)!));
      }
      const inside = formatIp({ family: 4, bytes: cidr.bytes });
      for (const more of [', 198.18.1.1', '.7', 'x', ':443']) expect(whole(cidr, `${inside}${more}`), `${text}: ${inside}${more}`).toBe(false);
    }
    expect(whole(c('192.0.64.0/18'), '192.0.80.256')).toBe(false);
    expect(whole(c('192.0.64.0/18'), '192.0.80.05')).toBe(false);
    // IPv6: the groups the range fixes exactly, the rest held to the characters of an address.
    expect(whole(c('2001:db8:1:2::/64'), '2001:db8:1:2::5')).toBe(true);
    expect(whole(c('2001:db8:1:2::/64'), '2001:DB8:1:2:0:0:0:5')).toBe(true);
    expect(whole(c('2001:db8:1:2::/64'), '2001:db8:1:2::5, 198.18.1.1')).toBe(false);
    expect(whole(c('2001:db8:1:2::/64'), '2001:db8:1:3::5')).toBe(false);
  });

  it('says which ranges it cannot match rather than matching them wrongly', () => {
    expect(addressPatterns(c('2001:db8::/56'))).toBeNull();
    expect(headerRegex([c('2001:db8::/56'), c('198.18.0.1')])).toMatchObject({ skipped: 1 });
    // Every IPv4 range can: at most 128 values of one octet.
    expect(matches(c('198.0.0.0/9'), '198.127.4.4')).toBe(true);
    expect(matches(c('198.0.0.0/9'), '198.128.4.4')).toBe(false);
  });
});

describe('the HTTP layer', () => {
  const cloudflare: TrustedProxy = { name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(['173.245.48.0/20']) };
  const base = { proxies: [cloudflare], panelHost: 'panel.example.com', tlsMode: 'letsencrypt' as const };

  it("refuses a blocked visitor behind a proxy by the proxy's header, and never on the panel", () => {
    const file = buildBlockedFile({ ...base, blocks: [block('198.18.9.9'), block('2001:db8:1:2::/64')], direct: false });
    expect(file).toMatchObject({ proxied: 2, direct: 0, skipped: 0 });
    const router = file.config!.http.routers['wpl7blk_p0']!;
    expect(router).toMatchObject({ priority: 1_000_000, service: 'wpl7-deny', middlewares: ['wpl7blk_deny'], tls: {} });
    const req = (host: string, peer: string, visitor?: string) => ({
      host,
      path: '/',
      peer,
      headers: visitor ? { 'Cf-Connecting-Ip': visitor } : {},
    });
    expect(ruleMatches(router.rule, req('shop.example.com', '173.245.48.9', '198.18.9.9'))).toBe(true);
    expect(ruleMatches(router.rule, req('shop.example.com', '173.245.48.9', '2001:db8:1:2::9'))).toBe(true);
    expect(ruleMatches(router.rule, req('shop.example.com', '173.245.48.9', '198.18.9.10'))).toBe(false);
    // The header from anyone else, and the panel's own host, never.
    expect(ruleMatches(router.rule, req('shop.example.com', '198.51.100.1', '198.18.9.9'))).toBe(false);
    expect(ruleMatches(router.rule, req('panel.example.com', '173.245.48.9', '198.18.9.9'))).toBe(false);
    // Direct visitors are the network layer's; nothing here for them.
    expect(file.config!.http.routers['wpl7blk_direct']).toBeUndefined();
  });

  it('refuses direct visitors too where the network layer is missing, the newest first past its ceiling', () => {
    const blocks = Array.from({ length: MAX_DIRECT + 5 }, (_, i) => block(`198.18.${Math.floor(i / 250)}.${i % 250}`, null, i));
    const file = buildBlockedFile({ ...base, proxies: [], blocks, direct: true });
    expect(file).toMatchObject({ direct: MAX_DIRECT, proxied: 0, skipped: 5 });
    const rule = file.config!.http.routers['wpl7blk_direct']!.rule;
    expect(ruleMatches(rule, { host: 'x.test', path: '/', peer: `198.18.${Math.floor((MAX_DIRECT + 4) / 250)}.${(MAX_DIRECT + 4) % 250}` })).toBe(true);
    expect(ruleMatches(rule, { host: 'x.test', path: '/', peer: '198.18.0.0' })).toBe(false);
  });

  it('writes no file when nothing is blocked, and a file Traefik can read when something is', () => {
    expect(buildBlockedFile({ ...base, blocks: [], direct: true }).config).toBeNull();
    const file = buildBlockedFile({ ...base, blocks: [block('2001:db8:1:2::/64'), block('198.18.0.0/20')], direct: true });
    const text = renderDynamicFile(file.config!);
    expect(text).toContain('wpl7-deny:');
    expect(text).toContain('url: "http://127.0.0.1:9"');
    expect(text).not.toMatch(/\{\{|\}\}/);
  });
});
