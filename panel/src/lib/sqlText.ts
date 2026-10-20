// @docs sites/database
import mysql from 'mysql2';
import type { DbFilterOp, DbRowFilter, DbRowKey } from '../../shared/databases.js';
import { DB_ANY_COLUMN, DB_ANY_COLUMN_OPS, DB_FILTER_LIST, DB_FILTER_UNARY, DB_LIMITS } from '../../shared/databases.js';
import { badRequest } from './errors.js';

/**
 * SQL text the database browser builds (services/dbBrowser.ts). Names go in quoted, values as
 * `?` placeholders that mysql2 escapes; nothing a request carries is ever pasted in as it is.
 */

/** A table or column name, quoted with backticks, a backtick in it doubled. */
export function quoteIdent(name: string): string {
  if (name.includes('\u0000')) throw badRequest('A name cannot contain NUL');
  return `\`${name.replace(/`/g, '``')}\``;
}

/** Text a LIKE pattern takes literally: `%`, `_` and the escape character itself. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** What a `?` placeholder takes here: text (numbers come as text too) or NULL. */
export type SqlValue = string | number | null;

/** A statement with its values filled in, to show (never to run): what the page read, for the SQL editor. */
export function formatSql(sql: string, values: SqlValue[]): string {
  return mysql.format(sql, values);
}

export interface SqlPart {
  sql: string;
  values: SqlValue[];
}

const COMPARE: Partial<Record<DbFilterOp, string>> = { eq: '=', ne: '<>', lt: '<', gt: '>', le: '<=', ge: '>=' };

/** The values of an `in` filter: apart by commas, each trimmed, empty ones left out. */
export function listValues(value: string): string[] {
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (values.length === 0) throw badRequest('A list needs at least one value');
  if (values.length > DB_LIMITS.listValues) throw badRequest(`A list takes at most ${DB_LIMITS.listValues} values`);
  return values;
}

/** The negative comparisons, and the positive one each is the opposite of. */
const POSITIVE_OF: Partial<Record<DbFilterOp, DbFilterOp>> = { ne: 'eq', notContains: 'contains', notIn: 'in' };

/** One filter on one column, as SQL. */
function condition(col: string, f: DbRowFilter): SqlPart {
  if (DB_FILTER_UNARY.includes(f.op)) return { sql: `${col} IS ${f.op === 'isNull' ? '' : 'NOT '}NULL`, values: [] };
  const value = f.value ?? '';
  const compare = COMPARE[f.op];
  if (compare) return { sql: `${col} ${compare} ?`, values: [value] };
  if (DB_FILTER_LIST.includes(f.op)) {
    const values = listValues(value);
    return { sql: `${col} ${f.op === 'notIn' ? 'NOT IN' : 'IN'} (${values.map(() => '?').join(', ')})`, values };
  }
  const pattern =
    f.op === 'startsWith' ? `${escapeLike(value)}%` : f.op === 'endsWith' ? `%${escapeLike(value)}` : `%${escapeLike(value)}%`;
  return { sql: `${col} ${f.op === 'notContains' ? 'NOT LIKE' : 'LIKE'} ?`, values: [pattern] };
}

/**
 * The WHERE clause of a filtered view. Every column must be one of the table's own: a name the
 * table does not have is a 400, not a query error, so a stale link says what is wrong. A filter on
 * DB_ANY_COLUMN looks in each of `anyColumns`: one match keeps the row, or for a negative
 * comparison, no match. `match: 'any'` keeps a row that one filter keeps.
 */
