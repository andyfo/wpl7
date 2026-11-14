/**
 * Container apps: a hosted site that is one container from an image of its own (`sites.app =
 * 'container'`). This is everything about one that is not a job: what a create writes, what its
 * page reads, the changes to its settings and routes, its deploy hook, and the two tasks that keep
 * it current (`app-updates`) and bring back one a stopped panel left half-replaced.
 *
 * - Its hosts are the ones its routes name. A host no site holds becomes the app's own, and goes
 *   into its `domains` with its dev hostname, which every app has; a host another site holds is
 *   borrowed, a path of it only, never in `domains` (services/appRoutes.ts hostRefusal).
 * - Secrets (a secret env value, the registry token, the deploy token) are written here and read
 *   only by the jobs, from the rows. No answer, job payload or log carries one.
 */
// @docs sites/container
import path from 'node:path';
import fsp from 'node:fs/promises';
import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  appDeploys,
  appEnv,
  appMounts,
  appRoutes,
  appSettings,
  jobs as jobsTable,
  sites,
  type AppDeployRow,
  type AppEnvRow,
  type AppRouteRow,
  type AppSettingsRow,
  type JobRow,
  type ServerRow,
  type SiteRow,
} from '../db/schema.js';
import type {
  AppDeployOrigin,
  AppEnvInput,
  AppMountInput,
  AppPatchBody,
  AppRouteInput,
  SiteCreateBody,
} from '../../shared/schemas.js';
import { describeRoute } from '../../shared/apps.js';
import type { AppDeployDto, AppDto } from '../../shared/types.js';
import { backupBeforeUpdatesOf } from '../../shared/updateBackups.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateSecret, sameSecret, sha256Hex } from '../lib/crypto.js';
import { containerName, dbIdentifier, isValidSlug, slugify } from '../lib/slug.js';
import { containerApps, containerAppOnly, hostedSites, isContainerApp } from '../lib/siteKind.js';
import type { CoreServices } from './index.js';
import { assertDomainsFree } from './domainGuard.js';
import { appDomains, hostOwners, hostRefusal, plainHttpRefusal } from './appRoutes.js';
import { containerPathProblem, dataDirFor, envProblem, parseDataPaths, parseExtraHosts, appOwner, type DataPath } from './appSpec.js';
import { registryAuthFor, resolveDigest } from './appImages.js';
import { queueReconcile, type HardeningSweep } from './siteHardening.js';
import { containerOfAside } from './siteSpec.js';

/** The deploy hook's header: never the path, which every log writes down (docs/security.md). */
export const DEPLOY_TOKEN_HEADER = 'x-wpl7-deploy-token';
const DEPLOY_TOKEN_PREFIX = 'wpl7d_';

/** How many deploys a page shows. */
const RECENT_DEPLOYS = 10;

/** An uploaded image archive waits this long for the deploy that takes it. */
export const UPLOAD_KEEP_MS = 24 * 3600_000;

/** At most this big an image archive. */
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 ** 3;

/** The route list as the rows are written: ids kept where the input names them. */
interface PlannedRoute {
  id?: number;
  host: string;
  match: AppRouteRow['match'];
  path: string;
  scheme: AppRouteRow['scheme'];
  enabled: boolean;
}

interface RoutePlan {
  routes: PlannedRoute[];
  /** Hosts no other site holds: the app's own. */
  own: Set<string>;
  /** Hosts another site holds, and whose: each route there borrows a path of it. */
  borrowed: Map<string, string>;
}

/** What an app is, for a check: its id (none before it exists), where it runs and its dev hostname. */
interface AppIdentity {
  id: number | null;
  slug: string;
  serverId: number;
  devHostname: string | null;
}

export class AppsService {
  constructor(private readonly s: CoreServices) {}

  private get db() {
    return this.s.db;
  }

  // ------------------------------------------------------------------ reading

  /** The app by its slug, refused with a 409 for any other site. */
  bySlug(slug: string): { site: SiteRow; settings: AppSettingsRow } {
    const site = this.db.select().from(sites).where(eq(sites.slug, slug)).get();
    if (!site) throw notFound(`Site "${slug}" not found`);
    if (!isContainerApp(site)) throw containerAppOnly(slug);
    return { site, settings: this.settingsOf(site.id) };
  }

  settingsOf(siteId: number): AppSettingsRow {
    const row = this.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get();
    if (!row) throw conflict(`Container app #${siteId} has no settings: delete it and create it again.`);
    return row;
  }

