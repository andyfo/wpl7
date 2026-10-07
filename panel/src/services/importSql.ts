/**
 * The SQL an import pulls from an old site, checked line by line before any of it reaches
 * MariaDB (docs/internal/import-protocol.md, A.8 and A.9).
 *
 * The plugin writes a small, fixed grammar - one statement per line: `DROP TABLE IF EXISTS`,
 * `CREATE TABLE`, `INSERT … VALUES` with plain literals - and nothing else gets through: no second
 * statement after a `;`, no comment (MySQL runs `/*!…*\/` ones), no table but the one being
 * pulled, no `DEFINER`, no other storage engine's back door. The dump is imported as the site's
 * own database user besides (DbAdminPort.importFromAs), so even a line that slipped past could
 * reach nothing but that site's database.
 */

// @docs sites/import
/** What every import's dump starts with, written by the panel (A.8). */
export const DUMP_PREAMBLE = [
  'SET NAMES utf8mb4;',
  'SET FOREIGN_KEY_CHECKS=0;',
  'SET UNIQUE_CHECKS=0;',
  "SET sql_mode='NO_AUTO_VALUE_ON_ZERO';",
  "SET time_zone='+00:00';",
].join('\n');

/** The last line of a complete dump: a pull that stopped part-way never has it. */
export const DUMP_TRAILER = '-- wpl7-import: end';

export class ImportSqlError extends Error {
  constructor(
    readonly table: string,
    readonly line: number,
    reason: string,
  ) {
    super(`Refused SQL from the old site (table ${table}, line ${line}): ${reason}`);
    this.name = 'ImportSqlError';
  }
}

/** Table options and clauses a CREATE TABLE line may not carry, outside quotes. */
const FORBIDDEN_IN_CREATE: { re: RegExp; what: string }[] = [
  { re: /\bDEFINER\b/i, what: 'DEFINER' },
  { re: /\bDATA\s+DIRECTORY\b/i, what: 'DATA DIRECTORY' },
  { re: /\bINDEX\s+DIRECTORY\b/i, what: 'INDEX DIRECTORY' },
  { re: /\bCONNECTION\s*=/i, what: 'CONNECTION=' },
  { re: /\bTABLESPACE\b/i, what: 'TABLESPACE' },
  { re: /\bENCRYPTION\b/i, what: 'ENCRYPTION' },
  { re: /\bENGINE\s*=\s*(FEDERATED|CONNECT|SPIDER|CSV|MERGE|MRG_MYISAM|S3)\b/i, what: 'that storage engine' },
  { re: /\bUNION\s*=/i, what: 'UNION=' },
  { re: /\bSELECT\b/i, what: 'SELECT' },
];

const NAME = '[A-Za-z0-9_$]+';
const DROP_RE = new RegExp(`^DROP TABLE IF EXISTS \`(${NAME})\`;$`);
const CREATE_RE = new RegExp(`^CREATE TABLE \`(${NAME})\` \\(`);
const INSERT_RE = new RegExp(`^INSERT INTO \`(${NAME})\` \\(`);

/**
 * MySQL 8's default collations, which MariaDB versions before 11.4.5 do not know. Each becomes
 * the nearest one WordPress itself picks on MariaDB.
 */
export function rewriteCollations(line: string): { line: string; changed: boolean } {
  let changed = false;
  const out = mapUnquoted(line, (segment) =>
    segment.replace(/\butf8mb4_[a-z_]*0900_[a-z_]+\b/g, (name) => {
      changed = true;
      return name.endsWith('_bin') ? 'utf8mb4_bin' : 'utf8mb4_unicode_520_ci';
    }),
  );
  return { line: out, changed };
}

