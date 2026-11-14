/**
 * A container app's own endpoints (services/apps.ts): its settings, routes, registry login and
 * deploys; the hook token; uploaded image archives; and the deploy hook itself, which takes no key
 * but the app's token, in a header of its own.
 */
// @docs sites/container
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  appDeployBody,
  appImageBody,
  appPatchBody,
  appRegistryAuthBody,
  appRoutesBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { UPLOAD_ID_RE } from '../../shared/siteFilePath.js';
import { AppError, badRequest, conflict, tooManyRequests } from '../lib/errors.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { requireAccess } from '../plugins/auth.js';
import { DEPLOY_TOKEN_HEADER, MAX_IMAGE_UPLOAD_BYTES } from '../services/apps.js';
import type { AppDeps } from './deps.js';
import { holdSigningDomainsOf } from './sites.js';

const slugParams = z.object({ slug: siteSlugParam });
const uploadParams = z.object({ id: z.string().regex(UPLOAD_ID_RE, 'an upload id is 16-64 characters of A-Z, a-z, 0-9, _ and -') });
const emptyAsUnset = (v: unknown) => (v === '' ? undefined : v);
const uploadQuery = z
  .object({
    offset: z.preprocess(emptyAsUnset, z.coerce.number().int().min(0)),
    size: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(MAX_IMAGE_UPLOAD_BYTES)),
  })
  .strict();

/** One chunk of an upload, as the database upload takes them. */
const CHUNK_BYTES = 8 * 1024 * 1024;

