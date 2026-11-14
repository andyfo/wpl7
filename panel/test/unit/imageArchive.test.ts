/**
 * A `docker save` archive read and renamed before a load: every name it carries is found, wherever a
 * reader would take it from, and replaced. The real stores' behaviour is in
 * test/engine/containerImages.test.ts and the SSH e2e; here the archives are written by hand.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TarWriter } from '../../src/lib/tarWriter.js';
import { fileFromTar, inspectArchive, normalImageName, renamedArchive } from '../../src/services/imageArchive.js';

const BLOCK = 512;

/** A header block of any type, as Go's tar writer would make it (POSIX ustar). */
function rawHeader(name: string, size: number, type: string, linkname = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
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

function paxEntry(records: Record<string, string>): Buffer {
  const body = Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      while (`${len}${rest}`.length !== len) len = `${len}${rest}`.length;
      return `${len}${rest}`;
    })
    .join('');
  return entry('PaxHeaders/x', Buffer.from(body), 'x');
}

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

function write(parts: Buffer[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-archive-')), 'image.tar');
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
    expect(() => renamedArchive(two, { ...(undefined as never), problem: 'x' } as never, 'n:1')).toThrow();
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
});
