/**
 * Duplicator packages for tests, built here byte by byte: a .zip (with ZIP64 when asked) and a
 * .daf in both of its header versions, holding a site laid out as Duplicator 5.x and 1.x lay one
 * out. archive.txt and the dumps follow what real packages from Duplicator 5.2.0 and 1.5.11 hold:
 * field names, PHP's class marks, the old site's salts (which must never come out the other side),
 * a schema file and one file per table (5.x), or one dump (1.x).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------- zip

export interface ZipFixtureEntry {
  name: string | Buffer;
  data?: Buffer | string;
  dir?: boolean;
  link?: boolean;
  /** Unix permission bits. */
  mode?: number;
  /** 8 deflate (the default for files), 0 stored, or something the reader refuses. */
  method?: number;
  /** General purpose flags; 1 marks the entry encrypted. */
  flags?: number;
  /** Corrupt the stored CRC-32. */
  badCrc?: boolean;
  /** Claim this size in the central directory instead of the real one. */
  claimSize?: number;
}

export function zipBytes(entries: ZipFixtureEntry[], opts: { zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name, 'utf8') : e.name;
    const raw = e.dir ? Buffer.alloc(0) : Buffer.from(e.data ?? '');
    const method = e.dir ? 0 : (e.method ?? (raw.length > 0 ? 8 : 0));
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = e.badCrc ? (zlib.crc32(raw) ^ 0xffff) >>> 0 : zlib.crc32(raw);
    const size = e.claimSize ?? raw.length;
    const flags = (e.flags ?? 0) | (typeof e.name === 'string' && /[^\x20-\x7e]/.test(e.name) ? 0x800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE((2024 - 1980) << 9 | (2 << 5) | 29, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const type = e.dir ? 0o040000 : e.link ? 0o120000 : 0o100000;
    const mode = type | (e.mode ?? (e.dir ? 0o755 : 0o644));
    const zip64 = opts.zip64 === true;
    const extra = zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE((2024 - 1980) << 9 | (2 << 5) | 29, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    cd.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(cd, name, extra);
    offset += local.length + name.length + body.length;
  }
  const cdBytes = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (opts.zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(entries.length), 24);
    z.writeBigUInt64LE(BigInt(entries.length), 32);
    z.writeBigUInt64LE(BigInt(cdBytes.length), 40);
    z.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBytes.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(z, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : cdBytes.length, 12);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cdBytes, ...tail, eocd]);
}

// ---------------------------------------------------------------------------- daf

export interface DafFixtureEntry {
  name: string | Buffer;
  data?: Buffer | string;
  dir?: boolean;
  mode?: string;
  /** Per file, from 5.0.0 on: its own compression flag. */
  compress?: boolean;
  badCrc?: boolean;
  /** The file's own CRC-32 in its header, instead of its content's. */
  fileHash?: string;
}

const crcHex = (b: Buffer) => (zlib.crc32(b) >>> 0).toString(16).padStart(8, '0');

/**
 * A DupArchive. `version` '5.0.1' writes the flags field and a per-file flag; '1.0.0' the old
 * `<C>` header, where the index is the one file stored as it is. Globs of `globSize` bytes.
 */
export function dafBytes(
  entries: DafFixtureEntry[],
  opts: { version?: '5.0.1' | '1.0.0'; compress?: boolean; crypt?: boolean; index?: boolean; globSize?: number } = {},
): Buffer {
  // The index has a fixed size, so its content moves nothing: built once to learn where the
  // installer's files start, then again with that in it.
  const first = dafBuild(entries, opts, Buffer.alloc(2000));
  if (opts.index === false) return first.bytes;
  const json = Buffer.alloc(2000);
  json.write(JSON.stringify({ extraPos: first.extraPos }));
  return dafBuild(entries, opts, json).bytes;
}