export async function registerAppRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Its own scope: the raw-body parser is for the upload chunks alone (as in routes/databases.ts).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const appOf = (slug: string) => deps.apps.detail(deps.apps.bySlug(slug).site);

  r.get('/api/sites/:slug/app', { schema: { params: slugParams } }, async (req) => appOf(req.params.slug));

  r.patch('/api/sites/:slug/app', { schema: { params: slugParams, body: appPatchBody } }, async (req, reply) => {
    const { job } = deps.apps.patch(req.params.slug, req.body);
    const body = { app: appOf(req.params.slug), job: job ? jobToDto(job, viewerOf(req)) : null };
    return job ? reply.status(202).header('location', `/api/jobs/${job.id}`).send(body) : body;
  });

  r.put('/api/sites/:slug/app/routes', { schema: { params: slugParams, body: appRoutesBody } }, async (req) => {
    await deps.apps.setRoutes(req.params.slug, req.body.routes, {
      own: (hosts, held) => holdSigningDomainsOf(deps, req, hosts, held),
      // A path of another site's domain: what answers there is a matter for whoever holds both, as mail identity is.
      borrowed: (hosts) => requireAccess(req, 'full', `a route on another site's domain (${hosts.join(', ')})`),
    });
    return appOf(req.params.slug);
  });

  r.put('/api/sites/:slug/app/registry-auth', { schema: { params: slugParams, body: appRegistryAuthBody } }, async (req) => {
    deps.apps.setRegistryAuth(req.params.slug, req.body);
    return appOf(req.params.slug);
  });

  r.post('/api/sites/:slug/app/deploy', { schema: { params: slugParams, body: appDeployBody } }, async (req, reply) => {
    const job = await deps.apps.deploy(req.params.slug, req.body);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/sites/:slug/app/image', { schema: { params: slugParams, body: appImageBody } }, async (req, reply) => {
    const job = await deps.apps.deployUpload(req.params.slug, req.body.uploadId, req.body.backupFirst);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.get('/api/sites/:slug/app/deploys', { schema: { params: slugParams } }, async (req) => ({
    items: deps.apps.deploys(deps.apps.bySlug(req.params.slug).site),
  }));

  r.post('/api/sites/:slug/app/deploy-token', { schema: { params: slugParams } }, async (req) => ({
    token: deps.apps.makeDeployToken(req.params.slug),
    header: 'X-WPL7-Deploy-Token',
    url: '/api/hooks/app-deploy',
  }));

  r.delete('/api/sites/:slug/app/deploy-token', { schema: { params: slugParams } }, async (req, reply) => {
    deps.apps.clearDeployToken(req.params.slug);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- uploaded images

  let inflightBytes = 0;
  r.put(
    '/api/app-uploads/:id',
    { schema: { params: uploadParams, querystring: uploadQuery }, config: { rateLimit: { max: 1200, timeWindow: 60_000 } } },
    async (req) => {
      const { id } = req.params;
      const { offset, size } = req.query;
      deps.apps.assertUploadFree(id);
      const file = deps.apps.uploadPath(id);
      const length = chunkLength(req);
      if (offset + length > size) throw badRequest('The chunk goes past the size given');
      if (inflightBytes + length > 64 * 1024 * 1024) throw tooManyRequests('The panel is receiving too much at once; retry in a moment');
      inflightBytes += length;
      try {
        if (offset === 0) {
          await fsp.mkdir(deps.apps.uploadDir(), { recursive: true, mode: 0o700 });
          const disk = await fsp.statfs(deps.apps.uploadDir()).catch(() => null);
          // The archive, and its copy in the server's image store when it is the panel's own.
          if (disk && disk.bavail * disk.bsize < size * 2) {
            throw new AppError('conflict', 507, `Not enough free disk on the panel's server: ${Math.round((disk.bavail * disk.bsize) / 1e6)} MB free, about ${Math.round((size * 2) / 1e6)} MB needed`);
          }
          await writeChunk(req, file, length, 'w');
        } else {
          const have = (await fsp.stat(file).catch(() => null))?.size ?? 0;
          if (have !== offset) throw conflict(`The upload has ${have} bytes; send the chunk from there`, { received: have });
          await writeChunk(req, file, length, 'a');
        }
        const received = offset + length;
        return { received, complete: received === size };
      } finally {
        inflightBytes -= length;
      }
    },
  );

  r.delete('/api/app-uploads/:id', { schema: { params: uploadParams } }, async (req, reply) => {
    deps.apps.assertUploadFree(req.params.id);
    await fsp.rm(deps.apps.uploadPath(req.params.id), { force: true });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- the hook

  r.post(
    '/api/hooks/app-deploy',
    // Per address: a CI job calls it once per push; a guesser gets 30 tries a minute at a 256-bit token.
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req, reply) => {
      const token = req.headers[DEPLOY_TOKEN_HEADER];
      const res = typeof token === 'string' ? deps.apps.hook(token) : null;
      if (!res) return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unknown deploy token.' } });
      return reply.status(202).send({
        app: res.slug,
        outcome: res.outcome,
        jobId: res.job?.id ?? null,
        message:
          res.outcome === 'queued'
            ? 'A deploy is queued.'
            : res.outcome === 'waiting'
              ? 'A deploy is queued already; it takes the newest image when it starts.'
              : 'The app is busy; it is deployed once it is free.',
      });
    },
  );
}

/** The chunk's size, as its Content-Length says: it has to be known up front. */
function chunkLength(req: FastifyRequest): number {
  const encoding = req.headers['content-encoding'];
  if (encoding && encoding !== 'identity') throw new AppError('validation_error', 415, 'Send the chunk as it is (no Content-Encoding)');
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1) throw new AppError('validation_error', 411, 'Send a Content-Length: the size has to be known up front');
  if (length > CHUNK_BYTES) throw new AppError('validation_error', 413, `Too large: at most ${CHUNK_BYTES} bytes per chunk`);
  if (!(req.body instanceof Readable)) throw new AppError('validation_error', 415, 'Send the chunk as application/octet-stream');
  return length;
}

/** Stream the chunk to the file, refusing a body that is not as long as it said. A short or long one leaves the file as it was. */
async function writeChunk(req: FastifyRequest, file: string, length: number, flags: 'w' | 'a'): Promise<void> {
  const before = flags === 'a' ? ((await fsp.stat(file).catch(() => null))?.size ?? 0) : 0;
  let got = 0;
  const counted = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      got += chunk.length;
      if (got > length) throw badRequest('The body is longer than its Content-Length');
      yield chunk;
    }
  };
  try {
    await pipeline(req.body as Readable, counted, fs.createWriteStream(file, { flags, mode: 0o600 }));
    if (got !== length) throw badRequest('The body is shorter than its Content-Length');
  } catch (err) {
    await fsp.truncate(file, before).catch(() => undefined);
    throw err;
  }
}
