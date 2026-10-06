// @docs automations/jobs
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { JobDto } from '../../../shared/types';
import { jobInfo, jobLabel } from '../../../shared/jobTypes';
import { ApiError, api } from '../api/client';
import { isTerminal, useJob, useMeta, useNow, useSchedules } from '../api/hooks';
import { Button, Card, ChecksList, ErrorNote, JobStatusBadge, OutLink, Spinner } from '../components/ui';
import { JobLogViewer } from '../components/JobProgress';
import { ActionDialog } from '../components/files/common';
import { formatBytes, formatDate, formatDuration, timeAgo } from '../lib/format';
import { firstErrorSeq } from '../lib/jobLog';
import { TriggeredBy } from '../components/JobTriggeredBy';

/** The 409 a running job answers a cancel with: taken, and applied at its next safe step. */
const cancelWasRequested = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.status === 409 &&
  typeof err.details === 'object' &&
  err.details !== null &&
  (err.details as { cancelRequested?: unknown }).cancelRequested === true;

export function JobDetail() {
  const { id = '' } = useParams();
  const location = useLocation();
  // Back to the list as it was left - filters, page and all - when that is where we came from.
  const from = (location.state as { from?: unknown } | null)?.from;
  const backTo = `/jobs${typeof from === 'string' ? from : ''}`;
  const jobId = /^\d{1,12}$/.test(id) ? Number(id) : null;
  const { job, logs, error, isLoading, draining } = useJob(jobId);
  const meta = useMeta();
  const schedules = useSchedules({ live: false });
  const qc = useQueryClient();
  const live = !!job && !isTerminal(job.status);
  const now = useNow(live ? 1000 : 30_000);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const [jump, setJump] = useState<{ seq: number } | null>(null);

  const back = (
    <Link to={backTo} className="text-sm text-neutral-500 hover:text-neutral-900 hover:underline">
      ← All jobs
    </Link>
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (error || !job) {
    return (
      <div className="space-y-4">
        {back}
        <h1 className="page-title">Job #{id}</h1>
        <Card>
          <ErrorNote
            error={
              error instanceof ApiError && error.status === 404
                ? new Error(`Job #${id} does not exist — or it finished long enough ago that housekeeping removed it.`)
                : (error ?? new Error(`Job #${id} could not be loaded.`))
            }
          />
        </Card>
      </div>
    );
  }

  const stopping = job.status === 'running' && (job.cancelRequested || stopRequested);
  const cancelable = (job.status === 'queued' || job.status === 'running') && !stopping;
  const readOnly = meta.data?.maintenance ? 'The panel is read-only while it updates' : undefined;
  const firstError = firstErrorSeq(logs);
  const info = jobInfo(job.type);
  const scheduleName = (sid: number) => (schedules.data ?? []).find((s) => s.id === sid)?.name ?? null;
  const serverName = (sid: number) => meta.data?.servers.find((s) => s.id === sid)?.name ?? `Server #${sid}`;

  const cancel = async () => {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    } catch (err) {
      if (!cancelWasRequested(err)) throw err;
      // It started in the meantime (or was running): the request stands, the job stops at
      // its next safe step - a neutral outcome, not an error.
      setStopRequested(true);
    }
    await qc.invalidateQueries({ queryKey: ['job', job.id] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };

  const cancelQueued = () => {
    setCancelBusy(true);
    setCancelError(null);
    cancel()
      .catch(setCancelError)
      .finally(() => setCancelBusy(false));
  };

  const waited = job.startedAt !== null ? job.startedAt - job.createdAt : null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="page-title">{jobLabel(job.type)}</h1>
              <JobStatusBadge status={job.status} stopping={stopping} />
            </div>
            {job.summary && <p className="text-sm text-neutral-600">{job.summary}</p>}
            <p className="font-mono text-xs text-neutral-400">
              #{job.id} · {job.type}
            </p>
          </div>
          {cancelable && (
            <Button
              variant="secondary"
              disabled={cancelBusy || !!readOnly}
              title={readOnly}
              onClick={() => (job.status === 'queued' ? cancelQueued() : setConfirmCancel(true))}
            >
              {cancelBusy ? 'Canceling…' : 'Cancel job'}
            </Button>
          )}
        </div>
      </div>

      <ErrorNote error={cancelError} />
      {stopping && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          <Spinner />
          <span>
            <b>Stopping…</b> Cancellation requested. The job stops at its next safe step; what it already did is not
            rolled back.
          </span>
        </div>
      )}

      {job.error && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            job.status === 'failed' ? 'border-red-200 bg-red-50 text-red-800' : 'border-neutral-200 bg-neutral-50 text-neutral-700'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 whitespace-pre-wrap break-words">
              <b>{job.status === 'failed' ? 'Failed: ' : 'Note: '}</b>
              {job.error}
            </div>
            {firstError !== null && (
              <Button small variant="secondary" onClick={() => setJump({ seq: firstError })}>
                Show in log
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              {job.siteSlug && (
                <Detail label="Site">
                  <Link to={`/sites/${job.siteSlug}`} className="font-medium hover:underline">
                    {job.siteSlug}
                  </Link>
                </Detail>
              )}
              {job.serverId !== null && (
                <Detail label="Server">
                  <Link to={`/servers/${job.serverId}`} className="hover:underline">
                    {serverName(job.serverId)}
                  </Link>
                </Detail>
              )}
              <Detail label="Triggered by">
                <TriggeredBy job={job} scheduleName={scheduleName} />
              </Detail>
              <Detail label="Queued">
                <span title={formatDate(job.createdAt)}>
                  {formatDate(job.createdAt)} <span className="text-neutral-400">({timeAgo(job.createdAt, now)})</span>
                </span>
              </Detail>
              <Detail label="Started">
                {job.startedAt === null ? (
                  <span className="text-neutral-400">{job.status === 'queued' ? 'Not yet' : 'Never'}</span>
                ) : (
                  <>
                    {formatDate(job.startedAt)}
                    {waited !== null && waited > 2000 && (
                      <span className="text-neutral-400"> · waited {formatDuration(waited)}</span>
                    )}
                  </>
                )}
              </Detail>
              {job.status === 'running' && job.startedAt !== null ? (
                <Detail label="Running for">
                  <span className="text-sky-700">{formatDuration(now - job.startedAt)}</span>
                </Detail>
              ) : (
                <Detail label="Finished">
                  {job.finishedAt !== null ? formatDate(job.finishedAt) : <span className="text-neutral-400">–</span>}
                </Detail>
              )}
              {job.startedAt !== null && job.finishedAt !== null && (
                <Detail label="Took">{formatDuration(job.finishedAt - job.startedAt)}</Detail>
              )}
              {job.batchId !== null && (
                <Detail label="Bulk run">
                  <Link to={`/jobs?batchId=${job.batchId}`} className="hover:underline">
                    #{job.batchId} · every job of that run
                  </Link>
                </Detail>
              )}
            </dl>
          </Card>
        </div>
        <Card title="What this job does">
          <p className="text-sm text-neutral-600">{info?.description ?? 'A job type this version of the panel does not know.'}</p>
        </Card>
      </div>

      {job.result && Object.keys(job.result).length > 0 && (
        <Card title="Result">
          <ResultView job={job} result={job.result} serverName={serverName} />
        </Card>
      )}

      <Card title={logs.length > 0 ? `Log · ${logs.length.toLocaleString()} ${logs.length === 1 ? 'line' : 'lines'}` : 'Log'}>
        <JobLogViewer variant="full" logs={logs} job={job} draining={draining} jumpTo={jump} />
      </Card>

      {confirmCancel && (
        <ActionDialog
          title={`Cancel “${jobLabel(job.type)}”`}
          submitLabel="Cancel the job"
          danger
          disabled={!!readOnly}
          disabledReason={readOnly}
          onClose={() => setConfirmCancel(false)}
          onSubmit={cancel}
        >
          <p className="text-neutral-700">
            It is running. It stops at the next safe step; what it already did is not rolled back.
          </p>
        </ActionDialog>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------- the result

type Scalar = string | number | boolean | null;
const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v);

interface OpResult {
  kind: string;
  slug: string | null;
  action: string;
  ok: boolean;
  from: string | null;
  to: string | null;
  error: string | null;
}
const isOps = (v: unknown): v is OpResult[] =>
  Array.isArray(v) && v.length > 0 && v.every((o) => typeof o === 'object' && o !== null && typeof (o as OpResult).ok === 'boolean');

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const isChecks = (v: unknown): v is Check[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Check).name === 'string' &&
      typeof (c as Check).ok === 'boolean' &&
      typeof (c as Check).detail === 'string',
  );

const ACRONYMS: Record<string, string> = { id: 'ID', ip: 'IP', url: 'URL', php: 'PHP', dns: 'DNS', wp: 'WP' };

/** A backup, a server or another job named by id, shown as a link to it. */
const LINKED_ID = /(^b|B)ackupId$|(^s|S)erverId$|(^j|J)obId$/;

/**
 * `backupsPruned` -> "Backups pruned", `publicIp` -> "Public IP", `sizeBytes` -> "Size",
 * `preMoveBackupId` -> "Pre move backup" (its value is the link).
 */
function humanize(key: string): string {
  const base = /.Bytes$/.test(key) ? key.slice(0, -5) : LINKED_ID.test(key) ? key.slice(0, -2) : key;
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w] ?? w);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A credential the job reports once (a generated admin password): hidden until asked for. */
function Secret({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="text-xs">{shown ? value : '••••••••••'}</code>
      <button type="button" className="text-xs text-neutral-500 underline" onClick={() => setShown(!shown)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}

function ScalarValue({
  name,
  value,
  job,
  serverName,
}: {
  name: string;
  value: Scalar;
  job: JobDto;
  serverName: (id: number) => string;
}) {
  if (value === null) return <span className="text-neutral-400">–</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') {
    if (/bytes$/i.test(name)) return <span title={`${value.toLocaleString()} bytes`}>{formatBytes(value)}</span>;
    if (/(^b|B)ackupId$/.test(name)) {
      if (!job.siteSlug) return <>#{value}</>;
      // A deleted site has no Backups tab; the Backups list still has its backups.
      return job.type === 'site.delete' ? (
        <Link to={`/backups?siteSlug=${encodeURIComponent(job.siteSlug)}`} className="hover:underline">
          #{value} · Backups
        </Link>
      ) : (
        <Link to={`/sites/${job.siteSlug}?tab=backups`} className="hover:underline">
          #{value} · Backups tab
        </Link>
      );
    }
    if (/(^j|J)obId$/.test(name)) {
      return (
        <Link to={`/jobs/${value}`} className="hover:underline">
          #{value}
        </Link>
      );
    }
    if (/(^s|S)erverId$/.test(name)) {
      return (
        <Link to={`/servers/${value}`} className="hover:underline">
          {serverName(value)}
        </Link>
      );
    }
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  if (/password|secret|token/i.test(name)) return <Secret value={value} />;
  if (name === 'url' && /^https?:\/\//.test(value)) return <OutLink href={value}>{value}</OutLink>;
  return <span className="break-words">{value}</span>;
}

/**
 * What a job reported when it finished, read rather than dumped: flat values as labelled rows
 * (sizes as sizes, a backup as a link to it), a WordPress run's operations as a table, and a
 * server's checks as the pass/fail list. Anything else is shown as JSON, and the whole result
 * is there raw underneath.
 */
function ResultView({
  job,
  result,
  serverName,
}: {
  job: JobDto;
  result: Record<string, unknown>;
  serverName: (id: number) => string;
}) {
  const entries = Object.entries(result);
  const rows: [string, ReactNode][] = [];
  let ops: OpResult[] | null = null;
  let checks: Check[] | null = null;
  for (const [key, value] of entries) {
    if (key === 'ops' && isOps(value)) ops = value;
    else if (key === 'checks' && isChecks(value)) checks = value;
    else if (isScalar(value)) {
      rows.push([key, <ScalarValue name={key} value={value} job={job} serverName={serverName} />]);
    } else if (Array.isArray(value) && value.every(isScalar)) {
      rows.push([key, value.length === 0 ? <span className="text-neutral-400">none</span> : value.join(', ')]);
    } else {
      rows.push([
        key,
        <pre className="max-h-48 overflow-auto rounded-md bg-neutral-100 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>,
      ]);
    }
  }
  return (
    <div className="space-y-5">
      {rows.length > 0 && (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
          {rows.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-neutral-500">{humanize(key)}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {ops && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2 pr-3">Kind</th>
                <th className="pb-2 pr-3">Slug</th>
                <th className="pb-2 pr-3">Action</th>
                <th className="pb-2 pr-3">Outcome</th>
                <th className="pb-2 pr-3">Version</th>
                <th className="pb-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op, i) => (
                <tr key={`${op.kind}:${op.slug ?? ''}:${i}`} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3 text-neutral-600">{op.kind}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{op.slug ?? '–'}</td>
                  <td className="py-2 pr-3">{op.action}</td>
                  <td className="py-2 pr-3">
                    {op.ok ? <span className="text-emerald-700">✓ done</span> : <span className="text-red-700">✗ failed</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-neutral-600">
                    {op.from || op.to ? `${op.from ?? '?'} → ${op.to ?? '?'}` : '–'}
                  </td>
                  <td className="py-2 text-xs text-red-700">{op.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {checks && <ChecksList checks={checks} />}
      <details>
        <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-800">Raw result</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}
