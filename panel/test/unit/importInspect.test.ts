import { describe, expect, it } from 'vitest';
import {
  blockingReason,
  constantLiteral,
  inspectReport,
  migrateReportSchema,
  nearestPhp,
  type MigrateReport,
} from '../../src/services/importInspect.js';
import { sampleReport } from '../importFixtures.js';

const OFFERED = ['8.1', '8.2', '8.3', '8.4'];

function report(overrides: Record<string, unknown> = {}): MigrateReport {
  return migrateReportSchema.parse(sampleReport(overrides));
}

const inspect = (overrides: Record<string, unknown> = {}, allowHttp = false) =>
  inspectReport(report(overrides), { offeredPhp: OFFERED, allowHttp });

const codes = (overrides: Record<string, unknown> = {}) => inspect(overrides).warnings.map((w) => w.code);

describe('the report schema', () => {
  it('takes numbers PHP sends as strings, and caps the lists', () => {
    const r = report({ db: { ...(sampleReport().db as object), bytes: '1024', tables: [{ name: 'wpx_options', rows: '7', bytes: '8', pk: null }] } });
    expect(r.db.bytes).toBe(1024);
    expect(r.db.tables[0]).toMatchObject({ rows: 7, bytes: 8, pk: null });
    const many = Array.from({ length: 2001 }, (_, i) => ({ file: `p${i}/p.php`, slug: `p${i}`, name: '', version: '1', active: false }));
    expect(migrateReportSchema.safeParse(sampleReport({ plugins: many })).success).toBe(false);
    expect(migrateReportSchema.safeParse(sampleReport({ title: 'x'.repeat(501) })).success).toBe(false);
  });

  it('takes the paths a host keeps to itself as null', () => {
    const r = report({ document_root: null, uploads_dir: null });
    expect(r).toMatchObject({ document_root: null, uploads_dir: null });
    expect(inspectReport(r, { offeredPhp: OFFERED, allowHttp: false }).warnings).toMatchObject([{ code: 'uploads-dir', blocking: false }]);
  });
});

