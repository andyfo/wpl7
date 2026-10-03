import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  domainSchema,
  mailDkimCreateBody,
  mailDomainsQuery,
  mailHostnameBody,
  mailMessagesQuery,
  mailQueueActionParams,
  mailQueueQuery,
  mailStatsQuery,
  mailTestBody,
} from '../../shared/schemas.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

const serverIdParams = z.object({ serverId: z.coerce.number().int().positive() });
const domainParams = z.object({ domain: domainSchema });

export function registerMailRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const requireServer = (serverId: number) => {
    const row = deps.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    return row;
  };

  // ---------------------------------------------------------------- overview

  r.get('/api/mail/status', async () => {
    const servers = await deps.mail.status();
    return {
      servers,
      // Only meaningful when this fleet delivers mail itself, but cheap enough to always
      // return - a smarthost setup with bad rDNS is still worth knowing about. Reuses the
      // hostnames from `servers` instead of re-probing each relay.
      reverseDns: await deps.mail.reverseDnsChecks(servers),
      mode: deps.config.mailMode,
    };
  });

  // ---------------------------------------------------------------- traffic

  r.get('/api/mail/messages', { schema: { querystring: mailMessagesQuery } }, async (req) =>
    deps.mail.messages({
      siteSlug: req.query.siteSlug,
      status: req.query.status,
      serverId: req.query.serverId,
      search: req.query.search,
      sinceHours: req.query.hours,
      limit: req.query.limit,
      offset: req.query.offset,
    }),
  );

  r.get('/api/mail/stats', { schema: { querystring: mailStatsQuery } }, async (req) =>
    deps.mail.stats(req.query.hours),
  );

  /** Pull the log right now instead of waiting for the scheduled tick. */
  r.post('/api/mail/ingest', async () => {
    await deps.mail.ingestTick();
    return { ok: true };
  });

  // ---------------------------------------------------------------- queue

  r.get('/api/mail/queue', { schema: { querystring: mailQueueQuery } }, async (req) => {
    if (req.query.serverId !== undefined) requireServer(req.query.serverId);
    return { items: await deps.mail.queue(req.query.serverId) };
  });

  r.post('/api/mail/queue/:serverId/flush', { schema: { params: serverIdParams } }, async (req) => {
    requireServer(req.params.serverId);
    await deps.mail.flushQueue(req.params.serverId);
    return { ok: true };
  });

  r.delete('/api/mail/queue/:serverId/:queueId', { schema: { params: mailQueueActionParams } }, async (req, reply) => {
    requireServer(req.params.serverId);
    await deps.mail.deleteQueued(req.params.serverId, req.params.queueId);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- test send

  r.post('/api/mail/test', { schema: { body: mailTestBody } }, async (req) => {
    const serverId = req.body.serverId ?? deps.settings.get('defaultServerId') ?? 1;
    requireServer(serverId);
    return deps.mail.sendTestFromRelay(serverId, {
      from: req.body.from,
      to: req.body.to,
      subject: req.body.subject,
    });
  });

  // ---------------------------------------------------------------- deliverability

  r.get('/api/mail/domains', { schema: { querystring: mailDomainsQuery } }, async (req) => ({
    items: await deps.mail.domains(req.query.domain),
  }));

  r.get('/api/mail/dkim', async () => ({
    items: deps.mail.listDkimKeys().map((k) => deps.mail.dkimKeyToDto(k)),
  }));

  /**
   * Generating a key also pushes it to every server, because a key that exists only in the
   * database signs nothing - and the operator is about to publish DNS for it.
   */
  r.post('/api/mail/dkim', { schema: { body: mailDkimCreateBody } }, async (req, reply) => {
    const row = deps.mail.createDkimKey(req.body.domain, { rotate: req.body.rotate });
    const sync = await deps.mail.syncDkimEverywhere();
    return reply.status(201).send({ key: deps.mail.dkimKeyToDto(row), sync });
  });

  r.delete('/api/mail/dkim/:domain', { schema: { params: domainParams } }, async (req) => {
    deps.mail.deleteDkimKey(req.params.domain);
    return { removed: req.params.domain, sync: await deps.mail.syncDkimEverywhere() };
  });

  /** Re-materialize keys and restart the signers; the repair button for a drifted server. */
  r.post('/api/mail/dkim/sync', async () => ({ sync: await deps.mail.syncDkimEverywhere() }));

  // ---------------------------------------------------------------- setup guide

  /** Everything the step-by-step guide shows, in one request. */
  r.get('/api/mail/setup', async () => deps.mail.setup());

  /**
   * Publish the records the panel is allowed to publish for one domain: SPF is *merged*
   * into whatever is already there, DKIM generates and pushes a key first if needed, and an
   * existing DMARC policy is left alone rather than weakened.
   */
  r.post('/api/mail/domains/:domain/publish', { schema: { params: domainParams } }, async (req) => ({
    results: await deps.mail.publishDomain(req.params.domain),
  }));

  /**
   * Change the name the relay announces. Applied live and persisted, so it survives the
   * container being recreated - see MailService.setMailHostname.
   */
  r.put('/api/mail/servers/:serverId/hostname', { schema: { params: serverIdParams, body: mailHostnameBody } }, async (req) => {
    requireServer(req.params.serverId);
    return deps.mail.setMailHostname(req.params.serverId, req.body.hostname);
  });

  /** The one server-side record that lives in a normal DNS zone (reverse DNS does not). */
  r.post('/api/mail/servers/:serverId/publish-hostname', { schema: { params: serverIdParams } }, async (req) => {
    requireServer(req.params.serverId);
    return deps.mail.publishHostnameA(req.params.serverId);
  });

  /**
   * Re-check one domain's published records. Separate from the list endpoint so the UI can
   * offer a "I've added the record, check again" button without re-resolving every domain.
   */
  r.post('/api/mail/domains/:domain/check', { schema: { params: domainParams } }, async (req) => {
    const [domain] = await deps.mail.domains(req.params.domain);
    if (!domain) throw badRequest(`"${req.params.domain}" is not a domain this fleet sends mail for`);
    return domain;
  });
}
