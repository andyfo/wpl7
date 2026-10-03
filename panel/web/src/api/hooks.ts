import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiActivityDto,
  ApiKeyDto,
  BackupDestinationDto,
  BackupDto,
  BackupListDto,
  BatchDto,
  CatalogStateDto,
  FtpServerStatusDto,
  JobDto,
  JobListDto,
  JobLogLine,
  MailDomainDto,
  MailMessageDto,
  MailOverviewDto,
  MailQueueDto,
  MailSetupDto,
  MailStatsDto,
  McpPageDto,
  MeDto,
  MetaDto,
  OffsiteOverviewDto,
  PanelUserDto,
  PluginDto,
  RecipeDto,
  ScheduleDto,
  ServerDto,
  ServerHistoryDto,
  ServerMonitorDto,
  ServerStatsDto,
  ServerStorageDto,
  ServerSystemInfoDto,
  SiteDetail,
  SiteFtpDto,
  SiteLicenseDto,
  SiteMonitorDto,
  SiteSummary,
  SiteTrafficDto,
  SiteWpStatusDto,
  SystemAboutDto,
  SystemVersionDto,
  WpInventoryDto,
  WporgPluginDto,
} from '../../../shared/types';
import type { WpComponentKind, WpInventoryFilter } from '../../../shared/schemas';
import { backupListParams, type BackupFilters } from '../lib/backupFilters';
import { siteFtpSettling } from '../lib/ftpStatus';
import { jobListParams, type JobListQuery } from '../lib/jobFilters';
import { api } from './client';
import { listFolder } from './files';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
export const isTerminal = (status?: string | null) => !!status && TERMINAL.has(status);

export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: () => api<MetaDto>('/api/meta'), staleTime: 5 * 60_000 });

/**
 * This build, and the newest release the hourly check found. Answered from the panel's own
 * cache rather than from GitHub, so the Settings card and the About page share one query
 * and "Check now" refreshes both.
 */
export const useSystemVersion = () =>
  useQuery({ queryKey: ['system-version'], queryFn: () => api<SystemVersionDto>('/api/system/version') });

/**
 * Where this install came from and what it runs on, for the About page. Both halves are
 * cached on the server - a minute for the host reading, ten for the reverse lookup - so
 * this is fetched on mount and then left alone.
 */
export const useAbout = () =>
  useQuery({ queryKey: ['about'], queryFn: () => api<SystemAboutDto>('/api/system/about'), staleTime: 60_000 });

export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: () => api<MeDto>('/api/auth/me'), retry: false });

/**
 * The admin accounts. Not polled: they change when someone here changes them, and every
 * write on the Users pages invalidates both this and the one-account query below.
 */
export const useUsers = () =>
  useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: PanelUserDto[] }>('/api/users').then((r) => r.items),
  });

export const useUser = (id: number) =>
  useQuery({
    queryKey: ['user', id],
    queryFn: () => api<PanelUserDto>(`/api/users/${id}`),
    // A URL can name any number, and a 404 is an answer rather than a hiccup to retry.
    enabled: Number.isFinite(id),
    retry: false,
  });

export const useSites = () =>
  useQuery({
    queryKey: ['sites'],
    queryFn: () => api<{ items: SiteSummary[] }>('/api/sites').then((r) => r.items),
    refetchInterval: 15_000,
  });

export const useSite = (slug: string) =>
  useQuery({
    queryKey: ['site', slug],
    queryFn: () => api<SiteDetail>(`/api/sites/${slug}`),
    refetchInterval: 15_000,
  });

/**
 * One folder of a site, for the Files tab. No retry: a 409 (the site is stopped) or a 404 (the
 * folder is gone) is the answer, not a blip - and the tab shows it as such.
 */
export const useSiteFiles = (slug: string, path: string) =>
  useQuery({
    queryKey: ['site-files', slug, path],
    queryFn: () => listFolder(slug, path),
    retry: false,
    staleTime: 2000,
  });

export const useMonitor = () =>
  useQuery({
    queryKey: ['monitor'],
    queryFn: () =>
      api<{ server: ServerStatsDto | null; servers: ServerMonitorDto[]; sites: SiteMonitorDto[] }>(
        '/api/monitor/overview',
      ),
    refetchInterval: 15_000,
  });

export const useServerHistory = (serverId: number, hours: number) =>
  useQuery({
    queryKey: ['server-history', serverId, hours],
    queryFn: () => api<ServerHistoryDto>(`/api/monitor/servers/${serverId}/history?hours=${hours}`),
    refetchInterval: 15_000,
  });

