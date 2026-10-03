import { Link } from 'react-router';
import type { JobStatus } from '../../../../shared/schemas';
import type { ScheduleDto, ScheduleRunDto } from '../../../../shared/types';
import { SCHEDULE_ACTION_INFO } from '../../../../shared/scheduleActions';
import { Button, Spinner, Toggle } from '../ui';
import { Icon, type IconName } from '../Icon';
import { formatRunTime } from '../../lib/cron';
import { formatDate, formatDuration, timeAgo, timeUntil } from '../../lib/format';
import { isPaused, nextRunsTooltip, targetText, type ServerName } from '../../lib/schedules';

/**
 * Something to say under a schedule's row until it is dismissed: how a Run now went, or a
 * failure. `before` is the schedule's last run as it was when Run now was pressed - the
 * panel's own clock, so the browser's cannot make a finished run look unfinished.
 */
export type ScheduleNote =
  | { kind: 'run'; run: ScheduleRunDto; before: number | null }
  | { kind: 'error'; error: unknown };

export interface ScheduleTableProps {
  items: ScheduleDto[];
  now: number;
  timezone?: string;
  servers: readonly ServerName[];
  /** The row a link pointed at (#schedule-<id>), marked for a moment. */
  highlight: number | null;
  /** Schedules with a pause or resume on its way. */
  busy: ReadonlySet<number>;
  notes: ReadonlyMap<number, ScheduleNote>;
  /** Set while the panel is read-only: why nothing here can be changed. */
  readOnly?: string;
  onToggle: (s: ScheduleDto, enabled: boolean) => void;
  onRun: (s: ScheduleDto) => void;
  onEdit: (s: ScheduleDto) => void;
  onDelete: (s: ScheduleDto) => void;
  onDismissNote: (id: number) => void;
}

const OUTCOME_DOTS: Record<string, string> = {
  ok: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-amber-400',
};
const OUTCOME_WORDS: Record<string, string> = { ok: 'Ran fine', failed: 'Failed', skipped: 'Did nothing' };

const JOB_COUNT_TONES: [JobStatus, string, string][] = [
  ['running', 'running', 'text-sky-700'],
  ['queued', 'queued', 'text-amber-700'],
  ['succeeded', 'ok', 'text-emerald-700'],
  ['failed', 'failed', 'text-red-700'],
  ['canceled', 'canceled', 'text-neutral-500'],
];

/** "Once, Sun 28 Sep, 03:00" - the API's text for a one-off is an ISO timestamp. */
function cadenceText(s: ScheduleDto, timezone?: string): string {
  if (s.cadence.runAt && !s.cadence.cron) return `Once, ${formatRunTime(new Date(s.cadence.runAt), timezone)}`;
  return s.cadence.text;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function skipsText(skipped: ScheduleRunDto['skipped'], max = 3): string {
  const listed = skipped
    .slice(0, max)
    .map((s) => (s.siteSlug ? `${s.siteSlug} (${s.reason})` : s.reason))
    .join(', ');
  return skipped.length > max ? `${listed} and ${skipped.length - max} more` : listed;
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

function NextCell({ s, now, timezone }: { s: ScheduleDto; now: number; timezone?: string }) {
  if (s.running) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-sky-700">
        <Spinner /> Running now
      </span>
    );
  }
  if (s.finished) return <span className="text-xs text-neutral-400">Done</span>;
  if (!s.enabled) return <span className="text-xs font-medium text-amber-700">Paused</span>;
  if (s.nextRunAt === null) return <span className="text-neutral-300">–</span>;
  return (
    <span className="whitespace-nowrap text-xs text-neutral-700" title={formatRunTime(new Date(s.nextRunAt), timezone)}>
      {timeUntil(s.nextRunAt, now)}
    </span>
  );
}

