// @docs servers/overview
import type { ServerSystemInfoDto } from '../../shared/types.js';
import type { ExecPort } from '../lib/exec.js';
import { notFound } from '../lib/errors.js';
import { systemResolver, type DnsResolver } from '../services/mailDns.js';
import type { Logger } from '../services/index.js';
import type { ServerHandle, ServerRegistry } from './registry.js';

/** Sections are separated by this on its own line, so a missing file just leaves one empty. */
const SEP = '===';

/**
 * One round trip that dumps the raw files rather than parsing them on the far end: `sed`
 * and `awk` one-liners quote badly through two shells, and every parsing bug would then be
 * unreproducible without an actual server. Here the shell only concatenates.
 */
export const SYSTEM_INFO_SCRIPT = [
  'uname -n 2>/dev/null; uname -r 2>/dev/null; uname -m 2>/dev/null',
  `echo ${SEP}`,
  'cat /etc/os-release 2>/dev/null',
  `echo ${SEP}`,
  'nproc 2>/dev/null',
  `echo ${SEP}`,
  'cat /proc/uptime 2>/dev/null',
  `echo ${SEP}`,
  'head -40 /proc/cpuinfo 2>/dev/null',
  `echo ${SEP}`,
  'head -3 /proc/meminfo 2>/dev/null',
  `echo ${SEP}`,
  'docker --version 2>/dev/null',
].join('\n');

type Facts = Omit<ServerSystemInfoDto, 'serverId' | 'reachable' | 'error' | 'readAt'>;

const EMPTY: Facts = {
  os: null,
  kernel: null,
  arch: null,
  hostname: null,
  cpuModel: null,
  cpus: null,
  memTotalBytes: null,
  uptimeSeconds: null,
  dockerVersion: null,
};

const clean = (value: string | undefined): string | null => {
  const out = (value ?? '').trim();
  return out === '' ? null : out;
};

const num = (value: string | undefined): number | null => {
  const n = Number.parseFloat((value ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** Parse what SYSTEM_INFO_SCRIPT printed. Every field is independently optional. */
export function parseSystemInfo(stdout: string): Facts {
  const [unameBlock = '', osRelease = '', nproc = '', uptime = '', cpuinfo = '', meminfo = '', docker = ''] =
    stdout.split(new RegExp(`^${SEP}$`, 'm'));
  const [hostname, kernel, arch] = unameBlock.trim().split('\n');

  // PRETTY_NAME first ("Ubuntu 24.04.1 LTS"); NAME+VERSION is the fallback for the rare
  // os-release without one, and an absent file leaves os null rather than inventing "Linux".
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}="?(.*?)"?\\s*$`, 'm').exec(osRelease);
    return clean(m?.[1]);
  };
  const pretty = field('PRETTY_NAME');
  const name = field('NAME');
  const version = field('VERSION');
  const os = pretty ?? (name ? [name, version].filter(Boolean).join(' ') : null);

  const cpuModel = clean(/^model name\s*:\s*(.*)$/m.exec(cpuinfo)?.[1]);
  const memKb = num(/^MemTotal:\s*(\d+)/m.exec(meminfo)?.[1]);

  return {
    os,
    kernel: clean(kernel),
    arch: clean(arch),
    hostname: clean(hostname),
    cpuModel,
    cpus: num(nproc),
    memTotalBytes: memKb === null ? null : memKb * 1024,
    uptimeSeconds: num(uptime.trim().split(/\s+/)[0]),
    dockerVersion: clean(docker),
  };
}

/** Readings older than this are refetched; younger ones come straight from memory. */
const TTL_MS = 60_000;

/** A PTR is set once and then never again, so the About page must not pay for one per visit. */
const PTR_TTL_MS = 10 * 60_000;

/**
 * `dns.reverse` goes to the network every time - it does not use the resolver the rest of
 * the OS shares - and inherits c-ares' own retry schedule, which on a box whose nameserver
 * is unreachable is tens of seconds. The page can live without the answer; it cannot live
 * with looking broken while it waits.
 */
const PTR_TIMEOUT_MS = 3000;

/**
 * What a server says about itself — OS, kernel, CPU, uptime — for the server detail page,
 * plus what DNS says about its address, for About.
 *
 * Cached for a minute because it costs a round trip on a machine that may be across the
 * internet, and because none of it changes between two page views. Server 1 is asked over
 * the same read-only host shell the Storage form uses: inside the panel container
 * `/etc/os-release` describes the image, not the machine the operator is looking at.
 */
export class SystemInfoService {
  private cache = new Map<number, ServerSystemInfoDto>();
  private ptrCache = new Map<string, { name: string | null; at: number }>();

  constructor(
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
    /** Read-only root shell on the panel's own host; absent in tests that don't need it. */
    private readonly hostExec: ExecPort | null = null,
    /** Injected so the suite never reaches a real nameserver; see services/mailDns.ts. */
    private readonly resolver: DnsResolver = systemResolver,
  ) {}

  /**
   * What DNS calls an address - the PTR record, for the About page.
   *
   * Mail's own reverse-DNS check (services/mailDns.ts) is a verdict: it wants the forward
   * confirmation too, and a missing PTR there is a problem to go and fix. This is the
   * opposite question. About is only saying what this machine is called, so every way the
   * lookup can fail - NXDOMAIN, a resolver that does not answer, no resolver at all - is
   * the same null, and the page shows nothing rather than an error nobody has to act on.
   */
  async reverseDns(ip: string): Promise<string | null> {
    const hit = this.ptrCache.get(ip);
    if (hit && Date.now() - hit.at < PTR_TTL_MS) return hit.name;
    let timer: NodeJS.Timeout | undefined;
    const name = await Promise.race([
      this.resolver.reverse(ip).then((names) => names[0] ?? null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PTR_TIMEOUT_MS);
      }),
    ]).catch(() => null);
    clearTimeout(timer);
    this.ptrCache.set(ip, { name, at: Date.now() });
    return name;
  }

  async describe(serverId: number, opts: { refresh?: boolean } = {}): Promise<ServerSystemInfoDto> {
    const row = this.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    const cached = this.cache.get(serverId);
    if (!opts.refresh && cached && Date.now() - cached.readAt < TTL_MS) return cached;

    const handle = this.servers.handleFor(serverId);
    let dto: ServerSystemInfoDto;
    try {
      const res = await this.execFor(handle).run('sh', ['-c', SYSTEM_INFO_SCRIPT], { timeoutMs: 30_000 });
      dto = { serverId, reachable: true, error: null, readAt: Date.now(), ...parseSystemInfo(res.stdout) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`System info for "${row.name}" failed: ${message}`);
      dto = { serverId, reachable: false, error: message, readAt: Date.now(), ...EMPTY };
    }
    this.cache.set(serverId, dto);
    return dto;
  }

  /** Host view of a server: the SSH hop for server 1, the ordinary exec port otherwise. */
  private execFor(handle: ServerHandle): ExecPort {
    if (handle.kind === 'local' && this.hostExec) return this.hostExec;
    return handle.exec;
  }

  forget(serverId: number): void {
    this.cache.delete(serverId);
  }
}
