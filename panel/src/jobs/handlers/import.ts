// @docs sites/import
import path from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { imports, sites, type ImportRow, type SiteRow } from '../../db/schema.js';
import type { ImportRunBody } from '../../../shared/schemas.js';
import { nextChunkSize, CHUNK_START } from '../../../shared/transferPlan.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { JobCanceledError } from '../../lib/errors.js';
import { TarWriter } from '../../lib/tarWriter.js';
import { IMPORT_TTL_MS, initialCursor, type ImportCursor } from '../../services/imports.js';
import { constantLiteral, type MigrateReport } from '../../services/importInspect.js';
import { DUMP_PREAMBLE, DUMP_TRAILER, checkSqlPage } from '../../services/importSql.js';
import {
  ImportSourceError,
  PullCanceledError,
  type FileEntry,
  type ImportPullClient,
  type PingAnswer,
} from '../../services/importPull.js';
import { buildSiteContainerSpec, sitePaths, siteRuntimeFrom, siteTlsFor } from '../../services/siteSpec.js';
import { restoreSiteOnServer, type ProtectionHold } from './restoreSite.js';
import {
  dnsPreflight,
  loadSite,
  probeSite,
  rewriteWordPressUrls,
  siteDomains,
  siteUrl,
  startSiteContainer,
  updateSiteRow,
  waitForWordPressFiles,
  writeSiteJson,
} from './shared.js';
import { ensureDevDnsRecord, ensureSiteImage } from './sites.js';

/**
 * An import's two jobs (services/imports.ts, docs/internal/import-protocol.md).
 *
 * `site.import` pulls the old site through its migration plugin into a staging folder on the
 * target server - files as they arrive, straight into `tar -x` there, and the database as checked
 * SQL into `db.sql.gz` - in the server's import lane, so the hours it can take hold up nothing
 * else on the machine. It writes down how far it got after every batch, and a run that stopped
 * goes on from there.
 *
 * `site.importFinish` then brings the site up from that folder in the server's own lane, the way
 * a move restores a site on its new server, and fixes what a site on another host needs fixed:
 * its wp-config.php, its address, what of the old host it should leave behind.
 */

export const siteImportPayload = z.object({ importId: z.number().int(), sourceHost: z.string() });
export const siteImportFinishPayload = siteImportPayload;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const MIB = 1024 * 1024;

/** One tar batch: what is extracted, and written down as done, in one go. */
const BATCH_BYTES = 512 * MIB;
const BATCH_ENTRIES = 2000;
/** Files up to this size travel whole, many to a request (`bundle`). */
const SMALL_FILE = MIB;
/** Files up to this size are read whole before they are written, so a change mid-read costs nothing. */
const MEDIUM_FILE = 64 * MIB;
/** How often a file that keeps changing while it is read is read again. */
const MAX_REREADS = 2;
/** A progress line every this many bytes or files. */
const LOG_BYTES = 256 * MIB;
const LOG_FILES = 5000;

function bytesText(bytes: number): string {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const count = (n: number) => n.toLocaleString('en-US');

/** The bytes of an entry's path, and the text it is shown as. */
function entryPath(entry: FileEntry): { bytes: Buffer; text: string } {
  return { bytes: entry.pb ? Buffer.from(entry.pb, 'base64') : Buffer.from(entry.p, 'utf8'), text: entry.p };
}

/**
 * Whether a path from the old site may be written into the staging folder: relative, no `.` or
 * `..`, no NUL, nothing under the panel's own reserved prefix. The plugin is trusted for none of it.
 */
export function importPathProblem(bytes: Buffer): string | null {
  if (bytes.length === 0) return 'an empty path';
  if (bytes.length > 4096) return 'a path longer than 4096 bytes';
  if (bytes.includes(0)) return 'a NUL byte';
  if (bytes[0] === 0x2f) return 'an absolute path';
  const segments = bytes.toString('latin1').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'an empty, "." or ".." segment';
    if (segment.length > 255) return 'a name longer than 255 bytes';
    if (segment.startsWith('.wpl7-')) return "the panel's reserved .wpl7- prefix";
  }
  return null;
}

/** Permission bits for a file or folder from the old host: readable, never setuid, never world-writable. */
function safeMode(md: string | undefined, dir: boolean): number {
  if (dir) return 0o755;
  const mode = Number.parseInt(md ?? '', 8);
  return Number.isFinite(mode) && mode & 0o111 ? 0o755 : 0o644;
}

/**
 * Run `tar -x` into `dir` on the server, fed from a TarWriter as `produce` fills it. If tar stops
 * reading - it failed, the disk is full - the writer is told at once rather than left waiting.
 */
async function extractInto(server: ServerHandle, dir: string, produce: (tar: TarWriter) => Promise<void>): Promise<void> {
  const tar = new TarWriter();
  tar.on('error', () => undefined);
  let producing = true;
  const extraction = server.exec
    .runWithInput('tar', ['-xf', '-', '-C', dir], tar, { timeoutMs: 4 * 3600_000 })
    .finally(() => {
      if (producing) tar.destroy(new Error('tar on the server stopped before the files were all sent'));
    });
  try {
    await produce(tar);
    await tar.finish();
    producing = false;
  } catch (err) {
    producing = false;
    tar.destroy(err instanceof Error ? err : new Error(String(err)));
    const res = await extraction.catch(() => null);
    if (res && res.exitCode !== 0 && /stopped before/.test(errMsg(err))) {
      throw new Error(`Extracting on the server failed: ${res.stderr.trim().slice(0, 300)}`);
    }
    throw err;
  }
  const res = await extraction;
  if (res.exitCode !== 0) throw new Error(`Extracting on the server failed: ${res.stderr.trim().slice(0, 300)}`);
}

// ------------------------------------------------------------------------- the pull

