// @docs sites/files
import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_LIMITS, joinSiteFilePath, newFileNameProblem } from '../../../../shared/siteFilePath';
import { isAborted, uploadFile } from '../../api/files';
import { ApiError } from '../../api/client';
import { formatBytes } from '../../lib/format';
import { Button } from '../ui';

type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'canceled';

export interface UploadItem {
  key: number;
  file: File;
  /** Where it goes, relative to the site folder. */
  path: string;
  overwrite: boolean;
  sent: number;
  status: UploadStatus;
  error?: string;
  /** Refused before it started (a name or a size the server would refuse too): retrying cannot help. */
  refused?: boolean;
}

/** Files at once; each is its own run of chunked requests, sharing the server's SSH channels. */
const PARALLEL = 3;

/**
 * The upload queue: add files, and they go up three at a time in the background while the
 * operator keeps browsing. `onUploaded` hears each one that lands.
 */
export function useUploads(slug: string, onUploaded: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<number, AbortController>());
  const nextKey = useRef(1);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const patch = useCallback((key: number, change: Partial<UploadItem>) => {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  const start = useCallback(
    (item: UploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      patch(item.key, { status: 'uploading', sent: 0, error: undefined });
      uploadFile(slug, item.path, item.file, {
        overwrite: item.overwrite,
        signal: controller.signal,
        onProgress: (sent) => patch(item.key, { sent }),
      })
        .then(() => {
          patch(item.key, { status: 'done', sent: item.file.size });
          onUploadedRef.current();
        })
        .catch((err: unknown) => {
          if (isAborted(err)) return patch(item.key, { status: 'canceled' });
          const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
          patch(item.key, { status: 'failed', error: message });
        })
        .finally(() => controllers.current.delete(item.key));
    },
    [slug, patch],
  );

  // The scheduler: whenever fewer than PARALLEL are running, start the next queued one.
  useEffect(() => {
    const running = items.filter((i) => i.status === 'uploading').length;
    // `controllers` is filled synchronously by start(), so a second pass over the same
    // snapshot (StrictMode, a batched update) never starts one file twice.
    const waiting = items
      .filter((i) => i.status === 'queued' && !controllers.current.has(i.key))
      .slice(0, Math.max(0, PARALLEL - running));
    for (const item of waiting) start(item);
  }, [items, start]);

  // Leaving the Files tab cancels what is still going (and removes what arrived of it).
  useEffect(() => () => controllers.current.forEach((c) => c.abort()), []);

  const add = useCallback((files: File[], dir: string, overwrite: (name: string) => boolean) => {
    const added = files.map((file): UploadItem => {
      const key = nextKey.current++;
      const problem =
        newFileNameProblem(file.name) ??
        (file.size > FILE_LIMITS.uploadBytes
          ? `Larger than ${formatBytes(FILE_LIMITS.uploadBytes)}, the most one upload can be`
          : null);
      return {
        key,
        file,
        path: joinSiteFilePath(dir, file.name),
        overwrite: overwrite(file.name),
        sent: 0,
        status: problem ? 'failed' : 'queued',
        error: problem ?? undefined,
        refused: problem !== null,
      };
    });
    setItems((all) => [...all, ...added]);
  }, []);

  const cancel = (key: number) => {
    const running = controllers.current.get(key);
    if (running) running.abort();
    else patch(key, { status: 'canceled' }); // still waiting its turn
  };
  const retry = (key: number) => patch(key, { status: 'queued', error: undefined, sent: 0 });
  const clearFinished = () => setItems((all) => all.filter((i) => i.status === 'queued' || i.status === 'uploading'));
  const busy = items.some((i) => i.status === 'queued' || i.status === 'uploading');

  return { items, add, cancel, retry, clearFinished, busy };
}

export function UploadPanel({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const { items, cancel, retry, clearFinished, busy } = uploads;
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">
          Uploads{' '}
          <span className="font-normal text-neutral-500">
            {done} of {items.length} done
          </span>
        </span>
        {!busy && (
          <Button small variant="ghost" onClick={clearFinished}>
            Clear
          </Button>
        )}
      </div>
      <ul className="max-h-60 space-y-1.5 overflow-y-auto text-sm">
        {items.map((i) => {
          const pct = i.file.size === 0 ? 100 : Math.round((i.sent / i.file.size) * 100);
          return (
            <li key={i.key} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={i.path}>
                <bdi>{i.path}</bdi>
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-neutral-500">{formatBytes(i.file.size)}</span>
              <span className="w-40 shrink-0">
                {i.status === 'uploading' || i.status === 'queued' ? (
                  <span className="block h-1.5 overflow-hidden rounded-full bg-neutral-200">
                    <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                  </span>
                ) : (
                  <span
                    className={`text-xs ${i.status === 'done' ? 'text-emerald-700' : i.status === 'failed' ? 'text-red-700' : 'text-neutral-500'}`}
                    title={i.error}
                  >
                    {i.status === 'done' ? 'Uploaded' : i.status === 'canceled' ? 'Canceled' : (i.error ?? 'Failed')}
                  </span>
                )}
              </span>
              <span className="w-16 shrink-0 text-right">
                {(i.status === 'uploading' || i.status === 'queued') && (
                  <Button small variant="ghost" onClick={() => cancel(i.key)}>
                    Cancel
                  </Button>
                )}
                {(i.status === 'failed' || i.status === 'canceled') && !i.refused && (
                  <Button small variant="ghost" onClick={() => retry(i.key)}>
                    Retry
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
