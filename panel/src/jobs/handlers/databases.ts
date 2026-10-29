// @docs databases/overview, sites/database, sites/database-structure
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { siteDatabases, type SiteRow } from '../../db/schema.js';
import { extraDbNameSchema, DB_LIMITS, DB_OBJECT_NAME_RE } from '../../../shared/databases.js';
import { generateSecret } from '../../lib/crypto.js';
import { AppError, JobCanceledError } from '../../lib/errors.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { DbTarget } from '../../services/dbBrowser.js';
import type { CoreServices } from '../../services/index.js';
import { sitePaths, siteRuntimeFrom } from '../../services/siteSpec.js';
import type { JobContext } from '../context.js';
import { loadSite, probeSite, shouldSiteRun, siteDomains, startSiteContainer, updateSiteRow } from './shared.js';
import { replaceContainer } from './sites.js';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------ another database for a site

export const databaseCreatePayload = z.object({
  siteId: z.number().int(),
  name: extraDbNameSchema,
  /** Who asked: an admin's username or an API key's name, kept with the database. */
  createdBy: z.string().nullable().default(null),
});

export async function databaseCreate(ctx: JobContext<z.infer<typeof databaseCreatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const { name } = ctx.payload;
  const server = s.servers.handleFor(site.serverId);
  // Again here: the request checked it, but another job may have taken the name since.
  s.databases.assertNameFree(name);
  const row = s.databases.reserve(site.id, name, ctx.payload.createdBy);
  if (row === null) throw new Error(`The name ${name} has just been taken; pick another`);
  ctx.info(`Creating database ${name} on "${server.name}" for ${site.dbUser}…`);
  try {
    await server.dbAdmin.createExtraDb(name, site.dbUser);
  } catch (err) {
    s.db.delete(siteDatabases).where(eq(siteDatabases.id, row)).run();
    throw err;
  } finally {
    s.databases.kick(site.serverId);
  }
  ctx.info(`Database ${name} added. It uses the site's database user and password.`);
  ctx.setResult({ name });
}

export const databaseDeletePayload = z.object({
  siteId: z.number().int(),
  name: extraDbNameSchema,
});

export async function databaseDelete(ctx: JobContext<z.infer<typeof databaseDeletePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const { name } = ctx.payload;
  const row = s.db
    .select()
    .from(siteDatabases)
    .where(and(eq(siteDatabases.siteId, site.id), eq(siteDatabases.name, name)))
    .get();
  if (!row) throw new Error(`"${name}" is not one of ${site.slug}'s databases`);
  const server = s.servers.handleFor(site.serverId);
  ctx.info(`Dropping database ${name} on "${server.name}"…`);
  await server.dbAdmin.dropDb(name);
  s.db.delete(siteDatabases).where(eq(siteDatabases.id, row.id)).run();
  s.databases.kick(site.serverId);
  ctx.info(`Database ${name} deleted.`);
  ctx.setResult({ name });
}

// ------------------------------------------------------------------ the password

export const databasePasswordPayload = z.object({ siteId: z.number().int() });