export const useServers = () =>
  useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ items: ServerDto[] }>('/api/servers').then((r) => r.items),
    refetchInterval: 30_000,
  });

/**
 * What the machine is: OS, kernel, CPU, uptime. One round trip to the server, cached for a
 * minute behind the API, so this is fetched on mount and left alone rather than polled.
 */
export const useServerInfo = (serverId: number) =>
  useQuery({
    queryKey: ['server-info', serverId],
    queryFn: () => api<ServerSystemInfoDto>(`/api/servers/${serverId}/info`),
    enabled: Number.isFinite(serverId),
    staleTime: 60_000,
    retry: false,
  });

export const useSshPublicKey = () =>
  useQuery({
    queryKey: ['ssh-public-key'],
    queryFn: () => api<{ publicKey: string | null }>('/api/servers/ssh-public-key'),
    staleTime: Infinity,
  });

export const useSiteHistory = (slug: string, hours = 24) =>
  useQuery({
    queryKey: ['history', slug, hours],
    queryFn: () =>
      api<{ samples: { ts: number; up: boolean | null; httpMs: number | null; cpuPct: number | null; memBytes: number | null }[] }>(
        `/api/monitor/sites/${slug}/history?hours=${hours}`,
      ).then((r) => r.samples),
    refetchInterval: 60_000,
  });

/**
 * Visitor statistics. The ingest runs on a one-minute tick, so polling faster than that
 * would only re-render identical numbers.
 */
export const useSiteTraffic = (slug: string, days: number) =>
  useQuery({
    queryKey: ['traffic', slug, days],
    queryFn: () => api<SiteTrafficDto>(`/api/sites/${slug}/traffic?days=${days}`),
    refetchInterval: 60_000,
  });

/**
 * A site's FTP logins and how to connect. Polled fast while a change is on its way to the
 * server - the gateway takes a few seconds to set up the first time, and "Applying…" should
 * turn into "Ready" without a reload - and slowly otherwise.
 */
export const useSiteFtp = (slug: string) =>
  useQuery({
    queryKey: ['site-ftp', slug],
    queryFn: () => api<SiteFtpDto>(`/api/sites/${slug}/ftp`),
    refetchInterval: (q) => (q.state.data && siteFtpSettling(q.state.data) ? 3000 : 30_000),
  });

/** One server's FTP gateway, for the server page. */
export const useServerFtp = (serverId: number) =>
  useQuery({
    queryKey: ['server-ftp', serverId],
    queryFn: () => api<FtpServerStatusDto>(`/api/servers/${serverId}/ftp`),
    refetchInterval: 30_000,
  });

export const useBackups = (slug: string) =>
  useQuery({
    queryKey: ['backups', slug],
    queryFn: () => api<{ items: BackupDto[] }>(`/api/sites/${slug}/backups`).then((r) => r.items),
  });

/**
 * Every backup on every server, a page at a time. Quick to poll while one on screen is being
 * written or uploaded, so it turns into its outcome without a reload; slow otherwise.
 */
export const useAllBackups = (filters: BackupFilters) =>
  useQuery({
    queryKey: ['all-backups', filters],
    queryFn: () => api<BackupListDto>(`/api/backups?${new URLSearchParams(backupListParams(filters))}`),
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some(
        (b) => b.status === 'creating' || b.copies.some((c) => c.status === 'uploading'),
      )
        ? 5000
        : 30_000,
    placeholderData: (prev) => prev,
  });

/**
 * Where a server keeps its backups. `path` asks the server to validate a candidate instead
 * of describing the current location, which is what makes the form's live check live -
 * debounced, because it costs a `findmnt` on the far end.
 *
 * `probedPath` is which path the result is about. The debounce means it lags the field for
 * up to 400ms, and an answer - or a failure - about a directory other than the one in the
 * box must never be shown as that box's verdict.
 */
export const useServerStorage = (serverId: number | null, path?: string) => {
  const probedPath = useDebounced(path ?? '', 400);
  const query = useQuery({
    queryKey: ['server-storage', serverId, probedPath],
    queryFn: () =>
      api<ServerStorageDto>(
        `/api/servers/${serverId}/storage${probedPath ? `?path=${encodeURIComponent(probedPath)}` : ''}`,
      ),
    enabled: serverId !== null,
    retry: false,
  });
  return { ...query, probedPath };
};

