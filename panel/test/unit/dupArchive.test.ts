import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { DafFormatError, DafReader, type DafEntry } from '../../src/lib/dupArchive.js';
import { dafBytes, tempFile, type DafFixtureEntry, removeTempFiles } from '../duplicatorFixtures.js';

async function walk(bytes: Buffer) {
  const daf = await DafReader.open(tempFile(bytes));
  try {
    const out: { entry: DafEntry; data: Buffer | null }[] = [];
    let current: Buffer[] | null = null;
    const flush = () => {
      if (current && out.length > 0) out.at(-1)!.data = Buffer.concat(current);
      current = null;
    };
    await daf.walk({
      onEntry: async (entry) => {
        flush();
        out.push({ entry, data: null });
        if (entry.kind !== 'file') return null;
        current = [];
        const mine = current;
        return async (chunk) => void mine.push(Buffer.from(chunk));
      },
    });
    flush();
    return { info: daf.info, out };
  } finally {
    await daf.close();
  }
}

const SITE: DafFixtureEntry[] = [
  { name: 'wp-admin', dir: true },
  { name: 'index.php', data: '<?php echo 1;'.repeat(300) },
  { name: 'empty.txt', data: '' },
  { name: 'wp-content/uploads/odd name & ü.txt', data: 'odd' },
  { name: 'dup-installer/archive.txt', data: '{"x":1}' },
];

afterAll(removeTempFiles);

describe('reading a DupArchive', () => {
  for (const version of ['5.0.1', '1.0.0'] as const) {
    it(`reads ${version}: folders, and files in several globs`, async () => {
      const { info, out } = await walk(dafBytes(SITE, { version, globSize: 512 }));
      expect(info).toMatchObject({ version, compressed: true, encrypted: false });
      expect(out.map((o) => [o.entry.name.toString('utf8'), o.entry.kind])).toEqual([
        ['__dup__archive__index.json', 'file'],
        ['wp-admin', 'dir'],
        ['index.php', 'file'],
        ['empty.txt', 'file'],
        ['wp-content/uploads/odd name & ü.txt', 'file'],
        ['dup-installer/archive.txt', 'file'],
      ]);
      expect(out[2]!.data!.toString()).toBe('<?php echo 1;'.repeat(300));
      expect(out[3]!.data!.length).toBe(0);
    });
  }

  it('takes a 5.x file stored as it is, the archive compressed or not', async () => {
    const { out } = await walk(dafBytes([{ name: 'raw.bin', data: Buffer.from([0, 255, 1]), compress: false }], { version: '5.0.1', compress: true }));
    expect([...out[1]!.data!]).toEqual([0, 255, 1]);
    const plain = await walk(dafBytes([{ name: 'a.txt', data: 'plain' }], { version: '1.0.0', compress: false }));
    expect(plain.out[1]!.data!.toString()).toBe('plain');
  });

  it('reads one entry again from its offset', async () => {
    const big = crypto.randomBytes(5000);
    const daf = await DafReader.open(tempFile(dafBytes([{ name: 'a.txt', data: 'first' }, { name: 'big.bin', data: big }, { name: 'c.txt', data: 'last' }], { globSize: 700 })));
    try {
      const offsets: number[] = [];
      await daf.walk({ onEntry: async (e) => void offsets.push(e.offset) });
      expect((await daf.readAllAt(offsets[2]!, 1 << 20)).equals(big)).toBe(true);
      // Refused on its size, before a byte of it is read.
      await expect(daf.readAllAt(offsets[2]!, 100)).rejects.toThrow(/larger than 100 bytes/);
      await expect(daf.readAllAt(offsets[0]! - 1, 100)).rejects.toBeInstanceOf(DafFormatError);
    } finally {
      await daf.close();
    }
  });

  it('refuses a damaged glob, and a header out of place', async () => {
    await expect(walk(dafBytes([{ name: 'a.txt', data: 'hello', badCrc: true }]))).rejects.toThrow(/CRC-32/);
    // Both Duplicators give every glob a CRC-32: one without is damage too, not a part to take unchecked.
    const good = dafBytes([{ name: 'a.txt', data: 'hello' }]).toString('latin1');
    for (const hash of ['', 'nothex!!', '0000000']) {
      const bad = Buffer.from(good.replace(/<G><OS>5<\/OS><SS>(\d+)<\/SS><HA>[0-9a-f]{8}<\/HA>/, `<G><OS>5</OS><SS>$1</SS><HA>${hash}</HA>`), 'latin1');
      expect(bad.toString('latin1')).toContain(`<HA>${hash}</HA></G>`);
      await expect(walk(bad)).rejects.toThrow(/has no CRC-32/);
    }
    const bytes = dafBytes([{ name: 'a.txt', data: 'hello' }]);
    const broken = Buffer.from(bytes.toString('latin1').replace('<F><FS>5', '<Q><FS>5'), 'latin1');
    await expect(walk(broken)).rejects.toBeInstanceOf(DafFormatError);
    await expect(DafReader.open(tempFile(Buffer.from('<A><V>x</V></A>')))).rejects.toThrow(/version/);
  });

  it("checks each file whole against its own CRC-32, where Duplicator took one", async () => {
    const entries = (fileHash: string): DafFixtureEntry[] => [{ name: 'a.txt', data: 'hello world', fileHash }, { name: 'b.txt', data: 'second' }];
    // Every part checks out, the whole does not: failed, or handed to onMismatch to go on.
    await expect(walk(dafBytes(entries('deadbeef')))).rejects.toThrow(/a\.txt is damaged: it does not match its CRC-32/);
    const daf = await DafReader.open(tempFile(dafBytes(entries('deadbeef'))));
    try {
      const mismatched: string[] = [];
      const read: string[] = [];
      await daf.walk({
        onEntry: async (e) => (e.kind === 'file' ? async () => void read.push(e.name.toString('utf8')) : null),
        onMismatch: (e) => mismatched.push(e.name.toString('utf8')),
      });
      expect(mismatched).toEqual(['a.txt']);
      expect(read).toContain('b.txt');
    } finally {
      await daf.close();
    }
    // The 32 zeros Duplicator writes past 100 MiB are no hash at all; anything else is a damaged header.
    expect((await walk(dafBytes(entries('0'.repeat(32))))).out[1]!.entry.hash).toBeNull();
    await expect(walk(dafBytes(entries('xyz')))).rejects.toThrow(/damaged header/);
  });

  it('takes no length past what Duplicator writes: a path, a glob', async () => {
    const long = dafBytes([{ name: 'a.txt', data: 'hello' }]);
    const path = Buffer.from(long.toString('latin1').replace('<RPL>5</RPL>', '<RPL>3000000000</RPL>'), 'latin1');
    await expect(walk(path)).rejects.toThrow(/claims a path of 3000000000 bytes/);
    const glob = Buffer.from(dafBytes([{ name: 'a.txt', data: 'hello', compress: false }], { compress: false }).toString('latin1').replace('<SS>5</SS>', '<SS>999999999</SS>'), 'latin1');
    await expect(walk(glob)).rejects.toThrow(/impossible size/);
  });

  it('says an archive is encrypted, and reads none of it', async () => {
    const daf = await DafReader.open(tempFile(dafBytes([{ name: 'a.txt', data: 'secret' }], { crypt: true })));
    try {
      expect(daf.info.encrypted).toBe(true);
    } finally {
      await daf.close();
    }
  });
});
