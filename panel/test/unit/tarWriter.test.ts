import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TarWriter } from '../../src/lib/tarWriter.js';

/** Pipe a writer into the system's tar, extracting into a fresh folder. */
async function extract(build: (tar: TarWriter) => Promise<void>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-tar-'));
  const tar = new TarWriter();
  const child = spawn('tar', ['-xf', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  tar.pipe(child.stdin);
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  await build(tar);
  expect(await exited, stderr).toBe(0);
  return dir;
}

describe('TarWriter', () => {
  it('writes files and folders that tar extracts as they were', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const dir = await extract(async (tar) => {
      await tar.addDir({ name: 'wp-content', mode: 0o755, mtime: 1_700_000_000 });
      await tar.addDir({ name: 'wp-content/uploads/2024/01', mode: 0o755, mtime: 1_700_000_000 });
      await tar.addFile({ name: 'index.php', mode: 0o644, mtime: 1_700_000_000 }, Buffer.from('<?php // index'));
      await tar.addFile({ name: 'wp-content/empty.txt', mode: 0o644, mtime: 1_700_000_000 }, Buffer.alloc(0));
      // In pieces, as the pull writes it.
      await tar.beginFile({ name: 'wp-content/uploads/big.bin', mode: 0o644, mtime: 1_700_000_000 }, big.length);
      for (let at = 0; at < big.length; at += 1024 * 1024) await tar.writeFileData(big.subarray(at, at + 1024 * 1024));
      expect(await tar.endFile()).toBe(0);
      await tar.addFile({ name: 'wp-content/run.sh', mode: 0o755, mtime: 1_600_000_000 }, Buffer.from('#!/bin/sh\n'));
      await tar.finish();
    });
    expect(fs.readFileSync(path.join(dir, 'index.php'), 'utf8')).toBe('<?php // index');
    expect(fs.statSync(path.join(dir, 'wp-content', 'empty.txt')).size).toBe(0);
    expect(fs.statSync(path.join(dir, 'wp-content', 'uploads', '2024', '01')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'wp-content', 'uploads', 'big.bin')).equals(big)).toBe(true);
    const run = fs.statSync(path.join(dir, 'wp-content', 'run.sh'));
    expect(run.mode & 0o777).toBe(0o755);
    expect(Math.floor(run.mtimeMs / 1000)).toBe(1_600_000_000);
  });

  it('writes names longer than a header holds', async () => {
    const long = `wp-content/plugins/${'a-very-long-folder-name/'.repeat(8)}file-with-a-long-name.php`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(200);
    const dir = await extract(async (tar) => {
      await tar.addFile({ name: long, mode: 0o644, mtime: 1 }, Buffer.from('long'));
      await tar.finish();
    });
    expect(fs.readFileSync(path.join(dir, long), 'utf8')).toBe('long');
  });

  // Linux file systems take any bytes but / and NUL in a name; macOS's refuses invalid UTF-8.
  it.runIf(process.platform === 'linux')('writes names that are not UTF-8 as the bytes they are', async () => {
    const latin1 = Buffer.concat([Buffer.from('wp-content/uploads/caf'), Buffer.from([0xe9]), Buffer.from('.jpg')]);
    const dir = await extract(async (tar) => {
      await tar.addFile({ name: latin1, mode: 0o644, mtime: 1 }, Buffer.from('latin1'));
      await tar.finish();
    });
    const uploads = fs.readdirSync(path.join(dir, 'wp-content', 'uploads'), { encoding: 'buffer' });
    expect(uploads.some((name) => name.equals(Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('.jpg')])))).toBe(
      true,
    );
  });

  it('fills a file that came up short, so the archive stays whole', async () => {
    const dir = await extract(async (tar) => {
      await tar.beginFile({ name: 'shrunk.txt', mode: 0o644, mtime: 1 }, 10);
      await tar.writeFileData(Buffer.from('abc'));
      expect(await tar.endFile()).toBe(7);
      // Fetched again into a later entry, which wins on extraction.
      await tar.addFile({ name: 'shrunk.txt', mode: 0o644, mtime: 2 }, Buffer.from('abc'));
      await tar.addFile({ name: 'after.txt', mode: 0o644, mtime: 1 }, Buffer.from('still here'));
      await tar.finish();
    });
    expect(fs.readFileSync(path.join(dir, 'shrunk.txt'), 'utf8')).toBe('abc');
    expect(fs.readFileSync(path.join(dir, 'after.txt'), 'utf8')).toBe('still here');
  });

  it('refuses more bytes than the header promised, and a second entry inside a file', async () => {
    const tar = new TarWriter();
    tar.resume();
    await tar.beginFile({ name: 'a.txt', mode: 0o644, mtime: 1 }, 2);
    await expect(tar.writeFileData(Buffer.from('abc'))).rejects.toThrow(/more bytes/);
    await expect(tar.addDir({ name: 'b', mode: 0o755, mtime: 1 })).rejects.toThrow(/not finished/);
  });

  it('stops waiting when the reader goes away', async () => {
    const tar = new TarWriter();
    tar.on('error', () => undefined);
    // Nobody reads: the buffer fills, and the writer waits.
    const writing = tar.addFile({ name: 'big.bin', mode: 0o644, mtime: 1 }, Buffer.alloc(16 * 1024 * 1024));
    tar.destroy(new Error('tar exited'));
    await expect(writing).rejects.toThrow(/tar exited/);
  });

  it('writes a size past 8 GiB in base-256', async () => {
    const tar = new TarWriter();
    const chunks: Buffer[] = [];
    tar.on('data', (c: Buffer) => chunks.push(c));
    await tar.beginFile({ name: 'huge.bin', mode: 0o644, mtime: 1 }, 9 * 1024 ** 3);
    await new Promise((r) => setImmediate(r));
    const head = Buffer.concat(chunks).subarray(0, 512);
    const field = head.subarray(124, 136);
    expect(field[0]).toBe(0x80);
    expect(field.readBigUInt64BE(4)).toBe(BigInt(9 * 1024 ** 3));
  });
});
