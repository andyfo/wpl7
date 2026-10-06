// @docs integrations/cloudflare
import crypto from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { ContainerConfig } from './docker.js';
import type { Logger } from './index.js';
import { CLOUDFLARE } from './dns.js';
import { TRAEFIK_CONTAINER } from './stack.js';
import type { DnsServerDto, TraefikDnsMode } from '../../shared/types.js';

/**
 * Where Traefik reads the token: deploy/docker-compose.yml sets CF_DNS_API_TOKEN_FILE to this,
 * inside ${SRV_ROOT}/traefik - which the container already mounts at /letsencrypt.
 */
export const TOKEN_FILE_IN_TRAEFIK = '/letsencrypt/dns/cloudflare-api-token';

export function tokenFilePath(config: Pick<Config, 'srvRoot'>): string {
  return path.join(config.srvRoot, 'traefik', 'dns', 'cloudflare-api-token');
}

/** The flag that gives Traefik its DNS resolver, and with it the provider. */
const PROVIDER_FLAG = '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=';

/**
 * How a server's Traefik answers DNS challenges, read off the container. lego - Traefik's ACME
 * library - takes a credential from its variable when that has a value and only otherwise
 * from the `_FILE` one, so a Traefik given CF_DNS_API_TOKEN by an older compose file never
 * reads the panel's copy, however current that is.
 */
export function traefikDnsMode(
  config: ContainerConfig | null,
  running: boolean,
): { mode: TraefikDnsMode; provider: string | null; envToken: boolean } {
  if (!config || !running) return { mode: 'stopped', provider: null, envToken: false };
  const flag = config.cmd.find((arg) => arg.startsWith(PROVIDER_FLAG));
  if (!flag) return { mode: 'none', provider: null, envToken: false };
  const provider = flag.slice(PROVIDER_FLAG.length);
  if (provider !== CLOUDFLARE) return { mode: 'other', provider, envToken: false };
  const fromEnv = ['CF_DNS_API_TOKEN', 'CLOUDFLARE_DNS_API_TOKEN', 'CF_API_KEY', 'CLOUDFLARE_API_KEY'].some((key) =>
    config.envSet.includes(key),
  );
  if (!fromEnv && config.envSet.includes('CF_DNS_API_TOKEN_FILE')) return { mode: 'file', provider, envToken: false };
  return { mode: 'env', provider, envToken: fromEnv };
}

type Status = DnsServerDto['traefik'];

const UNKNOWN: Status = {
  state: 'unknown',
  mode: null,
  provider: null,
  envToken: false,
  restartedAt: null,
  checkedAt: null,
  message: null,
};

/** A server that answered is looked at again this often, for a file removed or a Traefik replaced. */
const VERIFY_MS = 30 * 60_000;

const digestOf = (token: string): string | null =>
  token ? crypto.createHash('sha256').update(`${token}\n`).digest('hex') : null;

/**
 * Every server's Traefik gets the panel's Cloudflare token (Settings -> DNS) as a file, kept
 * in step with it: written when there is one, removed when there is none.
 *
 * Traefik reads the file once, the first time it needs the DNS resolver, and keeps what it
 * read for as long as it runs (it builds its ACME client once: pkg/provider/acme/provider.go,
 * getClient). So a file that changed under a Traefik that may already hold the old token -
 * a token replaced or removed - is followed by a restart, a few seconds in which that server's
 * sites do not answer. A first token needs none: a Traefik that had none never kept one.
 */
export class TraefikDnsSync {
  private chains = new Map<number, Promise<void>>();
  private waiting = new Map<number, Promise<void>>();
  private status = new Map<number, Status>();
  /** The token digest each server was last brought to, and when it was last looked at. */
  private synced = new Map<number, string | null>();
  private verifiedAt = new Map<number, number>();
  /** Servers whose file changed under a Traefik that has not been restarted since: the restart failed. */
  private restartOwed = new Set<number>();
  private readonly debounceMs: number;

  constructor(
    private readonly config: Pick<Config, 'srvRoot'>,
    private readonly servers: ServerRegistry,
    private readonly token: () => string,
    private readonly log: Logger,
    opts: { debounceMs?: number } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 500;
  }

  statusOf(serverId: number): Status {
    return this.status.get(serverId) ?? UNKNOWN;
  }

