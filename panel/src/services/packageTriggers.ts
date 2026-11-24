// @docs sites/duplicator
/**
 * The old database's triggers, which Duplicator keeps out of its dumps and lists in archive.txt,
 * each with its CREATE (handlers/sitePackage.ts adds them once the site is set up). MariaDB takes a
 * trigger that names a table it does not have, and from then on refuses every write to the
 * trigger's own table: a statement that writes no row does not show it, as the trigger's tables are
 * opened only when it runs. So a trigger is added only on the evidence that the site has all it
 * names (checkTrigger): every word of its body is a keyword or function of MariaDB's, NEW or OLD,
 * something the trigger declares or names itself (a variable, a cursor, a label, an alias, a
 * subquery's name), or a table, view, column or routine of the site's. Left out too is one that
 * uses ||, which is OR or joins strings depending on the SQL mode it was made with: Duplicator does
 * not record that mode, and the trigger runs in WordPress's here.
 *
 * Before the package is unpacked, only what is wrong whatever the site's database holds is said
 * (inspectTrigger): another database, a table it is on that the package has not, ||.
 */
import { MARIADB_FUNCTIONS, MARIADB_KEYWORDS } from '../lib/mariadbWords.js';
import { keyword, sqlTokens, type SqlToken } from '../lib/sqlLexer.js';

export interface TriggerRefs {
  /** The table the trigger is on. */
  table: string | null;
  /** Other databases it names. */
  databases: string[];
  /** It uses ||. */
  pipes: boolean;
  /** Where in its words (sqlTokens) a table of its own database stands: after INTO, FROM, JOIN, UPDATE, USING. */
  tableAt: number[];
}

/** What the site's database has, for a trigger to name. */
export interface SiteNames {
  /** Tables and views, as MariaDB on Linux tells them apart: by case too. */
  tables: ReadonlySet<string>;
  /** The columns of any of them. */
  columns: ReadonlySet<string>;
  /** Procedures and functions. */
  routines: ReadonlySet<string>;
}

const PIPES = 'uses ||, which means OR or joins strings depending on an SQL mode the package does not record';

/** Words that end a table reference: what follows a table where an alias could stand. */
const NOT_AN_ALIAS = new Set([
  'AS', 'SET', 'WHERE', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'NATURAL', 'OUTER', 'STRAIGHT_JOIN',
  'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'VALUES', 'VALUE', 'SELECT', 'FOR',
  'INTO', 'FROM', 'PARTITION', 'USE', 'IGNORE', 'FORCE', 'WINDOW', 'LOCK', 'RETURNING', 'WITH', 'DEFAULT', 'AND', 'OR',
  'NOT', 'END', 'THEN', 'ELSE', 'ELSEIF', 'WHEN', 'DO', 'IF', 'CASE', 'WHILE', 'LOOP', 'REPEAT', 'UNTIL', 'LEAVE',
  'ITERATE', 'RETURN', 'DECLARE', 'OPEN', 'CLOSE', 'FETCH', 'BEGIN', 'CALL', 'SIGNAL', 'RESIGNAL', 'DELETE', 'INSERT',
  'UPDATE', 'REPLACE', 'LOW_PRIORITY', 'QUICK', 'NOWAIT', 'SKIP', 'LOCKED', 'SHARE', 'MODE', 'FOLLOWS', 'PRECEDES',
  'EACH', 'ROW',
]);

/**
 * Whether `word`, at a list of tables' own depth, is where its tables end: the clause after them
 * (WHERE, SET, …, ON DUPLICATE KEY UPDATE, FOR UPDATE) or another statement. Not a join's words,
 * nor FOR SYSTEM_TIME, which follow a table.
 */
function endsTables(word: string, next: string | null): boolean {
  if (word === 'ON') return next === 'DUPLICATE';
  if (word === 'FOR') return next !== 'SYSTEM_TIME';
  return TABLES_END.has(word);
}

const TABLES_END = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'INTO', 'LOCK',
  'SET', 'RETURNING', 'PROCEDURE', 'VALUES', 'VALUE', 'SELECT', 'INSERT', 'REPLACE', 'DELETE', 'CALL', 'IF', 'THEN',
  'ELSE', 'ELSEIF', 'END', 'WHEN', 'DO', 'RETURN', 'DECLARE', 'OPEN', 'CLOSE', 'FETCH', 'LEAVE', 'ITERATE', 'SIGNAL',
  'RESIGNAL', 'BEGIN', 'LOOP', 'REPEAT', 'WHILE', 'UNTIL',
]);

