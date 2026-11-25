import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ZipFormatError, ZipReader, type ZipEntry } from '../../src/lib/zipReader.js';
import { tempFile, zipBytes, type ZipFixtureEntry, removeTempFiles } from '../duplicatorFixtures.js';

async function entriesOf(zip: ZipReader): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for await (const e of zip.entries()) out.push(e);
  return out;
}

async function readAll(entries: ZipFixtureEntry[], opts: { zip64?: boolean } = {}) {
  const zip = await ZipReader.open(tempFile(zipBytes(entries, opts)));
  try {
    const out: { entry: ZipEntry; data: Buffer | null }[] = [];
    for await (const entry of zip.entries()) {
      out.push({ entry, data: entry.kind === 'file' ? await zip.readAll(entry, 64 * 1024 * 1024) : null });
    }
    return out;
  } finally {
    await zip.close();
  }
}

afterAll(removeTempFiles);

describe('reading a .zip', () => {
  it('reads deflated and stored files, folders and links, with their names, modes and times', async () => {
    const got = await readAll([
      { name: 'wp-admin', dir: true },
      { name: 'index.php', data: '<?php echo 1;'.repeat(50) },
      { name: 'empty.txt', data: '' },
      { name: 'stored.bin', data: Buffer.from([0, 1, 2, 255]), method: 0 },
      { name: 'run.sh', data: '#!/bin/sh', mode: 0o755 },
      { name: 'wp-content/uploads/odd name & ü.txt', data: 'odd' },
      { name: 'link', data: 'index.php', link: true },
    ]);
    expect(got.map((g) => [g.entry.name.toString('utf8'), g.entry.kind])).toEqual([
      ['wp-admin/', 'dir'],
      ['index.php', 'file'],
      ['empty.txt', 'file'],
      ['stored.bin', 'file'],
      ['run.sh', 'file'],
      ['wp-content/uploads/odd name & ü.txt', 'file'],
      ['link', 'link'],
    ]);
    expect(got[1]!.data!.toString()).toBe('<?php echo 1;'.repeat(50));
    expect(got[1]!.entry.method).toBe(8);
    expect(got[2]!.data!.length).toBe(0);
    expect([...got[3]!.data!]).toEqual([0, 1, 2, 255]);
    expect(got[4]!.entry.mode).toBe(0o755);
    expect(got[1]!.entry.mtime).toBe(Date.UTC(2024, 1, 29) / 1000);
  });

  it('reads ZIP64 records', async () => {
    const got = await readAll([{ name: 'a.txt', data: 'alpha' }, { name: 'b/', dir: true }, { name: 'b/c.txt', data: 'gamma'.repeat(100) }], { zip64: true });
    expect(got.map((g) => g.data?.toString() ?? null)).toEqual(['alpha', null, 'gamma'.repeat(100)]);
  });

  it('reads a plain archive of exactly 65,535 entries, and refuses one that holds more and says so little', async () => {
    const many = Array.from({ length: 0xffff }, (_, i) => ({ name: `f/${i}.txt`, data: '' }));
    const bytes = zipBytes(many);
    const zip = await ZipReader.open(tempFile(bytes));
    try {
      expect((await entriesOf(zip)).length).toBe(0xffff);
    } finally {
      await zip.close();
    }
    // One more central entry than its plain end record can say, as a ZIP64 archive without its records looks.
    const eocd = bytes.length - 22;
    const cdOffset = bytes.readUInt32LE(eocd + 16);
    const firstNameLen = bytes.readUInt16LE(cdOffset + 28);
    const extraEntry = bytes.subarray(cdOffset, cdOffset + 46 + firstNameLen);
    const end = Buffer.from(bytes.subarray(eocd));
    end.writeUInt32LE(bytes.readUInt32LE(eocd + 12) + extraEntry.length, 12);
    const more = await ZipReader.open(tempFile(Buffer.concat([bytes.subarray(0, eocd), extraEntry, end])));
    try {
      await expect(entriesOf(more)).rejects.toThrow(/more than 65,535 entries/);
    } finally {
      await more.close();
    }
  });

  it('streams an entry too big to inflate in one go, and gets every byte back', async () => {
    const big = crypto.randomBytes(9 * 1024 * 1024);
    const zip = await ZipReader.open(tempFile(zipBytes([{ name: 'big.bin', data: big }])));
    try {
      const [entry] = await entriesOf(zip);
      const parts: Buffer[] = [];
      await zip.pipe(entry!, async (chunk) => void parts.push(Buffer.from(chunk)));
      expect(Buffer.concat(parts).equals(big)).toBe(true);
      expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      await zip.close();
    }
    // Nine MiB to deflate and inflate: seconds on a machine busy with other tests.
  }, 60_000);

  it('ends a streamed entry whose deflate data stops early, and hands a failing sink its own error back', async () => {
    // 64 bytes deflated, then 10 MiB that are no part of it: the stream ends before its packed size.
    const plain = Buffer.alloc(64, 7);
    const short = Buffer.concat([zlib.deflateRawSync(plain), Buffer.alloc(10 * 1024 * 1024)]);
    const bytes = zipBytes([{ name: 'short.bin', data: plain }]);
    // Put the long body where the deflated one was, and say so in both headers.
    const at = bytes.indexOf(zlib.deflateRawSync(plain));
    const patched = Buffer.concat([bytes.subarray(0, at), short, bytes.subarray(at + zlib.deflateRawSync(plain).length)]);
    patched.writeUInt32LE(short.length, 18);
    const cd = patched.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    patched.writeUInt32LE(short.length, cd + 20);
    patched.writeUInt32LE(cd, patched.length - 22 + 16);
    const zip = await ZipReader.open(tempFile(patched));
    try {
      const [entry] = await entriesOf(zip);
      await expect(zip.readAll(entry!, 1 << 20)).rejects.toThrow(/ends before the entry does/);
    } finally {
      await zip.close();
    }
    const big = crypto.randomBytes(3 * 1024 * 1024);
    const other = await ZipReader.open(tempFile(zipBytes([{ name: 'big.bin', data: big }])));
    try {
      const [entry] = await entriesOf(other);
      let n = 0;
      await expect(
        other.pipe(entry!, async () => {
          if (++n === 2) throw new Error('the disk is full');
        }),
      ).rejects.toThrow(/^the disk is full$/);
    } finally {
      await other.close();
    }
  });

  it('refuses what does not check out: a wrong CRC, more data than claimed, encryption, other methods', async () => {
    const bad = async (entry: ZipFixtureEntry, message: RegExp) => {
      const zip = await ZipReader.open(tempFile(zipBytes([entry])));
      try {
        const [e] = await entriesOf(zip);
        await expect(zip.readAll(e!, 1 << 20)).rejects.toThrow(message);
        await expect(zip.readAll(e!, 1 << 20)).rejects.toBeInstanceOf(ZipFormatError);
      } finally {
        await zip.close();
      }
    };
    await bad({ name: 'a.txt', data: 'hello world', badCrc: true }, /CRC-32/);
    await bad({ name: 'bomb.txt', data: 'x'.repeat(100_000), claimSize: 10 }, /more than|cannot be inflated/);
    await bad({ name: 'secret.txt', data: 'hidden', flags: 1 }, /encrypted/);
    await bad({ name: 'bz.txt', data: 'packed', method: 12 }, /method 12/);
  });

  it('refuses a file that is no .zip, or one cut short', async () => {
    await expect(ZipReader.open(tempFile(Buffer.from('not a zip at all')))).rejects.toThrow(/central directory/);
    const whole = zipBytes([{ name: 'a.txt', data: 'alpha' }]);
    await expect(ZipReader.open(tempFile(whole.subarray(0, whole.length - 10)))).rejects.toThrow(/central directory/);
  });
});
