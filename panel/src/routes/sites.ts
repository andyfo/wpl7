// @docs sites/create, sites/domains, sites/settings
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  backupsEnabledBody,
  domainsUpdateBody,
  offsiteEnabledBody,
  goLiveBody,
  mailSuspensionBody,
  phpUpdateBody,
  siteCreateBody,
  siteDeleteQuery,
  siteMoveBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { moveCleanups } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { requireAccess } from '../plugins/auth.js';
import type { AppDeps } from './deps.js';

// Addressing an existing site: no reserved-name check, see siteSlugParam.
const slugParams = z.object({ slug: siteSlugParam });

export function registerSiteRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * A domain becomes the sender domain of the site that claims it (services/mail.ts
   * senderOwners), and its mail goes out signed with the DKIM key of that domain - or of the
   * domain it is under: the signing policy gives every key its subdomains too
   * (services/mailDkim.ts renderSigningPolicy), and signs for whatever the site owns. Where that key is not one of this site's own domains - kept after
   * its site was deleted, made ahead of a migration, or another site's - claiming the domain
   * would let this site sign mail as someone else. That is mail identity, Full's (docs/mcp.md),
   * not work inside a site.
   */
  const holdSigningDomains = (req: FastifyRequest, domains: string[], held: string[] = []) => {
    const own = new Set(held.map((d) => d.toLowerCase()));
    const foreign = deps.mail
      .listDkimKeys()
      .map((key) => key.domain.toLowerCase())
      .filter((k) => !own.has(k));
    const claimed = domains.filter((d) => {
      const name = d.toLowerCase();
      return !own.has(name) && foreign.some((k) => name === k || name.endsWith(`.${k}`));
    });
    if (claimed.length > 0) {
      const what = `a domain whose mail would be signed with a DKIM key this site does not hold (${claimed.join(', ')})`;
      requireAccess(req, 'full', what);
    }
  };

  r.get('/api/sites', async () => ({ items: deps.sites.list() }));

  r.post('/api/sites', { schema: { body: siteCreateBody } }, async (req, reply) => {
    holdSigningDomains(req, req.body.domains ?? []);
    const { job } = deps.sites.create(req.body);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.get('/api/sites/:slug', { schema: { params: slugParams } }, async (req) =>
    deps.sites.detail(req.params.slug),
  );

  r.delete(
    '/api/sites/:slug',
    { schema: { params: slugParams, querystring: siteDeleteQuery } },
    async (req, reply) => {
      const job = deps.sites.delete(req.params.slug, req.query.finalBackup, req.query.deleteBackups);
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  for (const action of ['start', 'stop', 'restart'] as const) {
    r.post(`/api/sites/:slug/${action}`, { schema: { params: slugParams } }, async (req, reply) => {
      const job = deps.sites.action(req.params.slug, action);
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    });
  }

  r.put('/api/sites/:slug/php', { schema: { params: slugParams, body: phpUpdateBody } }, async (req, reply) => {
    const job = deps.sites.changePhp(req.params.slug, req.body.phpVersion);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/sites/:slug/go-live', { schema: { params: slugParams, body: goLiveBody } }, async (req, reply) => {
    // Going live is Manage; having the panel write the A records - of any name in the DNS
    // account, not only this site's - is DNS work, which is Full everywhere else.
    if (req.body.manageDns) requireAccess(req, 'full', 'writing DNS records (manageDns)');
    const current = deps.sites.bySlug(req.params.slug);
    holdSigningDomains(req, req.body.domains, JSON.parse(current.domains) as string[]);
    const job = deps.sites.updateDomains(
      req.params.slug,
      req.body.domains,
      req.body.keepDevAlias,
      true,
      req.body.manageDns,
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.put(
    '/api/sites/:slug/domains',
    { schema: { params: slugParams, body: domainsUpdateBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      holdSigningDomains(req, req.body.domains, JSON.parse(site.domains) as string[]);
      const job = deps.sites.updateDomains(req.params.slug, req.body.domains, site.keepDevAlias === 1, false);
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  /**
   * Re-apply the isolation policy to every site at once. The upgrade path after a policy
   * change: one job per site, serialized per server by the queue, each rolling back on its
   * own if the recreated container does not come up.
   */
  r.post('/api/sites/reconcile-all', async (req, reply) => {
    const jobs = deps.sites.reconcileAll();
    return reply.status(202).send({ jobs: jobs.map((job) => jobToDto(job, viewerOf(req))) });
  });

  /**
   * Re-apply the current isolation policy to one site (networks, capability drops, resource
   * ceilings, relay credential). Needed for sites created before a policy change; safe and
   * idempotent for the rest.
   */
  r.post('/api/sites/:slug/reconcile', { schema: { params: slugParams } }, async (req, reply) => {
    const job = deps.sites.reconcile(req.params.slug);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  /** Take one site in or out of the scheduled backup run (`backup.cron`). */
  r.put(
    '/api/sites/:slug/backups-enabled',
    { schema: { params: slugParams, body: backupsEnabledBody } },
    async (req, reply) => {
      deps.sites.setBackupsEnabled(req.params.slug, req.body.enabled);
      return reply.send(await deps.sites.detail(req.params.slug));
    },
  );

  /** Take one site in or out of the offsite copies. Existing copies are left alone. */
  r.put(
    '/api/sites/:slug/offsite-enabled',
    { schema: { params: slugParams, body: offsiteEnabledBody } },
    async (req, reply) => {
      deps.sites.setOffsiteEnabled(req.params.slug, req.body.enabled);
      if (req.body.enabled) deps.offsite.kick();
      return reply.send(await deps.sites.detail(req.params.slug));
    },
  );

  /** Resume (or suspend) a site's outbound mail after the abuse guard stopped it. */
  r.put(
    '/api/sites/:slug/mail-suspension',
    { schema: { params: slugParams, body: mailSuspensionBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      await deps.mail.setSiteMailSuspended(site.id, req.body.suspended, req.body.reason);
      // Awaited, not handed to send() as a promise: Fastify serializes that as `{}`.
      return reply.send(await deps.sites.detail(site.slug));
    },
  );

  r.post('/api/sites/:slug/move', { schema: { params: slugParams, body: siteMoveBody } }, async (req, reply) => {
    const job = deps.sites.move(req.params.slug, req.body);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  // Tear down the source copy of a moved site once its DNS points at the new server.
  r.post('/api/sites/:slug/move/finalize', { schema: { params: slugParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const cleanup = deps.db
      .select()
      .from(moveCleanups)
      .where(and(eq(moveCleanups.siteId, site.id), eq(moveCleanups.status, 'pending')))
      .get();
    if (!cleanup) throw notFound('No pending move cleanup for this site');
    const job = deps.worker.enqueue(
      'site.moveFinalize',
      { cleanupId: cleanup.id },
      { id: site.id, slug: site.slug, serverId: cleanup.sourceServerId },
      { serverId: cleanup.sourceServerId },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });
}
