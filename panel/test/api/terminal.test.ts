import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { TerminalServerMsg } from '../../shared/types.js';
import { makeApp, makeWorld, waitFor } from '../helpers.js';

/**
 * injectWS fabricates the upgrade request without a socket; give it one so
 * req.ip (rate-limit key, log serializer) resolves like on a real connection.
 */
const upgradeCtx = (cookie: string): Partial<IncomingMessage> => ({
  headers: { cookie },
  socket: { remoteAddress: '127.0.0.1' } as unknown as IncomingMessage['socket'],
});

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world, cookie: `${c.name}=${c.value}` };
}

interface Frame {
  binary: boolean;
  data: Buffer;
}

/**
 * Frame recorder. Attach via injectWS's onInit - the server may write its first
 * frames before the injectWS promise resolves, and listeners added after the
 * fact would miss them.
 */
function makeCollector() {
  const frames: Frame[] = [];
  const controls: TerminalServerMsg[] = [];
  let code: number | null = null;
  const onInit = (ws: WebSocket) => {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
      frames.push({ binary: isBinary, data: buf });
      if (!isBinary) {
        try {
          controls.push(JSON.parse(buf.toString('utf8')) as TerminalServerMsg);
        } catch {
          /* not a control frame */
        }
      }
    });
    ws.on('close', (c: number) => {
      code = c;
    });
  };
  return { frames, controls, closeCode: () => code, onInit };
}

describe('terminal API', () => {
  it('rejects the upgrade without a session', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/servers/1/terminal' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects cross-origin upgrades before auth even runs', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/servers/1/terminal',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    await app.close();
  });

  it('rejects with 429 once the session cap is reached', async () => {
    const { app, world, cookie } = await authedApp();
    const handles = [];
    for (let i = 0; i < 10; i++) handles.push(await world.deps.terminal.open(1, { cols: 80, rows: 24 }));
    const res = await app.inject({ method: 'GET', url: '/api/servers/1/terminal', headers: { cookie } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    world.deps.terminal.closeAll();
    await app.close();
  });

  it('bridges the PTY: ready, output, stdin, resize, exit', async () => {
    const { app, world, cookie } = await authedApp();
    const { frames, controls, closeCode, onInit } = makeCollector();
    const ws = await app.injectWS('/api/servers/1/terminal?cols=100&rows=30', upgradeCtx(cookie), { onInit });

    await waitFor(() => controls.some((m) => m.t === 'ready'));
    const fake = world.shell.opened[0]!;
    expect(fake.opts).toMatchObject({ cols: 100, rows: 30, username: 'root' });

    fake.output('root@server:~# ');
    await waitFor(() => frames.some((f) => f.binary && f.data.toString() === 'root@server:~# '));

    ws.send(Buffer.from('ls\n'));
    await waitFor(() => fake.stdin.some((b) => b.toString() === 'ls\n'));

    ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    await waitFor(() => fake.resizes.length > 0);
    expect(fake.resizes[0]).toEqual({ cols: 120, rows: 40 });

    // Hostile/garbage control frames must be ignored, and resizes clamped.
    ws.send('not json at all');
    ws.send(JSON.stringify({ t: 'resize', cols: 99999, rows: 1 }));
    await waitFor(() => fake.resizes.length > 1);
    expect(fake.resizes[1]).toEqual({ cols: 500, rows: 5 });

    fake.end(0);
    await waitFor(() => controls.some((m) => m.t === 'exit' && m.code === 0));
    await waitFor(() => closeCode() !== null);
    expect(closeCode()).toBe(1000);
    expect(world.deps.terminal.count()).toBe(0);
    await app.close();
  });

  it('replays input and a resize that arrived while the SSH session was opening', async () => {
    const { app, world, cookie } = await authedApp();
    // Block the connect: the browser's socket is open, but no PTY exists yet.
    world.shell.hold();
    const { controls, onInit } = makeCollector();
    const ws = await app.injectWS('/api/servers/1/terminal?cols=80&rows=24', upgradeCtx(cookie), { onInit });
    await waitFor(() => world.shell.connects.length === 1);

    ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    ws.send(Buffer.from('whoami\n'));
    // Let both frames reach the server while it is still inside the connect.
    await new Promise((r) => setTimeout(r, 50));
    expect(world.shell.opened).toHaveLength(0);

    world.shell.release();
    await waitFor(() => controls.some((m) => m.t === 'ready'));
    const fake = world.shell.opened[0]!;
    await waitFor(() => fake.stdin.some((b) => b.toString() === 'whoami\n'));
    // Geometry is applied before the replayed input, not left at the query-string size.
    expect(fake.resizes[0]).toEqual({ cols: 120, rows: 40 });
    ws.terminate();
    await app.close();
  });

  it('reports connect failures over the socket and closes with 1011', async () => {
    const { app, world, cookie } = await authedApp();
    world.shell.failQueue.push(new Error('connect ECONNREFUSED 203.0.113.1:22'));
    const { controls, closeCode, onInit } = makeCollector();
    await app.injectWS('/api/servers/1/terminal', upgradeCtx(cookie), { onInit });
    await waitFor(() => controls.some((m) => m.t === 'error' && m.message.includes('ECONNREFUSED')));
    await waitFor(() => closeCode() !== null);
    expect(closeCode()).toBe(1011);
    expect(world.deps.terminal.count()).toBe(0);
    await app.close();
  });

  it('tears the SSH session down when the browser disconnects', async () => {
    const { app, world, cookie } = await authedApp();
    const { controls, onInit } = makeCollector();
    const ws = await app.injectWS('/api/servers/1/terminal', upgradeCtx(cookie), { onInit });
    await waitFor(() => controls.some((m) => m.t === 'ready'));
    // terminate(), not close(): injectWS's in-memory stream pair never delivers the
    // raw-socket end that completes a graceful close handshake (a real TCP client
    // does), so model the browser vanishing abruptly instead.
    ws.terminate();
    await waitFor(() => world.shell.opened[0]!.disposed);
    expect(world.deps.terminal.count()).toBe(0);
    await app.close();
  });
});
