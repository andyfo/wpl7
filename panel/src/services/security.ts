/**
 * Site protection, per server: what every site's policy is, and making each server's rules
 * folder say so (docs/security.md).
 *
 * The database is the truth and `syncServer` makes one server match it: a `sec-<slug>.yml` in
 * `<SRV_ROOT>/traefik/dynamic` for every site that runs there with protection on, none for any
 * other - and never a touch to the files it did not write (`move-<slug>.yml` forwards a moved
 * site's traffic from the same folder). Changes kick the server they concern; a tick every
 * minute catches everything else, and so does the panel starting.
 *
 * A file is only rewritten when its content changes. Traefik rebuilds its whole configuration
 * whenever any file in the folder changes, and a rebuilt rate limiter starts counting from zero
 * - rewriting unchanged files every minute would mean the limits never limit.
 *
 * Fail open, always: a sync that fails leaves each server with the files it had, a site that
 * cannot be rendered keeps its previous file, and a missing file only means the site is served
 * by its own router, as it was before Security existed.
 */
// @docs help/troubleshooting, security/overview, security/site-protection
import crypto from 'node:crypto';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { securityNeverBlock, siteSecurity, sites, type ServerRow, type SiteRow, type SiteSecurityRow } from '../db/schema.js';
import type { Config } from '../config.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';
import {
  customRulesSchema,
  effectivePolicy,
  securityOverridesSchema,
  withRuleIds,
  type ContainerPolicy,
  type CustomRule,
  type EffectivePolicy,
  type FleetSecurity,
  type ScanOnFinding,
  type SecurityLevel,
  type SecurityOverrides,
  type SiteSecurityInput,
} from '../../shared/security.js';
import {
  RuleValueError,
  SECURITY_FILE_RE,
  buildSiteSecurityConfig,
  bypassList,
  fleetAddresses,
  renderDynamicFile,
  securityFileName,
} from './securityConfig.js';
import type { ProxyRangesService } from './proxyRanges.js';
import type { SettingsService } from './settings.js';
import { hardeningFiles } from './siteHardening.js';
import { sitePaths } from './siteSpec.js';
import type { Logger } from './index.js';

/** A server already in line is looked at again this often: a file deleted or edited by hand. */
const VERIFY_MS = 10 * 60_000;

export interface SecurityServiceOpts {
  /** Coalescing window for kicks; 0 in tests. */
  debounceMs?: number;
}

export type ProtectionSyncState = 'ok' | 'error' | 'unreachable' | 'unknown';

interface ServerStatus {
  state: ProtectionSyncState;
  message: string | null;
  checkedAt: number | null;
  syncedAt: number | null;
}

/** What the last sync did about one site. */
interface SiteState {
  serverId: number;
  /** Digest of the file it wrote; null = no file (Off, not running). */
  digest: string | null;
  at: number;
  /** The site's file could not be rendered - it keeps the one it had. */
  problem: string | null;
}

/** A running site, and what its container's hardening files should hold. */
type HardeningPlan = { site: SiteRow; container: ContainerPolicy; files: { apache: string; php: string } }[];

