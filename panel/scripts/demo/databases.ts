/**
 * Databases: every WordPress site's own with WordPress's tables in it, the PHP site's with its
 * booking app's, one site with a database added for its shop's order history, one database left
 * behind by the deleted site, and each server's sizes as read twenty minutes ago. The browser
 * answers from memory (test/dbBrowserFake.ts), so the Database tab has tables and rows to show;
 * SQL answers with a fixed result.
 */
import { serverDatabaseScans, serverDatabases, siteDatabases } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { fakeColumn, wordpressTables, type FakeDbBrowser, type FakeTable } from '../../test/dbBrowserFake.js';
import { DAY, MINUTE, ago } from './clock.js';
import { DELETED_SITE, SERVERS, SITES, isPhp, rng, seedOf, siteDomains } from './data.js';
import { siteIds } from './sites.js';

const MB = 1024 * 1024;
/** The database a site was given besides its own. */
export const EXTRA_DATABASE = { site: 'northwind-bakery', name: 'northwind_orders' };

const dbName = (slug: string) => `wp_${slug.replace(/-/g, '_')}`;

/**
 * Bayside Bike Rentals' booking app (a Laravel app, files.ts): its bikes, bookings and customers,
 * its queue, its staff logins and the migrations that made them. Customers are invented, their
 * addresses example.net ones.
 */
function bookingTables(): Record<string, FakeTable> {
  const id = (name = 'id') => fakeColumn(name, 'bigint(20) unsigned', { key: 'PRI', extra: 'auto_increment' });
  const stamp = (name: string) => fakeColumn(name, 'timestamp', { nullable: true });
  return {
    bikes: {
      columns: [id(), fakeColumn('name', 'varchar(255)'), fakeColumn('kind', 'varchar(255)'), fakeColumn('size', 'varchar(255)'), fakeColumn('hourly_rate', 'decimal(8,2)'), fakeColumn('active', 'tinyint(1)', { default: "'1'" })],
      key: ['id'],
      rows: [
        ['1', 'City cruiser 01', 'city', 'M', '8.00', '1'],
        ['2', 'City cruiser 02', 'city', 'L', '8.00', '1'],
        ['3', 'Trail e-bike 01', 'e-bike', 'M', '16.00', '1'],
        ['4', 'Trail e-bike 02', 'e-bike', 'L', '16.00', '1'],
        ['5', 'Tandem', 'tandem', 'L', '14.00', '1'],
        ['6', 'Kids 20"', 'kids', 'S', '5.00', '0'],
      ],
    },
    bookings: {
      columns: [
        id(),
        fakeColumn('reference', 'varchar(255)', { key: 'UNI' }),
        fakeColumn('bike_id', 'bigint(20) unsigned', { key: 'MUL' }),
        fakeColumn('customer_id', 'bigint(20) unsigned', { key: 'MUL' }),
        fakeColumn('starts_at', 'datetime'),
        fakeColumn('ends_at', 'datetime'),
        fakeColumn('status', 'varchar(255)', { default: "'held'" }),
        fakeColumn('total', 'decimal(8,2)'),
        stamp('created_at'),
      ],
      key: ['id'],
      rows: [
        ['2041', 'BB-7Q4K', '3', '118', '2026-10-05 10:00:00', '2026-10-05 14:00:00', 'confirmed', '64.00', '2026-10-01 18:22:09'],
        ['2042', 'BB-9M2D', '1', '87', '2026-10-05 11:00:00', '2026-10-05 13:00:00', 'confirmed', '16.00', '2026-10-03 07:41:55'],
        ['2043', 'BB-3T8W', '5', '131', '2026-10-05 13:00:00', '2026-10-05 17:00:00', 'held', '56.00', '2026-10-05 09:51:30'],
        ['2044', 'BB-6H1R', '4', '64', '2026-10-06 09:00:00', '2026-10-06 18:00:00', 'confirmed', '96.00', '2026-10-04 20:13:47'],
        ['2045', 'BB-2C5N', '2', '87', '2026-10-06 10:00:00', '2026-10-06 12:00:00', 'confirmed', '16.00', '2026-10-05 08:06:12'],
      ],
    },
    customers: {
      columns: [id(), fakeColumn('name', 'varchar(255)'), fakeColumn('email', 'varchar(255)', { key: 'UNI' }), stamp('created_at')],
      key: ['id'],
      rows: [
        ['64', 'R. Okafor', 'r.okafor@example.net', '2026-08-14 16:02:51'],
        ['87', 'J. Alvarez', 'j.alvarez@example.net', '2026-08-30 09:15:20'],
        ['118', 'K. Tanaka', 'k.tanaka@example.net', '2026-09-21 12:47:03'],
        ['131', 'L. Svensson', 'l.svensson@example.net', '2026-10-05 09:51:12'],
      ],
    },
    jobs: {
      columns: [id(), fakeColumn('queue', 'varchar(255)', { key: 'MUL' }), fakeColumn('payload', 'longtext'), fakeColumn('attempts', 'tinyint(3) unsigned'), fakeColumn('available_at', 'int(10) unsigned'), fakeColumn('created_at', 'int(10) unsigned')],
      key: ['id'],
      rows: [],
    },
    migrations: {
      columns: [fakeColumn('id', 'int(10) unsigned', { key: 'PRI', extra: 'auto_increment' }), fakeColumn('migration', 'varchar(255)'), fakeColumn('batch', 'int(11)')],
      key: ['id'],
      rows: [
        ['1', '0001_01_01_000000_create_users_table', '1'],
        ['2', '0001_01_01_000002_create_jobs_table', '1'],
        ['3', '2026_07_20_101500_create_bikes_table', '1'],
        ['4', '2026_07_20_101600_create_customers_table', '1'],
        ['5', '2026_07_20_101700_create_bookings_table', '1'],
        ['6', '2026_09_25_080000_add_reference_to_bookings_table', '2'],
      ],
    },
    users: {
      columns: [id(), fakeColumn('name', 'varchar(255)'), fakeColumn('email', 'varchar(255)', { key: 'UNI' }), fakeColumn('password', 'varchar(255)'), stamp('created_at')],
      key: ['id'],
      rows: [['1', 'Front desk', 'desk@baysidebikes.example', '$2y$12$demo.not.a.real.password.hash.000000000000000000000', '2026-07-25 09:30:00']],
    },
  };
}

export function seedDatabases(world: TestWorld): void {
  const browserOf = (server: number): FakeDbBrowser => (server === 1 ? world.dbBrowser : world.remote(server).dbBrowser);
  const adminOf = (server: number) => (server === 1 ? world.dbAdmin : world.remote(server).dbAdmin);
  const sizes: { serverId: number; name: string; tables: number; bytes: number }[] = [];

  for (const site of SITES) {
    const name = dbName(site.slug);
    const url = `https://${siteDomains(site)[0]}`;
    // A PHP site's database holds its own app's tables, not WordPress's.
    const tables = isPhp(site) ? bookingTables() : wordpressTables(url);
    for (const [table, contents] of Object.entries(tables)) browserOf(site.server).addTable(name, table, contents);
    const next = rng(seedOf(`db:${site.slug}`));
    // Busier and bigger sites keep bigger databases: posts, orders, sessions, logs.
    const bytes = Math.round((2.5 + site.diskMb / 90 + site.dailyVisitors / 40 + next() * 6) * MB);
    const count = 12 + Math.round(next() * 40);
    sizes.push({ serverId: site.server, name, tables: isPhp(site) ? Object.keys(tables).length : count, bytes });
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
