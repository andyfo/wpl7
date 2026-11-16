/**
 * A `docker save` archive read and written anew before a load: every name it carries is found,
 * wherever a reader would take it from, and replaced; what Go's reader and another could take two
 * ways is refused; and what goes to the daemon is plain ustar a strict reader reads back. Last, a
 * file read out of an image (`readImageFile`), which stops at 1 MiB. The real stores' behaviour is
 * in test/engine/containerImages.test.ts and the SSH e2e; here the archives are written by hand.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import type Docker from 'dockerode';
import { afterAll, describe, expect, it } from 'vitest';
import { TarWriter } from '../../src/lib/tarWriter.js';
import { DockerService } from '../../src/services/docker.js';
import { fileFromTar, inspectArchive, normalImageName, renamedArchive } from '../../src/services/imageArchive.js';

const BLOCK = 512;

/** A header block of any type, as Go's tar writer would make it (POSIX ustar); its size in base-256 when asked. */
function rawHeader(name: string, size: number, type: string, linkname = '', opts: { base256?: boolean } = {}): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  if (opts.base256) {
    block[124] = 0x80;
    let rest = BigInt(size);
    for (let i = 135; i > 124; i--, rest >>= 8n) block[i] = Number(rest & 0xffn);
  } else {
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  }
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of block) sum += b;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
const entry = (name: string, data: Buffer, type = '0') => Buffer.concat([rawHeader(name, data.length, type), data, pad(data.length)]);
const folder = (name: string) => rawHeader(name, 0, '5');
const link = (name: string, target: string) => rawHeader(name, 0, '2', target);
/** A GNU long name ('L') or long link ('K'), as GNU tar writes one ahead of its entry. */
const longEntry = (name: string, type: 'L' | 'K') => entry('././@LongLink', Buffer.from(`${name}\0`), type);

function paxBody(records: Record<string, string>): Buffer {
  return Buffer.from(
    Object.entries(records)
      .map(([k, v]) => {
        const rest = ` ${k}=${v}\n`;
        let len = rest.length + 1;
        while (`${len}${rest}`.length !== len) len = `${len}${rest}`.length;
        return `${len}${rest}`;
      })
      .join(''),
  );
}
const paxEntry = (records: Record<string, string>) => entry('PaxHeaders/x', paxBody(records), 'x');
const globalPax = (records: Record<string, string>) => entry('GlobalHead', paxBody(records), 'g');

const END = Buffer.alloc(BLOCK * 2);
const BLOB = crypto.randomBytes(3000);
const blobName = `blobs/sha256/${crypto.createHash('sha256').update(BLOB).digest('hex')}`;

const manifest = (tags: string[] | null, n = 1) =>
  Buffer.from(JSON.stringify(Array.from({ length: n }, () => ({ Config: blobName, RepoTags: tags, Layers: [blobName] }))));
