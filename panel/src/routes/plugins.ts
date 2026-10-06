// @docs plugins/catalog
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { pluginCreateBody, pluginSearchQuery, pluginUpdateBody } from '../../shared/schemas.js';
import { actorName } from '../lib/audit.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { badRequest } from '../lib/errors.js';
import { PluginSyncService } from '../services/pluginSync.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerPluginRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/plugins', async () => ({ items: deps.pluginCatalog.list(deps.pluginZipChecks.all()) }));

  // Typeahead for the wordpress.org directory. Results are cached in-process, but the route
  // still gets its own limit so a stuck typeahead cannot eat the global budget.
  r.get(
    '/api/plugins/search',
    { schema: { querystring: pluginSearchQuery }, config: { rateLimit: { max: 120, timeWindow: 60_000 } } },
    async (req) => deps.wporg.search(req.query.q, req.query.page),
  );

  r.post('/api/plugins', { schema: { body: pluginCreateBody } }, async (req, reply) => {
    const plugin = await deps.pluginCatalog.createWporg(req.body);
    return reply.status(201).send({ plugin });
  });

  // multipart: file field "file", optional text fields "name", "isDefault"
  r.post('/api/plugins/upload', async (req, reply) => {
    const data = await req.file();
    if (!data) throw badRequest('Expected a multipart upload with a "file" field');
    const fields = data.fields as Record<string, { value?: string } | undefined>;
    const name = fields.name?.value;
    const isDefault = fields.isDefault?.value === 'true';
    const plugin = await deps.pluginCatalog.saveZip(data.filename ?? 'plugin.zip', data.file, { name, isDefault });
    if (plugin.zipPath) {
      // Best-effort fan-out to the other servers; installs also lazily re-ensure the zip.
      void new PluginSyncService(deps.db, deps.config, deps.servers).pushToAll(plugin.zipPath, (m) =>
        deps.log.warn(m),
      );
      // Its malware check: what sites' copies of it can be vouched for with.
      if (deps.settings.get('scanEnabled') !== false) deps.pluginZipChecks.request(deps.worker, plugin.id);
    }
    return reply.status(201).send({ plugin });
  });

  // A zip's malware check: what it holds, what AMWScan said, and whether anyone reviewed it.
  r.get('/api/plugins/:id/check', { schema: { params: idParams } }, async (req) => {
    const plugin = deps.pluginCatalog.byId(req.params.id);
    if (plugin.kind !== 'zip') throw badRequest("A wordpress.org plugin is checked on each site against wordpress.org's own checksums");
    return deps.pluginZipChecks.details(plugin.id);
  });

  r.post('/api/plugins/:id/check', { schema: { params: idParams } }, async (req, reply) => {
    const { job } = deps.pluginZipChecks.request(deps.worker, req.params.id);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/plugins/:id/check/review', { schema: { params: idParams } }, async (req) => {
    deps.pluginCatalog.byId(req.params.id);
    return { check: deps.pluginZipChecks.review(req.params.id, actorName(req) ?? 'unknown') };
  });

  r.put('/api/plugins/:id', { schema: { params: idParams, body: pluginUpdateBody } }, async (req) => ({
    plugin: deps.pluginCatalog.update(req.params.id, req.body),
  }));

  r.delete('/api/plugins/:id', { schema: { params: idParams } }, async (req, reply) => {
    await deps.pluginCatalog.delete(req.params.id);
    return reply.status(204).send();
  });
}
