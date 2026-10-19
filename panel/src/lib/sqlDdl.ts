// @docs sites/database-structure
import {
  DB_COLUMN_TYPE_RE,
  type DbAlterChange,
  type DbColumnDef,
  type DbForeignKeyDef,
  type DbIndexDef,
} from '../../shared/databases.js';
import type { DbColumnDto, DbTableStructureDto } from '../../shared/types.js';
import { badRequest } from './errors.js';
import { quoteIdent } from './sqlText.js';

/**
 * The SQL a structure change runs (routes/databases.ts, the `database.alter` job). Built from a
 * form's fields, never pasted from them: names are quoted, a type must read as one
 * (DB_COLUMN_TYPE_RE), text goes in as a string literal, and every name a change refers to is
 * checked against the table as it is, so a mistake is a 400 that says what, not a failed job.
 */

/**
 * A string literal for DDL. Quotes doubled and backslashes doubled: right with MariaDB's default
 * SQL mode, and still one literal (if with doubled backslashes) under NO_BACKSLASH_ESCAPES.
 */
export function ddlString(value: string): string {
  if (value.includes('\u0000')) throw badRequest('Text cannot contain NUL');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const WHOLE_NUMBER_RE = /^(?:tinyint|smallint|mediumint|int|integer|bigint)\b/i;
const DATE_TIME_RE = /^(?:datetime|timestamp)(?:\((\d)\))?$/i;
/** The types a collation goes with. On any other, a kept collation would turn binary into text. */
const COLLATED_RE = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set|json)\b/i;

/** `CURRENT_TIMESTAMP` at the precision of the column it goes in: datetime(6) wants (6). */
function currentTimestamp(type: string): string {
  const m = DATE_TIME_RE.exec(type);
  if (!m) throw badRequest('Only a datetime or timestamp column can take the current time');
  return m[1] && m[1] !== '0' ? `CURRENT_TIMESTAMP(${m[1]})` : 'CURRENT_TIMESTAMP';
}

/** One column's definition, for ADD, CHANGE and CREATE TABLE. `current`: the column as it is, when it is changed. */
export function columnSql(def: DbColumnDef, current?: DbColumnDto): string {
  const type = def.type.trim();
  if (!DB_COLUMN_TYPE_RE.test(type) && !(current && type === current.type)) {
    throw badRequest(`"${type}" is not a column type this form takes; change it with SQL`);
  }
  if (def.autoIncrement && !WHOLE_NUMBER_RE.test(type)) throw badRequest(`${def.name}: only a whole-number column can count up by itself`);
  const parts = [quoteIdent(def.name), type];
  if (def.collation && COLLATED_RE.test(type)) parts.push(`COLLATE ${def.collation}`);
  parts.push(def.nullable ? 'NULL' : 'NOT NULL');
  const d = def.default;
  if (d.kind === 'null') {
    if (!def.nullable) throw badRequest(`${def.name} cannot default to NULL: it does not take NULL`);
    parts.push('DEFAULT NULL');
  } else if (d.kind === 'value') {
    parts.push(`DEFAULT ${ddlString(d.value)}`);
  } else if (d.kind === 'currentTimestamp') {
    parts.push(`DEFAULT ${currentTimestamp(type)}`);
  } else if (d.kind === 'keep') {
    if (!current) throw badRequest(`${def.name} is new: it has no default to keep`);
    // As MariaDB reports it - a literal in quotes, a number, NULL or an expression - it reads back
    // as SQL. Except where it shows ? for a character it cannot print (an emoji, a binary byte).
    const kept = current.default;
    if (kept?.includes('?')) {
      throw badRequest(`MariaDB shows the default of ${current.name} with ? for characters it cannot print, so it cannot be kept as it is: give it again`);
    }
    // NULL is no default for a column that no longer takes NULL.
    if (kept !== null && !(kept.toUpperCase() === 'NULL' && !def.nullable)) parts.push(`DEFAULT ${kept}`);
  }
  if (def.onUpdateCurrentTimestamp) parts.push(`ON UPDATE ${currentTimestamp(type)}`);
  if (def.autoIncrement) parts.push('AUTO_INCREMENT');
  if (def.comment) parts.push(`COMMENT ${ddlString(def.comment)}`);
  return parts.join(' ');
}

const indexColumns = (index: DbIndexDef) =>
  index.columns.map((c) => `${quoteIdent(c.name)}${c.length ? `(${c.length})` : ''}`).join(', ');

export function indexSql(index: DbIndexDef): string {
  if (index.kind === 'primary') return `PRIMARY KEY (${indexColumns(index)})`;
  const kind = index.kind === 'unique' ? 'UNIQUE INDEX' : index.kind === 'fulltext' ? 'FULLTEXT INDEX' : 'INDEX';
  return `${kind} ${index.name ? `${quoteIdent(index.name)} ` : ''}(${indexColumns(index)})`;
}

