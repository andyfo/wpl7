import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sites } from '../../src/db/schema.js';
import { GeoIpService } from '../../src/services/geoip.js';
import { makeTestConfig, makeWorld, type TestWorld } from '../helpers.js';

const GERMAN = '178.105.14.1';
const AMERICAN = '8.8.8.8';

/**
 * A world whose country table is seeded straight into the cache directory.
 *
 * Not through `refresh()`: that rejects a table under 50k ranges on purpose (a registry
 * answering 200 with an error page parses to nothing), and a fixture of three ranges is
 * exactly what that floor exists to reject.
 */
async function worldWithCountries(): Promise<TestWorld> {
  const config = makeTestConfig();
  const dir = path.join(config.paths.panel, 'geoip');
  fs.mkdirSync(dir, { recursive: true });
  const v4 = (ip: string, cc: string) => {
    const n = ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    return `${n}\t${n + 255}\t${cc}`;
  };
  fs.writeFileSync(path.join(dir, 'ipv4.tsv'), [v4('8.8.8.0', 'US'), v4('178.105.14.0', 'DE')].sort((a, b) => Number(a.split('\t')[0]) - Number(b.split('\t')[0])).join('\n'));
  fs.writeFileSync(path.join(dir, 'ipv6.tsv'), '');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ fetchedAt: Date.now(), ranges: 2 }));
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const geoip = new GeoIpService(config, log, (async () => new Response('', { status: 503 })) as never);
  await geoip.load();
  return makeWorld({ geoip, config });
}

const HOUR = 3600_000;
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let counter = 0;

/** One Traefik JSON access-log line. */
function hit(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ClientHost: '203.0.113.7',
    DownstreamContentSize: 1000,
    DownstreamStatus: 200,
    Duration: 100_000_000, // 100ms
    RequestCount: ++counter,
    RequestHost: 'acme.test',
    RequestMethod: 'GET',
    RequestPath: '/',
    RouterName: 'wp-acme@docker',
    ServiceName: 'wp-acme@docker',
    StartUTC: new Date(Date.now() - 60_000).toISOString(),
    'request_User-Agent': BROWSER,
    request_Referer: '',
    ...over,
  });
}

