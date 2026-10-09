// @docs backups/delete, backups/overview, backups/restore
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { backups, type BackupRow, type SiteRow } from '../../db/schema.js';
import { JobCanceledError } from '../../lib/errors.js';
import { TABLE_PREFIX_RE, backupTypes } from '../../../shared/schemas.js';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';
import {
  attachSiteNetwork,
  ensureSiteMountSources,
  loadSite,
  probeSite,
  runLicenseHook,
  siteDomains,
  siteUrl,
  startSiteContainer,
  updateSiteRow,
} from './shared.js';
import { sites } from '../../db/schema.js';
import { isExternal } from '../../lib/siteKind.js';

export const backupCreatePayload = z.object({
  siteId: z.number().int(),
  type: z.enum(backupTypes),
  note: z.string().optional(),
});

export async function backupCreate(ctx: JobContext<z.infer<typeof backupCreatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  try {
    const row = await createBackup(ctx, s, site);
    ctx.setResult({ backupId: row.id, sizeBytes: row.sizeBytes });
    // Offsite copies are reconciled on a one-minute tick; kicking it here is only so a
    // fresh backup starts uploading immediately rather than up to a minute later.
    s.offsite.kick();
  } catch (err) {
    // A failed backup is worth an email (services/alerts.ts); one that was stopped is not.
    if (!(err instanceof JobCanceledError)) {
      await s.alerts.backupFailed(site, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    }
    throw err;
  }
}

/** The backup itself: pulled through WPL7 Connect for a site hosted elsewhere (services/externalBackup.ts). */
async function createBackup(ctx: JobContext<z.infer<typeof backupCreatePayload>>, s: CoreServices, site: SiteRow): Promise<BackupRow> {
  if (isExternal(site)) return s.externalBackups.create(ctx, site, ctx.payload.type, { note: ctx.payload.note });
  s.monitor.busySlugs.add(site.slug);
  try {
    return await s.backup.create(site, ctx.payload.type, {
      note: ctx.payload.note,
      jobId: ctx.jobId,
      log: (l, m) => ctx.log(l, m),
    });
  } finally {
    s.monitor.busySlugs.delete(site.slug);
  }
}

export const backupRestorePayload = z.object({
  backupId: z.number().int(),
  skipPreRestoreBackup: z.boolean(),
});

export async function backupRestore(ctx: JobContext<z.infer<typeof backupRestorePayload>>, s: CoreServices): Promise<void> {
  const backup = s.db.select().from(backups).where(eq(backups.id, ctx.payload.backupId)).get();
  if (!backup) throw new Error(`Backup #${ctx.payload.backupId} not found`);
  if (backup.status !== 'complete') throw new Error('Only complete backups can be restored');
  const site = s.db.select().from(sites).where(eq(sites.slug, backup.siteSlug)).get();
  if (!site) throw new Error(`Site "${backup.siteSlug}" no longer exists (restore-as-new-site is not supported yet)`);
  if (isExternal(site)) throw new Error('Restore a site hosted elsewhere by hand: download its files and database.');
  if ((await readManifest(s, backup.serverId, backup.path))?.kind === 'external') {
    throw new Error('This is a backup of a site hosted elsewhere: restore it by hand from its download.');
  }
  if (backup.serverId !== site.serverId) {
    throw new Error(
      `Backup #${backup.id} lives on server #${backup.serverId} but the site now runs on server #${site.serverId}; ` +
        `move the site back first (cross-server restore is not supported yet)`,
    );
  }
  const server = s.servers.handleFor(site.serverId);

  s.monitor.busySlugs.add(site.slug);
  let safetyCopy: string | null = null;
  // The site is only "damaged" once we start changing it. Failing the checksum verify or
  // the pre-restore safety backup leaves it running and untouched, so flagging it `error`
  // there was pure collateral damage - it stops wp-cron and scheduled backups for a site
  // that is perfectly healthy.
  let touched = false;
  let resumeFtp: (() => void) | null = null;
  try {
    ctx.info('Verifying backup checksums…');
    await s.backup.verifyChecksums(backup);

    if (!ctx.payload.skipPreRestoreBackup) {
      ctx.info('Taking pre-restore safety backup…');
      await s.backup.create(site, 'pre_restore', { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m) });
    }
    ctx.checkCanceled();

    // FTP first: restoreFiles renames the whole folder away, and a file server left running
    // would go on serving - and taking uploads into - the copy set aside (services/ftp.ts).
    // Before `touched`: pausing changes nothing about the site if it fails.
    resumeFtp = await s.ftp.suspendSite(site);
    if (s.ftp.hasLogins(site.id)) ctx.info('FTP/SFTP paused until the restore is over.');

    ctx.info('Stopping site…');
    touched = true;
    await server.docker.stopContainer(site.containerName);

    ctx.info(`Restoring database ${site.dbName}…`);
    await server.dbAdmin.recreateDb(site.dbName);
    await s.backup.importDatabase(backup, site.dbName);

    ctx.info('Restoring files…');
    safetyCopy = await s.backup.restoreFiles(backup, site, (l, m) => ctx.log(l, m));
    // The archive carries the site's config directory. Rewriting the bind-mounted files from
    // the registry keeps a restore from reinstating a stale relay credential - or none at
    // all, for an archive taken before per-site mail authentication existed, which would
    // then cost the site its container the next time one is created.
    await ensureSiteMountSources(server, s, loadSite(s.db, site.id), ctx);
    await attachSiteNetwork(ctx, server, site.slug);

    // Optionally move back to the PHP version the backup was taken with.
    const manifest = await readManifest(s, backup.serverId, backup.path);
    const offered = s.settings.get('phpVersions') ?? [];
    const recreate: { phpVersion?: string; tablePrefix?: string } = {};
    if (manifest?.phpVersion && manifest.phpVersion !== site.phpVersion) {
      if (offered.includes(manifest.phpVersion)) {
        ctx.info(`Backup was taken on PHP ${manifest.phpVersion}; recreating container to match…`);
        recreate.phpVersion = manifest.phpVersion;
      } else {
        ctx.warn(
          `Backup was taken on PHP ${manifest.phpVersion}, which is no longer offered; keeping PHP ${site.phpVersion}.`,
        );
      }
    }
    // The database just restored names its tables the way the backup's site did. That is this
    // site's prefix, unless the slug once belonged to a deleted site whose backups it now restores.
    const backupPrefix = manifest?.tablePrefix;
    if (backupPrefix && TABLE_PREFIX_RE.test(backupPrefix) && backupPrefix !== site.tablePrefix) {
      ctx.info(`The backup's tables start with ${backupPrefix}, not ${site.tablePrefix}; recreating the container to match…`);
      recreate.tablePrefix = backupPrefix;
    }
    if (recreate.phpVersion || recreate.tablePrefix) {
      if (recreate.phpVersion) {
        const { ensureSiteImage } = await import('./sites.js');
        await ensureSiteImage(ctx, server, s.config, recreate.phpVersion);
      }
      await server.docker.removeContainer(site.containerName);
      updateSiteRow(s.db, site.id, recreate);
      const { buildSiteContainerSpec, siteRuntimeFrom, siteTlsFor } = await import('../../services/siteSpec.js');
      await server.docker.createSiteContainer(
        buildSiteContainerSpec(
          s.config,
          loadSite(s.db, site.id),
          siteDomains(site),
          siteTlsFor(s.dns, server.row),
          siteRuntimeFrom(s.settings),
        ),
      );
    }

    ctx.info('Starting site…');
    await startSiteContainer(server, s, site, ctx);
    updateSiteRow(s.db, site.id, { status: 'running' });

    // If domains changed since the backup, point WordPress at the current primary.
    const currentPrimary = siteDomains(site)[0]!;
    const backupPrimary = manifest?.domains?.[0];
    if (backupPrimary && backupPrimary !== currentPrimary) {
      const oldUrl = siteUrl(s.config, backupPrimary);
      const newUrl = siteUrl(s.config, currentPrimary);
      ctx.info(`Backup used ${backupPrimary}; rewriting URLs to ${currentPrimary}…`);
      await server.wp.optionUpdate(site.containerName, 'home', newUrl);
      await server.wp.optionUpdate(site.containerName, 'siteurl', newUrl);
      await server.wp.searchReplace(site.containerName, oldUrl, newUrl);
      // The backup's plugins were activated for the old URL; let their recipes follow the move.
      await runLicenseHook(ctx, s, server, site, 'afterUrlChange', { url: newUrl, oldUrl, newUrl });
    }

    const up = await probeSite(server, site.containerName, currentPrimary, s.config.probeTimeoutMs);
    if (!up) ctx.warn('Site did not answer the post-restore smoke check - check container logs.');
    ctx.info('Restore complete.');
    ctx.setResult({ backupId: backup.id });
  } catch (err) {
    if (touched) {
      updateSiteRow(s.db, site.id, { status: 'error' });
    } else {
      ctx.warn('Nothing was changed - the site is still running from its current files.');
    }
    if (safetyCopy) {
      ctx.error(`Restore failed AFTER the file swap. Previous files are preserved at: ${safetyCopy}`);
    }
    throw err;
  } finally {
    s.monitor.busySlugs.delete(site.slug);
    resumeFtp?.();
  }
}

