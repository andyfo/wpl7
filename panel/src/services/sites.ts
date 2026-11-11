// @docs sites/caching, sites/create, sites/move, sites/overview, sites/settings
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { BackupBeforeUpdates, JobType, SiteCacheBody, SiteCreateBody, SiteLimitsBody } from '../../shared/schemas.js';
import { CACHE_RULE_GROUPS, cacheGroupInUse, cacheOffProblem, parseSiteCacheRules, withCacheRuleIds } from '../../shared/cacheRules.js';
import { isBackupBeforeUpdates } from '../../shared/updateBackups.js';
import type { SiteCacheDto, SiteDetail, SiteLimits, SiteSummary, SiteWpSummary } from '../../shared/types.js';
import { jobs as jobsTable, moveCleanups, plugins, sites, type JobRow, type ServerRow, type SiteRow } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generatePassword, generateSecret } from '../lib/crypto.js';
import { containerName, dbIdentifier, isValidSlug, slugify } from '../lib/slug.js';
import type { CoreServices } from './index.js';
import type { JobWorker } from '../jobs/worker.js';
import { siteScheme } from './labels.js';
import { assertDomainsFree } from './domainGuard.js';
import { PHP_NO_MAINTENANCE, assertApp, assertKind, hasDatabase, hostedSites, isExternal, isPhpSite, phpNoPageCache, type SiteApps, type SiteKinds } from '../lib/siteKind.js';
import type { DockerPort } from './docker.js';
import { SITE_ROOT_IN_CONTAINER } from './siteHardening.js';
import { asSiteUser } from './wp.js';
import { RuntimeRefusedError, applySiteCaches, effectivePageCache, siteContainerStack } from './siteCaches.js';
import { assertPhpImage, defaultSiteLimits, limitsChange, siteImage, siteRuntimeFrom, type OwnSiteLimits } from './siteSpec.js';

/** The server a new site goes on: the one asked for, else the default in Settings - and it has to be up. */
export function resolveTargetServer(s: Pick<CoreServices, 'settings' | 'servers'>, requestedId?: number): ServerRow {
  const serverId = requestedId ?? s.settings.get('defaultServerId') ?? 1;
  const server = s.servers.rowById(serverId);
  if (!server) {
    throw requestedId !== undefined
      ? notFound(`Server #${serverId} not found`)
      : badRequest(`Default server #${serverId} no longer exists; update Settings`);
  }
  if (server.status !== 'ok') {
    throw conflict(`Server "${server.name}" is ${server.status}; pick another server`);
  }
  return server;
}

/**
 * Whether a PHP site's web root is there, asked inside its container as www-data, as the Files tab
 * asks. Apache answers every request with a 404 while it is not (services/siteHardening.ts).
 */
async function webRootExists(docker: Pick<DockerPort, 'exec'>, site: Pick<SiteRow, 'containerName' | 'webRoot'>): Promise<boolean> {
  const res = await docker.exec(site.containerName, ['test', '-d', `${SITE_ROOT_IN_CONTAINER}/${site.webRoot}`], { user: '33:33', timeoutMs: 10_000 });
  return res.exitCode === 0;
}

/** A backup reads the files and the database, and a save here reloads nothing it depends on. */
const CACHE_SAFE_JOBS = new Set(['backup.create']);

export class SitesService {
  constructor(
    private readonly s: CoreServices,
    private readonly worker: JobWorker,
  ) {}

  private get db() {
    return this.s.db;
  }

  /**
   * The site by its slug. An external site (hosted elsewhere, through WPL7 Connect) is refused
   * with a 409 unless the caller asks for either kind: only the routes that work for both pass
   * `{ kinds: 'any' }`, so a new route that forgets is safe rather than handed an empty container.
   * A PHP site is refused with a 409 where the caller asks for `{ app: 'wordpress' }`.
   */
  bySlug(slug: string, opts: { kinds?: SiteKinds; app?: SiteApps } = {}): SiteRow {
    const site = this.db.select().from(sites).where(eq(sites.slug, slug)).get();
    if (!site) throw notFound(`Site "${slug}" not found`);
    return assertApp(assertKind(site, opts.kinds), opts.app);
  }

  private assertDomainsFree(domains: string[], excludeSiteId?: number, allowDevHostname?: string | null): void {
    assertDomainsFree(this.s, domains, { excludeSiteId, allowDevHostname });
  }

