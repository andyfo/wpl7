// @docs sites/php
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_SITE_CRON_LINES, type SiteCronLineInput } from '../../../../shared/schemas';
import { cronError } from '../../../../shared/cron';
import type { SiteCronLineDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useMeta } from '../../api/hooks';
import { timeAgo, timeUntil } from '../../lib/format';
import { CronField } from '../CronField';
import { Button, Card, ErrorNote, Field, Modal, Spinner, Toggle, inputClass } from '../ui';

const STOP_AFTER = [1, 2, 5, 10, 15, 30, 60];

type Draft = { id?: number; expr: string; command: string; enabled: boolean; timeoutMin: number };

const inputOf = (line: SiteCronLineDto): SiteCronLineInput => ({
  id: line.id,
  expr: line.expr,
  command: line.command,
  enabled: line.enabled,
  timeoutMin: line.timeoutMin,
});

/** "12 s", "3 min", "1 h 5 min". */
function took(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * A PHP site's cron lines: commands run in its folder on a schedule, at most every minute. Not
 * jobs: a run holds nothing, and only its last result is kept, on its line.
 */
export function CronCard({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const meta = useMeta();
  const query = useQuery({
    queryKey: ['site-cron', slug],
    queryFn: () => api<{ lines: SiteCronLineDto[] }>(`/api/sites/${slug}/cron`),
    // A run's end shows within a quarter minute; quicker while one is going.
    refetchInterval: (q) => (q.state.data?.lines.some((l) => l.running) ? 3000 : 15_000),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState<number | null>(null);

  if (query.isError && !query.data) return <ErrorNote error={query.error} />;
  const lines = query.data?.lines ?? [];

  const put = (next: SiteCronLineInput[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    return api<{ lines: SiteCronLineDto[] }>(`/api/sites/${slug}/cron`, { method: 'PUT', body: { lines: next } })
      .then((res) => {
        qc.setQueryData(['site-cron', slug], res);
        return true;
      })
      .catch((err: unknown) => {
        setError(err);
        return false;
      })
      .finally(() => setSaving(false));
  };
  const saveDraft = (d: Draft) => {
    const others = lines.filter((l) => l.id !== d.id).map(inputOf);
    const edited = { ...(d.id !== undefined ? { id: d.id } : {}), expr: d.expr, command: d.command, enabled: d.enabled, timeoutMin: d.timeoutMin };
    const next = d.id === undefined ? [...others, edited] : lines.map((l) => (l.id === d.id ? edited : inputOf(l)));
    void put(next).then((ok) => ok && setDraft(null));
  };
  const runNow = (id: number) => {
    setStarting(id);
    setError(null);
    void api(`/api/sites/${slug}/cron/${id}/run`, { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: ['site-cron', slug] }))
      .catch(setError)
      .finally(() => setStarting(null));
  };
  const full = lines.length >= MAX_SITE_CRON_LINES;

  return (
    <Card
      title="Cron"
      action={
        <span title={full ? `${MAX_SITE_CRON_LINES} lines at most.` : undefined}>
          <Button small disabled={full} onClick={() => setDraft({ expr: '*/5 * * * *', command: '', enabled: true, timeoutMin: 5 })}>
            Add line
          </Button>
        </span>
      }
    >
      {!query.data ? (
        <Spinner />
      ) : lines.length === 0 ? (
        <p className="text-sm text-neutral-500">No cron lines. Each runs a command in the site's folder on a schedule.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 text-sm">
          {lines.map((line) => (
            <li key={line.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className={line.enabled ? 'font-medium' : 'font-medium text-neutral-400'}>
                    {line.schedule.replace(/\.$/, '')} <code className="ml-1 text-xs font-normal text-neutral-400">{line.expr}</code>
                  </div>
                  <code className="mt-0.5 block break-all text-xs text-neutral-700">{line.command}</code>
                  <div className="mt-1 text-xs text-neutral-500">
                    <LastRun line={line} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Toggle
                    checked={line.enabled}
                    disabled={saving}
                    label={line.enabled ? 'On' : 'Off'}
                    onChange={(enabled) => void put(lines.map((l) => (l.id === line.id ? { ...inputOf(l), enabled } : inputOf(l))))}
                  />
                  <span title={line.running ? 'It is running.' : undefined}>
                    <Button small variant="secondary" disabled={line.running} busy={starting === line.id} onClick={() => runNow(line.id)}>
                      Run now
                    </Button>
                  </span>
                  <Button small variant="ghost" onClick={() => setDraft({ ...inputOf(line), enabled: line.enabled })}>
                    Edit
                  </Button>
                  <Button small variant="ghost" disabled={saving} onClick={() => void put(lines.filter((l) => l.id !== line.id).map(inputOf))}>
                    Delete
                  </Button>
                </div>
              </div>
              {line.last?.output ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600">Last output</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-700">{line.last.output}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
      {draft && (
        <CronLineDialog draft={draft} timezone={meta.data?.timezone} saving={saving} error={error} onSave={saveDraft} onClose={() => setDraft(null)} />
      )}
    </Card>
  );
}

function LastRun({ line }: { line: SiteCronLineDto }) {
  const last = line.last;
  // Due for longer than a tick takes is a line waiting for its site: it runs once the site can.
  const next =
    !line.enabled || line.nextRunAt === null || line.running
      ? ''
      : line.nextRunAt < Date.now() - 90_000
        ? ' · waiting for the site'
        : ` · next ${timeUntil(line.nextRunAt)}`;
  if (line.running) return <span className="text-sky-700">Running since {timeAgo(last?.startedAt ?? Date.now())}</span>;
  if (!last) return <span>Not run yet{next}</span>;
  const ok = last.exitCode === 0 && last.error === null;
  return (
    <span>
      <span className={ok ? 'text-emerald-700' : 'text-red-700'}>
        {last.error ?? (last.exitCode === null ? 'Ended' : `Exit ${last.exitCode}`)}
      </span>
      {' · '}
      {timeAgo(last.startedAt)}
      {last.ms !== null ? `, took ${took(last.ms)}` : ''}
      {next}
    </span>
  );
}

function CronLineDialog({
  draft,
  timezone,
  saving,
  error,
  onSave,
  onClose,
}: {
  draft: Draft;
  timezone: string | undefined;
  saving: boolean;
  error: unknown;
  onSave: (d: Draft) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState(draft);
  const problem = cronError(d.expr) ?? (d.command.trim() === '' ? 'Enter a command.' : null);
  return (
    <Modal title={draft.id === undefined ? 'Add cron line' : 'Edit cron line'} onClose={onClose} dismissible={false}>
      <div className="space-y-4 text-sm">
        <CronField label="Schedule" value={d.expr} onChange={(expr) => setD({ ...d, expr })} timezone={timezone} />
        <Field label="Command" hint="Runs in the site's folder as its user, as with sh -c.">
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={3}
            value={d.command}
            placeholder="php artisan schedule:run"
            onChange={(e) => setD({ ...d, command: e.target.value })}
          />
        </Field>
        <Field label="Stop after" width="sm">
          <select className={inputClass} value={d.timeoutMin} onChange={(e) => setD({ ...d, timeoutMin: Number(e.target.value) })}>
            {[...new Set([...STOP_AFTER, d.timeoutMin])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {m} {m === 1 ? 'minute' : 'minutes'}
              </option>
            ))}
          </select>
        </Field>
        <Toggle checked={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} label="On" />
        <ErrorNote error={error} />
        <div className="flex items-center justify-end gap-2">
          {problem && <span className="mr-auto text-xs text-neutral-500">{problem}</span>}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <span title={problem ?? undefined}>
            <Button disabled={problem !== null} busy={saving} onClick={() => onSave(d)}>
              Save
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
