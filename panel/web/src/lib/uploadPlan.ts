/**
 * How big each upload chunk is. Traefik ends any request that takes longer than 60 s to
 * arrive, so a chunk has to cross the operator's uplink well within that - on hotel wifi as
 * much as on fibre. Start small, then aim for about ten seconds a chunk: doubling while they
 * come back fast, halving when one was slow.
 */

export const CHUNK_MIN = 256 * 1024;
export const CHUNK_START = 1024 * 1024;
export const CHUNK_MAX = 8 * 1024 * 1024;
const TARGET_MS = 10_000;

export function nextChunkSize(sent: number, tookMs: number): number {
  if (tookMs <= 0) return Math.min(CHUNK_MAX, sent * 2);
  let next = sent;
  if (tookMs < TARGET_MS / 2) next = sent * 2;
  else if (tookMs > TARGET_MS * 2) next = Math.floor(sent / 2);
  return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, next));
}

/** Upload ids are the client's to choose (see UPLOAD_ID_RE). */
export function newUploadId(): string {
  return crypto.randomUUID();
}

/** How long to wait before retrying a chunk that failed on the network. */
export const retryDelayMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);
