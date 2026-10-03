import {
  jobCategories,
  jobOrigins,
  jobStatuses,
  jobTypes,
  type JobCategory,
  type JobOrigin,
  type JobStatus,
  type JobType,
} from '../../../shared/schemas';

/**
 * The Jobs list's filters. They live in the URL rather than in component state, so a filtered
 * list can be bookmarked, linked to ("View runs" on the Schedules page is one) and returned
 * to with Back - and so a job's page can send its reader back to exactly the list they came
 * from. The URL uses the API's own parameter names where there is one.
 */

export const JOBS_PAGE_SIZE = 50;

/** "When" in the filter bar. A token, not a timestamp: "the last hour" moves with the clock. */
export const JOB_WINDOWS = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
} as const;
export type JobWindow = keyof typeof JOB_WINDOWS;

export interface JobFilters {
  /** `#123` finds that job; anything else is a substring the API matches (routes/jobs.ts). */
  q: string;
  status: JobStatus[];
  type: JobType | null;
  category: JobCategory | null;
  origin: JobOrigin | null;
  siteSlug: string | null;
  serverId: number | null;
  scheduleId: number | null;
  batchId: number | null;
  window: JobWindow | null;
  /** 1-based, like the pager reads. */
  page: number;
}

/** What `useJobs` takes: any subset of the filters, and a page size for short lists. */
export type JobListQuery = Partial<JobFilters> & { limit?: number };

export const EMPTY_JOB_FILTERS: JobFilters = {
  q: '',
  status: [],
  type: null,
  category: null,
  origin: null,
  siteSlug: null,
  serverId: null,
  scheduleId: null,
  batchId: null,
  window: null,
  page: 1,
};

const oneOf = <T extends string>(values: readonly T[], raw: string | null): T | null =>
  raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null;

const positiveInt = (raw: string | null): number | null => {
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
};

/**
 * The filters a URL asks for. Anything this build does not recognise is dropped rather than
 * passed on: the list API refuses unknown values outright, and one stale bookmark must not
 * turn the whole page into an error.
 */
export function parseJobFilters(params: URLSearchParams): JobFilters {
  const statuses = new Set((params.get('status') ?? '').split(',').map((s) => s.trim()));
  const site = (params.get('siteSlug') ?? '').trim();
  return {
    q: (params.get('q') ?? '').trim().slice(0, 200),
    // In the canonical order, so `failed,queued` and `queued,failed` are one cache entry.
    status: jobStatuses.filter((s) => statuses.has(s)),
    type: oneOf(jobTypes, params.get('type')),
    category: oneOf(jobCategories, params.get('category')),
    origin: oneOf(jobOrigins, params.get('origin')),
    siteSlug: site && site.length <= 64 ? site : null,
    serverId: positiveInt(params.get('serverId')),
    scheduleId: positiveInt(params.get('scheduleId')),
    batchId: positiveInt(params.get('batchId')),
    window: oneOf(Object.keys(JOB_WINDOWS) as JobWindow[], params.get('window')),
    page: positiveInt(params.get('page')) ?? 1,
  };
}

function serialize(key: keyof JobFilters, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(',') : null;
  if (typeof value === 'number') return key === 'page' && value <= 1 ? null : String(value);
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * The URL after a filter change. Empty values are removed rather than written as `?type=`,
 * and any change other than paging goes back to the first page - page 4 of a narrower
 * selection is usually empty, and never what the reader meant.
 */
export function patchJobParams(prev: URLSearchParams, patch: Partial<JobFilters>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const key of Object.keys(patch) as (keyof JobFilters)[]) {
    const text = serialize(key, patch[key]);
    if (text === null) next.delete(key);
    else next.set(key, text);
  }
  if (!('page' in patch)) next.delete('page');
  return next;
}

/**
 * The `GET /api/jobs` query for these filters: only names the API knows (it is strict), with
 * the window turned into `since` at the moment of asking - so a list polled for an hour still
 * shows "the last 24 hours", not the 24 hours before the page was opened.
 */
export function jobListParams(filters: JobListQuery, now: number): Record<string, string> {
  const limit = filters.limit ?? JOBS_PAGE_SIZE;
  const out: Record<string, string> = {};
  if (filters.q) out.q = filters.q;
  if (filters.status && filters.status.length > 0) out.status = filters.status.join(',');
  if (filters.type) out.type = filters.type;
  if (filters.category) out.category = filters.category;
  if (filters.origin) out.origin = filters.origin;
  if (filters.siteSlug) out.siteSlug = filters.siteSlug;
  if (filters.serverId) out.serverId = String(filters.serverId);
  if (filters.scheduleId) out.scheduleId = String(filters.scheduleId);
  if (filters.batchId) out.batchId = String(filters.batchId);
  if (filters.window) out.since = String(now - JOB_WINDOWS[filters.window]);
  out.limit = String(limit);
  const page = filters.page ?? 1;
  if (page > 1) out.offset = String((page - 1) * limit);
  return out;
}

/** Whether anything narrows the list (the page does not count). */
export function hasFilters(filters: JobFilters): boolean {
  return (
    filters.q !== '' ||
    filters.status.length > 0 ||
    filters.type !== null ||
    filters.category !== null ||
    filters.origin !== null ||
    filters.siteSlug !== null ||
    filters.serverId !== null ||
    filters.scheduleId !== null ||
    filters.batchId !== null ||
    filters.window !== null
  );
}
