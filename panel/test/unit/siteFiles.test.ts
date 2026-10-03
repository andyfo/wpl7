import { describe, expect, it } from 'vitest';
import {
  FILE_LIMITS,
  isSameOrInside,
  joinSiteFilePath,
  newFileNameProblem,
  parseSiteFilePath,
  siteFileBase,
  siteFileParent,
} from '../../shared/siteFilePath.js';
import { siteFileSearchQuery, sitePathSchema, siteWritablePathSchema } from '../../shared/schemas.js';
import {
  fileOpError,
  globLiteral,
  SiteFilesService,
  matchSnippet,
  parseContentMatches,
  parseEntryRecord,
  parseListing,
  parseNameMatches,
} from '../../src/services/siteFiles.js';
import { FILE_EXIT } from '../../src/services/siteFilesScripts.js';
import { attachmentDisposition } from '../../src/lib/contentDisposition.js';
import type { DockerPort, RunResult } from '../../src/services/docker.js';

/** The parts of Web FTP that are pure: path rules, parsing what the scripts print, errors. */

describe('site file paths', () => {
  it('normalises the forgivable and refuses the rest, saying why', () => {
    expect(parseSiteFilePath('')).toEqual({ ok: true, path: '' });
    expect(parseSiteFilePath('/')).toEqual({ ok: true, path: '' });
    expect(parseSiteFilePath('/wp-content/themes/')).toEqual({ ok: true, path: 'wp-content/themes' });
    expect(parseSiteFilePath('wp-content/[odd] name.php')).toEqual({ ok: true, path: 'wp-content/[odd] name.php' });
    // One slash either side is forgiven, so "//" is the site folder too.
    expect(parseSiteFilePath('//')).toEqual({ ok: true, path: '' });
    for (const bad of ['..', '../etc', 'a/../../b', 'a/./b', 'a//b', '///', 'a\0b']) {
      expect(parseSiteFilePath(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseSiteFilePath(`a/${'x'.repeat(256)}`).ok).toBe(false);
    expect(parseSiteFilePath('a/'.repeat(1100)).ok).toBe(false);
    // Bytes, not characters: 200 two-byte letters are 400 bytes.
    expect(parseSiteFilePath('ü'.repeat(128)).ok).toBe(false);
  });

  it('splits and joins', () => {
    expect(joinSiteFilePath('', 'a.txt')).toBe('a.txt');
    expect(joinSiteFilePath('wp-content', 'a.txt')).toBe('wp-content/a.txt');
    expect(siteFileParent('wp-content/a.txt')).toBe('wp-content');
    expect(siteFileParent('a.txt')).toBe('');
    expect(siteFileBase('wp-content/a.txt')).toBe('a.txt');
    expect(isSameOrInside('wp-content/themes', 'wp-content')).toBe(true);
    expect(isSameOrInside('wp-contentx', 'wp-content')).toBe(false);
  });

  it('keeps new names plain, and the panel prefix to itself', () => {
    expect(newFileNameProblem('style.css')).toBeNull();
    expect(newFileNameProblem('.htaccess')).toBeNull();
    for (const bad of ['', '.', '..', 'a/b', 'tab\there', 'line\nbreak', '.wpl7-upload-x.part', 'x'.repeat(256)]) {
      expect(newFileNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('turns those rules into request validation', () => {
    expect(sitePathSchema.parse('/wp-content/')).toBe('wp-content');
    expect(sitePathSchema.safeParse('../x').success).toBe(false);
    expect(siteWritablePathSchema.safeParse('wp-content/.wpl7-edit.abc').success).toBe(false);
    expect(siteWritablePathSchema.safeParse('').success).toBe(false);
    const q = siteFileSearchQuery.parse({ q: 'eval(', mode: 'content', include: '*.php, *.inc' });
    expect(q).toMatchObject({ path: '', case: false, regex: false, include: ['*.php', '*.inc'] });
    expect(siteFileSearchQuery.safeParse({ q: 'x', include: '$(rm -rf)' }).success).toBe(false);
  });
});

const rec = (s: string) => Buffer.from(s, 'utf8');

describe('what the scripts print', () => {
  it('reads an entry record, a link target with slashes included', () => {
    expect(parseEntryRecord(rec('rw/l/d/7/777/1727000000.5/33/33/uploads//mnt/media/uploads'))).toEqual({
      name: 'uploads',
      nameOk: true,
      type: 'link',
      target: '/mnt/media/uploads',
      targetType: 'dir',
      size: 7,
      mtimeMs: 1727000000500,
      mode: '777',
      uid: 33,
      gid: 33,
      readable: true,
      writable: true,
    });
    expect(parseEntryRecord(rec('r-/l/N/9/777/1/0/0/gone//nowhere'))).toMatchObject({ targetType: null, writable: false });
    expect(parseEntryRecord(rec('r-/f/f/0/0/1/0/0/empty/'))).toMatchObject({ mode: '000', target: null, targetType: null });
    expect(parseEntryRecord(rec('rw/f/f/cut-off'))).toBeNull();
  });

  it('keeps an invalid UTF-8 name, marked as unusable', () => {
    const bad = Buffer.concat([rec('rw/f/f/1/644/1/33/33/'), Buffer.from([0x62, 0xff]), rec('/')]);
    expect(parseEntryRecord(bad)).toMatchObject({ name: 'b\uFFFD', nameOk: false });
  });

  it('parses a listing: the folder first, then its entries, and notices a cut', () => {
    const records = [rec('r-/d/d/4096/755/1/0/0//'), rec('rw/f/f/5/644/1/33/33/a.txt/'), rec('rw/d/d/4096/755/1/33/33/b/')];
    const out = parseListing('x', Buffer.concat(records.flatMap((r) => [r, Buffer.from([0])])));
    expect(out).toMatchObject({ path: 'x', writable: false, truncated: false });
    expect(out.entries.map((e) => e.name)).toEqual(['a.txt', 'b']);
    const many = Array.from({ length: FILE_LIMITS.listEntries + 2 }, (_, i) => rec(`rw/f/f/1/644/1/33/33/f${i}/`));
    const cut = parseListing('', Buffer.concat(many.flatMap((r) => [r, Buffer.from([0])])));
    expect(cut.truncated).toBe(true);
    expect(cut.entries).toHaveLength(FILE_LIMITS.listEntries);
  });

  it('parses name matches, relative to the folder searched, and the timeout marker', () => {
    const out = parseNameMatches('wp-content', Buffer.from('f/plugins/x/evil.php\0d/uploads/2026\0T/timeout\0', 'latin1'));
    expect(out).toEqual({
      matches: [
        { path: 'wp-content/plugins/x/evil.php', type: 'file' },
        { path: 'wp-content/uploads/2026', type: 'dir' },
      ],
      truncated: false,
      timedOut: true,
    });
  });

  it('parses content matches, colons in the text included', () => {
    const out = parseContentMatches('', Buffer.from('./a.php\x003:$x = "a:b";\n./b.js\x0012:c\n\x00TIMEOUT\n'));
    expect(out).toEqual({
      matches: [
        { path: 'a.php', line: 3, text: '$x = "a:b";' },
        { path: 'b.js', line: 12, text: 'c' },
      ],
      truncated: false,
      timedOut: true,
    });
  });

  it('keeps a match in a file whose name holds a line break with that file', () => {
    const out = parseContentMatches('', Buffer.from('./odd\nname.php\x007:eval(x)\n./b.php\x001:ok\n'));
    expect(out.matches.map((m) => [m.path, m.line])).toEqual([
      ['odd\nname.php', 7],
      ['b.php', 1],
    ]);
    // A record cut off by the output cap is dropped, not half-read.
    expect(parseContentMatches('', Buffer.from('./a.php\x001:ok\n./b.php\x002:cut of')).matches).toHaveLength(1);
  });

  it('shows the part of a long line where the match is', () => {
    const line = `${'x'.repeat(5000)}eval(base64_decode(${'y'.repeat(5000)}`;
    const shown = matchSnippet(line, 'EVAL(', { regex: false, caseSensitive: false });
    expect(shown.length).toBeLessThanOrEqual(502);
    expect(shown).toContain('eval(base64_decode(');
    expect(shown.startsWith('…') && shown.endsWith('…')).toBe(true);
    expect(matchSnippet(line, 'eval', { regex: true, caseSensitive: true })).toBe(`${'x'.repeat(500)}…`);
    expect(matchSnippet('short', 'x', { regex: false, caseSensitive: true })).toBe('short');
  });

  it('makes a name search literal', () => {
    expect(globLiteral('[odd]*?.php\\x')).toBe('\\[odd\\]\\*\\?.php\\\\x');
  });
});

describe('script exit codes as HTTP errors', () => {
  it('maps each refusal to its status', () => {
    const at = { op: 'save', path: 'wp-config.php' };
    expect(fileOpError(FILE_EXIT.notFound, '', at)).toMatchObject({ statusCode: 404 });
    expect(fileOpError(FILE_EXIT.denied, '', at)).toMatchObject({ statusCode: 403, code: 'forbidden' });
    expect(fileOpError(FILE_EXIT.exists, '', at)).toMatchObject({ statusCode: 409 });
    expect(fileOpError(FILE_EXIT.exists, '', { ...at, createOnly: true })).toMatchObject({ statusCode: 412 });
    expect(fileOpError(FILE_EXIT.changed, '', at)).toMatchObject({ statusCode: 412, code: 'precondition_failed' });
    expect(fileOpError(FILE_EXIT.offset, '', { ...at, stdout: '4096' })).toMatchObject({ statusCode: 409, details: { received: 4096 } });
    expect(fileOpError(FILE_EXIT.busy, '', at)).toMatchObject({ statusCode: 409, code: 'conflict' });
    expect(fileOpError(99, 'boom', at)).toMatchObject({ statusCode: 502, details: 'boom' });
    expect(fileOpError(1, 'cat: write error: No space left on device', at).message).toMatch(/out of disk space/);
  });

  it('turns a PHP parse error into its line and message', () => {
    const err = fileOpError(
      FILE_EXIT.syntax,
      'PHP Parse error:  syntax error, unexpected token "}" in Standard input code on line 7\nErrors parsing Standard input code\n',
      { op: 'save', path: 'functions.php' },
    );
    expect(err).toMatchObject({ statusCode: 422, code: 'syntax_error', details: { line: 7 } });
    expect(err.message).toBe('Not saved: functions.php does not parse as PHP (line 7) - syntax error, unexpected token "}"');
  });
});

describe('Content-Disposition for a name off a site disk', () => {
  it('quotes a plain name and encodes the rest', () => {
    expect(attachmentDisposition('style.css')).toBe(`attachment; filename="style.css"; filename*=UTF-8''style.css`);
    expect(attachmentDisposition('résumé "v2".pdf')).toBe(
      `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`,
    );
  });

  it('drops what could split the header or disguise the name', () => {
    const header = attachmentDisposition('a\r\nSet-Cookie: x=1\u202Efdp.php');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain('\u202E');
    expect(attachmentDisposition('\u0001\u0002')).toContain('filename="download"');
  });
});

describe('upload chunks', () => {
  /** A container whose every append waits to be let go, counting how many run at once. */
  function slowContainer(answer: RunResult) {
    const waiting: (() => void)[] = [];
    let running = 0;
    const seen = { most: 0, calls: 0 };
    const docker = {
      async execWithInput(): Promise<RunResult> {
        seen.calls++;
        seen.most = Math.max(seen.most, ++running);
        await new Promise<void>((resolve) => waiting.push(resolve));
        running--;
        return answer;
      },
    };
    const letOneGo = async () => {
      while (waiting.length === 0) await new Promise((r) => setTimeout(r, 5));
      waiting.shift()!();
    };
    return { files: new SiteFilesService(docker as unknown as DockerPort), seen, letOneGo };
  }

  const upload = { path: 'a.txt', id: 'abcdefghijklmnop', offset: 0, size: 3, overwrite: false };
  const record = 'rw/f/f/3/644/1727000000.25/33/33/a.txt/\0';

  it('handles one chunk of an upload at a time, and answers a resent last chunk without writing again', async () => {
    const { files, seen, letOneGo } = slowContainer({ stdout: record, stderr: '', exitCode: 0 });
    // The answer to the first copy is lost; the client sends it again while it is still running.
    const first = files.appendChunk('wp-a', upload, Buffer.from('abc'));
    const resent = files.appendChunk('wp-a', upload, Buffer.from('abc'));
    await letOneGo();
    const [a, b] = await Promise.all([first, resent]);
    expect(seen).toEqual({ most: 1, calls: 1 });
    expect(a).toMatchObject({ received: 3, written: { path: 'a.txt', entry: { size: 3 } } });
    expect(a).not.toHaveProperty('replayed');
    expect(b).toEqual({ ...a, replayed: true });

    // Only that same chunk is answered from memory; anything else goes to the container.
    const other = files.appendChunk('wp-a', upload, Buffer.from('xyz'));
    await letOneGo();
    await other;
    expect(seen.calls).toBe(2);
  });

  it('keeps different uploads apart', async () => {
    const { files, seen, letOneGo } = slowContainer({ stdout: '', stderr: '', exitCode: 0 });
    const one = files.appendChunk('wp-a', { ...upload, size: 10 }, Buffer.from('abc'));
    const two = files.appendChunk('wp-a', { ...upload, id: 'ponmlkjihgfedcba', size: 10 }, Buffer.from('abc'));
    await letOneGo();
    await letOneGo();
    await Promise.all([one, two]);
    expect(seen.most).toBe(2);
  });
});
