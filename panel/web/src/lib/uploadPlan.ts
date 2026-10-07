/**
 * How big each upload chunk is: shared/transferPlan.ts, which an import's pull uses too. Traefik
 * ends any request that takes longer than 60 s to arrive, so a chunk has to cross the operator's
 * uplink well within that - on hotel wifi as much as on fibre.
 */
export { CHUNK_MAX, CHUNK_MIN, CHUNK_START, nextChunkSize } from '../../../shared/transferPlan';

/** Upload ids are the client's to choose (see UPLOAD_ID_RE). */
export function newUploadId(): string {
  return crypto.randomUUID();
}

/** How long to wait before retrying a chunk that failed on the network. */
export const retryDelayMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);
