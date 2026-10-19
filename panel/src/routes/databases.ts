// @docs databases/overview, sites/database
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DB_LIMITS,
  dbCreateBody,
  dbImportBody,
  dbParams,
  dbRowDeleteBody,
  dbRowFilters,
  dbRowInsertBody,
  dbRowKey,
  dbRowQuery,
  dbRowUpdateBody,
  dbRowsQuery,
  dbSqlBody,
  dbTableParams,
  dbUploadParams,
  dbUploadQuery,
  unusedDbParams,
} from '../../shared/databases.js';
import { siteSlugParam } from '../../shared/schemas.js';
import { serverDatabases, type SiteRow } from '../db/schema.js';
import { AppError, badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors.js';
import { actorName, audit as auditLog } from '../lib/audit.js';
import { attachmentDisposition } from '../lib/contentDisposition.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { tsStamp } from '../services/backup.js';
import type { AppDeps } from './deps.js';

/**
 * A site's databases, and every server's: what they hold (the browser), what they are called and
 * how big they are, their login, and the jobs that add, drop, refill or re-key them.
 *
 * The browser's queries run as the site's own database user (services/dbBrowser.ts), so what a
 * request can reach is held by MariaDB, not by these routes alone: they add which database of the
 * site's is meant, and that nothing changes one while a job is replacing it.
 */

const slugParams = z.object({ slug: siteSlugParam });

/**
 * The one kind of job a change made in the browser may run beside: a backup reads the database
 * and replaces nothing. A restore, an import or a move replaces it whole, and a row written
 * meanwhile would vanish without a word.
 */
const DB_SAFE_JOBS = new Set(['backup.create']);

/** Request bodies held in memory at once, across every upload chunk. */
const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;

/** JSON bodies that carry a row's values or a block of SQL: larger than the panel's usual 1 MiB. */
const BIG_JSON = 20 * 1024 * 1024;

export async function registerDatabaseRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Its own scope: the raw-body parser below is for the upload chunks alone (as in routes/files.ts).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  let inflightBytes = 0;

  /** A hosted site, whatever its state: reading what it has is always fine. */
  const siteOf = (slug: string): SiteRow => deps.sites.bySlug(slug);

  /** A site that exists in full: not one being created or deleted, whose database may not be there. */
  const usableSite = (slug: string): SiteRow => {
    const site = siteOf(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site "${site.slug}" is ${site.status}; its databases are not available`);
    }
    return site;
  };

  const browser = (site: SiteRow) => deps.servers.handleFor(site.serverId).dbBrowser;

  /** A change, with the site held (JobWorker.holdSite): refused while a job but a backup has it, and no job starts meanwhile. */
  const changing = async <T>(site: SiteRow, work: () => Promise<T>): Promise<T> => {
    const release = deps.worker.holdSite(site, DB_SAFE_JOBS);
    try {
      return await work();
    } finally {
      release();
    }
  };

  const audit = (req: FastifyRequest, site: SiteRow, op: string, fields: Record<string, unknown>): void =>
    auditLog(req, 'database', site.slug, op, fields);

  const accepted = (reply: FastifyReply, req: FastifyRequest, job: Parameters<typeof jobToDto>[0]) =>
    reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });

  /** JSON a query value carries (a filter list, a row's key), checked against its schema. */
  const parseJson = <T>(raw: string | undefined, schema: z.ZodType<T>, what: string, fallback: T): T => {
    if (raw === undefined || raw === '') return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest(`${what} is not JSON`);
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw badRequest(`${what}: ${checked.error.issues[0]?.message ?? 'not valid'}`);
    return checked.data;
  };

  /**
   * A dump is served from the panel's own origin, and dev sites share the panel's registrable
   * domain: the strict session cookie still goes along with what their pages start. Only the
   * panel's own pages, or an address the operator typed, download one (as in routes/files.ts).
   */
  const refuseForeignReads = (req: FastifyRequest): void => {
    if (req.authVia !== 'session') return;
    const from = req.headers['sec-fetch-site'];
    if (from !== undefined && from !== 'same-origin' && from !== 'none') {
      throw forbidden('A database can only be downloaded from the panel itself');
    }
  };

  // ------------------------------------------------------------------ every database

  r.get('/api/databases', async () => deps.databases.list());

  r.post('/api/databases/scan', async () => {
    await deps.databases.scanAll();
    return deps.databases.list();
  });

  r.delete('/api/databases/:serverId/:name', { schema: { params: unusedDbParams } }, async (req, reply) => {
    const { serverId, name } = req.params;
    if (!deps.servers.rowById(serverId)) throw notFound(`Server #${serverId} not found`);
    const claim = deps.databases.claimOf(serverId, name);
    if (claim) {
      throw conflict(
        claim.kind === 'moveCopy'
          ? `"${name}" is the old copy of ${claim.slug}, left by a move; finalize the move to drop it`
          : `"${name}" belongs to ${claim.slug}; delete it from the site instead`,
      );
    }
    const known = deps.db
      .select()
      .from(serverDatabases)
      .where(and(eq(serverDatabases.serverId, serverId), eq(serverDatabases.name, name)))
      .get();
    if (!known) throw notFound(`No database "${name}" was found on that server; refresh the list`);
    const job = deps.worker.enqueue('database.deleteUnused', { serverId, name }, undefined, { serverId });
    req.log.info({ database: { serverId, op: 'delete-unused', name } }, `database: delete unused "${name}"`);
    return accepted(reply, req, job);
  });

  // ------------------------------------------------------------------ a site's databases

  r.get('/api/sites/:slug/databases', { schema: { params: slugParams } }, async (req) =>
    deps.databases.siteInfo(siteOf(req.params.slug)),
  );

  r.post('/api/sites/:slug/databases', { schema: { params: slugParams, body: dbCreateBody } }, async (req, reply) => {
    const site = usableSite(req.params.slug);
    const { name } = req.body;
    deps.databases.assertNameFree(name);
    const onServer = deps.db
      .select()
      .from(serverDatabases)
      .where(and(eq(serverDatabases.serverId, site.serverId), eq(serverDatabases.name, name)))
      .get();
    if (onServer) throw conflict(`A database called "${name}" is already on the site's server; pick another name`);
    const job = deps.worker.enqueue('database.create', { siteId: site.id, name, createdBy: actorName(req) }, site);
    audit(req, site, 'add', { name });
    return accepted(reply, req, job);
  });

  r.delete('/api/sites/:slug/databases/:db', { schema: { params: dbParams } }, async (req, reply) => {
    const site = usableSite(req.params.slug);
    if (req.params.db === site.dbName) throw conflict("The site's own database goes only with the site");
    if (!deps.databases.extraNames(site.id).includes(req.params.db)) {
      throw notFound(`"${req.params.db}" is not one of this site's databases`);
    }
    const job = deps.worker.enqueue('database.delete', { siteId: site.id, name: req.params.db }, site);
    audit(req, site, 'delete', { name: req.params.db });
    return accepted(reply, req, job);
  });

  r.post('/api/sites/:slug/database-password/reveal', { schema: { params: slugParams } }, async (req) => {
    const site = siteOf(req.params.slug);
    audit(req, site, 'reveal-password', {});
    return { password: site.dbPassword };
  });

  r.post('/api/sites/:slug/database-password', { schema: { params: slugParams } }, async (req, reply) => {
    const site = usableSite(req.params.slug);
    const job = deps.worker.enqueue('database.password', { siteId: site.id }, site);
    audit(req, site, 'change-password', {});
    return accepted(reply, req, job);
  });

  // ------------------------------------------------------------------ export and import

  r.get('/api/sites/:slug/databases/:db/export', { schema: { params: dbParams } }, async (req, reply) => {
    refuseForeignReads(req);
    const site = usableSite(req.params.slug);
    const { database } = deps.databases.targetFor(site, req.params.db);
    const server = deps.servers.handleFor(site.serverId);
    const gzip = zlib.createGzip();
    // A reader that went away errors the stream, which is what stops the dump on the server:
    // a stream merely closed would leave a remote mariadb-dump stalled until its deadline.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gzip.destroy(new Error('The download was cancelled'));
    });
    server.dbAdmin.dumpToStream(database, gzip).then(
      () => {
        if (!gzip.writableEnded) gzip.end();
      },
      (err: unknown) => {
        req.log.warn(`Export of ${database} failed: ${err instanceof Error ? err.message : String(err)}`);
        gzip.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    );
    audit(req, site, 'export', { db: database });
    const stamp = tsStamp(new Date()).slice(0, 13); // YYYYMMDD-HHMM, UTC
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', attachmentDisposition(`${database}-${stamp}.sql.gz`))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(gzip);
  });

  r.put(
    '/api/sites/:slug/database-uploads/:id',
    {
      schema: { params: dbUploadParams, querystring: dbUploadQuery },
      config: { rateLimit: { max: 1200, timeWindow: 60_000 } },
    },
    async (req) => {
      const site = usableSite(req.params.slug);
      const { offset, size } = req.query;
      const server = deps.servers.handleFor(site.serverId);
      const file = deps.databases.uploadPath(site, req.params.id);
      deps.databases.assertUploadFree(req.params.id);
      const { body, release } = await readBody(req, DB_LIMITS.chunkBytes);
      try {
        if (offset + body.length > size) throw badRequest('The chunk goes past the size given');
        if (offset === 0) {
          const dir = deps.databases.uploadDir(site);
          await server.files.mkdirp(dir, { mode: 0o700 });
          const disk = await server.files.statvfs(dir).catch(() => null);
          // The dump, and room for the database it becomes: at least as much again.
          if (disk && disk.freeBytes < size * 3) {
            throw new AppError(
              'conflict',
              507,
              `Not enough free disk on the site's server: ${Math.round(disk.freeBytes / 1e6)} MB free, about ${Math.round((size * 3) / 1e6)} MB needed`,
            );
          }
          await server.files.writeFile(file, body, { mode: 0o600 });
        } else {
          const have = (await server.files.stat(file))?.sizeBytes ?? 0;
          if (have !== offset) throw conflict(`The upload has ${have} bytes; send the chunk from there`, { received: have });
          await server.files.appendFile(file, body);
        }
        const received = offset + body.length;
        return { received, complete: received === size };
      } finally {
        release();
      }
    },
  );

  r.delete('/api/sites/:slug/database-uploads/:id', { schema: { params: dbUploadParams } }, async (req, reply) => {
    const site = siteOf(req.params.slug);
    deps.databases.assertUploadFree(req.params.id);
    await deps.servers.handleFor(site.serverId).files.rm(deps.databases.uploadPath(site, req.params.id));
    return reply.status(204).send();
  });

  r.post('/api/sites/:slug/databases/:db/import', { schema: { params: dbParams, body: dbImportBody } }, async (req, reply) => {
    const site = usableSite(req.params.slug);
    const { database } = deps.databases.targetFor(site, req.params.db);
    const file = deps.databases.uploadPath(site, req.body.uploadId);
    if (!(await deps.servers.handleFor(site.serverId).files.stat(file))) {
      throw notFound('That upload is not on the server; upload the file again');
    }
    const job = deps.worker.enqueue(
      'database.import',
      { siteId: site.id, database, uploadId: req.body.uploadId, empty: req.body.empty, backupFirst: req.body.backupFirst },
      site,
    );
    audit(req, site, 'import', { db: database, empty: req.body.empty, backupFirst: req.body.backupFirst });
    return accepted(reply, req, job);
  });

  // ------------------------------------------------------------------ the browser

  r.get('/api/sites/:slug/databases/:db/tables', { schema: { params: dbParams } }, async (req) => {
    const site = usableSite(req.params.slug);
    return { items: await browser(site).tables(deps.databases.targetFor(site, req.params.db)) };
  });

  r.get('/api/sites/:slug/databases/:db/tables/:table', { schema: { params: dbTableParams } }, async (req) => {
    const site = usableSite(req.params.slug);
    return browser(site).structure(deps.databases.targetFor(site, req.params.db), req.params.table);
  });

  r.get(
    '/api/sites/:slug/databases/:db/tables/:table/rows',
    { schema: { params: dbTableParams, querystring: dbRowsQuery } },
    async (req) => {
      const site = usableSite(req.params.slug);
      const q = req.query;
      return browser(site).rows(deps.databases.targetFor(site, req.params.db), req.params.table, {
        offset: q.offset,
        limit: q.limit,
        sort: q.sort,
        dir: q.dir,
        filters: parseJson(q.filters, dbRowFilters, 'filters', []),
      });
    },
  );

  r.get(
    '/api/sites/:slug/databases/:db/tables/:table/row',
    { schema: { params: dbTableParams, querystring: dbRowQuery } },
    async (req) => {
      const site = usableSite(req.params.slug);
      const key = parseJson(req.query.key, dbRowKey, 'key', {});
      const row = await browser(site).row(deps.databases.targetFor(site, req.params.db), req.params.table, key);
      if (!row) throw notFound('That row is no longer there: it was changed or deleted since it was read');
      return row;
    },
  );

  r.post(
    '/api/sites/:slug/databases/:db/tables/:table/rows',
    { schema: { params: dbTableParams, body: dbRowInsertBody }, bodyLimit: BIG_JSON },
    async (req) => {
      const site = usableSite(req.params.slug);
      const target = deps.databases.targetFor(site, req.params.db);
      return changing(site, async () => {
        const res = await browser(site).insert(target, req.params.table, req.body.values);
        audit(req, site, 'insert-row', { db: target.database, table: req.params.table, columns: Object.keys(req.body.values) });
        return res;
      });
    },
  );

  r.patch(
    '/api/sites/:slug/databases/:db/tables/:table/rows',
    { schema: { params: dbTableParams, body: dbRowUpdateBody }, bodyLimit: BIG_JSON },
    async (req) => {
      const site = usableSite(req.params.slug);
      const target = deps.databases.targetFor(site, req.params.db);
      return changing(site, async () => {
        const res = await browser(site).update(target, req.params.table, req.body.key, req.body.values);
        audit(req, site, 'update-row', {
          db: target.database,
          table: req.params.table,
          key: req.body.key,
          columns: Object.keys(req.body.values),
        });
        return res;
      });
    },
  );

  r.post(
    '/api/sites/:slug/databases/:db/tables/:table/rows/delete',
    { schema: { params: dbTableParams, body: dbRowDeleteBody } },
    async (req) => {
      const site = usableSite(req.params.slug);
      const target = deps.databases.targetFor(site, req.params.db);
      return changing(site, async () => {
        const res = await browser(site).remove(target, req.params.table, req.body.keys);
        audit(req, site, 'delete-rows', { db: target.database, table: req.params.table, rows: req.body.keys.length });
        return res;
      });
    },
  );

  r.post(
    '/api/sites/:slug/databases/:db/query',
    { schema: { params: dbParams, body: dbSqlBody }, bodyLimit: BIG_JSON },
    async (req) => {
      const site = usableSite(req.params.slug);
      const target = deps.databases.targetFor(site, req.params.db);
      return changing(site, async () => {
        // The SQL itself is not logged: it may carry anything, a password included.
        audit(req, site, 'sql', { db: target.database, chars: req.body.sql.length });
        return browser(site).run(target, req.body.sql);
      });
    },
  );

  // ------------------------------------------------------------------ bodies

  /** An upload chunk's body, whole, once the caller is known (as routes/files.ts reads its own). */
  async function readBody(req: FastifyRequest, max: number): Promise<{ body: Buffer; release: () => void }> {
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity') {
      throw new AppError('validation_error', 415, 'Send the chunk as it is (no Content-Encoding)');
    }
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new AppError('validation_error', 411, 'Send a Content-Length: the size has to be known up front');
    }
    if (length > max) throw new AppError('validation_error', 413, `Too large: at most ${max} bytes per chunk`);
    if (!(req.body instanceof Readable)) throw new AppError('validation_error', 415, 'Send the chunk as application/octet-stream');
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
      for await (const chunk of req.body as Readable) {
        got += (chunk as Buffer).length;
        if (got > length) throw badRequest('The body is longer than its Content-Length');
        chunks.push(chunk as Buffer);
      }
      if (got !== length) throw badRequest('The body is shorter than its Content-Length');
      return { body: Buffer.concat(chunks, length), release };
    } catch (err) {
      release();
      throw err;
    }
  }
}
