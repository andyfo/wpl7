import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import type { Config } from '../config.js';
import { hostExec as processExec, type ExecOpts, type ExecPort, type ExecResult } from '../lib/exec.js';
import type { Logger } from '../services/index.js';
import { readPanelPrivateKey } from './keys.js';
import { SshConnection } from './sshConnection.js';
import { SshExec } from './sshExec.js';
import { resolveLocalSshHost } from './terminal.js';

/**
 * Commands on the panel's OWN host, as opposed to inside its container.
 *
 * Every other server is already reached this way — the SSH exec port runs on the host as
 * root. Server 1 is the exception: the panel's `exec` there is its own container, which
 * sees only what compose mounted. That is fine for the things the panel owns (everything
 * under SRV_ROOT) and useless for the one question the Storage form has to answer — what
 * disks does this machine actually have.
 *
 * So this reuses the web terminal's connection parameters (host.docker.internal, panel key,
 * the host key pinned on the server-1 row) and nothing else: **read-only discovery and
 * validation**. Running as root, `sudo` is off. Outside a container there is nothing to
 * bridge and the ordinary process runner is used instead.
 */
export class LocalHostExec implements ExecPort {
  private conn: SshConnection | null = null;
  private inner: ExecPort | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly inContainer: () => boolean = () => fs.existsSync('/.dockerenv'),
  ) {}

  /** True when reaching the host needs the SSH hop at all. */
  needsSsh(): boolean {
    return this.inContainer();
  }

  private async resolve(): Promise<ExecPort> {
    if (!this.inContainer()) return processExec;
    if (this.inner) return this.inner;
    const host = await resolveLocalSshHost();
    this.conn = new SshConnection(
      {
        serverId: 1,
        serverName: this.db.select().from(servers).where(eq(servers.id, 1)).get()?.name ?? 'server 1',
        host,
        port: 22,
        username: 'root',
        privateKey: () => readPanelPrivateKey(this.config),
        // Same pin the terminal and the pooled connection use; read fresh so a re-trust
        // on the Servers page takes effect without a panel restart.
        pinnedHostKey: () => this.db.select().from(servers).where(eq(servers.id, 1)).get()?.hostKeySha256 ?? null,
        onHostKeyCaptured: (fp) => {
          this.db.update(servers).set({ hostKeySha256: fp, updatedAt: Date.now() }).where(eq(servers.id, 1)).run();
          this.log.info(`Server 1: pinned host key ${fp} (host discovery)`);
        },
      },
      (msg) => this.log.warn(msg),
    );
    this.inner = new SshExec(this.conn, { sudo: false });
    return this.inner;
  }

  async run(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult> {
    return (await this.resolve()).run(cmd, args, opts);
  }

  /** Deliberately unsupported: this port exists to look, not to write. */
  async runWithInput(): Promise<ExecResult> {
    throw new Error('LocalHostExec is read-only');
  }

  async runToStream(): Promise<{ exitCode: number; stderr: string }> {
    throw new Error('LocalHostExec is read-only');
  }

  close(): void {
    this.conn?.close();
    this.conn = null;
    this.inner = null;
  }
}
