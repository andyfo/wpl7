import type { DbRowFilter, DbRowKey } from '../shared/databases.js';
import { DB_LIMITS } from '../shared/databases.js';
import type {
  DbCell,
  DbColumnDto,
  DbQueryDto,
  DbRowDto,
  DbRowsPageDto,
  DbTableDto,
  DbTableStructureDto,
  DbWriteResultDto,
} from '../shared/types.js';
import { badRequest, conflict, notFound } from '../src/lib/errors.js';
import type { DbBrowserPort, DbTarget, DbValues, RowsQuery } from '../src/services/dbBrowser.js';

/** A table the fake holds: its columns, which of them find a row, and the rows as text. */
export interface FakeTable {
  columns: DbColumnDto[];
  key: string[] | null;
  rows: (string | null)[][];
  type?: 'table' | 'view';
}

/** A column for a FakeTable, with the defaults most columns have. */
export function fakeColumn(name: string, type: string, extra: Partial<DbColumnDto> = {}): DbColumnDto {
  const t = type.toLowerCase();
  const kind = /int|decimal|float|double/.test(t)
    ? 'number'
    : /date|time/.test(t)
      ? 'date'
      : /blob|binary/.test(t)
        ? 'binary'
        : 'text';
  return {
    name,
    type,
    kind,
    nullable: false,
    default: null,
    key: '',
    extra: '',
    comment: '',
    charset: kind === 'text' ? 'utf8mb4' : null,
    ...extra,
  };
}

/**
 * The database browser in memory, for the route tests and the demo world: tables, filters, paging
 * and writes behave as the real one's do for the cases the panel uses, and every call is recorded
 * with the login it was given. SQL is answered by `runAnswer`, which a test sets.
 */
export class FakeDbBrowser implements DbBrowserPort {
  calls: { method: string; target: DbTarget; args: unknown[] }[] = [];
  /** database -> table -> contents. */
  dbs = new Map<string, Map<string, FakeTable>>();
  runAnswer: (sql: string) => DbQueryDto = (sql) => ({
    results: [{ kind: 'ok', affected: 0, insertId: null, info: `ran: ${sql.slice(0, 40)}`, warnings: 0, ms: 1 }],
    ms: 1,
  });
  /** Fail the next call of this method with this error. */
  failOn = new Map<string, Error>();

  private record(method: string, target: DbTarget, args: unknown[]): void {
    this.calls.push({ method, target, args });
    const fail = this.failOn.get(method);
    if (fail) {
      this.failOn.delete(method);
      throw fail;
    }
  }

  table(database: string, name: string): FakeTable {
    const t = this.dbs.get(database)?.get(name);
    if (!t) throw notFound(`There is no table "${name}" in this database`);
    return t;
  }

  /** What an import that emptied the database, or loaded other tables, leaves behind. */
  dropTable(database: string, name: string): void {
    this.dbs.get(database)?.delete(name);
  }

  addTable(database: string, name: string, table: FakeTable): void {
    let db = this.dbs.get(database);
    if (!db) {
      db = new Map();
      this.dbs.set(database, db);
    }
    db.set(name, table);
  }

