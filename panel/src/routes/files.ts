// @docs sites/files
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  siteFileChmodBody,
  siteFileCompressBody,
  siteFileCopyBody,
  siteFileDeleteBody,
  siteFileExtractBody,
  siteFileFixOwnershipBody,
  siteFileMkdirBody,
  siteFileMoveBody,
  siteFileQuery,
  siteFileSearchQuery,
  siteFileWriteQuery,
  siteFilesQuery,
  siteSlugParam,
  siteUploadAbortQuery,
  siteUploadParams,
  siteUploadQuery,
} from '../../shared/schemas.js';
import { FILE_LIMITS, siteFileBase, siteFileParent } from '../../shared/siteFilePath.js';
import { AppError, badRequest, conflict, forbidden, tooManyRequests } from '../lib/errors.js';
import { attachmentDisposition } from '../lib/contentDisposition.js';
import { audit as auditLog } from '../lib/audit.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import type { SiteRow } from '../db/schema.js';
import type { SiteFilesService } from '../services/siteFiles.js';
import type { AppDeps } from './deps.js';

/**
 * Web FTP: browse, read, write, upload and download a site's files.
 *
 * The routes only decide WHETHER something may happen; how it happens - always inside the
 * site's own container, as www-data - is services/siteFiles.ts, and why is written there.
 */

const slugParams = z.object({ slug: siteSlugParam });

/**
 * The one kind of job a file change may run beside. A backup reads the files and replaces
 * nothing; a restore or a move replaces the whole folder, and an edit made meanwhile would
 * vanish without a word - so every other job makes the site's files read-only until it ends.
 */
const FILE_SAFE_JOBS = new Set(['backup.create']);

/**
 * Request bodies held in memory at once, across every save and upload chunk. Bodies are
 * read whole before anything starts in the container (a slow client never holds an exec,
 * or a remote server's SSH channel, open); this is what bounds the memory that costs.
 */
const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;

