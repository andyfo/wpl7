/**
 * Site protection and malware scans (docs/security.md): the fleet's overview, each site's own
 * protection, its scans, findings and quarantine. Blocked addresses are routes/blocklist.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  blockedRequestsQuery,
  findingsQuery,
  scanSettingsBody,
  scansRequestBody,
  siteSecurityUpdateBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { withRuleIds } from '../../shared/security.js';
import { siteScanFindings, sites } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { actorName, audit } from '../lib/audit.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { MU_PLUGIN_PATH, ensureMuPlugin } from '../services/adminLogin.js';
import { LICENSES_MU_PLUGIN_PATH } from '../services/licenses.js';
import { QuarantineService } from '../services/quarantine.js';
import { canPutBack, canReinstall, manualQuarantineProblem } from '../services/scanPolicy.js';
import {
  findingDto,
  fleetScans,
  quarantineDto,
  scanHistory,
  securityOverview,
  siteFindings,
  siteScanDto,
  siteSecurityDto,
} from '../services/securityViews.js';
import type { AppDeps } from './deps.js';

const slugParams = z.object({ slug: siteSlugParam });
const idParams = z.object({ slug: siteSlugParam, id: z.coerce.number().int().positive() });

export function registerSecurityRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------------ the fleet

  r.get('/api/security/overview', async () => securityOverview(deps));

  /** Put every server's rules and blocked addresses in line now, rather than at the next minute. */
  r.post('/api/security/sync', async () => {
    await Promise.all([deps.security.kickAll(), deps.firewall.kickAll()]);
    return securityOverview(deps);
  });

  r.get('/api/security/scans', async () => ({ ...fleetScans(deps), inFlight: securityOverview(deps).scansInFlight }));

  /** Scan now, for some sites or every site that is scanned. One per site at a time. */
  r.post('/api/security/scans', { schema: { body: scansRequestBody } }, async (req) => {
    const wanted = req.body.slugs
      ? req.body.slugs.map((slug) => deps.sites.bySlug(slug))
      : deps.db
          .select()
          .from(sites)
          .where(inArray(sites.status, ['running', 'stopped']))
          .all()
          .filter((site) => deps.malwareScan.settingsFor(site.id).enabled);
    const queued: string[] = [];
    const already: string[] = [];
    for (const site of wanted) {
      if (site.status === 'provisioning' || site.status === 'deleting') throw badRequest(`"${site.slug}" is being ${site.status === 'provisioning' ? 'created' : 'deleted'}`);
      const { queued: fresh } = deps.malwareScan.request(deps.worker, site, 'manual');
      (fresh ? queued : already).push(site.slug);
    }
    return { queued, already };
  });

  // ------------------------------------------------------------------ one site's protection

  r.get('/api/sites/:slug/security', { schema: { params: slugParams } }, async (req) => siteSecurityDto(deps, deps.sites.bySlug(req.params.slug)));

  r.put('/api/sites/:slug/security', { schema: { params: slugParams, body: siteSecurityUpdateBody } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const { level, overrides, customRules } = req.body;
    deps.security.updateSite(
      site,
      {
        ...(level !== undefined ? { level } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
        ...(customRules !== undefined ? { customRules: withRuleIds(customRules) } : {}),
      },
      actorName(req),
    );
    audit(req, 'security', site.slug, 'change protection', {
      ...(level !== undefined ? { level } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
      ...(customRules !== undefined ? { customRules: customRules.length } : {}),
    });
    return siteSecurityDto(deps, site);
  });

  r.get('/api/sites/:slug/security/blocked', { schema: { params: slugParams, querystring: blockedRequestsQuery } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    return {
      items: deps.securityEvents.recent({ siteId: site.id, limit: req.query.limit, ...(req.query.rule ? { rule: req.query.rule } : {}) }),
      counts7d: deps.securityEvents.countsBySite(site.id, 7),
    };
  });

  // ------------------------------------------------------------------ one site's scans

  r.get('/api/sites/:slug/security/scan', { schema: { params: slugParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    return { scan: siteScanDto(deps, site), history: scanHistory(deps, site.id) };
  });

  r.post('/api/sites/:slug/security/scan', { schema: { params: slugParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    if (site.status === 'provisioning' || site.status === 'deleting') throw badRequest(`"${site.slug}" is being ${site.status === 'provisioning' ? 'created' : 'deleted'}`);
    const { job } = deps.malwareScan.request(deps.worker, site, 'manual');
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.put('/api/sites/:slug/security/scan/settings', { schema: { params: slugParams, body: scanSettingsBody } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const { enabled, onFinding } = req.body;
    deps.security.updateSite(
      site,
      {
        ...(enabled !== undefined ? { scanEnabled: enabled } : {}),
        ...(onFinding !== undefined ? { scanOnFinding: onFinding } : {}),
      },
      actorName(req),
    );
    audit(req, 'security', site.slug, 'change scan settings', req.body);
    return siteScanDto(deps, site);
  });

  r.get('/api/sites/:slug/security/findings', { schema: { params: slugParams, querystring: findingsQuery } }, async (req) =>
    siteFindings(deps, deps.sites.bySlug(req.params.slug).id, req.query.status),
  );

  const findingOf = (siteId: number, id: number) => {
    const row = deps.db
      .select()
      .from(siteScanFindings)
      .where(and(eq(siteScanFindings.siteId, siteId), eq(siteScanFindings.id, id)))
      .get();
    if (!row) throw notFound(`Finding #${id} not found`);
    return row;
  };

  /** Ignore, unignore, resolve: what a person decided about a finding. A scan respects each. */
  const transitions = {
    ignore: { from: ['open'], to: 'ignored', what: 'Only an open finding can be ignored' },
    unignore: { from: ['ignored'], to: 'open', what: 'Only an ignored finding can be taken back' },
    resolve: { from: ['open', 'ignored'], to: 'resolved', what: 'Only an open or ignored finding can be marked resolved' },
  } as const;
  for (const [action, t] of Object.entries(transitions)) {
    r.post(`/api/sites/:slug/security/findings/:id/${action}`, { schema: { params: idParams } }, async (req) => {
      const site = deps.sites.bySlug(req.params.slug);
      const row = findingOf(site.id, req.params.id);
      if (!(t.from as readonly string[]).includes(row.status)) throw badRequest(t.what);
      deps.db
        .update(siteScanFindings)
        .set({ status: t.to, statusAt: Date.now(), statusBy: actorName(req) ?? 'unknown' })
        .where(eq(siteScanFindings.id, row.id))
        .run();
      deps.malwareScan.refreshCounts(site.id);
      audit(req, 'security', site.slug, `${action} finding`, { path: row.path, kind: row.kind });
      return findingDto(findingOf(site.id, row.id));
    });
  }

  /**
   * A changed WPL7 file: the panel writes its own again - from inside the running site, like
   * every write to a site's files - and a scan follows to see that it is so.
   */
  r.post('/api/sites/:slug/security/findings/:id/put-back', { schema: { params: idParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const row = findingOf(site.id, req.params.id);
    if (!canPutBack({ ...row, kind: row.kind as never })) throw badRequest('Put back is for a changed WPL7 file');
    const server = deps.servers.handleFor(site.serverId);
    const state = await server.docker.containerState(site.containerName);
    if (state !== 'running') throw conflict(`Site container is ${state}; start the site first`);
    if (row.path === MU_PLUGIN_PATH) {
      await ensureMuPlugin(server, site, deps.panelFiles);
    } else if (row.path === LICENSES_MU_PLUGIN_PATH) {
      await deps.licenses.rewriteDropIn(server, site, { info: () => undefined, warn: () => undefined });
    } else {
      throw badRequest('The panel no longer writes that file; remove it in the Files tab');
    }
    audit(req, 'security', site.slug, 'put back', { path: row.path });
    const { job } = deps.malwareScan.request(deps.worker, site, 'rescan');
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/sites/:slug/security/findings/:id/reinstall', { schema: { params: idParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const row = findingOf(site.id, req.params.id);
    if (!canReinstall({ ...row, kind: row.kind as never })) {
      throw badRequest('Reinstall original is for a changed or missing file of WordPress or of a wordpress.org plugin');
    }
    const job = deps.worker.enqueue('wp.reinstall', { siteId: site.id, package: row.package }, { id: site.id, slug: site.slug, serverId: site.serverId });
    audit(req, 'security', site.slug, 'reinstall', { package: row.package });
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/sites/:slug/security/findings/:id/quarantine', { schema: { params: idParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const row = findingOf(site.id, req.params.id);
    const problem = manualQuarantineProblem({ ...row, kind: row.kind as never });
    if (problem) throw badRequest(problem);
    // Every finding about that file goes with it.
    const sameFile = deps.db
      .select({ id: siteScanFindings.id })
      .from(siteScanFindings)
      .where(and(eq(siteScanFindings.siteId, site.id), eq(siteScanFindings.path, row.path), inArray(siteScanFindings.status, ['open', 'ignored'])))
      .all()
      .map((f) => f.id);
    const moved = await QuarantineService.held(deps.worker, site, () =>
      deps.quarantine.move(site, { path: row.path, sha256: row.sha256!, findingIds: sameFile, reason: 'Moved by hand' }, actorName(req) ?? 'unknown'),
    );
    deps.malwareScan.refreshCounts(site.id);
    audit(req, 'security', site.slug, 'quarantine', { path: row.path });
    return quarantineDto(moved);
  });

  // ------------------------------------------------------------------ one site's quarantine

  r.get('/api/sites/:slug/security/quarantine', { schema: { params: slugParams } }, async (req) => ({
    items: deps.quarantine.list(deps.sites.bySlug(req.params.slug).id).map(quarantineDto),
  }));

  r.post('/api/sites/:slug/security/quarantine/:id/restore', { schema: { params: idParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const restored = await QuarantineService.held(deps.worker, site, () => deps.quarantine.restore(site, req.params.id, actorName(req) ?? 'unknown'));
    deps.malwareScan.refreshCounts(site.id);
    audit(req, 'security', site.slug, 'restore from quarantine', { path: restored.path });
    return quarantineDto(restored);
  });

  r.delete('/api/sites/:slug/security/quarantine/:id', { schema: { params: idParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const deleted = await deps.quarantine.remove(site, req.params.id, actorName(req) ?? 'unknown');
    deps.malwareScan.refreshCounts(site.id);
    audit(req, 'security', site.slug, 'delete from quarantine', { path: deleted.path });
    return quarantineDto(deleted);
  });
}
