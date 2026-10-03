import type {
  SiteDirListingDto,
  SiteFileEntryDto,
  SiteFileSearchDto,
  SiteFileWrittenDto,
  SiteUploadChunkDto,
} from '../../../shared/types';
import { api, ApiError } from './client';
import { CHUNK_START, newUploadId, nextChunkSize, retryDelayMs } from '../lib/uploadPlan';

/**
 * The Files tab's calls. JSON operations go through api() like everything else; the raw
 * ones - reading and saving a file, uploading - are here, and deliberately do NOT redirect
 * to /login on a 401: an expired session must not throw away the text in the editor. The
 * caller says "sign in again in another tab, then save" and keeps it.
 */

const base = (slug: string) => `/api/sites/${encodeURIComponent(slug)}/files`;
const query = (params: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

async function errorOf(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  const err = json?.error;
  return new ApiError(res.status, err?.code ?? 'internal', err?.message ?? `HTTP ${res.status}`, err?.details);
}

export const listFolder = (slug: string, path: string) => api<SiteDirListingDto>(`${base(slug)}${query({ path })}`);

export async function readFile(slug: string, path: string): Promise<{ bytes: Uint8Array; etag: string }> {
  const res = await fetch(`${base(slug)}/content${query({ path })}`, { credentials: 'same-origin' });
  if (!res.ok) throw await errorOf(res);
  const etag = (res.headers.get('etag') ?? '').replace(/"/g, '');
  return { bytes: new Uint8Array(await res.arrayBuffer()), etag };
}

/**
 * Save a whole file. `etag`: only if it is still the version that was read (412 otherwise).
 * `createOnly`: only if nothing has the name yet. `lint`: refuse PHP that does not parse (422).
 */
export async function saveFile(
  slug: string,
  path: string,
  bytes: Uint8Array,
  opts: { etag?: string; createOnly?: boolean; lint?: boolean } = {},
): Promise<SiteFileWrittenDto> {
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-csrf': '1' };
  if (opts.etag) headers['if-match'] = `"${opts.etag}"`;
  if (opts.createOnly) headers['if-none-match'] = '*';
  const res = await fetch(`${base(slug)}/content${query({ path, lint: opts.lint ? 'php' : undefined })}`, {
    method: 'PUT',
    headers,
    body: bytes as BodyInit,
    credentials: 'same-origin',
  });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as SiteFileWrittenDto;
}

export const downloadUrl = (slug: string, path: string) => `${base(slug)}/download${query({ path })}`;

export const search = (
  slug: string,
  q: { path: string; q: string; mode: 'name' | 'content'; case: boolean; regex: boolean; include: string },
) =>
  api<SiteFileSearchDto>(
    `${base(slug)}/search${query({ ...q, include: q.include.trim() || undefined, case: q.case || undefined, regex: q.regex || undefined })}`,
  );

export const fileOp = <T = { entry: SiteFileEntryDto }>(slug: string, op: string, body: unknown) =>
  api<T>(`${base(slug)}/${op}`, { method: 'POST', body });

// ------------------------------------------------------------------ uploads

class Aborted extends Error {
  constructor() {
    super('Upload canceled');
  }
}

/** One chunk over XHR - fetch cannot report upload progress. */
function putChunk(url: string, chunk: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<SiteUploadChunkDto>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Forced: a slice of an image is otherwise sent as image/png, which the API refuses.
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-csrf', '1');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON: a proxy's error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json as SiteUploadChunkDto);
      const err = (json as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
      reject(new ApiError(xhr.status, err?.code ?? 'internal', err?.message ?? `HTTP ${xhr.status}`, err?.details));
    };
    xhr.onerror = () => reject(new TypeError('Network error'));
    xhr.onabort = () => reject(new Aborted());
    if (signal.aborted) return reject(new Aborted());
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(chunk);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Aborted());
    }, { once: true });
  });

/**
 * Upload one file to `path`, in chunks sized to the connection (lib/uploadPlan.ts). A
 * chunk lost on the network is retried; a 409 carrying `received` means the server has
 * more (or less) than we thought, and the upload carries on from there. Canceling removes
 * what already arrived.
 */
export async function uploadFile(
  slug: string,
  path: string,
  file: File,
  opts: { overwrite: boolean; onProgress: (sent: number) => void; signal: AbortSignal },
): Promise<SiteFileWrittenDto> {
  const id = newUploadId();
  const url = (offset: number) =>
    `${base(slug)}/uploads/${id}${query({ path, offset, size: file.size, overwrite: opts.overwrite || undefined })}`;
  let offset = 0;
  let chunkSize = CHUNK_START;
  let attempt = 0;
  try {
    for (;;) {
      const end = Math.min(file.size, offset + chunkSize);
      const started = performance.now();
      try {
        const res = await putChunk(url(offset), file.slice(offset, end), (loaded) => opts.onProgress(offset + loaded), opts.signal);
        attempt = 0;
        chunkSize = nextChunkSize(end - offset, performance.now() - started);
        offset = res.received;
        opts.onProgress(offset);
        if (res.written) return res.written;
      } catch (err) {
        if (err instanceof Aborted) throw err;
        const received = (err as ApiError).details as { received?: number } | undefined;
        if (err instanceof ApiError && err.status === 409 && typeof received?.received === 'number') {
          offset = received.received;
          continue;
        }
        const retryable = err instanceof TypeError || (err instanceof ApiError && (err.status >= 500 || err.status === 429));
        if (!retryable || attempt >= 4) throw err;
        await sleep(retryDelayMs(attempt++), opts.signal);
      }
    }
  } catch (err) {
    if (err instanceof Aborted) {
      void fetch(`${base(slug)}/uploads/${id}${query({ path })}`, {
        method: 'DELETE',
        headers: { 'x-csrf': '1' },
        credentials: 'same-origin',
      }).catch(() => undefined);
    }
    throw err;
  }
}

export const isAborted = (err: unknown): boolean => err instanceof Aborted;
