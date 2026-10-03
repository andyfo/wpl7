import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { JobDto } from '../../../shared/types';
import {
  jobCategories,
  jobStatuses,
  type JobCategory,
  type JobOrigin,
  type JobStatus,
  type JobType,
} from '../../../shared/schemas';
import { JOB_CATEGORY_LABELS, jobInfo, jobLabel, typesInCategories } from '../../../shared/jobTypes';
import { api } from '../api/client';
import { isTerminal, useDebounced, useJobs, useMeta, useNow, useSchedules, useSites } from '../api/hooks';
import { Button, Card, EmptyState, ErrorNote, Field, inputClass, JobStatusBadge, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { TriggeredBy } from '../components/JobTriggeredBy';
import { formatDate, formatDuration, timeAgo } from '../lib/format';
import {
  JOBS_PAGE_SIZE,
  hasFilters,
  parseJobFilters,
  patchJobParams,
  type JobFilters,
  type JobWindow,
} from '../lib/jobFilters';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
};

const STATUS_DOTS: Record<JobStatus, string> = {
  queued: 'bg-amber-400',
  running: 'bg-sky-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  canceled: 'bg-neutral-400',
};

/** The first entry of each group in the Job select, which picks the whole category. */
const ALL_IN_CATEGORY: Record<JobCategory, string> = {
  sites: 'All site jobs',
  backups: 'All backup jobs',
  wordpress: 'All WordPress jobs',
  files: 'All file jobs',
  security: 'All security jobs',
  servers: 'All server jobs',
  system: 'All panel jobs',
};

const ORIGINS: { id: JobOrigin; label: string }[] = [
  { id: 'user', label: 'In the panel' },
  { id: 'api', label: 'API' },
  { id: 'mcp', label: 'AI apps (MCP)' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'system', label: 'System' },
];

const WINDOWS: { id: JobWindow; label: string }[] = [
  { id: '1h', label: 'Last hour' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

const RETENTIONS = [7, 30, 90, 180, 365];

/** "Took": how long it ran, how long it has been running, or how long it has been waiting. */
function took(job: JobDto, now: number): string {
  if (job.status === 'queued') return `waiting ${formatDuration(Math.max(1000, now - job.createdAt))}`;
  if (job.startedAt === null) return '–';
  const end = job.finishedAt ?? (job.status === 'running' ? now : null);
  return end === null ? '–' : formatDuration(Math.max(0, end - job.startedAt));
}

/** A filter that has no control of its own on the page (it came with a link), as a removable chip. */
function FilterChip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="entity-chip entity-chip-active">
      {children}
      <button type="button" aria-label="Remove this filter" className="-mr-1 rounded-full px-1 hover:opacity-70" onClick={onRemove}>
        ✕
      </button>
    </span>
  );
}

/**
 * Everything the panel has done or is doing, newest first. The filters are the URL (see
 * lib/jobFilters.ts), so a filtered list can be linked to - the Schedules page's "View runs"
 * and the job page's back link both rely on it.
 */