/** What a trigger's CREATE names, read as MariaDB reads it. */
export function triggerRefs(create: string): TriggerRefs {
  const t = sqlTokens(create);
  const kw = (j: number) => keyword(t[j]);
  const isP = (j: number, v: string) => t[j]?.k === 'p' && (t[j] as { v: string }).v === v;
  const nameAt = (j: number): string | null => (t[j]?.k === 'name' ? (t[j] as { v: string }).v : null);
  /** A name where an alias could stand: one in backquotes, or a bare word that ends nothing. */
  const aliasAt = (j: number): string | null => {
    const tok = t[j];
    if (tok?.k !== 'name') return null;
    return tok.q || !NOT_AN_ALIAS.has(tok.v.toUpperCase()) ? tok.v : null;
  };

  const aliases = new Set(['new', 'old']);
  const tables: string[] = [];
  const tableAt: number[] = [];
  const databases: string[] = [];
  /** Names that are a table reference's database or table: not qualifiers of columns. */
  const used = new Set<number>();
  let own: string | null = null;

  /** Past the `)` that closes the `(` at `n`. */
  const closing = (n: number): number => {
    let depth = 0;
    for (let k = n; k < t.length; k++) {
      if (isP(k, '(')) depth++;
      else if (isP(k, ')') && --depth === 0) return k + 1;
    }
    return t.length;
  };

  /**
   * One table reference at `n`, with its alias: a table (`t`, `db`.`t`), a derived table or a group
   * of joins in parentheses, JSON_TABLE(…). Returns where it ends, so a list goes on after it; it only
   * notes what it names, as the reading goes through every word, inside parentheses too. The table
   * is whatever word stands there, a keyword such as `events` too: MariaDB takes one as a table's name.
   */
  const tableRef = (n: number): number => {
    let end: number;
    if (isP(n, '(')) {
      // A group of joins, (a JOIN b): its first table noted here, the rest at their JOIN. A derived
      // table, (SELECT …): its own FROM names its tables.
      if (nameAt(n + 1) !== null && kw(n + 1) !== 'SELECT' && kw(n + 1) !== 'WITH') tableList(n + 1);
      end = closing(n);
    } else if (kw(n) === 'JSON_TABLE' && isP(n + 1, '(')) {
      // MariaDB's table function: what it reads is its arguments.
      end = closing(n + 1);
    } else {
      const first = nameAt(n);
      // FROM DUAL names no table.
      if (first === null || kw(n) === 'DUAL') return n;
      end = n + 1;
      used.add(n);
      let table = first;
      if (isP(n + 1, '.') && nameAt(n + 2) !== null) {
        databases.push(first);
        table = nameAt(n + 2)!;
        used.add(n + 2);
        end = n + 3;
      } else {
        tables.push(first);
        tableAt.push(n);
      }
      aliases.add(table.toLowerCase());
    }
    let a = end;
    if (kw(a) === 'AS') a++;
    const alias = aliasAt(a);
    if (alias !== null) {
      aliases.add(alias.toLowerCase());
      end = a + 1;
    }
    return end;
  };
  /** References separated by commas, from `n`. */
  function tableList(n: number): number {
    let end = tableRef(n);
    while (isP(end, ',') && end > n) {
      const next = tableRef(end + 1);
      if (next === end + 1) break;
      end = next;
    }
    return end;
  }

  // Names given to subqueries and the like before they are used: `x AS (`, `x (a, b) AS (`, DECLARE'd variables.
  for (let j = 0; j < t.length; j++) {
    const name = nameAt(j);
    if (name === null) continue;
    let as = j + 1;
    if (isP(as, '(')) {
      // x (a, b) AS (…): past the list of columns.
      while (as < t.length && !isP(as, ')')) as++;
      as++;
    }
    if (kw(as) === 'AS' && isP(as + 1, '(')) {
      aliases.add(name.toLowerCase());
    }
    if (kw(j) === 'DECLARE') {
      for (let n = j + 1; nameAt(n) !== null; n += 2) {
        aliases.add(nameAt(n)!.toLowerCase());
        if (!isP(n + 1, ',')) break;
      }
    }
  }

  /**
   * Whether the FROM at `j` is DELETE's, of the form DELETE FROM targets USING …: the targets, each
   * `t` or `t.*`, come before the USING.
   */
  const deletesUsing = (j: number): boolean => {
    let b = j - 1;
    while (['LOW_PRIORITY', 'QUICK', 'IGNORE'].includes(kw(b) ?? '')) b--;
    if (kw(b) !== 'DELETE') return false;
    let k = j + 1;
    for (;;) {
      if (nameAt(k) === null) return false;
      k++;
      if (isP(k, '.') && isP(k + 1, '*')) k += 2;
      if (!isP(k, ',')) break;
      k++;
    }
    return kw(k) === 'USING';
  };

  /** Per open parenthesis: whether it holds a query (FROM there names tables) or an expression. */
  const frames: ('query' | 'expr')[] = [];
  /**
   * The lists of tables being read, by the depth of parentheses each is at. FROM, UPDATE and USING
   * open one; at its depth a comma starts the next table, whatever came before it (a join's ON
   * condition, a derived table, an index hint), and the clause after the tables closes it.
   */
  const lists: number[] = [];
  let depth = 0;
  const openList = (n: number) => {
    lists.push(depth);
    tableList(n);
  };
  let pipes = false;
  for (let j = 0; j < t.length; j++) {
    const tok: SqlToken = t[j]!;
    if (tok.k === 'p') {
      if (tok.v === '||') pipes = true;
      else if (tok.v === '(') {
        depth++;
        frames.push(kw(j + 1) === 'SELECT' || kw(j + 1) === 'WITH' ? 'query' : 'expr');
      } else if (tok.v === ')') {
        depth--;
        frames.pop();
        while ((lists.at(-1) ?? -1) > depth) lists.pop();
        // A derived table's alias: `(SELECT …) [AS] d`.
        let n = j + 1;
        if (kw(n) === 'AS') n++;
        const alias = aliasAt(n);
        if (alias !== null) aliases.add(alias.toLowerCase());
      } else if (tok.v === ',' && lists.at(-1) === depth) {
        tableRef(j + 1);
      } else if (tok.v === ';') {
        lists.length = 0;
      }
      continue;
    }
    if (tok.k !== 'name' || tok.q) continue;
    const before = kw(j - 1);
    const word = tok.v.toUpperCase();
    if (lists.at(-1) === depth && endsTables(word, kw(j + 1))) lists.pop();
    switch (word) {
      case 'ON':
        // The trigger's own table: {BEFORE | AFTER} {INSERT | UPDATE | DELETE} ON t.
        if ((before === 'INSERT' || before === 'UPDATE' || before === 'DELETE') && (kw(j - 2) === 'BEFORE' || kw(j - 2) === 'AFTER')) {
          const at = tables.length;
          tableRef(j + 1);
          if (tables.length > at) {
            own = tables.pop()!;
            tableAt.pop();
          }
        }
        break;
      case 'INSERT':
      case 'REPLACE': {
        // INSERT(…) and REPLACE(…) are string functions; after BEFORE or AFTER, the trigger's event.
        if (isP(j + 1, '(') || before === 'BEFORE' || before === 'AFTER') break;
        let n = j + 1;
        while (['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE'].includes(kw(n) ?? '')) n++;
        if (kw(n) === 'INTO') n++;
        tableRef(n);
        break;
      }
      case 'UPDATE': {
        // The trigger's event, ON DUPLICATE KEY UPDATE's columns, SELECT … FOR UPDATE: no table.
        if (before === 'BEFORE' || before === 'AFTER' || before === 'KEY' || before === 'FOR') break;
        let n = j + 1;
        while (['LOW_PRIORITY', 'IGNORE'].includes(kw(n) ?? '')) n++;
        openList(n);
        break;
      }
      case 'FROM':
        // EXTRACT(YEAR FROM d), TRIM(… FROM s), SUBSTRING(s FROM 2): no table. FETCH [NEXT] FROM c:
        // a cursor. FOR SYSTEM_TIME FROM … TO …: a time.
        if (before === 'FETCH' || before === 'NEXT' || before === 'SYSTEM_TIME') break;
        // DELETE FROM l USING wp_log AS l: what follows FROM names tables or aliases of the USING list, which names the tables.
        if (deletesUsing(j)) break;
        if ((frames.at(-1) ?? 'query') === 'query') openList(j + 1);
        break;
      case 'JOIN':
      case 'STRAIGHT_JOIN':
        tableRef(j + 1);
        break;
      case 'USING':
        // DELETE … USING t1, t2. JOIN … USING (columns) names columns, CONVERT(… USING utf8mb4) a character set.
        if (!isP(j + 1, '(') && (frames.at(-1) ?? 'query') === 'query') openList(j + 1);
        break;
    }
  }

  for (let j = 0; j + 2 < t.length; j++) {
    const q = nameAt(j);
    if (q === null || !isP(j + 1, '.') || nameAt(j + 2) === null || used.has(j) || isP(j - 1, '.')) continue;
    // other.t.c and other.f(): a database.
    if ((isP(j + 3, '.') && nameAt(j + 4) !== null) || isP(j + 3, '(')) databases.push(q);
  }

  const unique = (names: string[]) => [...new Set(names)];
  return { table: own, databases: unique(databases), pipes, tableAt };
}

