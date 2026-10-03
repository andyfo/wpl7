/**
 * `Content-Disposition: attachment` for a name that came off a site's disk - so a name an
 * attacker may have picked. Control characters (a CR/LF would end the header early) and
 * the bidi overrides that make `invoice\u202Efdp.php` display as `invoicephp.pdf` are dropped.
 * The quoted `filename` is a plain-ASCII stand-in; `filename*` (RFC 5987) carries the real
 * name to every browser that reads it, which is all of them.
 */
export function attachmentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  let encoded: string;
  try {
    encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    // A lone surrogate has no UTF-8 form; the ASCII stand-in is all there is to send.
    return `attachment; filename="${ascii}"`;
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