/** What the image's wp-config.php reads the password with; a file that does not is left alone. */
const READS_PASSWORD_FROM_ENV = /getenv_docker\(\s*['"]WORDPRESS_DB_PASSWORD['"]/;

/**
 * A new password for the site's database user. WordPress reads it from the container's settings
 * (`getenv_docker` in wp-config.php), and a container's settings are fixed when it is created, so
 * the container is recreated with it: the site is offline for the few seconds that takes. Every
 * step is undone when a later one fails - a site whose user and container disagree on the password
 * cannot reach its database at all. Where an undo fails too, the panel keeps the password MariaDB
 * has, so "Recreate container" puts the two back in step.
 */
export async function databasePassword(ctx: JobContext<z.infer<typeof databasePasswordPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const wpConfig = path.join(sitePaths(s.config, site.slug).wordpress, 'wp-config.php');
  const text = await server.files.readUntrusted(wpConfig, 512 * 1024);
  if (text === null && (await server.files.stat(wpConfig))) {
    // There, but a link or not readable: how it sets the password is unknown, and unknown is not "from the container".
    throw new Error("wp-config.php could not be read, so it is not known where WordPress takes its database password from. Try again; if it keeps failing, look at the file.");
  }
  if (text !== null && !READS_PASSWORD_FROM_ENV.test(text)) {
    throw new Error(
      "wp-config.php sets the database password itself, so a new one would cut WordPress off from its database. " +
        "Change it there by hand, or put back DB_PASSWORD's getenv_docker('WORDPRESS_DB_PASSWORD', …) and try again.",
    );
  }
  const oldPassword = site.dbPassword;
  const newPassword = generateSecret(24);
  const state = await server.docker.containerState(site.containerName);
  const run = shouldSiteRun(state, site);
  const domains = siteDomains(site);
  const withPassword = (dbPassword: string) => ({ site: { ...site, dbPassword }, domains });
  const answers = async (timeoutMs: number): Promise<boolean> =>
    s.config.nodeEnv === 'test'
      ? (await server.docker.containerState(site.containerName)) === 'running'
      : probeSite(server, site.containerName, domains[0]!, timeoutMs);
  // Asked briefly: only a site that answers now can be said to have stopped answering later.
  const answeredBefore = run && state === 'running' && (await answers(5_000));

  /** The old password back in MariaDB and the panel, and in a new container when one was made. */
  const putBack = async (container: boolean): Promise<void> => {
    try {
      await server.dbAdmin.setUserPassword(site.dbUser, oldPassword);
    } catch (err) {
      ctx.error(
        `Could not put the old password back either: ${errMsg(err)}. MariaDB keeps the new one, and so does the panel: ` +
          '"Recreate container" on the site page gives it to the site.',
      );
      return;
    }
    updateSiteRow(s.db, site.id, { dbPassword: oldPassword });
    if (!container) return;
    await replaceContainer(
      ctx,
      server,
      s,
      siteRuntimeFrom(s.settings, site),
      loadSite(s.db, site.id),
      withPassword(oldPassword),
      withPassword(newPassword),
      run,
    ).catch((err: unknown) => {
      ctx.error(`Could not recreate the container with the old password: ${errMsg(err)}. "Recreate container" on the site page does it.`);
    });
  };

  ctx.info(`Setting a new password for ${site.dbUser}…`);
  try {
    await server.dbAdmin.setUserPassword(site.dbUser, newPassword);
  } catch (err) {
    // The answer may have been lost after MariaDB took it: make sure the old password holds.
    await server.dbAdmin.setUserPassword(site.dbUser, oldPassword).catch((undoErr: unknown) => {
      ctx.error(`Could not make sure the old password holds: ${errMsg(undoErr)}. If the site cannot reach its database, change the password again.`);
    });
    throw err;
  }
  // MariaDB has the new password from here on, and the panel follows it.
  updateSiteRow(s.db, site.id, { dbPassword: newPassword });
  try {
    ctx.info('Recreating the site container with it (the site is offline for a few seconds)…');
    await replaceContainer(
      ctx,
      server,
      s,
      siteRuntimeFrom(s.settings, site),
      loadSite(s.db, site.id),
      withPassword(newPassword),
      withPassword(oldPassword),
      run,
    );
  } catch (err) {
    // replaceContainer put the previous container back, and it has the old password.
    ctx.error(`The container could not be recreated (${errMsg(err)}); putting the old password back…`);
    await putBack(false);
    throw err;
  }
  // Connections the browser kept open were made with the old password.
  server.dbBrowser.closeIdle();
  if (run) {
    const up = await answers(s.config.probeTimeoutMs);
    if (!up && answeredBefore) {
      ctx.error('The site answered before the change and does not now; putting the old password back…');
      await putBack(true);
      server.dbBrowser.closeIdle();
      throw new Error(
        'The site stopped answering with the new password, so the old one was put back. Something besides the ' +
          "container's settings may give WordPress its password: look at wp-config.php and the files it includes.",
      );
    }
    if (!up) ctx.warn('The site did not answer the check after the restart, nor before it; look at its container logs.');
  } else {
    ctx.info('The site was stopped, and is left stopped.');
  }
  ctx.info(`${site.dbUser} has a new password.`);
}

// ------------------------------------------------------------------ import

export const databaseImportPayload = z.object({
  siteId: z.number().int(),
  database: z.string(),
  uploadId: z.string(),
  /** Drop every table first, so the database holds exactly what the dump makes. */
  empty: z.boolean().default(false),
  /** Take a backup of the site before anything is changed. */
  backupFirst: z.boolean().default(true),
});

/**
 * One pass over a dump before anything is changed: its longest line, whether a `USE` or
 * `CREATE DATABASE` names a database other than `target` (first such line and the name), and
 * whether it creates the table `want`. POSIX awk: the hosts have mawk or busybox, not gawk.
 */
const DUMP_SCAN_AWK = `
BEGIN { m = 0; has = 0; bad = 0; badName = "" }
{
  if (length($0) > m) m = length($0)
  if (bad) next
  line = $0
  sub(/^[ \\t]+/, "", line)
  u = toupper(substr(line, 1, 20))
  kind = ""
  if (u ~ /^USE[ \\t\`]/) kind = "use"
  else if (u ~ /^CREATE[ \\t]+(DATABASE|SCHEMA)[ \\t]/) kind = "create"
  else if (want != "" && u ~ /^CREATE[ \\t]+TABLE/ && index(line, "\`" want "\`") > 0) has = 1
  if (kind == "") next
  if (match(line, /\`[^\`]+\`/)) name = substr(line, RSTART + 1, RLENGTH - 2)
  else {
    n = split(line, w, /[ \\t;]+/)
    i = (kind == "use") ? 2 : 3
    if (kind == "create" && toupper(w[3]) == "IF") i = 6
    name = w[i]
  }
  if (name != target) { bad = NR; badName = name }
}
END { printf "%d\\t%d\\t%d\\t%s\\n", m, has, bad, badName }
`;

/**
 * Load an uploaded dump into one of the site's databases, as the site's own database user: what
 * the dump says can reach that site's databases and nothing else, whoever wrote it. For the site's
 * own database the site is stopped meanwhile, as a restore does: a WordPress whose tables are half
 * loaded serves its installer to whoever asks (the maintenance page does not cover install.php),
 * and visitors would write into tables being replaced. It must find its installation afterwards.
 */
export async function databaseImport(ctx: JobContext<z.infer<typeof databaseImportPayload>>, s: CoreServices): Promise<void> {
  const p = ctx.payload;
  const site = loadSite(s.db, p.siteId);
  const target = s.databases.targetFor(site, p.database);
  const server = s.servers.handleFor(site.serverId);
  const file = s.databases.uploadPath(site, p.uploadId);
  const ownDb = p.database === site.dbName;
  const gone = () => new Error('The upload is not on the server any more; upload the file again');

  if (!(await server.files.stat(file))) throw gone();
  ctx.info('Checking the file…');
  const test = await server.exec.run('gzip', ['-t', file], { timeoutMs: 60 * 60_000 });
  if (test.exitCode !== 0) throw new Error(`The upload is not a complete gzip file: ${test.stderr.trim().slice(0, 300)}`);
  // A dump is text: a NUL byte near its start means a zip, a tar or some other file.
  const nul = await server.exec.run('sh', ['-c', 'gzip -dc -- "$1" | head -c 65536 | tr -cd "\\000" | wc -c', 'sh', file], {
    timeoutMs: 5 * 60_000,
  });
  if (nul.exitCode === 0 && Number(nul.stdout.trim()) > 0) {
    throw new Error('The file is not an SQL dump: it holds binary data. Upload a .sql file, or a .sql.gz.');
  }
  const scan = await server.exec.run(
    'sh',
    ['-c', 'gzip -dc -- "$1" | LC_ALL=C awk -v target="$2" -v want="$3" "$4"', 'sh', file, p.database, `${site.tablePrefix}options`, DUMP_SCAN_AWK],
    { timeoutMs: 60 * 60_000 },
  );
  if (scan.exitCode !== 0) throw new Error(`The dump could not be read: ${(scan.stderr || scan.stdout).trim().slice(0, 300)}`);
  const [longestText, hasOptions, badLine, badName] = scan.stdout.replace(/\n$/, '').split('\t');
  if (Number(badLine) > 0) {
    throw new Error(
      `The dump switches to the database ${badName} (line ${badLine}), so it would not load into ${p.database}. ` +
        'Export it without CREATE DATABASE and USE statements, then import it again.',
    );
  }
  if (ownDb && p.empty && hasOptions !== '1') {
    throw new Error(
      `The dump has no ${site.tablePrefix}options table. With every table deleted first, WordPress would find no installation. ` +
        'Import a dump of the whole database, or keep the tables.',
    );
  }

  if (p.backupFirst) {
    ctx.info('Backing the site up first…');
    s.monitor.busySlugs.add(site.slug);
    try {
      await s.backup.create(site, 'pre_restore', {
        note: `Before importing into ${p.database}`,
        jobId: ctx.jobId,
        log: (l, m) => ctx.log(l, m),
      });
    } finally {
      s.monitor.busySlugs.delete(site.slug);
    }
  }
  ctx.checkCanceled();

  // MariaDB refuses a statement longer than max_allowed_packet (16 MiB by default); a dump with
  // one would fail half-way.
  const longest = Number(longestText) || 0;
  if (longest > 0) {
    const raised = await server.dbAdmin.raisePacketLimit(longest);
    if (raised) ctx.info(`Raised MariaDB's packet limit to ${Math.round(raised / 1024 / 1024)} MiB for the longest statement.`);
  }

  const stopped = ownDb && (await server.docker.containerState(site.containerName)) === 'running';
  if (ownDb) s.monitor.busySlugs.add(site.slug);
  try {
    if (stopped) {
      ctx.info('Stopping the site for the import…');
      await server.docker.stopContainer(site.containerName);
    }
    let failure: unknown = null;
    try {
      // Again, now that the backup has run: nothing is emptied for a dump that has gone meanwhile.
      if (!(await server.files.stat(file))) throw gone();
      if (p.empty) {
        ctx.info(`Emptying ${p.database}…`);
        await server.dbAdmin.recreateDb(p.database);
      }
      ctx.info(`Importing into ${p.database} as ${target.user}…`);
      await server.dbAdmin.importFromAs(file, p.database, target.user, target.password, { timeoutMs: 2 * 3600_000 });
    } catch (err) {
      failure = err;
      ctx.error(`The import failed: ${errMsg(err)}`);
    } finally {
      s.databases.kick(site.serverId);
    }
    // Failed or not: a failed import may have emptied the database as surely as a wrong dump.
    if (stopped) await restartIfInstalled(ctx, s, site, target, { failed: failure !== null, backedUp: p.backupFirst });
    if (failure !== null) throw failure;
  } finally {
    if (ownDb) s.monitor.busySlugs.delete(site.slug);
  }
  // Kept when the import fails, so it can be run again without a new upload; housekeeping drops it after a day.
  await server.files.rm(file).catch(() => undefined);
  ctx.info('Import complete.');
  ctx.setResult({ database: p.database });
}

/**
 * After an import into the site's own database, failed or not, the site is started again only on
 * a database WordPress finds its installation in: one without hands its installer, and the site,
 * to whoever asks first. The database is asked while the site is still stopped, so there is no
 * moment in which the installer is served.
 */
async function restartIfInstalled(
  ctx: JobContext<unknown>,
  s: CoreServices,
  site: SiteRow,
  target: DbTarget,
  opts: { failed: boolean; backedUp: boolean },
): Promise<void> {
  const server = s.servers.handleFor(site.serverId);
  const installed = await hasInstallation(server, site, target);
  if (installed === false) {
    const restore = opts.backedUp ? 'Restore the backup taken before the import' : 'Restore a backup';
    throw new Error(
      (opts.failed
        ? 'The import failed, and left no WordPress installation in the database. '
        : `WordPress finds no installation in the imported database: its tables may not start with ${site.tablePrefix}. `) +
        `The site stays stopped, so no one can run the installer. ${restore}, or import a dump whose tables start with ` +
        `${site.tablePrefix}, then start the site.`,
    );
  }
  ctx.info('Starting the site again…');
  try {
    await startSiteContainer(server, s, loadSite(s.db, site.id), ctx);
  } catch (err) {
    ctx.error(`Could not start the site again: ${errMsg(err)}. Start it on the site page.`);
    return;
  }
  // The database could not be asked: WordPress is, now that it runs.
  if (installed === null) await assertStillInstalled(ctx, s, site, opts.backedUp);
}

/**
 * Whether the site's database holds a WordPress installation, as WordPress decides it
 * (is_blog_installed: a siteurl in its options table). Asked as the site's own user, through the
 * database browser, so the site need not run. `null` when the database could not be asked.
 */
async function hasInstallation(server: ServerHandle, site: SiteRow, target: DbTarget): Promise<boolean | null> {
  try {
    const page = await server.dbBrowser.rows(target, `${site.tablePrefix}options`, {
      offset: 0,
      limit: 1,
      dir: 'asc',
      filters: [{ column: 'option_name', op: 'eq', value: 'siteurl' }],
    });
    const at = page.columns.findIndex((c) => c.name === 'option_value');
    const value = at === -1 ? undefined : page.rows[0]?.[at];
    return value !== undefined && value !== null && value !== '';
  } catch (err) {
    // No options table: no installation. Anything else says nothing either way.
    return err instanceof AppError && err.statusCode === 404 ? false : null;
  }
}

/**
 * WordPress itself asked, in a site that runs: one that finds no installation is stopped again.
 * For when the database could not be asked first.
 */
async function assertStillInstalled(ctx: JobContext<unknown>, s: CoreServices, site: SiteRow, backedUp: boolean): Promise<void> {
  const server = s.servers.handleFor(site.serverId);
  let installed: boolean | null = null;
  // wp-cli may need a moment in a container that has just started.
  for (let attempt = 0; attempt < 3 && installed === null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, s.config.nodeEnv === 'test' ? 0 : 3000));
    installed = await server.wp.isInstalled(site.containerName).catch(() => null);
  }
  if (installed === true) return;
  if (installed === null) {
    ctx.warn('Could not check that WordPress finds its installation; open the site to make sure.');
    return;
  }
  await server.docker.stopContainer(site.containerName).catch(() => undefined);
  throw new Error(
    `WordPress finds no installation in the imported database: its tables may not start with ${site.tablePrefix}. ` +
      `The site is stopped, so no one can run the installer. ${backedUp ? 'Restore the backup taken before the import' : 'Restore a backup'}, ` +
      `or import a dump whose tables start with ${site.tablePrefix}, then start the site.`,
  );
}