export const useBackupDestinations = () =>
  useQuery({
    queryKey: ['backup-destinations'],
    queryFn: () => api<{ items: BackupDestinationDto[] }>('/api/backup-destinations').then((r) => r.items),
    refetchInterval: 30_000,
  });

/**
 * Destination health plus the recent failures. Polled on the same cadence as the
 * reconciler tick - anything faster would re-render identical numbers.
 */
export const useOffsiteOverview = (enabled = true) =>
  useQuery({
    queryKey: ['offsite-overview'],
    queryFn: () => api<OffsiteOverviewDto>('/api/backups/overview'),
    enabled,
    refetchInterval: 60_000,
  });

/**
 * The site's WordPress snapshot. A database read on the server, so polling it is cheap -
 * and it keeps up with the job that is currently changing the site, which is what makes
 * the tab feel live without re-execing wp-cli on every render.
 */
export const useWpStatus = (slug: string) =>
  useQuery({
    queryKey: ['wp-status', slug],
    queryFn: () => api<SiteWpStatusDto>(`/api/sites/${slug}/wp/status`),
    refetchInterval: 60_000,
  });

export interface WpInventoryFilters {
  kind: WpComponentKind;
  filter: WpInventoryFilter[];
  q?: string;
  serverId?: number;
  siteSlug?: string;
  includeStopped?: boolean;
}

/** The fleet table. Polled slowly: it only changes when a scan or a bulk run finishes. */
export const useWpInventory = (filters: WpInventoryFilters) =>
  useQuery({
    queryKey: ['wp-inventory', filters],
    queryFn: () => {
      const params = new URLSearchParams({ kind: filters.kind });
      if (filters.filter.length > 0) params.set('filter', filters.filter.join(','));
      if (filters.q) params.set('q', filters.q);
      if (filters.serverId !== undefined) params.set('serverId', String(filters.serverId));
      if (filters.siteSlug) params.set('siteSlug', filters.siteSlug);
      if (filters.includeStopped) params.set('includeStopped', 'true');
      return api<WpInventoryDto>(`/api/wp/inventory?${params}`);
    },
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

export interface BatchRes {
  batch: BatchDto;
  jobs: JobDto[];
}

/** One bulk run and its per-site jobs; stops polling once every job is terminal. */
export function useBatch(batchId: number | null) {
  return useQuery({
    queryKey: ['wp-batch', batchId],
    enabled: batchId !== null,
    queryFn: () => api<BatchRes>(`/api/wp/batches/${batchId}`),
    refetchInterval: (q) => {
      const jobs = q.state.data?.jobs ?? [];
      if (jobs.length === 0) return 2000;
      return jobs.every((job) => isTerminal(job.status)) ? false : 2000;
    },
  });
}

export const useBatches = () =>
  useQuery({
    queryKey: ['wp-batches'],
    queryFn: () => api<{ items: BatchDto[] }>('/api/wp/batches?limit=10').then((r) => r.items),
    refetchInterval: 15_000,
  });

export const useWpMaintenance = (slug: string, enabled: boolean) =>
  useQuery({
    queryKey: ['wp-maintenance', slug],
    queryFn: () => api<{ enabled: boolean }>(`/api/sites/${slug}/wp/maintenance`).then((r) => r.enabled),
    enabled,
    retry: false,
  });

export const usePluginCatalog = () =>
  useQuery({
    queryKey: ['plugin-catalog'],
    queryFn: () => api<{ items: PluginDto[] }>('/api/plugins').then((r) => r.items),
    // A zip's malware check takes a minute or two: follow it while one runs.
    refetchInterval: (q) => (q.state.data?.some((p) => p.check?.checking) ? 4000 : false),
  });

/**
 * Plugin recipes with what is entered for their inputs (never a secret itself).
 * `refetchOnWindowFocus` is for a page that sends the operator to another tab to set one up.
 */
export const useRecipes = ({ refetchOnWindowFocus = false } = {}) =>
  useQuery({
    queryKey: ['recipes'],
    queryFn: () => api<{ items: RecipeDto[] }>('/api/recipes').then((r) => r.items),
    refetchOnWindowFocus,
  });

/** The public catalog's state: what was fetched when, and whether the last fetch worked. */
export const useCatalogState = () =>
  useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<CatalogStateDto>('/api/catalog'),
    refetchInterval: 60_000,
  });

