// @docs sites/external
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  connectionAddBody,
  connectionCreateBody,
  connectionIdParams,
  siteConnectionPatchBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { plugins, type SiteConnectionRow } from '../db/schema.js';
import { actorName, audit } from '../lib/audit.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { attachmentDisposition } from '../lib/contentDisposition.js';
import { PANEL_VERSION } from '../lib/version.js';
import { notFound } from '../lib/errors.js';
import { requireAccess } from '../plugins/auth.js';
import { safeJoin } from '../lib/slug.js';
import { PluginRefusal } from '../services/imports.js';
import { CONNECT_TOKEN_HEADER } from '../services/connections.js';
import type { AppDeps } from './deps.js';

/** An enroll body holds the site's report: thousands of plugins and tables at most. */
const ENROLL_BODY_LIMIT = 4 * 1024 * 1024;

const slugParams = z.object({ slug: siteSlugParam });
const catalogParams = z.object({ pluginId: z.coerce.number().int().positive() });

declare module 'fastify' {
  interface FastifyRequest {
    /** The connection a WPL7 Connect plugin's call is for, once its token was accepted. */
    connectionRow: SiteConnectionRow | null;
  }
}

export function registerConnectionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('connectionRow', null);

  r.get('/api/connections', async () => ({ items: deps.connections.list() }));

  r.post('/api/connections', { schema: { body: connectionCreateBody } }, async (req, reply) => {
    const row = deps.connections.create(req.body, actorName(req));
    return reply.status(201).send(deps.connections.toDto(row));
  });

  r.get('/api/connections/:id', { schema: { params: connectionIdParams } }, async (req) =>
    deps.connections.toDto(deps.connections.get(req.params.id)),
  );

  r.get('/api/connections/:id/plugin', { schema: { params: connectionIdParams } }, async (req, reply) => {
    const zip = deps.connections.pluginZip(req.params.id);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', attachmentDisposition(zip.name))
      .header('cache-control', 'no-store')
      .send(zip.data);
  });

  r.get('/api/connections/:id/code', { schema: { params: connectionIdParams } }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(deps.connections.connectionCode(req.params.id)),
  );

  r.post(
    '/api/connections/:id/check',
    { schema: { params: connectionIdParams }, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (req) => {
      await deps.connections.check(req.params.id);
      return deps.connections.toDto(deps.connections.get(req.params.id));
    },
  );

  r.post('/api/connections/:id/add', { schema: { params: connectionIdParams, body: connectionAddBody } }, async (req, reply) => {
    const { site, jobs } = deps.connections.add(req.params.id, req.body);
    audit(req, 'connect', site.slug, 'add', { connection: req.params.id });
    return reply.status(201).send({ site: deps.sites.toSummary(site), jobs: jobs.map((job) => jobToDto(job, viewerOf(req))) });
  });

  r.delete('/api/connections/:id', { schema: { params: connectionIdParams } }, async (req, reply) => {
    deps.connections.delete(req.params.id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- an external site's connection

  r.patch('/api/sites/:slug/connection', { schema: { params: slugParams, body: siteConnectionPatchBody } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug, { kinds: 'any' });
    // Where the backups go is the backup policy, which is Full: the same line the Storage form holds.
    if (req.body.storageServerId !== undefined && req.body.storageServerId !== site.serverId) {
      requireAccess(req, 'full', "changing where a site's backups are kept");
    }
    const updated = await deps.connections.update(site, req.body);
    if (req.body.storageServerId !== undefined && updated.serverId !== site.serverId) {
      // A copy elsewhere is no longer the one the next backup builds on: it starts over there.
      await deps.externalBackups.forgetMirror(site).catch((err: unknown) =>
        req.log.warn(`Site "${site.slug}": could not remove its copy on the old server (${err instanceof Error ? err.message : err})`),
      );
    }
    audit(req, 'connect', site.slug, 'update', { ...req.body });
    return deps.sites.detail(updated.slug);
  });

  r.post('/api/sites/:slug/connection/reconnect', { schema: { params: slugParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug, { kinds: 'any' });
    const row = deps.connections.reconnect(site, actorName(req));
    audit(req, 'connect', site.slug, 'reconnect', { connection: row.id });
    return reply.status(201).send(deps.connections.toDto(row));
  });

  r.post('/api/sites/:slug/connection/disconnect', { schema: { params: slugParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug, { kinds: 'any' });
    await deps.connections.disconnect(site);
    audit(req, 'connect', site.slug, 'disconnect', {});
    return deps.sites.detail(site.slug);
  });

  // ---------------------------------------------------------------- the plugin's own calls

  /**
   * Open routes (plugins/auth.ts). What lets the plugin in is its connection's enrollment token,
   * in a header of its own - never `Authorization`, so the API-key check and the activity log
   * never take it for a key.
   */
  const pluginOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers[CONNECT_TOKEN_HEADER];
    const row = typeof token === 'string' ? deps.connections.byToken(token) : null;
    if (!row) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unknown or ended connection. Download the plugin again from the panel.' } });
    }
    req.connectionRow = row;
  };

  app.post(
    '/api/connect/enroll',
    { bodyLimit: ENROLL_BODY_LIMIT, preHandler: pluginOnly, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      try {
        const row = await deps.connections.enroll(req.connectionRow!, req.body);
        // `enrolled` for a reconnect too: the plugin is connected once a signed request reaches it.
        return reply.send({ ok: true, connection: { id: row.id, status: 'enrolled' }, panel_version: PANEL_VERSION });
      } catch (err) {
        if (!(err instanceof PluginRefusal)) throw err;
        return reply.status(err.status).send({
          error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
        });
      }
    },
  );

  /** WPL7 Connect without a connection, for a site's own update: a link the panel signed (section 12). */
  r.get(
    '/api/connect/package',
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (query.v !== PANEL_VERSION || !deps.connections.verifyLink('/api/connect/package', query, ['v', 'e'])) {
        throw notFound();
      }
      const zip = deps.connections.pluginPackage();
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', attachmentDisposition(zip.name))
        .header('cache-control', 'no-store')
        .send(zip.data);
    },
  );

  /** One catalog zip, for an install the panel asked a site for: a link the panel signed, for ten minutes. */
  r.get(
    '/api/connect/catalog/:pluginId',
    { schema: { params: catalogParams }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (!deps.connections.verifyLink(`/api/connect/catalog/${req.params.pluginId}`, query, ['site', 'e'])) throw notFound();
      const row = deps.db.select().from(plugins).where(eq(plugins.id, req.params.pluginId)).get();
      if (!row || row.kind !== 'zip' || !row.zipPath) throw notFound();
      const file = safeJoin(deps.config.paths.plugins, path.relative(deps.config.paths.plugins, row.zipPath));
      if (!fs.existsSync(file)) throw notFound();
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', attachmentDisposition(`${row.slug}.zip`))
        .header('cache-control', 'no-store')
        .send(fs.createReadStream(file));
    },
  );
}
