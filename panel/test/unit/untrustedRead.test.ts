/**
 * A site's own files, read by the panel - as the panel on this host, as root on a server. Any
 * hacked plugin, and any Manage credential (docs/mcp.md), has a shell in the site and can turn
 * those files into links to /dev/zero or to the host's own files, or into FIFOs that never answer.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { ExecFiles, LocalFiles, type FilesPort } from '../../src/lib/files.js';
import { readWpVersion } from '../../src/services/backup.js';
import type { ServerHandle } from '../../src/servers/registry.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-untrusted-'));
  fs.writeFileSync(path.join(dir, 'version.php'), `<?php $wp_version = '6.9.1';\n${'/* padding */\n'.repeat(10_000)}`);
  fs.symlinkSync('/dev/zero', path.join(dir, 'zero.php'));
  // Refused even when it points at something harmless: what it points at can change.
  fs.symlinkSync(path.join(dir, 'version.php'), path.join(dir, 'link.php'));
  execFileSync('mkfifo', [path.join(dir, 'fifo.php')]);
});

// The same promise from both: this host through the filesystem, a server through its shell.
for (const [where, files] of [
  ['on this host', new LocalFiles()],
  ['on a server, in its shell', new ExecFiles(hostExec)],
] as [string, FilesPort][]) {
  describe(`reading a file a site controls, ${where}`, () => {
    it('reads a regular file, and no more of it than asked for', async () => {
      const text = await files.readUntrusted(path.join(dir, 'version.php'), 64);
      expect(text).toHaveLength(64);
      expect(text).toMatch(/^<\?php \$wp_version = '6\.9\.1';/);
    });

    it('refuses a link, a FIFO, a folder and a file that is not there', async () => {
      for (const name of ['zero.php', 'link.php', 'fifo.php', '.', 'missing.php']) {
        expect(await files.readUntrusted(path.join(dir, name), 1024), name).toBeNull();
      }
    });
  });
}

describe("reading a site's WordPress version for its backup", () => {
  const handle = (files: FilesPort) => ({ files }) as unknown as ServerHandle;

  it('finds it in version.php, and gives up on a version.php that is a link', async () => {
    const wordpress = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-wp-'));
    fs.mkdirSync(path.join(wordpress, 'wp-includes'));
    const version = path.join(wordpress, 'wp-includes', 'version.php');
    fs.writeFileSync(version, "<?php $wp_version = '6.9.1';");
    expect(await readWpVersion(handle(new LocalFiles()), wordpress)).toBe('6.9.1');

    fs.rmSync(version);
    fs.symlinkSync('/dev/zero', version);
    expect(await readWpVersion(handle(new LocalFiles()), wordpress)).toBeNull();
  });

  it('asks a server for a bounded read, never a plain cat', async () => {
    const calls: { cmd: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
    const exec = {
      run: async (cmd: string, args: string[], opts?: { timeoutMs?: number }) => {
        calls.push({ cmd, args, opts });
        return { exitCode: 0, stdout: "<?php $wp_version = '6.8.2';", stderr: '' };
      },
    } as unknown as ExecPort;
    expect(await readWpVersion(handle(new ExecFiles(exec)), '/srv/sites/shop/wordpress')).toBe('6.8.2');
    expect(calls).toEqual([
      {
        cmd: 'sh',
        args: ['-c', expect.stringContaining('head -c'), 'sh', '/srv/sites/shop/wordpress/wp-includes/version.php', '65536'],
        opts: { timeoutMs: expect.any(Number) },
      },
    ]);
  });
});
