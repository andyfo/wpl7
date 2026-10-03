import { describe, expect, it } from 'vitest';
import { SettingsService } from '../../src/services/settings.js';
import { AI_SOURCES, ProxyRangesService, RANGE_SOURCES, parsePrefixList, parseRangeList } from '../../src/services/proxyRanges.js';
import { resolveClient } from '../../src/lib/clientIp.js';
import { trustedProxiesSchema } from '../../shared/security.js';
import { createTestDb } from '../helpers.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A fetch answering each URL from `bodies`; anything else is a 404. */
function fetchFrom(bodies: Record<string, string | number>): typeof fetch {
  return (async (input: string | URL) => {
    const body = bodies[String(input)];
    if (typeof body === 'number') return new Response('', { status: body });
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

const CF_V4 = Array.from({ length: 12 }, (_, i) => `104.${16 + i}.0.0/16`).join('\n');
const CF_V6 = '2400:cb00::/32\n2606:4700::/32\n';
const JETPACK = '192.0.64.0/18\n122.248.245.244/32\n54.217.201.243/32\n';

function service(fetchImpl: typeof fetch) {
  const settings = new SettingsService(createTestDb());
  return { settings, ranges: new ProxyRangesService(settings, quiet, fetchImpl) };
}

describe('parseRangeList', () => {
  it('reads a vendor list, comments and blank lines skipped', () => {
    expect(parseRangeList('# ranges\n173.245.48.0/20\n\n2400:cb00::/32\n')).toEqual({ ranges: ['173.245.48.0/20', '2400:cb00::/32'] });
  });

  it('refuses a list with anything a proxy cannot be', () => {
    expect(parseRangeList('<html>')).toHaveProperty('problem');
    expect(parseRangeList('10.0.0.0/8')).toHaveProperty('problem');
    expect(parseRangeList('0.0.0.0/0')).toHaveProperty('problem');
  });
});

describe('parsePrefixList', () => {
  const doc = (...prefixes: object[]) => JSON.stringify({ creationTime: '2026-09-30T00:00:00Z', prefixes });

  it("reads Google's JSON format, which the AI companies publish theirs in", () => {
    expect(parsePrefixList(doc({ ipv4Prefix: '216.73.216.0/22' }, { ipv6Prefix: '2001:4860:c::/48' }, { ipv4Prefix: '34.162.230.222/32' }))).toEqual({
      ranges: ['216.73.216.0/22', '2001:4860:c::/48', '34.162.230.222'],
    });
  });

  it('refuses anything else, and a range wider than the list may hold', () => {
    expect(parsePrefixList('<html>Sign in to the Wi-Fi</html>')).toEqual({ problem: 'not JSON' });
    expect(parsePrefixList('{"creationTime": "x"}')).toEqual({ problem: 'no "prefixes" list' });
    expect(parsePrefixList(doc({ ipv4Prefix: 12 }))).toEqual({ problem: 'a prefix without an address' });
    expect(parsePrefixList(doc({ ipv4Prefix: '10.1.0.0/16' }))).toHaveProperty('problem');
    const widest = RANGE_SOURCES.openai.widest;
    expect(parsePrefixList(doc({ ipv4Prefix: '136.122.0.0/16' }), widest)).toHaveProperty('ranges');
    expect(parsePrefixList(doc({ ipv4Prefix: '136.122.0.0/15' }), widest)).toEqual({ problem: '136.122.0.0/15 is wider than a /16' });
  });

  it('ships copies that pass the same checks as a download', () => {
    for (const source of AI_SOURCES) {
      const spec = RANGE_SOURCES[source];
      expect(parseRangeList(spec.builtin.join('\n'), spec.widest), source).toEqual({ ranges: spec.builtin });
      expect(spec.builtin.length, source).toBeGreaterThanOrEqual(spec.minRanges);
    }
  });
});

describe('ProxyRangesService', () => {
  it("uses the copy it shipped with until a download passes the checks", async () => {
    const { ranges } = service(fetchFrom({}));
    expect(ranges.ranges('cloudflare')).toEqual(RANGE_SOURCES.cloudflare.builtin);
    expect(ranges.isStale()).toBe(true);

    const result = await ranges.refresh();
    expect(result.failed).toEqual(['cloudflare', 'jetpack', ...AI_SOURCES]);
    expect(ranges.ranges('cloudflare')).toEqual(RANGE_SOURCES.cloudflare.builtin);
    expect(ranges.status().find((s) => s.source === 'cloudflare')).toMatchObject({ fetchedAt: null, error: expect.stringMatching(/404/) });
    // Tried today: not again until tomorrow, whatever happened.
    expect(ranges.isStale()).toBe(false);
  });

  it('keeps the last good copy when a later download is broken', async () => {
    const good = fetchFrom({
      'https://www.cloudflare.com/ips-v4': CF_V4,
      'https://www.cloudflare.com/ips-v6': CF_V6,
      'https://jetpack.com/ips-v4.txt': JETPACK,
    });
    const { settings, ranges } = service(good);
    let changes = 0;
    ranges.onChange = () => changes++;
    expect(await ranges.refresh()).toEqual({ refreshed: ['cloudflare', 'jetpack'], failed: [...AI_SOURCES] });
    expect(ranges.ranges('cloudflare')).toContain('104.16.0.0/16');
    expect(ranges.ranges('jetpack')).toEqual(['192.0.64.0/18', '122.248.245.244', '54.217.201.243']);
    expect(changes).toBe(1);

    // A captive portal answering 200 with a page, and a list cut to two lines.
    const broken = new ProxyRangesService(
      settings,
      quiet,
      fetchFrom({
        'https://www.cloudflare.com/ips-v4': '<html>Sign in to the Wi-Fi</html>',
        'https://www.cloudflare.com/ips-v6': CF_V6,
        'https://jetpack.com/ips-v4.txt': '192.0.64.0/18\n',
      }),
    );
    expect(await broken.refresh(Date.now() + 8 * 24 * 3600_000)).toEqual({ refreshed: [], failed: ['cloudflare', 'jetpack', ...AI_SOURCES] });
    expect(broken.ranges('cloudflare')).toContain('104.16.0.0/16');
    expect(broken.ranges('jetpack')).toHaveLength(3);
  });

  it("keeps an AI company's list merged, and never blocks what is on it", async () => {
    const claude = JSON.stringify({ prefixes: [{ ipv4Prefix: '203.0.113.0/25' }, { ipv4Prefix: '203.0.113.128/25' }, ...['1', '3', '5', '7'].map((n) => ({ ipv4Prefix: `198.51.100.${n}/32` }))] });
    const { settings, ranges } = service(fetchFrom({ 'https://claude.com/crawling/bots.json': claude }));
    const result = await ranges.refresh();
    expect(result.refreshed).toEqual(['anthropic']);
    // The two halves of a /24 are kept as the /24.
    expect(ranges.ranges('anthropic')).toEqual(['198.51.100.1', '198.51.100.3', '198.51.100.5', '198.51.100.7', '203.0.113.0/24']);
    expect(ranges.aiAssistants().find((a) => a.label.startsWith('Anthropic'))!.set.has('203.0.113.200')).toBe(true);
    // A company that never answered is still covered by the copy this version shipped with.
    expect(ranges.aiAssistants().find((a) => a.label.startsWith('OpenAI'))!.set.has('9.129.1.1')).toBe(true);

    // A later list with a range far too wide is not used; the last good one stays.
    const wide = JSON.stringify({ prefixes: [{ ipv4Prefix: '8.0.0.0/8' }, ...['1', '2', '3', '4', '5'].map((n) => ({ ipv4Prefix: `198.51.100.${n}/32` }))] });
    const later = new ProxyRangesService(settings, quiet, fetchFrom({ 'https://claude.com/crawling/bots.json': wide }));
    expect((await later.refresh(Date.now() + 8 * 24 * 3600_000)).failed).toContain('anthropic');
    expect(later.ranges('anthropic')).toContain('203.0.113.0/24');
    expect(later.status().find((s) => s.source === 'anthropic')!.error).toMatch(/8\.0\.0\.0\/8 is wider than a \/16/);
  });

  it('trusts Cloudflare and the proxies of the setting, and only their headers', () => {
    const { settings, ranges } = service(fetchFrom({}));
    const custom = trustedProxiesSchema.parse({
      cloudflare: false,
      custom: [{ name: 'Office LB', ranges: ['198.51.100.0/24'], header: 'True-Client-Ip' }],
    });
    settings.set('securityTrustedProxies', custom);
    ranges.changed();
    const proxies = ranges.trusted();
    expect(proxies.map((p) => p.name)).toEqual(['Office LB']);
    expect(resolveClient('198.51.100.9', { 'True-Client-Ip': '203.0.113.5' }, proxies)).toEqual({ clientIp: '203.0.113.5', via: 'Office LB' });
    // Cloudflare is off, so its header from its own range means nothing.
    expect(resolveClient('173.245.48.1', { 'Cf-Connecting-Ip': '203.0.113.5' }, proxies)).toEqual({ clientIp: '173.245.48.1', via: null });

    settings.set('securityTrustedProxies', { cloudflare: true, custom: [] });
    ranges.changed();
    expect(resolveClient('173.245.48.1', { 'Cf-Connecting-Ip': '203.0.113.5' }, ranges.trusted())).toEqual({
      clientIp: '203.0.113.5',
      via: 'cloudflare',
    });
  });

  it('refuses a proxy setting that would trust too much, or twice', () => {
    const bad = [
      { cloudflare: true, custom: [{ name: 'x', ranges: ['0.0.0.0/0'], header: 'True-Client-Ip' }] },
      { cloudflare: true, custom: [{ name: 'x', ranges: ['nope'], header: 'True-Client-Ip' }] },
      { cloudflare: true, custom: [{ name: 'x', ranges: ['198.51.100.0/24'], header: 'X-Forwarded-For' }] },
      { cloudflare: true, custom: [{ name: 'Cloudflare', ranges: ['198.51.100.0/24'], header: 'Cf-Connecting-Ip' }] },
      {
        cloudflare: true,
        custom: [
          { name: 'lb', ranges: ['198.51.100.0/24'], header: 'True-Client-Ip' },
          { name: 'LB', ranges: ['198.51.101.0/24'], header: 'True-Client-Ip' },
        ],
      },
    ];
    for (const value of bad) expect(trustedProxiesSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    // And writes what it keeps the canonical way.
    expect(
      trustedProxiesSchema.parse({ cloudflare: true, custom: [{ name: 'lb', ranges: [' 198.51.100.7/24'], header: 'True-Client-Ip' }] }).custom[0]!
        .ranges,
    ).toEqual(['198.51.100.0/24']);
  });
});
