// @docs sites/import
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import { PANEL_VERSION } from '../lib/version.js';
import { OutboundRefusedError, assertAllowedSource, type AllowedSource, type LookupFn } from '../lib/outboundGuard.js';

/**
 * The panel's side of the import protocol (docs/internal/import-protocol.md): every request it
 * makes to the migration plugin on an old site, signed with the import's token, sent to the
 * address the outbound guard vetted, retried when the old host has a bad moment, and falling
 * back - to the query-string transport when the host blocks /wp-json/, to base64 and gzip when it
 * mangles binary bodies - the first time either is needed. What was learned (the transport, the
 * encoding, the clock offset) is kept in `state`, which the pull job stores with its cursor.
 */

export interface PullRequest {
  url: URL;
  /** The vetted address the connection must go to (the name is only for TLS and Host). */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: Buffer;
  /** Larger answers are cut off and refused. */
  maxBytes: number;
  timeoutMs: number;
}

export interface PullResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type PullTransport = (req: PullRequest) => Promise<PullResponse>;

export class PullTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullTransportError';
  }
}

/**
 * The transport the panel uses: node's own http and https, never `fetch`. undici cannot be told
 * which address to connect to, so a name that re-resolved between the guard's check and the
 * connection - a DNS rebind - would carry a signed request into the panel's own network. Here
 * the socket goes to the vetted address, TLS checks the certificate against the name, and a
 * redirect is an answer like any other (the client refuses it). Connections are kept alive per
 * address: an import is thousands of requests, and a TLS handshake for each would double its time.
 */
