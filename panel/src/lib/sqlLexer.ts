/**
 * SQL as MariaDB reads it, word by word: what a statement names, outside its strings and comments.
 * For the statements of a dump and the triggers of a package (services/packageDump.ts,
 * services/packageTriggers.ts), never to run anything.
 */

/** What may follow `--` for it to start a comment: blank space, a control character, or the end. */
export const endsDashes = (code: number) => !(code > 0x20);
/** `/*!` and `/*M!`: code that only some servers run, read as code. */
export const isVersionComment = (text: string, at: number) => text[at + 2] === '!' || (text[at + 2] === 'M' && text[at + 3] === '!');

/**
 * A word of SQL: a name (`q` when it was in backquotes, so never a keyword), a mark such as `(`,
 * `.`, `,` or `||`, or a value (a string, a number, a variable).
 */
export type SqlToken = { k: 'name'; v: string; q: boolean } | { k: 'p'; v: string } | { k: 'lit' };

const VERSION_OPENING_RE = /\/\*M?!\d*/y;
const WORD_RE = /[A-Za-z0-9_$\u0080-￿]/;
const NUMBER_RE = /^(?:\d+(?:e\d+)?|0x[0-9a-f]+|0b[01]+)$/i;

/** The end of a quoted run that starts at `at`: past its closing quote, its escapes and doubled quotes skipped. */
function quoteEnd(text: string, at: number): number {
  const quote = text[at]!;
  let j = at + 1;
  while (j < text.length) {
    if (text[j] === '\\' && quote !== '`') j += 2;
    else if (text[j] === quote && text[j + 1] === quote) j += 2;
    else if (text[j] === quote) return j + 1;
    else j++;
  }
  return text.length;
}

export function sqlTokens(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || c === '"') {
      i = quoteEnd(text, i);
      tokens.push({ k: 'lit' });
    } else if (c === '`') {
      const end = quoteEnd(text, i);
      tokens.push({ k: 'name', v: text.slice(i + 1, end - 1).replace(/``/g, '`'), q: true });
      i = end;
    } else if (c === '#' || (c === '-' && text[i + 1] === '-' && endsDashes(text.charCodeAt(i + 2)))) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (c === '/' && text[i + 1] === '*') {
      if (isVersionComment(text, i)) {
        // Code only some servers run: read on as code after its opening.
        VERSION_OPENING_RE.lastIndex = i;
        i += VERSION_OPENING_RE.exec(text)![0].length;
      } else {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
      }
    } else if (c === '*' && text[i + 1] === '/') {
      // The end of a version comment.
      i += 2;
    } else if (c === '@') {
      // A variable, @x, @@session.x or @`x`, never a name of the database's; DEFINER's host too.
      let j = i + 1;
      if (text[j] === '@') j++;
      if (text[j] === "'" || text[j] === '"' || text[j] === '`') j = quoteEnd(text, j);
      else while (j < text.length && /[A-Za-z0-9_.$]/.test(text[j]!)) j++;
      i = j;
      tokens.push({ k: 'lit' });
    } else if (WORD_RE.test(c)) {
      let j = i;
      while (j < text.length && WORD_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      i = j;
      tokens.push(NUMBER_RE.test(word) ? { k: 'lit' } : { k: 'name', v: word, q: false });
    } else if (c === '|' && text[i + 1] === '|') {
      tokens.push({ k: 'p', v: '||' });
      i += 2;
    } else {
      tokens.push({ k: 'p', v: c });
      i++;
    }
  }
  return tokens;
}

/** The bare word a token is, in capitals; null for anything else, a name in backquotes too. */
export const keyword = (t: SqlToken | undefined): string | null => (t?.k === 'name' && !t.q ? t.v.toUpperCase() : null);
