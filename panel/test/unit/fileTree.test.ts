/**
 * Every regular file below a folder, with its size and mtime, and every folder: how a backup of a
 * site hosted elsewhere tells what the copy it keeps holds (services/externalBackup.ts).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hostExec } from '../../src/lib/exec.js';
import { ExecFiles, LocalFiles, type FilesPort } from '../../src/lib/files.js';

let dir: string;
/** Servers run Ubuntu, whose `find -printf` the shell adapter uses; a Mac's BSD find has none. */
const gnuFind = spawnSync('find', ['.', '-maxdepth', '0', '-printf', '']).status === 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-tree-'));
  const put = (name: string, content: string, mtime: number) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtime, mtime);
  };
  put('index.php', '<?php', 1_700_000_000);
  put('wp-content/uploads/a photo.jpg', 'x'.repeat(2048), 1_700_000_123.75);
  put('wp-content/odd\nname.txt', 'odd', 1_700_000_456);
  // A folder that holds only an empty folder.
  fs.mkdirSync(path.join(dir, 'wp-content/cache/empty'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'index.php'), path.join(dir, 'link.php'));
  fs.symlinkSync(path.join(dir, 'wp-content'), path.join(dir, 'linked-folder'));
});

// The same promise from both: this host through the filesystem, a server through its shell.
for (const [where, files, runs] of [
  ['on this host', new LocalFiles(), true],
  ['on a server, in its shell', new ExecFiles(hostExec), gnuFind],
] as [string, FilesPort, boolean][]) {
  describe.skipIf(!runs)(`the tree below a folder, ${where}`, () => {
    it('lists each regular file with its size and its mtime to the second, and each folder, and follows no link', async () => {
      const tree = await files.tree(dir);
      expect(tree.files).toEqual(
        new Map([
          ['index.php', { sizeBytes: 5, mtimeS: 1_700_000_000 }],
          ['wp-content/uploads/a photo.jpg', { sizeBytes: 2048, mtimeS: 1_700_000_123 }],
          ['wp-content/odd\nname.txt', { sizeBytes: 3, mtimeS: 1_700_000_456 }],
        ]),
      );
      expect(tree.folders).toEqual(new Set(['wp-content', 'wp-content/uploads', 'wp-content/cache', 'wp-content/cache/empty']));
    });

    it('is empty for a folder that is not there', async () => {
      const tree = await files.tree(path.join(dir, 'missing'));
      expect([tree.files.size, tree.folders.size]).toEqual([0, 0]);
    });
  });
}