  async tables(t: DbTarget): Promise<DbTableDto[]> {
    this.record('tables', t, []);
    return [...(this.dbs.get(t.database) ?? new Map<string, FakeTable>()).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, table]) => ({
        name,
        type: table.type ?? 'table',
        engine: table.type === 'view' ? null : 'InnoDB',
        rows: table.type === 'view' ? null : table.rows.length,
        bytes: table.type === 'view' ? null : 16_384 + table.rows.reduce((n, r) => n + r.join('').length, 0),
        collation: 'utf8mb4_unicode_ci',
        comment: '',
      }));
  }

  async structure(t: DbTarget, name: string): Promise<DbTableStructureDto> {
    this.record('structure', t, [name]);
    const table = this.table(t.database, name);
    return {
      table: name,
      type: table.type ?? 'table',
      columns: table.columns,
      indexes: table.key ? [{ name: 'PRIMARY', unique: true, columns: table.key, type: 'BTREE' }] : [],
      key: table.key,
      rows: table.rows.length,
    };
  }

  async rows(t: DbTarget, name: string, q: RowsQuery): Promise<DbRowsPageDto> {
    this.record('rows', t, [name, q]);
    const table = this.table(t.database, name);
    const index = (col: string) => {
      const i = table.columns.findIndex((c) => c.name === col);
      if (i < 0) throw badRequest(`The table has no column "${col}"`);
      return i;
    };
    let rows = table.rows.filter((row) => q.filters.every((f) => matches(row[index(f.column)] ?? null, f, table.columns[index(f.column)]!)));
    if (q.sort) {
      const i = index(q.sort);
      const numeric = table.columns[i]!.kind === 'number';
      rows = [...rows].sort((a, b) => {
        const x = a[i] ?? '';
        const y = b[i] ?? '';
        const c = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        return q.dir === 'desc' ? -c : c;
      });
    }
    const page = rows.slice(q.offset, q.offset + q.limit);
    return {
      columns: table.columns,
      key: table.key,
      rows: page.map((r) => r.map((v) => cell(v, DB_LIMITS.cellChars))),
      offset: q.offset,
      limit: q.limit,
      hasMore: rows.length > q.offset + q.limit,
      estimate: q.filters.length === 0 ? table.rows.length : null,
      sql: `SELECT * FROM \`${name}\` LIMIT ${q.limit} OFFSET ${q.offset}`,
    };
  }

  async row(t: DbTarget, name: string, key: DbRowKey): Promise<DbRowDto | null> {
    this.record('row', t, [name, key]);
    const table = this.table(t.database, name);
    const found = this.find(table, key);
    if (!found) return null;
    return { columns: table.columns, key: table.key, values: found.map((v) => cell(v, DB_LIMITS.fullValueBytes)) };
  }

  async insert(t: DbTarget, name: string, values: DbValues): Promise<DbWriteResultDto> {
    this.record('insert', t, [name, values]);
    const table = this.table(t.database, name);
    if (table.type === 'view') throw badRequest('A view is read only here: change its tables instead');
    const row = table.columns.map((c) => (c.name in values ? values[c.name]! : c.default));
    let insertId: string | null = null;
    const auto = table.columns.findIndex((c) => c.extra.includes('auto_increment'));
    if (auto >= 0 && row[auto] === null) {
      insertId = String(Math.max(0, ...table.rows.map((r) => Number(r[auto]))) + 1);
      row[auto] = insertId;
    }
    if (table.key && this.find(table, Object.fromEntries(table.key.map((k) => [k, row[table.columns.findIndex((c) => c.name === k)] ?? null])))) {
      throw conflict('Duplicate entry for key PRIMARY');
    }
    table.rows.push(row);
    return { affected: 1, insertId };
  }

  async update(t: DbTarget, name: string, key: DbRowKey, values: DbValues): Promise<DbWriteResultDto> {
    this.record('update', t, [name, key, values]);
    const table = this.table(t.database, name);
    if (!table.key) throw badRequest('This table has no primary key, so its rows are read only here: use SQL to change them');
    const found = this.find(table, key);
    if (!found) throw notFound('That row is no longer there: it was changed or deleted since it was read');
    for (const [col, value] of Object.entries(values)) {
      const i = table.columns.findIndex((c) => c.name === col);
      if (i < 0) throw badRequest(`The table has no column "${col}"`);
      found[i] = value;
    }
    return { affected: 1, insertId: null };
  }

  async remove(t: DbTarget, name: string, keys: DbRowKey[]): Promise<DbWriteResultDto> {
    this.record('remove', t, [name, keys]);
    const table = this.table(t.database, name);
    let affected = 0;
    for (const key of keys) {
      const found = this.find(table, key);
      if (!found) continue;
      table.rows.splice(table.rows.indexOf(found), 1);
      affected++;
    }
    return { affected, insertId: null };
  }

  async run(t: DbTarget, sql: string): Promise<DbQueryDto> {
    this.record('run', t, [sql]);
    return this.runAnswer(sql);
  }

  closeIdle(): void {
    this.calls.push({ method: 'closeIdle', target: { database: '', user: '', password: '' }, args: [] });
  }

  private find(table: FakeTable, key: DbRowKey): (string | null)[] | undefined {
    if (!table.key) return undefined;
    const at = table.key.map((k) => table.columns.findIndex((c) => c.name === k));
    return table.rows.find((row) => table.key!.every((k, i) => row[at[i]!] === key[k]));
  }
}

function cell(value: string | null, max: number): DbCell {
  if (value === null) return null;
  return value.length > max ? { cut: value.slice(0, max), length: value.length } : value;
}

function matches(value: string | null, f: DbRowFilter, column: DbColumnDto): boolean {
  if (f.op === 'isNull') return value === null;
  if (f.op === 'notNull') return value !== null;
  if (value === null) return false;
  const v = f.value ?? '';
  const cmp = column.kind === 'number' ? Number(value) - Number(v) : value.localeCompare(v);
  switch (f.op) {
    case 'eq':
      return cmp === 0;
    case 'ne':
      return cmp !== 0;
    case 'lt':
      return cmp < 0;
    case 'gt':
      return cmp > 0;
    case 'le':
      return cmp <= 0;
    case 'ge':
      return cmp >= 0;
    case 'contains':
      return value.toLowerCase().includes(v.toLowerCase());
    case 'notContains':
      return !value.toLowerCase().includes(v.toLowerCase());
    case 'startsWith':
      return value.toLowerCase().startsWith(v.toLowerCase());
    case 'endsWith':
      return value.toLowerCase().endsWith(v.toLowerCase());
  }
}

