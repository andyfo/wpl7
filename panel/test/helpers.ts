import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Duplex, type Readable, type Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { connectDb, openDb, type Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig, type Config } from '../src/config.js';
import type {
  ContainerConfig,
  ContainerLimits,
  ContainerLogsOpts,
  ContainerSample,
  ContainerState,
  DockerPort,
  EnsureNetworkResult,
  EphemeralOpts,
  ExecOpts,
  NetworkInfo,
  NetworkSpec,
  RunResult,
  ServiceContainerSpec,
  ServiceOutcome,
  ServiceState,
  SiteContainerSpec,
} from '../src/services/docker.js';
import { SPEC_LABEL, serviceSpecHash } from '../src/services/docker.js';
import type { DbAdminPort } from '../src/services/dbAdmin.js';
import { hostExec, type ExecPort, type ExecResult } from '../src/lib/exec.js';
import { LocalFiles, type FilesPort } from '../src/lib/files.js';
import { servers as serversTable } from '../src/db/schema.js';
import type { CoreServices } from '../src/services/index.js';
import { ServerRegistry, type HandlePorts } from '../src/servers/registry.js';
import { BackupService } from '../src/services/backup.js';
import { OffsiteService } from '../src/services/offsite.js';
import { StorageService } from '../src/services/storage.js';
import { CloudflareApiError, DnsService, type DnsProviderClient, type DnsTxtRecord, type DnsZone } from '../src/services/dns.js';
import { DnsAccount, type DnsClient } from '../src/services/dnsAccount.js';
import { TraefikDnsSync } from '../src/services/traefikDns.js';
import type { DnsResolver } from '../src/services/mailDns.js';
import { MonitorService } from '../src/services/monitor.js';
import { MailService } from '../src/services/mail.js';
import { RELAY_HOSTNAME_PROBE } from '../src/services/mailHostname.js';
import { TrafficService } from '../src/services/traffic.js';
import { UpdateService } from '../src/services/updates.js';
import { SystemUpdateService } from '../src/services/systemUpdate.js';
import { HostShell, type HostExecFn, type HostRunResult } from '../src/servers/hostShell.js';
import { GeoIpService } from '../src/services/geoip.js';
import { SettingsService } from '../src/services/settings.js';
import { seed } from '../src/db/seed.js';
import { JobWorker } from '../src/jobs/worker.js';
import { Schedulers } from '../src/jobs/schedulers.js';
import { SystemInfoService } from '../src/servers/systemInfo.js';
import { FeedbackService, type PostLike } from '../src/services/feedback.js';
import {
  TerminalService,
  type OpenTerminal,
  type ShellConnectFn,
  type ShellConnectOpts,
} from '../src/servers/terminal.js';
import { SitesService } from '../src/services/sites.js';
import { VulnerabilityFeedService } from '../src/services/vulnerabilities.js';
import { RecipeCatalog } from '../src/services/catalog.js';
import { LicenseService } from '../src/services/licenses.js';
import { PanelFiles } from '../src/services/panelFiles.js';
import { CatalogSyncService } from '../src/services/catalogSync.js';
import { WpInventoryService } from '../src/services/wpInventory.js';
import { WpBulkService } from '../src/services/wpBulk.js';
import { FtpService } from '../src/services/ftp.js';
import { ProxyRangesService } from '../src/services/proxyRanges.js';
import { SecurityService } from '../src/services/security.js';
import { BlocklistService } from '../src/services/blocklist.js';
import { SecurityEventsService } from '../src/services/securityEvents.js';
import { FirewallSyncService } from '../src/services/firewallSync.js';
import { AttackDetector } from '../src/services/attackDetector.js';
import { IntegrityManifests, type FetchLike } from '../src/services/integrityManifests.js';
import { MalwareScanService } from '../src/services/malwareScan.js';
import { PluginZipChecks } from '../src/services/pluginZipChecks.js';
import { QuarantineService } from '../src/services/quarantine.js';
import type { HostPort } from '../src/servers/hostPort.js';
import { ApiKeysService } from '../src/services/apiKeys.js';
import { ApiActivityService } from '../src/services/apiActivity.js';
import { PluginCatalogService } from '../src/services/pluginCatalog.js';
import { TwoFactorService } from '../src/services/twoFactor.js';
import { UsersService } from '../src/services/users.js';
import { AccountRecoveryService } from '../src/services/accountRecovery.js';
import { OAuthService } from '../src/services/oauth.js';
import type { WporgDirectory, WporgSearchResult } from '../src/services/wporg.js';
import type { WporgPluginDto } from '../shared/types.js';
import { badGateway } from '../src/lib/errors.js';
import type { AppDeps } from '../src/routes/deps.js';
import { buildServer } from '../src/server.js';
import { SCRIPTS as SITE_FILE_SCRIPTS } from '../src/services/siteFilesScripts.js';
import { sitePaths } from '../src/services/siteSpec.js';

/**
 * Every test gets a database of its own, but not a migration run of its own: the migrations run
 * once per process, and each test opens a copy of the result - 0.1 ms, where migrating took
 * ten or more. A copy is an independent in-memory database; writing to it changes nothing else.
 */
let migrated: Buffer | undefined;

export function createTestDb(): Db {
  if (!migrated) {
    const db = openDb(':memory:');
    runMigrations(db);
    migrated = db.$client.serialize();
  }
  return connectDb(new Database(migrated));
}

/**
 * The same for seed(): a world whose config seeds what an earlier world's did starts from a copy
 * of that database. The key is the whole config but the world's own temp dir, which seed() has
 * no reason to write into the database - and a seeded database that holds it anyway is not
 * reused.
 */
const seeded = new Map<string, Buffer>();

async function seededTestDb(config: Config): Promise<Db> {
  const key = JSON.stringify(config).replaceAll(config.srvRoot, '<srvRoot>');
  const image = seeded.get(key);
  if (image) return connectDb(new Database(image));
  const db = createTestDb();
  await seed(db, config);
  const copy = db.$client.serialize();
  if (!copy.includes(config.srvRoot)) seeded.set(key, copy);
  return db;
}

export function makeTestConfig(overrides: Record<string, string> = {}): Config {
  const srvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-test-'));
  return loadConfig({
    NODE_ENV: 'test',
    SRV_ROOT: srvRoot,
    TLS_MODE: 'none',
    DEV_DOMAIN: 'dev.example.test',
    PANEL_DOMAIN: 'panel.example.test',
    PANEL_ADMIN_USER: 'admin',
    PANEL_ADMIN_PASSWORD: 'correct-horse-battery',
    PANEL_SESSION_SECRET: 'x'.repeat(40),
    ...overrides,
  });
}

/** The "is this postfix?" probe the mail sync runs before touching credentials. */
function isRelayCapabilityProbe(cmd: string[]): boolean {
  return cmd.join(' ').includes('command -v saslpasswd2');
}

/** The panel's own mu-plugin drop-ins (SiteFilesService.putDropIn), written inside a site container. */
function isDropInWrite(cmd: string[]): boolean {
  return cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2] === SITE_FILE_SCRIPTS.dropIn;
}

/** `wp user list --role=administrator …`: who the panel acts as in a site (WpService.siteAdministrator). */
function isAdministratorList(cmd: string[]): boolean {
  return cmd[0] === 'wp' && cmd[1] === 'user' && cmd[2] === 'list' && cmd.includes('--role=administrator');
}

/** MailService's look at what the relay announces and what its default is (mailHostname.ts). */
function isRelayHostnameProbe(cmd: string[]): boolean {
  return cmd.length === RELAY_HOSTNAME_PROBE.length && cmd.every((part, i) => part === RELAY_HOSTNAME_PROBE[i]);
}

/** sasldblistusers2 / saslpasswd2 / the chmod on the db / `postfix reload`. */
function isRelayAuthCommand(cmd: string[]): boolean {
  const line = cmd.join(' ');
  return /saslpasswd2|sasldblistusers2|sasldb2/.test(line) || /^postfix reload$/.test(line);
}

/**
 * Container paths the site image has a regular FILE at. A bind mount whose source is a
 * directory cannot be laid over one, which is how a site loses its container (see
 * FakeDocker.enforceFileBinds).
 */
