import { describe, expect, it } from 'vitest';
import { decodeFile, encodeFile } from '../../web/src/lib/fileText.js';
import { imageTypeFor, isKnownBinary, languageFor } from '../../web/src/lib/fileKinds.js';
import { CHUNK_MAX, CHUNK_MIN, nextChunkSize } from '../../web/src/lib/uploadPlan.js';

/** The editor's round trip: what is saved is what was opened, plus the edit and nothing else. */

const bytes = (s: string) => new TextEncoder().encode(s);

describe('decoding and encoding a file for the editor', () => {
  it('round-trips CRLF files and a BOM exactly', () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<?php\r\necho 1;\r\n')]);
    const d = decodeFile(original);
    expect(d).toEqual({ kind: 'text', text: '<?php\necho 1;\n', bom: true, eol: 'crlf' });
    if (d.kind !== 'text') throw new Error('not text');
    expect(encodeFile(d.text, d)).toEqual(original);
    const edited = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encodeFile(`${d.text}echo 2;\n`, d));
    expect(edited).toBe('\uFEFF<?php\r\necho 1;\r\necho 2;\r\n');
  });

  it('leaves LF, single-line and mixed files as they are', () => {
    expect(decodeFile(bytes('a\nb\n'))).toMatchObject({ eol: 'lf', bom: false });
    expect(decodeFile(bytes('one line'))).toMatchObject({ eol: 'none' });
    const mixed = decodeFile(bytes('a\r\nb\nc'));
    expect(mixed).toMatchObject({ eol: 'mixed', text: 'a\r\nb\nc' });
  });

  it('refuses to edit binary files and text that is not UTF-8', () => {
    expect(decodeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toEqual({ kind: 'binary' });
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1
    expect(decodeFile(latin1)).toEqual({ kind: 'not-utf8', preview: 'café' });
  });
});

describe('file kinds', () => {
  it('picks the editor language, including dotfiles', () => {
    expect(languageFor('functions.php')).toBe('php');
    expect(languageFor('.htaccess')).toBe('ini');
    expect(languageFor('app.min.JS')).toBe('javascript');
    expect(languageFor('README')).toBe('plain');
  });

  it('previews only allowlisted images, with the type from the name', () => {
    expect(imageTypeFor('logo.SVG')).toBe('image/svg+xml');
    expect(imageTypeFor('page.html')).toBeNull();
    expect(isKnownBinary('backup.tar.gz')).toBe(true);
    expect(isKnownBinary('style.css')).toBe(false);
  });
});

describe('upload chunk sizing', () => {
  it('grows while chunks are quick, shrinks when one is slow, within bounds', () => {
    expect(nextChunkSize(1024 * 1024, 1000)).toBe(2 * 1024 * 1024);
    expect(nextChunkSize(1024 * 1024, 10_000)).toBe(1024 * 1024);
    expect(nextChunkSize(1024 * 1024, 30_000)).toBe(512 * 1024);
    expect(nextChunkSize(CHUNK_MAX, 100)).toBe(CHUNK_MAX);
    expect(nextChunkSize(CHUNK_MIN, 60_000)).toBe(CHUNK_MIN);
  });
});