/** Where each recipe stands on one site; a database read, so polling it is cheap. */
export const useSiteRecipes = (slug: string) =>
  useQuery({
    queryKey: ['wp-recipes', slug],
    queryFn: () => api<{ items: SiteLicenseDto[] }>(`/api/sites/${slug}/wp/recipes`).then((r) => r.items),
    refetchInterval: 60_000,
  });

/** Trailing debounce: the value settles `ms` after the last change. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export interface WporgSearchRes {
  items: WporgPluginDto[];
  page: number;
  pages: number;
  total: number;
}

/**
 * Typeahead against the wordpress.org directory. Debounced so a burst of keystrokes is one
 * request, and cached for the session - retyping a search term costs nothing.
 */
export function useWporgSearch(query: string, page = 1) {
  const q = useDebounced(query.trim(), 300);
  return useQuery({
    queryKey: ['wporg-search', q, page],
    queryFn: () => api<WporgSearchRes>(`/api/plugins/search?q=${encodeURIComponent(q)}&page=${page}`),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    // A typo is a 400 from the query schema; retrying it just delays the "no matches" message.
    retry: false,
    placeholderData: (prev) => prev,
  });
}

/**
 * Mail traffic is reconstructed from each relay's log on a one-minute scheduler tick, so
 * polling faster than that would only re-render the same rows.
 */
export const useMailStatus = () =>
  useQuery({
    queryKey: ['mail-status'],
    queryFn: () => api<MailOverviewDto>('/api/mail/status'),
    refetchInterval: 60_000,
  });

export interface MailMessageFilters {
  siteSlug?: string;
  status?: string;
  search?: string;
  hours?: number;
  limit?: number;
  offset?: number;
}

export const useMailMessages = (filters: MailMessageFilters) =>
  useQuery({
    queryKey: ['mail-messages', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
      return api<{ items: MailMessageDto[]; total: number }>(`/api/mail/messages?${params}`);
    },
    refetchInterval: 30_000,
  });

export const useMailStats = (hours: number) =>
  useQuery({
    queryKey: ['mail-stats', hours],
    queryFn: () => api<MailStatsDto>(`/api/mail/stats?hours=${hours}`),
    refetchInterval: 60_000,
  });

export const useMailQueue = () =>
  useQuery({
    queryKey: ['mail-queue'],
    queryFn: () => api<{ items: MailQueueDto[] }>('/api/mail/queue').then((r) => r.items),
    refetchInterval: 30_000,
  });

/**
 * The setup guide: relay status, per-server records and the per-domain plan in one call.
 * Every domain costs several live DNS lookups, so it is fetched on demand and not polled -
 * the guide has its own "check again" buttons.
 */
export const useMailSetup = (enabled: boolean) =>
  useQuery({
    queryKey: ['mail-setup'],
    queryFn: () => api<MailSetupDto>('/api/mail/setup'),
    enabled,
    staleTime: 60_000,
  });

/** Every entry costs several live DNS lookups, so this one is fetched on demand only. */
export const useMailDomains = (enabled: boolean) =>
  useQuery({
    queryKey: ['mail-domains'],
    queryFn: () => api<{ items: MailDomainDto[] }>('/api/mail/domains').then((r) => r.items),
    enabled,
    staleTime: 60_000,
  });

export const useApiKeys = () =>
  useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<{ items: ApiKeyDto[] }>('/api/api-keys').then((r) => r.items),
  });

/**
 * The MCP page. Polled every few seconds while a connection window is open, so an app that
 * registers shows up without a reload - and slowly otherwise, for "last used".
 */
export const useMcp = () =>
  useQuery({
    queryKey: ['mcp'],
    queryFn: () => api<McpPageDto>('/api/mcp'),
    refetchInterval: (query) => (query.state.data?.window ? 3000 : 30_000),
  });

export interface ApiActivityFilters {
  keyId?: number | '';
  outcome?: string;
  method?: string;
  search?: string;
  /** 0 = everything still stored. */
  hours: number;
  limit: number;
  offset: number;
}

export const useApiActivity = (filters: ApiActivityFilters) =>
  useQuery({
    queryKey: ['api-activity', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
      return api<ApiActivityDto>(`/api/api-keys/activity?${params}`);
    },
    refetchInterval: 20_000,
  });

/**
 * A page of the Jobs list. The key holds the filters as the page has them - a window like
 * "24h", not a timestamp - and `since` is worked out on every fetch, so each poll asks about
 * the last 24 hours as of now. The previous page stays on screen while the next one loads.
 */