const IMAGE_FILE_MOUNTS = ['/etc/msmtprc', '/usr/local/etc/php/conf.d/zz-site.ini', '/etc/apache2/conf-enabled/zz-wpl7-security.conf'];

/**
 * wordpress.org's checksum endpoints, answered from what a test put here: core lists by
 * `<version>:<locale>` (path -> md5), plugin lists by `<slug>:<version>` (path -> sha256).
 * Anything else is "nothing published"; `down` makes every request fail.
 */
export class FakeChecksums {
  core = new Map<string, Record<string, string>>();
  plugins = new Map<string, Record<string, string>>();
  requests: string[] = [];
  down = false;
  fetch: FetchLike = async (url) => {
    this.requests.push(url);
    if (this.down) throw new Error('getaddrinfo EAI_AGAIN api.wordpress.org');
    const u = new URL(url);
    const reply = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
    if (u.hostname === 'api.wordpress.org') {
      const files = this.core.get(`${u.searchParams.get('version')}:${u.searchParams.get('locale')}`);
      return reply(200, { checksums: files ?? false });
    }
    const m = /^\/plugin-checksums\/([^/]+)\/([^/]+)\.json$/.exec(u.pathname);
    const files = m ? this.plugins.get(`${m[1]}:${m[2]}`) : undefined;
    if (!files) return reply(404, null);
    return reply(200, { files: Object.fromEntries(Object.entries(files).map(([f, sha256]) => [f, { md5: '0'.repeat(32), sha256 }])) });
  };
}

