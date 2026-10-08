// @docs sites/import
import path from 'node:path';
import { z } from 'zod';
import type { BackupRow } from '../../db/schema.js';
import type { ImportRunBody } from '../../../shared/schemas.js';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';
import { initialCursor } from '../../services/imports.js';
import { NOT_READ, type ListedFile } from '../../services/importListing.js';
import { PullCanceledError, type ImportPullClient } from '../../services/importPull.js';
import { JobCanceledError } from '../../lib/errors.js';
import { siteImage, sitePaths } from '../../services/siteSpec.js';
import type { SiteRow } from '../../db/schema.js';
import { safeJoin } from '../../lib/slug.js';
import { LICENSES_MU_PLUGIN_PATH } from '../../services/licenses.js';
import { MU_PLUGIN_PATH } from '../../services/adminLogin.js';
import type { ServerHandle } from '../../servers/registry.js';
import { fixWordPress, importPathProblem, listFiles, makeRoomForStatements, pullDatabase, pullFiles, reportSkipped } from './import.js';
import { loadSite, probeSite, siteDomains, siteUrl, startSiteContainer, updateSiteRow, writeSiteJson } from './shared.js';

/**
 * Refresh from source (docs/site-lifecycle.md → Import): an imported site's database pulled again
 * from the old site, with the files that changed since, while the old site shows visitors a
 * maintenance page - the last step before going live, for a site whose old copy kept taking orders
 * or comments after the import.
 *
 * In the site's server lane, holding the site: its database is replaced. A safety backup comes
 * first, and a failure after the database was touched puts that backup back.
 */

export const siteImportRefreshPayload = z.object({ importId: z.number().int(), sourceHost: z.string() });

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The old site's maintenance page lasts this long unless it is renewed; renewed every half of it. */
const MAINTENANCE_TTL_S = 3600;

/** Never removed, whatever the old site no longer has: the new copy's own. */
const KEEP = new Set(['wp-config.php', '.htaccess', MU_PLUGIN_PATH, LICENSES_MU_PLUGIN_PATH]);

/** The flags of a folder the old site listed without looking inside it. */
const NOT_LOOKED_INTO = ['unreadable', 'too_deep', 'cycle'];

/** What each path of the old site's listing is now: a folder it listed in full, or anything else. */
type ListedNow = Map<string, 'folder' | 'other'>;

/**
 * Whether the listing says a file it no longer has was deleted: the nearest folder above it that
 * the listing has must have been listed in full. A folder it could not look inside - unreadable,
 * a link now - says nothing of what is in it. The site's own folder was (siteImportRefresh).
 */
export function listedGone(file: string, now: ListedNow): boolean {
  for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
    const kind = now.get(file.slice(0, slash));
    if (kind) return kind === 'folder';
  }
  return true;
}

/**
 * Removes the files its arguments name - size, mtime, path, three at a time, the path relative to
 * the site's folder - that are still regular files of exactly that size and mtime, and prints how
 * many it removed and how many it kept because they changed. Run in the site's container as
 * www-data, like the Files tab (services/siteFiles.ts): a link a site planted leads nowhere the
 * site could not reach already.
 */
export const REMOVE_UNCHANGED_SCRIPT = `removed=0; kept=0
while [ $# -ge 3 ]; do
  size=$1; mtime=$2; file=$3; shift 3
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    if [ "$(stat -c '%s %Y' -- "$file")" = "$size $mtime" ]; then
      rm -f -- "$file" && removed=$((removed + 1))
    else
      kept=$((kept + 1))
    fi
  fi
done
echo "$removed $kept"`;

/** What cp is run with, in the container that brings the changed files in. */
export const APPLY_CHANGED_FILES = ['-R', '--preserve=mode,timestamps', '/delta/.', '/var/www/html/'];

/**
 * The changed files into the site's folder, as the site's own user in a container of its image,
 * like the quarantine (services/quarantine.ts). The folder is the site's, and as root on the
 * server a link it planted would carry the copy anywhere; in there it reaches only what the site
 * can. The times are kept: a later refresh tells an unchanged file by them.
 */
