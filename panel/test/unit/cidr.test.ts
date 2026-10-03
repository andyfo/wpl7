import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CidrSet,
  cidrContains,
  cidrCovers,
  cidrInputProblem,
  formatIp,
  isPrivateIp,
  mergeCidrs,
  normalizeCidr,
  normalizeIp,
  parseCidr,
  parseIp,
  visitorKey,
} from '../../shared/cidr.js';

/** A tiny deterministic PRNG, so a failure names the same addresses every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const randomV4 = (r: () => number) => Array.from({ length: 4 }, () => Math.floor(r() * 256)).join('.');
const randomV6 = (r: () => number) =>
  Array.from({ length: 8 }, () => Math.floor(r() * 65536).toString(16)).join(':');

describe('parseIp / formatIp', () => {
  it('writes addresses one way only', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp(' 2001:DB8:0:0:0:0:0:1 ')).toBe('2001:db8::1');
    expect(normalizeIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normalizeIp('::')).toBe('::');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('[2001:db8::7]')).toBe('2001:db8::7');
    expect(normalizeIp('2001:db8::1:0:0:0')).toBe('2001:db8:0:0:1::');
  });

  it('reads an IPv4 address in IPv6 clothing as IPv4', () => {
    expect(parseIp('::ffff:198.51.100.3')).toMatchObject({ family: 4 });
    expect(normalizeIp('::ffff:198.51.100.3')).toBe('198.51.100.3');
    expect(normalizeIp('::ffff:c633:6403')).toBe('198.51.100.3');
  });

  it('refuses what is not one address', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.4/24', 'example.com', '1::2::3', '1:2:3:4:5:6:7:8:9', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8::', 'g::1']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it('agrees with Node about what is an address, and writes what Node reads back', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const v6 = randomV6(r);
      expect(net.isIPv6(formatIp(parseIp(v6)!)), v6).toBe(true);
      const v4 = randomV4(r);
      expect(formatIp(parseIp(v4)!)).toBe(v4);
    }
  });
});

describe('parseCidr', () => {
  it('names a range by its network address, and a single address without a prefix', () => {
    expect(normalizeCidr('203.0.113.7/24')).toBe('203.0.113.0/24');
    expect(normalizeCidr('203.0.113.7/32')).toBe('203.0.113.7');
    expect(normalizeCidr('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeCidr('2001:db8:1:2:3::9/64')).toBe('2001:db8:1:2::/64');
    expect(normalizeCidr('::ffff:203.0.113.0/120')).toBe('203.0.113.0/24');
    expect(normalizeCidr('0.0.0.0/0')).toBe('0.0.0.0/0');
  });

  it('refuses a prefix the family does not have', () => {
    for (const bad of ['1.2.3.4/33', '::/129', '1.2.3.4/', '1.2.3.4/x', '1.2.3.4/-1', '/24']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe('ranges against Node', () => {
  it('contain exactly what net.BlockList says they contain', () => {
    const r = rng(42);
    for (let i = 0; i < 200; i++) {
      const v4 = i % 2 === 0;
      const base = v4 ? randomV4(r) : randomV6(r);
      const prefix = v4 ? 8 + Math.floor(r() * 25) : 16 + Math.floor(r() * 113);
      const cidr = parseCidr(`${base}/${prefix}`)!;
      const list = new net.BlockList();
      list.addSubnet(cidr.text.split('/')[0]!, prefix, v4 ? 'ipv4' : 'ipv6');
      // Inside it, by construction, and random addresses that mostly are not.
      const probes = [cidr.text.split('/')[0]!, base, v4 ? randomV4(r) : randomV6(r)];
      for (const probe of probes) {
        const expected = list.check(probe, v4 ? 'ipv4' : 'ipv6');
        expect(cidrContains(cidr, probe), `${cidr.text} ∋ ${probe}`).toBe(expected);
        expect(new CidrSet([cidr]).has(probe)).toBe(expected);
      }
    }
  });

  it('look addresses up in a set of many ranges like BlockList does', () => {
    const r = rng(9);
    const entries: string[] = [];
    const list = new net.BlockList();
    for (let i = 0; i < 80; i++) {
      const prefix = 8 + Math.floor(r() * 25);
      const cidr = parseCidr(`${randomV4(r)}/${prefix}`)!;
      entries.push(cidr.text);
      list.addSubnet(cidr.text.split('/')[0]!, prefix, 'ipv4');
    }
    const set = new CidrSet(entries);
    for (let i = 0; i < 2000; i++) {
      const probe = randomV4(r);
      expect(set.has(probe), probe).toBe(list.check(probe, 'ipv4'));
    }
  });
});

describe('mergeCidrs', () => {
  const merged = (list: string[]) => mergeCidrs(list.map((c) => parseCidr(c)!)).map((c) => c.text);

  it('drops ranges another one covers, and joins halves', () => {
    expect(merged(['10.0.0.0/8', '10.1.0.0/16', '10.1.2.3'])).toEqual(['10.0.0.0/8']);
    expect(merged(['192.0.2.0/25', '192.0.2.128/25'])).toEqual(['192.0.2.0/24']);
    expect(merged(['192.0.2.0/26', '192.0.2.64/26', '192.0.2.128/25'])).toEqual(['192.0.2.0/24']);
    // Adjacent but not halves of one range: both stay.
    expect(merged(['192.0.2.128/25', '192.0.3.0/25'])).toEqual(['192.0.2.128/25', '192.0.3.0/25']);
    expect(merged(['2001:db8::/33', '2001:db8:8000::/33', '198.51.100.1'])).toEqual(['198.51.100.1', '2001:db8::/32']);
  });

  it('never changes which addresses are covered', () => {
    const r = rng(3);
    const input = Array.from({ length: 60 }, () => parseCidr(`10.${Math.floor(r() * 4)}.${Math.floor(r() * 256)}.0/${22 + Math.floor(r() * 11)}`)!);
    const out = mergeCidrs(input);
    for (let i = 0; i < 3000; i++) {
      const probe = `10.${Math.floor(r() * 4)}.${Math.floor(r() * 256)}.${Math.floor(r() * 256)}`;
      expect(out.some((c) => cidrContains(c, probe)), probe).toBe(input.some((c) => cidrContains(c, probe)));
    }
    // And no two left overlap - what nftables refuses in an interval set.
    for (const a of out) for (const b of out) if (a !== b) expect(cidrCovers(a, b), `${a.text} ${b.text}`).toBe(false);
  });
});

describe('private addresses and visitors', () => {
  it('knows the networks that are never a visitor on the internet', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '100.64.3.4', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.128.0.1']) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('counts an IPv6 visitor by its /64, an IPv4 one by its address', () => {
    expect(visitorKey('2001:db8:1:2:aaaa::1')?.text).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8:1:2:bbbb::9')?.text).toBe('2001:db8:1:2::/64');
    expect(visitorKey('198.51.100.7')?.text).toBe('198.51.100.7');
    expect(visitorKey('nope')).toBeNull();
  });

  it('refuses a range too wide to type by accident', () => {
    expect(cidrInputProblem('10.0.0.0/7')).toMatch(/too wide/);
    expect(cidrInputProblem('2001::/15')).toMatch(/too wide/);
    expect(cidrInputProblem('10.0.0.0/8')).toBeNull();
    expect(cidrInputProblem('hello')).toMatch(/not an IP address/);
    expect(cidrInputProblem('  ')).toMatch(/Enter/);
  });
});