const index = (name: string | null, n = 1) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: Array.from({ length: n }, () => ({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${'a'.repeat(64)}`,
        size: 1,
        annotations: name ? { 'io.containerd.image.name': `docker.io/library/${name}`, 'org.opencontainers.image.ref.name': name.split(':')[1]!, other: 'kept' } : {},
      })),
    }),
  );
const repositories = (repo: string, tag: string) => Buffer.from(JSON.stringify({ [repo]: { [tag]: 'abc' } }));

const folders: string[] = [];
afterAll(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
});

function write(parts: Buffer[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-archive-'));
  folders.push(dir);
  const file = path.join(dir, 'image.tar');
  fs.writeFileSync(file, Buffer.concat([...parts, END]));
  return file;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** As the classic store saves an image: blobs first, then the three name files and the layout. */
const classic = (name: string) =>
  write([entry(blobName, BLOB), entry('index.json', index(name)), entry('manifest.json', manifest([name])), entry('oci-layout', Buffer.from('{}')), entry('repositories', repositories(name.split(':')[0]!, name.split(':')[1]!))]);

/** Why pass 1 refuses an archive of these parts, with a blob and a manifest of its own ahead of them; null when it does not. */
const refusal = async (...parts: Buffer[]) => (await inspectArchive(write([entry(blobName, BLOB), entry('manifest.json', manifest(['x:1'])), ...parts]))).problem;

interface Read {
  name: string;
  type: string;
  link: string;
  data: Buffer;
}

/**
 * An archive as a strict reader takes it: every header plain ustar with a good checksum, of a file,
 * a folder or a link, owned by root with the panel's modes, a size in octal or base-256; no PAX or
 * GNU record; two zero blocks at the end and nothing after them.
 */
function strictRead(tar: Buffer): Read[] {
  const out: Read[] = [];
  for (let offset = 0; ; ) {
    const block = tar.subarray(offset, offset + BLOCK);
    expect(block.length).toBe(BLOCK);
    if (block.every((b) => b === 0)) {
      expect(tar.length - offset).toBe(BLOCK * 2);
      expect(tar.subarray(offset).every((b) => b === 0)).toBe(true);
      return out;
    }
    const text = (start: number, length: number) => {
      const field = block.subarray(start, start + length);
      const nul = field.indexOf(0);
      return field.subarray(0, nul === -1 ? length : nul).toString('latin1');
    };
    expect(block.toString('latin1', 257, 265)).toBe('ustar\u000000');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    expect(block.toString('latin1', 148, 156)).toBe(`${sum.toString(8).padStart(6, '0')}\0 `);
    const type = block.toString('latin1', 156, 157);
    expect(['0', '5', '2']).toContain(type);
    expect(block.toString('latin1', 100, 108)).toBe({ '0': '0000644\0', '5': '0000755\0', '2': '0000777\0' }[type]);
    expect(block.toString('latin1', 108, 124)).toBe('0000000\u00000000000\u0000');
    const field = block.subarray(124, 136);
    let size = 0;
    if (field[0] === 0x80) for (let i = 1; i < 12; i++) size = size * 256 + field[i]!;
    else size = parseInt(field.toString('latin1', 0, 11), 8);
    if (type !== '0') expect(size).toBe(0);
    const prefix = text(345, 155);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    out.push({ name, type, link: text(157, 100), data: tar.subarray(offset + BLOCK, offset + BLOCK + size) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
}

const renamed = async (file: string, name = 'wpl7-app-shop:u1') => strictRead(await streamToBuffer(renamedArchive(file, await inspectArchive(file), name)));
const json = (read: Read[], name: string): unknown => JSON.parse(read.find((e) => e.name === name)!.data.toString('utf8'));

describe('reading an archive before it is loaded', () => {
  it('finds the names in all three places, as a daemon lists them', async () => {
    const info = await inspectArchive(classic('wpl7-wordpress:php8.4'));
    expect(info.problem).toBeNull();
    expect(info.images).toBe(1);
    expect(info.names).toEqual(['wpl7-wordpress:php8.4']);
    expect(normalImageName('docker.io/library/traefik:v3.7')).toBe('traefik:v3.7');
  });

  it('reads a name that only one place carries', async () => {
    const onlyIndex = write([entry(blobName, BLOB), entry('index.json', index('traefik:v3.9')), entry('manifest.json', manifest(null))]);
    expect((await inspectArchive(onlyIndex)).names).toEqual(['traefik:v3.9']);
  });

  it('takes a PAX path as the entry’s name, as Go’s reader does, so a manifest cannot hide behind one', async () => {
    const hidden = write([entry(blobName, BLOB), paxEntry({ path: 'manifest.json' }), entry('innocent.txt', manifest(['mariadb:11.4']))]);
    const info = await inspectArchive(hidden);
    expect(info.names).toEqual(['mariadb:11.4']);
    expect(info.entries.find((e) => e.name === 'manifest.json')).toBeDefined();
  });

  it('refuses an archive of two images, a name file that is a link or comes twice, and one without a manifest', async () => {
    expect((await inspectArchive(write([entry('manifest.json', manifest(['a:1'], 2))]))).problem).toMatch(/2 images/);
    const link = Buffer.concat([rawHeader('manifest.json', 0, '2', 'blobs/sha256/x')]);
    expect((await inspectArchive(write([entry(blobName, BLOB), link]))).problem).toMatch(/not a plain file/);
    expect((await inspectArchive(write([entry('manifest.json', manifest(['a:1'])), entry('manifest.json', manifest(['b:1']))]))).problem).toMatch(/twice/);
    expect((await inspectArchive(write([entry(blobName, BLOB)]))).problem).toMatch(/no manifest\.json/);
    expect((await inspectArchive(write([Buffer.from('not a tar at all'.padEnd(BLOCK, 'x'))]))).problem).toMatch(/not a tar/);
  });

  it('refuses a manifest.json or index.json that is no docker save’s, before a load could stumble on it', async () => {
    for (const bad of ['[null]', '[{"Config":1}]', '{"Config":"a"}', '[{"Config":"a","RepoTags":"x:1"}]', '[{"Config":"a","Layers":{}}]']) {
      expect((await inspectArchive(write([entry('manifest.json', Buffer.from(bad))]))).problem, bad).toBe("The archive's manifest.json is not one docker save writes.");
    }
    for (const bad of ['null', '[]', '{"manifests":{}}', '{"manifests":[{"annotations":{"a":1}}]}']) {
      expect((await inspectArchive(write([entry('index.json', Buffer.from(bad)), entry('manifest.json', manifest(['x:1']))]))).problem, bad).toBe("The archive's index.json is not one docker save writes.");
    }
  });
});

describe('what Go’s reader and another could take two ways', () => {
  // Each archive below carries a second manifest.json, naming an image the server has, where an
  // older pass 1 did not see one and Go's reader (the daemon's) does.
  const victim = () => manifest(['wpl7-wordpress:php8.4']);

  it('refuses a folder or a link with a size: Go gives it no data, so the size would hide what follows', async () => {
    const hidden = entry('manifest.json', victim());
    expect(await refusal(rawHeader('blobs/', hidden.length, '5'), hidden)).toBe('The archive\'s "blobs/" is a folder with a size: readers disagree on where the next entry starts.');
    // An old-style file whose name ends in "/" is a folder to Go.
    expect(await refusal(rawHeader('blobs/', hidden.length, '\0'), hidden)).toMatch(/"blobs\/" is a folder with a size/);
    expect(await refusal(rawHeader('l', hidden.length, '2', blobName), hidden)).toMatch(/"l" is a link with a size/);
    // ...and a PAX size on one, which Go ignores for it as well.
    expect(await refusal(paxEntry({ size: String(hidden.length) }), folder('blobs/'), hidden)).toMatch(/is a folder with a size/);
  });

  it('refuses names a reader would clean into another, and any that is not plain', async () => {
    expect(await refusal(entry('/manifest.json', victim()))).toBe('The archive\'s "/manifest.json" starts with "/": names in an image archive are relative.');
    // Only `.` and `./` are the archive's own folder, which goes; `/` and `.//` are no names of it.
    expect(await refusal(folder('/'))).toBe('The archive\'s "/" starts with "/": names in an image archive are relative.');
    expect(await refusal(folder('./'), folder('.'), entry('./x', BLOB))).toBeNull();
    expect(await refusal(entry('./', BLOB))).toBe('The archive\'s "./" names the archive\'s own folder, and is not a folder.');
    // A "/" left once "./" goes is an empty part: the name itself does not start with one.
    expect(await refusal(folder('.//'))).toBe('The archive\'s ".//" has an empty, "." or ".." part.');
    for (const name of ['.//manifest.json', 'a/../manifest.json', 'blobs/./x', 'blobs//x', '..']) {
      expect(await refusal(entry(name, victim())), name).toBe(`The archive's ${JSON.stringify(name)} has an empty, "." or ".." part.`);
    }
    for (const name of ['blobs/a b', 'blobs/a\u0001', 'blobs/ü', 'a\\b']) {
      expect(await refusal(entry(name, BLOB)), name).toMatch(/has a character other than letters, digits and \._@:\+=,~-\.$/);
    }
    expect(await refusal(paxEntry({ path: 'x'.repeat(101) }), entry('long', BLOB))).toMatch(/is too long for a plain tar header\.$/);
    // "./" in front is what every reader strips: then it is one name twice.
    expect(await refusal(entry('./././manifest.json', victim()))).toBe('The archive has manifest.json twice.');
  });

  it('refuses two extended headers of one kind for an entry, which Go would not merge', async () => {
    // Merged, the path is innocent.txt; to Go, only the last counts and the name is manifest.json.
    expect(await refusal(paxEntry({ path: 'innocent.txt' }), paxEntry({ mtime: '1' }), entry('manifest.json', victim()))).toBe(
      'An entry in the archive has two extended headers of one kind: readers disagree on which one counts.',
    );
    expect(await refusal(longEntry('innocent.txt', 'L'), longEntry('manifest.json', 'L'), entry('x', victim()))).toMatch(/two extended headers of one kind/);
    expect(await refusal(longEntry(blobName, 'K'), paxEntry({ mtime: '1' }), longEntry('x', 'K'), link('l', 'y'))).toMatch(/two extended headers of one kind/);
  });

  it('refuses a PAX name beside a GNU long one: Go takes the long one', async () => {
    expect(await refusal(paxEntry({ path: 'innocent.txt' }), longEntry('manifest.json', 'L'), entry('x', victim()))).toBe(
      'An entry in the archive has both a PAX name and a GNU long name: readers disagree on which one counts.',
    );
    expect(await refusal(paxEntry({ linkpath: blobName }), longEntry('manifest.json', 'K'), link('l', 'x'))).toMatch(/both a PAX name and a GNU long name/);
  });

  it('refuses a global header, which clears what comes before it in Go', async () => {
    expect(await refusal(paxEntry({ path: 'innocent.txt' }), globalPax({}), entry('manifest.json', victim()))).toBe('The archive has a global extended header, which no docker save writes.');
  });

  it('refuses a sparse file: GNU.sparse.name renames an entry in Go', async () => {
    expect(await refusal(paxEntry({ 'GNU.sparse.major': '1', 'GNU.sparse.minor': '0', 'GNU.sparse.name': 'manifest.json' }), entry('innocent.txt', victim()))).toBe(
      'The archive has a sparse file, which no docker save writes.',
    );
  });

  it('refuses a PAX size that is not a plain decimal number, records that do not read, and a header that belongs to no entry', async () => {
    for (const size of ['0x10', '1e3', ' 16', '+16', '-1', '16.0']) {
      expect(await refusal(paxEntry({ size }), entry('a', Buffer.alloc(16))), size).toBe('An extended header in the archive gives a size that is not a plain number.');
    }
    for (const body of ['12 path=x\nzz', '7 path\n', '3 =x\n', '6 =xy\n', '99 path=x\n', 'x path=y\n']) {
      expect(await refusal(entry('PaxHeaders/x', Buffer.from(body), 'x'), entry('a', BLOB)), body).toBe('An extended header in the archive is malformed.');
    }
    expect(await refusal(paxEntry({ path: 'a' }))).toBe('The archive ends with an extended header that belongs to no entry.');
  });

  it('refuses anything but files, folders and symbolic links', async () => {
    const types: [string, string][] = [
      ['1', 'a hard link'],
      ['3', 'a character device'],
      ['4', 'a block device'],
      ['6', 'a FIFO'],
      ['7', 'a contiguous file'],
      ['S', 'a sparse file'],
      ['V', 'of tar type "V"'],
    ];
    for (const [type, what] of types) {
      expect(await refusal(rawHeader('odd', 0, type, type === '1' ? 'manifest.json' : '')), type).toBe(`The archive's "odd" is ${what}: an image archive holds only files, folders and symbolic links.`);
    }
  });

  it('refuses any name twice: a file, a folder or a link', async () => {
    expect(await refusal(folder('blobs/'), folder('blobs'))).toBe('The archive has blobs twice.');
    expect(await refusal(entry('layer', BLOB), folder('layer/'))).toBe('The archive has layer twice.');
    expect(await refusal(link('l', blobName), link('l', blobName))).toBe('The archive has l twice.');
  });

  it('refuses an entry under a link, which an unpacked archive would write through, and one under a file', async () => {
    // The classic store unpacks into a folder: d/x through d -> blobs is blobs/x.
    expect(await refusal(folder('blobs/'), link('d', 'blobs'), entry('d/x', BLOB))).toBe(
      "The archive's d/x is under the link d: a load that unpacks the archive would write through it.",
    );
    // Through d -> . it would be the root's manifest.json, but that link is refused as soon as it is read.
    expect(await refusal(link('d', '.'), entry('d/manifest.json', victim()))).toBe('The archive\'s link d points at ".", which is not a file in the archive.');
    expect(await refusal(entry('d/manifest.json', victim()), link('d', blobName))).toMatch(/d\/manifest\.json is under the link d:/);
    expect(await refusal(entry('layer', BLOB), entry('layer/x', BLOB))).toBe("The archive's layer/x is under the file layer.");
  });

  it('refuses a link that is not a plain way to a file in the archive', async () => {
    for (const target of ['.', '..', '/etc/passwd', '../outside', 'missing.tar', 'blobs', 'other', 'blobs/../manifest.json', `./${blobName}`, 'a//b']) {
      expect(await refusal(folder('blobs/'), link('other', blobName), link('l', target)), target).toBe(`The archive's link l points at ${JSON.stringify(target)}, which is not a file in the archive.`);
    }
    // A file it could point at, by a target longer than the 100 bytes a plain header holds.
    const far = `${'n'.repeat(90)}/${'m'.repeat(20)}`;
    expect(await refusal(longEntry(far, 'L'), entry('x', BLOB), longEntry(`../${far}`, 'K'), link('a/l', 'x'))).toMatch(
      /^The archive's link a\/l points at "\.\.\/n+\/m+…", which is too long for a plain tar header\.$/,
    );
    // In a name file's place, a link is not a plain file.
    expect(await refusal(link('oci-layout', blobName))).toBe("The archive's oci-layout is not a plain file.");
  });

  it('refuses a link by its target as soon as it is read, and keeps a small, bounded amount for each entry', async () => {
    // Before the next entry is read: a GNU long link or a PAX header can make a target 64 KiB, and
    // the walk would keep each one to its end. Past the link, the second manifest.json would be refused.
    const linked = await inspectArchive(
      write([entry(blobName, BLOB), entry('manifest.json', manifest(['x:1'])), longEntry('t'.repeat(101), 'K'), link('l', 'x'), entry('manifest.json', victim())]),
    );
    expect(linked.problem).toBe(`The archive's link l points at "${'t'.repeat(100)}…", which is too long for a plain tar header.`);
    expect(linked.entries.map((e) => e.name)).toEqual([blobName, 'manifest.json']);
    expect(await refusal(link('l', '../outside'), entry('manifest.json', victim()))).toBe('The archive\'s link l points at "../outside", which is not a file in the archive.');
    // Each name is kept as a copy of its own: a slice of a 64 KiB PAX path or GNU long name that is
    // "./" up to a short name would keep all 64 KiB.
    const n = 400;
    const prefixed = (i: number) => `${'./'.repeat(32 * 1024 - 32)}file-${String(i).padStart(20, '0')}`;
    const file = write([
      entry(blobName, BLOB),
      entry('manifest.json', manifest(['x:1'])),
      ...Array.from({ length: n }, (_, i) => [i % 2 ? paxEntry({ path: prefixed(i) }) : longEntry(prefixed(i), 'L'), entry('x', Buffer.alloc(0))]).flat(),
    ]);
    // A full collection on either side, so the difference is what the walk keeps.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    const before = process.memoryUsage().heapUsed;
    const named = await inspectArchive(file);
    gc();
    const kept = process.memoryUsage().heapUsed - before;
    expect(named.problem).toBeNull();
    expect(named.entries).toHaveLength(n + 2);
    expect(named.entries.slice(2, 4).map((e) => e.name)).toEqual([`file-${'0'.repeat(20)}`, `file-${'1'.padStart(20, '0')}`]);
    // Under 1 KiB an entry as it is; 64 KiB when an entry kept its raw name.
    expect(kept / n).toBeLessThan(16 * 1024);
  });

  it('stops at 10,000 entries, and at an extended header of more than 64 KiB', async () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => rawHeader(`f${i}`, 0, '0'));
    expect((await inspectArchive(write([entry('manifest.json', manifest(['x:1'])), ...files(9_999)]))).problem).toBeNull();
    expect((await inspectArchive(write([entry('manifest.json', manifest(['x:1'])), ...files(10_000)]))).problem).toBe(
      "The archive has more than 10,000 entries; one image's docker save has far fewer.",
    );
    expect(await refusal(paxEntry({ comment: 'x'.repeat(64 * 1024) }), entry('a', BLOB))).toBe('An extended header in the archive is too large.');
    expect(await refusal(longEntry('a'.repeat(64 * 1024), 'L'), entry('a', BLOB))).toBe('An extended header in the archive is too large.');
  });
});

