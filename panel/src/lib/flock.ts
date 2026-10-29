// @docs servers/resources
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A lock this process holds. */
export interface HeldLock {
  /** Let it go. Resolves once the process that held it has ended. */
  release(): Promise<void>;
}

/**
 * Take an exclusive lock on `file` without waiting: a flock(2) lock, the one provision/lib.sh takes
 * with flock(1) on the host. Node cannot take one itself, so a flock(1) child holds it for as long
 * as its stdin stays open. The kernel lets the lock go when that child ends, and the child ends
 * when this process does, so a crash leaves nothing held. No other process need know what a
 * stale lock looks like.
 *
 * Resolves null when another process holds the lock. Rejects when flock(1) cannot run (it is in
 * util-linux, which the panel's image and Ubuntu both have; macOS does not).
 */
export function tryFlock(file: string): Promise<HeldLock | null> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', file, 'sh', '-c', 'echo held; exec cat >/dev/null'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ended = new Promise<void>((done) => child.once('close', () => done()));
    let settled = false;
    child.once('error', (err) => {
      settled = true;
      reject(err);
    });
    // flock(1) exits 1 at once when the lock is taken; after `held` it exits only on release.
    child.once('exit', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
    child.stdout.once('data', () => {
      if (settled) return;
      settled = true;
      resolve({
        release: () => {
          child.stdin.end();
          return ended;
        },
      });
    });
  });
}
