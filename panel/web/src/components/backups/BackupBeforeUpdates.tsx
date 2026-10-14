// @docs plugins/updates
import { useEffect, useState } from 'react';
import { backupBeforeUpdatesValues, type BackupBeforeUpdates } from '../../../../shared/schemas';
import type { SiteDetail } from '../../../../shared/types';
import { api } from '../../api/client';
import { BACKUP_BEFORE_UPDATES_LABELS } from '../wp/BulkRunOptions';
import { compactInputClass, Spinner } from '../ui';

/**
 * Whether an update backs one site up first: as Settings says for every site, or always, ask, never
 * of its own. Saved as it is picked. What it shows is what is stored: a save that fails puts the
 * choice back.
 */
export function BackupBeforeUpdatesSetting({
  slug,
  value,
  fallback,
  onSaved,
  onError,
}: {
  slug: string;
  /** The site's own: null = the default. */
  value: BackupBeforeUpdates | null;
  /** The default, from Settings. */
  fallback: BackupBeforeUpdates;
  /** With the site as it is now, this setting included. */
  onSaved: (site: SiteDetail) => void;
  onError: (err: unknown) => void;
}) {
  const [shown, setShown] = useState<string>(value ?? 'default');
  const [busy, setBusy] = useState(false);
  // Saved here or elsewhere: the control shows what is stored.
  useEffect(() => setShown(value ?? 'default'), [value]);

  const save = (next: string) => {
    setShown(next);
    setBusy(true);
    onError(null);
    void api<SiteDetail>(`/api/sites/${slug}/backup-before-updates`, {
      method: 'PUT',
      body: { value: next === 'default' ? null : next },
    })
      .then(onSaved)
      .catch((err: unknown) => {
        setShown(value ?? 'default');
        onError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-700">
      <span>Back up before updates</span>
      <select
        className={compactInputClass}
        aria-label="Back up before updates"
        value={shown}
        disabled={busy}
        onChange={(e) => save(e.target.value)}
      >
        <option value="default">{BACKUP_BEFORE_UPDATES_LABELS[fallback]} (default)</option>
        {backupBeforeUpdatesValues.map((v) => (
          <option key={v} value={v}>
            {BACKUP_BEFORE_UPDATES_LABELS[v]}
          </option>
        ))}
      </select>
      {busy && <Spinner />}
    </div>
  );
}
