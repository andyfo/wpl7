// @docs get-started/how-it-works, reference/architecture, security/overview
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import type { Duplex, Readable } from 'node:stream';
import Docker from 'dockerode';
import { collectDemuxed, demuxBuffer, demuxToStreams } from '../lib/demux.js';
import { badGateway, timedOut } from '../lib/errors.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SiteContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  binds: string[];
  /**
   * Networks to attach, in order. The first is set at creation time (Docker only accepts
   * one there); the rest are connected before the container is started. A site's list is
   * its own `wpl7_site_<slug>` plus the shared egress network — never another site's.
   */
  networks: string[];
  memoryBytes?: number;
  /** CPU ceiling in nanocpus (1e9 = one core). Undefined = uncapped. */
  nanoCpus?: number;
  /** Process/thread ceiling. Undefined = uncapped. */
  pidsLimit?: number;
}

/**
 * A long-running container the panel owns outright, rather than one per site: the FTP
 * gateway and each site's FTP file server (services/ftp.ts). Everything that decides how it
 * runs is in here, because `ensureServiceContainer` recreates it whenever any of it changes.
 */
export interface ServiceContainerSpec {
  name: string;
  image: string;
  cmd: string[];
  /** uid:gid. These never run as root. */
  user: string;
  env?: Record<string, string>;
  labels: Record<string, string>;
  /** `src:dst` / `src:dst:ro`, created as Mounts (see bindToMount). */
  binds: string[];
  /** Mount point -> tmpfs options (`size=16m,uid=33,…`); the writable scratch of a read-only root. */
  tmpfs?: Record<string, string>;
  readOnlyRootfs: boolean;
  /** Attached in order; the first one at creation (it also carries the published ports). */
  networks: string[];
  /** TCP, one entry per port - the Engine API has no ranges. */
  ports?: { hostIp: string; hostPort: number; containerPort: number }[];
  memoryBytes: number;
  nanoCpus?: number;
  pidsLimit?: number;
  /**
   * Whatever else the container depends on that the daemon cannot see - the contents of the
   * config files it reads at start, the identity of a folder it mounts. Part of the change
   * label, so a change to any of it recreates the container.
   */
  inputs?: string;
}

/** What `ensureServiceContainer` had to do. */
export type ServiceOutcome = 'created' | 'recreated' | 'started' | 'unchanged';

export interface ServiceState {
  state: ContainerState;
  /** Docker is between two attempts of its restart policy: the process keeps dying. */
  restarting: boolean;
  /** How often Docker's restart policy has restarted it since it was created. */
  restartCount: number;
  /** Unix ms of the current run's start; null when it is not running. */
  startedAt: number | null;
}

/** The label holding a service container's spec hash. */
export const SPEC_LABEL = 'wpl7.spec';

/**
 * A stable digest of a service spec. JSON with the keys sorted, so the same spec always hashes
 * the same whatever order its object literal was written in.
 */
export function serviceSpecHash(spec: ServiceContainerSpec): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(spec))).digest('hex').slice(0, 32);
}

export interface NetworkSpec {
  name: string;
  /** No route off the host: members reach each other and nothing else. */
  internal?: boolean;
  /** Driver options, e.g. `com.docker.network.bridge.enable_icc`. */
  options?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface ConnectOpts {
  /** Extra DNS names this container answers to on the network (compose `aliases:`). */
  aliases?: string[];
}

export interface EnsureNetworkResult {
  outcome: 'created' | 'existing' | 'recreated';
  /** Members disconnected to allow a recreate; empty otherwise. */
  detached: string[];
}

export interface NetworkInfo {
  name: string;
  internal: boolean;
  options: Record<string, string>;
  /** Container names currently attached. */
  containers: string[];
}

/**
 * Capabilities a WordPress container never needs, dropped from Docker's default set.
 * NET_RAW is the one that matters most: with it, root in a compromised site container can
 * forge packets and poison ARP caches of everything on its bridges - which is how one
 * infected site reaches the panel's database traffic. The rest are simply unused surface.
 * What stays is what `wordpress:apache` genuinely uses: NET_BIND_SERVICE (:80),
 * SETUID/SETGID (master drops to www-data), CHOWN/FOWNER/DAC_OVERRIDE (entrypoint fixes
 * ownership), FSETID and KILL (graceful restarts).
 */
export const SITE_CAP_DROP = ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'AUDIT_WRITE', 'SETFCAP', 'SETPCAP'];

/**
 * Blocks the setuid path out of the container: `wordpress:apache` is Debian and ships su,
 * mount, passwd and friends, so a www-data shell from a plugin exploit otherwise has a
 * local-privilege-escalation surface to chew on. Nothing the panel runs needs it - wp-cli
 * gets its uid from `docker exec -u 33:33`, which the daemon applies, not from setuid.
 */
export const SITE_SECURITY_OPT = ['no-new-privileges:true'];

export interface ExecOpts {
  user?: string;
  env?: string[];
  workdir?: string;
  timeoutMs?: number;
  /**
   * Stop reading when this fires (a download whose browser went away, a request whose client
   * hung up), and reject. The command itself runs on until it finishes or hits its deadline -
   * Docker has no way to kill an exec - but its output is discarded instead of backing up, and
   * the connection (on a remote server, an SSH channel) is free again at once.
   */
  signal?: AbortSignal;
  /** exec/execWithInput: per-stream output cap in bytes (default 1 MiB, see lib/demux.ts). */
  outputCap?: number;
  /**
   * exec/execWithInput: each complete line of output (stdout and stderr alike) as it arrives,
   * while the command is still running - how a queued command's job log fills in live. It sees
   * every line, those past `outputCap` included: the cap bounds what is kept, not what is seen.
   */
  onOutput?: (line: string) => void;
}

