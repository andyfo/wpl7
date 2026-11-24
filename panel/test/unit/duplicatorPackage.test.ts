import { afterAll, describe, expect, it } from 'vitest';
import { OpenPackage, PackageError, inspectPackage, notUtf8Charset, packageCharset, type PackageInspection } from '../../src/services/duplicator.js';
import { OLD_ABS, OLD_HOME, archiveTxt, dafBytes, packageEntries, tempFile, zipBytes, removeTempFiles } from '../duplicatorFixtures.js';

const OFFERED = ['8.2', '8.3', '8.4'];

type Entries = ReturnType<typeof packageEntries>;
const asZip = (entries: Entries) => tempFile(zipBytes(entries), 'shop_archive.zip');
const asDaf = (entries: Entries, version: '5.0.1' | '1.0.0' = '5.0.1') => tempFile(dafBytes(entries, { version }), 'shop_archive.daf');

async function inspect(file: string): Promise<PackageInspection> {
  const pkg = await OpenPackage.open(file);
  try {
    return await inspectPackage(pkg, 'upload-0123456789ab', OFFERED);
  } finally {
    await pkg.close();
  }
}

const FORMATS = [
  ['a .zip', (e: Entries) => asZip(e)],
  ['a .daf', (e: Entries) => asDaf(e, '5.0.1')],
  ['a 1.x .daf', (e: Entries) => asDaf(e, '1.0.0')],
] as const;

afterAll(removeTempFiles);