function dafBuild(
  entries: DafFixtureEntry[],
  opts: { version?: '5.0.1' | '1.0.0'; compress?: boolean; crypt?: boolean; index?: boolean; globSize?: number },
  index: Buffer,
): { bytes: Buffer; extraPos: number } {
  const version = opts.version ?? '5.0.1';
  const v5 = version.startsWith('5');
  const compress = opts.compress ?? true;
  const glob = opts.globSize ?? 1024;
  const out: Buffer[] = [];
  let size = 0;
  const put = (b: Buffer) => {
    out.push(b);
    size += b.length;
  };
  const flags = Buffer.alloc(2);
  flags.writeUInt16LE((compress ? 1 : 0) | (opts.crypt ? 2 : 0));
  put(
    v5
      ? Buffer.concat([Buffer.from(`<A><V>${version}</V><X>`), flags, Buffer.from(`</X><P>${opts.crypt ? '$6$rounds=50000$salt$hash' : ''}</P></A>`)])
      : Buffer.from(`<A><V>${version}</V><C>${compress ? 'true' : 'false'}</C></A>`),
  );
  const file = (name: Buffer, data: Buffer, fileCompress: boolean, mode: string, badCrc = false, fileHash?: string) => {
    const fflags = Buffer.alloc(2);
    fflags.writeUInt16LE(fileCompress ? 1 : 0);
    put(Buffer.from(`<F><FS>${data.length}</FS><MT>1700000000</MT><P>${mode}</P>`));
    if (v5) put(Buffer.concat([Buffer.from('<X>'), fflags, Buffer.from('</X>')]));
    put(Buffer.concat([Buffer.from(`<HA>${fileHash ?? crcHex(data)}</HA><RPL>${name.length}</RPL><RP>`), name, Buffer.from('</RP></F>')]));
    for (let at = 0; at < data.length; at += glob) {
      const plain = data.subarray(at, at + glob);
      const stored = fileCompress ? zlib.deflateRawSync(plain, { level: 2 }) : plain;
      const hash = badCrc ? '00000001' : crcHex(v5 ? plain : stored);
      put(Buffer.concat([Buffer.from(`<G><OS>${plain.length}</OS><SS>${stored.length}</SS><HA>${hash}</HA></G>`), stored]));
    }
  };
  // The index is written at its fixed size and never compressed, in either version.
  if (opts.index !== false) file(Buffer.from('__dup__archive__index.json'), index, false, '0644');
  let extraPos = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : e.name;
    if (!extraPos && name.toString('latin1').startsWith('dup-installer/')) extraPos = size;
    if (e.dir) put(Buffer.concat([Buffer.from(`<D><MT>1700000000</MT><P>${e.mode ?? '0755'}</P><RPL>${name.length}</RPL><RP>`), name, Buffer.from('</RP></D>')]));
    else file(name, Buffer.from(e.data ?? ''), v5 ? (e.compress ?? compress) : compress, e.mode ?? '0644', e.badCrc, e.fileHash);
  }
  return { bytes: Buffer.concat(out), extraPos };
}

// ---------------------------------------------------------------------------- a site in a package

export const OLD_HOME = 'https://shop.example.com';
export const OLD_ABS = '/home/shop/public_html';

