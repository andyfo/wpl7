import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY } from '../../shared/reminders.js';
import { domainLookups } from '../../src/db/schema.js';
import { DomainLookupService, readPublicJson, parseRdap, registrableDomain, type JsonReader } from '../../src/services/domainLookups.js';
import { ReminderSources, osRelease } from '../../src/services/reminderSources.js';
import { makeWorld } from '../helpers.js';

const bootstrap = { status: 200, body: { services: [[['com', 'net'], ['https://rdap.example.net/']]] } };
const answer = (date: string | null = '2028-01-01', status: string[] = []) => ({
  status: 200,
  body: {
    objectClassName: 'domain',
    events: date ? [{ eventAction: 'expiration', eventDate: `${date}T12:00:00Z` }] : [],
    status,
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] }],
  },
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RDAP domain lookups', () => {
  it('refuses private targets before opening a connection', async () => {
    await expect(readPublicJson('https://127.0.0.1/domain/example.com')).rejects.toThrow(/private|reserved/);
  });
  it('uses the public suffix list and IDNA, and rejects addresses and URLs', () => {
    expect(registrableDomain('www.shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(registrableDomain('https://example.com')).toBeNull();
    expect(registrableDomain('127.0.0.1')).toBeNull();
    expect(registrableDomain('example.com/a')).toBeNull();
    expect(parseRdap(answer(null, ['clientHold']).body)).toMatchObject({
      expires: null,
      registrar: 'Example Registrar',
      statuses: ['client hold'],
    });
  });
  it('shares in-flight work and daily cache across subdomains and service restarts', async () => {
    const w = await makeWorld();
    const read = vi.fn<JsonReader>().mockResolvedValueOnce(bootstrap).mockResolvedValue(answer());
    const svc = new DomainLookupService(w.db, w.core.settings, read);
    const values = await Promise.all([svc.lookup('www.example.com'), svc.lookup('shop.example.com')]);
    expect(values[0]).toEqual(values[1]);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await new DomainLookupService(w.db, w.core.settings, read).lookup('example.com')).expires).toBe('2028-01-01');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('uses the registry supplement and keeps prior answers on malformed data or network errors', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await makeWorld();
    const read = vi
      .fn<JsonReader>()
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce({ status: 200, body: {} });
    const svc = new DomainLookupService(w.db, w.core.settings, read);
    await svc.lookup('example.co');
    expect(read.mock.calls[1]![0]).toBe('https://rdap.registry.co/co/domain/example.co');
    vi.setSystemTime(Date.now() + DAY + 1);
    expect(await svc.lookup('example.co')).toMatchObject({
      expires: '2028-01-01',
      observed: true,
      missing: false,
      error: 'Lookup failed. Keeping the last known date.',
    });
  });
  it('backs off an entire registry on 429, without changing stored expiry or flags', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await makeWorld();
    const read = vi
      .fn<JsonReader>()
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(answer())
      .mockResolvedValue({ status: 429, body: null, retryAfter: '172800' });
    const svc = new DomainLookupService(w.db, w.core.settings, read);
    await svc.lookup('example.com');
    vi.setSystemTime(Date.now() + DAY + 1);
    expect((await svc.lookup('example.com')).expires).toBe('2028-01-01');
    const count = read.mock.calls.length;
    expect((await svc.lookup('example.net')).error).toContain('rate limit');
    expect(read).toHaveBeenCalledTimes(count);
  });
  it('marks a formerly seen domain missing, but does not claim a first 404 proves deletion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await makeWorld();
    const read = vi
      .fn<JsonReader>()
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(answer())
      .mockResolvedValue({ status: 404, body: null });
    const svc = new DomainLookupService(w.db, w.core.settings, read);
    await svc.lookup('example.com');
    vi.setSystemTime(Date.now() + DAY + 1);
    expect((await svc.lookup('example.com')).missing).toBe(true);
    expect((await svc.lookup('example.net')).missing).toBe(false);
  });
  it('allows manual dates without contacting a registry when disabled or no server exists', async () => {
    const w = await makeWorld();
    const read = vi.fn<JsonReader>().mockResolvedValue(bootstrap);
    const svc = new DomainLookupService(w.db, w.core.settings, read);
    w.core.settings.set('domainLookups', false);
    expect((await svc.lookup('example.com')).error).toContain('off');
    expect(read).not.toHaveBeenCalled();
    w.core.settings.set('domainLookups', true);
    expect((await svc.lookup('example.eu')).error).toContain('manual');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('token and operating-system dates', () => {
  it('reads user-token expiry without exposing credentials in stored facts', async () => {
    const w = await makeWorld();
    const token = 'cfut_' + 'a'.repeat(45);
    w.core.settings.setRaw('dns.cloudflareToken', token);
    const read = vi
      .fn<JsonReader>()
      .mockResolvedValue({ status: 200, body: { success: true, result: { status: 'active', expires_on: '2028-01-31T00:00:00Z' } } });
    const svc = new ReminderSources(w.core, w.deps.serverInfo, read);
    const facts = await svc.refresh();
    expect(facts.cloudflare).toMatchObject({ expires: '2028-01-31', invalid: false });
    expect(JSON.stringify(facts)).not.toContain(token);
    await svc.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    w.core.settings.setRaw('reminders.sources', { ...facts, at: 0 });
    read.mockResolvedValue({ status: 200, body: { success: true, result: { status: 'active', expires_on: 'invalid' } } });
    expect((await svc.refresh()).cloudflare).toMatchObject({
      expires: '2028-01-31',
      invalid: false,
      error: 'Token check failed. Keeping the last known date.',
    });
  });
  it('uses account-token verification and treats missing permissions as unknown, not expired', async () => {
    const w = await makeWorld();
    w.core.settings.setRaw('dns.cloudflareToken', 'cfat_' + 'a'.repeat(45));
    const account = 'b'.repeat(32);
    const read = vi
      .fn<JsonReader>()
      .mockResolvedValueOnce({ status: 200, body: { success: true, result: [{ account: { id: account } }] } })
      .mockResolvedValueOnce({ status: 200, body: { success: true, result: { status: 'active' } } });
    const svc = new ReminderSources(w.core, w.deps.serverInfo, read);
    expect((await svc.refresh()).cloudflare).toMatchObject({ expires: null, invalid: false });
    expect(read.mock.calls[1]![0]).toContain(`/accounts/${account}/tokens/verify`);
    w.core.settings.setRaw('reminders.sources', { at: 0, cloudflare: null, servers: [] });
    read
      .mockResolvedValueOnce({ status: 200, body: { success: true, result: [{ account: { id: account } }] } })
      .mockResolvedValueOnce({ status: 403, body: null });
    expect((await svc.refresh()).cloudflare).toMatchObject({ invalid: false, error: 'Token check failed. Keeping the last known date.' });
  });
  it('recognizes known OS releases without guessing unknown versions', () => {
    expect(osRelease('Ubuntu 24.04.1 LTS')).toBe('ubuntu:24.04');
    expect(osRelease('Debian GNU/Linux 12 (bookworm)')).toBe('debian:12');
    expect(osRelease('Custom Linux')).toBeNull();
  });
});
