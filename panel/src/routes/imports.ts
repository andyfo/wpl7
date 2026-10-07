// @docs sites/import
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { importCreateBody, importIdParams, importRunBody } from '../../shared/schemas.js';
import type { ImportRow } from '../db/schema.js';
import { actorName } from '../lib/audit.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { attachmentDisposition } from '../lib/contentDisposition.js';
import { PANEL_VERSION } from '../lib/version.js';
import { PluginRefusal } from '../services/imports.js';
import type { AppDeps } from './deps.js';

/** The header the migration plugin carries its import's token in (docs/internal/import-protocol.md). */
export const IMPORT_TOKEN_HEADER = 'x-wpl7-import-token';

/** A connect body holds the old site's report: thousands of plugins and tables at most. */
const CONNECT_BODY_LIMIT = 4 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** The import a migration plugin's call is for, once its token was accepted. */
    importRow: ImportRow | null;
  }
}

export function registerImportRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('importRow', null);

  r.get('/api/imports', async () => ({ items: deps.imports.list() }));

  r.post('/api/imports', { schema: { body: importCreateBody } }, async (req, reply) => {
    const row = deps.imports.create(req.body, actorName(req));
    return reply.status(201).send(deps.imports.toDto(row));
  });

  r.get('/api/imports/:id', { schema: { params: importIdParams } }, async (req) =>
    deps.imports.toDto(deps.imports.get(req.params.id)),
  );

  r.get('/api/imports/:id/plugin', { schema: { params: importIdParams } }, async (req, reply) => {
    const zip = deps.imports.pluginZip(req.params.id);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', attachmentDisposition(zip.name))
      .header('cache-control', 'no-store')
      .send(zip.data);
  });

  r.get('/api/imports/:id/code', { schema: { params: importIdParams } }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(deps.imports.connectionCode(req.params.id)),
  );

  r.post('/api/imports/:id/run', { schema: { params: importIdParams, body: importRunBody } }, async (req, reply) => {
    const { job } = deps.imports.start(req.params.id, req.body);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/imports/:id/retry', { schema: { params: importIdParams } }, async (req, reply) => {
    const { job } = deps.imports.retry(req.params.id);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/imports/:id/disconnect', { schema: { params: importIdParams } }, async (req) =>
    deps.imports.toDto(await deps.imports.disconnect(req.params.id)),
  );

  r.delete('/api/imports/:id', { schema: { params: importIdParams } }, async (req, reply) => {
    await deps.imports.delete(req.params.id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- the plugin's own calls

  /**
   * Open routes (plugins/auth.ts): what lets the plugin in is its import's token, in a header of
   * its own - never `Authorization`, so the API-key check and the activity log never take it for
   * a key. An unknown, disconnected or expired token is a 401 like any other.
   */
  const pluginOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers[IMPORT_TOKEN_HEADER];
    const row = typeof token === 'string' ? deps.imports.byToken(token) : null;
    if (!row) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unknown or ended import. Download the plugin again from the panel.' } });
    }
    req.importRow = row;
  };
  const refusal = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof PluginRefusal)) throw err;
    return reply.status(err.status).send({
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
  };

  app.post(
    '/api/migrate/connect',
    { bodyLimit: CONNECT_BODY_LIMIT, preHandler: pluginOnly, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      try {
        const row = await deps.imports.connect(req.importRow!, req.body);
        return reply.send({
          ok: true,
          import: { id: row.id, status: row.status, label: `Import #${row.id}` },
          panel_version: PANEL_VERSION,
        });
      } catch (err) {
        return refusal(reply, err);
      }
    },
  );

  app.get(
    '/api/migrate/status',
    { preHandler: pluginOnly, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (req, reply) => reply.header('cache-control', 'no-store').send(deps.imports.statusForPlugin(req.importRow!)),
  );
}