export async function siteImport(ctx: JobContext<z.infer<typeof siteImportPayload>>, s: CoreServices): Promise<void> {
  let row = s.imports.get(ctx.payload.importId);
  if (!['queued', 'failed', 'pulling'].includes(row.status)) {
    throw new Error(`Import #${row.id} is ${row.status}; there is nothing to pull`);
  }
  if (!row.siteId || row.serverId === null || !row.stagingPath) throw new Error(`Import #${row.id} was never started`);
  const site = loadSite(s.db, row.siteId);
  const server = s.servers.handleFor(row.serverId);
  const staging = row.stagingPath;
  const wordpressDir = path.join(staging, 'wordpress');
  const dbFile = path.join(staging, 'db.sql.gz');
  const report = s.imports.reportOf(row);
  if (!report) throw new Error(`Import #${row.id} has no report from the old site`);

  row = s.imports.mark(row.id, { status: 'pulling', jobId: ctx.jobId, lastError: null });
  updateSiteRow(s.db, site.id, { status: 'provisioning' });
  ctx.info(`Importing from ${ctx.payload.sourceHost} into "${site.slug}"…`);

  let cursor: ImportCursor = s.imports.cursorOf(row) ?? initialCursor(['wp-config.php']);
  let client: ImportPullClient | null = null;
  const commit = async () => {
    if (client) {
      cursor.transport = client.state.transport;
      cursor.encoding = client.state.encoding;
      cursor.skewS = client.state.skewS;
    }
    await server.files.writeFile(path.join(staging, 'import.json'), JSON.stringify(cursor));
    s.imports.writeCursor(row.id, cursor);
  };

  try {
    // ---------------------------------------------------------- preflight
    const alive = await server.exec.run('true', [], { timeoutMs: 30_000 });
    if (alive.exitCode !== 0) throw new Error(`Server "${server.name}" did not answer: ${alive.stderr.trim().slice(0, 200)}`);
    await server.files.mkdirp(staging, { mode: 0o700 });
    await server.files.mkdirp(wordpressDir, { mode: 0o755 });
    // The folder's own copy wins over the row's: it is what is on the disk.
    const onDisk = await server.files.readOptional(path.join(staging, 'import.json'));
    if (onDisk) {
      try {
        cursor = { ...initialCursor(cursor.skip), ...(JSON.parse(onDisk) as ImportCursor) };
      } catch {
        ctx.warn('The staging folder\'s import.json could not be read; going by the panel\'s record.');
      }
    }
    if (cursor.filesDone > 0 || cursor.tablesDone > 0 || cursor.phase !== 'snapshot') {
      ctx.info(`Resuming: ${count(cursor.filesDone)} files and ${cursor.tablesDone} tables already pulled.`);
    }
    const need = Math.max(0, (report.files.bytes + report.db.bytes) * 2.5 - cursor.bytesDone);
    const disk = await server.files.statvfs(s.config.srvRoot).catch(() => null);
    if (disk && disk.freeBytes < need) {
      throw new ImportSourceError(
        `Not enough free disk on "${server.name}": ${bytesText(disk.freeBytes)} free, about ${bytesText(need)} needed.`,
        false,
        'disk',
      );
    }
    if (!disk) ctx.warn(`Could not read the free disk space on "${server.name}"; going on.`);

    client = s.imports.clientFor(row, {
      state: { transport: cursor.transport, encoding: cursor.encoding, skewS: cursor.skewS },
      canceled: () => ctx.cancelRequested,
      log: (line) => ctx.info(line),
    });
    const ping = await client.ping();
    ctx.info(`The plugin answers (version ${ping.plugin}).`);
    ctx.checkCanceled();

    if (cursor.phase === 'snapshot') await listFiles(ctx, client, cursor, commit);
    if (cursor.phase === 'files') await pullFiles(ctx, client, ping, server, wordpressDir, cursor, commit);
    if (cursor.phase === 'db') await pullDatabase(ctx, client, ping, server, dbFile, report, cursor, commit);

    // ---------------------------------------------------------- verify
    const found = await server.exec.run('sh', ['-c', `find ${shq(wordpressDir)} -type f | wc -l`], { timeoutMs: 10 * 60_000 });
    const files = Number(found.stdout.trim());
    if (found.exitCode === 0 && Number.isFinite(files)) {
      if (files < cursor.filesDone) ctx.warn(`${count(files)} files on the server, ${count(cursor.filesDone)} copied: some went missing on the way.`);
      ctx.info(`Verified: ${count(files)} files, ${bytesText(cursor.bytesDone)}; the database's ${cursor.tablesTotal} tables.`);
    }
    reportSkipped(ctx, cursor);

    cursor.phase = 'done';
    await commit();
    const finish = s.db.transaction(() => {
      const job = s.worker.enqueue(
        'site.importFinish',
        { importId: row.id, sourceHost: ctx.payload.sourceHost },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      s.imports.mark(row.id, { status: 'pulled', pulledAt: Date.now(), jobId: job.id });
      return job;
    });
    ctx.info(`Pull finished. Queued the finish job #${finish.id}.`);
    ctx.setResult({ importId: row.id, finishJobId: finish.id, files: cursor.filesDone, bytes: cursor.bytesDone, tables: cursor.tablesDone });
  } catch (err) {
    await commit().catch(() => undefined);
    const canceled = err instanceof JobCanceledError || err instanceof PullCanceledError;
    s.imports.mark(row.id, { status: 'failed', lastError: canceled ? 'Stopped' : errMsg(err) });
    if (!canceled) updateSiteRow(s.db, site.id, { status: 'error' });
    ctx.info(
      canceled
        ? 'Stopped. Continue goes on from where it stopped.'
        : err instanceof ImportSourceError && err.fatal
          ? 'Continue tries again once the reason is fixed.'
          : 'Continue goes on from where it stopped.',
    );
    if (canceled) throw new JobCanceledError();
    throw err;
  } finally {
    client?.close();
  }
}

/**
 * Every file of the old site, listed by its plugin in steps it can finish within its time limit.
 * `since`: only what changed from then on (unix seconds), for a refresh.
 */
export async function listFiles(
  ctx: JobContext<unknown>,
  client: ImportPullClient,
  cursor: ImportCursor,
  commit: () => Promise<void>,
  opts: { since?: number } = {},
): Promise<void> {
  ctx.info(opts.since ? "Listing the old site's files that changed since the import…" : "Listing the old site's files…");
  const start = () => client.snapshot('start', { follow: 'none', ...(opts.since ? { since: opts.since } : {}) });
  let snap = cursor.snapshotId ? await client.snapshot('status') : await start();
  if (cursor.snapshotId && snap.snapshot_id !== cursor.snapshotId) snap = await start();
  cursor.snapshotId = snap.snapshot_id;
  await commit();
  let logged = Date.now();
  while (!snap.done) {
    ctx.checkCanceled();
    snap = await client.snapshot('continue');
    if (snap.snapshot_id !== cursor.snapshotId) {
      throw new ImportSourceError('The old site started another listing of its files. Continue starts this one again.', false, 'snapshot_stale');
    }
    if (Date.now() - logged > 30_000) {
      ctx.info(`… ${count(snap.entries)} files and folders listed`);
      logged = Date.now();
    }
  }
  for (const w of snap.warnings ?? []) {
    const note = listingNote(w);
    if (note) ctx.log(note.level, note.text);
  }
  cursor.filesTotal = snap.entries;
  cursor.bytesTotal = snap.bytes;
  cursor.phase = 'files';
  await commit();
  ctx.info(`Listed ${count(snap.entries)} files and folders, ${bytesText(snap.bytes)}.`);
}

/**
 * What the old site says about its listing, in words. Links and files it could not read are
 * counted by the pull itself, and reported at its end.
 */
function listingNote(w: { code: string; count?: number; detail?: string }): { level: 'info' | 'warn'; text: string } | null {
  const n = w.count ?? 0;
  const s = n === 1 ? '' : 's';
  switch (w.code) {
    case 'link':
    case 'dangling':
    case 'cycle':
    case 'unreadable':
    case 'too_large':
      return null;
    case 'excluded':
      return { level: 'info', text: `Left out, as always: ${w.detail ?? '?'} (${count(n)})` };
    case 'too_deep':
      return { level: 'warn', text: `${count(n)} folder${s} nested too deep to list, not copied.` };
    case 'special':
      return { level: 'warn', text: `${count(n)} special file${s} (pipes, sockets, devices), not copied.` };
    case 'too_long':
      return { level: 'warn', text: `${count(n)} path${s} too long to copy.` };
    default:
      return { level: 'warn', text: `The old site: ${w.detail ?? w.code}${n ? ` (${count(n)})` : ''}` };
  }
}

/** The files, page by page of the listing, into the staging folder. */
export async function pullFiles(
  ctx: JobContext<unknown>,
  client: ImportPullClient,
  ping: PingAnswer,
  server: ServerHandle,
  wordpressDir: string,
  cursor: ImportCursor,
  commit: () => Promise<void>,
): Promise<void> {
  ctx.info(cursor.filesAfterId > 0 ? 'Copying the files, from where the last run stopped…' : 'Copying the files…');
  const maxBytes = Math.max(64 * 1024, ping.limits.max_bytes);
  const skip = new Set(cursor.skip);
  const bundles = client.answers('bundle');
  let chunk = Math.min(CHUNK_START, maxBytes);
  let logged = { bytes: cursor.bytesDone, files: cursor.filesDone };
  const progress = () => {
    if (cursor.bytesDone - logged.bytes < LOG_BYTES && cursor.filesDone - logged.files < LOG_FILES) return;
    logged = { bytes: cursor.bytesDone, files: cursor.filesDone };
    ctx.info(`… ${count(cursor.filesDone)} of ${count(cursor.filesTotal)} files, ${bytesText(cursor.bytesDone)} of ${bytesText(cursor.bytesTotal)}`);
  };

  /** Read a file whole into memory, starting over when it changes under the read. */
  const readWhole = async (entry: FileEntry): Promise<{ data: Buffer; mtime: number } | null> => {
    for (let attempt = 0; attempt <= MAX_REREADS; attempt++) {
      const parts: Buffer[] = [];
      let size = Infinity;
      let mtime = entry.m;
      let offset = 0;
      let changed = false;
      while (offset < size) {
        const started = Date.now();
        const answer = await client.range(entry.id, offset, chunk, offset === 0 ? 'refresh' : 'error');
        if (answer.kind === 'missing') return null;
        if (answer.kind === 'changed') {
          changed = true;
          break;
        }
        if (offset === 0) {
          size = answer.size;
          mtime = answer.mtime;
        }
        parts.push(answer.data);
        offset += answer.data.length;
        chunk = nextChunkSize(Math.max(answer.data.length, 1), Date.now() - started, maxBytes);
        if (answer.data.length === 0) break;
        ctx.checkCanceled();
      }
      if (!changed && offset === size) return { data: Buffer.concat(parts), mtime };
    }
    cursor.skipped.changed.push(entry.p);
    return null;
  };

  /** Stream a big file into the open tar; false when it changed under the read and was padded. */
  const streamLarge = async (tar: TarWriter, entry: FileEntry, name: Buffer): Promise<'done' | 'padded' | 'missing'> => {
    const started = Date.now();
    const first = await client.range(entry.id, 0, chunk, 'refresh');
    if (first.kind === 'missing') return 'missing';
    if (first.kind === 'changed') return 'padded';
    chunk = nextChunkSize(Math.max(first.data.length, 1), Date.now() - started, maxBytes);
    await tar.beginFile({ name, mode: safeMode(entry.md, false), mtime: first.mtime }, first.size);
    await tar.writeFileData(first.data);
    let offset = first.data.length;
    let result: 'done' | 'padded' = 'done';
    while (offset < first.size) {
      ctx.checkCanceled();
      const t0 = Date.now();
      const answer = await client.range(entry.id, offset, Math.min(chunk, first.size - offset), 'error');
      if (answer.kind !== 'data' || answer.data.length === 0) {
        result = 'padded';
        break;
      }
      await tar.writeFileData(answer.data);
      offset += answer.data.length;
      cursor.bytesDone += answer.data.length;
      chunk = nextChunkSize(answer.data.length, Date.now() - t0, maxBytes);
      progress();
    }
    await tar.endFile();
    cursor.bytesDone += first.data.length;
    return result;
  };

  /** Write one page of the listing, in as many tar batches as its sizes ask for. */
  const writePage = async (entries: FileEntry[], rereading: boolean) => {
    let i = 0;
    while (i < entries.length) {
      let batchBytes = 0;
      let batchEntries = 0;
      let lastId = cursor.filesAfterId;
      // What the batch counts only stands once tar has the batch on disk: a batch that fails is
      // written again from its start, and must not be counted twice.
      const before = structuredClone({
        filesDone: cursor.filesDone,
        bytesDone: cursor.bytesDone,
        skipped: cursor.skipped,
        retry: cursor.retry,
        retried: cursor.retried,
      });
      const startedAt = i;
      try {
        await extractInto(server, wordpressDir, async (tar) => {
          while (i < entries.length && batchBytes < BATCH_BYTES && batchEntries < BATCH_ENTRIES) {
            ctx.checkCanceled();
            const entry = entries[i]!;
            const { bytes: name, text } = entryPath(entry);
            const problem = importPathProblem(name);
            const leave = problem !== null || skip.has(text) || (entry.f ?? []).some((f) => ['unreadable', 'too_large', 'cycle', 'dangling', 'too_deep'].includes(f));
            if (problem) ctx.warn(`Not copied: ${JSON.stringify(text)} (${problem}).`);
            if (leave) {
              if ((entry.f ?? []).includes('unreadable') || (entry.f ?? []).includes('too_large')) cursor.skipped.unreadable++;
              i++;
              lastId = entry.id;
              batchEntries++;
              continue;
            }
            if (entry.t === 'd') {
              await tar.addDir({ name, mode: 0o755, mtime: entry.m });
              i++;
              lastId = entry.id;
              batchEntries++;
              continue;
            }
            if (entry.t === 'l') {
              cursor.skipped.links++;
              i++;
              lastId = entry.id;
              batchEntries++;
              continue;
            }
            if (entry.s <= SMALL_FILE && bundles && !rereading) {
              // A run of small files, many to a request.
              const run: FileEntry[] = [];
              let runBytes = 0;
              for (let j = i; j < entries.length && run.length < 200; j++) {
                const e = entries[j]!;
                if (e.t !== 'f' || e.s > SMALL_FILE || (e.f ?? []).length > 0 || skip.has(e.p) || importPathProblem(entryPath(e).bytes)) break;
                if (runBytes + e.s > maxBytes && run.length > 0) break;
                run.push(e);
                runBytes += e.s;
              }
              if (run.length > 0) {
                const answer = await client.bundle(cursorSnapshot(cursor), run.map((e) => e.id), maxBytes);
                const byId = new Map(answer.files.map((f) => [f.id, f]));
                let consumed = 0;
                for (const e of run) {
                  const got = byId.get(e.id);
                  if (!got) break;
                  consumed++;
                  if ('error' in got && got.error === 'too_large') {
                    // It grew past what a bundle carries since it was listed: read again, in ranges.
                    cursor.retry.push(e.id);
                    cursor.filesDone++;
                  } else if ('error' in got) {
                    if (got.error !== 'missing') cursor.skipped.unreadable++;
                  } else {
                    await tar.addFile({ name: entryPath(e).bytes, mode: safeMode(e.md, false), mtime: got.mtime }, got.data);
                    cursor.filesDone++;
                    cursor.bytesDone += got.data.length;
                    batchBytes += got.data.length;
                  }
                  lastId = e.id;
                  batchEntries++;
                }
                if (consumed === 0) throw new ImportSourceError('The old site returned none of the files asked for.', false, 'bundle');
                i += consumed;
                progress();
                continue;
              }
            }
            if (entry.s <= MEDIUM_FILE) {
              const whole = await readWhole(entry);
              if (whole) {
                await tar.addFile({ name, mode: safeMode(entry.md, false), mtime: whole.mtime }, whole.data);
                if (!rereading) cursor.filesDone++;
                cursor.bytesDone += whole.data.length;
                batchBytes += whole.data.length;
              }
            } else {
              const outcome = await streamLarge(tar, entry, name);
              if (outcome === 'padded') {
                const tries = (cursor.retried[entry.id] ?? 0) + 1;
                cursor.retried[entry.id] = tries;
                if (tries <= MAX_REREADS) cursor.retry.push(entry.id);
                else cursor.skipped.changed.push(entry.p);
              }
              if (outcome !== 'missing' && !rereading) cursor.filesDone++;
              batchBytes += entry.s;
            }
            i++;
            lastId = entry.id;
            batchEntries++;
            progress();
          }
        });
      } catch (err) {
        Object.assign(cursor, before);
        throw err;
      }
      // Written down only once tar has the whole batch on disk.
      if (!rereading) cursor.filesAfterId = lastId;
      await commit();
      if (i === startedAt) break;
    }
  };

  for (;;) {
    ctx.checkCanceled();
    let page;
    try {
      page = await client.files(cursorSnapshot(cursor), cursor.filesAfterId, 1000);
    } catch (err) {
      if (err instanceof ImportSourceError && err.code === 'snapshot_stale') {
        ctx.warn('The old site lost the listing this pull was working from. Listing its files again.');
        Object.assign(cursor, { phase: 'snapshot', snapshotId: null, filesAfterId: 0, filesDone: 0, bytesDone: 0, retry: [], retried: {} });
        await commit();
        throw new ImportSourceError('The listing of the old site changed. Continue lists it again and copies from the start.', false, 'snapshot_stale');
      }
      throw err;
    }
    if (page.entries.length > 0) await writePage(page.entries, false);
    if (page.next === null || page.entries.length === 0) break;
  }

  // Files that changed while they were read, read again into later entries, which win on extraction.
  while (cursor.retry.length > 0) {
    const ids = [...cursor.retry];
    ctx.info(`Reading ${ids.length === 1 ? 'a file' : `${ids.length} files`} again that changed while being copied…`);
    const entries: FileEntry[] = [];
    for (const id of ids) {
      const page = await client.files(cursorSnapshot(cursor), id - 1, 1);
      if (page.entries[0]?.id === id) entries.push(page.entries[0]);
    }
    await writePage(entries, true);
    // Read again: off the list. One that changed yet again was put back at its end.
    cursor.retry = cursor.retry.slice(ids.length);
    await commit();
  }
  cursor.phase = 'db';
  await commit();
  ctx.info(`Files copied: ${count(cursor.filesDone)}, ${bytesText(cursor.bytesDone)}.`);
}

function cursorSnapshot(cursor: ImportCursor): string {
  if (!cursor.snapshotId) throw new Error('The pull has no listing of the old site');
  return cursor.snapshotId;
}

/** The database, table by table and page by page, checked and appended to db.sql.gz. */
export async function pullDatabase(
  ctx: JobContext<unknown>,
  client: ImportPullClient,
  ping: PingAnswer,
  server: ServerHandle,
  dbFile: string,
  report: MigrateReport,
  cursor: ImportCursor,
  commit: () => Promise<void>,
): Promise<void> {
  const append = async (text: string) => {
    const res = await server.exec.runWithInput('sh', ['-c', `gzip -c >> ${shq(dbFile)}`], Readable.from([Buffer.from(text, 'utf8')]), {
      timeoutMs: 10 * 60_000,
    });
    if (res.exitCode !== 0) throw new Error(`Writing the database copy failed: ${res.stderr.trim().slice(0, 300)}`);
  };
  const sizeNow = async () => (await server.files.stat(dbFile))?.sizeBytes ?? 0;

  if (!cursor.tables) {
    ctx.info("Copying the database…");
    const answer = await client.tables();
    const prefix = report.table_prefix;
    cursor.tables = answer.tables.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
    const foreign = answer.tables.length - cursor.tables.length;
    if (foreign > 0) ctx.warn(`${foreign} table${foreign === 1 ? '' : 's'} without the prefix ${prefix} left behind.`);
    cursor.tablesTotal = cursor.tables.length;
    cursor.tablesDone = 0;
    cursor.dbTable = cursor.tables[0] ?? null;
    cursor.dbCursor = '';
    await server.files.rm(dbFile);
    await append(`${DUMP_PREAMBLE}\n`);
    cursor.dbBytesCommitted = await sizeNow();
    await commit();
  } else {
    ctx.info(`Copying the database, from table ${cursor.tablesDone + 1} of ${cursor.tablesTotal}…`);
    // Whatever a stopped run appended after its last written-down page goes: each page is one
    // gzip member, so the file is whole up to there.
    const cut = await server.exec.run(
      'sh',
      ['-c', `truncate -s ${cursor.dbBytesCommitted} ${shq(dbFile)} 2>/dev/null || { head -c ${cursor.dbBytesCommitted} ${shq(dbFile)} > ${shq(`${dbFile}.cut`)} && mv ${shq(`${dbFile}.cut`)} ${shq(dbFile)}; }`],
      { timeoutMs: 10 * 60_000 },
    );
    if (cut.exitCode !== 0) throw new Error(`Could not set the database copy back to its last page: ${cut.stderr.trim().slice(0, 300)}`);
  }

  const maxBytes = Math.max(64 * 1024, ping.limits.max_bytes);
  let collationsWarned = false;
  while (cursor.dbTable) {
    ctx.checkCanceled();
    const table = cursor.dbTable;
    const page = await client.sql(table, cursor.dbCursor, maxBytes);
    const checked = checkSqlPage(page.sql, table, { first: cursor.dbCursor === '' });
    for (const w of page.warnings) {
      ctx.warn(w.code === 'create_comment' ? `${table}: copied without ${w.detail ?? 'a comment'} from its definition.` : `${table}: ${w.detail ?? w.code}`);
    }
    if (checked.collations && !collationsWarned) {
      ctx.warn('MySQL 8 collations were changed to their MariaDB equivalents.');
      collationsWarned = true;
    }
    if (checked.lines.length > 0) await append(`${checked.lines.join('\n')}\n`);
    for (const line of checked.lines) cursor.longestStatement = Math.max(cursor.longestStatement ?? 0, Buffer.byteLength(line, 'utf8'));
    if (page.skipped.length > 0) {
      cursor.skipped.rows += page.skipped.length;
      const which = page.skipped
        .slice(0, 3)
        .map((r) => (Array.isArray(r.key) ? r.key.join('/') : r.offset !== undefined ? `row ${r.offset + 1}` : '?'))
        .join(', ');
      ctx.warn(`${table}: ${page.skipped.length} row${page.skipped.length === 1 ? '' : 's'} too large to copy (${which}).`);
    }
    cursor.dbBytesCommitted = await sizeNow();
    if (page.next === null) {
      cursor.tablesDone++;
      cursor.dbTable = cursor.tables![cursor.tablesDone] ?? null;
      cursor.dbCursor = '';
      if (cursor.tablesDone % 10 === 0 || !cursor.dbTable) ctx.info(`… ${cursor.tablesDone} of ${cursor.tablesTotal} tables`);
    } else {
      cursor.dbCursor = page.next;
    }
    await commit();
  }
  await append(`${DUMP_TRAILER}\n`);
  const test = await server.exec.run('gzip', ['-t', dbFile], { timeoutMs: 10 * 60_000 });
  if (test.exitCode !== 0) throw new Error(`The database copy is damaged: ${test.stderr.trim().slice(0, 300)}`);
  cursor.dbBytesCommitted = await sizeNow();
  ctx.info(`Database copied: ${cursor.tablesTotal} tables, ${bytesText(cursor.dbBytesCommitted)} compressed.`);
}

/**
 * MariaDB takes a statement of at most 16 MiB unless told otherwise, and the plugin sends rows of
 * up to 15 MiB, which can come close to twice that as SQL. A dump with one that long raises the
 * server's limit before it is loaded.
 */
export async function makeRoomForStatements(ctx: JobContext<unknown>, server: ServerHandle, longest: number): Promise<void> {
  if (longest < 15 * MIB) return;
  const raised = await server.dbAdmin.raisePacketLimit(longest);
  if (raised) ctx.info(`The database server now takes statements of up to ${bytesText(raised)}, for one of ${bytesText(longest)}, until it restarts.`);
}

export function reportSkipped(ctx: JobContext<unknown>, cursor: ImportCursor): void {
  const { links, unreadable, changed, rows } = cursor.skipped;
  if (links > 0) ctx.warn(`${count(links)} symbolic link${links === 1 ? ' was' : 's were'} not copied.`);
  if (unreadable > 0) ctx.warn(`${count(unreadable)} file${unreadable === 1 ? '' : 's'} could not be read on the old host and ${unreadable === 1 ? 'was' : 'were'} not copied.`);
  if (changed.length > 0) {
    ctx.warn(
      `${count(changed.length)} file${changed.length === 1 ? '' : 's'} kept changing while being copied, and may be missing or incomplete: ` +
        `${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}.`,
    );
  }
  if (rows > 0) ctx.warn(`${count(rows)} database row${rows === 1 ? ' was' : 's were'} too large to copy.`);
}

/**
 * A queued pull canceled before it ran: when nothing was pulled yet, the import goes back to
 * Confirm and the site row it reserved is let go, so the slug is free again.
 */
export function siteImportQueuedCancel(payload: z.infer<typeof siteImportPayload>, s: CoreServices): void {
  const imp = s.db.select().from(imports).where(eq(imports.id, payload.importId)).get();
  if (!imp) return;
  const cursor = s.imports.cursorOf(imp);
  const untouched = !cursor || (cursor.phase === 'snapshot' && !cursor.snapshotId && cursor.filesDone === 0);
  const site = imp.siteId ? s.db.select().from(sites).where(eq(sites.id, imp.siteId)).get() : undefined;
  if (untouched && site?.status === 'provisioning') {
    s.db.delete(sites).where(eq(sites.id, site.id)).run();
    s.imports.mark(imp.id, {
      status: 'connected',
      siteId: null,
      serverId: null,
      jobId: null,
      cursor: null,
      choices: null,
      stagingPath: null,
      startedAt: null,
      expiresAt: Date.now() + IMPORT_TTL_MS.connected,
    });
    s.log.info(`Import #${imp.id}: canceled before it started; back to its Confirm step`);
    return;
  }
  s.imports.mark(imp.id, { status: 'failed', lastError: 'Stopped' });
}

// ------------------------------------------------------------------------- the set-up

/** WordPress's own rewrite rules: what an Apache site needs, and what a host on nginx never had. */
export const WORDPRESS_HTACCESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;

/** Folders that are never the old site's own old address. */
const SHORT_ROOTS = new Set(['/', '/var/www', '/var/www/html']);

/**
 * What `wp eval` runs to take the migration plugin out of the copy. Its files stay on the old site
 * (the plugin leaves its own folder out of the listing); its place among the active plugins and its
 * settings, the import's token and a maintenance page that was on during a refresh among them, come
 * with the database.
 */
export const FORGET_MIGRATE_PLUGIN = String.raw`require_once ABSPATH . 'wp-admin/includes/plugin.php'; deactivate_plugins('wpl7-migrate/wpl7-migrate.php', true); global $wpdb; $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE 'wpl7\_migrate\_%'");`;

/**
 * What a database from another host needs before it works here, run in a started container: the
 * schema brought up to the WordPress version, the old address replaced with `url` - in both schemes
 * and inside JSON with its slashes escaped, which page builders store - the old folder with
 * /var/www/html when asked, the chosen plugins deactivated, and search engines discouraged while
 * the site is not live. Plugins are left out of the commands that do not need them: a plugin that
 * fails without the old host's cache server must not stop the rest. Returns the administrator the
 * panel acts as.
 */
export async function fixWordPress(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  site: SiteRow,
  report: MigrateReport,
  choices: ImportRunBody,
  url: string,
  opts: { discourageSearchEngines: boolean },
): Promise<{ id: number; login: string } | null> {
  const container = site.containerName;
  try {
    const res = await server.wp.run(container, ['core', 'update-db', '--skip-plugins', '--skip-themes'], 300_000);
    if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim().slice(0, 300));
  } catch (err) {
    ctx.warn(`Could not update the database for this WordPress version (${errMsg(err)}).`);
  }
  const admin = await server.wp.siteAdministrator(container, null).catch(() => null);
  if (!admin) ctx.warn('The site has no administrator account the panel can act as.');

  const old = report.home.replace(/\/+$/, '');
  const abspath = report.abspath.replace(/\/+$/, '') || '/';
  // The recipes run with the address change (afterUrlChange): licensed plugins are activated for the
  // new address. Not afterInstall as well - it would update plugins on a site that arrived as it was.
  await rewriteWordPressUrls(ctx, s, server, site, old, url, true, {
    skipExtensions: true,
    inside: async (c) => {
      const other = old.startsWith('https://') ? `http://${old.slice(8)}` : `https://${old.slice(7)}`;
      for (const [from, to] of [
        [other, url],
        [old.replaceAll('/', '\\/'), url.replaceAll('/', '\\/')],
        [other.replaceAll('/', '\\/'), url.replaceAll('/', '\\/')],
      ] as const) {
        await server.wp.searchReplace(c, from, to, { skipExtensions: true });
      }
      if (choices.rewritePaths) {
        if (SHORT_ROOTS.has(abspath)) {
          ctx.warn(`The old site's folder is ${abspath}; file paths were left as they are.`);
        } else {
          ctx.info(`Replacing the old folder ${abspath} with /var/www/html…`);
          await server.wp.searchReplace(c, abspath, '/var/www/html', { skipExtensions: true });
        }
      }
    },
  });

  const forget = await server.wp
    .run(container, ['eval', FORGET_MIGRATE_PLUGIN, '--skip-plugins', '--skip-themes'], 60_000)
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: errMsg(err) }));
  if (forget.exitCode !== 0) {
    ctx.warn(`Could not take the migration plugin's settings out of the copy (${(forget.stderr || forget.stdout).trim().slice(0, 200)}).`);
  }

  if (choices.deactivatePlugins.length > 0) {
    ctx.info(`Deactivating ${choices.deactivatePlugins.join(', ')}…`);
    try {
      await server.wp.pluginDeactivate(container, choices.deactivatePlugins, admin?.login);
    } catch (err) {
      // A plugin that fatals here without its old host is deactivated without being loaded.
      const res = await server.wp.run(container, ['plugin', 'deactivate', ...choices.deactivatePlugins, '--skip-plugins', '--skip-themes'], 300_000);
      if (res.exitCode !== 0) ctx.warn(`Could not deactivate them (${errMsg(err)}); do it on the site's WordPress tab.`);
    }
  }
  if (opts.discourageSearchEngines) {
    try {
      await server.wp.optionUpdate(container, 'blog_public', '0', { skipExtensions: true });
      ctx.info('Search engines are discouraged until the site goes live.');
    } catch (err) {
      ctx.warn(`Could not discourage search engines (${errMsg(err)}); set it in Settings -> Reading.`);
    }
  }
  return admin;
}

