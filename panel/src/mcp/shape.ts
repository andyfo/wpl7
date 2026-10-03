/**
 * What a tool answers with: one block of compact JSON that always parses, and never runs past
 * a budget - an AI client pays for every character, and a site list or a job log can be far
 * longer than anything worth reading. Cut in order, the least lossy first:
 *
 *  1. `select`: only the fields asked for, in each array of objects the answer holds;
 *  2. the longest array, cut to what fits, with a `truncated` note saying how much was left out;
 *  3. every string over STRING_CAP, clipped;
 *  4. last of all, the text itself, cut and handed back as a string - still valid JSON.
 *
 * Anything that must arrive whole - a file's text that will be edited and saved back - is
 * sized to fit before it gets here (mcp/tools.ts), because step 3 would clip it.
 */

export const ANSWER_BUDGET = 40_000;
const STRING_CAP = 2_000;

export interface Truncation {
  /** Where the array was, as a dotted path (`body.items`). */
  field: string;
  returned: number;
  total: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Keep only `fields` (dotted paths: `domains`, `wp.version`) of every object in the arrays at
 * the top of `body` and one level down - `{items: [...]}`, `{job, logs: [...]}`.
 */
export function project(body: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields || fields.length === 0) return body;
  const pick = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const parts = field.split('.');
      let from: unknown = item;
      for (const part of parts) from = from && typeof from === 'object' ? (from as Record<string, unknown>)[part] : undefined;
      if (from === undefined) continue;
      let into = out;
      for (const part of parts.slice(0, -1)) into = (into[part] ??= {}) as Record<string, unknown>;
      into[parts.at(-1)!] = from;
    }
    return out;
  };
  const inArrays = (value: unknown): unknown => (Array.isArray(value) ? value.map(pick) : value);
  if (Array.isArray(body)) return inArrays(body);
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, inArrays(value)]));
}

/**
 * `envelope` as JSON text of at most `budget` characters. Where arrays were cut, the envelope
 * gains `truncated: [{field, returned, total}]`; where even that was not enough, its short
 * scalar fields (`status`, `endpoint`, `done`…) stay and everything else becomes `partial`, the
 * start of its own JSON text, with `truncated` saying so.
 */
export function fitAnswer(envelope: Record<string, unknown>, budget = ANSWER_BUDGET): string {
  const text = JSON.stringify(envelope);
  if (text.length <= budget) return text;

  const value = JSON.parse(text) as Record<string, Json>;
  const cuts: Truncation[] = [];
  const withCuts = () => JSON.stringify(cuts.length > 0 ? { ...value, truncated: cuts } : value);

  // 2. The longest arrays first, each cut to what still fits - a few rounds at most.
  for (let round = 0; round < 8 && withCuts().length > budget; round++) {
    const longest = longestArray(value);
    if (!longest || longest.array.length <= 1) break;
    const { array, path } = longest;
    const total = array.length;
    const others = withCuts().length - JSON.stringify(array).length;
    // Keep the head of the array: lists come newest or most relevant first.
    let lo = 0;
    let hi = total - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (others + JSON.stringify(array.slice(0, mid)).length + 120 <= budget) lo = mid;
      else hi = mid - 1;
    }
    array.splice(lo);
    const existing = cuts.find((c) => c.field === path);
    if (existing) existing.returned = lo;
    else cuts.push({ field: path, returned: lo, total });
  }

  // 3. Clip long strings wherever they are.
  if (withCuts().length > budget) clipStrings(value);
  const fitted = withCuts();
  if (fitted.length <= budget) return fitted;

  // 4. One enormous value somewhere: keep the short scalars as they are, and hand back the
  // start of the rest as a string.
  const short = (v: Json) => v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200);
  const scalars = Object.fromEntries(Object.entries(value).filter(([, v]) => short(v)));
  const restText = JSON.stringify(Object.fromEntries(Object.entries(value).filter(([k]) => !(k in scalars))));
  const note = { truncated: 'The answer was too long; partial holds the start of its JSON text', partial: '' };
  const full = { ...scalars, ...note };
  const head = JSON.stringify(full).length <= budget ? full : note;
  const room = Math.max(0, budget - JSON.stringify(head).length);
  return JSON.stringify({ ...head, partial: prefixWithin(restText, room) });
}

/**
 * The longest start of `text` whose JSON encoding - quotes and backslashes escaped, every one of
 * them twice its size - still fits in `room` characters.
 */
function prefixWithin(text: string, room: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(text.slice(0, mid)).length - 2 <= room) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** The array holding the most text, anywhere in the value, and where it is. */
function longestArray(value: Json, path = ''): { array: Json[]; path: string; size: number } | null {
  let best: { array: Json[]; path: string; size: number } | null = null;
  const visit = (node: Json, at: string, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const size = JSON.stringify(node).length;
      if (!best || size > best.size) best = { array: node, path: at, size };
      node.forEach((item, i) => visit(item, `${at}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node)) visit(child, at ? `${at}.${key}` : key, depth + 1);
  };
  visit(value, path, 0);
  return best;
}

function clipStrings(node: Json): void {
  if (node === null || typeof node !== 'object') return;
  const entries: [string | number, Json][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [key, child] of entries) {
    if (typeof child === 'string' && child.length > STRING_CAP) {
      const clipped = `${child.slice(0, STRING_CAP)}… [${child.length - STRING_CAP} more characters]`;
      if (Array.isArray(node)) node[key as number] = clipped;
      else node[key as string] = clipped;
    } else {
      clipStrings(child);
    }
  }
}