/**
 * What New site says of a trigger before the package is unpacked: what is wrong whatever the
 * site's database holds, the views among it that archive.txt does not name.
 */
export function inspectTrigger(create: string, tables: ReadonlySet<string>): string[] {
  const refs = triggerRefs(create);
  const out = refs.databases.map((db) => `names the database ${db}`);
  // A trigger is on a table, never on a view.
  if (refs.table !== null && !tables.has(refs.table)) out.push(`is on ${refs.table}, which the package does not have`);
  if (refs.pipes) out.push(PIPES);
  return out;
}

/** Why a trigger cannot be added to the site's database, or [] when it can. */
export function checkTrigger(create: string, site: SiteNames): string[] {
  const refs = triggerRefs(create);
  const out = refs.databases.map((db) => `names the database ${db}`);
  const unknown = unknownNames(create, site).filter((name) => !refs.databases.includes(name));
  if (unknown.length > 0) out.push(`names ${unknown.join(', ')}, which the site's database does not have`);
  if (refs.pipes) out.push(PIPES);
  return out;
}

/**
 * The names of a trigger that nothing in the site's database accounts for: its own table when the
 * site has not that, and every word of its body that is no keyword or function of MariaDB's, no
 * NEW or OLD, nothing the trigger declares or names itself, and no table, view, column or routine
 * of the site's. Tables and views are told apart by case, as MariaDB on Linux does.
 */
