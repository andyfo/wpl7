import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { ABANDONED_AFTER_MS, RUN_FOLDER, removeAbandonedRuns } from '../globalSetup.js';

/** The temp folder a test run has to itself, and deletes at the end (test/globalSetup.ts). */

const KEEP = process.env.WPL7_ENGINE_KEEP === '1';
/** Above the highest process id Linux and macOS can give out. */
const NO_SUCH_PROCESS = 4_194_305;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The hook setup() just added: it stays until the process exits, so a test takes it off itself. */
const lastExitHook = () => process.listeners('exit').at(-1) as () => void;

describe("a test run's temp folder", () => {
  it.skipIf(KEEP)('is where the tests, and every process they start, make their temp files', () => {
    const own = os.tmpdir();
    expect(path.basename(own)).toMatch(RUN_FOLDER);
    expect(spawnSync('sh', ['-c', 'printf %s "$TMPDIR"'], { encoding: 'utf8' }).stdout).toBe(own);
    // What a test keeps for the next run goes beside it.
    expect(process.env.WPL7_TEST_CACHE).toBe(path.dirname(own));
  });

  it.skipIf(KEEP)('is made in the temp folder there was, and deleted at the end with what is in it', () => {
    const tmp = os.tmpdir();
    const end = setup()!;
    const onExit = lastExitHook();
    const dir = os.tmpdir();
    try {
      expect(path.dirname(dir)).toBe(tmp);
      expect(RUN_FOLDER.exec(path.basename(dir))?.[1]).toBe(String(process.pid));
      fs.mkdirSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-test-')), 'sites', 'blog'), { recursive: true });
    } finally {
      end();
      process.off('exit', onExit);
    }
    expect(fs.existsSync(dir)).toBe(false);
    expect(os.tmpdir()).toBe(tmp);
  });

  it.skipIf(KEEP)('is deleted again on the way out: after a late write, and when Ctrl-C or SIGTERM skip the teardown', () => {
    const end = setup()!;
    const onExit = lastExitHook();
    const dir = os.tmpdir();
    try {
      fs.mkdirSync(path.join(dir, 'wpl7-test-abc123', 'sites'), { recursive: true });
      onExit();
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      end();
      process.off('exit', onExit);
    }
  });

  it('is not made under WPL7_ENGINE_KEEP=1, which leaves a site running on its files', () => {
    const tmp = os.tmpdir();
    const keep = process.env.WPL7_ENGINE_KEEP;
    process.env.WPL7_ENGINE_KEEP = '1';
    try {
      expect(setup()).toBeUndefined();
      expect(os.tmpdir()).toBe(tmp);
    } finally {
      if (keep === undefined) delete process.env.WPL7_ENGINE_KEEP;
      else process.env.WPL7_ENGINE_KEEP = keep;
    }
  });

  it('of a run that was killed is deleted by a later run, once its process is gone and a day has passed', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-runs-'));
    dirs.push(parent);
    const runFolder = (pid: number) => {
      const dir = fs.mkdtempSync(path.join(parent, `wpl7-test-run-${pid}-`));
      fs.mkdirSync(path.join(dir, 'wpl7-test-abc123', 'sites'), { recursive: true });
      return dir;
    };
    const killed = runFolder(NO_SUCH_PROCESS);
    const running = runFolder(process.pid);
    const notARun = fs.mkdtempSync(path.join(parent, 'wpl7-test-'));
    const aFile = path.join(parent, `wpl7-test-run-${NO_SUCH_PROCESS}-file00`);
    fs.writeFileSync(aFile, '');

    removeAbandonedRuns(parent);
    expect(fs.existsSync(killed)).toBe(true);

    removeAbandonedRuns(parent, Date.now() + ABANDONED_AFTER_MS + 60_000);
    expect(fs.existsSync(killed)).toBe(false);
    expect([running, notARun, aFile].filter((p) => !fs.existsSync(p))).toEqual([]);
  });
});