/** archive.txt as Duplicator writes it, with what tests change. */
export function archiveTxt(o: {
  layout: 'new' | 'legacy';
  prefix?: string;
  multisite?: boolean;
  dbOnly?: boolean;
  dumpFiles?: string[];
  plugins?: Record<string, unknown>;
  php?: string;
  home?: string;
  abs?: string;
  charset?: string;
  /** Triggers by name, with a body of their own or SET @n = 1. */
  triggers?: (string | { name: string; body: string })[];
  buildMode?: string;
  version?: string;
  /** More constants of the old wp-config.php. */
  defines?: Record<string, unknown>;
  /** Folders other than WordPress's own: plugins, muplugins, themes. */
  paths?: Record<string, string>;
}) {
  const prefix = o.prefix ?? 'wpd_';
  const home = o.home ?? OLD_HOME;
  const abs = o.abs ?? OLD_ABS;
  const define = (value: unknown, inWpConfig: boolean) => ({ 'CL_-=_-=': 'stdClass', value, inWpConfig });
  return JSON.stringify({
    'CL_-=_-=': 'Duplicator\\Installer\\Package\\ArchiveDescriptor',
    dup_type: 'lite',
    created: '2026-11-20 10:00:00',
    version_dup: o.version ?? (o.layout === 'new' ? '5.2.0' : '1.5.11'),
    version_wp: '7.1.5',
    version_db: '8.0.46',
    version_php: o.php ?? '8.2.29',
    version_os: 'Linux',
    blogname: 'Shop',
    exportOnlyDB: o.dbOnly ?? false,
    secure_on: 0,
    secure_pass: '',
    wp_tableprefix: prefix,
    mu_mode: o.multisite ? 1 : 0,
    installer_backup_name: 'shop_abc_20261120_installer-backup.php',
    components: ['package_component_db', 'package_component_core', 'package_component_plugins', 'package_component_themes', 'package_component_uploads'],
    dbInfo: {
      'CL_-=_-=': 'Duplicator\\Installer\\Package\\DescriptorDBInfo',
      version: '8.0.46',
      collationList: ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_520_ci'],
      tablesSizeOnDisk: 4096,
      tablesList: { [`${prefix}options`]: { 'CL_-=_-=': 'x', insertedRows: 2, size: 2048 }, [`${prefix}posts`]: { 'CL_-=_-=': 'x', insertedRows: 2, size: 2048 } },
      ...(o.dumpFiles ? { dumpFiles: o.dumpFiles } : {}),
      viewCount: 1,
      procCount: 0,
      funcCount: 0,
      // PHP writes an empty list as [], one with triggers as an object by name.
      triggerList: o.triggers
        ? Object.fromEntries(
            o.triggers.map((t) => {
              const { name, body } = typeof t === 'string' ? { name: t, body: 'SET @n = 1' } : t;
              const create = `DELIMITER ;;\nCREATE DEFINER=\`olduser\`@\`localhost\` TRIGGER \`${name}\` AFTER INSERT ON \`${prefix}posts\` FOR EACH ROW ${body};;\nDELIMITER ;`;
              return [name, { 'CL_-=_-=': 'x', event: 'INSERT', table: `${prefix}posts`, timing: 'AFTER', create }];
            }),
          )
        : [],
      ...(o.buildMode ? { buildMode: o.buildMode } : {}),
    },
    fileInfo: { 'CL_-=_-=': 'x', dirCount: 5, fileCount: 8, size: 4096 },
    wpInfo: {
      'CL_-=_-=': 'Duplicator\\Installer\\Package\\DescriptorWpInfo',
      version: '7.1.5',
      is_multisite: o.multisite ?? false,
      configs: {
        'CL_-=_-=': 'stdClass',
        defines: {
          'CL_-=_-=': 'stdClass',
          ABSPATH: define(`${abs}/`, true),
          DB_CHARSET: define(o.charset ?? 'utf8mb4', true),
          AUTH_KEY: define('old-site-auth-key-never-leaves', true),
          NONCE_SALT: define('old-site-nonce-salt-never-leaves', true),
          WP_MEMORY_LIMIT: define('256M', true),
          WP_POST_REVISIONS: define(5, true),
          WP_DEBUG: define(false, true),
          WP_CACHE: define(true, true),
          AUTOSAVE_INTERVAL: define(60, false),
          ...Object.fromEntries(Object.entries(o.defines ?? {}).map(([k, v]) => [k, define(v, true)])),
        },
        realValues: {
          'CL_-=_-=': 'stdClass',
          siteUrl: home,
          homeUrl: home,
          originalPaths: {
            'CL_-=_-=': 'stdClass',
            home: abs,
            abs,
            wpconfig: abs,
            wpcontent: `${abs}/wp-content`,
            uploads: `${abs}/wp-content/uploads`,
            plugins: `${abs}/wp-content/plugins`,
            muplugins: `${abs}/wp-content/mu-plugins`,
            themes: `${abs}/wp-content/themes`,
            ...o.paths,
          },
        },
      },
      plugins: o.plugins ?? {
        'akismet/akismet.php': { 'CL_-=_-=': 'x', slug: 'akismet/akismet.php', name: 'Akismet', version: '5.7.2', active: false, mustUse: false, dropIns: false },
        'litespeed-cache/litespeed-cache.php': { 'CL_-=_-=': 'x', slug: 'litespeed-cache/litespeed-cache.php', name: 'LiteSpeed Cache', version: '7.9', active: true, mustUse: false, dropIns: false },
        'hello.php': { 'CL_-=_-=': 'x', slug: 'hello.php', name: 'Hello Dolly', version: '1.7.2', active: true, mustUse: false, dropIns: false },
        'object-cache.php': { 'CL_-=_-=': 'x', slug: 'object-cache.php', name: 'LiteSpeed object cache', version: '', active: true, mustUse: false, dropIns: true },
        'kinsta-mu-plugins.php': { 'CL_-=_-=': 'x', slug: 'kinsta-mu-plugins.php', name: 'Kinsta', version: '', active: true, mustUse: true, dropIns: false },
      },
      themes: { twentytwentyfive: { 'CL_-=_-=': 'x', slug: 'twentytwentyfive', themeName: 'Twenty Twenty-Five', version: '1.5', isActive: true } },
    },
    package_hash: 'abc1234-20101000',
  });
}

