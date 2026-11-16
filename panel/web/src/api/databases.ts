// @docs databases/overview, sites/database
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DB_LIMITS, type DbRowFilter, type DbRowKey } from '../../../shared/databases';
import type {
  DatabaseListDto,
  DbDdlPreviewDto,
  DbQueryDto,
  DbRowDto,
  DbRowsPageDto,
  DbTableDto,
  DbTableStructureDto,
  DbWriteResultDto,
  SiteDatabaseDto,
} from '../../../shared/types';
import { api } from './client';
import { uploadInChunks } from './chunkUpload';

/** A site's databases: its own, the others it was given, and where code reaches them. */
export const useSiteDatabases = (slug: string) =>
  useQuery({ queryKey: ['site-databases', slug], queryFn: () => api<SiteDatabaseDto>(`/api/sites/${slug}/databases`) });

/** Every server's databases, as last read. */
export const useDatabaseList = () =>
  useQuery({ queryKey: ['databases'], queryFn: () => api<DatabaseListDto>('/api/databases'), refetchInterval: 60_000 });

const base = (slug: string, db: string) => `/api/sites/${slug}/databases/${encodeURIComponent(db)}`;
const tableBase = (slug: string, db: string, table: string) => `${base(slug, db)}/tables/${encodeURIComponent(table)}`;

export const useDbTables = (slug: string, db: string | null) =>
  useQuery({
    queryKey: ['db-tables', slug, db],
    queryFn: () => api<{ items: DbTableDto[] }>(`${base(slug, db!)}/tables`).then((r) => r.items),
    enabled: !!db,
  });

export const useDbStructure = (slug: string, db: string | null, table: string | null) =>
  useQuery({
    queryKey: ['db-structure', slug, db, table],
    queryFn: () => api<DbTableStructureDto>(tableBase(slug, db!, table!)),
    enabled: !!db && !!table,
  });

export interface RowsQuery {
  offset: number;
  limit: number;
  sort: string | null;
  dir: 'asc' | 'desc';
  filters: DbRowFilter[];
  /** Every filter must match, or one is enough. */
  match: 'all' | 'any';
}

export const useDbRows = (slug: string, db: string | null, table: string | null, q: RowsQuery) =>
  useQuery({
    queryKey: ['db-rows', slug, db, table, q],
    queryFn: () => {
      const params = new URLSearchParams({ offset: String(q.offset), limit: String(q.limit), dir: q.dir });
      if (q.sort) params.set('sort', q.sort);
      if (q.filters.length > 0) params.set('filters', JSON.stringify(q.filters));
      if (q.match === 'any' && q.filters.length > 1) params.set('match', 'any');
      return api<DbRowsPageDto>(`${tableBase(slug, db!, table!)}/rows?${params}`);
    },
    enabled: !!db && !!table,
    // A new page or filter keeps the old rows in view until the new ones are in.
    placeholderData: keepPreviousData,
    // What fails here fails again (a filter past the time limit, a column gone): not twice the wait.
    retry: false,
  });

export const fetchDbRow = (slug: string, db: string, table: string, key: DbRowKey) =>
  api<DbRowDto>(`${tableBase(slug, db, table)}/row?key=${encodeURIComponent(JSON.stringify(key))}`);

export const updateDbRow = (slug: string, db: string, table: string, key: DbRowKey, values: Record<string, string | null>) =>
  api<DbWriteResultDto>(`${tableBase(slug, db, table)}/rows`, { method: 'PATCH', body: { key, values } });

export const insertDbRow = (slug: string, db: string, table: string, values: Record<string, string | null>) =>
  api<DbWriteResultDto>(`${tableBase(slug, db, table)}/rows`, { method: 'POST', body: { values } });

export const deleteDbRows = (slug: string, db: string, table: string, keys: DbRowKey[]) =>
  api<DbWriteResultDto>(`${tableBase(slug, db, table)}/rows/delete`, { method: 'POST', body: { keys } });

/** Where a structure change goes, and what it sends: one request answers its SQL (preview) or runs it. */
export const structurePaths = {
  alter: (slug: string, db: string, table: string) => `${tableBase(slug, db, table)}/alter`,
  create: (slug: string, db: string) => `${base(slug, db)}/tables`,
  drop: (slug: string, db: string, table: string) => tableBase(slug, db, table),
  truncate: (slug: string, db: string, table: string) => `${tableBase(slug, db, table)}/truncate`,
};

/** The SQL a structure change would run, and nothing run. */
export const previewStructure = (path: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>) =>
  method === 'DELETE' || body === undefined
    ? api<DbDdlPreviewDto>(`${path}?preview=true`, { method })
    : api<DbDdlPreviewDto>(path, { method, body: { ...body, preview: true } });

export const runDbSql = (slug: string, db: string, sql: string) =>
  api<DbQueryDto>(`${base(slug, db)}/query`, { method: 'POST', body: { sql } });

export const revealDbPassword = (slug: string) =>
  api<{ password: string }>(`/api/sites/${slug}/database-password/reveal`, { method: 'POST' });

export const scanDatabases = () => api<DatabaseListDto>('/api/databases/scan', { method: 'POST' });

/** Where a dump downloads from: a plain link, so the browser saves it as it streams. */
export const dbExportUrl = (slug: string, db: string) => `${base(slug, db)}/export`;

/** An upload's id, made before the first byte goes: whatever happens next, the dialog can remove it. */
export const newDumpUploadId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
};

/** Whether a file is gzip already: its first two bytes. */
async function isGzip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * A dump as it is sent: gzipped, a plain .sql compressed here first so less of it crosses the
 * network. Kept by the caller, so an upload tried again sends the very same bytes.
 */
export async function prepareDump(file: File, onCompressing: () => void, signal?: AbortSignal): Promise<Blob> {
  let blob: Blob = file;
  if (!(await isGzip(file))) {
    onCompressing();
    blob = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'), { signal })).blob();
  }
  if (blob.size > DB_LIMITS.importBytes) throw new Error('The dump is larger than 4 GB, even compressed');
  return blob;
}

/**
 * Send a prepared dump to the site's server for an import, in chunks, as upload `id` (resumable;
 * see uploadInChunks).
 */
export async function uploadDump(
  slug: string,
  id: string,
  blob: Blob,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await uploadInChunks((offset, size) => `/api/sites/${slug}/database-uploads/${id}?offset=${offset}&size=${size}`, blob, DB_LIMITS.chunkBytes, onProgress, signal);
}

/** Throw away an upload that will not be imported (the dialog was closed half-way). */
export const discardUpload = (slug: string, id: string) =>
  api<void>(`/api/sites/${slug}/database-uploads/${id}`, { method: 'DELETE' }).catch(() => undefined);
