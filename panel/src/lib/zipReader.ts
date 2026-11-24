// @docs sites/duplicator
/**
 * A .zip the panel did not make, read in place: a Duplicator package (services/duplicator.ts).
 * The central directory says what is in it; each entry is read at its own offset, inflated, and
 * checked against its size and CRC-32 before the next one. ZIP64 is read. Encrypted entries,
 * compression other than none and deflate, and archives split over several files are refused.
 * Whatever made the archive is trusted for none of it: names are bytes, checked by the caller
 * (lib/archivePath.ts), and sizes are what the central directory claims until the data agrees.
 */
import type { FileHandle } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
/** The central directory is read in pieces of this size. */
const CD_CHUNK = 4 * 1024 * 1024;
/**
 * Entries up to these sizes, packed and inflated, are inflated in one go; bigger ones are streamed,
 * so that no one inflate holds the event loop for long.
 */
const WHOLE_ENTRY = 1024 * 1024;
const WHOLE_PLAIN = 4 * 1024 * 1024;
const PIECE = 1024 * 1024;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export type ZipEntryKind = 'file' | 'dir' | 'link' | 'other';

export interface ZipEntry {
  /** The name's bytes, as the archive holds them. */
  name: Buffer;
  kind: ZipEntryKind;
  /** 0 stored, 8 deflate; anything else is refused when read. */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Unix seconds: the extended timestamp when there is one, else the DOS time, read as UTC. */
  mtime: number;
  /** The permission bits of an archive made on Unix; null when it does not say. */
  mode: number | null;
  /** Where the entry's local header starts. */
  offset: number;
}

/** DOS date and time to Unix seconds. A field out of range reads as the epoch. */
function dosTime(time: number, date: number): number {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return 0;
  return Math.floor(Date.UTC(year, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2) / 1000);
}

/** A 64-bit little-endian count, refused past what a double holds exactly. */
function u64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('A size or offset in the archive is too large');
  return Number(value);
}

export class ZipReader {
  private constructor(
    private readonly fh: FileHandle,
    readonly fileSize: number,
    /** How many entries the central directory holds. */
    readonly count: number,
    private readonly cdOffset: number,
    private readonly cdSize: number,
    /** The count is the most a plain end record holds: true only if the directory has no more. */
    private readonly countIsCeiling = false,
  ) {}

