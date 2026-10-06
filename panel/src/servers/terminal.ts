// @docs servers/terminal
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import dns from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { servers, type ServerRow } from '../db/schema.js';
import type { Config } from '../config.js';
import { notFound } from '../lib/errors.js';
import type { Logger } from '../services/index.js';
import type { ServerRegistry } from './registry.js';
import { readPanelPrivateKey, readPanelPublicKey } from './keys.js';
import { sshFingerprint } from './sshConnection.js';
import { shellQuote } from './sshExec.js';
import { PANEL_CONTAINER } from '../services/stack.js';

export const MAX_TERMINALS = 10;
const IDLE_TIMEOUT_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MINUTES = IDLE_TIMEOUT_MS / 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** ready + shell() together; generous next to the ssh2 readyTimeout of 10s. */
const OPEN_DEADLINE_MS = 20_000;
const KEY_INSTALL_TIMEOUT_MS = 30_000;

/** One open PTY: write = stdin, 'data' = output. Returned by a ShellConnectFn. */
export interface OpenTerminal {
  channel: Duplex;
  setWindow(cols: number, rows: number): void;
  /** Resolves with the remote shell's exit code (null if never reported) on channel close. */
  exit: Promise<number | null>;
  /** Idempotent teardown of the channel and its SSH client. */
  dispose(): void;
}

export interface ShellConnectOpts {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  cols: number;
  rows: number;
  pinnedHostKey: () => string | null;
  onHostKeyCaptured?: (fingerprint: string) => void;
}

/** Injectable so tests exercise the service and route without touching ssh2. */
export type ShellConnectFn = (opts: ShellConnectOpts) => Promise<OpenTerminal>;

/** A live terminal as seen by the WS route. */
export interface TerminalHandle {
  channel: Duplex;
  setWindow(cols: number, rows: number): void;
  exit: Promise<number | null>;
  /** Record traffic so the idle sweeper leaves the session alone. */
  touch(): void;
  /** Tear down and unregister; safe to call more than once. */
  close(): void;
}

/**
 * Fresh, dedicated SSH connection per terminal - deliberately NOT the pooled
 * SshConnection: an interactive shell can sit open for hours and would starve
 * its 8-channel pool that all site operations on the server ride on.
 * (Exported for the live e2e harness; the service uses it as its default.)
 */
export const sshShellConnect: ShellConnectFn = (opts) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let hostKeyError: Error | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      client.end();
      reject(hostKeyError ?? err);
    };
    const deadline = setTimeout(
      () => fail(new Error(`connection timed out after ${OPEN_DEADLINE_MS / 1000}s`)),
      OPEN_DEADLINE_MS,
    );
    client.on('error', fail);
    client.on('close', () => fail(new Error('connection closed during setup')));
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, channel) => {
        if (err) return fail(err);
        if (settled) {
          channel.close();
          client.end();
          return;
        }
        settled = true;
        clearTimeout(deadline);
        // Post-setup errors must never bubble to the process handlers; the exit
        // promise below is how consumers observe the session ending.
        client.removeListener('error', fail);
        client.on('error', () => undefined);
        channel.on('error', () => undefined);
        // With a PTY all output arrives on the main stream; stderr is wired defensively.
        channel.stderr?.on('data', (chunk: Buffer) => channel.emit('data', chunk));
        let exitCode: number | null = null;
        const exit = new Promise<number | null>((res) => {
          channel.on('exit', (code: number | null) => {
            exitCode = code ?? null;
          });
          channel.on('close', () => {
            client.end();
            res(exitCode);
          });
        });
        resolve({
          channel,
          setWindow: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
          exit,
          dispose: () => {
            channel.close();
            client.end();
          },
        });
      });
    });
    try {
      client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        privateKey: opts.privateKey,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const fp = sshFingerprint(key);
          const pinned = opts.pinnedHostKey();
          if (pinned) {
            if (fp !== pinned) {
              hostKeyError = new Error(
                `Host key for ${opts.host} changed (expected ${pinned}, got ${fp}) - ` +
                  `possible MITM or reinstalled server; re-trust it on the Servers page`,
              );
              return false;
            }
            return true;
          }
          opts.onHostKeyCaptured?.(fp);
          return true;
        },
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });

