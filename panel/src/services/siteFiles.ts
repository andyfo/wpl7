import crypto from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import type { DockerPort, RunResult } from './docker.js';
import { FILE_EXIT, SCRIPTS } from './siteFilesScripts.js';
import { COMPRESS_ZIP_PHP, EXTRACT_ZIP_PHP, PHP_ZIP_ARGS } from './siteFilesZip.js';
import {
  FILE_LIMITS,
  SITE_FILES_ROOT,
  containerPath,
  joinSiteFilePath,
  siteFileBase,
  siteFileParent,
} from '../../shared/siteFilePath.js';
import type {
  SiteDirListingDto,
  SiteFileEntryDto,
  SiteFileSearchDto,
  SiteFileSearchMatchDto,
  SiteFileType,
  SiteFileWrittenDto,
  SiteUploadChunkDto,
} from '../../shared/types.js';
import {
  AppError,
  badGateway,
  badRequest,
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  syntaxError,
  tooManyRequests,
} from '../lib/errors.js';

/**
 * Web FTP: reading and changing a site's files.
 *
 * Every operation runs INSIDE the site's own container, as www-data (33:33), through
 * `docker exec` - never on the host, and as root only where www-data cannot (below). That is
 * the whole security model:
 *
 * - A compromised site can plant symlinks. Resolved on the host - or in the panel's
 *   container, which is root and mounts every site's files plus the panel's own database -
 *   one link would reach another site's wp-config.php or the panel itself. Resolved inside
 *   the site's container, a link can only lead to what that site can already see.
 * - Running host-side as uid 33 would not be enough: every site's files are uid 33 on the
 *   host, so a link into `/srv/sites/<another>/` would still cross over. The container's
 *   mount namespace is the boundary, not the uid.
 * - Docker's archive API (`docker cp`) is no alternative either: it runs as root in the
 *   daemon, has had symlink-race escapes (CVE-2018-15664), and cannot replace a file
 *   atomically or conditionally.
 *
 * So the Files tab can do exactly what the site's own PHP could do, and nothing more. Its
 * power is www-data's: a file owned by root is read-only here, which is what "Fix
 * ownership" (the one operation of the tab that runs as root, still inside the container)
 * is for. The panel's own drop-ins (putDropIn) are the other root step, and as careful.
 *
 * One service per server (see ServerHandle.siteFiles); the download limit is per server
 * because a remote server's Docker API rides on eight SSH channels shared with everything.
 */

const WWW_DATA = '33:33';
/** C locale: tool messages are English and byte-oriented, whatever the image sets. */
const ENV = ['LC_ALL=C', 'HOME=/tmp'];

const TIMEOUTS = {
  quick: 30_000,
  write: 120_000,
  bulk: 10 * 60_000,
  search: 60_000,
  transfer: 60 * 60_000,
  archive: 30 * 60_000,
};

/** Downloads at once from one server; more answer 429 rather than queueing for a channel. */
const MAX_DOWNLOADS = 3;

/** How long a finished upload's answer is kept for a client that did not hear it, and how many. */
const FINISHED_UPLOAD_TTL_MS = 10 * 60_000;
const FINISHED_UPLOADS_KEPT = 1000;

interface FinishedUpload {
  at: number;
  path: string;
  size: number;
  /** The chunk that finished the upload: where it went, and its SHA-256. */
  offset: number;
  sha: string;
  result: SiteUploadChunkDto;
}

// ---------------------------------------------------------------------------
// Records (see siteFilesScripts.ts: `flags/y/Y/size/mode/mtime/uid/gid/name/target` NUL)

const TYPES: Record<string, SiteFileType> = { f: 'file', d: 'dir', l: 'link' };
const typeOf = (c: string): SiteFileType => TYPES[c] ?? 'other';

const strict = new TextDecoder('utf-8', { fatal: true });
const lossy = new TextDecoder('utf-8');

function decodeName(bytes: Buffer): { name: string; ok: boolean } {
  try {
    return { name: strict.decode(bytes), ok: true };
  } catch {
    return { name: lossy.decode(bytes), ok: false };
  }
}

