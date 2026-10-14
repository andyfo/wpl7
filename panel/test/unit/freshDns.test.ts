import { describe, expect, it } from 'vitest';
import { FreshResolver, type DnsQueries, type FreshDnsBackend } from '../../src/services/freshDns.js';

const fail = (code: string) => Object.assign(new Error(`query ${code}`), { code });

/** What one zone's nameserver holds; `error` is how it fails instead of answering. */
interface Nameserver {
  txt?: Record<string, string[]>;
  cname?: Record<string, string[]>;
  ptr?: Record<string, string[]>;
  error?: string;
}

/**
 * DNS as the panel sees it: the machine's resolver (`ns`, `a`, `cname`, and `txt` as it still
 * remembers it) and each nameserver by address. Every lookup is logged as "<who> <type> <name>".
 */
function dnsWorld(spec: {
  ns?: Record<string, string[]>;
  a?: Record<string, string[]>;
  cname?: Record<string, string[]>;
  txt?: Record<string, string[]>;
  nameservers?: Record<string, Nameserver>;
}) {
  const calls: string[] = [];
  const lookup = <T>(who: string, type: string, name: string, table?: Record<string, T[]>, error?: string): Promise<T[]> => {
    calls.push(`${who} ${type} ${name}`);
    if (error) return Promise.reject(fail(error));
    const hit = table?.[name];
    return hit ? Promise.resolve(hit) : Promise.reject(fail('ENODATA'));
  };
  const reverseName = (ip: string) => `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const recursive: DnsQueries = {
    resolveTxt: (n) => lookup('recursive', 'TXT', n, spec.txt).then((r) => r.map((t) => [t])),
    resolve4: (n) => lookup('recursive', 'A', n, spec.a),
    resolveMx: (n) => lookup('recursive', 'MX', n, {}),
    reverse: (ip) => lookup('recursive', 'PTR', reverseName(ip), {}),
    resolveNs: (n) => lookup('recursive', 'NS', n, spec.ns),
    resolveCname: (n) => lookup('recursive', 'CNAME', n, spec.cname),
  };
  const backend: FreshDnsBackend = {
    recursive,
    at(servers) {
      const ns = spec.nameservers?.[servers[0]!] ?? {};
      const who = servers.join(',');
      return {
        resolveTxt: (n) => lookup(who, 'TXT', n, ns.txt, ns.error).then((r) => r.map((t) => [t])),
        resolve4: (n) => lookup(who, 'A', n, {}, ns.error),
        resolveMx: (n) => lookup(who, 'MX', n, {}, ns.error),
        reverse: (ip) => lookup(who, 'PTR', reverseName(ip), ns.ptr, ns.error),
        resolveNs: (n) => lookup(who, 'NS', n, {}, ns.error),
        resolveCname: (n) => lookup(who, 'CNAME', n, ns.cname, ns.error),
      };
    },
  };
  return { backend, calls };
}

const KEY = 'v=DKIM1; k=rsa; p=MIIBIjAN';
/** example.com, served by one nameserver at 192.0.2.53. */
const EXAMPLE = { ns: { 'example.com': ['ns1.dns.example.net'] }, a: { 'ns1.dns.example.net': ['192.0.2.53'] } };

describe('FreshResolver', () => {
  it("asks the zone's own nameserver, past a resolver that still remembers the record missing", async () => {
    const { backend, calls } = dnsWorld({
      ...EXAMPLE,
      txt: {}, // the machine's resolver cached "no such record" before it was added
      nameservers: { '192.0.2.53': { txt: { 'wpl7._domainkey.shop.example.com': [KEY] } } },
    });
    const dns = new FreshResolver(backend);

    expect(await dns.resolveTxt('wpl7._domainkey.shop.example.com')).toEqual([[KEY]]);
    expect(calls).not.toContain('recursive TXT wpl7._domainkey.shop.example.com');
    // The walk went up the name to where the NS records are, and not past it.
    expect(calls.filter((c) => c.startsWith('recursive NS'))).toEqual([
      'recursive NS wpl7._domainkey.shop.example.com',
      'recursive NS _domainkey.shop.example.com',
      'recursive NS shop.example.com',
      'recursive NS example.com',
    ]);
    expect(await dns.zoneOf('shop.example.com')).toBe('example.com');
  });

  it('takes "no such record" from the zone as the answer', async () => {
    const { backend, calls } = dnsWorld({
      ...EXAMPLE,
      txt: { '_dmarc.example.com': ['v=DMARC1; p=none'] }, // stale: deleted since
      nameservers: { '192.0.2.53': { txt: {} } },
    });
    await expect(new FreshResolver(backend).resolveTxt('_dmarc.example.com')).rejects.toMatchObject({ code: 'ENODATA' });
    expect(calls).not.toContain('recursive TXT _dmarc.example.com');
  });

  it("follows a CNAME out of the zone through the machine's resolver", async () => {
    // Hosted DMARC: the zone's server answers the CNAME and nothing of the type asked for.
    const { backend } = dnsWorld({
      ...EXAMPLE,
      txt: { '_dmarc.example.com': ['v=DMARC1; p=reject'] },
      nameservers: {
        '192.0.2.53': {
          txt: { '_dmarc.example.com': [] },
          cname: { '_dmarc.example.com': ['example.com.dmarc.provider.example'] },
        },
      },
    });
    expect(await new FreshResolver(backend).resolveTxt('_dmarc.example.com')).toEqual([['v=DMARC1; p=reject']]);
  });

  it("uses the machine's resolver when the nameservers do not answer, and stops waiting for them", async () => {
    const { backend, calls } = dnsWorld({
      ...EXAMPLE,
      txt: { 'example.com': ['v=spf1 ip4:192.0.2.10 ~all'], '_dmarc.example.com': ['v=DMARC1; p=none'] },
      nameservers: { '192.0.2.53': { error: 'ETIMEOUT' } },
    });
    const dns = new FreshResolver(backend);
    expect(await dns.resolveTxt('example.com')).toEqual([['v=spf1 ip4:192.0.2.10 ~all']]);
    expect(await dns.resolveTxt('_dmarc.example.com')).toEqual([['v=DMARC1; p=none']]);
    expect(calls.filter((c) => c.startsWith('192.0.2.53'))).toEqual(['192.0.2.53 TXT example.com']);
  });

  it('finds a zone delegated below the registrable domain', async () => {
    const { backend } = dnsWorld({
      ns: { 'dev.example.com': ['ns1.dns.example.net'], 'example.com': ['ns9.dns.example.net'] },
      a: { 'ns1.dns.example.net': ['192.0.2.53'] },
    });
    expect(await new FreshResolver(backend).zoneOf('alpha.dev.example.com')).toBe('dev.example.com');
  });

  it('does not take a CNAME for the start of a zone', async () => {
    // NS records "at" a name with a CNAME are those of the name it points to.
    const { backend } = dnsWorld({
      ns: { 'www.example.com': ['ns.other.example'], ...EXAMPLE.ns },
      a: EXAMPLE.a,
      cname: { 'www.example.com': ['example.other.example'] },
    });
    expect(await new FreshResolver(backend).zoneOf('www.example.com')).toBe('example.com');
  });

  it("asks the machine's resolver when no zone is found", async () => {
    const { backend } = dnsWorld({ txt: { 'example.test': ['v=spf1 -all'] } });
    const dns = new FreshResolver(backend);
    expect(await dns.zoneOf('example.test')).toBeNull();
    expect(await dns.resolveTxt('example.test')).toEqual([['v=spf1 -all']]);
  });

  it('asks the reverse zone for a PTR record', async () => {
    const { backend } = dnsWorld({
      ns: { '113.0.203.in-addr.arpa': ['ns1.dns.example.net'] },
      a: EXAMPLE.a,
      nameservers: { '192.0.2.53': { ptr: { '7.113.0.203.in-addr.arpa': ['mail.example.com'] } } },
    });
    expect(await new FreshResolver(backend).reverse('203.0.113.7')).toEqual(['mail.example.com']);
  });

  it('looks for a zone it did not find again after a minute, and keeps one it found for ten', async () => {
    let now = 0;
    const spec = { ns: {} as Record<string, string[]>, a: EXAMPLE.a };
    const { backend } = dnsWorld(spec);
    const dns = new FreshResolver(backend, () => now);
    expect(await dns.zoneOf('example.com')).toBeNull();

    spec.ns['example.com'] = ['ns1.dns.example.net'];
    now = 30_000;
    expect(await dns.zoneOf('example.com')).toBeNull();
    now = 61_000;
    expect(await dns.zoneOf('example.com')).toBe('example.com');

    delete spec.ns['example.com'];
    now = 61_000 + 9 * 60_000;
    expect(await dns.zoneOf('example.com')).toBe('example.com');
  });
});
