// @docs integrations/api
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { Cron } from 'croner';
import { z } from 'zod';
import {
  apiActivityQuery,
  apiKeyCreateBody,
  historyQuery,
  settingsUpdateBody,
  siteSlugParam,
  siteTrafficQuery,
} from '../../shared/schemas.js';
import { WP_LOCALES } from '../../shared/locales.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { mcpUnavailableReason } from '../lib/panelUrl.js';
import { PANEL_GIT_SHA, PANEL_VERSION } from '../lib/version.js';
import { ftpPortsProblem } from '../services/ftpConfig.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
// Addressing an existing site: no reserved-name check, see siteSlugParam.
const slugParams = z.object({ slug: siteSlugParam });

export function registerMiscRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/health', async () => ({ ok: true }));

  r.get('/api/meta', async () => {
    const serverRows = deps.servers.listRows();
    return {
      phpVersions: deps.settings.get('phpVersions') ?? [],
      defaultPhpVersion: deps.settings.get('defaultPhpVersion'),
      defaultLocale: deps.settings.get('defaultLocale'),
      defaultAdminEmail: deps.settings.get('defaultAdminEmail') ?? '',
      locales: WP_LOCALES,
      devDomain: serverRows.find((s) => s.id === 1)?.devDomain || deps.config.devDomain,
      panelDomain: deps.config.panelDomain,
      tlsMode: deps.config.tlsMode,
      mailMode: deps.config.mailMode,
      version: PANEL_VERSION,
      gitSha: PANEL_GIT_SHA,
      // Scheduled backups fire on this process's clock, so the schedule editor labels
      // its preview with it - "03:00" means nothing until you know whose 03:00 it is.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // The site page describes the schedule rather than assuming it; it is a cron
      // expression the operator can set to anything, not a fixed nightly run.
      backupCron: deps.settings.get('backupCron'),
      backupsPaused: deps.schedulers.backupsPaused(),
      // Where each server keeps its backups, so Settings and the site page can say so
      // without every page learning to call the storage endpoint.
      backupRoots: deps.storage.roots(),
      offsiteConfigured: deps.offsite.anyConfigured(),
      servers: serverRows.map((s) => ({ id: s.id, name: s.name, devDomain: s.devDomain, status: s.status })),
      defaultServerId: deps.settings.get('defaultServerId') || 1,
      multiServer: serverRows.length > 1,
      dnsManaged: deps.dns.enabled,
      // The sidebar's "update available" link. Read from the cached check, so this endpoint
      // stays a database read however unreachable GitHub is.
      channel: deps.config.channel,
      updateAvailable: deps.updates.status().updateAvailable,
      maintenance: deps.system.maintenance(),
      // The Support page's ways out. Also in /api/system/about, but that one asks the host
      // a question, and Support is the page someone opens when the host is the problem.
      repoUrl: deps.config.repoUrl,
      communityUrl: deps.config.communityUrl,
    };
  });

  // ------------------------------------------------------------------ monitor

  r.get('/api/monitor/overview', async () => deps.monitor.overview());

  r.get(
    '/api/monitor/servers/:id/history',
    { schema: { params: idParams, querystring: historyQuery } },
    async (req) => {
      if (!deps.servers.rowById(req.params.id)) throw notFound(`Server #${req.params.id} not found`);
      return {
        ...deps.monitor.serverHistory(req.params.id, req.query.hours),
        sampleIntervalMs: (deps.settings.get('monitorStatsIntervalSec') || 60) * 1000,
      };
    },
  );

  r.get(
    '/api/monitor/sites/:slug/history',
    { schema: { params: slugParams, querystring: historyQuery } },
    async (req) => {
      const site = deps.sites.bySlug(req.params.slug, { kinds: 'any' });
      return { samples: deps.monitor.history(site.id, req.query.hours) };
    },
  );

  /**
   * Per-site visitor statistics. Read straight out of the rollups the access-log ingest
   * maintains, so this is a database read however long the range is.
   */
  r.get(
    '/api/sites/:slug/traffic',
    { schema: { params: slugParams, querystring: siteTrafficQuery } },
    async (req) => {
      const site = deps.sites.bySlug(req.params.slug);
      return deps.traffic.siteTraffic(site.id, site.serverId, req.query.days);
    },
  );

  // ----------------------------------------------------------------- settings

  r.get('/api/settings', async () => ({ settings: deps.settings.getAll() }));

  r.put('/api/settings', { schema: { body: settingsUpdateBody } }, async (req) => {
    if (req.body.backupCron !== undefined) {
      try {
        new Cron(req.body.backupCron, { paused: true }).stop();
      } catch {
        throw badRequest(`"${req.body.backupCron}" is not a valid cron expression`);
      }
    }
    if (req.body.phpVersions && req.body.defaultPhpVersion === undefined) {
      const current = deps.settings.get('defaultPhpVersion');
      if (!req.body.phpVersions.includes(current)) {
        throw badRequest(`phpVersions must include the default PHP version (${current})`);
      }
    }
    if (req.body.defaultPhpVersion !== undefined) {
      const offered = req.body.phpVersions ?? deps.settings.get('phpVersions') ?? [];
      if (!offered.includes(req.body.defaultPhpVersion)) {
        throw badRequest('defaultPhpVersion must be one of phpVersions');
      }
    }
    if (req.body.defaultServerId !== undefined) {
      const server = deps.servers.rowById(req.body.defaultServerId);
      if (!server) throw badRequest(`Server #${req.body.defaultServerId} does not exist`);
      if (server.status !== 'ok') throw badRequest(`Server "${server.name}" is ${server.status}`);
    }
    const ftpKeys = ['ftpEnabled', 'ftpSftpPort', 'ftpOfferFtps', 'ftpPort', 'ftpPassivePortStart', 'ftpPassivePortEnd'] as const;
    const ftpChanged = ftpKeys.some((k) => req.body[k] !== undefined);
    const current = deps.settings.getAll();
    // Only switching it on is refused: one that is on stays switchable, whatever changed since.
    const mcpProblem = mcpUnavailableReason(deps.config);
    if (req.body.mcpEnabled === true && current.mcpEnabled !== true && mcpProblem) {
      throw conflict(`MCP cannot be switched on: ${mcpProblem}. See docs/mcp.md`);
    }
    const limitKeys = ['siteCpuLimit', 'siteMemoryLimitMb', 'sitePidsLimit'] as const;
    const limitsChanged = limitKeys.some((k) => req.body[k] !== undefined && req.body[k] !== current[k]);
    // Switching FTP off always works: nothing will listen, so no port can be wrong.
    if (ftpChanged && (req.body.ftpEnabled ?? current.ftpEnabled) !== false) {
      const problem = ftpPortsProblem(
        {
          sftpPort: req.body.ftpSftpPort ?? current.ftpSftpPort,
          offerFtps: req.body.ftpOfferFtps ?? current.ftpOfferFtps,
          ftpPort: req.body.ftpPort ?? current.ftpPort,
          passiveStart: req.body.ftpPassivePortStart ?? current.ftpPassivePortStart,
          passiveEnd: req.body.ftpPassivePortEnd ?? current.ftpPassivePortEnd,
        },
        [22, 80, 443, ...deps.servers.listRows().map((s) => s.sshPort)],
      );
      if (problem) throw badRequest(problem);
    }
    const settings = deps.settings.update(req.body);
    if (req.body.backupCron !== undefined) deps.schedulers.scheduleBackups(settings.backupCron);
    // Who is trusted to say who the visitor is: the rules that key on the visitor follow.
    if (req.body.securityTrustedProxies !== undefined) deps.proxyRanges.changed();
    // The default protection reaches every site that follows it; the fleet's rules follow.
    const protectionKeys = ['securityLevel', 'securityOverrides', 'securityBypassPrivate'] as const;
    if (protectionKeys.some((k) => req.body[k] !== undefined)) void deps.security.kickAll();
    // Enforcement off empties every server's list; on puts it back.
    if (req.body.securityEnforcement !== undefined) void deps.firewall.kickAll();
    // New ports, or FTP switched on or off: every server's gateway is set up again (or
    // removed) in the background - the settings form does not wait for a dozen servers.
    if (ftpChanged) void deps.ftp.kickAll();
    // Switching address collection off has to mean the stored ones go, not just that no
    // more are added - otherwise the setting reads as a promise it does not keep.
    if (req.body.trafficStoreIps === false) {
      const forgotten = deps.traffic.forgetIps() + deps.securityEvents.forgetIps();
      if (forgotten > 0) deps.log.info(`Visitor statistics: forgot ${forgotten} stored address rows`);
    }
    // Switching the vulnerability feed off has to clear the severities the site list shows
    // right now, not at the next scan - and switching it on has to fill them in without
    // waiting six hours for one either. The refresh runs in the background: it is a few
    // hundred cached lookups, and the settings form should not hang on them.
    if (req.body.vulnerabilityFeed !== undefined) {
      if (req.body.vulnerabilityFeed) {
        void deps.vulnerabilities
          .refreshReferenced()
          .then(() => deps.wpInventory.recount())
          .catch((err: unknown) => deps.log.warn(`Vulnerability feed refresh failed: ${String(err)}`));
      } else {
        deps.wpInventory.recount();
      }
    }
    // New ceilings have to reach the sites that already exist, not just the containers built
    // from now on: one job per server changes them in place. Returned so the form can say so.
    const jobs = limitsChanged ? deps.sites.applyLimits() : [];
    return { settings, jobs: jobs.map((job) => jobToDto(job, viewerOf(req))) };
  });

  // ----------------------------------------------------------------- api keys

  r.get('/api/api-keys', async () => ({ items: deps.apiKeys.list(deps.apiActivity.countsByKey(24)) }));

  /**
   * The API request log. Static segment, so it is matched before `/api/api-keys/:id` -
   * and `:id` is a coerced number anyway, which "activity" could never satisfy.
   */
  r.get('/api/api-keys/activity', { schema: { querystring: apiActivityQuery } }, async (req) => {
    const { items, total } = deps.apiActivity.list({
      keyId: req.query.keyId,
      outcome: req.query.outcome,
      method: req.query.method,
      search: req.query.search,
      sinceHours: req.query.hours,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return {
      items,
      total,
      last24h: deps.apiActivity.last24h(),
      retentionDays: deps.settings.get('apiActivityRetentionDays') || 30,
      maxRows: deps.apiActivity.maxRows,
    };
  });

  r.delete('/api/api-keys/activity', async () => ({ removed: deps.apiActivity.clear() }));

  r.post('/api/api-keys', { schema: { body: apiKeyCreateBody } }, async (req, reply) => {
    const created = deps.apiKeys.create(req.body.name, req.body.access);
    return reply.status(201).send(created); // token is present exactly once, here
  });

  r.delete('/api/api-keys/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (!deps.apiKeys.revoke(req.params.id)) throw notFound(`API key #${req.params.id} not found`);
    return reply.status(204).send();
  });
}
