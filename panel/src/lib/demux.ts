import { Writable, type Readable } from 'node:stream';

export interface DemuxResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_CAP = 1024 * 1024; // 1 MiB per stream is plenty for wp-cli / dump tooling output

class CappedCollector extends Writable {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Bytes after the last newline, held until the rest of the line arrives. */
  private partial = '';
  truncated = false;

  constructor(
    private readonly cap: number,
    /** Fed one complete line at a time while the command runs; for live job logs. */
    private readonly onLine?: (line: string) => void,
  ) {
    super();
  }

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    if (this.onLine) {
      this.partial += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.partial.indexOf('\n')) !== -1) {
        const line = this.partial.slice(0, nl).trimEnd();
        this.partial = this.partial.slice(nl + 1);
        if (line) this.onLine(line);
      }
    }
    if (this.size < this.cap) {
      const room = this.cap - this.size;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(Buffer.from(slice));
      this.size += slice.length;
      if (chunk.length > room) this.truncated = true;
    } else {
      this.truncated = true;
    }
    cb();
  }

  /**
   * Hand over a last line that never got its newline - `printf done` has none. Called when the
   * source stream ends: docker-modem's demuxStream never ends the writables it feeds, so a
   * `_final` here would never run.
   */
  flush(): void {
    const line = this.partial.trimEnd();
    this.partial = '';
    if (line && this.onLine) this.onLine(line);
  }

  toString(): string {
    let s = Buffer.concat(this.chunks).toString('utf8');
    if (this.truncated) s += '\n…[output truncated]';
    return s;
  }
}

interface ModemLike {
  demuxStream(stream: NodeJS.ReadableStream, stdout: Writable, stderr: Writable): void;
}

/**
 * Collect a Docker multiplexed (Tty:false) stream into stdout/stderr strings.
 * Docker frames stdout/stderr over one stream with 8-byte headers; modem.demuxStream
 * understands the framing. Never "fix" garbled output with Tty:true - that merges streams.
 */
export function collectDemuxed(
  modem: ModemLike,
  stream: NodeJS.ReadableStream,
  opts: {
    timeoutMs?: number;
    cap?: number;
    onOutput?: (line: string) => void;
    /**
     * Settle on 'close' instead of rejecting on 'error'. For a command fed through stdin: one
     * that exits without reading all of its input makes our pending write fail with EPIPE,
     * yet its output (and, from inspect, its exit code) is still the answer. A transport that
     * really died shows up afterwards, when the exit code cannot be read.
     */
    tolerateErrors?: boolean;
  } = {},
): Promise<DemuxResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  const stdout = new CappedCollector(cap, opts.onOutput);
  const stderr = new CappedCollector(cap, opts.onOutput);
  modem.demuxStream(stream, stdout, stderr);

  return new Promise<DemuxResult>((resolve, reject) => {
    let done = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (done) return;
          done = true;
          (stream as { destroy?: (e?: Error) => void }).destroy?.();
          reject(new Error(`Timed out after ${opts.timeoutMs}ms waiting for command output`));
        }, opts.timeoutMs)
      : null;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stdout.flush();
      stderr.flush();
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    };
    stream.on('end', () => finish());
    stream.on('close', () => finish());
    stream.on('error', (err: Error) => {
      if (!opts.tolerateErrors) finish(err);
    });
  });
}

/**
 * Demultiplex a Docker (Tty:false) stream into two Writables WITH backpressure.
 *
 * docker-modem's demuxStream ignores what the destination's write() returns, so a consumer
 * slower than the container (gzip -> disk during a database dump) had the whole dump pile
 * up in panel memory - a large enough site could take the panel down with it. This one
 * pauses the source whenever a destination is full and resumes on 'drain'; frames that
 * span chunk boundaries are reassembled. Resolves when the source ends/closes; rejects on
 * any stream error.
 *
 * A destination that closes first also rejects. A download whose browser tab was closed
 * destroys its response without an error, and a destroyed stream never emits 'drain', so
 * waiting for one would park the command (and, on a remote server, its SSH channel) until
 * the deadline instead of letting the caller hang up.
 */
export function demuxToStreams(stream: Readable, stdout: Writable, stderr: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    let ended = false;
    let done = false;
    let waiting = false; // paused until a destination emits 'drain'

    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      stdout.off('error', onError);
      stderr.off('error', onError);
      stdout.off('close', onDestClose);
      stderr.off('close', onDestClose);
      if (err) reject(err);
      else resolve();
    };
    const onError = (err: Error): void => finish(err);
    const onDestClose = (): void => finish(new Error('output destination closed before the command finished'));

    const pump = (): void => {
      if (done || waiting) return;
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break; // partial frame - wait for more
        const type = buf[0];
        const payload = buf.subarray(8, 8 + size);
        buf = buf.subarray(8 + size);
        const dest = type === 2 ? stderr : stdout;
        // Destroyed before we started (no 'close' left to hear): a write would only return
        // false, and the 'drain' it promises never comes.
        if (dest.destroyed) {
          onDestClose();
          return;
        }
        if (size > 0 && !dest.write(payload)) {
          waiting = true;
          stream.pause();
          dest.once('drain', () => {
            waiting = false;
            if (done) return;
            stream.resume();
            pump();
          });
          return;
        }
      }
      if (ended) finish(); // a trailing partial frame means a truncated stream; exit code tells
    };
    const onData = (chunk: Buffer): void => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    };
    const onEnd = (): void => {
      ended = true;
      pump();
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
    stdout.on('error', onError);
    stderr.on('error', onError);
    stdout.on('close', onDestClose);
    stderr.on('close', onDestClose);
  });
}

/** Demux a complete multiplexed Buffer (e.g. from container.logs without follow). */
export function demuxBuffer(buf: Buffer): DemuxResult {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset]!;
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buf.length);
    const payload = buf.subarray(start, end);
    (type === 2 ? err : out).push(payload);
    offset = end;
  }
  if (out.length === 0 && err.length === 0 && buf.length > 0) {
    // Not multiplexed (Tty container) - treat everything as stdout.
    return { stdout: buf.toString('utf8'), stderr: '' };
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}
