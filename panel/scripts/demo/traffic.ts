/**
 * Two weeks of visitor statistics per site, in the rollup tables the Visitors tab and the Sites
 * list read: requests and page views by hour, one row per visitor per hour, crawlers, top pages
 * and referrers, and the busiest addresses (documentation ranges only). Country data counts as
 * downloaded, so the countries list shows.
 */
import { buildTable } from '../../src/services/geoip.js';
import {
  siteTraffic,
  siteTrafficCrawlers,
  siteTrafficIps,
  siteTrafficPaths,
  siteTrafficReferrers,
  siteVisitors,
} from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, ago, DEMO_NOW } from './clock.js';
import { SITES, rng, seedOf } from './data.js';
import { siteIds } from './sites.js';

const COUNTRIES: [string, number][] = [
  ['US', 0.34], ['DE', 0.13], ['GB', 0.11], ['FR', 0.07], ['CA', 0.06], ['NL', 0.05], ['AU', 0.04],
  ['SE', 0.03], ['ES', 0.03], ['IT', 0.03], ['CH', 0.02], ['AT', 0.02], ['IE', 0.02], ['JP', 0.02],
];

const CRAWLERS: [string, number][] = [
  ['Googlebot', 0.36], ['bingbot', 0.17], ['Applebot', 0.09], ['AhrefsBot', 0.12], ['SemrushBot', 0.1], ['DuckDuckBot', 0.05], ['GPTBot', 0.06], ['ClaudeBot', 0.05],
];

const REFERRERS: [string, number][] = [
  ['www.google.com', 0.55], ['duckduckgo.com', 0.1], ['www.bing.com', 0.08], ['l.facebook.com', 0.09], ['www.instagram.com', 0.08], ['t.co', 0.04], ['www.reddit.com', 0.03], ['news.ycombinator.com', 0.03],
];

const PAGES: Record<string, string[]> = {
  'pixel-press': ['/', '/2026/10/04/the-quiet-return-of-film-cameras/', '/2026/10/02/inside-a-type-foundry/', '/reviews/', '/2026/09/29/ten-desks-ten-designers/', '/newsletter/', '/2026/09/26/the-print-issue/', '/about/', '/contact/', '/advertise/'],
  'ridge-outfitters': ['/', '/shop/', '/product/alpine-shell-jacket/', '/product-category/tents/', '/cart/', '/product/trail-runner-gtx/', '/checkout/', '/stores/', '/returns/', '/blog/packing-list-for-a-weekend/'],
  'northwind-bakery': ['/', '/menu/', '/order-online/', '/our-story/', '/wholesale/', '/cakes/', '/visit/', '/blog/sourdough-starter-guide/', '/careers/', '/contact/'],
};
const DEFAULT_PAGES = ['/', '/services/', '/about/', '/contact/', '/team/', '/blog/', '/faq/', '/book/', '/news/', '/privacy-policy/'];

function pick<T>(table: [T, number][], r: number): T {
  let acc = 0;
  for (const [value, weight] of table) {
    acc += weight;
    if (r < acc) return value;
  }
  return table[table.length - 1]![0];
}

