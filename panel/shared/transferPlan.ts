/**
 * How much to move in one request, for transfers made of many short requests: the panel's own
 * uploads from the browser (web/src/lib/uploadPlan.ts), and an import pulling a site's files from
 * the old host. Each request has to finish well inside a time limit nobody here controls - Traefik
 * ends a request that takes longer than 60 s to arrive, and a shared host ends a PHP request after
 * its `max_execution_time` - on a slow line as much as on a fast one. So: start small, then aim for
 * about ten seconds a request, doubling while they come back fast and halving when one was slow.
 */

export const CHUNK_MIN = 256 * 1024;
export const CHUNK_START = 1024 * 1024;
export const CHUNK_MAX = 8 * 1024 * 1024;
export const TARGET_MS = 10_000;

/** The size of the next request, from the last one's size and how long it took. */
export function nextChunkSize(sent: number, tookMs: number, max = CHUNK_MAX): number {
  if (tookMs <= 0) return Math.min(max, sent * 2);
  let next = sent;
  if (tookMs < TARGET_MS / 2) next = sent * 2;
  else if (tookMs > TARGET_MS * 2) next = Math.floor(sent / 2);
  return Math.max(Math.min(CHUNK_MIN, max), Math.min(max, next));
}
