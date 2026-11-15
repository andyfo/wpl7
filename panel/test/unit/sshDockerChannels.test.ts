import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { type Duplex, Writable } from 'node:stream';
import Docker from 'dockerode';
import { Server, utils, type ServerChannel } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerUnreachableError, SshConnection } from '../../src/servers/sshConnection.js';
import { SshDockerAgent } from '../../src/servers/sshDockerAgent.js';
import { DockerService } from '../../src/services/docker.js';
import { waitFor } from '../helpers.js';

/**
 * The pooled SSH connection to an added server, against an sshd that behaves as OpenSSH does where
 * it matters: a forwarded docker.sock channel is closed only once both of its halves have ended.
 *
 * Docker ends its half of an exec's connection when the command has exited and leaves the other
 * half to the client. A panel that never ended its own kept the channel, and its slot in the pool
 * of eight, for good: the ninth Docker call to the server waited for ever, and so did every call
 * after it. A reader that hung up before reading to the end kept its slot the same way.
 */

const frame = (payload: string): Buffer => {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Fails with `what` if `promise` takes longer than `ms`: a call stuck waiting for a channel. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Listens on a free port; afterEach drops whatever is still connected and closes it. */
async function listen(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (sock: net.Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** Just enough of dockerd for an exec: create it, start it, read its exit code. */
async function fakeDockerd(): Promise<number> {
  let execs = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(req.url ?? '')) return send(201, { Id: `exec-${++execs}` });
    if (req.method === 'GET' && /^\/exec\/[^/]+\/json$/.test(req.url ?? '')) return send(200, { Running: false, ExitCode: 0 });
    send(404, { message: `no route for ${req.method} ${req.url}` });
  });
  // An exec's start: the command's output, then Docker ends its own half and nothing else.
  server.on('upgrade', (_req, socket: net.Socket) => {
    socket.on('error', () => undefined);
    socket.resume();
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    socket.end(frame('ok\n'));
  });
  return listen(server);
}

/** A socket that has a lot to say and never ends its half: a command whose output nobody reads. */
async function chattySocket(): Promise<number> {
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('error', () => undefined);
    sock.write(Buffer.alloc(256 * 1024, 'y'));
  });
  return listen(server);
}

/**
 * OpenSSH's rule for a forwarded socket: the socket's EOF goes to the client as an EOF, the
 * client's EOF shuts the socket's write side, and the channel is closed once both have happened,
 * or when the client closes it.
 */
function forwardLikeOpenSsh(channel: ServerChannel, sock: net.Socket, onClosed: () => void): void {
  let sockEnded = false;
  let clientEnded = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClosed();
    channel.close();
    sock.destroy();
  };
  sock.on('error', close);
  sock.on('data', (chunk: Buffer) => channel.write(chunk));
  sock.on('end', () => {
    sockEnded = true;
    channel.eof();
    if (clientEnded) close();
  });
  channel.on('data', (chunk: Buffer) => sock.write(chunk));
  channel.on('end', () => {
    clientEnded = true;
    sock.end();
    if (sockEnded) close();
  });
  channel.on('close', close);
}

/** A command that prints without end, until the client hangs up: `cat` of a big backup. */
function printForEver(channel: ServerChannel): void {
  let gone = false;
  channel.on('close', () => (gone = true));
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const pump = () => {
    while (!gone && channel.write(chunk));
    if (!gone) channel.once('drain', pump);
  };
  pump();
}

/** Output, and the channel closed at once by the server: a command that is done, read or not. */
function closeFirst(channel: ServerChannel): void {
  channel.write(Buffer.alloc(256 * 1024, 'y'));
  channel.close();
}

/** Whether the server's close has arrived. ssh2 says so only once the stream has been read. */
const closedByServer = (channel: Duplex): boolean =>
  (channel as unknown as { incoming: { state: string } }).incoming.state === 'closed';

interface FakeSshd {
  port: number;
  /** The docker.sock channels it still holds. */
  open: () => number;
}

/**
 * An sshd that forwards docker.sock to `backendPort` and runs every other command as `printForEver`.
 * `drop` instead cuts the connection the moment a forward is asked for: a network that goes away.
 * `refuseForwarding` leaves the panel `docker system dial-stdio`, served like the socket, and
 * `closeFirst` serves both with `closeFirst` instead of a backend.
 */
async function fakeSshd(opts: {
  backendPort?: number;
  drop?: boolean;
  refuseForwarding?: boolean;
  closeFirst?: boolean;
}): Promise<FakeSshd> {
  let open = 0;
  let socket: net.Socket | null = null;
  const serveDocker = (channel: ServerChannel) => {
    if (opts.closeFirst) return closeFirst(channel);
    open++;
    forwardLikeOpenSsh(channel, net.connect(opts.backendPort!, '127.0.0.1'), () => open--);
  };
  // An OpenSSH ident: ssh2 only asks other servers for socket forwarding with strictVendor off.
  const ssh = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private], ident: 'OpenSSH_9.9' }, (client) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('openssh.streamlocal', (accept, reject) => {
        if (opts.drop) {
          socket?.destroy();
          return;
        }
        if (opts.refuseForwarding) return reject();
        serveDocker(accept());
      });
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec();
          if (info.command === 'docker system dial-stdio') serveDocker(channel);
          else printForEver(channel);
        });
      });
    });
  });
  const port = await listen(
    net.createServer((sock) => {
      socket = sock;
      ssh.injectSocket(sock);
    }),
  );
  return { port, open: () => open };
}