/** A site row good enough for the ingest to attribute requests to. */
function addSite(w: TestWorld, slug: string): number {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
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

async function ingest(w: TestWorld, lines: string[]): Promise<number> {
  w.docker.logs.set('wpl7-traefik', lines.join('\n'));
  return (await w.deps.traffic.ingestServer(1)).events;
}

describe('TrafficService ingest', () => {
  it('counts requests, page views and unique visitors per site', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      hit(),
      hit({ RequestPath: '/blog/' }),
      // Same person, second page: one visitor, two page views.
      hit({ RequestPath: '/kontakt' }),
      // An asset the page pulled in: a request, not a page view.
      hit({ RequestPath: '/wp-content/themes/x/style.css' }),
      // A different person.
      hit({ ClientHost: '198.51.100.4', RequestPath: '/' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.totals.requests).toBe(5);
    expect(t.totals.pageViews).toBe(4);
    expect(t.totals.visitors).toBe(2);
    expect(t.totals.bytes).toBe(5000);
    expect(t.totals.avgMs).toBe(100);
    expect(t.collecting).toBe(true);
  });

  it('never counts the panel\'s own uptime probe as traffic', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      hit({ 'request_User-Agent': 'wpl7-probe/1' }),
      hit({ 'request_User-Agent': 'wpl7-probe/1' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    // Not a visitor, not a page view, and not even a request: it is the panel talking to
    // itself once a minute and would otherwise be every quiet site's entire traffic.
    expect(t.totals).toMatchObject({ requests: 0, pageViews: 0, visitors: 0, botRequests: 0 });
  });

  it('counts a crawler as a request but not as a visitor', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      hit({ 'request_User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
      hit(),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.totals).toMatchObject({ requests: 2, botRequests: 1, pageViews: 1, visitors: 1 });
  });

  it('does not double-count the lines the overlap window re-reads', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    const lines = [hit(), hit({ RequestPath: '/blog/' })];

    expect(await ingest(w, lines)).toBe(2);
    // `docker logs --since` has one-second resolution, so the next tick asks for a window
    // that necessarily contains these lines again.
    expect(await ingest(w, lines)).toBe(0);
    expect(w.deps.traffic.siteTraffic(siteId, 1, 1).totals.requests).toBe(2);

    const more = [...lines, hit({ RequestPath: '/impressum' })];
    expect(await ingest(w, more)).toBe(1);
    expect(w.deps.traffic.siteTraffic(siteId, 1, 1).totals.requests).toBe(3);
  });

  it('keeps sites apart, and ignores hosts that match no site', async () => {
    const w = await makeWorld();
    const acme = addSite(w, 'acme');
    const other = addSite(w, 'other');

    await ingest(w, [
      hit(),
      hit({ RouterName: 'wp-other@docker', ServiceName: 'wp-other@docker' }),
      hit({ RouterName: 'wp-other@docker', ServiceName: 'wp-other@docker', RequestPath: '/blog/' }),
      // The panel itself, and a site that no longer exists.
      hit({ RouterName: 'panel@docker', ServiceName: 'panel@docker' }),
      hit({ RouterName: 'wp-deleted@docker', ServiceName: 'wp-deleted@docker' }),
    ]);

    expect(w.deps.traffic.siteTraffic(acme, 1, 1).totals.requests).toBe(1);
    expect(w.deps.traffic.siteTraffic(other, 1, 1).totals.requests).toBe(2);
  });

  it('collects top pages and referring hosts, leaving direct traffic out of the referrers', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      hit({ RequestPath: '/blog/', request_Referer: 'https://news.ycombinator.com/item?id=1' }),
      hit({ ClientHost: '198.51.100.4', RequestPath: '/blog/', request_Referer: 'https://www.google.com/search?q=x' }),
      hit({ ClientHost: '198.51.100.9', RequestPath: '/blog/', request_Referer: 'https://google.com/search?q=y' }),
      hit({ ClientHost: '198.51.100.5', RequestPath: '/blog/', request_Referer: '' }),
      hit({ ClientHost: '198.51.100.6', RequestPath: '/' }),
      hit({ ClientHost: '198.51.100.8', RequestPath: '/' }),
      // Internal navigation is not a referral.
      hit({ ClientHost: '198.51.100.7', RequestPath: '/impressum', request_Referer: 'https://acme.test/blog/' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.topPages).toEqual([
      { path: '/blog/', views: 4 },
      { path: '/', views: 2 },
      { path: '/impressum', views: 1 },
    ]);
    // www. is folded away, so the two Google referrals are one source - and the direct
    // visits and the internal navigation are in neither list.
    expect(t.topReferrers).toEqual([
      { referrer: 'google.com', views: 2 },
      { referrer: 'news.ycombinator.com', views: 1 },
    ]);
  });

  it('stores no address, only a per-day hash that differs between sites', async () => {
    const w = await makeWorld();
    addSite(w, 'acme');
    addSite(w, 'other');

    await ingest(w, [
      hit(),
      hit({ RouterName: 'wp-other@docker', ServiceName: 'wp-other@docker' }),
    ]);

    const rows = w.db.$client.prepare('select site_id, visitor from site_visitors').all() as {
      site_id: number;
      visitor: string;
    }[];
    expect(rows).toHaveLength(2);
    // The same person on two sites is two unrelated ids - one customer's analytics cannot
    // be joined against another's.
    expect(rows[0]!.visitor).not.toBe(rows[1]!.visitor);
    for (const row of rows) expect(row.visitor).not.toContain('203.0.113.7');
  });

  it('serves a dense series and marks a never-logging server as not collecting', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    const cold = w.deps.traffic.siteTraffic(siteId, 1, 7);
    expect(cold.collecting).toBe(false);
    expect(cold.bucket).toBe('day');
    // Eight points: seven whole days back plus today. Empty buckets are kept - "nobody
    // came" is the answer the chart is being asked for.
    expect(cold.series).toHaveLength(8);
    expect(cold.series.every((p) => p.requests === 0)).toBe(true);

    await ingest(w, [hit()]);
    const warm = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(warm.collecting).toBe(true);
    expect(warm.bucket).toBe('hour');
    expect(warm.series).toHaveLength(25);
    expect(warm.series.reduce((a, p) => a + p.requests, 0)).toBe(1);
  });

  it('collapses a visitor active across several hours into one per day', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    const now = Date.now();

    await ingest(w, [
      hit({ StartUTC: new Date(now - 3 * HOUR).toISOString(), RequestPath: '/' }),
      hit({ StartUTC: new Date(now - 2 * HOUR).toISOString(), RequestPath: '/blog/' }),
      hit({ StartUTC: new Date(now - HOUR).toISOString(), RequestPath: '/kontakt' }),
      hit({ ClientHost: '198.51.100.4', StartUTC: new Date(now - HOUR).toISOString(), RequestPath: '/' }),
    ]);

    // Hour buckets: one row per person per hour, so the reader shows up in three of them.
    const hourly = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(hourly.series.reduce((a, p) => a + p.visitors, 0)).toBe(4);

    // Day buckets: two people, four page views - not four "visitors".
    const daily = w.deps.traffic.siteTraffic(siteId, 1, 7);
    expect(daily.bucket).toBe('day');
    expect(daily.series.reduce((a, p) => a + p.visitors, 0)).toBe(2);
    expect(daily.totals.visitors).toBe(2);
    expect(daily.totals.pageViews).toBe(4);
    // Top pages are stored per calendar day, and must survive both bucket sizes.
    expect(hourly.topPages).toEqual(daily.topPages);
    expect(daily.topPages).toContainEqual({ path: '/', views: 2 });
  });

  it('only reaches back a few hours on a cold start', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    // A restarted Traefik still holds days of log. Replaying all of it would be a surprise
    // spike, so the first-ever read of a server is bounded, exactly like the mail ingest.
    await ingest(w, [hit({ StartUTC: new Date(Date.now() - 48 * HOUR).toISOString() }), hit()]);
    expect(w.deps.traffic.siteTraffic(siteId, 1, 7).totals.requests).toBe(1);
  });

  it('drops rollups past the retention window, and everything for a deleted site', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    await ingest(w, [hit()]);

    // Written directly: the ingest deliberately cannot reach back far enough to produce a
    // 40-day-old bucket (see the cold-start test above).
    const old = Date.now() - 40 * 24 * HOUR;
    w.db.$client
      .prepare('insert into site_traffic (site_id, ts, requests, page_views) values (?, ?, 5, 5)')
      .run(siteId, old);
    w.db.$client.prepare('insert into site_visitors (site_id, ts, visitor) values (?, ?, ?)').run(siteId, old, 'abc');
    expect(w.deps.traffic.siteTraffic(siteId, 1, 90).totals.requests).toBe(6);

    expect(w.deps.traffic.prune(30)).toBe(2);
    expect(w.deps.traffic.siteTraffic(siteId, 1, 90).totals.requests).toBe(1);

    // The foreign keys cascade, so deleting a site takes its statistics with it rather
    // than leaving a customer's numbers behind after their site is gone.
    w.db.delete(sites).where(eq(sites.id, siteId)).run();
    expect(w.db.$client.prepare('select count(*) as n from site_traffic').get()).toMatchObject({ n: 0 });
    expect(w.db.$client.prepare('select count(*) as n from site_visitors').get()).toMatchObject({ n: 0 });
  });
});

