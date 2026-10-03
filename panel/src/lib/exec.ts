import { execFile, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOpts {
  timeoutMs?: number;
  cwd?: string;
}

export interface ExecPort {
  run(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Pipe a Readable into the command's stdin; stdout/stderr captured (bounded). */
  runWithInput(cmd: string, args: string[], input: Readable, opts?: ExecOpts): Promise<ExecResult>;
  /** Pipe the command's stdout into a Writable; stderr captured (bounded). */
  runToStream(
    cmd: string,
    args: string[],
    stdout: Writable,
    opts?: ExecOpts,
  ): Promise<{ exitCode: number; stderr: string }>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const STDERR_CAP = 64 * 1024;

/** The command is not on this machine (ENOENT). */
export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Command not found: ${command}`);
  }
}

function spawnStreaming(
  cmd: string,
  args: string[],
  opts: ExecOpts,
  wire: (child: ReturnType<typeof spawn>) => void,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(cmd) : err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 1 : 0), stderr });
    });
    wire(child);
  });
}

/** Host-command runner (tar, du, gzip …) with timeout and captured output. */
export const hostExec: ExecPort = {
  run(cmd, args, opts = {}) {
    return new Promise<ExecResult>((resolve, reject) => {
      execFile(
        cmd,
        args,
        {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cwd: opts.cwd,
          maxBuffer: 16 * 1024 * 1024,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new CommandNotFoundError(cmd));
            return;
          }
          if (error && error.killed) {
            reject(new Error(`${cmd} timed out after ${opts.timeoutMs ?? 600000}ms`));
            return;
          }
          const exitCode = error ? ((error as { code?: number | string }).code as number) ?? 1 : 0;
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: typeof exitCode === 'number' ? exitCode : 1,
          });
        },
      );
    });
  },

  async runWithInput(cmd, args, input, opts = {}) {
    let stdout = '';
    const { exitCode, stderr } = await spawnStreaming(cmd, args, opts, (child) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < STDERR_CAP) stdout += chunk.toString();
      });
      input.on('error', () => child.kill('SIGKILL'));
      // A child that exits early (bad flags, full disk, its own timeout) makes the next
      // write to stdin raise EPIPE. Unhandled, that 'error' event takes down the whole
      // panel process — API, worker and every other server's jobs with it. The command's
      // own exit code is the real error signal, so swallow the pipe teardown here.
      child.stdin?.on('error', () => input.unpipe(child.stdin!));
      input.pipe(child.stdin!);
    });
    return { stdout, stderr, exitCode };
  },

  runToStream(cmd, args, stdout, opts = {}) {
    return spawnStreaming(cmd, args, opts, (child) => {
      child.stdin?.end();
      // pipe() ends the destination on EOF — cross-server pipes and HTTP responses both rely on it.
      child.stdout!.pipe(stdout);
      stdout.on('error', () => child.kill('SIGKILL'));
    });
  },
};