async function readManifest(
  s: CoreServices,
  serverId: number,
  dir: string,
): Promise<{ phpVersion?: string; domains?: string[]; tablePrefix?: string; kind?: string } | null> {
  try {
    const files = s.servers.handleFor(serverId).files;
    return JSON.parse(await files.readFile(path.join(dir, 'manifest.json')));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// backup.delete — several backups, everywhere

export const backupDeletePayload = z.object({
  // No upper bound here: the API caps what a request may name (MAX_BULK_BACKUP_DELETE), and a
  // site deletion names that site's backups, all of them, however many there are.
  backupIds: z.array(z.number().int().positive()).min(1),
  /**
   * The site deletion that queued this one. It is still finishing up when this starts, and is
   * done with the backups by then - without this, every one of them would read as in use.
   */
  parentJobId: z.number().int().positive().optional(),
});

/** Reasons a failed deletion's error spells out before it says "and N more". */
const REASONS_IN_ERROR = 3;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `#12 (shop, scheduled, 2026-10-01 03:00 UTC)` - enough to find it again in a list. */
function describeBackup(row: BackupRow): string {
  const when = new Date(row.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  return `#${row.id} (${row.siteSlug}, ${row.type}, ${when} UTC)`;
}

/**
 * Delete each backup the way the Delete button does - remote copies first, then the files and
 * the row - one after the other, in the `backup-delete` lane. A backup that is in use (being
 * written, restored, copied) is skipped rather than waited for, and one whose remote copy
 * cannot be removed is kept; either way the job ends failed and names it, because something
 * it was asked to delete is still there. One that is already gone counts as done.
 */
export async function backupDelete(ctx: JobContext<z.infer<typeof backupDeletePayload>>, s: CoreServices): Promise<void> {
  const { backupIds, parentJobId } = ctx.payload;
  const except = parentJobId === undefined ? [ctx.jobId] : [ctx.jobId, parentJobId];
  const log = { info: (m: string) => ctx.info(m), warn: (m: string) => ctx.warn(m), error: (m: string) => ctx.error(m) };
  let deleted = 0;
  let alreadyGone = 0;
  let keptByPolicy = 0;
  let freedBytes = 0;
  const notDeleted: string[] = [];
  const report = () =>
    ctx.setResult({
      requested: backupIds.length,
      deleted,
      alreadyGone,
      notDeleted: notDeleted.length,
      freedBytes,
      ...(keptByPolicy > 0 ? { keptByPolicy } : {}),
    });

  ctx.info(`Deleting ${backupIds.length} backup${backupIds.length === 1 ? '' : 's'}…`);
  report();
  for (const id of backupIds) {
    ctx.checkCanceled();
    const row = s.db.select().from(backups).where(eq(backups.id, id)).get();
    if (!row) {
      alreadyGone++;
      report();
      continue;
    }
    const what = describeBackup(row);
    const blocker = s.backup.deletionBlocker(row, except);
    if (blocker) {
      notDeleted.push(blocker);
      ctx.warn(`Kept ${what}: ${blocker}`);
      report();
      continue;
    }
    try {
      const out = await s.offsite.deleteEverywhere(row, log);
      keptByPolicy += out.keptByPolicy;
      if (out.purgeFailed > 0) {
        const reason = `${what}: ${out.purgeFailed} remote copy/copies could not be removed, so the backup was kept`;
        notDeleted.push(reason);
        ctx.error(`Kept ${reason}`);
      } else {
        deleted++;
        freedBytes += row.sizeBytes ?? 0;
        ctx.info(`Deleted ${what}`);
      }
    } catch (err) {
      // Its server unreachable, most likely: the row stays, so the files are not orphaned silently.
      notDeleted.push(`${what}: ${errMsg(err)}`);
      ctx.error(`Could not delete ${what}: ${errMsg(err)}`);
    }
    report();
  }

  if (keptByPolicy > 0) {
    ctx.warn(
      `${keptByPolicy} remote copy/copies were left in place because their destination manages its own retention. ` +
        `Remove them with your provider's tools if you want them gone.`,
    );
  }
  if (alreadyGone > 0) ctx.info(`${alreadyGone} had already been deleted.`);
  if (notDeleted.length > 0) {
    const more = notDeleted.length > REASONS_IN_ERROR ? `; and ${notDeleted.length - REASONS_IN_ERROR} more, see the log` : '';
    throw new Error(
      `${notDeleted.length} of ${backupIds.length} backups were not deleted: ` +
        `${notDeleted.slice(0, REASONS_IN_ERROR).join('; ')}${more}`,
    );
  }
  ctx.info(`Done: ${deleted} deleted.`);
}
