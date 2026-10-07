// @docs servers/overview, servers/resources
import fsp from 'node:fs/promises';
import os from 'node:os';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { serverStats, siteStats, sites, type SiteRow } from '../db/schema.js';
import type { Config } from '../config.js';
import type { ServerMonitorDto, ServerStatsDto, SiteMonitorDto } from '../../shared/types.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { httpProbeOnce } from '../lib/httpProbe.js';
import { sitePaths } from './siteSpec.js';

/** The site states the monitor looks at; mid-create and mid-delete are a job's to report. */
const MONITORED = ['running', 'stopped', 'error'];
/** How long the check at the end of a job gives a container that has just started to answer. */
const SETTLE_MS = 10_000;

export class MonitorService {
  private latest = new Map<number, SiteMonitorDto>();
  private latestServers = new Map<number, ServerStatsDto>();
  /** Previous CPU counter reading per site; the other half of the rate calculation. */
  private cpuCursors = new Map<number, { cpuNs: number; at: number }>();
  private duCursor = 0;
  /** Slugs with an active backup/restore/move; du scanning skips them. */
  readonly busySlugs = new Set<string>();
  /**
   * Per site: how many jobs are changing it (holdChecks), and `changeSeq` as of the last time one
   * began or ended. In memory, like the jobs' own handlers: neither survives a restart.
   */
  private changes = new Map<number, { holds: number; seq: number }>();
  private changeSeq = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
  ) {}

  private activeSites(): SiteRow[] {
    return this.db
      .select()
      .from(sites)
      .where(inArray(sites.status, MONITORED))
      .all();
  }

  private activeSitesByServer(): Map<number, SiteRow[]> {
    const map = new Map<number, SiteRow[]>();
    for (const site of this.activeSites()) {
      const list = map.get(site.serverId) ?? [];
      list.push(site);
      map.set(site.serverId, list);
    }
    return map;
  }

  private entryFor(siteId: number, slug: string, serverId: number): SiteMonitorDto {
    let entry = this.latest.get(siteId);
    if (!entry) {
      entry = {
        slug,
        serverId,
        up: null,
        httpStatus: null,
        httpMs: null,
        lastCheckedAt: null,
        cpuPct: null,
        memBytes: null,
        diskBytes: null,
      };
      this.latest.set(siteId, entry);
    }
    entry.slug = slug;
    entry.serverId = serverId;
    return entry;
  }

  /** HTTP probe of each site. Parallel across servers, sequential within one - no thundering herd per host. */
  async tickUptime(): Promise<void> {
    // Taken with the list: each probe is built from the row as listed - its status, its
    // domains - and a job that begins or ends on the site later in the tick makes that stale.
    const seq = this.changeSeq;
    const byServer = this.activeSitesByServer();
    await Promise.all(
      [...byServer.entries()].map(async ([serverId, list]) => {
        let handle: ServerHandle | null = null;
        try {
          handle = this.servers.handleFor(serverId);
        } catch {
          /* server row gone mid-tick */
        }
        for (const site of list) await this.check(site, handle, () => this.changedSince(site.id, seq));
      }),
    );
  }

  /**
   * Hold the uptime check off a site while a job stops, starts or replaces its container on
   * purpose (the worker calls this for SITE_INTERRUPTING_JOBS). A probe landing in a container
   * swap reads Traefik's 404, and that reading stayed on the site page until the next check.
   * The returned function checks the site and then ends the hold, so the job ends with a
   * reading of what it left - not the last one from before it, or one taken halfway through.
   */
  holdChecks(siteId: number): () => Promise<void> {
    const change = this.changes.get(siteId) ?? { holds: 0, seq: 0 };
    this.changes.set(siteId, change);
    change.holds++;
    change.seq = ++this.changeSeq;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const seq = change.seq;
      try {
        // Still held while it runs, so no scheduled probe of the site starts beside it and
        // lands after it: one that failed on a container still settling would have the last word.
        if (change.holds === 1) await this.recheck(siteId, () => change.seq !== seq);
      } finally {
        change.holds--;
        // A scheduled probe that listed the site, or was out, before this point drops its answer.
        change.seq = ++this.changeSeq;
      }
    };
  }

  /** Whether a job is changing the site, or has begun or ended since `seq`. */
  private changedSince(siteId: number, seq: number): boolean {
    const change = this.changes.get(siteId);
    return change !== undefined && (change.holds > 0 || change.seq > seq);
  }

  /**
   * The check that ends a hold: the row as the job left it, and a few seconds to answer.
   * `stale` says whether another job has begun on the site since.
   */
  private async recheck(siteId: number, stale: () => boolean): Promise<void> {
    const site = this.db.select().from(sites).where(eq(sites.id, siteId)).get();
    if (!site || !MONITORED.includes(site.status)) return;
    let handle: ServerHandle | null = null;
    try {
      handle = this.servers.handleFor(site.serverId);
    } catch {
      /* server row gone */
    }
    // The jobs' own smoke-check window, cut down: a job that has one already waited for the
    // site, and one that only started a container (Start, Restart) needs seconds, not half a
    // minute. Zero in tests, as theirs is.
    await this.check(site, handle, stale, Math.min(this.config.probeTimeoutMs, SETTLE_MS));
  }

  /**
   * Probe one site and record what it answered, unless it has gone `stale`: a job has begun or
   * ended on it since its row was read, and the reading is that job's to take (holdChecks). With
   * `settleMs`, a failed probe is tried again, a second apart, until that long has passed.
   */
  private async check(site: SiteRow, handle: ServerHandle | null, stale: () => boolean, settleMs = 0): Promise<void> {
    if (stale()) return;
    const entry = this.entryFor(site.id, site.slug, site.serverId);
    // `stopped` is the one state the panel can answer without asking: it stopped the
    // container itself. `error` is NOT - it only says a job failed, and plenty of them
    // fail with the site still serving (a delete whose final backup failed marks the
    // row `error` while the container is still up). Asserting `up: false` there put a
    // measured-looking "not serving" on a site nobody had probed.
    if (site.status === 'stopped') {
      entry.up = false;
      entry.httpStatus = null;
      entry.httpMs = null;
      entry.lastCheckedAt = Date.now();
      return;
    }
    if (!handle) return;
    const url = handle.probeUrlFor(site.containerName);
    const primary = (JSON.parse(site.domains) as string[])[0] ?? site.slug;
    const deadline = Date.now() + settleMs;
    let attempt = await httpProbeOnce(url, primary, 5000);
    while (!attempt.ok && Date.now() < deadline && !stale()) {
      await new Promise((r) => setTimeout(r, 1000));
      attempt = await httpProbeOnce(url, primary, 5000);
    }
    // A job that began on the site while the request was out may be what it answered.
    if (stale()) return;
    const { ok: up, status, ms } = attempt;
    entry.up = up;
    // Kept even when the probe passed: it is the whole difference between "nothing
    // answered" and "Traefik answered 404 because no router matched this hostname",
    // which is what the panel has to say out loud when a site is running but dark.
    entry.httpStatus = status;
    entry.httpMs = up ? ms : null;
    entry.lastCheckedAt = Date.now();
    this.db
      .insert(siteStats)
      .values({ siteId: site.id, ts: Date.now(), up: up ? 1 : 0, httpMs: entry.httpMs })
      .run();
  }

  async tickContainerStats(): Promise<void> {
    const byServer = this.activeSitesByServer();
    await Promise.all(
      [...byServer.entries()].map(async ([serverId, list]) => {
        let handle: ServerHandle;
        try {
          handle = this.servers.handleFor(serverId);
        } catch {
          return;
        }
        for (const site of list) {
          if (site.status !== 'running') {
            // A stopped container's counter restarts at zero, so the reading held for it
            // is no longer a baseline for anything.
            this.cpuCursors.delete(site.id);
            continue;
          }
          const entry = this.entryFor(site.id, site.slug, site.serverId);
          const sample = await handle.docker.sampleStats(site.containerName);
          entry.cpuPct = this.cpuRate(site.id, sample.cpuNs);
          entry.memBytes = sample.memBytes;
          if (entry.cpuPct !== null || sample.memBytes !== null) {
            this.db
              .insert(siteStats)
              .values({ siteId: site.id, ts: Date.now(), cpuPct: entry.cpuPct, memBytes: sample.memBytes })
              .run();
          }
        }
      }),
    );
  }

  /**
   * CPU as a percentage of ONE core (the unit `docker stats` uses), averaged over the whole
   * gap since the previous reading rather than over a one-second window inside it.
   *
   * The window is why this is not Docker's own number. Both are computed from the same
   * cumulative counter, but Docker pairs it with a sample taken ~1s earlier, and the
   * panel's schedulers all tick on multiples of a minute from the same start - so that
   * second contained the panel's own uptime probe on every tick, and its wp-cron run on
   * every fifth. A site nobody had visited reported ~30% (with ~95% spikes every five
   * minutes) while its true consumption, read straight off the cgroup, was 0.3%.
   *
   * Returns null until there is a baseline to difference against, and after a restart
   * (counter back to zero) - one missing point beats an invented one.
   */
  private cpuRate(siteId: number, cpuNs: number | null): number | null {
    if (cpuNs === null) {
      this.cpuCursors.delete(siteId);
      return null;
    }
    const at = Date.now();
    const prev = this.cpuCursors.get(siteId);
    this.cpuCursors.set(siteId, { cpuNs, at });
    if (!prev || cpuNs < prev.cpuNs || at <= prev.at) return null;
    const pct = ((cpuNs - prev.cpuNs) / ((at - prev.at) * 1e6)) * 100;
    return Math.round(pct * 10) / 10;
  }

  /** Disk usage: staggered round-robin, one site per tick, skipping sites mid-backup/restore. */
  async tickDiskUsage(): Promise<void> {
    const list = this.activeSites();
    if (list.length === 0) return;
    for (let i = 0; i < list.length; i++) {
      const site = list[(this.duCursor + i) % list.length]!;
      if (this.busySlugs.has(site.slug)) continue;
      this.duCursor = (this.duCursor + i + 1) % list.length;
      let handle: ServerHandle;
      try {
        handle = this.servers.handleFor(site.serverId);
      } catch {
        return;
      }
      const p = sitePaths(this.config, site.slug);
      // -sk is portable (macOS du has no -b); KiB * 1024.
      const res = await handle.exec.run('du', ['-sk', p.root], { timeoutMs: 5 * 60_000 }).catch(() => null);
      if (!res || res.exitCode !== 0) return;
      const kib = parseInt(res.stdout.trim().split(/\s+/)[0] ?? '', 10);
      if (Number.isNaN(kib)) return;
      const bytes = kib * 1024;
      const entry = this.entryFor(site.id, site.slug, site.serverId);
      entry.diskBytes = bytes;
      this.db.update(sites).set({ diskBytes: bytes }).where(eq(sites.id, site.id)).run();
      this.db.insert(siteStats).values({ siteId: site.id, ts: Date.now(), diskBytes: bytes }).run();
      return;
    }
  }

  /** Load/mem/disk per server. Doubles as the reachability heartbeat for remote servers. */
  /** How much of a server's memory was in use at the last sample; null before the first. */
  memoryUsed(serverId: number): number | null {
    const stats = this.latestServers.get(serverId);
    return stats && stats.memTotal > 0 ? stats.memUsed / stats.memTotal : null;
  }

  async tickServerStats(): Promise<void> {
    await Promise.all(
      this.servers.listRows().map(async (row) => {
        let stats: ServerStatsDto | null = null;
        if (row.kind === 'local') {
          stats = await this.localServerStats();
        } else {
          try {
            const handle = this.servers.handleFor(row.id);
            stats = await this.remoteServerStats(handle);
            this.servers.markReachable(row.id);
          } catch (err) {
            this.servers.markUnreachable(row.id, err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        if (!stats) return;
        this.latestServers.set(row.id, stats);
        this.db.insert(serverStats).values({ serverId: row.id, ts: Date.now(), ...stats }).run();
      }),
    );
  }

  private async localServerStats(): Promise<ServerStatsDto> {
    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    let memTotal = os.totalmem();
    let memUsed = memTotal - os.freemem();
    try {
      // Inside a container /proc/meminfo is host-wide, which is what we want on a server dashboard.
      const meminfo = await fsp.readFile('/proc/meminfo', 'utf8');
      const parsed = parseMeminfo(meminfo);
      if (parsed) {
        memTotal = parsed.memTotal;
        memUsed = parsed.memUsed;
      }
    } catch {
      /* not Linux - os module values are fine for dev */
    }
    let diskTotal = 0;
    let diskUsed = 0;
    try {
      const stat = await fsp.statfs(this.config.srvRoot);
      diskTotal = Number(stat.blocks) * Number(stat.bsize);
      diskUsed = diskTotal - Number(stat.bavail) * Number(stat.bsize);
    } catch {
      /* ignore */
    }
    return { load1, load5, load15, memTotal, memUsed, diskTotal, diskUsed };
  }

  private async remoteServerStats(handle: ServerHandle): Promise<ServerStatsDto | null> {
    const res = await handle.exec.run(
      'sh',
      ['-c', `cat /proc/loadavg; echo ==; cat /proc/meminfo; echo ==; df -kP ${this.config.srvRoot}`],
      { timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0) throw new Error(`stats collection failed: ${res.stderr.trim().slice(0, 200)}`);
    const [loadPart = '', memPart = '', dfPart = ''] = res.stdout.split('==');
    const [l1 = '0', l5 = '0', l15 = '0'] = loadPart.trim().split(/\s+/);
    const mem = parseMeminfo(memPart) ?? { memTotal: 0, memUsed: 0 };
    let diskTotal = 0;
    let diskUsed = 0;
    const dfLines = dfPart.trim().split('\n');
    const cols = dfLines[dfLines.length - 1]?.split(/\s+/);
    const totalKb = Number(cols?.[1]);
    const availKb = Number(cols?.[3]);
    if (Number.isFinite(totalKb) && Number.isFinite(availKb)) {
      diskTotal = totalKb * 1024;
      diskUsed = diskTotal - availKb * 1024;
    }
    return {
      load1: parseFloat(l1) || 0,
      load5: parseFloat(l5) || 0,
      load15: parseFloat(l15) || 0,
      ...mem,
      diskTotal,
      diskUsed,
    };
  }

  overview(): { server: ServerStatsDto | null; servers: ServerMonitorDto[]; sites: SiteMonitorDto[] } {
    const list = this.activeSites().map((site) => {
      const entry = this.latest.get(site.id);
      return {
        slug: site.slug,
        serverId: site.serverId,
        up: entry?.up ?? null,
        httpStatus: entry?.httpStatus ?? null,
        httpMs: entry?.httpMs ?? null,
        lastCheckedAt: entry?.lastCheckedAt ?? null,
        cpuPct: entry?.cpuPct ?? null,
        memBytes: entry?.memBytes ?? null,
        diskBytes: site.diskBytes ?? entry?.diskBytes ?? null,
      };
    });
    const serverList = this.servers.listRows().map((row) => ({
      serverId: row.id,
      name: row.name,
      status: row.status as ServerMonitorDto['status'],
      ...(this.latestServers.get(row.id) ?? {
        load1: 0,
        load5: 0,
        load15: 0,
        memTotal: 0,
        memUsed: 0,
        diskTotal: 0,
        diskUsed: 0,
      }),
    }));
    // `server` kept for existing API clients: always server #1.
    return { server: this.latestServers.get(1) ?? null, servers: serverList, sites: list };
  }

  latestFor(siteId: number): SiteMonitorDto | null {
    return this.latest.get(siteId) ?? null;
  }

  /** Keep the latest real sample per bucket; at most 240 points, even for a week. */
  serverHistory(serverId: number, hours: number) {
    const until = Date.now();
    const since = until - hours * 3600_000;
    const bucketMs = Math.max(15_000, Math.ceil((until - since + 1) / 240));
    const sampleIds = this.db
      .select({ id: sql<number>`max(${serverStats.id})` })
      .from(serverStats)
      .where(and(eq(serverStats.serverId, serverId), gte(serverStats.ts, since), lte(serverStats.ts, until)))
      .groupBy(sql`cast((${serverStats.ts} - ${since}) / ${bucketMs} as integer)`);
    const samples = this.db
      .select({
        ts: serverStats.ts,
        load1: serverStats.load1,
        load5: serverStats.load5,
        load15: serverStats.load15,
        memTotal: serverStats.memTotal,
        memUsed: serverStats.memUsed,
        diskTotal: serverStats.diskTotal,
        diskUsed: serverStats.diskUsed,
      })
      .from(serverStats)
      .where(and(eq(serverStats.serverId, serverId), inArray(serverStats.id, sampleIds)))
      .orderBy(serverStats.ts)
      .all();
    return { samples, since, until, bucketMs };
  }

  /** Bucketed history for sparklines, capped at ~288 points. */
  history(siteId: number, hours: number) {
    const since = Date.now() - hours * 3600_000;
    const rows = this.db
      .select()
      .from(siteStats)
      .where(and(eq(siteStats.siteId, siteId), gte(siteStats.ts, since)))
      .orderBy(siteStats.ts)
      .all();
    const bucketMs = Math.max(60_000, Math.ceil((hours * 3600_000) / 288));
    const buckets = new Map<number, { ts: number; up: number | null; httpMs: number[]; cpu: number[]; mem: number[] }>();
    for (const row of rows) {
      const key = Math.floor(row.ts / bucketMs);
      let b = buckets.get(key);
      if (!b) {
        b = { ts: key * bucketMs, up: null, httpMs: [], cpu: [], mem: [] };
        buckets.set(key, b);
      }
      if (row.up !== null) b.up = b.up === 0 ? 0 : row.up; // any down sample marks the bucket down
      if (row.httpMs !== null) b.httpMs.push(row.httpMs);
      if (row.cpuPct !== null) b.cpu.push(row.cpuPct);
      if (row.memBytes !== null) b.mem.push(row.memBytes);
    }
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return [...buckets.values()].map((b) => ({
      ts: b.ts,
      up: b.up === null ? null : b.up === 1,
      httpMs: avg(b.httpMs),
      cpuPct: avg(b.cpu),
      memBytes: avg(b.mem),
    }));
  }
}

function parseMeminfo(meminfo: string): { memTotal: number; memUsed: number } | null {
  const grab = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(meminfo);
    return m ? parseInt(m[1]!, 10) * 1024 : null;
  };
  const total = grab('MemTotal');
  const available = grab('MemAvailable');
  if (total === null || available === null) return null;
  return { memTotal: total, memUsed: total - available };
}
