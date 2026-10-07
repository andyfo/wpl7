/**
 * An import waiting on Confirm: a pediatrics practice's site on a shared host, connected an hour
 * ago through the migration plugin. Its tables use their own prefix, it runs a Redis object cache
 * (an active plugin and its drop-in) that the panel suggests leaving behind, its wp-config.php
 * carries three settings - one of which starts unticked - and its .htaccess has rules of its own.
 */
import { imports } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import type { TestWorld } from '../../test/helpers.js';
import { HOUR, MINUTE, ago } from './clock.js';
import { IMPORT_SOURCE } from './data.js';

/** A stand-in: shaped like a token, and no token. */
const TOKEN = 'demo-import-token-not-a-real-one-0000000000';

export function seedImports(world: TestWorld): void {
  const host = new URL(IMPORT_SOURCE).hostname;
  const report = {
    protocol: 1,
    plugin: '0.3.0',
    time: Math.floor(ago(HOUR) / 1000),
    endpoint: `${IMPORT_SOURCE}/wp-json/wpl7-migrate/v1/`,
    home: IMPORT_SOURCE,
    siteurl: IMPORT_SOURCE,
    abspath: '/home/willow/public_html/',
    document_root: '/home/willow/public_html',
    content_dir: '/home/willow/public_html/wp-content',
    uploads_dir: '/home/willow/public_html/wp-content/uploads',
    multisite: false,
    windows: false,
    table_prefix: 'wpx_',
    wp: '7.1.2',
    php: '8.2.29',
    locale: 'en_US',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_520_ci',
    blog_public: 1,
    admin_email: `office@${host}`,
    title: 'Willow Pediatrics',
    https: true,
    db: {
      server: 'MariaDB 10.11.6',
      bytes: 61_865_984,
      tables: [
        'commentmeta',
        'comments',
        'links',
        'options',
        'postmeta',
        'posts',
        'term_relationships',
        'term_taxonomy',
        'termmeta',
        'terms',
        'usermeta',
        'users',
      ].map((t) => ({ name: `wpx_${t}`, rows: 100, bytes: 1_000_000, pk: ['id'], collation: 'utf8mb4_unicode_520_ci' })),
      views: 0,
      triggers: 0,
      routines: 0,
    },
    files: { count: 18_744, bytes: 2_312_105_984, dirs: 2_216, links: 0, unreadable: 0, excluded: ['wp-content/cache/**'] },
    constants: [
      { name: 'WP_MEMORY_LIMIT', value: '256M', type: 'string' },
      { name: 'WP_POST_REVISIONS', value: 5, type: 'int' },
      { name: 'DISALLOW_FILE_MODS', value: true, type: 'bool' },
    ],
    dropins: ['object-cache.php'],
    mu_plugins: [],
    plugins: [
      { file: 'redis-cache/redis-cache.php', slug: 'redis-cache', name: 'Redis Object Cache', version: '2.6.5', active: true },
      { file: 'wordpress-seo/wp-seo.php', slug: 'wordpress-seo', name: 'Yoast SEO', version: '26.1', active: true },
      { file: 'contact-form-7/wp-contact-form-7.php', slug: 'contact-form-7', name: 'Contact Form 7', version: '6.1.2', active: true },
      { file: 'classic-editor/classic-editor.php', slug: 'classic-editor', name: 'Classic Editor', version: '1.6.7', active: false },
    ],
    theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.3' },
    htaccess: { present: true, custom: true },
    user_ini: false,
    php_ini: false,
    warnings: [],
  };
  world.db
    .insert(imports)
    .values({
      token: TOKEN,
      tokenHash: sha256Hex(TOKEN),
      status: 'connected',
      sourceUrl: IMPORT_SOURCE,
      homeUrl: IMPORT_SOURCE,
      endpointUrl: report.endpoint,
      allowHttp: 0,
      pluginVersion: report.plugin,
      protocol: 1,
      wpVersion: report.wp,
      phpVersion: report.php,
      tablePrefix: report.table_prefix,
      multisite: 0,
      blogPublic: 1,
      filesBytes: report.files.bytes,
      dbBytes: report.db.bytes,
      fileCount: report.files.count,
      tableCount: report.db.tables.length,
      report: JSON.stringify(report),
      warnings: '[]',
      createdBy: 'priya',
      createdAt: ago(HOUR + 12 * MINUTE),
      updatedAt: ago(HOUR),
      connectedAt: ago(HOUR),
      expiresAt: ago(HOUR) + 7 * 24 * HOUR,
    })
    .run();
}
