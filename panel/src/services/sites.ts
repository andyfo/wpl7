import { and, asc, eq } from 'drizzle-orm';
import type { SiteCreateBody } from '../../shared/schemas.js';
import type { SiteDetail, SiteSummary, SiteWpSummary } from '../../shared/types.js';
import { jobs as jobsTable, moveCleanups, plugins, sites, type JobRow, type ServerRow, type SiteRow } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generatePassword, generateSecret } from '../lib/crypto.js';
import { containerName, dbIdentifier, isValidSlug, slugify } from '../lib/slug.js';
import type { CoreServices } from './index.js';
import type { JobWorker } from '../jobs/worker.js';
import { siteScheme } from './labels.js';
import { assertDomainsFree } from './domainGuard.js';

export class SitesService {
  constructor(
    private readonly s: CoreServices,
    private readonly worker: JobWorker,
  ) {}

  private get db() {
    return this.s.db;
  }

  bySlug(slug: string): SiteRow {
    const site = this.db.select().from(sites).where(eq(sites.slug, slug)).get();
    if (!site) throw notFound(`Site "${slug}" not found`);
    return site;
  }

  private assertDomainsFree(domains: string[], excludeSiteId?: number, allowDevHostname?: string | null): void {
    assertDomainsFree(this.s, domains, { excludeSiteId, allowDevHostname });
  }

  /** Resolve + validate the target server for a new site. */
  private resolveTargetServer(requestedId?: number): ServerRow {
    const serverId = requestedId ?? this.s.settings.get('defaultServerId') ?? 1;
    const server = this.s.servers.rowById(serverId);
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

  create(body: SiteCreateBody): { site: SiteRow; job: JobRow } {
    const offered = this.s.settings.get('phpVersions') ?? [];
    const phpVersion = body.phpVersion ?? this.s.settings.get('defaultPhpVersion');
    if (!offered.includes(phpVersion)) {
      throw badRequest(`PHP ${phpVersion} is not offered (available: ${offered.join(', ')})`);
    }
    const locale = body.locale ?? this.s.settings.get('defaultLocale') ?? 'en_US';
    const adminEmail = body.adminEmail ?? (this.s.settings.get('defaultAdminEmail') || null);
    if (!adminEmail) throw badRequest('No default admin email is set in Settings; provide "adminEmail"');
    const server = this.resolveTargetServer(body.serverId);

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
    // catalog choice at all is the catalog's defaults, in the order the wizard lists them.
    const catalogIds =
      body.plugins?.catalogIds ??
      this.db
        .select({ id: plugins.id })
        .from(plugins)
        .where(eq(plugins.isDefault, 1))
        .orderBy(asc(plugins.id))
        .all()
        .map((p) => p.id);
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
            locale,
            status: 'provisioning',
            dbName: dbIdentifier(slug),
            dbUser: dbIdentifier(slug),
            dbPassword: generateSecret(24),
            // The site's own relay credential; the relay uses it to tell whose mail this is,
            // and refuses senders belonging to another site (services/mailAuth.ts).
            mailPassword: generateSecret(24),
            wpAdminUser: body.adminUser,
            wpAdminEmail: adminEmail,
            containerName: containerName(slug),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const job = this.worker.enqueue(
          'site.create',
          {
            siteId: site.id,
            adminPassword,
            passwordGenerated,
            pluginSlugs,
            pluginZipPaths,
            discourageSearchEngines: body.discourageSearchEngines,
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
    const site = this.bySlug(slug);
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
    return this.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug, serverId: site.serverId });
  }

  /** Reconcile every site, newest last so a fleet-wide pass is predictable in the job list. */
  reconcileAll(): JobRow[] {
    const rows = this.s.db.select().from(sites).orderBy(asc(sites.id)).all();
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
   * Bring every existing site container to the CPU, memory and process ceilings in Settings:
   * one server.applySiteLimits per server with sites on it. A server that already has one
   * waiting to start is not given a second - that one reads the settings when it starts, so
   * it is returned in its place.
   */
  applyLimits(): JobRow[] {
    const serverIds = this.db.selectDistinct({ serverId: sites.serverId }).from(sites).all();
    return serverIds.map(({ serverId }) => {
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
    const quiesce = body.quiesce ?? (isLive ? 'maintenance' : 'none');
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
    const site = this.bySlug(slug);
    return this.db
      .update(sites)
      .set({ backupsEnabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  /**
   * Take one site in or out of the offsite copies. Existing copies are kept: switching this
   * off means "stop sending new ones", not "delete what is already in the bucket".
   */
  setOffsiteEnabled(slug: string, enabled: boolean): SiteRow {
    const site = this.bySlug(slug);
    return this.db
      .update(sites)
      .set({ offsiteEnabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(sites.id, site.id))
      .returning()
      .get();
  }

  updateDomains(slug: string, domains: string[], keepDevAlias: boolean, goLive: boolean, manageDns = false): JobRow {
    const site = this.bySlug(slug);
    const unique = [...new Set(domains)];
    this.assertDomainsFree(unique, site.id, site.devHostname);
    return this.worker.enqueue(
      'site.updateDomains',
      { siteId: site.id, domains: unique, keepDevAlias, goLive, manageDns },
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
      status: site.status as SiteSummary['status'],
      up: monitor?.up ?? null,
      httpStatus: monitor?.httpStatus ?? null,
      lastCheckedAt: monitor?.lastCheckedAt ?? null,
      diskBytes: site.diskBytes,
      recentTraffic: traffic,
      wp,
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
    const site = this.bySlug(slug);
    const summary = this.toSummary(site);
    let containerState: SiteDetail['containerState'];
    try {
      containerState = await this.s.servers.handleFor(site.serverId).docker.containerState(site.containerName);
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
    };
  }
}
