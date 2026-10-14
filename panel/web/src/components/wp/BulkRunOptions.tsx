// @docs plugins/updates, sites/bulk, sites/wordpress
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { BackupBeforeUpdates } from '../../../../shared/schemas';
import { Toggle } from '../ui';

export interface BulkRunOptionsValue {
  backupFirst: boolean;
  healthCheck: boolean;
}

/**
 * The sites' setting decides the backup, not the switch: `on` is what it decided, null when it
 * decides differently for different sites. `why` says so beside the switch, `title` on hover.
 */
export interface BackupDecided {
  on: boolean | null;
  why: ReactNode;
  title: string;
}

/**
 * How long the backup taken first is kept, in words: the sites' own keep periods (null = as
 * Settings says, `fallback`), which the nightly housekeeping deletes it after.
 */
export function keptFor(sitesKeepDays: (number | null)[], fallback: number): string {
  const days = new Set(sitesKeepDays.map((own) => own ?? fallback));
  if (days.size > 1) return "kept as long as each site's backups";
  const only = [...days][0] ?? fallback;
  return only > 0 ? `kept for ${only} days` : 'kept until you delete it';
}

export const BACKUP_BEFORE_UPDATES_LABELS: Record<BackupBeforeUpdates, string> = {
  always: 'Always',
  ask: 'Ask each time',
  never: 'Never',
};

/**
 * What one site's setting decided, for its update dialogs: null when it asks, and the switch is
 * the answer. `own`: the site set it itself, on its Backups tab; otherwise Settings did.
 */
export function backupDecidedFor(
  setting: BackupBeforeUpdates,
  own: boolean,
  slug: string,
  kept: string,
): BackupDecided | null {
  if (setting === 'ask') return null;
  const [on, where, to] = own
    ? ['on', "this site's Backups tab", `/sites/${slug}?tab=backups`]
    : ['in', 'Settings → Backups', '/settings#before-updates'];
  const word = setting === 'always' ? 'Always' : 'Never';
  return {
    on: setting === 'always',
    why: (
      <>
        {word}, as set {on}{' '}
        <Link className="underline" to={to}>
          {where}
        </Link>
        .{setting === 'always' && ` ${kept.charAt(0).toUpperCase()}${kept.slice(1)}.`}
      </>
    ),
    title: `${word}, as set ${on} ${where}`,
  };
}

const sites = (n: number) => (n === 1 ? '1 site' : `${n} sites`);

/**
 * What the selected sites' settings decide for a bulk update, from how many are set to each: the
 * switch's hint when some ask, and `decided` when none does.
 */
export function bulkBackupChoice(
  count: Record<BackupBeforeUpdates, number>,
  kept: string,
): { decided: BackupDecided | null; hint: string } {
  const { always, ask, never } = count;
  const keptSentence = `${kept.charAt(0).toUpperCase()}${kept.slice(1)}.`;
  if (ask > 0) {
    if (always === 0 && never === 0) return { decided: null, hint: `Database and files, ${kept}.` };
    const others = (n: number, when: string) =>
      n === 1 ? `The other site ${when} backs up first.` : `The other ${n} sites ${when} back up first.`;
    const rest =
      always > 0 && never > 0
        ? `Of the others, ${always} always back up first and ${never} never ${never === 1 ? 'does' : 'do'}.`
        : always > 0
          ? others(always, 'always')
          : others(never, 'never');
    return { decided: null, hint: `For the ${ask === 1 ? 'site' : `${ask} sites`} set to ask. ${rest}` };
  }
  const these = always + never === 1 ? 'the site is' : 'these sites are';
  if (never === 0) {
    const why = `Always, as ${these} set. ${keptSentence}`;
    return { decided: { on: true, why, title: why }, hint: '' };
  }
  if (always === 0) {
    const why = `Never, as ${these} set.`;
    return { decided: { on: false, why, title: why }, hint: '' };
  }
  const why = `Back up first: ${sites(always)} always, ${never} never, as each is set.`;
  return { decided: { on: null, why, title: why }, hint: '' };
}

/**
 * The two decisions every WordPress write shares. Both are offered rather than implied:
 * a backup of a big site costs minutes and disk, and the health check is the only thing
 * standing between "the update ran" and "the site still works". Where the sites' setting
 * decides the backup (`backupDecided`), the switch shows what it decided and cannot be moved.
 */
export function BulkRunOptions({
  value,
  onChange,
  backupHint,
  backupDecided,
}: {
  value: BulkRunOptionsValue;
  onChange: (value: BulkRunOptionsValue) => void;
  backupHint?: ReactNode;
  backupDecided?: BackupDecided | null;
}) {
  return (
    <div className="space-y-2">
      {backupDecided?.on === null ? (
        <p className="text-sm text-neutral-700">{backupDecided.why}</p>
      ) : (
        <>
          <span className="inline-block" title={backupDecided?.title}>
            <Toggle
              checked={backupDecided ? backupDecided.on : value.backupFirst}
              disabled={!!backupDecided}
              onChange={(backupFirst) => onChange({ ...value, backupFirst })}
              label="Back up first"
            />
          </span>
          <p className="pl-11 text-xs text-neutral-500">{backupDecided?.why ?? backupHint ?? 'Database and files.'}</p>
        </>
      )}
      <Toggle
        checked={value.healthCheck}
        onChange={(healthCheck) => onChange({ ...value, healthCheck })}
        label="Check the site answers afterwards"
      />
      <p className="pl-11 text-xs text-neutral-500">The job fails if the site stops responding.</p>
    </div>
  );
}
