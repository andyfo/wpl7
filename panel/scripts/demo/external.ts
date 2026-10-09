/**
 * Sites hosted elsewhere: two added through WPL7 Connect - Meadow Vet Clinic answering, Granite
 * Gym's plugin no longer answering the panel - and a third site's plugin that has just connected,
 * waiting on its Confirm step. fra1 keeps their backups (backups.ts); their plugins and themes are
 * in plugins.ts. Runs before the inventory, which needs their ids.
 */
import { siteConnections, siteStats, sites } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { PANEL_VERSION } from '../../src/lib/version.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { ADMIN_EMAIL, CONNECT_SOURCE, EXTERNAL_SITES, rng, seedOf, type DemoExternalSite } from './data.js';
import { EXTERNAL_INVENTORY, WORDPRESS } from './plugins.js';
import { siteIds } from './sites.js';

const MB = 1024 * 1024;

/** Stand-ins: shaped like the real thing, and not it. The demo never calls a site. */
const TOKEN = 'demo-connect-token-not-a-real-one-00000000000';
const PRIVATE_KEY = 'demo-not-a-private-key';
const PUBLIC_KEY = 'demo-not-a-public-key-000000000000000000000';

const ADMINS = [
  { id: 1, login: 'admin', name: 'Site Admin' },
  { id: 4, login: 'marta', name: 'Marta Lind' },
];

/** What WPL7 Connect reports about a site (docs/internal/connect-protocol.md, The report). */
function report(home: string, title: string, php: string, opts: { loader: boolean; plugins: { slug: string; name: string; version: string }[] }) {
  const host = new URL(home).hostname;
  const user = host.split('.')[0]!.replace(/-/g, '');
  return {
    protocol: 1,
    plugin: PANEL_VERSION,
    time: Math.floor(ago(3 * MINUTE) / 1000),
    endpoint: `${home}/wp-json/wpl7-connect/v1/`,
    home,
    siteurl: home,
    abspath: `/home/${user}/public_html/`,
    document_root: `/home/${user}/public_html`,
    content_dir: `/home/${user}/public_html/wp-content`,
    uploads_dir: `/home/${user}/public_html/wp-content/uploads`,
    multisite: false,
    windows: false,
    table_prefix: 'wp_',
    wp: WORDPRESS,
    php,
    locale: 'en_US',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_520_ci',
    blog_public: 1,
    admin_email: `office@${host}`,
    title,
    https: true,
    db: {
      server: 'MySQL 8.0.43',
      bytes: 48_234_496,
      tables: ['commentmeta', 'comments', 'links', 'options', 'postmeta', 'posts', 'term_relationships', 'term_taxonomy', 'termmeta', 'terms', 'usermeta', 'users'].map(
        (t) => ({ name: `wp_${t}`, rows: 100, bytes: 1_000_000, pk: ['id'], collation: 'utf8mb4_unicode_520_ci' }),
      ),
      views: 0,
      triggers: 0,
      routines: 0,
    },
    files: { count: 9_412, bytes: 1_168_637_952, dirs: 1_204, links: 0, unreadable: 0, excluded: [] },
    constants: [],
    dropins: [],
    mu_plugins: opts.loader ? [{ file: 'wpl7-connect-loader.php', name: 'WPL7 Connect loader' }] : [],
    plugins: [
      { file: 'wpl7-connect/wpl7-connect.php', slug: 'wpl7-connect', name: 'WPL7 Connect', version: PANEL_VERSION, active: true },
      ...opts.plugins.map((p) => ({ file: `${p.slug}/${p.slug}.php`, slug: p.slug, name: p.name, version: p.version, active: true })),
    ],
    theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.5' },
    htaccess: { present: true, custom: false },
    user_ini: false,
    php_ini: false,
    warnings: [],
    admins: ADMINS,
    fs_method: 'direct',
    file_mods: true,
    loader: opts.loader,
    commands: [],
  };
}

const addedAt = (site: DemoExternalSite): number => ago(site.ageDays * DAY + 5 * HOUR);

