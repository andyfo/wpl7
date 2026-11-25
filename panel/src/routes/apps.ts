/**
 * A container app's own endpoints (services/apps.ts): its settings, routes, registry login and
 * deploys; the hook token; uploaded image archives; and the deploy hook itself, which takes no key
 * but the app's token, in a header of its own.
 */
// @docs sites/container
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  APP_MOUNT_NAME_RE,
  appDeployBody,
  appImageBody,
  appPatchBody,
  appRegistryAuthBody,
  appRoutesBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { UPLOAD_ID_RE } from '../../shared/siteFilePath.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { jobToDto, seesCommands, viewerOf } from '../lib/dto.js';
import { requireAccess } from '../plugins/auth.js';
import { DEPLOY_TOKEN_HEADER, MAX_IMAGE_UPLOAD_BYTES } from '../services/apps.js';
import { appLogLines, appPaths } from '../services/appSpec.js';
import type { AppDeps } from './deps.js';
import { chunkLength, readChunk, receiveChunk, withChunkBudget } from './uploadChunks.js';
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

/** A mount's archive: at most this big. */
const MAX_MOUNT_UPLOAD_BYTES = 4 * 1024 ** 3;
const mountUploadQuery = z
  .object({
    offset: z.preprocess(emptyAsUnset, z.coerce.number().int().min(0)),
    size: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(MAX_MOUNT_UPLOAD_BYTES)),
  })
  .strict();
const appLogsQuery = z
  .object({
    tail: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(5000)).default(500),
    /** The last line's time, as a line gives it: only newer ones come back. */
    since: z.preprocess(emptyAsUnset, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, 'a time as a log line gives it')).optional(),
  })
  .strict();
const mountParams = z.object({ slug: siteSlugParam, name: z.string().regex(APP_MOUNT_NAME_RE, '1-32 of a-z, 0-9 and -') });
const appMountFillBody = z.object({ uploadId: z.string().regex(UPLOAD_ID_RE, 'an upload id is 16-64 characters of A-Z, a-z, 0-9, _ and -') }).strict();

export async function registerAppRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Its own scope: the raw-body parser is for the upload chunks alone (as in routes/databases.ts).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const appOf = (slug: string, opts: { logTails?: boolean } = {}) => deps.apps.detail(deps.apps.bySlug(slug).site, opts);
  // A failed deploy's last lines are what the app printed, as its log is: for whoever may read that.
  const logTailsFor = (req: FastifyRequest) => ({ logTails: seesCommands(viewerOf(req)) });

  r.get('/api/sites/:slug/app', { schema: { params: slugParams } }, async (req) => appOf(req.params.slug, logTailsFor(req)));

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

  // Its container's log: what the app prints, which can hold anything it knows, hence Manage.
  r.get('/api/sites/:slug/app/logs', { schema: { params: slugParams, querystring: appLogsQuery } }, async (req) => {
    const { site } = deps.apps.bySlug(req.params.slug);
    const { tail, since } = req.query;
    const sinceSec = since ? Math.floor(Date.parse(since) / 1000) : undefined;
    const raw = await deps.servers.handleFor(site.serverId).docker.containerLogs(site.containerName, {
      tail,
      timestamps: true,
      ...(sinceSec !== undefined && Number.isFinite(sinceSec) ? { sinceSec } : {}),
    });
    return { lines: appLogLines(raw, since) };
  });

  r.get('/api/sites/:slug/app/deploys', { schema: { params: slugParams } }, async (req) => ({
    items: deps.apps.deploys(deps.apps.bySlug(req.params.slug).site, logTailsFor(req)),
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

  r.put(
    '/api/app-uploads/:id',
    { schema: { params: uploadParams, querystring: uploadQuery }, config: { rateLimit: { max: 1200, timeWindow: 60_000 } } },
    async (req) => {
      const { id } = req.params;
      const { offset, size } = req.query;
      deps.apps.assertUploadFree(id);
      // The archive, and its copy in the server's image store when it is the panel's own.
      return receiveChunk(req, { dir: deps.apps.uploadDir(), file: deps.apps.uploadPath(id), offset, size, need: size * 2 });
    },
  );

  r.delete('/api/app-uploads/:id', { schema: { params: uploadParams } }, async (req, reply) => {
    deps.apps.assertUploadFree(req.params.id);
    await fsp.rm(deps.apps.uploadPath(req.params.id), { force: true });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- mounts

  // A mount's archive goes to the app's own server, chunk by chunk, as a database dump does.
  r.put(
    '/api/sites/:slug/app/mount-uploads/:id',
    { schema: { params: slugParams.extend(uploadParams.shape), querystring: mountUploadQuery }, config: { rateLimit: { max: 1200, timeWindow: 60_000 } } },
    async (req) => {
      const { site } = deps.apps.bySlug(req.params.slug);
      const { offset, size } = req.query;
      deps.apps.assertUploadFree(`mount:${req.params.id}`);
      const server = deps.servers.handleFor(site.serverId);
      const file = appPaths(deps.config, site.slug).mountUpload(req.params.id);
      const length = chunkLength(req);
      if (offset + length > size) throw badRequest('The chunk goes past the size given');
      return withChunkBudget(length, async () => {
        const body = await readChunk(req, length);
        if (offset === 0) {
          const dir = path.dirname(file);
          await server.files.mkdirp(dir, { mode: 0o700 });
          const disk = await server.files.statvfs(dir).catch(() => null);
          // The archive, what it unpacks to, and the mount's old files until the swap.
          if (disk && disk.freeBytes < size * 3) {
            throw new AppError('conflict', 507, `Not enough free disk on the app's server: ${Math.round(disk.freeBytes / 1e6)} MB free, about ${Math.round((size * 3) / 1e6)} MB needed`);
          }
          await server.files.writeFile(file, body, { mode: 0o600 });
        } else {
          const have = (await server.files.stat(file))?.sizeBytes ?? 0;
          if (have !== offset) throw conflict(`The upload has ${have} bytes; send the chunk from there`, { received: have });
          await server.files.appendFile(file, body);
        }
        const received = offset + length;
        return { received, complete: received === size };
      });
    },
  );

  r.delete('/api/sites/:slug/app/mount-uploads/:id', { schema: { params: slugParams.extend(uploadParams.shape) } }, async (req, reply) => {
    const { site } = deps.apps.bySlug(req.params.slug);
    deps.apps.assertUploadFree(`mount:${req.params.id}`);
    await deps.servers.handleFor(site.serverId).files.rm(appPaths(deps.config, site.slug).mountUpload(req.params.id));
    return reply.status(204).send();
  });

  r.put('/api/sites/:slug/app/mounts/:name', { schema: { params: mountParams, body: appMountFillBody } }, async (req, reply) => {
    const job = await deps.apps.fillMount(req.params.slug, req.params.name, req.body.uploadId);
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
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