/** Byte values a PHP-mode dump keeps raw inside a quoted value. */
export const BINARY = Buffer.from([0x00, 0x01, 0xff, 0xfe]);

/** 5.x's schema file: the tables, a MySQL 8 collation, and a view with the old user as its definer. */
export function schemaSql(prefix = 'wpd_'): Buffer {
  return Buffer.from(
    [
      '/* DUPLICATOR-PRO (PHP MULTI-THREADED BUILD MODE) MYSQL SCRIPT CREATED ON : 2026-11-20 10:00:00 */',
      '',
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
      '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
      '',
      `CREATE TABLE IF NOT EXISTS \`${prefix}options\` (`,
      '  `option_id` bigint unsigned NOT NULL AUTO_INCREMENT,',
      '  `option_name` varchar(191) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT \'\',',
      '  `option_value` longtext COLLATE utf8mb4_unicode_520_ci NOT NULL,',
      '  PRIMARY KEY (`option_id`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;',
      '',
      `CREATE TABLE IF NOT EXISTS \`${prefix}posts\` (`,
      '  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,',
      '  `post_content` longtext NOT NULL,',
      '  `raw` varbinary(16) DEFAULT NULL,',
      '  PRIMARY KEY (`ID`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
      '',
      `CREATE ALGORITHM=UNDEFINED DEFINER=\`olduser\`@\`%\` SQL SECURITY DEFINER VIEW \`${prefix}recent\` AS select \`${prefix}posts\`.\`ID\` AS \`ID\` from \`${prefix}posts\`;`,
      '',
      '/***** TABLE CREATION END *****/',
      '/* DUPLICATOR_MYSQLDUMP_EOF */',
      '',
    ].join('\n'),
    'latin1',
  );
}

/** One of 5.x's table files: rows one to a line, strings with their line breaks escaped. */
export function tableSql(prefix: string, table: 'options' | 'posts'): Buffer {
  const rows =
    table === 'options'
      ? [`("1","siteurl","${OLD_HOME}")`, `("2","blogname","USE other; DEFINER=\`x\`@\`y\` utf8mb4_0900_ai_ci stays")`]
      : [`("1","<p>Hello from ${OLD_HOME}/about/</p>\\n<p>second line</p>",NULL)`];
  const head = Buffer.from(`/* INSERT TABLE DATA: ${prefix}${table} */\nINSERT IGNORE INTO \`${prefix}${table}\` VALUES \n`, 'latin1');
  const lines = rows.map((r, i) => Buffer.from(`${r}${i === rows.length - 1 ? ';' : ','}\n`, 'latin1'));
  if (table === 'posts') {
    // A binary value, raw between its quotes, on a row of its own.
    lines[lines.length - 1] = Buffer.from(`${rows[0]},\n`, 'latin1');
    lines.push(Buffer.concat([Buffer.from('("2","binary",X\'00\'),\n("3","raw bytes:', 'latin1'), BINARY, Buffer.from('",NULL);\n', 'latin1')]));
  }
  return Buffer.concat([head, ...lines, Buffer.from('\n/* DUPLICATOR_MYSQLDUMP_EOF */\n', 'latin1')]);
}

/** 1.x's single dump, every row an INSERT of its own. */
export function legacySql(prefix = 'wp_'): Buffer {
  return Buffer.from(
    [
      '/* DUPLICATOR-LITE (PHP BUILD MODE) MYSQL SCRIPT CREATED ON : 2026-11-20 10:00:00 */',
      '',
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
      '',
      'SET FOREIGN_KEY_CHECKS = 0;',
      '',
      `CREATE TABLE \`${prefix}options\` (`,
      '  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,',
      '  `option_name` varchar(191) NOT NULL DEFAULT \'\',',
      '  `option_value` longtext NOT NULL,',
      '  PRIMARY KEY (`option_id`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
      '',
      `CREATE TABLE \`${prefix}posts\` (`,
      '  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,',
      '  PRIMARY KEY (`ID`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
      '',
      `INSERT INTO \`${prefix}options\` VALUES("1", "siteurl", "${OLD_HOME}");`,
      `INSERT INTO \`${prefix}options\` VALUES("2", "home", "${OLD_HOME}");`,
      '',
      'SET FOREIGN_KEY_CHECKS = 1; ',
      '',
      '/* Duplicator WordPress Timestamp: 2026-11-20 10:00:00*/',
      '/* DUPLICATOR_MYSQLDUMP_EOF */',
      '',
    ].join('\n'),
    'latin1',
  );
}