  /**
   * The early half of the image check for a new PHP site (services/siteSpec.ts siteContainerSpec):
   * a server whose site image is from before PHP sites refuses one before anything is made. An
   * image the server doesn't have yet is fine: the create job builds or pulls it at the panel's own
   * version, which can run one.
   */
  async assertCanCreate(body: SiteCreateBody): Promise<void> {
    if (body.app !== 'php') return;
    const server = resolveTargetServer(this.s, body.serverId);
    const phpVersion = body.phpVersion ?? this.s.settings.get('defaultPhpVersion');
    await assertPhpImage(this.s.servers.handleFor(server.id), siteImage(phpVersion), { missingIsFine: true });
  }

  /**
   * The early image check for a PHP site that is to get a container on `serverId` from the image of
   * `phpVersion`: a move's target, a PHP version change. Refused, before anything is queued, where
   * that image is from before PHP sites; one the server doesn't have yet is fine.
   */
  async assertPhpImageOn(site: SiteRow, serverId: number, phpVersion = site.phpVersion): Promise<void> {
    if (!isPhpSite(site) || !this.s.servers.rowById(serverId)) return;
    await assertPhpImage(this.s.servers.handleFor(serverId), siteImage(phpVersion), { missingIsFine: true });
  }

  create(body: SiteCreateBody): { site: SiteRow; job: JobRow } {
    // Left out by callers inside the panel that predate PHP sites.
    const php = (body.app ?? 'wordpress') === 'php';
    const offered = this.s.settings.get('phpVersions') ?? [];
    const phpVersion = body.phpVersion ?? this.s.settings.get('defaultPhpVersion');
    if (!offered.includes(phpVersion)) {
      throw badRequest(`PHP ${phpVersion} is not offered (available: ${offered.join(', ')})`);
    }
    const locale = body.locale ?? this.s.settings.get('defaultLocale') ?? 'en_US';
    // WordPress's administrator: a PHP site has none.
    const adminEmail = php ? null : (body.adminEmail ?? (this.s.settings.get('defaultAdminEmail') || null));
    if (!php && !adminEmail) throw badRequest('No default admin email is set in Settings; provide "adminEmail"');
    const server = resolveTargetServer(this.s, body.serverId);

    const slug = body.slug ?? slugify(body.domainMode === 'custom' ? body.domains![0]! : body.title);
    if (!slug || !isValidSlug(slug)) {
      throw badRequest(
        `Could not derive a valid site name${slug ? ` ("${slug}")` : ''}; provide "slug" explicitly (3-32 chars, a-z 0-9 -)`,
      );
    }

    let domains: string[];
    let devHostname: string | null;
    if (body.domainMode === 'dev') {
      devHostname = `${slug}.${server.devDomain || this.s.config.devDomain}`;
      domains = [devHostname];
      this.assertDomainsFree(domains, undefined, devHostname);
    } else {
      devHostname = null;
      domains = [...new Set(body.domains!)];
      this.assertDomainsFree(domains);
    }

    const adminPassword = body.adminPassword ?? generatePassword(20);
    const passwordGenerated = !body.adminPassword;

    // Resolve plugin selection to concrete slugs/zips now, so the job is self-contained. No
    // catalog choice at all is the catalog's defaults, in the order the wizard lists them. A PHP
    // site gets none.
    const catalogIds = php
      ? []
      : (body.plugins?.catalogIds ??
        this.db
          .select({ id: plugins.id })
          .from(plugins)
          .where(eq(plugins.isDefault, 1))
          .orderBy(asc(plugins.id))
          .all()
          .map((p) => p.id));
    const pluginSlugs: string[] = [];
    const pluginZipPaths: string[] = [];
    for (const id of catalogIds) {
      const row = this.db.select().from(plugins).where(eq(plugins.id, id)).get();
      if (!row) throw badRequest(`Catalog plugin #${id} does not exist`);
      if (row.kind === 'zip' && row.zipPath) pluginZipPaths.push(row.zipPath);
      else pluginSlugs.push(row.slug);
    }
    for (const extra of body.plugins?.extraWporgSlugs ?? []) {
      if (!pluginSlugs.includes(extra)) pluginSlugs.push(extra);
    }

    // A WordPress site always has its own database; a PHP site only when asked. Without one the
    // three columns are '' (lib/siteKind.ts hasDatabase), and it can be made later.
    const withDatabase = !php || body.database === true;
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
            isLive: body.domainMode === 'custom' ? 1 : 0,
            keepDevAlias: 1,
            phpVersion,
            app: php ? 'php' : 'wordpress',
            webRoot: php ? (body.webRoot ?? '') : '',
            ...(php ? {} : { locale }),
            status: 'provisioning',
            dbName: withDatabase ? dbIdentifier(slug) : '',
            dbUser: withDatabase ? dbIdentifier(slug) : '',
            dbPassword: withDatabase ? generateSecret(24) : '',
            // The site's own relay credential; the relay uses it to tell whose mail this is,
            // and refuses senders belonging to another site (services/mailAuth.ts).
            mailPassword: generateSecret(24),
            wpAdminUser: php ? null : body.adminUser,
            wpAdminEmail: adminEmail,
            containerName: containerName(slug),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const job = this.worker.enqueue(
          'site.create',
          php
            ? { siteId: site.id }
            : {
                siteId: site.id,
                adminPassword,
                passwordGenerated,
                pluginSlugs,
                pluginZipPaths,
                discourageSearchEngines: body.discourageSearchEngines ?? true,
              },
          { id: site.id, slug, serverId: server.id },
        );
        return { site, job };
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: sites\.slug/.test(err.message)) {
        throw conflict(`Site name "${slug}" is already taken`);
      }
      throw err;
    }
  }

  delete(slug: string, finalBackup: boolean, deleteBackups = false): JobRow {
    const site = this.bySlug(slug, { kinds: 'any' });
    if (isExternal(site)) {
      // Remove from panel: the site keeps running where it is, so there is no final backup to take.
      if (site.status === 'deleting') throw conflict(`"${site.slug}" is being removed already.`);
      return this.worker.enqueue('site.delete', { siteId: site.id, finalBackup: false, deleteBackups }, { id: site.id, slug, serverId: site.serverId });
    }
    // An import that is making the site, or failed part-way, owns what there is of it: its
    // staging folder and its record. Deleting the import clears both.
    if (this.s.imports.activeForSite(site.id)) {
      throw conflict('This site is being imported. Delete the import under Sites → Import site first.');
    }
    // A recently-moved site still has a parked copy on its old server, and site.delete
    // tears that down too. Claim the source lane as well, or that teardown races whatever
    // else the source server is doing.
    const pending = this.db
      .select({ sourceServerId: moveCleanups.sourceServerId })
      .from(moveCleanups)
      .where(and(eq(moveCleanups.siteId, site.id), eq(moveCleanups.status, 'pending')))
      .get();
    return this.worker.enqueue(
      'site.delete',
      { siteId: site.id, finalBackup, deleteBackups },
      { id: site.id, slug, serverId: site.serverId },
      pending && pending.sourceServerId !== site.serverId
        ? { serverId: site.serverId, auxServerId: pending.sourceServerId }
        : undefined,
    );
  }

  action(slug: string, action: 'start' | 'stop' | 'restart'): JobRow {
    const site = this.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site is ${site.status}; wait for it to finish`);
    }
    const type = action === 'start' ? 'site.start' : action === 'stop' ? 'site.stop' : 'site.restart';
    return this.worker.enqueue(type, { siteId: site.id }, { id: site.id, slug, serverId: site.serverId });
  }

  changePhp(slug: string, phpVersion: string): JobRow {
    const site = this.bySlug(slug);
    const offered = this.s.settings.get('phpVersions') ?? [];
    if (!offered.includes(phpVersion)) {
      throw badRequest(`PHP ${phpVersion} is not offered (available: ${offered.join(', ')})`);
    }
    return this.worker.enqueue(
      'site.changePhp',
      { siteId: site.id, phpVersion },
      { id: site.id, slug, serverId: site.serverId },
    );
  }

  /**
   * Re-apply the current isolation policy (networks, capability drops, resource ceilings,
   * mail credential) to one site. The way a site created under an older policy catches up
   * without waiting for an unrelated operation to recreate its container.
   */
  reconcile(slug: string): JobRow {
    const site = this.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site is ${site.status}; wait for it to finish`);
    }
    return this.worker.enqueue('site.reconcile', { siteId: site.id, retrySwitch: true }, { id: site.id, slug, serverId: site.serverId });
  }

  /** Reconcile every site, newest last so a fleet-wide pass is predictable in the job list. */
  reconcileAll(): JobRow[] {
    const rows = this.s.db.select().from(sites).where(hostedSites()).orderBy(asc(sites.id)).all();
    const jobs: JobRow[] = [];
    for (const site of rows) {
      if (site.status === 'provisioning' || site.status === 'deleting') continue;
      try {
        jobs.push(
          this.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId }),
        );
      } catch {
        // Another job holds this site's lane; it will be picked up by the next pass.
      }
    }
    return jobs;
  }

  /**
   * Bring the existing site containers to their CPU, memory and process ceilings: one
   * server.applySiteLimits per server with sites on it - or, given a site, for its server. A
   * move under way builds a site's container on its other server from the limits it read when
   * it started, so that server gets one too, last: the move holds its lane, so it runs once the
   * move is over, with the site there. A server that already has one waiting to start is not
   * given a second - that one reads the limits when it starts, so it is returned in its place.
   */
  applyLimits(site?: Pick<SiteRow, 'id' | 'serverId'>): JobRow[] {
    const hosting = site
      ? [site.serverId]
      : this.db
          .selectDistinct({ serverId: sites.serverId })
          .from(sites)
          .where(hostedSites())
          .all()
          .map((row) => row.serverId);
    const movingTo = this.db
      .select({ serverId: jobsTable.auxServerId })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.type, 'site.move'),
          inArray(jobsTable.status, ['queued', 'running']),
          site ? eq(jobsTable.siteId, site.id) : undefined,
        ),
      )
      .all()
      .flatMap((job) => (job.serverId === null ? [] : [job.serverId]));
    return [...new Set([...hosting, ...movingTo])].map((serverId) => {
      const waiting = this.db
        .select()
        .from(jobsTable)
        .where(
          and(eq(jobsTable.type, 'server.applySiteLimits'), eq(jobsTable.serverId, serverId), eq(jobsTable.status, 'queued')),
        )
        .get();
      return waiting ?? this.worker.enqueue('server.applySiteLimits', { serverId }, undefined, { serverId });
    });
  }

  move(slug: string, body: { targetServerId: number; quiesce?: 'maintenance' | 'stop' | 'none' }): JobRow {
    const site = this.bySlug(slug);
    if (site.status !== 'running' && site.status !== 'stopped') {
      throw conflict(`Site is ${site.status}; only running or stopped sites can move`);
    }
    if (body.targetServerId === site.serverId) {
      throw badRequest('The site is already on that server');
    }
    const target = this.s.servers.rowById(body.targetServerId);
    if (!target) throw notFound(`Server #${body.targetServerId} not found`);
    if (target.status !== 'ok') throw conflict(`Server "${target.name}" is ${target.status}`);
    const pending = this.s.db
      .select({ id: moveCleanups.id })
      .from(moveCleanups)
      .where(and(eq(moveCleanups.siteId, site.id), eq(moveCleanups.status, 'pending')))
      .get();
    if (pending) {
      throw conflict('A previous move is still awaiting cleanup; finalize it first (site page banner)');
    }
    const isLive = site.isLive === 1;
    // Maintenance mode is WordPress's. A live PHP site is stopped while it is copied: a short
    // outage, and nothing written meanwhile is lost.
    if (body.quiesce === 'maintenance' && isPhpSite(site)) throw conflict(PHP_NO_MAINTENANCE(site.slug));
    const quiesce = body.quiesce ?? (isLive ? (isPhpSite(site) ? 'stop' : 'maintenance') : 'none');
    // The old copy is never torn down inside the move itself - see siteMovePayload.decommission.
    const decommission = 'deferred';
    return this.worker.enqueue(
      'site.move',
      {
        siteId: site.id,
        sourceServerId: site.serverId,
        targetServerId: body.targetServerId,
        quiesce,
        decommission,
      },
      { id: site.id, slug, serverId: site.serverId },
      { serverId: site.serverId, auxServerId: body.targetServerId },
    );
  }

  /**
   * Take one site in or out of the scheduled backup run. Not a job: nothing on the server
   * changes, only whether the cron enqueues this site - so it applies the moment it returns.
   */
  setBackupsEnabled(slug: string, enabled: boolean): SiteRow {
    const site = this.bySlug(slug, { kinds: 'any' });
    return this.db
      .update(sites)
      .set({ backupsEnabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  /**
   * After how many days this site's backups are deleted: null follows the panel's setting, 0 keeps
   * them. Not a job either: the nightly housekeeping reads it when it deletes old backups.
   */
  setBackupKeepDays(slug: string, days: number | null): SiteRow {
    const site = this.bySlug(slug, { kinds: 'any' });
    return this.db
      .update(sites)
      .set({ backupKeepDays: days, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  /**
   * Whether an update of this site backs it up first: null follows the panel's setting. Not a job:
   * the update routes read it when an update is asked for.
   */
  setBackupBeforeUpdates(slug: string, value: BackupBeforeUpdates | null): SiteRow {
    const site = this.bySlug(slug, { kinds: 'any' });
    return this.db
      .update(sites)
      .set({ backupBeforeUpdates: value, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  /** The sites that decide for themselves whether an update backs them up first, by name. */
  ownBackupBeforeUpdates(): { slug: string; value: BackupBeforeUpdates }[] {
    return this.db
      .select({ slug: sites.slug, value: sites.backupBeforeUpdates })
      .from(sites)
      .where(isNotNull(sites.backupBeforeUpdates))
      .orderBy(asc(sites.slug))
      .all()
      .flatMap((site) => (isBackupBeforeUpdates(site.value) ? [{ slug: site.slug, value: site.value }] : []));
  }

  /**
   * Set one site's own container limits: each left out stays as it is, null puts it back on
   * Settings. Not a job itself: a container built from now on reads them, and the site's server
   * gets the server.applySiteLimits that changes the container it has - unless what the
   * container should have is the same as before, when `job` is null.
   */
  setLimits(slug: string, body: SiteLimitsBody): { site: SiteRow; job: JobRow | null } {
    const site = this.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site is ${site.status}; wait for it to finish`);
    }
    const own: OwnSiteLimits = {
      cpuLimit: body.cpuLimit === undefined ? site.cpuLimit : body.cpuLimit,
      memoryLimitMb: body.memoryLimitMb === undefined ? site.memoryLimitMb : body.memoryLimitMb,
      pidsLimit: body.pidsLimit === undefined ? site.pidsLimit : body.pidsLimit,
    };
    const row = this.db
      .update(sites)
      .set({ ...own, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
    const unchanged = limitsChange(siteRuntimeFrom(this.s.settings, site), siteRuntimeFrom(this.s.settings, own)) === 'none';
    if (unchanged) return { site: row, job: null };
    // The last is the one that reaches the container: while the site moves, it is the pass on
    // the server it is moving to.
    return { site: row, job: this.applyLimits(site).at(-1) ?? null };
  }

  /** The sites with container limits of their own, by name: null where one follows Settings. */
  ownSiteLimits(): ({ slug: string } & SiteLimits<number | null>)[] {
    return this.db
      .select({ slug: sites.slug, cpuLimit: sites.cpuLimit, memoryLimitMb: sites.memoryLimitMb, pidsLimit: sites.pidsLimit })
      .from(sites)
      .where(and(hostedSites(), or(isNotNull(sites.cpuLimit), isNotNull(sites.memoryLimitMb), isNotNull(sites.pidsLimit))))
      .orderBy(asc(sites.slug))
      .all();
  }

  /** The sites that keep their backups for a time of their own, by name. */
  ownBackupKeepDays(): { slug: string; days: number }[] {
    return this.db
      .select({ slug: sites.slug, days: sites.backupKeepDays })
      .from(sites)
      .where(isNotNull(sites.backupKeepDays))
      .orderBy(asc(sites.slug))
      .all()
      .flatMap((site) => (site.days === null ? [] : [{ slug: site.slug, days: site.days }]));
  }

  /**
   * Take one site in or out of the offsite copies. Existing copies are kept: switching this
   * off means "stop sending new ones", not "delete what is already in the bucket".
   */
  setOffsiteEnabled(slug: string, enabled: boolean): SiteRow {
    const site = this.bySlug(slug, { kinds: 'any' });
    return this.db
      .update(sites)
      .set({ offsiteEnabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  /**
   * Change the domains a site answers on; `goLive` also marks it live. `allowSearchEngines` only
   * counts with `goLive`: a plain domain edit leaves WordPress's search engine setting alone.
   */
  updateDomains(
    slug: string,
    domains: string[],
    keepDevAlias: boolean,
    goLive: boolean,
    opts: { manageDns?: boolean; allowSearchEngines?: boolean } = {},
  ): JobRow {
    const site = this.bySlug(slug);
    const unique = [...new Set(domains)];
    this.assertDomainsFree(unique, site.id, site.devHostname);
    return this.worker.enqueue(
      'site.updateDomains',
      {
        siteId: site.id,
        domains: unique,
        keepDevAlias,
        goLive,
        manageDns: opts.manageDns ?? false,
        allowSearchEngines: goLive && (opts.allowSearchEngines ?? false),
      },
      { id: site.id, slug, serverId: site.serverId },
    );
  }

  private serverNames(): Map<number, string> {
    return new Map(this.s.servers.listRows().map((r) => [r.id, r.name]));
  }

  toSummary(
    site: SiteRow,
    serverNames?: Map<number, string>,
    recentTraffic?: Map<number, { visitors: number; pageViews: number }>,
    wpSummaries?: Map<number, SiteWpSummary>,
  ): SiteSummary {
    const domains = JSON.parse(site.domains) as string[];
    const monitor = this.s.monitor.latestFor(site.id);
    const names = serverNames ?? this.serverNames();
    const traffic = (recentTraffic ?? this.s.traffic.recentBySite()).get(site.id) ?? null;
    const wp = (wpSummaries ?? this.s.wpInventory.summaries()).get(site.id) ?? null;
    return {
      id: site.id,
      slug: site.slug,
      title: site.title,
      serverId: site.serverId,
      serverName: names.get(site.serverId) ?? `#${site.serverId}`,
      primaryDomain: domains[0] ?? '',
      domains,
      devHostname: site.devHostname,
      isLive: site.isLive === 1,
      phpVersion: site.phpVersion,
      phpRelease: site.phpRelease,
      status: site.status as SiteSummary['status'],
      up: monitor?.up ?? null,
      httpStatus: monitor?.httpStatus ?? null,
      lastCheckedAt: monitor?.lastCheckedAt ?? null,
      diskBytes: site.diskBytes,
      recentTraffic: traffic,
      wp,
      kind: site.kind as SiteSummary['kind'],
      app: site.app,
      external: this.s.connections.externalSummary(site),
      backupKeepDays: site.backupKeepDays,
      backupBeforeUpdates: isBackupBeforeUpdates(site.backupBeforeUpdates) ? site.backupBeforeUpdates : null,
      createdAt: site.createdAt,
    };
  }

  list(): SiteSummary[] {
    const names = this.serverNames();
    // Every lookup here is one query for the whole list, not one per site.
    const traffic = this.s.traffic.recentBySite();
    const wp = this.s.wpInventory.summaries();
    return this.db.select().from(sites).all().map((s) => this.toSummary(s, names, traffic, wp));
  }

  async detail(slug: string): Promise<SiteDetail> {
    const site = this.bySlug(slug, { kinds: 'any' });
    const summary = this.toSummary(site);
    if (isExternal(site)) return this.externalDetail(site, summary);
    let containerState: SiteDetail['containerState'];
    let stack: SiteDetail['stack'] = null;
    let webRootMissing: SiteDetail['webRootMissing'] = site.webRoot === '' ? false : null;
    try {
      const { docker } = this.s.servers.handleFor(site.serverId);
      containerState = await docker.containerState(site.containerName);
      stack = await siteContainerStack(docker, site.containerName);
      if (site.webRoot !== '' && containerState === 'running') webRootMissing = !(await webRootExists(docker, site));
    } catch (err) {
      // The registry still answers when the hosting server cannot be reached: the metadata,
      // backups and recovery actions are exactly what an operator needs at that moment.
      this.s.log.warn(
        `Site "${site.slug}": could not inspect its container (${err instanceof Error ? err.message : err}); ` +
          `reporting its state as unknown`,
      );
      containerState = 'unknown';
    }
    const cleanup = this.s.db
      .select()
      .from(moveCleanups)
      .where(and(eq(moveCleanups.siteId, site.id), eq(moveCleanups.status, 'pending')))
      .get();
    return {
      ...summary,
      locale: site.locale,
      adminUser: site.wpAdminUser,
      adminEmail: site.wpAdminEmail,
      dbName: site.dbName,
      hasDatabase: hasDatabase(site),
      webRoot: site.webRoot,
      webRootMissing,
      tablePrefix: site.tablePrefix,
      containerState,
      url: `${siteScheme(this.s.config.tlsMode)}://${summary.primaryDomain}`,
      keepDevAlias: site.keepDevAlias === 1,
      backupsEnabled: site.backupsEnabled === 1,
      offsiteEnabled: site.offsiteEnabled === 1,
      mailSuspended: site.mailSuspendedAt
        ? { since: site.mailSuspendedAt, reason: site.mailSuspendReason ?? 'Outbound mail suspended' }
        : null,
      pendingMoveCleanup: cleanup
        ? {
            id: cleanup.id,
            sourceServerName:
              this.s.servers.rowById(cleanup.sourceServerId)?.name ?? `#${cleanup.sourceServerId}`,
            targetIp: cleanup.targetIp,
            hostsPending: JSON.parse(cleanup.verifyHosts) as string[],
            since: cleanup.createdAt,
          }
        : null,
      importSource: this.s.imports.sourceForSite(site.id),
      external: null,
      activeJob: this.activeJob(site),
      limits: {
        own: { cpuLimit: site.cpuLimit, memoryLimitMb: site.memoryLimitMb, pidsLimit: site.pidsLimit },
        defaults: defaultSiteLimits(this.s.settings),
      },
      stack,
      // A restore or a move can put it on stack 2 by another way than the switch, which is the only
      // thing that clears this. A container on stack 2 has nothing left to report.
      stackSwitchError: stack === 2 ? null : site.stackSwitchError,
      cache: this.cacheDto(site, stack, containerState),
    };
  }

  private cacheDto(site: SiteRow, stack: SiteDetail['stack'], containerState: SiteDetail['containerState']): SiteCacheDto {
    const rules = parseSiteCacheRules(site.cacheRules);
    const components = [...this.s.wpInventory.componentsFor(site.id).values()];
    const installed = components.filter((c) => c.kind === 'plugin').map((c) => c.slug);
    // Redis Object Cache's own drop-in counts as nothing in the way: `wp redis enable` takes it over.
    const foreign = components.find((c) => c.kind === 'plugin' && c.status === 'dropin' && c.slug === 'object-cache.php' && !/redis object cache/i.test(c.title));
    const oldSetup = 'This site still runs the old PHP setup.';
    return {
      page: site.pageCache === 'on' || site.pageCache === 'off' ? site.pageCache : 'default',
      pageOn: effectivePageCache(this.s.settings, site),
      pageDefault: this.s.settings.get('sitePageCache') ?? true,
      offReason: rules.offReason,
      keepSeconds: rules.keepSeconds,
      keepDefaultSeconds: Number(this.s.settings.get('sitePageCacheSeconds')),
      off: rules.off,
      own: rules.own,
      groupsInUse: CACHE_RULE_GROUPS.filter((group) => cacheGroupInUse(group, installed)).map((group) => group.id),
      object: site.objectCache === 1,
      objectBlocked: stack === 1 ? oldSetup : !site.objectCache && foreign ? `Another object cache is installed: ${foreign.title}.` : null,
      liveBlocked: stack === 1 ? oldSetup : stack === 2 && containerState === 'running' ? null : 'The site is not running.',
    };
  }

  /**
   * A site's caches. Rules, keep time and the page cache's switch take effect here and now, in the
   * running container; the object cache queues a job, because it installs a plugin.
   *
   * The site is held meanwhile, so that this doesn't reload a container a job is replacing, and a
   * save that didn't make it to the container leaves the row as it was.
   */
  async setCache(slug: string, body: SiteCacheBody): Promise<{ job: JobRow | null }> {
    const problem = body.off ? cacheOffProblem(body.off) : null;
    if (problem) throw badRequest(problem, [{ path: 'off', message: problem }]);
    // One save at a time, each reading the row the one before it left.
    return this.worker.inRuntimeTurn(this.bySlug(slug).id, () => this.saveCache(slug, body));
  }

  private async saveCache(slug: string, body: SiteCacheBody): Promise<{ job: JobRow | null }> {
    const site = this.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site is ${site.status}; wait for it to finish`);
    }
    const server = this.s.servers.handleFor(site.serverId);
    if (body.object === true && (await siteContainerStack(server.docker, site.containerName)) === 1) {
      throw conflict('This site still runs the old PHP setup, which has no object cache.');
    }

    const { object, page, keepSeconds, off, own } = body;
    const pageCache = page !== undefined || keepSeconds !== undefined || off !== undefined || own !== undefined;
    if (pageCache && isPhpSite(site)) throw conflict(phpNoPageCache(site.slug));
    if (pageCache) {
      const rules = parseSiteCacheRules(site.cacheRules);
      const changes = {
        pageCache: page === undefined ? site.pageCache : page === 'default' ? null : page,
        cacheRules: JSON.stringify({
          keepSeconds: keepSeconds === undefined ? rules.keepSeconds : keepSeconds,
          off: off ?? rules.off,
          own: own ? withCacheRuleIds(own) : rules.own,
          // It said why the cache is off, until someone chooses.
          offReason: page === undefined ? rules.offReason : null,
        }),
      };
      const release = this.worker.holdSite(site, CACHE_SAFE_JOBS);
      try {
        const row = this.db.update(sites).set({ ...changes, updatedAt: Date.now() }).where(eq(sites.id, site.id)).returning().get();
        try {
          await applySiteCaches(server, this.s, row);
        } catch (err) {
          this.db.update(sites).set({ pageCache: site.pageCache, cacheRules: site.cacheRules, updatedAt: Date.now() }).where(eq(sites.id, site.id)).run();
          if (err instanceof RuntimeRefusedError) throw conflict(err.message);
          throw err;
        }
      } finally {
        release();
      }
    }
    if (object === undefined || object === (site.objectCache === 1)) return { job: null };
    return { job: this.worker.enqueue('site.objectCache', { siteId: site.id, on: object }, { id: site.id, slug, serverId: site.serverId }) };
  }

  /**
   * A PHP site's web root (sites.web_root). In force at once on a running site: the protection's
   * sync writes it into the site's own Apache file, checks it and reloads Apache, as for a change of
   * protection (services/siteHardening.ts). A file Apache refuses puts the old value back, and the
   * answer is what Apache said. A stopped site gets it at its next start.
   */
  async setWebRoot(slug: string, webRoot: string): Promise<void> {
    const site = this.bySlug(slug);
    if (!isPhpSite(site)) throw conflict(`"${site.slug}" is a WordPress site: a web root is for PHP sites.`);
    if (site.status === 'provisioning' || site.status === 'deleting') throw conflict(`Site is ${site.status}; wait for it to finish`);
    if (webRoot === site.webRoot) return;
    this.db.update(sites).set({ webRoot, updatedAt: Date.now() }).where(eq(sites.id, site.id)).run();
    await this.s.security.kick(site.serverId);
    const refusal = this.s.security.apacheRefusal(site.id);
    if (refusal === null) return;
    this.db.update(sites).set({ webRoot: site.webRoot, updatedAt: Date.now() }).where(eq(sites.id, site.id)).run();
    await this.s.security.kick(site.serverId);
    throw conflict(`Apache refused it, so the web root is as it was: ${refusal}`);
  }

  /**
   * One test message from the site, as its own code would send it: wp_mail() on a WordPress site,
   * PHP's mail() with no From header on a PHP site, so its default sender is what it is tested with
   * (services/mailAuth.ts defaultMailFrom). Accepted means handed to the relay; delivery is the mail
   * log's to tell.
   */
  async testMail(slug: string, to: string): Promise<{ accepted: boolean; detail: string }> {
    const site = this.bySlug(slug);
    const server = this.s.servers.handleFor(site.serverId);
    const state = await server.docker.containerState(site.containerName);
    if (state !== 'running') throw conflict(`Site container is ${state}; start the site first`);
    if (!isPhpSite(site)) {
      const res = await server.wp.testEmail(site.containerName, to, site.title);
      const accepted = res.stdout.includes('true');
      return {
        accepted,
        detail: accepted
          ? `wp_mail() accepted the message for ${to} - check the inbox (and the mail log if it never arrives)`
          : `wp_mail() returned false: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
      };
    }
    // The address and the words go in the environment, never into the code.
    const res = await server.docker.exec(
      site.containerName,
      ['php', '-r', "var_export(mail(getenv('WPL7_TO'), getenv('WPL7_SUBJECT'), getenv('WPL7_BODY')));"],
      asSiteUser(60_000, [`WPL7_TO=${to}`, `WPL7_SUBJECT=Test email from ${site.title}`, 'WPL7_BODY=This is a test email sent from the WPL7 control panel. If you can read this, mail() works.']),
    );
    const accepted = res.exitCode === 0 && res.stdout.trim() === 'true';
    return {
      accepted,
      detail: accepted
        ? `mail() accepted the message for ${to} - check the inbox (and the mail log if it never arrives)`
        : `mail() returned false: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
    };
  }

  /** The job holding the site, for its page to show: a new site's `site.create`, among others. */
  private activeJob(site: SiteRow): SiteDetail['activeJob'] {
    const job = this.worker.activeSiteJob(site.id);
    return job ? { id: job.id, type: job.type as JobType } : null;
  }

  /** An external site's page: no container to ask about, and its connection instead. */
  private externalDetail(site: SiteRow, summary: SiteSummary): SiteDetail {
    return {
      ...summary,
      locale: site.locale,
      adminUser: site.wpAdminUser,
      adminEmail: site.wpAdminEmail,
      dbName: '',
      hasDatabase: false,
      webRoot: '',
      webRootMissing: false,
      tablePrefix: site.tablePrefix,
      containerState: 'missing',
      url: summary.external?.home ?? `https://${summary.primaryDomain}`,
      keepDevAlias: false,
      backupsEnabled: site.backupsEnabled === 1,
      offsiteEnabled: site.offsiteEnabled === 1,
      mailSuspended: null,
      pendingMoveCleanup: null,
      importSource: null,
      external: this.s.connections.externalDto(site, { wpVersion: this.s.wpInventory.coreVersionOf(site.id) }),
      activeJob: this.activeJob(site),
      limits: null,
      stack: null,
      stackSwitchError: null,
      cache: null,
    };
  }
}
