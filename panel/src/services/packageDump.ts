// @docs sites/duplicator
/**
 * A Duplicator package's database dump, made fit to load into the new site's own database as the
 * site's own user (DbAdminPort.importFromAs): what it says can reach that database and nothing
 * else, whoever wrote it, as on the Database tab. On the way:
 *
 * - `USE` and `CREATE DATABASE` are refused: the dump would load somewhere else.
 * - `DEFINER=user@host` is taken out of views, triggers and routines, which then belong to the
 *   site's user: it cannot create them for the old host's user.
 * - MySQL 8's collations become the nearest ones MariaDB before 11.4.5 knows (importSql.ts).
 * - `SET @@GLOBAL…` and the binary log switch mysqldump writes on a host with GTIDs are dropped:
 *   they need privileges the site's user does not have, and mean nothing here.
 * - `UNIQUE_CHECKS=0`, which mysqldump sets, becomes 1 in a SET statement of the dump's own: with
 *   it off, InnoDB may take a row that duplicates another into a unique index without a word, and
 *   the load must fail on one. A routine's body is left as it is.
 * - Rows go through untouched, as they arrive: an INSERT's lines are data, never held whole and
 *   never read for any of the above, only looked at for where the statement ends. Only its first
 *   words change: INSERT IGNORE and REPLACE become INSERT, so a row MariaDB counts as a duplicate
 *   of another (its collations tell apart less than MySQL 8's) fails the load rather than going
 *   unnoticed.
 *
 * Every other statement (a table, a view, a routine) is read whole, as SQL: what is in a quoted
 * string, a quoted name or a comment stays as it is, even where a routine's string runs over
 * several lines, as SHOW CREATE PROCEDURE gives it. Rows never start inside a string: Duplicator
 * and mysqldump escape the line breaks in values. The bytes are handled as latin1, which maps each
 * byte to one character and back, so binary columns stay as they were; the character sets the
 * panel loads keep the bytes of quotes, backslashes and line breaks out of other characters.
 */
import { endsDashes, isVersionComment, keyword, sqlTokens } from '../lib/sqlLexer.js';
import { replaceCollations } from './importSql.js';

export class PackageDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageDumpError';
  }
}

/**
 * The character sets a dump can be in besides UTF-8: the single-byte sets MariaDB has, and the
 * multi-byte ones whose characters are made of bytes from 0x80 up. Sets such as sjis, big5 or gbk
 * put backslash and quote bytes inside characters, which this filter would read as SQL.
 */
const OTHER_CHARSETS = new Set([
  'armscii8', 'ascii', 'cp1250', 'cp1251', 'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866', 'dec8', 'geostd8', 'greek',
  'hebrew', 'hp8', 'keybcs2', 'koi8r', 'koi8u', 'latin1', 'latin2', 'latin5', 'latin7', 'macce', 'macroman', 'swe7',
  'tis620', 'eucjpms', 'euckr', 'gb2312', 'ujis',
]);

/** The set a dump in WordPress's connection character set `name` is loaded in; null for one the panel cannot load. */
export function dumpCharset(name: string): string | null {
  const n = name.trim().toLowerCase();
  // WordPress raises utf8 to utf8mb4, and utf8mb3's bytes are utf8mb4's too.
  if (n === 'utf8' || n === 'utf8mb3' || n === 'utf8mb4') return 'utf8mb4';
  return OTHER_CHARSETS.has(n) ? n : null;
}

/** What every package's dump is loaded after: its character set (dumpCharset), as Duplicator's installer sets it. */
export function packageDumpPreamble(charset: string): string {
  if (dumpCharset(charset) !== charset) throw new PackageDumpError(`Not a character set the panel loads a dump in: ${charset}`);
  // No UNIQUE_CHECKS=0: InnoDB then takes duplicates into a unique index unnoticed (PackageDumpFilter).
  return [`SET NAMES ${charset};`, 'SET FOREIGN_KEY_CHECKS=0;', "SET sql_mode='NO_AUTO_VALUE_ON_ZERO';", ''].join('\n');
}

