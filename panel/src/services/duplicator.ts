// @docs sites/duplicator
/**
 * Duplicator packages: the archive (.zip or .daf) of a Duplicator backup, uploaded to make a new
 * site from (New site → WordPress → Start from: Duplicator package). The installer.php that comes
 * with it is never run: the panel reads the archive itself, as it reads an import's pull.
 *
 * - An upload goes to the panel's own disk in chunks, as an app's image does, and stays a day
 *   after its last chunk unless a create holds it. A failed create keeps it for Back to the form.
 * - What is in a package is read from its installer folder: `archive.txt` (the old site's address,
 *   folders, table prefix, versions, plugins, wp-config.php constants), the dump files, and the
 *   copies of `.htaccess` and `.user.ini` that Duplicator leaves out of the site's files. Two
 *   layouts: Duplicator 1.x keeps them in `dup-installer/` under hashed names, 5.x in
 *   `dup-installer/dup_descriptors_<hash>/`. archive.txt also holds the old site's keys and salts:
 *   only the fields below are kept, and never a secret.
 * - The package becomes the report an import's plugin sends (importInspect.ts), so the warnings, the
 *   suggestions and the choices are the import's own, and so is the set-up (handlers/sitePackage.ts).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ImportRunBody } from '../../shared/schemas.js';
import { TABLE_PREFIX_RE, WORDPRESS_DROPINS, MU_PLUGIN_FILE_RE } from '../../shared/schemas.js';
import type { ImportWarning, PackageInspectionDto, PackageSourceDto } from '../../shared/types.js';
import { UPLOAD_ID_RE } from '../../shared/siteFilePath.js';
import { importPathProblem } from '../lib/archivePath.js';
import { conflict, notFound, tooManyRequests } from '../lib/errors.js';
import { DafFormatError, DafReader, DAF_INDEX_FILE, type DafEntry } from '../lib/dupArchive.js';
import { ZipFormatError, ZipReader, type ZipEntry } from '../lib/zipReader.js';
import { phpStringDefines } from '../lib/phpDefines.js';
import { dumpCharset } from './packageDump.js';
import { checkTrigger, inspectTrigger, type SiteNames } from './packageTriggers.js';
import { CONSTANT_BLOCKLIST, blockingReason, checkChoices, inspectReport, migrateReportSchema, sourceOf, type MigrateReport } from './importInspect.js';

/** The largest package the panel takes. */
export const PACKAGE_UPLOAD_MAX_BYTES = 20 * 1024 ** 3;
/** How long an upload no create took stays, after its last chunk. */
export const PACKAGE_UPLOAD_KEEP_MS = 24 * 3600_000;
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
/** The longest trigger definition read. */
const MAX_TRIGGER_BYTES = 1024 * 1024;
/** The largest .htaccess or .user.ini of the old site the panel puts back: a site's redirects can run to megabytes. */
export const MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
const INSTALLER_DIR = 'dup-installer/';

export type PackageFormat = 'zip' | 'daf';

/** Where an entry is, to read it again. */
export type PackageEntryRef = { format: 'zip'; entry: ZipEntry } | { format: 'daf'; offset: number; size: number };

/** One file of the dump, in the order it loads. */
export interface PackageDumpFile {
  name: string;
  gzip: boolean;
  bytes: number;
  ref: PackageEntryRef;
}

// ---------------------------------------------------------------------- archive.txt

const count = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).catch(0);
const text = (max = 2000) => z.string().max(max);

/** Names of the Duplicator plugin's own options: no other option of the site is ever deleted for a package. */
const OWN_OPTION_RE = /^(duplicator|dupli_opt)_[A-Za-z0-9_]{1,150}$/;

/** archive.txt's opts_delete, as Duplicator's own: 1.x writes the list as a JSON string. */
function ownOptions(value: unknown): string[] {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((o): o is string => typeof o === 'string' && OWN_OPTION_RE.test(o)).slice(0, 200);
}
/** The fields of a package's archive.txt the panel reads; the rest, the old salts among them, are dropped. */
const descriptorSchema = z.object({
  /** lite or pro; the oldest packages say nothing, and are Lite's. */
  dup_type: text(32).catch(''),
  version_dup: text(32).catch(''),
  license_type: z.coerce.number().int().catch(0),
  /** The plugin's own options its installer deletes on the new site: a list, or 1.x's list as a JSON string. */
  opts_delete: z.unknown().transform(ownOptions),
  packInfo: z.object({ packageId: count, packageHash: text(100).catch('') }).catch({ packageId: 0, packageHash: '' }),
  version_wp: text(32),
  version_php: text(32),
  version_db: text(200).catch(''),
  version_os: text(100).catch(''),
  created: text(64).catch(''),
  blogname: text(500).catch(''),
  exportOnlyDB: z.boolean().catch(false),
  wp_tableprefix: text(64),
  mu_mode: z.coerce.number().catch(0),
  installer_backup_name: text(300).catch(''),
  components: z.array(text(100)).max(50).catch([]),
  dbInfo: z.object({
    version: text(200).catch(''),
    collationList: z.array(text(100)).max(500).catch([]),
    tablesList: z.record(text(200), z.object({ insertedRows: count, size: count })).catch({}),
    tablesSizeOnDisk: count,
    tablesFinalCount: count,
    dumpFiles: z.array(text(300)).max(200_000).catch([]),
    viewCount: count,
    procCount: count,
    funcCount: count,
    /** PHP, PHPCHUNKING or MYSQLDUMP: what wrote the dump. */
    buildMode: text(32).catch(''),
    // Duplicator keeps triggers out of its dumps and lists them here, each with its CREATE
    // ("DELIMITER ;;\n…;;\nDELIMITER ;"). PHP writes an empty list as [].
    triggerList: z
      .record(text(200), z.object({ create: z.string().max(MAX_TRIGGER_BYTES).catch('') }).catch({ create: '' }))
      .catch({})
      .transform((list) => Object.entries(list).map(([name, t]) => ({ name, create: t.create }))),
  }).catch({ version: '', collationList: [], tablesList: {}, tablesSizeOnDisk: 0, tablesFinalCount: 0, dumpFiles: [], viewCount: 0, procCount: 0, funcCount: 0, buildMode: '', triggerList: [] }),
  fileInfo: z.object({ fileCount: count, dirCount: count, size: count }).catch({ fileCount: 0, dirCount: 0, size: 0 }),
  wpInfo: z.object({
    is_multisite: z.boolean().catch(false),
    configs: z.object({
      defines: z.record(text(100), z.unknown()).catch({}).transform(carriedDefines),
      realValues: z.object({
        siteUrl: text(),
        homeUrl: text(),
        originalPaths: z.object({
          home: text(),
          abs: text(),
          wpcontent: text(),
          uploads: text().nullable().catch(null),
          // WP_PLUGIN_DIR, WPMU_PLUGIN_DIR, the theme root: empty where an older Duplicator does not say.
          plugins: text().catch(''),
          muplugins: text().catch(''),
          themes: text().catch(''),
        }),
      }),
    }),
    plugins: z
      .record(
        text(300),
        z.object({ name: text(300).catch(''), version: text(64).catch(''), active: z.boolean().catch(false), mustUse: z.boolean().catch(false), dropIns: z.boolean().catch(false) }),
      )
      .catch({}),
    themes: z.record(text(200), z.object({ themeName: text(300).catch(''), version: text(64).catch(''), isActive: z.boolean().catch(false) })).catch({}),
  }),
});
type Descriptor = z.infer<typeof descriptorSchema>;

