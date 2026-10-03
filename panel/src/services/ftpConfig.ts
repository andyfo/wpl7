import path from 'node:path';
import type { Config } from '../config.js';
import { safeJoin } from '../lib/slug.js';
import type { ServiceContainerSpec } from './docker.js';
import { FTP_ARGON2, isSftpgoArgon2 } from './ftpKeys.js';

/**
 * What the FTP/SFTP containers are told, as pure functions of the panel's state.
 *
 * Two SFTPGo roles per server (services/ftp.ts has the why):
 * - the **gateway** `wpl7-ftp`: public, speaks SFTP and FTPS, checks passwords - and holds no
 *   site files at all. Every login's filesystem is SFTP, pointed at its site's file server.
 * - one **file server** `wpl7-ftp-<slug>` per site with logins: SFTP on an internal network
 *   only, running as the site's own user with only that site's folder mounted.
 *
 * SFTPGo reads a JSON config file and a users file in its "memory" provider format; both are
 * rendered here and nowhere else, so the golden fixtures in the tests are the contract.
 */

export const FTP_GATEWAY_CONTAINER = 'wpl7-ftp';
export const ftpFileServerContainer = (slug: string) => `wpl7-ftp-${slug}`;
/** Internal: the gateway and the file servers, nothing else. No route off the host. */
export const FTP_NETWORK = 'wpl7_ftp';
/** The gateway's own bridge, which carries its published ports. Nothing else joins it. */
export const FTP_EDGE_NETWORK = 'wpl7_ftp_edge';
export const FTP_ROLE_GATEWAY = 'ftp-gateway';
export const FTP_ROLE_FILES = 'ftp-files';

/**
 * The gateway's uid. Not 1000 (the SFTPGo image's own): on many hosts that is the first
 * human account, which would then own - and could read - the users file. Above useradd's
 * range (1000-60000) and below systemd's dynamic users (61184+), so nothing on a host has it.
 */
export const FTP_GATEWAY_UID = 60021;
/** www-data, which every site's files belong to. */
export const SITE_UID = 33;

/** Where the panel's files for a container are mounted inside it (read-only). */
export const CONFIG_DIR = '/etc/wpl7-ftp';
/** SFTPGo's own scratch (its "config dir"), on a tmpfs: the root filesystem is read-only. */
export const STATE_DIR = '/var/lib/sftpgo';
export const SITE_ROOT_IN_FILE_SERVER = '/var/www/html';
/** Ports inside the containers. The published ones are settings (see FtpPorts). */
export const SFTP_PORT_IN_CONTAINER = 2022;
export const FTP_PORT_IN_CONTAINER = 2121;
/** The one login a file server has: the gateway's. */
export const FILE_SERVER_USER = 'gateway';

/**
 * Everything a login may do. Never `create_symlinks` (SFTPGo's userspace path checks are
 * the thing a symlink attacks) and never `chown` (the file server could not anyway: it is
 * not root).
 */
export const FULL_ACCESS = [
  'list',
  'download',
  'upload',
  'overwrite',
  'delete',
  'rename',
  'create_dirs',
  'chmod',
  'chtimes',
  'copy',
] as const;

/** SFTPGo's memory-provider dump version (dataprovider.DumpVersion in v2.7). */
export const DUMP_VERSION = 17;

export function ftpPaths(config: Config) {
  // Not `${SRV_ROOT}/ftp`: with the default /srv that is /srv/ftp, the home Debian gives the
  // `ftp` user of vsftpd and proftpd - and the teardown removes this folder whole.
  const root = path.join(config.srvRoot, 'wpl7-ftp');
  const sites = path.join(root, 'sites');
  return {
    root,
    gateway: path.join(root, 'gateway'),
    sites,
    site: (slug: string) => safeJoin(sites, slug),
  };
}
export type FtpPaths = ReturnType<typeof ftpPaths>;

/** The files a container reads from CONFIG_DIR, by name. */
export const FILES = {
  config: 'sftpgo.json',
  users: 'users.json',
  hostEd25519: 'host_ed25519',
  hostRsa: 'host_rsa',
  tlsCert: 'ftps.crt',
  tlsKey: 'ftps.key',
} as const;
const inConfig = (file: string) => `${CONFIG_DIR}/${file}`;