export class FakeDocker implements DockerPort {
  calls: { method: string; args: unknown[] }[] = [];
  containers = new Map<string, ContainerState>();
  /**
   * Model what real Docker does with a bind mount whose source file is missing: it creates
   * the source as a DIRECTORY, and the container then refuses to start because the image
   * has a file at that path - leaving the directory behind, so every later attempt fails the
   * same way. Off by default (most tests do not care) and only meaningful on a fake server
   * whose paths are the real ones, i.e. not behind MappedFiles.
   */
  enforceFileBinds = false;
  /** Binds of the container as last created, for enforceFileBinds. */
  private bindsByContainer = new Map<string, string[]>();
  images = new Set<string>(['wpl7-wordpress:php8.3']);
  execQueue: RunResult[] = [];
  /** Scripted container logs, keyed by container name (mail-log ingest reads these). */
  logs = new Map<string, string>();
  execDefault: RunResult = { stdout: '', stderr: '', exitCode: 0 };
  /** Answer for sasldb/postfix-reload calls; override to simulate a relay that refuses. */
  relayAuthResult: RunResult = { stdout: '', stderr: '', exitCode: 0 };
  /** False = the relay is mailpit (local dev), which has no credential database. */
  relayHasSasl = true;
  /**
   * What the relay's postfix announces, and the HOSTNAME its container was created with (the
   * default), for MailService's hostname probe. Infrastructure like the relay auth: the mail-log
   * tick asks every minute, so it never eats a test's scripted answers. Null = a relay that
   * cannot say, as mailpit cannot.
   */
  relayHostnames: { live: string; fallback: string } | null = { live: 'mail.example.test', fallback: 'mail.example.test' };
  /** What `apache2ctl -t` in a site container says; override to have Apache refuse a file. */
  apacheCheck: RunResult = { stdout: '', stderr: 'Syntax OK', exitCode: 0 };
  /**
   * The administrators `wp user list --role=administrator` finds in every site, oldest first. The
   * panel looks them up on its own - to act as one when it changes a plugin or a theme - so, like
   * the relay housekeeping, the lookup never eats an answer a test lined up. Set it to [] for a
   * site without one.
   */
  administrators: { ID: number; user_login: string }[] = [{ ID: 1, user_login: 'admin' }];
  failOn = new Map<string, string>();
  /**
   * Half-successes: the state change lands and THEN the call throws, matching the real
   * multi-request Docker operations (createContainer succeeds, attaching the second
   * network fails). This is what leaves orphans behind for rollback to deal with.
   */
  failAfter = new Map<string, string>();
  onStart: ((name: string) => void) | null = null;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const fail = this.failOn.get(method);
    if (fail) throw new Error(fail);
  }

  private failLate(method: string): void {
    const fail = this.failAfter.get(method);
    if (fail) throw new Error(fail);
  }

  /**
   * The runc mount step: materialise missing sources as directories, then refuse the ones
   * that are. Runs on start AND restart, because that is when the real runtime resolves the
   * binds - a container created against a file that was deleted afterwards fails here.
   */
  private mountFileBinds(name: string): void {
    for (const bind of this.bindsByContainer.get(name) ?? []) {
      const [src, dst] = bind.split(':');
      if (!src || !dst || !IMAGE_FILE_MOUNTS.includes(dst)) continue;
      if (!fs.existsSync(src)) fs.mkdirSync(src, { recursive: true });
      if (fs.statSync(src).isDirectory()) {
        throw new Error(
          `(HTTP code 400) unexpected - failed to create task for container: failed to create shim task: ` +
            `OCI runtime create failed: error mounting "${src}" to rootfs at "${dst}": not a directory: ` +
            `Are you trying to mount a directory onto a file (or vice-versa)?`,
        );
      }
    }
  }

  async createSiteContainer(spec: SiteContainerSpec): Promise<void> {
    this.record('createSiteContainer', [spec]);
    this.bindsByContainer.set(spec.name, spec.binds);
    this.labelsByContainer.set(spec.name, spec.labels);
    this.limits.set(spec.name, {
      memoryBytes: spec.memoryBytes ?? 512 * 1024 * 1024,
      ...(spec.nanoCpus ? { nanoCpus: spec.nanoCpus } : {}),
      ...(spec.pidsLimit ? { pidsLimit: spec.pidsLimit } : {}),
    });
    // 'created', not 'exited': a container that has never run is what Docker reports, and
    // the difference is what tells a repair job "never started" from "stopped on purpose".
    this.containers.set(spec.name, 'created');
    this.failLate('createSiteContainer');
  }
  async startContainer(name: string): Promise<void> {
    this.record('startContainer', [name]);
    if (this.enforceFileBinds) this.mountFileBinds(name);
    this.containers.set(name, 'running');
    this.onStart?.(name);
  }
  async stopContainer(name: string): Promise<void> {
    this.record('stopContainer', [name]);
    if (this.containers.has(name)) this.containers.set(name, 'exited');
  }
  async restartContainer(name: string): Promise<void> {
    this.record('restartContainer', [name]);
    if (this.enforceFileBinds) this.mountFileBinds(name);
    this.containers.set(name, 'running');
  }
  async removeContainer(name: string): Promise<void> {
    this.record('removeContainer', [name]);
    this.containers.delete(name);
    this.bindsByContainer.delete(name);
    this.labelsByContainer.delete(name);
    this.limits.delete(name);
    this.serviceSpecs.delete(name);
    for (const members of this.networkMembers.values()) members.delete(name);
  }
  async containerState(name: string): Promise<ContainerState> {
    return this.containers.get(name) ?? 'missing';
  }
  /** Whatever the stack was started from; the panel reads its own to clone itself. */
  containerImages = new Map<string, string>([['wpl7-panel', 'ghcr.io/andyfo/wpl7/panel:0.3.0']]);
  async containerImage(name: string): Promise<string | null> {
    return this.containers.has(name) ? (this.containerImages.get(name) ?? `${name}:latest`) : null;
  }
  /**
   * How each container was started. Traefik defaults to what deploy/docker-compose.yml starts it
   * with: the DNS resolver on Cloudflare, the token read from the panel's file.
   */
  containerConfigs = new Map<string, ContainerConfig>([
    [
      'wpl7-traefik',
      { cmd: ['--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=cloudflare'], envSet: ['CF_DNS_API_TOKEN_FILE'] },
    ],
  ]);
  async containerConfig(name: string): Promise<ContainerConfig | null> {
    return this.containers.has(name) ? (this.containerConfigs.get(name) ?? { cmd: [], envSet: [] }) : null;
  }
  /** Each site container's ceilings: as created, then as changed in place. */
  limits = new Map<string, ContainerLimits>();
  async containerLimits(name: string): Promise<ContainerLimits | null> {
    return this.containers.has(name) ? (this.limits.get(name) ?? { memoryBytes: 0 }) : null;
  }
  async updateContainerLimits(name: string, limits: ContainerLimits): Promise<void> {
    this.record('updateContainerLimits', [name, limits]);
    if (!this.containers.has(name)) throw Object.assign(new Error(`No such container: ${name}`), { statusCode: 404 });
    // What the real daemon does: an update without a CPU limit keeps the one there is.
    const nanoCpus = limits.nanoCpus ?? this.limits.get(name)?.nanoCpus;
    this.limits.set(name, {
      memoryBytes: limits.memoryBytes,
      ...(nanoCpus ? { nanoCpus } : {}),
      ...(limits.pidsLimit ? { pidsLimit: limits.pidsLimit } : {}),
    });
  }
  async containerLogs(name: string, opts?: ContainerLogsOpts): Promise<string> {
    this.record('containerLogs', [name, opts]);
    return this.logs.get(name) ?? '';
  }
  async exec(name: string, cmd: string[], opts?: ExecOpts): Promise<RunResult> {
    // opts recorded too, so a test can check what a command was handed through its
    // environment (a recipe's PHP step reads its license key from there, not from argv).
    this.record('exec', [name, cmd, opts]);
    // Relay credential housekeeping (sasldb + reload) is infrastructure the panel does on
    // its own schedule, not something a test lines up answers for. Serving it from the
    // shared queue would hand a site's scripted wp-cli output to the mail container - which
    // is exactly what happened when per-site SASL logins were introduced.
    if (isRelayCapabilityProbe(cmd)) {
      return { stdout: this.relayHasSasl ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 };
    }
    if (isRelayAuthCommand(cmd)) return this.relayAuthResult;
    if (isRelayHostnameProbe(cmd)) {
      return this.relayHostnames
        ? { stdout: `${this.relayHostnames.live}\n${this.relayHostnames.fallback}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'sh: postconf: not found', exitCode: 127 };
    }
    if (isDropInWrite(cmd)) return this.dropIn(name, cmd, null);
    // Apache's own check before a reload of a site's protection (services/security.ts):
    // infrastructure again, answered here rather than from the queue.
    if (cmd[0] === 'apache2ctl') return this.apacheCheck;
    if (isAdministratorList(cmd)) return { stdout: JSON.stringify(this.administrators), stderr: '', exitCode: 0 };
    return this.answer(opts);
  }

  /** The next scripted answer - and, like the real exec, every line of it as it "arrives". */
  private answer(opts: ExecOpts | undefined): RunResult {
    const result = this.execQueue.shift() ?? this.execDefault;
    if (opts?.onOutput) {
      for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
        if (line.trimEnd()) opts.onOutput(line.trimEnd());
      }
    }
    return result;
  }

  /**
   * Where a site container's /var/www/html is on the fake's disk (set by makeWorld). The
   * panel writes its own drop-ins through the container now; mirroring just that one script
   * onto the site's folder keeps those files where the tests have always looked for them -
   * and, like the relay housekeeping above, it never eats an answer a test lined up.
   */
  siteRoot: ((container: string) => string) | null = null;

  private dropIn(name: string, cmd: string[], input: Buffer | null): RunResult {
    const [, dir, file, mode, legacy] = cmd.slice(4) as [string, string, string, string, string];
    const done = (stdout: string): RunResult => ({ stdout, stderr: '', exitCode: 0 });
    const root = this.siteRoot?.(name);
    if (!root) return done('');
    const folder = dir.startsWith('/var/www/html') ? root + dir.slice('/var/www/html'.length) : dir;
    const onDisk = (n: string) => path.join(folder, n);
    if (legacy) fs.rmSync(onDisk(legacy), { force: true });
    if (mode === 'remove') {
      if (!fs.existsSync(onDisk(file))) return done('');
      fs.rmSync(onDisk(file));
      return done('removed');
    }
    fs.mkdirSync(folder, { recursive: true });
    const content = input ?? Buffer.alloc(0);
    const same = fs.existsSync(onDisk(file)) && fs.readFileSync(onDisk(file)).equals(content);
    if (!same) fs.writeFileSync(onDisk(file), content);
    return done(same ? 'same' : 'written');
  }
  /** What each execWithInput call was fed on stdin, in call order. */
  inputs: Buffer[] = [];
  async execWithInput(name: string, cmd: string[], input: Buffer, opts?: ExecOpts): Promise<RunResult> {
    this.record('execWithInput', [name, cmd, opts]);
    this.inputs.push(Buffer.from(input));
    if (isDropInWrite(cmd)) return this.dropIn(name, cmd, input);
    return this.answer(opts);
  }
  /**
   * Scripted answers for execToStream, taken in order; when empty it writes a fake SQL dump,
   * which is what the database-dump callers expect.
   */
  streamQueue: { stdout: Buffer | string; exitCode?: number; stderr?: string }[] = [];
  async execToStream(
    name: string,
    cmd: string[],
    stdout: Writable,
    opts?: ExecOpts,
  ): Promise<{ exitCode: number; stderr: string }> {
    this.record('execToStream', [name, cmd, opts]);
    const scripted = this.streamQueue.shift();
    if (scripted) {
      if (scripted.stdout.length > 0) stdout.write(scripted.stdout);
      return { exitCode: scripted.exitCode ?? 0, stderr: scripted.stderr ?? '' };
    }
    stdout.write('-- fake SQL dump\nCREATE TABLE wp_options (option_id INT);\n'.repeat(10));
    return { exitCode: 0, stderr: '' };
  }
  /** Answers runEphemeral itself when set (a scan engine, a quarantine move); otherwise the queue does. */
  ephemeral: ((opts: EphemeralOpts) => RunResult | Promise<RunResult>) | null = null;
  async runEphemeral(opts: EphemeralOpts): Promise<RunResult> {
    this.record('runEphemeral', [opts]);
    if (this.ephemeral) return this.ephemeral(opts);
    return this.execQueue.shift() ?? this.execDefault;
  }
  async imageExists(tag: string): Promise<boolean> {
    return this.images.has(tag);
  }
  async buildImage(tag: string, contextDir: string, buildArgs: Record<string, string>): Promise<void> {
    this.record('buildImage', [tag, contextDir, buildArgs]);
    this.images.add(tag);
  }
  async pullImage(tag: string): Promise<void> {
    this.record('pullImage', [tag]);
    this.images.add(tag);
  }
  async tagImage(source: string, target: string): Promise<void> {
    this.record('tagImage', [source, target]);
    if (!this.images.has(source)) throw Object.assign(new Error(`No such image: ${source}`), { statusCode: 404 });
    this.images.add(target);
  }
  async removeImage(ref: string): Promise<void> {
    this.record('removeImage', [ref]);
    this.images.delete(ref);
  }
  async pruneImages(labels: string[]): Promise<void> {
    this.record('pruneImages', [labels]);
  }
  /** Cumulative CPU counter; advanced by `cpuNsPerSample` on every read, like a real one. */
  cpuNs = 0;
  cpuNsPerSample = 0;
  async sampleStats(): Promise<ContainerSample> {
    this.cpuNs += this.cpuNsPerSample;
    return { cpuNs: this.cpuNs, memBytes: 1024 * 1024 };
  }
  /** Labels of every container as created, site and service alike - what listManaged filters on. */
  private labelsByContainer = new Map<string, Record<string, string>>();

  async listManaged(labelFilters: string[] = []): Promise<{ name: string; labels: Record<string, string>; state: string }[]> {
    return [...this.labelsByContainer.entries()]
      .filter(([name, labels]) =>
        this.containers.has(name) &&
        labelFilters.every((f) => {
          const [k, v] = f.split('=');
          return k !== undefined && (v === undefined ? k in labels : labels[k] === v);
        }),
      )
      .map(([name, labels]) => ({ name, labels, state: this.containers.get(name)! }));
  }

  // --- service containers (the FTP gateway and file servers, services/ftp.ts) --------
  /** Each service container's spec as last created, with the hash that decides a recreate. */
  serviceSpecs = new Map<string, ServiceContainerSpec & { hash: string }>();
  /** Scripted crash loops: name -> what serviceState reports beyond running/stopped. */
  serviceTrouble = new Map<string, { restarting?: boolean; restartCount?: number }>();
  signals: { name: string; signal: string }[] = [];

  async ensureServiceContainer(spec: ServiceContainerSpec): Promise<ServiceOutcome> {
    this.record('ensureServiceContainer', [spec]);
    const hash = serviceSpecHash(spec);
    const existing = this.serviceSpecs.get(spec.name);
    if (existing && existing.hash === hash && this.containers.has(spec.name)) {
      for (const net of spec.networks) await this.connectContainer(net, spec.name);
      if (this.containers.get(spec.name) === 'running') return 'unchanged';
      this.containers.set(spec.name, 'running');
      return 'started';
    }
    const outcome: ServiceOutcome = this.containers.has(spec.name) ? 'recreated' : 'created';
    if (outcome === 'recreated') {
      for (const members of this.networkMembers.values()) members.delete(spec.name);
    }
    this.serviceSpecs.set(spec.name, { ...spec, hash });
    this.labelsByContainer.set(spec.name, { 'wpl7.managed': 'true', ...spec.labels, [SPEC_LABEL]: hash });
    this.bindsByContainer.set(spec.name, spec.binds);
    for (const net of spec.networks) {
      const members = this.networkMembers.get(net) ?? new Set<string>();
      members.add(spec.name);
      this.networkMembers.set(net, members);
    }
    this.containers.set(spec.name, 'running');
    this.failLate('ensureServiceContainer');
    return outcome;
  }

  async signalContainer(name: string, signal: 'SIGHUP' | 'SIGUSR1'): Promise<boolean> {
    this.record('signalContainer', [name, signal]);
    if (this.containers.get(name) !== 'running') return false;
    this.signals.push({ name, signal });
    return true;
  }

  async serviceState(name: string): Promise<ServiceState> {
    const state = this.containers.get(name) ?? 'missing';
    const trouble = this.serviceTrouble.get(name) ?? {};
    return {
      state,
      restarting: trouble.restarting ?? false,
      restartCount: trouble.restartCount ?? 0,
      startedAt: state === 'running' ? 1 : null,
    };
  }

  // --- networks (see services/siteNetwork.ts) --------------------------------
  /** name -> spec, mirroring what the daemon would hold. */
  networks = new Map<string, NetworkSpec>();
  /** network -> attached container names. Infra containers exist so they can be attached. */
  networkMembers = new Map<string, Set<string>>();

  async ensureNetwork(spec: NetworkSpec): Promise<EnsureNetworkResult> {
    this.record('ensureNetwork', [spec]);
    const existing = this.networks.get(spec.name);
    if (existing) {
      const same =
        (existing.internal ?? false) === (spec.internal ?? false) &&
        Object.entries(spec.options ?? {}).every(([k, v]) => existing.options?.[k] === v);
      if (same) return { outcome: 'existing', detached: [] };
      const detached = [...(this.networkMembers.get(spec.name) ?? [])];
      this.networks.set(spec.name, spec);
      this.networkMembers.set(spec.name, new Set());
      return { outcome: 'recreated', detached };
    }
    this.networks.set(spec.name, spec);
    this.networkMembers.set(spec.name, new Set());
    return { outcome: 'created', detached: [] };
  }

  async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    const spec = this.networks.get(name);
    if (!spec) return null;
    return {
      name,
      internal: spec.internal ?? false,
      options: spec.options ?? {},
      containers: [...(this.networkMembers.get(name) ?? [])],
    };
  }

  async removeNetwork(name: string): Promise<void> {
    this.record('removeNetwork', [name]);
    this.networks.delete(name);
    this.networkMembers.delete(name);
  }

  async listNetworkNames(labelFilters: string[] = []): Promise<string[]> {
    return [...this.networks.entries()]
      .filter(([, spec]) =>
        labelFilters.every((f) => {
          const [k, v] = f.split('=');
          return k !== undefined && spec.labels?.[k] === v;
        }),
      )
      .map(([name]) => name);
  }

  async containerNetworks(name: string): Promise<string[]> {
    if (!this.containers.has(name)) return [];
    return [...this.networkMembers.entries()].filter(([, members]) => members.has(name)).map(([net]) => net);
  }

  async connectContainer(network: string, container: string): Promise<void> {
    this.record('connectContainer', [network, container]);
    const members = this.networkMembers.get(network) ?? new Set<string>();
    members.add(container);
    this.networkMembers.set(network, members);
  }

  async disconnectContainer(network: string, container: string): Promise<void> {
    this.record('disconnectContainer', [network, container]);
    this.networkMembers.get(network)?.delete(container);
  }
}

export class FakeDbAdmin implements DbAdminPort {
  calls: { method: string; args: unknown[] }[] = [];
  failOn = new Map<string, string>();
  databases = new Set<string>();

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const fail = this.failOn.get(method);
    if (fail) throw new Error(fail);
  }

  async createSiteDb(dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    this.record('createSiteDb', [dbName, dbUser, dbPassword]);
    this.databases.add(dbName);
  }
  async dropSiteDb(dbName: string, dbUser: string): Promise<void> {
    this.record('dropSiteDb', [dbName, dbUser]);
    this.databases.delete(dbName);
  }
  async recreateDb(dbName: string): Promise<void> {
    this.record('recreateDb', [dbName]);
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async dumpTo(dbName: string, destGzPath: string): Promise<void> {
    this.record('dumpTo', [dbName, destGzPath]);
    fs.writeFileSync(destGzPath, '-- fake SQL dump\nCREATE TABLE wp_options (option_id INT);\n'.repeat(10));
  }
  async importFrom(srcGzPath: string, dbName: string): Promise<void> {
    this.record('importFrom', [srcGzPath, dbName]);
  }
  async importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    this.record('importFromAs', [srcGzPath, dbName, dbUser, dbPassword]);
  }
}

export const fakeExecOk: ExecPort = {
  async run(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  async runWithInput(_cmd, _args, input): Promise<ExecResult> {
    input.resume(); // drain
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  async runToStream(): Promise<{ exitCode: number; stderr: string }> {
    return { exitCode: 0, stderr: '' };
  },
};

/** Recording ExecPort for command-shape assertions (streams scripted output). */
export class FakeExec implements ExecPort {
  calls: { method: string; cmd: string; args: string[]; input?: string }[] = [];
  results: ExecResult[] = [];
  resultDefault: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
  streamOutput = '';

  async run(cmd: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ method: 'run', cmd, args });
    return this.results.shift() ?? this.resultDefault;
  }
  async runWithInput(cmd: string, args: string[], input: Readable): Promise<ExecResult> {
    const chunks: Buffer[] = [];
    input.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    await new Promise((r) => input.on('end', r));
    this.calls.push({ method: 'runWithInput', cmd, args, input: Buffer.concat(chunks).toString() });
    return this.results.shift() ?? this.resultDefault;
  }
  async runToStream(cmd: string, args: string[], stdout: Writable): Promise<{ exitCode: number; stderr: string }> {
    this.calls.push({ method: 'runToStream', cmd, args });
    if (this.streamOutput) stdout.write(this.streamOutput);
    stdout.end();
    const res = this.results.shift() ?? this.resultDefault;
    return { exitCode: res.exitCode, stderr: res.stderr };
  }
}

export interface FakeServerPorts {
  docker: FakeDocker;
  dbAdmin: FakeDbAdmin;
  exec: ExecPort;
  files: FilesPort;
  /** Set when the fake server has a real filesystem root (addSshServer real:true). */
  root?: string;
}

// ---------------------------------------------------------------------------
// Path-mapping decorators: a fake "remote" server gets its own tmpdir while
// handlers keep using the canonical /srv-style paths - real tar/extract/stat
// semantics without path collisions between "servers" on one machine.

const mapPath = (p: string, from: string, to: string) => p.split(from).join(to);

export class MappedFiles implements FilesPort {
  constructor(
    private readonly inner: FilesPort,
    private readonly from: string,
    private readonly to: string,
  ) {}
  private m(p: string) {
    return mapPath(p, this.from, this.to);
  }
  exists(p: string) {
    return this.inner.exists(this.m(p));
  }
  isDirectory(p: string) {
    return this.inner.isDirectory(this.m(p));
  }
  mkdirp(p: string, opts?: Parameters<FilesPort['mkdirp']>[1]) {
    return this.inner.mkdirp(this.m(p), opts);
  }
  mkdirExclusive(p: string) {
    return this.inner.mkdirExclusive(this.m(p));
  }
  writeFile(p: string, c: string | Buffer, opts?: Parameters<FilesPort['writeFile']>[2]) {
    return this.inner.writeFile(this.m(p), c, opts);
  }
  readFile(p: string) {
    return this.inner.readFile(this.m(p));
  }
  readOptional(p: string) {
    return this.inner.readOptional(this.m(p));
  }
  readUntrusted(p: string, maxBytes: number) {
    return this.inner.readUntrusted(this.m(p), maxBytes);
  }
  rm(p: string) {
    return this.inner.rm(this.m(p));
  }
  rename(a: string, b: string) {
    return this.inner.rename(this.m(a), this.m(b));
  }
  readdir(p: string) {
    return this.inner.readdir(this.m(p));
  }
  stat(p: string) {
    return this.inner.stat(this.m(p));
  }
  statvfs(p: string) {
    return this.inner.statvfs(this.m(p));
  }
  sha256(p: string) {
    return this.inner.sha256(this.m(p));
  }
}

export class MappedExec implements ExecPort {
  constructor(
    private readonly inner: ExecPort,
    private readonly from: string,
    private readonly to: string,
  ) {}
  private m(args: string[]) {
    return args.map((a) => mapPath(a, this.from, this.to));
  }
  run(cmd: string, args: string[], opts?: Parameters<ExecPort['run']>[2]) {
    return this.inner.run(cmd, this.m(args), opts);
  }
  runWithInput(cmd: string, args: string[], input: Readable, opts?: Parameters<ExecPort['run']>[2]) {
    return this.inner.runWithInput(cmd, this.m(args), input, opts);
  }
  runToStream(cmd: string, args: string[], stdout: Writable, opts?: Parameters<ExecPort['run']>[2]) {
    return this.inner.runToStream(cmd, this.m(args), stdout, opts);
  }
}

class MappedDbAdmin extends FakeDbAdmin {
  constructor(
    private readonly from: string,
    private readonly to: string,
  ) {
    super();
  }
  override async dumpTo(dbName: string, destGzPath: string): Promise<void> {
    await super.dumpTo(dbName, mapPath(destGzPath, this.from, this.to));
  }
}

/** One fake PTY handed out by FakeShell; poke it to script the "remote" side. */
export class FakeTerminal implements OpenTerminal {
  /** Bytes the route wrote as stdin. */
  stdin: Buffer[] = [];
  resizes: { cols: number; rows: number }[] = [];
  disposed = false;
  channel: Duplex;
  exit: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;

  constructor(public readonly opts: ShellConnectOpts) {
    const self = this;
    this.channel = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        self.stdin.push(Buffer.from(chunk));
        cb();
      },
    });
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  setWindow(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  /** Emit PTY output toward the websocket. */
  output(data: string | Buffer): void {
    this.channel.push(Buffer.from(data));
  }
  /** Remote shell exits on its own. */
  end(code: number | null = 0): void {
    this.resolveExit(code);
  }
  dispose(): void {
    this.disposed = true;
    this.resolveExit(null);
  }
}

/** Scriptable ShellConnectFn: records connects, can fail some, hands out FakeTerminals. */
export class FakeShell {
  connects: ShellConnectOpts[] = [];
  opened: FakeTerminal[] = [];
  /** Errors thrown by upcoming connects, in order (shift'ed); then connects succeed. */
  failQueue: Error[] = [];
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  /** Block every connect mid-setup, so tests can act while a session is opening. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }
  /** Let held connects finish. */
  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  connect: ShellConnectFn = async (opts) => {
    this.connects.push(opts);
    if (this.gate) await this.gate;
    const fail = this.failQueue.shift();
    if (fail) throw fail;
    const terminal = new FakeTerminal(opts);
    this.opened.push(terminal);
    return terminal;
  };
}

/** An ssh2-shaped auth failure (what a missing key in authorized_keys produces). */
export function sshAuthFailure(): Error {
  const err = new Error('All configured authentication methods failed');
  (err as Error & { level: string }).level = 'client-authentication';
  return err;
}

/**
 * Stand-in for the wordpress.org directory. `known` is the whole universe of plugins:
 * anything not listed is "not found", which is what the catalog's slug check keys off.
 */
export class FakeWporg implements WporgDirectory {
  known = new Map<string, WporgPluginDto>();
  calls: { method: 'search' | 'info'; arg: string }[] = [];
  /** When set, every lookup throws this instead of answering. See goOffline(). */
  failure: Error | null = null;

  constructor(slugs: string[] = ['akismet', 'wordpress-seo', 'classic-editor']) {
    for (const slug of slugs) this.add(slug);
  }

  /** Simulate a panel with no outbound internet access, as the real client reports it. */
  goOffline(): void {
    this.failure = badGateway('Could not reach the wordpress.org plugin directory.');
  }

  add(slug: string, patch: Partial<WporgPluginDto> = {}): WporgPluginDto {
    const plugin: WporgPluginDto = {
      slug,
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      author: 'Test Author',
      shortDescription: `The ${slug} plugin.`,
      version: '1.0.0',
      activeInstalls: 1000,
      rating: 90,
      numRatings: 10,
      requiresWp: '6.0',
      requiresPhp: '7.4',
      testedUpTo: '6.8',
      lastUpdated: '2026-01-01 12:00am GMT',
      homepage: `https://example.test/${slug}`,
      icon: null,
      ...patch,
    };
    this.known.set(slug, plugin);
    return plugin;
  }

  async search(query: string, page = 1): Promise<WporgSearchResult> {
    this.calls.push({ method: 'search', arg: query });
    if (this.failure) throw this.failure;
    const items = [...this.known.values()].filter(
      (p) => p.slug.includes(query.toLowerCase()) || p.name.toLowerCase().includes(query.toLowerCase()),
    );
    return { items, page, pages: 1, total: items.length };
  }

  async info(slug: string): Promise<WporgPluginDto | null> {
    this.calls.push({ method: 'info', arg: slug });
    if (this.failure) throw this.failure;
    return this.known.get(slug.toLowerCase()) ?? null;
  }
}

