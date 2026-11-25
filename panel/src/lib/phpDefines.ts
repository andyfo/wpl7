/**
 * The constants a PHP file such as wp-config.php defines with a plain string, read without running
 * it. Comments, strings and inline HTML are stepped over, so a define() in a comment, or written out
 * inside another string, is not taken for one.
 */

// @docs sites/duplicator
type Token = { kind: 'word'; text: string } | { kind: 'string'; value: string | null } | { kind: 'mark'; text: string };

const WORD_START = /[A-Za-z_\x80-￿]/;
const WORD_CHAR = /[A-Za-z0-9_\x80-￿]/;

/** Where the PHP code of a file starts: after `<?php`, `<?=` or `<?`. -1 for none. */
function codeStart(src: string, from: number): { at: number; open: number } {
  const at = src.indexOf('<?', from);
  if (at < 0) return { at: -1, open: 0 };
  if (src.slice(at, at + 5).toLowerCase() === '<?php') return { at, open: 5 };
  if (src[at + 2] === '=') return { at, open: 3 };
  return { at, open: 2 };
}

function tokens(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // Outside PHP until the first opening tag; a closing tag goes back out.
  const enterCode = () => {
    const { at, open } = codeStart(src, i);
    i = at < 0 ? src.length : at + open;
  };
  enterCode();
  while (i < src.length) {
    const c = src[i]!;
    if (c === '?' && src[i + 1] === '>') {
      i += 2;
      enterCode();
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      // To the end of the line, or a closing tag, which ends a line comment too.
      while (i < src.length && src[i] !== '\n' && !(src[i] === '?' && src[i + 1] === '>')) i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'") {
      // Only \\ and \' mean anything in single quotes.
      let value = '';
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && (src[i + 1] === '\\' || src[i + 1] === "'")) {
          value += src[i + 1];
          i += 2;
        } else value += src[i++];
      }
      i++;
      out.push({ kind: 'string', value });
      continue;
    }
    if (c === '"') {
      // A value only without escapes or variables: PHP works out anything else when it runs.
      const start = ++i;
      let plain = true;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          plain = false;
          i += 2;
        } else {
          if (src[i] === '$') plain = false;
          i++;
        }
      }
      out.push({ kind: 'string', value: plain ? src.slice(start, i) : null });
      i++;
      continue;
    }
    if (c === '<' && src.startsWith('<<<', i)) {
      // A heredoc or nowdoc: to the line that closes it. Never a value here.
      const head = /^<<<[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(src.slice(i, i + 300));
      if (head) {
        const close = new RegExp(`\\n[ \\t]*${head[2]}(?![A-Za-z0-9_])`, 'g');
        close.lastIndex = i + head[0].length - 1;
        const end = close.exec(src);
        i = end ? end.index + end[0].length : src.length;
        out.push({ kind: 'string', value: null });
        continue;
      }
    }
    if (WORD_START.test(c)) {
      const start = i;
      while (i < src.length && WORD_CHAR.test(src[i]!)) i++;
      out.push({ kind: 'word', text: src.slice(start, i) });
      continue;
    }
    // `->` and `::` stay one mark, so a method called define is told apart.
    const two = src.slice(i, i + 2);
    if (two === '->' || two === '::') {
      out.push({ kind: 'mark', text: two });
      i += 2;
      continue;
    }
    out.push({ kind: 'mark', text: c });
    i++;
  }
  return out;
}

/**
 * The value each constant gets from `define('NAME', 'value')`, for the names asked about. A name is
 * left out when one of its define() calls has a value PHP works out when it runs (a variable, a call,
 * a double-quoted string with escapes), or when two of them give it different values: which one
 * holds depends on the run.
 */
export function phpStringDefines(source: string, names: readonly string[]): Map<string, string> {
  const wanted = new Set(names);
  const found = new Map<string, string | null>();
  const list = tokens(source);
  for (let k = 0; k < list.length; k++) {
    const t = list[k]!;
    if (t.kind !== 'word' || t.text.toLowerCase() !== 'define') continue;
    const before = list[k - 1];
    if (before && ((before.kind === 'mark' && (before.text === '->' || before.text === '::')) || (before.kind === 'word' && /^(function|const|new)$/i.test(before.text)))) continue;
    const [open, name, comma, value, after] = [list[k + 1], list[k + 2], list[k + 3], list[k + 4], list[k + 5]];
    if (open?.kind !== 'mark' || open.text !== '(' || name?.kind !== 'string' || name.value === null || !wanted.has(name.value)) continue;
    if (comma?.kind !== 'mark' || comma.text !== ',') continue;
    const literal = value?.kind === 'string' && after?.kind === 'mark' && (after.text === ')' || after.text === ',') ? value.value : null;
    const seen = found.get(name.value);
    found.set(name.value, seen === undefined || seen === literal ? literal : null);
  }
  const out = new Map<string, string>();
  for (const [name, value] of found) if (value !== null) out.set(name, value);
  return out;
}
