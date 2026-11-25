/**
 * What the MariaDB client says when a statement fails: the statement itself, between lines of
 * dashes, then an `ERROR` line that quotes what it held (the duplicate entry, the bad value, the
 * text near a syntax error). Loading a site's database that is a row of its data; running the
 * panel's own SQL it can be a password. Either ends up in a job's log and error, which every API
 * key that may read jobs reads too.
 *
 * So only the `ERROR` lines are kept, and of each only what MariaDB's own message says: its code,
 * its line, and the names in it. A message is matched whole against MariaDB's wording; one that
 * does not match is not shown. A trigger or routine can raise an error of any code and state with
 * words of its own (SIGNAL … SET MYSQL_ERRNO, MESSAGE_TEXT): those of SIGNAL's own codes are never
 * shown, and words dressed as another code's show only where that code's message has a name.
 */

const NOT_SHOWN = '(not shown, as it can hold the site’s data)';
/** The client's own error lines: `ERROR 1062 (23000) at line 42: …`, `ERROR at line 5: …`, `ERROR 2002 (HY000): …`. */
const ERROR_LINE_RE = /^ERROR(?: (\d+) \(([0-9A-Z]{5})\))?(?: at line (\d+))?: ([\s\S]*)$/;
/** A line of the tools around the client, gzip's or the shell's, quoting nothing: kept, as it says what broke. */
const TOOL_LINE_RE = /^(?:gzip|bash|sh|mariadb|mysql|docker): [^'"`]*$/;
/** SIGNAL's own: a warning, not found, an exception (ER_SIGNAL_WARN, _NOT_FOUND, _EXCEPTION). */
const SIGNAL_CODES = new Set(['1642', '1643', '1644']);

/** A name in a message: quoted, as MariaDB quotes it, and never across a quote. */
const N = "([^']*)";
/** A value: anything, quotes of its own included, as MariaDB does not escape them. */
const V = "'[\\s\\S]*'";
const BQ = '(`[^`]*`(?:\\.`[^`]*`)*)';

/** MariaDB's messages (sql/share/errmsg-utf8.txt) an import or the panel's own SQL meets, with the value parts masked. */
const TEMPLATES: [RegExp, string][] = [
  [new RegExp(`^Duplicate entry ${V} for key '${N}'$`), "Duplicate entry '…' for key '$1'"],
  [new RegExp(`^Duplicate entry ${V} for key (\\d+)$`), "Duplicate entry '…' for key $1"],
  [
    new RegExp(`^(You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use) near ${V} at line (\\d+)$`),
    "$1 near '…' at line $2",
  ],
  [new RegExp(`^Incorrect ([\\w ]+?) value: ${V} for column ${BQ} at row (\\d+)$`), "Incorrect $1 value: '…' for column $2 at row $3"],
  [new RegExp(`^Incorrect ([\\w ]+?) value: ${V} for function (\\w+)$`), "Incorrect $1 value: '…' for function $2"],
  [new RegExp(`^Truncated incorrect ([\\w ]+?) value: ${V}$`), "Truncated incorrect $1 value: '…'"],
  [new RegExp(`^Invalid (\\w+) character string: ${V}$`), "Invalid $1 character string: '…'"],
  [new RegExp(`^([\\w ]+) value is out of range in ${V}$`), "$1 value is out of range in '…'"],
  [new RegExp(`^Table '${N}' doesn't exist$`), "Table '$1' doesn't exist"],
  [new RegExp(`^Table '${N}' already exists$`), "Table '$1' already exists"],
  [new RegExp(`^Unknown table '${N}'$`), "Unknown table '$1'"],
  [new RegExp(`^Unknown table '${N}' in (\\w+)$`), "Unknown table '$1' in $2"],
  [new RegExp(`^Unknown database '${N}'$`), "Unknown database '$1'"],
  [new RegExp(`^Unknown column '${N}' in '${N}'$`), "Unknown column '$1' in '$2'"],
  [new RegExp(`^Data too long for column '${N}' at row (\\d+)$`), "Data too long for column '$1' at row $2"],
  [new RegExp(`^Data truncated for column '${N}' at row (\\d+)$`), "Data truncated for column '$1' at row $2"],
  [new RegExp(`^Out of range value for column '${N}' at row (\\d+)$`), "Out of range value for column '$1' at row $2"],
  [new RegExp(`^Column '${N}' cannot be null$`), "Column '$1' cannot be null"],
  [new RegExp(`^Field '${N}' doesn't have a default value$`), "Field '$1' doesn't have a default value"],
  [new RegExp(`^Invalid default value for '${N}'$`), "Invalid default value for '$1'"],
  [new RegExp(`^Duplicate column name '${N}'$`), "Duplicate column name '$1'"],
  [new RegExp(`^Duplicate key name '${N}'$`), "Duplicate key name '$1'"],
  [new RegExp(`^Unknown collation: '${N}'$`), "Unknown collation: '$1'"],
  [new RegExp(`^Unknown character set: '${N}'$`), "Unknown character set: '$1'"],
  [new RegExp(`^(\\w+) command denied to user '${N}'@'${N}' for table ${BQ}$`), "$1 command denied to user '$2'@'$3' for table $4"],
  [new RegExp(`^Access denied for user '${N}'@'${N}' to database '${N}'$`), "Access denied for user '$1'@'$2' to database '$3'"],
  [new RegExp(`^Access denied for user '${N}'@'${N}' \\(using password: (YES|NO)\\)$`), "Access denied for user '$1'@'$2' (using password: $3)"],
  [/^(Access denied; you need \(at least one of\) the [\w ,]+ privilege\(s\) for this operation)$/, '$1'],
  [new RegExp(`^Operation ([A-Z ]+) failed for '${N}'@'${N}'$`), "Operation $1 failed for '$2'@'$3'"],
  [/^(PROCEDURE|FUNCTION) ([\w$.`]+) does not exist$/, '$1 $2 does not exist'],
  [new RegExp(`^The user specified as a definer \\('${N}'@'${N}'\\) does not exist$`), "The user specified as a definer ('$1'@'$2') does not exist"],
  [new RegExp(`^CONSTRAINT ${BQ} failed for ${BQ}$`), 'CONSTRAINT $1 failed for $2'],
  [/^(Cannot (?:add|delete) or update a (?:child|parent) row: a foreign key constraint fails \([^']*\))$/, '$1'],
  [/^(Got a packet bigger than 'max_allowed_packet' bytes)$/, '$1'],
  [/^(Specified key was too long; max key length is \d+ bytes)$/, '$1'],
  [/^(Row size too large[^']*)$/, '$1'],
  [/^(Lock wait timeout exceeded; try restarting transaction)$/, '$1'],
  [/^(Deadlock found when trying to get lock; try restarting transaction)$/, '$1'],
  [/^(Got error \d+ "[^"]*" (?:from storage engine \w+|during COMMIT|during ROLLBACK))$/, '$1'],
  [/^(Lost connection to server during query|Server has gone away|MySQL server has gone away)$/, '$1'],
  [new RegExp(`^(Can't connect to (?:local )?server (?:through socket|on)) '${N}' \\((-?\\d+)\\)$`), "$1 '$2' ($3)"],
  [new RegExp(`^Unknown server host '${N}' \\((-?\\d+)\\)$`), "Unknown server host '$1' ($2)"],
];

/** A MariaDB client's output, cut to its error lines with only MariaDB's own words and names in them. */
export function redactSqlError(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ERROR_LINE_RE.exec(line);
    if (!m) {
      if (TOOL_LINE_RE.test(line)) kept.push(line);
      continue;
    }
    const [, code, state, at, message] = m;
    const head = `ERROR${code ? ` ${code} (${state})` : ''}${at ? ` at line ${at}` : ''}: `;
    kept.push(head + redactMessage(code ?? '', state ?? '', message!));
  }
  return kept.length > 0 ? kept.join('\n') : '(the database server’s words are left out, as they can hold the site’s data)';
}

function redactMessage(code: string, state: string, message: string): string {
  if (SIGNAL_CODES.has(code) || state.startsWith('45')) return NOT_SHOWN;
  for (const [re, out] of TEMPLATES) if (re.test(message)) return message.replace(re, out);
  return NOT_SHOWN;
}