const NL = 0x0a;
const EMPTY = Buffer.alloc(0);
/** A version comment's opening, MySQL's `/*!50001 ` and MariaDB's `/*M!100616 `, or a plain comment before the statement. */
const LEADING_COMMENT_RE = /^(?:\/\*M?!\d*\s*|\/\*(?!M?!)[\s\S]*?\*\/\s*)/;
/** Statements that need more than the site's own database and are dropped. */
const DROPPED_RE = /^SET\s+@@(GLOBAL\.|SESSION\.SQL_LOG_BIN\b|SESSION\.GTID_NEXT\b)|^SET\s+@@GTID_PURGED\b/i;

/** The statement's first words, with the comments and version comment openings in front of them taken away. */
function statementHead(text: string): string {
  let head = text.trimStart();
  for (let i = 0; i < 5 && LEADING_COMMENT_RE.test(head); i++) head = head.replace(LEADING_COMMENT_RE, '');
  return head;
}

const isBlank = (byte: number) => byte === 0x0a || byte === 0x20 || byte === 0x0d || byte === 0x09;

/** Where SQL is at a point of a statement: in a quoted string or name, in a comment, or in code. */
interface SqlState {
  quote: "'" | '"' | '`' | null;
  comment: boolean;
}
const CODE: SqlState = { quote: null, comment: false };

/**
 * Read `text` as MySQL does, from `state`: `code` gets each run of it outside quoted strings,
 * quoted names and comments. Returns where SQL is at its end, for the text that follows.
 */
function readSql(text: string, state: SqlState, code?: (from: number, to: number) => void): SqlState {
  let { quote, comment } = state;
  let run = quote || comment ? -1 : 0;
  const close = (at: number) => {
    if (run >= 0 && at > run) code?.(run, at);
    run = -1;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\' && quote !== '`') i += 2;
      else if (c === quote && text[i + 1] === quote) i += 2;
      else if (c === quote) {
        quote = null;
        run = ++i;
      } else i++;
      continue;
    }
    if (comment) {
      if (c === '*' && text[i + 1] === '/') {
        comment = false;
        run = i += 2;
      } else i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      close(i);
      quote = c;
      i++;
    } else if (c === '#' || (c === '-' && text[i + 1] === '-' && endsDashes(text.charCodeAt(i + 2)))) {
      // To the end of the line, whose break is code again.
      close(i);
      const nl = text.indexOf('\n', i);
      run = i = nl === -1 ? text.length : nl;
    } else if (c === '/' && text[i + 1] === '*' && !isVersionComment(text, i)) {
      close(i);
      comment = true;
      i += 2;
    } else i++;
  }
  close(text.length);
  return { quote, comment };
}

/** `fn` applied to the code of `text`, a statement read from its start; its strings, names and comments stay as they are. */
function mapCode(text: string, fn: (code: string) => string): string {
  let out = '';
  let at = 0;
  readSql(text, CODE, (from, to) => {
    out += text.slice(at, from) + fn(text.slice(from, to));
    at = to;
  });
  return out + text.slice(at);
}

/** `DEFINER = user@host`, with each part quoted or bare, at the start of the string. */
const DEFINER_RE =
  /DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.$%-]+)\s*@\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.$%:\[\]-]+)\s*/iy;
const IDENT = /[A-Za-z0-9_$]/;

/** The statement without its `DEFINER=…@…` clauses, outside quoted strings, quoted names and comments. */
export function stripDefiners(text: string): { line: string; removed: number } {
  if (!/definer/i.test(text)) return { line: text, removed: 0 };
  let out = '';
  let from = 0;
  let removed = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      // A quoted run: skipped whole, its escapes and doubled quotes with it.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\' && c !== '`') j += 2;
        else if (text[j] === c && text[j + 1] === c) j += 2;
        else if (text[j] === c) break;
        else j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '#' || (c === '-' && text[i + 1] === '-' && endsDashes(text.charCodeAt(i + 2)))) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*' && !isVersionComment(text, i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if ((c === 'D' || c === 'd') && (i === 0 || !IDENT.test(text[i - 1]!))) {
      DEFINER_RE.lastIndex = i;
      const m = DEFINER_RE.exec(text);
      if (m) {
        out += text.slice(from, i);
        i += m[0].length;
        from = i;
        removed++;
        continue;
      }
    }
    i++;
  }
  return { line: out + text.slice(from), removed };
}