/** PHP's serialised class names (`"CL_-=_-=": "stdClass"`) out of every object, so the records hold values alone. */
function withoutClassMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClassMarks);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('CL_')) out[k] = withoutClassMarks(v);
    return out;
  }
  return value;
}

/**
 * The old wp-config.php's constants the panel uses: DB_CHARSET, and those an import could carry.
 * The rest go as archive.txt is read, its keys and salts among them.
 */
function carriedDefines(defines: Record<string, unknown>): Record<string, { value: unknown; inWpConfig: unknown }> {
  const out: Record<string, { value: unknown; inWpConfig: unknown }> = {};
  for (const [name, raw] of Object.entries(defines)) {
    if (!raw || typeof raw !== 'object') continue;
    if (name !== 'DB_CHARSET' && !constantOf(name, raw)) continue;
    const { value, inWpConfig } = raw as { value?: unknown; inWpConfig?: unknown };
    out[name] = { value, inWpConfig };
  }
  return out;
}

/** A constant from the old wp-config.php, as the import's report carries one; null for what cannot be carried. */
function constantOf(name: string, raw: unknown): MigrateReport['constants'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const { value, inWpConfig } = raw as { value?: unknown; inWpConfig?: unknown };
  // Only what the old wp-config.php said: the rest is WordPress's own defaults.
  if (inWpConfig !== true || CONSTANT_BLOCKLIST.has(name) || name.startsWith('FTP_')) return null;
  if (typeof value === 'string') return value.length <= 2000 ? { name, value, type: 'string' } : null;
  if (typeof value === 'boolean') return { name, value, type: 'bool' };
  if (typeof value === 'number') return { name, value, type: Number.isInteger(value) ? 'int' : 'float' };
  if (value === null) return { name, value: null, type: 'null' };
  return null;
}

/** `classic-editor/classic-editor.php` -> `classic-editor`; `hello.php` -> `hello`: WP-CLI's names. */
function pluginSlug(file: string): string {
  return file.includes('/') ? file.slice(0, file.indexOf('/')) : file.replace(/\.php$/i, '');
}

const isDropin = (name: string) => (WORDPRESS_DROPINS as readonly string[]).includes(name);

// ---------------------------------------------------------------------- the open package

/** What the panel found in a package, besides the site's own files. */
export interface PackageContents {
  format: PackageFormat;
  bytes: number;
  /** Null when archive.txt is missing or unreadable: the package is refused. */
  descriptor: Descriptor | null;
  descriptorProblem: string | null;
  dumps: PackageDumpFile[];
  /** The old site's own files Duplicator keeps apart; its wp-config.php is read only for the Duplicator plugin's key. */
  original: { htaccess: PackageEntryRef | null; userIni: PackageEntryRef | null; phpIni: boolean; wpConfig: PackageEntryRef | null };
  encrypted: boolean;
  /** The site's files: what the listing holds outside the installer's folder. */
  files: { count: number; bytes: number; links: number; other: number };
  hasCore: boolean;
  dropins: string[];
  muPlugins: string[];
  /** The first path the panel refuses to write, if any. */
  badPath: string | null;
}

export class OpenPackage {
  private constructor(
    private readonly zip: ZipReader | null,
    private readonly daf: DafReader | null,
    readonly contents: PackageContents,
  ) {}

  /**
   * Read the package's listing and installer files, or take `known`: what an inspection of the
   * same file found. Throws when the file is neither format.
   */
  static async open(file: string, known?: PackageContents): Promise<OpenPackage> {
    const fd = await fsp.open(file, 'r');
    const head = Buffer.alloc(4);
    let size = 0;
    try {
      size = (await fd.stat()).size;
      await fd.read(head, 0, 4, 0);
    } finally {
      await fd.close();
    }
    if (head.toString('latin1') === 'PK\x03\x04') {
      const zip = await ZipReader.open(file);
      try {
        return new OpenPackage(zip, null, known?.format === 'zip' ? known : await listZip(zip, size));
      } catch (err) {
        await zip.close();
        throw err;
      }
    }
    if (head.toString('latin1').startsWith('<A>')) {
      const daf = await DafReader.open(file);
      try {
        return new OpenPackage(null, daf, known?.format === 'daf' ? known : await listDaf(daf, size));
      } catch (err) {
        await daf.close();
        throw err;
      }
    }
    throw new PackageError('This is not a Duplicator archive: upload the file that ends in _archive.zip or _archive.daf.');
  }

