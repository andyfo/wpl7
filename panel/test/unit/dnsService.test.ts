import { describe, expect, it } from 'vitest';
import { DnsService } from '../../src/services/dns.js';
import { FakeDnsProvider } from '../helpers.js';

const noLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

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