describe('a Duplicator package, read as an import reads an old site', () => {
  for (const [format, write] of FORMATS) {
    for (const layout of ['new', 'legacy'] as const) {
      it(`reads ${format} laid out as Duplicator ${layout === 'new' ? '5.x' : '1.x'} does`, async () => {
        const prefix = layout === 'new' ? 'wpd_' : 'wp_';
        const { dto, contents } = await inspect(write(packageEntries({ layout })));
        expect(dto.blockedReason).toBeNull();
        expect(dto.report).toMatchObject({
          home: OLD_HOME,
          tablePrefix: prefix,
          phpVersion: '8.2.29',
          abspath: OLD_ABS,
          dropins: ['object-cache.php'],
          muPlugins: [{ file: 'kinsta-mu-plugins.php', name: 'Kinsta' }],
          theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.5' },
        });
        expect(dto.report!.plugins.map((p) => [p.slug, p.active])).toEqual([
          ['akismet', false],
          ['litespeed-cache', true],
          ['hello', true],
        ]);
        // The site's files: not Duplicator's installer, here or in its folder.
        expect(contents.files.count).toBe(8);
        expect(contents.hasCore).toBe(true);
        expect(dto.suggestions).toMatchObject({
          phpVersion: '8.2',
          deactivatePlugins: ['litespeed-cache'],
          removeDropins: ['object-cache.php'],
          removeMuPlugins: ['kinsta-mu-plugins.php'],
        });
        // What the old wp-config.php said, that can be carried: never its keys, its paths or its cache.
        expect(dto.constants.map((c) => [c.name, c.ticked])).toEqual([
          ['WP_MEMORY_LIMIT', true],
          ['WP_POST_REVISIONS', true],
          ['WP_DEBUG', false],
        ]);
        expect(JSON.stringify(dto)).not.toContain('never-leaves');
        expect(dto.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['mysql8-collation', 'htaccess-custom']));
        expect(dto.warnings.map((w) => w.code)).not.toContain('no-primary-key');
        if (layout === 'new') {
          // The order archive.txt gives, whatever the archive's.
          expect(contents.dumps.map((d) => d.name.split('/').pop())).toEqual(['schema.sql.gz', 'wpd_options-h1.sql.gz', 'wpd_posts-h2.sql.gz']);
          expect(dto.warnings.map((w) => w.code)).toContain('user-ini');
        } else {
          expect(contents.dumps.map((d) => d.name)).toEqual(['dup-installer/dup-database__abc1234-20101000.sql']);
        }
      });
    }
  }

  it('refuses what cannot make a site, and says why', async () => {
    const reason = async (entries: Entries) => (await inspect(asZip(entries))).dto;
    expect((await reason(packageEntries({ layout: 'new', core: false }))).blockedReason).toMatch(/no WordPress files/);
    expect((await reason(packageEntries({ layout: 'legacy', dumps: false }))).blockedReason).toMatch(/no database/);
    expect((await reason(packageEntries({ layout: 'new', dumps: false }))).blockedReason).toMatch(/database file that archive.txt lists is missing/);
    expect((await reason(packageEntries({ layout: 'new', archive: archiveTxt({ layout: 'new', dbOnly: true, dumpFiles: [] }) }))).blockedReason).toMatch(/database only/);
    expect((await reason(packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', multisite: true }) }))).blockedReason).toMatch(/multisite/);
    expect((await reason(packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', home: `${OLD_HOME}/blog` }) }))).blockedReason).toMatch(/subfolder/);
    expect((await reason(packageEntries({ layout: 'legacy', archive: '{not json' }))).blockedReason).toMatch(/cannot be read/);
    const noConfig = packageEntries({ layout: 'legacy' }).filter((e) => !e.name.endsWith('.txt') || !e.name.startsWith('dup-installer/'));
    expect((await reason(noConfig)).blockedReason).toMatch(/no archive.txt/);
    const encrypted = await inspect(tempFile(dafBytes(packageEntries({ layout: 'new' }), { crypt: true })));
    expect(encrypted.dto.blockedReason).toMatch(/encrypted/);
  });

  it("says which triggers it cannot add, and reads the dump in the set it was written in", async () => {
    const legacy = (o: Partial<Parameters<typeof archiveTxt>[0]>) => packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', ...o }) });
    // A trigger on the package's own tables comes along; one that reaches another database does not.
    const triggers = (await inspect(asZip(legacy({ triggers: ['wp_log_insert', { name: 'wp_sync_stock', body: 'INSERT INTO stock.levels VALUES (NEW.ID)' }] })))).dto;
    expect(triggers.blockedReason).toBeNull();
    expect(triggers.warnings.find((w) => w.code === 'triggers')).toMatchObject({
      blocking: false,
      message: "Left out: the trigger wp_sync_stock, which names the database stock. Its definition is in the package's archive.txt.",
    });
    // The one that comes along is said, with the SQL mode it runs in.
    expect(triggers.warnings.find((w) => w.code === 'triggers-mode')).toMatchObject({
      blocking: false,
      message: "The trigger wp_log_insert is added if the site has all it names. It runs in WordPress's SQL mode: Duplicator does not record the one it was made with.",
    });
    // PHP dumps and mysqldump's since Duplicator 5.0.0 are in DB_CHARSET's set; mysqldump's before, in UTF-8.
    const charset = async (o: Partial<Parameters<typeof archiveTxt>[0]>) => packageCharset((await inspect(asZip(legacy(o)))).contents);
    expect(await charset({ charset: 'cp1250' })).toBe('cp1250');
    expect(await charset({ charset: 'utf8' })).toBe('utf8mb4');
    expect(await charset({ charset: 'latin1', buildMode: 'MYSQLDUMP' })).toBe('utf8mb4');
    expect(await charset({ charset: 'latin1', buildMode: 'MYSQLDUMP', version: '5.0.0' })).toBe('latin1');
    // Such a dump whose bytes are not UTF-8 is in the old site's own set, else latin1.
    const otherwise = async (o: Partial<Parameters<typeof archiveTxt>[0]>) => notUtf8Charset((await inspect(asZip(legacy({ buildMode: 'MYSQLDUMP', ...o })))).contents);
    expect(await otherwise({ charset: 'utf8' })).toBe('latin1');
    expect(await otherwise({ charset: '' })).toBe('latin1');
    expect(await otherwise({ charset: 'cp1250' })).toBe('cp1250');
    expect(await otherwise({ charset: 'sjis' })).toBeNull();
    expect((await inspect(asZip(legacy({ charset: 'sjis', buildMode: 'MYSQLDUMP' })))).dto.blockedReason).toBeNull();
    const none = (await inspect(asZip(legacy({ charset: '' })))).dto;
    expect(none.warnings.find((w) => w.code === 'charset')).toMatchObject({ blocking: false });
    expect((await inspect(asZip(legacy({ charset: 'sjis' })))).dto.blockedReason).toMatch(/sjis character set, which the panel cannot load/);
  });

  it('carries UPLOADS, a folder from where WordPress is, so the media library finds its files', async () => {
    const pkg = packageEntries({
      layout: 'legacy',
      archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', defines: { UPLOADS: 'media' }, paths: { uploads: `${OLD_ABS}/media` } }),
    });
    const dto = (await inspect(asZip(pkg))).dto;
    expect(dto.constants.find((c) => c.name === 'UPLOADS')).toMatchObject({ preview: 'media', ticked: true });
    expect(dto.warnings.map((w) => w.code)).not.toContain('uploads-dir');
    // Without it, the folder is the old site's upload_path, which Rewrite file paths takes care of.
    const without = (await inspect(asZip(packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', paths: { uploads: `${OLD_ABS}/media` } }) })))).dto;
    expect(without.warnings.find((w) => w.code === 'uploads-dir')).toMatchObject({ blocking: false });
  });

  it('refuses a site whose plugins, must-use plugins or themes are not where WordPress keeps them', async () => {
    const at = async (paths: Record<string, string>) =>
      (await inspect(asZip(packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', paths }) })))).dto;
    expect((await at({})).blockedReason).toBeNull();
    expect((await at({ plugins: `${OLD_ABS}/wp-content/extensions` })).blockedReason).toBe(`Plugins are in ${OLD_ABS}/wp-content/extensions, not in wp-content/plugins.`);
    expect((await at({ muplugins: `${OLD_ABS}/must` })).warnings.find((w) => w.code === 'mu-plugins-dir')).toMatchObject({ blocking: true });
    expect((await at({ themes: '/srv/shared/themes' })).warnings.find((w) => w.code === 'themes-dir')).toMatchObject({ blocking: true });
    // An older Duplicator does not say: nothing to go by.
    expect((await at({ plugins: '' })).blockedReason).toBeNull();
  });

  it("carries a setting that names a folder of the old site's as the same folder here, and leaves other folders unticked", async () => {
    const pkg = packageEntries({
      layout: 'legacy',
      archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', defines: { WP_LANG_DIR: `${OLD_ABS}/wp-content/languages`, SHOP_CACHE_DIR: '/var/cache/shop' } }),
    });
    const constants = (await inspect(asZip(pkg))).dto.constants;
    expect(constants.find((c) => c.name === 'WP_LANG_DIR')).toMatchObject({ preview: '/var/www/html/wp-content/languages', ticked: true });
    expect(constants.find((c) => c.name === 'SHOP_CACHE_DIR')).toMatchObject({ preview: '/var/cache/shop', ticked: false, note: 'A folder on the old host.' });
  });

  it('leaves out the wp-config-docker.php of a site that ran on WordPress\'s image', async () => {
    const pkg = await OpenPackage.open(asZip(packageEntries({ layout: 'new', extra: [{ name: 'wp-config-docker.php', data: "<?php define('DB_HOST', 'old-db');" }, { name: 'wp-content/wp-config-docker.php', data: 'kept' }] })));
    try {
      const names: string[] = [];
      await pkg.walkSite({ onDir: async () => undefined, onFile: async (name) => (names.push(name.toString('utf8')), async () => undefined), onFileEnd: async () => undefined });
      expect(names).not.toContain('wp-config-docker.php');
      expect(names).toContain('wp-content/wp-config-docker.php');
    } finally {
      await pkg.close();
    }
  });

  it('refuses a file that is no Duplicator archive', async () => {
    await expect(OpenPackage.open(tempFile(Buffer.from('<?php // installer.php')))).rejects.toBeInstanceOf(PackageError);
  });

  it('refuses a package that holds a path the panel does not write', async () => {
    const dto = (await inspect(asZip(packageEntries({ layout: 'legacy', extra: [{ name: '../outside.php', data: 'x' }] })))).dto;
    expect(dto.blockedReason).toMatch(/a path the panel does not write/);
  });

  it('refuses a .daf file named like a folder, in the listing and in the walk', async () => {
    const file = asDaf(packageEntries({ layout: 'new', extra: [{ name: 'wp-content/uploads/sneaky/', data: 'x' }] }));
    const dto = (await inspect(file)).dto;
    expect(dto.blockedReason).toMatch(/wp-content\/uploads\/sneaky\/ \(a file whose name ends in \/\)/);
    const pkg = await OpenPackage.open(file);
    try {
      const walk = pkg.walkSite({ onDir: async () => undefined, onFile: async () => async () => undefined, onFileEnd: async () => undefined });
      await expect(walk).rejects.toThrow(/a file whose name ends in \//);
    } finally {
      await pkg.close();
    }
  });
});
