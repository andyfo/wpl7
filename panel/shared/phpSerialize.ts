// @docs sites/database
/**
 * PHP's serialize() format, read and written: what WordPress keeps in wp_options and the meta
 * tables whenever a value is an array or an object (`a:2:{i:0;s:19:"akismet/akismet.php";…}`).
 *
 * A string's length in it is its length in BYTES, so editing such a value by hand - one changed
 * character in `ľ` instead of `l` - leaves a length that no longer matches, and PHP then reads the
 * whole value as false: the option silently empties. Edited here, the value is written back with
 * every length recounted. What cannot be written back byte for byte (bytes that are not UTF-8, a
 * class's own serialization) is left as it was: `editable` says so.
 */

export type PhpKey = { t: 'int'; v: string } | { t: 'string'; v: string };

export type PhpValue =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** As written, so a 64-bit integer keeps every digit. */
  | { t: 'int'; v: string }
  /** As written: `0.1`, `1.0E+25`, `INF`, `NAN`. */
  | { t: 'float'; v: string }
  | { t: 'string'; v: string }
  | { t: 'array'; items: { key: PhpKey; value: PhpValue }[] }
  | { t: 'object'; cls: string; props: { key: PhpKey; value: PhpValue }[] }
  /** `C:` - a class that serializes itself: its bytes are its own business, kept as they are. */
  | { t: 'custom'; cls: string; data: string }
  /** `E:` - a PHP 8.1 enum case, `Suit:Hearts`. */
  | { t: 'enum'; v: string }
  /** `r:` / `R:` - a reference to an earlier value. */
  | { t: 'ref'; kind: 'r' | 'R'; v: string };

export interface PhpParsed {
  value: PhpValue;
  /** Whether serializePhp gives back the very bytes it was read from, so edits can be written safely. */
  editable: boolean;
}

const encoder = new TextEncoder();
// ignoreBOM: a string that starts with U+FEFF keeps it (a decoder drops it by default, and its
// three bytes would go missing from the length written back).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** How many bytes PHP counts for a string: its UTF-8 length. */
export function phpByteLength(s: string): number {
  return encoder.encode(s).length;
}

class ParseError extends Error {}

/**
 * The value `text` serializes, or null when it is not a serialized value - not one at all, or one
 * with anything after it, as WordPress's is_serialized() would not take it either.
 */
export function parsePhp(text: string): PhpParsed | null {
  const trimmed = text.trim();
  if (!/^(N;|[bidsaOCErR]:)/.test(trimmed)) return null;
  const bytes = encoder.encode(trimmed);
  let pos = 0;
  let editable = true;

  const peek = () => bytes[pos];
  const expect = (ch: string) => {
    if (bytes[pos] !== ch.charCodeAt(0)) throw new ParseError(`expected ${ch} at ${pos}`);
    pos++;
  };
  const until = (ch: string): string => {
    const stop = bytes.indexOf(ch.charCodeAt(0), pos);
    if (stop < 0) throw new ParseError(`no ${ch} after ${pos}`);
    const s = lenientDecoder.decode(bytes.subarray(pos, stop));
    pos = stop + 1;
    return s;
  };
  const count = (): number => {
    const s = until(':');
    if (!/^\d+$/.test(s)) throw new ParseError(`bad length ${s}`);
    return Number(s);
  };
  const quoted = (length: number): string => {
    expect('"');
    const end = pos + length;
    if (end > bytes.length) throw new ParseError('string runs past the end');
    const raw = bytes.subarray(pos, end);
    let s: string;
    try {
      s = decoder.decode(raw);
    } catch {
      // Not UTF-8: shown, but never written back - re-encoding would change its bytes.
      editable = false;
      s = lenientDecoder.decode(raw);
    }
    pos = end;
    expect('"');
    return s;
  };

  const key = (): PhpKey => {
    const v = value();
    if (v.t === 'int' || v.t === 'string') return v;
    throw new ParseError('an array key is an int or a string');
  };

  const pairs = (n: number) => {
    const out: { key: PhpKey; value: PhpValue }[] = [];
    expect('{');
    for (let i = 0; i < n; i++) out.push({ key: key(), value: value() });
    expect('}');
    return out;
  };

  const value = (): PhpValue => {
    const type = String.fromCharCode(peek() ?? 0);
    pos++;
    if (type === 'N') {
      expect(';');
      return { t: 'null' };
    }
    expect(':');
    switch (type) {
      case 'b': {
        const v = until(';');
        if (v !== '0' && v !== '1') throw new ParseError('bad bool');
        return { t: 'bool', v: v === '1' };
      }
      case 'i': {
        const v = until(';');
        if (!/^-?\d+$/.test(v)) throw new ParseError('bad int');
        return { t: 'int', v };
      }
      case 'd': {
        const v = until(';');
        if (!/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|-?INF|NAN)$/.test(v)) throw new ParseError('bad float');
        return { t: 'float', v };
      }
      case 's': {
        const v = quoted(count());
        expect(';');
        return { t: 'string', v };
      }
      case 'a':
        return { t: 'array', items: pairs(count()) };
      case 'O': {
        const cls = quoted(count());
        expect(':');
        return { t: 'object', cls, props: pairs(count()) };
      }
      case 'C': {
        const cls = quoted(count());
        expect(':');
        const n = count();
        expect('{');
        const data = lenientDecoder.decode(bytes.subarray(pos, pos + n));
        if (phpByteLength(data) !== n) editable = false;
        pos += n;
        expect('}');
        return { t: 'custom', cls, data };
      }
      case 'E': {
        const v = quoted(count());
        expect(';');
        return { t: 'enum', v };
      }
      case 'r':
      case 'R': {
        const v = until(';');
        if (!/^\d+$/.test(v)) throw new ParseError('bad reference');
        return { t: 'ref', kind: type, v };
      }
      default:
        throw new ParseError(`unknown type ${type}`);
    }
  };

  try {
    const parsed = value();
    if (pos !== bytes.length) return null;
    return { value: parsed, editable };
  } catch (err) {
    if (err instanceof ParseError) return null;
    throw err;
  }
}

