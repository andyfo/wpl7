import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import Modem from 'docker-modem';
import type Docker from 'dockerode';
import { DockerService } from '../../src/services/docker.js';

/**
 * The stdin half of `docker exec`, against a real socket.
 *
 * A unix-socket server stands in for the daemon's hijacked connection: it sees exactly what
 * the panel writes and when it half-closes, and answers in Docker's multiplexed framing.
 * That is the part a fake cannot model - EOF arriving as a half-close, and a command that
 * hangs up while the panel is still writing.
 */

const frame = (stream: 1 | 2, payload: string | Buffer): Buffer => {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

interface Harness {
  service: DockerService;
  /** Server-side sockets, in connection order. */
  accepted: net.Socket[];
  execConfigs: Record<string, unknown>[];
  close(): Promise<void>;
}

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** What exec inspect answers, one call after another: the last one repeats. */
type Inspect = { ExitCode: number | null; Running: boolean };

async function harness(
  onConnection: (sock: net.Socket) => void,
  exitCode = 0,
  inspects: Inspect[] = [{ ExitCode: exitCode, Running: false }],
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-exec-'));
  const socketPath = path.join(dir, 'd.sock');
  const accepted: net.Socket[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    accepted.push(sock);
    sock.on('error', () => undefined);
    onConnection(sock);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(socketPath, r));
  const execConfigs: Record<string, unknown>[] = [];
  const fakeDocker = {
    modem: new Modem({ socketPath }),
    getContainer: () => ({
      exec: async (config: Record<string, unknown>) => {
        execConfigs.push(config);
        return {
          start: async () => net.connect(socketPath),
          inspect: async () => (inspects.length > 1 ? inspects.shift()! : inspects[0]!),
        };
      },
    }),
  } as unknown as Docker;
  return {
    // Docker gives itself 3 s to record an exit; the fake records it on the given inspect or never.
    service: new DockerService('proxy', 'db', fakeDocker, { exitSettleMs: 200, exitPollMs: 10 }),
    accepted,
    execConfigs,
    close: async () => undefined,
  };
}

describe('DockerService.execWithInput', () => {
  it('delivers every byte, then EOF, and still reads the answer', async () => {
    const input = crypto.randomBytes(3 * 1024 * 1024);
    const h = await harness((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      // 'end' only fires on the half-close: the command's EOF.
      sock.on('end', () => {
        const got = Buffer.concat(chunks);
        const sha = crypto.createHash('sha256').update(got).digest('hex');
        sock.write(frame(1, `${got.length} ${sha}\n`));
        sock.end(frame(2, 'done\n'));
      });
    });
    const res = await h.service.execWithInput('wp-a', ['sh', '-c', 'cat > x'], input, {
      user: '33:33',
      workdir: '/var/www/html',
    });
    const want = crypto.createHash('sha256').update(input).digest('hex');
    expect(res).toEqual({ stdout: `${input.length} ${want}\n`, stderr: 'done\n', exitCode: 0 });
    expect(h.execConfigs[0]).toMatchObject({
      AttachStdin: true,
      User: '33:33',
      WorkingDir: '/var/www/html',
      Tty: false,
    });
    // The in-container deadline wraps the command, as for every exec.
    expect((h.execConfigs[0]!.Cmd as string[]).slice(0, 4)).toEqual(['timeout', '-k', '5', '120']);
  });

  it('reports the exit code of a command that hangs up before reading its input', async () => {
    const h = await harness((sock) => {
      // A failed precondition: answer at once and close without reading a byte.
      sock.end(frame(2, 'changed since you opened it\n'));
      setTimeout(() => sock.destroy(), 20);
    }, 14);
    const res = await h.service.execWithInput('wp-a', ['sh', '-c', 'exit 14'], crypto.randomBytes(5 * 1024 * 1024));
    expect(res.exitCode).toBe(14);
    expect(res.stderr).toContain('changed since you opened it');
  });

  it('handles empty input (a new, empty file)', async () => {
    const h = await harness((sock) => {
      let n = 0;
      sock.on('data', (c: Buffer) => (n += c.length));
      sock.on('end', () => sock.end(frame(1, String(n))));
    });
    const res = await h.service.execWithInput('wp-a', ['true'], Buffer.alloc(0));
    expect(res.stdout).toBe('0');
  });
});

describe('DockerService exec: live lines, hanging up, and a connection that drops', () => {
  it('hands a stdin command its output line by line as it comes, every line - past the cap too', async () => {
    const h = await harness((sock) => {
      sock.on('end', () => {
        sock.write(frame(1, 'first\nsec'));
        setTimeout(() => {
          sock.write(frame(2, 'a warning\n'));
          sock.write(frame(1, `ond\n${'x'.repeat(100)}\nlast`));
          sock.end();
        }, 20);
      });
      sock.resume();
    });
    const lines: string[] = [];
    const res = await h.service.execWithInput('wp-a', ['wp', 'db', 'query'], Buffer.from('SELECT 1'), {
      outputCap: 16,
      onOutput: (line) => lines.push(line),
    });
    expect(lines).toEqual(['first', 'a warning', 'second', 'x'.repeat(100), 'last']);
    // The cap bounds what is kept, not what is seen.
    expect(res.stdout).toContain('…[output truncated]');
  });

  it("does not guess an exit code for a command whose connection dropped while it still ran", async () => {
    const h = await harness((sock) => sock.end(frame(1, '{"ok":tr')), 0, [{ ExitCode: null, Running: true }]);
    await expect(h.service.exec('wp-a', ['wp', 'godmode', 'chat', 'send'])).rejects.toMatchObject({
      code: 'bad_gateway',
      message: expect.stringMatching(/^Lost the connection to wp while it was still running .* do not run it again/),
    });
  }, 10_000);

  it('waits the moment Docker takes to record an exit that the output already showed', async () => {
    const h = await harness((sock) => sock.end(frame(1, 'done')), 0, [
      { ExitCode: null, Running: true },
      { ExitCode: null, Running: true },
      { ExitCode: 3, Running: false },
    ]);
    expect(await h.service.exec('wp-a', ['wp', 'x'])).toEqual({ stdout: 'done', stderr: '', exitCode: 3 });
  });

  it('reports a command killed at its deadline as a timeout, not a plain failure', async () => {
    const h = await harness((sock) => sock.end(), 124);
    await expect(h.service.exec('wp-a', ['wp', 'x'], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'timeout',
      statusCode: 504,
      message: 'wp timed out after 1000ms and was killed inside the container',
    });
  });

  it('hangs up on a command whose caller went away, and says so', async () => {
    const closed = { at: null as number | null };
    const h = await harness((sock) => {
      // Half-open like Docker's end: the hang-up arrives as 'end'.
      sock.on('end', () => {
        closed.at = Date.now();
        sock.end();
      });
      sock.write(frame(1, 'waiting…\n'));
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(h.service.exec('wp-a', ['wp', 'godmode', 'chat', 'wait'], { signal: ac.signal })).rejects.toThrow(/abandoned/);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed.at).not.toBeNull();

    // Already gone before it started: nothing is run at all.
    await expect(h.service.exec('wp-a', ['wp', 'x'], { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(h.execConfigs).toHaveLength(1);
  });
});

describe('DockerService.execToStream', () => {
  /** A command with a lot to say: frames until the connection goes away. */
  const chatty = (closed: { at: number | null }) => (sock: net.Socket) => {
    const blob = frame(1, Buffer.alloc(64 * 1024, 120));
    const pump = () => {
      while (!sock.destroyed && sock.write(blob));
      if (!sock.destroyed) sock.once('drain', pump);
    };
    sock.on('close', () => (closed.at = Date.now()));
    pump();
  };

  it('hangs up when the destination closes (a download whose tab was closed)', async () => {
    const closed = { at: null as number | null };
    const h = await harness(chatty(closed));
    let received = 0;
    const dest = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        // Slow consumer: never acknowledges, so the source backs up...
        if (received > 256 * 1024) {
          // ...until the reader goes away without an error, like a destroyed HTTP response.
          setImmediate(() => dest.destroy());
          return;
        }
        cb();
      },
    });
    await expect(h.service.execToStream('wp-a', ['cat', 'big'], dest)).rejects.toThrow(/destination closed/);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed.at).not.toBeNull();
  });

  it('hangs up when the caller aborts', async () => {
    const closed = { at: null as number | null };
    const h = await harness(chatty(closed));
    const ac = new AbortController();
    const sink = new PassThrough();
    sink.resume();
    setTimeout(() => ac.abort(), 30);
    await expect(h.service.execToStream('wp-a', ['cat', 'big'], sink, { signal: ac.signal })).rejects.toThrow(/abandoned/);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed.at).not.toBeNull();
  });

  it('passes the working directory through', async () => {
    const h = await harness((sock) => sock.end(frame(1, 'ok')));
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const res = await h.service.execToStream('wp-a', ['pwd'], sink, { workdir: '/var/www/html', user: '33:33' });
    expect(res.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('ok');
    expect(h.execConfigs[0]).toMatchObject({ WorkingDir: '/var/www/html', User: '33:33' });
  });
});