export function seedExternalSites(world: TestWorld): void {
  for (const site of EXTERNAL_SITES) {
    const host = new URL(site.home).hostname;
    const row = world.db
      .insert(sites)
      .values({
        slug: site.slug,
        kind: 'external',
        serverId: site.storage,
        title: site.title,
        domains: JSON.stringify([host]),
        devHostname: null,
        isLive: 1,
        keepDevAlias: 0,
        phpVersion: site.php,
        locale: 'en_US',
        status: 'connected',
        dbName: '',
        dbUser: '',
        dbPassword: '',
        mailPassword: null,
        wpAdminUser: 'admin',
        wpAdminEmail: ADMIN_EMAIL,
        containerName: '',
        tablePrefix: 'wp_',
        diskBytes: 1_115 * MB,
        createdAt: addedAt(site),
        updatedAt: addedAt(site),
      })
      .returning()
      .get();
    siteIds.set(site.slug, row.id);
    const plugins = EXTERNAL_INVENTORY[site.slug]!.components.filter((c) => c.kind === 'plugin').map((c) => ({ slug: c.slug, name: c.title, version: c.version }));
    world.db
      .insert(siteConnections)
      .values({
        siteId: row.id,
        status: 'active',
        token: null,
        tokenHash: sha256Hex(`${TOKEN}-${site.slug}`),
        privateKey: PRIVATE_KEY,
        publicKey: PUBLIC_KEY,
        allowHttp: 0,
        sourceUrl: site.home,
        homeUrl: site.home,
        endpointUrl: `${site.home}/wp-json/wpl7-connect/v1/`,
        transport: 'rest',
        pluginVersion: PANEL_VERSION,
        protocol: 1,
        report: JSON.stringify(report(site.home, site.title, `${site.php}.26`, { loader: true, plugins })),
        warnings: '[]',
        commands: '[]',
        actAsUserId: 1,
        actAsLogin: 'admin',
        lastContactAt: site.reachable ? ago(17 * MINUTE) : ago(4 * HOUR + 17 * MINUTE),
        lastError: site.reachable ? null : 'The site did not answer ping (HTTP 403).',
        lastErrorAt: site.reachable ? null : ago(17 * MINUTE),
        failCount: site.reachable ? 0 : 4,
        certExpiresAt: ago(-(site.reachable ? 62 : 38) * DAY),
        lastBackupAt: ago(7 * HOUR - 4 * MINUTE),
        createdBy: 'priya',
        createdAt: addedAt(site) - 9 * MINUTE,
        updatedAt: ago(17 * MINUTE),
        enrolledAt: addedAt(site) - 6 * MINUTE,
        addedAt: addedAt(site),
      })
      .run();
  }
  seedMonitoring(world);
  seedWaitingConnection(world);
}

/** Their home pages, asked from the panel every minute: a day of response times, and the latest. */
function seedMonitoring(world: TestWorld): void {
  const latest = (world.core.monitor as unknown as { latest: Map<number, object> }).latest;
  const rows: (typeof siteStats.$inferInsert)[] = [];
  for (const site of EXTERNAL_SITES) {
    const id = siteIds.get(site.slug)!;
    const next = rng(seedOf(`external:${site.slug}`));
    const baseMs = 280 + Math.round(next() * 160);
    let httpMs = baseMs;
    for (let i = DAY / (5 * MINUTE); i >= 0; i--) {
      const ts = ago(i * 5 * MINUTE);
      const hour = new Date(ts).getUTCHours();
      const daily = 0.5 + 0.5 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      httpMs = Math.round(baseMs * (0.85 + 0.3 * next()) + daily * 60);
      rows.push({ siteId: id, ts, up: 1, httpMs });
    }
    latest.set(id, {
      slug: site.slug,
      serverId: site.storage,
      up: true,
      httpStatus: 200,
      httpMs,
      lastCheckedAt: ago(40_000),
      cpuPct: null,
      memBytes: null,
      diskBytes: 1_115 * MB,
    });
  }
  world.db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(siteStats).values(rows.slice(i, i + 500)).run();
  });
}

/**
 * A bookshop's plugin, connected three minutes ago and checked a minute ago: the Confirm step.
 * Its must-use folder is not writable, so the page warns that a rollback would not work there.
 */
function seedWaitingConnection(world: TestWorld): void {
  const r = report(CONNECT_SOURCE, 'Riverside Books', '8.3.26', {
    loader: false,
    plugins: [
      { slug: 'woocommerce', name: 'WooCommerce', version: '11.1.2' },
      { slug: 'wordpress-seo', name: 'Yoast SEO', version: '28.6' },
    ],
  });
  world.db
    .insert(siteConnections)
    .values({
      siteId: null,
      status: 'enrolled',
      token: TOKEN,
      tokenHash: sha256Hex(TOKEN),
      privateKey: PRIVATE_KEY,
      publicKey: PUBLIC_KEY,
      allowHttp: 0,
      sourceUrl: null,
      homeUrl: CONNECT_SOURCE,
      endpointUrl: r.endpoint,
      transport: 'rest',
      pluginVersion: PANEL_VERSION,
      protocol: 1,
      report: JSON.stringify(r),
      warnings: '[]',
      commands: '[]',
      lastContactAt: null,
      checkedAt: ago(MINUTE),
      createdBy: 'admin',
      createdAt: ago(9 * MINUTE),
      updatedAt: ago(MINUTE),
      enrolledAt: ago(3 * MINUTE),
      expiresAt: ago(3 * MINUTE) + DAY,
    })
    .run();
}
