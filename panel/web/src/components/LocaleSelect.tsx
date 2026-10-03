import { useMeta } from '../api/hooks';
import { localeLabel } from '../lib/format';
import { inputClass } from './ui';

/**
 * Language picker offering WordPress's own list (shared/locales.ts, served by /api/meta).
 * A value outside that list - a locale published after the list was generated, or one set
 * over the API - is kept as an option of its own, so opening a form never silently
 * rewrites it to the first entry.
 */
export function LocaleSelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const locales = useMeta().data?.locales ?? [];
  const known = locales.some((l) => l.code === value);
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value}</option>}
      {locales.map((l) => (
        <option key={l.code} value={l.code}>
          {localeLabel(l)}
        </option>
      ))}
    </select>
  );
}
