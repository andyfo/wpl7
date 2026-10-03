import { useMemo, useState } from 'react';
import {
  CRON_FIELDS,
  DEFAULT_CRON,
  cronFieldError,
  cronParts,
  describeCron,
  isCronEditable,
} from '../../../shared/cron';
import { cronPatternError, formatRunTime, nextCronRuns } from '../lib/cron';
import { inputClass } from './ui';

/**
 * A cron expression as one input per field inside a single box - "0 3 * * *" with each
 * part editable on its own - and the schedule in plain words underneath as it is typed.
 * "0 3 * * *" only reads as "03:00 every day" to someone who writes crontabs for a
 * living, and a backup window is not a good place to find out you were wrong.
 *
 * Drop-in wherever a schedule is set: it fills its container, so a half-width grid cell
 * makes it sit beside any other Field.
 */
export function CronField({
  label,
  value,
  onChange,
  timezone,
}: {
  label: string;
  value: string;
  onChange: (expr: string) => void;
  /** The server's zone: the clock this schedule runs on. */
  timezone?: string;
}) {
  // The slots are the right place to fix any five-field expression, including a broken one.
  // An expression croner runs happily but they cannot hold (a seconds field, L, #) belongs
  // in the text box instead - the alternative is a panel that locks an operator out of a
  // setting it is perfectly willing to schedule.
  const canUseFields =
    isCronEditable(value) || (cronParts(value) !== null && cronPatternError(value, timezone) !== null);
  const [parts, setParts] = useState<string[]>(() => cronParts(value) ?? DEFAULT_CRON.split(' '));
  const [asText, setAsText] = useState(() => !canUseFields);

  // Reload the slots when the value changes from outside (a save, or the text box).
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const next = cronParts(value);
    if (next && next.join(' ') !== parts.join(' ')) setParts(next);
  }

  const errors = parts.map((part, i) => cronFieldError(part, i));
  const editorProblem = errors.find((e) => e !== null) ?? null;
  const setPart = (index: number, text: string) => {
    const next = parts.map((part, i) => (i === index ? text : part));
    setParts(next);
    onChange(next.join(' '));
  };

  const preview = useMemo(() => {
    // The slot-level message names the offending field, so prefer it over croner's.
    const problem = (asText ? null : editorProblem) ?? cronPatternError(value, timezone);
    if (problem) return { problem };
    return { text: describeCron(value), runs: nextCronRuns(value, 3, timezone) };
  }, [value, asText, editorProblem, timezone]);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-neutral-700">{label}</span>
        <button
          type="button"
          disabled={asText && !canUseFields}
          title={asText && !canUseFields ? 'This expression uses syntax the slots cannot show' : undefined}
          className="text-xs text-neutral-400 hover:text-neutral-700 disabled:cursor-not-allowed disabled:text-neutral-300"
          onClick={() => setAsText(!asText)}
        >
          {asText ? 'Edit as fields' : 'Edit as text'}
        </button>
      </div>

      {asText ? (
        <input
          className={`${inputClass} font-mono`}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        // One box, five seamless slots: it reads as the cron line it is, and each part is
        // still its own input.
        <div
          className={`flex w-full rounded-lg border bg-surface px-1 py-1 focus-within:border-neutral-500 ${
            editorProblem ? 'border-red-400' : 'border-neutral-300'
          }`}
        >
          {CRON_FIELDS.map((field, i) => (
            <label
              key={field.key}
              title={`${field.label} (${field.hint})`}
              // min-w-0 + size=1: an input's intrinsic ~20-character width would otherwise
              // stop the five slots from ever shrinking to fit a half-width cell.
              className="flex min-w-0 flex-1 cursor-text flex-col items-center rounded-md px-0.5 py-0.5 hover:bg-neutral-50 focus-within:bg-neutral-100"
            >
              <input
                className={`w-full bg-transparent text-center font-mono text-sm outline-none ${
                  errors[i] ? 'text-red-600' : 'text-neutral-900'
                }`}
                value={parts[i] ?? ''}
                size={1}
                spellCheck={false}
                autoComplete="off"
                aria-label={field.label}
                aria-invalid={errors[i] ? true : undefined}
                onChange={(e) => setPart(i, e.target.value)}
              />
              <span className="mt-0.5 text-[10px] leading-none text-neutral-400">{field.short}</span>
            </label>
          ))}
        </div>
      )}

      <CronSummary preview={preview} timezone={timezone} />
    </div>
  );
}

/** One hint-sized line under the box: what this schedule does, or why it cannot run. */
function CronSummary({
  preview,
  timezone,
}: {
  preview: { problem: string } | { text: string | null; runs: Date[] };
  timezone?: string;
}) {
  if ('problem' in preview) {
    return <span className="mt-1 block text-xs text-red-600">{preview.problem}</span>;
  }
  if (preview.runs.length === 0) {
    return <span className="mt-1 block text-xs text-amber-700">No date ever matches this.</span>;
  }
  return (
    <span
      className="mt-1 block text-xs text-neutral-500"
      // The words are the answer; the exact next runs are there for anyone who wants to check.
      title={`Next: ${preview.runs.map((run) => formatRunTime(run, timezone)).join(' · ')}`}
    >
      {preview.text ?? `Next run ${formatRunTime(preview.runs[0]!, timezone)}`}
      {timezone && <span className="text-neutral-400"> ({timezone})</span>}
    </span>
  );
}
