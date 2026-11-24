// @docs sites/duplicator
/**
 * site.create for a site made from a Duplicator package (services/duplicator.ts): an import's
 * set-up, with the package for the old site.
 *
 * The package is read on the panel and its files go to the target server as a tar stream into
 * `tar -x`, through the same checks as an import's pull (lib/archivePath.ts): no links, no path
 * outside the folder, plain permissions. Its database files go through PackageDumpFilter into one
 * `db.sql.gz` beside them. From that staging folder the site comes up as an import's does
 * (restoreSiteOnServer, `tree`): the database made and loaded as the site's own user, the panel's
 * wp-config.php written by the image, the old address replaced with the new one, what of the old
 * host the admin chose left behind. The installer the package came with is never extracted.
 */
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { localeSchema, type ImportRunBody } from '../../../shared/schemas.js';
import { sites, type SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { constantHere, constantLiteral, type MigrateReport } from '../../services/importInspect.js';
import {
  MAX_ORIGINAL_BYTES,
  OpenPackage,
  charsetFromMysqldump,
  checkPackageChoices,
  notUtf8Charset,
  packageCharset,
  packageTriggers,
  type PackageContents,
  type PackageDumpFile,
  type PackageEntryRef,
} from '../../services/duplicator.js';
import { PackageDumpFilter, packageDumpPreamble } from '../../services/packageDump.js';
import type { SiteNames } from '../../services/packageTriggers.js';
import { sitePaths } from '../../services/siteSpec.js';
import { restoreSiteOnServer, type ProtectionHold } from './restoreSite.js';
import { WORDPRESS_HTACCESS, bytesText, extractInto, fixWordPress, leaveBehind, makeRoomForStatements } from './import.js';
import { dnsPreflight, probeSite, siteDomains, siteUrl, updateSiteRow, waitForWordPressFiles, writeSiteJson } from './shared.js';
import { ensureDevDnsRecord, ensureSiteImage, publishWordPress, type siteCreatePayload } from './sites.js';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MIB = 1024 * 1024;
/** A progress line every this many bytes or files. */
const LOG_BYTES = 256 * MIB;
const LOG_FILES = 5000;
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

export async function createSiteFromPackage(ctx: JobContext<z.infer<typeof siteCreatePayload>>, s: CoreServices, site: SiteRow): Promise<void> {
  const input = ctx.payload.package!;
  const server = s.servers.handleFor(site.serverId);
  const domains = siteDomains(site);
  const primary = domains[0]!;
  const url = siteUrl(s.config, primary);
  const paths = sitePaths(s.config, site.slug);
  // Beside an import's: the same filesystem as the site's folder, so the files move in one rename.
  const staging = path.join(s.config.srvRoot, 'wpl7-import', `package-${site.id}`);
  const wordpressDir = path.join(staging, 'wordpress');
  const dbSqlGz = path.join(staging, 'db.sql.gz');
  const protection: ProtectionHold = { release: null };
  const choices: ImportRunBody = {
    title: site.title,
    slug: site.slug,
    carryConstants: input.carryConstants,
    deactivatePlugins: input.deactivatePlugins,
    removeDropins: input.removeDropins,
    removeMuPlugins: input.removeMuPlugins,
    rewritePaths: input.rewritePaths,
  };
  // Held again after a restart, which forgets the hold the create took.
  s.packages.hold(input.uploadId);
  try {
    ctx.info(`Creating site "${site.slug}" at ${url} on server "${server.name}" from a Duplicator package`);
    const file = s.packages.path(input.uploadId);
    if (!(await fsp.stat(file).catch(() => null))) {
      throw new Error('The package is not on the panel any more: an upload is kept a day. Upload it again.');
    }
    // As the form showed it, read once: the job opens the package on what that found.
    const inspection = await s.packages.inspect(input.uploadId);
    if (inspection.dto.blockedReason || !inspection.report) throw new Error(inspection.dto.blockedReason ?? 'The package cannot be read.');
    const problem = checkPackageChoices(inspection, choices);
    if (problem) throw new Error(problem);
    const report = inspection.report;
    if (report.table_prefix !== site.tablePrefix) throw new Error(`The package's table prefix is ${report.table_prefix}, the site's ${site.tablePrefix}`);
    const c = inspection.contents;
    ctx.info(
      `The package: ${c.format === 'zip' ? 'a .zip' : 'a .daf'} of ${bytesText(c.bytes)} made by Duplicator ${inspection.dto.duplicator ?? '(version not given)'}, ` +
        `from ${report.home}: WordPress ${report.wp}, PHP ${report.php}, table prefix ${report.table_prefix}.`,
    );

    // ------------------------------------------------------------ preflight
    const need = (c.files.bytes + report.db.bytes) * 2.5;
    const disk = await server.files.statvfs(s.config.srvRoot).catch(() => null);
    if (disk && disk.freeBytes < need) {
      throw new Error(`Not enough free disk on "${server.name}": ${bytesText(disk.freeBytes)} free, about ${bytesText(need)} needed.`);
    }
    if (!disk) ctx.warn(`Could not read the free disk space on "${server.name}"; going on.`);
    await ensureDevDnsRecord(ctx, s, server, site.devHostname);
    await dnsPreflight(s.config, server.row, domains, ctx);
    // Before anything is unpacked: an image the server cannot get fails the create first.
    await ensureSiteImage(ctx, server, s.config, site.phpVersion);
    await server.files.mkdirp(s.config.paths.plugins);
    ctx.checkCanceled();

    // ------------------------------------------------------------ the package, unpacked
    ctx.pushCompensation('remove the unpacked package', async () => {
      await server.files.rm(staging);
    });
    await server.files.rm(staging);
    await server.files.mkdirp(staging, { mode: 0o700 });
    await server.files.mkdirp(wordpressDir, { mode: 0o755 });
    let db: UnpackedDatabase;
    const pkg = await OpenPackage.open(file, c);
    try {
      // The database first: smaller than the files, and where a package fails most.
      db = await unpackDatabase(ctx, server, pkg, c, report, dbSqlGz);
      ctx.checkCanceled();
      await unpackFiles(ctx, server, pkg, c, wordpressDir);
      ctx.checkCanceled();
    } finally {
      await pkg.close();
    }

    // ------------------------------------------------------------ what stays behind
    await leaveBehind(ctx, server, wordpressDir, choices);
    ctx.checkCanceled();

    // ------------------------------------------------------------ the site, unrouted
    await makeRoomForStatements(ctx, server, db.longest);
    try {
      await restoreSiteOnServer(ctx, s, server, site, domains, { kind: 'tree', wordpressDir, dbSqlGz }, {
        routing: false,
        requireWpConfig: false,
        protection,
        probe: null,
      });
    } catch (err) {
      // Rows load without IGNORE: two that the old server told apart and this one does not stop the load.
      if (err instanceof Error && /\bDuplicate entry\b/.test(err.message)) {
        throw new Error(
          `${err.message.replace(/\.?\s*$/, '.')} Two rows of the old database count as the same here` +
            `${db.collationsChanged ? ', as MariaDB tells apart fewer characters than MySQL 8' : ''}. Change one of them on the old site, then build the package again.`,
        );
      }
      throw err;
    }
    // The image writes wp-config.php from the container's settings at its first start.
    ctx.info('Waiting for WordPress to write its wp-config.php…');
    await waitForWordPressFiles(server.files, paths.wordpress, ctx);
    // -h: the site's own folder, so a link there is changed itself, never what it points at.
    await server.exec.run('chown', ['-h', '33:33', path.join(paths.wordpress, 'wp-config.php')]).catch(() => undefined);
    ctx.checkCanceled();

    // ------------------------------------------------------------ WordPress
    const container = site.containerName;
    const carried = choices.carryConstants
      .map((name) => report.constants.find((c) => c.name === name))
      .filter((c): c is MigrateReport['constants'][number] => c !== undefined)
      .map((c) => constantHere(c, report));
    if (carried.length > 0) {
      ctx.info(`Carrying ${plural(carried.length, 'setting')} into wp-config.php…`);
      for (const constant of carried) {
        const literal = constantLiteral(constant);
        if (!literal) continue;
        try {
          await server.wp.configSet(container, constant.name, literal.value, { raw: literal.raw });
        } catch (err) {
          ctx.warn(`Could not set ${constant.name} (${errMsg(err)}).`);
        }
      }
    }
    const admin = await fixWordPress(ctx, s, server, site, report, choices, url, { discourageSearchEngines: ctx.payload.discourageSearchEngines });
    if (!ctx.payload.discourageSearchEngines) {
      // The old site's own setting came with its database: what the form said wins.
      try {
        await server.wp.optionUpdate(container, 'blog_public', '1', { skipExtensions: true });
      } catch (err) {
        ctx.warn(`Could not allow search engines (${errMsg(err)}); set it in Settings -> Reading.`);
      }
    }
    // Last of the database's changes: the address rewrite and the rest above would have fired them.
    await addTriggers(ctx, server, site, c, report, db.names, path.join(staging, 'triggers'));
    const locale = await siteLanguage(server, container);
    if (!locale) ctx.warn(`Could not read the site's language from WordPress, so the panel takes it to be ${site.locale}.`);
    ctx.checkCanceled();

    // ------------------------------------------------------------ publish
    await publishWordPress(ctx, s, server, site, domains);
    const up = await probeSite(server, container, primary, s.config.probeTimeoutMs);
    if (!up) ctx.warn('The site did not answer the smoke check yet; look at its Files tab (.htaccess) and container logs if it stays down.');

    updateSiteRow(s.db, site.id, { status: 'running', wpAdminUser: admin?.login ?? null, ...(locale ? { locale } : {}) });
    protection.release?.();
    protection.release = null;
    ctx.clearCompensations();
    await writeSiteJson(server, s, s.db.select().from(sites).where(eq(sites.id, site.id)).get()!).catch((err) =>
      ctx.warn(`Could not write site.json (${errMsg(err)}).`),
    );
    // While the create still holds it: once let go, another create could take it and lose it.
    await s.packages.remove(input.uploadId).catch((err) => ctx.warn(`Could not remove the uploaded package (${errMsg(err)}).`));
  } catch (err) {
    ctx.error(`Provisioning failed: ${errMsg(err)}`);
    const clean = await ctx.runCompensations();
    if (clean) {
      // Everything rolled back: the name is free again, and the upload is still there for another try.
      s.db.delete(sites).where(eq(sites.id, site.id)).run();
      await s.mail.syncMailAuthEverywhere().catch(() => undefined);
      ctx.info('All resources rolled back; site removed. The package stays for a day: Back to the form tries again.');
    } else {
      updateSiteRow(s.db, site.id, { status: 'error' });
      ctx.error('Some rollback steps failed - resolve via site Delete, which is safe to repeat.');
    }
    if (protection.release) {
      protection.release();
      await s.security.kick(server.id);
    }
    throw err;
  } finally {
    s.packages.release(input.uploadId);
  }

  // ------------------------------------------------------------ the site is up: the rest is best effort
  const made = s.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
  try {
    await s.wpInventory.scanSite(made, server, { log: (level, message) => ctx.log(level, message) });
  } catch (err) {
    ctx.warn(`Could not read the site's plugins and themes yet (${errMsg(err)}).`);
  }
  try {
    s.malwareScan.request(s.worker, made, 'import');
    ctx.info('Queued a malware scan.');
  } catch (err) {
    ctx.warn(`Could not queue a malware scan (${errMsg(err)}); start one from the site's Security tab.`);
  }
  try {
    s.monitor.busySlugs.add(made.slug);
    await s.backup.createOn(server, made, 'import', {
      note: 'made from a Duplicator package',
      jobId: ctx.jobId,
      log: (level, message) => ctx.log(level, message),
    });
  } catch (err) {
    ctx.warn(`The first backup failed (${errMsg(err)}); take one from the Backups tab.`);
  } finally {
    s.monitor.busySlugs.delete(made.slug);
  }
  await server.files.rm(staging).catch((err) => ctx.warn(`Could not remove the staging folder ${staging} (${errMsg(err)}).`));
  ctx.setResult({ url, slug: site.slug });
  ctx.info(`Site created: ${url}${ctx.payload.discourageSearchEngines ? '. Search engines stay discouraged until you go live' : ''}.`);
}

/** The site's files from the package, as a tar stream into `tar -x` in `dir` on the server. */
async function unpackFiles(ctx: JobContext<unknown>, server: ServerHandle, pkg: OpenPackage, c: PackageContents, dir: string): Promise<void> {
  ctx.info(`Unpacking ${plural(c.files.count, 'file')}, ${bytesText(c.files.bytes)}…`);
  const htaccess = await originalFile(ctx, pkg, c.original.htaccess, ".htaccess, so WordPress's standard one is written");
  const userIni = await originalFile(ctx, pkg, c.original.userIni, '.user.ini, so the site has none');
  let files = 0;
  let bytes = 0;
  const changed: string[] = [];
  let nextBytes = LOG_BYTES;
  let nextFiles = LOG_FILES;
  const now = Math.floor(Date.now() / 1000);
  await extractInto(server, dir, async (tar) => {
    await pkg.walkSite({
      onDir: (name, mtime) => tar.addDir({ name, mode: 0o755, mtime }),
      onFile: async (name, size, mtime, mode) => {
        ctx.checkCanceled();
        // Readable by the site, never setuid, never world-writable: what the import gives files too.
        await tar.beginFile({ name, mode: mode !== null && (mode & 0o111) !== 0 ? 0o755 : 0o644, mtime }, size);
        return async (chunk) => {
          // A big file is not sent to its end once the job is stopped.
          ctx.checkCanceled();
          bytes += chunk.length;
          await tar.writeFileData(chunk);
        };
      },
      onMismatch: (name) => changed.push(name.toString('utf8')),
      onFileEnd: async () => {
        if ((await tar.endFile()) > 0) throw new Error('A file in the package came up short');
        files++;
        if (bytes >= nextBytes || files >= nextFiles) {
          ctx.info(`… ${plural(files, 'file')}, ${bytesText(bytes)}`);
          while (nextBytes <= bytes) nextBytes += LOG_BYTES;
          while (nextFiles <= files) nextFiles += LOG_FILES;
        }
      },
    });
    // Duplicator keeps the site's own .htaccess and .user.ini apart from its files: back in place,
    // as an import brings them. What in them would hurt the site here is dealt with at the start.
    await tar.addFile({ name: '.htaccess', mode: 0o644, mtime: now }, htaccess ?? Buffer.from(WORDPRESS_HTACCESS));
    if (userIni) await tar.addFile({ name: '.user.ini', mode: 0o644, mtime: now }, userIni);
  });
  ctx.info(`Unpacked ${plural(files, 'file')}, ${bytesText(bytes)}.`);
  if (changed.length > 0) {
    // Duplicator's installer goes on too: a file that changed while the package was made, most likely.
    ctx.warn(
      `${plural(changed.length, 'file')} in the package ${changed.length === 1 ? 'differs' : 'differ'} from what Duplicator noted for ${changed.length === 1 ? 'it' : 'them'}, ` +
        `likely changed while the package was made: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}.`,
    );
  }
  if (!c.original.htaccess) ctx.info('Wrote WordPress’s standard .htaccess (the package has none).');
  if (c.files.links > 0) ctx.warn(`${plural(c.files.links, 'symbolic link')} in the package ${c.files.links === 1 ? 'was' : 'were'} not unpacked.`);
  if (c.files.other > 0) ctx.warn(`${plural(c.files.other, 'entry', 'entries')} in the package that ${c.files.other === 1 ? 'is' : 'are'} neither a file nor a folder ${c.files.other === 1 ? 'was' : 'were'} left out.`);
}

/** One of the old site's files Duplicator keeps apart; null, with a warning, when it cannot be read. */
async function originalFile(ctx: JobContext<unknown>, pkg: OpenPackage, ref: PackageEntryRef | null, what: string): Promise<Buffer | null> {
  if (!ref) return null;
  try {
    return await pkg.readAll(ref, MAX_ORIGINAL_BYTES);
  } catch (err) {
    ctx.warn(`Could not read the package's ${what} (${errMsg(err)}).`);
    return null;
  }
}

/** What the database's unpacking found: what restoring it and adding triggers go by. */
interface UnpackedDatabase {
  /** The longest statement, in bytes. */
  longest: number;
  /** What it creates: tables and views, their columns, routines. */
  names: SiteNames;
  collationsChanged: boolean;
}

/** A dump that was to be UTF-8 holds bytes that are not: it is read again in another set. */
class NotUtf8Error extends Error {}

/**
 * The package's database files, in the order they load, through PackageDumpFilter into one gzip
 * file on the server. Where the package does not say the dump's character set (Duplicator's
 * mysqldump before 5.0.0), it is taken to be UTF-8 while its bytes are, and read again in the other
 * set the old site's settings point to when they are not.
 */
async function unpackDatabase(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  pkg: OpenPackage,
  c: PackageContents,
  report: MigrateReport,
  dbSqlGz: string,
): Promise<UnpackedDatabase> {
  ctx.info(`Unpacking the database (${plural(c.dumps.length, 'file')})…`);
  const charset = packageCharset(c);
  if (!charset) throw new Error("The package's database is in a character set the panel cannot load.");
  if (!charsetFromMysqldump(c)) return writeDatabase(ctx, server, pkg, c, report, dbSqlGz, charset, false);
  try {
    return await writeDatabase(ctx, server, pkg, c, report, dbSqlGz, charset, true);
  } catch (err) {
    if (!(err instanceof NotUtf8Error)) throw err;
    const other = notUtf8Charset(c);
    if (!other) throw new Error("The package's database dump is not UTF-8, and the old site's DB_CHARSET names a set the panel cannot load.");
    ctx.warn(
      `The database dump is not UTF-8: Duplicator before 5.0.0 wrote it in the old host's mysqldump setting. Reading it as ${other} instead. ` +
        "If letters with accents look wrong on the site, build the package again with Duplicator's SQL Mode set to PHP Code (Settings → Packages).",
    );
    return writeDatabase(ctx, server, pkg, c, report, dbSqlGz, other, false);
  }
}

async function writeDatabase(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  pkg: OpenPackage,
  c: PackageContents,
  report: MigrateReport,
  dbSqlGz: string,
  charset: string,
  checkUtf8: boolean,
): Promise<UnpackedDatabase> {
  const filter = new PackageDumpFilter(report.table_prefix, charset);
  const gzip = zlib.createGzip();
  // Destroyed with the error that stopped the copy: what reads it hears of that, not this.
  gzip.on('error', () => undefined);
  const writing = server.exec.runWithInput('sh', ['-c', 'cat > "$1"', 'sh', dbSqlGz], gzip, { timeoutMs: 4 * 3600_000 });
  // Ends every wait for room, early or not: one signal for all of them, which keeps no handler per wait.
  const ended = new AbortController();
  writing.then(
    (res) => ended.abort(new Error(`Writing the database copy stopped: ${res.stderr.trim().slice(0, 300) || `exit ${res.exitCode}`}`)),
    (err: unknown) => ended.abort(err),
  );
  const out = async (buf: Buffer) => {
    if (buf.length === 0) return;
    ctx.checkCanceled();
    if (!gzip.write(buf)) await roomIn(gzip, ended.signal);
  };
  try {
    await out(Buffer.from(packageDumpPreamble(charset), 'latin1'));
    for (const dump of c.dumps) {
      ctx.checkCanceled();
      await pumpDump(pkg, dump, filter, out, checkUtf8 ? utf8Check() : null);
    }
    gzip.end();
    const res = await writing;
    if (res.exitCode !== 0) throw new Error(`Writing the database copy failed: ${res.stderr.trim().slice(0, 300)}`);
  } catch (err) {
    // With the error: the command on the server is stopped then, rather than left waiting for more.
    gzip.destroy(err instanceof Error ? err : new Error(String(err)));
    await writing.catch(() => undefined);
    throw err;
  }
  if (!filter.hasOptions) {
    throw new Error(`The package's database has no ${report.table_prefix}options table: WordPress would find no installation in it.`);
  }
  const test = await server.exec.run('gzip', ['-t', dbSqlGz], { timeoutMs: 10 * 60_000 });
  if (test.exitCode !== 0) throw new Error(`The database copy is damaged: ${test.stderr.trim().slice(0, 300)}`);
  if (filter.collationsChanged) ctx.warn('MySQL 8 collations were changed to their MariaDB equivalents.');
  if (filter.definersRemoved > 0) {
    ctx.info(`${plural(filter.definersRemoved, 'view, trigger or routine', 'views, triggers or routines')} will belong to the site's own database user.`);
  }
  if (filter.dropped > 0) ctx.info(`Left out ${plural(filter.dropped, 'statement')} that set the old database server itself (SET @@GLOBAL and the like).`);
  const size = (await server.files.stat(dbSqlGz))?.sizeBytes ?? 0;
  ctx.info(`Database unpacked: ${bytesText(size)} compressed.`);
  return {
    longest: filter.longest,
    names: { tables: filter.tables, columns: filter.columns, routines: filter.routines },
    collationsChanged: filter.collationsChanged,
  };
}

/** A check that a dump file's bytes are UTF-8, fed as they come: throws NotUtf8Error, `end` at the file's end. */
function utf8Check(): { chunk: (buf: Buffer) => void; end: () => void } {
  let decoder = new TextDecoder('utf-8', { fatal: true });
  const fail = () => {
    throw new NotUtf8Error('The database dump is not UTF-8');
  };
  return {
    chunk: (buf) => {
      try {
        decoder.decode(buf, { stream: true });
      } catch {
        fail();
      }
    },
    end: () => {
      try {
        decoder.decode();
      } catch {
        fail();
      }
      decoder = new TextDecoder('utf-8', { fatal: true });
    },
  };
}

/** Until `stream` takes more, or `stop` says why it never will. */
async function roomIn(stream: NodeJS.WritableStream, stop: AbortSignal): Promise<void> {
  try {
    await once(stream as unknown as NodeJS.EventEmitter, 'drain', { signal: stop });
  } catch (err) {
    throw stop.aborted ? stop.reason : err;
  }
}

/** One dump file through the filter: gunzipped first when it is a .gz, its bytes checked by `check` when given. */
async function pumpDump(
  pkg: OpenPackage,
  dump: PackageDumpFile,
  filter: PackageDumpFilter,
  out: (buf: Buffer) => Promise<void>,
  check: ReturnType<typeof utf8Check> | null,
): Promise<void> {
  const base = path.posix.basename(dump.name);
  if (!dump.gzip) {
    await pkg.read(dump.ref, (chunk) => {
      check?.chunk(chunk);
      return out(filter.push(chunk));
    });
  } else {
    const gunzip = zlib.createGunzip();
    const consume = (async () => {
      for await (const chunk of gunzip) {
        check?.chunk(chunk as Buffer);
        await out(filter.push(chunk as Buffer));
      }
    })();
    const consumed = new AbortController();
    consume.then(
      () => consumed.abort(new Error('The database file ended before it was read')),
      (err: unknown) => consumed.abort(err),
    );
    try {
      await pkg.read(dump.ref, async (chunk) => {
        if (!gunzip.write(chunk)) await roomIn(gunzip, consumed.signal);
      });
      gunzip.end();
      await consume;
    } catch (err) {
      gunzip.destroy();
      await consume.catch(() => undefined);
      if (err instanceof Error && !(err instanceof NotUtf8Error) && /header|unexpected end|invalid/i.test(err.message) && !/dump/i.test(err.message)) {
        throw new Error(`The database file ${base} in the package cannot be unpacked: ${err.message}`);
      }
      throw err;
    }
  }
  check?.end();
  await out(filter.endFile());
}

/**
 * The modes wpdb takes out of every session's (class-wpdb.php, $incompatible_modes), as WordPress's
 * trunk has them: its next release adds NO_BACKSLASH_ESCAPES to the six of 7.1. Watchlist.
 */
const WORDPRESS_INCOMPATIBLE_MODES = ['NO_ZERO_DATE', 'ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'TRADITIONAL', 'ANSI', 'NO_BACKSLASH_ESCAPES'];

/**
 * What a trigger is added under. A trigger keeps the SQL mode it was made in, which archive.txt
 * does not record: WordPress's, the server's own without the modes wpdb takes out, is the one a
 * plugin's trigger was made in, and one in which a wrong guess turns no write into an error. Not
 * the dump's: its NO_AUTO_VALUE_ON_ZERO is for loading rows. Lock waits end in half a minute.
 */
const TRIGGER_PREAMBLE = [
  'SET NAMES utf8mb4;',
  'SET SESSION lock_wait_timeout = 30;',
  "SET @wpl7_mode = CONCAT(',', @@GLOBAL.sql_mode, ',');",
  ...WORDPRESS_INCOMPATIBLE_MODES.map((mode) => `SET @wpl7_mode = REPLACE(@wpl7_mode, ',${mode},', ',');`),
  "SET SESSION sql_mode = TRIM(BOTH ',' FROM @wpl7_mode);",
  '',
].join('\n');

/** A trigger's CREATE as it is loaded: after TRIGGER_PREAMBLE, made fit as the dump's statements are. */
export function triggerSql(create: string, prefix: string): Buffer {
  const filter = new PackageDumpFilter(prefix);
  return Buffer.concat([Buffer.from(TRIGGER_PREAMBLE), filter.push(Buffer.from(`${create}\n`, 'utf8')), filter.endFile()]);
}

/**
 * The old database's triggers, which Duplicator keeps out of its dumps, added as the site's own
 * user once everything else has changed the database: made fit as the dump's statements are (their
 * definer the site's user). One that names what the database has not, or whose meaning depends on
 * an SQL mode, is left out (services/packageTriggers.ts), and so is one the database refuses: the
 * job log names each.
 */
async function addTriggers(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  site: SiteRow,
  c: PackageContents,
  report: MigrateReport,
  names: SiteNames,
  dir: string,
): Promise<void> {
  // The package's tables as archive.txt names them, beside what the dump created.
  const tables = new Set([...Object.keys(c.descriptor?.dbInfo.tablesList ?? {}), ...names.tables]);
  const triggers = packageTriggers(c, { ...names, tables });
  if (triggers.length === 0) return;
  ctx.info(`Adding the old database's ${plural(triggers.length, 'trigger')}…`);
  await server.files.mkdirp(dir, { mode: 0o700 });
  const added: string[] = [];
  for (const [n, t] of triggers.entries()) {
    ctx.checkCanceled();
    if (t.problems.length > 0) {
      ctx.warn(`Left out the trigger ${t.name}, which ${t.problems.join(', and ')}. The package's archive.txt has its definition.`);
      continue;
    }
    const file = path.join(dir, `${n}.sql.gz`);
    try {
      await server.files.writeFile(file, zlib.gzipSync(triggerSql(t.create, report.table_prefix)), { mode: 0o600 });
      await server.dbAdmin.importFromAs(file, site.dbName, site.dbUser, site.dbPassword, { timeoutMs: 2 * 60_000 });
      added.push(t.name);
    } catch (err) {
      ctx.warn(`Could not add the trigger ${t.name} (${errMsg(err)}). The package's archive.txt has its definition.`);
    }
  }
  if (added.length > 0) {
    ctx.info(`Added ${plural(added.length, 'trigger')} (${added.join(', ')}), owned by the site's database user and run in WordPress's SQL mode.`);
  }
}

/**
 * The site's language, as WordPress itself has it (get_locale): the WPLANG option, a WPLANG
 * constant carried over, or the language of a translated WordPress download. Null when it cannot
 * be read.
 */
async function siteLanguage(server: ServerHandle, container: string): Promise<string | null> {
  try {
    const res = await server.wp.run(container, ['eval', 'echo get_locale();', '--skip-plugins', '--skip-themes'], 60_000);
    const value = res.stdout.trim();
    return res.exitCode === 0 && localeSchema.safeParse(value).success ? value : null;
  } catch {
    return null;
  }
}
