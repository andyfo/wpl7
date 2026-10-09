import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { canonicalRequest, signRequest, type PullRequest, type PullResponse, type PullTransport } from '../src/services/importPull.js';

/**
 * An old site with the migration plugin on it, as the panel's pull client sees it: every action of
 * the protocol (docs/internal/import-protocol.md) answered over the client's transport, each
 * request's signature checked with the import's token. Files and tables live in memory. A test
 * makes it misbehave on purpose: fail an action, change a file between listing and reading, block
 * the REST route or raw bodies, run its clock fast.
 */

export type FakeFile = Buffer | string | { link: string } | 'dir';

export interface FakeColumn {
  name: string;
  kind: 'int' | 'string' | 'binary';
}

export interface FakeTable {
  name: string;
  /** The CREATE TABLE line, `;` included. */
  create: string;
  columns: FakeColumn[];
  rows: unknown[][];
  pk: string[] | null;
}

interface Entry {
  id: number;
  path: string;
  type: 'f' | 'd' | 'l';
  data?: Buffer;
  mtime: number;
  link?: string;
  flags?: string[];
}

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** A value as the plugin writes it into an INSERT line (A.9). */
export function sqlLiteral(value: unknown, kind: FakeColumn['kind']): string {
  if (value === null || value === undefined) return 'NULL';
  if (kind === 'binary' || Buffer.isBuffer(value)) return `X'${Buffer.from(value as Buffer).toString('hex')}'`;
  if (kind === 'int') return String(value);
  const text = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0');
  return `'${text}'`;
}

export class FakeSourceSite {
  readonly home: string;
  readonly endpoint: string;
  /** Every action asked for, in order. */
  requests: string[] = [];
  /** Answer the next call of an action with this status (a 503, a network error). */
  private failures = new Map<string, (number | 'network')[]>();
  /** The REST route answers like a host that blocks /wp-json/: a 404 page without the protocol header. */
  blockRest = false;
  /** Raw range bodies come back altered, as a host's output filter would. */
  mangleRaw = false;
  /** Seconds the old site's clock is ahead of the panel's. */
  clockSkewS = 0;
  /** Whether it answers `bundle` (and lists it in ping). */
  bundles = true;
  /** Turned on by `maintenance`, off by `finish`. */
  maintenance = false;
  finished = false;
  /** What the first page of a table's SQL says the plugin took out of its CREATE TABLE line. */
  createComments: Record<string, string> = {};
  /** What the snapshot says about the listing (link, special, excluded, …). */
  snapshotWarnings: { code: string; count?: number; detail?: string }[] = [];
  /**
   * Files and folders the old site cannot read, `''` for its own folder: flagged `unreadable`, with
   * nothing below a folder listed, and counted in the snapshot's warnings like the plugin's root row.
   */
  unreadable = new Set<string>();
  /** Entries per page of `files`, whatever the panel asks for: small, so a pull takes several batches. */
  pageSize = 1000;
  /** Called with every action before it is answered. */
  onRequest: ((action: string, params: Record<string, unknown>) => void) | null = null;
  /** Files that change after so many reads of them: a change in the middle of a read. */
  private changesAfter = new Map<string, { reads: number; content: Buffer }>();
  private reads = new Map<string, number>();
  private files: Entry[] = [];
  private snapshotId: string | null = null;
  private snapshotSteps = 0;
  private seen = new Set<string>();
  /** Changes made to a file after the snapshot listed it: applied on the next read. */
  private pendingChanges = new Map<string, Buffer>();
  /** The modification time of a file changed by `writeFile`; every other file is from 2023. */
  private mtimes = new Map<string, number>();
  /** The current snapshot's `since`: files not changed from then on are listed as unchanged. */
  private since: number | null = null;

  /** The plugin's REST namespace and query variable, and the header its answers carry. */
  protected readonly plugin: { name: string; marker: string };