/** What a statement creates: a table or view with its columns, or a routine. */
export interface CreatedNames {
  kind: 'table' | 'view' | 'routine';
  name: string;
  columns: string[];
}

/** Words that start what is not a column in CREATE TABLE's list: keys, constraints, periods. */
const NOT_A_COLUMN = new Set(['PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'CONSTRAINT', 'CHECK', 'FOREIGN', 'PERIOD']);

/**
 * What a statement creates: `CREATE [OR REPLACE] [ALGORITHM=…] TABLE|VIEW [IF NOT EXISTS] name`,
 * `CREATE [DEFINER=…] PROCEDURE|FUNCTION name`; null for anything else. A table's columns are the
 * first word of each part of its list, a view's the names its select gives with AS.
 */
export function createdNames(statement: string): CreatedNames | null {
  if (!/\bCREATE\b/i.test(statement)) return null;
  const t = sqlTokens(statement);
  const start = t.findIndex((x) => keyword(x) === 'CREATE');
  if (start === -1) return null;
  const isP = (j: number, v: string) => t[j]?.k === 'p' && (t[j] as { v: string }).v === v;
  for (let j = start + 1; j < t.length; j++) {
    const word = keyword(t[j]);
    const kind = word === 'TABLE' ? 'table' : word === 'VIEW' ? 'view' : word === 'PROCEDURE' || word === 'FUNCTION' ? 'routine' : null;
    if (kind === null) {
      // A trigger's or an event's body may create tables of its own: not this statement's.
      if (word === 'TRIGGER' || word === 'EVENT' || isP(j, '(')) return null;
      continue;
    }
    let n = j + 1;
    if (keyword(t[n]) === 'IF' && keyword(t[n + 1]) === 'NOT' && keyword(t[n + 2]) === 'EXISTS') n += 3;
    if (t[n]?.k !== 'name') return null;
    // `db`.`t`: the table's own name.
    if (isP(n + 1, '.') && t[n + 2]?.k === 'name') n += 2;
    const name = (t[n] as { v: string }).v;
    const columns: string[] = [];
    if (kind === 'table' && isP(n + 1, '(')) {
      // The first word of each part at the list's own depth.
      let depth = 0;
      let first = true;
      for (let k = n + 1; k < t.length; k++) {
        const tok = t[k]!;
        if (tok.k === 'p' && tok.v === '(') {
          depth++;
          if (depth === 1) first = true;
          continue;
        }
        if (tok.k === 'p' && tok.v === ')') {
          if (--depth === 0) break;
          continue;
        }
        if (depth !== 1) continue;
        if (tok.k === 'p' && tok.v === ',') {
          first = true;
          continue;
        }
        if (first && tok.k === 'name' && (tok.q || !NOT_A_COLUMN.has(tok.v.toUpperCase()))) columns.push(tok.v);
        first = false;
      }
    } else if (kind === 'view') {
      // Past the view's own AS: the names its select gives.
      const select = keyword(t[n + 1]) === 'AS' ? n + 2 : n + 1;
      for (let k = select; k + 1 < t.length; k++) if (keyword(t[k]) === 'AS' && t[k + 1]!.k === 'name') columns.push((t[k + 1] as { v: string }).v);
    }
    return { kind, name, columns };
  }
  return null;
}

/** MariaDB's character sets and the decoders their bytes are read with; others are read as latin1. */
const DECODERS: Record<string, string> = {
  utf8mb4: 'utf-8',
  cp1250: 'windows-1250',
  cp1251: 'windows-1251',
  cp1256: 'windows-1256',
  cp1257: 'windows-1257',
  latin2: 'iso-8859-2',
  latin5: 'iso-8859-9',
  latin7: 'iso-8859-13',
  greek: 'iso-8859-7',
  hebrew: 'iso-8859-8',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  macroman: 'macintosh',
  tis620: 'windows-874',
  ujis: 'euc-jp',
  eucjpms: 'euc-jp',
  euckr: 'euc-kr',
  gb2312: 'gbk',
};

/** `text`, a statement read as latin1 (one character a byte), as the characters it is in `charset`. */
function decodedIn(charset: string, text: string): string {
  const label = DECODERS[charset];
  if (!label || !/[\u0080-\u00ff]/.test(text)) return text;
  try {
    return new TextDecoder(label).decode(Buffer.from(text, 'latin1'));
  } catch {
    return text;
  }
}

/** `UNIQUE_CHECKS=0` and `@@SESSION.unique_checks = 0`, as mysqldump's header sets it. */
const UNIQUE_CHECKS_OFF_RE = /\b((?:@@(?:SESSION\.)?)?UNIQUE_CHECKS)\s*=\s*0\b/gi;

/** INSERT IGNORE and REPLACE, with what may come between: their first words, to become INSERT. */
const LENIENT_INSERT_RE = /^(\s*)(?:INSERT(?:\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY))?\s+IGNORE|REPLACE(?:\s+(?:LOW_PRIORITY|DELAYED))?)(?=\s)/i;

/** A row statement's first line with INSERT in place of INSERT IGNORE or REPLACE. */
function plainInsert(raw: Buffer): Buffer {
  const m = LENIENT_INSERT_RE.exec(raw.subarray(0, 200).toString('latin1'));
  // latin1: one character a byte, so the match's length is its bytes'.
  return m ? Buffer.concat([Buffer.from(`${m[1]}INSERT`, 'latin1'), raw.subarray(m[0].length)]) : raw;
}

/** The longest statement the database server could take: its max_allowed_packet ceiling. */
export const MAX_DUMP_LINE = 1024 ** 3;
/** The longest statement that is not a row: a table's definition, a view, a routine. */
const MAX_STATEMENT = 64 * 1024 * 1024;
/** How much of a line's start says what statement it begins. */
const HEAD_BYTES = 4096;
/** How much of a row's line is kept, to find its end. */
const TAIL_BYTES = 4096;

/**
 * The filter for one package's dumps, fed piece by piece in load order: `push` gives back what it
 * has to pass on, changed where it had to be, and `endFile` the rest of each file's.
 */
export class PackageDumpFilter {
  /** The longest statement, in bytes: the database server has to take each one whole. */
  longest = 0;
  /** A CREATE TABLE for `<prefix>options` went by: WordPress will find its installation. */
  hasOptions = false;
  collationsChanged = false;
  definersRemoved = 0;
  /** Statements dropped (SET @@GLOBAL and the like). */
  dropped = 0;
  /** The tables and views the dump creates, their columns and its routines: what a trigger may name. */
  readonly tables = new Set<string>();
  readonly columns = new Set<string>();
  readonly routines = new Set<string>();
  private delimiter = ';';
  /** What the lines being read belong to; null between statements. */
  private statement: 'data' | 'other' | 'drop' | null = null;
  /** The bytes of the statement so far. */
  private statementBytes = 0;
  /** A statement that is not rows: its lines until it ends, and where SQL is at their end. */
  private held: string[] = [];
  private heldBytes = 0;
  private sql: SqlState = CODE;
  /** The pieces of the line that has not ended yet, while it is not known to be a row's. */
  private rest: Buffer[] = [];
  private restBytes = 0;
  /** A row's line, passed on as it arrives: how long it is so far, and its last bytes. */
  private streaming = false;
  private lineBytes = 0;
  private tail = EMPTY;
  private readonly optionsTable: string;

  /** `charset`: the set the dump is read in, for the names it creates. */
  constructor(
    prefix: string,
    private readonly charset = 'utf8mb4',
  ) {
    this.optionsTable = `\`${prefix}options\``;
  }

  push(chunk: Buffer): Buffer {
    const parts: Buffer[] = [];
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NL, start);
      const end = nl === -1 ? chunk.length : nl + 1;
      const piece = chunk.subarray(start, end);
      start = end;
      if (this.streaming) {
        this.passOn(piece, parts);
        if (nl !== -1) this.endRowLine();
        continue;
      }
      this.keep(piece);
      if (nl !== -1) {
        const out = this.line(this.takeLine());
        if (out) parts.push(out);
      } else if (this.restBytes >= HEAD_BYTES) {
        const row = this.startsRow();
        if (row === null) continue;
        // A row longer than what has come of it: passed on now, and the rest as it arrives.
        this.streaming = true;
        const kept = this.rest;
        this.rest = [];
        this.restBytes = 0;
        if (row === 'new') this.passOn(plainInsert(Buffer.concat(kept)), parts);
        else for (const p of kept) this.passOn(p, parts);
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** The end of one dump file: its last line ended, so the next file starts on a line of its own. */
  endFile(): Buffer {
    const parts: Buffer[] = [];
    if (this.streaming) {
      this.passOn(Buffer.from('\n'), parts);
      this.endRowLine();
    } else if (this.restBytes > 0) {
      this.keep(Buffer.from('\n'));
      const out = this.line(this.takeLine());
      if (out) parts.push(out);
    }
    // A statement never runs from one file into the next, nor does a DELIMITER.
    if (this.held.length > 0) parts.push(this.rewrite(this.held.join('')));
    if (this.statement !== null) this.endStatement();
    this.delimiter = ';';
    return parts.length === 0 ? EMPTY : Buffer.concat(parts);
  }

  /** Part of a line not known to be a row's: kept, up to what a statement that is not rows can be. */
  private keep(piece: Buffer): void {
    this.restBytes += piece.length;
    if (this.restBytes > MAX_STATEMENT) throw new PackageDumpError(`A statement of the dump that is not a row is longer than ${MAX_STATEMENT} bytes.`);
    this.rest.push(piece);
  }

  private takeLine(): Buffer {
    const line = this.rest.length === 1 ? this.rest[0]! : Buffer.concat(this.rest, this.restBytes);
    this.rest = [];
    this.restBytes = 0;
    return line;
  }

  /** Whether the line kept so far is a row's: 'more' of an INSERT or REPLACE, the start of a 'new' one, or neither. */
  private startsRow(): 'new' | 'more' | null {
    if (this.statement === 'data') return 'more';
    if (this.statement !== null) return null;
    const head: Buffer[] = [];
    let n = 0;
    for (const p of this.rest) {
      head.push(p.subarray(0, HEAD_BYTES - n));
      n += head.at(-1)!.length;
      if (n >= HEAD_BYTES) break;
    }
    if (!/^(INSERT|REPLACE)\b/i.test(statementHead(Buffer.concat(head).toString('latin1')))) return null;
    this.statement = 'data';
    return 'new';
  }

  private passOn(piece: Buffer, parts: Buffer[]): void {
    this.lineBytes += piece.length;
    this.count(piece.length);
    parts.push(piece);
    this.tail = piece.length >= TAIL_BYTES ? Buffer.from(piece.subarray(piece.length - TAIL_BYTES)) : Buffer.concat([this.tail, piece]).subarray(-TAIL_BYTES);
  }

  private endRowLine(): void {
    const ends = this.endsRaw(this.tail, this.lineBytes <= this.tail.length);
    this.streaming = false;
    this.lineBytes = 0;
    this.tail = EMPTY;
    if (ends) this.endStatement();
  }

  private count(bytes: number): void {
    this.statementBytes += bytes;
    if (this.statementBytes > MAX_DUMP_LINE + 1) throw new PackageDumpError(`A statement of the dump is longer than ${MAX_DUMP_LINE} bytes, more than the database server takes.`);
  }

  private endStatement(): void {
    // Without the line break after it, as the server gets the statement.
    this.longest = Math.max(this.longest, this.statementBytes - 1);
    this.statementBytes = 0;
    this.statement = null;
  }

  /** Whether a row's line, without the blank space after it, ends with the delimiter. `whole`: `raw` is all of the line. */
  private endsRaw(raw: Buffer, whole = true): boolean {
    let end = raw.length;
    while (end > 0 && isBlank(raw[end - 1]!)) end--;
    if (!whole && end < this.delimiter.length) throw new PackageDumpError('A row of the dump ends in more blank space than the panel reads.');
    return end >= this.delimiter.length && raw.subarray(end - this.delimiter.length, end).toString('latin1') === this.delimiter;
  }

  /** Whether a line of a statement that is not rows ends it: the delimiter last in its code, after where SQL was. */
  private endsSql(text: string): boolean {
    let last = '';
    this.sql = readSql(text, this.sql, (from, to) => {
      const code = text.slice(from, to);
      if (code.trim() !== '') last = code;
    });
    return !this.sql.quote && !this.sql.comment && last.trimEnd().endsWith(this.delimiter);
  }

  private line(raw: Buffer): Buffer | null {
    if (this.statement === 'data') {
      // A row: passed on as it is, whatever is in it. Only its end is looked at.
      this.count(raw.length);
      if (this.endsRaw(raw)) this.endStatement();
      return raw;
    }
    if (this.statement === 'drop') {
      this.count(raw.length);
      if (this.endsSql(raw.toString('latin1'))) this.endStatement();
      return null;
    }
    if (this.statement === 'other') return this.hold(raw);
    // Between statements: what this line starts, from its first words.
    const head = raw.subarray(0, HEAD_BYTES).toString('latin1').trimStart();
    if (head.trimEnd() === '' || head.startsWith('--') || head.startsWith('#')) return raw;
    const words = statementHead(head);
    if (/^(INSERT|REPLACE)\b/i.test(words)) {
      this.statement = 'data';
      const row = plainInsert(raw);
      this.count(row.length);
      if (this.endsRaw(row)) this.endStatement();
      return row;
    }
    const text = raw.toString('latin1');
    const trimmed = text.trim();
    // A plain comment on its own line; a version comment is a statement.
    if (/^\/\*(?![M]?!)/.test(trimmed) && trimmed.endsWith('*/') && !trimmed.slice(2, -2).includes('*/')) return raw;
    const delimiter = /^DELIMITER\s+(\S+)$/i.exec(trimmed);
    if (delimiter) {
      this.delimiter = delimiter[1]!;
      return raw;
    }
    if (/^USE\b/i.test(words)) throw new PackageDumpError(`The dump switches to another database (${trimmed.slice(0, 80)}), so it would not load into the site's.`);
    if (/^CREATE\s+(DATABASE|SCHEMA)\b/i.test(words)) throw new PackageDumpError(`The dump creates a database of its own (${trimmed.slice(0, 80)}), so it would not load into the site's.`);
    this.sql = CODE;
    if (DROPPED_RE.test(words)) {
      this.dropped++;
      this.statement = 'drop';
      this.count(raw.length);
      if (this.endsSql(text)) this.endStatement();
      return null;
    }
    if (/^CREATE\s+TABLE\b/i.test(words) && text.includes(this.optionsTable)) this.hasOptions = true;
    this.statement = 'other';
    return this.hold(raw, text);
  }

  /** A line of a statement that is not rows, held until the statement ends; then the statement, rewritten. */
  private hold(raw: Buffer, text?: string): Buffer | null {
    this.heldBytes += raw.length;
    if (this.heldBytes > MAX_STATEMENT) throw new PackageDumpError(`A statement of the dump that is not a row is longer than ${MAX_STATEMENT} bytes.`);
    this.count(raw.length);
    const line = text ?? raw.toString('latin1');
    this.held.push(line);
    if (!this.endsSql(line)) return null;
    const statement = this.held.join('');
    this.endStatement();
    return this.rewrite(statement);
  }

  private rewrite(statement: string): Buffer {
    this.held = [];
    this.heldBytes = 0;
    this.sql = CODE;
    const created = createdNames(statement);
    if (created !== null) {
      const name = decodedIn(this.charset, created.name);
      if (created.kind === 'routine') this.routines.add(name);
      else this.tables.add(name);
      for (const column of created.columns) this.columns.add(decodedIn(this.charset, column));
    }
    const defined = stripDefiners(statement);
    const collated = mapCode(defined.line, replaceCollations);
    if (collated !== defined.line) this.collationsChanged = true;
    this.definersRemoved += defined.removed;
    // Only a SET of its own, as mysqldump writes it: in a routine, unique_checks = 0 may be a question.
    const checked = /^SET\b/i.test(statementHead(collated.slice(0, HEAD_BYTES))) ? mapCode(collated, (code) => code.replace(UNIQUE_CHECKS_OFF_RE, '$1=1')) : collated;
    return Buffer.from(checked, 'latin1');
  }
}