  detail(site: SiteRow): AppDto {
    const settings = this.settingsOf(site.id);
    const owners = hostOwners(this.db);
    const routes = this.db.select().from(appRoutes).where(eq(appRoutes.siteId, site.id)).orderBy(asc(appRoutes.position)).all();
    const env = this.db.select().from(appEnv).where(eq(appEnv.siteId, site.id)).orderBy(asc(appEnv.position)).all();
    const mounts = this.db.select().from(appMounts).where(eq(appMounts.siteId, site.id)).orderBy(asc(appMounts.name)).all();
    const routes$ = this.s.appRoutes.state(site.id);
    return {
      source: settings.source,
      reference: settings.reference,
      digest: settings.digest,
      imageId: settings.imageId,
      pendingDigest: settings.pendingDigest,
      registryUser: settings.registryUser,
      registryToken: { secret: true, set: settings.registryToken !== '' },
      port: settings.port,
      env: env.map((v) => ({ name: v.name, value: v.secret ? null : v.value, secret: v.secret === 1, set: v.value !== '' })),
      routes: routes.map((r) => {
        const owner = owners.get(r.host);
        return {
          id: r.id,
          host: r.host,
          match: r.match,
          path: r.path,
          scheme: r.scheme,
          enabled: r.enabled === 1,
          borrowedFrom: owner && owner.id !== site.id ? owner.slug : null,
        };
      }),
      mounts: mounts.map((m) => ({ name: m.name, path: m.containerPath, writable: m.writable === 1, inBackups: m.inBackups === 1, filledAt: m.filledAt })),
      dataPaths: parseDataPaths(settings.dataPaths),
      extraHosts: parseExtraHosts(settings.extraHosts),
      hardening: {
        dropAllCaps: settings.dropAllCaps === 1,
        readOnlyRoot: settings.readOnlyRoot === 1,
        runAs: settings.runAs,
        stopGraceSec: settings.stopGraceSec,
      },
      user: appOwner(settings),
      health: { path: settings.healthPath, host: settings.healthHost, deployCheckPath: settings.deployCheckPath, timeoutSec: settings.healthTimeoutSec },
      updates: { mode: settings.updateMode, checkMinutes: settings.checkMinutes, checkedAt: settings.checkedAt, checkError: settings.checkError },
      deployToken: { set: settings.deployTokenHash !== null, setAt: settings.deployTokenSetAt },
      routesState: routes$.state,
      routesProblem: routes$.problem,
      deploys: this.deploys(site, settings, RECENT_DEPLOYS),
    };
  }

  /** Newest first. */
  deploys(site: Pick<SiteRow, 'id'>, settings?: AppSettingsRow, limit = 50): AppDeployDto[] {
    const s = settings ?? this.settingsOf(site.id);
    const rows = this.db
      .select()
      .from(appDeploys)
      .where(eq(appDeploys.siteId, site.id))
      .orderBy(desc(appDeploys.startedAt), desc(appDeploys.id))
      .limit(limit)
      .all();
    return rows.map((d) => deployToDto(d, s));
  }

  // ------------------------------------------------------------------ checks

  private devDomains(): string[] {
    return this.s.servers
      .listRows()
      .map((r) => r.devDomain)
      .filter(Boolean)
      .concat(this.s.config.devDomain ? [this.s.config.devDomain] : []);
  }

  /** Every check a route list passes: whose each host is, and that no other app on the server takes the same route. */
  planRoutes(app: AppIdentity, input: AppRouteInput[], existing: AppRouteRow[] = []): RoutePlan {
    const owners = hostOwners(this.db);
    const devDomains = [...new Set(this.devDomains())];
    const seen = new Set<string>();
    const own = new Set<string>();
    const borrowed = new Map<string, string>();
    const routes: PlannedRoute[] = [];
    const existingIds = new Set(existing.map((r) => r.id));
    // The routes other apps on the server take, by host, match and path.
    const taken = new Map<string, string>();
    const others = this.db
      .select({ host: appRoutes.host, match: appRoutes.match, path: appRoutes.path, slug: sites.slug })
      .from(appRoutes)
      .innerJoin(sites, eq(sites.id, appRoutes.siteId))
      .where(and(eq(sites.serverId, app.serverId), app.id === null ? undefined : ne(appRoutes.siteId, app.id)))
      .all();
    for (const o of others) taken.set(`${o.host} ${o.match} ${o.path}`, o.slug);
    for (const r of input) {
      if (r.id !== undefined && !existingIds.has(r.id)) throw badRequest(`Route #${r.id} is not one of this app's.`);
      const key = `${r.host} ${r.match} ${r.path}`;
      if (seen.has(key)) throw badRequest(`Two routes take ${describeRoute(r)}.`);
      seen.add(key);
      const owner = owners.get(r.host) ?? null;
      const refusal = hostRefusal({ config: this.s.config, devDomains }, { id: app.id ?? -1, serverId: app.serverId, devHostname: app.devHostname }, r.host, owner, r.match);
      if (refusal) throw conflict(refusal);
      const other = taken.get(key);
      if (other) throw conflict(`${describeRoute(r)} is a route of "${other}" already.`);
      if (owner && owner.id !== app.id && r.host !== app.devHostname) borrowed.set(r.host, owner.slug);
      else own.add(r.host);
      routes.push({ ...(r.id !== undefined ? { id: r.id } : {}), host: r.host, match: r.match, path: r.path, scheme: r.scheme, enabled: r.enabled });
    }
    return { routes, own, borrowed };
  }

