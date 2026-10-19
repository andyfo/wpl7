// @docs reference/architecture, sites/database
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import mysql from 'mysql2';
import type { FieldPacket, ResultSetHeader } from 'mysql2';
import { DB_LIMITS, type DbRowFilter, type DbRowKey } from '../../shared/databases.js';
import type {
  DbCell,
  DbColumnDto,
  DbIndexDto,
  DbQueryDto,
  DbQueryResultDto,
  DbRowDto,
  DbRowsPageDto,
  DbTableDto,
  DbTableStructureDto,
  DbValueKind,
  DbWriteResultDto,
} from '../../shared/types.js';
import { AppError, badGateway, badRequest, conflict, notFound, timedOut } from '../lib/errors.js';
import { buildKeyCondition, buildWhere, formatSql, quoteIdent, splitStatements, type SqlValue } from '../lib/sqlText.js';
import type { DockerPort } from './docker.js';
import { MARIADB_CONTAINER } from './stack.js';

/**
 * The database browser: a site's tables, their rows, and SQL, run on the server the site lives on.
 *
 * Every query goes to MariaDB as the site's own database user, so MariaDB itself keeps the browser
 * to that site's databases - `SHOW DATABASES` lists them and nothing else, and `mysql.user` is
 * refused. The connection rides the Docker connection the panel already has to each server: a
 * relay run with `docker exec` inside the MariaDB container joins the exec's stdin and stdout to
 * MariaDB's port, and mysql2 speaks the MySQL protocol over that stream. One path for every server
 * - server 1's socket and a worker's SSH alike - with no port published and none forwarded.
 */

/** Which database, as whom. The route has already checked the database is one of the site's. */
export interface DbTarget {
  database: string;
  user: string;
  password: string;
}

export interface RowsQuery {
  offset: number;
  limit: number;
  sort?: string;
  dir: 'asc' | 'desc';
  filters: DbRowFilter[];
}

export type DbValues = Record<string, string | null>;

export interface DbBrowserPort {
  tables(t: DbTarget): Promise<DbTableDto[]>;
  structure(t: DbTarget, table: string): Promise<DbTableStructureDto>;
  rows(t: DbTarget, table: string, q: RowsQuery): Promise<DbRowsPageDto>;
  /** One row whole (values up to DB_LIMITS.fullValueBytes); null when no row has that key. */
  row(t: DbTarget, table: string, key: DbRowKey): Promise<DbRowDto | null>;
  insert(t: DbTarget, table: string, values: DbValues): Promise<DbWriteResultDto>;
  update(t: DbTarget, table: string, key: DbRowKey, values: DbValues): Promise<DbWriteResultDto>;
  /** All the rows or none: one transaction. */
  remove(t: DbTarget, table: string, keys: DbRowKey[]): Promise<DbWriteResultDto>;
  /** SQL from the editor: one statement after another, stopping at the first error. */
  run(t: DbTarget, sql: string): Promise<DbQueryDto>;
  /** Hang up the connections kept idle for the next request. */
  closeIdle(): void;
}

/**
 * Joins the exec's stdin and stdout to MariaDB's port inside its own container. The writer runs in
 * front: when the panel hangs up, end-of-file stops it and it takes the reader along, so a
 * connection the panel abandoned closes on the server too rather than waiting out wait_timeout.
 * 127.0.0.1 matches a site user's `'user'@'%'`: the image creates no anonymous users to shadow it.
 */
export const RELAY_CMD = [
  'bash',
  '-c',
  'exec 3<>/dev/tcp/127.0.0.1/3306 || exit 1; cat <&3 & r=$!; cat >&3; kill $r 2>/dev/null; wait',
];

/** Sessions at once on one server. Each holds an SSH channel there while it lives; jobs need the rest. */
const MAX_SESSIONS = 3;
/** An idle browsing connection is kept this long, so paging through a table does not reconnect each time. */
const IDLE_MS = 30_000;
/** The longest one relay may live: a session is one request, and a request is never this long. */
const RELAY_MAX_MS = 15 * 60_000;
/** The most characters one row read carries, its long values together (DB_LIMITS.fullValueBytes each). */
const ROW_CHARS = 8 * 1024 * 1024;