export function foreignKeySql(fk: DbForeignKeyDef): string {
  const cols = (names: string[]) => names.map(quoteIdent).join(', ');
  return (
    `${fk.name ? `CONSTRAINT ${quoteIdent(fk.name)} ` : ''}FOREIGN KEY (${cols(fk.columns)}) ` +
    `REFERENCES ${quoteIdent(fk.refTable)} (${cols(fk.refColumns)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
  );
}

const position = (p: 'first' | { after: string } | null) => (p === null ? '' : p === 'first' ? ' FIRST' : ` AFTER ${quoteIdent(p.after)}`);

/** Why a column's change here would lose something of it; null when nothing. */
function lockedColumn(c: DbColumnDto): string | null {
  if (/\bGENERATED\b/i.test(c.extra)) return 'is a generated column';
  if (/\bINVISIBLE\b/i.test(c.extra)) return 'is invisible';
  if (c.check) return 'has a CHECK constraint of its own';
  return null;
}

/**
 * One ALTER TABLE for a request's changes, checked the way MariaDB reads one: CHANGE and DROP
 * name columns of the table as it is, each once; a column's place (`AFTER`) names a column there
 * at that point and still there at the end; an index's or foreign key's columns are named as the
 * whole statement leaves them, renamed columns by their new names.
 */
export function alterTableSql(s: DbTableStructureDto, changes: readonly DbAlterChange[]): string {
  if (s.type === 'view') throw badRequest("A view's structure is its query: change it with SQL");
  const original = new Map(s.columns.map((c) => [c.name, c]));
  /** The columns' names as the changes so far leave them. */
  const columns = new Set(original.keys());
  /** Columns of the table a change already changed or dropped. */
  const touched = new Set<string>();
  const indexes = new Set(s.indexes.map((i) => i.name));
  const foreignKeys = new Set(s.foreignKeys.map((f) => f.name));
  const ofTable = (name: string): DbColumnDto => {
    const column = original.get(name);
    if (!column) {
      throw badRequest(columns.has(name) ? `"${name}" is a name this same request gives: name columns as the table has them` : `The table has no column "${name}"`);
    }
    if (touched.has(name)) throw badRequest(`"${name}" is changed or dropped twice in one request`);
    touched.add(name);
    return column;
  };
  const free = (name: string) => {
    if (columns.has(name)) throw badRequest(`The table has a column "${name}" already`);
  };
  /** Columns a place names: there at the end too, checked once every change is in. */
  const afters: string[] = [];
  const after = (p: 'first' | { after: string } | null, self: string) => {
    if (p && p !== 'first') {
      if (p.after === self) throw badRequest(`A column cannot go after itself`);
      if (!columns.has(p.after)) throw badRequest(`The table has no column "${p.after}"`);
      afters.push(p.after);
    }
  };
  const clauses: string[] = [];
  /** Columns an added index or foreign key names: checked once every column change is in. */
  const keyed: string[] = [];
  for (const change of changes) {
    switch (change.op) {
      case 'addColumn': {
        free(change.column.name);
        after(change.position, change.column.name);
        clauses.push(`ADD COLUMN ${columnSql(change.column)}${position(change.position)}`);
        columns.add(change.column.name);
        break;
      }
      case 'modifyColumn': {
        const current = ofTable(change.name);
        const locked = lockedColumn(current);
        if (locked) throw badRequest(`${change.name} ${locked}, which a change here would lose: change it with SQL`);
        columns.delete(change.name);
        free(change.column.name);
        after(change.position, change.name);
        clauses.push(`CHANGE COLUMN ${quoteIdent(change.name)} ${columnSql(change.column, current)}${position(change.position)}`);
        columns.add(change.column.name);
        break;
      }
      case 'dropColumn': {
        ofTable(change.name);
        if (columns.size === 1) throw badRequest('A table keeps at least one column: drop the table instead');
        clauses.push(`DROP COLUMN ${quoteIdent(change.name)}`);
        columns.delete(change.name);
        break;
      }
      case 'addIndex': {
        keyed.push(...change.index.columns.map((c) => c.name));
        const name = change.index.kind === 'primary' ? 'PRIMARY' : change.index.name;
        if (name && indexes.has(name)) {
          throw badRequest(name === 'PRIMARY' ? 'The table has a primary key already: replace it' : `The table has an index "${name}" already`);
        }
        if (change.index.kind === 'primary' && change.index.name) throw badRequest('A primary key has no name of its own');
        clauses.push(`ADD ${indexSql(change.index)}`);
        if (name) indexes.add(name);
        break;
      }
      case 'dropIndex': {
        if (!indexes.has(change.name)) throw badRequest(`The table has no index "${change.name}"`);
        clauses.push(change.name === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${quoteIdent(change.name)}`);
        indexes.delete(change.name);
        break;
      }
      case 'addForeignKey': {
        keyed.push(...change.foreignKey.columns);
        if (change.foreignKey.name && foreignKeys.has(change.foreignKey.name)) {
          throw badRequest(`The table has a foreign key "${change.foreignKey.name}" already`);
        }
        clauses.push(`ADD ${foreignKeySql(change.foreignKey)}`);
        if (change.foreignKey.name) foreignKeys.add(change.foreignKey.name);
        break;
      }
      case 'dropForeignKey': {
        if (!foreignKeys.has(change.name)) throw badRequest(`The table has no foreign key "${change.name}"`);
        clauses.push(`DROP FOREIGN KEY ${quoteIdent(change.name)}`);
        foreignKeys.delete(change.name);
        break;
      }
      case 'rename': {
        if (change.name === s.table) throw badRequest('That is the name it has');
        clauses.push(`RENAME TO ${quoteIdent(change.name)}`);
        break;
      }
    }
  }
  for (const name of afters) {
    if (!columns.has(name)) throw badRequest(`A column goes after "${name}", which this same request renames or drops`);
  }
  for (const name of keyed) {
    if (!columns.has(name)) throw badRequest(`The table has no column "${name}"`);
  }
  return `ALTER TABLE ${quoteIdent(s.table)} ${clauses.join(', ')}`;
}