  /**
   * The hosts of another site a route list claims that the app does not route on yet: a new claim
   * needs Full (routes/apps.ts), as a domain with another site's DKIM key does.
   */
  newClaims(app: { id: number | null }, plan: RoutePlan): string[] {
    const have = new Set(app.id === null ? [] : this.db.select({ host: appRoutes.host }).from(appRoutes).where(eq(appRoutes.siteId, app.id)).all().map((r) => r.host));
    return [...plan.borrowed.keys()].filter((h) => !have.has(h));
  }

  /** Refused, before anything is written, on a server whose Traefik cannot answer plain http for an app yet. */
  async assertHttpRoutesOn(serverId: number, routes: { scheme: string; enabled?: boolean }[]): Promise<void> {
    if (!routes.some((r) => r.scheme !== 'https')) return;
    const row = this.s.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    const refusal = await plainHttpRefusal(this.s.servers.handleFor(serverId), row, this.s.config.tlsMode);
    if (refusal) throw conflict(refusal);
  }

  /** The environment as it is written: values kept for a secret left without one, every placeholder known. */
  private planEnv(input: AppEnvInput[], existing: AppEnvRow[], database: boolean): { name: string; value: string; secret: boolean }[] {
    const names = new Set<string>();
    const out = input.map((v) => {
      if (names.has(v.name)) throw badRequest(`${v.name} is in the environment twice.`);
      names.add(v.name);
      if (v.value !== undefined) return { name: v.name, value: v.value, secret: v.secret };
      const kept = existing.find((e) => e.name === v.name && e.secret === 1);
      if (!kept || !v.secret) throw badRequest(`${v.name} has no value.`);
      return { name: v.name, value: kept.value, secret: true };
    });
    const problem = envProblem(out, { database });
    if (problem) throw badRequest(problem);
    return out;
  }

  private planMounts(input: AppMountInput[], dataPaths: string[]): AppMountInput[] {
    const names = new Set<string>();
    const paths = new Set(dataPaths);
    for (const m of input) {
      if (names.has(m.name)) throw badRequest(`Two mounts are called ${m.name}.`);
      names.add(m.name);
      const problem = containerPathProblem(m.path);
      if (problem) throw badRequest(`Mount ${m.name}: ${problem}`);
      if (paths.has(m.path)) throw badRequest(`${m.path} is mounted twice.`);
      paths.add(m.path);
    }
    return input;
  }

  /** The data paths as they are kept: each keeps its folder, a new one gets its own. */
  private planDataPaths(input: string[], current: DataPath[]): DataPath[] {
    const out: DataPath[] = [];
    for (const p of input) {
      const problem = containerPathProblem(p);
      if (problem) throw badRequest(`Data path: ${problem}`);
      if (out.some((d) => d.path === p)) throw badRequest(`${p} is a data path twice.`);
      const kept = current.find((d) => d.path === p);
      out.push(kept ?? { path: p, dir: dataDirFor(p, [...current.map((d) => d.dir), ...out.map((d) => d.dir)]), fromImage: false });
    }
    return out;
  }

  private planExtraHosts(input: { host: string; address: string }[]): { host: string; address: string }[] {
    const seen = new Set<string>();
    for (const h of input) {
      if (seen.has(h.host.toLowerCase())) throw badRequest(`${h.host} is a host alias twice.`);
      seen.add(h.host.toLowerCase());
    }
    return input;
  }

  // ------------------------------------------------------------------ creating one

  /** The early, asynchronous half of a create's checks (SitesService.assertCanCreate). */
  async assertCanCreate(body: SiteCreateBody, server: ServerRow): Promise<void> {
    // Left out, the one route is the dev hostname's, over https.
    await this.assertHttpRoutesOn(server.id, body.routes ?? []);
    if (body.image && 'uploadId' in body.image) await this.assertUploadReady(body.image.uploadId);
  }

  /** A create's hosts: its own, which a DKIM key may hold (routes/sites.ts), and those of other sites it borrows a path of, which need Full. */
  hostsOfCreate(body: SiteCreateBody, server: ServerRow): { own: string[]; borrowed: string[] } {
    const slug = this.slugFor(body);
    const devHostname = `${slug}.${server.devDomain || this.s.config.devDomain}`;
    const plan = this.planRoutes({ id: null, slug, serverId: server.id, devHostname }, body.routes ?? this.defaultRoutes(devHostname));
    return { own: [...plan.own].filter((h) => h !== devHostname), borrowed: this.newClaims({ id: null }, plan) };
  }

  private slugFor(body: SiteCreateBody): string {
    const slug = body.slug ?? slugify(body.title);
    if (!slug || !isValidSlug(slug)) {
      throw badRequest(`Could not derive a valid site name${slug ? ` ("${slug}")` : ''}; provide "slug" explicitly (3-32 chars, a-z 0-9 -)`);
    }
    return slug;
  }

  private defaultRoutes(devHostname: string): AppRouteInput[] {
    return [{ host: devHostname, match: 'none', path: '', scheme: 'https', enabled: true }];
  }