export interface EphemeralOpts {
  image: string;
  cmd: string[];
  /**
   * Replaces the image's ENTRYPOINT. The rclone image runs `rclone` directly, and a couple
   * of shell statements have to run before it (obscuring a password, writing known_hosts),
   * so its offsite runs come in through `/bin/sh` instead.
   */
  entrypoint?: string[];
  name?: string;
  env?: string[];
  binds?: string[];
  networks?: string[];
  labels?: Record<string, string>;
  user?: string;
  timeoutMs?: number;
  /**
   * Called with each complete output line while the container runs. A twelve-hour rclone
   * upload that only reports when it finishes is indistinguishable from a hung one, so its
   * progress lines go into the job log as they arrive.
   */
  onOutput?: (line: string) => void;
  /**
   * Bytes kept of stdout, and of stderr; past that the output is cut and ends in
   * "…[output truncated]" (lib/demux.ts). 1 MiB when not given.
   */
  outputCap?: number;
  /**
   * For a run over a site's own files, which are not to be trusted: see EphemeralLockdown.
   * `networks` is ignored - a locked-down run has none.
   */
  lockdown?: EphemeralLockdown;
}

/**
 * Everything a run over a site's files must not have (services/scanEngines.ts): any
 * network, any capability, a way to gain privileges, a writable root. What it writes goes to
 * tmpfs, and memory (swap included), CPU and processes are capped. Its binds become Mounts,
 * so a missing source is an error instead of an empty folder Docker creates on the host.
 */
export interface EphemeralLockdown {
  memoryBytes: number;
  /** Nanocpus; 1e9 = one core. */
  nanoCpus: number;
  pidsLimit: number;
  /** Scratch space: path in the container -> size in MiB. Counts against `memoryBytes`. */
  tmpfs: Record<string, number>;
}

/**
 * `created` = the container exists but has never run: it was built and not started, or its
 * start FAILED. Kept distinct from `exited` because only `exited` means "was running and
 * was stopped" - the one state a repair job must preserve. Collapsing the two made a site
 * whose start had failed look deliberately stopped, so the repair recreated it correctly
 * and then left it down (404 behind Traefik).
 */
export type ContainerState = 'running' | 'created' | 'exited' | 'missing';

/** A site container's CPU, memory and process ceilings. CPU and pids left out = uncapped. */
export interface ContainerLimits {
  memoryBytes: number;
  /** Nanocpus; 1e9 = one core. */
  nanoCpus?: number;
  pidsLimit?: number;
}

export interface ContainerConfig {
  /** `Config.Cmd`: what compose's `command:` became. */
  cmd: string[];
  /** Variables with a non-empty value. */
  envSet: string[];
}

/**
 * A single read of a container's cumulative resource counters.
 *
 * Deliberately NOT a CPU percentage. Docker derives its own percentage from two samples
 * roughly a second apart, which measures whatever ran inside that one second rather than
 * the container's actual load - and the panel's ticks are periodic, so the window landed
 * on the panel's own uptime probe every single time and on its wp-cron run every fifth.
 * An idle site read ~30% instead of its true ~0.3%. `MonitorService` differences this
 * counter against its own previous read instead, which averages over the whole interval.
 */
export interface ContainerSample {
  /** Cumulative CPU time the container has used, in nanoseconds. Resets when it restarts. */
  cpuNs: number | null;
  memBytes: number | null;
}

export interface ContainerLogsOpts {
  /** Unix seconds; only lines logged at or after this point are returned. */
  sinceSec?: number;
  /** Cap on the number of lines read back, newest first. */
  tail?: number;
}

