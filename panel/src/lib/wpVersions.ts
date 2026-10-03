/**
 * WordPress version arithmetic, in PHP's terms.
 *
 * Every version string in this feature comes out of the WordPress world - wp-cli's
 * `version`/`update_version`, and the `min_version`/`max_version` bounds wpvulnerability.net
 * publishes - and all of it is written on the assumption that PHP's `version_compare()` is
 * doing the comparing. That function is not semver: it canonicalizes the string first
 * (`1.0.0-beta2` becomes `1.0.0.beta.2`), then compares part by part with a ranking that
 * puts `dev` below `alpha` below `beta` below `RC` below a plain number below `pl`. So
 * `1.0.0-beta1 < 1.0.0` and `1.0 < 1.0.1` come out right, and - importantly for an
 * advisory saying "fixed in 5.3.2" - so does `5.3.2-RC1 < 5.3.2`.
 *
 * Re-deriving that here rather than approximating it with semver is the difference between
 * "this site is vulnerable" and "this site is not", so the port follows PHP's
 * ext/standard/versioning.c closely enough that its own test cases pass.
 */

/**
 * PHP's php_canonicalize_version: `-`, `_` and `+` become `.`, a digit/non-digit boundary
 * gains a `.`, and any other non-alphanumeric collapses to a single `.`.
 */
export function canonicalizeVersion(version: string): string {
  if (version.length === 0) return '';
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlnum = (c: string) => /[a-zA-Z0-9]/.test(c);
  const out: string[] = [version[0]!];
  let lp = version[0]!;
  for (let i = 1; i < version.length; i++) {
    const ch = version[i]!;
    const lq = out[out.length - 1]!;
    if (ch === '-' || ch === '_' || ch === '+') {
      lp = ch;
      if (lq !== '.') out.push('.');
    } else if ((!isDigit(lp) && isDigit(ch)) || (isDigit(lp) && !isDigit(ch))) {
      // `*p != '.'` matters: the rule is "insert a dot at a digit/letter boundary", and a
      // dot is already the separator - without this guard "1.0" canonicalizes to "1..0"
      // and every length comparison after it ("1.0.1" vs "1.0") comes out backwards.
      if (lq !== '.' && ch !== '.') out.push('.');
      lp = ch;
      out.push(ch);
    } else if (!isAlnum(ch)) {
      if (lq !== '.') {
        out.push('.');
        lp = '.';
      }
    } else {
      lp = ch;
      out.push(ch);
    }
  }
  return out.join('');
}

/** The numeric placeholder PHP compares a non-numeric part against. */
const NUMERIC_FORM = '#N#';

/**
 * PHP's compare_special_forms. The match is a *prefix* match against the table in order,
 * so `beta3` ranks as `beta` and anything unrecognised ranks below `dev`.
 */
function specialFormOrder(part: string): number {
  const forms: [string, number][] = [
    ['dev', 0],
    ['alpha', 1],
    ['a', 1],
    ['beta', 2],
    ['b', 2],
    ['RC', 3],
    ['rc', 3],
    ['#', 4],
    ['pl', 5],
    ['p', 5],
  ];
  for (const [name, order] of forms) {
    if (part.startsWith(name)) return order;
  }
  return -1;
}

const cmp = (a: number, b: number): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

const startsWithDigit = (s: string) => s.length > 0 && s[0]! >= '0' && s[0]! <= '9';