  /** Write a new app's rows and queue its site.create. Called by SitesService.create for `app: 'container'`. */
  create(body: SiteCreateBody, server: ServerRow): { site: SiteRow; job: JobRow } {
    if (!body.image) throw badRequest('image is required for a container app');
    const slug = this.slugFor(body);
    const devHostname = `${slug}.${server.devDomain || this.s.config.devDomain}`;
    const plan = this.planRoutes({ id: null, slug, serverId: server.id, devHostname }, body.routes ?? this.defaultRoutes(devHostname));
    const domains = appDomains(devHostname, plan.routes, plan.own);
    assertDomainsFree(this.s, domains, { allowDevHostname: devHostname });
    const database = body.database === true;
    const env = this.planEnv(body.env ?? [], [], database);
    const dataPaths = this.planDataPaths(body.dataPaths ?? [], []);
    const mounts = this.planMounts(body.mounts ?? [], dataPaths.map((d) => d.path));
    const extraHosts = this.planExtraHosts(body.extraHosts ?? []);
    const image = body.image;
    const upload = 'uploadId' in image ? image.uploadId : null;
    if (upload) this.claimUpload(upload);
    const now = Date.now();
    try {
      return this.db.transaction(() => {
        const site = this.db
          .insert(sites)
          .values({
            slug,
            serverId: server.id,
            title: body.title,
            domains: JSON.stringify(domains),
            devHostname,
            // Live once it answers on a host of its own: what decides the move's default, and the list's label.
            isLive: domains.some((d) => d !== devHostname) ? 1 : 0,
            keepDevAlias: 1,
            phpVersion: '',
            app: 'container',
            webRoot: '',
            status: 'provisioning',
            dbName: database ? dbIdentifier(slug) : '',
            dbUser: database ? dbIdentifier(slug) : '',
            dbPassword: database ? generateSecret(24) : '',
            // Every site has a relay login; an app learns it only through {{mail.*}} in its environment.
            mailPassword: generateSecret(24),
            wpAdminUser: null,
            wpAdminEmail: null,
            containerName: containerName(slug),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const hardening = body.hardening ?? {};
        const health = body.health ?? {};
        const updates = body.updates ?? {};
        this.db
          .insert(appSettings)
          .values({
            siteId: site.id,
            source: upload ? 'upload' : 'registry',
            reference: 'reference' in image ? image.reference : '',
            registryUser: 'reference' in image ? (image.registryUser ?? '') : '',
            registryToken: 'reference' in image ? (image.registryToken ?? '') : '',
            // 0: the one port the image exposes, read at the first deploy.
            port: body.port ?? 0,
            stopGraceSec: hardening.stopGraceSec ?? 20,
            runAs: hardening.runAs ?? '',
            dropAllCaps: hardening.dropAllCaps ? 1 : 0,
            readOnlyRoot: hardening.readOnlyRoot ? 1 : 0,
            extraHosts: JSON.stringify(extraHosts),
            dataPaths: JSON.stringify(dataPaths),
            healthPath: health.path ?? '/',
            healthHost: health.host ?? '',
            deployCheckPath: health.deployCheckPath ?? '',
            healthTimeoutSec: health.timeoutSec ?? 60,
            // An upload has no tag to watch.
            updateMode: upload ? 'pinned' : (updates.mode ?? 'auto'),
            checkMinutes: updates.checkMinutes ?? 15,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.writeEnv(site.id, env);
        this.writeRoutes(site.id, plan.routes, now);
        this.writeMounts(site.id, mounts);
        const job = this.s.worker.enqueue('site.create', { siteId: site.id, ...(upload ? { uploadId: upload } : {}) }, { id: site.id, slug, serverId: server.id });
        return { site, job };
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: sites\.slug/.test(err.message)) throw conflict(`Site name "${slug}" is already taken`);
      throw err;
    }
  }

  private writeEnv(siteId: number, env: { name: string; value: string; secret: boolean }[]): void {
    this.db.delete(appEnv).where(eq(appEnv.siteId, siteId)).run();
    env.forEach((v, position) => {
      this.db.insert(appEnv).values({ siteId, position, name: v.name, value: v.value, secret: v.secret ? 1 : 0 }).run();
    });
  }

  private writeRoutes(siteId: number, routes: PlannedRoute[], now: number): void {
    const keep = new Set(routes.flatMap((r) => (r.id !== undefined ? [r.id] : [])));
    const current = this.db.select({ id: appRoutes.id }).from(appRoutes).where(eq(appRoutes.siteId, siteId)).all();
    const gone = current.map((r) => r.id).filter((id) => !keep.has(id));
    if (gone.length > 0) this.db.delete(appRoutes).where(inArray(appRoutes.id, gone)).run();
    routes.forEach((r, position) => {
      const values = { position, host: r.host, match: r.match, path: r.path, scheme: r.scheme, enabled: r.enabled ? 1 : 0, updatedAt: now };
      if (r.id !== undefined) this.db.update(appRoutes).set(values).where(eq(appRoutes.id, r.id)).run();
      else this.db.insert(appRoutes).values({ siteId, createdAt: now, ...values }).run();
    });
  }

  private writeMounts(siteId: number, mounts: AppMountInput[]): void {
    const current = this.db.select().from(appMounts).where(eq(appMounts.siteId, siteId)).all();
    const keep = new Set(mounts.map((m) => m.name));
    const gone = current.filter((m) => !keep.has(m.name)).map((m) => m.id);
    if (gone.length > 0) this.db.delete(appMounts).where(inArray(appMounts.id, gone)).run();
    for (const m of mounts) {
      const values = { containerPath: m.path, writable: m.writable ? 1 : 0, inBackups: m.inBackups ? 1 : 0 };
      const was = current.find((c) => c.name === m.name);
      if (was) this.db.update(appMounts).set(values).where(eq(appMounts.id, was.id)).run();
      else this.db.insert(appMounts).values({ siteId, name: m.name, ...values }).run();
    }
  }

  // ------------------------------------------------------------------ changing one

  private changeable(site: SiteRow): void {
    if (site.status === 'provisioning' || site.status === 'deleting') throw conflict(`Site is ${site.status}; wait for it to finish`);
  }

  /**
   * Save what the body names. A change the container is made with (port, environment, mounts, data
   * paths, host aliases, hardening) is put in force by recreating it, behind the health gate: the
   * job is returned. The rest takes effect as it is saved.
   */
  patch(slug: string, body: AppPatchBody): { job: JobRow | null } {
    const { site, settings } = this.bySlug(slug);
    this.changeable(site);
    const now = Date.now();
    const set: Partial<typeof appSettings.$inferInsert> = { updatedAt: now };
    let recreate = false;
    if (body.reference !== undefined) {
      if (settings.source !== 'registry') throw conflict(`"${slug}" runs an uploaded image: it has no reference to watch.`);
      set.reference = body.reference;
      set.pendingDigest = '';
    }
    if (body.port !== undefined && body.port !== settings.port) {
      set.port = body.port;
      recreate = true;
    }
    const currentPaths = parseDataPaths(settings.dataPaths);
    const dataPaths = body.dataPaths !== undefined ? this.planDataPaths(body.dataPaths, currentPaths) : null;
    if (dataPaths) {
      set.dataPaths = JSON.stringify(dataPaths);
      recreate = true;
    }
    const mountPaths = (dataPaths ?? currentPaths).map((d) => d.path);
    const mounts = body.mounts !== undefined ? this.planMounts(body.mounts, mountPaths) : null;
    if (mounts) recreate = true;
    if (body.extraHosts !== undefined) {
      set.extraHosts = JSON.stringify(this.planExtraHosts(body.extraHosts));
      recreate = true;
    }
    const env = body.env !== undefined ? this.planEnv(body.env, this.db.select().from(appEnv).where(eq(appEnv.siteId, site.id)).all(), site.dbName !== '') : null;
    if (env) recreate = true;
    const h = body.hardening;
    if (h) {
      if (h.dropAllCaps !== undefined) set.dropAllCaps = h.dropAllCaps ? 1 : 0;
      if (h.readOnlyRoot !== undefined) set.readOnlyRoot = h.readOnlyRoot ? 1 : 0;
      if (h.runAs !== undefined) set.runAs = h.runAs;
      if (h.stopGraceSec !== undefined) set.stopGraceSec = h.stopGraceSec;
      recreate = true;
    }
    const health = body.health;
    if (health) {
      if (health.path !== undefined) set.healthPath = health.path;
      if (health.host !== undefined) set.healthHost = health.host;
      if (health.deployCheckPath !== undefined) set.deployCheckPath = health.deployCheckPath;
      if (health.timeoutSec !== undefined) set.healthTimeoutSec = health.timeoutSec;
    }
    if (body.updates) {
      if (body.updates.mode !== undefined) {
        if (settings.source !== 'registry' && body.updates.mode !== 'pinned') throw conflict(`"${slug}" runs an uploaded image: only a new upload deploys it.`);
        set.updateMode = body.updates.mode;
        if (body.updates.mode !== 'ask') set.pendingDigest = '';
      }
      if (body.updates.checkMinutes !== undefined) set.checkMinutes = body.updates.checkMinutes;
    }
    const job = this.db.transaction(() => {
      this.db.update(appSettings).set(set).where(eq(appSettings.siteId, site.id)).run();
      if (env) this.writeEnv(site.id, env);
      if (mounts) this.writeMounts(site.id, mounts);
      // A container that was never made (a create that failed) has nothing to put the change into.
      if (!recreate || (site.status !== 'running' && site.status !== 'stopped')) return null;
      return this.s.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug, serverId: site.serverId });
    });
    if (set.port !== undefined) void this.s.appRoutes.kick(site.serverId);
    return { job };
  }

  /**
   * Replace the route list. No job: the routes file is rewritten, nothing restarts. `guard` asks the
   * caller's access of what needs more: a new own host a DKIM key holds, a path of another site's domain.
   */
  async setRoutes(
    slug: string,
    input: AppRouteInput[],
    guard: { own: (hosts: string[], held: string[]) => void; borrowed: (hosts: string[]) => void },
  ): Promise<void> {
    const { site } = this.bySlug(slug);
    this.changeable(site);
    const existing = this.db.select().from(appRoutes).where(eq(appRoutes.siteId, site.id)).all();
    const plan = this.planRoutes(site, input, existing);
    const held = JSON.parse(site.domains) as string[];
    guard.own([...plan.own].filter((h) => h !== site.devHostname), held);
    const claims = this.newClaims(site, plan);
    if (claims.length > 0) guard.borrowed(claims);
    await this.assertHttpRoutesOn(site.serverId, plan.routes.filter((r) => r.enabled));
    const domains = appDomains(site.devHostname, plan.routes, plan.own);
    assertDomainsFree(this.s, domains, { excludeSiteId: site.id, allowDevHostname: site.devHostname });
    const before = site.domains;
    this.db.transaction(() => {
      this.writeRoutes(site.id, plan.routes, Date.now());
      this.db.update(sites).set({ domains: JSON.stringify(domains), isLive: domains.some((d) => d !== site.devHostname) ? 1 : 0, updatedAt: Date.now() }).where(eq(sites.id, site.id)).run();
    });
    await this.s.appRoutes.kick(site.serverId);
    // Its own hosts are its sender domains.
    if (before !== JSON.stringify(domains)) await this.s.mail.syncMailAuthEverywhere().catch(() => undefined);
  }

  setRegistryAuth(slug: string, body: { username: string; token: string }): void {
    const { site, settings } = this.bySlug(slug);
    if (settings.source !== 'registry') throw conflict(`"${slug}" runs an uploaded image: it pulls from no registry.`);
    if ((body.username === '') !== (body.token === '')) throw badRequest('A login takes a username and a token; both empty removes it.');
    this.db.update(appSettings).set({ registryUser: body.username, registryToken: body.token, updatedAt: Date.now() }).where(eq(appSettings.siteId, site.id)).run();
  }

  /** Whether a deploy backs the app up first (shared/updateBackups.ts): `ask` reads as yes for a deploy nobody is asked about. */
  backupFirstFor(site: SiteRow, origin: AppDeployOrigin, answer?: boolean): boolean {
    const setting = backupBeforeUpdatesOf(site.backupBeforeUpdates, this.s.settings.get('backupBeforeUpdates'));
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return origin === 'user' || origin === 'rollback' || origin === 'upload' ? (answer ?? true) : true;
  }

  /** Deploy now, or roll back to a deploy's image. */
  async deploy(slug: string, body: { deployId?: number; backupFirst?: boolean }): Promise<JobRow> {
    const { site, settings } = this.bySlug(slug);
    this.changeable(site);
    let origin: AppDeployOrigin = 'user';
    if (body.deployId !== undefined) {
      const row = this.db.select().from(appDeploys).where(and(eq(appDeploys.id, body.deployId), eq(appDeploys.siteId, site.id))).get();
      if (!row) throw notFound(`Deploy #${body.deployId} is not one of "${slug}"'s.`);
      if (row.result !== 'ok') throw conflict(`Deploy #${row.id} did not go through: there is nothing of it to go back to.`);
      if (!row.digest) {
        const there = row.imageId ? await this.s.servers.handleFor(site.serverId).docker.imageExists(row.imageId) : false;
        if (!there) throw conflict(`The image of deploy #${row.id} is no longer on the server, and an uploaded image cannot be pulled again. Upload it again.`);
      }
      origin = 'rollback';
    } else if (settings.source !== 'registry') {
      throw conflict(`"${slug}" runs an uploaded image: upload a new one to deploy it.`);
    }
    return this.s.worker.enqueue(
      'app.deploy',
      { siteId: site.id, origin, ...(body.deployId !== undefined ? { deployId: body.deployId } : {}), backupFirst: this.backupFirstFor(site, origin, body.backupFirst) },
      { id: site.id, slug, serverId: site.serverId },
    );
  }

  /** Deploy an uploaded image archive. */
  async deployUpload(slug: string, uploadId: string, backupFirst?: boolean): Promise<JobRow> {
    const { site, settings } = this.bySlug(slug);
    this.changeable(site);
    if (settings.source !== 'upload') throw conflict(`"${slug}" pulls its image from a registry: deploy it from there.`);
    await this.assertUploadReady(uploadId);
    this.claimUpload(uploadId);
    return this.s.worker.enqueue(
      'app.deploy',
      { siteId: site.id, origin: 'upload', uploadId, backupFirst: this.backupFirstFor(site, 'upload', backupFirst) },
      { id: site.id, slug, serverId: site.serverId },
    );
  }

  // ------------------------------------------------------------------ the deploy hook

  /** Make a new hook token, replacing the one there was. Shown once: only its hash is kept. */
  makeDeployToken(slug: string): string {
    const { site } = this.bySlug(slug);
    const token = `${DEPLOY_TOKEN_PREFIX}${generateSecret(32)}`;
    this.db.update(appSettings).set({ deployTokenHash: sha256Hex(token), deployTokenSetAt: Date.now(), updatedAt: Date.now() }).where(eq(appSettings.siteId, site.id)).run();
    return token;
  }

  clearDeployToken(slug: string): void {
    const { site } = this.bySlug(slug);
    this.db.update(appSettings).set({ deployTokenHash: null, deployTokenSetAt: null, updatedAt: Date.now() }).where(eq(appSettings.siteId, site.id)).run();
  }

  /**
   * A call of the deploy hook. While a deploy of the app waits, that one is the answer: it resolves
   * the tag when it starts, so a burst of pushes ends in one deploy of the newest. While the app is
   * busy with anything else, the call is noted, and app-updates deploys once it is free.
   */
  hook(token: string): { outcome: 'queued' | 'waiting' | 'noted'; job: JobRow | null; slug: string } | null {
    if (!token.startsWith(DEPLOY_TOKEN_PREFIX)) return null;
    const hash = sha256Hex(token);
    const row = this.db.select().from(appSettings).where(eq(appSettings.deployTokenHash, hash)).get();
    if (!row?.deployTokenHash || !sameSecret(row.deployTokenHash, hash)) return null;
    const site = this.db.select().from(sites).where(eq(sites.id, row.siteId)).get();
    if (!site || !isContainerApp(site)) return null;
    const waiting = this.db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.siteId, site.id), eq(jobsTable.type, 'app.deploy'), eq(jobsTable.status, 'queued')))
      .get();
    if (waiting) return { outcome: 'waiting', job: waiting, slug: site.slug };
    if (site.status === 'provisioning' || site.status === 'deleting' || this.s.worker.activeSiteJob(site.id)) {
      this.db.update(appSettings).set({ deployWantedAt: Date.now() }).where(eq(appSettings.siteId, site.id)).run();
      return { outcome: 'noted', job: null, slug: site.slug };
    }
    const job = this.s.worker.enqueue(
      'app.deploy',
      { siteId: site.id, origin: 'hook', backupFirst: this.backupFirstFor(site, 'hook') },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    return { outcome: 'queued', job, slug: site.slug };
  }

  // ------------------------------------------------------------------ uploaded images

  /** On the panel's own disk: the archive is read and renamed here before a byte reaches a server (services/imageArchive.ts). */
  uploadDir(): string {
    return path.join(this.s.config.paths.panel, 'app-uploads');
  }

  uploadPath(id: string): string {
    return path.join(this.uploadDir(), `${id}.tar`);
  }

  /** Uploads a deploy has taken: no chunk may land in one any more, and nobody else may take it. */
  private readonly claimed = new Set<string>();

  claimUpload(id: string): void {
    if (this.claimed.has(id)) throw conflict('That upload is being deployed already.');
    this.claimed.add(id);
  }

  releaseUpload(id: string): void {
    this.claimed.delete(id);
  }

  assertUploadFree(id: string): void {
    if (this.claimed.has(id)) throw conflict('That upload is being deployed: it can no longer change.');
  }

  async assertUploadReady(id: string): Promise<void> {
    const stat = await fsp.stat(this.uploadPath(id)).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw conflict('No such upload: send the archive first.');
  }

  /** The uploads nobody deployed within a day. */
  async removeStaleUploads(now = Date.now()): Promise<number> {
    const names = await fsp.readdir(this.uploadDir()).catch(() => [] as string[]);
    let n = 0;
    for (const name of names) {
      const id = name.replace(/\.tar$/, '');
      if (this.claimed.has(id)) continue;
      const file = path.join(this.uploadDir(), name);
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > UPLOAD_KEEP_MS) {
        await fsp.rm(file, { force: true });
        n++;
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ app-updates

  /**
   * The minute tick of `app-updates`: each registry app is due once its interval has passed, and
   * the registry is asked what the reference names (one manifest request, no pull). A new digest
   * is deployed (Automatic), noted for its Update (Ask first), or left (Pinned). A hook call that
   * came while its app was busy is deployed once it is free. A busy app is asked again next tick.
   */
  async updatesTick(now = Date.now()): Promise<{ checked: number; queued: number }> {
    const rows = this.db
      .select({ site: sites, settings: appSettings })
      .from(sites)
      .innerJoin(appSettings, eq(appSettings.siteId, sites.id))
      .where(and(hostedSites(), containerApps(), eq(sites.status, 'running')))
      .all();
    let checked = 0;
    let queued = 0;
    for (const { site, settings } of rows) {
      if (this.s.worker.activeSiteJob(site.id)) continue;
      const enqueue = (origin: AppDeployOrigin) => {
        this.s.worker.enqueue('app.deploy', { siteId: site.id, origin, backupFirst: this.backupFirstFor(site, origin) }, { id: site.id, slug: site.slug, serverId: site.serverId });
        queued++;
      };
      if (settings.deployWantedAt !== null) {
        this.db.update(appSettings).set({ deployWantedAt: null }).where(eq(appSettings.siteId, site.id)).run();
        enqueue('hook');
        continue;
      }
      if (settings.source !== 'registry' || settings.updateMode === 'pinned' || !settings.reference) continue;
      if (settings.checkedAt !== null && now - settings.checkedAt < settings.checkMinutes * 60_000) continue;
      checked++;
      let digest: string;
      try {
        digest = await resolveDigest(this.s.servers.handleFor(site.serverId), settings.reference, registryAuthFor(settings));
      } catch (err) {
        this.db.update(appSettings).set({ checkedAt: now, checkError: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).where(eq(appSettings.siteId, site.id)).run();
        continue;
      }
      const set: Partial<typeof appSettings.$inferInsert> = { checkedAt: now, checkError: null };
      if (digest !== settings.digest) {
        if (settings.updateMode === 'auto') enqueue('auto');
        else if (settings.pendingDigest !== digest) set.pendingDigest = digest;
      } else if (settings.pendingDigest) {
        set.pendingDigest = '';
      }
      this.db.update(appSettings).set(set).where(eq(appSettings.siteId, site.id)).run();
    }
    return { checked, queued };
  }

  // ------------------------------------------------------------------ recovery

  /**
   * After a panel that stopped half-way through a deploy: an app with its old container aside, or a
   * running app with no container (or one that never started), gets a `site.reconcile`, which puts
   * the old one back first (jobs/handlers/apps.ts replaceAppContainer). At boot, then hourly.
   */
  async sweep(worker: Parameters<typeof queueReconcile>[0]): Promise<HardeningSweep> {
    const sweep: HardeningSweep = { queued: [], busy: [] };
    this.failInterruptedDeploys();
    const rows = this.db.select().from(sites).where(and(hostedSites(), containerApps())).all();
    for (const server of this.s.servers.listRows()) {
      if (server.status === 'unreachable' || server.status === 'provisioning') continue;
      const here = rows.filter((r) => r.serverId === server.id);
      if (here.length === 0) continue;
      try {
        const containers = await this.s.servers.handleFor(server.id).docker.listManaged(['wpl7.role=app']);
        const queued = new Set<number>();
        for (const c of containers) {
          const asideOf = containerOfAside(c.name);
          if (!asideOf) continue;
          const site = here.find((r) => r.containerName === asideOf);
          if (!site || queued.has(site.id)) continue;
          queued.add(site.id);
          queueReconcile(worker, site, sweep);
        }
        for (const site of here) {
          if (site.status !== 'running' || queued.has(site.id)) continue;
          const c = containers.find((x) => x.name === site.containerName);
          if (c && c.state !== 'created') continue;
          queueReconcile(worker, site, sweep);
        }
      } catch (err) {
        this.s.log.warn(`Container apps sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (sweep.queued.length > 0) this.s.log.info(`Container apps: ${sweep.queued.length} app(s) queued to get their container back`);
    return sweep;
  }

  /** The image ids an app keeps on its server: what runs and the two deploys before it (dockerCleanup.ts, jobs/handlers/apps.ts). */
  keptImages(siteId: number): string[] {
    const settings = this.db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get();
    const rows = this.db
      .select({ imageId: appDeploys.imageId })
      .from(appDeploys)
      .where(and(eq(appDeploys.siteId, siteId), eq(appDeploys.result, 'ok'), isNotNull(appDeploys.imageId)))
      .orderBy(desc(appDeploys.startedAt), desc(appDeploys.id))
      .all();
    const out = new Set<string>(settings?.imageId ? [settings.imageId] : []);
    for (const r of rows) {
      if (out.size >= 3) break;
      if (r.imageId) out.add(r.imageId);
    }
    return [...out];
  }

  /** Every image the apps on a server keep, but for `except`'s. */
  keptImagesOn(serverId: number, except?: number): Set<string> {
    const apps = this.db.select({ id: sites.id }).from(sites).where(and(eq(sites.serverId, serverId), containerApps())).all();
    return new Set(apps.filter((a) => a.id !== except).flatMap((a) => this.keptImages(a.id)));
  }

  /** Deploys a panel restart cut short: their jobs ended without them (worker.ts reconcileOnBoot). */
  failInterruptedDeploys(): number {
    const running = this.db.select({ id: appDeploys.id, jobId: appDeploys.jobId }).from(appDeploys).where(eq(appDeploys.result, 'running')).all();
    const ids = running
      .filter((r) => {
        if (r.jobId === null) return true;
        const job = this.db.select({ status: jobsTable.status }).from(jobsTable).where(eq(jobsTable.id, r.jobId)).get();
        return !job || (job.status !== 'running' && job.status !== 'queued');
      })
      .map((r) => r.id);
    if (ids.length > 0) this.db.update(appDeploys).set({ result: 'failed', error: 'The panel stopped while this deploy ran.' }).where(inArray(appDeploys.id, ids)).run();
    return ids.length;
  }
}

export function deployToDto(d: AppDeployRow, settings: Pick<AppSettingsRow, 'source'>): AppDeployDto {
  return {
    id: d.id,
    reference: d.reference,
    digest: d.digest,
    imageId: d.imageId,
    startedAt: d.startedAt,
    tookMs: d.tookMs,
    result: d.result,
    origin: d.origin,
    actor: d.actor,
    jobId: d.jobId,
    gapMs: d.gapMs,
    error: d.error,
    logTail: d.logTail,
    // A registry image comes back by its digest; an upload only while its image is on the server, which the deploy checks.
    canRollBack: d.result === 'ok' && (d.digest !== '' || (settings.source === 'upload' && d.imageId !== '')),
  };
}