  constructor(
    readonly opts: {
      token: string;
      importId: number;
      host?: string;
      prefix?: string;
      files: Record<string, FakeFile>;
      tables: FakeTable[];
      maxBytes?: number;
    },
    plugin: { name: string; marker: string } = { name: 'wpl7-migrate', marker: 'x-wpl7-protocol' },
  ) {
    this.plugin = plugin;
    this.home = `https://${opts.host ?? 'willow-pediatrics.example'}`;
    this.endpoint = `${this.home}/wp-json/${plugin.name}/v1/`;
  }

  failNext(action: string, ...how: (number | 'network')[]): void {
    this.failures.set(action, [...(this.failures.get(action) ?? []), ...how]);
  }

  /** A file written on the old site now, by its own clock, between pulls: new, or changed. */
  writeFile(path: string, content: string | Buffer): void {
    this.opts.files[path] = Buffer.from(content);
    this.mtimes.set(path, Math.floor(Date.now() / 1000) + this.clockSkewS);
  }

  /** A file deleted on the old site between pulls. */
  deleteFile(path: string): void {
    delete this.opts.files[path];
  }

  /** A file moved on the old site between pulls, its times kept: what renaming its folder does. */
  moveFile(from: string, to: string): void {
    this.opts.files[to] = this.opts.files[from]!;
    delete this.opts.files[from];
    const mtime = this.mtimes.get(from);
    if (mtime !== undefined) this.mtimes.set(to, mtime);
    this.mtimes.delete(from);
  }

  /** The file changes on the old site once the snapshot has it: its next read sees the new content. */
  changeFile(path: string, content: string | Buffer): void {
    this.pendingChanges.set(path, Buffer.from(content));
  }

  /** The file changes after `reads` reads of it - in the middle of the panel reading it. */
  changeFileAfter(path: string, reads: number, content: string | Buffer): void {
    this.changesAfter.set(path, { reads, content: Buffer.from(content) });
  }

  count(action: string): number {
    return this.requests.filter((a) => a === action).length;
  }

  get maxBytes(): number {
    return this.opts.maxBytes ?? 64 * 1024;
  }

  transport: PullTransport = async (req: PullRequest): Promise<PullResponse> => {
    const url = req.url;
    const rest = `/wp-json/${this.plugin.name}/v1/`;
    let action: string | null = null;
    let via: 'rest' | 'query' = 'rest';
    if (url.pathname.startsWith(rest)) {
      if (this.blockRest) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<h1>Not Found</h1>') };
      action = url.pathname.slice(rest.length);
    } else if (url.searchParams.has(this.plugin.name)) {
      action = url.searchParams.get(this.plugin.name);
      via = 'query';
    }
    if (!action) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nope') };
    this.requests.push(action);
    const failure = this.failures.get(action)?.shift();
    if (failure === 'network') throw new Error('socket hang up');
    if (typeof failure === 'number') return this.error(failure, 'internal');
    const before = this.beforeSignature(action, req, via);
    if (before) return before;

    const now = Math.floor(Date.now() / 1000) + this.clockSkewS;
    const refused = this.verify(action, req, now);
    if (refused) return refused;
    const nonce = req.headers['x-wpl7-nonce'] ?? '';
    if (this.seen.has(nonce)) return this.error(401, 'replay');
    this.seen.add(nonce);
    const params = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>;
    this.onRequest?.(action, params);
    return this.answer(action, params, now, via);
  };

  /** What answers before the plugin is reached at all (a site that fails as it loads): nothing, here. */
  protected beforeSignature(_action: string, _req: PullRequest, _via: 'rest' | 'query'): PullResponse | null {
    return null;
  }

  /** The signature and the time window, as the plugin checks them: the refusal, or null. */
  protected verify(action: string, req: PullRequest, now: number): PullResponse | null {
    const id = req.headers['x-wpl7-import-id'];
    const ts = Number(req.headers['x-wpl7-timestamp']);
    const nonce = req.headers['x-wpl7-nonce'] ?? '';
    const sig = req.headers['x-wpl7-signature'] ?? '';
    if (id !== String(this.opts.importId)) return this.error(401, 'unauthorized');
    const expected = `v1=${signRequest(this.opts.token, canonicalRequest(this.opts.importId, action, ts, nonce, req.body))}`;
    if (sig !== expected) return this.error(401, 'unauthorized');
    if (Math.abs(now - ts) > 300) return this.error(401, 'stale', { time: now });
    return null;
  }