/**
 * `wpl7-firewall` on one server, as far as the panel can tell: installed or not, switched off
 * or not, its table loaded or not, which boot it is in. `apply` reads the rules the panel
 * wrote, from where the server's files really are.
 */
export class FakeFirewallHost {
  installed = true;
  off = false;
  table = false;
  bootId = 'boot-1';
  /** Set to make the next applies fail the way `nft -c` refusing the file does. */
  failApply: string | null = null;
  /** Set to make every call fail without an answer, the way a helper that hangs does. */
  failRun: string | null = null;
  /** The rules file as it was at each apply. */
  applied: string[] = [];
  calls: string[] = [];

  constructor(private readonly rulesPath: () => string) {}

  /** A reboot: the kernel forgot the table. */
  reboot(): void {
    this.table = false;
    this.bootId = `boot-${Number(this.bootId.split('-')[1] ?? 0) + 1}`;
  }

  private status(state: string, message = ''): string {
    return JSON.stringify({ state, table: this.table, appliedAt: Math.floor(Date.now() / 1000), sha256: '', bootId: this.bootId, message });
  }

  port(): HostPort {
    return {
      run: async (cmd, args) => {
        this.calls.push([cmd, ...args].join(' '));
        if (this.failRun) throw new Error(this.failRun);
        if (!this.installed) return { stdout: '', stderr: 'sudo: wpl7-firewall: command not found', exitCode: 127 };
        const sub = args[0];
        if (sub === 'status') return { stdout: this.status(this.off ? 'off' : this.table ? 'ok' : 'missing'), stderr: '', exitCode: 0 };
        if (sub === 'apply') {
          if (this.off) return { stdout: this.status('off'), stderr: '', exitCode: 0 };
          if (this.failApply) return { stdout: this.status('error', this.failApply), stderr: '', exitCode: 1 };
          this.applied.push(fs.readFileSync(this.rulesPath(), 'utf8'));
          this.table = true;
          return { stdout: this.status('ok'), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: `unknown ${sub}`, exitCode: 2 };
      },
    };
  }
}

export interface TestWorld {
  db: Db;
  /** Scripted GitHub Releases API, backing the update checker. */
  github: FakeGitHub;
  /** Scripted root SSH to the panel's own host, backing the Update button. */
  host: FakeHostExec;
  /** The Update button's service, with the fake host shell behind it. */
  system: SystemUpdateService;
  config: Config;
  /** Server 1's fakes (existing tests assert against these directly). */
  docker: FakeDocker;
  dbAdmin: FakeDbAdmin;
  servers: ServerRegistry;
  core: CoreServices;
  geoip: GeoIpService;
  /** Offsite destinations + the reconciler, for tests that exercise copies directly. */
  offsite: OffsiteService;
  worker: JobWorker;
  deps: AppDeps;
  /** The web terminal's fake SSH layer. */
  shell: FakeShell;
  /** The fake wordpress.org directory backing the catalog and the plugin typeahead. */
  wporg: FakeWporg;
  /** `wpl7-firewall` on each server (created the first time a server is asked about). */
  firewallHost(serverId: number): FakeFirewallHost;
  /** wordpress.org's checksum lists, as the malware scan fetches them. */
  checksums: FakeChecksums;
  /** Fakes for ssh-kind server rows, keyed by server id (created lazily). */
  remote(serverId: number): FakeServerPorts;
  /**
   * Insert an ssh-kind server row. real:true gives it a real filesystem in its own
   * tmpdir (path-mapped hostExec + LocalFiles) so tar/extract/stream semantics are real.
   */
  addSshServer(name: string, opts?: { real?: boolean; publicIp?: string; devDomain?: string }): FakeServerPorts & { id: number };
}

/**
 * The root SSH connection to the panel's own host, scripted.
 *
 * Only the ssh2 round trip is faked: the real HostShell still resolves the host, reads the
 * panel key and pins server 1's host key, because those are the parts that go wrong.
 */
export class FakeHostExec {
  commands: string[] = [];
  results: HostRunResult[] = [];
  fallback: HostRunResult = { stdout: '', stderr: '', exitCode: 0 };
  /** Set to simulate an unreachable host (sshd down, key refused). */
  failWith: Error | null = null;