export const useJobs = (filters: JobListQuery, { poll = true }: { poll?: boolean } = {}) =>
  useQuery({
    queryKey: ['jobs', filters],
    queryFn: () => api<JobListDto>(`/api/jobs?${new URLSearchParams(jobListParams(filters, Date.now()))}`),
    refetchInterval: poll ? 5000 : false,
    placeholderData: (prev) => prev,
  });

/**
 * Every schedule: the built-in tasks and the custom ones. Polled fast while a run is under way,
 * so "Running now" turns into its outcome without a reload. `live: false` is for a page that
 * only wants the names (the Jobs list).
 */
export const useSchedules = ({ live = true }: { live?: boolean } = {}) =>
  useQuery({
    queryKey: ['schedules'],
    queryFn: () => api<{ items: ScheduleDto[] }>('/api/schedules').then((r) => r.items),
    refetchInterval: (q) => (!live ? false : (q.state.data ?? []).some((s) => s.running) ? 2000 : 15_000),
  });

/**
 * The time, re-read every `ms` - for "running for 12s" and "in 3m" that have to move between
 * two fetches. Off while `enabled` is false, so a page with nothing live does not re-render.
 */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

export interface JobDetailRes {
  job: JobDto;
  logs: JobLogLine[];
  lastSeq: number;
}

/** The API returns at most this many log lines per request (see routes/jobs.ts). */
const LOG_PAGE_SIZE = 500;

/** Poll a job until terminal, accumulating log lines via the seq cursor. */
export function useJob(jobId: number | null) {
  const [logs, setLogs] = useState<JobLogLine[]>([]);
  const lastSeq = useRef(0);
  /** The job the accumulated `logs` belong to; guards responses from a previous one. */
  const logsFor = useRef<number | null>(jobId);

  useEffect(() => {
    setLogs([]);
    lastSeq.current = 0;
    logsFor.current = jobId;
  }, [jobId]);

  const query = useQuery({
    queryKey: ['job', jobId],
    enabled: jobId !== null,
    // Log lines arrive incrementally (logAfter cursor) and accumulate in component state,
    // so a cache hit that skips queryFn would leave the log view empty forever - hence
    // staleTime 0 / gcTime 0: every mount re-reads the job from cursor 0.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const forJob = jobId;
      const res = await api<JobDetailRes>(`/api/jobs/${forJob}?logAfter=${lastSeq.current}`);
      // A request for the previous job can land after the id changed; appending its lines
      // would mix two jobs' logs together and push the cursor past the new job's range.
      if (forJob !== logsFor.current) return res;
      if (res.logs.length > 0) {
        lastSeq.current = res.lastSeq;
        setLogs((prev) => [...prev, ...res.logs]);
      }
      return res;
    },
    // Keep polling while the job runs; stop when it cannot be read at all (deleted/pruned
    // job, bad id), which would otherwise poll a 404 forever. On a terminal job, keep
    // draining as long as the last page came back full - stopping at the first terminal
    // response truncated any job with more than one page of logs at exactly 500 lines.
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      if (!isTerminal(q.state.data?.job.status)) return 1200;
      return (q.state.data?.logs.length ?? 0) >= LOG_PAGE_SIZE ? 200 : false;
    },
  });

  const data = query.data;
  return {
    job: data?.job ?? null,
    logs,
    error: query.error,
    isLoading: jobId !== null && query.isPending,
    /** The job is over but more of its log is still being fetched. */
    draining: !!data && isTerminal(data.job.status) && data.logs.length >= LOG_PAGE_SIZE,
  };
}

/** Fire a mutation that returns 202 {job} and track the job id. */
export function useRunJob(invalidateKeys: unknown[][] = []) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<number | null>(null);
  const { job, logs } = useJob(jobId);

  useEffect(() => {
    if (isTerminal(job?.status)) {
      for (const key of [['sites'], ['jobs'], ...invalidateKeys]) void qc.invalidateQueries({ queryKey: key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  const mutation = useMutation({
    mutationFn: async (req: { path: string; method?: string; body?: unknown }) => {
      const res = await api<{ job: JobDto }>(req.path, { method: req.method ?? 'POST', body: req.body });
      setJobId(res.job.id);
      return res.job;
    },
  });

  return { ...mutation, jobId, job, logs, reset: () => setJobId(null) };
}