  async close(): Promise<void> {
    await this.zip?.close();
    await this.daf?.close();
  }

  /** An entry's content, piece by piece. */
  async read(ref: PackageEntryRef, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    if (ref.format === 'zip') await this.zip!.pipe(ref.entry, sink);
    else await this.daf!.readAt(ref.offset, sink);
  }

  async readAll(ref: PackageEntryRef, max: number): Promise<Buffer> {
    if (ref.format === 'zip') return this.zip!.readAll(ref.entry, max);
    return this.daf!.readAllAt(ref.offset, max);
  }

  /**
   * The site's files, in archive order: everything outside the installer's folder, but for links,
   * Duplicator's own installer copies and the archive's index. `onFile` returns the sink for a
   * file's content; a path the panel refuses fails the walk. A .daf file whose content is not what
   * Duplicator noted for it goes to `onMismatch`: it changed while the package was made.
   */
  async walkSite(handlers: {
    onDir: (name: Buffer, mtime: number) => Promise<void>;
    onFile: (name: Buffer, size: number, mtime: number, mode: number | null) => Promise<(chunk: Buffer) => Promise<void>>;
    onFileEnd: () => Promise<void>;
    onMismatch?: (name: Buffer) => void;
  }): Promise<void> {
    const skip = siteFileFilter(this.contents.descriptor?.installer_backup_name ?? '');
    if (this.zip) {
      for await (const entry of this.zip.entries()) {
        const verdict = skip(entry.name);
        if (verdict !== 'keep' || entry.kind === 'link' || entry.kind === 'other') continue;
        const problem = entryProblem(entry.name, entry.kind);
        if (problem) throw new PackageError(`The package holds ${entry.name.toString('utf8')}, a path the panel does not write: ${problem}.`);
        if (entry.kind === 'dir') {
          await handlers.onDir(stripSlash(entry.name), entry.mtime);
          continue;
        }
        const sink = await handlers.onFile(entry.name, entry.size, entry.mtime, entry.mode);
        await this.zip.pipe(entry, sink);
        await handlers.onFileEnd();
      }
      return;
    }
    let ended: (() => Promise<void>) | null = null;
    await this.daf!.walk({
      onMismatch: (entry) => {
        if (!handlers.onMismatch) throw new PackageError(`${entry.name.toString('utf8')} in the package does not match its CRC-32.`);
        handlers.onMismatch(entry.name);
      },
      onEntry: async (entry) => {
        if (ended) {
          await ended();
          ended = null;
        }
        const verdict = skip(entry.name);
        if (verdict !== 'keep') return null;
        const problem = entryProblem(entry.name, entry.kind);
        if (problem) throw new PackageError(`The package holds ${entry.name.toString('utf8')}, a path the panel does not write: ${problem}.`);
        if (entry.kind === 'dir') {
          await handlers.onDir(stripSlash(entry.name), entry.mtime);
          return null;
        }
        const sink = await handlers.onFile(entry.name, entry.size, entry.mtime, entry.mode);
        if (entry.size === 0) {
          await handlers.onFileEnd();
          return null;
        }
        ended = handlers.onFileEnd;
        return sink;
      },
    });
    if (ended) await (ended as () => Promise<void>)();
  }
}

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

const stripSlash = (name: Buffer) => (name[name.length - 1] === 0x2f ? name.subarray(0, name.length - 1) : name);

/** Why the panel does not write one of the site's entries, or null. A file named like a folder would be read as one. */
function entryProblem(name: Buffer, kind: 'file' | 'dir'): string | null {
  if (kind === 'file' && name[name.length - 1] === 0x2f) return 'a file whose name ends in /';
  return importPathProblem(stripSlash(name));
}

/**
 * Which entries are the site's: not the installer's folder, not Duplicator's own installer copies
 * at the top (an installer left in a site's folder installs it again for whoever opens it), not the
 * archive's index, not a wp-config.php (the panel writes its own), and not the wp-config-docker.php
 * of a site that ran on WordPress's image, which that image writes the new one from when it is there.
 */
function siteFileFilter(installerBackup: string): (name: Buffer) => 'keep' | 'installer' | 'skip' {
  return (name) => {
    const n = name.toString('latin1');
    if (n.startsWith(INSTALLER_DIR) || n === 'dup-installer') return 'installer';
    if (n === DAF_INDEX_FILE || n === 'wp-config.php' || n === 'wp-config-docker.php') return 'skip';
    if (!n.includes('/') && (n === 'installer.php' || /_installer(-backup)?\.php(\.bak)?$/.test(n) || (installerBackup !== '' && n === installerBackup))) return 'skip';
    return 'keep';
  };
}

/** What the installer's folder holds: archive.txt, the dumps and the original config files. */
interface InstallerFiles {
  config: { name: string; ref: PackageEntryRef }[];
  dumps: Map<string, { name: string; ref: PackageEntryRef; bytes: number }>;
  original: Map<string, PackageEntryRef>;
}

const CONFIG_NEW_RE = /^dup-installer\/(dup_descriptors_[^/]+)\/archive\.txt$/;
const CONFIG_OLD_RE = /^dup-installer\/dup-archive__[^/]+\.txt$/;
const DUMP_NEW_RE = /^dup-installer\/(dup_descriptors_[^/]+)\/db_dumps\/([^/]+\.sql(\.gz)?)$/;
const DUMP_OLD_RE = /^dup-installer\/dup-database__[^/]+\.sql(\.gz)?$/;
const ORIGINAL_RE = /^dup-installer\/(?:dup_descriptors_[^/]+\/orig_files|original_files_[^/]+)\/source_site_(htaccess|userini|phpini|wpconfig)$/;

function noteInstallerFile(found: InstallerFiles, name: string, ref: PackageEntryRef, bytes: number): void {
  if (CONFIG_NEW_RE.test(name) || CONFIG_OLD_RE.test(name)) found.config.push({ name, ref });
  else if (DUMP_NEW_RE.test(name) || DUMP_OLD_RE.test(name)) found.dumps.set(name, { name, ref, bytes });
  else {
    const original = ORIGINAL_RE.exec(name);
    if (original) found.original.set(original[1]!, ref);
  }
}