export function createPinnedTransport(): PullTransport & { close: () => void } {
  const agents = new Map<string, http.Agent>();
  const agentFor = (url: URL, address: string, family: 4 | 6): http.Agent => {
    const key = `${url.protocol}//${url.host}@${address}`;
    let agent = agents.get(key);
    if (!agent) {
      const lookup: LookupFunction = (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
        else callback(null, address, family);
      };
      const options = { keepAlive: true, maxSockets: 4, lookup };
      agent = url.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
      agents.set(key, agent);
    }
    return agent;
  };
  const transport = (req: PullRequest) =>
    new Promise<PullResponse>((resolve, reject) => {
      const secure = req.url.protocol === 'https:';
      const request = (secure ? https : http).request(
        {
          method: 'POST',
          hostname: req.url.hostname.replace(/^\[|\]$/g, ''),
          port: req.url.port || (secure ? 443 : 80),
          path: `${req.url.pathname}${req.url.search}`,
          headers: { ...req.headers, 'content-length': String(req.body.length) },
          agent: agentFor(req.url, req.address, req.family),
          timeout: req.timeoutMs,
          ...(secure ? { servername: req.url.hostname, rejectUnauthorized: true } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > req.maxBytes) {
              res.destroy(new PullTransportError(`The answer was larger than ${req.maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        },
      );
      request.on('timeout', () => request.destroy(new PullTransportError(`No answer within ${Math.round(req.timeoutMs / 1000)} s`)));
      request.on('error', reject);
      request.end(req.body);
    });
  return Object.assign(transport, {
    close: () => {
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  });
}

/** Something about the old site the pull cannot get past. `fatal`: retrying will not help. */
export class ImportSourceError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ImportSourceError';
  }
}

export type Transport = 'rest' | 'query';
export type RangeEncoding = 'raw' | 'base64' | 'gzip';

/** What the client learned about the old host; kept with the pull's cursor. */
export interface PullState {
  transport: Transport | null;
  encoding: RangeEncoding;
  /** The plugin's clock minus the panel's, in seconds. */
  skewS: number;
}

export interface PingAnswer {
  protocol: number;
  plugin: string;
  time: number;
  limits: { max_ms: number; max_bytes: number; max_row_bytes: number };
  transports?: string[];
  encodings?: string[];
  actions?: string[];
}

export interface SnapshotAnswer {
  snapshot_id: string;
  done: boolean;
  entries: number;
  bytes: number;
  dirs_pending?: number;
  warnings?: { code: string; count?: number; detail?: string }[];
}

/** One entry of the snapshot (A.5 `files`). */
export interface FileEntry {
  id: number;
  p: string;
  s: number;
  m: number;
  md: string;
  t: 'f' | 'd' | 'l';
  f?: string[];
  l?: string;
  lb?: string;
  pb?: string;
  h?: string;
}

export interface FilesAnswer {
  entries: FileEntry[];
  next: number | null;
}

export type RangeAnswer =
  | { kind: 'data'; data: Buffer; size: number; mtime: number; wholeSha256: string | null }
  | { kind: 'changed'; size: number; mtime: number }
  | { kind: 'missing'; detail: string };

export type BundleFile =
  | { id: number; size: number; mtime: number; sha256: string; data: Buffer; changed?: boolean }
  | { id: number; error: string };

export interface BundleAnswer {
  files: BundleFile[];
  next: number | null;
}

export interface TablesAnswer {
  tables: { name: string; rows: number; bytes: number; pk: string[] | null; collation?: string | null; engine?: string; avg_row?: number }[];
  prefix: string;
}

export interface SqlAnswer {
  sql: string;
  next: string | null;
  rows: number;
  /** Rows too large to copy: by their key's values, or by their place in a table without one. */
  skipped: { key?: unknown[]; offset?: number; bytes: number }[];
  /** `create_comment`: what the plugin took out of the CREATE TABLE line (a versioned comment). */
  warnings: { code: string; detail?: string }[];
}

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** The canonical string a request's signature covers (A.2). */
export function canonicalRequest(importId: number, action: string, timestamp: number, nonce: string, body: Buffer): string {
  return ['WPL7-MIGRATE-V1', String(importId), action, String(timestamp), nonce, sha256(body)].join('\n');
}

export function signRequest(token: string, canonical: string): string {
  return crypto.createHmac('sha256', Buffer.from(token, 'utf8')).update(canonical).digest('hex');
}

/** Where an action is, through each transport. */
export function actionUrl(transport: Transport, endpoint: string, home: string, action: string): URL {
  if (transport === 'query') {
    const url = new URL(home.endsWith('/') ? home : `${home}/`);
    url.searchParams.set('wpl7-migrate', action);
    return url;
  }
  const url = new URL(endpoint);
  const route = url.searchParams.get('rest_route');
  if (route !== null) {
    url.searchParams.set('rest_route', `${route.endsWith('/') ? route : `${route}/`}${action}`);
  } else {
    url.pathname = `${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}${action}`;
  }
  return url;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json: Record<string, unknown> | null;
}

export interface PullClientOptions {
  importId: number;
  token: string;
  home: string;
  endpoint: string;
  allowHttp: boolean;
  transport?: PullTransport;
  lookup?: LookupFn;
  state?: Partial<PullState>;
  canceled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Attempts per request before giving up on a transient failure. */
  attempts?: number;
}

/** Thrown when a sleep between retries notices the job was asked to stop. */
export class PullCanceledError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'PullCanceledError';
  }
}

export class ImportPullClient {
  readonly state: PullState;
  private readonly transport: PullTransport;
  private vetted: { address: AllowedSource; at: number } | null = null;
  /** The old host has zlib: SQL pages and bundles travel gzipped. */
  private gzip = false;
  private actions: string[] | null = null;
  /** Requests sent, for the job's progress line. */
  requests = 0;

  constructor(private readonly opts: PullClientOptions) {
    this.state = { transport: opts.state?.transport ?? null, encoding: opts.state?.encoding ?? 'raw', skewS: opts.state?.skewS ?? 0 };
    this.transport = opts.transport ?? createPinnedTransport();
  }

  close(): void {
    (this.transport as { close?: () => void }).close?.();
  }

  // ------------------------------------------------------------------ actions

  async ping(): Promise<PingAnswer> {
    const answer = await this.call('ping', {});
    const ping = answer.json as unknown as PingAnswer;
    if (ping.protocol !== 1) {
      throw new ImportSourceError(`The plugin on the old site speaks protocol ${ping.protocol}; download it again from the panel.`, true, 'unsupported');
    }
    if (typeof ping.time === 'number') this.state.skewS = ping.time - Math.floor(this.now() / 1000);
    this.gzip = ping.encodings?.includes('gzip') ?? false;
    this.actions = ping.actions ?? null;
    return ping;
  }

  /** Whether the plugin answers an action; null until ping said, and for a plugin that does not list them. */
  answers(action: string): boolean {
    return this.actions?.includes(action) ?? false;
  }

  snapshot(op: 'start' | 'continue' | 'status', params: { follow?: 'none' | 'inside'; since?: number; budget_ms?: number } = {}): Promise<SnapshotAnswer> {
    return this.call('snapshot', { op, follow: params.follow ?? 'none', ...params }).then((a) => a.json as unknown as SnapshotAnswer);
  }

  files(snapshotId: string, after: number, limit: number): Promise<FilesAnswer> {
    return this.call('files', { snapshot_id: snapshotId, after, limit }).then((a) => a.json as unknown as FilesAnswer);
  }

  /**
   * Part of one file. `refresh` at offset 0 serves the file as it is now even when it changed
   * since the snapshot listed it; otherwise a change is answered `changed`.
   */
  async range(id: number, offset: number, length: number, ifChanged: 'error' | 'refresh'): Promise<RangeAnswer> {
    for (;;) {
      const encoding = this.state.encoding;
      const answer = await this.call('range', { id, offset, length, encoding, if_changed: ifChanged }, { binary: encoding === 'raw', pass: [404, 409] });
      if (answer.status === 404) return { kind: 'missing', detail: String((answer.json?.error as { detail?: string })?.detail ?? 'missing') };
      if (answer.status === 409) {
        const e = (answer.json?.error ?? {}) as { size?: number; mtime?: number; code?: string };
        if (e.code === 'changed') return { kind: 'changed', size: Number(e.size ?? 0), mtime: Number(e.mtime ?? 0) };
        throw new ImportSourceError(`The old site refused a file read: ${e.code ?? 'conflict'}`, false, e.code);
      }
      let data: Buffer;
      let size: number;
      let mtime: number;
      let check: string | null;
      if (encoding === 'raw') {
        data = answer.body;
        size = Number(answer.headers['x-wpl7-size']);
        mtime = Number(answer.headers['x-wpl7-mtime']);
        check = answer.headers['x-wpl7-range-sha256'] ?? null;
      } else {
        const json = answer.json as { data?: string; size?: number; mtime?: number; sha256?: string };
        const raw = Buffer.from(String(json.data ?? ''), 'base64');
        data = encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
        size = Number(json.size);
        mtime = Number(json.mtime);
        check = json.sha256 ?? null;
      }
      // A host that rewrites what PHP sends - an output filter, a misconfigured compression -
      // breaks binary bodies first. The checksum of every range says whether it arrived as sent.
      if (check === null || sha256(data) !== check || !Number.isFinite(size)) {
        const next: RangeEncoding | null = encoding === 'raw' ? 'base64' : encoding === 'base64' ? 'gzip' : null;
        if (!next) throw new ImportSourceError('The old host changes file contents on their way to the panel, whatever the encoding.', true, 'mangled');
        this.opts.log?.(`The old host altered a file on its way (${encoding}); switching to ${next}.`);
        this.state.encoding = next;
        continue;
      }
      return { kind: 'data', data, size, mtime, wholeSha256: answer.headers['x-wpl7-sha256'] ?? null };
    }
  }

  /** Several small files whole, in one request. */
  async bundle(snapshotId: string, ids: number[], maxBytes: number): Promise<BundleAnswer> {
    const encoding = this.gzip ? 'gzip' : 'base64';
    const answer = await this.call('bundle', { snapshot_id: snapshotId, ids, max_bytes: maxBytes, encoding });
    const json = answer.json as { files?: Record<string, unknown>[]; next?: number | null };
    const files: BundleFile[] = [];
    for (const f of json.files ?? []) {
      const id = Number(f.id);
      if (typeof f.error === 'string') {
        files.push({ id, error: f.error });
        continue;
      }
      const raw = Buffer.from(String(f.data ?? ''), 'base64');
      const data = encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
      const sum = String(f.sha256 ?? '');
      if (sha256(data) !== sum) throw new ImportSourceError(`A file of the bundle arrived altered (#${id}).`, false, 'mangled');
      files.push({ id, size: Number(f.size), mtime: Number(f.mtime), sha256: sum, data, ...(f.changed ? { changed: true } : {}) });
    }
    return { files, next: json.next === null || json.next === undefined ? null : Number(json.next) };
  }

  tables(): Promise<TablesAnswer> {
    return this.call('tables', {}).then((a) => a.json as unknown as TablesAnswer);
  }

  async sql(table: string, cursor: string, maxBytes: number): Promise<SqlAnswer> {
    const answer = await this.call('sql', { table, cursor, max_bytes: maxBytes, encoding: this.gzip ? 'gzip' : 'json' });
    const json = answer.json as {
      sql?: string;
      gz?: string;
      sha256?: string;
      next?: string | null;
      rows?: number;
      skipped?: SqlAnswer['skipped'];
      warnings?: SqlAnswer['warnings'];
    };
    const sql = typeof json.gz === 'string' ? zlib.gunzipSync(Buffer.from(json.gz, 'base64')).toString('utf8') : String(json.sql ?? '');
    if (json.sha256 && sha256(Buffer.from(sql, 'utf8')) !== json.sha256) {
      throw new ImportSourceError(`A page of ${table} arrived altered.`, false, 'mangled');
    }
    return { sql, next: json.next ?? null, rows: Number(json.rows ?? 0), skipped: json.skipped ?? [], warnings: json.warnings ?? [] };
  }

  maintenance(on: boolean, ttlS = 3600): Promise<{ on: boolean; until: number }> {
    return this.call('maintenance', { on, ttl_s: ttlS }).then((a) => a.json as unknown as { on: boolean; until: number });
  }

  async finish(): Promise<void> {
    await this.call('finish', {});
  }

  // ------------------------------------------------------------------ the request

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    const sleepFn = this.opts.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
    // In slices, so a job asked to stop does not first sit out a five-minute back-off.
    for (let left = ms; left > 0; left -= 1000) {
      if (this.opts.canceled?.()) throw new PullCanceledError();
      await sleepFn(Math.min(1000, left));
    }
    if (this.opts.canceled?.()) throw new PullCanceledError();
  }

  /** The vetted address, looked up again every five minutes. */
  private async address(url: URL): Promise<AllowedSource> {
    if (this.vetted && this.now() - this.vetted.at < 5 * 60_000 && this.vetted.address.url.host === url.host) return this.vetted.address;
    try {
      const address = await assertAllowedSource(url.toString(), { allowHttp: this.opts.allowHttp, lookup: this.opts.lookup });
      this.vetted = { address, at: this.now() };
      return address;
    } catch (err) {
      if (err instanceof OutboundRefusedError) throw new ImportSourceError(`The panel will not connect to the old site: ${err.message}.`, true, 'refused');
      throw err;
    }
  }

  private async send(transport: Transport, action: string, body: Buffer, maxBytes: number): Promise<Answer> {
    const url = actionUrl(transport, this.opts.endpoint, this.opts.home, action);
    const target = await this.address(url);
    const timestamp = Math.floor(this.now() / 1000) + this.state.skewS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = `v1=${signRequest(this.opts.token, canonicalRequest(this.opts.importId, action, timestamp, nonce, body))}`;
    // In the query string as well as in headers: some hosts strip headers they do not know.
    url.searchParams.set('_id', String(this.opts.importId));
    url.searchParams.set('_ts', String(timestamp));
    url.searchParams.set('_nonce', nonce);
    url.searchParams.set('_sig', signature);
    this.requests++;
    const res = await this.transport({
      url,
      address: target.address,
      family: target.family,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json, application/octet-stream',
        'user-agent': `WPL7/${PANEL_VERSION}`,
        'x-wpl7-import-id': String(this.opts.importId),
        'x-wpl7-timestamp': String(timestamp),
        'x-wpl7-nonce': nonce,
        'x-wpl7-signature': signature,
      },
      body,
      maxBytes,
      timeoutMs: 60_000,
    });
    let json: Record<string, unknown> | null = null;
    if ((res.headers['content-type'] ?? '').includes('json')) {
      try {
        json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
    return { ...res, json };
  }

  /**
   * One action, with everything that keeps it going: the other transport, the clock fix, and
   * retries with back-off for whatever an old host does now and then. `pass` lists the statuses
   * the caller handles itself.
   */
  private async call(
    action: string,
    params: Record<string, unknown>,
    opts: { binary?: boolean; pass?: number[]; maxBytes?: number } = {},
  ): Promise<Answer> {
    const body = Buffer.from(JSON.stringify(params), 'utf8');
    const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    const attempts = this.opts.attempts ?? 8;
    let fixedClock = false;
    let problem = 'no answer';
    for (let attempt = 1; attempt <= attempts; ) {
      if (this.opts.canceled?.()) throw new PullCanceledError();
      const outcome = await this.once(action, body, maxBytes, opts.pass ?? []);
      if (outcome.kind === 'answer') return outcome.answer;
      if (outcome.kind === 'clock') {
        // The two clocks disagree: sign with the old site's time from now on, and again at once.
        if (fixedClock) throw new ImportSourceError("The old site keeps refusing the panel's clock.", true, 'stale');
        this.state.skewS = outcome.skewS;
        fixedClock = true;
        continue;
      }
      problem = outcome.problem;
      if (attempt === attempts) break;
      const wait = Math.min(300_000, outcome.retryAfterMs ?? 2000 * 2 ** (attempt - 1));
      this.opts.log?.(`The old site did not answer ${action} (${problem}); trying again in ${Math.round(wait / 1000)} s.`);
      await this.sleep(wait);
      attempt++;
    }
    throw new ImportSourceError(`The old site did not answer ${action} after ${attempts} attempts (${problem}).`, false, 'unreachable');
  }

  /** One try, through the transport that worked last and then the other one. */
  private async once(
    action: string,
    body: Buffer,
    maxBytes: number,
    pass: number[],
  ): Promise<
    | { kind: 'answer'; answer: Answer }
    | { kind: 'clock'; skewS: number }
    | { kind: 'retry'; problem: string; retryAfterMs: number | null }
  > {
    const known = this.state.transport;
    const order: Transport[] = known ? [known, known === 'rest' ? 'query' : 'rest'] : ['rest', 'query'];
    let foreign: Answer | null = null;
    for (const transport of order) {
      let answer: Answer;
      try {
        answer = await this.send(transport, action, body, maxBytes);
      } catch (err) {
        if (err instanceof ImportSourceError) throw err;
        // A network failure says nothing about the transport: back off and try again.
        return { kind: 'retry', problem: err instanceof Error ? err.message : String(err), retryAfterMs: null };
      }
      if (!answer.headers['x-wpl7-protocol']) {
        // Not the plugin. A host's error page is worth waiting out; anything else - a WAF page, a
        // 404 for /wp-json/, a redirect - and the other way in may still get through.
        if (RETRYABLE.has(answer.status)) return { kind: 'retry', problem: `HTTP ${answer.status}`, retryAfterMs: retryAfter(answer.headers) };
        foreign ??= answer;
        continue;
      }
      this.state.transport = transport;
      const error = (answer.json?.error ?? null) as { code?: string; time?: number; detail?: string } | null;
      if ((answer.status >= 200 && answer.status < 300) || pass.includes(answer.status)) return { kind: 'answer', answer };
      if (answer.status === 401 && error?.code === 'stale' && typeof error.time === 'number') {
        return { kind: 'clock', skewS: error.time - Math.floor(this.now() / 1000) };
      }
      if (answer.status === 401 && error?.code === 'replay') return { kind: 'retry', problem: 'replay', retryAfterMs: 0 };
      if (answer.status === 401 || answer.status === 403) {
        throw new ImportSourceError(
          'The plugin on the old site refused the panel. It may have been disconnected or replaced: download it again and connect.',
          true,
          'unauthorized',
        );
      }
      if (answer.status === 422) {
        throw new ImportSourceError(`The old site cannot do this: ${error?.detail ?? error?.code ?? 'unsupported'}.`, true, 'unsupported');
      }
      if (answer.status === 409 && error?.code === 'busy') {
        return { kind: 'retry', problem: 'busy', retryAfterMs: retryAfter(answer.headers) ?? 5000 };
      }
      if (RETRYABLE.has(answer.status)) {
        return { kind: 'retry', problem: `HTTP ${answer.status}${error?.code ? ` (${error.code})` : ''}`, retryAfterMs: retryAfter(answer.headers) };
      }
      throw new ImportSourceError(`The old site answered ${action} with HTTP ${answer.status}${error?.code ? ` (${error.code})` : ''}.`, false, error?.code);
    }
    const type = foreign!.headers['content-type']?.split(';')[0];
    throw new ImportSourceError(
      `The old host answered with something else (HTTP ${foreign!.status}${type ? `, ${type}` : ''}). ` +
        "Allow the panel's address in the old host's firewall, or add a rule that skips /wp-json/wpl7-migrate/ and ?wpl7-migrate=.",
      true,
      'foreign',
    );
  }
}

function retryAfter(headers: Record<string, string>): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
