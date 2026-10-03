import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ScheduleDto, ScheduleRunDto } from '../../../shared/types';
import { MAX_CUSTOM_SCHEDULES, SCHEDULE_ACTION_INFO } from '../../../shared/scheduleActions';
import { api } from '../api/client';
import { useMeta, useNow, useSchedules } from '../api/hooks';
import { Button, Card, EmptyState, ErrorNote, inputClass, Spinner } from '../components/ui';
import { ActionDialog } from '../components/files/common';
import { ScheduleEditor } from '../components/schedules/ScheduleEditor';
import { ScheduleTable, type ScheduleNote } from '../components/schedules/ScheduleTable';
import { timeAgo } from '../lib/format';
import { backgroundSummary, isPaused, sortSchedules, targetText } from '../lib/schedules';

type Confirm = { kind: 'run' | 'pause' | 'delete'; schedule: ScheduleDto };

/** Custom schedules past this many get a filter box. */
const FILTER_FROM = 10;

/**
 * Everything the panel runs on its own, in three groups: the built-in schedules that queue
 * jobs, the custom ones (made here or by an integration), and the background ticks that keep
 * monitoring and upkeep going. Each can be run now; most can be paused.
 */
export function Schedules() {
  const schedules = useSchedules();
  const meta = useMeta();
  const qc = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const now = useNow(5000);
  const [editing, setEditing] = useState<ScheduleDto | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [notes, setNotes] = useState<ReadonlyMap<number, ScheduleNote>>(new Map());
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState<number | null>(null);
  /** A row to bring into view once it is on the page: a schedule just created or saved. */
  const [reveal, setReveal] = useState<number | null>(null);
  const [forceBackground, setForceBackground] = useState(false);

  const items = schedules.data ?? [];
  const servers = meta.data?.servers ?? [];
  const tz = meta.data?.timezone;
  const readOnly = meta.data?.maintenance
    ? `${meta.data.maintenance.reason}: the panel is read-only until it finishes`
    : undefined;

  const builtinJobs = items.filter((s) => s.group === 'jobs');
  const background = items.filter((s) => s.group === 'background');
  const custom = useMemo(() => sortSchedules(items.filter((s) => s.group === 'custom')), [items]);
  const paused = items.filter(isPaused);
  const needle = filter.trim().toLowerCase();
  const shownCustom = needle
    ? custom.filter((s) =>
        [s.name, s.action ? SCHEDULE_ACTION_INFO[s.action]?.label : '', targetText(s.target, servers, s.action), s.createdBy ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : custom;

  // Folded unless something there needs a look, or the reader opened it (?background=1).
  const backgroundParam = params.get('background');
  const backgroundAttention = background.some((s) => s.lastOutcome === 'failed' || isPaused(s));
  const backgroundOpen =
    forceBackground || backgroundParam === '1' || (backgroundParam === null && backgroundAttention);
  const setBackgroundOpen = (open: boolean) => {
    setForceBackground(false);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (open) next.set('background', '1');
        else if (backgroundAttention) next.set('background', '0');
        else next.delete('background');
        return next;
      },
      { replace: true },
    );
  };

  // #schedule-<id> (or a built-in's key: #schedule-backups) lands on that row and marks it.
  // Once per hash: polling re-renders must not scroll the page back there.
  const handledHash = useRef<string | null>(null);
  const hashKey = /^#schedule-([a-z0-9-]{1,40})$/.exec(location.hash)?.[1] ?? null;
  const target = hashKey ? items.find((s) => String(s.id) === hashKey || s.key === hashKey) : undefined;
  useEffect(() => {
    if (!target || handledHash.current === location.hash) return;
    if (target.group === 'background' && !backgroundOpen) {
      // Opened for the link without touching the URL, which would drop the hash.
      setForceBackground(true);
      return;
    }
    const el = document.getElementById(`schedule-${target.id}`);
    if (!el) return;
    handledHash.current = location.hash;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(target.id);
  }, [target, backgroundOpen, location.hash]);
  useEffect(() => {
    if (reveal === null) return;
    const el = document.getElementById(`schedule-${reveal}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setHighlight(reveal);
    setReveal(null);
  }, [reveal, items]);
  useEffect(() => {
    if (highlight === null) return;
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  const note = (id: number, value: ScheduleNote | null) =>
    setNotes((prev) => {
      const next = new Map(prev);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });

  const refresh = async (s?: ScheduleDto) => {
    await qc.invalidateQueries({ queryKey: ['schedules'] });
    // The site pages say when scheduled backups are paused (GET /meta, backupsPaused).
    if (s?.key === 'backups') void qc.invalidateQueries({ queryKey: ['meta'] });
  };

  const setEnabled = async (s: ScheduleDto, enabled: boolean) => {
    setBusy((prev) => new Set(prev).add(s.id));
    note(s.id, null);
    try {
      await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled } });
      await refresh(s);
    } catch (err) {
      note(s.id, { kind: 'error', error: err });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };

  const toggle = (s: ScheduleDto, enabled: boolean) => {
    // Pausing a built-in stops something the panel relies on, so it says what first;
    // a custom schedule is the operator's own, and resuming anything is always safe.
    if (!enabled && s.kind === 'builtin') setConfirm({ kind: 'pause', schedule: s });
    else void setEnabled(s, enabled);
  };

  const runNow = async (s: ScheduleDto) => {
    note(s.id, null);
    const run = await api<ScheduleRunDto>(`/api/schedules/${s.id}/run`, { method: 'POST' });
    // Read the schedule again before saying anything: a background task is marked running
    // before the request is answered, so from here on its row tells running from finished.
    await refresh(s);
    note(s.id, { kind: 'run', run, before: s.lastRunAt });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };

  const run = (s: ScheduleDto) => {
    // A background tick is cheap and does nothing it would not do within minutes anyway;
    // anything that queues jobs is asked about first.
    if (s.group === 'background') void runNow(s).catch((err: unknown) => note(s.id, { kind: 'error', error: err }));
    else setConfirm({ kind: 'run', schedule: s });
  };

  const remove = async (s: ScheduleDto) => {
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    note(s.id, null);
    await refresh();
  };

  const table = (list: ScheduleDto[]) => (
    <ScheduleTable
      items={list}
      now={now}
      timezone={tz}
      servers={servers}
      highlight={highlight}
      busy={busy}
      notes={notes}
      readOnly={readOnly}
      onToggle={toggle}
      onRun={run}
      onEdit={(s) => setEditing(s)}
      onDelete={(s) => setConfirm({ kind: 'delete', schedule: s })}
      onDismissNote={(id) => note(id, null)}
    />
  );

  const atLimit = custom.length >= MAX_CUSTOM_SCHEDULES;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Schedules</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Everything the panel runs on its own. Times are on the server's clock{tz ? ` (${tz})` : ''}.
          </p>
        </div>
        <Button
          disabled={!!readOnly || atLimit}
          title={readOnly ?? (atLimit ? `There are already ${MAX_CUSTOM_SCHEDULES} custom schedules; delete one first` : undefined)}
          onClick={() => setEditing('new')}
        >
          New schedule
        </Button>
      </div>

      {paused.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">
            {paused.length === 1 ? '1 schedule is paused' : `${paused.length} schedules are paused`}
          </div>
          <ul className="mt-2 space-y-2">
            {paused.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <a href={`#schedule-${s.id}`} className="font-medium underline">
                    {s.name}
                  </a>
                  {s.pausedAt !== null && <span className="text-xs text-amber-800"> · paused {timeAgo(s.pausedAt, now)}</span>}
                  {s.pauseWarning && <p className="text-xs text-amber-800">{s.pauseWarning}</p>}
                </div>
                <Button
                  small
                  variant="secondary"
                  disabled={!!readOnly || busy.has(s.id)}
                  title={readOnly}
                  onClick={() => void setEnabled(s, true)}
                >
                  {busy.has(s.id) ? 'Resuming…' : 'Resume'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ErrorNote error={schedules.error} />

      {!schedules.data ? (
        schedules.isPending && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )
      ) : (
        <>
          <Card title="Scheduled jobs">
            <p className="mb-4 text-xs text-neutral-500">
              Built into the panel. Each run queues jobs you can follow in the{' '}
              <Link className="underline" to="/jobs">
                Jobs
              </Link>{' '}
              list.
            </p>
            {table(builtinJobs)}
          </Card>

          <Card
            title={`Custom schedules${custom.length > 0 ? ` (${custom.length})` : ''}`}
            action={
              custom.length > FILTER_FROM && (
                <input
                  className={`${inputClass} max-w-56`}
                  type="search"
                  placeholder="Filter schedules"
                  aria-label="Filter custom schedules"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )
            }
          >
            {custom.length === 0 ? (
              <EmptyState>
                No custom schedules yet. <b>New schedule</b> runs a backup, an update or a command on the sites you pick, on
                a timetable or once. Integrations can create them too, with <code>POST /api/schedules</code> — see the
                Docs tab under{' '}
                <Link className="underline" to="/api-keys">
                  API keys
                </Link>
                .
              </EmptyState>
            ) : shownCustom.length === 0 ? (
              <EmptyState>No custom schedule matches “{filter.trim()}”.</EmptyState>
            ) : (
              table(shownCustom)
            )}
          </Card>

          <Card
            title="Background tasks"
            action={
              <Button small variant="ghost" onClick={() => setBackgroundOpen(!backgroundOpen)}>
                {backgroundOpen ? 'hide' : 'show'}
              </Button>
            }
          >
            <p className={`text-xs text-neutral-500 ${backgroundOpen ? 'mb-4' : ''}`}>
              Monitoring and upkeep that runs inside the panel rather than as jobs.{' '}
              {!backgroundOpen && (
                <span className={backgroundAttention ? 'font-medium text-amber-800' : ''}>{backgroundSummary(background)}</span>
              )}
            </p>
            {backgroundOpen && table(background)}
          </Card>
        </>
      )}

      {editing && (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => setReveal(saved.id)}
        />
      )}

      {confirm?.kind === 'run' && (
        <ActionDialog
          title={`Run “${confirm.schedule.name}” now`}
          submitLabel="Run now"
          disabled={!!readOnly}
          disabledReason={readOnly}
          onClose={() => setConfirm(null)}
          onSubmit={() => runNow(confirm.schedule)}
        >
          <p className="text-neutral-700">
            {confirm.schedule.kind === 'custom' && confirm.schedule.action
              ? `${SCHEDULE_ACTION_INFO[confirm.schedule.action]?.label ?? confirm.schedule.action}${
                  confirm.schedule.target && confirm.schedule.target.kind !== 'panel'
                    ? ` on ${targetText(confirm.schedule.target, servers, confirm.schedule.action)}`
                    : ''
                }. `
              : `${confirm.schedule.description} `}
            The jobs it queues show up in the Jobs list.
          </p>
          {isPaused(confirm.schedule) && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              It is paused. This runs it once anyway, and it stays paused.
            </p>
          )}
        </ActionDialog>
      )}

      {confirm?.kind === 'pause' && (
        <ActionDialog
          title={`Pause “${confirm.schedule.name}”`}
          submitLabel="Pause"
          disabled={!!readOnly}
          disabledReason={readOnly}
          onClose={() => setConfirm(null)}
          onSubmit={async () => {
            await api(`/api/schedules/${confirm.schedule.id}`, { method: 'PATCH', body: { enabled: false } });
            await refresh(confirm.schedule);
          }}
        >
          <p className="text-neutral-700">
            {confirm.schedule.pauseWarning ?? 'It stops running on its own until you resume it.'}
          </p>
          <p className="text-xs text-neutral-500">Run now still works while it is paused, and Resume starts it again.</p>
        </ActionDialog>
      )}

      {confirm?.kind === 'delete' && (
        <ActionDialog
          title={`Delete “${confirm.schedule.name}”`}
          submitLabel="Delete"
          danger
          disabled={!!readOnly}
          disabledReason={readOnly}
          onClose={() => setConfirm(null)}
          onSubmit={() => remove(confirm.schedule)}
        >
          <p className="text-neutral-700">
            The schedule is removed and does not run again. The jobs it already ran stay in the Jobs list.
          </p>
        </ActionDialog>
      )}
    </div>
  );
}
