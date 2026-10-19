// @docs databases/adminer, reference/architecture
import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import type { ServerRegistry } from '../servers/registry.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';
import type { Logger } from '../services/index.js';
import { ADMINER_CONTAINER, adminerRequest, readAll } from './relay.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().slice(0, 300);

/** The network Adminer shares with MariaDB alone: no site, no panel, no internet. */
export const ADMINER_NETWORK = 'wpl7_adminer';
const MARIADB = { container: 'wpl7-mariadb', alias: 'mariadb' };

/**
 * Each server's `wpl7-adminer`: started by the first open, stopped once nobody has used it for
 * ADMINER_IDLE_MS (the scheduler asks). The image is this version's, pulled or built like SFTPGo's.
 */
export class AdminerContainers {
  /** When each server's Adminer was last used, for those the panel started or used since it started. */
  private readonly lastUsed = new Map<number, number>();
  /** Whether a stop has looked at every server once: an Adminer may outlive a panel restart. */
  private swept = false;
  /** One start per server at a time: two tabs opening at once wait for the same one. */
  private readonly starting = new Map<number, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * What lets the panel, and only the panel, sign Adminer in on one server: the router in the
   * image refuses a sign-in without it. Derived from the panel's secret, so nothing stores it.
   */
  loginKey(serverId: number): string {
    return createHmac('sha256', this.config.sessionSecret).update(`wpl7-adminer-login:${serverId}`).digest('base64url');
  }

  used(serverId: number): void {
    this.lastUsed.set(serverId, this.now());
  }

  /** Running and answering on this server, started if need be. `status` hears what takes long. */
  ensure(serverId: number, status: (message: string) => void = () => undefined): Promise<void> {
    const running = this.starting.get(serverId);
    if (running) return running;
    const start = this.start(serverId, status).finally(() => this.starting.delete(serverId));
    this.starting.set(serverId, start);
    return start;
  }

  private async start(serverId: number, status: (message: string) => void): Promise<void> {
    const handle = this.servers.handleFor(serverId);
    const { docker } = handle;
    const c = this.config.adminer;
    if (!(await docker.imageExists(c.image))) {
      let pulled = false;
      if (c.imagePinned || this.config.source === 'image') {
        const from = c.imagePinned ? c.image : c.publishedImage;
        status(`Downloading Adminer to "${handle.name}"…`);
        try {
          await docker.pullImage(from);
          if (from !== c.image) await docker.tagImage(from, c.image);
          pulled = true;
        } catch (err) {
          if (c.imagePinned || err instanceof ServerUnreachableError) throw err;
          this.log.warn(`Adminer on "${handle.name}": could not download ${from} (${errorText(err)}); building it instead`);
        }
      }
      if (!pulled) {
        if (!c.version) throw new Error(`this panel cannot build Adminer: its build context is missing (${c.imageContext})`);
        status(`Building Adminer on "${handle.name}": a minute, once per version…`);
        await docker.buildImage(c.image, c.imageContext, {});
      }
    }
    await docker.ensureNetwork({ name: ADMINER_NETWORK, internal: true, labels: { 'wpl7.role': 'adminer-network' } });
    if (!(await docker.containerNetworks(MARIADB.container)).includes(ADMINER_NETWORK)) {
      await docker.connectContainer(ADMINER_NETWORK, MARIADB.container, { aliases: [MARIADB.alias] });
    }
    status('Starting Adminer…');
    await docker.ensureServiceContainer({
      name: ADMINER_CONTAINER,
      image: c.image,
      cmd: ['php', '-S', '127.0.0.1:8080', '-t', '/srv/adminer/empty', '/srv/adminer/router.php'],
      user: '65534:65534',
      env: { WPL7_LOGIN_KEY: this.loginKey(serverId), PHP_CLI_SERVER_WORKERS: '4' },
      labels: { 'wpl7.role': 'adminer' },
      binds: [],
      // Adminer's sessions and uploads: in memory, gone when it stops.
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=256m,mode=1777' },
      readOnlyRootfs: true,
      networks: [ADMINER_NETWORK],
      // Four PHP workers; an import holds its upload more than once.
      memoryBytes: 512 * 1024 * 1024,
      pidsLimit: 64,
    });
    // PHP's server takes a moment to listen after the container starts.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await adminerRequest(docker, { method: 'GET', path: '/', headers: {} });
        await readAll(res);
        break;
      } catch (err) {
        if (attempt >= 20) throw new Error(`Adminer did not answer on "${handle.name}": ${errorText(err)}`);
        await new Promise((r) => setTimeout(r, this.config.nodeEnv === 'test' ? 5 : 500));
      }
    }
    this.used(serverId);
  }

  /**
   * Stop each server's Adminer that nobody has used for `idleMs` and that no session needs. Only
   * servers the panel started one on are asked - except the first time, which asks every server:
   * one the panel has no record of (it restarted since) counts as idle.
   */
  async stopIdle(idleMs: number, inUse: (serverId: number) => boolean): Promise<number> {
    const everywhere = !this.swept;
    this.swept = true;
    let stopped = 0;
    for (const row of this.servers.listRows()) {
      const last = this.lastUsed.get(row.id);
      if (last === undefined && !everywhere) continue;
      if (inUse(row.id) || this.starting.has(row.id)) continue;
      if (last !== undefined && this.now() - last < idleMs) continue;
      try {
        const { docker } = this.servers.handleFor(row.id);
        if ((await docker.containerState(ADMINER_CONTAINER)) === 'running') {
          await docker.stopContainer(ADMINER_CONTAINER);
          stopped++;
        }
        this.lastUsed.delete(row.id);
      } catch (err) {
        this.log.warn(`Adminer on server #${row.id}: could not stop it: ${errorText(err)}`);
      }
    }
    return stopped;
  }
}
