// @docs sites/duplicator
/**
 * A DupArchive (.daf): the format Duplicator writes when it does not make a .zip
 * (services/duplicator.ts). Read in archive order, the way Duplicator's own expander reads it:
 *
 *   <A><V>version</V><X>flags</X><P>password hash</P></A>      (5.0.0 on; before, <C>compressed</C>)
 *   <D><MT>mtime</MT><P>perms</P><RPL>n</RPL><RP>path</RP></D>                  a folder
 *   <F><FS>size</FS><MT>…</MT><P>…</P><X>flags</X><HA>…</HA><RPL>n</RPL><RP>path</RP></F>
 *     then <G><OS>size</OS><SS>stored</SS><HA>crc32</HA></G> and the stored bytes, until the
 *     globs add up to the file's size. Flag 1: each glob is raw deflate. Flag 2: AES, refused.
 *
 * The first file is usually `__dup__archive__index.json`, Duplicator's own index, which the panel
 * skips. Every glob is checked against its CRC-32 and its size, and no length the archive gives is
 * taken past what Duplicator itself would write: nothing it says is trusted further.
 */
import type { FileHandle } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

export class DafFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DafFormatError';
  }
}

export const DAF_INDEX_FILE = '__dup__archive__index.json';
const FLAG_COMPRESS = 1;
const FLAG_CRYPT = 2;
/** Duplicator's own limit on a header field (AbstractDupArchiveHeader::MAX_FILED_LEN). */
const MAX_FIELD = 1024;
/** Read past what is needed: a header is a few dozen bytes, and a skipped glob leaves the buffer behind. */
const READ_AHEAD = 64 * 1024;
/** Duplicator writes globs of 1 MiB (DupArchiveCreateState::DEFAULT_GLOB_SIZE); a larger one is not its own. */
/** A file's hash when Duplicator took none: past 100 MiB, or a file it could not read whole. */
const NO_FILE_HASH = '0'.repeat(32);
const MAX_GLOB = 16 * 1024 * 1024;
/** A path no longer than the panel writes (lib/archivePath.ts). */
const MAX_PATH = 4096;

export interface DafEntry {
  kind: 'file' | 'dir';
  /** The path's bytes, as the archive holds them. */
  name: Buffer;
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** Permission bits; 0644 or 0755 when the archive's do not parse. */
  mode: number;
  compressed: boolean;
  encrypted: boolean;
  /** The content's CRC-32 as the archive gives it; null where Duplicator gave none (past 100 MiB, or unreadable). */
  hash: string | null;
  /** Where the entry's header starts: readAt() reads it again from there. */
  offset: number;
}

export interface DafInfo {
  version: string;
  compressed: boolean;
  /** Packed with a password: the panel reads none of it. */
  encrypted: boolean;
  /** Where the first entry starts. */
  firstEntry: number;
}

/** A sink for an entry's content, or null to skip it. */
export type DafSink = ((chunk: Buffer) => Promise<void>) | null;

const atLeast = (version: string, major: number): boolean => Number(version.split('.')[0]) >= major;

/** A forward-reading cursor over the file, with a buffer ahead of it. */
class Cursor {
  private buf = Buffer.alloc(0);
  /** The file position of buf[0]. */
  private bufAt = 0;

  constructor(
    private readonly fh: FileHandle,
    readonly size: number,
    public pos: number,
  ) {
    this.bufAt = pos;
  }

  private async fill(n: number): Promise<void> {
    const have = this.bufAt + this.buf.length - this.pos;
    if (this.pos < this.bufAt || have < 0) {
      this.buf = Buffer.alloc(0);
      this.bufAt = this.pos;
    }
    if (this.bufAt + this.buf.length - this.pos >= n) return;
    const keep = this.buf.subarray(this.pos - this.bufAt);
    const want = Math.max(n - keep.length, READ_AHEAD);
    const more = Buffer.allocUnsafe(Math.min(want, this.size - (this.pos + keep.length)));
    let done = 0;
    while (done < more.length) {
      const { bytesRead } = await this.fh.read(more, done, more.length - done, this.pos + keep.length + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    this.buf = Buffer.concat([keep, more.subarray(0, done)]);
    this.bufAt = this.pos;
    if (this.buf.length < n) throw new DafFormatError(`The archive ends early, at byte ${this.pos + this.buf.length}`);
  }

  get atEnd(): boolean {
    return this.pos >= this.size;
  }

  async bytes(n: number): Promise<Buffer> {
    await this.fill(n);
    const out = this.buf.subarray(this.pos - this.bufAt, this.pos - this.bufAt + n);
    this.pos += n;
    return out;
  }

  async peek(n: number): Promise<Buffer> {
    await this.fill(Math.min(n, this.size - this.pos));
    return this.buf.subarray(this.pos - this.bufAt, this.pos - this.bufAt + n);
  }

  async expect(text: string): Promise<void> {
    const at = this.pos;
    const got = await this.bytes(text.length);
    if (got.toString('latin1') !== text) throw new DafFormatError(`Expected ${text} at byte ${at}, found ${JSON.stringify(got.toString('latin1'))}`);
  }

  /** `<NAME>value</NAME>`: the value's bytes. */
  async field(name: string): Promise<Buffer> {
    await this.expect(`<${name}>`);
    const end = Buffer.from(`</${name}>`, 'latin1');
    await this.fill(Math.min(MAX_FIELD + end.length, this.size - this.pos));
    const window = this.buf.subarray(this.pos - this.bufAt, this.pos - this.bufAt + MAX_FIELD + end.length);
    const at = window.indexOf(end);
    if (at < 0) throw new DafFormatError(`The field ${name} at byte ${this.pos} does not end`);
    const value = Buffer.from(window.subarray(0, at));
    this.pos += at + end.length;
    return value;
  }

  async number(name: string): Promise<number> {
    const raw = (await this.field(name)).toString('latin1');
    if (!/^\d{1,16}$/.test(raw)) throw new DafFormatError(`The field ${name} is not a number: ${JSON.stringify(raw.slice(0, 40))}`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new DafFormatError(`The field ${name} is too large`);
    return n;
  }

  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.size) throw new DafFormatError('The archive ends early');
  }
}

export class DafReader {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
    readonly info: DafInfo,
  ) {}