interface Tally {
  files: { count: number; bytes: number; links: number; other: number };
  hasVersion: boolean;
  hasLoad: boolean;
  dropins: string[];
  muPlugins: string[];
  badPath: string | null;
}

function tallySiteEntry(t: Tally, name: Buffer, kind: 'file' | 'dir' | 'link' | 'other', size: number): void {
  if (kind === 'link') {
    t.files.links++;
    return;
  }
  if (kind === 'other') {
    t.files.other++;
    return;
  }
  if (!t.badPath) {
    const problem = entryProblem(name, kind);
    if (problem) t.badPath = `${name.toString('utf8')} (${problem})`;
  }
  if (kind === 'dir') return;
  t.files.count++;
  t.files.bytes += size;
  const n = name.toString('latin1');
  if (n === 'wp-includes/version.php') t.hasVersion = true;
  else if (n === 'wp-load.php') t.hasLoad = true;
  else if (/^wp-content\/[^/]+\.php$/.test(n) && isDropin(n.slice('wp-content/'.length))) t.dropins.push(n.slice('wp-content/'.length));
  else if (/^wp-content\/mu-plugins\/[^/]+\.php$/.test(n)) {
    const file = n.slice('wp-content/mu-plugins/'.length);
    if (MU_PLUGIN_FILE_RE.test(file)) t.muPlugins.push(file);
  }
}

const newTally = (): Tally => ({ files: { count: 0, bytes: 0, links: 0, other: 0 }, hasVersion: false, hasLoad: false, dropins: [], muPlugins: [], badPath: null });

async function listZip(zip: ZipReader, bytes: number): Promise<PackageContents> {
  const filter = siteFileFilter('');
  const found: InstallerFiles = { config: [], dumps: new Map(), original: new Map() };
  const tally = newTally();
  let encrypted = false;
  for await (const entry of zip.entries()) {
    if (entry.encrypted) encrypted = true;
    const verdict = filter(entry.name);
    if (verdict === 'installer') {
      if (entry.kind === 'file') noteInstallerFile(found, entry.name.toString('latin1'), { format: 'zip', entry }, entry.size);
      continue;
    }
    if (verdict === 'skip') continue;
    tallySiteEntry(tally, entry.name, entry.kind, entry.size);
  }
  return finish('zip', bytes, found, tally, encrypted, (ref, max) => zip.readAll((ref as { entry: ZipEntry }).entry, max));
}

async function listDaf(daf: DafReader, bytes: number): Promise<PackageContents> {
  const filter = siteFileFilter('');
  const found: InstallerFiles = { config: [], dumps: new Map(), original: new Map() };
  const tally = newTally();
  if (!daf.info.encrypted) {
    await daf.walk({
      onEntry: async (entry: DafEntry) => {
        const verdict = filter(entry.name);
        if (verdict === 'installer') {
          if (entry.kind === 'file') noteInstallerFile(found, entry.name.toString('latin1'), { format: 'daf', offset: entry.offset, size: entry.size }, entry.size);
          return null;
        }
        if (verdict === 'keep') tallySiteEntry(tally, entry.name, entry.kind, entry.size);
        return null;
      },
    });
  }
  return finish('daf', bytes, found, tally, daf.info.encrypted, (ref, max) => daf.readAllAt((ref as { offset: number }).offset, max));
}

async function finish(
  format: PackageFormat,
  bytes: number,
  found: InstallerFiles,
  tally: Tally,
  encrypted: boolean,
  readAll: (ref: PackageEntryRef, max: number) => Promise<Buffer>,
): Promise<PackageContents> {
  let descriptor: Descriptor | null = null;
  let descriptorProblem: string | null = null;
  if (encrypted) {
    descriptorProblem = 'encrypted';
  } else if (found.config.length === 0) {
    descriptorProblem = 'missing';
  } else if (found.config.length > 1) {
    descriptorProblem = 'several';
  } else {
    try {
      const raw = JSON.parse((await readAll(found.config[0]!.ref, MAX_CONFIG_BYTES)).toString('utf8')) as unknown;
      const parsed = descriptorSchema.safeParse(withoutClassMarks(raw));
      if (parsed.success) descriptor = parsed.data;
      else descriptorProblem = 'unreadable';
    } catch {
      descriptorProblem = 'unreadable';
    }
  }
  // The dump's files, in the order they load: as archive.txt lists them (5.x writes one per table,
  // after the schema), else by name, else the single dump of Duplicator 1.x.
  const dumps: PackageDumpFile[] = [];
  const configDir = found.config[0] ? CONFIG_NEW_RE.exec(found.config[0].name)?.[1] : undefined;
  const all = [...found.dumps.values()];
  const listed = descriptor?.dbInfo.dumpFiles ?? [];
  const inDir = (n: string) => (configDir ? n.startsWith(`${INSTALLER_DIR}${configDir}/db_dumps/`) : DUMP_OLD_RE.test(n));
  if (listed.length > 0 && configDir) {
    for (const name of listed) {
      const base = path.posix.basename(name);
      const hit = found.dumps.get(`${INSTALLER_DIR}${configDir}/db_dumps/${base}.gz`) ?? found.dumps.get(`${INSTALLER_DIR}${configDir}/db_dumps/${base}`);
      if (!hit) {
        dumps.length = 0;
        descriptorProblem ??= 'dump-missing';
        break;
      }
      dumps.push({ name: hit.name, gzip: hit.name.endsWith('.gz'), bytes: hit.bytes, ref: hit.ref });
    }
  } else {
    for (const hit of all.filter((d) => inDir(d.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      dumps.push({ name: hit.name, gzip: hit.name.endsWith('.gz'), bytes: hit.bytes, ref: hit.ref });
    }
  }
  return {
    format,
    bytes,
    descriptor,
    descriptorProblem,
    dumps,
    original: {
      htaccess: found.original.get('htaccess') ?? null,
      userIni: found.original.get('userini') ?? null,
      phpIni: found.original.has('phpini'),
      wpConfig: found.original.get('wpconfig') ?? null,
    },
    encrypted,
    files: tally.files,
    hasCore: tally.hasVersion && tally.hasLoad,
    dropins: [...new Set(tally.dropins)],
    muPlugins: [...new Set(tally.muPlugins)],
    badPath: tally.badPath,
  };
}

/**
 * The character set the dump's bytes are in. Duplicator writes no SET NAMES: its PHP dump reads
 * through WordPress's connection, whose set DB_CHARSET names, and so does its mysqldump since 5.0.0
 * (--default-character-set). Before that mysqldump ran in its own default, UTF-8, whatever the
 * site's set. Null for one the panel cannot load; utf8mb4 when the old site set none, the default
 * of servers today.
 */
export function packageCharset(contents: PackageContents): string | null {
  if (charsetFromMysqldump(contents)) return 'utf8mb4';
  const value = contents.descriptor?.wpInfo.configs.defines['DB_CHARSET']?.value;
  return typeof value === 'string' && value.trim() !== '' ? dumpCharset(value) : 'utf8mb4';
}

/**
 * A dump Duplicator's mysqldump wrote before 5.0.0, in the character set of the old host's mysqldump:
 * UTF-8 unless that host set another. What it is, its bytes say (handlers/sitePackage.ts).
 */
export function charsetFromMysqldump(contents: PackageContents): boolean {
  const d = contents.descriptor;
  return d !== null && d.dbInfo.buildMode === 'MYSQLDUMP' && !versionAtLeast(d.version_dup, [5, 0, 0]);
}

function versionAtLeast(version: string, least: number[]): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < least.length; i++) {
    if ((parts[i] ?? 0) !== least[i]) return (parts[i] ?? 0) > least[i]!;
  }
  return true;
}

