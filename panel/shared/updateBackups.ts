// @docs plugins/updates
import { backupBeforeUpdatesValues, type BackupBeforeUpdates, type WpComponentAction } from './schemas.js';

/**
 * Whether an update backs a site up first. Shared because the panel decides it and the pages say it:
 * a page that showed "no backup first" for a run the panel then backs up would be lying.
 */

/** One of the three. A column or a setting holds whatever was written into it. */
export const isBackupBeforeUpdates = (value: unknown): value is BackupBeforeUpdates =>
  (backupBeforeUpdatesValues as readonly unknown[]).includes(value);

/** A site's own setting, or the panel's when it has none. */
export function backupBeforeUpdatesOf(own: unknown, panel: unknown): BackupBeforeUpdates {
  if (isBackupBeforeUpdates(own)) return own;
  return isBackupBeforeUpdates(panel) ? panel : 'ask';
}

/** Does this run update something? Only those follow the setting: a bulk delete backs up when asked to. */
export const updatesSomething = (ops: readonly { action: WpComponentAction }[]): boolean =>
  ops.some((op) => op.action === 'update');

/**
 * Whether an update takes a backup first: what the setting says, or for `ask` the answer the request
 * gave. undefined: the site asks and nobody answered.
 */
export function backupFirstFor(setting: BackupBeforeUpdates, answer: boolean | undefined): boolean | undefined {
  if (setting === 'always') return true;
  if (setting === 'never') return false;
  return answer;
}