/** Little-endian hex gateway of the default route in /proc/net/route, as dotted quad. */
export function defaultGatewayFromRouteTable(text: string): string | null {
  for (const line of text.split('\n').slice(1)) {
    const [, dest, gw] = line.trim().split(/\s+/);
    if (dest === '00000000' && gw && gw !== '00000000' && /^[0-9A-Fa-f]{8}$/.test(gw)) {
      const n = parseInt(gw, 16);
      return `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >>> 24) & 0xff}`;
    }
  }
  return null;
}

/**
 * Where sshd for the panel's own host lives, seen from inside the panel container.
 * Prefers the compose-provided host-gateway alias; falls back to the routing table
 * so containers created before that compose change still work.
 */
export async function resolveLocalSshHost(): Promise<string> {
  if (!fs.existsSync('/.dockerenv')) return '127.0.0.1';
  try {
    await dns.lookup('host.docker.internal');
    return 'host.docker.internal';
  } catch {
    // extra_hosts not present (container predates it); derive the gateway instead.
  }
  const table = await fsp.readFile('/proc/net/route', 'utf8').catch(() => '');
  const gateway = defaultGatewayFromRouteTable(table);
  if (gateway) return gateway;
  throw new Error(
    'Cannot determine the host address from inside the container - ' +
      'recreate the panel with the current compose file (it adds a host-gateway mapping)',
  );
}

const isAuthFailure = (err: unknown): boolean =>
  (err as { level?: string }).level === 'client-authentication' ||
  (err instanceof Error && err.message.includes('All configured authentication methods failed'));

/** POSIX-sh statements that idempotently add the panel key to an authorized_keys file. */
export function rootKeyInstallScript(sshDir: string, publicKey: string): string {
  const ak = `${sshDir}/authorized_keys`;
  const key = shellQuote([publicKey]);
  return (
    `install -d -m 700 ${sshDir}; ` +
    `touch ${ak}; chmod 600 ${ak}; ` +
    // A last line with no terminating newline would otherwise get the key glued
    // onto its end: no valid key line, so root login keeps failing - and a
    // substring match would then find the key inside that mangled line forever,
    // so no retry could ever repair it. Hence both the newline guard and -x
    // (whole-line match), which makes a damaged file self-heal on the next run.
    `if [ -s ${ak} ] && [ -n "$(tail -c1 ${ak})" ]; then printf '\\n' >> ${ak}; fi; ` +
    `grep -qxF -- ${key} ${ak} || printf '%s\\n' ${key} >> ${ak}`
  );
}

interface ActiveSession {
  handle: TerminalHandle;
  lastActivity: number;
  onIdle?: () => void;
}

export interface TerminalCallbacks {
  /** Connection progress, shown in the terminal before the shell opens. */
  onStatus?: (message: string) => void;
  /** Fired once right before an idle session is torn down. */
  onIdle?: () => void;
}

