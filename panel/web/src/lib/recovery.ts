// @docs servers/recover
import type { RecoveryBackupDto, RecoveryTargetDto, ServerRecoveryDto, SiteRecoveryDto } from '../../../shared/types';

/**
 * Where a backup comes from for a recovery onto `targetId`, as the dialogs name it: the server
 * whose disk has its files when that is the target, else its first offsite copy. Null when it
 * can't reach that server at all. The order is the panel's (services/recovery.ts sourceFor).
 */
export function backupFrom(backup: RecoveryBackupDto, targetId: number, serverName: (id: number) => string): string | null {
  if (backup.localServerId === targetId) return serverName(targetId);
  return backup.copies[0]?.name ?? null;
}

/** The newest backup that can reach `targetId`; the lists come newest first. */
export function newestFor(backups: RecoveryBackupDto[], targetId: number): RecoveryBackupDto | null {
  return backups.find((b) => b.localServerId === targetId || b.copies.length > 0) ?? null;
}

/**
 * The server a server's sites come back on unless the user picks another: the server itself while
 * it answers (its sites are gone from it, not it), else the first other one.
 */
export function defaultServerTarget(report: ServerRecoveryDto): RecoveryTargetDto | null {
  if (report.server.answers) {
    const own = report.targets.find((t) => t.id === report.server.id);
    if (own) return own;
  }
  return report.targets.find((t) => t.id !== report.server.id) ?? null;
}

/** One line of the server dialog: the backup a site comes back from on the target, or why it can't. */
export type RecoveryLine =
  | { slug: string; title: string; backup: RecoveryBackupDto; from: string }
  | { slug: string; title: string; reason: string };

export function recoveryLine(site: SiteRecoveryDto, target: RecoveryTargetDto | null, serverName: (id: number) => string): RecoveryLine {
  const base = { slug: site.slug, title: site.title };
  if (site.refusal) return { ...base, reason: site.refusal };
  if (!target) return { ...base, reason: 'There is no server to bring it back on.' };
  if (!site.targets.some((t) => t.id === target.id)) return { ...base, reason: `It can't come back on ${target.name}.` };
  const backup = newestFor(site.backups, target.id);
  if (!backup) return { ...base, reason: `No backup of it can reach ${target.name}.` };
  return { ...base, backup, from: backupFrom(backup, target.id, serverName) ?? '' };
}
