// @docs backups/overview
import { useEffect, useState } from 'react';
import { MAX_BACKUP_KEEP_DAYS } from '../../../../shared/schemas';
import { api } from '../../api/client';
import { Button, compactInputClass, Spinner } from '../ui';

type Mode = 'default' | 'never' | 'days';

const modeOf = (days: number | null): Mode => (days === null ? 'default' : days === 0 ? 'never' : 'days');

/**
 * After how many days one site's backups are deleted: as Settings says for every site, never, or a
 * number of its own. The first two save as they are picked; a number waits for Save.
 */
export function KeepDaysSetting({
  slug,
  value,
  fallback,
  onSaved,
  onError,
}: {
  slug: string;
  /** The site's own: null = the default, 0 = never. */
  value: number | null;
  /** The default, from Settings: 0 = never. */
  fallback: number;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [mode, setMode] = useState<Mode>(modeOf(value));
  const [text, setText] = useState(String(value || fallback || 30));
  const [busy, setBusy] = useState(false);
  // Saved here or elsewhere: the control shows what is stored.
  useEffect(() => {
    setMode(modeOf(value));
    if (value) setText(String(value));
  }, [value]);

  const save = (days: number | null) => {
    setBusy(true);
    onError(null);
    void api(`/api/sites/${slug}/backups-keep-days`, { method: 'PUT', body: { days } })
      .then(onSaved)
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const days = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(days) && days >= 1 && days <= MAX_BACKUP_KEEP_DAYS;
  const unsaved = mode === 'days' && days !== value;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-700">
      <span>Delete backups after</span>
      <select
        className={compactInputClass}
        aria-label="Delete backups after"
        value={mode}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value as Mode;
          setMode(next);
          if (next === 'default' && value !== null) save(null);
          if (next === 'never' && value !== 0) save(0);
        }}
      >
        <option value="default">{fallback > 0 ? `${fallback} days (default)` : 'Never (default)'}</option>
        <option value="never">Never</option>
        <option value="days">Custom</option>
      </select>
      {mode === 'days' && (
        <>
          <input
            type="number"
            className={`${compactInputClass} w-20`}
            aria-label="Days"
            min={1}
            max={MAX_BACKUP_KEEP_DAYS}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          days
          {unsaved && (
            <Button small disabled={!valid || busy} title={valid ? undefined : `1 to ${MAX_BACKUP_KEEP_DAYS} days`} onClick={() => save(days)}>
              Save
            </Button>
          )}
        </>
      )}
      {busy && <Spinner />}
    </div>
  );
}
