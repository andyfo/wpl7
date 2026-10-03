/**
 * Bytes off a site's disk <-> text in the editor, without changing anything the operator
 * did not touch. A save must write back the same encoding, the same byte-order mark and
 * the same line endings the file had: a BOM that appears in front of `<?php` is the classic
 * "headers already sent", and a Windows-edited theme file should not come back with every
 * line changed.
 */

export type LineEndings = 'lf' | 'crlf' | 'mixed' | 'none';

export type DecodedFile =
  | { kind: 'text'; text: string; bom: boolean; eol: LineEndings }
  /** Has a NUL in its first 8 KiB: an image, an archive, a compiled file. */
  | { kind: 'binary' }
  /** Text, but not UTF-8 (Latin-1, say). Editing it here would rewrite it; view only. */
  | { kind: 'not-utf8'; preview: string };

const BOM = [0xef, 0xbb, 0xbf];

function lineEndings(text: string): LineEndings {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf === 0 && lf === 0 && cr === 0) return 'none';
  if (crlf > 0 && lf === 0 && cr === 0) return 'crlf';
  if (crlf === 0 && cr === 0) return 'lf';
  return 'mixed';
}

export function decodeFile(bytes: Uint8Array): DecodedFile {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return { kind: 'binary' };
  const bom = BOM.every((b, i) => bytes[i] === b);
  const body = bom ? bytes.subarray(3) : bytes;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { kind: 'not-utf8', preview: new TextDecoder('windows-1252').decode(body.subarray(0, 200_000)) };
  }
  const eol = lineEndings(raw);
  // The editor works in \n. A file that is CRLF throughout gets its CRLFs back on save; a
  // mixed one is edited as it is, and saving it normalises to \n (the editor says so).
  const text = eol === 'crlf' ? raw.replace(/\r\n/g, '\n') : raw;
  return { kind: 'text', text, bom, eol };
}

/** The bytes to save: the text, its line endings restored, its BOM put back. */
export function encodeFile(text: string, opts: { bom: boolean; eol: LineEndings }): Uint8Array {
  const withEol = opts.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
  const utf8 = new TextEncoder().encode(withEol);
  if (!opts.bom) return utf8;
  const out = new Uint8Array(utf8.length + 3);
  out.set(BOM, 0);
  out.set(utf8, 3);
  return out;
}
