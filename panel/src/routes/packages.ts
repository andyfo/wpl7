/**
 * Duplicator packages for New site (services/duplicator.ts): the package, chunk by chunk, to the
 * panel's own disk; what it holds; and throwing it away. POST /api/sites makes the site from one.
 */
// @docs sites/duplicator
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { UPLOAD_ID_RE } from '../../shared/siteFilePath.js';
import { badRequest } from '../lib/errors.js';
import { PACKAGE_UPLOAD_MAX_BYTES, PackageError } from '../services/duplicator.js';
import type { AppDeps } from './deps.js';
import { receiveChunk } from './uploadChunks.js';

const params = z.object({ id: z.string().regex(UPLOAD_ID_RE, 'an upload id is 16-64 characters of A-Z, a-z, 0-9, _ and -') });
const emptyAsUnset = (v: unknown) => (v === '' ? undefined : v);
const query = z
  .object({
    offset: z.preprocess(emptyAsUnset, z.coerce.number().int().min(0)),
    size: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(PACKAGE_UPLOAD_MAX_BYTES)),
  })
  .strict();
/** What has to stay free on the panel's disk besides the package. */
const DISK_MARGIN = 1024 ** 3;

export async function registerPackageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Its own scope: the raw-body parser is for the chunks alone (as in routes/apps.ts).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.put('/api/package-uploads/:id', { schema: { params, querystring: query }, config: { rateLimit: { max: 1200, timeWindow: 60_000 } } }, async (req) => {
    const { id } = req.params;
    const { offset, size } = req.query;
    const file = deps.packages.path(id);
    deps.packages.beginWrite(id);
    try {
      return await receiveChunk(req, { dir: deps.packages.dir(), file, offset, size, need: size + DISK_MARGIN, keepFree: DISK_MARGIN });
    } finally {
      deps.packages.endWrite(id);
    }
  });

  r.get('/api/package-uploads/:id', { schema: { params } }, async (req) => {
    try {
      return (await deps.packages.inspect(req.params.id)).dto;
    } catch (err) {
      // What the archive is, in its own words: not a server fault.
      if (err instanceof PackageError) throw badRequest(err.message);
      throw err;
    }
  });

  r.delete('/api/package-uploads/:id', { schema: { params } }, async (req, reply) => {
    deps.packages.assertFree(req.params.id);
    await deps.packages.remove(req.params.id);
    return reply.status(204).send();
  });
}
