import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryFlock } from '../../src/lib/flock.js';

/** The lock the panel takes with flock(1), the one provision/lib.sh takes on the host (lib/flock.ts). */

/** flock(1) is in util-linux: the panel's image, Ubuntu and CI have it, macOS does not. */
const hasFlock = spawnSync('flock', ['--version']).status === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const lockFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-flock-'));
  dirs.push(dir);
  return path.join(dir, 'update', 'docker.lock');
};

describe('tryFlock', () => {
  it('rejects when flock(1) cannot run', async () => {
    const PATH = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(tryFlock(lockFile())).rejects.toThrow(/ENOENT/);
    } finally {
      process.env.PATH = PATH;
    }
  });

  it.skipIf(!hasFlock)('takes a free lock, says null while it is held, and lets it go', async () => {
    const file = lockFile();
    const first = await tryFlock(file);
    expect(first).not.toBeNull();
    expect(await tryFlock(file)).toBeNull();
    // The same lock flock(1) takes on the host, as update.sh does.
    expect(spawnSync('flock', ['--nonblock', file, 'true']).status).toBe(1);
    await first!.release();
    const again = await tryFlock(file);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it.skipIf(!hasFlock)('is free again the moment its holder dies, without anyone cleaning up', async () => {
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // --close: the lock is flock(1)'s alone, not its child's, so killing it is the holder dying.
    const holder = spawn('flock', ['--exclusive', '--close', file, 'sleep', '60']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await tryFlock(file)).toBeNull();
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    const lock = await tryFlock(file);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