/** Apply `fn` to the parts of a line outside '…', "…" and `…`, keeping the quoted parts as they are. */
function mapUnquoted(line: string, fn: (segment: string) => string): string {
  let out = '';
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" || c === '"' || c === '`') {
      out += fn(line.slice(start, i));
      const close = quoteEnd(line, i);
      const end = close === -1 ? line.length : close;
      out += line.slice(i, end);
      i = start = end;
      continue;
    }
    i++;
  }
  return out + fn(line.slice(start));
}

/** The index just past the quoted run that starts at `i`; -1 when it never closes. */
function quoteEnd(line: string, i: number): number {
  const q = line[i]!;
  let j = i + 1;
  while (j < line.length) {
    const c = line[j]!;
    if (c === '\\' && q !== '`') {
      j += 2;
      continue;
    }
    if (c === q) {
      if (line[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/** The parts of a CREATE TABLE line outside quotes, or why there are none that can be trusted. */
function unquotedOf(line: string): { text: string; problem: string | null } {
  let text = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const end = quoteEnd(line, i);
      if (end === -1) return { text, problem: 'a quote that never closes' };
      text += ' ';
      i = end;
      continue;
    }
    if ((c === '/' && line[i + 1] === '*') || c === '#' || (c === '-' && line[i + 1] === '-')) {
      return { text, problem: 'a comment' };
    }
    text += c;
    i++;
  }
  return { text, problem: null };
}

function checkCreate(line: string, table: string, n: number): void {
  const { text, problem } = unquotedOf(line);
  if (problem) throw new ImportSqlError(table, n, `a CREATE TABLE line with ${problem}`);
  if (text.indexOf(';') !== text.length - 1) throw new ImportSqlError(table, n, 'a second statement after the CREATE TABLE');
  for (const { re, what } of FORBIDDEN_IN_CREATE) {
    if (re.test(text)) throw new ImportSqlError(table, n, `${what} in a CREATE TABLE`);
  }
}

/**
 * An INSERT's VALUES: `(literal, …), (…);` and nothing else. Literals are NULL, numbers, X'hex'
 * and '…' strings with backslash and doubled-quote escapes.
 */
function checkValues(line: string, start: number, table: string, n: number): void {
  let i = start;
  const fail = (what: string): never => {
    throw new ImportSqlError(table, n, `${what} at character ${i}`);
  };
  const skipSpace = () => {
    while (line[i] === ' ') i++;
  };
  for (;;) {
    skipSpace();
    if (line[i] !== '(') fail('expected "("');
    i++;
    for (;;) {
      skipSpace();
      const c = line[i];
      if (c === "'") {
        const end = quoteEnd(line, i);
        if (end === -1) fail('a string that never closes');
        i = end;
      } else if ((c === 'X' || c === 'x') && line[i + 1] === "'") {
        const m = /^[Xx]'([0-9A-Fa-f]*)'/.exec(line.slice(i, i + 3 + 2 * 1024 * 1024 * 16));
        if (!m || m[1]!.length % 2 !== 0) fail('a malformed hex literal');
        i += m![0].length;
      } else if (line.startsWith('NULL', i)) {
        i += 4;
      } else {
        const m = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(line.slice(i, i + 400));
        if (!m) fail('a value that is not a literal');
        i += m![0].length;
      }
      skipSpace();
      if (line[i] === ',') {
        i++;
        continue;
      }
      if (line[i] === ')') {
        i++;
        break;
      }
      fail('expected "," or ")"');
    }
    skipSpace();
    if (line[i] === ',') {
      i++;
      continue;
    }
    if (line[i] === ';' && i === line.length - 1) return;
    fail('expected "," or ";" ending the line');
  }
}

/** `(\`a\`,\`b\`) VALUES ` after the table name: the column list. Returns where the tuples start. */
function columnsEnd(line: string, at: number, table: string, n: number): number {
  let i = at;
  for (;;) {
    if (line[i] !== '`') throw new ImportSqlError(table, n, 'a column name that is not quoted');
    const end = quoteEnd(line, i);
    if (end === -1 || end === i + 2) throw new ImportSqlError(table, n, 'a column name that is empty or never closes');
    i = end;
    if (line[i] === ',') {
      i++;
      continue;
    }
    if (line[i] === ')') break;
    throw new ImportSqlError(table, n, 'a malformed column list');
  }
  const rest = ') VALUES ';
  if (line.slice(i, i + rest.length) !== rest) throw new ImportSqlError(table, n, 'expected ") VALUES"');
  return i + rest.length;
}

/**
 * Check one page of SQL the plugin sent for `table`, and give back its lines ready to append to
 * the dump (collations rewritten). `first`: the first page of a table, which must open with its
 * DROP and CREATE; later pages hold INSERT lines only.
 */
export function checkSqlPage(sql: string, table: string, opts: { first: boolean }): { lines: string[]; collations: boolean } {
  const lines = sql.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  let collations = false;
  lines.forEach((line, index) => {
    const n = index + 1;
    if (line.includes('\r')) throw new ImportSqlError(table, n, 'a carriage return outside a string');
    const named = (m: RegExpExecArray | null, kind: string): RegExpExecArray => {
      if (!m) throw new ImportSqlError(table, n, `a line that is no ${kind}`);
      if (m[1] !== table) throw new ImportSqlError(table, n, `a statement for another table (${m[1]})`);
      return m;
    };
    if (opts.first && n === 1) {
      named(DROP_RE.exec(line), 'DROP TABLE IF EXISTS');
      out.push(line);
      return;
    }
    if (opts.first && n === 2) {
      named(CREATE_RE.exec(line), 'CREATE TABLE');
      checkCreate(line, table, n);
      const rewritten = rewriteCollations(line);
      collations ||= rewritten.changed;
      out.push(rewritten.line);
      return;
    }
    const m = named(INSERT_RE.exec(line), 'INSERT INTO');
    checkValues(line, columnsEnd(line, m[0].length, table, n), table, n);
    out.push(line);
  });
  if (opts.first && out.length < 2) throw new ImportSqlError(table, 1, 'a first page without its DROP and CREATE');
  return { lines: out, collations };
}