/** One record, or null when it is not one (a cut-off tail). */
export function parseEntryRecord(rec: Buffer): SiteFileEntryDto | null {
  const fields: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < 9; i++) {
    const at = rec.indexOf(0x2f, start);
    if (at === -1) return null;
    fields.push(rec.subarray(start, at));
    start = at + 1;
  }
  const [flags, y, Y, size, mode, mtime, uid, gid] = fields.map((f) => f.toString('latin1'));
  const type = typeOf(y!);
  const decoded = decodeName(fields[8]!);
  // %Y for a link: N = dangling, L = a loop, ? = could not tell.
  const targetType = type === 'link' ? (Y === 'N' || Y === 'L' || Y === '?' ? null : typeOf(Y!)) : null;
  return {
    name: decoded.name,
    nameOk: decoded.ok,
    type,
    target: type === 'link' ? lossy.decode(rec.subarray(start)) : null,
    targetType,
    size: Number(size),
    mtimeMs: Math.round(Number(mtime) * 1000),
    mode: mode!.padStart(3, '0'),
    uid: Number(uid),
    gid: Number(gid),
    readable: flags![0] === 'r',
    writable: flags![1] === 'w',
  };
}

function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
    out.push(buf.subarray(start, i));
    start = i + 1;
  }
  return out;
}

/** A listing: the folder's own record, then one per entry. */
export function parseListing(path: string, stdout: Buffer): SiteDirListingDto {
  const [self, ...rest] = splitNul(stdout);
  const own = self ? parseEntryRecord(self) : null;
  const entries = rest.slice(0, FILE_LIMITS.listEntries).map(parseEntryRecord).filter((e): e is SiteFileEntryDto => e !== null);
  return { path, writable: own?.writable ?? false, entries, truncated: rest.length > FILE_LIMITS.listEntries };
}

/** The record a mutating script prints last, named after the path the caller asked for. */
function entryFrom(stdout: string, path: string): SiteFileEntryDto {
  const rec = Buffer.from(stdout.replace(/\0+$/, ''), 'utf8');
  const entry = parseEntryRecord(rec);
  if (!entry) throw badGateway('The server did not describe the result', stdout.slice(0, 500));
  return { ...entry, name: siteFileBase(path) || entry.name, nameOk: true };
}

export function parseNameMatches(dir: string, stdout: Buffer): Omit<SiteFileSearchDto, 'mode' | 'path'> {
  let timedOut = false;
  const matches: SiteFileSearchMatchDto[] = [];
  let records = 0;
  for (const rec of splitNul(stdout)) {
    const slash = rec.indexOf(0x2f);
    if (slash !== 1) continue;
    const kind = String.fromCharCode(rec[0]!);
    if (kind === 'T') {
      timedOut = true;
      continue;
    }
    records++;
    if (matches.length >= FILE_LIMITS.searchResults) continue;
    const rel = decodeName(rec.subarray(2));
    if (!rel.ok || rel.name === '') continue;
    matches.push({ path: joinSiteFilePath(dir, rel.name), type: typeOf(kind) });
  }
  return { matches, truncated: records > FILE_LIMITS.searchResults, timedOut };
}

/**
 * The line to show for a match: all of it when it is short, else 500 characters around the
 * match - a minified script is one line, and its first 500 characters rarely hold it. Plain
 * text is found again here; a regular expression is not re-run in the panel (a pathological
 * one would stall the whole process), so its lines show from the start.
 */
export function matchSnippet(line: string, q: string, opts: { regex: boolean; caseSensitive: boolean }): string {
  const WIDTH = 500;
  if (line.length <= WIDTH) return line;
  const at = opts.regex ? -1 : opts.caseSensitive ? line.indexOf(q) : line.toLowerCase().indexOf(q.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - 200);
  return `${start > 0 ? '…' : ''}${line.slice(start, start + WIDTH)}${start + WIDTH < line.length ? '…' : ''}`;
}

/**
 * grep's records: `./path` NUL `line:text` LF. Read path-first: a name can contain a line
 * break but never a NUL, so splitting on LF first would hand a match to the wrong file.
 */