export function Jobs() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseJobFilters(params), [params]);
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meta = useMeta();
  const sites = useSites();
  const schedules = useSchedules({ live: false });
  const multiServer = meta.data?.multiServer ?? false;

  const patch = (change: Partial<JobFilters>) => setParams((prev) => patchJobParams(prev, change), { replace: true });

  // The search box types into its own state; the URL (and the query) follow it once the
  // typing pauses. A change from elsewhere - Clear, Back - goes the other way.
  const [text, setText] = useState(filters.q);
  const typed = useDebounced(text.trim(), 300);
  useEffect(() => {
    if (typed !== filters.q) patch({ q: typed });
    // Only when the typing settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);
  useEffect(() => {
    if (filters.q !== text.trim()) setText(filters.q);
    // Only when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  const page = filters.page;
  const jobs = useJobs(filters, { poll: page === 1 });
  const data = jobs.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const anyActive = items.some((j) => !isTerminal(j.status));
  const now = useNow(anyActive ? 1000 : 15_000);

  const scheduleNames = useMemo(() => new Map((schedules.data ?? []).map((s) => [s.id, s.name])), [schedules.data]);
  const scheduleName = (id: number) => scheduleNames.get(id) ?? null;
  const serverNames = useMemo(() => new Map((meta.data?.servers ?? []).map((s) => [s.id, s.name])), [meta.data]);
  const siteList = useMemo(() => [...(sites.data ?? [])].sort((a, b) => a.slug.localeCompare(b.slug)), [sites.data]);
  const filtered = hasFilters(filters);

  const clearAll = () => {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const toggleStatus = (status: JobStatus) =>
    patch({
      status: filters.status.includes(status)
        ? filters.status.filter((s) => s !== status)
        : jobStatuses.filter((s) => s === status || filters.status.includes(s)),
    });

  const jobValue = filters.type ? `type:${filters.type}` : filters.category ? `cat:${filters.category}` : '';
  const pickJob = (value: string) => {
    if (value.startsWith('type:')) patch({ type: value.slice(5) as JobType, category: null });
    else if (value.startsWith('cat:')) patch({ category: value.slice(4) as JobCategory, type: null });
    else patch({ type: null, category: null });
  };

  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionError, setRetentionError] = useState<unknown>(null);
  const setRetention = async (days: number) => {
    setSavingRetention(true);
    setRetentionError(null);
    try {
      await api('/api/settings', { method: 'PUT', body: { jobsRetentionDays: days } });
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setRetentionError(err);
    } finally {
      setSavingRetention(false);
    }
  };
  const retention = data?.retentionDays ?? 90;
  const retentionOptions = RETENTIONS.includes(retention) ? RETENTIONS : [...RETENTIONS, retention].sort((a, b) => a - b);

  const openJob = (e: React.MouseEvent, id: number) => {
    // The links and buttons inside the row own their own clicks.
    if ((e.target as HTMLElement).closest('a, button, input, select')) return;
    if (e.metaKey || e.ctrlKey) window.open(`/jobs/${id}`, '_blank');
    else void navigate(`/jobs/${id}`, { state: { from: location.search } });
  };

  const pager =
    total > JOBS_PAGE_SIZE ? (
      <span className="flex items-center gap-2 text-xs">
        <Button small variant="ghost" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>
          ←
        </Button>
        <span className="text-neutral-500 tabular-nums">
          {(page - 1) * JOBS_PAGE_SIZE + 1}–{Math.min(page * JOBS_PAGE_SIZE, total)}
        </span>
        <Button small variant="ghost" disabled={page * JOBS_PAGE_SIZE >= total} onClick={() => patch({ page: page + 1 })}>
          →
        </Button>
      </span>
    ) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Jobs</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Everything the panel runs in the background: what it did, who started it, and its log.
          </p>
        </div>
        <Link
          to="/jobs/schedules"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-900"
        >
          Schedules
          <Icon name="arrow" size={14} />
        </Link>
      </div>

      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-80">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-neutral-400">
                <Icon name="search" size={15} />
              </span>
              <input
                className={`${inputClass} pl-9`}
                type="search"
                placeholder="Search: site, plugin, error, #id"
                aria-label="Search jobs"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Status">
              <button
                type="button"
                aria-pressed={filters.status.length === 0}
                className={`entity-chip ${filters.status.length === 0 ? 'entity-chip-active' : ''}`}
                onClick={() => patch({ status: [] })}
              >
                All
              </button>
              {jobStatuses.map((status) => {
                const on = filters.status.includes(status);
                const count = data?.counts[status];
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={on}
                    className={`entity-chip ${on ? 'entity-chip-active' : ''}`}
                    onClick={() => toggleStatus(status)}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOTS[status]}`} />
                    {STATUS_LABELS[status]}
                    {count !== undefined && <span className="tabular-nums opacity-70">{count.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`grid gap-3 sm:grid-cols-2 ${multiServer ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
            <Field label="Job" width="full">
              <select className={inputClass} value={jobValue} onChange={(e) => pickJob(e.target.value)}>
                <option value="">All jobs</option>
                {jobCategories.map((category) => {
                  const types = typesInCategories([category]).filter(
                    (t) => !jobInfo(t)?.internal || t === filters.type,
                  );
                  if (types.length === 0) return null;
                  return (
                    <optgroup key={category} label={JOB_CATEGORY_LABELS[category]}>
                      <option value={`cat:${category}`}>{ALL_IN_CATEGORY[category]}</option>
                      {types.map((t) => (
                        <option key={t} value={`type:${t}`}>
                          {jobLabel(t)}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </Field>
            <Field label="Site" width="full">
              <select
                className={inputClass}
                value={filters.siteSlug ?? ''}
                onChange={(e) => patch({ siteSlug: e.target.value || null })}
              >
                <option value="">All sites</option>
                {filters.siteSlug && !siteList.some((s) => s.slug === filters.siteSlug) && (
                  // A link can name a site that has since been deleted; its jobs are still here.
                  <option value={filters.siteSlug}>
                    {filters.siteSlug}
                    {sites.data ? ' (deleted)' : ''}
                  </option>
                )}
                {siteList.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.slug}
                  </option>
                ))}
              </select>
            </Field>
            {multiServer && (
              <Field label="Server" width="full">
                <select
                  className={inputClass}
                  value={filters.serverId ?? ''}
                  onChange={(e) => patch({ serverId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">All servers</option>
                  {filters.serverId !== null && !serverNames.has(filters.serverId) && (
                    <option value={filters.serverId}>Server #{filters.serverId}</option>
                  )}
                  {(meta.data?.servers ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Triggered by" width="full">
              <select
                className={inputClass}
                value={filters.origin ?? ''}
                onChange={(e) => patch({ origin: (e.target.value || null) as JobOrigin | null })}
              >
                <option value="">Anyone</option>
                {ORIGINS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When" width="full">
              <select
                className={inputClass}
                value={filters.window ?? ''}
                onChange={(e) => patch({ window: (e.target.value || null) as JobWindow | null })}
              >
                <option value="">Any time</option>
                {WINDOWS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {(filters.scheduleId !== null || filters.batchId !== null || filtered) && (
            <div className="flex flex-wrap items-center gap-2">
              {filters.scheduleId !== null && (
                <FilterChip onRemove={() => patch({ scheduleId: null })}>
                  <Icon name="clock" size={13} />
                  {scheduleName(filters.scheduleId) ?? `Schedule #${filters.scheduleId}`}
                </FilterChip>
              )}
              {filters.batchId !== null && (
                <FilterChip onRemove={() => patch({ batchId: null })}>Bulk run #{filters.batchId}</FilterChip>
              )}
              {filtered && (
                <Button small variant="ghost" onClick={clearAll}>
                  Clear filters
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-3">
            {data ? `${total.toLocaleString()} ${total === 1 ? 'job' : 'jobs'}` : 'Jobs'}
            {page === 1 && data && (
              <span className={`live-label ${jobs.isError ? 'live-label-stale' : ''}`}>
                {jobs.isError ? 'Not updating' : 'Live'}
              </span>
            )}
            {jobs.isPlaceholderData && <Spinner />}
          </span>
        }
        action={pager}
      >
        <div className="space-y-3">
          <ErrorNote error={jobs.error} />
          {!data ? (
            jobs.isPending ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : null
          ) : items.length === 0 ? (
            <EmptyState>
              {total > 0 && page > 1 ? (
                <>
                  This page is past the end of the list.{' '}
                  <button type="button" className="underline" onClick={() => patch({ page: 1 })}>
                    Back to the first page
                  </button>
                </>
              ) : filtered ? (
                <>
                  No jobs match these filters.{' '}
                  <button type="button" className="underline" onClick={clearAll}>
                    Clear filters
                  </button>
                </>
              ) : (
                'No jobs yet. Creating a site, a backup or an update each runs as a job, and shows up here.'
              )}
            </EmptyState>
          ) : (
            <table className={`w-full text-sm transition-opacity ${jobs.isPlaceholderData ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2 pr-3">#</th>
                  <th className="pb-2 pr-3">Job</th>
                  <th className="hidden pb-2 pr-3 sm:table-cell">Status</th>
                  <th className="hidden pb-2 pr-3 md:table-cell">Triggered by</th>
                  <th className="pb-2 pr-3">When</th>
                  <th className="hidden pb-2 text-right sm:table-cell">Took</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr
                    key={job.id}
                    // A mouse convenience on top of the real link in the Job cell, as on Sites.
                    onClick={(e) => openJob(e, job.id)}
                    className="cursor-pointer border-t border-neutral-100 align-top transition-colors hover:bg-neutral-50"
                  >
                    <td className="py-2 pr-3 text-xs tabular-nums text-neutral-400">#{job.id}</td>
                    <td className="w-full max-w-0 py-2 pr-3">
                      <div className="sm:min-w-48">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <Link
                            to={`/jobs/${job.id}`}
                            state={{ from: location.search }}
                            className="font-medium hover:underline"
                          >
                            {jobLabel(job.type)}
                          </Link>
                          {job.siteSlug && (
                            <Link to={`/sites/${job.siteSlug}`} className="text-xs text-neutral-500 hover:underline">
                              {job.siteSlug}
                            </Link>
                          )}
                          {multiServer && job.serverId !== null && (
                            <span className="text-xs text-neutral-400">
                              {serverNames.get(job.serverId) ?? `server #${job.serverId}`}
                            </span>
                          )}
                          {/* A phone has no room for a status column; the badge rides along. */}
                          <span className="sm:hidden">
                            <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
                          </span>
                        </div>
                        {job.summary && (
                          <div className="truncate text-xs text-neutral-500" title={job.summary}>
                            {job.summary}
                          </div>
                        )}
                        {job.status === 'failed' && job.error && (
                          <div className="truncate text-xs text-red-700" title={job.error}>
                            {job.error}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">
                      <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
                    </td>
                    <td className="hidden py-2 pr-3 md:table-cell">
                      <TriggeredBy job={job} scheduleName={scheduleName} />
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-xs text-neutral-500" title={formatDate(job.createdAt)}>
                      {timeAgo(job.createdAt, now)}
                    </td>
                    <td className="hidden whitespace-nowrap py-2 text-right text-xs tabular-nums text-neutral-500 sm:table-cell">
                      {took(job, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pager && items.length > 0 && <div className="flex justify-end">{pager}</div>}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>Finished jobs are kept for</span>
        <select
          className={`${inputClass} max-w-32`}
          aria-label="How long finished jobs are kept"
          disabled={savingRetention || !data || !!meta.data?.maintenance}
          title={meta.data?.maintenance ? 'The panel is read-only while it updates' : undefined}
          value={retention}
          onChange={(e) => void setRetention(Number(e.target.value))}
        >
          {retentionOptions.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
        <span>and then removed by the nightly housekeeping.</span>
        {savingRetention && <Spinner />}
        <ErrorNote error={retentionError} />
      </div>
    </div>
  );
}
