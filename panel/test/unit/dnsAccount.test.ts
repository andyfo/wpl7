/**
 * Settings -> DNS: the Cloudflare token, seeded once from deploy/.env and owned by the panel
 * after that, and the check that says what a token reaches before anything depends on it.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servers } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { CLOUDFLARE_TOKEN_KEY, DnsAccount, seedCloudflareToken } from '../../src/services/dnsAccount.js';
import { DnsService } from '../../src/services/dns.js';
import { SettingsService } from '../../src/services/settings.js';
import { createTestDb, FakeDnsProvider, makeTestConfig, makeWorld } from '../helpers.js';

const noLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('the token from deploy/.env', () => {
  it('is read for Cloudflare, or when no provider is named - never for another provider', () => {
    expect(makeTestConfig({ DNS_PROVIDER: 'cloudflare', CF_DNS_API_TOKEN: ` ${TOKEN}\n` }).cloudflareTokenSeed).toBe(TOKEN);
    expect(makeTestConfig({ CF_DNS_API_TOKEN: TOKEN }).cloudflareTokenSeed).toBe(TOKEN);
    expect(makeTestConfig({ DNS_PROVIDER: 'hetzner', CF_DNS_API_TOKEN: TOKEN }).cloudflareTokenSeed).toBe('');
    // ...whose own token is only ever handed on to a worker.
    expect(makeTestConfig({ DNS_PROVIDER: 'hetzner', HETZNER_API_KEY: 'h-key' }).otherDnsToken).toBe('h-key');
    expect(makeTestConfig({ DNS_PROVIDER: 'cloudflare', CF_DNS_API_TOKEN: TOKEN }).otherDnsToken).toBe('');
  });

  it('seeds Settings once, and is never seeded back over a token removed there', () => {
    const settings = new SettingsService(createTestDb());
    seedCloudflareToken(settings, TOKEN);
    expect(settings.getRaw(CLOUDFLARE_TOKEN_KEY)).toBe(TOKEN);
    // Edited in .env afterwards: changes nothing, as for every other seeded value.
    seedCloudflareToken(settings, OTHER);
    expect(settings.getRaw(CLOUDFLARE_TOKEN_KEY)).toBe(TOKEN);
    // Removed in Settings: an empty string, not a missing row.
    settings.setRaw(CLOUDFLARE_TOKEN_KEY, '');
    seedCloudflareToken(settings, TOKEN);
    expect(settings.getRaw(CLOUDFLARE_TOKEN_KEY)).toBe('');
  });

  it("waits for a token: a boot with none leaves the row for the first one that has it", () => {
    const settings = new SettingsService(createTestDb());
    seedCloudflareToken(settings, '');
    expect(settings.getRaw(CLOUDFLARE_TOKEN_KEY)).toBeUndefined();
    seedCloudflareToken(settings, TOKEN);
    expect(settings.getRaw(CLOUDFLARE_TOKEN_KEY)).toBe(TOKEN);
  });

  it("is seeded by the boot, and server 1's wildcard certificate from DNS_PROVIDER only the once", async () => {
    const db = createTestDb();
    const config = makeTestConfig({ DNS_PROVIDER: 'cloudflare', CF_DNS_API_TOKEN: TOKEN });
    await seed(db, config);
    expect(new SettingsService(db).getRaw(CLOUDFLARE_TOKEN_KEY)).toBe(TOKEN);
    const local = () => db.select().from(servers).where(eq(servers.id, 1)).get()!;
    expect(local().dnsProvider).toBe('cloudflare');
    // Switched off in Settings -> DNS: the next boot must not switch it back on.
    db.update(servers).set({ dnsProvider: '' }).where(eq(servers.id, 1)).run();
    await seed(db, config);
    expect(local().dnsProvider).toBe('');
  });
});

describe('DnsAccount', () => {
  const account = (provider = new FakeDnsProvider()) => {
    const db = createTestDb();
    const settings = new SettingsService(db);
    const dns = new DnsService(null, noLog);
    const made: string[] = [];
    let changes = 0;
    return {
      settings,
      dns,
      made,
      changes: () => changes,
      provider,
      async withServers(rows: { name: string; devDomain: string }[]) {
        const w = await makeWorld();
        for (const row of rows) w.addSshServer(row.name, { devDomain: row.devDomain });
        const a = new DnsAccount(w.core.settings, w.core.dns, w.servers, w.config, noLog, () => provider);
        return { a, w };
      },
      a: (() => {
        const a = new DnsAccount(settings, dns, { listRows: () => [] } as never, makeTestConfig(), noLog, (token) => {
          made.push(token);
          return provider;
        });
        a.onChange = () => void changes++;
        return a;
      })(),
    };
  };

  it('keeps a token write-only in a row of its own, and puts it to work at once', () => {
    const t = account();
    expect(t.a.status()).toEqual({ configured: false, setAt: null, envDiffers: false });
    expect(t.a.set(` ${TOKEN} `)).toBe(true);
    expect(t.a.token()).toBe(TOKEN);
    expect(t.made).toEqual([TOKEN]);
    expect(t.dns.enabled).toBe(true);
    expect(t.changes()).toBe(1);
    const status = t.a.status();
    expect(status.configured).toBe(true);
    expect(status.setAt).toBeGreaterThan(0);
    // Never one of the settings GET /api/settings answers with.
    expect(Object.values(t.settings.getAll())).not.toContain(TOKEN);
  });

  it('changes nothing, and tells nobody, when the same token is saved again', () => {
    const t = account();
    t.a.set(TOKEN);
    expect(t.a.set(TOKEN)).toBe(false);
    expect(t.changes()).toBe(1);
  });

  it('switches the panel’s records off when the token is removed', () => {
    const t = account();
    t.a.set(TOKEN);
    expect(t.a.set('')).toBe(true);
    expect(t.dns.enabled).toBe(false);
    expect(t.a.status()).toEqual({ configured: false, setAt: null, envDiffers: false });
    expect(t.changes()).toBe(2);
  });

  it('says when deploy/.env still holds a token the panel no longer uses', async () => {
    const w = await makeWorld({ env: { DNS_PROVIDER: 'cloudflare', CF_DNS_API_TOKEN: TOKEN }, dnsClient: () => new FakeDnsProvider() });
    expect(w.core.dnsAccount.status().envDiffers).toBe(false);
    w.core.dnsAccount.set(OTHER);
    expect(w.core.dnsAccount.status().envDiffers).toBe(true);
    w.core.dnsAccount.set('');
    expect(w.core.dnsAccount.status().envDiffers).toBe(true);
  });

  it('checks a token for what it reaches: the zones, and the zone of every dev domain', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.test', 'other.test'];
    provider.recordsRefused.add('other.test');
    const t = account(provider);
    const { a } = await t.withServers([
      { name: 's2', devDomain: 'dev.example.test' },
      { name: 's3', devDomain: 'dev.other.test' },
      { name: 's4', devDomain: 'dev.elsewhere.test' },
    ]);
    const check = await a.check(TOKEN);
    expect(check.ok).toBe(true);
    expect(check.error).toBeNull();
    expect(check.zones).toEqual(['example.test', 'other.test']);
    expect(check.zoneCount).toBe(2);
    // Server 1 shares the test config's dev domain with s2.
    expect(check.devDomains).toEqual([
      { domain: 'dev.example.test', servers: ['local', 's2'], zone: 'example.test', records: 'readable', detail: null },
      { domain: 'dev.other.test', servers: ['s3'], zone: 'other.test', records: 'refused', detail: expect.stringMatching(/^Cloudflare said: Unauthorized/) },
      { domain: 'dev.elsewhere.test', servers: ['s4'], zone: null, records: null, detail: null },
    ]);
    // Reads only.
    expect(provider.records.size).toBe(0);
    expect(provider.calls.some((c) => /upsert|create|update|delete/i.test(c.method))).toBe(false);
  });

  it('says what Cloudflare said when it refuses a token', async () => {
    const provider = new FakeDnsProvider();
    provider.refuse = FakeDnsProvider.invalidToken();
    const check = await account(provider).a.check(TOKEN);
    expect(check).toMatchObject({ ok: false, error: 'Cloudflare said: Invalid API Token (1000)', zones: [] });
  });

  it('refuses a token that works but reaches no zone, and says which permissions it needs', async () => {
    const check = await account(new FakeDnsProvider()).a.check(TOKEN);
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/can't see any domain.*Zone → Zone → Read and Zone → DNS → Edit/);
  });

  it('checks the stored token when given none, and has nothing to check without one', async () => {
    const provider = new FakeDnsProvider();
    provider.zones = ['example.test'];
    const t = account(provider);
    expect(await t.a.check()).toMatchObject({ ok: false, error: 'There is no token to check.' });
    t.a.set(TOKEN);
    expect((await t.a.check()).ok).toBe(true);
  });
});