/** A few WordPress tables with rows in them, under `prefix`: what a fresh site's database looks like. */
export function wordpressTables(siteUrl: string, prefix = 'wp_'): Record<string, FakeTable> {
  const id = (name: string) => fakeColumn(name, 'bigint(20) unsigned', { key: 'PRI', extra: 'auto_increment' });
  return {
    [`${prefix}options`]: {
      columns: [
        id('option_id'),
        fakeColumn('option_name', 'varchar(191)', { key: 'UNI' }),
        fakeColumn('option_value', 'longtext'),
        fakeColumn('autoload', 'varchar(20)', { default: "'yes'", key: 'MUL' }),
      ],
      key: ['option_id'],
      rows: [
        ['1', 'siteurl', siteUrl, 'yes'],
        ['2', 'home', siteUrl, 'yes'],
        ['3', 'blogname', 'Northwind Bakery', 'yes'],
        ['4', 'blogdescription', 'Bread, every morning', 'yes'],
        ['5', 'admin_email', 'owner@example.com', 'yes'],
        ['6', 'active_plugins', 'a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:27:"woocommerce/woocommerce.php";}', 'yes'],
        ['7', 'template', 'twentytwentyfive', 'yes'],
        ['8', 'stylesheet', 'twentytwentyfive', 'yes'],
        ['9', 'permalink_structure', '/%postname%/', 'yes'],
        ['10', 'timezone_string', 'Europe/Prague', 'yes'],
        ['11', 'wp_user_roles', 'a:1:{s:13:"administrator";a:2:{s:4:"name";s:13:"Administrator";s:12:"capabilities";a:1:{s:14:"manage_options";b:1;}}}', 'on'],
        ['12', '_transient_doing_cron', '1760870000.1234', 'off'],
      ],
    },
    [`${prefix}posts`]: {
      columns: [
        id('ID'),
        fakeColumn('post_author', 'bigint(20) unsigned', { default: "'0'" }),
        fakeColumn('post_date', 'datetime'),
        fakeColumn('post_title', 'text'),
        fakeColumn('post_status', 'varchar(20)', { default: "'publish'" }),
        fakeColumn('post_name', 'varchar(200)'),
        fakeColumn('post_type', 'varchar(20)', { default: "'post'" }),
      ],
      key: ['ID'],
      rows: [
        ['1', '1', '2026-09-28 08:12:00', 'Hello from the bakery', 'publish', 'hello-from-the-bakery', 'post'],
        ['2', '1', '2026-09-28 08:12:00', 'Sample Page', 'publish', 'sample-page', 'page'],
        ['3', '1', '2026-10-02 06:30:00', 'Sourdough, explained', 'publish', 'sourdough-explained', 'post'],
        ['4', '1', '2026-10-09 07:05:00', 'Opening hours', 'publish', 'opening-hours', 'page'],
        ['5', '1', '2026-10-15 05:45:00', 'Autumn menu', 'draft', 'autumn-menu', 'post'],
      ],
    },
    [`${prefix}postmeta`]: {
      columns: [
        id('meta_id'),
        fakeColumn('post_id', 'bigint(20) unsigned', { default: "'0'", key: 'MUL' }),
        fakeColumn('meta_key', 'varchar(255)', { nullable: true, key: 'MUL' }),
        fakeColumn('meta_value', 'longtext', { nullable: true }),
      ],
      key: ['meta_id'],
      rows: [
        ['1', '2', '_wp_page_template', 'default'],
        ['2', '3', '_edit_last', '1'],
        ['3', '4', '_wp_page_template', 'default'],
      ],
    },
    [`${prefix}users`]: {
      columns: [
        id('ID'),
        fakeColumn('user_login', 'varchar(60)'),
        fakeColumn('user_email', 'varchar(100)'),
        fakeColumn('user_registered', 'datetime'),
        fakeColumn('display_name', 'varchar(250)'),
      ],
      key: ['ID'],
      rows: [['1', 'admin', 'owner@example.com', '2026-09-28 08:11:00', 'admin']],
    },
    [`${prefix}comments`]: {
      columns: [
        id('comment_ID'),
        fakeColumn('comment_post_ID', 'bigint(20) unsigned', { key: 'MUL' }),
        fakeColumn('comment_author', 'tinytext'),
        fakeColumn('comment_content', 'text'),
        fakeColumn('comment_approved', 'varchar(20)', { default: "'1'" }),
      ],
      key: ['comment_ID'],
      rows: [['1', '1', 'A WordPress Commenter', 'Hi, this is a comment.', '1']],
    },
  };
}