/** Narrow surface consumed by job handlers and services; faked in tests. */
export interface DockerPort {
  createSiteContainer(spec: SiteContainerSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string): Promise<void>;
  restartContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
  containerState(name: string): Promise<ContainerState>;
  /** The image reference a container was created from; null when it does not exist. */
  containerImage(name: string): Promise<string | null>;
  /** The ceilings a container runs under now; null when it does not exist. */
  containerLimits(name: string): Promise<ContainerLimits | null>;
  /**
   * How a container was started: its command, and the names of the environment variables it
   * has a value for - never the values, which is where a compose file puts its credentials.
   * Null when it does not exist.
   */
  containerConfig(name: string): Promise<ContainerConfig | null>;
  /**
   * Change a container's ceilings in place, running or stopped, without restarting it. It
   * cannot lift a CPU cap (see limitsChange) - a container that has to lose one is rebuilt.
   */
  updateContainerLimits(name: string, limits: ContainerLimits): Promise<void>;
  /** Combined stdout+stderr of a container's log, already demultiplexed. */
  containerLogs(name: string, opts?: ContainerLogsOpts): Promise<string>;
  exec(name: string, cmd: string[], opts?: ExecOpts): Promise<RunResult>;
  /** `exec` with `input` as the command's stdin, followed by end-of-file. */
  execWithInput(name: string, cmd: string[], input: Buffer, opts?: ExecOpts): Promise<RunResult>;
  execToStream(name: string, cmd: string[], stdout: Writable, opts?: ExecOpts): Promise<{ exitCode: number; stderr: string }>;
  runEphemeral(opts: EphemeralOpts): Promise<RunResult>;
  imageExists(tag: string): Promise<boolean>;
  /** Builds from every file in `contextDir` (a flat folder), on this server's daemon. */
  buildImage(tag: string, contextDir: string, buildArgs: Record<string, string>, onProgress?: (line: string) => void): Promise<void>;
  pullImage(tag: string, onProgress?: (line: string) => void): Promise<void>;
  /** Give an image a second name, `repo:tag`. */
  tagImage(source: string, target: string): Promise<void>;
  /** Untag, and remove if nothing else uses it. An image that does not exist is not an error. */
  removeImage(ref: string): Promise<void>;
  /** Remove untagged images carrying all these labels (`key=value`): what a build left behind. */
  pruneImages(labels: string[]): Promise<void>;
  /** One read of the container's cumulative CPU/memory counters (see ContainerSample). */
  sampleStats(name: string): Promise<ContainerSample>;
  listManaged(labelFilters: string[]): Promise<{ name: string; labels: Record<string, string>; state: string }[]>;
  /**
   * Create the network if absent; recreate it if it exists with different isolation. On a
   * recreate, `detached` names the containers that had to be disconnected first - the caller
   * owns putting back the ones it cares about (with their aliases).
   */
  ensureNetwork(spec: NetworkSpec): Promise<EnsureNetworkResult>;
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  removeNetwork(name: string): Promise<void>;
  listNetworkNames(labelFilters?: string[]): Promise<string[]>;
  /** Networks a container is currently attached to; [] when the container does not exist. */
  containerNetworks(name: string): Promise<string[]>;
  connectContainer(network: string, container: string, opts?: ConnectOpts): Promise<void>;
  disconnectContainer(network: string, container: string): Promise<void>;
  /**
   * Make a service container match its spec: create it when missing, replace it when the spec
   * changed (its `wpl7.spec` label), start it when it is stopped. Idempotent - the FTP
   * reconciler calls it every tick.
   */
  ensureServiceContainer(spec: ServiceContainerSpec): Promise<ServiceOutcome>;
  /** Send a signal to the container's main process; false when it is missing or not running. */
  signalContainer(name: string, signal: 'SIGHUP' | 'SIGUSR1'): Promise<boolean>;
  serviceState(name: string): Promise<ServiceState>;
}

/**
 * `src:dst` / `src:dst:ro` -> one entry for HostConfig.Mounts.
 *
 * Mounts, not Binds, on purpose. Binds is the `-v` form: a missing source is not an error,
 * Docker CREATES it - always as a directory - and the container only fails afterwards, when
 * runc tries to lay that directory over a file the image has at the target. The directory it
 * made stays behind, so every later attempt fails identically, including a rollback to a
 * previously working container. Mounts is the `--mount` form: it refuses at CREATE time with
 * "bind source path does not exist" and touches nothing on the host.
 *
 * Measured on Docker 29.8.1: `-v` create exit 0, start fails, source left behind as a
 * directory; `--mount` create exit 1, nothing created. moby/moby#47616 asked for the choice
 * to be configurable on `-v` and was closed as not planned, so this is the only way to get
 * the safe behaviour.
 *
 * Every source here is panel-managed and made to exist before the create (see
 * ensureSiteMountSources, and the boot-time mkdirp of the shared plugin directory), so
 * failing loudly on a missing one reports a real problem rather than inventing an empty
 * directory to hide it.
 */
export function bindToMount(bind: string): Docker.MountSettings {
  const parts = bind.split(':');
  const [source, target, options] = parts;
  if (parts.length < 2 || parts.length > 3 || !source || !target) {
    throw new Error(`Unparseable bind mount "${bind}"`);
  }
  if (options !== undefined && options !== 'ro') {
    throw new Error(`Unsupported bind mount option "${options}" in "${bind}" (only "ro" is handled)`);
  }
  return { Type: 'bind', Source: source, Target: target, ReadOnly: options === 'ro' };
}

const isStatusError = (err: unknown, code: number): boolean =>
  typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === code;

/**
 * A site's memory ceiling, with swap at twice it. Sent together on every change, not just at
 * create: Docker refuses to raise the memory limit past the swap limit already set unless
 * both move in the same request.
 */
const siteMemory = (memoryBytes: number) => ({ Memory: memoryBytes, MemorySwap: memoryBytes * 2 });

/** Seconds GNU `timeout` waits after SIGTERM before it sends SIGKILL. */
const KILL_AFTER_SEC = 5;
/** Client-side slack on top of the in-container deadline: time for `timeout` to kill and the stream to close. */
const CLIENT_GRACE_MS = 10_000;
/** How long to wait for a timed-out process to be confirmed gone before reporting it as still running. */
const EXIT_CONFIRM_MS = 15_000;
/**
 * How long a finished command's exec may still read as running: the output ends as the process
 * does, and Docker records the exit a moment later.
 */
const EXIT_SETTLE_MS = 3_000;
/** 124 = `timeout` expired; 128+ = killed by a signal (137 when it had to SIGKILL). */
const timedOutExit = (exitCode: number, elapsedMs: number, timeoutMs: number): boolean =>
  exitCode === 124 || (exitCode >= 128 && elapsedMs >= timeoutMs);

/**
 * Enforce the deadline INSIDE the container. Destroying the attached stream when the
 * client-side timer fired never stopped the process itself: a timed-out `wp search-replace`
 * or `wp core update` kept rewriting tables/files after its job had already failed, and the
 * next mutation for that site overlapped it. Both the site image (Debian) and the MariaDB
 * image ship coreutils, so `timeout` is always available.
 */
export function withDeadline(cmd: string[], timeoutMs: number): string[] {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  return ['timeout', '-k', String(KILL_AFTER_SEC), String(sec), ...cmd];
}

