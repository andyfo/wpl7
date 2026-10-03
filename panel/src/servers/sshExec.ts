import type { Readable, Writable } from 'node:stream';
import type { ExecOpts, ExecPort, ExecResult } from '../lib/exec.js';
import type { SshConnection } from './sshConnection.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Extra client-side grace on top of the remote `timeout` wrapper. */
const CLIENT_GRACE_MS = 15_000;

const SAFE_WORD_RE = /^[A-Za-z0-9_/.:=,@%^+-]+$/;

/** Quote argv words for a remote `sh -c`-style command string. */
export function shellQuote(args: string[]): string {
  return args
    .map((a) => {
      if (a === '') return "''";
      if (SAFE_WORD_RE.test(a)) return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

/**
 * ExecPort over SSH. Commands run as root via `sudo -n` so host-side file operations
 * (chown 33:33, rm -rf under /srv) behave exactly like the root panel container does
 * locally. Belt and braces on timeouts: remote GNU `timeout` plus a client-side cap.
 */
export class SshExec implements ExecPort {
  constructor(
    private readonly conn: SshConnection,
    private readonly opts: { sudo: boolean } = { sudo: true },
  ) {}

  private command(cmd: string, args: string[], opts?: ExecOpts): { line: string; clientTimeoutMs: number } {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    let line = `timeout -k 5 ${timeoutSec} ${shellQuote([cmd, ...args])}`;
    if (this.opts.sudo) line = `sudo -n -- ${line}`;
    if (opts?.cwd) line = `cd ${shellQuote([opts.cwd])} && ${line}`;
    return { line, clientTimeoutMs: timeoutMs + CLIENT_GRACE_MS };
  }

  async run(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult> {
    const { line, clientTimeoutMs } = this.command(cmd, args, opts);
    return this.conn.exec(line, { timeoutMs: clientTimeoutMs });
  }

  async runWithInput(cmd: string, args: string[], input: Readable, opts?: ExecOpts): Promise<ExecResult> {
    const { line, clientTimeoutMs } = this.command(cmd, args, opts);
    return this.conn.exec(line, { input, timeoutMs: clientTimeoutMs });
  }

  async runToStream(
    cmd: string,
    args: string[],
    stdout: Writable,
    opts?: ExecOpts,
  ): Promise<{ exitCode: number; stderr: string }> {
    const { line, clientTimeoutMs } = this.command(cmd, args, opts);
    const res = await this.conn.exec(line, { stdout, timeoutMs: clientTimeoutMs });
    return { exitCode: res.exitCode, stderr: res.stderr };
  }
}
