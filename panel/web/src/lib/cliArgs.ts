/**
 * A WP-CLI command line as the panel's inputs take it ("option update blogname 'My Site'"),
 * and the argv the API wants. The API takes an array on purpose - nothing on the server ever
 * joins it into a shell string - so the quoting rules live here, in one place, for the site
 * page's console and the schedule editor alike.
 */

/**
 * Split a wp-cli command line into argv, honouring quotes: without this,
 * `option update blogname "My Site"` would write the literal `"My` into the database.
 */
export function tokenizeCli(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let hasToken = false;
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) out.push(cur);
  return out;
}

/** What is wrong with a command line, or null: a quote left open would silently eat the rest. */
export function cliArgsProblem(input: string): string | null {
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  if (quote) return `The ${quote === '"' ? 'double' : 'single'} quote is never closed`;
  if (tokenizeCli(input).length === 0) return 'Type a command, e.g. cache flush';
  return null;
}

/**
 * The reverse of tokenizeCli, for putting a stored argv back into a text box: an argument
 * with a space, a quote or nothing in it is quoted, so tokenizing the result gives the same
 * argv back.
 */
export function formatCliArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== '' && !/[\s"']/.test(arg)) return arg;
      // Single quotes cannot hold a single quote and double quotes cannot hold a double one,
      // and the tokenizer has no escapes - pick whichever the argument does not contain.
      if (!arg.includes('"')) return `"${arg}"`;
      if (!arg.includes("'")) return `'${arg}'`;
      // Both kinds (`echo "it's";`): single-quote the stretches between apostrophes and put
      // each apostrophe in double quotes - `'echo "it'"'"'s";'` - pieces the tokenizer joins
      // back into one argument, as a shell would.
      return `'${arg.split("'").join(`'"'"'`)}'`;
    })
    .join(' ');
}
