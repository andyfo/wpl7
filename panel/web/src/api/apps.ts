// @docs sites/container
/**
 * A container app's calls (routes/apps.ts). Its settings come with the site (SiteDetail.container);
 * its log is polled while its tab is open.
 */
import { useQuery } from '@tanstack/react-query';
import type { AppDto } from '../../../shared/types';
import { api } from './client';
import { uploadInChunks } from './chunkUpload';
import { newUploadId } from '../lib/uploadPlan';

export interface AppLogLine {
  ts: string;
  text: string;
}

/** The newest lines of the app's log, read again every 2 s while `on`. */
export const useAppLogs = (slug: string, on: boolean) =>
  useQuery({
    queryKey: ['app-logs', slug],
    queryFn: () => api<{ lines: AppLogLine[] }>(`/api/sites/${slug}/app/logs?tail=1000`),
    refetchInterval: on ? 2000 : false,
    retry: false,
  });

export const patchApp = (slug: string, body: Record<string, unknown>) =>
  api<{ app: AppDto; job: { id: number } | null }>(`/api/sites/${slug}/app`, { method: 'PATCH', body });

export const saveRoutes = (slug: string, routes: unknown[]) => api<AppDto>(`/api/sites/${slug}/app/routes`, { method: 'PUT', body: { routes } });

export const saveRegistryAuth = (slug: string, username: string, token: string) =>
  api<AppDto>(`/api/sites/${slug}/app/registry-auth`, { method: 'PUT', body: { username, token } });

export const makeDeployToken = (slug: string) => api<{ token: string; header: string; url: string }>(`/api/sites/${slug}/app/deploy-token`, { method: 'POST' });

export const clearDeployToken = (slug: string) => api<void>(`/api/sites/${slug}/app/deploy-token`, { method: 'DELETE' });

/** 8 MiB a chunk, as the panel takes them. */
const CHUNK = 8 * 1024 * 1024;

/** An image archive (`docker save`) to the panel: its id goes to New site or Upload image. */
export async function uploadAppImage(file: Blob, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const id = newUploadId();
  await uploadInChunks((offset, size) => `/api/app-uploads/${id}?offset=${offset}&size=${size}`, file, CHUNK, onProgress, signal);
  return id;
}

/** A mount's archive (.tar.gz or .zip) to the app's server: its id goes to PUT …/mounts/:name. */
export async function uploadMountArchive(
  slug: string,
  file: Blob,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const id = newUploadId();
  await uploadInChunks((offset, size) => `/api/sites/${slug}/app/mount-uploads/${id}?offset=${offset}&size=${size}`, file, CHUNK, onProgress, signal);
  return id;
}

/** `sha256:4f3c…` → `4f3c2a1b9d0e` */
export const shortDigest = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 12);

/** What a deploy ran, in a few characters: its digest, or the upload's image id. */
export const imageOf = (d: { digest: string; imageId: string }): string => (d.digest ? shortDigest(d.digest) : d.imageId ? `upload ${shortDigest(d.imageId)}` : '–');