  run: HostExecFn = async (opts) => {
    this.commands.push(opts.command);
    if (this.failWith) throw this.failWith;
    return this.results.shift() ?? this.fallback;
  };
}

/**
 * The GitHub Releases API, scripted.
 *
 * Nothing in the suite is allowed near the network, and the update checker is the one
 * service whose whole job is to reach out - so the default answer is a 404 and every test
 * that wants a release says so. Responses can be queued to exercise ETags and rate limits,
 * which are the two things that decide whether a fleet keeps being told about updates.
 */
export interface FakeGitHubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export class FakeGitHub {
  /** url substring -> response. */
  routes: { match: string; response: FakeGitHubResponse }[] = [];
  requests: { url: string; headers: Record<string, string> }[] = [];

  /** Last writer wins, so a test can re-script a route to publish a newer release. */
  on(match: string, response: FakeGitHubResponse): this {
    this.routes = this.routes.filter((r) => r.match !== match);
    this.routes.push({ match, response });
    return this;
  }

  /** The common case: one release with a manifest asset, on the given channel. */
  release(manifest: Record<string, unknown>, opts: { etag?: string; prerelease?: boolean } = {}): this {
    const assetUrl = 'https://api.github.com/repos/x/y/releases/assets/1';
    const release = {
      draft: false,
      prerelease: opts.prerelease ?? manifest.channel === 'edge',
      assets: [{ name: 'manifest.json', url: assetUrl }],
    };
    const headers: Record<string, string> = opts.etag ? { etag: opts.etag } : {};
    this.on('/releases?per_page', { status: 200, body: [release], headers });
    this.on('/releases/tags/', { status: 200, body: release, headers });
    this.on('/releases/assets/', { status: 200, body: manifest });
    return this;
  }

