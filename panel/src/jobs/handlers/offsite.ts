import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { backupCopies, backupDestinations, backups } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';

/** ctx.info/warn/error, which is the shape OffsiteService logs through. */
const logOf = (ctx: JobContext<unknown>) => ({
  info: (m: string) => ctx.info(m),
  warn: (m: string) => ctx.warn(m),
  error: (m: string) => ctx.error(m),
});

// ---------------------------------------------------------------------------
// backup.offsite — copy one backup to every destination still waiting for it

export const backupOffsitePayload = z.object({ backupId: z.number().int() });

export async function backupOffsite(
  ctx: JobContext<z.infer<typeof backupOffsitePayload>>,
  s: CoreServices,
): Promise<void> {
  const { ok, failed } = await s.offsite.uploadBackup(ctx.payload.backupId, logOf(ctx));
  if (ok === 0 && failed === 0) {
    ctx.info('Nothing left to copy - every destination already has this backup.');
  }
  if (failed > 0) ctx.warn(`${failed} destination(s) failed and will be retried.`);
  ctx.setResult({ backupId: ctx.payload.backupId, copied: ok, failed });
}

// ---------------------------------------------------------------------------
// backup.fetch — bring an offsite-only backup back onto a server

export const backupFetchPayload = z.object({
  backupId: z.number().int(),
  destinationId: z.number().int(),
});

export async function backupFetch(
  ctx: JobContext<z.infer<typeof backupFetchPayload>>,
  s: CoreServices,
): Promise<void> {
  const row = await s.offsite.fetchBackup(ctx.payload.backupId, ctx.payload.destinationId, logOf(ctx));
  ctx.setResult({ backupId: row.id, serverId: row.serverId, path: row.path });
}

// ---------------------------------------------------------------------------
// backup.offsitePurge — remove a destination's objects, then the destination

export const backupOffsitePurgePayload = z.object({ destinationId: z.number().int() });

export async function backupOffsitePurge(
  ctx: JobContext<z.infer<typeof backupOffsitePurgePayload>>,
  s: CoreServices,
): Promise<void> {
  const destination = s.db
    .select()
    .from(backupDestinations)
    .where(eq(backupDestinations.id, ctx.payload.destinationId))
    .get();
  if (!destination) {
    ctx.warn(`Destination #${ctx.payload.destinationId} is already gone.`);
    return;
  }
  const copies = s.db
    .select()
    .from(backupCopies)
    .where(eq(backupCopies.destinationId, destination.id))
    .all();
  ctx.info(`Removing ${copies.length} copy/copies from "${destination.name}"…`);
  const { purged, failed } = await s.offsite.purgeCopies(copies, logOf(ctx));
  if (failed > 0) {
    throw new Error(
      `${failed} of ${copies.length} copies could not be removed from "${destination.name}"; ` +
        `the destination was kept so you can retry or remove it without deleting the objects`,
    );
  }
  const dropped = s.offsite.dropEmptyBackups();
  s.db.delete(backupDestinations).where(eq(backupDestinations.id, destination.id)).run();
  ctx.info(`Destination "${destination.name}" removed (${purged} copy/copies purged).`);
  ctx.setResult({ destination: destination.name, purged, droppedBackups: dropped });
}

// ---------------------------------------------------------------------------
// panel.snapshot — a backup of the panel's own database

/**
 * Site backups without the registry are restorable one at a time, by hand — `manifest.json`
 * carries enough to do it (docs/backup-restore.md). What they cannot rebuild is the fleet:
 * which servers exist, which domains belong to which site, the DKIM keys every sending
 * domain published. That lives in `panel.db`, so it gets a backup of its own and rides the
 * same offsite copies as everything else.
 *
 * The SSH private key is deliberately NOT included: it is the key to every server in the
 * fleet, and a bucket is not where it belongs unless the destination is encrypted.
 */
export const panelSnapshotPayload = z.object({});

export async function panelSnapshot(ctx: JobContext<Record<string, never>>, s: CoreServices): Promise<void> {
  const handle = s.servers.localHandle();
  const { dir, root, ts } = await s.backup.claimBackupDir(handle, 'panel');
  const row = s.db
    .insert(backups)
    .values({
      siteId: null,
      siteSlug: 'panel',
      serverId: handle.id,
      type: 'panel',
      status: 'creating',
      path: dir,
      rootPath: root,
      note: 'panel database',
      jobId: ctx.jobId,
      createdAt: Date.now(),
    })
    .returning()
    .get();

  try {
    // better-sqlite3's online backup: a consistent copy without stopping the panel, which
    // a plain file copy of a WAL database is not.
    const plain = path.join(dir, 'panel.db');
    ctx.info('Copying the panel database…');
    await s.db.$client.backup(plain);
    const gz = `${plain}.gz`;
    await pipeline(fs.createReadStream(plain), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz));
    await fs.promises.rm(plain, { force: true });
    // Same posture as panel.db itself: this file holds every credential the panel has.
    await fs.promises.chmod(gz, 0o600);

    const manifest = {
      format: 1,
      slug: 'panel',
      type: 'panel',
      createdAt: new Date().toISOString(),
      panelDomain: s.config.panelDomain,
      servers: s.servers.listRows().map((srv) => ({ id: srv.id, name: srv.name, kind: srv.kind })),
      note: 'Restore by hand: stop the panel, gunzip over /srv/panel/panel.db, start it again.',
    };
    await handle.files.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const sum = await handle.files.sha256(gz);
    await handle.files.writeFile(path.join(dir, 'sha256sums'), `${sum}  panel.db.gz\n`);

    // Best effort: the snapshot is written and summed by now, and its size is only shown.
    const sizeBytes = (await handle.files.stat(gz).catch(() => null))?.sizeBytes ?? 0;
    s.db.update(backups).set({ status: 'complete', sizeBytes }).where(eq(backups.id, row.id)).run();
    ctx.info(`Panel snapshot complete (${(sizeBytes / 1024).toFixed(0)} KiB).`);
    ctx.setResult({ backupId: row.id, sizeBytes });
    s.offsite.kick();
  } catch (err) {
    s.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, row.id)).run();
    await handle.files.rm(dir).catch(() => undefined);
    throw err;
  }
}