export async function registerFileRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Awaited, and its own scope: the octet-stream parser below is for these routes alone, and
  // buildServer never calls ready() - an un-awaited register would leave these routes out of
  // the route table the API docs are checked against.
  await app.register(async (scope) => {
    // Hand the raw body to the handler unread. Fastify parses bodies BEFORE the auth gate
    // runs, so reading here would let anyone make the panel buffer 8 MiB; the handlers read
    // it once the caller is known (readBody).
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  let inflightBytes = 0;

  /** The site, unless it is being created or deleted: then there are no files to work on. */
  const siteOf = (slug: string): SiteRow => {
    const site = deps.sites.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site "${site.slug}" is ${site.status}; its files are not available`);
    }
    return site;
  };

  /** Where the files are worked on: the site's container, which has to be running. */
  const containerOf = async (site: SiteRow): Promise<{ container: string; files: SiteFilesService }> => {
    const server = deps.servers.handleFor(site.serverId);
    const state = await server.docker.containerState(site.containerName);
    if (state !== 'running') throw conflict(`Site container is ${state}; start the site to work on its files`);
    return { container: site.containerName, files: server.siteFiles };
  };

  /** Reading waits for nothing, and nothing waits for it. */
  const reading = async (slug: string) => {
    const site = siteOf(slug);
    return { site, ...(await containerOf(site)) };
  };

  /**
   * Run a change to the site's files with the site held (JobWorker.holdSite) from the job
   * check until the change is done: refused while any job but a backup has the site, and no
   * job starts on it meanwhile - a restore queued a second later waits for the change instead
   * of replacing the folder under it. A body is read BEFORE this, never inside: the site's
   * jobs wait for the change, not for a slow client.
   */
  const changing = async <T>(
    site: SiteRow,
    work: (at: { container: string; files: SiteFilesService }) => Promise<T>,
  ): Promise<T> => {
    const release = deps.worker.holdSite(site, FILE_SAFE_JOBS);
    try {
      return await work(await containerOf(site));
    } finally {
      release();
    }
  };

  /**
   * The body of a PUT, whole, once the caller has been let in. Needs a Content-Length (a
   * chunked body could be any size) no larger than `max`, sent as application/octet-stream.
   * `release` hands its bytes back to the in-flight budget; call it when the body is done with.
   */
  const readBody = async (req: FastifyRequest, max: number): Promise<{ body: Buffer; release: () => void }> => {
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity') {
      throw new AppError('validation_error', 415, 'Send the content uncompressed (no Content-Encoding)');
    }
    const declared = req.headers['content-length'];
    if (declared === undefined) {
      if (req.headers['transfer-encoding']) {
        throw new AppError('validation_error', 411, 'Send a Content-Length: the size has to be known up front');
      }
      return { body: Buffer.alloc(0), release: () => undefined };
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw badRequest('Content-Length is not a number');
    if (length > max) {
      throw new AppError('validation_error', 413, `Too large: at most ${max} bytes per request`);
    }
    if (length > 0 && !(req.body instanceof Readable)) {
      throw new AppError('validation_error', 415, 'Send the content as application/octet-stream');
    }
    if (inflightBytes + length > MAX_INFLIGHT_BYTES) {
      throw tooManyRequests('The panel is receiving too much at once; retry in a moment');
    }
    inflightBytes += length;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflightBytes -= length;
    };
    try {
      const chunks: Buffer[] = [];
      let got = 0;
      if (length > 0) {
        for await (const chunk of req.body as Readable) {
          got += (chunk as Buffer).length;
          if (got > length) throw badRequest('The body is longer than its Content-Length');
          chunks.push(chunk as Buffer);
        }
      }
      if (got !== length) throw badRequest('The body is shorter than its Content-Length');
      return { body: Buffer.concat(chunks, length), release };
    } catch (err) {
      release();
      throw err;
    }
  };

  /**
   * Raw site files are served from the panel's own origin, and dev sites share the panel's
   * registrable domain - to the browser they are the SAME SITE, so a `SameSite=strict`
   * session cookie still goes along with requests a compromised site's pages start
   * (`<script src>`, `<img>`, a top-level navigation). Only requests the panel's own pages
   * made, or the operator typed, may read raw bytes with a cookie. API keys never ride along
   * by themselves, so they need no such check.
   */
  const refuseForeignReads = (req: FastifyRequest): void => {
    if (req.authVia !== 'session') return;
    const from = req.headers['sec-fetch-site'];
    if (from !== undefined && from !== 'same-origin' && from !== 'none') {
      throw forbidden('Site files can only be read from the panel itself');
    }
  };

  /**
   * Headers for raw bytes off a site's disk. Whatever the file is - an .html page, an .svg
   * with a script in it - it must never render or run in the panel's origin: a download,
   * never sniffed, sandboxed if opened anyway, not embeddable elsewhere, not cached.
   */
  const rawHeaders = (reply: FastifyReply, filename: string): FastifyReply =>
    reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', attachmentDisposition(filename))
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'no-store');

  /** One structured line per change (and per content read), naming who - see lib/audit.ts. */
  const audit = (req: FastifyRequest, site: SiteRow, op: string, fields: Record<string, unknown>): void =>
    auditLog(req, 'files', site.slug, op, fields);

  /**
   * `If-Match` / `If-None-Match: *` as write preconditions (RFC 9110; strong ETags only).
   * `If-Match: *` is its own condition - the file must exist, in any version - not an ETag.
   */
  const preconditions = (req: FastifyRequest): { ifMatch?: string; mustExist?: boolean; createOnly?: boolean } => {
    const ifNoneMatch = req.headers['if-none-match'];
    const ifMatch = req.headers['if-match'];
    if (ifNoneMatch !== undefined) {
      if (ifNoneMatch.trim() !== '*') throw badRequest('If-None-Match only takes "*" (create, never replace)');
      if (ifMatch !== undefined) throw badRequest('Send If-Match or If-None-Match, not both');
      return { createOnly: true };
    }
    if (ifMatch === undefined) return {};
    const tag = ifMatch.trim();
    if (tag === '*') return { mustExist: true };
    const m = /^"([0-9a-f]{64})"$/.exec(tag);
    if (!m) throw badRequest('If-Match takes the ETag a read returned, quoted');
    return { ifMatch: m[1] };
  };

  // ------------------------------------------------------------------ reading

  r.get('/api/sites/:slug/files', { schema: { params: slugParams, querystring: siteFilesQuery } }, async (req) => {
    const { container, files } = await reading(req.params.slug);
    return files.list(container, req.query.path);
  });

  r.get(
    '/api/sites/:slug/files/content',
    { schema: { params: slugParams, querystring: siteFileQuery }, exposeHeadRoute: false },
    async (req, reply) => {
      refuseForeignReads(req);
      const { site, container, files } = await reading(req.params.slug);
      const { bytes, etag } = await files.read(container, req.query.path);
      audit(req, site, 'read', { path: req.query.path, bytes: bytes.length });
      rawHeaders(reply, siteFileBase(req.query.path)).header('etag', `"${etag}"`);
      return reply.send(bytes);
    },
  );

  r.get(
    '/api/sites/:slug/files/download',
    { schema: { params: slugParams, querystring: siteFilesQuery }, exposeHeadRoute: false },
    async (req, reply) => {
      refuseForeignReads(req);
      const { site, container, files } = await reading(req.params.slug);
      const path = req.query.path;
      const release = files.acquireDownload();
      try {
        const what = await files.probeDownload(container, path);
        // A closed tab destroys the response; the exec hangs up with it (see execToStream).
        const hangUp = new AbortController();
        reply.raw.once('close', () => hangUp.abort());
        const out = new PassThrough();
        const name = siteFileBase(path) || site.slug;
        const streaming =
          what.kind === 'file'
            ? files.streamFile(container, path, what.size, out, hangUp.signal)
            : files.streamFolder(container, path, name, out, hangUp.signal);
        streaming
          .catch((err: unknown) => {
            req.log.warn(`files: download of "${path}" from site "${site.slug}" stopped: ${err instanceof Error ? err.message : err}`);
          })
          .finally(release);
        audit(req, site, 'download', { path, kind: what.kind, ...(what.kind === 'file' ? { bytes: what.size } : {}) });
        rawHeaders(reply, what.kind === 'file' ? name : `${name}.tar.gz`);
        if (what.kind === 'file') reply.header('content-length', String(what.size));
        return reply.send(out);
      } catch (err) {
        release();
        throw err;
      }
    },
  );

  r.get(
    '/api/sites/:slug/files/search',
    {
      schema: { params: slugParams, querystring: siteFileSearchQuery },
      // A content search reads every file under the folder; a held-down Enter must not
      // turn into a disk-thrashing loop.
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (req) => {
      const { container, files } = await reading(req.params.slug);
      return files.search(container, req.query);
    },
  );

  // ------------------------------------------------------------------ writing

  r.put(
    '/api/sites/:slug/files/content',
    { schema: { params: slugParams, querystring: siteFileWriteQuery } },
    async (req) => {
      const conditions = preconditions(req);
      const site = siteOf(req.params.slug);
      const { body, release } = await readBody(req, FILE_LIMITS.editBytes);
      try {
        return await changing(site, async ({ container, files }) => {
          const written = await files.write(container, req.query.path, body, { ...conditions, lint: req.query.lint });
          audit(req, site, conditions.createOnly ? 'create' : 'save', { path: req.query.path, bytes: body.length });
          return written;
        });
      } finally {
        release();
      }
    },
  );

  r.put(
    '/api/sites/:slug/files/uploads/:id',
    {
      schema: { params: siteUploadParams, querystring: siteUploadQuery },
      // A folder of small files is one request per file; the global 300/min would cut a
      // theme's worth of images off half-way.
      config: { rateLimit: { max: 1200, timeWindow: 60_000 } },
    },
    async (req) => {
      const site = siteOf(req.params.slug);
      const { body, release } = await readBody(req, FILE_LIMITS.chunkBytes);
      try {
        return await changing(site, async ({ container, files }) => {
          const { replayed, ...res } = await files.appendChunk(container, { ...req.query, id: req.params.id }, body);
          if (res.written && !replayed) audit(req, site, 'upload', { path: req.query.path, bytes: req.query.size });
          return res;
        });
      } finally {
        release();
      }
    },
  );

  r.delete(
    '/api/sites/:slug/files/uploads/:id',
    { schema: { params: siteUploadParams, querystring: siteUploadAbortQuery } },
    async (req, reply) => {
      // Not held: it only removes what arrived of an upload, which a job may as well find gone.
      const { container, files } = await reading(req.params.slug);
      await files.abortUpload(container, req.query.path, req.params.id);
      return reply.status(204).send();
    },
  );

  r.post('/api/sites/:slug/files/mkdir', { schema: { params: slugParams, body: siteFileMkdirBody } }, async (req) => {
    const site = siteOf(req.params.slug);
    return changing(site, async ({ container, files }) => {
      const entry = await files.mkdir(container, req.body.path);
      audit(req, site, 'mkdir', { path: req.body.path });
      return { entry };
    });
  });

  r.post('/api/sites/:slug/files/move', { schema: { params: slugParams, body: siteFileMoveBody } }, async (req) => {
    const site = siteOf(req.params.slug);
    return changing(site, async ({ container, files }) => {
      const entry = await files.move(container, req.body.from, req.body.to, req.body.overwrite);
      audit(req, site, 'move', { from: req.body.from, to: req.body.to, overwrite: req.body.overwrite });
      return { entry };
    });
  });

  r.post('/api/sites/:slug/files/copy', { schema: { params: slugParams, body: siteFileCopyBody } }, async (req) => {
    const site = siteOf(req.params.slug);
    return changing(site, async ({ container, files }) => {
      const entry = await files.copy(container, req.body.from, req.body.to);
      audit(req, site, 'copy', { from: req.body.from, to: req.body.to });
      return { entry };
    });
  });

  r.post('/api/sites/:slug/files/delete', { schema: { params: slugParams, body: siteFileDeleteBody } }, async (req) => {
    const site = siteOf(req.params.slug);
    return changing(site, async ({ container, files }) => {
      await files.remove(container, req.body.paths);
      audit(req, site, 'delete', { paths: req.body.paths });
      return { deleted: req.body.paths.length };
    });
  });

  r.post('/api/sites/:slug/files/chmod', { schema: { params: slugParams, body: siteFileChmodBody } }, async (req) => {
    const site = siteOf(req.params.slug);
    return changing(site, async ({ container, files }) => {
      const entry = await files.chmod(container, req.body.path, req.body.mode);
      audit(req, site, 'chmod', { path: req.body.path, mode: req.body.mode });
      return { entry };
    });
  });

  r.post(
    '/api/sites/:slug/files/fix-ownership',
    { schema: { params: slugParams, body: siteFileFixOwnershipBody } },
    async (req) => {
      const site = siteOf(req.params.slug);
      return changing(site, async ({ container, files }) => {
        await files.fixOwnership(container, req.body.path);
        audit(req, site, 'fix-ownership', { path: req.body.path });
        return { ok: true };
      });
    },
  );

  // ------------------------------------------------------------------ archives (jobs)

  r.post('/api/sites/:slug/files/extract', { schema: { params: slugParams, body: siteFileExtractBody } }, async (req, reply) => {
    const site = siteOf(req.params.slug);
    const job = await changing(site, async () =>
      deps.worker.enqueue(
        'files.extract',
        { siteId: site.id, path: req.body.path, to: req.body.to, overwrite: req.body.overwrite },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      ),
    );
    audit(req, site, 'extract', { path: req.body.path, to: req.body.to, job: job.id });
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post(
    '/api/sites/:slug/files/compress',
    { schema: { params: slugParams, body: siteFileCompressBody } },
    async (req, reply) => {
      const folder = siteFileParent(req.body.to);
      const outside = req.body.paths.find((p) => siteFileParent(p) !== folder);
      if (outside !== undefined) throw badRequest(`"${outside}" is not in the folder the archive goes into`);
      const site = siteOf(req.params.slug);
      const job = await changing(site, async () =>
        deps.worker.enqueue(
          'files.compress',
          { siteId: site.id, paths: req.body.paths, to: req.body.to, overwrite: req.body.overwrite },
          { id: site.id, slug: site.slug, serverId: site.serverId },
        ),
      );
      audit(req, site, 'compress', { paths: req.body.paths, to: req.body.to, job: job.id });
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );
}
