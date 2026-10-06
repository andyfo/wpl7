/**
 * Puts the fleet's blocked addresses in force on every server (services/firewallRender.ts
 * writes the files, services/blocklist.ts is the list).
 *
 * On each server, two layers. The network layer - `wpl7-firewall`, installed by setup.sh -
 * refuses direct visitors in the kernel, and keeps doing so with the panel stopped: a timed
 * block even ends on time without it. The HTTP layer, one Traefik file, refuses visitors
 * behind a trusted proxy by the address in its header, and direct visitors too where the
 * network layer is missing.
 *
 * A server is loaded again only when the list's meaning changed, its table is gone, or it
 * rebooted - never merely because time passed, which would reset its counters for nothing.
 * Changes are coalesced: a detector that blocks ten addresses in one pass causes one load and
 * one Traefik reload per server.
 */
// @docs help/troubleshooting, security/blocked-addresses
import crypto from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';
import type { HostPort } from '../servers/hostPort.js';
import { parseCidr } from '../../shared/cidr.js';
import type { FirewallOverviewDto, FirewallServerDto, FirewallState } from '../../shared/types.js';
import { BLOCKED_FILE, buildBlockedFile, nftMeaning, planNft, renderNft, type BlockForRender } from './firewallRender.js';
import { renderDynamicFile } from './securityConfig.js';
import type { BlocklistService } from './blocklist.js';
import type { ProxyRangesService } from './proxyRanges.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';

/** A server in line is asked again this often: has it rebooted, is its table still there? */
const RECHECK_MS = 5 * 60_000;

interface HelperStatus {
  state: string;
  table: boolean;
  appliedAt: number;
  bootId: string;
  message: string;
}

interface ServerState {
  state: FirewallState;
  message: string | null;
  checkedAt: number | null;
  appliedAt: number | null;
  /** What was last loaded there, and in which boot of the server. */
  meaning: string | null;
  bootId: string | null;
  networkEntries: number;
  httpProxied: number;
  httpDirect: number;
  httpSkipped: number;
}