export interface FtpPorts {
  sftp: number;
  /** null = no FTP on this server (switched off, or no public IPv4 to hand out for passive mode). */
  ftp: { port: number; passiveStart: number; passiveEnd: number; passiveIp: string } | null;
}

// ------------------------------------------------------------------------ SFTPGo config

/** Everything a WPL7 SFTPGo leaves off, whichever role it plays. */
const COMMON_OFF = {
  webdavd: { bindings: [{ port: 0 }] },
  httpd: { bindings: [{ port: 0, enable_web_admin: false, enable_web_client: false, enable_rest_api: false }] },
  telemetry: { bind_port: 0 },
  plugins: [],
};

const dataProvider = {
  driver: 'memory',
  name: inConfig(FILES.users),
  // Lowercase and trim what a client sends, so "Alice " logs in as "alice".
  naming_rules: 6,
  password_caching: true,
  track_quota: 0,
  create_default_admin: false,
  users_base_dir: '',
  backups_path: `${STATE_DIR}/backups`,
  // The algorithm the panel hashes with. SFTPGo re-hashes a password after a successful login
  // whenever its hash is not in the configured algorithm - bcrypt, by default.
  password_hashing: {
    algo: 'argon2id',
    argon2_options: {
      memory: FTP_ARGON2.memoryCost,
      iterations: FTP_ARGON2.timeCost,
      parallelism: FTP_ARGON2.parallelism,
    },
  },
};

export function renderGatewayConfig(ftp: FtpPorts['ftp']): object {
  return {
    common: {
      idle_timeout: 15,
      // Atomic: an upload lands under a temporary name and is renamed only when the client
      // finished sending it. A cut connection must never leave half a functions.php in place,
      // and only this side knows whether the transfer completed. A file being replaced stays
      // where it is meanwhile - which upstream SFTPGo does not do, and deploy/sftpgo-image's
      // patch does: upstream moves it to the temporary name first, so a site would go without
      // its wp-config.php for the whole upload, and for good if the upload broke off.
      upload_mode: 1,
      setstat_mode: 0,
      rename_mode: 0,
      symlink_mode: 0,
      max_total_connections: 300,
      max_per_host_connections: 20,
      allow_self_connections: 0,
      defender: {
        enabled: true,
        driver: 'memory',
        ban_time: 30,
        ban_time_increment: 50,
        threshold: 15,
        score_invalid: 2,
        score_valid: 1,
        score_limit_exceeded: 3,
        score_no_auth: 0,
        observation_time: 30,
        entries_soft_limit: 100,
        entries_hard_limit: 150,
        login_delay: { success: 0, password_failed: 1000 },
      },
    },
    sftpd: {
      bindings: [{ port: SFTP_PORT_IN_CONTAINER, address: '', apply_proxy_config: false }],
      max_auth_tries: 4,
      host_keys: [inConfig(FILES.hostEd25519), inConfig(FILES.hostRsa)],
      password_authentication: true,
      // Some clients (older WinSCP, PuTTY's psftp) ask for the password this way.
      keyboard_interactive_authentication: true,
      enabled_ssh_commands: ['md5sum', 'sha1sum', 'sha256sum', 'cd', 'pwd', 'scp'],
    },
    ftpd: {
      bindings: [
        ftp
          ? {
              port: FTP_PORT_IN_CONTAINER,
              address: '',
              apply_proxy_config: false,
              // 1 = explicit TLS, required: a client that will not upgrade the connection is
              // refused before it sends a password in the clear.
              tls_mode: 1,
              certificate_file: inConfig(FILES.tlsCert),
              certificate_key_file: inConfig(FILES.tlsKey),
              min_tls_version: 12,
              // Inside its container SFTPGo only knows the container's address; the one a
              // client can reach for the data connection is the server's.
              force_passive_ip: ftp.passiveIp,
              passive_ip_overrides: [],
              passive_host: '',
              // The data connection must come from the same address as the control one.
              passive_connections_security: 0,
              active_connections_security: 0,
            }
          : { port: 0 },
      ],
      passive_port_range: ftp ? { start: ftp.passiveStart, end: ftp.passiveEnd } : { start: 50000, end: 50100 },
      // Active mode has the server connect out to the client, through Docker's NAT - it
      // works nowhere worth supporting, and every client falls back to passive.
      disable_active_mode: true,
      // FileZilla changes permissions with SITE CHMOD; without this its "File permissions…" fails.
      enable_site: true,
    },
    ...COMMON_OFF,
    data_provider: dataProvider,
  };
}