  static async open(file: string): Promise<DafReader> {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const c = new Cursor(fh, size, 0);
      await c.expect('<A>');
      const version = (await c.field('V')).toString('latin1');
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new DafFormatError(`Not a DupArchive version: ${JSON.stringify(version.slice(0, 20))}`);
      let flags = 0;
      let password = '';
      if (atLeast(version, 5)) {
        await c.expect('<X>');
        flags = (await c.bytes(2)).readUInt16LE(0);
        await c.expect('</X>');
        password = (await c.field('P')).toString('latin1');
      } else {
        flags = /^(true|1)$/i.test((await c.field('C')).toString('latin1')) ? FLAG_COMPRESS : 0;
      }
      await c.expect('</A>');
      return new DafReader(fh, size, {
        version,
        compressed: (flags & FLAG_COMPRESS) !== 0,
        encrypted: (flags & FLAG_CRYPT) !== 0 || password !== '',
        firstEntry: c.pos,
      });
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  /**
   * Every entry from `from`, in archive order. `onEntry` returns a sink for a file's content, null
   * (or nothing) to skip it, or 'stop' to end the walk there.
   */
  /**
   * Every entry from `from` on. A file's content goes to the sink `onEntry` gives for it, checked
   * part by part and whole; one whose whole differs from its CRC-32 goes to `onMismatch`, which
   * Duplicator's installer reports and goes on (a file that changed while the package was made),
   * and without one fails the walk.
   */
  async walk(opts: { from?: number; onEntry: (entry: DafEntry) => Promise<DafSink | 'stop' | void>; onMismatch?: (entry: DafEntry) => void }): Promise<void> {
    const c = new Cursor(this.fh, this.size, opts.from ?? this.info.firstEntry);
    const v5 = atLeast(this.info.version, 5);
    while (!c.atEnd) {
      const offset = c.pos;
      const marker = (await c.peek(3)).toString('latin1');
      if (marker === '<D>') {
        await c.expect('<D>');
        const mtime = await c.number('MT');
        const mode = parseMode((await c.field('P')).toString('latin1'), 0o755);
        const length = pathLength(await c.number('RPL'), offset);
        await c.expect('<RP>');
        const name = Buffer.from(await c.bytes(length));
        await c.expect('</RP></D>');
        const next = await opts.onEntry({ kind: 'dir', name, size: 0, mtime, mode, compressed: false, encrypted: false, hash: null, offset });
        if (next === 'stop') return;
        continue;
      }
      if (marker !== '<F>') throw new DafFormatError(`Expected a folder or a file at byte ${offset}, found ${JSON.stringify(marker)}`);
      await c.expect('<F>');
      const size = await c.number('FS');
      const mtime = await c.number('MT');
      const mode = parseMode((await c.field('P')).toString('latin1'), 0o644);
      let flags: number | null = null;
      if (v5) {
        await c.expect('<X>');
        flags = (await c.bytes(2)).readUInt16LE(0);
        await c.expect('</X>');
      }
      const hash = (await c.field('HA')).toString('latin1').toLowerCase();
      // Eight hex digits, or the 32 zeros Duplicator writes where it took none.
      if (!/^[0-9a-f]{8}$/.test(hash) && hash !== NO_FILE_HASH) throw new DafFormatError(`The file at byte ${offset} has a damaged header: its CRC-32 is ${JSON.stringify(hash.slice(0, 40))}`);
      const length = pathLength(await c.number('RPL'), offset);
      await c.expect('<RP>');
      const name = Buffer.from(await c.bytes(length));
      await c.expect('</RP></F>');
      // Before 5.0.0 the archive's flag is every file's, but for the index: it is written at a
      // fixed size, to be rewritten in place, and so never compressed.
      flags ??= this.info.compressed && name.toString('latin1') !== DAF_INDEX_FILE ? FLAG_COMPRESS : 0;
      const entry: DafEntry = {
        kind: 'file',
        name,
        size,
        mtime,
        mode,
        compressed: (flags & FLAG_COMPRESS) !== 0,
        encrypted: (flags & FLAG_CRYPT) !== 0,
        hash: hash === NO_FILE_HASH ? null : hash,
        offset,
      };
      const sink = await opts.onEntry(entry);
      if (sink === 'stop') return;
      const crc = await this.globs(c, entry, v5, sink ?? null);
      if (crc !== null && entry.hash !== null && crc !== entry.hash) {
        if (!opts.onMismatch) throw new DafFormatError(`${entry.name.toString('utf8')} is damaged: it does not match its CRC-32`);
        opts.onMismatch(entry);
      }
    }
  }

  /** The globs of a file whose header was just read: to `sink`, checked, or skipped. Returns the content's CRC-32 when it was read. */
  private async globs(c: Cursor, entry: DafEntry, v5: boolean, sink: DafSink): Promise<string | null> {
    const shown = entry.name.toString('utf8');
    if (sink && entry.encrypted) throw new DafFormatError(`${shown} is encrypted`);
    let got = 0;
    let whole = 0;
    while (got < entry.size) {
      await c.expect('<G>');
      const original = await c.number('OS');
      const stored = await c.number('SS');
      const hash = (await c.field('HA')).toString('latin1').toLowerCase();
      await c.expect('</G>');
      if (original === 0 || original > MAX_GLOB || stored > MAX_GLOB || got + original > entry.size) {
        throw new DafFormatError(`${shown}: a part of it has an impossible size (${original} of ${entry.size} bytes)`);
      }
      if (!sink) {
        c.skip(stored);
        got += original;
        continue;
      }
      // Not copied: the cursor reads into new buffers only, so this one stays as it is.
      const packed = await c.bytes(stored);
      let plain: Buffer;
      if (entry.compressed) {
        try {
          plain = zlib.inflateRawSync(packed, { maxOutputLength: original + 1 });
        } catch (err) {
          throw new DafFormatError(`${shown} cannot be inflated: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        plain = packed;
      }
      if (plain.length !== original) throw new DafFormatError(`${shown}: a part of it holds ${plain.length} bytes, not ${original}`);
      // Every part has a CRC-32, whichever Duplicator wrote it: before 5.0.0 of the stored bytes,
      // since then of the content. One without is as damaged as one that does not match.
      if (!/^[0-9a-f]{8}$/.test(hash)) throw new DafFormatError(`${shown} is damaged: a part of it has no CRC-32`);
      const crc = (zlib.crc32(v5 ? plain : packed) >>> 0).toString(16).padStart(8, '0');
      if (crc !== hash) throw new DafFormatError(`${shown} is damaged: a part of it does not match its CRC-32`);
      whole = zlib.crc32(plain, whole);
      await sink(plain);
      got += original;
    }
    return sink ? (whole >>> 0).toString(16).padStart(8, '0') : null;
  }

  /**
   * One file's content, read again from where its header starts. `max`, when given, refuses a
   * file larger than that before a byte of it is read.
   */
  async readAt(offset: number, sink: (chunk: Buffer) => Promise<void>, max = Infinity): Promise<void> {
    let found = false;
    await this.walk({
      from: offset,
      onEntry: async (entry) => {
        if (found) return 'stop';
        found = true;
        if (entry.kind !== 'file') throw new DafFormatError(`No file at byte ${offset}`);
        if (entry.size > max) throw new DafFormatError(`${entry.name.toString('utf8')} is larger than ${max} bytes`);
        return sink;
      },
    });
    if (!found) throw new DafFormatError(`No entry at byte ${offset}`);
  }

  /** A small file's content whole, refused past `max` bytes. */
  async readAllAt(offset: number, max: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    await this.readAt(offset, async (chunk) => void parts.push(chunk), max);
    return Buffer.concat(parts);
  }
}

/** A path's length as a header gives it, refused past what a path can be. */
function pathLength(length: number, offset: number): number {
  if (length < 1 || length > MAX_PATH) throw new DafFormatError(`The entry at byte ${offset} claims a path of ${length} bytes`);
  return length;
}

/** '0644' -> 0o644; what does not parse as permission bits reads as `fallback`. */
function parseMode(raw: string, fallback: number): number {
  return /^[0-7]{3,4}$/.test(raw) ? Number.parseInt(raw, 8) & 0o7777 : fallback;
}
