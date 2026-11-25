// @docs sites/container, sites/duplicator
/**
 * One chunk of a file sent in pieces (PUT …?offset=&size=, body application/octet-stream): an app's
 * image archive and a mount's (routes/apps.ts), a Duplicator package (routes/packages.ts). Each
 * piece says its size up front and is refused whole when its body is longer or shorter.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { AppError, badRequest, conflict, tooManyRequests } from '../lib/errors.js';

/** One chunk of an upload, as the database upload takes them. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** What the panel holds of chunks on their way, every upload together. */
const INFLIGHT_MAX = 64 * 1024 * 1024;
let inflightBytes = 0;

/** `work` with `length` bytes of the budget all uploads share: refused while the panel receives too much at once. */
export async function withChunkBudget<T>(length: number, work: () => Promise<T>): Promise<T> {
  if (inflightBytes + length > INFLIGHT_MAX) throw tooManyRequests('The panel is receiving too much at once; retry in a moment');
  inflightBytes += length;
  try {
    return await work();
  } finally {
    inflightBytes -= length;
  }
}

/** Files with a chunk being written: another chunk for one waits (429), or both would land. */
const writing = new Set<string>();
/**
 * The uploads under way, by file: their filesystem and the bytes they still have to send. A new
 * upload's room is counted after theirs; one with no chunk for an hour gives its room back.
 */
const underWay = new Map<string, { dev: number; left: number; at: number }>();
const UNDER_WAY_MS = 3600_000;

/** What the other uploads under way on filesystem `dev` still have to send. */
function owedBesides(file: string, dev: number, now: number): number {
  let owed = 0;
  for (const [other, u] of underWay) {
    // An upload whose file is gone (deleted, made a site of) owes nothing, unless its first chunk is still on its way.
    if (now - u.at > UNDER_WAY_MS || (!writing.has(other) && !fs.existsSync(other))) underWay.delete(other);
    else if (other !== file && u.dev === dev) owed += u.left;
  }
  return owed;
}

const noRoom = (free: number, need: number) =>
  new AppError('conflict', 507, `Not enough free disk on the panel's server: ${Math.round(free / 1e6)} MB free, about ${Math.round(need / 1e6)} MB needed`);

/**
 * One chunk of a file on the panel's own disk. The first starts the file once there is room for
 * `need` bytes besides what the other uploads under way there still have to send; each later one
 * has to begin where the file ends. No chunk may leave less than `keepFree` bytes free.
 */
export async function receiveChunk(
  req: FastifyRequest,
  opts: { dir: string; file: string; offset: number; size: number; need: number; keepFree?: number },
): Promise<{ received: number; complete: boolean }> {
  const { dir, file, offset, size, need, keepFree = 0 } = opts;
  const length = chunkLength(req);
  if (offset + length > size) throw badRequest('The chunk goes past the size given');
  if (writing.has(file)) throw tooManyRequests('A chunk of this upload is still being written; retry in a moment');
  writing.add(file);
  try {
    return await withChunkBudget(length, async () => {
      if (offset === 0) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const [disk, where] = await Promise.all([fsp.statfs(dir).catch(() => null), fsp.stat(dir).catch(() => null)]);
      const free = disk ? disk.bavail * disk.bsize : Infinity;
      const now = Date.now();
      if (offset === 0) {
        const owed = where ? owedBesides(file, where.dev, now) : 0;
        if (free < need + owed) throw noRoom(free, need + owed);
        // Reserved before anything waits again: a first chunk of another upload, checked meanwhile, counts it.
        if (where) underWay.set(file, { dev: where.dev, left: size, at: now });
      } else {
        const have = (await fsp.stat(file).catch(() => null))?.size ?? 0;
        if (have !== offset) throw conflict(`The upload has ${have} bytes; send the chunk from there`, { received: have });
      }
      // Every chunk on its way counts against what has to stay free, this one with them.
      if (free - inflightBytes < keepFree) {
        if (offset === 0) underWay.delete(file);
        throw noRoom(free, inflightBytes + keepFree);
      }
      try {
        await writeChunk(req, file, length, offset === 0 ? 'w' : 'a');
      } catch (err) {
        if (offset === 0) underWay.delete(file);
        throw err;
      }
      const received = offset + length;
      if (received === size) underWay.delete(file);
      else if (where) underWay.set(file, { dev: where.dev, left: size - received, at: now });
      return { received, complete: received === size };
    });
  } finally {
    writing.delete(file);
  }
}

/** The chunk's size, as its Content-Length says: it has to be known up front. */
export function chunkLength(req: FastifyRequest): number {
  const encoding = req.headers['content-encoding'];
  if (encoding && encoding !== 'identity') throw new AppError('validation_error', 415, 'Send the chunk as it is (no Content-Encoding)');
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1) throw new AppError('validation_error', 411, 'Send a Content-Length: the size has to be known up front');
  if (length > CHUNK_BYTES) throw new AppError('validation_error', 413, `Too large: at most ${CHUNK_BYTES} bytes per chunk`);
  if (!(req.body instanceof Readable)) throw new AppError('validation_error', 415, 'Send the chunk as application/octet-stream');
  return length;
}

/** The chunk, whole, refusing a body that is not as long as it said. */
export async function readChunk(req: FastifyRequest, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of req.body as Readable) {
    got += (chunk as Buffer).length;
    if (got > length) throw badRequest('The body is longer than its Content-Length');
    chunks.push(chunk as Buffer);
  }
  if (got !== length) throw badRequest('The body is shorter than its Content-Length');
  return Buffer.concat(chunks, length);
}

/** Stream the chunk to the file, refusing a body that is not as long as it said. A short or long one leaves the file as it was. */
export async function writeChunk(req: FastifyRequest, file: string, length: number, flags: 'w' | 'a'): Promise<void> {
  const before = flags === 'a' ? ((await fsp.stat(file).catch(() => null))?.size ?? 0) : 0;
  let got = 0;
  const counted = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      got += chunk.length;
      if (got > length) throw badRequest('The body is longer than its Content-Length');
      yield chunk;
    }
  };
  try {
    await pipeline(req.body as Readable, counted, fs.createWriteStream(file, { flags, mode: 0o600 }));
    if (got !== length) throw badRequest('The body is shorter than its Content-Length');
  } catch (err) {
    await fsp.truncate(file, before).catch(() => undefined);
    throw err;
  }
}