// ------------------------------------------------------------------ table structure

export const databaseAlterPayload = z.object({
  siteId: z.number().int(),
  database: z.string(),
  /** What the job list says: "Add column x to wp_posts". */
  summary: z.string().max(300),
  /** Built and checked by the route (lib/sqlDdl.ts) from the change asked for; run as they are. */
  statements: z.array(z.string().max(DB_LIMITS.ddlChars)).min(1).max(10),
});

/**
 * A structure change: statements lib/sqlDdl.ts built from a form, run one after another as the
 * site's own database user, so MariaDB keeps them to the site's databases. A table the site is
 * busy in fails the change after a few seconds rather than stalling the site behind it.
 */
export async function databaseAlter(ctx: JobContext<z.infer<typeof databaseAlterPayload>>, s: CoreServices): Promise<void> {
  const p = ctx.payload;
  const site = loadSite(s.db, p.siteId);
  const target = s.databases.targetFor(site, p.database);
  const server = s.servers.handleFor(site.serverId);
  for (const sql of p.statements) {
    ctx.checkCanceled();
    ctx.info(sql.length > 2000 ? `${sql.slice(0, 2000)}…` : sql);
    const res = await server.dbBrowser
      .execute(target, sql, {
        lockWaitSeconds: 10,
        relayMs: 2 * 3600_000,
        // Stopped on the server before the job's own deadline (registry: two hours), and on Cancel.
        killAfterMs: 115 * 60_000,
        canceled: () => ctx.cancelRequested,
      })
      .catch((err: unknown) => {
        if (ctx.cancelRequested) throw new JobCanceledError();
        throw err;
      });
    // What MariaDB noted: a value rounded to a narrower type is a note, not an error.
    for (const w of res.warnings ?? []) ctx.warn(`MariaDB: ${w}`);
  }
  ctx.info('Done.');
  ctx.setResult({ database: p.database });
}