describe('countries, crawlers and addresses', () => {
  it('counts distinct visitors per country, not requests', async () => {
    const w = await worldWithCountries();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      // One German reading three pages is one German.
      hit({ ClientHost: GERMAN, RequestPath: '/' }),
      hit({ ClientHost: GERMAN, RequestPath: '/blog/' }),
      hit({ ClientHost: GERMAN, RequestPath: '/impressum' }),
      hit({ ClientHost: '178.105.14.9', RequestPath: '/' }),
      hit({ ClientHost: AMERICAN, RequestPath: '/' }),
      // No delegation covers this one, so it is left out rather than shown as unknown.
      hit({ ClientHost: '198.51.100.4', RequestPath: '/' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.countryData).toBe(true);
    expect(t.topCountries).toEqual([
      { country: 'DE', visitors: 2 },
      { country: 'US', visitors: 1 },
    ]);
    expect(t.totals.visitors).toBe(4);
  });

  it('reports no countries, rather than wrong ones, without a table', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    await ingest(w, [hit({ ClientHost: GERMAN })]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.countryData).toBe(false);
    expect(t.topCountries).toEqual([]);
    // Everything that does not depend on the table keeps working.
    expect(t.totals.visitors).toBe(1);
  });

  it('lists crawlers by name with the version stripped', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      hit({ 'request_User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
      hit({ 'request_User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.0)' }),
      hit({ 'request_User-Agent': 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)' }),
      hit(),
      // The panel's own probe is dropped before any of this.
      hit({ 'request_User-Agent': 'ceo-panel-probe/1' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.topCrawlers.map((c) => ({ crawler: c.crawler, requests: c.requests }))).toEqual([
      { crawler: 'Googlebot', requests: 2 },
      { crawler: 'AhrefsBot', requests: 1 },
    ]);
    expect(t.topCrawlers[0]!.lastSeenAt).toBeGreaterThan(0);
  });

  it('ranks addresses by request count, splitting out crawler and error traffic', async () => {
    const w = await worldWithCountries();
    const siteId = addSite(w, 'acme');

    await ingest(w, [
      ...Array.from({ length: 5 }, () => hit({ ClientHost: AMERICAN, 'request_User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' })),
      hit({ ClientHost: GERMAN, RequestPath: '/' }),
      hit({ ClientHost: GERMAN, RequestPath: '/blog/' }),
      hit({ ClientHost: GERMAN, RequestPath: '/boom', DownstreamStatus: 500 }),
      // Never a "top visitor": on a correct stack it cannot happen, and on a broken one it
      // would be the proxy in front, not a person.
      hit({ ClientHost: '10.0.0.5' }),
    ]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.ipsCollected).toBe(true);
    expect(t.topIps.map((r) => r.ip)).toEqual([AMERICAN, GERMAN]);
    expect(t.topIps[0]).toMatchObject({ requests: 5, botRequests: 5, pageViews: 0, country: 'US' });
    expect(t.topIps[1]).toMatchObject({ requests: 3, botRequests: 0, pageViews: 2, errors: 1, country: 'DE' });
    expect(t.topIps[1]!.lastSeenAt).toBeGreaterThan(0);
  });

  it('counts a visitor behind Cloudflare as themselves, and a forged header as nothing', async () => {
    const w = await worldWithCountries();
    const siteId = addSite(w, 'acme');
    // Two Cloudflare edge servers carrying the same German visitor, and a direct visitor
    // claiming to be somebody else by the same header.
    await ingest(w, [
      hit({ ClientAddr: '173.245.48.10:40000', 'request_Cf-Connecting-Ip': GERMAN }),
      hit({ ClientAddr: '104.16.3.4:40000', 'request_Cf-Connecting-Ip': GERMAN, RequestPath: '/blog/' }),
      hit({ ClientAddr: `${AMERICAN}:40000`, 'request_Cf-Connecting-Ip': GERMAN }),
    ]);
    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.topIps.map((r) => [r.ip, r.requests, r.country])).toEqual([
      [GERMAN, 2, 'DE'],
      [AMERICAN, 1, 'US'],
    ]);
    expect(t.totals.visitors).toBe(2);
    expect([...t.topCountries].sort((a, b) => a.country.localeCompare(b.country))).toEqual([
      { country: 'DE', visitors: 1 },
      { country: 'US', visitors: 1 },
    ]);
  });

  it('stores no address at all when the setting is off, and forgets the stored ones', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    await ingest(w, [hit({ ClientHost: GERMAN })]);
    expect(w.deps.traffic.siteTraffic(siteId, 1, 1).topIps).toHaveLength(1);

    expect(w.deps.traffic.forgetIps()).toBe(1);
    w.deps.settings.set('trafficStoreIps', false);
    await ingest(w, [hit({ ClientHost: GERMAN, RequestPath: '/blog/' })]);

    const t = w.deps.traffic.siteTraffic(siteId, 1, 1);
    expect(t.ipsCollected).toBe(false);
    expect(t.topIps).toEqual([]);
    expect(w.db.$client.prepare('select count(*) as n from site_traffic_ips').get()).toMatchObject({ n: 0 });
    // The anonymous half is untouched by the switch.
    expect(t.totals.pageViews).toBe(2);
    expect(t.totals.visitors).toBe(1);
  });

  it('expires addresses on their own shorter clock than the anonymous counters', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'acme');
    await ingest(w, [hit({ ClientHost: GERMAN })]);

    const old = Date.now() - 30 * 24 * HOUR;
    w.db.$client
      .prepare('insert into site_traffic (site_id, ts, requests, page_views) values (?, ?, 1, 1)')
      .run(siteId, old);
    w.db.$client
      .prepare('insert into site_traffic_ips (site_id, day, ip, requests) values (?, ?, ?, 1)')
      .run(siteId, Math.floor(old / (24 * HOUR)) * 24 * HOUR, '203.0.113.9');

    // 90 days of counters, 7 days of addresses: the address goes, the counter stays.
    w.deps.traffic.prune(90, 7);
    expect(w.db.$client.prepare('select count(*) as n from site_traffic_ips').get()).toMatchObject({ n: 1 });
    expect(w.deps.traffic.siteTraffic(siteId, 1, 90).totals.requests).toBe(2);
  });
});
