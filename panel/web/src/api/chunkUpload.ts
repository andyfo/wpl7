import { ApiError } from './client';
import { retryDelayMs } from '../lib/uploadPlan';

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Send a file in chunks to an upload endpoint that takes `?offset=&size=` (a database dump, a
 * container app's image or mount archive). It carries on from wherever the server says the upload
 * is, so the same id sent again resumes. A chunk lost on the network, or turned away for a moment
 * (429, 5xx), is sent again after a pause.
 */
export async function uploadInChunks(
  urlFor: (offset: number, size: number) => string,
  blob: Blob,
  chunkBytes: number,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = blob.size;
  let offset = 0;
  let attempt = 0;
  onProgress(0, total);
  while (offset < total) {
    signal?.throwIfAborted();
    const chunk = blob.slice(offset, offset + chunkBytes);
    let res: Response | null = null;
    try {
      res = await fetch(urlFor(offset, total), {
        method: 'PUT',
        headers: { 'x-csrf': '1', 'content-type': 'application/octet-stream' },
        body: chunk,
        credentials: 'same-origin',
        signal,
      });
    } catch (err) {
      if (signal?.aborted || attempt >= 5) throw err;
    }
    if (res) {
      const json = (await res.json().catch(() => null)) as
        | { received?: number; error?: { code: string; message: string; details?: { received?: number } } }
        | null;
      if (res.status === 409 && typeof json?.error?.details?.received === 'number') {
        offset = json.error.details.received;
        onProgress(offset, total);
        continue;
      }
      if (res.ok) {
        attempt = 0;
        offset = json?.received ?? offset + chunk.size;
        onProgress(offset, total);
        continue;
      }
      if ((res.status < 500 && res.status !== 429) || attempt >= 5) {
        throw new ApiError(res.status, json?.error?.code ?? 'internal', json?.error?.message ?? `HTTP ${res.status}`);
      }
    }
    await pause(retryDelayMs(attempt++), signal);
  }
}
