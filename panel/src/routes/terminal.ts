import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { badRequest, forbidden, tooManyRequests } from '../lib/errors.js';
import { IDLE_TIMEOUT_MINUTES, MAX_TERMINALS, type TerminalHandle } from '../servers/terminal.js';
import { recordUpgrade } from '../plugins/apiActivity.js';
import type { TerminalClientMsg, TerminalServerMsg } from '../../shared/types.js';
import type { AppDeps } from './deps.js';

const PING_INTERVAL_MS = 30_000;
/** Pause the PTY when this much output sits unsent in the socket… */
const BUFFER_HIGH_WATER = 1024 * 1024;
/** …resume once the client has drained it down to this. */
const BUFFER_LOW_WATER = 256 * 1024;
/** Ceiling on stdin buffered while the SSH session is still being set up. */
const EARLY_INPUT_CAP = 64 * 1024;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Initial PTY size from the query string; clamped, defaults 80×24. */
export function parseSize(query: Record<string, unknown>): { cols: number; rows: number } {
  const num = (value: unknown, fallback: number) => {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    cols: clamp(num(query.cols, 80), 20, 500),
    rows: clamp(num(query.rows, 24), 5, 300),
  };
}

/**
 * Interactive root shell over a WebSocket (wire protocol in shared/types.ts).
 * Auth rides the normal /api/* gate: the upgrade GET carries the session cookie
 * (or a Bearer key) and the global preHandler rejects before the handshake.
 */
export function registerTerminalRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.addHook('onClose', async () => deps.terminal.closeAll());

  app.get(
    '/api/servers/:id/terminal',
    {
      websocket: true,
      // Runs before the auth preHandler - rejections here reveal nothing.
      preValidation: async (req) => {
        // GET upgrades are exempt from the X-CSRF header, so pin the Origin instead
        // (browsers always send it on WS handshakes; absent = non-browser client,
        // which still has to present a session cookie or Bearer key).
        const origin = req.headers.origin;
        if (origin) {
          let host: string | null;
          try {
            host = new URL(origin).host;
          } catch {
            host = null;
          }
          if (!host || host !== req.headers.host) {
            throw forbidden('Cross-origin terminal connections are not allowed');
          }
        }
        if (!/^\d+$/.test((req.params as { id: string }).id)) throw badRequest('Invalid server id');
        if (deps.terminal.count() >= MAX_TERMINALS) {
          throw tooManyRequests(`Terminal limit reached (${MAX_TERMINALS} concurrent sessions)`);
        }
      },
    },
    (socket, req) => {
      // The upgrade succeeded, which means the reply is hijacked and the activity hook
      // will never fire for it. A key opening a root shell is the last thing that should
      // be missing from the log, so it is recorded here instead.
      recordUpgrade(deps.apiActivity, req, deps.apiKeys);
      void handleTerminal(socket, req, deps);
    },
  );
}

const toBuffer = (data: Buffer | ArrayBuffer | Buffer[]): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

async function handleTerminal(socket: WebSocket, req: FastifyRequest, deps: AppDeps): Promise<void> {
  const serverId = Number((req.params as { id: string }).id);
  const size = parseSize(req.query as Record<string, unknown>);

  const sendCtl = (msg: TerminalServerMsg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  let session: TerminalHandle | null = null;
  let wsClosed = false;
  // Frames sent while the SSH session is still being set up (handshake, and on the
  // self-heal path a key install plus a reconnect - seconds, not milliseconds). The
  // socket is already open to the browser by then and ws drops events that have no
  // listener, so the handler is registered up front and buffers: otherwise early
  // keystrokes vanish and a resize sent during setup is lost, leaving the PTY at the
  // wrong geometry for the rest of the session.
  const early: { input: Buffer[]; bytes: number; resize: { cols: number; rows: number } | null } = {
    input: [],
    bytes: 0,
    resize: null,
  };
  // A socket error without a listener would throw; terminate() then fires 'close'.
  socket.on('error', () => socket.terminate());
  socket.on('close', () => {
    wsClosed = true;
    session?.close();
  });

  // Input: binary = stdin bytes, text = one JSON control message.
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    session?.touch();
    if (isBinary) {
      const chunk = toBuffer(data);
      if (session) {
        session.channel.write(chunk);
      } else if (early.bytes + chunk.length <= EARLY_INPUT_CAP) {
        early.input.push(chunk);
        early.bytes += chunk.length;
      }
      return;
    }
    let msg: TerminalClientMsg;
    try {
      msg = JSON.parse(toBuffer(data).toString('utf8')) as TerminalClientMsg;
    } catch {
      return; // malformed control frame - never a reason to kill a root shell
    }
    if (msg?.t === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      const cols = clamp(msg.cols, 20, 500);
      const rows = clamp(msg.rows, 5, 300);
      // Before the PTY exists only the latest size matters.
      if (session) session.setWindow(cols, rows);
      else early.resize = { cols, rows };
    }
  });

  try {
    session = await deps.terminal.open(serverId, size, {
      onStatus: (message) => sendCtl({ t: 'status', message }),
      onIdle: () => {
        sendCtl({ t: 'error', message: `Session closed after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity` });
        socket.close(1000, 'idle timeout');
      },
    });
  } catch (err) {
    req.log.warn({ err, serverId }, 'terminal open failed');
    sendCtl({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    socket.close(1011, 'terminal open failed');
    return;
  }
  if (wsClosed) {
    // Browser went away while the SSH connection was still being set up.
    session.close();
    return;
  }
  const active = session;
  sendCtl({ t: 'ready' });

  // Output: PTY -> socket, pausing the channel while the client lags behind.
  let paused = false;
  active.channel.on('data', (chunk: Buffer) => {
    active.touch();
    if (socket.readyState !== socket.OPEN) return;
    socket.send(chunk, { binary: true }, () => {
      if (paused && socket.bufferedAmount < BUFFER_LOW_WATER) {
        paused = false;
        active.channel.resume();
      }
    });
    if (!paused && socket.bufferedAmount > BUFFER_HIGH_WATER) {
      paused = true;
      active.channel.pause();
    }
  });

  // Replay what arrived during setup: geometry first, so the shell never sees
  // input at a size it is about to leave.
  if (early.resize) active.setWindow(early.resize.cols, early.resize.rows);
  for (const chunk of early.input) active.channel.write(chunk);
  early.input.length = 0;
  early.bytes = 0;

  void active.exit.then((code) => {
    sendCtl({ t: 'exit', code });
    active.close();
    socket.close(1000, 'shell exited');
  });

  // Keepalive: keeps Traefik/NAT paths open and reaps browsers that vanished
  // without a FIN (laptop lid closed, network drop).
  let missedPongs = 0;
  const pinger = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (missedPongs >= 2) {
      socket.terminate();
      return;
    }
    missedPongs++;
    socket.ping();
  }, PING_INTERVAL_MS);
  pinger.unref();
  socket.on('pong', () => {
    missedPongs = 0;
  });
  socket.on('close', () => clearInterval(pinger));
}