function LastCell({ s, now }: { s: ScheduleDto; now: number }) {
  if (s.lastRunAt === null) return <span className="text-xs text-neutral-400">Never</span>;
  const result = s.lastResult;
  const counts = s.lastJobs ? JOB_COUNT_TONES.filter(([status]) => (s.lastJobs?.[status] ?? 0) > 0) : [];
  return (
    <div className="max-w-xs space-y-0.5 text-xs">
      <div className="flex items-center gap-1.5 whitespace-nowrap text-neutral-700">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${OUTCOME_DOTS[s.lastOutcome ?? ''] ?? 'bg-neutral-300'}`}
          title={OUTCOME_WORDS[s.lastOutcome ?? ''] ?? undefined}
        />
        <span title={formatDate(s.lastRunAt)}>{timeAgo(s.lastRunAt, now)}</span>
        {s.lastDurationMs !== null && <span className="text-neutral-400">· {formatDuration(s.lastDurationMs)}</span>}
      </div>
      {counts.length > 0 && (
        <div className="text-neutral-500">
          {plural(Object.values(s.lastJobs ?? {}).reduce((n, c) => n + (c ?? 0), 0), 'job')}:{' '}
          {counts.map(([status, word, tone], i) => (
            <span key={status} className={tone}>
              {i > 0 && ', '}
              {s.lastJobs?.[status]} {word}
            </span>
          ))}
        </div>
      )}
      {result?.message && <div className="text-neutral-500">{result.message}</div>}
      {result && result.skipped.length > 0 && (
        <div
          className="text-amber-700"
          title={result.skipped.map((k) => (k.siteSlug ? `${k.siteSlug}: ${k.reason}` : k.reason)).join('\n')}
        >
          {plural(result.skipped.length, 'site')} skipped
        </div>
      )}
      {s.lastError && (
        <div className="truncate text-red-700" title={s.lastError}>
          {s.lastError}
        </div>
      )}
      {s.group !== 'background' && (
        <Link to={`/jobs?scheduleId=${s.id}`} className="text-neutral-500 underline hover:text-neutral-800">
          View runs
        </Link>
      )}
    </div>
  );
}

function ActiveCell({
  s,
  busy,
  readOnly,
  onToggle,
}: {
  s: ScheduleDto;
  busy: boolean;
  readOnly?: string;
  onToggle: (enabled: boolean) => void;
}) {
  if (!s.pausable) {
    return (
      <div className="max-w-52 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-1 font-medium text-neutral-700">
          <Icon name="lock" size={13} />
          Always on
        </span>
        {s.lockedReason && <p className="mt-0.5">{s.lockedReason}</p>}
      </div>
    );
  }
  const title = readOnly ?? (s.finished ? 'It has run. Edit it and give it a new time to run it again.' : undefined);
  return (
    <span title={title} className="inline-block">
      <Toggle
        checked={s.enabled}
        busy={busy}
        disabled={!!readOnly || s.finished}
        onChange={onToggle}
        label={<span className="sr-only">{s.enabled ? `Pause ${s.name}` : `Resume ${s.name}`}</span>}
      />
    </span>
  );
}

function NoteRow({ s, note, now, onDismiss }: { s: ScheduleDto; note: ScheduleNote; now: number; onDismiss: () => void }) {
  let tone = 'bg-sky-50 text-sky-800';
  let body: React.ReactNode;
  if (note.kind === 'error') {
    tone = 'bg-red-50 text-red-700';
    body = note.error instanceof Error ? note.error.message : String(note.error);
  } else if (note.run.running) {
    // A background task answers at once and runs on; the page polls it until it is done.
    const recorded = s.lastRunAt !== null && s.lastRunAt !== note.before;
    body = !s.running ? (
      recorded ? (
        <>
          Finished {timeAgo(s.lastRunAt, now)}
          {s.lastOutcome === 'failed'
            ? ` with an error${s.lastError ? `: ${s.lastError}` : '.'}`
            : s.lastResult?.message
              ? `: ${s.lastResult.message}`
              : '.'}
        </>
      ) : (
        'Finished.'
      )
    ) : (
      <span className="inline-flex items-center gap-2">
        <Spinner /> Running…
      </span>
    );
  } else {
    const { jobs, skipped } = note.run;
    body = (
      <>
        {jobs.length > 0 ? `Started ${plural(jobs.length, 'job')}` : 'No job was queued'}
        {skipped.length > 0 && ` · ${skipped.length} skipped: ${skipsText(skipped)}`}
        {jobs.length === 0 && skipped.length === 0 && s.lastResult?.message && ` · ${s.lastResult.message}`}
        {jobs.length > 0 && (
          <>
            {' · '}
            <Link
              className="font-medium underline"
              to={jobs.length === 1 ? `/jobs/${jobs[0]!.id}` : `/jobs?scheduleId=${s.id}`}
            >
              {jobs.length === 1 ? 'View job' : 'View jobs'}
            </Link>
          </>
        )}
      </>
    );
  }
  return (
    <tr>
      <td colSpan={6} className="pb-3">
        <div className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-xs ${tone}`}>
          <div className="min-w-0">{body}</div>
          <button type="button" aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100" onClick={onDismiss}>
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

function Actions({ s, readOnly, props }: { s: ScheduleDto; readOnly?: string; props: ScheduleTableProps }) {
  return (
    <div className="flex items-center gap-1 md:justify-end">
      <Button
        small
        variant="secondary"
        disabled={!!readOnly || s.running}
        title={
          readOnly ??
          (s.running
            ? 'A run is already under way'
            : isPaused(s)
              ? 'Runs it once now; it stays paused'
              : 'Runs it once now, whatever its schedule says')
        }
        onClick={() => props.onRun(s)}
      >
        <span className="whitespace-nowrap">Run now</span>
      </Button>
      {s.kind === 'custom' && (
        <>
          <IconButton icon="pencil" label={`Edit ${s.name}`} disabled={!!readOnly} title={readOnly} onClick={() => props.onEdit(s)} />
          <IconButton icon="trash" label={`Delete ${s.name}`} disabled={!!readOnly} title={readOnly} onClick={() => props.onDelete(s)} />
        </>
      )}
    </div>
  );
}

/**
 * Schedules as rows: what, when, what is next, how the last run went, the pause switch and
 * the actions. Each schedule is its own <tbody> - the anchor a link lands on - so the note a
 * Run now leaves stays with its row. Below `md` the columns fold into the first cell: six
 * columns do not fit a phone, and a table that scrolls sideways hides the switch people came for.
 */
export function ScheduleTable(props: ScheduleTableProps) {
  const { items, now, timezone, servers, highlight, busy, notes, readOnly } = props;
  return (
    <table className="w-full text-sm">
      <thead className="hidden md:table-header-group">
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
          <th className="pb-2 pr-3">Schedule</th>
          <th className="pb-2 pr-3">When</th>
          <th className="pb-2 pr-3">Next</th>
          <th className="pb-2 pr-3">Last run</th>
          <th className="pb-2 pr-3">Active</th>
          <th className="pb-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      {items.map((s) => {
        const info = s.action ? SCHEDULE_ACTION_INFO[s.action] : undefined;
        const note = notes.get(s.id);
        const ownDescription = s.kind === 'custom' && s.description && s.description !== info?.description;
        return (
          <tbody
            key={s.id}
            id={`schedule-${s.id}`}
            className={`scroll-mt-24 transition-colors duration-700 ${highlight === s.id ? 'bg-amber-50' : ''}`}
          >
            <tr className="border-t border-neutral-100 align-top">
              <td className="py-3 pr-3">
                <div className="font-medium text-neutral-900">{s.name}</div>
                {s.kind === 'custom' ? (
                  <>
                    <div className="text-xs text-neutral-500">
                      {info?.label ?? s.action}
                      {s.target && s.target.kind !== 'panel' && ` · ${targetText(s.target, servers, s.action)}`}
                      {s.createdBy && ` · by ${s.createdBy}`}
                    </div>
                    {ownDescription && <p className="line-clamp-2 max-w-md text-xs text-neutral-500">{s.description}</p>}
                    {s.missing.length > 0 && (
                      <div className="text-xs text-amber-700">
                        {s.missing.join(', ')} {s.missing.length === 1 ? 'no longer exists' : 'no longer exist'}; runs skip{' '}
                        {s.missing.length === 1 ? 'it' : 'them'}.
                      </div>
                    )}
                  </>
                ) : (
                  <p className="line-clamp-2 max-w-md text-xs text-neutral-500" title={s.description}>
                    {s.description}
                  </p>
                )}
                {s.settingsHref && (
                  <Link to={s.settingsHref} className="text-xs text-neutral-500 underline hover:text-neutral-800">
                    Change in Settings
                  </Link>
                )}
                <div className="mt-2 space-y-2 md:hidden">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-neutral-600">
                    <span title={nextRunsTooltip(s, timezone)}>{cadenceText(s, timezone)}</span>
                    <span className="text-neutral-300">·</span>
                    <NextCell s={s} now={now} timezone={timezone} />
                  </div>
                  <LastCell s={s} now={now} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <ActiveCell
                      s={s}
                      busy={busy.has(s.id)}
                      readOnly={readOnly}
                      onToggle={(enabled) => props.onToggle(s, enabled)}
                    />
                    <Actions s={s} readOnly={readOnly} props={props} />
                  </div>
                </div>
              </td>
              <td className="hidden py-3 pr-3 text-xs text-neutral-600 md:table-cell" title={nextRunsTooltip(s, timezone)}>
                <span className="block max-w-48">{cadenceText(s, timezone)}</span>
              </td>
              <td className="hidden py-3 pr-3 md:table-cell">
                <NextCell s={s} now={now} timezone={timezone} />
              </td>
              <td className="hidden py-3 pr-3 md:table-cell">
                <LastCell s={s} now={now} />
              </td>
              <td className="hidden py-3 pr-3 md:table-cell">
                <ActiveCell
                  s={s}
                  busy={busy.has(s.id)}
                  readOnly={readOnly}
                  onToggle={(enabled) => props.onToggle(s, enabled)}
                />
              </td>
              <td className="hidden py-3 md:table-cell">
                <Actions s={s} readOnly={readOnly} props={props} />
              </td>
            </tr>
            {note && <NoteRow s={s} note={note} now={now} onDismiss={() => props.onDismissNote(s.id)} />}
          </tbody>
        );
      })}
    </table>
  );
}