  fetch = async (url: string, init: { headers: Record<string, string> }) => {
    this.requests.push({ url, headers: init.headers });
    const route = this.routes.find((r) => url.includes(r.match));
    const res = route?.response ?? { status: 404, body: { message: 'Not Found' } };
    const headers = res.headers ?? {};
    return {
      status: res.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => res.body,
      text: async () => JSON.stringify(res.body),
    };
  };
}

/**
 * Recording DNS provider fake: manages any zone listed in `zones`. Also the client Settings ->
 * DNS checks a token with (makeWorld's `dnsClient`): `refuse` answers the way Cloudflare does a
 * token it will not take, `recordsRefused` a zone the token reads but not its records.
 */
export class FakeDnsProvider implements DnsClient {
  zones: string[] = [];
  records = new Map<string, string>(); // fqdn -> ip
  txt = new Map<string, DnsTxtRecord[]>(); // fqdn -> TXT records
  refuse: CloudflareApiError | null = null;
  recordsRefused = new Set<string>();
  private txtSeq = 0;
  calls: { method: string; fqdn: string; ip?: string; content?: string; zone?: string }[] = [];

  /** What Cloudflare answers a token it does not know. */
  static invalidToken(): CloudflareApiError {
    return new CloudflareApiError(400, 'Invalid API Token (1000)', 'GET', '/zones');
  }

  async listZones(): Promise<{ zones: DnsZone[]; total: number }> {
    this.calls.push({ method: 'listZones', fqdn: '' });
    if (this.refuse) throw this.refuse;
    return { zones: this.zones.map((name) => ({ id: `zone-${name}`, name })), total: this.zones.length };
  }
  async probeRecords(zone: DnsZone): Promise<void> {
    this.calls.push({ method: 'probeRecords', fqdn: zone.name, zone: zone.name });
    if (this.recordsRefused.has(zone.name)) {
      throw new CloudflareApiError(403, 'Unauthorized to access requested resource (9109)', 'GET', `/zones/${zone.id}/dns_records`);
    }
  }

  async findZone(fqdn: string): Promise<DnsZone | null> {
    this.calls.push({ method: 'findZone', fqdn });
    if (this.refuse) throw this.refuse;
    const zone = this.zones.find((z) => fqdn === z || fqdn.endsWith(`.${z}`));
    return zone ? { id: `zone-${zone}`, name: zone } : null;
  }
  async upsertA(zone: DnsZone, fqdn: string, ip: string): Promise<void> {
    // The zone is recorded so tests can catch a record being written into the wrong one.
    this.calls.push({ method: 'upsertA', fqdn, ip, zone: zone.name });
    this.records.set(fqdn, ip);
  }
  async deleteA(zone: DnsZone, fqdn: string): Promise<void> {
    this.calls.push({ method: 'deleteA', fqdn, zone: zone.name });
    this.records.delete(fqdn);
  }

  // --- TXT (SPF / DKIM / DMARC), keyed by name so several can share one.
  async listTxt(zone: DnsZone, fqdn: string): Promise<DnsTxtRecord[]> {
    this.calls.push({ method: 'listTxt', fqdn, zone: zone.name });
    return [...(this.txt.get(fqdn) ?? [])];
  }
  async createTxt(zone: DnsZone, fqdn: string, content: string): Promise<void> {
    this.calls.push({ method: 'createTxt', fqdn, content, zone: zone.name });
    const list = this.txt.get(fqdn) ?? [];
    list.push({ id: `txt-${++this.txtSeq}`, content });
    this.txt.set(fqdn, list);
  }
  async updateTxt(zone: DnsZone, recordId: string, fqdn: string, content: string): Promise<void> {
    this.calls.push({ method: 'updateTxt', fqdn, content, zone: zone.name });
    const list = this.txt.get(fqdn) ?? [];
    const existing = list.find((r) => r.id === recordId);
    if (!existing) throw new Error(`no TXT record ${recordId} at ${fqdn}`);
    existing.content = content;
  }