  protected json(status: number, body: unknown, extra: Record<string, string> = {}): PullResponse {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', [this.plugin.marker]: '1', 'cache-control': 'no-store', ...extra },
      body: Buffer.from(JSON.stringify(body)),
    };
  }

  protected error(status: number, code: string, extra: Record<string, unknown> = {}): PullResponse {
    return this.json(status, { error: { code, ...extra } });
  }

  private walk(): void {
    this.files = [];
    let id = 0;
    const hidden = (p: string) => [...this.unreadable].some((d) => d === '' || p.startsWith(`${d}/`));
    const all = Object.keys(this.opts.files).sort();
    const dirs = new Set<string>();
    for (const p of all) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const paths = all.filter((p) => !hidden(p));
    // Folders first, then everything else, the way a breadth-first walk lists them.
    for (const d of [...dirs].sort()) {
      if (hidden(d)) continue;
      this.files.push({ id: ++id, path: d, type: 'd', mtime: 1_700_000_000, ...(this.unreadable.has(d) ? { flags: ['unreadable'] } : {}) });
    }
    for (const p of paths) {
      const f = this.opts.files[p]!;
      const mtime = this.mtimes.get(p) ?? 1_700_000_000;
      if (f === 'dir') this.files.push({ id: ++id, path: p, type: 'd', mtime });
      else if (typeof f === 'object' && !Buffer.isBuffer(f)) this.files.push({ id: ++id, path: p, type: 'l', link: f.link, mtime });
      else this.files.push({ id: ++id, path: p, type: 'f', data: Buffer.from(f), mtime, ...(this.unreadable.has(p) ? { flags: ['unreadable'] } : {}) });
    }
  }

  /** The file as it is now, after any change a test made since the listing. */
  private current(entry: Entry): Entry {
    const reads = (this.reads.get(entry.path) ?? 0) + 1;
    this.reads.set(entry.path, reads);
    const later = this.changesAfter.get(entry.path);
    if (later && reads > later.reads) {
      this.changesAfter.delete(entry.path);
      this.pendingChanges.set(entry.path, later.content);
    }
    const changed = this.pendingChanges.get(entry.path);
    if (changed) {
      this.pendingChanges.delete(entry.path);
      entry.data = changed;
      entry.mtime += 60;
      this.changedSinceListing.add(entry.id);
    }
    return entry;
  }

  private changedSinceListing = new Set<number>();
  /** Size and mtime as listed. */
  private listed = new Map<number, { s: number; m: number }>();

  protected answer(action: string, p: Record<string, unknown>, now: number, _via: 'rest' | 'query' = 'rest'): PullResponse {
    switch (action) {
      case 'ping':
        return this.json(200, {
          protocol: 1,
          plugin: '0.3.0',
          time: now,
          limits: { max_ms: 10000, max_bytes: this.maxBytes, max_row_bytes: 15 * 1024 * 1024 },
          transports: ['rest', 'query'],
          encodings: ['raw', 'base64', 'gzip'],
          actions: ['ping', 'info', 'snapshot', 'files', 'range', ...(this.bundles ? ['bundle'] : []), 'tables', 'sql', 'maintenance', 'finish'],
        });
      case 'snapshot': {
        if (p.op === 'start') {
          this.snapshotId = crypto.randomBytes(8).toString('hex');
          this.snapshotSteps = 0;
          this.since = typeof p.since === 'number' ? p.since : null;
          this.walk();
          this.listed = new Map(this.files.map((f) => [f.id, { s: f.data?.length ?? 0, m: f.mtime }]));
        } else if (p.op === 'continue') {
          this.snapshotSteps++;
        }
        const done = this.snapshotSteps >= 1;
        const unreadable = this.files.filter((f) => f.flags?.includes('unreadable')).length + (this.unreadable.has('') ? 1 : 0);
        return this.json(200, {
          snapshot_id: this.snapshotId,
          done,
          entries: done ? this.files.length : Math.floor(this.files.length / 2),
          bytes: this.files.reduce((n, f) => n + (f.data?.length ?? 0), 0),
          dirs_pending: done ? 0 : 1,
          warnings: done ? [...this.snapshotWarnings, ...(unreadable > 0 ? [{ code: 'unreadable', count: unreadable }] : [])] : [],
        });
      }
      case 'files': {
        if (p.snapshot_id !== this.snapshotId) return this.error(409, 'snapshot_stale');
        const after = Number(p.after ?? 0);
        const limit = Math.min(5000, Number(p.limit ?? 1000), this.pageSize);
        const list = this.files.filter((f) => f.id > after).slice(0, limit);
        const last = list.at(-1);
        const more = last ? this.files.some((f) => f.id > last.id) : false;
        return this.json(200, {
          entries: list.map((f) => {
            const listed = this.listed.get(f.id) ?? { s: 0, m: f.mtime };
            const utf8 = Buffer.from(f.path, 'utf8');
            return {
              id: f.id,
              p: f.path,
              s: listed.s,
              m: listed.m,
              md: f.type === 'd' ? '755' : '644',
              t: f.type,
              ...(f.link ? { l: f.link } : {}),
              ...(f.flags ? { f: f.flags } : this.since !== null && f.type === 'f' && f.mtime < this.since ? { f: ['unchanged'] } : {}),
              ...(utf8.toString('utf8') === f.path ? {} : { pb: utf8.toString('base64') }),
              ...(f.data && f.data.length <= 1024 * 1024 ? { h: sha256(f.data) } : {}),
            };
          }),
          next: more ? last!.id : null,
        });
      }
      case 'range': {
        const entry = this.files.find((f) => f.id === Number(p.id) && f.type === 'f');
        if (!entry) return this.error(404, 'not_found', { detail: 'missing' });
        const listed = this.listed.get(entry.id)!;
        const file = this.current(entry);
        const offset = Number(p.offset);
        const length = Math.min(Number(p.length), this.maxBytes);
        const changed = file.data!.length !== listed.s || file.mtime !== listed.m;
        if (changed && !(p.if_changed === 'refresh' && offset === 0)) {
          return this.error(409, 'changed', { size: file.data!.length, mtime: file.mtime });
        }
        if (changed) this.listed.set(entry.id, { s: file.data!.length, m: file.mtime });
        const slice = file.data!.subarray(offset, offset + length);
        const encoding = String(p.encoding ?? 'raw');
        if (encoding === 'raw') {
          const body = this.mangleRaw ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), slice]) : slice;
          return {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              [this.plugin.marker]: '1',
              'x-wpl7-size': String(file.data!.length),
              'x-wpl7-mtime': String(file.mtime),
              'x-wpl7-range-sha256': sha256(slice),
              ...(file.data!.length <= 1024 * 1024 ? { 'x-wpl7-sha256': sha256(file.data!) } : {}),
            },
            body,
          };
        }
        const data = encoding === 'gzip' ? zlib.gzipSync(slice) : slice;
        return this.json(200, { data: data.toString('base64'), size: file.data!.length, mtime: file.mtime, sha256: sha256(slice) });
      }
      case 'bundle': {
        if (!this.bundles) return this.error(404, 'not_found');
        if (p.snapshot_id !== this.snapshotId) return this.error(409, 'snapshot_stale');
        const ids = (p.ids as number[]) ?? [];
        const max = Math.min(Number(p.max_bytes), this.maxBytes);
        const out: Record<string, unknown>[] = [];
        let used = 0;
        let next: number | null = null;
        for (const id of ids) {
          const entry = this.files.find((f) => f.id === id);
          if (!entry || entry.type !== 'f') {
            out.push({ id, error: entry ? 'not_a_file' : 'missing' });
            continue;
          }
          const file = this.current(entry);
          if (file.data!.length > 1024 * 1024) {
            // Grown past what a bundle carries since it was listed.
            out.push({ id, error: 'too_large' });
            continue;
          }
          if (used > 0 && used + file.data!.length > max) {
            next = id;
            break;
          }
          used += file.data!.length;
          const listed = this.listed.get(id)!;
          const data = p.encoding === 'gzip' ? zlib.gzipSync(file.data!) : file.data!;
          out.push({
            id,
            size: file.data!.length,
            mtime: file.mtime,
            sha256: sha256(file.data!),
            data: data.toString('base64'),
            ...(file.data!.length !== listed.s || file.mtime !== listed.m ? { changed: true } : {}),
          });
        }
        return this.json(200, { files: out, next });
      }
      case 'tables':
        return this.json(200, {
          prefix: this.opts.prefix ?? 'wpx_',
          tables: this.opts.tables.map((t) => ({ name: t.name, rows: t.rows.length, bytes: 1000, pk: t.pk, collation: 'utf8mb4_unicode_520_ci', engine: 'InnoDB', avg_row: 100 })),
        });
      case 'sql': {
        const table = this.opts.tables.find((t) => t.name === p.table);
        if (!table) return this.error(404, 'not_found');
        const cursor = String(p.cursor ?? '');
        const start = cursor === '' ? 0 : Number(cursor.slice(2));
        const lines: string[] = [];
        if (cursor === '') lines.push(`DROP TABLE IF EXISTS \`${table.name}\`;`, table.create);
        // Two rows a page, so every table of more than two takes several.
        const rows = table.rows.slice(start, start + 2);
        if (rows.length > 0) {
          const cols = table.columns.map((c) => `\`${c.name}\``).join(',');
          const values = rows.map((r) => `(${r.map((v, i) => sqlLiteral(v, table.columns[i]!.kind)).join(',')})`).join(',');
          lines.push(`INSERT INTO \`${table.name}\` (${cols}) VALUES ${values};`);
        }
        const next = start + 2 < table.rows.length ? `o:${start + 2}` : null;
        const sql = lines.length > 0 ? `${lines.join('\n')}\n` : '';
        const body: Record<string, unknown> = { next, rows: rows.length, skipped: [], sha256: sha256(Buffer.from(sql)) };
        const removed = cursor === '' ? this.createComments[table.name] : undefined;
        if (removed) body.warnings = [{ code: 'create_comment', detail: removed }];
        if (p.encoding === 'gzip') body.gz = zlib.gzipSync(Buffer.from(sql)).toString('base64');
        else body.sql = sql;
        return this.json(200, body);
      }
      case 'maintenance':
        this.maintenance = p.on === true;
        return this.json(200, { on: this.maintenance, until: this.maintenance ? now + Number(p.ttl_s ?? 3600) : 0 });
      case 'finish':
        this.finished = true;
        this.maintenance = false;
        return this.json(200, { ok: true });
      default:
        return this.error(404, 'not_found');
    }
  }
}

/** A table in the plugin's own shape: an id and a text column, and a CREATE line to match. */
export function fakeTable(name: string, rows: [number, string | null][], extra: { binary?: Buffer[] } = {}): FakeTable {
  const withBinary = extra.binary !== undefined;
  return {
    name,
    create:
      `CREATE TABLE \`${name}\` ( \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT, \`value\` longtext, ` +
      `${withBinary ? '`blob` varbinary(255) DEFAULT NULL, ' : ''}PRIMARY KEY (\`id\`) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;`,
    columns: [
      { name: 'id', kind: 'int' },
      { name: 'value', kind: 'string' },
      ...(withBinary ? [{ name: 'blob', kind: 'binary' as const }] : []),
    ],
    rows: rows.map((r, i) => (withBinary ? [...r, extra.binary![i] ?? null] : [...r])),
    pk: ['id'],
  };
}
