import { eq } from 'drizzle-orm';
import ssh2 from 'ssh2';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import type { Config } from '../config.js';
import type { Logger } from '../services/index.js';
import type { ServerRegistry } from './registry.js';
import { readPanelPrivateKey } from './keys.js';
import { sshFingerprint } from './sshConnection.js';
import { resolveLocalSshHost } from './terminal.js';

const { Client } = ssh2;

/**
 * Run one command as root on the panel's own host.
 *
 * The panel cannot replace its own container from inside it, so an update has to belong to
 * something that outlives the container: `systemd-run` on the host, started over this
 * connection. Everything here already existed for the web terminal - the same key, the same
 * `host.docker.internal` resolution, the same trust-on-first-use pin on server 1's row - it
 * was just married to an interactive PTY. This is the same access without the shell.
 *
 * Deliberately not the pooled SshConnection: that pool is for worker servers, and a command
 * that tears down the panel has no business sharing channels with site operations.
 */
export interface HostRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HostExecFn = (opts: {
  host: string;
  port: number;
  privateKey: string;
  command: string;
  timeoutMs: number;
  pinnedHostKey: () => string | null;
  onHostKeyCaptured: (fingerprint: string) => void;
}) => Promise<HostRunResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Server 1 is the panel's own machine and cannot be removed. */
const LOCAL_SERVER_ID = 1;

export class HostShell {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly registry: ServerRegistry,
    private readonly log: Logger,
    private readonly exec: HostExecFn = sshExecOnce,
  ) {}

  async run(command: string, opts: { timeoutMs?: number } = {}): Promise<HostRunResult> {
    const row = this.registry.rowById(LOCAL_SERVER_ID);
    if (!row) throw new Error('Server #1 is missing from the registry');
    return this.exec({
      host: await resolveLocalSshHost(),
      port: 22,
      privateKey: readPanelPrivateKey(this.config),
      command,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pinnedHostKey: () => this.registry.rowById(LOCAL_SERVER_ID)?.hostKeySha256 ?? null,
      onHostKeyCaptured: (fp) => {
        this.db
          .update(servers)
          .set({ hostKeySha256: fp, updatedAt: Date.now() })
          .where(eq(servers.id, LOCAL_SERVER_ID))
          .run();
        this.log.info(`Pinned this host's key ${fp} (host shell)`);
      },
    });
  }
}

export const sshExecOnce: HostExecFn = (opts) =>
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
    const deadline = setTimeout(() => fail(new Error(`host command timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);

    client.on('error', fail);
    client.on('close', () => fail(new Error('connection closed before the command finished')));
    client.on('ready', () => {
      client.exec(opts.command, (err, channel) => {
        if (err) return fail(err);
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        channel.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        channel.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        channel.on('exit', (code: number | null) => {
          exitCode = code ?? 0;
        });
        channel.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          client.removeListener('error', fail);
          client.on('error', () => undefined);
          client.end();
          resolve({ stdout, stderr, exitCode });
        });
      });
    });

    try {
      client.connect({
        host: opts.host,
        port: opts.port,
        username: 'root',
        privateKey: opts.privateKey,
        readyTimeout: 10_000,
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
          opts.onHostKeyCaptured(fp);
          return true;
        },
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