const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json']);
const NUMBER_TYPES = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'year',
]);
const DATE_TYPES = new Set(['date', 'time', 'datetime', 'timestamp']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit']);

/** How the grid shows a column, from information_schema's DATA_TYPE. */
export function columnKind(dataType: string): DbValueKind {
  const t = dataType.toLowerCase();
  if (NUMBER_TYPES.has(t)) return 'number';
  if (DATE_TYPES.has(t)) return 'date';
  if (t === 'json') return 'json';
  if (TEXT_TYPES.has(t)) return 'text';
  if (BINARY_TYPES.has(t)) return 'binary';
  return 'other';
}

/** Characters as MariaDB counts them in utf8mb4: code points. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

/** A value as mysql2 hands it over (default type cast: text, numbers, Buffers, parsed JSON), as a cell. */
export function toCell(value: unknown, maxChars: number = DB_LIMITS.cellChars): DbCell {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { binary: value.length, hex: value.subarray(0, 32).toString('hex') };
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > maxChars ? { cut: text.slice(0, maxChars), length: text.length } : text;
}

// mysql2's column type numbers (the protocol's), for the kind of a result column.
const FIELD_NUMBER = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);
const FIELD_DATE = new Set([7, 10, 11, 12, 14, 17, 18, 19]);
const FIELD_STRINGS = new Set([15, 249, 250, 251, 252, 253, 254]);
const FIELD_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp',
  8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit',
  245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob',
  252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
};
const BINARY_CHARSET = 63;

function fieldKind(f: FieldPacket): DbValueKind {
  const type = f.columnType ?? -1;
  if (FIELD_NUMBER.has(type)) return 'number';
  if (FIELD_DATE.has(type)) return 'date';
  if (type === 245) return 'json';
  if (type === 16 || type === 255 || (FIELD_STRINGS.has(type) && f.characterSet === BINARY_CHARSET)) return 'binary';
  if (FIELD_STRINGS.has(type)) return 'text';
  return 'other';
}

function fieldType(f: FieldPacket): string {
  const name = FIELD_NAMES[f.columnType ?? -1] ?? 'value';
  if (f.characterSet !== BINARY_CHARSET) return name;
  return name === 'varchar' ? 'varbinary' : name === 'char' ? 'binary' : name.replace('text', 'blob');
}

interface Column extends DbColumnDto {
  /** CHARACTER_MAXIMUM_LENGTH: characters for text, bytes for binary; null for the rest. */
  maxLength: number | null;
}

interface TableMeta {
  table: string;
  type: 'table' | 'view';
  columns: Column[];
  indexes: DbIndexDto[];
  key: string[] | null;
  rows: number | null;
}

/** mysql2 errors carry MariaDB's code and message; a dropped connection is `fatal`. */
interface SqlError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
  fatal?: boolean;
}

const sqlErrorMessage = (err: SqlError) => err.sqlMessage ?? err.message;

