/**
 * A container app's routes, as a file of its own in `<SRV_ROOT>/traefik/dynamic` on its server:
 * `app-<slug>.yml`, with a router for each route and scheme, all sending to one service that
 * reaches the container by its name on the app's own network (test/engine/containerApps.test.ts,
 * items 7 and 8). The container itself carries `traefik.enable=false` and no other Traefik label:
 * the Docker provider would give a container with a service a router of its own, on every port.
 *
 * Not on the container's labels: those are fixed when a container is made, so a route switched on
 * or off would recreate it, and a labelled container gets traffic the moment it starts. Here a
 * switch rewrites the file and nothing restarts, and a deploy can hold every route (the service has
 * no server, so Traefik answers 503 itself) until the new container has passed its check.
 *
 * Every change in the folder restarts every rate limiter on the server (services/security.ts), so a
 * file is written only when what it says changes, as the protection's are.
 *
 * Hosts and paths go into rules: every value passes `guard`, and the file is emitted from typed
 * objects (securityConfig.ts renderDynamicFile), since one file that does not parse stops the whole
 * folder.
 */
// @docs sites/container
import crypto from 'node:crypto';
import path from 'node:path';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { APP_LIMITS, APP_ROUTE_PRIORITY, appRoutePriority, appRouterName } from '../../shared/apps.js';
import type { AppRouteMatch, AppRouteScheme } from '../../shared/schemas.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { appRoutes, appSettings, moveCleanups, sites, type AppRouteRow, type ServerRow, type SiteRow } from '../db/schema.js';
import { isUnderDevDomain } from '../jobs/handlers/shared.js';
import { containerApps, isContainerApp } from '../lib/siteKind.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';
import type { DnsService } from './dns.js';
import type { Logger } from './index.js';
import { TRAEFIK_CONTAINER } from './stack.js';
import { guard, renderDynamicFile, RuleValueError, type DynamicConfig, type TraefikRouter } from './securityConfig.js';