export const OLD_HTACCESS = '# BEGIN WordPress\nRewriteEngine On\nRewriteRule . /index.php [L]\n# END WordPress\nphp_value upload_max_filesize 64M\n';

/** A site as a package holds it: WordPress, wp-content, Duplicator's own installer files beside it. */
export function packageEntries(o: {
  layout: 'new' | 'legacy';
  prefix?: string;
  core?: boolean;
  dumps?: boolean;
  archive?: string;
  extra?: { name: string; data?: string | Buffer; dir?: boolean; link?: boolean }[];
}): { name: string; data?: Buffer | string; dir?: boolean; link?: boolean }[] {
  const prefix = o.prefix ?? (o.layout === 'new' ? 'wpd_' : 'wp_');
  const site: { name: string; data?: Buffer | string; dir?: boolean; link?: boolean }[] = [
    { name: 'wp-admin', dir: true },
    { name: 'wp-content', dir: true },
    { name: 'wp-content/uploads/2024', dir: true },
    { name: 'index.php', data: '<?php require __DIR__ . "/wp-blog-header.php";' },
    ...(o.core === false ? [] : [{ name: 'wp-load.php', data: '<?php // load' }, { name: 'wp-includes/version.php', data: "<?php $wp_version = '7.1.5';" }]),
    { name: 'wp-config-sample.php', data: '<?php // sample' },
    { name: 'wp-content/object-cache.php', data: '<?php // LiteSpeed object cache' },
    { name: 'wp-content/mu-plugins/kinsta-mu-plugins.php', data: '<?php // host' },
    { name: 'wp-content/uploads/2024/photo.jpg', data: Buffer.alloc(5000, 7) },
    { name: 'wp-content/uploads/odd name & ü.txt', data: 'odd' },
    // Duplicator's own installer, beside the site in the archive: never unpacked.
    { name: 'shop_abc_20261120_installer-backup.php', data: '<?php // the installer, again' },
    ...(o.extra ?? []),
  ];
  const archive = o.archive ?? archiveTxt({ layout: o.layout, prefix, ...(o.layout === 'new' ? { dumpFiles: ['schema.sql', `${prefix}options-h1.sql`, `${prefix}posts-h2.sql`] } : {}) });
  const installer =
    o.layout === 'new'
      ? [
          { name: 'dup-installer/main.installer.php', data: '<?php // installer' },
          { name: 'dup-installer/dup_descriptors_abc1234-20101000/archive.txt', data: archive },
          { name: 'dup-installer/dup_descriptors_abc1234-20101000/orig_files/source_site_htaccess', data: OLD_HTACCESS },
          { name: 'dup-installer/dup_descriptors_abc1234-20101000/orig_files/source_site_userini', data: 'memory_limit = 512M\n' },
          { name: 'dup-installer/dup_descriptors_abc1234-20101000/orig_files/source_site_wpconfig', data: "<?php define('DB_PASSWORD', '');" },
          ...(o.dumps === false
            ? []
            : [
                // In archive order a table file can come before the schema: archive.txt says the order.
                { name: `dup-installer/dup_descriptors_abc1234-20101000/db_dumps/${prefix}posts-h2.sql.gz`, data: zlib.gzipSync(tableSql(prefix, 'posts')) },
                { name: 'dup-installer/dup_descriptors_abc1234-20101000/db_dumps/schema.sql.gz', data: zlib.gzipSync(schemaSql(prefix)) },
                { name: `dup-installer/dup_descriptors_abc1234-20101000/db_dumps/${prefix}options-h1.sql.gz`, data: zlib.gzipSync(tableSql(prefix, 'options')) },
              ]),
        ]
      : [
          { name: 'dup-installer/main.installer.php', data: '<?php // installer' },
          { name: 'dup-installer/dup-archive__abc1234-20101000.txt', data: archive },
          { name: 'dup-installer/original_files_abc1234-20101000/source_site_htaccess', data: OLD_HTACCESS },
          ...(o.dumps === false ? [] : [{ name: 'dup-installer/dup-database__abc1234-20101000.sql', data: legacySql(prefix) }]),
        ];
  return [...site, ...installer];
}

const tempDirs: string[] = [];

/** Write `bytes` to a new file in a temporary folder of its own; removeTempFiles takes them all away. */
export function tempFile(bytes: Buffer, name = 'package.bin'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-test-dup-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The folders tempFile made: for a test file's afterAll. */
export function removeTempFiles(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
