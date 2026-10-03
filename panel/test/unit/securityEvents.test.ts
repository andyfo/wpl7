import { describe, expect, it } from 'vitest';
import { sites, siteBlockedRecent } from '../../src/db/schema.js';
import { blockedRule, RECENT_PER_SITE } from '../../src/services/securityEvents.js';
import { makeWorld, type TestWorld } from '../helpers.js';

let counter = 0;

/** One Traefik access-log line for a request a rule of `acme` answered. */
function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ClientAddr: '198.18.3.3:40000',
    DownstreamContentSize: 9,
    DownstreamStatus: 403,
    OriginStatus: 0,
    Duration: 100_000,
    RequestCount: ++counter,
    RequestHost: 'acme.test',
    RequestMethod: 'GET',
    RequestPath: '/.env?x=1',
    RouterName: 'wpl7sec_deny-files_acme@file',
    ServiceName: 'wp-acme@docker',
    StartUTC: new Date(Date.now() - 30_000).toISOString(),
    'request_User-Agent': 'curl/8',
    ...over,
  });
}

function addSite(w: TestWorld, slug: string, domains = [`${slug}.test`]): number {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify(domains),
      phpVersion: '8.3',
      status: 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

async function ingest(w: TestWorld, lines: string[]): Promise<void> {
  w.docker.logs.set('wpl7-traefik', lines.join('\n'));
  await w.deps.traffic.ingestServer(1);
}

describe('which rule turned a request away', () => {
  it('reads it off the router that answered', () => {
    const e = (router: string, status: number, originStatus = 0) => blockedRule({ router, status, originStatus });
    expect(e('wpl7sec_deny-files_acme', 403)).toBe('files');
    expect(e('wpl7sec_deny-wpcron_acme', 403)).toBe('wpcron');
    expect(e('wpl7sec_block-x7_acme', 403)).toBe('block-x7');
    expect(e('wpl7sec_login_acme', 429)).toBe('limit-login');
    expect(e('wpl7sec_login-p0_acme', 429)).toBe('limit-login');
    expect(e('wpl7sec_main-p2_acme', 429)).toBe('limit-requests');
    expect(e('wpl7sec_static_acme', 429)).toBe('limit-assets');
    expect(e('wpl7blk_cloudflare', 403)).toBe('blocked-address');
  });

  it('never counts what the site itself answered', () => {
    // A plugin sending its own 429 through the limited router.
    expect(blockedRule({ router: 'wpl7sec_main_acme', status: 429, originStatus: 429 })).toBeNull();
    expect(blockedRule({ router: 'wpl7sec_main_acme', status: 200, originStatus: 200 })).toBeNull();
    expect(blockedRule({ router: 'wpl7sec_infra_acme', status: 403, originStatus: 0 })).toBeNull();
    expect(blockedRule({ router: 'wp-acme', status: 403, originStatus: 0 })).toBeNull();
  });
});

describe('counting blocked requests', () => {
  it('counts per site, day and rule, and keeps the request without its query string', async () => {
    const w = await makeWorld();
    const acme = addSite(w, 'acme');
    await ingest(w, [
      line(),
      line({ RequestPath: '/.git/config' }),
      line({ RouterName: 'wpl7sec_login_acme@file', RequestMethod: 'POST', RequestPath: '/wp-login.php', DownstreamStatus: 429 }),
      // Served, and not counted.
      line({ RouterName: 'wpl7sec_main_acme@file', DownstreamStatus: 200, OriginStatus: 200, RequestPath: '/' }),
    ]);
    expect(w.core.securityEvents.countsBySite(acme, 7)).toEqual({ files: 2, 'limit-login': 1 });
    const recent = w.core.securityEvents.recent({ siteId: acme, limit: 10 });
    expect(recent.map((r) => [r.rule, r.path, r.ip])).toEqual([
      ['limit-login', '/wp-login.php', '198.18.3.3'],
      ['files', '/.git/config', '198.18.3.3'],
      ['files', '/.env', '198.18.3.3'],
    ]);
  });

  it('attributes a blocked address by host, and counts the hit against its block', async () => {
    const w = await makeWorld();
    const shop = addSite(w, 'shop', ['shop.example.com', 'www.shop.example.com']);
    const block = w.core.blocklist.block({ address: '198.18.3.3', source: 'manual', reason: 'x', durationMs: null });
    await ingest(w, [line({ RouterName: 'wpl7blk_direct@file', ServiceName: 'wpl7-deny@file', RequestHost: 'WWW.shop.example.com' })]);
    expect(w.core.securityEvents.countsBySite(shop, 1)).toEqual({ 'blocked-address': 1 });
    expect(w.core.blocklist.byId(block.id)).toMatchObject({ hits: 1 });
  });

  it('stores no address while addresses are not stored, and forgets the stored ones', async () => {
    const w = await makeWorld();
    const acme = addSite(w, 'acme');
    await ingest(w, [line()]);
    expect(w.core.securityEvents.forgetIps()).toBe(1);
    w.core.settings.set('trafficStoreIps', false);
    await ingest(w, [line({ RequestPath: '/.env.local' })]);
    expect(w.core.securityEvents.recent({ siteId: acme, limit: 10 }).map((r) => r.ip)).toEqual([null, null]);
  });

  it('keeps the newest requests of each site, and counts all of them', async () => {
    const w = await makeWorld();
    const acme = addSite(w, 'acme');
    await ingest(w, Array.from({ length: RECENT_PER_SITE + 20 }, (_, i) => line({ RequestPath: `/.env${i}` })));
    expect(w.db.select().from(siteBlockedRecent).all()).toHaveLength(RECENT_PER_SITE);
    expect(w.core.securityEvents.countsBySite(acme, 1).files).toBe(RECENT_PER_SITE + 20);
    // "Blocked in 24 h" does not stop at what the list holds.
    expect(w.core.securityEvents.fleetCounts(Date.now() - 24 * 3600_000).get(acme)).toBe(RECENT_PER_SITE + 20);
  });

  it('blanks addresses past their retention', async () => {
    const w = await makeWorld();
    const acme = addSite(w, 'acme');
    await ingest(w, [line()]);
    expect(w.core.securityEvents.prune(Date.now() + 8 * 24 * 3600_000)).toBeGreaterThan(0);
    expect(w.core.securityEvents.recent({ siteId: acme, limit: 1 })[0]?.ip ?? null).toBeNull();
  });
});