export function renderFileServerConfig(): object {
  return {
    common: {
      idle_timeout: 15,
      // Plain: the gateway already uploads to a temporary name and renames it (above).
      upload_mode: 0,
      setstat_mode: 0,
      rename_mode: 0,
      symlink_mode: 0,
      // Every connection comes from the gateway: a ban or a per-address cap here would lock
      // the whole site out, and brute force is the gateway's problem, not this one's.
      max_total_connections: 0,
      max_per_host_connections: 0,
      allow_self_connections: 0,
      defender: { enabled: false },
    },
    sftpd: {
      bindings: [{ port: SFTP_PORT_IN_CONTAINER, address: '', apply_proxy_config: false }],
      max_auth_tries: 2,
      host_keys: [inConfig(FILES.hostEd25519)],
      password_authentication: false,
      keyboard_interactive_authentication: false,
      enabled_ssh_commands: [],
    },
    ftpd: { bindings: [{ port: 0 }] },
    ...COMMON_OFF,
    data_provider: dataProvider,
  };
}

// ------------------------------------------------------------------------ users

/** One FTP login, as the gateway is told about it. */
export interface GatewayLogin {
  username: string;
  /** argon2id, already in SFTPGo's parameter order (ftpKeys.toSftpgoArgon2). */
  passwordHash: string;
  /** '' = the whole site; else a site-relative folder the login is kept inside. */
  folder: string;
  /** Unix ms; null = no expiry. */
  expiresAt: number | null;
  siteSlug: string;
  /** The site's gateway->file-server key (OpenSSH private key). */
  clientKey: string;
  /** The site's file server's host key fingerprint, pinned by the gateway. */
  fileServerFingerprint: string;
}

interface DumpUser {
  status: 1;
  username: string;
  password?: string;
  public_keys?: string[];
  home_dir: string;
  expiration_date?: number;
  permissions: Record<string, string[]>;
  description?: string;
  filters: Record<string, unknown>;
  filesystem: Record<string, unknown>;
}

function dump(users: DumpUser[]): object {
  return {
    version: DUMP_VERSION,
    users,
    groups: [],
    folders: [],
    admins: [],
    api_keys: [],
    shares: [],
    event_actions: [],
    event_rules: [],
    roles: [],
    ip_lists: [],
  };
}

export function gatewayUser(login: GatewayLogin): DumpUser {
  return {
    status: 1,
    username: login.username,
    password: login.passwordHash,
    // SFTPGo wants a local home even for a login whose files are elsewhere; it only ever
    // creates an empty folder there (on the tmpfs).
    home_dir: `${STATE_DIR}/users/${login.username}`,
    expiration_date: login.expiresAt ?? 0,
    permissions: { '/': [...FULL_ACCESS] },
    description: `site ${login.siteSlug}`,
    filters: { denied_protocols: ['DAV', 'HTTP'] },
    filesystem: {
      provider: 5, // SFTP
      sftpconfig: {
        endpoint: `${ftpFileServerContainer(login.siteSlug)}:${SFTP_PORT_IN_CONTAINER}`,
        username: FILE_SERVER_USER,
        private_key: { status: 'Plain', payload: login.clientKey },
        fingerprints: [login.fileServerFingerprint],
        prefix: login.folder === '' ? '/' : `/${login.folder}`,
        disable_concurrent_reads: false,
        // 0 = unbuffered, which is also what keeps atomic uploads (upload_mode 1) possible.
        buffer_size: 0,
        equality_check_mode: 0,
      },
    },
  };
}

export function fileServerUser(clientPublicKey: string): DumpUser {
  return {
    status: 1,
    username: FILE_SERVER_USER,
    public_keys: [clientPublicKey],
    home_dir: SITE_ROOT_IN_FILE_SERVER,
    permissions: { '/': [...FULL_ACCESS] },
    description: 'the FTP gateway',
    filters: {
      denied_protocols: ['FTP', 'DAV', 'HTTP'],
      denied_login_methods: ['password', 'password-over-SSH', 'keyboard-interactive'],
    },
    filesystem: { provider: 0 },
  };
}