export function parseContentMatches(
  dir: string,
  stdout: Buffer,
  query: { q: string; regex: boolean; caseSensitive: boolean } = { q: '', regex: true, caseSensitive: true },
): Omit<SiteFileSearchDto, 'mode' | 'path'> {
  let timedOut = false;
  const matches: SiteFileSearchMatchDto[] = [];
  let records = 0;
  let pos = 0;
  while (pos < stdout.length) {
    const nul = stdout.indexOf(0, pos);
    if (nul === -1) break;
    const nl = stdout.indexOf(0x0a, nul + 1);
    // No line end: the output was cut off mid-record (the cap); that record is not a match.
    if (nl === -1) break;
    const name = stdout.subarray(pos, nul);
    const rest = lossy.decode(stdout.subarray(nul + 1, nl));
    pos = nl + 1;
    if (name.length === 0) {
      if (rest === 'TIMEOUT') timedOut = true;
      continue;
    }
    records++;
    if (matches.length >= FILE_LIMITS.searchResults) continue;
    const file = decodeName(name);
    if (!file.ok) continue;
    const colon = rest.indexOf(':');
    const lineNo = Number(rest.slice(0, colon));
    if (colon === -1 || !Number.isInteger(lineNo)) continue;
    matches.push({
      path: joinSiteFilePath(dir, file.name.replace(/^\.\//, '')),
      line: lineNo,
      text: matchSnippet(rest.slice(colon + 1), query.q, query),
    });
  }
  return { matches, truncated: records > FILE_LIMITS.searchResults, timedOut };
}

/** `name*` patterns match literally: find's glob characters are escaped. */
export const globLiteral = (s: string): string => s.replace(/[\\*?[\]]/g, (c) => `\\${c}`);

// ---------------------------------------------------------------------------
// Errors

export interface FileOpContext {
  /** Verb for messages: "read", "save", "delete"... */
  op: string;
  path?: string;
  /** What a FILE_EXIT.wrongType means for this operation. */
  wrongType?: string;
  /** An "exists" that answers a create-only precondition (If-None-Match: *) is a 412. */
  createOnly?: boolean;
  stdout?: string;
}

const describe = (path: string | undefined): string =>
  path === undefined ? 'That entry' : path === '' ? 'The site folder' : `"${path}"`;

/** An exit code from FILE_EXIT, as the HTTP error it stands for. */
export function fileOpError(code: number, stderr: string, ctx: FileOpContext): AppError {
  const what = describe(ctx.path);
  const detail = stderr.trim().slice(0, 2000) || undefined;
  if (/No space left on device|Disk quota exceeded/i.test(stderr)) {
    return conflict('The server is out of disk space');
  }
  switch (code) {
    case FILE_EXIT.notFound:
      return notFound(`${what} does not exist`);
    case FILE_EXIT.wrongType:
      return conflict(ctx.wrongType ?? `${what} is not something this can ${ctx.op}`);
    case FILE_EXIT.denied:
      return forbidden(
        `Permission denied: the site's own user (www-data) may not ${ctx.op} ${what}. ` +
          'If it belongs to root, "Fix ownership" hands it back to the site.',
      );
    case FILE_EXIT.exists:
      return ctx.createOnly ? preconditionFailed(`${what} already exists`) : conflict(`${what} already exists`);
    case FILE_EXIT.changed:
      return preconditionFailed(`${what} changed since it was opened (or no longer exists)`);
    case FILE_EXIT.tooLarge:
      return conflict(`${what} is too large to open here; download it instead`);
    case FILE_EXIT.short:
      return badRequest('The data arrived incomplete and was not saved; send it again');
    case FILE_EXIT.offset: {
      const received = Number((ctx.stdout ?? '').trim());
      return new AppError('conflict', 409, `The upload has ${received} bytes; continue from there`, { received });
    }
    case FILE_EXIT.noSpace:
      return conflict(
        `Not enough free disk space: at least ${FILE_LIMITS.minFreeBytes / 1024 ** 3} GiB must stay free on the server` +
          (detail ? ` (${detail})` : ''),
      );
    case FILE_EXIT.intoItself:
      return badRequest('A folder cannot be moved or copied into itself');
    case FILE_EXIT.badPattern:
      return badRequest(`Not a valid search pattern${detail ? `: ${detail}` : ''}`);
    case FILE_EXIT.syntax: {
      const output = stderr.trim().slice(0, 2000);
      const line = /on line (\d+)/.exec(output)?.[1];
      const message = /(?:PHP )?Parse error:\s*(.*?)(?: in Standard input code)?(?: on line \d+)?$/m.exec(output)?.[1];
      return syntaxError(
        `Not saved: ${ctx.path ?? 'the file'} does not parse as PHP${line ? ` (line ${line})` : ''}${message ? ` - ${message}` : ''}`,
        { line: line ? Number(line) : null, output },
      );
    }
    case FILE_EXIT.badArchive:
    case FILE_EXIT.unsafeArchive:
      return badRequest(detail ?? 'The archive cannot be extracted');
    case FILE_EXIT.busy:
      return conflict(`Another change next to ${what} is still being written; try again in a moment`);
    default:
      return badGateway(`Could not ${ctx.op} ${what} (exit ${code})`, detail);
  }
}

/**
 * Docker's own refusals, which would otherwise reach the error handler as a 4xx it can only
 * call `validation_error` - with Docker's wording.
 */
function dockerError(err: unknown): unknown {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 404) return conflict("The site's container does not exist; repair the site first");
  if (status === 409) return conflict("The site's container is not running; start the site first");
  return err;
}

// ---------------------------------------------------------------------------
// Streams

/** Collects stdout as bytes (exec() would decode it as UTF-8), up to a cap. */
class BufferSink extends Writable {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    const room = this.cap - this.size;
    if (room > 0) {
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(Buffer.from(slice));
      this.size += slice.length;
    }
    if (chunk.length > room) this.truncated = true;
    cb();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Passes what it is given on to `dest`, honouring dest's backpressure, and counts it: a
 * download has promised a Content-Length, and a file that shrank while it was read must
 * break the response rather than end it short (which a keep-alive client would misread).
 */
class CountingForwarder extends Writable {
  bytes = 0;

  constructor(private readonly dest: Writable) {
    super();
    dest.once('close', () => this.destroy());
  }

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.bytes += chunk.length;
    if (this.dest.write(chunk)) cb();
    else this.dest.once('drain', () => cb());
  }
}

/** Splits output into lines as it arrives (job progress). */
class LineSink extends Writable {
  private partial = '';
  lines: string[] = [];

  constructor(private readonly onLine: (line: string) => void) {
    super();
  }

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.partial += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, nl).trimEnd();
      this.partial = this.partial.slice(nl + 1);
      if (!line) continue;
      this.lines.push(line);
      if (!line.startsWith('{')) this.onLine(line);
    }
    cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (this.partial.trim()) this.lines.push(this.partial.trim());
    cb();
  }
}

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