// ------------------------------------------------------------------ a database no site uses

export const databaseDeleteUnusedPayload = z.object({
  serverId: z.number().int(),
  name: z.string().regex(DB_OBJECT_NAME_RE),
});

/**
 * Drop a database nothing claims (the Databases page's "Not used by any site"). Checked again here,
 * against the sites as they are now: one that came to be used since the list was read stays.
 */
export async function databaseDeleteUnused(
  ctx: JobContext<z.infer<typeof databaseDeleteUnusedPayload>>,
  s: CoreServices,
): Promise<void> {
  const { serverId, name } = ctx.payload;
  const claim = s.databases.claimOf(serverId, name);
  if (claim) {
    throw new Error(
      claim.kind === 'moveCopy'
        ? `"${name}" is the old copy of ${claim.slug}, left by a move; finalize the move to drop it`
        : `"${name}" belongs to ${claim.slug} now; it was not deleted`,
    );
  }
  const server = s.servers.handleFor(serverId);
  ctx.info(`Dropping database ${name} on "${server.name}"…`);
  await server.dbAdmin.dropDb(name);
  // A site's database user has the site's database's name; one left behind with it goes too.
  if (/^wp_[a-z0-9_]+$/.test(name) && !s.databases.userClaimed(name) && (await server.dbAdmin.userExists(name))) {
    ctx.info(`Dropping the user ${name} it was made for…`);
    await server.dbAdmin.dropUser(name);
  }
  s.databases.kick(serverId);
  ctx.info(`Database ${name} deleted.`);
  ctx.setResult({ name });
}