  kick(serverId: number): Promise<void> {
    const pending = this.waiting.get(serverId);
    if (pending) return pending;
    const before = this.chains.get(serverId) ?? Promise.resolve();
    const run = before
      .then(() => (this.debounceMs > 0 ? new Promise<void>((r) => setTimeout(r, this.debounceMs)) : undefined))
      .then(async () => {
        this.waiting.delete(serverId);
        await this.syncServer(serverId);
      });
    this.waiting.set(serverId, run);
    this.chains.set(serverId, run);
    return run;
  }

  /** Every server: the token changed. */
  kickAll(): Promise<void> {
    return Promise.all(this.servers.listRows().map((row) => this.kick(row.id))).then(() => undefined);
  }

  /** Wait for everything queued so far (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /**
   * The minute tick: a server that has not been given the current token, or that has not been
   * looked at for a while, is synced. Unreachable servers wait for the monitor to see them.
   */
  tick(now = Date.now()): { kicked: number } {
    const wanted = digestOf(this.token());
    let kicked = 0;
    for (const row of this.servers.listRows()) {
      if (row.status === 'provisioning' || row.status === 'unreachable') continue;
      const due = now - (this.verifiedAt.get(row.id) ?? 0) >= VERIFY_MS;
      if (!due && this.synced.get(row.id) === wanted && this.statusOf(row.id).state === 'ok') continue;
      void this.kick(row.id);
      kicked++;
    }
    return { kicked };
  }

  /** Never throws: what went wrong is the server's status, which Settings -> DNS shows. */
  async syncServer(serverId: number): Promise<Status> {
    const row = this.servers.rowById(serverId);
    if (!row) {
      this.status.delete(serverId);
      this.synced.delete(serverId);
      this.verifiedAt.delete(serverId);
      this.restartOwed.delete(serverId);
      return UNKNOWN;
    }
    const previous = this.statusOf(serverId);
    // Its provision job puts the token in place as its last step, once there is a stack to read it.
    if (row.status === 'provisioning') return previous;
    const token = this.token();
    const wanted = digestOf(token);
    const file = tokenFilePath(this.config);
    try {
      const handle = this.servers.handleFor(serverId);
      const present = await handle.files.exists(file);
      const current = present ? await handle.files.sha256(file) : null;
      if (current !== wanted) {
        // Owed before the write, so a restart that then fails is tried again next time.
        if (current !== null) this.restartOwed.add(serverId);
        if (token) {
          // 0700 on the folder as well: the file is written atomically, through a temporary
          // name next to it.
          await handle.files.mkdirp(path.dirname(file), { mode: 0o700 });
          await handle.files.writeFile(file, `${token}\n`, { mode: 0o600, atomic: true });
        } else {
          await handle.files.rm(file);
        }
      }
      const running = (await handle.docker.containerState(TRAEFIK_CONTAINER)) === 'running';
      const traefik = traefikDnsMode(await handle.docker.containerConfig(TRAEFIK_CONTAINER), running);
      let restartedAt = previous.restartedAt;
      if (this.restartOwed.has(serverId)) {
        // Only a running Traefik that reads the file can be holding the old token. A stopped one
        // reads the new file when it starts; any other never reads it.
        if (traefik.mode === 'file') {
          await handle.docker.restartContainer(TRAEFIK_CONTAINER);
          restartedAt = Date.now();
          this.log.info(`DNS: restarted Traefik on "${row.name}" so it reads the ${token ? 'new' : 'removed'} Cloudflare token`);
        }
        this.restartOwed.delete(serverId);
      }
      const next: Status = {
        state: 'ok',
        ...traefik,
        restartedAt,
        checkedAt: Date.now(),
        message: null,
      };
      this.status.set(serverId, next);
      this.synced.set(serverId, wanted);
      this.verifiedAt.set(serverId, Date.now());
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Once per error, not once a minute: the tick tries again every minute.
      if (previous.state !== 'error' || previous.message !== message) {
        this.log.warn(`DNS: Traefik's token on "${row.name}" could not be brought up to date: ${message}`);
      }
      const next: Status = { ...previous, state: 'error', checkedAt: Date.now(), message };
      this.status.set(serverId, next);
      this.synced.delete(serverId);
      return next;
    }
  }
}