export interface ArchiveResult {
  files: number;
  folders: number;
  bytes: number;
  skipped: number;
}

export class SiteFilesService {
  private downloads = 0;
  /**
   * Uploads that finished lately, by container and upload id. The chunk that finished one
   * comes again when its answer was lost on the way back - the client resends what it heard
   * nothing about - and by then the part it appended to has become the file: the script alone
   * would answer 404, or for a one-chunk upload "already exists", and the browser would call
   * a finished upload failed. The same chunk is answered with the same result instead, and
   * nothing is written twice. In memory, because such a retry comes seconds later.
   */
  private finishedUploads = new Map<string, FinishedUpload>();
  /** Per upload, the chunk being handled (settles, never rejects): see appendChunk. */
  private uploadsBusy = new Map<string, Promise<unknown>>();

  constructor(
    private readonly docker: DockerPort,
    /** Where the site's files are inside its container. Tests point it at a temp dir. */
    private readonly root: string = SITE_FILES_ROOT,
  ) {}

  private abs(p: string): string {
    return containerPath(p, this.root);
  }

  private async run(
    container: string,
    script: string,
    args: string[],
    opts: { timeoutMs?: number; user?: string; input?: Buffer } = {},
  ): Promise<RunResult> {
    const cmd = ['sh', '-c', script, 'sh', ...args];
    const execOpts = {
      user: opts.user ?? WWW_DATA,
      env: ENV,
      workdir: this.root,
      timeoutMs: opts.timeoutMs ?? TIMEOUTS.quick,
    };
    try {
      return opts.input
        ? await this.docker.execWithInput(container, cmd, opts.input, execOpts)
        : await this.docker.exec(container, cmd, execOpts);
    } catch (err) {
      throw dockerError(err);
    }
  }

  /** Like run(), but stdout as raw bytes - names and contents are not necessarily UTF-8. */
  private async runBytes(
    container: string,
    script: string,
    args: string[],
    opts: { timeoutMs?: number; maxBytes: number },
  ): Promise<{ stdout: Buffer; truncated: boolean; exitCode: number; stderr: string }> {
    const sink = new BufferSink(opts.maxBytes);
    try {
      const res = await this.docker.execToStream(container, ['sh', '-c', script, 'sh', ...args], sink, {
        user: WWW_DATA,
        env: ENV,
        workdir: this.root,
        timeoutMs: opts.timeoutMs ?? TIMEOUTS.quick,
      });
      return { stdout: sink.bytes(), truncated: sink.truncated, ...res };
    } catch (err) {
      throw dockerError(err);
    }
  }