export interface FirewallSyncOpts {
  /** Coalescing window for kicks; 0 in tests. */
  debounceMs?: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export class FirewallSyncService {
  private readonly chains = new Map<number, Promise<void>>();
  private readonly waiting = new Map<number, Promise<void>>();
  private readonly states = new Map<number, ServerState>();
  /** `<serverId>` -> digest of the HTTP file known to be there. */
  private readonly httpWritten = new Map<number, string>();
  /** Servers whose view of the panel's address has been asked for since the panel started. */
  private readonly panelAsked = new Set<number>();
  private readonly debounceMs: number;

  constructor(
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly blocklist: BlocklistService,
    private readonly proxyRanges: ProxyRangesService,
    private readonly hostPort: (serverId: number) => HostPort,
    private readonly log: Logger,
    opts: FirewallSyncOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000;
  }

  private dir(): string {
    return path.join(this.config.srvRoot, 'wpl7-firewall');
  }

  /** What every server should hold right now. */
  private plan(now: number) {
    const enforced = this.settings.get('securityEnforcement') !== false;
    const blocks: BlockForRender[] = [];
    if (enforced) {
      for (const row of this.blocklist.active(now)) {
        const cidr = parseCidr(row.address);
        if (cidr) blocks.push({ cidr, expiresAt: row.expiresAt, createdAt: row.createdAt });
      }
    }
    const nft = planNft(blocks, this.blocklist.protectedSet(now).cidrs, now);
    return { enforced, blocks, nft, meaning: nftMeaning(nft) };
  }

  // ------------------------------------------------------------------ syncing

  /** Bring a server in line soon; bursts coalesce. Never rejects. */
  kick(serverId: number): Promise<void> {
    const pending = this.waiting.get(serverId);
    if (pending) return pending;
    const before = this.chains.get(serverId) ?? Promise.resolve();
    const run = before
      .then(() => (this.debounceMs > 0 ? new Promise<void>((r) => setTimeout(r, this.debounceMs)) : undefined))
      .then(() => {
        this.waiting.delete(serverId);
        return this.syncServer(serverId);
      })
      .catch((err: unknown) => {
        this.waiting.delete(serverId);
        this.log.warn(`Blocked addresses: sync of server #${serverId} failed: ${errorText(err)}`);
      });
    this.waiting.set(serverId, run);
    this.chains.set(serverId, run);
    return run;
  }

  kickAll(): Promise<void> {
    return Promise.all(this.servers.listRows().map((row) => this.kick(row.id))).then(() => undefined);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** Every minute: the servers whose list changed, and the ones not asked for a while. */
  tick(now = Date.now()): { kicked: number } {
    const { meaning } = this.plan(now);
    let kicked = 0;
    for (const row of this.servers.listRows()) {
      if (row.status === 'provisioning' || row.status === 'unreachable') continue;
      const state = this.states.get(row.id);
      const due = !state || state.checkedAt === null || now - state.checkedAt >= RECHECK_MS;
      const changed = state?.state === 'ok' ? state.meaning !== meaning : true;
      if (!due && !changed) continue;
      void this.kick(row.id);
      kicked++;
    }
    return { kicked };
  }

  private setState(serverId: number, patch: Partial<ServerState>): ServerState {
    const prev = this.states.get(serverId) ?? {
      state: 'unknown',
      message: null,
      checkedAt: null,
      appliedAt: null,
      meaning: null,
      bootId: null,
      networkEntries: 0,
      httpProxied: 0,
      httpDirect: 0,
      httpSkipped: 0,
    };
    const next = { ...prev, ...patch };
    this.states.set(serverId, next);
    return next;
  }

  /** Never throws: what went wrong is the server's state, which the Enforcement tab shows. */
  async syncServer(serverId: number): Promise<void> {
    const row = this.servers.rowById(serverId);
    if (!row) {
      this.states.delete(serverId);
      this.httpWritten.delete(serverId);
      return;
    }
    if (row.status === 'provisioning') return;
    const now = Date.now();
    try {
      const handle = this.servers.handleFor(serverId);
      await this.askPanelAddress(serverId, row.kind);
      const plan = this.plan(now);
      const network = await this.network(handle, serverId, plan, now).catch((err: unknown) => this.networkFailed(serverId, err));
      const http = await this.http(handle, serverId, plan.blocks, network.state !== 'ok');
      // The HTTP layer is what stands in for a missing network layer; say so where it does.
      const state: FirewallState = network.state === 'error' && http.direct > 0 ? 'http-only' : network.state;
      this.setState(serverId, {
        ...network,
        state,
        checkedAt: now,
        httpProxied: http.proxied,
        httpDirect: http.direct,
        httpSkipped: http.skipped,
      });
    } catch (err) {
      this.httpWritten.delete(serverId);
      const unreachable = err instanceof ServerUnreachableError;
      this.setState(serverId, { state: unreachable ? 'unreachable' : 'error', message: errorText(err).slice(0, 300), checkedAt: now });
      if (!unreachable) this.log.warn(`Blocked addresses on "${row.name}": ${errorText(err)}`);
    }
  }

  /** How the panel's own requests reach a worker - never to be blocked there. Once per start. */
  private async askPanelAddress(serverId: number, kind: string): Promise<void> {
    if (kind !== 'ssh' || this.panelAsked.has(serverId)) return;
    this.panelAsked.add(serverId);
    const address = await this.servers.panelAddressSeenBy(serverId).catch(() => null);
    if (address) this.blocklist.setPanelAddress(serverId, address);
  }

  private async network(
    handle: ServerHandle,
    serverId: number,
    plan: ReturnType<FirewallSyncService['plan']>,
    now: number,
  ): Promise<Pick<ServerState, 'state' | 'message' | 'appliedAt' | 'meaning' | 'bootId' | 'networkEntries'>> {
    const host = this.hostPort(serverId);
    const entries = plan.nft.permanent.length + plan.nft.timed.length;
    const prev = this.states.get(serverId);
    const statusRun = await host.run('wpl7-firewall', ['status'], { timeoutMs: 30_000 });
    if (statusRun.exitCode === 127 || /not found|No such file/i.test(statusRun.stderr)) {
      return { state: 'not-installed', message: 'Set this server up again (Update on the Servers page) to install the network layer.', appliedAt: null, meaning: null, bootId: null, networkEntries: 0 };
    }
    const status = parseHelper(statusRun.stdout);
    if (!status) {
      return { state: 'error', message: `wpl7-firewall status said: ${(statusRun.stderr || statusRun.stdout).trim().slice(0, 200)}`, appliedAt: null, meaning: null, bootId: null, networkEntries: 0 };
    }
    if (status.state === 'off') {
      return { state: 'off', message: 'Switched off on the server (wpl7-firewall off); `wpl7-firewall on` there switches it back on.', appliedAt: prev?.appliedAt ?? null, meaning: null, bootId: status.bootId, networkEntries: 0 };
    }
    const current =
      status.table && status.state === 'ok' && prev?.meaning === plan.meaning && prev.bootId === status.bootId && prev.state === 'ok';
    if (current) {
      return { state: 'ok', message: null, appliedAt: prev.appliedAt, meaning: plan.meaning, bootId: status.bootId, networkEntries: entries };
    }
    await handle.files.mkdirp(this.dir(), { mode: 0o700 });
    await handle.files.writeFile(path.join(this.dir(), 'wpl7.nft'), renderNft(plan.nft, now), { atomic: true, mode: 0o600 });
    const applyRun = await host.run('wpl7-firewall', ['apply'], { timeoutMs: 120_000 });
    const applied = parseHelper(applyRun.stdout);
    if (applyRun.exitCode !== 0 || applied?.state !== 'ok') {
      const message = applied?.message || (applyRun.stderr || applyRun.stdout).trim().slice(0, 300) || `exit ${applyRun.exitCode}`;
      this.log.warn(`Blocked addresses: the network layer on server #${serverId} did not load: ${message}`);
      return { state: 'error', message, appliedAt: prev?.appliedAt ?? null, meaning: null, bootId: status.bootId, networkEntries: 0 };
    }
    return { state: 'ok', message: null, appliedAt: now, meaning: plan.meaning, bootId: applied.bootId || status.bootId, networkEntries: entries };
  }

  /**
   * The network layer failed outright - the helper hung, say, or its file could not be written.
   * That is the layer's state, not a failed sync: the HTTP layer still goes out, and refuses
   * direct visitors in its place. An unreachable server gets neither.
   */
  private networkFailed(serverId: number, err: unknown): Awaited<ReturnType<FirewallSyncService['network']>> {
    if (err instanceof ServerUnreachableError) throw err;
    const message = errorText(err).slice(0, 300);
    this.log.warn(`Blocked addresses: the network layer on server #${serverId} failed: ${message}`);
    return { state: 'error', message, appliedAt: this.states.get(serverId)?.appliedAt ?? null, meaning: null, bootId: null, networkEntries: 0 };
  }

  private async http(
    handle: ServerHandle,
    serverId: number,
    blocks: BlockForRender[],
    direct: boolean,
  ): Promise<{ proxied: number; direct: number; skipped: number }> {
    const file = buildBlockedFile({
      proxies: this.proxyRanges.trusted(),
      blocks,
      direct,
      panelHost: this.config.panelDomain || null,
      tlsMode: this.config.tlsMode,
    });
    const target = path.join(this.config.srvRoot, 'traefik', 'dynamic', BLOCKED_FILE);
    if (!file.config) {
      if (this.httpWritten.get(serverId) !== 'none') {
        await handle.files.rm(target);
        this.httpWritten.set(serverId, 'none');
      }
      return file;
    }
    const content = renderDynamicFile(file.config, [
      'Written by the WPL7 panel (Security -> Blocked addresses): visitors refused on every site of this server.',
      'Replaced on every change to the list - an edit here is overwritten.',
    ]);
    const sum = digest(content);
    if (this.httpWritten.get(serverId) !== sum) {
      const current = this.httpWritten.has(serverId) ? null : await handle.files.readFile(target).catch(() => null);
      if (current === null || digest(current) !== sum) {
        await handle.files.mkdirp(path.dirname(target));
        await handle.files.writeFile(target, content, { atomic: true, mode: 0o644 });
      }
      this.httpWritten.set(serverId, sum);
    }
    return file;
  }

  // ------------------------------------------------------------------ views

  status(serverId: number): FirewallServerDto {
    const row = this.servers.rowById(serverId);
    const s = this.states.get(serverId);
    return {
      serverId,
      serverName: row?.name ?? `#${serverId}`,
      state: row?.status === 'unreachable' && !s ? 'unreachable' : (s?.state ?? 'unknown'),
      message: s?.message ?? null,
      checkedAt: s?.checkedAt ?? null,
      appliedAt: s?.appliedAt ?? null,
      networkEntries: s?.networkEntries ?? 0,
      httpProxied: s?.httpProxied ?? 0,
      httpDirect: s?.httpDirect ?? 0,
      httpSkipped: s?.httpSkipped ?? 0,
    };
  }

  overview(now = Date.now()): FirewallOverviewDto {
    return {
      enforced: this.settings.get('securityEnforcement') !== false,
      activeBlocks: this.blocklist.activeCount(now),
      servers: this.servers.listRows().map((r) => this.status(r.id)),
    };
  }
}

function parseHelper(stdout: string): HelperStatus | null {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    const j = JSON.parse(line) as Partial<HelperStatus>;
    if (typeof j.state !== 'string') return null;
    return {
      state: j.state,
      table: j.table === true,
      appliedAt: typeof j.appliedAt === 'number' ? j.appliedAt : 0,
      bootId: typeof j.bootId === 'string' ? j.bootId : '',
      message: typeof j.message === 'string' ? j.message : '',
    };
  } catch {
    return null;
  }
}