/**
 * Why SFTPGo would refuse this login, or null. Mirrors the checks its memory provider runs
 * on every user it loads - which STOPS at the first failure, leaving everyone after it out
 * (and refuses to start at all on a bad file). A row that fails here is left out of the file
 * and reported instead, so one bad row can never take every login on a server with it.
 */
export function gatewayLoginProblem(login: GatewayLogin): string | null {
  if (!/^[a-zA-Z0-9-_.~]+$/.test(login.username) || login.username.length > 255) return 'username SFTPGo cannot hold';
  if (!isSftpgoArgon2(login.passwordHash)) return 'password hash SFTPGo cannot read';
  if (login.folder !== '' && (login.folder.startsWith('/') || login.folder.endsWith('/') || /(^|\/)\.\.?(\/|$)|\/\/|\0/.test(login.folder))) {
    return 'folder is not a clean relative path';
  }
  if (login.expiresAt !== null && (!Number.isSafeInteger(login.expiresAt) || login.expiresAt < 0)) return 'bad expiry';
  if (!login.clientKey.includes('PRIVATE KEY')) return 'no gateway key for the site';
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(login.fileServerFingerprint)) return 'no file-server fingerprint for the site';
  return null;
}

export interface RenderedUsers {
  json: string;
  skipped: { username: string; problem: string }[];
}

export function renderGatewayUsers(logins: GatewayLogin[]): RenderedUsers {
  const users: DumpUser[] = [];
  const skipped: RenderedUsers['skipped'] = [];
  for (const login of [...logins].sort((a, b) => a.username.localeCompare(b.username))) {
    const problem = gatewayLoginProblem(login);
    if (problem) skipped.push({ username: login.username, problem });
    else users.push(gatewayUser(login));
  }
  return { json: toJson(dump(users)), skipped };
}

export function renderFileServerUsers(clientPublicKey: string): string {
  return toJson(dump([fileServerUser(clientPublicKey)]));
}

export const toJson = (v: object) => `${JSON.stringify(v, null, 2)}\n`;

// ------------------------------------------------------------------------ containers

const sftpgoCmd = [
  'sftpgo',
  'serve',
  '--config-dir',
  STATE_DIR,
  '--config-file',
  inConfig(FILES.config),
  '--log-file-path',
  '',
  '--log-level',
  'info',
];

const scratch = (uid: number) => {
  const opts = `rw,noexec,nosuid,nodev,size=16m,uid=${uid},gid=${uid},mode=0700`;
  return { [STATE_DIR]: opts, '/tmp': opts };
};

export function gatewaySpec(opts: {
  image: string;
  paths: FtpPaths;
  ports: FtpPorts;
  /** Digest of what the gateway reads only at start: its config, host keys and certificate. */
  inputs: string;
}): ServiceContainerSpec {
  const { ftp } = opts.ports;
  const ports: NonNullable<ServiceContainerSpec['ports']> = [
    { hostIp: '0.0.0.0', hostPort: opts.ports.sftp, containerPort: SFTP_PORT_IN_CONTAINER },
  ];
  if (ftp) {
    ports.push({ hostIp: '0.0.0.0', hostPort: ftp.port, containerPort: FTP_PORT_IN_CONTAINER });
    // Passive ports go through 1:1: SFTPGo announces the number it listens on.
    for (let p = ftp.passiveStart; p <= ftp.passiveEnd; p++) ports.push({ hostIp: '0.0.0.0', hostPort: p, containerPort: p });
  }
  return {
    name: FTP_GATEWAY_CONTAINER,
    image: opts.image,
    cmd: sftpgoCmd,
    user: `${FTP_GATEWAY_UID}:${FTP_GATEWAY_UID}`,
    // The Go runtime's soft ceiling, under the container's hard one: it collects garbage
    // harder instead of being OOM-killed mid-transfer.
    env: { GOMEMLIMIT: '400MiB' },
    labels: { 'wpl7.role': FTP_ROLE_GATEWAY },
    binds: [`${opts.paths.gateway}:${CONFIG_DIR}:ro`],
    tmpfs: scratch(FTP_GATEWAY_UID),
    readOnlyRootfs: true,
    // The edge network first: it is the one whose bridge the published ports are bound to.
    networks: [FTP_EDGE_NETWORK, FTP_NETWORK],
    ports,
    // Memory and processes, but no CPU ceiling: Docker refuses a CPU limit above the host's
    // own CPU count - a 2-core cap would keep the gateway from ever starting on a 1-vCPU
    // server - and refuses one outright on kernels without CPU quotas.
    memoryBytes: 512 * 1024 * 1024,
    pidsLimit: 256,
    inputs: opts.inputs,
  };
}