export class DbBrowserService implements DbBrowserPort {
  private idle = new Map<string, { conn: mysql.Connection; timer: NodeJS.Timeout }>();
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly docker: DockerPort,
    private readonly serverName: () => string = () => 'the server',
    /** The MariaDB container the relay runs in; another name only for the engine test. */
    private readonly container: string = MARIADB_CONTAINER,
    /** How long a statement from the SQL editor may run; shorter only for the engine test. */
    private readonly sqlSeconds: number = DB_LIMITS.sqlSeconds,
  ) {}

  // ---------------------------------------------------------------- reading

  async tables(t: DbTarget): Promise<DbTableDto[]> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const rows = await select<[string, string, string | null, number | string | null, number | string | null, string | null, string]>(
        conn,
        `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COLLATION, TABLE_COMMENT
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
      );
      return rows.map(([name, type, engine, rowCount, bytes, collation, comment]) => {
        const view = type === 'VIEW';
        return {
          name,
          type: view ? ('view' as const) : ('table' as const),
          engine,
          rows: view || rowCount === null ? null : Number(rowCount),
          bytes: view || bytes === null ? null : Number(bytes),
          collation,
          comment: comment ?? '',
        };
      });
    });
  }

  async structure(t: DbTarget, table: string): Promise<DbTableStructureDto> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      return {
        table: meta.table,
        type: meta.type,
        columns: meta.columns.map(publicColumn),
        indexes: meta.indexes,
        key: meta.key,
        rows: meta.rows,
      };
    });
  }

  async rows(t: DbTarget, table: string, q: RowsQuery): Promise<DbRowsPageDto> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      const names = new Set(meta.columns.map((c) => c.name));
      const where = buildWhere(q.filters, names);
      if (q.sort !== undefined && !names.has(q.sort)) throw badRequest(`The table has no column "${q.sort}"`);
      // Ties in the sorted column are broken by the key, or without one by every other column:
      // otherwise MariaDB may order them differently from one page to the next, and paging shows
      // some rows twice and others never.
      const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
      const tieBreak = (meta.key ?? meta.columns.map((c) => c.name)).filter((c) => c !== q.sort);
      const order = q.sort
        ? `ORDER BY ${[q.sort, ...tieBreak].map((c) => `${quoteIdent(c)} ${dir}`).join(', ')}`
        : meta.key
          ? `ORDER BY ${meta.key.map(quoteIdent).join(', ')}`
          : '';
      const from = `FROM ${quoteIdent(meta.table)} ${where.sql} ${order}`.replace(/\s+/g, ' ').trim();
      const picked = pickColumns(meta.columns, DB_LIMITS.cellChars, 32);
      const data = await select<unknown[]>(conn, `SELECT ${picked.sql} ${from} LIMIT ? OFFSET ?`, [
        ...where.values,
        q.limit + 1,
        q.offset,
      ]);
      const page = data.slice(0, q.limit).map((row) => picked.cells(row));
      return {
        columns: meta.columns.map(publicColumn),
        key: meta.key,
        rows: page,
        offset: q.offset,
        limit: q.limit,
        hasMore: data.length > q.limit,
        estimate: q.filters.length === 0 ? meta.rows : null,
        sql: formatSql(`SELECT * ${from} LIMIT ${q.limit} OFFSET ${q.offset}`, where.values),
      };
    });
  }

  async row(t: DbTarget, table: string, key: DbRowKey): Promise<DbRowDto | null> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      const keyColumns = requireKey(meta);
      const cond = buildKeyCondition(key, keyColumns);
      // Each long value whole up to its limit, and the row within ROW_CHARS all told: a table of a
      // thousand LONGTEXT columns is not read whole into the panel.
      const long = meta.columns.filter(
        (c) => (c.kind === 'text' || c.kind === 'json') && (c.maxLength === null || c.maxLength > DB_LIMITS.cellChars),
      ).length;
      const fullChars = Math.max(DB_LIMITS.cellChars, Math.min(DB_LIMITS.fullValueBytes, Math.floor(ROW_CHARS / Math.max(1, long))));
      const picked = pickColumns(meta.columns, fullChars, 1024);
      const [found] = await select<unknown[]>(
        conn,
        `SELECT ${picked.sql} FROM ${quoteIdent(meta.table)} WHERE ${cond.sql} LIMIT 1`,
        cond.values,
      );
      if (!found) return null;
      return { columns: meta.columns.map(publicColumn), key: meta.key, values: picked.cells(found) };
    });
  }

  // ---------------------------------------------------------------- writing

  async insert(t: DbTarget, table: string, values: DbValues): Promise<DbWriteResultDto> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      const set = writable(meta, values);
      const sql =
        set.length === 0
          ? `INSERT INTO ${quoteIdent(meta.table)} () VALUES ()`
          : `INSERT INTO ${quoteIdent(meta.table)} (${set.map(([c]) => quoteIdent(c)).join(', ')}) VALUES (${set.map(() => '?').join(', ')})`;
      const res = await write(conn, sql, set.map(([, v]) => v));
      return { affected: res.affectedRows, insertId: res.insertId ? String(res.insertId) : null };
    });
  }

  async update(t: DbTarget, table: string, key: DbRowKey, values: DbValues): Promise<DbWriteResultDto> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      const keyColumns = requireKey(meta);
      const set = writable(meta, values);
      if (set.length === 0) throw badRequest('Nothing to change');
      const cond = buildKeyCondition(key, keyColumns);
      const res = await write(
        conn,
        `UPDATE ${quoteIdent(meta.table)} SET ${set.map(([c]) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${cond.sql} LIMIT 1`,
        [...set.map(([, v]) => v), ...cond.values],
      );
      // mysql2 asks for found rows: 0 means no row has that key any more, not "nothing changed".
      if (res.affectedRows === 0) throw notFound('That row is no longer there: it was changed or deleted since it was read');
      return { affected: res.affectedRows, insertId: null };
    });
  }

  async remove(t: DbTarget, table: string, keys: DbRowKey[]): Promise<DbWriteResultDto> {
    return this.withSession(t, DB_LIMITS.browseSeconds, true, async (conn) => {
      const meta = await tableMeta(conn, table);
      const keyColumns = requireKey(meta);
      const conditions = keys.map((k) => buildKeyCondition(k, keyColumns));
      await write(conn, 'START TRANSACTION', []);
      try {
        let affected = 0;
        for (const cond of conditions) {
          affected += (await write(conn, `DELETE FROM ${quoteIdent(meta.table)} WHERE ${cond.sql} LIMIT 1`, cond.values))
            .affectedRows;
        }
        await write(conn, 'COMMIT', []);
        return { affected, insertId: null };
      } catch (err) {
        await write(conn, 'ROLLBACK', []).catch(() => undefined);
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------- SQL

  async run(t: DbTarget, sql: string): Promise<DbQueryDto> {
    const statements = splitStatements(sql);
    if (statements.length === 0) throw badRequest('There is no SQL to run, only comments');
    const started = Date.now();
    // Never put back: what the SQL changed about its session (variables, USE, temporary tables)
    // must not follow the next request onto the connection.
    return this.withSession(t, this.sqlSeconds, false, async (conn) => {
      const results: DbQueryResultDto[] = [];
      for (const statement of statements) {
        // Again before each one: the SQL may have changed it for its session.
        await write(conn, `SET SESSION max_statement_time = ${this.sqlSeconds}`, []);
        const outcome = await runStatement(conn, statement, {
          // `SET STATEMENT max_statement_time = 0 FOR …` gets past the session's limit: a statement
          // still running a little after it is killed on the server, and its connection closed.
          seconds: this.sqlSeconds,
          killAfterMs: (this.sqlSeconds + 5) * 1000,
          kill: () => this.killQuery(t, conn.threadId),
        });
        results.push(...outcome.results);
        if (outcome.stop) break;
      }
      return { results, ms: Date.now() - started };
    }, { mapErrors: false });
  }

  /** `KILL QUERY` for one of the user's own connections, over a connection of its own: a user may kill its own. */
  private async killQuery(t: DbTarget, threadId: number | null): Promise<void> {
    if (!threadId) return;
    const conn = await this.open(t).catch(() => null);
    if (!conn) return;
    try {
      await write(conn, `KILL QUERY ${Number(threadId)}`, []);
    } catch {
      // Ended by itself in the meantime, or not ours to end: either way nothing is left to do.
    } finally {
      endQuietly(conn);
    }
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Run `work` on a connection as `t`, holding one of the server's session slots. A browsing call
   * reuses a connection left idle by the last one with the same login and database (`reuse`).
   * `max_statement_time` bounds every statement: a request the browser gave up on stops on the
   * server by itself within that.
   */
  private async withSession<T>(
    t: DbTarget,
    seconds: number,
    reuse: boolean,
    work: (conn: mysql.Connection) => Promise<T>,
    opts: { mapErrors?: boolean } = {},
  ): Promise<T> {
    const release = await this.slot();
    const key = createHash('sha256').update(`${t.user}\u0000${t.password}\u0000${t.database}`).digest('hex');
    const limit = `SET SESSION max_statement_time = ${seconds}`;
    let conn: mysql.Connection | null = reuse ? this.takeIdle(key) : null;
    try {
      if (conn) {
        // The first statement doubles as the check that the idle connection still works.
        await write(conn, limit, []).catch(() => {
          conn?.destroy();
          conn = null;
        });
      }
      if (!conn) {
        conn = await this.open(t);
        await write(conn, limit, []);
      }
      const result = await work(conn);
      if (reuse) this.putIdle(key, conn);
      else endQuietly(conn);
      return result;
    } catch (err) {
      (conn as mysql.Connection | null)?.destroy();
      throw opts.mapErrors === false ? err : this.mapError(err, seconds);
    } finally {
      release();
    }
  }

  private async open(t: DbTarget): Promise<mysql.Connection> {
    let relay: { stream: Duplex; stderr: () => string };
    try {
      // As MariaDB's own unprivileged user: the relay needs nothing but a socket.
      relay = await this.docker.execDuplex(this.container, RELAY_CMD, { timeoutMs: RELAY_MAX_MS, user: 'mysql' });
    } catch (err) {
      throw badGateway(`Could not reach MariaDB on ${this.serverName()}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const conn = mysql.createConnection({
      stream: relay.stream as never,
      user: t.user,
      password: t.password,
      database: t.database,
      multipleStatements: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      charset: 'UTF8MB4_UNICODE_CI',
      connectTimeout: 20_000,
    });
    // A connection that dies while idle says so here; one that dies mid-query fails that query.
    conn.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => {
        if (!err) return resolve();
        conn.destroy();
        const e = err as SqlError;
        if (e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR') {
          return reject(badGateway(`MariaDB on ${this.serverName()} refused the site's database login: ${sqlErrorMessage(e)}`));
        }
        const relayError = relay.stderr().trim();
        reject(
          badGateway(
            `Could not connect to MariaDB on ${this.serverName()}: ${relayError || sqlErrorMessage(e)}`,
          ),
        );
      });
    });
    return conn;
  }

  private takeIdle(key: string): mysql.Connection | null {
    const entry = this.idle.get(key);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.idle.delete(key);
    return entry.conn;
  }

  private putIdle(key: string, conn: mysql.Connection): void {
    const previous = this.idle.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      endQuietly(previous.conn);
    }
    const timer = setTimeout(() => {
      if (this.idle.get(key)?.conn === conn) this.idle.delete(key);
      endQuietly(conn);
    }, IDLE_MS);
    timer.unref();
    this.idle.set(key, { conn, timer });
  }

  /** Close every idle connection: after a site's password changed, or when the panel stops. */
  closeIdle(): void {
    for (const [key, entry] of this.idle) {
      clearTimeout(entry.timer);
      endQuietly(entry.conn);
      this.idle.delete(key);
    }
  }

  private slot(): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
    if (this.active < MAX_SESSIONS) {
      this.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve(release);
      });
    });
  }

  /** What a failed browsing call answers: MariaDB's own words, with the status that fits them. */
  private mapError(err: unknown, seconds: number): Error {
    if (err instanceof AppError) return err;
    const e = err as SqlError;
    if (!e || typeof e !== 'object' || (!e.code && !e.sqlMessage)) return err instanceof Error ? err : new Error(String(err));
    const message = sqlErrorMessage(e);
    if (e.errno === 1969 || e.code === 'ER_STATEMENT_TIMEOUT') {
      return timedOut(`The query ran longer than ${seconds} seconds and was stopped`);
    }
    if (e.fatal) return badGateway(`Lost the connection to MariaDB on ${this.serverName()}: ${message}`);
    if (e.code === 'ER_NO_SUCH_TABLE') return notFound(message);
    if (e.code === 'ER_DUP_ENTRY') return conflict(message);
    return new AppError('validation_error', 400, message, { code: e.code ?? null });
  }
}

