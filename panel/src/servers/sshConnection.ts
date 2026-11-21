import crypto from 'node:crypto';
import type { Duplex, Readable, Writable } from 'node:stream';
import { Client } from 'ssh2';

export class ServerUnreachableError extends Error {
  constructor(
    public readonly serverId: number,
    public readonly serverName: string,
    public readonly cause2: Error,
  ) {
    super(`Server "${serverName}" (#${serverId}) is unreachable over SSH: ${cause2.message}`);
    this.name = 'ServerUnreachableError';
  }
}

export interface SshTarget {
  serverId: number;
  serverName: string;
  host: string;
  port: number;
  username: string;
  /** Lazy so the key file is only read when a connection is actually needed. */
  privateKey: () => string;
  /**
   * SHA256:<base64> pin; null = trust-on-first-use (capture via onHostKeyCaptured).
   * Read fresh on EVERY connect: this object outlives the first handshake (the registry
   * caches the handle), so a snapshot taken at construction would stay null forever and
   * every reconnect would silently re-trust — and re-pin — whatever key was presented.
   */
  pinnedHostKey: () => string | null;
  onHostKeyCaptured?: (fingerprint: string) => void;
}

const MAX_CHANNELS = 8;
/**
 * How long the slot of a hung-up dial-stdio channel waits for the 'close' that gives it back, before
 * it comes back anyway: none follows when the server closed the channel first, or the connection
 * dropped, with output still unread.
 */
const HANG_UP_CLOSE_MS = 2_000;
const FAIL_FAST_MS = 5_000;
const CHANNEL_OPEN_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 1024 * 1024;

export function sshFingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/**
 * One pooled SSH connection per server. Docker API calls and host commands each ride
 * a cheap channel on this connection instead of a fresh TCP+SSH handshake per call.
 */