const isTimeoutError = (err: unknown): boolean => err instanceof Error && /timed out/i.test(err.message);

/**
 * Hang up on a command whose caller went away: with the connection closed, Docker drops its
 * output instead of holding it, and a remote server's SSH channel is free again at once. The
 * command itself runs on to its deadline. Returns what stops listening.
 */
function hangUpOnAbort(stream: unknown, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  const hangUp = () => (stream as { destroy?: () => void }).destroy?.();
  if (signal.aborted) {
    hangUp();
    return () => undefined;
  }
  signal.addEventListener('abort', hangUp, { once: true });
  return () => signal.removeEventListener('abort', hangUp);
}

const abandoned = (cmd: string[]) =>
  new Error(`${cmd[0] ?? 'command'} was abandoned: its caller went away (it runs on to its deadline)`);

export class DockerService implements DockerPort {
  private readonly docker: Docker;

  private readonly exitSettleMs: number;
  private readonly exitPollMs: number;

  constructor(
    private readonly proxyNetwork: string,
    private readonly dbNetwork: string,
    docker?: Docker,
    /** How long, and how often, to ask for an exit code the output has already announced. */
    opts: { exitSettleMs?: number; exitPollMs?: number } = {},
  ) {
    this.docker = docker ?? new Docker({ socketPath: '/var/run/docker.sock' });
    this.exitSettleMs = opts.exitSettleMs ?? EXIT_SETTLE_MS;
    this.exitPollMs = opts.exitPollMs ?? 100;
  }