// ------------------------------------------------------------------ queries

function select<Row extends unknown[]>(conn: mysql.Connection, sql: string, values: SqlValue[] = []): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values, rowsAsArray: true }, (err, rows) => (err ? reject(err) : resolve(rows as unknown as Row[])));
  });
}

function write(conn: mysql.Connection, sql: string, values: SqlValue[]): Promise<ResultSetHeader> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values }, (err, res) => (err ? reject(err) : resolve(res as ResultSetHeader)));
  });
}

/**
 * The table's columns, indexes, key and row estimate, in one round trip. Unknown to the site's user
 * (absent, or another database's) is a 404: information_schema shows a user nothing else.
 */
async function tableMeta(conn: mysql.Connection, table: string): Promise<TableMeta> {
  const sets = await new Promise<unknown[][][]>((resolve, reject) => {
    conn.query(
      {
        sql: `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?;
SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION;
SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
        values: [table, table, table],
        rowsAsArray: true,
      },
      (err, rows) => (err ? reject(err) : resolve(rows as unknown as unknown[][][])),
    );
  });
  const [tableRows = [], columnRows = [], indexRows = []] = sets;
  const found = tableRows[0] as [string, string, number | string | null] | undefined;
  if (!found) throw notFound(`There is no table "${table}" in this database`);
  const view = found[1] === 'VIEW';
  const columns: Column[] = (
    columnRows as [string, string, string, string, string | null, string, string, string, number | string | null, string | null][]
  ).map(
    ([name, type, dataType, nullable, dflt, key, extra, comment, maxLength, charset]) => ({
      name,
      type,
      kind: columnKind(dataType),
      nullable: nullable === 'YES',
      default: dflt,
      key: (['PRI', 'UNI', 'MUL'].includes(key) ? key : '') as Column['key'],
      extra: extra ?? '',
      comment: comment ?? '',
      charset: charset ?? null,
      maxLength: maxLength === null ? null : Number(maxLength),
    }),
  );
  const byName = new Map<string, DbIndexDto>();
  for (const [name, nonUnique, column, type] of indexRows as [string, number | string, string, string][]) {
    const index = byName.get(name) ?? { name, unique: Number(nonUnique) === 0, columns: [], type };
    index.columns.push(column);
    byName.set(name, index);
  }
  const indexes = [...byName.values()];
  const nullable = new Set(columns.filter((c) => c.nullable).map((c) => c.name));
  const keyIndex = view
    ? undefined
    : (indexes.find((i) => i.name === 'PRIMARY') ?? indexes.find((i) => i.unique && i.columns.every((c) => !nullable.has(c))));
  return {
    table: found[0],
    type: view ? 'view' : 'table',
    columns,
    indexes,
    key: keyIndex ? keyIndex.columns : null,
    rows: view || found[2] === null ? null : Number(found[2]),
  };
}

function publicColumn(c: Column): DbColumnDto {
  const { maxLength, ...rest } = c;
  void maxLength;
  return rest;
}

/** Hang up politely (COM_QUIT); a connection that is already gone has nothing to say. */
function endQuietly(conn: mysql.Connection): void {
  try {
    conn.end(() => undefined);
  } catch {
    conn.destroy();
  }
}

function requireKey(meta: TableMeta): string[] {
  if (meta.type === 'view') throw badRequest('A view is read only here: change its tables instead');
  if (!meta.key) throw badRequest('This table has no primary key, so its rows are read only here: use SQL to change them');
  return meta.key;
}

/** The values a write may set: only columns the table has, never one holding binary data, which text would garble. */
function writable(meta: TableMeta, values: DbValues): [string, string | null][] {
  if (meta.type === 'view') throw badRequest('A view is read only here: change its tables instead');
  const byName = new Map(meta.columns.map((c) => [c.name, c]));
  return Object.entries(values).map(([name, value]) => {
    const column = byName.get(name);
    if (!column) throw badRequest(`The table has no column "${name}"`);
    if (column.kind === 'binary') throw badRequest(`"${name}" holds binary data, which is changed with SQL rather than here`);
    if (value === null && !column.nullable) throw badRequest(`"${name}" cannot be NULL`);
    return [name, value];
  });
}

/**
 * The select list for a page of rows, and how to read a row of it back as cells. A long text column
 * comes cut at the server - `LEFT()` and its length beside it - so a page of fifty posts does not
 * carry fifty whole posts; a binary one comes as its first bytes and its length.
 */
function pickColumns(columns: Column[], maxChars: number, maxBytes: number) {
  const parts: string[] = [];
  const readers: ((row: unknown[], at: number) => { cell: DbCell; width: number })[] = [];
  for (const c of columns) {
    const col = quoteIdent(c.name);
    const longText = c.kind === 'text' || c.kind === 'json' ? c.maxLength === null || c.maxLength > maxChars : false;
    if (longText) {
      parts.push(`LEFT(${col}, ${maxChars})`, `CHAR_LENGTH(${col})`);
      readers.push((row, at) => {
        const text = row[at];
        const length = row[at + 1];
        if (text === null || text === undefined) return { cell: null, width: 2 };
        const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
        const n = Number(length);
        // CHAR_LENGTH counts characters; a JS string's length counts UTF-16 units, two for an emoji.
        return { cell: n > codePoints(s) ? { cut: s, length: n } : s, width: 2 };
      });
    } else if (c.kind === 'binary' && c.type.toLowerCase() !== 'bit' && !c.type.toLowerCase().startsWith('bit(')) {
      parts.push(`LEFT(${col}, ${maxBytes})`, `OCTET_LENGTH(${col})`);
      readers.push((row, at) => {
        const bytes = row[at];
        if (bytes === null || bytes === undefined) return { cell: null, width: 2 };
        const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'binary');
        return { cell: { binary: Number(row[at + 1]), hex: b.subarray(0, maxBytes).toString('hex') }, width: 2 };
      });
    } else {
      parts.push(col);
      readers.push((row, at) => ({ cell: toCell(row[at], maxChars), width: 1 }));
    }
  }
  return {
    sql: parts.join(', '),
    cells(row: unknown[]): DbCell[] {
      const out: DbCell[] = [];
      let at = 0;
      for (const read of readers) {
        const { cell, width } = read(row, at);
        out.push(cell);
        at += width;
      }
      return out;
    },
  };
}

/**
 * One statement from the editor, streamed: rows are kept up to DB_LIMITS.resultRows and the
 * statement is stopped there - hanging up is the one way to make MariaDB stop sending - so a
 * `SELECT *` from a big table costs a thousand rows, not the table. A statement may return more
 * than one result (a CALL); each is kept.
 */
const stoppedAfter = (seconds: number) => `Stopped after ${seconds} seconds (the longest a statement may run here)`;

function runStatement(
  conn: mysql.Connection,
  sql: string,
  watch: { seconds: number; killAfterMs: number; kill: () => Promise<void> },
): Promise<{ results: DbQueryResultDto[]; stop: boolean }> {
  return new Promise((resolve) => {
    const results: DbQueryResultDto[] = [];
    let current: Extract<DbQueryResultDto, { kind: 'rows' }> | null = null;
    let started = Date.now();
    let settled = false;
    const settle = (stop: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ results, stop });
    };
    const watchdog = setTimeout(() => {
      if (settled) return;
      results.push({ kind: 'error', message: stoppedAfter(watch.seconds), code: 'ER_STATEMENT_TIMEOUT' });
      settle(true);
      void watch.kill().finally(() => conn.destroy());
    }, watch.killAfterMs);
    watchdog.unref?.();
    const query = conn.query({ sql, rowsAsArray: true });
    query.on('fields', (fields?: FieldPacket[]) => {
      if (!fields) return; // a statement that returns no rows: its result follows
      current = {
        kind: 'rows',
        columns: fields.map((f) => ({ name: f.name, type: fieldType(f), kind: fieldKind(f) })),
        rows: [],
        truncated: false,
        ms: 0,
      };
      results.push(current);
    });
    query.on('result', (row: unknown) => {
      if (settled) return;
      if (current === null || !Array.isArray(row)) {
        const header = row as ResultSetHeader;
        results.push({
          kind: 'ok',
          affected: header.affectedRows ?? 0,
          insertId: header.insertId ? String(header.insertId) : null,
          info: header.info ?? '',
          warnings: header.warningStatus ?? 0,
          ms: Date.now() - started,
        });
        started = Date.now();
        return;
      }
      if (current.rows.length >= DB_LIMITS.resultRows) {
        current.truncated = true;
        current.ms = Date.now() - started;
        conn.destroy();
        settle(true);
        return;
      }
      current.rows.push(row.map((v) => toCell(v)));
    });
    query.on('error', (err: SqlError) => {
      // After a stop of our own (row limit, watchdog) the closed connection errors too: not news.
      if (settled) return;
      results.push({
        kind: 'error',
        message: err.errno === 1969 || err.code === 'ER_STATEMENT_TIMEOUT' ? stoppedAfter(watch.seconds) : sqlErrorMessage(err),
        code: err.code ?? null,
      });
      settle(true);
    });
    query.on('end', () => {
      if (current) current.ms = Date.now() - started;
      settle(false);
    });
  });
}