describe('renaming an archive', () => {
  it('leaves the panel’s name in every place, drops the old format, and passes every other byte as it was', async () => {
    const file = classic('wpl7-wordpress:php8.4');
    const info = await inspectArchive(file);
    const out = path.join(path.dirname(file), 'renamed.tar');
    fs.writeFileSync(out, await streamToBuffer(renamedArchive(file, info, 'wpl7-app-orders:uabc')));
    const again = await inspectArchive(out);
    expect(again.problem).toBeNull();
    expect(again.names).toEqual(['wpl7-app-orders:uabc']);
    expect(again.entries.map((e) => e.name)).toEqual([blobName, 'index.json', 'manifest.json', 'oci-layout']);
    expect(again.index?.manifests?.[0]?.annotations).toMatchObject({
      'io.containerd.image.name': 'docker.io/library/wpl7-app-orders:uabc',
      'org.opencontainers.image.ref.name': 'uabc',
      other: 'kept',
    });
    const blob = fileFromTar(fs.readFileSync(out), blobName);
    expect(blob && 'data' in blob && blob.data.equals(BLOB)).toBe(true);
  });

  it('refuses to rename what it refused to read', async () => {
    const two = write([entry('manifest.json', manifest(['a:1'], 2))]);
    expect(() => renamedArchive(two, { problem: 'x' } as never, 'n:1')).toThrow('x');
    const linked = write([entry(blobName, BLOB), entry('manifest.json', manifest(['x:1'])), folder('blobs/'), link('d', 'blobs'), entry('d/x', BLOB)]);
    const info = await inspectArchive(linked);
    expect(() => renamedArchive(linked, info, 'n:1')).toThrow(/under the link d/);
  });

  it('writes a plain tar the panel’s own writer reads back', async () => {
    const tar = new TarWriter();
    void (async () => {
      await tar.addFile({ name: 'manifest.json', mode: 0o644, mtime: 0 }, manifest(['x:1']));
      await tar.finish();
    })();
    const file = write([await streamToBuffer(tar)]);
    // TarWriter ends with its own end blocks; the extra ones `write` adds are read as the end too.
    const info = await inspectArchive(file);
    expect(info.names).toEqual(['x:1']);
  });

  it('writes every entry anew: plain ustar headers of its own, and not one PAX or GNU record of the upload’s', async () => {
    const longFolder = `blobs/${'f'.repeat(90)}/${'g'.repeat(40)}`;
    const longFile = `${longFolder}/${'h'.repeat(60)}`;
    const file = write([
      folder('./'),
      paxEntry({ path: `${longFolder}/`, mtime: '1700000000.5', 'SCHILY.xattr.user.x': 'y' }),
      rawHeader('PaxHeaders/ignored', 0, '5'),
      longEntry(longFile, 'L'),
      entry('././@LongLink', BLOB),
      entry(`./${blobName}`, BLOB),
      paxEntry({ uname: 'someone', 'LIBARCHIVE.creationtime': '1' }),
      link('l', blobName),
      entry('index.json', index('traefik:v3.7')),
      entry('manifest.json', manifest(['traefik:v3.7'])),
      entry('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}')),
      entry('repositories', repositories('traefik', 'v3.7')),
    ]);
    const out = await renamed(file);
    expect(out.map((e) => [e.name, e.type, e.link])).toEqual([
      [`${longFolder}/`, '5', ''],
      [longFile, '0', ''],
      [blobName, '0', ''],
      ['l', '2', blobName],
      ['index.json', '0', ''],
      ['manifest.json', '0', ''],
      ['oci-layout', '0', ''],
    ]);
    expect(out[1]!.data.equals(BLOB) && out[2]!.data.equals(BLOB)).toBe(true);
    expect(out[6]!.data.toString()).toBe('{"imageLayoutVersion":"1.0.0"}');
    expect(json(out, 'manifest.json')).toEqual([{ Config: blobName, RepoTags: ['wpl7-app-shop:u1'], Layers: [blobName] }]);
  });

  it('writes manifest.json and index.json with only the fields a load reads: Go’s JSON reader takes a key in any case', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const sneaky = write([
      entry(blobName, BLOB),
      entry(
        'index.json',
        Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [
              {
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                digest,
                size: 1,
                platform: { architecture: 'amd64', os: 'linux' },
                annotations: { other: 'kept' },
                Annotations: { 'io.containerd.image.name': 'docker.io/library/traefik:v3.7' },
              },
            ],
            Manifests: [{ digest, annotations: { 'io.containerd.image.name': 'docker.io/library/mariadb:11.4' } }],
            annotations: { 'io.containerd.image.name': 'docker.io/library/mariadb:11.4' },
          }),
        ),
      ),
      entry('manifest.json', Buffer.from(JSON.stringify([{ Config: blobName, RepoTags: ['x:1'], Layers: [blobName], repotags: ['wpl7-wordpress:php8.4'], Parent: `sha256:${'e'.repeat(64)}` }]))),
      entry('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}')),
    ]);
    const out = await renamed(sneaky);
    expect(json(out, 'manifest.json')).toEqual([{ Config: blobName, RepoTags: ['wpl7-app-shop:u1'], Layers: [blobName] }]);
    expect(json(out, 'index.json')).toEqual({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest,
          size: 1,
          platform: { architecture: 'amd64', os: 'linux' },
          annotations: { other: 'kept', 'io.containerd.image.name': 'docker.io/library/wpl7-app-shop:u1', 'org.opencontainers.image.ref.name': 'u1' },
        },
      ],
    });
  });

  it('keeps the <id>/layer.tar links podman, skopeo and Docker before 25 write, and renames the archive', async () => {
    const [id1, id2, layer, config] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64)) as [string, string, string, string];
    const tags = ['docker.io/library/traefik:v3.7'];
    // containers/image: the layers at the root, and a folder per layer with a link to its file.
    const podman = write([
      entry(`${layer}.tar`, BLOB),
      entry(`${config}.json`, Buffer.from('{}')),
      link(`${id1}/layer.tar`, `../${layer}.tar`),
      entry(`${id1}/VERSION`, Buffer.from('1.0')),
      entry(`${id1}/json`, Buffer.from('{}')),
      entry('manifest.json', Buffer.from(JSON.stringify([{ Config: `${config}.json`, RepoTags: tags, Layers: [`${layer}.tar`] }]))),
      entry('repositories', repositories('traefik', 'v3.7')),
    ]);
    expect((await inspectArchive(podman)).names).toEqual(['traefik:v3.7']);
    const fromPodman = await renamed(podman);
    expect(fromPodman.map((e) => [e.name, e.type, e.link])).toEqual([
      [`${layer}.tar`, '0', ''],
      [`${config}.json`, '0', ''],
      [`${id1}/layer.tar`, '2', `../${layer}.tar`],
      [`${id1}/VERSION`, '0', ''],
      [`${id1}/json`, '0', ''],
      ['manifest.json', '0', ''],
    ]);
    expect(json(fromPodman, 'manifest.json')).toEqual([{ Config: `${config}.json`, RepoTags: ['wpl7-app-shop:u1'], Layers: [`${layer}.tar`] }]);
    // Docker before 25: a folder per layer, and a link where a layer comes again.
    const legacy = write([
      folder(`${id1}/`),
      entry(`${id1}/VERSION`, Buffer.from('1.0')),
      entry(`${id1}/layer.tar`, BLOB),
      folder(`${id2}/`),
      link(`${id2}/layer.tar`, `../${id1}/layer.tar`),
      entry(`${config}.json`, Buffer.from('{}')),
      entry('manifest.json', Buffer.from(JSON.stringify([{ Config: `${config}.json`, RepoTags: tags, Layers: [`${id1}/layer.tar`, `${id2}/layer.tar`] }]))),
      entry('repositories', repositories('traefik', 'v3.7')),
    ]);
    expect((await renamed(legacy)).map((e) => [e.name, e.type, e.link])).toEqual([
      [`${id1}/`, '5', ''],
      [`${id1}/VERSION`, '0', ''],
      [`${id1}/layer.tar`, '0', ''],
      [`${id2}/`, '5', ''],
      [`${id2}/layer.tar`, '2', `../${id1}/layer.tar`],
      [`${config}.json`, '0', ''],
      ['manifest.json', '0', ''],
    ]);
  });

  it('reads a base-256 size as Go does, and writes one for 8 GiB and more', async () => {
    const small = write([Buffer.concat([rawHeader(blobName, BLOB.length, '0', '', { base256: true }), BLOB, pad(BLOB.length)]), entry('manifest.json', manifest(['x:1']))]);
    expect((await renamed(small)).find((e) => e.name === blobName)?.data.equals(BLOB)).toBe(true);
    // 8 GiB and a byte, in a sparse file: only its headers are read, and only the first one written.
    const huge = 8 * 1024 ** 3 + 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-archive-'));
    const file = path.join(dir, 'huge.tar');
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, rawHeader(blobName, huge, '0', '', { base256: true }), 0, BLOCK, 0);
      fs.writeSync(fd, Buffer.concat([entry('manifest.json', manifest(['x:1'])), END]), 0, undefined, BLOCK + Math.ceil(huge / BLOCK) * BLOCK);
    } finally {
      fs.closeSync(fd);
    }
    try {
      const info = await inspectArchive(file);
      expect(info.problem).toBeNull();
      expect(info.entries.map((e) => [e.name, e.size])).toEqual([
        [blobName, huge],
        ['manifest.json', manifest(['x:1']).length],
      ]);
      let first = Buffer.alloc(0);
      for await (const chunk of renamedArchive(file, info, 'wpl7-app-shop:u1')) {
        first = Buffer.concat([first, chunk as Buffer]);
        if (first.length >= BLOCK) break;
      }
      expect([...first.subarray(124, 136)]).toEqual([0x80, 0, 0, 0, 0, 0, 0, 0x02, 0, 0, 0, 0x01]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a file read out of an image', () => {
  function docker(answer: () => Readable) {
    const removed: unknown[] = [];
    const fake = {
      createContainer: async () => ({ getArchive: async () => answer(), remove: async (opts: unknown) => void removed.push(opts) }),
    } as unknown as Docker;
    return { service: new DockerService('proxy', 'db', fake), removed };
  }

  it('is the file’s bytes, as Docker sends it', async () => {
    const passwd = Buffer.from('root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000::/app:/bin/sh\n');
    const { service, removed } = docker(() => Readable.from([paxEntry({ 'SCHILY.xattr.user.x': 'y' }), entry('passwd', passwd), END]));
    expect((await service.readImageFile('wpl7-app-shop:u1', '/etc/passwd'))?.equals(passwd)).toBe(true);
    expect(removed).toEqual([{ force: true, v: true }]);
    // 1 MiB is still read whole, with its headers.
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const atMost = docker(() => Readable.from([paxEntry({ 'SCHILY.xattr.user.x': 'y' }), entry('group', big), END]));
    expect((await atMost.service.readImageFile('wpl7-app-shop:u1', '/etc/group'))?.equals(big)).toBe(true);
  });

  it('stops past 1 MiB, so a huge /etc/passwd costs the panel no memory, and says what to do', async () => {
    let sent = 0;
    const { service, removed } = docker(() =>
      Readable.from(
        (function* () {
          yield rawHeader('passwd', 16 * 1024 * 1024, '0');
          for (let i = 0; i < 256; i++) {
            sent += 64 * 1024;
            yield Buffer.alloc(64 * 1024, 0x61);
          }
        })(),
      ),
    );
    // As a sentence either way: a 16 MiB Buffer in a failure message would be printed byte by byte.
    const outcome = await service.readImageFile('wpl7-app-shop:u1', '/etc/passwd').then(
      (data) => `read ${data?.length} bytes`,
      (err: Error) => err.message,
    );
    expect(outcome).toBe("The image's /etc/passwd is larger than 1 MiB, more than the panel reads: give the image's USER as numbers (uid:gid).");
    expect(sent).toBeLessThan(4 * 1024 * 1024);
    expect(removed).toEqual([{ force: true, v: true }]);
  });
});
