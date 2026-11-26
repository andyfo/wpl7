import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A test run's temp folders all go in one folder of the run's own, which the run deletes when it
 * ends. Every world makes a folder for its SRV_ROOT (makeTestConfig in test/helpers.ts) and nothing
 * deleted it; with the ones other tests leave, each run left two thousand folders behind.
 *
 * TMPDIR points at the run's folder before Vitest starts its workers, which inherit it. So
 * os.tmpdir() in a test, and mktemp in anything a test runs, both land in it.
 *
 * Runs at the same time, in other checkouts or a watch session, each have their own folder, and a
 * run deletes only its own. A run that was killed cannot delete its folder; the next run deletes
 * it once the run's process is gone and the folder has been left alone for a day.
 */
export default function setup(): (() => void) | undefined {
  // WPL7_ENGINE_KEEP=1 leaves an engine test's site running on its files in the temp folder.
  if (process.env.WPL7_ENGINE_KEEP === '1') return undefined;
  const parent = os.tmpdir();
  removeAbandonedRuns(parent);
  const dir = fs.mkdtempSync(path.join(parent, `wpl7-test-run-${process.pid}-`));
  const before = { TMPDIR: process.env.TMPDIR, WPL7_TEST_CACHE: process.env.WPL7_TEST_CACHE };
  process.env.TMPDIR = dir;
  // For what a test keeps for the next run, such as the end-to-end tests' WP-CLI.
  process.env.WPL7_TEST_CACHE ??= parent;
  const remove = () => removeFolder(dir);
  // Once more on the way out. Ctrl-C and SIGTERM end Vitest with process.exit(), which never gets
  // to the teardown; and the teardown runs before Vitest has waited for its workers to stop, so one
  // can still write into the folder after it.
  process.once('exit', remove);
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    remove();
  };
}

export const RUN_FOLDER = /^wpl7-test-run-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Longer than any run. Waiting this long also covers a run in another PID namespace, whose process
 * only looks gone from here.
 */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Deletes this user's run folders whose process is gone and that have not changed for a day. */
export function removeAbandonedRuns(parent: string, now = Date.now()): void {
  for (const name of fs.readdirSync(parent)) {
    const pid = RUN_FOLDER.exec(name)?.[1];
    if (!pid || isRunning(Number(pid))) continue;
    const dir = path.join(parent, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue; // another run deleted it first
    }
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || now - stat.mtimeMs < ABANDONED_AFTER_MS) continue;
    removeFolder(dir);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process is there, but it is another user's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeFolder(dir: string): void {
  try {
    // Retries: a worker that is still stopping may write into it while it goes.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`Could not delete the test run's temp folder ${dir}: ${(err as Error).message}`);
  }
}
