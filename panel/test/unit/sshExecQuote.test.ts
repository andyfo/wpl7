import { describe, expect, it } from 'vitest';
import { SshExec, shellQuote } from '../../src/servers/sshExec.js';
import type { SshConnection } from '../../src/servers/sshConnection.js';

function captureConn() {
  const commands: string[] = [];
  const conn = {
    exec: async (command: string) => {
      commands.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  } as unknown as SshConnection;
  return { conn, commands };
}

describe('shellQuote', () => {
  it('leaves safe words bare and single-quotes the rest', () => {
    expect(shellQuote(['tar', '-C', '/srv/sites/demo', '-czf', 'x.tar.gz'])).toBe(
      'tar -C /srv/sites/demo -czf x.tar.gz',
    );
    expect(shellQuote(['echo', 'two words'])).toBe("echo 'two words'");
    expect(shellQuote(['rm', '-rf', '$(boom)'])).toBe("rm -rf '$(boom)'");
    expect(shellQuote([''])).toBe("''");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(['cat', "it's.txt"])).toBe(`cat 'it'\\''s.txt'`);
  });
});

describe('SshExec command building', () => {
  it('wraps with sudo -n and a remote timeout', async () => {
    const { conn, commands } = captureConn();
    await new SshExec(conn).run('chown', ['-R', '33:33', '/srv/sites/demo/wordpress'], { timeoutMs: 60_000 });
    expect(commands[0]).toBe('sudo -n -- timeout -k 5 60 chown -R 33:33 /srv/sites/demo/wordpress');
  });

  it('quotes hostile arguments before they hit the remote shell', async () => {
    const { conn, commands } = captureConn();
    await new SshExec(conn).run('rm', ['-rf', '--', '/srv/sites/a; rm -rf /'], { timeoutMs: 1_000 });
    expect(commands[0]).toBe(`sudo -n -- timeout -k 5 1 rm -rf -- '/srv/sites/a; rm -rf /'`);
  });

  it('can run without sudo', async () => {
    const { conn, commands } = captureConn();
    await new SshExec(conn, { sudo: false }).run('true', [], { timeoutMs: 1_000 });
    expect(commands[0]).toBe('timeout -k 5 1 true');
  });
});
