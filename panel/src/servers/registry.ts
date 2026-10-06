// @docs servers/add, servers/overview
import fs from 'node:fs';
import dns from 'node:dns/promises';
import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { servers, sites, type ServerRow } from '../db/schema.js';
import type { Config } from '../config.js';
import { notFound } from '../lib/errors.js';
import { hostExec, type ExecPort } from '../lib/exec.js';
import { ExecFiles, LocalFiles, type FilesPort } from '../lib/files.js';
import { DockerService, type DockerPort } from '../services/docker.js';
import { DbAdminService, type DbAdminPort } from '../services/dbAdmin.js';
import { RemoteDbAdminService } from './remoteDbAdmin.js';
import { WpService } from '../services/wp.js';
import { SiteFilesService } from '../services/siteFiles.js';
import { SshConnection, ServerUnreachableError } from './sshConnection.js';
import { SshDockerAgent } from './sshDockerAgent.js';
import { TRAEFIK_CONTAINER } from '../services/stack.js';
import { SshExec } from './sshExec.js';
import { readPanelPrivateKey } from './keys.js';
import { siteImage } from '../services/siteSpec.js';
import type { Logger } from '../services/index.js';
import type { ServerCheck } from '../../shared/types.js';

export { ServerUnreachableError } from './sshConnection.js';

/** Everything needed to operate on ONE server. All ops routed here run on that server. */
export interface ServerHandle {
  id: number;
  name: string;
  kind: 'local' | 'ssh';
  /** Fresh row snapshot (publicIp, devDomain, dnsProvider, ssh fields…), updated on every handleFor(). */
  row: ServerRow;
  docker: DockerPort;
  exec: ExecPort;
  files: FilesPort;
  dbAdmin: DbAdminPort;
  wp: WpService;
  /** Web FTP: a site's files, always worked on inside its own container (services/siteFiles.ts). */
  siteFiles: SiteFilesService;
  /** Base URL for HTTP probes of a site container on this server. */
  probeUrlFor(containerName: string): string;
}

export interface HandlePorts {
  docker: DockerPort;
  exec: ExecPort;
  files: FilesPort;
  dbAdmin: DbAdminPort;
}

/** Injectable factories so tests can register fake servers without touching ssh2. */
export interface HandleFactories {
  makeLocal?(row: ServerRow): HandlePorts;
  makeSsh?(row: ServerRow): HandlePorts;
}

interface CacheEntry {
  handle: ServerHandle;
  conn: SshConnection | null;
  /** Connection-relevant fields; a change invalidates the cached ports. */
  sshSig: string;
}

/** RFC1918 + loopback + link-local + CGNAT (100.64/10). */
export function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

const sshSigOf = (row: ServerRow) => `${row.kind}|${row.sshHost}|${row.sshPort}|${row.sshUser}|${row.hostKeySha256}`;

