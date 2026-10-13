// @docs plugins/updates, sites/bulk, sites/wordpress
import { Toggle } from '../ui';

export interface BulkRunOptionsValue {
  backupFirst: boolean;
  healthCheck: boolean;
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

/**
 * The two decisions every WordPress write shares. Both are offered rather than implied:
 * a backup of a big site costs minutes and disk, and the health check is the only thing
 * standing between "the update ran" and "the site still works".
 */
export function BulkRunOptions({
  value,
  onChange,
  backupHint,
}: {
  value: BulkRunOptionsValue;
  onChange: (value: BulkRunOptionsValue) => void;
  backupHint?: string;
}) {
  return (
    <div className="space-y-2">
      <Toggle
        checked={value.backupFirst}
        onChange={(backupFirst) => onChange({ ...value, backupFirst })}
        label="Back up first"
      />
      <p className="pl-11 text-xs text-neutral-500">
        {backupHint ?? 'Database and files.'}
      </p>
      <Toggle
        checked={value.healthCheck}
        onChange={(healthCheck) => onChange({ ...value, healthCheck })}
        label="Check the site answers afterwards"
      />
      <p className="pl-11 text-xs text-neutral-500">The job fails if the site stops responding.</p>
    </div>
  );
}