/** Take out what the admin chose to leave behind: drop-ins, and must-use plugins with their folders. */
export async function leaveBehind(ctx: JobContext<unknown>, server: ServerHandle, wordpressDir: string, choices: ImportRunBody): Promise<void> {
  for (const dropin of choices.removeDropins) {
    await server.files.rm(path.join(wordpressDir, 'wp-content', dropin));
  }
  for (const file of choices.removeMuPlugins) {
    // A host's must-use plugin is a file and, often, a folder of the same name beside it.
    await server.files.rm(path.join(wordpressDir, 'wp-content', 'mu-plugins', file));
    await server.files.rm(path.join(wordpressDir, 'wp-content', 'mu-plugins', file.replace(/\.php$/, '')));
  }
  if (choices.removeDropins.length + choices.removeMuPlugins.length > 0) {
    ctx.info(`Left behind: ${[...choices.removeDropins, ...choices.removeMuPlugins].join(', ')}.`);
  }
}

export async function siteImportFinish(ctx: JobContext<z.infer<typeof siteImportFinishPayload>>, s: CoreServices): Promise<void> {
  let row: ImportRow = s.imports.get(ctx.payload.importId);
  if (!['pulled', 'failed', 'finishing'].includes(row.status)) {
    throw new Error(`Import #${row.id} is ${row.status}; there is nothing to set up`);
  }
  const report = s.imports.reportOf(row);
  const choices = row.choices ? (JSON.parse(row.choices) as ImportRunBody) : null;
  const cursor = s.imports.cursorOf(row);
  if (!report || !choices || !cursor || cursor.phase !== 'done' || !row.stagingPath || !row.siteId) {
    throw new Error(`Import #${row.id} has not finished pulling`);
  }
  let site: SiteRow = loadSite(s.db, row.siteId);
  const server = s.servers.handleFor(site.serverId);
  const paths = sitePaths(s.config, site.slug);
  const domains = siteDomains(site);
  const primary = domains[0]!;
  const devUrl = siteUrl(s.config, primary);
  const staging = row.stagingPath;
  const wordpressDir = path.join(staging, 'wordpress');
  const dbSqlGz = path.join(staging, 'db.sql.gz');
  const protection: ProtectionHold = { release: null };

  row = s.imports.mark(row.id, { status: 'finishing', jobId: ctx.jobId, lastError: null });
  updateSiteRow(s.db, site.id, { status: 'provisioning' });
  ctx.info(`Setting up "${site.slug}" from the pulled copy…`);
  try {
    // ------------------------------------------------------------ preflight
    if (!(await server.files.exists(wordpressDir)) && (await server.files.exists(paths.wordpress))) {
      // An earlier attempt moved the files in and could not move them back: they are the only copy.
      ctx.warn('Moving the files an earlier attempt left in the site folder back to staging…');
      await server.files.rename(paths.wordpress, wordpressDir);
    }
    if (!(await server.files.exists(wordpressDir)) || !(await server.files.exists(dbSqlGz))) {
      throw new ImportSourceError('The pulled copy is gone. Delete the import and start again.', true, 'staging');
    }
    if ((await server.docker.containerState(site.containerName)) !== 'missing') {
      ctx.warn(`Removing leftover container ${site.containerName} (earlier attempt)`);
      await server.docker.removeContainer(site.containerName);
    }
    if (await server.files.exists(paths.root)) {
      ctx.warn('Removing leftover files of an earlier attempt');
      await server.files.rm(paths.root);
    }
    await server.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
    await ensureDevDnsRecord(ctx, s, server, site.devHostname);
    await dnsPreflight(s.config, server.row, domains, ctx);
    await ensureSiteImage(ctx, server, s.config, site.phpVersion);
    await server.files.mkdirp(s.config.paths.plugins);
    ctx.checkCanceled();

    // ------------------------------------------------------------ what stays behind
    await leaveBehind(ctx, server, wordpressDir, choices);
    // The image writes WordPress's rules only into an empty folder; a site from nginx has none.
    if (!(await server.files.exists(path.join(wordpressDir, '.htaccess')))) {
      ctx.info('Writing WordPress’s standard .htaccess (the old site had none).');
      await server.files.writeFile(path.join(wordpressDir, '.htaccess'), WORDPRESS_HTACCESS, { mode: 0o644 });
    }

    // ------------------------------------------------------------ the site, unrouted
    await makeRoomForStatements(ctx, server, cursor.longestStatement ?? 0);
    await restoreSiteOnServer(ctx, s, server, site, domains, { kind: 'tree', wordpressDir, dbSqlGz }, {
      routing: false,
      requireWpConfig: false,
      protection,
      probe: null,
    });
    s.imports.writeCursor(row.id, { ...cursor, materialized: true });
    // The image writes wp-config.php from the container's settings at its first start.
    ctx.info('Waiting for WordPress to write its wp-config.php…');
    await waitForWordPressFiles(server.files, paths.wordpress, ctx);
    // -h: the site's own folder, so a link there is changed itself, never what it points at.
    await server.exec.run('chown', ['-h', '33:33', path.join(paths.wordpress, 'wp-config.php')]).catch(() => undefined);
    ctx.checkCanceled();

    // ------------------------------------------------------------ WordPress
    const container = site.containerName;
    const carried = choices.carryConstants
      .map((name) => report.constants.find((c) => c.name === name))
      .filter((c): c is MigrateReport['constants'][number] => c !== undefined);
    if (carried.length > 0) {
      ctx.info(`Carrying ${carried.length} setting${carried.length === 1 ? '' : 's'} into wp-config.php…`);
      for (const constant of carried) {
        const literal = constantLiteral(constant);
        if (!literal) continue;
        try {
          await server.wp.configSet(container, constant.name, literal.value, { raw: literal.raw });
        } catch (err) {
          ctx.warn(`Could not set ${constant.name} (${errMsg(err)}).`);
        }
      }
    }
    const admin = await fixWordPress(ctx, s, server, site, report, choices, devUrl, { discourageSearchEngines: true });
    ctx.checkCanceled();

    // ------------------------------------------------------------ publish
    ctx.info('Publishing the site…');
    await s.security.kick(server.id);
    await server.docker.removeContainer(site.containerName);
    await server.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, site, domains, siteTlsFor(s.dns, server.row), siteRuntimeFrom(s.settings)),
    );
    await startSiteContainer(server, s, site, ctx);
    const up = await probeSite(server, site.containerName, primary, s.config.probeTimeoutMs);
    if (!up) ctx.warn('The site did not answer the smoke check yet; look at its Files tab (.htaccess) and container logs if it stays down.');

    updateSiteRow(s.db, site.id, { status: 'running', wpAdminUser: admin?.login ?? null });
    protection.release?.();
    protection.release = null;
    ctx.clearCompensations();
    site = loadSite(s.db, site.id);
    await writeSiteJson(server, s.config, site).catch((err) => ctx.warn(`Could not write site.json (${errMsg(err)}).`));
  } catch (err) {
    ctx.error(`Setting the site up failed: ${errMsg(err)}`);
    await ctx.runCompensations();
    updateSiteRow(s.db, site.id, { status: 'error' });
    s.imports.mark(row.id, {
      status: 'failed',
      lastError: err instanceof JobCanceledError ? 'Stopped' : errMsg(err),
      cursor: JSON.stringify({ ...cursor, materialized: false }),
    });
    ctx.info('The pulled copy is back in staging. Continue tries the set-up again.');
    if (protection.release) {
      protection.release();
      await s.security.kick(server.id);
    }
    throw err;
  }

  // ------------------------------------------------------------ the site is up: the rest is best effort
  try {
    await s.wpInventory.scanSite(site, server, { log: (level, message) => ctx.log(level, message) });
  } catch (err) {
    ctx.warn(`Could not read the site's plugins and themes yet (${errMsg(err)}).`);
  }
  try {
    s.malwareScan.request(s.worker, site, 'import');
    ctx.info('Queued a malware scan.');
  } catch (err) {
    ctx.warn(`Could not queue a malware scan (${errMsg(err)}); start one from the site's Security tab.`);
  }
  let backupId: number | null = null;
  try {
    s.monitor.busySlugs.add(site.slug);
    backupId = (
      await s.backup.createOn(server, site, 'import', {
        note: `imported from ${ctx.payload.sourceHost}`,
        jobId: ctx.jobId,
        log: (level, message) => ctx.log(level, message),
      })
    ).id;
  } catch (err) {
    ctx.warn(`The first backup failed (${errMsg(err)}); take one from the Backups tab.`);
  } finally {
    s.monitor.busySlugs.delete(site.slug);
  }
  await server.files.rm(staging).catch((err) => ctx.warn(`Could not remove the staging folder ${staging} (${errMsg(err)}).`));
  s.imports.mark(row.id, { status: 'done', importedAt: Date.now(), stagingPath: null, expiresAt: null });
  ctx.setResult({ slug: site.slug, url: devUrl, ...(backupId !== null ? { backupId } : {}) });
  ctx.info(`Imported: ${devUrl}. Search engines stay discouraged until you go live.`);
}
