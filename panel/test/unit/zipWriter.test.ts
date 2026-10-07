import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipOf } from '../../src/lib/zipWriter.js';
import { zipEntries, zipPluginFolder } from '../../src/lib/pluginZip.js';

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function written(entries: Parameters<typeof zipOf>[0]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-zip-')), 'out.zip');
  fs.writeFileSync(file, zipOf(entries));
  return file;
}

const longText = 'WordPress '.repeat(5000);

describe('zipOf', () => {
  const entries = [
    { name: 'wpl7-migrate/' },
    { name: 'wpl7-migrate/wpl7-migrate.php', data: '<?php // plugin\n' },
    { name: 'wpl7-migrate/includes/' },
    { name: 'wpl7-migrate/includes/big.txt', data: longText },
    { name: 'wpl7-migrate/includes/ü.php', data: Buffer.from([0, 1, 2, 255]) },
  ];

  it('is read back by the panel’s own zip reader', () => {
    const file = written(entries);
    expect(zipEntries(file)).toEqual([
      { name: 'wpl7-migrate/', size: 0 },
      { name: 'wpl7-migrate/wpl7-migrate.php', size: 16 },
      { name: 'wpl7-migrate/includes/', size: 0 },
      { name: 'wpl7-migrate/includes/big.txt', size: longText.length },
      { name: 'wpl7-migrate/includes/ü.php', size: 4 },
    ]);
    expect(zipPluginFolder(file)).toBe('wpl7-migrate');
  });

  it('gives the same bytes for the same files', () => {
    expect(zipOf(entries).equals(zipOf(entries))).toBe(true);
  });

  it.runIf(hasUnzip)('passes `unzip -t` and unpacks to the same content', () => {
    const file = written(entries);
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toMatch(/No errors detected/);
    expect(execFileSync('unzip', ['-p', file, 'wpl7-migrate/includes/big.txt'], { encoding: 'utf8' })).toBe(longText);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-unzip-'));
    execFileSync('unzip', ['-q', file, '-d', dir]);
    expect(fs.readFileSync(path.join(dir, 'wpl7-migrate', 'includes', 'ü.php'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(fs.statSync(path.join(dir, 'wpl7-migrate', 'wpl7-migrate.php')).mode & 0o777).toBe(0o644);
  });

  it('refuses names that would land outside the folder, and the same name twice', () => {
    expect(() => zipOf([{ name: '../evil.php', data: 'x' }])).toThrow(/Not a name/);
    expect(() => zipOf([{ name: '/etc/passwd', data: 'x' }])).toThrow(/Not a name/);
    expect(() => zipOf([{ name: 'a/../../b', data: 'x' }])).toThrow(/Not a name/);
    expect(() => zipOf([{ name: 'a.txt' }, { name: 'a.txt' }])).toThrow(/Twice/);
  });
});
