import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { backups, servers } from '../../db/schema.js';
import { normalizeBackupRoot } from '../../../shared/backupRoot.js';
import { safeJoin } from '../../lib/slug.js';
import { shellQuote } from '../../servers/sshExec.js';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';

export const serverRelocateBackupsPayload = z.object({
  serverId: z.number().int(),
  to: z.string().min(1),
});

/**
 * Move a server's existing backups to a new location, then point the server at it.
 *
 * Copy, verify, then remove — never `mv`, because the whole point of choosing a new
 * location is usually that it is a different disk, where a rename is a copy anyway and a
 * half-finished one would be indistinguishable from a complete one. Each backup is moved
 * on its own and the row is updated as soon as its files are in place, so an interrupted
 * run leaves every backup either fully at the old location or fully at the new one, and
 * re-running it finishes the job.
 */
export async function serverRelocateBackups(
  ctx: JobContext<z.infer<typeof serverRelocateBackupsPayload>>,
  s: CoreServices,
): Promise<void> {
  const server = s.servers.rowById(ctx.payload.serverId);
  if (!server) throw new Error(`Server #${ctx.payload.serverId} not found`);
  const to = normalizeBackupRoot(ctx.payload.to, s.config.srvRoot);
  const handle = s.servers.handleFor(server.id);
  const from = s.backup.rootFor(server);

  await handle.files.mkdirp(to, { mode: 0o700 });
  if (to === from) {
    ctx.info(`Backups are already stored in ${to}.`);
    return;
  }

  const rows = s.db
    .select()
    .from(backups)
    .where(and(eq(backups.serverId, server.id), eq(backups.filesPresent, 1)))
    .all()
    .filter((row) => s.backup.rootOf(row) === from);
  ctx.info(`Moving ${rows.length} backup(s) from ${from} to ${to} on "${server.name}"…`);

  const skipped: string[] = [];
  let moved = 0;
  for (const row of rows) {
    ctx.checkCanceled();
    const active = s.backup.activeJobFor(row);
    if (active) {
      skipped.push(`#${row.id} (job #${active.id} ${active.type} is using it)`);
      continue;
    }
    // Moved while a deletion works on it, the copy would outlive the row: the deletion removes
    // the files it last knew of and the row, and the copy stays behind, known to nothing.
    const deleting = s.backup.deletionJobFor(row.id);
    if (deleting) {
      skipped.push(`#${row.id} (job #${deleting.id} is deleting it)`);
      continue;
    }
    const ts = path.basename(row.path);
    const source = s.backup.backupDir(row);
    if (!(await handle.files.exists(source))) {
      skipped.push(`#${row.id} (files missing at ${source})`);
      continue;
    }
    const finalDir = safeJoin(to, row.siteSlug, ts);
    const staging = `${finalDir}.relocating`;
    try {
      await handle.files.rm(staging);
      await handle.files.mkdirp(safeJoin(to, row.siteSlug), { mode: 0o700 });
      const cp = await handle.exec.run('cp', ['-a', '--', source, staging], { timeoutMs: 6 * 3600_000 });
      if (cp.exitCode !== 0) throw new Error(`cp failed: ${cp.stderr.trim().slice(0, 200)}`);

      const verify = await handle.exec.run(
        'sh',
        ['-c', `cd ${shellQuote([staging])} && exec sha256sum -c --strict sha256sums`],
        { timeoutMs: 2 * 3600_000 },
      );
      if (verify.exitCode !== 0) {
        throw new Error(`checksums did not match after the copy: ${(verify.stderr || verify.stdout).slice(0, 200)}`);
      }

      await handle.files.rm(finalDir);
      await handle.files.rename(staging, finalDir);
      // The row points at the new copy before the old one is removed: a crash in between
      // costs disk space, the other order would cost the backup.
      s.db.update(backups).set({ path: finalDir, rootPath: to }).where(eq(backups.id, row.id)).run();
      await handle.files.rm(source);
      moved++;
      ctx.info(`Moved backup #${row.id} (${row.siteSlug}/${ts}).`);
    } catch (err) {
      await handle.files.rm(staging).catch(() => undefined);
      skipped.push(`#${row.id} (${err instanceof Error ? err.message : String(err)})`);
      ctx.warn(`Backup #${row.id} could not be moved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  s.db.update(servers).set({ backupRoot: to, updatedAt: Date.now() }).where(eq(servers.id, server.id)).run();
  s.servers.invalidate(server.id);
  ctx.info(`"${server.name}" now stores backups in ${to}.`);

  if (skipped.length > 0) {
    ctx.warn(
      `${skipped.length} backup(s) stayed where they were: ${skipped.join(', ')}. ` +
        `They are still listed and still restorable; run the move again to retry them.`,
    );
  }
  ctx.setResult({ moved, skipped: skipped.length, root: to });
}
