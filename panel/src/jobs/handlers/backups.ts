import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { backups } from '../../db/schema.js';
import { backupTypes } from '../../../shared/schemas.js';
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

export const backupCreatePayload = z.object({
  siteId: z.number().int(),
  type: z.enum(backupTypes),
  note: z.string().optional(),
});

export async function backupCreate(ctx: JobContext<z.infer<typeof backupCreatePayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  s.monitor.busySlugs.add(site.slug);
  try {
    const row = await s.backup.create(site, ctx.payload.type, {
      note: ctx.payload.note,
      jobId: ctx.jobId,
      log: (l, m) => ctx.log(l, m),
    });
    ctx.setResult({ backupId: row.id, sizeBytes: row.sizeBytes });
    // Offsite copies are reconciled on a one-minute tick; kicking it here is only so a
    // fresh backup starts uploading immediately rather than up to a minute later.
    s.offsite.kick();
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
    if (manifest?.phpVersion && manifest.phpVersion !== site.phpVersion) {
      if (offered.includes(manifest.phpVersion)) {
        ctx.info(`Backup was taken on PHP ${manifest.phpVersion}; recreating container to match…`);
        const { ensureSiteImage } = await import('./sites.js');
        await ensureSiteImage(ctx, server, s.config, manifest.phpVersion);
        await server.docker.removeContainer(site.containerName);
        updateSiteRow(s.db, site.id, { phpVersion: manifest.phpVersion });
        const { buildSiteContainerSpec, siteRuntimeFrom } = await import('../../services/siteSpec.js');
        await server.docker.createSiteContainer(
          buildSiteContainerSpec(
            s.config,
            loadSite(s.db, site.id),
            siteDomains(site),
            server.row,
            siteRuntimeFrom(s.settings),
          ),
        );
      } else {
        ctx.warn(
          `Backup was taken on PHP ${manifest.phpVersion}, which is no longer offered; keeping PHP ${site.phpVersion}.`,
        );
      }
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
): Promise<{ phpVersion?: string; domains?: string[] } | null> {
  try {
    const files = s.servers.handleFor(serverId).files;
    return JSON.parse(await files.readFile(path.join(dir, 'manifest.json')));
  } catch {
    return null;
  }
}
