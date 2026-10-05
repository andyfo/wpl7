import { describe, expect, it } from 'vitest';
import { DnsService } from '../../src/services/dns.js';
import { FakeDnsProvider } from '../helpers.js';

const noLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Holds a provider's zone lookups - each answered as of when it was asked - until let go. */
function holdLookups(provider: FakeDnsProvider): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const findZone = provider.findZone.bind(provider);
  provider.findZone = async (fqdn) => {
    const answer = await findZone(fqdn);
    await held;
    return answer;
  };
  return release;
}

describe('DnsService', () => {
  it('is disabled without a provider - every call is a safe no-op', async () => {
    const dns = new DnsService(null, noLog);
    expect(dns.enabled).toBe(false);
    expect(await dns.upsertA('a.dev.example.com', '1.2.3.4')).toBe('unmanaged');
    expect(await dns.deleteA('a.dev.example.com')).toBe('unmanaged');
    expect(await dns.canManage('a.dev.example.com')).toBe(false);
  });

  it('upserts and deletes records for managed zones', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com'];
    const dns = new DnsService(provider, noLog);
    expect(await dns.upsertA('site.dev.example.com', '203.0.113.9')).toBe('updated');
    expect(provider.records.get('site.dev.example.com')).toBe('203.0.113.9');
    expect(await dns.deleteA('site.dev.example.com')).toBe('deleted');
    expect(provider.records.has('site.dev.example.com')).toBe(false);
  });

  it('reports unmanaged zones instead of failing', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com'];
    const dns = new DnsService(provider, noLog);
    expect(await dns.upsertA('customer.other.net', '203.0.113.9')).toBe('unmanaged');
    expect(provider.records.size).toBe(0);
  });

  it('memoizes zone lookups within a zone', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com'];
    const dns = new DnsService(provider, noLog);
    await dns.upsertA('a.dev.example.com', '1.1.1.1');
    await dns.upsertA('b.dev.example.com', '2.2.2.2');
    await dns.upsertA('example.com', '3.3.3.3'); // the apex is in the same zone
    const lookups = provider.calls.filter((c) => c.method === 'findZone');
    expect(lookups).toHaveLength(1);
  });

  it('never serves one apex domain’s zone to another (cache key is the zone, not the TLD)', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com', 'another.com'];
    const dns = new DnsService(provider, noLog);
    await dns.upsertA('example.com', '1.1.1.1');
    await dns.upsertA('another.com', '2.2.2.2');
    // Both looked up for real, and each record landed in its own zone.
    expect(provider.calls.filter((c) => c.method === 'findZone')).toHaveLength(2);
    expect(provider.calls.filter((c) => c.method === 'upsertA').map((c) => c.zone)).toEqual([
      'example.com',
      'another.com',
    ]);
  });

  it('does not re-query a name already known to have no zone', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com'];
    const dns = new DnsService(provider, noLog);
    expect(await dns.canManage('customer.other.net')).toBe(false);
    expect(await dns.canManage('customer.other.net')).toBe(false);
    expect(provider.calls.filter((c) => c.method === 'findZone')).toHaveLength(1);
  });
});

describe('DnsService, account changes', () => {
  it('works in another account once told to, and forgets the zones it knew', async () => {
    const first = new FakeDnsProvider();
    first.zones = ['example.com'];
    const dns = new DnsService(first, noLog);
    expect(await dns.canManage('a.example.com')).toBe(true);

    const second = new FakeDnsProvider();
    second.zones = ['other.net'];
    dns.use(second);
    expect(dns.enabled).toBe(true);
    // The first account's zone id means nothing in the second: asked again, not served from cache.
    expect(await dns.canManage('a.example.com')).toBe(false);
    expect(await dns.upsertA('x.other.net', '203.0.113.9')).toBe('updated');
    expect(first.records.size).toBe(0);
    expect(second.records.get('x.other.net')).toBe('203.0.113.9');

    dns.use(null);
    expect(dns.enabled).toBe(false);
    expect(await dns.upsertA('x.other.net', '203.0.113.9')).toBe('unmanaged');
  });

  it('finds a zone added to the account once asked to look again', async () => {
    const provider = new FakeDnsProvider();
    const dns = new DnsService(provider, noLog);
    expect(await dns.canManage('shop.new.example')).toBe(false);
    provider.zones = ['new.example'];
    expect(await dns.canManage('shop.new.example')).toBe(false);
    dns.forgetZones();
    expect(await dns.canManage('shop.new.example')).toBe(true);
  });

  it('asks the new token when the old one is replaced under a lookup, not trusting the old one’s answer', async () => {
    const before = new FakeDnsProvider();
    const after = new FakeDnsProvider();
    after.zones = ['example.com'];
    const dns = new DnsService(before, noLog);
    const release = holdLookups(before);
    // The old token reaches no zone; the new one, saved while Cloudflare was being asked, does.
    const writing = dns.upsertA('go.example.com', '203.0.113.9');
    const asking = dns.canManage('mail.example.com');
    dns.use(after);
    release();
    expect(await writing).toBe('updated');
    expect(await asking).toBe(true);
    expect(after.records.get('go.example.com')).toBe('203.0.113.9');
    expect(before.records.size).toBe(0);
  });

  it('writes nothing once the token is removed under a lookup', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.com'];
    const dns = new DnsService(provider, noLog);
    const release = holdLookups(provider);
    const writing = dns.upsertA('go.example.com', '203.0.113.9');
    dns.use(null);
    release();
    expect(await writing).toBe('unmanaged');
    expect(provider.records.size).toBe(0);
  });

  it('keeps nothing a lookup still out learnt once told to look again', async () => {
    const provider = new FakeDnsProvider();
    const dns = new DnsService(provider, noLog);
    const release = holdLookups(provider);
    // Asked before the zone was added to the account, answered after Check looked again.
    const asking = dns.canManage('shop.new.example');
    provider.zones = ['new.example'];
    dns.forgetZones();
    release();
    expect(await asking).toBe(false);
    expect(await dns.canManage('shop.new.example')).toBe(true);
  });

  it('gives a server the wildcard certificate only from a provider with credentials behind it', () => {
    const without = new DnsService(null, noLog);
    // Cloudflare's token is the panel's: none, and a site labelled for the wildcard gets no certificate.
    expect(without.wildcardProvider('cloudflare')).toBe('');
    // Another provider's credentials are in that server's .env, which the panel cannot see.
    expect(without.wildcardProvider('hetzner')).toBe('hetzner');
    expect(without.wildcardProvider('')).toBe('');
    const withToken = new DnsService(new FakeDnsProvider(), noLog);
    expect(withToken.wildcardProvider('cloudflare')).toBe('cloudflare');
    expect(withToken.wildcardProvider('')).toBe('');
  });
});
