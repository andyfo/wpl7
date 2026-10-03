import { describe, expect, it } from 'vitest';
import { buildTable, parseDelegationLine, type DelegationRange } from '../../src/services/geoip.js';
import { ipv4ToInt, ipv6Top64, isPrivateAddress } from '../../src/lib/ip.js';
import { crawlerName } from '../../src/lib/accessLog.js';

describe('ipv4ToInt', () => {
  it('reads a dotted quad and rejects everything else', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('203.0.113.7')).toBe(3405803783);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '', '1.2.3.-1', '01.2.3.4444']) {
      expect(ipv4ToInt(bad), bad).toBeNull();
    }
  });
});

describe('ipv6Top64', () => {
  it('takes the first four groups, expanding :: wherever it sits', () => {
    expect(ipv6Top64('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(0x20010db800000000n);
    expect(ipv6Top64('2001:db8::1')).toBe(0x20010db800000000n);
    expect(ipv6Top64('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe(0x20010db812345678n);
    expect(ipv6Top64('::1')).toBe(0n);
    expect(ipv6Top64('2a02:8109:a940:1234::42')).toBe(0x2a028109a9401234n);
    // A zone index is a local artefact, not part of the address.
    expect(ipv6Top64('fe80::1%eth0')).toBe(0xfe80000000000000n);
  });

  it('understands an IPv4-mapped address', () => {
    expect(ipv6Top64('::ffff:203.0.113.7')).toBe(0n);
    expect(ipv6Top64('64:ff9b::203.0.113.7')).toBe(0x0064ff9b00000000n);
  });

  it('rejects malformed input rather than guessing', () => {
    for (const bad of ['203.0.113.7', '2001:db8::1::2', 'gggg::1', '', '2001:db8:1:2:3:4:5:6:7']) {
      expect(ipv6Top64(bad), bad).toBeNull();
    }
  });
});

describe('isPrivateAddress', () => {
  it('knows the ranges a real visitor never arrives from', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255',
                      '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('leaves public addresses alone', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2a02:8109::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('parseDelegationLine', () => {
  it('reads an IPv4 row, where the value is a COUNT of addresses', () => {
    // 1.178.112.0 + 4096 addresses -> 1.178.112.0 – 1.178.127.255
    expect(parseDelegationLine('ripencc|PS|ipv4|1.178.112.0|4096|20071126|allocated|abc')).toEqual({
      family: 'v4',
      cc: 'PS',
      start: BigInt(ipv4ToInt('1.178.112.0')!),
      end: BigInt(ipv4ToInt('1.178.127.255')!),
    });
  });

  it('reads an IPv6 row, where the value is a PREFIX LENGTH', () => {
    // 2001:600::/29 spans 2^(64-29) keys of the top-64 space.
    expect(parseDelegationLine('ripencc|NL|ipv6|2001:600::|29|19990826|allocated|abc')).toEqual({
      family: 'v6',
      cc: 'NL',
      start: 0x2001060000000000n,
      end: 0x2001060000000000n + (1n << 35n) - 1n,
    });
  });

  it('skips summaries, reservations, headers and anything unallocated', () => {
    for (const line of [
      'ripencc|*|ipv4|*|100804|summary',
      '2|ripencc|20260918|100804|19830101|20260917|+0000',
      'arin|US|ipv4|1.2.3.0|256|20200101|reserved',
      'apnic||ipv4|1.2.3.0|256|20200101|allocated',
      'apnic|ZZZ|ipv4|1.2.3.0|256|20200101|allocated',
      'arin|US|asn|1234|1|20200101|allocated',
      '# a comment',
      '',
    ]) {
      expect(parseDelegationLine(line), line).toBeNull();
    }
  });
});

describe('buildTable', () => {
  const lookup = (ranges: DelegationRange[], key: bigint): string | null => {
    const t = buildTable(ranges);
    let lo = 0;
    let hi = t.start.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (key < t.start[mid]!) hi = mid - 1;
      else if (key > t.end[mid]!) lo = mid + 1;
      else return t.codes[t.cc[mid]!]!;
    }
    return null;
  };

  it('finds the range a key falls in, and nothing outside one', () => {
    const ranges: DelegationRange[] = [
      { cc: 'DE', start: 200n, end: 299n },
      { cc: 'AT', start: 100n, end: 199n },
      { cc: 'CH', start: 400n, end: 499n },
    ];
    expect(lookup(ranges, 100n)).toBe('AT');
    expect(lookup(ranges, 150n)).toBe('AT');
    expect(lookup(ranges, 199n)).toBe('AT');
    expect(lookup(ranges, 200n)).toBe('DE');
    expect(lookup(ranges, 450n)).toBe('CH');
    expect(lookup(ranges, 99n)).toBeNull();
    expect(lookup(ranges, 350n)).toBeNull(); // the gap between DE and CH
    expect(lookup(ranges, 500n)).toBeNull();
  });

  it('de-overlaps, because the binary search is only correct on disjoint ranges', () => {
    // The registries occasionally publish a block inside an older, larger one.
    const ranges: DelegationRange[] = [
      { cc: 'US', start: 0n, end: 999n },
      { cc: 'CA', start: 500n, end: 1499n },
    ];
    expect(lookup(ranges, 100n)).toBe('US');
    expect(lookup(ranges, 999n)).toBe('US');
    expect(lookup(ranges, 1000n)).toBe('CA');
    expect(lookup(ranges, 1499n)).toBe('CA');
    // Fully-covered ranges drop out instead of shadowing their container.
    const table = buildTable([
      { cc: 'US', start: 0n, end: 999n },
      { cc: 'CA', start: 100n, end: 200n },
    ]);
    expect(table.start.length).toBe(1);
  });

  it('keeps one entry per distinct country code, not per range', () => {
    const table = buildTable([
      { cc: 'DE', start: 0n, end: 9n },
      { cc: 'DE', start: 20n, end: 29n },
      { cc: 'AT', start: 40n, end: 49n },
    ]);
    expect(table.codes).toEqual(['DE', 'AT']);
    expect(table.start.length).toBe(3);
  });
});

describe('crawlerName', () => {
  it('groups a crawler under one name, version and decoration stripped', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
      ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bingbot'],
      ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'AhrefsBot'],
      ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'SemrushBot'],
      ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'GPTBot'],
      ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
      ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Facebook'],
      ['Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; https://zhanzhang.toutiao.com/)', 'Bytespider'],
      ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'Yandex'],
      ['curl/8.7.1', 'curl'],
      ['python-requests/2.32.3', 'python-requests'],
      ['ceo-panel-probe/1', 'Panel uptime check'],
      ['', 'Unidentified'],
    ];
    for (const [ua, expected] of cases) {
      expect(crawlerName(ua), ua).toBe(expected);
    }
  });

  it('collapses versions of the same crawler onto one row', () => {
    expect(crawlerName('Mozilla/5.0 (compatible; Googlebot/2.0)')).toBe(
      crawlerName('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
    );
  });
});