export function fileServerSpec(opts: {
  image: string;
  paths: FtpPaths;
  slug: string;
  /** The site's WordPress folder on the host. */
  siteFolder: string;
  /**
   * Digest of the config files, plus the site folder's device:inode. A restore renames the
   * folder away and puts another in its place; a container started before that still has
   * the OLD one mounted, and would go on serving - and taking uploads into - the copy the
   * restore set aside.
   */
  inputs: string;
}): ServiceContainerSpec {
  return {
    name: ftpFileServerContainer(opts.slug),
    image: opts.image,
    cmd: sftpgoCmd,
    user: `${SITE_UID}:${SITE_UID}`,
    env: { GOMEMLIMIT: '96MiB' },
    labels: { 'wpl7.role': FTP_ROLE_FILES, 'wpl7.site': opts.slug },
    binds: [`${opts.siteFolder}:${SITE_ROOT_IN_FILE_SERVER}`, `${opts.paths.site(opts.slug)}:${CONFIG_DIR}:ro`],
    tmpfs: scratch(SITE_UID),
    readOnlyRootfs: true,
    networks: [FTP_NETWORK],
    memoryBytes: 128 * 1024 * 1024,
    pidsLimit: 64,
    inputs: opts.inputs,
  };
}

// ------------------------------------------------------------------------ settings

export interface FtpPortSettings {
  sftpPort: number;
  offerFtps: boolean;
  ftpPort: number;
  passiveStart: number;
  passiveEnd: number;
}

/** The most passive ports there may be: each is one docker-proxy process on every server. */
export const MAX_PASSIVE_PORTS = 100;

/**
 * Why these ports cannot work, or null. `taken` is what every server already listens on: the
 * SSH ports (the panel's own way in) and Traefik's 80 and 443.
 */
export function ftpPortsProblem(p: FtpPortSettings, taken: number[]): string | null {
  const busy = new Set(taken);
  if (busy.has(p.sftpPort)) return `SFTP cannot use port ${p.sftpPort}: the servers already use it (SSH or the web).`;
  if (!p.offerFtps) return null;
  // SFTPGo only uses a range whose end is above its start; a single port is ignored, and
  // passive mode then listens on a random port nobody published.
  if (p.passiveEnd <= p.passiveStart) return 'The passive range needs at least two ports, from low to high.';
  if (p.passiveEnd - p.passiveStart + 1 > MAX_PASSIVE_PORTS) {
    return `The passive range can hold at most ${MAX_PASSIVE_PORTS} ports.`;
  }
  // Passive ports are published 1:1, and Docker keys its port bindings by the port inside the
  // container: one of the gateway's own would silently lose its published port.
  for (const own of [SFTP_PORT_IN_CONTAINER, FTP_PORT_IN_CONTAINER]) {
    if (own >= p.passiveStart && own <= p.passiveEnd) {
      return `The passive range cannot include ${own}: the gateway uses it inside its container.`;
    }
  }
  if (p.ftpPort === p.sftpPort) return 'FTP and SFTP need different ports.';
  if (busy.has(p.ftpPort)) return `FTP cannot use port ${p.ftpPort}: the servers already use it (SSH or the web).`;
  const inRange = (port: number) => port >= p.passiveStart && port <= p.passiveEnd;
  if (inRange(p.sftpPort) || inRange(p.ftpPort)) return 'The SFTP and FTP ports have to be outside the passive range.';
  for (const port of busy) {
    if (inRange(port)) return `The passive range includes port ${port}, which the servers already use.`;
  }
  return null;
}