  /** Seed a record the way a customer's zone would already have one. */
  seedTxt(fqdn: string, content: string): string {
    const list = this.txt.get(fqdn) ?? [];
    const id = `txt-${++this.txtSeq}`;
    list.push({ id, content });
    this.txt.set(fqdn, list);
    return id;
  }
}

const refuseCloudflare = (): never => {
  throw new Error('test tried to reach Cloudflare; pass makeWorld({ dnsClient })');
};

/** Nothing in the suite may reach the network; a test that means to post supplies its own. */
const refuseToLeaveTheSuite: PostLike = async (url) => {
  throw new Error(`test tried to POST ${url}; pass makeWorld({ communityPost })`);
};

export async function makeWorld(
  opts: {
    exec?: ExecPort;
    dnsProvider?: DnsProviderClient;
    /**
     * The Cloudflare client Settings -> DNS makes from a token. Without one, a test that sets a
     * token fails rather than reaching Cloudflare.
     */
    dnsClient?: (token: string) => DnsClient;
    wporg?: FakeWporg;
    resolver?: DnsResolver;
    /** The community's /feedback endpoint. Without one the suite refuses to leave the box. */
    communityPost?: PostLike;
    github?: FakeGitHub;
    host?: FakeHostExec;
    geoip?: GeoIpService;
    /** Pass the same config a pre-built GeoIpService was given, so they share an SRV_ROOT. */
    config?: Config;
    /**
     * Answers for the wpvulnerability.net lookups. Without it every lookup fails, which is
     * the offline path a test install is on anyway.
     */
    feedFetch?: typeof fetch;
    /** Environment overrides, for the settings a box's .env decides (channel, registry). */
    env?: Record<string, string>;
    /** Answers for the public catalog's index and signature; absent = unreachable. */
    catalogFetch?: typeof fetch;
  } = {},
): Promise<TestWorld> {
  const config = opts.config ?? makeTestConfig(opts.env);
  // Mirror the boot-time layout from src/index.ts.
  for (const dir of [config.paths.sites, config.paths.backups, config.paths.plugins, config.paths.panel]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Stand-in for ensurePanelSshKey() - the terminal service reads these.
  fs.mkdirSync(config.paths.sshDir, { recursive: true });
  fs.writeFileSync(config.paths.sshKey, 'FAKE-PRIVATE-KEY');
  fs.writeFileSync(config.paths.sshPubKey, 'ssh-ed25519 AAAAFAKEKEY wpl7-panel@test\n');
  const db = await seededTestDb(config);
  const docker = new FakeDocker();
  docker.siteRoot = (container) => sitePaths(config, container.replace(/^wp-/, '')).wordpress;
  // Server 1 is provisioned, like every other server the tests register: its stack is up.
  // Site networks are only attachable once Traefik, the relay and MariaDB exist.
  for (const c of ['wpl7-mariadb', 'wpl7-traefik', 'wpl7-mail', 'wpl7-dkim']) docker.containers.set(c, 'running');
  const dbAdmin = new FakeDbAdmin();
  const exec = opts.exec ?? fakeExecOk;
  const remoteFakes = new Map<number, FakeServerPorts>();
  const remote = (serverId: number): FakeServerPorts => {
    let ports = remoteFakes.get(serverId);
    if (!ports) {
      ports = { docker: new FakeDocker(), dbAdmin: new FakeDbAdmin(), exec: fakeExecOk, files: new LocalFiles() };
      remoteFakes.set(serverId, ports);
    }
    return ports;
  };
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const servers = new ServerRegistry(db, config, log, {
    makeLocal: () => ({ docker, exec, files: new LocalFiles(), dbAdmin }),
    makeSsh: (row): HandlePorts => remote(row.id),
    // No Traefik in tests: a probe is refused at once, as on a server with nothing listening.
    // Without this one went to the server's documentation-range address and waited out its
    // timeout, or reached whatever the machine running the suite has on :443. A test that
    // wants an answer points the handle at an edge of its own (monitorUptime.test.ts).
    probeUrl: () => 'http://127.0.0.1:1/',
  });
  const addSshServer: TestWorld['addSshServer'] = (name, opts = {}) => {
    const now = Date.now();
    const row = db
      .insert(serversTable)
      .values({
        name,
        kind: 'ssh',
        sshHost: `${name}.test`,
        publicIp: opts.publicIp ?? '203.0.113.9',
        devDomain: opts.devDomain ?? config.devDomain,
        status: 'ok',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    let ports: FakeServerPorts;
    if (opts.real) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-remote-'));
      ports = {
        docker: new FakeDocker(),
        dbAdmin: new MappedDbAdmin(config.srvRoot, root),
        exec: new MappedExec(hostExec, config.srvRoot, root),
        files: new MappedFiles(new LocalFiles(), config.srvRoot, root),
        root,
      };
    } else {
      ports = { docker: new FakeDocker(), dbAdmin: new FakeDbAdmin(), exec: fakeExecOk, files: new LocalFiles() };
    }
    // A provisioned server has its stack running.
    for (const c of ['wpl7-mariadb', 'wpl7-traefik', 'wpl7-mail', 'wpl7-dkim']) ports.docker.containers.set(c, 'running');
    remoteFakes.set(row.id, ports);
    return { ...ports, id: row.id };
  };
  const settings = new SettingsService(db);
  const monitor = new MonitorService(db, config, servers);
  const backup = new BackupService(db, config, servers);
  const dns = new DnsService(opts.dnsProvider ?? null, log);
  const dnsAccount = new DnsAccount(settings, dns, servers, config, log, opts.dnsClient ?? refuseCloudflare);
  // No debounce: a test awaits `traefikDns.idle()` (or the sync itself).
  const traefikDns = new TraefikDnsSync(config, servers, () => dnsAccount.token(), log, { debounceMs: 0 });
  dnsAccount.onChange = () => void traefikDns.kickAll();
  // No settle: the fake relay has logged the test message by the time sendmail returns.
  const mail = new MailService(db, config, servers, settings, log, opts.resolver, dns, 0);
  const offsite = new OffsiteService(db, config, servers, backup, mail, log);
  // No host SSH in tests: server 1's own exec port is the panel, which is what a dev-mode
  // (uncontainerized) panel looks like anyway.
  const storage = new StorageService(db, config, servers, backup, log, null);
  // No network in tests: with no cached table every lookup answers null, which is
  // exactly the 'country data not downloaded yet' path a fresh install is on.
  const geoip = opts.geoip ?? new GeoIpService(config, log, async () => new Response('', { status: 503 }));
  // No network in tests: the ranges shipped with the panel are what a test sees.
  const proxyRanges = new ProxyRangesService(settings, log, async () => new Response('', { status: 503 }));
  const traffic = new TrafficService(db, servers, settings, log, geoip, () => proxyRanges.trusted());
  // No network in tests: every lookup fails, which puts the feed on its stale-if-error
  // path unless a test scripts its own answers (see test/unit/vulnerabilities.test.ts).
  const vulnerabilities = new VulnerabilityFeedService(db, settings, log, {
    fetchImpl: opts.feedFetch ?? (async () => new Response('', { status: 503 })),
  });
  const github = opts.github ?? new FakeGitHub();
  const updates = new UpdateService(settings, config, log, github.fetch);
  const host = opts.host ?? new FakeHostExec();
  const system = new SystemUpdateService(db, config, settings, updates, new HostShell(db, config, servers, log, host.run), log);
  // `worker` is filled in by JobWorker's constructor below - see CoreServices.
  // The real bundled recipes (panel/catalog), so a test sees what an install sees; tests
  // that need a recipe of their own add it through `core.licenses.catalog.add()`. No network
  // in tests: the catalog is only fetched when a test scripts its own answers (see
  // test/unit/catalogSync.test.ts), and a fetch that fails keeps the bundled recipes.
  const catalog = new RecipeCatalog(log);
  const panelFiles = new PanelFiles(db);
  const licenses = new LicenseService(db, config, catalog, panelFiles);
  const catalogSync = new CatalogSyncService(db, config, settings, catalog, log, {
    fetchImpl: opts.catalogFetch ?? (async () => new Response('', { status: 503 })),
  });
  licenses.reload = () => catalogSync.rebuild();
  catalogSync.rebuild();
  // No debounce: a test awaits the sync a change kicked (ftp.idle()) instead of a timer.
  const ftp = new FtpService(db, config, servers, settings, log, { debounceMs: 0, settleMs: 0 });
  // No debounce either: a test awaits `security.idle()` (or the kick itself).
  const security = new SecurityService(db, config, servers, settings, proxyRanges, log, { debounceMs: 0 });
  proxyRanges.onChange = () => {
    void security.kickAll();
    void firewall.kickAll();
  };
  const blocklist = new BlocklistService(db, settings, servers, proxyRanges, geoip, log);
  const firewallHosts = new Map<number, FakeFirewallHost>();
  const firewallHost = (serverId: number): FakeFirewallHost => {
    let host = firewallHosts.get(serverId);
    if (!host) {
      host = new FakeFirewallHost(() => {
        const rootOf = serverId === 1 ? config.srvRoot : (remoteFakes.get(serverId)?.root ?? config.srvRoot);
        return path.join(rootOf, 'wpl7-firewall', 'wpl7.nft');
      });
      firewallHosts.set(serverId, host);
    }
    return host;
  };
  const firewall = new FirewallSyncService(config, servers, settings, blocklist, proxyRanges, (id) => firewallHost(id).port(), log, { debounceMs: 0 });
  blocklist.onChange = () => void firewall.kickAll();
  const securityEvents = new SecurityEventsService(db, settings, geoip, blocklist);
  const detector = new AttackDetector(settings, blocklist, log, { reverse: async () => [], lookup: async () => [] });
  const checksums = new FakeChecksums();
  const integrityManifests = new IntegrityManifests(db, log, checksums.fetch);
  const quarantine = new QuarantineService(db, config, servers, log);
  const pluginZipChecks = new PluginZipChecks(db, servers, settings, (subject, body) => mail.notifyOperator(subject, body), log);
  const malwareScan = new MalwareScanService(db, config, servers, settings, integrityManifests, pluginZipChecks, panelFiles, quarantine, (subject, body) => mail.notifyOperator(subject, body), log);
  traffic.onEvents((serverId, events, chunk) => {
    securityEvents.fold(events);
    security.noteTraefikLog(chunk);
    detector.feed(serverId, events);
  });
  const core = {
    config,
    db,
    servers,
    backup,
    offsite,
    storage,
    monitor,
    settings,
    dns,
    dnsAccount,
    traefikDns,
    mail,
    traffic,
    updates,
    system,
    geoip,
    vulnerabilities,
    licenses,
    catalogSync,
    ftp,
    proxyRanges,
    security,
    blocklist,
    securityEvents,
    firewall,
    detector,
    integrityManifests,
    malwareScan,
    pluginZipChecks,
    panelFiles,
    quarantine,
    log,
  } as unknown as CoreServices;
  core.wpInventory = new WpInventoryService(core, vulnerabilities);
  const worker = new JobWorker(db, core);
  offsite.attachWorker(worker);
  const shell = new FakeShell();
  const wporg = opts.wporg ?? new FakeWporg();
  const users = new UsersService(db);
  const deps: AppDeps = {
    ...core,
    worker,
    sites: new SitesService(core, worker),
    apiKeys: new ApiKeysService(db),
    apiActivity: new ApiActivityService(db),
    users,
    twoFactor: new TwoFactorService(users, config.panelDomain),
    recovery: new AccountRecoveryService(users, mail, config, log),
    oauth: new OAuthService(db, config, settings, log),
    pluginCatalog: new PluginCatalogService(db, config.paths.plugins, wporg),
    wpBulk: new WpBulkService(core, worker, core.wpInventory),
    wporg,
    serverInfo: new SystemInfoService(servers, log, null, opts.resolver),
    feedback: new FeedbackService(config, log, opts.communityPost ?? refuseToLeaveTheSuite),
    terminal: new TerminalService(db, config, servers, log, { connect: shell.connect }),
    // Never started: no timer runs in a test unless it calls `run()` / `runDueCustom()`.
    schedulers: new Schedulers(core, worker),
  };
  return { db, config, docker, dbAdmin, servers, core, geoip, offsite, worker, deps, shell, wporg, github, host, system, remote, addSshServer, firewallHost, checksums };
}

export async function makeApp(world?: TestWorld, opts: { webDist?: string } = {}) {
  const w = world ?? (await makeWorld());
  // No web app unless the test asked for one: whether `npm run build:web` happens to have
  // been run on this machine must not change what the suite exercises.
  const app = await buildServer(w.deps, { webDist: opts.webDist ?? null });
  return { app, world: w };
}

/** A stand-in for `web/dist`: index.html plus one hashed asset, which is all the panel serves. */
export function makeWebDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-web-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html lang="en">\n  <body><div id="root"></div></body>\n</html>\n',
  );
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("panel");\n');
  return dir;
}

/**
 * A zip of `entries` (name -> content; a name ending in `/` is a folder), stored rather than
 * deflated: real enough for `unzip`, and for anything that reads the central directory.
 * `zip64` writes the end records the way a streaming zipper does - the classic one saying
 * only "see the Zip64 record".
 */
export function zipOf(entries: Record<string, string>, opts: { comment?: string; zip64?: boolean } = {}): Buffer {
  const JAN_1_1980 = 0x21;
  const files: Buffer[] = [];
  const index: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(JAN_1_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(JAN_1_1980, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); // MS-DOS directory attribute
    entry.writeUInt32LE(offset, 42);
    files.push(local, fileName, data);
    index.push(entry, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const dir = Buffer.concat(index);
  const count = Object.keys(entries).length;
  const comment = Buffer.from(opts.comment ?? '');
  const zip64: Buffer[] = [];
  if (opts.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(dir.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + dir.length), 8);
    locator.writeUInt32LE(1, 16);
    zip64.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(opts.zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : dir.length, 12);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...files, dir, ...zip64, end, comment]);
}

/**
 * What curl prints for one REST exchange (src/services/wpRest.ts): the body on stdout, the
 * write-out on stderr - its `%{header_json}` one header per line, the way curl 8 lays it out.
 * Queue it on `docker.execQueue`; `status: 0` with an `errormsg` is a request nothing answered.
 */
export function curlAnswer(
  opts: {
    status?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string[]>;
    exitCode?: number;
    errormsg?: string;
    sizeDownload?: number;
  } = {},
): RunResult {
  const body = opts.body ?? '';
  const contentType = opts.contentType ?? 'application/json; charset=UTF-8';
  const meta = {
    http_code: opts.status ?? 200,
    content_type: contentType,
    size_download: opts.sizeDownload ?? Buffer.byteLength(body),
    time_total: 0.042,
    errormsg: opts.errormsg ?? null,
    exitcode: opts.exitCode ?? 0,
  };
  const headers = JSON.stringify({ 'content-type': [contentType], ...opts.headers }).replace(/\],"/g, '],\n"');
  return {
    stdout: body,
    stderr: `\n@@wpl7-meta@@${JSON.stringify(meta)}\n@@wpl7-headers@@${headers}\n`,
    exitCode: opts.exitCode ?? 0,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Checked often: most conditions are one query, and ~200 waits in the suite each lose half
  // an interval on average.
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** What a 2026-07-28 client puts in every request's `_meta`. */
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'wpl7-test', version: '1' },
};

/**
 * A JSON-RPC client of /mcp, as a client of either protocol era sends its requests. A 2025-era
 * answer arrives as a short event stream, so its message is read off the `data:` line.
 */
export function mcpClient(
  app: Awaited<ReturnType<typeof buildServer>>,
  headers: Record<string, string>,
  opts: { era?: 'legacy' | 'modern'; remoteAddress?: string } = {},
) {
  let id = 0;
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const modern = opts.era === 'modern';
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-06-18',
        ...(modern ? { 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) } : {}),
        ...headers,
      },
      payload: { jsonrpc: '2.0', id: ++id, method, params: modern ? { ...params, _meta: MODERN_META } : params },
    });
    let message: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null = null;
    if (res.statusCode === 200) {
      const type = String(res.headers['content-type'] ?? '');
      const raw = type.includes('text/event-stream')
        ? res.body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length)
        : res.body;
      message = JSON.parse(raw);
    }
    return { res, message };
  };
  return {
    send,
    async tools(): Promise<string[]> {
      const { message } = await send('tools/list');
      return (message!.result!.tools as { name: string }[]).map((t) => t.name);
    },
    /** A tool's answer: the JSON its one text block holds, and whether it is an error. */
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; value: any }> {
      const { res, message } = await send('tools/call', { name, arguments: args });
      if (!message?.result) throw new Error(`tools/call ${name}: HTTP ${res.statusCode} ${res.body}`);
      const content = message.result.content as { type: string; text: string }[];
      let value: unknown = content[0]!.text;
      try {
        value = JSON.parse(content[0]!.text);
      } catch {
        // The SDK's own refusals (bad arguments) are plain text.
      }
      return { isError: message.result.isError === true, value };
    },
  };
}