/**
 * PHP's `version_compare($a, $b)`: -1 when `a` is older, 1 when newer, 0 when equal.
 * An empty string is older than anything non-empty (as in PHP), which is how an unknown
 * installed version is kept from silently comparing equal to a bound.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (a.length === 0 || b.length === 0) {
    if (a.length === 0 && b.length === 0) return 0;
    return a.length > 0 ? 1 : -1;
  }
  const parts1 = (a.startsWith('#') ? a : canonicalizeVersion(a)).split('.');
  const parts2 = (b.startsWith('#') ? b : canonicalizeVersion(b)).split('.');

  const shared = Math.min(parts1.length, parts2.length);
  let i = 0;
  for (; i < shared; i++) {
    const p1 = parts1[i]!;
    const p2 = parts2[i]!;
    // PHP's loop condition tests the REST of each string rather than the current segment,
    // so an empty segment - which only a trailing separator can produce ("1.0-" becomes
    // "1.0.") - ends the walk instead of being compared. The very first segment is always
    // compared, because at that point the rest of the string is the whole string.
    if (i > 0 && (p1 === '' || p2 === '')) break;
    const d1 = startsWithDigit(p1);
    const d2 = startsWithDigit(p2);
    let compare: -1 | 0 | 1;
    if (d1 && d2) compare = cmp(parseInt(p1, 10), parseInt(p2, 10));
    else if (!d1 && !d2) compare = cmp(specialFormOrder(p1), specialFormOrder(p2));
    else if (d1) compare = cmp(specialFormOrder(NUMERIC_FORM), specialFormOrder(p2));
    else compare = cmp(specialFormOrder(p1), specialFormOrder(NUMERIC_FORM));
    if (compare !== 0) return compare;
  }
  // Equal so far but one side has more to say: a trailing number makes it newer
  // (1.0.1 > 1.0), a trailing pre-release marker makes it older (1.0-beta < 1.0). PHP looks
  // at the first operand's leftovers first, which is why this is not symmetric.
  if (i < parts1.length) {
    const rest = parts1[i]!;
    return startsWithDigit(rest) ? 1 : compareVersions(rest, NUMERIC_FORM);
  }
  if (i < parts2.length) {
    const rest = parts2[i]!;
    return startsWithDigit(rest) ? -1 : (-compareVersions(rest, NUMERIC_FORM) as -1 | 0 | 1);
  }
  return 0;
}

/**
 * Every operator PHP's own `version_compare()` accepts. The feed publishes the word forms
 * (`lt`, `ge`, …); the symbolic ones are here because they are equally valid PHP and cost
 * nothing to honour if an advisory ever carries one.
 */
const OPERATORS: Record<string, (c: -1 | 0 | 1) => boolean> = {
  lt: (c) => c < 0,
  '<': (c) => c < 0,
  le: (c) => c <= 0,
  lte: (c) => c <= 0,
  '<=': (c) => c <= 0,
  gt: (c) => c > 0,
  '>': (c) => c > 0,
  ge: (c) => c >= 0,
  gte: (c) => c >= 0,
  '>=': (c) => c >= 0,
  eq: (c) => c === 0,
  '==': (c) => c === 0,
  '=': (c) => c === 0,
  ne: (c) => c !== 0,
  '!=': (c) => c !== 0,
  '<>': (c) => c !== 0,
};

export type VersionOperator = string;

export const isVersionOperator = (op: unknown): op is VersionOperator =>
  typeof op === 'string' && OPERATORS[op.toLowerCase()] !== undefined;

/** `installed {op} bound`, with PHP's version ordering. Unknown operators are `false`. */
export function versionSatisfies(installed: string, op: VersionOperator, bound: string): boolean {
  const test = OPERATORS[op.toLowerCase()];
  return test ? test(compareVersions(installed, bound)) : false;
}

export interface VersionRange {
  minVersion?: string | null;
  minOperator?: string | null;
  maxVersion?: string | null;
  maxOperator?: string | null;
}

/**
 * Does `installed` fall inside an advisory's affected range?
 *
 * - `'match'`    — every bound the advisory gives is satisfied
 * - `'no-match'` — a bound is definitely not satisfied, so this install is unaffected
 * - `'unknown'`  — the range could not be evaluated: no installed version, a bound with no
 *                  operator, or an operator the feed invented since this was written. The
 *                  caller shows it flagged instead of hiding it, because the failure mode
 *                  of a security list must be "mentions something harmless", never
 *                  "silently drops a real advisory".
 *
 * An advisory with no bounds at all (which the core endpoint's entries have by
 * construction, being version-scoped already) matches.
 */
export function matchRange(installed: string | null | undefined, range: VersionRange): 'match' | 'no-match' | 'unknown' {
  const version = (installed ?? '').trim();
  const bounds: { version: string; op: string | null | undefined }[] = [];
  if (range.minVersion) bounds.push({ version: range.minVersion, op: range.minOperator });
  if (range.maxVersion) bounds.push({ version: range.maxVersion, op: range.maxOperator });
  if (bounds.length === 0) return 'match';
  if (!version) return 'unknown';

  let uncertain = false;
  for (const bound of bounds) {
    if (!isVersionOperator(bound.op)) {
      uncertain = true;
      continue;
    }
    if (!versionSatisfies(version, bound.op, bound.version)) return 'no-match';
  }
  return uncertain ? 'unknown' : 'match';
}