describe('inspecting a report', () => {
  it('has nothing to say about a plain single site', () => {
    expect(inspect().warnings).toEqual([]);
  });

  it.each([
    ['multisite', { multisite: true }],
    ['windows', { windows: true }],
    ['table-prefix', { table_prefix: 'wp-x_' }],
    ['subdirectory', { siteurl: 'https://willow-pediatrics.example/wp' }],
    ['subdirectory', { home: 'https://willow-pediatrics.example/blog', siteurl: 'https://willow-pediatrics.example/blog' }],
    ['content-dir', { content_dir: '/home/willow/content' }],
    ['uploads-dir', { uploads_dir: '/srv/shared-uploads' }],
  ])('refuses %s', (code, overrides) => {
    const { warnings } = inspect(overrides);
    expect(warnings.find((w) => w.code === code)).toMatchObject({ blocking: true });
    expect(blockingReason(warnings)).toBe(warnings.find((w) => w.blocking)!.message);
  });

  it('only warns about the rest', () => {
    const r = sampleReport();
    const found = inspect(
      {
        home: 'http://willow-pediatrics.example',
        siteurl: 'http://willow-pediatrics.example',
        uploads_dir: '/home/willow/public_html/files',
        php: '7.4.33',
        collation: 'utf8mb4_0900_ai_ci',
        db: {
          ...(r.db as object),
          tables: [
            { name: 'wpx_options', rows: 1, bytes: 1, pk: ['option_id'] },
            { name: 'wpx_log', rows: 1, bytes: 1, pk: null },
            { name: 'old_stats', rows: 1, bytes: 1, pk: ['id'] },
          ],
          views: 1,
          triggers: 2,
        },
        files: { count: 9, bytes: 30 * 1024 ** 3, links: 3, unreadable: 1, partial: true },
        htaccess: { present: true, custom: true },
        user_ini: true,
        warnings: [{ code: 'open-basedir', detail: 'open_basedir limits what the plugin can read.' }],
      },
      true,
    ).warnings;
    expect(found.every((w) => !w.blocking)).toBe(true);
    expect(found.map((w) => w.code)).toEqual([
      'uploads-dir',
      'http-only',
      'foreign-tables',
      'no-primary-key',
      'links',
      'unreadable',
      'large',
      'php-not-offered',
      'mysql8-collation',
      'views-triggers',
      'htaccess-custom',
      'user-ini',
      'partial-count',
      'open-basedir',
    ]);
    expect(found.find((w) => w.code === 'php-not-offered')!.message).toBe(
      'The old site runs PHP 7.4, which this panel does not offer. It gets PHP 8.1.',
    );
    expect(found.find((w) => w.code === 'foreign-tables')!.message).toBe('1 table without the prefix wpx_ will be left behind.');
    expect(found.find((w) => w.code === 'open-basedir')!.message).toBe('open_basedir limits what the plugin can read.');
  });

  it('suggests what of the old host to leave behind', () => {
    const { suggestions } = inspect({
      dropins: ['object-cache.php', 'advanced-cache.php', 'maintenance.php'],
      mu_plugins: [
        { file: 'wpengine-security-auditor.php', name: 'WP Engine Security Auditor' },
        { file: 'my-tweaks.php', name: 'Our tweaks' },
      ],
    });
    expect(suggestions).toEqual({
      title: 'Willow Pediatrics',
      slug: 'willow-pediatrics',
      phpVersion: '8.2',
      locale: 'en_US',
      deactivatePlugins: ['redis-cache'],
      removeDropins: ['object-cache.php', 'advanced-cache.php'],
      removeMuPlugins: ['wpengine-security-auditor.php'],
    });
  });

  it('carries constants it can write, never the blocked ones, and masks the secret-looking ones', () => {
    const { constants } = inspect({
      constants: [
        { name: 'WP_MEMORY_LIMIT', value: '256M', type: 'string' },
        { name: 'DISALLOW_FILE_MODS', value: true, type: 'bool' },
        { name: 'ACF_PRO_LICENSE', value: 'b3JkZXJfaWQ9MTIzNDU2', type: 'string' },
        { name: 'DB_PASSWORD', value: 'hunter2', type: 'string' },
        { name: 'FTP_PASS', value: 'hunter2', type: 'string' },
        { name: 'WP_CONTENT_DIR', value: '/home/willow/x', type: 'string' },
        { name: 'my_lowercase', value: 'x', type: 'string' },
        { name: 'SNEAKY', value: '--require=/tmp/x.php', type: 'string' },
        { name: 'WP_POST_REVISIONS', value: 5, type: 'int' },
        { name: 'WP_POST_REVISIONS', value: 6, type: 'int' },
      ],
    });
    expect(constants).toEqual([
      { name: 'WP_MEMORY_LIMIT', type: 'string', preview: '256M', ticked: true, note: null },
      {
        name: 'DISALLOW_FILE_MODS',
        type: 'bool',
        preview: 'true',
        ticked: false,
        note: 'Blocks plugin and theme updates in WordPress.',
      },
      { name: 'ACF_PRO_LICENSE', type: 'string', preview: 'b3••••U2', ticked: true, note: null },
      { name: 'WP_POST_REVISIONS', type: 'int', preview: '5', ticked: true, note: null },
    ]);
  });

  it('writes constants as PHP only where the type says so', () => {
    expect(constantLiteral({ name: 'A', value: true, type: 'bool' })).toEqual({ value: 'true', raw: true });
    expect(constantLiteral({ name: 'A', value: 42, type: 'int' })).toEqual({ value: '42', raw: true });
    expect(constantLiteral({ name: 'A', value: -1.5, type: 'float' })).toEqual({ value: '-1.5', raw: true });
    expect(constantLiteral({ name: 'A', value: null, type: 'null' })).toEqual({ value: 'null', raw: true });
    expect(constantLiteral({ name: 'A', value: "it's", type: 'string' })).toEqual({ value: "it's", raw: false });
    // A type and a value that disagree are not carried at all.
    expect(constantLiteral({ name: 'A', value: 'system("id")', type: 'int' })).toBeNull();
    expect(constantLiteral({ name: 'A', value: 'true', type: 'bool' })).toBeNull();
  });

  it('picks the PHP nearest to the old site’s', () => {
    expect(nearestPhp('8.2.29', OFFERED)).toBe('8.2');
    expect(nearestPhp('7.4.33', OFFERED)).toBe('8.1');
    expect(nearestPhp('8.5.0', OFFERED)).toBe('8.4');
    expect(nearestPhp('nonsense', OFFERED)).toBe('8.4');
    expect(nearestPhp('8.2.1', [])).toBeNull();
    expect(codes({ php: '8.3.1' })).toEqual([]);
  });
});
