/**
 * An old site, as the migration plugin reports it (docs/internal/import-protocol.md, A.4): a
 * plain single site on a shared host. Tests change what they are about.
 */
export function sampleReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 1,
    plugin: '0.3.0',
    time: Math.floor(Date.now() / 1000),
    endpoint: 'https://willow-pediatrics.example/wp-json/wpl7-migrate/v1/',
    home: 'https://willow-pediatrics.example',
    siteurl: 'https://willow-pediatrics.example',
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
    admin_email: 'office@willow-pediatrics.example',
    title: 'Willow Pediatrics',
    https: true,
    db: {
      server: 'MariaDB 10.11.6',
      bytes: 48_000_000,
      tables: [
        { name: 'wpx_options', rows: 812, bytes: 2_000_000, pk: ['option_id'], collation: 'utf8mb4_unicode_520_ci' },
        { name: 'wpx_posts', rows: 1200, bytes: 30_000_000, pk: ['ID'], collation: 'utf8mb4_unicode_520_ci' },
        { name: 'wpx_postmeta', rows: 9000, bytes: 16_000_000, pk: ['meta_id'], collation: 'utf8mb4_unicode_520_ci' },
      ],
      views: 0,
      triggers: 0,
      routines: 0,
    },
    files: { count: 14_210, bytes: 1_400_000_000, dirs: 1900, links: 0, unreadable: 0, excluded: ['wp-content/cache/**'] },
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
      { file: 'classic-editor/classic-editor.php', slug: 'classic-editor', name: 'Classic Editor', version: '1.6.7', active: false },
    ],
    theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.3' },
    htaccess: { present: true, custom: false },
    user_ini: false,
    php_ini: false,
    warnings: [],
    ...overrides,
  };
}
