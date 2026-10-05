/**
 * The checks callers act on when a path is not there - exists, isDirectory, stat, readOptional.
 * "Not there" has to mean not there: on a server, a check that timed out or a shell that never
 * started used to answer no, and callers then wrote a default over a file, left a folder out of
 * a backup, or deleted a site without its final one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hostExec, type ExecPort, type ExecResult } from '../../src/lib/exec.js';
import { ExecFiles, LocalFiles, type FilesPort } from '../../src/lib/files.js';

let dir: string;
/** Servers run Ubuntu, whose `stat -c` the shell adapter uses; a Mac's BSD stat has no `-c`. */
const gnuStat = spawnSync('stat', ['--version']).status === 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-checks-'));
  fs.writeFileSync(path.join(dir, 'relay.env'), 'POSTFIX_myhostname=smtp.example.com\n');
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));
});

// The same promise from both: this host through the filesystem, a server through its shell.
for (const [where, files, canStat] of [
  ['on this host', new LocalFiles(), true],
  ['on a server, in its shell', new ExecFiles(hostExec), gnuStat],
] as [string, FilesPort, boolean][]) {
  describe(`checking a path, ${where}`, () => {
    const at = (name: string) => path.join(dir, name);

    it('says what is there', async () => {
      expect(await files.exists(at('relay.env'))).toBe(true);
      expect(await files.isDirectory(at('folder'))).toBe(true);
      expect(await files.isDirectory(at('relay.env'))).toBe(false);
      if (canStat) expect((await files.stat(at('relay.env')))?.sizeBytes).toBe(36);
      expect(await files.readOptional(at('relay.env'))).toBe('POSTFIX_myhostname=smtp.example.com\n');
    });

    it('says "not there" for a path that is not, or that runs through a file', async () => {
      for (const name of ['missing.env', 'relay.env/below']) {
        expect(await files.exists(at(name)), name).toBe(false);
        expect(await files.isDirectory(at(name)), name).toBe(false);
        expect(await files.stat(at(name)), name).toBeNull();
        expect(await files.readOptional(at(name)), name).toBeNull();
      }
      expect(await files.exists(at('dangling'))).toBe(false);
    });

    it('throws for something there that is not a readable file', async () => {
      await expect(files.readOptional(at('folder'))).rejects.toThrow();
    });
  });
}

describe('checking a path on a server whose check fails', () => {
  /** A server where every command comes back with this exit code. */
  const answering = (exitCode: number, stderr = ''): ExecPort => ({
    run: async (): Promise<ExecResult> => ({ stdout: '', stderr, exitCode }),
    runWithInput: async () => ({ stdout: '', stderr, exitCode }),
    runToStream: async () => ({ exitCode, stderr }),
  });
  const checks = (files: FilesPort, p: string) => [
    files.exists(p),
    files.isDirectory(p),
    files.stat(p),
    files.readOptional(p),
  ];

  it('throws when the check timed out, rather than answering "not there"', async () => {
    // 124: the `timeout` SshExec wraps every remote command in.
    for (const check of checks(new ExecFiles(answering(124)), '/srv/mail/relay.env')) {
      await expect(check).rejects.toThrow(/exit 124/);
    }
  });

  it('throws when sudo or the command failed, which exit 1 like a "no" from test would', async () => {
    for (const check of checks(new ExecFiles(answering(1, 'sudo: a password is required')), '/srv/sites/x')) {
      await expect(check).rejects.toThrow(/sudo: a password is required/);
    }
  });
});