export class ServerRegistry {
  private cache = new Map<number, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly factories: HandleFactories = {},
  ) {}

  listRows(): ServerRow[] {
    return this.db.select().from(servers).all();
  }

  rowById(serverId: number): ServerRow | undefined {
    return this.db.select().from(servers).where(eq(servers.id, serverId)).get();
  }

  /**
   * Resolve a handle. Synchronous (row lookup + lazily-connecting adapters, no I/O);
   * network errors surface on first use of a port as ServerUnreachableError.
   */
  handleFor(serverId: number): ServerHandle {
    const row = this.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);

    const cached = this.cache.get(serverId);
    if (cached && cached.sshSig === sshSigOf(row)) {
      cached.handle.row = row;
      cached.handle.name = row.name;
      return cached.handle;
    }
    if (cached) this.closeEntry(cached);

    const { ports, conn } = this.buildPorts(row);
    const tlsMode = this.config.tlsMode;
    const handle: ServerHandle = {
      id: row.id,
      name: row.name,
      kind: row.kind as 'local' | 'ssh',
      row,
      ...ports,
      wp: new WpService(ports.docker),
      siteFiles: new SiteFilesService(ports.docker),
      probeUrlFor(_containerName: string): string {
        // Probes go through Traefik, never straight at the container. Site containers are
        // no longer members of wpl7_proxy - that isolation is the point (services/siteNetwork.ts)
        // - so the panel cannot address them by name any more, and would not want to: routing
        // is part of what "is this site up" means, and reaching the container directly reported
        // a site whose router was broken as healthy.
        if (this.kind === 'local' && fs.existsSync('/.dockerenv')) {
          return tlsMode === 'none' ? `http://${TRAEFIK_CONTAINER}/` : `https://${TRAEFIK_CONTAINER}/`;
        }
        // Everything else goes through Traefik, whose `web` entrypoint 301-redirects every
        // request to `websecure` regardless of routing — probing :80 would therefore report
        // any hostname as up. Go straight to :443 whenever TLS is on.
        const host = this.kind === 'local' ? '127.0.0.1' : this.row.publicIp;
        return tlsMode === 'none' ? `http://${host}/` : `https://${host}/`;
      },
    };
    this.cache.set(serverId, { handle, conn, sshSig: sshSigOf(row) });
    return handle;
  }

  localHandle(): ServerHandle {
    return this.handleFor(1);
  }

  private buildPorts(row: ServerRow): { ports: HandlePorts; conn: SshConnection | null } {
    if (row.kind === 'local') {
      if (this.factories.makeLocal) return { ports: this.factories.makeLocal(row), conn: null };
      const docker = new DockerService(this.config.proxyNetwork, this.config.dbNetwork);
      return {
        ports: {
          docker,
          exec: hostExec,
          files: new LocalFiles(),
          dbAdmin: new DbAdminService(this.config, docker),
        },
        conn: null,
      };
    }
    if (this.factories.makeSsh) return { ports: this.factories.makeSsh(row), conn: null };

    const conn = new SshConnection(
      {
        serverId: row.id,
        serverName: row.name,
        host: row.sshHost ?? '',
        port: row.sshPort,
        username: row.sshUser,
        privateKey: () => readPanelPrivateKey(this.config),
        // Read from the DB on every connect, so the key captured on the first handshake
        // actually pins subsequent ones (the handle - and this connection - are cached).
        pinnedHostKey: () => this.rowById(row.id)?.hostKeySha256 ?? null,
        onHostKeyCaptured: (fp) => {
          // Trust-on-first-use: pin the key so a later change fails loudly.
          this.db.update(servers).set({ hostKeySha256: fp, updatedAt: Date.now() }).where(eq(servers.id, row.id)).run();
          const entry = this.cache.get(row.id);
          if (entry) {
            entry.handle.row = { ...entry.handle.row, hostKeySha256: fp };
            entry.sshSig = sshSigOf(entry.handle.row);
          }
          this.log.info(`Server "${row.name}": pinned host key ${fp}`);
        },
      },
      (msg) => this.log.warn(msg),
    );
    const exec = new SshExec(conn);
    const docker = new DockerService(
      this.config.proxyNetwork,
      this.config.dbNetwork,
      // host/port are dummies (only used for the HTTP Host header); every request rides an SSH channel.
      new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(conn) } as never),
    );
    return {
      ports: { docker, exec, files: new ExecFiles(exec), dbAdmin: new RemoteDbAdminService(exec) },
      conn,
    };
  }

  /**
   * The panel's own address as a worker sees it: the client half of `SSH_CONNECTION` in a
   * command run without sudo (which would drop that variable). Null for server 1, which is the
   * panel, and whenever it cannot be told. Never blocked there (services/blocklist.ts).
   */
  async panelAddressSeenBy(serverId: number): Promise<string | null> {
    if (this.rowById(serverId)?.kind !== 'ssh') return null;
    this.handleFor(serverId); // makes sure there is a cached connection to ask on
    const conn = this.cache.get(serverId)?.conn;
    if (!conn) return null;
    const res = await conn.exec('printf %s "${SSH_CONNECTION%% *}"', { timeoutMs: 15_000 }).catch(() => null);
    const address = res?.exitCode === 0 ? res.stdout.trim() : '';
    return /^[0-9a-fA-F:.]{2,45}$/.test(address) ? address : null;
  }

  /** Drop the cached handle + SSH connection (after PATCH, delete, host-key retrust). */
  invalidate(serverId: number): void {
    const entry = this.cache.get(serverId);
    if (entry) {
      this.closeEntry(entry);
      this.cache.delete(serverId);
    }
  }

  private closeEntry(entry: CacheEntry): void {
    entry.conn?.close();
  }

  markReachable(serverId: number): void {
    const row = this.rowById(serverId);
    if (!row) return;
    const patch: Partial<typeof servers.$inferInsert> = { lastSeenAt: Date.now(), lastError: null };
    // Don't clobber provisioning/error - those are managed by the provisioning flow.
    if (row.status === 'unreachable') patch.status = 'ok';
    this.db.update(servers).set(patch).where(eq(servers.id, serverId)).run();
  }

  markUnreachable(serverId: number, err: Error): void {
    const row = this.rowById(serverId);
    if (!row) return;
    const patch: Partial<typeof servers.$inferInsert> = { lastError: err.message.slice(0, 500) };
    if (row.status === 'ok') patch.status = 'unreachable';
    this.db.update(servers).set(patch).where(eq(servers.id, serverId)).run();
  }

  /** Full connectivity/stack test; used by POST /api/servers and /test. */
  async verify(serverId: number, opts: { defaultPhpVersion?: string } = {}): Promise<{ ok: boolean; checks: ServerCheck[] }> {
    const handle = this.handleFor(serverId);
    const checks: ServerCheck[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

    // 1. SSH + sudo (remote) / process access (local)
    try {
      const res = await handle.exec.run('true', [], { timeoutMs: 20_000 });
      if (res.exitCode !== 0) {
        add('ssh', false, `command failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 200)}`);
        return this.verifyResult(serverId, checks);
      }
      add('ssh', true, handle.kind === 'ssh' ? `connected as ${handle.row.sshUser}@${handle.row.sshHost} (sudo ok)` : 'local');
    } catch (err) {
      add('ssh', false, err instanceof Error ? err.message : String(err));
      return this.verifyResult(serverId, checks);
    }

    // 2. Docker + stack containers
    for (const [name, container, required] of [
      ['mariadb', 'wpl7-mariadb', true],
      ['traefik', 'wpl7-traefik', true],
      ['mail', 'wpl7-mail', false],
      ['dkim', 'wpl7-dkim', false],
    ] as const) {
      try {
        const state = await handle.docker.containerState(container);
        const ok = state === 'running' || (!required && state !== 'missing');
        const optionalNote =
          name === 'mail' ? ' (mail relay optional but recommended)' : ' (DKIM signing optional; mail goes out unsigned)';
        add(name, required ? state === 'running' : true, state === 'running' ? 'running' : `${container}: ${state}${!required && !ok ? optionalNote : ''}`);
      } catch (err) {
        add(name, !required, err instanceof Error ? err.message.slice(0, 200) : String(err));
        if (required) return this.verifyResult(serverId, checks);
      }
    }

    // 3. MariaDB answers
    try {
      const healthy = await handle.dbAdmin.ping();
      add('mariadb-health', healthy, healthy ? 'healthcheck ok' : 'healthcheck failed');
    } catch (err) {
      add('mariadb-health', false, err instanceof Error ? err.message.slice(0, 200) : String(err));
    }

    // 4. /srv layout (SRV_ROOT must match the panel's - documented constraint). The backup
    // location is checked where this server actually keeps it, not where the panel's own
    // default would be: a worker with its backups on a second disk is correctly configured,
    // not broken.
    const dirs = [
      this.config.paths.sites,
      handle.row.backupRoot || this.config.paths.backups,
      this.config.paths.plugins,
    ];
    const missing: string[] = [];
    for (const dir of dirs) {
      if (!(await handle.files.exists(dir).catch(() => false))) missing.push(dir);
    }
    add('srv', missing.length === 0, missing.length === 0 ? dirs.join(', ') : `missing: ${missing.join(', ')}`);

    // 5. Default site image (informational - the panel builds it on demand)
    if (opts.defaultPhpVersion) {
      const tag = siteImage(opts.defaultPhpVersion);
      const present = await handle.docker.imageExists(tag).catch(() => false);
      add('wp-image', true, present ? `${tag} present` : `${tag} missing (will be built on first use)`);
    }

    // 6. Public IP (auto-detect when the row has none)
    if (!handle.row.publicIp) {
      const res = await handle.exec
        .run('sh', ['-c', `ip route get 1.1.1.1 | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}'`], { timeoutMs: 20_000 })
        .catch(() => null);
      const ip = res?.stdout.trim().split('\n')[0] ?? '';
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        this.db.update(servers).set({ publicIp: ip, updatedAt: Date.now() }).where(eq(servers.id, serverId)).run();
        handle.row = { ...handle.row, publicIp: ip };
        // `ip route get` returns the source address of the default route, which on a NATed
        // or bridged host is a private one. It is kept (LAN fleets are legitimate) but must
        // be called out: DNS records and the move-forwarding proxy are built from this value.
        if (isPrivateIpv4(ip)) {
          const detail = `detected ${ip}, which is a private address - if this server is behind NAT, set its real public IP on the Servers page (DNS records and move forwarding use it)`;
          this.log.warn(`Server #${serverId}: ${detail}`);
          add('public-ip', true, detail);
        } else {
          add('public-ip', true, `detected ${ip}`);
        }
      } else {
        add('public-ip', false, 'could not auto-detect; set it manually');
      }
    } else {
      add('public-ip', true, handle.row.publicIp);
    }

    // 7. Wildcard DNS (informational)
    if (handle.row.devDomain && handle.row.publicIp) {
      try {
        const probe = `wpl7-probe-${Math.random().toString(36).slice(2, 8)}.${handle.row.devDomain}`;
        const addrs = await dns.resolve4(probe);
        add(
          'dev-dns',
          true,
          addrs.includes(handle.row.publicIp)
            ? `*.${handle.row.devDomain} resolves here`
            : `*.${handle.row.devDomain} resolves to ${addrs.join(', ')} (explicit per-site records will be used)`,
        );
      } catch {
        add('dev-dns', true, `*.${handle.row.devDomain} does not resolve (yet)`);
      }
    }

    return this.verifyResult(serverId, checks);
  }

  private verifyResult(serverId: number, checks: ServerCheck[]): { ok: boolean; checks: ServerCheck[] } {
    const ok = checks.every((c) => c.ok);
    if (ok) this.markReachable(serverId);
    else {
      const firstFail = checks.find((c) => !c.ok);
      this.markUnreachable(serverId, new Error(`${firstFail?.name}: ${firstFail?.detail}`));
    }
    return { ok, checks };
  }

  sitesCountFor(serverId: number): number {
    return this.db.select({ id: sites.id }).from(sites).where(eq(sites.serverId, serverId)).all().length;
  }

  async closeAll(): Promise<void> {
    for (const entry of this.cache.values()) this.closeEntry(entry);
    this.cache.clear();
  }
}