export class TerminalService {
  private sessions = new Set<ActiveSession>();
  /** Opens that passed the cap check but have not registered a session yet. */
  private pending = 0;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly connect: ShellConnectFn;
  private readonly inContainer: () => boolean;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly registry: ServerRegistry,
    private readonly log: Logger,
    overrides: { connect?: ShellConnectFn; inContainer?: () => boolean } = {},
  ) {
    this.connect = overrides.connect ?? sshShellConnect;
    this.inContainer = overrides.inContainer ?? (() => fs.existsSync('/.dockerenv'));
  }

  count(): number {
    // In-flight opens are counted: they hold a reserved slot, so the route's
    // pre-upgrade check must not wave through more than the cap allows either.
    return this.sessions.size + this.pending;
  }

  /**
   * Open a root shell on a server. On "wrong key" auth failures the panel key is
   * installed into root's authorized_keys (idempotent) and the connect retried once -
   * so the terminal works out of the box on hosts provisioned before this feature.
   */
  async open(
    serverId: number,
    size: { cols: number; rows: number },
    callbacks: TerminalCallbacks = {},
  ): Promise<TerminalHandle> {
    const row = this.registry.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    // Reserve the slot here, before anything yields. Opening involves a DNS
    // lookup, an SSH handshake and possibly a key install + reconnect, so a
    // check that only counted registered sessions would let every concurrent
    // open past it at once and blow through the cap together.
    if (this.count() >= MAX_TERMINALS) {
      throw new Error(`Terminal limit reached (${MAX_TERMINALS} concurrent sessions)`);
    }
    this.pending++;
    try {
      return await this.openReserved(serverId, row, size, callbacks);
    } finally {
      this.pending--;
    }
  }

  private async openReserved(
    serverId: number,
    row: ServerRow,
    size: { cols: number; rows: number },
    callbacks: TerminalCallbacks,
  ): Promise<TerminalHandle> {
    const target =
      row.kind === 'local'
        ? { host: await resolveLocalSshHost(), port: 22 }
        : { host: row.sshHost ?? '', port: row.sshPort };
    const connectOpts: ShellConnectOpts = {
      ...target,
      username: 'root',
      privateKey: readPanelPrivateKey(this.config),
      cols: size.cols,
      rows: size.rows,
      // Read fresh on every connect (the row may get pinned between retries).
      pinnedHostKey: () => this.registry.rowById(serverId)?.hostKeySha256 ?? null,
      onHostKeyCaptured: (fp) => {
        // Trust-on-first-use, like the pooled connection: pin so a later change fails loudly.
        this.db.update(servers).set({ hostKeySha256: fp, updatedAt: Date.now() }).where(eq(servers.id, serverId)).run();
        this.log.info(`Server "${row.name}": pinned host key ${fp} (terminal)`);
      },
    };

    callbacks.onStatus?.(`Connecting to root@${target.host}…`);
    let terminal: OpenTerminal;
    try {
      terminal = await this.connect(connectOpts);
    } catch (err) {
      if (!isAuthFailure(err)) throw err;
      callbacks.onStatus?.("Root login refused; installing the panel's key…");
      await this.ensureRootKey(row);
      callbacks.onStatus?.(`Key installed; reconnecting to root@${target.host}…`);
      terminal = await this.connect(connectOpts);
    }

    const session: ActiveSession = {
      lastActivity: Date.now(),
      onIdle: callbacks.onIdle,
      // Explicit delegation, not a spread: an OpenTerminal implemented as a class
      // (the test fake) keeps its methods on the prototype, which a spread drops.
      handle: {
        channel: terminal.channel,
        exit: terminal.exit,
        setWindow: (cols, rows) => terminal.setWindow(cols, rows),
        touch: () => {
          session.lastActivity = Date.now();
        },
        close: () => {
          if (!this.sessions.has(session)) return;
          this.sessions.delete(session);
          if (this.sessions.size === 0) this.stopSweeper();
          terminal.dispose();
        },
      },
    };
    this.sessions.add(session);
    this.startSweeper();
    this.log.info(`Terminal opened for server "${row.name}" (#${serverId}); ${this.sessions.size} active`);
    return session.handle;
  }

  /**
   * Put the panel's public key into root's authorized_keys. Convenience, not new
   * privilege: every path used here (NOPASSWD sudo on workers, docker.sock on the
   * local host) is access the panel already holds.
   */
  private async ensureRootKey(row: ServerRow): Promise<void> {
    const publicKey = readPanelPublicKey(this.config);
    const handle = this.registry.handleFor(row.id);
    if (row.kind === 'ssh') {
      const res = await handle.exec.run('sh', ['-c', rootKeyInstallScript('/root/.ssh', publicKey)], {
        timeoutMs: KEY_INSTALL_TIMEOUT_MS,
      });
      if (res.exitCode !== 0) {
        throw new Error(`Installing the panel key for root failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 300)}`);
      }
      return;
    }
    // Local server: the panel runs in a container, so /root is out of reach directly -
    // but the mounted docker.sock isn't. A throwaway container binds the host's /root.
    if (!this.inContainer()) {
      throw new Error(
        "Root login refused and the panel isn't containerized (dev mode) - " +
          "add the panel's public key (Servers page) to /root/.ssh/authorized_keys yourself",
      );
    }
    // The panel's own image, whatever it happens to be: a released tag on GHCR, a local
    // build, a pinned fork. Hardcoding a name here broke the moment a box stopped building
    // its own panel, and this container only has to contain a shell.
    const image = (await handle.docker.containerImage(PANEL_CONTAINER)) ?? 'wpl7-panel:dev';
    const res = await handle.docker.runEphemeral({
      image,
      cmd: ['sh', '-c', rootKeyInstallScript('/hostroot/.ssh', publicKey)],
      binds: ['/root:/hostroot'],
      networks: [],
      timeoutMs: KEY_INSTALL_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(`Installing the panel key for root failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 300)}`);
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_TIMEOUT_MS;
      for (const session of [...this.sessions]) {
        if (session.lastActivity < cutoff) {
          session.onIdle?.();
          session.handle.close();
        }
      }
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  private stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  closeAll(): void {
    for (const session of [...this.sessions]) session.handle.close();
  }
}