const str = (s: string) => `s:${phpByteLength(s)}:"${s}";`;
const keyText = (k: PhpKey) => (k.t === 'int' ? `i:${k.v};` : str(k.v));

/** A value back in PHP's format, every string length counted again in bytes. */
export function serializePhp(v: PhpValue): string {
  switch (v.t) {
    case 'null':
      return 'N;';
    case 'bool':
      return `b:${v.v ? 1 : 0};`;
    case 'int':
      return `i:${v.v};`;
    case 'float':
      return `d:${v.v};`;
    case 'string':
      return str(v.v);
    case 'array':
      return `a:${v.items.length}:{${v.items.map((i) => keyText(i.key) + serializePhp(i.value)).join('')}}`;
    case 'object':
      return `O:${phpByteLength(v.cls)}:"${v.cls}":${v.props.length}:{${v.props.map((p) => keyText(p.key) + serializePhp(p.value)).join('')}}`;
    case 'custom':
      return `C:${phpByteLength(v.cls)}:"${v.cls}":${phpByteLength(v.data)}:{${v.data}}`;
    case 'enum':
      return `E:${phpByteLength(v.v)}:"${v.v}";`;
    case 'ref':
      return `${v.kind}:${v.v};`;
  }
}

/** How a property's key reads: `\0*\0name` is protected, `\0Class\0name` private, as PHP stores them. */
export function phpKeyLabel(k: PhpKey): string {
  if (k.t === 'int') return k.v;
  const m = /^\u0000([^\u0000]*)\u0000(.*)$/s.exec(k.v);
  if (!m) return k.v;
  return m[1] === '*' ? `${m[2]} (protected)` : `${m[2]} (private, ${m[1]})`;
}

/** A scalar's text as an input shows it, and the value an edited text makes of it - or null when the text does not fit the type. */
export function editScalar(v: PhpValue, text: string): PhpValue | null {
  switch (v.t) {
    case 'string':
      return { t: 'string', v: text };
    case 'int':
      return /^-?\d+$/.test(text.trim()) ? { t: 'int', v: text.trim() } : null;
    case 'float':
      return /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|-?INF|NAN)$/.test(text.trim()) ? { t: 'float', v: text.trim() } : null;
    case 'bool':
      return text === 'true' || text === '1' ? { t: 'bool', v: true } : text === 'false' || text === '0' ? { t: 'bool', v: false } : null;
    default:
      return null;
  }
}

/** A copy of `root` with the value at `path` (indexes into items/props) replaced. */
export function replaceAt(root: PhpValue, path: number[], next: PhpValue): PhpValue {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (root.t === 'array') {
    return { ...root, items: root.items.map((it, i) => (i === head ? { ...it, value: replaceAt(it.value, rest, next) } : it)) };
  }
  if (root.t === 'object') {
    return { ...root, props: root.props.map((p, i) => (i === head ? { ...p, value: replaceAt(p.value, rest, next) } : p)) };
  }
  return root;
}
