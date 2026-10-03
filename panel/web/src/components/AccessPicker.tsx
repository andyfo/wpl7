import { ACCESS_LABELS, ACCESS_SUMMARIES, accessLevels, type AccessLevel } from '../../../shared/access';

/**
 * The three access levels, each with what it adds - for a new API key, and for an app being
 * approved over MCP. Radios rather than a select: the difference between the levels is the
 * whole decision, so it is spelled out rather than hidden behind a name.
 */
export function AccessPicker({
  value,
  onChange,
  name,
}: {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  /** The radio group's name; one per picker on a page. */
  name: string;
}) {
  return (
    <div role="radiogroup" className="space-y-2">
      {accessLevels.map((level) => (
        <label
          key={level}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
            value === level
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-neutral-200 hover:border-neutral-300'
          }`}
        >
          <input
            type="radio"
            name={name}
            className="mt-1"
            checked={value === level}
            onChange={() => onChange(level)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-neutral-800">{ACCESS_LABELS[level]}</span>
            <span className="block text-xs text-neutral-500">{ACCESS_SUMMARIES[level]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

const BADGE: Record<AccessLevel, string> = {
  read: 'bg-emerald-100 text-emerald-800',
  manage: 'bg-amber-100 text-amber-800',
  full: 'bg-red-100 text-red-800',
};

/** A level as a small badge, for tables. */
export function AccessBadge({ level, title }: { level: AccessLevel; title?: string }) {
  return (
    <span
      title={title ?? ACCESS_SUMMARIES[level]}
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${BADGE[level]}`}
    >
      {ACCESS_LABELS[level]}
    </span>
  );
}