export interface SiteSecurityPatch {
  level?: SecurityLevel | null;
  overrides?: SecurityOverrides;
  customRules?: CustomRule[];
  scanEnabled?: boolean | null;
  scanOnFinding?: ScanOnFinding | null;
}

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SecurityService {
  private readonly chains = new Map<number, Promise<void>>();
  private readonly waiting = new Map<number, Promise<void>>();
  /** `<serverId>:<file>` -> digest of what is known to be there. */
  private readonly written = new Map<string, string>();
  private readonly status = new Map<number, ServerStatus>();
  private readonly siteStates = new Map<number, SiteState>();
  /** When each server's files were last read back rather than taken from the cache. */
  private readonly verifiedAt = new Map<number, number>();
  /** Per server: the digest of the plan its last good sync wrote. */
  private readonly synced = new Map<number, string>();
  /** Sites a job wants served on a server ahead of what the database says (a move's target). */
  private readonly pins = new Map<number, Map<number, number>>();
  /** Per site slug: what Traefik said about its routers since its file was last written. */
  private readonly rejected = new Map<string, { router: string; message: string; at: number }[]>();
  /** Per site: why the protection inside its container is not what its policy says. */
  private readonly hardeningProblems = new Map<number, string>();
  /** `<serverId>:<file>` -> digest of an Apache file its check refused; not tried again as it is. */
  private readonly refused = new Map<string, string>();
  private readonly debounceMs: number;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly proxyRanges: ProxyRangesService,
    private readonly log: Logger,
    opts: SecurityServiceOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 500;
  }

  // ------------------------------------------------------------------ policy

  fleet(): FleetSecurity {
    return {
      level: this.settings.get('securityLevel') ?? 'standard',
      overrides: this.settings.get('securityOverrides') ?? {},
    };
  }

  siteRow(siteId: number): SiteSecurityRow | undefined {
    return this.db.select().from(siteSecurity).where(eq(siteSecurity.siteId, siteId)).get();
  }

  /**
   * A site's own settings, read defensively: a row written by a later version, or by hand,
   * must not stop every other site's rules from being written.
   */
  siteInput(siteId: number): SiteSecurityInput {
    const row = this.siteRow(siteId);
    if (!row) return { level: null, overrides: {}, customRules: [] };
    const overrides = securityOverridesSchema.safeParse(safeJson(row.overrides, {}));
    const rules = customRulesSchema.safeParse(safeJson(row.customRules, []));
    const level = row.level === 'off' || row.level === 'standard' || row.level === 'strict' ? row.level : null;
    return {
      level,
      overrides: overrides.success ? overrides.data : {},
      customRules: rules.success ? withRuleIds(rules.data) : [],
    };
  }

  policyFor(siteId: number): EffectivePolicy {
    return effectivePolicy(this.fleet(), this.siteInput(siteId));
  }

  /** Save a site's own settings; its server's rules follow within moments. */
  updateSite(site: SiteRow, patch: SiteSecurityPatch, by: string | null): void {
    const now = Date.now();
    const current = this.siteRow(site.id);
    const values = {
      level: patch.level !== undefined ? patch.level : (current?.level ?? null),
      overrides: patch.overrides !== undefined ? JSON.stringify(patch.overrides) : (current?.overrides ?? '{}'),
      customRules: patch.customRules !== undefined ? JSON.stringify(patch.customRules) : (current?.customRules ?? '[]'),
      scanEnabled:
        patch.scanEnabled !== undefined ? (patch.scanEnabled === null ? null : patch.scanEnabled ? 1 : 0) : (current?.scanEnabled ?? null),
      scanOnFinding: patch.scanOnFinding !== undefined ? patch.scanOnFinding : (current?.scanOnFinding ?? null),
      updatedAt: now,
      updatedBy: by,
    };
    this.db
      .insert(siteSecurity)
      .values({ siteId: site.id, ...values })
      .onConflictDoUpdate({ target: siteSecurity.siteId, set: values })
      .run();
    void this.kick(site.serverId);
  }

  // ------------------------------------------------------------------ what a server gets

  /** Hold a site on a server regardless of the database - see `pins`. */
  pin(serverId: number, siteId: number): () => void {
    const onServer = this.pins.get(serverId) ?? new Map<number, number>();
    onServer.set(siteId, (onServer.get(siteId) ?? 0) + 1);
    this.pins.set(serverId, onServer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (onServer.get(siteId) ?? 1) - 1;
      if (n <= 0) onServer.delete(siteId);
      else onServer.set(siteId, n);
    };
  }

  /** The files a server should have: name -> content, or null to keep what is there. */
  private plan(row: ServerRow): Map<string, { siteId: number; content: string | null; problem: string | null }> {
    const pinned = this.pins.get(row.id) ?? new Map<number, number>();
    const rows = this.db.select().from(sites).all();
    const here = rows.filter((s) => (s.serverId === row.id && s.status === 'running') || pinned.has(s.id));
    const out = new Map<string, { siteId: number; content: string | null; problem: string | null }>();
    if (here.length === 0) return out;

    const fleet = fleetAddresses(this.servers.listRows().map((s) => s.publicIp));
    const neverBlock = this.db.select({ address: securityNeverBlock.address }).from(securityNeverBlock).all().map((r) => r.address);
    const shared = {
      tlsMode: this.config.tlsMode,
      proxies: this.proxyRanges.trusted(),
      bypass: bypassList({ fleet, neverBlock, bypassPrivate: this.settings.get('securityBypassPrivate') !== false }),
      fleet,
      jetpack: this.proxyRanges.ranges('jetpack'),
    };
    const fleetPolicy = this.fleet();
    for (const site of here) {
      const policy = effectivePolicy(fleetPolicy, this.siteInput(site.id));
      try {
        const config = buildSiteSecurityConfig({
          ...shared,
          slug: site.slug,
          domains: JSON.parse(site.domains) as string[],
          policy,
        });
        if (!config) continue;
        const content = renderDynamicFile(config, [
          `Written by the WPL7 panel: the protection of "${site.slug}" (${policy.level}).`,
          'Change it in the panel (the site\'s Security tab) - an edit here is overwritten.',
        ]);
        out.set(securityFileName(site.slug), { siteId: site.id, content, problem: null });
      } catch (err) {
        if (!(err instanceof RuleValueError)) throw err;
        out.set(securityFileName(site.slug), { siteId: site.id, content: null, problem: err.message });
      }
    }
    return out;
  }

  private planDigest(plan: ReturnType<SecurityService['plan']>, hardening: HardeningPlan): string {
    return digest(
      JSON.stringify([
        [...plan.entries()].map(([file, e]) => [file, e.content]).sort(),
        hardening.map((e) => [e.site.id, e.files.apache, e.files.php]),
      ]),
    );
  }

  // ------------------------------------------------------------------ syncing

  /**
   * Bring a server's rules in line soon. Kicks that arrive while one is waiting ride along,
   * and one mid-sync queues exactly one more, so a burst of changes is one sync - and, on the
   * server, one configuration reload. Resolves once a sync started after the kick is done;
   * never rejects.
   */
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
        this.log.warn(`Site protection sync of server #${serverId} failed: ${errorText(err)}`);
      });
    this.waiting.set(serverId, run);
    this.chains.set(serverId, run);
    return run;
  }

  /** Every server - after a fleet-wide change: the default, the proxies, the never-block list. */
  kickAll(): Promise<void> {
    return Promise.all(this.servers.listRows().map((row) => this.kick(row.id))).then(() => undefined);
  }

  /** Wait for everything queued so far (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /**
   * The minute tick: a server whose rules should differ from what it was last given, or that
   * has not been looked at for a while, is synced. Unreachable servers are left for when the
   * monitor has seen them answer again.
   */
  tick(now = Date.now()): { kicked: number } {
    let kicked = 0;
    for (const row of this.servers.listRows()) {
      if (row.status === 'provisioning' || row.status === 'unreachable') continue;
      const planned = this.planDigest(this.plan(row), this.hardeningPlan(row.id));
      const due = now - (this.verifiedAt.get(row.id) ?? 0) >= VERIFY_MS;
      if (!due && this.synced.get(row.id) === planned && this.status.get(row.id)?.state === 'ok') continue;
      void this.kick(row.id);
      kicked++;
    }
    return { kicked };
  }

  private setStatus(serverId: number, patch: Partial<ServerStatus>): void {
    const prev = this.status.get(serverId) ?? { state: 'unknown', message: null, checkedAt: null, syncedAt: null };
    this.status.set(serverId, { ...prev, ...patch });
  }

  /** Never throws: what went wrong is the server's status, which the pages show. */
  async syncServer(serverId: number): Promise<void> {
    const row = this.servers.rowById(serverId);
    if (!row) {
      this.status.delete(serverId);
      this.forgetWrites(serverId);
      return;
    }
    if (row.status === 'provisioning') return;
    const startedAt = Date.now();
    try {
      const handle = this.servers.handleFor(serverId);
      const plan = this.plan(row);
      const verify = startedAt - (this.verifiedAt.get(serverId) ?? 0) >= VERIFY_MS;
      const dir = this.dir();
      await handle.files.mkdirp(dir);
      let wrote = 0;
      for (const [file, entry] of plan) {
        if (entry.content === null) {
          // Kept as it is, and said so: a value that could not be written is a bug, not a
          // reason to take the site's protection away.
          this.siteStates.set(entry.siteId, { serverId, digest: null, at: startedAt, problem: entry.problem });
          this.log.warn(`Site protection for site #${entry.siteId} not rewritten: ${entry.problem}`);
          continue;
        }
        if (await this.put(handle, path.join(dir, file), entry.content, verify)) {
          wrote++;
          // A new file is a new chance: what Traefik said about the old one no longer applies.
          this.rejected.delete(file.replace(/^sec-/, '').replace(/\.yml$/, ''));
        }
        this.siteStates.set(entry.siteId, { serverId, digest: digest(entry.content), at: startedAt, problem: null });
      }
      let removed = 0;
      for (const name of await handle.files.readdir(dir)) {
        const match = SECURITY_FILE_RE.exec(name);
        if (!match || plan.has(name)) continue;
        await handle.files.rm(path.join(dir, name));
        this.written.delete(`${serverId}:${path.join(dir, name)}`);
        removed++;
      }
      // Sites this server no longer serves have no file here any more.
      for (const [siteId, state] of this.siteStates) {
        if (state.serverId === serverId && ![...plan.values()].some((e) => e.siteId === siteId)) {
          this.siteStates.set(siteId, { serverId, digest: null, at: startedAt, problem: null });
        }
      }
      const hardeningPlan = this.hardeningPlan(serverId);
      const hardening = await this.syncHardening(handle, hardeningPlan);
      if (verify) this.verifiedAt.set(serverId, startedAt);
      // A container that could not be checked is tried again at the next tick, not in ten minutes.
      if (hardening.retry) this.synced.delete(serverId);
      else this.synced.set(serverId, this.planDigest(plan, hardeningPlan));
      this.setStatus(serverId, { state: 'ok', message: null, checkedAt: startedAt, syncedAt: startedAt });
      if (wrote + removed > 0) {
        this.log.info(`Site protection on "${row.name}": ${wrote} file(s) written, ${removed} removed`);
      }
      if (hardening.changed > 0) {
        this.log.info(`Site protection on "${row.name}": updated inside ${hardening.changed} site container(s)`);
      }
    } catch (err) {
      this.forgetWrites(serverId);
      this.verifiedAt.delete(serverId);
      this.synced.delete(serverId);
      const unreachable = err instanceof ServerUnreachableError;
      this.setStatus(serverId, { state: unreachable ? 'unreachable' : 'error', message: errorText(err).slice(0, 300), checkedAt: startedAt });
      if (!unreachable) this.log.warn(`Site protection on "${row.name}": ${errorText(err)}`);
    }
  }

  /**
   * Write a file unless it already holds exactly this. The first time since the panel started
   * - and on every verify pass - that is checked against the file itself rather than the cache,
   * so a deploy of the panel does not rewrite every file and reset every limiter with it.
   * Returns whether it wrote.
   */
  private async put(handle: ServerHandle, file: string, content: string, verify: boolean): Promise<boolean> {
    const key = `${handle.id}:${file}`;
    const sum = digest(content);
    if (!verify && this.written.get(key) === sum) return false;
    if (verify || !this.written.has(key)) {
      const current = await handle.files.readFile(file).catch(() => null);
      if (current !== null && digest(current) === sum) {
        this.written.set(key, sum);
        return false;
      }
    }
    await handle.files.writeFile(file, content, { atomic: true, mode: 0o644 });
    this.written.set(key, sum);
    return true;
  }

  private forgetWrites(serverId: number): void {
    for (const key of [...this.written.keys()]) if (key.startsWith(`${serverId}:`)) this.written.delete(key);
  }

  private dir(): string {
    return path.join(this.config.srvRoot, 'traefik', 'dynamic');
  }

  // ------------------------------------------------------------------ inside the containers

  /** The running sites on a server, and what their hardening files should hold. */
  private hardeningPlan(serverId: number): HardeningPlan {
    const fleetPolicy = this.fleet();
    return this.db
      .select()
      .from(sites)
      .where(and(eq(sites.serverId, serverId), eq(sites.status, 'running')))
      .all()
      .map((site) => {
        const { container } = effectivePolicy(fleetPolicy, this.siteInput(site.id));
        return { site, container, files: hardeningFiles(container) };
      });
  }

  /**
   * Write a site's hardening files ahead of a start (ensureSiteMountSources): the folder they
   * sit in, and both files from its policy as it is now. The container about to start reads
   * them, so there is nothing to reload.
   */
  async prepareHardening(handle: ServerHandle, site: Pick<SiteRow, 'id' | 'slug'>): Promise<void> {
    const p = sitePaths(this.config, site.slug);
    const files = hardeningFiles(this.policyFor(site.id).container);
    await handle.files.mkdirp(p.securityDir, { mode: 0o755 });
    await handle.files.writeFile(p.securityWpPhp, files.php, { atomic: true, mode: 0o644 });
    // In place: a single-file mount keeps the inode it was given (see siteHardening.ts).
    await handle.files.writeFile(p.securityApacheConf, files.apache, { mode: 0o644 });
    this.written.set(`${handle.id}:${p.securityWpPhp}`, digest(files.php));
    this.written.set(`${handle.id}:${p.securityApacheConf}`, digest(files.apache));
    this.refused.delete(`${handle.id}:${p.securityApacheConf}`);
    this.hardeningProblems.delete(site.id);
  }

  /**
   * Keep the hardening inside each running site's container in line with its policy. Only a
   * file that is there is rewritten: making them is ensureSiteMountSources' job, just before a
   * container starts, and a container from before they existed is rebuilt with them
   * (sweepHardening). `retry`: a container could not be checked, so try again soon.
   */
  private async syncHardening(handle: ServerHandle, plan: HardeningPlan): Promise<{ changed: number; retry: boolean }> {
    let changed = 0;
    let retry = false;
    for (const entry of plan) {
      const { site } = entry;
      try {
        if (await this.applyHardening(handle, entry)) changed++;
      } catch (err) {
        if (err instanceof ServerUnreachableError) throw err;
        retry = true;
        this.hardeningProblems.set(site.id, `The protection inside its container could not be updated: ${errorText(err)}`);
        this.log.warn(`Site protection inside "${site.slug}": ${errorText(err)}`);
      }
    }
    return { changed, retry };
  }

  private async applyHardening(handle: ServerHandle, { site, container, files }: HardeningPlan[number]): Promise<boolean> {
    const p = sitePaths(this.config, site.slug);
    const php = await this.onDisk(handle, p.securityWpPhp, files.php);
    const apache = await this.onDisk(handle, p.securityApacheConf, files.apache);
    if (php.state === 'missing' || apache.state === 'missing') {
      if (Object.values(container).some(Boolean)) {
        this.hardeningProblems.set(
          site.id,
          'Its container was built before protection reached inside it. The panel rebuilds it by itself; Recreate container does it now.',
        );
      } else this.hardeningProblems.delete(site.id);
      return false;
    }
    let changed = false;

    // PHP reads its file on every request, so it is replaced whole and takes effect at once.
    if (php.state === 'differs') {
      await handle.files.writeFile(p.securityWpPhp, files.php, { atomic: true, mode: 0o644 });
      this.written.set(`${handle.id}:${p.securityWpPhp}`, digest(files.php));
      changed = true;
    }

    // Apache reads its file when it starts or reloads: checked first, and put back if refused.
    const key = `${handle.id}:${p.securityApacheConf}`;
    if (apache.state === 'differs') {
      if (this.refused.get(key) === digest(files.apache)) return changed;
      await handle.files.writeFile(p.securityApacheConf, files.apache, { mode: 0o644 });
      let refusal: string | null;
      try {
        refusal = await this.reloadApache(handle, site.containerName);
      } catch (err) {
        // Not known to be good, so not left in place for the next start to trip over.
        await handle.files.writeFile(p.securityApacheConf, apache.current, { mode: 0o644 });
        throw err;
      }
      if (refusal !== null) {
        await handle.files.writeFile(p.securityApacheConf, apache.current, { mode: 0o644 });
        this.refused.set(key, digest(files.apache));
        this.hardeningProblems.set(site.id, `Apache refused the new protection inside its container, so it keeps the previous one: ${refusal}`);
        this.log.warn(`Site protection inside "${site.slug}": Apache refused the new file (${refusal}); the previous one is back`);
        return changed;
      }
      this.written.set(key, digest(files.apache));
      changed = true;
    }
    this.refused.delete(key);
    this.hardeningProblems.delete(site.id);
    return changed;
  }

  /**
   * Whether a file already holds `content`: from the cache when it says so, otherwise read.
   * `missing` - the container predates these files; see syncHardening.
   */
  private async onDisk(
    handle: ServerHandle,
    file: string,
    content: string,
  ): Promise<{ state: 'same' } | { state: 'missing' } | { state: 'differs'; current: string }> {
    const key = `${handle.id}:${file}`;
    if (this.written.get(key) === digest(content)) return { state: 'same' };
    const current = await handle.files.readFile(file).catch(() => null);
    if (current === null) return { state: 'missing' };
    this.written.set(key, digest(current));
    return current === content ? { state: 'same' } : { state: 'differs', current };
  }

  /**
   * Check Apache's configuration inside the running container, then reload it gracefully:
   * requests in flight finish on the old configuration. Null when reloaded - or when the
   * container is not running, since its next start reads the file anyway - otherwise why the
   * check refused it.
   */
  private async reloadApache(handle: ServerHandle, container: string): Promise<string | null> {
    if ((await handle.docker.containerState(container)) !== 'running') return null;
    const check = await handle.docker.exec(container, ['apache2ctl', '-t'], { timeoutMs: 30_000 });
    if (check.exitCode !== 0) {
      // "AH00526: Syntax error on line 2 of <file>:" and, on the next line, what the error is.
      // The one about the server's name is printed on every check and says nothing.
      const lines = `${check.stderr}\n${check.stdout}`.split('\n').map((l) => l.trim());
      const said = lines.filter((l) => l && !/^AH00558/.test(l)).slice(0, 2).join(' ');
      return (said || `exit code ${check.exitCode}`).slice(0, 300);
    }
    await handle.docker.signalContainer(container, 'SIGUSR1');
    return null;
  }

  // ------------------------------------------------------------------ Traefik's side

  /**
   * Traefik's own complaints about the routers this wrote, read from its log with the access
   * log. A rule it could not use is left out on its own - the rest of the site's rules keep
   * working - so this is the only place anyone would hear of it. A service that "does not
   * exist" is a container being recreated, and not a rule's fault.
   */
  noteTraefikLog(chunk: string, now = Date.now()): void {
    if (!chunk.includes('wpl7sec_')) return;
    for (const line of chunk.split('\n')) {
      if (!line.includes('wpl7sec_') || line.trimStart().startsWith('{"ClientAddr"')) continue;
      if (!/\b(ERR|ERROR|error)\b|"level":"error"/.test(line)) continue;
      if (/does not exist|not found|no such/i.test(line)) continue;
      const match = /wpl7sec_([a-z0-9-]+)_([a-z0-9][a-z0-9-]{1,30}[a-z0-9])/.exec(line);
      if (!match) continue;
      const slug = match[2]!;
      const list = (this.rejected.get(slug) ?? []).filter((r) => r.router !== match[0]);
      list.push({ router: match[0], message: line.trim().slice(0, 400), at: now });
      this.rejected.set(slug, list.slice(-10));
    }
  }

  rejections(slug: string): { router: string; message: string; at: number }[] {
    return this.rejected.get(slug) ?? [];
  }

  // ------------------------------------------------------------------ views

  serverStatus(serverId: number): ServerStatus {
    return this.status.get(serverId) ?? { state: 'unknown', message: null, checkedAt: null, syncedAt: null };
  }

  /**
   * Whether the site is protected the way its policy says, and if not, why. `unprotected` is
   * what the site's tab turns into a banner: a policy that asks for protection the server does
   * not have yet - or cannot be given.
   */
  siteStatus(site: SiteRow): { applied: boolean; unprotected: string | null; writtenAt: number | null } {
    const policy = this.policyFor(site.id);
    if (policy.level === 'off' || site.status !== 'running') return { applied: true, unprotected: null, writtenAt: null };
    const state = this.siteStates.get(site.id);
    const server = this.serverStatus(site.serverId);
    if (state?.problem) return { applied: false, unprotected: `Its rules could not be written: ${state.problem}`, writtenAt: null };
    const inside = this.hardeningProblems.get(site.id);
    if (inside) return { applied: false, unprotected: inside, writtenAt: state?.at ?? null };
    if (server.state === 'unreachable') {
      return { applied: false, unprotected: 'The panel cannot reach its server, so changes have not been applied there.', writtenAt: state?.at ?? null };
    }
    if (server.state === 'error') {
      return { applied: false, unprotected: `Its server's rules could not be updated: ${server.message}`, writtenAt: state?.at ?? null };
    }
    if (!state || state.serverId !== site.serverId || state.digest === null) {
      return { applied: false, unprotected: null, writtenAt: null };
    }
    return { applied: true, unprotected: null, writtenAt: state.at };
  }
}

function safeJson<T>(text: string | null | undefined, fallback: T): unknown {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}