  async createSiteContainer(spec: SiteContainerSpec): Promise<void> {
    const networks = spec.networks.length > 0 ? spec.networks : [this.proxyNetwork, this.dbNetwork];
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      HostConfig: {
        Mounts: spec.binds.map(bindToMount),
        RestartPolicy: { Name: 'unless-stopped' },
        ...siteMemory(spec.memoryBytes ?? 512 * 1024 * 1024),
        // A miner in one site otherwise takes every core on the box, which is felt by every
        // other site on it. PidsLimit is the fork-bomb equivalent.
        ...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
        ...(spec.pidsLimit ? { PidsLimit: spec.pidsLimit } : {}),
        CapDrop: SITE_CAP_DROP,
        SecurityOpt: SITE_SECURITY_OPT,
      },
      NetworkingConfig: {
        EndpointsConfig: { [networks[0]!]: {} },
      },
    });
    // Docker accepts one network at creation time; the rest connect before start.
    for (const net of networks.slice(1)) {
      await this.docker.getNetwork(net).connect({ Container: container.id });
    }
  }

  async startContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).start();
    } catch (err) {
      if (isStatusError(err, 304)) return; // already running
      throw err;
    }
  }

  async stopContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).stop({ t: 20 });
    } catch (err) {
      if (isStatusError(err, 304) || isStatusError(err, 404)) return; // already stopped / gone
      throw err;
    }
  }

  async restartContainer(name: string): Promise<void> {
    await this.docker.getContainer(name).restart({ t: 20 });
  }

  async removeContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (err) {
      if (isStatusError(err, 404)) return;
      throw err;
    }
  }

  async containerState(name: string): Promise<ContainerState> {
    try {
      const info = await this.docker.getContainer(name).inspect();
      if (info.State.Running) return 'running';
      return info.State.Status === 'created' ? 'created' : 'exited';
    } catch (err) {
      if (isStatusError(err, 404)) return 'missing';
      throw err;
    }
  }

  async containerImage(name: string): Promise<string | null> {
    try {
      const info = (await this.docker.getContainer(name).inspect()) as { Config?: { Image?: string } };
      return info.Config?.Image ?? null;
    } catch (err) {
      if (isStatusError(err, 404)) return null;
      throw err;
    }
  }

  async containerConfig(name: string): Promise<ContainerConfig | null> {
    try {
      const info = (await this.docker.getContainer(name).inspect()) as { Config?: { Cmd?: string[] | null; Env?: string[] | null } };
      const envSet = (info.Config?.Env ?? [])
        .map((entry) => /^([^=]+)=(.+)$/s.exec(entry)?.[1])
        .filter((key): key is string => key !== undefined);
      return { cmd: info.Config?.Cmd ?? [], envSet };
    } catch (err) {
      if (isStatusError(err, 404)) return null;
      throw err;
    }
  }

  async containerLimits(name: string): Promise<ContainerLimits | null> {
    try {
      const info = (await this.docker.getContainer(name).inspect()) as {
        HostConfig?: { Memory?: number; NanoCpus?: number; PidsLimit?: number | null };
      };
      const host = info.HostConfig ?? {};
      return {
        memoryBytes: host.Memory ?? 0,
        // No cap reads back as 0 or null - and as -1 for pids, from older daemons.
        ...(host.NanoCpus ? { nanoCpus: host.NanoCpus } : {}),
        ...(host.PidsLimit && host.PidsLimit > 0 ? { pidsLimit: host.PidsLimit } : {}),
      };
    } catch (err) {
      if (isStatusError(err, 404)) return null;
      throw err;
    }
  }

  async updateContainerLimits(name: string, limits: ContainerLimits): Promise<void> {
    await this.docker.getContainer(name).update({
      ...siteMemory(limits.memoryBytes),
      // To this endpoint a CPU limit of 0 means "leave it as it is", so it is only sent to set one.
      ...(limits.nanoCpus ? { NanoCpus: limits.nanoCpus } : {}),
      // Whereas a pids limit of 0 does mean "none", which is how a process cap comes off.
      PidsLimit: limits.pidsLimit ?? 0,
    });
  }

  /**
   * Read a container's log. `since` has one-second resolution, so callers that poll must
   * tolerate seeing the boundary second twice — the mail ingester dedupes on queue id.
   * A missing container reads as an empty log rather than an error: the mail relay is
   * optional, and a server without one should not fail the tick.
   */
  async containerLogs(name: string, opts: ContainerLogsOpts = {}): Promise<string> {
    try {
      const raw = (await this.docker.getContainer(name).logs({
        stdout: true,
        stderr: true,
        follow: false,
        ...(opts.sinceSec !== undefined ? { since: opts.sinceSec } : {}),
        ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
      })) as unknown as Buffer | string;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      const { stdout, stderr } = demuxBuffer(buf);
      return stdout + stderr;
    } catch (err) {
      if (isStatusError(err, 404)) return '';
      throw err;
    }
  }

  async exec(name: string, cmd: string[], opts: ExecOpts = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    opts.signal?.throwIfAborted();
    const container = this.docker.getContainer(name);
    const exec = await container.exec({
      Cmd: withDeadline(cmd, timeoutMs),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user,
      Env: opts.env,
      WorkingDir: opts.workdir,
    });
    const startedAt = Date.now();
    const stream = await exec.start({ hijack: true, stdin: false });
    const detach = hangUpOnAbort(stream, opts.signal);
    let output: { stdout: string; stderr: string };
    try {
      output = await collectDemuxed(this.docker.modem, stream, {
        timeoutMs: timeoutMs + CLIENT_GRACE_MS,
        cap: opts.outputCap,
        onOutput: opts.onOutput,
      });
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      throw await this.timeoutError(exec, cmd, timeoutMs);
    } finally {
      detach();
    }
    if (opts.signal?.aborted) throw abandoned(cmd);
    const exitCode = await this.exitCodeOf(exec, cmd, timeoutMs, startedAt);
    return { ...output, exitCode };
  }

  /**
   * Run a command with `input` as its stdin: the bytes, then end-of-file.
   *
   * The upgraded connection is written to and then half-closed; Docker runs every exec with
   * CloseStdin, so that half-close is what the command reads as EOF (`cat` finishing). The
   * output keeps flowing back over the other half. This holds on the local socket and over
   * both SSH transports (streamlocal forwarding and `docker system dial-stdio`), whose
   * channels are half-open by default.
   *
   * The whole input is a Buffer on purpose: callers read a request body completely before
   * they start anything, so a slow or abandoned client never holds an exec (and, on a
   * remote server, one of its SSH channels) open.
   */
  async execWithInput(name: string, cmd: string[], input: Buffer, opts: ExecOpts = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    opts.signal?.throwIfAborted();
    const container = this.docker.getContainer(name);
    const exec = await container.exec({
      Cmd: withDeadline(cmd, timeoutMs),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user,
      Env: opts.env,
      WorkingDir: opts.workdir,
    });
    const startedAt = Date.now();
    const sock = (await exec.start({ hijack: true, stdin: true })) as unknown as Duplex;
    // A command that exits without reading all of its input (a failed precondition) closes
    // the connection under our write. Unheard, that EPIPE is an uncaught 'error' - which
    // takes the whole panel down.
    sock.on('error', () => undefined);
    // Listen before writing: a short command can answer and hang up before end() returns.
    const output = collectDemuxed(this.docker.modem, sock, {
      timeoutMs: timeoutMs + CLIENT_GRACE_MS,
      cap: opts.outputCap,
      onOutput: opts.onOutput,
      tolerateErrors: true,
    });
    output.catch(() => undefined);
    const detach = hangUpOnAbort(sock, opts.signal);
    sock.end(input);
    let result: { stdout: string; stderr: string };
    try {
      result = await output;
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      throw await this.timeoutError(exec, cmd, timeoutMs);
    } finally {
      detach();
    }
    if (opts.signal?.aborted) throw abandoned(cmd);
    const exitCode = await this.exitCodeOf(exec, cmd, timeoutMs, startedAt);
    return { ...result, exitCode };
  }

  /**
   * Exit code of a finished exec; a `timeout`-style exit at/after the deadline is reported
   * as an error rather than a plain non-zero status, so callers never mistake "killed
   * half-way" for "ran and failed".
   */
  private async exitCodeOf(exec: Docker.Exec, cmd: string[], timeoutMs: number, startedAt: number): Promise<number> {
    let inspect = await exec.inspect();
    const settleBy = Date.now() + this.exitSettleMs;
    while (inspect.Running && Date.now() < settleBy) {
      await new Promise((r) => setTimeout(r, this.exitPollMs));
      inspect = await exec.inspect();
    }
    // Still running once its output has ended: the connection dropped (an SSH hop reset), not the
    // command. An exit code guessed now would report a command as failed that may yet succeed -
    // and a caller who believed it would run it a second time.
    if (inspect.Running) {
      throw badGateway(
        `Lost the connection to ${cmd[0] ?? 'the command'} while it was still running inside the container - ` +
          'it may yet finish, so do not run it again until it has',
      );
    }
    const exitCode = inspect.ExitCode ?? 1;
    if (timedOutExit(exitCode, Date.now() - startedAt, timeoutMs)) {
      throw timedOut(`${cmd[0] ?? 'command'} timed out after ${timeoutMs}ms and was killed inside the container`);
    }
    return exitCode;
  }

  /**
   * The client stopped waiting; before reporting, confirm the process is actually gone
   * (the in-container `timeout` kills it). The message says so explicitly when it is not,
   * because transport loss is not proof that the command finished.
   */
  private async timeoutError(exec: Docker.Exec, cmd: string[], timeoutMs: number): Promise<Error> {
    const deadline = Date.now() + EXIT_CONFIRM_MS;
    let running = true;
    while (Date.now() < deadline) {
      const info = await exec.inspect().catch(() => null);
      if (!info || !info.Running) {
        running = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const what = `${cmd[0] ?? 'command'} timed out after ${timeoutMs}ms`;
    return timedOut(
      running
        ? `${what} and is STILL RUNNING inside the container - do not retry until it has exited`
        : `${what} (process terminated)`,
    );
  }

  async execToStream(
    name: string,
    cmd: string[],
    stdoutDest: Writable,
    opts: ExecOpts = {},
  ): Promise<{ exitCode: number; stderr: string }> {
    const timeoutMs = opts.timeoutMs ?? 60 * 60_000;
    opts.signal?.throwIfAborted();
    const container = this.docker.getContainer(name);
    const exec = await container.exec({
      Cmd: withDeadline(cmd, timeoutMs),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user,
      Env: opts.env,
      WorkingDir: opts.workdir,
    });
    const startedAt = Date.now();
    const stream = await exec.start({ hijack: true, stdin: false });
    // Hanging up is how a reader that is gone gets out of the way: with the connection
    // closed Docker drops the command's output instead of letting it back up, and on a
    // remote server the SSH channel is free again at once rather than at the deadline.
    const hangUp = () => (stream as { destroy?: () => void }).destroy?.();

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const stderrSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (stderrSize < 64 * 1024) {
          stderrChunks.push(chunk);
          stderrSize += chunk.length;
        }
        cb();
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        hangUp();
        reject(new Error(`exec stream timed out after ${timeoutMs}ms`));
      }, timeoutMs + CLIENT_GRACE_MS);
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!opts.signal) return;
      onAbort = () => {
        hangUp();
        reject(new Error('reading the command output was abandoned'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      // Backpressure-aware demux: the container stream is paused while the destination
      // (gzip -> disk for a dump) is full, instead of buffering the whole output in memory.
      await Promise.race([demuxToStreams(stream as unknown as Readable, stdoutDest, stderrSink), timeout, aborted]);
    } catch (err) {
      hangUp();
      if (!isTimeoutError(err)) throw err;
      throw await this.timeoutError(exec, cmd, timeoutMs);
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await this.exitCodeOf(exec, cmd, timeoutMs, startedAt);
    return { exitCode, stderr: Buffer.concat(stderrChunks).toString('utf8') };
  }

  async runEphemeral(opts: EphemeralOpts): Promise<RunResult> {
    const lock = opts.lockdown;
    const networks = lock ? [] : (opts.networks ?? [this.proxyNetwork, this.dbNetwork]);
    const container = await this.docker.createContainer({
      name: opts.name,
      Image: opts.image,
      Cmd: opts.cmd,
      ...(opts.entrypoint ? { Entrypoint: opts.entrypoint } : {}),
      Env: opts.env,
      User: opts.user,
      Labels: { 'wpl7.managed': 'true', 'wpl7.role': 'ephemeral', ...opts.labels },
      HostConfig: lock
        ? {
            Mounts: (opts.binds ?? []).map(bindToMount),
            NetworkMode: 'none',
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            ReadonlyRootfs: true,
            Tmpfs: Object.fromEntries(
              Object.entries(lock.tmpfs).map(([dir, mb]) => [dir, `rw,noexec,nosuid,nodev,size=${mb}m`]),
            ),
            Memory: lock.memoryBytes,
            MemorySwap: lock.memoryBytes,
            NanoCpus: lock.nanoCpus,
            PidsLimit: lock.pidsLimit,
          }
        : { Binds: opts.binds },
      NetworkingConfig: networks[0] ? { EndpointsConfig: { [networks[0]]: {} } } : undefined,
    });
    try {
      for (const net of networks.slice(1)) {
        await this.docker.getNetwork(net).connect({ Container: container.id });
      }
      // Attach before start so no output is missed.
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      await container.start();

      const timeoutMs = opts.timeoutMs ?? 300_000;
      const output = collectDemuxed(this.docker.modem, stream, {
        timeoutMs: timeoutMs + 5_000,
        cap: opts.outputCap,
        onOutput: opts.onOutput,
      });
      // If the wait race below rejects first, `await output` is never reached; without a
      // handler attached now, its later rejection is an unhandled rejection and Node
      // kills the panel. Attaching one does not change what `await output` observes.
      output.catch(() => undefined);
      // Cleared once the race is over: a scan's half-hour timer left running kept every one
      // of its containers' objects alive for the full half hour after it had finished.
      let timer: NodeJS.Timeout | undefined;
      const waitResult = (await Promise.race([
        container.wait(),
        new Promise((_r, reject) => {
          timer = setTimeout(() => reject(new Error(`Container timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer))) as { StatusCode: number };
      const { stdout, stderr } = await output;
      return { stdout, stderr, exitCode: waitResult.StatusCode };
    } finally {
      // `v`: with its anonymous volumes. An image that declares a VOLUME (the WordPress one
      // does, /var/www/html) would otherwise leave one behind on every run.
      await container.remove({ force: true, v: true }).catch(() => undefined);
    }
  }

  async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch (err) {
      if (isStatusError(err, 404)) return false;
      throw err;
    }
  }

  async buildImage(
    tag: string,
    contextDir: string,
    buildArgs: Record<string, string>,
    onProgress?: (line: string) => void,
  ): Promise<void> {
    // dockerode sends only the files it is given: every file of the context, which is a flat
    // folder (deploy/wordpress-image, deploy/sftpgo-image).
    const src = fs
      .readdirSync(contextDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    // forcerm: the container of a step that FAILS is otherwise left behind, stopped - and it
    // holds on to the image it ran in, so nothing of a failed build could be pruned.
    const stream = await this.docker.buildImage(
      { context: contextDir, src },
      { t: tag, buildargs: buildArgs, rm: true, forcerm: true },
    );
    await this.followProgress(stream, onProgress);
  }

  async tagImage(source: string, target: string): Promise<void> {
    // A colon after the last slash starts the tag; one before it is a registry's port.
    const colon = target.lastIndexOf(':');
    const [repo, tag] = colon > target.lastIndexOf('/') ? [target.slice(0, colon), target.slice(colon + 1)] : [target, 'latest'];
    await this.docker.getImage(source).tag({ repo, tag });
  }

  async removeImage(ref: string): Promise<void> {
    try {
      await this.docker.getImage(ref).remove();
    } catch (err) {
      if (!isStatusError(err, 404)) throw err;
    }
  }

  async pruneImages(labels: string[]): Promise<void> {
    await this.docker.pruneImages({ filters: { dangling: ['true'], label: labels } });
  }

  async pullImage(tag: string, onProgress?: (line: string) => void): Promise<void> {
    const stream = await this.docker.pull(tag);
    await this.followProgress(stream, onProgress);
  }

  private followProgress(stream: NodeJS.ReadableStream, onProgress?: (line: string) => void): Promise<void> {
    let lastEmit = 0;
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, output: { error?: string; errorDetail?: { message?: string } }[]) => {
          if (err) return reject(err);
          const failed = output?.find((o) => o.error);
          if (failed) return reject(new Error(failed.errorDetail?.message ?? failed.error));
          resolve();
        },
        (event: { stream?: string; status?: string; progress?: string; error?: string }) => {
          if (!onProgress) return;
          const now = Date.now();
          if (now - lastEmit < 5000 && !event.error) return; // throttle to ~1 line / 5s
          const line = event.error ?? event.stream?.trim() ?? [event.status, event.progress].filter(Boolean).join(' ');
          if (line) {
            lastEmit = now;
            onProgress(line);
          }
        },
      );
    });
  }

  async sampleStats(name: string): Promise<ContainerSample> {
    try {
      // one-shot: return the counters as they stand instead of collecting two cycles a
      // second apart. The percentage that pairing produces is not used (see
      // ContainerSample), and waiting for it made every stats tick take a second per site.
      const stats = (await this.docker.getContainer(name).stats({ stream: false, 'one-shot': true })) as {
        cpu_stats?: { cpu_usage?: { total_usage?: number } };
        memory_stats?: { usage?: number; stats?: { inactive_file?: number } };
      };
      const cpuNs = stats.cpu_stats?.cpu_usage?.total_usage;
      const usage = stats.memory_stats?.usage;
      return {
        cpuNs: typeof cpuNs === 'number' ? cpuNs : null,
        memBytes: usage !== undefined ? usage - (stats.memory_stats?.stats?.inactive_file ?? 0) : null,
      };
    } catch {
      return { cpuNs: null, memBytes: null };
    }
  }

  async ensureServiceContainer(spec: ServiceContainerSpec): Promise<ServiceOutcome> {
    const hash = serviceSpecHash(spec);
    let existing: Docker.ContainerInspectInfo | null = null;
    try {
      existing = await this.docker.getContainer(spec.name).inspect();
    } catch (err) {
      if (!isStatusError(err, 404)) throw err;
    }
    let outcome: ServiceOutcome;
    if (existing && existing.Config.Labels?.[SPEC_LABEL] === hash) {
      // Same spec. What can still drift without a recreate: the networks it is on (a network
      // removed and made again leaves it detached), and whether it runs at all.
      const attached = Object.keys(existing.NetworkSettings?.Networks ?? {});
      for (const net of spec.networks) {
        if (!attached.includes(net)) await this.connectContainer(net, spec.name);
      }
      for (const net of attached) {
        if (!spec.networks.includes(net)) await this.disconnectContainer(net, spec.name);
      }
      if (existing.State.Running) return 'unchanged';
      outcome = 'started';
    } else {
      if (existing) await this.removeContainer(spec.name);
      await this.createServiceContainer(spec, hash);
      outcome = existing ? 'recreated' : 'created';
    }
    await this.startContainer(spec.name);
    return outcome;
  }

  private async createServiceContainer(spec: ServiceContainerSpec, hash: string): Promise<void> {
    const ports = spec.ports ?? [];
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.cmd,
      User: spec.user,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: { 'wpl7.managed': 'true', ...spec.labels, [SPEC_LABEL]: hash },
      ExposedPorts: Object.fromEntries(ports.map((p) => [`${p.containerPort}/tcp`, {}])),
      HostConfig: {
        Mounts: spec.binds.map(bindToMount),
        Tmpfs: spec.tmpfs,
        ReadonlyRootfs: spec.readOnlyRootfs,
        PortBindings: Object.fromEntries(
          ports.map((p) => [`${p.containerPort}/tcp`, [{ HostIp: p.hostIp, HostPort: String(p.hostPort) }]]),
        ),
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: spec.memoryBytes,
        // Equal to Memory: no swap. A file server that swaps is slower than one that is
        // restarted, and the restart is what the status then reports.
        MemorySwap: spec.memoryBytes,
        ...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
        ...(spec.pidsLimit ? { PidsLimit: spec.pidsLimit } : {}),
        // Unlike a site container, nothing in here needs a single capability: it runs as an
        // unprivileged user, binds ports above 1024, and never changes an owner.
        CapDrop: ['ALL'],
        SecurityOpt: SITE_SECURITY_OPT,
      },
      NetworkingConfig: { EndpointsConfig: { [spec.networks[0]!]: {} } },
    });
    try {
      for (const net of spec.networks.slice(1)) {
        await this.docker.getNetwork(net).connect({ Container: container.id });
      }
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined);
      throw err;
    }
  }

  async signalContainer(name: string, signal: 'SIGHUP' | 'SIGUSR1'): Promise<boolean> {
    try {
      await this.docker.getContainer(name).kill({ signal });
      return true;
    } catch (err) {
      // 404 = gone, 409 = not running: nothing there to tell.
      if (isStatusError(err, 404) || isStatusError(err, 409)) return false;
      throw err;
    }
  }

  async serviceState(name: string): Promise<ServiceState> {
    try {
      const info = await this.docker.getContainer(name).inspect();
      const started = Date.parse(info.State.StartedAt);
      return {
        state: info.State.Running ? 'running' : info.State.Status === 'created' ? 'created' : 'exited',
        restarting: info.State.Restarting === true,
        restartCount: info.RestartCount ?? 0,
        startedAt: info.State.Running && Number.isFinite(started) ? started : null,
      };
    } catch (err) {
      if (isStatusError(err, 404)) return { state: 'missing', restarting: false, restartCount: 0, startedAt: null };
      throw err;
    }
  }

  async listManaged(labelFilters: string[]): Promise<{ name: string; labels: Record<string, string>; state: string }[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: labelFilters },
    });
    return containers.map((c) => ({
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      labels: c.Labels ?? {},
      state: c.State,
    }));
  }

  // --- networks -------------------------------------------------------------
  // Site isolation is expressed as network membership, so these are as much a part of a
  // site's identity as its container: `wpl7_site_<slug>` is the only place its container,
  // Traefik, the relay and MariaDB meet, and no other site is ever a member.

  async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    try {
      const info = (await this.docker.getNetwork(name).inspect()) as {
        Internal?: boolean;
        Options?: Record<string, string>;
        Containers?: Record<string, { Name?: string }>;
      };
      return {
        name,
        internal: info.Internal === true,
        options: info.Options ?? {},
        containers: Object.values(info.Containers ?? {})
          .map((c) => c.Name ?? '')
          .filter(Boolean),
      };
    } catch (err) {
      if (isStatusError(err, 404)) return null;
      throw err;
    }
  }

  async ensureNetwork(spec: NetworkSpec): Promise<EnsureNetworkResult> {
    const existing = await this.inspectNetwork(spec.name);
    if (existing) {
      const wantInternal = spec.internal === true;
      const optionsMatch = Object.entries(spec.options ?? {}).every(([k, v]) => existing.options[k] === v);
      if (existing.internal === wantInternal && optionsMatch) return { outcome: 'existing', detached: [] };
      // Isolation flags are fixed at creation time, so a network that predates a change in
      // policy has to be rebuilt rather than patched. Members are detached first: Docker
      // refuses to remove a network that still has endpoints, and a half-removed network
      // would leave the site unroutable.
      for (const container of existing.containers) {
        await this.disconnectContainer(spec.name, container);
      }
      await this.removeNetwork(spec.name);
      await this.createNetwork(spec);
      return { outcome: 'recreated', detached: existing.containers };
    }
    await this.createNetwork(spec);
    return { outcome: 'created', detached: [] };
  }

  private async createNetwork(spec: NetworkSpec): Promise<void> {
    try {
      await this.docker.createNetwork({
        Name: spec.name,
        Driver: 'bridge',
        Internal: spec.internal === true,
        CheckDuplicate: true,
        Options: spec.options,
        Labels: { 'wpl7.managed': 'true', ...spec.labels },
      });
    } catch (err) {
      // Another job created it between inspect and create.
      if (isStatusError(err, 409)) return;
      throw err;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch (err) {
      if (isStatusError(err, 404)) return;
      throw err;
    }
  }

  async listNetworkNames(labelFilters: string[] = []): Promise<string[]> {
    const nets = (await this.docker.listNetworks(
      labelFilters.length > 0 ? { filters: { label: labelFilters } } : {},
    )) as { Name?: string }[];
    return nets.map((n) => n.Name ?? '').filter(Boolean);
  }

  async containerNetworks(name: string): Promise<string[]> {
    try {
      const info = (await this.docker.getContainer(name).inspect()) as {
        NetworkSettings?: { Networks?: Record<string, unknown> };
      };
      return Object.keys(info.NetworkSettings?.Networks ?? {});
    } catch (err) {
      if (isStatusError(err, 404)) return [];
      throw err;
    }
  }

  async connectContainer(network: string, container: string, opts: ConnectOpts = {}): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({
        Container: container,
        ...(opts.aliases?.length ? { EndpointConfig: { Aliases: opts.aliases } } : {}),
      });
    } catch (err) {
      // 403 = already a member. Idempotent so callers can reconcile blindly.
      if (isStatusError(err, 403)) return;
      throw err;
    }
  }

  async disconnectContainer(network: string, container: string): Promise<void> {
    try {
      await this.docker.getNetwork(network).disconnect({ Container: container, Force: true });
    } catch (err) {
      if (isStatusError(err, 404) || isStatusError(err, 403)) return;
      throw err;
    }
  }
}