/**
 * What a dump from charsetFromMysqldump is in when its bytes are not UTF-8: the old site's own
 * DB_CHARSET when that is not UTF-8, else latin1, mysqldump's other usual setting. Null for a set
 * the panel cannot load.
 */
export function notUtf8Charset(contents: PackageContents): string | null {
  const setting = charsetSetting(contents);
  const set = setting === '' ? 'utf8mb4' : dumpCharset(setting);
  return set === 'utf8mb4' ? 'latin1' : set;
}

/** The old site's DB_CHARSET, as it said it: '' for none. */
function charsetSetting(contents: PackageContents): string {
  const value = contents.descriptor?.wpInfo.configs.defines['DB_CHARSET']?.value;
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------- the plugin's own records

/**
 * What Duplicator's installer does to the Duplicator plugin's own records on the new site, done by
 * the panel instead (DbCleanup and duplicatorMigrationInfoSet in its dup-installer). The dump comes
 * from the middle of the package's build: without this the plugin finds that build still exporting
 * the database, the old site's other backups listed with no files, and settings it cannot decrypt.
 */
export interface DuplicatorAfterInstall {
  /** The plugin's tables to empty, after the site's prefix: the old site's backups and their activity log. */
  tables: string[];
  /** The plugin's options to delete. */
  options: string[];
  /** What the plugin reads at the first administrator login to finish the move, as its installer writes it. */
  firstLogin: { option: string; dataOption: string; data: Record<string, unknown>; timeField: 'installTime' | 'time' };
  /** The wp-config.php constants the plugin encrypts its settings with, in the order it reads them. */
  keyNames: string[];
}

/**
 * The plugin's records by the version that made the package: 5.x renamed its options and tables.
 * Null for Duplicator Pro, whose names the panel has not read, and a package that gives no version.
 */
export function duplicatorAfterInstall(contents: PackageContents): DuplicatorAfterInstall | null {
  const d = contents.descriptor;
  if (!d || d.version_dup === '' || (d.dup_type !== '' && d.dup_type.toLowerCase() !== 'lite')) return null;
  const v5 = versionAtLeast(d.version_dup, [5, 0, 0]);
  // As the installer fills it for a new single site from its own archive, with no installer
  // files on the site to clean up: they never reach it.
  const common = {
    installerVersion: d.version_dup,
    installType: -1,
    logicModes: ['CLASSIC'],
    template: 'base',
    restoreBackupMode: false,
    recoveryMode: false,
    archivePath: '',
    ...(v5 ? { packageId: d.packInfo.packageId } : {}),
    packageHash: d.packInfo.packageHash,
    installerPath: '',
    installerBootLog: '',
    installerLog: '',
    dupInstallerPath: '',
    origFileFolderPath: '',
    safeMode: 0,
    cleanInstallerFiles: true,
    licenseType: d.license_type,
    phpVersion: d.version_php,
    archiveType: contents.format === 'zip' ? 'zip' : 'dup',
    siteSize: d.fileInfo.size,
    siteNumFiles: d.fileInfo.dirCount + d.fileInfo.fileCount,
    siteDbSize: d.dbInfo.tablesSizeOnDisk,
    siteDBNumTables: d.dbInfo.tablesFinalCount,
    components: d.components,
    ustatIdentifier: '',
  };
  return v5
    ? {
        tables: ['duplicator_backups', 'duplicator_activity_logs'],
        options: [...new Set(['dupli_opt_plugin_data_stats', 'dupli_opt_unique_id', ...d.opts_delete])],
        // 5.x's MigrateData says dup-pro whichever plugin wrote it.
        firstLogin: { option: 'dupli_opt_first_login_after_install', dataOption: 'dupli_opt_migration_data', data: { plugin: 'dup-pro', ...common, extra: [] }, timeField: 'installTime' },
        keyNames: ['DUPLICATOR_AUTH_KEY', 'DUP_SECURE_KEY'],
      }
    : {
        tables: ['duplicator_packages'],
        options: [...new Set(['duplicator_plugin_data_stats', ...d.opts_delete])],
        firstLogin: { option: 'duplicator_first_login_after_install', dataOption: 'duplicator_migration_data', data: { plugin: 'dup-lite', ...common }, timeField: 'time' },
        keyNames: [],
      };
}

/** What 5.x works its key out from when wp-config.php defines none (CryptBlowfish::getLegacyKey). */
const LEGACY_KEY_PARTS = ['AUTH_KEY', 'DB_HOST', 'DB_NAME', 'DB_USER'] as const;

/**
 * The Duplicator plugin's key in an old wp-config.php, as the plugin finds it (CryptBlowfish::
 * getDefaultKey): the first of `names` it defines with a plain string. With none, and `names` 5.x's,
 * the key the plugin worked out from the old site's salt and database settings - what a site that has
 * had Duplicator since 1.x still uses, as only a new install writes a key - for DUPLICATOR_AUTH_KEY to
 * keep: a new site has other settings. Null when it cannot be told, and for one the environment
 * cannot carry (a NUL) or that was not UTF-8.
 */
export function duplicatorKeyIn(wpConfig: string, names: readonly string[]): { name: string; value: string; workedOut: boolean } | null {
  const defines = phpStringDefines(wpConfig, [...names, ...LEGACY_KEY_PARTS]);
  const usable = (v: string | undefined): v is string => v !== undefined && !/[\0\uFFFD]/.test(v);
  for (const name of names) {
    const value = defines.get(name);
    if (value && usable(value)) return { name, value, workedOut: false };
  }
  if (!names.includes('DUPLICATOR_AUTH_KEY')) return null;
  const parts = LEGACY_KEY_PARTS.map((name) => defines.get(name));
  if (!parts.every(usable)) return null;
  return { name: 'DUPLICATOR_AUTH_KEY', value: createHash('md5').update(parts.join(''), 'utf8').digest('hex'), workedOut: true };
}

// ---------------------------------------------------------------------- the report

const WORDPRESS_RULES_RE = /^\s*# BEGIN WordPress[\s\S]*# END WordPress\s*$/;

/** The package as the import's plugin would have reported the old site. */
export function packageReport(contents: PackageContents, htaccess: string | null): MigrateReport | null {
  const d = contents.descriptor;
  if (!d) return null;
  const rv = d.wpInfo.configs.realValues;
  const plugins: MigrateReport['plugins'] = [];
  const dropins = new Set(contents.dropins);
  const muPlugins = new Map(contents.muPlugins.map((f) => [f, '']));
  for (const [file, p] of Object.entries(d.wpInfo.plugins)) {
    if (p.dropIns) {
      if (isDropin(file)) dropins.add(file);
      continue;
    }
    if (p.mustUse) {
      if (MU_PLUGIN_FILE_RE.test(file)) muPlugins.set(file, p.name);
      continue;
    }
    plugins.push({ file, slug: pluginSlug(file), name: p.name, version: p.version, active: p.active });
  }
  const active = Object.entries(d.wpInfo.themes).find(([, t]) => t.isActive);
  const collation = d.dbInfo.collationList.find((c) => /_0900_/.test(c));
  const constants = Object.entries(d.wpInfo.configs.defines)
    .map(([name, raw]) => constantOf(name, raw))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const draft = {
    protocol: 1,
    plugin: `duplicator ${d.version_dup}`.trim(),
    endpoint: '',
    home: rv.homeUrl,
    siteurl: rv.siteUrl,
    abspath: rv.originalPaths.abs,
    content_dir: rv.originalPaths.wpcontent,
    uploads_dir: rv.originalPaths.uploads,
    multisite: d.wpInfo.is_multisite || d.mu_mode > 0,
    windows: /^win/i.test(d.version_os),
    table_prefix: d.wp_tableprefix,
    wp: d.version_wp,
    php: d.version_php,
    locale: 'en_US',
    ...(collation ? { collation } : {}),
    blog_public: 1,
    title: d.blogname,
    https: rv.homeUrl.startsWith('https://'),
    db: {
      server: d.dbInfo.version,
      bytes: d.dbInfo.tablesSizeOnDisk,
      tables: Object.entries(d.dbInfo.tablesList).map(([name, t]) => ({ name, rows: t.insertedRows, bytes: t.size, pk: null })),
      views: d.dbInfo.viewCount,
      triggers: d.dbInfo.triggerList.length,
      routines: d.dbInfo.procCount + d.dbInfo.funcCount,
    },
    files: { count: contents.files.count, bytes: contents.files.bytes, links: contents.files.links, unreadable: 0, excluded: [], partial: false },
    constants,
    dropins: [...dropins],
    mu_plugins: [...muPlugins].map(([file, name]) => ({ file, name })),
    plugins,
    theme: active ? { slug: active[0], name: active[1].themeName, version: active[1].version } : null,
    htaccess: { present: htaccess !== null, custom: htaccess !== null && !WORDPRESS_RULES_RE.test(htaccess) },
    user_ini: contents.original.userIni !== null,
    php_ini: contents.original.phpIni,
    warnings: [],
  };
  const parsed = migrateReportSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

/** What only a package can have wrong, before the import's own checks. */
function packageWarnings(contents: PackageContents, report: MigrateReport | null): ImportWarning[] {
  const out: ImportWarning[] = [];
  const block = (code: string, message: string) => out.push({ code, blocking: true, message });
  const warn = (code: string, message: string) => out.push({ code, blocking: false, message });
  const d = contents.descriptor;
  switch (contents.descriptorProblem) {
    case 'encrypted':
      block('encrypted', 'The package is encrypted. Build it again with Security set to No protection or Installer password.');
      return out;
    case 'missing':
      block('no-config', 'The package has no archive.txt in its dup-installer folder. Upload the archive Duplicator made, as it is.');
      return out;
    case 'several':
      block('no-config', 'The package holds more than one archive.txt.');
      return out;
    case 'unreadable':
      block('no-config', 'The package\'s archive.txt cannot be read.');
      return out;
    case 'dump-missing':
      block('no-dump', 'A database file that archive.txt lists is missing from the package.');
      break;
  }
  if (!d) return out;
  if (d.exportOnlyDB) block('db-only', 'The package holds the database only. Build one with the files as well.');
  else if (!contents.hasCore) block('no-core', 'The package holds no WordPress files. Build it with the WordPress core included.');
  if (contents.dumps.length === 0 && contents.descriptorProblem !== 'dump-missing') block('no-dump', 'The package holds no database.');
  if (contents.badPath) block('unsafe-path', `The package holds ${contents.badPath}, a path the panel does not write.`);
  if (!report) block('no-config', 'The package\'s archive.txt does not describe a site the panel can read.');
  const left = [
    ['package_component_plugins', 'plugins'],
    ['package_component_themes', 'themes'],
    ['package_component_uploads', 'uploads'],
  ].filter(([c]) => d.components.length > 0 && !d.components.includes(c!));
  if (left.length > 0) warn('partial', `The package leaves out the ${left.map(([, n]) => n).join(' and ')}.`);
  if (!TABLE_PREFIX_RE.test(d.wp_tableprefix)) block('table-prefix', `The table prefix "${d.wp_tableprefix}" is not one the panel can use.`);
  const charset = charsetSetting(contents);
  if (packageCharset(contents) === null) {
    block('charset', `The old site's database uses the ${charset.slice(0, 40)} character set, which the panel cannot load. Convert it to utf8mb4 on the old host, then build the package again.`);
  } else if (charset === '' && !charsetFromMysqldump(contents)) {
    warn('charset', "The old wp-config.php sets no DB_CHARSET, so the database is read as utf8mb4.");
  }
  const triggers = packageTriggers(contents);
  const leftOut = triggers.filter((t) => t.problems.length > 0);
  const added = triggers.filter((t) => t.problems.length === 0);
  if (leftOut.length > 0) {
    const one = leftOut.length === 1;
    warn(
      'triggers',
      `Left out: ${leftOut.map((t) => `the trigger ${t.name}, which ${t.problems.join(', and ')}`).join('; ')}. ` +
        `${one ? 'Its definition is' : 'Their definitions are'} in the package's archive.txt.`,
    );
  }
  if (added.length > 0) {
    const one = added.length === 1;
    warn(
      'triggers-mode',
      `${one ? `The trigger ${added[0]!.name} is` : `The triggers ${added.map((t) => t.name).join(', ')} are`} added if the site has all ${one ? 'it names' : 'they name'}. ` +
        `${one ? 'It runs' : 'They run'} in WordPress's SQL mode: Duplicator does not record the one ${one ? 'it was' : 'they were'} made with.`,
    );
  }
  // WP_PLUGIN_DIR and the like are the old host's paths, never carried: WordPress would look in wp-content.
  const paths = d.wpInfo.configs.realValues.originalPaths;
  const content = paths.wpcontent.replace(/\/+$/, '');
  for (const [where, folder, code, what] of [
    [paths.plugins, 'plugins', 'plugins-dir', 'Plugins'],
    [paths.muplugins, 'mu-plugins', 'mu-plugins-dir', 'Must-use plugins'],
    [paths.themes, 'themes', 'themes-dir', 'Themes'],
  ] as const) {
    const at = where.replace(/\/+$/, '');
    if (at !== '' && at !== `${content}/${folder}`) block(code, `${what} are in ${at}, not in wp-content/${folder}.`);
  }
  return out;
}

/**
 * The old database's triggers, which Duplicator keeps out of its dumps, each with why it cannot be
 * added (packageTriggers.ts): to `site`, what the site's database has once it is loaded; without
 * it, what is wrong whatever it holds, the package's tables known and its views not.
 */
export function packageTriggers(contents: PackageContents, site?: SiteNames): { name: string; create: string; problems: string[] }[] {
  const d = contents.descriptor;
  if (!d) return [];
  const tables = new Set(Object.keys(d.dbInfo.tablesList));
  return d.dbInfo.triggerList.map((t) => ({
    ...t,
    problems: t.create.trim() === '' ? ['has no definition in archive.txt'] : site ? checkTrigger(t.create, site) : inspectTrigger(t.create, tables),
  }));
}

/**
 * The import's warnings that are about pulling from a live site, or about what a package does not
 * say: none of them is true of a package. Its tables all load, whatever their prefix.
 */
const NOT_FOR_PACKAGES = new Set(['no-primary-key', 'large', 'http-only', 'partial-count', 'foreign-tables', 'views-triggers', 'unreadable']);

export interface PackageInspection {
  contents: PackageContents;
  report: MigrateReport | null;
  dto: PackageInspectionDto;
}

/** Everything the New site form shows about a package, and what a create is checked against. */
export async function inspectPackage(pkg: OpenPackage, uploadId: string, offeredPhp: string[]): Promise<PackageInspection> {
  const c = pkg.contents;
  let htaccess: string | null = null;
  if (c.original.htaccess) {
    htaccess = (await pkg.readAll(c.original.htaccess, MAX_ORIGINAL_BYTES).catch(() => null))?.toString('utf8') ?? null;
  }
  const report = packageReport(c, htaccess);
  const own = packageWarnings(c, report);
  const inspected = report ? inspectReport(report, { offeredPhp, allowHttp: false }) : null;
  // Uploads elsewhere in the site's folder go there again where the old wp-config.php's UPLOADS comes along.
  const carriesUploads = inspected?.constants.some((k) => k.name === 'UPLOADS') ?? false;
  const warnings = [
    ...own,
    ...(inspected?.warnings ?? []).filter(
      (w) => !NOT_FOR_PACKAGES.has(w.code) && !own.some((o) => o.code === w.code) && !(carriesUploads && w.code === 'uploads-dir' && !w.blocking),
    ),
  ];
  const d = c.descriptor;
  return {
    contents: c,
    report,
    dto: {
      uploadId,
      format: c.format,
      bytes: c.bytes,
      duplicator: d?.version_dup ?? null,
      created: d?.created || null,
      report: report ? packageSource(report) : null,
      dumpFiles: c.dumps.length,
      warnings,
      blockedReason: blockingReason(warnings),
      suggestions: inspected?.suggestions ?? null,
      constants: inspected?.constants ?? [],
    },
  };
}

/** The old site as the form shows it: a package does not say its language or search engine setting. */
function packageSource(report: MigrateReport): PackageSourceDto {
  const { locale, searchEnginesAllowed, pluginVersion, ...source } = sourceOf(report);
  return source;
}

/** The choices of a create, checked against the package as checkChoices checks an import's. */
export function checkPackageChoices(inspection: PackageInspection, choices: ImportRunBody): string | null {
  if (!inspection.report) return inspection.dto.blockedReason ?? 'The package cannot be read.';
  return checkChoices(inspection.report, choices, inspection.dto.constants);
}

// ---------------------------------------------------------------------- uploads

/** Uploaded packages, on the panel's own disk until a create unpacks one or the day is over. */
export class PackageUploads {
  /** Uploads a create holds: no chunk may land in one, and nobody may delete it. */
  private readonly claimed = new Set<string>();
  /** Uploads with a chunk being written: no create may take one then, nor a delete. */
  private readonly writing = new Set<string>();
  /** Uploads being deleted: no create may take one, nor a chunk land in it. */
  private readonly removing = new Set<string>();
  /** Inspections, by upload and the file's size and time: a package is read once. */
  private readonly cache = new Map<string, { key: string; inspection: Promise<UploadInspection> }>();

  constructor(
    private readonly config: Config,
    /** The PHP versions the panel offers: what a package's PHP is suggested from. */
    private readonly offeredPhp: () => string[],
  ) {}

  dir(): string {
    return path.join(this.config.paths.panel, 'package-uploads');
  }

  path(id: string): string {
    if (!UPLOAD_ID_RE.test(id)) throw notFound('No such upload');
    return path.join(this.dir(), `${id}.pkg`);
  }

  /**
   * A create's hold on its upload. `stamp`, from the inspection the create was checked against:
   * the file has to be the one that was read, there still.
   */
  claim(id: string, stamp?: string): void {
    if (this.claimed.has(id)) throw conflict('That package is being unpacked already.');
    if (this.writing.has(id)) throw conflict('That package is still going up.');
    if (this.removing.has(id)) throw notFound('No such upload: send the package first.');
    if (stamp !== undefined) {
      const stat = fs.statSync(this.path(id), { throwIfNoEntry: false });
      if (!stat?.isFile()) throw notFound('No such upload: send the package first.');
      if (stampOf(stat) !== stamp) throw conflict('The package changed while it was being read. Try again.');
    }
    this.claimed.add(id);
  }

  release(id: string): void {
    this.claimed.delete(id);
  }

  /** The job's own hold on its upload: taken again after a restart, which forgets the create's. */
  hold(id: string): void {
    this.claimed.add(id);
  }

  assertFree(id: string): void {
    if (this.claimed.has(id)) throw conflict('That package is being unpacked: it can no longer change.');
    if (this.writing.has(id)) throw conflict('A chunk of that package is still being written.');
  }

  /** A chunk's hold on its upload while it is written: one at a time (429, to retry), and none once a create holds it. */
  beginWrite(id: string): void {
    if (this.claimed.has(id)) throw conflict('That package is being unpacked: it can no longer change.');
    if (this.writing.has(id) || this.removing.has(id)) throw tooManyRequests('A chunk of that package is still being written; retry in a moment.');
    this.writing.add(id);
  }

  endWrite(id: string): void {
    this.writing.delete(id);
  }

  /**
   * The package, read and inspected, with the stamp of the file that was read (claim). A damaged
   * archive is a PackageError, in the reader's words.
   */
  async inspect(id: string): Promise<UploadInspection> {
    const file = this.path(id);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw notFound('No such upload: send the package first.');
    const offeredPhp = this.offeredPhp();
    const stamp = stampOf(stat);
    const key = `${stamp}:${offeredPhp.join(',')}`;
    const hit = this.cache.get(id);
    if (hit?.key === key) return hit.inspection;
    const inspection = (async () => {
      const pkg = await OpenPackage.open(file).catch((err: unknown) => {
        throw asPackageError(err);
      });
      try {
        return { ...(await inspectPackage(pkg, id, offeredPhp)), stamp };
      } catch (err) {
        throw asPackageError(err);
      } finally {
        await pkg.close();
      }
    })();
    this.cache.set(id, { key, inspection });
    inspection.catch(() => this.cache.delete(id));
    // A few at a time: the oldest goes.
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
    return inspection;
  }

  async remove(id: string): Promise<void> {
    const file = this.path(id);
    this.cache.delete(id);
    this.removing.add(id);
    try {
      await fsp.rm(file, { force: true });
    } finally {
      this.removing.delete(id);
    }
  }

  /** Uploads no create took within a day of their last chunk. */
  async removeStale(now = Date.now()): Promise<number> {
    const names = await fsp.readdir(this.dir()).catch(() => [] as string[]);
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.pkg')) continue;
      const id = name.slice(0, -'.pkg'.length);
      if (this.claimed.has(id) || this.writing.has(id)) continue;
      const file = path.join(this.dir(), name);
      const stat = await fsp.stat(file).catch(() => null);
      // Asked again after the wait: a create or a chunk may have taken it meanwhile.
      if (!stat || now - stat.mtimeMs <= PACKAGE_UPLOAD_KEEP_MS || this.claimed.has(id) || this.writing.has(id) || !UPLOAD_ID_RE.test(id)) continue;
      await this.remove(id);
      n++;
    }
    return n;
  }
}

/** An uploaded package's inspection, with which file it read: its size and time. */
export type UploadInspection = PackageInspection & { stamp: string };

const stampOf = (stat: { size: number; mtimeMs: number }) => `${stat.size}:${stat.mtimeMs}`;

const asPackageError = (err: unknown): unknown => (err instanceof ZipFormatError || err instanceof DafFormatError ? new PackageError(err.message) : err);