/** A new table: its columns, its primary key, InnoDB, and the database's character set. `temporary`: to try it first. */
export function createTableSql(
  body: { name: string; columns: readonly DbColumnDef[]; primaryKey: readonly string[] },
  opts: { temporary?: boolean } = {},
): string {
  const names = new Set<string>();
  for (const c of body.columns) {
    if (names.has(c.name)) throw badRequest(`Two columns are called "${c.name}"`);
    names.add(c.name);
    if (c.default.kind === 'keep') throw badRequest(`${c.name} is new: it has no default to keep`);
  }
  for (const k of body.primaryKey) {
    if (!names.has(k)) throw badRequest(`The primary key names "${k}", which is not one of the columns`);
  }
  const counting = body.columns.filter((c) => c.autoIncrement);
  if (counting.length > 1) throw badRequest('Only one column can count up by itself');
  if (counting[0] && body.primaryKey[0] !== counting[0].name) {
    throw badRequest(`${counting[0].name} counts up by itself, so it must come first in the primary key`);
  }
  const lines = body.columns.map((c) => `  ${columnSql(c)}`);
  if (body.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${body.primaryKey.map(quoteIdent).join(', ')})`);
  return `CREATE ${opts.temporary ? 'TEMPORARY ' : ''}TABLE ${quoteIdent(body.name)} (\n${lines.join(',\n')}\n) ENGINE=InnoDB`;
}

export function dropTableSql(s: Pick<DbTableStructureDto, 'table' | 'type'>): string {
  return `DROP ${s.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdent(s.table)}`;
}

export function truncateTableSql(s: Pick<DbTableStructureDto, 'table' | 'type'>): string {
  if (s.type === 'view') throw badRequest('A view holds no rows of its own');
  return `TRUNCATE TABLE ${quoteIdent(s.table)}`;
}

const INDEX_WORDS: Record<DbIndexDef['kind'], string> = { primary: 'primary key', unique: 'unique index', index: 'index', fulltext: 'full-text index' };

/** What the job list calls a structure change: one change in words, or how many. */
export function describeChanges(table: string, changes: readonly DbAlterChange[]): string {
  if (changes.length !== 1) return `${changes.length} changes to ${table}`;
  const c = changes[0]!;
  switch (c.op) {
    case 'addColumn':
      return `Add column ${c.column.name} to ${table}`;
    case 'modifyColumn':
      return c.column.name === c.name ? `Change column ${c.name} in ${table}` : `Rename column ${c.name} to ${c.column.name} in ${table}`;
    case 'dropColumn':
      return `Drop column ${c.name} from ${table}`;
    case 'addIndex':
      return `Add a ${INDEX_WORDS[c.index.kind]} to ${table}`;
    case 'dropIndex':
      return c.name === 'PRIMARY' ? `Drop the primary key of ${table}` : `Drop index ${c.name} from ${table}`;
    case 'addForeignKey':
      return `Add a foreign key to ${table}`;
    case 'dropForeignKey':
      return `Drop foreign key ${c.name} from ${table}`;
    case 'rename':
      return `Rename ${table} to ${c.name}`;
  }
}
