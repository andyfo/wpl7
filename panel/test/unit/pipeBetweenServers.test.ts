import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pipeBetweenServers } from '../../src/jobs/handlers/moveHelpers.js';
import type { ExecPort, ExecResult } from '../../src/lib/exec.js';
import type { ServerHandle } from '../../src/servers/registry.js';

/** Source: writes `payload` as soon as it is wired, like a local `tar` does. */
function sourceExec(payload: string): ExecPort {
  return {
    async run(): Promise<ExecResult> {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async runWithInput(): Promise<ExecResult> {
      throw new Error('not the source side');
    },
    async runToStream(_cmd, _args, stdout) {
      for (const chunk of payload.match(/.{1,8}/g) ?? []) stdout.write(chunk);
      stdout.end();
      return { exitCode: 0, stderr: '' };
    },
  };
}

/** Target: attaches only after `attachDelayMs`, like a remote SSH channel. */
function targetExec(received: { text: string }, attachDelayMs: number): ExecPort {
  return {
    async run(): Promise<ExecResult> {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async runWithInput(_cmd, _args, input: Readable) {
      await new Promise((r) => setTimeout(r, attachDelayMs));
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        input.on('error', reject);
        if (input.destroyed) return reject(new Error('source aborted'));
        input.pipe(
          new Writable({
            write(chunk: Buffer, _enc, cb) {
              chunks.push(Buffer.from(chunk));
              cb();
            },
            final(cb) {
              resolve();
              cb();
            },
          }),
        );
      });
      received.text = Buffer.concat(chunks).toString();
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async runToStream() {
      throw new Error('not the target side');
    },
  };
}

const handle = (exec: ExecPort) => ({ exec, name: 'x', id: 1 }) as unknown as ServerHandle;

describe('pipeBetweenServers', () => {
  it('loses nothing when the target attaches after the source has started writing', async () => {
    const payload = 'A'.repeat(64) + 'B'.repeat(64) + 'C'.repeat(64);
    const received = { text: '' };
    const seen: number[] = [];

    const { bytes } = await pipeBetweenServers({
      source: handle(sourceExec(payload)),
      sourceCmd: ['tar', []],
      target: handle(targetExec(received, 50)),
      targetCmd: ['tar', []],
      timeoutMs: 10_000,
      onBytes: (total) => seen.push(total),
    });

    expect(received.text).toBe(payload); // every byte, in order
    expect(bytes).toBe(payload.length);
    expect(seen.at(-1)).toBe(payload.length);
  });

  it('propagates a non-zero exit from either side', async () => {
    const failing: ExecPort = {
      ...sourceExec('data'),
      async runToStream() {
        return { exitCode: 2, stderr: 'tar: broken' };
      },
    };
    await expect(
      pipeBetweenServers({
        source: handle(failing),
        sourceCmd: ['tar', []],
        target: handle(targetExec({ text: '' }, 0)),
        targetCmd: ['tar', []],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/source tar failed \(exit 2\)/);
  });
});
