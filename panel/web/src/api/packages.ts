// @docs sites/duplicator
import { useQuery } from '@tanstack/react-query';
import type { PackageInspectionDto } from '../../../shared/types';
import { api } from './client';
import { uploadInChunks } from './chunkUpload';

const CHUNK = 8 * 1024 * 1024;

/**
 * A Duplicator package to the panel's disk, chunk by chunk, under `id` (lib/uploadPlan newUploadId):
 * the id goes to POST /api/sites (package), or to discardPackage when the upload stops part way.
 */
export async function uploadPackage(id: string, file: Blob, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  await uploadInChunks((offset, size) => `/api/package-uploads/${id}?offset=${offset}&size=${size}`, file, CHUNK, onProgress, signal);
}

/** What an uploaded package holds, read once: it does not change. */
export function usePackageInspection(id: string | null) {
  return useQuery({
    queryKey: ['package-upload', id],
    queryFn: () => api<PackageInspectionDto>(`/api/package-uploads/${id}`),
    enabled: id !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** An upload nobody is going to use: gone at once rather than in a day. */
export function discardPackage(id: string): void {
  void api(`/api/package-uploads/${id}`, { method: 'DELETE' }).catch(() => undefined);
}