function connect(
  sshPort: number,
  warn: (msg: string) => void = () => undefined,
  opts: { hangUpCloseMs?: number } = {},
): SshConnection {
  const key = utils.generateKeyPairSync('ed25519').private;
  const conn = new SshConnection(
    {
      serverId: 2,
      serverName: 'worker',
      host: '127.0.0.1',
      port: sshPort,
      username: 'wpl7-panel',
      privateKey: () => key,
      pinnedHostKey: () => null,
    },
    warn,
    opts,
  );
  cleanups.push(() => conn.close());
  return conn;
}

describe('Docker channels over SSH', () => {
  it('gives back the channel of every exec, so twenty in a row never wait for one', async () => {
    const sshd = await fakeSshd({ backendPort: await fakeDockerd() });
    const conn = connect(sshd.port);
    const docker = new DockerService(
      'proxy',
      'db',
      new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(conn) } as never),
      { exitSettleMs: 200, exitPollMs: 10 },
    );
    for (let i = 1; i <= 20; i++) {
      expect(await within(docker.exec('wp-a', ['echo', 'ok']), 5_000, `exec ${i}`)).toEqual({
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
      });
    }
    await waitFor(() => sshd.open() === 0, 3_000);
  });

  it('closes the channel of a reader that hangs up before reading to the end, and gives it back', async () => {
    const sshd = await fakeSshd({ backendPort: await chattySocket() });
    const conn = connect(sshd.port);
    for (let i = 1; i <= 12; i++) {
      const channel = await within(conn.openDockerChannel(), 5_000, `channel ${i}`);
      await waitFor(() => channel.readableLength > 0, 3_000); // output there, unread
      const closed = once(channel, 'close');
      channel.destroy();
      // node:http's agent forgets a socket on 'close', and only then.
      await within(closed, 3_000, `'close' of channel ${i}`);
    }
    await waitFor(() => sshd.open() === 0, 3_000);
  });

  it("gives back a forwarded channel's slot at the hang-up, though no 'close' can follow it", async () => {
    const sshd = await fakeSshd({ closeFirst: true });
    // Long enough to notice: a forwarded channel is no sshd session, and never waits it out.
    const conn = connect(sshd.port, () => undefined, { hangUpCloseMs: 60_000 });
    const held: Duplex[] = [];
    for (let i = 1; i <= 8; i++) {
      const channel = await within(conn.openDockerChannel(), 5_000, `channel ${i}`);
      await waitFor(() => closedByServer(channel), 3_000); // closed, its output unread
      held.push(channel);
    }
    for (const channel of held) channel.destroy();
    (await within(conn.openDockerChannel(), 2_000, 'the ninth channel')).destroy();
  });

  it("gives back a dial-stdio channel's slot after a wait, not at the hang-up", async () => {
    const warnings: string[] = [];
    const sshd = await fakeSshd({ refuseForwarding: true, closeFirst: true });
    const conn = connect(sshd.port, (msg) => warnings.push(msg), { hangUpCloseMs: 300 });
    const held: Duplex[] = [];
    for (let i = 1; i <= 8; i++) {
      const channel = await within(conn.openDockerChannel(), 5_000, `channel ${i}`);
      await waitFor(() => closedByServer(channel), 3_000); // closed, its output unread
      held.push(channel);
    }
    expect(warnings.join(' ')).toContain('dial-stdio');
    const hungUpAt = Date.now();
    for (const channel of held) channel.destroy();
    // Each is a session that sshd may still count, so no slot comes back at the hang-up; and no
    // 'close' can follow, so the wait gives them back.
    (await within(conn.openDockerChannel(), 5_000, 'the ninth channel')).destroy();
    expect(Date.now() - hungUpAt).toBeGreaterThanOrEqual(250);
  });

  it('fails a forward whose connection drops, without taking the panel down', async () => {
    const warnings: string[] = [];
    const sshd = await fakeSshd({ drop: true });
    const conn = connect(sshd.port, (msg) => warnings.push(msg));
    const err = await within(
      conn.openDockerChannel().catch((e: unknown) => e),
      5_000,
      'the forward',
    );
    expect(err).toBeInstanceOf(ServerUnreachableError);
    // A lost connection is no refusal of forwarding: no fallback to dial-stdio.
    expect(warnings).toEqual([]);
  });
});

describe('Host commands over SSH', () => {
  it('hangs up on a command whose destination goes away (a download whose tab was closed)', async () => {
    const sshd = await fakeSshd({});
    const conn = connect(sshd.port);
    for (let i = 1; i <= 10; i++) {
      const dest = new Writable({
        highWaterMark: 16 * 1024,
        // Never acknowledges, and goes away without an error, like a destroyed HTTP response.
        write: () => setImmediate(() => dest.destroy()),
      });
      await expect(
        within(conn.exec('cat backup.tar', { stdout: dest, timeoutMs: 60_000 }), 3_000, `download ${i}`),
      ).rejects.toThrow(/destination closed before the command finished/);
    }
  });

  it('hangs up at once on a command whose destination was gone before its channel opened', async () => {
    const sshd = await fakeSshd({});
    const conn = connect(sshd.port);
    // Closed while the call waited for a channel, all eight being busy: no 'close' is left to hear.
    const dest = new Writable({ write: (_chunk, _enc, cb) => cb() });
    dest.destroy();
    await expect(within(conn.exec('cat backup.tar', { stdout: dest, timeoutMs: 60_000 }), 3_000, 'the download')).rejects.toThrow(
      /destination closed before the command started/,
    );
  });
});
