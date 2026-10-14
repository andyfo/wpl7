// @docs automations/reminders
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ReminderDto } from '../../../shared/reminders';
import { Icon } from './Icon';

function shortDate(date: string, today: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  });
}

export function ReminderTask({
  reminder: r,
  today,
  serverName,
  busy,
  canSnooze,
  onComplete,
  onReopen,
  onSnooze,
  onEdit,
  onDelete,
}: {
  reminder: ReminderDto;
  today: string;
  serverName?: string;
  busy: boolean;
  canSnooze: boolean;
  onComplete: () => void;
  onReopen: () => void;
  onSnooze: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const completed = r.state === 'done';
  const pending = r.state === 'pending';
  const singleSite = r.affectedSites.length === 1 ? r.affectedSites[0] : undefined;
  const repeats = r.kind === 'recurring' || (r.kind === 'domain' && !r.automatic);
  const status = r.urgent
    ? 'Needs attention'
    : r.state === 'overdue'
      ? 'Overdue'
      : r.state === 'warning'
        ? 'Due soon'
        : pending
          ? 'Awaiting confirmation'
          : r.state === 'snoozed' && r.snoozedUntil
            ? `Snoozed until ${shortDate(r.snoozedUntil, today)}`
            : null;
  const dateColor =
    r.urgent || r.state === 'overdue' || r.state === 'due' ? 'text-red-700' : r.state === 'warning' ? 'text-amber-700' : 'text-neutral-500';
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      if (!actions.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <li className="flex items-start gap-2 px-3 py-3 hover:bg-neutral-50 sm:gap-3 sm:px-5">
      <button
        type="button"
        role="checkbox"
        aria-checked={pending ? 'mixed' : completed}
        aria-label={`${pending ? 'Undo done for' : completed ? 'Reopen' : 'Complete'} ${r.title}`}
        title={pending ? 'Undo done' : completed ? 'Reopen' : r.kind === 'domain' ? 'Mark renewed' : 'Done'}
        disabled={busy}
        onClick={pending ? onReopen : onComplete}
        className="group flex size-8 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`flex size-5 items-center justify-center rounded-full border transition-colors ${
            completed
              ? 'border-neutral-400 bg-neutral-400 text-surface'
              : 'border-neutral-300 text-neutral-500 group-hover:border-[var(--accent)] group-hover:text-[var(--accent)]'
          }`}
        >
          {pending ? (
            <Icon name="clock" size={13} />
          ) : (
            <span className={completed ? '' : 'opacity-0 group-hover:opacity-100'}>
              <Icon name="check" size={13} />
            </span>
          )}
        </span>
      </button>
      <div className="min-w-0 flex-1 pt-1 sm:flex sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={`block max-w-full break-words text-left text-sm leading-6 hover:underline ${completed ? 'text-neutral-500 line-through' : 'font-medium'}`}
            onClick={onEdit}
          >
            {r.title}
          </button>
          {(repeats || r.serverId || r.affectedSites.length > 0) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
              {repeats && (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="refresh" size={12} />
                  Every {r.every > 1 ? `${r.every} ${r.unit}` : r.unit.slice(0, -1)}
                </span>
              )}
              {r.serverId && (
                <Link className="hover:underline" to={`/servers/${r.serverId}`}>
                  {serverName ?? 'Server'}
                </Link>
              )}
              {singleSite && (
                <Link className="break-words hover:underline" to={`/sites/${singleSite.slug}`}>
                  {singleSite.title}
                </Link>
              )}
              {r.affectedSites.length > 1 && (
                <details className="group/sites min-w-0">
                  <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-neutral-800 [&::-webkit-details-marker]:hidden">
                    {r.affectedSites.length} sites
                    <span className="transition-transform group-open/sites:rotate-180">
                      <Icon name="chevron" size={12} />
                    </span>
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {r.affectedSites.map((site) => (
                      <Link key={site.id} className="break-words hover:underline" to={`/sites/${site.slug}`}>
                        {site.title}
                      </Link>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
          {r.note && (
            <p className="mt-1 truncate text-xs text-neutral-500" title={r.note}>
              {r.note}
            </p>
          )}
          {r.problem && <p className="mt-1 text-xs text-amber-700">{r.problem}</p>}
        </div>
        <div
          className={`mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-6 sm:mt-0 sm:shrink-0 sm:flex-col sm:items-end ${dateColor}`}
        >
          <time dateTime={r.dueDate} title={`Due ${r.dueDate}`} className="tabular-nums">
            {r.state === 'due' ? 'Today' : shortDate(r.dueDate, today)}
          </time>
          {status && <span className="leading-5">{status}</span>}
        </div>
      </div>
      <div
        ref={actions}
        className="relative shrink-0"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
        }}
      >
        <button
          ref={trigger}
          type="button"
          aria-label={`Actions for ${r.title}`}
          aria-expanded={open}
          aria-controls={`reminder-actions-${r.id}`}
          className="flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          onClick={() => setOpen(!open)}
        >
          <Icon name="more" size={18} />
        </button>
        {open && (
          <div
            id={`reminder-actions-${r.id}`}
            className="absolute right-0 z-30 mt-1 w-40 rounded-lg border border-neutral-200 bg-surface p-1 shadow-lg"
          >
            {!completed && r.pendingUntil !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => pick(onReopen)}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-50"
              >
                <Icon name="refresh" size={15} />
                Undo done
              </button>
            )}
            {!completed && (
              <button
                type="button"
                disabled={busy || !canSnooze}
                onClick={() => pick(onSnooze)}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-50"
              >
                <Icon name="clock" size={15} />
                Snooze
              </button>
            )}
            <button
              type="button"
              onClick={() => pick(onEdit)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-neutral-100"
            >
              <Icon name="pencil" size={15} />
              Edit
            </button>
            <button
              type="button"
              onClick={() => pick(onDelete)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-red-700 hover:bg-neutral-100"
            >
              <Icon name="trash" size={15} />
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
