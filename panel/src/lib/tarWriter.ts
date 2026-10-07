import { Readable } from 'node:stream';

/**
 * A tar stream written as the files arrive: what an import pipes into `tar -x` on the target
 * server while it pulls the old site file by file (services/importPull.ts). Nothing is held in
 * memory but the chunk on its way, and the producer waits whenever the reader falls behind.
 *
 * GNU tar's format: ustar headers, a `././@LongLink` entry ahead of a name longer than the
 * header holds, and base-256 sizes past 8 GiB. GNU tar and bsdtar read both, and a long name is
 * written as the bytes it is - an old site's file names need not be UTF-8, which pax headers
 * would have to declare.
 */

export interface TarHeader {
  /** Relative, '/'-separated; bytes for a name that is not UTF-8. */
  name: string | Buffer;
  /** Permission bits only; the type comes from the call. */
  mode: number;
  /** Unix seconds. */
  mtime: number;
  /** Owner, www-data's unless said otherwise: what the site's container runs as. */
  uid?: number;
  gid?: number;
}

const BLOCK = 512;
/** The largest size the 11 octal digits of a plain header hold. */
const OCTAL_SIZE_MAX = 0o77777777777;

function octal(value: number, width: number): Buffer {
  // width-1 digits, then NUL, as GNU tar writes them.
  const text = value.toString(8).padStart(width - 1, '0');
  if (text.length > width - 1) throw new Error(`Value too large for a ${width}-byte tar field: ${value}`);
  return Buffer.from(`${text}\0`, 'ascii');
}

/** A size, in octal while it fits and in base-256 (high bit set, big-endian) past that. */
function sizeField(size: number): Buffer {
  if (size <= OCTAL_SIZE_MAX) return octal(size, 12);
  const out = Buffer.alloc(12);
  let rest = BigInt(size);
  for (let i = 11; i >= 1; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  out[0] = 0x80;
  return out;
}

function header(name: Buffer, opts: { mode: number; uid: number; gid: number; size: number; mtime: number; type: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0, 0, Math.min(name.length, 100));
  octal(opts.mode & 0o7777, 8).copy(block, 100);
  octal(opts.uid, 8).copy(block, 108);
  octal(opts.gid, 8).copy(block, 116);
  sizeField(opts.size).copy(block, 124);
  octal(Math.max(0, Math.floor(opts.mtime)), 12).copy(block, 136);
  block.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  block.write(opts.type, 156, 'ascii');
  block.write('ustar  \0', 257, 'ascii'); // GNU magic + version
  block.write('www-data', 265, 'ascii');
  block.write('www-data', 297, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(block, 148);
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

export class TarWriter extends Readable {
  private wake: ((err?: Error) => void) | null = null;
  private failed: Error | null = null;
  /** Bytes of the file being written that are still to come. */
  private open: { name: string; left: number; size: number } | null = null;
  /** Bytes pushed so far: the size of the archive, once ended. */
  bytes = 0;

  constructor() {
    super({ highWaterMark: 4 * 1024 * 1024 });
  }

  override _read(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  override _destroy(err: Error | null, done: (err?: Error | null) => void): void {
    this.failed = err ?? new Error('The tar stream was closed before it was finished');
    const wake = this.wake;
    this.wake = null;
    wake?.(this.failed);
    done(err);
  }

  /** Push a chunk, waiting while the reader has enough. */
  private async put(chunk: Buffer): Promise<void> {
    if (this.failed) throw this.failed;
    if (chunk.length === 0) return;
    this.bytes += chunk.length;
    if (this.push(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      this.wake = (err) => (err ? reject(err) : resolve());
    });
  }

  private async entryHeader(h: TarHeader, type: '0' | '5', size: number): Promise<void> {
    if (this.open) throw new Error(`The file ${this.open.name} is not finished`);
    let name = typeof h.name === 'string' ? Buffer.from(h.name, 'utf8') : h.name;
    if (type === '5' && name[name.length - 1] !== 0x2f) name = Buffer.concat([name, Buffer.from('/')]);
    if (name.length === 0 || name.includes(0)) throw new Error('A tar entry needs a name without NUL bytes');
    const ids = { uid: h.uid ?? 33, gid: h.gid ?? 33 };
    if (name.length > 100) {
      const long = Buffer.concat([name, Buffer.from([0])]);
      await this.put(header(Buffer.from('././@LongLink'), { mode: 0o644, ...ids, size: long.length, mtime: 0, type: 'L' }));
      await this.put(long);
      await this.put(padding(long.length));
    }
    await this.put(header(name, { mode: h.mode, ...ids, size, mtime: h.mtime, type }));
  }

  async addDir(h: TarHeader): Promise<void> {
    await this.entryHeader(h, '5', 0);
  }

  /** Start a file of `size` bytes; its content follows through writeFileData, then endFile. */
  async beginFile(h: TarHeader, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Not a file size: ${size}`);
    await this.entryHeader(h, '0', size);
    this.open = { name: typeof h.name === 'string' ? h.name : h.name.toString('latin1'), left: size, size };
  }

  async writeFileData(chunk: Buffer): Promise<void> {
    if (!this.open) throw new Error('No file is open');
    if (chunk.length > this.open.left) throw new Error(`${this.open.name}: more bytes than its header says`);
    this.open.left -= chunk.length;
    await this.put(chunk);
  }

  /**
   * End the open file. A file that came up short - it shrank on the old host while it was being
   * read - is filled with zero bytes to the size its header promised: the archive has to stay
   * whole, and the caller fetches that file again into a later entry, which wins on extraction.
   * Returns how many bytes were filled in.
   */
  async endFile(): Promise<number> {
    if (!this.open) throw new Error('No file is open');
    const { left, size } = this.open;
    this.open = null;
    for (let rest = left; rest > 0; rest -= 1024 * 1024) await this.put(Buffer.alloc(Math.min(rest, 1024 * 1024)));
    await this.put(padding(size));
    return left;
  }

  async addFile(h: TarHeader, data: Buffer): Promise<void> {
    await this.beginFile(h, data.length);
    await this.writeFileData(data);
    await this.endFile();
  }

  /** The two zero blocks that end an archive, and the end of the stream. */
  async finish(): Promise<void> {
    if (this.open) throw new Error(`The file ${this.open.name} is not finished`);
    await this.put(Buffer.alloc(BLOCK * 2));
    this.push(null);
  }
}