export const appRoutesFileName = (slug: string) => `app-${slug}.yml`;
/** A file this module wrote, by name; nothing else in the folder is touched. */
export const APP_ROUTES_FILE_RE = /^app-([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\.yml$/;

/** What a routes file is built from. */
export interface AppRoutesInput {
  slug: string;
  /** The container's name, which Traefik resolves on the app's network. */
  containerName: string;
  port: number;
  routes: Pick<AppRouteRow, 'id' | 'host' | 'match' | 'path' | 'scheme' | 'enabled'>[];
  /** The hosts that are the app's own: the others are borrowed, and their certificate is their site's. */
  ownHosts: string[];
  tlsMode: Config['tlsMode'];
  acmeResolver: string;
  devDomain: string;
  /** Non-empty = dev hostnames share the `*.<dev domain>` certificate (DNS-01). */
  wildcardProvider: string;
  /** Every router stays; the service has no server, so Traefik answers 503 itself. */
  held: boolean;
}

/** The certificate a host's https router asks for, as `labels.ts` asks for a site's. */
function tlsFor(host: string, input: AppRoutesInput): NonNullable<TraefikRouter['tls']> {
  if (input.wildcardProvider && isUnderDevDomain(host, input.devDomain)) {
    const resolver = input.acmeResolver === 'letsencrypt-staging' ? 'letsencrypt-dns-staging' : 'letsencrypt-dns';
    return { certResolver: resolver, domains: [{ main: input.devDomain, sans: [`*.${input.devDomain}`] }] };
  }
  return { certResolver: input.acmeResolver };
}

const ruleOf = (route: { host: string; match: AppRouteMatch; path: string }): string => {
  const host = `Host(\`${guard(route.host, 'host')}\`)`;
  if (route.match === 'none') return host;
  const matcher = route.match === 'exact' ? 'Path' : 'PathPrefix';
  return `${host} && ${matcher}(\`${guard(route.path, 'path')}\`)`;
};

/** The file's content as objects. Throws RuleValueError for a value that must not reach Traefik. */
export function buildAppRoutes(input: AppRoutesInput): DynamicConfig {
  const service = appRouterName('svc', input.slug);
  const routers: Record<string, TraefikRouter> = {};
  const https = input.tlsMode !== 'none';
  for (const route of input.routes) {
    if (!route.enabled) continue;
    const rule = ruleOf(route);
    const priority = appRoutePriority(route);
    if (!https) {
      // Without TLS every router is on web, and a route of either scheme is one router there.
      routers[appRouterName(`r${route.id}`, input.slug)] = { rule, priority, entryPoints: ['web'], service };
      continue;
    }
    if (route.scheme !== 'http') {
      routers[appRouterName(`r${route.id}`, input.slug)] = { rule, priority, entryPoints: ['websecure'], service, tls: tlsFor(route.host, input) };
    }
    if (route.scheme !== 'https') {
      routers[appRouterName(`r${route.id}-http`, input.slug)] = { rule, priority, entryPoints: ['web'], service };
    }
  }
  const url = `http://${guard(input.containerName, 'container')}:${input.port}`;
  return {
    http: {
      routers,
      services: { [service]: { loadBalancer: { servers: input.held ? [] : [{ url }] } } },
    },
  };
}

/** The app's own hosts and its dev hostname, primary first: what goes into `sites.domains`. */
export function appDomains(devHostname: string | null, routes: { host: string }[], ownHosts: Set<string>): string[] {
  const own = [...new Set(routes.map((r) => r.host).filter((h) => ownHosts.has(h)))];
  if (devHostname && !own.includes(devHostname)) own.push(devHostname);
  return own;
}

// ---------------------------------------------------------------------------
// Whose a route's host is

export interface HostOwner {
  host: string;
  /** null = no site has it: it becomes the app's own. */
  owner: Pick<SiteRow, 'id' | 'slug' | 'serverId' | 'kind' | 'devHostname'> | null;
}

/**
 * Why an app may not route `host`, or whose it borrows: a path on a domain another site has is
 * allowed only when that site is hosted on the same server, and never on the panel's own address,
 * another site's dev hostname or a site hosted elsewhere, all of which assertDomainsFree counts as
 * taken (services/domainGuard.ts).
 */
export function hostRefusal(
  deps: { config: Pick<Config, 'panelDomain'>; devDomains: string[] },
  app: Pick<SiteRow, 'id' | 'serverId' | 'devHostname'>,
  host: string,
  owner: HostOwner['owner'],
  match: AppRouteMatch,
): string | null {
  if (deps.config.panelDomain && host === deps.config.panelDomain.toLowerCase()) return `${host} is the panel's own address.`;
  if (!owner || owner.id === app.id) {
    if (host === app.devHostname) return null;
    if (deps.devDomains.includes(host)) return `${host} is a dev domain itself.`;
    if (deps.devDomains.some((d) => isUnderDevDomain(host, d))) return `${host} is under a dev domain: an app's only dev hostname is its own.`;
    return null;
  }
  if (owner.kind !== 'hosted') return `${host} belongs to "${owner.slug}", a site hosted elsewhere.`;
  if (owner.devHostname === host) return `${host} is the dev hostname of "${owner.slug}".`;
  if (owner.serverId !== app.serverId) return `${host} belongs to "${owner.slug}", on another server.`;
  if (match === 'none') return `${host} belongs to "${owner.slug}": a route there needs a path.`;
  return null;
}

/** Every site that has a host, by host (its domains and its dev hostname). */
export function hostOwners(db: Db): Map<string, SiteRow> {
  const out = new Map<string, SiteRow>();
  for (const row of db.select().from(sites).all()) {
    for (const d of JSON.parse(row.domains) as string[]) out.set(d, row);
    if (row.devHostname) out.set(row.devHostname, row);
  }
  return out;
}

/** The apps that route on a site's hosts, and on which: what deleting, moving or renaming that site must not break. */
export function appsRoutingOn(db: Db, site: Pick<SiteRow, 'id' | 'domains' | 'devHostname'>, hosts?: string[]): { slug: string; host: string }[] {
  const mine = new Set(hosts ?? (JSON.parse(site.domains) as string[]));
  if (mine.size === 0) return [];
  const rows = db
    .select({ slug: sites.slug, host: appRoutes.host })
    .from(appRoutes)
    .innerJoin(sites, eq(sites.id, appRoutes.siteId))
    .where(and(inArray(appRoutes.host, [...mine]), ne(appRoutes.siteId, site.id)))
    .all();
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(`${r.slug} ${r.host}`) && seen.add(`${r.slug} ${r.host}`));
}

/** A route that is on, on plain http. */
const onPlainHttp = () => and(eq(appRoutes.enabled, 1), inArray(appRoutes.scheme, ['http', 'both']));

/**
 * The hosts container apps answer plain http on, on a server, sorted: the block list follows them
 * onto web (services/firewallRender.ts webHosts), with the pinned apps' (AppRoutesService
 * webHosts). A move's source counts the ones its forwarder still sends on to the target until the
 * move is finalized (jobs/handlers/move.ts): the target sees the source's address, not the
 * visitor's, so only the source can turn a blocked visitor away.
 */
export function appHttpHosts(db: Db, serverId: number): string[] {
  const http = onPlainHttp();
  const own = db
    .select({ host: appRoutes.host })
    .from(appRoutes)
    .innerJoin(sites, eq(sites.id, appRoutes.siteId))
    .where(and(eq(sites.serverId, serverId), containerApps(), eq(sites.status, 'running'), http))
    .all();
  const forwarded = db
    .select({ host: appRoutes.host })
    .from(moveCleanups)
    .innerJoin(sites, eq(sites.id, moveCleanups.siteId))
    .innerJoin(appRoutes, eq(appRoutes.siteId, sites.id))
    .where(and(eq(moveCleanups.sourceServerId, serverId), eq(moveCleanups.status, 'pending'), isNotNull(moveCleanups.proxyConfigPath), containerApps(), http))
    .all();
  return [...new Set([...own, ...forwarded].map((r) => r.host))].sort();
}

/** The flag deploy/docker-compose.yml gives Traefik so that a router on web can win over the redirect. */
export const REDIRECT_PRIORITY_FLAG = '--entrypoints.web.http.redirections.entrypoint.priority=';

/**
 * Why a server cannot answer plain http for an app yet: a Traefik started from an older compose
 * file still has the redirect at its top priority, which no router beats. It gets the flag only
 * when its stack is brought up again (an update). Read off the running container, as
 * `traefikDnsMode` reads it. Null when it can.
 */
export async function plainHttpRefusal(handle: Pick<ServerHandle, 'docker'>, server: Pick<ServerRow, 'name'>, tlsMode: Config['tlsMode']): Promise<string | null> {
  // Without TLS there is no redirect at all.
  if (tlsMode === 'none') return null;
  const config = await handle.docker.containerConfig(TRAEFIK_CONTAINER);
  if (!config) return `Traefik is not running on "${server.name}".`;
  const flag = config.cmd.find((arg) => arg.startsWith(REDIRECT_PRIORITY_FLAG));
  const priority = flag ? Number(flag.slice(REDIRECT_PRIORITY_FLAG.length)) : NaN;
  if (Number.isFinite(priority) && priority < APP_ROUTE_PRIORITY) return null;
  return `Traefik on "${server.name}" is from before plain http routes. Update the server, then try again.`;
}

/** The refusal for a change to a site that an app routes on. */
export function routedOnRefusal(siteSlug: string, routing: { slug: string; host: string }[]): string | null {
  if (routing.length === 0) return null;
  const apps = [...new Set(routing.map((r) => `"${r.slug}"`))].join(', ');
  const hosts = [...new Set(routing.map((r) => r.host))].join(', ');
  return `The container app ${apps} has routes on ${hosts}, which belongs to "${siteSlug}": change its routes first.`;
}

// ---------------------------------------------------------------------------
// Writing the files

const VERIFY_MS = 10 * 60_000;
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface AppRoutesState {
  /** What the app's file says now: the routes are in force, held for a deploy, or the app has none. */
  state: 'serving' | 'held' | 'none';
  /** Why the file could not be written as it should, if it could not. */
  problem: string | null;
}

export interface AppRoutesServiceOpts {
  /** Coalescing window for kicks; 0 in tests. */
  debounceMs?: number;
  /**
   * A server's plain http hosts (webHosts) are not what its last sync saw, or this sync is its
   * first: the block list's twins on web follow them (services/firewallSync.ts), now rather than at
   * its next recheck.
   */
  onWebHostsChange?: (serverId: number) => void;
  /** An app's file was written or removed: what Traefik said about the one before no longer applies. */
  onFileWritten?: (slug: string) => void;
}

/** What one sync of a server did: what a hold or a release asks of it. */
interface SyncOutcome {
  /** The server's name, for a message. */
  server: string;
  /** The sites whose file this sync wrote, or found as it should be. */
  inForce: Set<number>;
  /** Why a site's file could not be built: it keeps the one it had. */
  problems: Map<number, string>;
  /** Why the sync stopped short, if it did: the server unreachable, a write that failed. */
  error: string | null;
}

/**
 * Why a sync left a site's file other than its plan says, or null. A site the plan has no file for
 * is fine unless the sync stopped short, which may have left its old one there.
 */
const failureOf = (outcome: SyncOutcome, siteId: number): string | null =>
  outcome.problems.get(siteId) ?? (outcome.inForce.has(siteId) ? null : outcome.error);

export class AppRoutesService {
  private readonly held = new Map<number, number>();
  private readonly written = new Map<string, string>();
  /** Per server: the last sync queued there. Each one starts when the one before it is done. */
  private readonly chains = new Map<number, Promise<SyncOutcome>>();
  /** Per server: the sync queued and not started yet, which every request until then rides along with. */
  private readonly waiting = new Map<number, { run: Promise<SyncOutcome>; hurry: () => void }>();
  private readonly verifiedAt = new Map<number, number>();
  private readonly problems = new Map<number, string>();
  /** Sites a job wants routed on a server ahead of the database: a new app, a move's target. */
  private readonly pins = new Map<number, Map<number, number>>();
  /** Per server: the plain http hosts its last sync saw. */
  private readonly webHostsSeen = new Map<number, string>();
  private readonly debounceMs: number;
  private readonly onWebHostsChange: AppRoutesServiceOpts['onWebHostsChange'];
  private readonly onFileWritten: AppRoutesServiceOpts['onFileWritten'];

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly dns: Pick<DnsService, 'wildcardProvider'>,
    private readonly log: Logger,
    opts: AppRoutesServiceOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.onWebHostsChange = opts.onWebHostsChange;
    this.onFileWritten = opts.onFileWritten;
  }

  /**
   * Hold an app's routes: every router stays and Traefik answers 503 until `release`, which a deploy
   * calls once its new container has passed, or the old one is back. Resolves once the file says so.
   * Rejects when it could not be made to, and holds nothing then: the caller must not swap the
   * container, and has nothing to release. In memory only: after a panel restart nothing is held,
   * and the next sync writes the routes.
   */
  async hold(site: Pick<SiteRow, 'id' | 'serverId'>): Promise<void> {
    this.held.set(site.id, (this.held.get(site.id) ?? 0) + 1);
    const outcome = await this.enqueue(site.serverId, false);
    const why = failureOf(outcome, site.id);
    if (why === null) return;
    this.unhold(site.id);
    // A write that failed may still have landed (an atomic rename done before the command timed
    // out), and the file then says held with nothing holding it: the next sync goes at once.
    if (!outcome.problems.has(site.id)) void this.enqueue(site.serverId, false);
    throw new Error(`Could not hold the app's routes on "${outcome.server}": ${why}`);
  }

  /**
   * Let a held app's routes serve again. Never throws: a file that could not be written is logged,
   * and the minute tick writes it.
   */
  async release(site: Pick<SiteRow, 'id' | 'serverId'>): Promise<void> {
    this.unhold(site.id);
    const outcome = await this.enqueue(site.serverId, false);
    const why = failureOf(outcome, site.id);
    if (why !== null) this.log.warn(`Routes of site #${site.id} still held on "${outcome.server}": ${why}. The minute tick tries again.`);
  }

  private unhold(siteId: number): void {
    const n = (this.held.get(siteId) ?? 1) - 1;
    if (n <= 0) this.held.delete(siteId);
    else this.held.set(siteId, n);
  }

  isHeld(siteId: number): boolean {
    return this.held.has(siteId);
  }

  /**
   * Route an app on a server regardless of the database - a new app before its row says it runs, a
   * move's or a restore's target before its cutover. Letting go queues a sync there: the file goes
   * unless the row keeps it, and the block list hears if the hosts on web changed.
   */
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
      void this.kick(serverId);
    };
  }

  /**
   * The hosts the block list follows onto web on a server (services/firewallSync.ts webHosts): the
   * ones appHttpHosts counts, and the pinned apps', whose routes are there before their row says so.
   */
  webHosts(serverId: number): string[] {
    const hosts = appHttpHosts(this.db, serverId);
    const pinned = [...(this.pins.get(serverId)?.keys() ?? [])];
    if (pinned.length === 0) return hosts;
    // Only a container app has routes, and only an app is pinned.
    const more = this.db
      .select({ host: appRoutes.host })
      .from(appRoutes)
      .where(and(inArray(appRoutes.siteId, pinned), onPlainHttp()))
      .all()
      .map((r) => r.host);
    return [...new Set([...hosts, ...more])].sort();
  }

  state(siteId: number): AppRoutesState {
    const problem = this.problems.get(siteId) ?? null;
    const site = this.db.select({ status: sites.status }).from(sites).where(eq(sites.id, siteId)).get();
    if (this.held.has(siteId)) return { state: 'held', problem };
    return { state: site?.status === 'running' ? 'serving' : 'none', problem };
  }

  /** What an app's file says, for its row as it is now: the routes, and the hosts that are its own. */
  inputFor(site: SiteRow, server: Pick<ServerRow, 'devDomain' | 'dnsProvider'>): AppRoutesInput | null {
    const settings = this.db.select().from(appSettings).where(eq(appSettings.siteId, site.id)).get();
    if (!settings) return null;
    const routes = this.db.select().from(appRoutes).where(eq(appRoutes.siteId, site.id)).orderBy(appRoutes.position).all();
    return {
      slug: site.slug,
      containerName: site.containerName,
      port: settings.port,
      routes,
      ownHosts: JSON.parse(site.domains) as string[],
      tlsMode: this.config.tlsMode,
      acmeResolver: this.config.acmeResolver,
      devDomain: server.devDomain,
      wildcardProvider: this.dns.wildcardProvider(server.dnsProvider),
      held: this.held.has(site.id),
    };
  }

  /** The files a server should have: name -> content, or null to keep what is there. */
  private plan(row: ServerRow): Map<string, { siteId: number; content: string | null; problem: string | null }> {
    const pinned = this.pins.get(row.id) ?? new Map<number, number>();
    const apps = this.db.select().from(sites).where(containerApps()).all();
    const out = new Map<string, { siteId: number; content: string | null; problem: string | null }>();
    for (const site of apps) {
      if (!isContainerApp(site)) continue;
      const here = (site.serverId === row.id && site.status === 'running') || pinned.has(site.id);
      if (!here) continue;
      const input = this.inputFor(site, row);
      if (!input) continue;
      try {
        const content = renderDynamicFile(buildAppRoutes(input), [
          `Written by the WPL7 panel: the routes of the container app "${site.slug}"${input.held ? ', held for a deploy' : ''}.`,
          "Change them in the panel (the app's Settings tab) - an edit here is overwritten.",
        ]);
        out.set(appRoutesFileName(site.slug), { siteId: site.id, content, problem: null });
      } catch (err) {
        if (!(err instanceof RuleValueError)) throw err;
        out.set(appRoutesFileName(site.slug), { siteId: site.id, content: null, problem: err.message });
      }
    }
    return out;
  }

  private dir(): string {
    return path.join(this.config.srvRoot, 'traefik', 'dynamic');
  }

  /** Make a server's routes files say what the database says, in turn with every other sync there. Never throws. */
  async syncServer(serverId: number): Promise<void> {
    await this.enqueue(serverId, false);
  }

  /**
   * Queue a sync of a server. One runs at a time on a server, each after the one before, and each
   * plans as it starts: the newest plan is always the one written last. A request while one waits
   * to start rides along with it, since that one plans after the request; one that may not wait (a
   * hold, a release, the tick) cuts its debounce short. Never rejects.
   */
  private enqueue(serverId: number, debounce: boolean): Promise<SyncOutcome> {
    const pending = this.waiting.get(serverId);
    if (pending) {
      if (!debounce) pending.hurry();
      return pending.run;
    }
    let hurried = !debounce || this.debounceMs <= 0;
    let cutShort = () => {
      hurried = true;
    };
    const before = this.chains.get(serverId) ?? Promise.resolve();
    const run = before
      .then(() =>
        hurried
          ? undefined
          : new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, this.debounceMs);
              cutShort = () => {
                clearTimeout(timer);
                resolve();
              };
            }),
      )
      .then(() => {
        this.waiting.delete(serverId);
        return this.sync(serverId);
      })
      // A link that failed would stop every sync after it on the server.
      .catch((err: unknown): SyncOutcome => {
        this.log.warn(`App routes on server #${serverId}: ${errorText(err)}`);
        return { server: `#${serverId}`, inForce: new Set(), problems: new Map(), error: errorText(err) };
      });
    this.waiting.set(serverId, { run, hurry: () => cutShort() });
    this.chains.set(serverId, run);
    return run;
  }

  /** One sync of a server, in its turn (`enqueue`): the plan, made as it starts, then the writes. */
  private async sync(serverId: number): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { server: `#${serverId}`, inForce: new Set(), problems: new Map(), error: null };
    const row = this.servers.rowById(serverId);
    if (!row) {
      this.webHostsSeen.delete(serverId);
      return { ...outcome, error: 'the panel has no such server' };
    }
    outcome.server = row.name;
    if (row.status === 'provisioning') return { ...outcome, error: 'it is still being set up' };
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
          const problem = entry.problem ?? 'cannot be written';
          this.problems.set(entry.siteId, problem);
          outcome.problems.set(entry.siteId, problem);
          this.log.warn(`Routes of site #${entry.siteId} not rewritten: ${problem}`);
          continue;
        }
        this.problems.delete(entry.siteId);
        if (await this.put(handle, path.join(dir, file), entry.content, verify)) {
          wrote++;
          this.fileWritten(file);
        }
        outcome.inForce.add(entry.siteId);
      }
      let removed = 0;
      for (const name of await handle.files.readdir(dir)) {
        if (!APP_ROUTES_FILE_RE.test(name) || plan.has(name)) continue;
        await handle.files.rm(path.join(dir, name));
        this.written.delete(`${serverId}:${path.join(dir, name)}`);
        this.fileWritten(name);
        removed++;
      }
      if (verify) this.verifiedAt.set(serverId, startedAt);
      if (wrote + removed > 0) this.log.info(`App routes on "${row.name}": ${wrote} file(s) written, ${removed} removed`);
    } catch (err) {
      for (const key of [...this.written.keys()]) if (key.startsWith(`${serverId}:`)) this.written.delete(key);
      this.verifiedAt.delete(serverId);
      outcome.error = errorText(err);
      if (!(err instanceof ServerUnreachableError)) this.log.warn(`App routes on "${row.name}": ${outcome.error}`);
    }
    this.noteWebHosts(serverId);
    return outcome;
  }

  private fileWritten(name: string): void {
    const slug = APP_ROUTES_FILE_RE.exec(name)?.[1];
    if (slug) this.onFileWritten?.(slug);
  }

  /**
   * Tell the block list when a server's plain http hosts (webHosts) are not what this last saw
   * there: a route switched to http, an app started, stopped, made, deleted or pinned. The first
   * sight of a server counts as a change: the block list read them as the panel started, before
   * this first ran, and a change in between would go untold. When nothing changed, its sync finds
   * its file as it should be and writes nothing.
   */
  private noteWebHosts(serverId: number): void {
    if (!this.onWebHostsChange) return;
    try {
      const hosts = this.webHosts(serverId).join(' ');
      const before = this.webHostsSeen.get(serverId);
      this.webHostsSeen.set(serverId, hosts);
      if (before !== hosts) this.onWebHostsChange(serverId);
    } catch (err) {
      this.log.warn(`App routes on server #${serverId}: the block list was not told of its http hosts: ${errorText(err)}`);
    }
  }

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

  /** Soon, once: kicks that arrive while one waits ride along. Resolves once a sync started after it is done. */
  kick(serverId: number): Promise<void> {
    return this.enqueue(serverId, true).then(() => undefined);
  }

  /**
   * The minute tick: every server with an app on it is put right, and every other one hourly, for a
   * file an app left behind. A change kicks its server at once; this catches what drifted.
   */
  async tick(now = Date.now()): Promise<{ servers: number }> {
    const withApps = new Set(this.db.select({ serverId: sites.serverId }).from(sites).where(containerApps()).all().map((r) => r.serverId));
    let n = 0;
    for (const row of this.servers.listRows()) {
      if (row.status === 'provisioning' || row.status === 'unreachable') continue;
      if (!withApps.has(row.id) && now - (this.verifiedAt.get(row.id) ?? 0) < 6 * VERIFY_MS) continue;
      await this.syncServer(row.id);
      n++;
    }
    return { servers: n };
  }

  /** Wait for everything queued so far (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}

/** At most this many routes per app (shared/apps.ts). */
export const MAX_APP_ROUTES = APP_LIMITS.routes;
export type { AppRouteMatch, AppRouteScheme };