export class SshConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** The Client of an in-flight connect, so close() can tear it down mid-handshake. */
  private pending: Client | null = null;
  private closed = false;
  private lastFail: { err: Error; at: number } | null = null;
  private channels = 0;
  private waiters: (() => void)[] = [];
  /** Set when streamlocal forwarding is administratively prohibited on the server. */
  private useDialStdio = false;
  private warnedDialStdio = false;
  private readonly hangUpCloseMs: number;

  constructor(
    private readonly target: SshTarget,
    private readonly warn: (msg: string) => void = () => undefined,
    /** HANG_UP_CLOSE_MS when left out; a test waits milliseconds. */
    opts: { hangUpCloseMs?: number } = {},
  ) {
    this.hangUpCloseMs = opts.hangUpCloseMs ?? HANG_UP_CLOSE_MS;
  }

  /** A session is open: its keepalives (15 s, three missed) close it within a minute once the server is gone. */
  get up(): boolean {
    return this.client !== null;
  }

  private unreachable(err: Error): ServerUnreachableError {
    if (err instanceof ServerUnreachableError) return err;
    return new ServerUnreachableError(this.target.serverId, this.target.serverName, err);
  }

  private async acquire(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (this.lastFail && Date.now() - this.lastFail.at < FAIL_FAST_MS) {
      throw this.unreachable(this.lastFail.err);
    }
    this.closed = false;
    this.connecting = new Promise<Client>((resolve, reject) => {
      const client = new Client();
      this.pending = client;
      let settled = false;
      let hostKeyError: Error | null = null;
      client.on('ready', () => {
        settled = true;
        this.connecting = null;
        this.pending = null;
        this.lastFail = null;
        // close() may have been called while this handshake was still running.
        if (this.closed) {
          client.end();
          reject(this.unreachable(new Error('connection closed during handshake')));
          return;
        }
        this.client = client;
        resolve(client);
      });
      client.on('error', (err: Error) => {
        const wrapped = hostKeyError ?? err;
        if (!settled) {
          settled = true;
          this.connecting = null;
          this.lastFail = { err: wrapped, at: Date.now() };
          reject(this.unreachable(wrapped));
        }
        if (this.pending === client) this.pending = null;
        if (this.client === client) this.client = null;
      });
      client.on('close', () => {
        if (this.pending === client) this.pending = null;
        if (this.client === client) this.client = null;
      });
      try {
        client.connect({
          host: this.target.host,
          port: this.target.port,
          username: this.target.username,
          privateKey: this.target.privateKey(),
          readyTimeout: 10_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const fp = sshFingerprint(key);
            const pinned = this.target.pinnedHostKey();
            if (pinned) {
              if (fp !== pinned) {
                hostKeyError = new Error(
                  `Host key for ${this.target.host} changed (expected ${pinned}, got ${fp}) - ` +
                    `possible MITM or reinstalled server; re-trust it on the Servers page`,
                );
                return false;
              }
              return true;
            }
            this.target.onHostKeyCaptured?.(fp);
            return true;
          },
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          this.connecting = null;
          this.pending = null;
          const e = err instanceof Error ? err : new Error(String(err));
          this.lastFail = { err: e, at: Date.now() };
          reject(this.unreachable(e));
        }
      }
    });
    return this.connecting;
  }

  private acquireSlot(): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.channels--;
      this.waiters.shift()?.();
    };
    if (this.channels < MAX_CHANNELS) {
      this.channels++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.channels++;
        resolve(release);
      });
    });
  }

  /**
   * Open a channel speaking directly to the remote /var/run/docker.sock.
   * The OPEN itself is deadlined: a wedged dockerd (or an sshd that accepts the channel
   * request and then stalls) would otherwise hold its pool slot forever, and eight of
   * those brick every subsequent operation on the server.
   */
  async openDockerChannel(): Promise<Duplex> {
    const release = await this.acquireSlot();
    try {
      const client = await this.acquire();
      /** Set for the dial-stdio shim, whose channel is an sshd session (MaxSessions counts it). */
      let session = false;
      const channel = await new Promise<Duplex>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`opening a docker channel timed out after ${CHANNEL_OPEN_TIMEOUT_MS}ms`));
        }, CHANNEL_OPEN_TIMEOUT_MS);
        const ok = (stream: Duplex) => {
          if (settled) {
            stream.destroy(); // arrived after the deadline; nothing is listening
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(stream);
        };
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        };
        const dialStdio = () => {
          try {
            client.exec('docker system dial-stdio', (err, stream) => {
              if (err) return fail(err);
              session = true;
              ok(stream);
            });
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err))); // 'Not connected'
          }
        };
        if (this.useDialStdio) {
          dialStdio();
          return;
        }
        client.openssh_forwardOutStreamLocal('/var/run/docker.sock', (err, stream) => {
          if (!err) return ok(stream);
          // A connection lost while the forward was being opened fails it too. That is no refusal,
          // and the shim cannot run on a closed connection: client.exec would throw out of ssh2's
          // event handler and take the panel down.
          if (this.client !== client) return fail(err);
          // Non-default sshd may prohibit streamlocal forwarding; fall back to the docker CLI shim.
          this.useDialStdio = true;
          if (!this.warnedDialStdio) {
            this.warnedDialStdio = true;
            this.warn(
              `${this.target.serverName}: socket forwarding unavailable (${err.message}); using "docker system dial-stdio" fallback`,
            );
          }
          dialStdio();
        });
      });
      // Docker ends its half of a connection once it is done with it (an exec's, when the command
      // has exited) and leaves the other half to the client. Node ends a local socket's other half
      // by itself; an SSH channel stays half-open, and sshd keeps a forwarded one open until both
      // halves have ended. Without this, every exec kept its slot, and once MAX_CHANNELS of them
      // had, every later Docker call to the server waited for one.
      channel.once('end', () => channel.end());
      // A hang-up marks the stream as no longer readable, so that a 'close' follows: ssh2 says
      // 'close' only once a stream has been read to its end or is no longer readable, and a reader
      // that hangs up has stopped reading. Without it a download whose tab was closed kept its slot
      // for good, and node:http's agent kept its channel, never told that it had closed.
      //
      // A forwarded socket's channel gives its slot back at the hang-up. It is no sshd session, and
      // sshd may keep it a long while yet, until Docker lets go of a connection it holds unread
      // input for. A dial-stdio channel is a session, and one opened before the last has gone counts
      // against sshd's MaxSessions, which refuses it: its slot waits for the 'close'.
      const destroy = channel.destroy.bind(channel);
      let hungUp = false;
      channel.destroy = (err?: Error) => {
        if (!hungUp) {
          hungUp = true;
          channel.readable = false;
          if (session) setTimeout(release, this.hangUpCloseMs).unref();
          else release();
        }
        return destroy(err);
      };
      channel.on('close', release);
      channel.on('error', release);
      return channel;
    } catch (err) {
      release();
      throw this.unreachable(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Run a raw command string on the server. Caller is responsible for quoting. */
  async exec(
    command: string,
    opts: { input?: Readable; stdout?: Writable; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const release = await this.acquireSlot();
    try {
      const client = await this.acquire();
      return await new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) {
            reject(this.unreachable(err));
            return;
          }
          let out = '';
          let errText = '';
          let done = false;
          // Stop waiting for the command and close its channel: the slot comes back as this settles.
          const hangUp = (why: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            stream.close();
            reject(new Error(`${why}: ${command.slice(0, 200)}`));
          };
          const timer = setTimeout(() => hangUp(`ssh command timed out after ${opts.timeoutMs}ms`), opts.timeoutMs);

          if (opts.stdout) {
            stream.pipe(opts.stdout);
            // A destination gone before the output has ended (a download whose tab was closed)
            // reads no more of it, and the command kept its channel until its deadline.
            opts.stdout.on('error', (e: Error) => hangUp(`writing the command's output failed (${e.message})`));
            opts.stdout.on('close', () => {
              if (!stream.readableEnded) hangUp('the output destination closed before the command finished');
            });
            // Gone while this call waited for a channel: that 'close' came and went unheard.
            if (opts.stdout.destroyed) hangUp('the output destination closed before the command started');
          } else {
            stream.on('data', (chunk: Buffer) => {
              if (out.length < OUTPUT_CAP) out += chunk.toString();
            });
          }
          stream.stderr.on('data', (chunk: Buffer) => {
            if (errText.length < OUTPUT_CAP) errText += chunk.toString();
          });
          if (opts.input) {
            opts.input.on('error', () => stream.close());
            opts.input.pipe(stream);
          } else {
            stream.end();
          }
          stream.on('close', (code: number | null, signal: string | undefined) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({
              stdout: out,
              stderr: signal ? `${errText}\n(killed by signal ${signal})`.trim() : errText,
              exitCode: code ?? 1,
            });
          });
          stream.on('error', (e: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
          });
        });
      });
    } finally {
      release();
    }
  }

  close(): void {
    this.closed = true;
    this.connecting = null;
    // A handshake still in flight would otherwise complete into a live, unreferenced
    // connection that nothing ever ends.
    this.pending?.end();
    this.pending = null;
    this.client?.end();
    this.client = null;
  }
}