async function applyChangedFiles(server: ServerHandle, site: SiteRow, wordpressDir: string, delta: string): Promise<void> {
  const res = await server.docker.runEphemeral({
    image: siteImage(site.phpVersion),
    entrypoint: ['cp'],
    cmd: APPLY_CHANGED_FILES,
    user: '33:33',
    binds: [`${wordpressDir}:/var/www/html`, `${delta}:/delta:ro`],
    labels: { 'wpl7.refresh': site.slug },
    timeoutMs: 60 * 60_000,
    lockdown: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1e9, pidsLimit: 32, tmpfs: { '/tmp': 8 } },
  });
  if (res.exitCode !== 0) throw new Error(`Copying the changed files in failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
}

/**
 * The files the old site listed at the last pull and lists no more, removed from the new copy
 * where they are still as they were pulled. A file changed here since stays, and so does one in
 * a folder the old site could not list this time: those are returned, with their records.
 */
async function removeDeleted(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  container: string,
  before: Map<string, ListedFile>,
  now: ListedNow,
): Promise<[string, ListedFile][]> {
  const gone: string[] = [];
  const unlisted: [string, ListedFile][] = [];
  for (const [file, listed] of before) {
    if (now.has(file) || KEEP.has(file) || importPathProblem(Buffer.from(file, 'utf8'))) continue;
    if (!listedGone(file, now)) {
      unlisted.push([file, listed]);
      continue;
    }
    gone.push(String(listed.s), String(listed.m), file);
  }
  const n = unlisted.length;
  if (n > 0) ctx.warn(`Kept ${n} file${n === 1 ? '' : 's'} in folders the old site could not list.`);
  if (gone.length === 0) return unlisted;
  let removed = 0;
  let kept = 0;
  for (let i = 0; i < gone.length; i += 600) {
    const res = await server.docker.exec(container, ['sh', '-c', REMOVE_UNCHANGED_SCRIPT, 'sh', ...gone.slice(i, i + 600)], {
      user: '33:33',
      env: ['LC_ALL=C'],
      workdir: '/var/www/html',
      timeoutMs: 5 * 60_000,
    });
    const [r, k] = res.stdout.trim().split(' ').map(Number);
    if (res.exitCode !== 0 || !Number.isFinite(r) || !Number.isFinite(k)) {
      throw new Error(`Removing the files the old site deleted failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    }
    removed += r!;
    kept += k!;
  }
  if (removed > 0) ctx.info(`Removed ${removed} file${removed === 1 ? '' : 's'} the old site deleted since the last pull.`);
  if (kept > 0) {
    ctx.info(`Kept ${kept} file${kept === 1 ? '' : 's'} the old site deleted: ${kept === 1 ? 'it was' : 'they were'} changed on this copy since.`);
  }
  return unlisted;
}