export function unknownNames(create: string, site: SiteNames): string[] {
  const t = sqlTokens(create);
  const kw = (j: number) => keyword(t[j]);
  const isP = (j: number, v: string) => t[j]?.k === 'p' && (t[j] as { v: string }).v === v;
  const nameAt = (j: number): string | null => (t[j]?.k === 'name' ? (t[j] as { v: string }).v : null);
  const lower = (name: string) => name.toLowerCase();
  // Where a table stands, read as triggerRefs reads the same words.
  const tableAt = new Set(triggerRefs(create).tableAt);
  const columns = new Set([...site.columns].map(lower));
  const routines = new Set([...site.routines].map(lower));

  // The body: after FOR EACH ROW, and the trigger FOLLOWS or PRECEDES, which is no name of the database's.
  let body = t.length;
  for (let j = 0; j + 2 < t.length; j++) {
    if (kw(j) === 'FOR' && kw(j + 1) === 'EACH' && kw(j + 2) === 'ROW') {
      body = j + 3;
      break;
    }
  }
  if (kw(body) === 'FOLLOWS' || kw(body) === 'PRECEDES') body += 2;

  const unknown: string[] = [];
  // Its own table: {BEFORE | AFTER} {INSERT | UPDATE | DELETE} ON t.
  for (let j = 2; j < body; j++) {
    const event = kw(j - 1);
    if (kw(j) !== 'ON' || (event !== 'INSERT' && event !== 'UPDATE' && event !== 'DELETE') || (kw(j - 2) !== 'BEFORE' && kw(j - 2) !== 'AFTER')) continue;
    const table = isP(j + 2, '.') ? nameAt(j + 3) : nameAt(j + 1);
    if (isP(j + 2, '.')) unknown.push(nameAt(j + 1)!);
    if (table !== null && !site.tables.has(table)) unknown.push(table);
    break;
  }

  // What the trigger names itself, wherever it does; and the subqueries it names, which stand where a table does.
  const declared = new Set(['new', 'old']);
  const ctes = new Set<string>();
  const aliasAt = (j: number): string | null => {
    const tok = t[j];
    return tok?.k === 'name' && (tok.q || !MARIADB_KEYWORDS.has(tok.v.toUpperCase())) ? tok.v : null;
  };
  for (let j = body; j < t.length; j++) {
    const name = nameAt(j);
    if (name === null) {
      // `(SELECT …) d`, `COUNT(*) total`: a derived table's or a value's name.
      const alias = isP(j, ')') ? aliasAt(j + 1) : null;
      if (alias !== null) declared.add(lower(alias));
      continue;
    }
    if (kw(j) === 'DECLARE') {
      // Variables, cursors, conditions: DECLARE a, b INT.
      for (let n = j + 1; nameAt(n) !== null; n += 2) {
        declared.add(lower(nameAt(n)!));
        if (!isP(n + 1, ',')) break;
      }
      continue;
    }
    // A label: lbl: BEGIN, lbl: LOOP.
    if (isP(j + 1, ':')) declared.add(lower(name));
    // JSON_TABLE(… COLUMNS (v INT PATH '$', n FOR ORDINALITY, NESTED PATH '$.a' COLUMNS (…))): the
    // first name of each part, a nested list's in its own turn.
    if (kw(j) === 'COLUMNS' && isP(j + 1, '(')) {
      let level = 0;
      let first = true;
      for (let k = j + 1; k < t.length; k++) {
        if (isP(k, '(')) {
          if (++level === 1) first = true;
          continue;
        }
        if (isP(k, ')')) {
          if (--level === 0) break;
          continue;
        }
        if (level !== 1) continue;
        if (isP(k, ',')) {
          first = true;
          continue;
        }
        if (first && nameAt(k) !== null && kw(k) !== 'NESTED') declared.add(lower(nameAt(k)!));
        first = false;
      }
    }
    // An alias with AS, of a value or a table.
    if (kw(j) === 'AS' && aliasAt(j + 1) !== null && !isP(j + 2, '(')) declared.add(lower(aliasAt(j + 1)!));
    // A subquery's name, with its columns: x AS (…), x (a, b) AS (…).
    let as = j + 1;
    const named: string[] = [];
    if (isP(as, '(')) {
      for (as++; as < t.length && !isP(as, ')'); as++) if (nameAt(as) !== null) named.push(nameAt(as)!);
      as++;
    }
    if (kw(as) === 'AS' && isP(as + 1, '(')) {
      ctes.add(name);
      for (const n of [name, ...named]) declared.add(lower(n));
    }
    // An alias without AS: right after a table or view of the site's.
    if (site.tables.has(name) && !isP(j + 1, '.')) {
      const alias = aliasAt(j + 1);
      if (alias !== null && !isP(j + 2, '(') && !isP(j + 2, '.')) declared.add(lower(alias));
    }
  }

  for (let j = body; j < t.length; j++) {
    const tok = t[j]!;
    if (tok.k !== 'name') continue;
    const name = tok.v;
    // The column of a table, NEW, OLD or an alias: x.col. What x is, is asked of x.
    if (isP(j - 1, '.')) continue;
    const before = kw(j - 1);
    // Where a table or a routine has to stand, any word is its name, keyword or not: the site has it, or the trigger fails every write.
    if (tableAt.has(j)) {
      if (!site.tables.has(name) && !ctes.has(name)) unknown.push(name);
      continue;
    }
    if (before === 'CALL') {
      if (!routines.has(lower(name))) unknown.push(name);
      continue;
    }
    if (!tok.q && (MARIADB_KEYWORDS.has(name.toUpperCase()) || name.toUpperCase() === 'DELIMITER')) continue;
    // A collation or character set's name, CONVERT(x USING utf8mb4)'s too (a table after USING is
    // read above), and an introducer: _utf8mb4'…'.
    if (before === 'COLLATE' || before === 'CHARSET' || before === 'USING' || (before === 'SET' && kw(j - 2) === 'CHARACTER')) continue;
    if (!tok.q && name.startsWith('_') && t[j + 1]?.k === 'lit') continue;
    if (declared.has(lower(name))) continue;
    // A table, its columns' list after it or not: INSERT INTO t (a, b).
    if (site.tables.has(name)) continue;
    if (isP(j + 1, '(')) {
      // A function of MariaDB's, or a routine that has to be the site's.
      if (!tok.q && MARIADB_FUNCTIONS.has(name.toUpperCase())) continue;
      if (!routines.has(lower(name))) unknown.push(name);
      continue;
    }
    if (columns.has(lower(name))) continue;
    unknown.push(name);
  }
  return [...new Set(unknown)];
}