export function seedTraffic(world: TestWorld): void {
  // The registries' country table counts as downloaded: the documentation ranges are all it holds.
  const geoip = world.geoip as unknown as { v4: unknown; meta: unknown };
  geoip.v4 = buildTable([
    { cc: 'US', start: 0xc0000200n, end: 0xc00002ffn },
    { cc: 'DE', start: 0xc6336400n, end: 0xc63364ffn },
    { cc: 'NL', start: 0xcb007100n, end: 0xcb0071ffn },
  ]);
  geoip.meta = { fetchedAt: ago(3 * DAY), sources: [] };

  const traffic: (typeof siteTraffic.$inferInsert)[] = [];
  const visitors: (typeof siteVisitors.$inferInsert)[] = [];
  const crawlers: (typeof siteTrafficCrawlers.$inferInsert)[] = [];
  const ips: (typeof siteTrafficIps.$inferInsert)[] = [];
  const paths: (typeof siteTrafficPaths.$inferInsert)[] = [];
  const referrers: (typeof siteTrafficReferrers.$inferInsert)[] = [];

  const hourNow = Math.floor(DEMO_NOW / HOUR) * HOUR;
  for (const site of SITES) {
    if (site.dailyVisitors === 0) continue;
    const siteId = siteIds.get(site.slug)!;
    const next = rng(seedOf(`traffic:${site.slug}`));
    const pages = PAGES[site.slug] ?? DEFAULT_PAGES;
    const firstHour = Math.max(hourNow - 14 * DAY, Math.floor((DEMO_NOW - site.ageDays * DAY) / HOUR) * HOUR);
    const dayViews = new Map<number, number>();
    let visitorSeq = 0;
    for (let ts = firstHour; ts <= hourNow; ts += HOUR) {
      const hour = new Date(ts).getUTCHours();
      const weekday = new Date(ts).getUTCDay();
      const shape = 0.25 + 0.75 * Math.max(0, Math.sin(((hour - 6) / 18) * Math.PI));
      const weekend = weekday === 0 || weekday === 6 ? 0.8 : 1;
      const partial = ts === hourNow ? (DEMO_NOW - hourNow) / HOUR : 1;
      const count = Math.round((site.dailyVisitors / 13) * shape * weekend * (0.85 + 0.3 * next()) * partial);
      for (let i = 0; i < count; i++) {
        visitorSeq++;
        visitors.push({ siteId, ts, visitor: (seedOf(`${site.slug}:${visitorSeq}`) >>> 0).toString(16).padStart(8, '0'), country: pick(COUNTRIES, next()) });
      }
      const pageViews = Math.round(count * (2.1 + next() * 0.8));
      const requests = Math.round(pageViews * (6 + next() * 3));
      traffic.push({
        siteId,
        ts,
        requests,
        pageViews,
        botRequests: Math.round(requests * (0.18 + next() * 0.1)),
        errors: next() < 0.06 ? 1 : 0,
        bytes: requests * (38_000 + Math.round(next() * 12_000)),
        durationMsSum: requests * (40 + Math.round(next() * 60)),
      });
      const day = Math.floor(ts / DAY) * DAY;
      dayViews.set(day, (dayViews.get(day) ?? 0) + pageViews);
    }
    for (const [day, views] of dayViews) {
      const dayRng = rng(seedOf(`${site.slug}:${day}`));
      let left = views;
      pages.forEach((p, i) => {
        const share = i === pages.length - 1 ? left : Math.round(views * (0.34 / (i + 1)) * (0.9 + dayRng() * 0.2));
        left = Math.max(0, left - share);
        if (share > 0) paths.push({ siteId, day, path: p, views: share });
      });
      for (const [referrer, weight] of REFERRERS) {
        referrers.push({ siteId, day, referrer, views: Math.round(views * 0.42 * weight * (0.8 + dayRng() * 0.4)) });
      }
      referrers.push({ siteId, day, referrer: '', views: Math.round(views * 0.5) });
      for (const [crawler, weight] of CRAWLERS) {
        crawlers.push({ siteId, day, crawler, requests: Math.round(site.dailyVisitors * 0.9 * weight * (0.7 + dayRng() * 0.6)), lastSeenAt: Math.min(DEMO_NOW - 60_000, day + DAY - Math.round(dayRng() * 3 * HOUR)) });
      }
      // The busiest addresses, kept for a week (traffic.ipRetentionDays): documentation ranges only.
      for (let i = 0; day >= DEMO_NOW - 7 * DAY && i < 6; i++) {
        const ip = i % 2 === 0 ? `198.51.100.${17 + i * 9}` : `192.0.2.${33 + i * 11}`;
        const requests = Math.round(site.dailyVisitors * (1.6 / (i + 1)) * (0.8 + dayRng() * 0.4));
        ips.push({ siteId, day, ip, requests, pageViews: Math.round(requests * 0.12), botRequests: i === 0 ? Math.round(requests * 0.9) : 0, errors: 0, country: i % 2 === 0 ? 'DE' : 'US', lastSeenAt: Math.min(DEMO_NOW - 120_000, day + DAY - 2 * HOUR) });
      }
    }
  }
  world.db.transaction((tx) => {
    const insert = <T>(table: Parameters<typeof tx.insert>[0], rows: T[]) => {
      for (let i = 0; i < rows.length; i += 400) tx.insert(table).values(rows.slice(i, i + 400) as never).run();
    };
    insert(siteTraffic, traffic);
    insert(siteVisitors, visitors);
    insert(siteTrafficCrawlers, crawlers);
    insert(siteTrafficIps, ips);
    insert(siteTrafficPaths, paths);
    insert(siteTrafficReferrers, referrers);
  });
}