export async function siteImportRefresh(ctx: JobContext<z.infer<typeof siteImportRefreshPayload>>, s: CoreServices): Promise<void> {
  const row = s.imports.get(ctx.payload.importId);
  if (row.status !== 'done' || !row.siteId) throw new Error(`Import #${row.id} has not finished; there is nothing to refresh`);
  if (!row.token) throw new Error('The plugin on the old site was disconnected. Import the site again instead.');
  const report = s.imports.reportOf(row);
  const choices = row.choices ? (JSON.parse(row.choices) as ImportRunBody) : null;
  if (!report || !choices) throw new Error(`Import #${row.id} has no record of the old site`);
  let site = loadSite(s.db, row.siteId);
  const server = s.servers.handleFor(site.serverId);
  const paths = sitePaths(s.config, site.slug);
  const url = siteUrl(s.config, siteDomains(site)[0]!);
  const staging = safeJoin(path.join(s.config.srvRoot, 'wpl7-import'), String(row.id));
  const delta = path.join(staging, 'delta');
  const dbFile = path.join(staging, 'db.sql.gz');
  const before = s.imports.listings.read(row.id);
  // From when the last listing began, by the old site's clock: a file changed after that may
  // have been read before it changed. A few minutes more, for clocks that are not quite even.
  const since = before?.listedAt != null ? before.listedAt - 300 : undefined;
  const listedNow: ListedNow = new Map();
  let unreadableListed = 0;
  // What the copy has of the files this listing could not read or list is what the last pull
  // brought: the next listing keeps their records from the last one.
  const carried: [string, ListedFile][] = [];

  ctx.info(`Refreshing "${site.slug}" from ${ctx.payload.sourceHost}…`);
  s.monitor.busySlugs.add(site.slug);
  let client: ImportPullClient | null = null;
  let keepalive: NodeJS.Timeout | null = null;
  let renewal: Promise<void> | null = null;
  // Set when the job ends: a renewal still trying stops there.
  let ended = false;
  let resumeFtp: (() => void) | null = null;
  let safety: BackupRow | null = null;
  let touched = false;
  const wasRunning = (await server.docker.containerState(site.containerName)) === 'running';
  try {
    await server.files.rm(staging);
    await server.files.mkdirp(delta, { mode: 0o755 });
    client = s.imports.clientFor(row, { canceled: () => ctx.cancelRequested || ended, log: (line) => ctx.info(line) });
    const ping = await client.ping();

    ctx.info('Taking a backup of the site as it is now…');
    safety = await s.backup.create(site, 'pre_restore', {
      note: `before a refresh from ${ctx.payload.sourceHost}`,
      jobId: ctx.jobId,
      log: (level, message) => ctx.log(level, message),
    });
    ctx.checkCanceled();

    // Nothing the old site takes from here on would reach this copy.
    await client.maintenance(true, MAINTENANCE_TTL_S);
    ctx.info('The old site shows visitors a maintenance page while the panel copies it.');
    const renewing = client;
    keepalive = setInterval(() => {
      if (renewal) return;
      renewal = renewing
        .maintenance(true, MAINTENANCE_TTL_S)
        .then(
          () => undefined,
          (err: unknown) => {
            if (!ended) ctx.warn(`Could not renew the old site's maintenance page: ${errMsg(err)}`);
          },
        )
        .finally(() => {
          renewal = null;
        });
    }, s.config.nodeEnv === 'test' ? 50 : (MAINTENANCE_TTL_S / 2) * 1000);
    keepalive.unref();

    const cursor = initialCursor([
      'wp-config.php',
      ...choices.removeDropins.map((d) => `wp-content/${d}`),
      ...choices.removeMuPlugins.map((m) => `wp-content/mu-plugins/${m}`),
    ]);
    const nothing = async () => undefined;
    if (since === undefined) ctx.warn("The panel has no list of the old site's files from the last pull, so every file is copied again.");
    const listing = await listFiles(ctx, client, cursor, nothing, since === undefined ? {} : { since });
    // Progress counts what is copied: the listing has every file, changed or not.
    cursor.filesTotal = 0;
    cursor.bytesTotal = 0;
    s.imports.listings.reset(row.id, 'next', cursor.listedAt);
    await pullFiles(ctx, client, ping, server, delta, cursor, nothing, {
      onPage: (entries) => {
        for (const e of entries) {
          const flags = e.f ?? [];
          if (flags.includes('unreadable')) unreadableListed++;
          if (e.pb) continue;
          listedNow.set(e.p, e.t === 'd' && !flags.some((f) => NOT_LOOKED_INTO.includes(f)) ? 'folder' : 'other');
          const was = e.t === 'f' && flags.some((f) => NOT_READ.includes(f)) ? before?.files.get(e.p) : undefined;
          if (was) carried.push([e.p, was]);
        }
        s.imports.listings.append(row.id, entries, 'next');
      },
      // Unchanged by its times is not enough: the files of a folder renamed there keep theirs, and
      // are new at their path.
      alreadyThere: (e) => {
        const was = e.pb ? undefined : before?.files.get(e.p);
        return was !== undefined && was.s === e.s && was.m === e.m;
      },
    });
    // The file list never shows the site's own folder, but the listing's warnings count its flag
    // with the others: one `unreadable` more than the list has is that folder. Without it in
    // full, what changed and what was deleted there cannot be told.
    if ((listing.warnings?.find((w) => w.code === 'unreadable')?.count ?? 0) > unreadableListed) {
      throw new Error("The old site's own folder could not be listed in full. Check its permissions on the old host.");
    }
    await pullDatabase(ctx, client, ping, server, dbFile, report, cursor, nothing);
    reportSkipped(ctx, cursor);
    ctx.checkCanceled();

    // ---------------------------------------------------------- replace
    // FTP first: putting the backup back sets this folder aside, and a file server left running
    // would go on serving - and taking uploads into - the copy set aside (services/ftp.ts).
    resumeFtp = await s.ftp.suspendSite(site);
    if (s.ftp.hasLogins(site.id)) ctx.info('FTP/SFTP paused until the refresh is over.');
    ctx.info('Replacing the database and the changed files…');
    touched = true;
    if (wasRunning) await server.docker.stopContainer(site.containerName);
    await makeRoomForStatements(ctx, server, cursor.longestStatement);
    await server.dbAdmin.recreateDb(site.dbName);
    await server.dbAdmin.importFromAs(dbFile, site.dbName, site.dbUser, site.dbPassword);
    // What was left behind at the import stays out: the listing skips it (cursor.skip).
    await applyChangedFiles(server, site, paths.wordpress, delta);
    await startSiteContainer(server, s, site, ctx);
    const unlisted = before ? await removeDeleted(ctx, server, site.containerName, before.files, listedNow) : [];
    if (!before) ctx.warn('Files the old site deleted since the import are still here: the panel has no list of its files from then.');
    await fixWordPress(ctx, s, server, site, report, choices, url, { discourageSearchEngines: site.isLive !== 1 });
    const up = await probeSite(server, site.containerName, siteDomains(site)[0]!, s.config.probeTimeoutMs);
    if (!up) ctx.warn('The site did not answer the smoke check yet; look at its container logs if it stays down.');
    if (!wasRunning) await server.docker.stopContainer(site.containerName);
    touched = false;
    resumeFtp();

    s.imports.mark(row.id, { importedAt: Date.now() });
    s.imports.listings.carry(row.id, [...carried, ...unlisted]);
    s.imports.listings.promote(row.id);
    site = loadSite(s.db, site.id);
    await writeSiteJson(server, s.config, site).catch(() => undefined);
    try {
      await s.backup.create(site, 'import', {
        note: `refreshed from ${ctx.payload.sourceHost}`,
        jobId: ctx.jobId,
        log: (level, message) => ctx.log(level, message),
      });
    } catch (err) {
      ctx.warn(`The backup after the refresh failed (${errMsg(err)}); take one from the Backups tab.`);
    }
    ctx.setResult({ slug: site.slug, url, files: cursor.filesDone, tables: cursor.tablesDone });
    ctx.info(`Refreshed: ${cursor.filesDone} new or changed files, and the database's ${cursor.tablesDone} tables.`);
  } catch (err) {
    const canceled = err instanceof JobCanceledError || err instanceof PullCanceledError;
    if (canceled) ctx.info('Stopped.');
    else ctx.error(`The refresh failed: ${errMsg(err)}`);
    if (touched && safety) {
      ctx.info('Putting the site back as it was before the refresh…');
      try {
        await server.docker.stopContainer(site.containerName).catch(() => undefined);
        await server.dbAdmin.recreateDb(site.dbName);
        await s.backup.importDatabase(safety, site.dbName);
        await s.backup.restoreFiles(safety, site, (level, message) => ctx.log(level, message));
        if (wasRunning) await startSiteContainer(server, s, site, ctx);
        ctx.info('The site is back as it was.');
      } catch (restoreErr) {
        updateSiteRow(s.db, site.id, { status: 'error' });
        ctx.error(`Putting it back failed too (${errMsg(restoreErr)}). Restore backup #${safety.id} from the Backups tab.`);
      }
    }
    throw canceled ? new JobCanceledError() : err;
  } finally {
    ended = true;
    if (keepalive) clearInterval(keepalive);
    // A renewal still on its way would put the maintenance page back after it was ended.
    await renewal;
    if (client) {
      client.close();
      // A client of its own: the job's sends nothing more once the job is asked to stop, and the
      // old site has to serve visitors again then too.
      const lift = s.imports.clientFor(row, { state: client.state, attempts: 3, log: (line) => ctx.info(line) });
      await lift.maintenance(false).then(
        () => ctx.info('The old site serves visitors again.'),
        (err) => ctx.warn(`Could not end the old site's maintenance page (${errMsg(err)}); it ends by itself within the hour.`),
      );
      lift.close();
    }
    resumeFtp?.();
    await server.files.rm(staging).catch(() => undefined);
    s.imports.listings.reset(row.id, 'next');
    s.monitor.busySlugs.delete(site.slug);
  }
}
