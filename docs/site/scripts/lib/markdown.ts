/**
 * Markdown for the generated pages: text that renders exactly as written, inline code that
 * survives any content, and tables. The pages are plain Markdown (.md), so nothing here has
 * to care about MDX's `{` and `<`, only about Markdown's own punctuation.
 */

/** Inline code for any content. In a table cell, `|` is escaped (GFM reads `\|` inside code too). */
export function code(value: string, inTable = false): string {
  let content = value.replace(/\s*\n\s*/g, ' ');
  if (inTable) content = content.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = content.startsWith('`') || content.endsWith('`') || /^ .* $/.test(content) ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

function escapePlain(value: string, inTable: boolean): string {
  let out = value.replace(/([\\*_[\]~])/g, '\\$1').replace(/</g, '&lt;');
  if (inTable) out = out.replace(/\|/g, '\\|');
  return out.replace(/^([#>+-]|\d+\.)(?=\s)/, '\\$1');
}

/**
 * Text as Markdown: punctuation that would format is escaped, and spans the source already
 * wrote in backticks stay code. An unmatched backtick is shown as one.
 */
export function text(value: string, inTable = false): string {
  let out = '';
  let rest = value.replace(/\r\n/g, '\n');
  while (rest.length > 0) {
    const open = /`+/.exec(rest);
    if (!open) {
      out += escapePlain(rest, inTable);
      break;
    }
    out += escapePlain(rest.slice(0, open.index), inTable);
    const after = rest.slice(open.index + open[0].length);
    const close = new RegExp(`(?<!\`)${open[0]}(?!\`)`).exec(after);
    if (!close) {
      out += '\\`'.repeat(open[0].length);
      rest = after;
      continue;
    }
    out += code(after.slice(0, close.index).trim(), inTable);
    rest = after.slice(close.index + close[0].length);
  }
  return out;
}

/** Text for a table cell: line breaks become <br>. */
export function cell(value: string): string {
  return text(value, true).replace(/\n/g, '<br>');
}

export function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** "1 endpoint", "3 endpoints". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
