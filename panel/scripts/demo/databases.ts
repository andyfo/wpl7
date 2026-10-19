/**
 * Databases: every site's own with WordPress's tables in it, one site with a database added for
 * its shop's order history, one database left behind by the deleted site, and each server's sizes
 * as read twenty minutes ago. The browser answers from memory (test/dbBrowserFake.ts), so the
 * Database tab has tables and rows to show; SQL answers with a fixed result.
 */
import { serverDatabaseScans, serverDatabases, siteDatabases } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { fakeColumn, wordpressTables, type FakeDbBrowser } from '../../test/dbBrowserFake.js';
import { DAY, MINUTE, ago } from './clock.js';
import { DELETED_SITE, SERVERS, SITES, rng, seedOf, siteDomains } from './data.js';
import { siteIds } from './sites.js';

const MB = 1024 * 1024;
/** The database a site was given besides its own. */
export const EXTRA_DATABASE = { site: 'northwind-bakery', name: 'northwind_orders' };

const dbName = (slug: string) => `wp_${slug.replace(/-/g, '_')}`;

export function seedDatabases(world: TestWorld): void {
  const browserOf = (server: number): FakeDbBrowser => (server === 1 ? world.dbBrowser : world.remote(server).dbBrowser);
  const adminOf = (server: number) => (server === 1 ? world.dbAdmin : world.remote(server).dbAdmin);
  const sizes: { serverId: number; name: string; tables: number; bytes: number }[] = [];

  for (const site of SITES) {
    const name = dbName(site.slug);
    const url = `https://${siteDomains(site)[0]}`;
    for (const [table, contents] of Object.entries(wordpressTables(url))) browserOf(site.server).addTable(name, table, contents);
    const next = rng(seedOf(`db:${site.slug}`));
    // Busier and bigger sites keep bigger databases: posts, orders, sessions, logs.
    const bytes = Math.round((2.5 + site.diskMb / 90 + site.dailyVisitors / 40 + next() * 6) * MB);
    sizes.push({ serverId: site.server, name, tables: 12 + Math.round(next() * 40), bytes });
  }

  const shop = SITES.find((s) => s.slug === EXTRA_DATABASE.site)!;
  browserOf(shop.server).addTable(EXTRA_DATABASE.name, 'orders', {
    columns: [
      fakeColumn('id', 'int(10) unsigned', { key: 'PRI', extra: 'auto_increment' }),
      fakeColumn('customer', 'varchar(120)'),
      fakeColumn('total', 'decimal(10,2)'),
      fakeColumn('placed_at', 'datetime'),
    ],
    key: ['id'],
    rows: [
      ['1001', 'M. Novak', '24.50', '2026-10-01 07:12:44'],
      ['1002', 'J. Alvarez', '11.00', '2026-10-02 08:03:10'],
      ['1003', 'K. Osei', '42.75', '2026-10-03 06:55:31'],
      ['1004', 'L. Park', '8.90', '2026-10-04 09:21:05'],
    ],
  });
  world.db
    .insert(siteDatabases)
    .values({ siteId: siteIds.get(shop.slug)!, name: EXTRA_DATABASE.name, createdBy: 'andy', createdAt: ago(40 * DAY) })
    .run();
  sizes.push({ serverId: shop.server, name: EXTRA_DATABASE.name, tables: 1, bytes: Math.round(0.4 * MB) });
  // Left on its server when the site went: nothing claims it.
  sizes.push({ serverId: DELETED_SITE.server, name: dbName(DELETED_SITE.slug), tables: 14, bytes: Math.round(6.2 * MB) });

  for (const s of sizes) {
    world.db.insert(serverDatabases).values({ ...s, collation: 'utf8mb4_unicode_ci' }).run();
    // The fake MariaDB says the same, so Refresh reads back what the page already shows.
    adminOf(s.serverId).databases.add(s.name);
    adminOf(s.serverId).sizes.set(s.name, { tables: s.tables, bytes: s.bytes });
  }
  for (const server of SERVERS) {
    world.db.insert(serverDatabaseScans).values({ serverId: server.id, scannedAt: ago(20 * MINUTE), attemptedAt: ago(20 * MINUTE), error: null }).run();
  }

  // What the SQL view's Run gets back in the demo: the shape of a real answer.
  for (const server of SERVERS) {
    browserOf(server.id).runAnswer = () => ({
      results: [
        {
          kind: 'rows',
          columns: [
            { name: 'option_name', type: 'varchar', kind: 'text' },
            { name: 'option_value', type: 'longtext', kind: 'text' },
          ],
          rows: [
            ['siteurl', 'https://northwindbakery.example'],
            ['home', 'https://northwindbakery.example'],
            ['blogname', 'Northwind Bakery'],
          ],
          truncated: false,
          ms: 3,
        },
      ],
      ms: 4,
    });
  }
}