  async list(container: string, path: string): Promise<SiteDirListingDto> {
    const res = await this.runBytes(container, SCRIPTS.list, [this.abs(path), String(FILE_LIMITS.listEntries + 2)], {
      // A record is at most ~4.4 KB (two 255-byte names worth of multibyte, a 4 KB link target).
      maxBytes: 64 * 1024 * 1024,
    });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, { op: 'list', path, wrongType: `"${path}" is not a folder` });
    }
    return parseListing(path, res.stdout);
  }

  async stat(container: string, path: string): Promise<SiteFileEntryDto> {
    const res = await this.run(container, SCRIPTS.stat, [this.abs(path)]);
    if (res.exitCode !== 0) throw fileOpError(res.exitCode, res.stderr, { op: 'read', path });
    return entryFrom(res.stdout, path);
  }

  /** The content for the editor, with its ETag (SHA-256 of exactly these bytes). */
  async read(container: string, path: string): Promise<{ bytes: Buffer; etag: string }> {
    const max = FILE_LIMITS.editBytes;
    const res = await this.runBytes(container, SCRIPTS.read, [this.abs(path), String(max)], { maxBytes: max + 1 });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, { op: 'read', path, wrongType: `"${path}" is not a file` });
    }
    // It grew between the size check and the read.
    if (res.stdout.length > max) throw fileOpError(FILE_EXIT.tooLarge, '', { op: 'read', path });
    return { bytes: res.stdout, etag: sha256(res.stdout) };
  }

  /**
   * Save a whole file (the editor, "New file"). `ifMatch`: only replace the version with that
   * ETag. `mustExist` (If-Match: *): only replace, whatever the version. `createOnly`: only
   * if nothing has the name yet. None of them: create or replace.
   * `lint: 'php'` refuses content that does not parse, before it replaces anything.
   */
  async write(
    container: string,
    path: string,
    body: Buffer,
    opts: { ifMatch?: string; mustExist?: boolean; createOnly?: boolean; lint?: 'php' } = {},
  ): Promise<SiteFileWrittenDto> {
    const mode = opts.createOnly ? 'create' : opts.ifMatch || opts.mustExist ? 'replace' : 'any';
    const etag = sha256(body);
    const res = await this.run(
      container,
      SCRIPTS.write,
      [this.abs(path), mode, opts.ifMatch ?? '-', String(body.length), etag, opts.lint ?? '-'],
      { input: body, timeoutMs: TIMEOUTS.write },
    );
    if (res.exitCode !== 0) {
      // The one thing a save cannot find is the folder it goes into.
      if (res.exitCode === FILE_EXIT.notFound) throw notFound(`${describe(siteFileParent(path))} does not exist`);
      if (res.exitCode === FILE_EXIT.changed && !opts.ifMatch) {
        throw preconditionFailed(`${describe(path)} does not exist, and If-Match: * only replaces a file that does`);
      }
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'save',
        path,
        wrongType: `"${path}" is not a file`,
        createOnly: opts.createOnly,
      });
    }
    return { path, entry: entryFrom(res.stdout, path), etag };
  }

  /** The name an upload is assembled under: beside its target, so the final rename is atomic. */
  uploadPartPath(path: string, id: string): string {
    return this.abs(joinSiteFilePath(siteFileParent(path), `.wpl7-upload-${id}.part`));
  }

  /**
   * One chunk of an upload (see SCRIPTS.append for the protocol). An upload's chunks are
   * handled one at a time, so a chunk resent while its first copy is still being written
   * waits for it - and then finds it landed: a 409 saying where to resume, or, for the chunk
   * that finished the upload, that upload's answer again (`replayed`, see finishedUploads).
   */
  async appendChunk(
    container: string,
    upload: { path: string; id: string; offset: number; size: number; overwrite: boolean },
    chunk: Buffer,
  ): Promise<SiteUploadChunkDto & { replayed?: true }> {
    const { path, id, offset, size, overwrite } = upload;
    if (offset + chunk.length > size) throw badRequest('The chunk runs past the size of the file');
    if (chunk.length === 0 && offset !== size) throw badRequest('An empty chunk only completes an upload (offset = size)');
    const key = `${container}/${id}`;
    const chunkSha = sha256(chunk);
    return this.oneUploadChunkAtATime(key, async () => {
      const finished = this.finishedUploads.get(key);
      if (
        finished &&
        Date.now() - finished.at <= FINISHED_UPLOAD_TTL_MS &&
        finished.path === path &&
        finished.size === size &&
        finished.offset === offset &&
        finished.sha === chunkSha
      ) {
        return { ...finished.result, replayed: true };
      }
      const res = await this.run(
        container,
        SCRIPTS.append,
        [
          this.uploadPartPath(path, id),
          String(offset),
          String(chunk.length),
          chunkSha,
          String(size),
          this.abs(path),
          overwrite ? '1' : '0',
          String(FILE_LIMITS.minFreeBytes),
        ],
        { input: chunk, timeoutMs: TIMEOUTS.write },
      );
      if (res.exitCode !== 0) {
        // At offset 0 that is the folder; later, the part (abandoned and cleaned up meanwhile).
        if (res.exitCode === FILE_EXIT.notFound) {
          throw notFound(
            offset === 0
              ? `${describe(siteFileParent(path))} does not exist`
              : 'This upload is gone from the server (abandoned for over a day?); start it again',
          );
        }
        throw fileOpError(res.exitCode, res.stderr, {
          op: 'upload to',
          path,
          wrongType: `"${path}" is a folder or a special file, not something an upload can replace`,
          stdout: res.stdout,
        });
      }
      const received = offset + chunk.length;
      if (!res.stdout) return { received, written: null };
      const result = { received, written: { path, entry: entryFrom(res.stdout, path), etag: null } };
      this.rememberFinishedUpload(key, { path, size, offset, sha: chunkSha, result });
      return result;
    });
  }

  private async oneUploadChunkAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.uploadsBusy.get(key);
    const mine = before ? before.then(work) : work();
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    this.uploadsBusy.set(key, settled);
    try {
      return await mine;
    } finally {
      if (this.uploadsBusy.get(key) === settled) this.uploadsBusy.delete(key);
    }
  }

  private rememberFinishedUpload(key: string, record: Omit<FinishedUpload, 'at'>): void {
    const now = Date.now();
    // Oldest first (a Map keeps insertion order): drop what expired, and what is over the cap.
    for (const [k, old] of this.finishedUploads) {
      if (now - old.at <= FINISHED_UPLOAD_TTL_MS && this.finishedUploads.size < FINISHED_UPLOADS_KEPT) break;
      this.finishedUploads.delete(k);
    }
    this.finishedUploads.set(key, { ...record, at: now });
  }

  async abortUpload(container: string, path: string, id: string): Promise<void> {
    await this.run(container, SCRIPTS.abort, [this.uploadPartPath(path, id)]);
  }

  async mkdir(container: string, path: string): Promise<SiteFileEntryDto> {
    const res = await this.run(container, SCRIPTS.mkdir, [this.abs(path)]);
    if (res.exitCode !== 0) throw fileOpError(res.exitCode, res.stderr, { op: 'create', path });
    return entryFrom(res.stdout, path);
  }

  async move(container: string, from: string, to: string, overwrite: boolean): Promise<SiteFileEntryDto> {
    if (from === to) throw badRequest('That is already its name and place');
    const res = await this.run(container, SCRIPTS.move, [this.abs(from), this.abs(to), overwrite ? '1' : '0'], {
      timeoutMs: TIMEOUTS.bulk,
    });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'move',
        path: res.exitCode === FILE_EXIT.exists || res.exitCode === FILE_EXIT.wrongType ? to : from,
        wrongType: `"${to}" is a folder; a folder is never replaced`,
      });
    }
    return entryFrom(res.stdout, to);
  }

  async copy(container: string, from: string, to: string): Promise<SiteFileEntryDto> {
    const res = await this.run(container, SCRIPTS.copy, [this.abs(from), this.abs(to), String(FILE_LIMITS.minFreeBytes)], {
      timeoutMs: TIMEOUTS.bulk,
    });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, { op: 'copy', path: res.exitCode === FILE_EXIT.exists ? to : from });
    }
    return entryFrom(res.stdout, to);
  }

  async remove(container: string, paths: string[]): Promise<void> {
    if (paths.includes('')) throw badRequest('The site folder itself cannot be deleted');
    const res = await this.run(
      container,
      SCRIPTS.remove,
      paths.map((p) => this.abs(p)),
      { timeoutMs: TIMEOUTS.bulk },
    );
    if (res.exitCode !== 0) {
      // The script names the offending path on stderr for the checks it makes up front.
      const named = res.stderr.startsWith(this.root) ? res.stderr.slice(this.root.length + 1).split('\n')[0] : undefined;
      const path = named !== undefined && paths.includes(named) ? named : paths.length === 1 ? paths[0] : undefined;
      throw fileOpError(res.exitCode, named === undefined ? res.stderr : '', { op: 'delete', path });
    }
  }

  async chmod(container: string, path: string, mode: string): Promise<SiteFileEntryDto> {
    const res = await this.run(container, SCRIPTS.chmod, [this.abs(path), mode]);
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'change the permissions of',
        path,
        wrongType: `"${path}" is a symlink; change the permissions of what it points at instead`,
      });
    }
    return entryFrom(res.stdout, path);
  }

  /** Hand everything under `path` back to www-data - the one operation of the tab that runs as root. */
  async fixOwnership(container: string, path: string): Promise<void> {
    const res = await this.run(container, SCRIPTS.fixOwnership, [this.abs(path)], {
      user: '0:0',
      timeoutMs: TIMEOUTS.bulk,
    });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'fix the ownership of',
        path,
        wrongType: `A folder on the way to "${path}" is a symlink; fix the ownership of the real folder instead`,
      });
    }
  }

  /**
   * Put one of the panel's own drop-ins in the site's wp-content/mu-plugins (null: take it
   * away). Inside the container, like every other write to a site's files - the host-side
   * write this replaces followed a symlink the site could plant, as root. `legacy` names an
   * old drop-in the new one replaces.
   */
  async putDropIn(
    container: string,
    name: string,
    content: string | null,
    legacy?: string,
  ): Promise<'written' | 'same' | 'removed' | 'absent'> {
    const args = [
      this.abs('wp-content'),
      this.abs('wp-content/mu-plugins'),
      name,
      content === null ? 'remove' : 'put',
      legacy ?? '',
      SCRIPTS.dropInWrite,
    ];
    const res = await this.run(container, SCRIPTS.dropIn, args, {
      user: '0:0',
      input: content === null ? undefined : Buffer.from(content, 'utf8'),
    });
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'write the panel drop-in',
        path: `wp-content/mu-plugins/${name}`,
        wrongType: 'wp-content/mu-plugins is reached through a symlink; the panel will not write its drop-in there',
      });
    }
    const said = res.stdout.trim();
    return said === 'written' || said === 'same' || said === 'removed' ? said : 'absent';
  }

  /** Reserve one of this server's download slots; the returned function gives it back. */
  acquireDownload(): () => void {
    if (this.downloads >= MAX_DOWNLOADS) {
      throw tooManyRequests(`${MAX_DOWNLOADS} downloads are already running from this server; try again when one finishes`);
    }
    this.downloads++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.downloads--;
    };
  }

  /** What a download of `path` would be: a file of some size, or a folder (sent as .tar.gz). */
  async probeDownload(container: string, path: string): Promise<{ kind: 'file'; size: number } | { kind: 'dir' }> {
    const res = await this.run(container, SCRIPTS.probe, [this.abs(path)]);
    if (res.exitCode !== 0) {
      throw fileOpError(res.exitCode, res.stderr, {
        op: 'download',
        path,
        wrongType: `"${path}" is neither a file nor a folder`,
      });
    }
    if (res.stdout === 'd') return { kind: 'dir' };
    const size = Number(/^f (\d+)$/.exec(res.stdout)?.[1]);
    if (!Number.isFinite(size)) throw badGateway('The server did not describe the download', res.stdout.slice(0, 200));
    return { kind: 'file', size };
  }

  /**
   * Stream a file of `size` bytes into `dest` and end it - or destroy it, when fewer bytes
   * came (the file shrank) or anything failed, so the client sees a broken download rather
   * than a short one.
   */
  async streamFile(container: string, path: string, size: number, dest: Writable, signal?: AbortSignal): Promise<void> {
    // This method breaks `dest` itself when something goes wrong, and reports why to its
    // caller; an 'error' event nobody is listening for would take the whole panel down.
    dest.on('error', () => undefined);
    const counter = new CountingForwarder(dest);
    try {
      const res = await this.docker.execToStream(
        container,
        ['sh', '-c', SCRIPTS.cat, 'sh', this.abs(path), String(size)],
        counter,
        { user: WWW_DATA, env: ENV, workdir: this.root, timeoutMs: TIMEOUTS.transfer, signal },
      );
      counter.end();
      await finished(counter);
      if (res.exitCode !== 0) throw fileOpError(res.exitCode, res.stderr, { op: 'download', path });
      if (counter.bytes !== size) throw new Error(`"${path}" changed while it was being downloaded`);
      dest.end();
    } catch (err) {
      dest.destroy(err instanceof Error ? err : new Error(String(err)));
      throw dockerError(err);
    }
  }

  /** Stream a folder as .tar.gz into `dest` and end it (or destroy it on failure). */
  async streamFolder(container: string, path: string, topName: string, dest: Writable, signal?: AbortSignal): Promise<void> {
    dest.on('error', () => undefined); // see streamFile
    // The site folder itself is archived from its parent, under the site's name rather than
    // the container's `html` - so it unpacks into a folder, not all over the current one.
    const cut = this.root.lastIndexOf('/');
    const args =
      path === ''
        ? [this.root.slice(0, cut) || '/', this.root.slice(cut + 1), topName]
        : [this.abs(siteFileParent(path)), siteFileBase(path), ''];
    try {
      const res = await this.docker.execToStream(container, ['sh', '-c', SCRIPTS.tar, 'sh', ...args], dest, {
        user: WWW_DATA,
        env: ENV,
        workdir: this.root,
        timeoutMs: TIMEOUTS.transfer,
        signal,
      });
      if (res.exitCode !== 0) throw fileOpError(res.exitCode, res.stderr, { op: 'download', path });
      dest.end();
    } catch (err) {
      dest.destroy(err instanceof Error ? err : new Error(String(err)));
      throw dockerError(err);
    }
  }

  async search(
    container: string,
    q: { path: string; q: string; mode: 'name' | 'content'; case: boolean; regex: boolean; include: string[] },
  ): Promise<SiteFileSearchDto> {
    const max = FILE_LIMITS.searchResults + 1;
    const res =
      q.mode === 'name'
        ? await this.runBytes(
            container,
            SCRIPTS.searchNames,
            [this.abs(q.path), `*${globLiteral(q.q)}*`, String(max), q.case ? '1' : '0'],
            { timeoutMs: TIMEOUTS.search, maxBytes: 16 * 1024 * 1024 },
          )
        : await this.runBytes(
            container,
            SCRIPTS.searchContent,
            [
              this.abs(q.path),
              q.q,
              String(max),
              q.regex ? '0' : '1',
              q.case ? '1' : '0',
              ...q.include.map((g) => `--include=${g}`),
            ],
            { timeoutMs: TIMEOUTS.search, maxBytes: 16 * 1024 * 1024 },
          );
    if (res.exitCode !== 0) throw fileOpError(res.exitCode, res.stderr, { op: 'search', path: q.path });
    const found =
      q.mode === 'name'
        ? parseNameMatches(q.path, res.stdout)
        : parseContentMatches(q.path, res.stdout, { q: q.q, regex: q.regex, caseSensitive: q.case });
    // Output past the cap is gone; so, then, are any matches it held.
    return { mode: q.mode, path: q.path, ...found, truncated: found.truncated || res.truncated };
  }

  /** Extract a .zip into a folder (see EXTRACT_ZIP_PHP for what is refused). For a job. */
  async extractZip(
    container: string,
    a: { path: string; to: string; overwrite: boolean },
    onLine: (line: string) => void,
  ): Promise<ArchiveResult> {
    return this.runPhp(
      container,
      EXTRACT_ZIP_PHP,
      [this.abs(a.path), this.abs(a.to), a.overwrite ? '1' : '0', String(FILE_LIMITS.minFreeBytes)],
      { op: 'extract', path: a.path },
      onLine,
    );
  }

  /** Compress entries of one folder into a .zip beside them. For a job. */
  async compressZip(
    container: string,
    a: { paths: string[]; to: string; overwrite: boolean },
    onLine: (line: string) => void,
  ): Promise<ArchiveResult> {
    const dir = siteFileParent(a.to);
    const outside = a.paths.find((p) => siteFileParent(p) !== dir);
    if (outside !== undefined) throw badRequest(`"${outside}" is not in the folder the archive goes into`);
    return this.runPhp(
      container,
      COMPRESS_ZIP_PHP,
      [this.abs(dir), this.abs(a.to), a.overwrite ? '1' : '0', String(FILE_LIMITS.minFreeBytes), ...a.paths.map(siteFileBase)],
      { op: 'compress into', path: a.to },
      onLine,
    );
  }

  private async runPhp(
    container: string,
    code: string,
    args: string[],
    ctx: FileOpContext,
    onLine: (line: string) => void,
  ): Promise<ArchiveResult> {
    const sink = new LineSink(onLine);
    let res: { exitCode: number; stderr: string };
    try {
      res = await this.docker.execToStream(container, [...PHP_ZIP_ARGS, '-r', code, '--', ...args], sink, {
        user: WWW_DATA,
        env: ENV,
        workdir: this.root,
        timeoutMs: TIMEOUTS.archive,
      });
    } catch (err) {
      throw dockerError(err);
    }
    sink.end();
    await finished(sink);
    const json = [...sink.lines].reverse().find((l) => l.startsWith('{'));
    if (res.exitCode !== 0) {
      // The status comes from the exit code; the words from the script, which knows which
      // entry was in the way - and, when extraction refuses up front, lists them all.
      const base = fileOpError(res.exitCode, res.stderr, ctx);
      const said = res.stderr.trim().split('\n').pop();
      const known = res.exitCode >= FILE_EXIT.notFound && res.exitCode <= FILE_EXIT.unsafeArchive;
      throw new AppError(
        base.code,
        base.statusCode,
        known && said ? said : base.message,
        json ? (JSON.parse(json) as unknown) : base.details,
      );
    }
    if (!json) throw badGateway(`The ${ctx.op} step did not report back`, sink.lines.slice(-5).join('\n'));
    return JSON.parse(json) as ArchiveResult;
  }
}