  /** Open `file` and find its central directory. Refuses what is not a single-file .zip. */
  static async open(file: string): Promise<ZipReader> {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const tailSize = Math.min(size, EOCD_SIZE + 0xffff + ZIP64_LOCATOR_SIZE);
      const tail = Buffer.alloc(tailSize);
      await read(fh, tail, size - tailSize);
      // The record nearest the end whose comment length reaches exactly to the end of the file.
      let eocd = -1;
      for (let i = tailSize - EOCD_SIZE; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG && i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tailSize) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new ZipFormatError('Not a .zip archive, or one cut short: its central directory is missing');
      const disk = tail.readUInt16LE(eocd + 4);
      const cdDisk = tail.readUInt16LE(eocd + 6);
      let entriesOnDisk = tail.readUInt16LE(eocd + 8);
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      let countIsCeiling = false;
      const locator = eocd - ZIP64_LOCATOR_SIZE;
      if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
        if (tail.readUInt32LE(locator + 4) !== 0 || tail.readUInt32LE(locator + 16) > 1) {
          throw new ZipFormatError('The archive is split over several files');
        }
        const at = u64(tail, locator + 8);
        const z = Buffer.alloc(56);
        if (at + z.length > size) throw new ZipFormatError('The ZIP64 end record is outside the file');
        await read(fh, z, at);
        if (z.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipFormatError('The ZIP64 end record is missing');
        if (z.readUInt32LE(16) !== 0 || z.readUInt32LE(20) !== 0) throw new ZipFormatError('The archive is split over several files');
        entriesOnDisk = u64(z, 24);
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      } else if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new ZipFormatError('The archive needs ZIP64 records it does not have');
      } else if (disk !== 0 || cdDisk !== 0) {
        throw new ZipFormatError('The archive is split over several files');
      } else {
        // 65,535 entries fit a plain record exactly, and are what one says when it has more.
        countIsCeiling = count === 0xffff;
      }
      if (entriesOnDisk !== count) throw new ZipFormatError('The archive is split over several files');
      if (cdOffset + cdSize > size) throw new ZipFormatError('The central directory is outside the file');
      if (count > 10_000_000) throw new ZipFormatError(`The archive claims ${count} entries`);
      return new ZipReader(fh, size, count, cdOffset, cdSize, countIsCeiling);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  /** Every entry, in central directory order. */
  async *entries(): AsyncGenerator<ZipEntry> {
    let buf = Buffer.alloc(0);
    let pos = this.cdOffset;
    const end = this.cdOffset + this.cdSize;
    let seen = 0;
    const need = async (n: number) => {
      while (buf.length < n) {
        if (pos >= end) throw new ZipFormatError('The central directory ends in the middle of an entry');
        const piece = Buffer.alloc(Math.min(CD_CHUNK, end - pos));
        await read(this.fh, piece, pos);
        pos += piece.length;
        buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);
      }
    };
    while (seen < this.count) {
      await need(CENTRAL_SIZE);
      if (buf.readUInt32LE(0) !== CENTRAL_SIG) throw new ZipFormatError(`Entry ${seen + 1} of the central directory is damaged`);
      const nameLen = buf.readUInt16LE(28);
      const extraLen = buf.readUInt16LE(30);
      const commentLen = buf.readUInt16LE(32);
      const total = CENTRAL_SIZE + nameLen + extraLen + commentLen;
      await need(total);
      yield parseCentral(buf.subarray(0, total), nameLen, extraLen);
      buf = buf.subarray(total);
      seen++;
    }
    if (this.countIsCeiling && (buf.length > 0 || pos < end)) {
      throw new ZipFormatError('The archive has more than 65,535 entries but no ZIP64 records to say how many');
    }
  }

  /**
   * An entry's content, as `sink` takes it piece by piece. Refused when it is encrypted or packed
   * in a way the panel does not read; fails when the content is longer or shorter than the
   * central directory says, or its CRC-32 differs.
   */
  async pipe(entry: ZipEntry, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    const shown = entry.name.toString('utf8');
    if (entry.encrypted) throw new ZipFormatError(`${shown} is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) throw new ZipFormatError(`${shown} is packed with method ${entry.method}, which the panel does not read`);
    const local = Buffer.alloc(LOCAL_SIZE);
    if (entry.offset + LOCAL_SIZE > this.fileSize) throw new ZipFormatError(`${shown}: its data is outside the file`);
    await read(this.fh, local, entry.offset);
    if (local.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError(`${shown}: its local header is damaged`);
    const start = entry.offset + LOCAL_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (start + entry.compressedSize > this.fileSize) throw new ZipFormatError(`${shown}: its data runs past the end of the file`);

    let crc = 0;
    let out = 0;
    const emit = async (chunk: Buffer) => {
      out += chunk.length;
      if (out > entry.size) throw new ZipFormatError(`${shown} holds more than the ${entry.size} bytes it claims`);
      crc = zlib.crc32(chunk, crc);
      for (let i = 0; i < chunk.length; i += PIECE) await sink(chunk.subarray(i, i + PIECE));
    };

    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new ZipFormatError(`${shown}: stored, yet its sizes differ`);
      for (let at = 0; at < entry.compressedSize; at += PIECE) {
        const piece = Buffer.allocUnsafe(Math.min(PIECE, entry.compressedSize - at));
        await read(this.fh, piece, start + at);
        await emit(piece);
      }
    } else if (entry.compressedSize <= WHOLE_ENTRY && entry.size <= WHOLE_PLAIN) {
      const packed = Buffer.allocUnsafe(entry.compressedSize);
      await read(this.fh, packed, start);
      let plain: Buffer;
      try {
        // One byte more than claimed: a longer stream is caught rather than cut to size.
        plain = zlib.inflateRawSync(packed, { maxOutputLength: entry.size + 1 });
      } catch (err) {
        throw new ZipFormatError(`${shown} cannot be inflated: ${err instanceof Error ? err.message : String(err)}`);
      }
      await emit(plain);
    } else {
      // Read as it is taken: what it inflates to waits in the stream, not in memory, and a stream
      // longer than claimed stops at the first byte too many. The pipeline ends every part of it
      // when one fails, and the error is the one that part threw: only zlib's own is the package's.
      const fh = this.fh;
      const pieces = async function* () {
        for (let at = 0; at < entry.compressedSize; at += PIECE) {
          const piece = Buffer.allocUnsafe(Math.min(PIECE, entry.compressedSize - at));
          await read(fh, piece, start + at);
          yield piece;
        }
      };
      // What the sink threw, which the pipeline may report as its own abort instead.
      let sinkError: unknown = null;
      try {
        await pipeline(Readable.from(pieces()), zlib.createInflateRaw(), async (source: AsyncIterable<Buffer>) => {
          for await (const chunk of source) {
            try {
              await emit(chunk);
            } catch (err) {
              sinkError = err;
              throw err;
            }
          }
        });
      } catch (err) {
        if (sinkError !== null) throw sinkError;
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && code.startsWith('Z_')) throw new ZipFormatError(`${shown} cannot be inflated: ${(err as Error).message}`);
        // The deflated data ended while the entry still had bytes to give: not a .zip anyone wrote.
        if (code === 'ABORT_ERR') throw new ZipFormatError(`${shown}: its deflated data ends before the entry does`);
        throw err;
      }
    }
    if (out !== entry.size) throw new ZipFormatError(`${shown} holds ${out} bytes, not the ${entry.size} it claims`);
    if (crc >>> 0 !== entry.crc32 >>> 0) throw new ZipFormatError(`${shown} is damaged: its CRC-32 does not match`);
  }

  /** A small entry's content whole, refused past `max` bytes. */
  async readAll(entry: ZipEntry, max: number): Promise<Buffer> {
    if (entry.size > max) throw new ZipFormatError(`${entry.name.toString('utf8')} is larger than ${max} bytes`);
    const parts: Buffer[] = [];
    await this.pipe(entry, async (chunk) => {
      parts.push(Buffer.from(chunk));
    });
    return Buffer.concat(parts);
  }
}

async function read(fh: FileHandle, into: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < into.length) {
    const { bytesRead } = await fh.read(into, done, into.length - done, position + done);
    if (bytesRead === 0) throw new ZipFormatError('The archive ends early');
    done += bytesRead;
  }
}

function parseCentral(rec: Buffer, nameLen: number, extraLen: number): ZipEntry {
  const madeBy = rec.readUInt16LE(4) >> 8;
  const flags = rec.readUInt16LE(8);
  const method = rec.readUInt16LE(10);
  let mtime = dosTime(rec.readUInt16LE(12), rec.readUInt16LE(14));
  const crc32 = rec.readUInt32LE(16);
  let compressedSize = rec.readUInt32LE(20);
  let size = rec.readUInt32LE(24);
  let diskStart = rec.readUInt16LE(34);
  const external = rec.readUInt32LE(38);
  let offset = rec.readUInt32LE(42);
  const name = Buffer.from(rec.subarray(CENTRAL_SIZE, CENTRAL_SIZE + nameLen));
  const extra = rec.subarray(CENTRAL_SIZE + nameLen, CENTRAL_SIZE + nameLen + extraLen);

  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    const data = extra.subarray(i + 4, i + 4 + len);
    if (id === 0x0001) {
      // ZIP64: the fields that read all ones in the record, in this order.
      let at = 0;
      const next = () => {
        if (at + 8 > data.length) throw new ZipFormatError(`${name.toString('utf8')}: its ZIP64 field is too short`);
        const v = u64(data, at);
        at += 8;
        return v;
      };
      if (size === 0xffffffff) size = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (offset === 0xffffffff) offset = next();
      if (diskStart === 0xffff && at + 4 <= data.length) diskStart = data.readUInt32LE(at);
    } else if (id === 0x5455 && data.length >= 5 && (data[0]! & 1) === 1) {
      mtime = data.readUInt32LE(1);
    }
    i += 4 + len;
  }
  if (diskStart !== 0) throw new ZipFormatError('The archive is split over several files');

  // Unix (3) and macOS (19) archivers keep the file's mode in the upper half of the attributes.
  const unixMode = madeBy === 3 || madeBy === 19 ? external >>> 16 : 0;
  const type = unixMode & 0o170000;
  let kind: ZipEntryKind;
  if (name[name.length - 1] === 0x2f || type === 0o040000 || (unixMode === 0 && (external & 0x10) !== 0)) kind = 'dir';
  else if (type === 0o120000) kind = 'link';
  else if (type === 0 || type === 0o100000) kind = 'file';
  else kind = 'other';
  return {
    name,
    kind,
    method,
    encrypted: (flags & 1) === 1 || method === 99,
    compressedSize,
    size,
    crc32,
    mtime,
    mode: unixMode === 0 ? null : unixMode & 0o7777,
    offset,
  };
}