export function buildWhere(
  filters: readonly DbRowFilter[],
  columns: ReadonlySet<string>,
  opts: { match?: 'all' | 'any'; anyColumns?: readonly string[] } = {},
): SqlPart {
  const parts: string[] = [];
  const values: SqlValue[] = [];
  for (const f of filters) {
    if (f.column === DB_ANY_COLUMN && !columns.has(DB_ANY_COLUMN)) {
      if (!DB_ANY_COLUMN_OPS.includes(f.op)) throw badRequest('Pick a column to compare with <, > or to look for NULL');
      // As text, every column: a number column compared with text would read it as a number,
      // and 'abc' as 0. A negative comparison is "no column matches", NULL counting as no match.
      const positive = POSITIVE_OF[f.op];
      const each = (opts.anyColumns ?? []).map((c) => condition(`CAST(${quoteIdent(c)} AS CHAR)`, positive ? { ...f, op: positive } : f));
      if (each.length === 0) throw badRequest('The table has no column to look in');
      parts.push(
        positive
          ? `NOT (${each.map((e) => `COALESCE(${e.sql}, 0)`).join(' OR ')})`
          : `(${each.map((e) => e.sql).join(' OR ')})`,
      );
      for (const e of each) values.push(...e.values);
      continue;
    }
    if (!columns.has(f.column)) throw badRequest(`The table has no column "${f.column}"`);
    const one = condition(quoteIdent(f.column), f);
    parts.push(one.sql);
    values.push(...one.values);
  }
  if (parts.length === 0) return { sql: '', values };
  const any = opts.match === 'any' && parts.length > 1;
  return { sql: `WHERE ${any ? parts.map((p) => `(${p})`).join(' OR ') : parts.join(' AND ')}`, values };
}

/**
 * The condition that finds one row by its key. `<=>` is MariaDB's NULL-safe equality, for a
 * unique key that allows NULL: `= NULL` would match nothing.
 */
export function buildKeyCondition(key: DbRowKey, keyColumns: readonly string[]): SqlPart {
  const given = Object.keys(key);
  if (given.length !== keyColumns.length || keyColumns.some((c) => !(c in key))) {
    throw badRequest(`A row is found by ${keyColumns.join(', ')}; send exactly those`);
  }
  return {
    sql: keyColumns.map((c) => `${quoteIdent(c)} <=> ?`).join(' AND '),
    values: keyColumns.map((c) => key[c] ?? null),
  };
}

/**
 * Statements in a block of SQL, split where a `;` ends one - not inside a quoted string, a
 * quoted name or a comment. `DELIMITER` lines, as dumps with triggers or routines carry them,
 * change what ends a statement, the way the mariadb client reads them. Comments stay with the
 * statement they are in (MariaDB's `/*! … *\/` are executable); a statement of nothing but
 * comments and space is dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let delimiter = ';';
  let current = '';
  /** Whether `current` holds anything but comments and space: kept as it grows, never rescanned. */
  let hasCode = false;
  let i = 0;
  const n = sql.length;
  const push = () => {
    if (hasCode) out.push(current.trim());
    current = '';
    hasCode = false;
  };
  while (i < n) {
    // A client command, not SQL: only where a line starts, and only before a statement's text.
    if (!hasCode && (i === 0 || sql[i - 1] === '\n')) {
      const eol = sql.indexOf('\n', i);
      const line = sql.slice(i, eol === -1 ? n : eol);
      const m = /^\s*delimiter\s+(\S+)\s*$/i.exec(line);
      if (m) {
        delimiter = m[1]!;
        current = '';
        i += line.length;
        continue;
      }
    }
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const end = closingQuote(sql, i, c);
      current += sql.slice(i, end);
      hasCode = true;
      i = end;
      continue;
    }
    if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!)))) {
      const eol = sql.indexOf('\n', i);
      const stop = eol === -1 ? n : eol;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      current += sql.slice(i, stop);
      // MariaDB runs what is inside `/*! … */`: that is code, not a comment.
      if (sql[i + 2] === '!' || sql.startsWith('/*M!', i)) hasCode = true;
      i = stop;
      continue;
    }
    if (sql.startsWith(delimiter, i)) {
      push();
      i += delimiter.length;
      continue;
    }
    current += c;
    if (!/\s/.test(c)) hasCode = true;
    i++;
  }
  push();
  return out;
}

/** Where a quoted run that starts at `start` ends: past its closing quote, a doubled quote or a backslash escape skipped. */
function closingQuote(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '\\' && quote !== '`') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}
