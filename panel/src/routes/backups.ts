import { PassThrough } from 'node:stream';
import { and, desc, eq, inArray, isNull, ne, not, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { backups, sites } from '../db/schema.js';
import {
  backupCreateBody,
  backupDeleteQuery,
  backupFetchBody,
  backupOffsiteBody,
  backupRestoreBody,
  backupsListQuery,
  siteSlugParam,
} from '../../shared/schemas.js';
import type { BackupListDto } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { backupToDto, jobToDto, viewerOf } from '../lib/dto.js';
import { offsiteLane } from '../services/offsite.js';
import { requireAccess } from '../plugins/auth.js';
import type { AppDeps } from './deps.js';

// Addressing an existing site: no reserved-name check, see siteSlugParam.
const slugParams = z.object({ slug: siteSlugParam });
const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerBackupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Every backup, whoever it belongs to. The site pages list theirs, but a deleted site has no
   * page - and its final backup, kept until somebody deletes it, is exactly the one worth
   * finding. "Deleted" is by slug, as everywhere else a backup is tied to its site: a site
   * that re-used the name owns the old backups, and can restore them.
   */
  r.get('/api/backups', { schema: { querystring: backupsListQuery } }, async (req): Promise<BackupListDto> => {
    const q = req.query;
    const ofDeletedSite = and(ne(backups.type, 'panel'), isNull(sites.id))!;
    const conditions: SQL[] = [];
    if (q.siteSlug) conditions.push(eq(backups.siteSlug, q.siteSlug));
    if (q.deleted !== undefined) conditions.push(q.deleted ? ofDeletedSite : not(ofDeletedSite));
    if (q.type.length > 0) conditions.push(inArray(backups.type, q.type));
    if (q.serverId !== undefined) conditions.push(eq(backups.serverId, q.serverId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Joined rather than looked up per row: the title of a site that exists, and a null id -
    // the one test for "deleted" - for one that does not.
    const rows = deps.db
      .select()
      .from(backups)
      .leftJoin(sites, eq(sites.slug, backups.siteSlug))
      .where(where)
      .orderBy(desc(backups.createdAt), desc(backups.id))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    const total = Number(
      deps.db
        .select({ n: sql<number>`count(*)` })
        .from(backups)
        .leftJoin(sites, eq(sites.slug, backups.siteSlug))
        .where(where)
        .get()?.n ?? 0,
    );
    const copies = deps.offsite.copyDtosFor(rows.map((row) => row.backups.id));

    const lastBackupAt = sql<number>`max(${backups.createdAt})`;
    const deletedSites = deps.db
      .select({
        slug: backups.siteSlug,
        backups: sql<number>`count(*)`,
        complete: sql<number>`sum(case when ${backups.status} = 'complete' then 1 else 0 end)`,
        lastBackupAt,
        sizeBytes: sql<number>`coalesce(sum(${backups.sizeBytes}), 0)`,
      })
      .from(backups)
      .leftJoin(sites, eq(sites.slug, backups.siteSlug))
      .where(ofDeletedSite)
      .groupBy(backups.siteSlug)
      .orderBy(desc(lastBackupAt), backups.siteSlug)
      .all();

    return {
      items: rows.map(({ backups: row, sites: site }) => ({
        ...backupToDto(row, copies.get(row.id) ?? []),
        siteTitle: site?.title ?? null,
        siteDeleted: row.type !== 'panel' && !site,
      })),
      total,
      deletedSites: deletedSites.map((d) => ({
        ...d,
        backups: Number(d.backups),
        complete: Number(d.complete),
        sizeBytes: Number(d.sizeBytes),
      })),
    };
  });

  r.get('/api/sites/:slug/backups', { schema: { params: slugParams } }, async (req) => {
    deps.sites.bySlug(req.params.slug); // 404 for unknown sites
    const rows = deps.db
      .select()
      .from(backups)
      .where(eq(backups.siteSlug, req.params.slug))
      .orderBy(desc(backups.createdAt))
      .limit(200)
      .all();
    const copies = deps.offsite.copyDtosFor(rows.map((row) => row.id));
    return { items: rows.map((row) => backupToDto(row, copies.get(row.id) ?? [])) };
  });

  r.post(
    '/api/sites/:slug/backups',
    { schema: { params: slugParams, body: backupCreateBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      const job = deps.worker.enqueue(
        'backup.create',
        { siteId: site.id, type: 'manual', note: req.body.note },
        { id: site.id, slug: site.slug },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  r.post(
    '/api/backups/:id/restore',
    { schema: { params: idParams, body: backupRestoreBody } },
    async (req, reply) => {
      const backup = deps.db.select().from(backups).where(eq(backups.id, req.params.id)).get();
      if (!backup) throw notFound(`Backup #${req.params.id} not found`);
      const site = deps.sites.bySlug(backup.siteSlug); // 404s when the site is gone
      if (backup.status !== 'complete') throw conflict('Only complete backups can be restored');
      if (backup.filesPresent === 0) {
        throw conflict(
          `This backup exists only at a remote destination; fetch it back to "${site.slug}"'s server first`,
        );
      }
      if (backup.serverId !== site.serverId) {
        throw conflict(
          `This backup lives on another server (the site moved since it was taken); ` +
            `fetch it back from an offsite copy onto the current server, or move the site back`,
        );
      }
      const job = deps.worker.enqueue(
        'backup.restore',
        { backupId: backup.id, skipPreRestoreBackup: req.body.skipPreRestoreBackup },
        { id: site.id, slug: site.slug },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  /** Copy now, or retry a copy that gave up. Resets the attempt counter either way. */
  r.post('/api/backups/:id/offsite', { schema: { params: idParams, body: backupOffsiteBody } }, async (req, reply) => {
    const backup = deps.db.select().from(backups).where(eq(backups.id, req.params.id)).get();
    if (!backup) throw notFound(`Backup #${req.params.id} not found`);
    // Where panel.db may go - which destinations, encrypted or not - is the admin's to decide.
    if (backup.type === 'panel') requireAccess(req, 'full', 'copying a panel snapshot');
    if (backup.status !== 'complete') throw conflict('Only complete backups can be copied to a remote destination');
    if (backup.filesPresent === 0) throw conflict('This backup has no local files left to copy');
    const queued = deps.offsite.requeue(backup, req.body.destinationId);
    if (queued === 0) throw badRequest('There is nothing to copy: every destination already has this backup');
    const job = deps.worker.enqueue('backup.offsite', { backupId: backup.id }, undefined, {
      lane: offsiteLane(backup.serverId),
      siteSlug: backup.siteSlug,
    });
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  /** Bring an offsite copy back onto a server so it can be restored or downloaded. */
  r.post('/api/backups/:id/fetch', { schema: { params: idParams, body: backupFetchBody } }, async (req, reply) => {
    const backup = deps.db.select().from(backups).where(eq(backups.id, req.params.id)).get();
    if (!backup) throw notFound(`Backup #${req.params.id} not found`);
    if (backup.type === 'panel') requireAccess(req, 'full', 'fetching a panel snapshot');
    const copy = deps.offsite.copiesOf(backup.id).find((c) => c.destinationId === req.body.destinationId);
    if (!copy || copy.status !== 'complete') {
      throw badRequest(`Backup #${backup.id} has no completed copy at that destination`);
    }
    deps.backup.assertDeletable(backup); // same "is anything using these files" guard
    // The fetch lands where the site is now, which is also where the lane has to be: a
    // backup taken before a move comes back onto the server the site runs on today.
    const site = deps.db.select().from(sites).where(eq(sites.slug, backup.siteSlug)).get();
    const targetServerId = site?.serverId ?? backup.serverId;
    const job = deps.worker.enqueue(
      'backup.fetch',
      { backupId: backup.id, destinationId: req.body.destinationId },
      undefined,
      { lane: offsiteLane(targetServerId), siteSlug: backup.siteSlug },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.get('/api/backups/:id/download', { schema: { params: idParams } }, async (req, reply) => {
    const backup = deps.db.select().from(backups).where(eq(backups.id, req.params.id)).get();
    if (!backup || backup.status !== 'complete') throw notFound('Backup not found');
    // A site's backup holds what its WordPress admin can read anyway - Manage's. A panel
    // snapshot is panel.db: every credential of the panel itself.
    if (backup.type === 'panel') requireAccess(req, 'full', 'downloading a panel snapshot');
    if (backup.filesPresent === 0) {
      throw conflict('This backup exists only at a remote destination; fetch it back first');
    }
    const handle = deps.backup.handleForBackup(backup);
    // Archives inside are already gzipped; plain tar wrapper avoids double compression.
    // Streams from whichever server holds the files (local spawn or SSH channel).
    const stream = new PassThrough();
    handle.exec
      .runToStream('tar', ['-C', backup.path, '-cf', '-', '.'], stream, { timeoutMs: 60 * 60_000 })
      .catch(() => stream.destroy());
    const tsName = backup.path.split('/').pop() ?? backup.id.toString();
    reply
      .header('content-type', 'application/x-tar')
      .header('content-disposition', `attachment; filename="${backup.siteSlug}-${tsName}.tar"`);
    return reply.send(stream);
  });

  /**
   * Delete means everywhere, offsite included. `?keepOffsite=true` is the deliberate
   * opt-out, for "free the disk, keep the archive".
   */
  r.delete('/api/backups/:id', { schema: { params: idParams, querystring: backupDeleteQuery } }, async (req, reply) => {
    const backup = deps.db.select().from(backups).where(eq(backups.id, req.params.id)).get();
    if (!backup) throw notFound(`Backup #${req.params.id} not found`);
    deps.backup.assertDeletable(backup);

    const copies = deps.offsite.copiesOf(backup.id);
    if (req.query.keepOffsite) {
      const kept = copies.filter((c) => c.status === 'complete');
      if (kept.length === 0) throw badRequest('This backup has no completed remote copy to keep');
      await deps.backup.removeLocalFiles(backup);
      // Copies that never made it are dropped rather than left pending: with the local
      // files gone there is nothing left to upload from.
      deps.offsite.dropIncompleteCopies(backup.id);
      return reply.send({ keptOffsite: kept.length });
    }

    const { failed, keptByPolicy } = await deps.offsite.purgeCopies(copies);
    if (failed > 0) {
      throw conflict(
        `${failed} offsite copy/copies could not be removed, so the backup was kept. ` +
          `Retry, or delete it with ?keepOffsite=true and clear the destination by hand.`,
      );
    }
    await deps.backup.deleteBackup(backup);
    if (keptByPolicy > 0) {
      // Not a failure: those destinations are configured so the panel never deletes from
      // them. Saying nothing would be claiming the backup is gone when it is not.
      return reply.send({
        deleted: true,
        keptByPolicy,
        note:
          `${keptByPolicy} copy/copies were left in place because their destination manages its own ` +
          `retention. Remove them with your provider's tools if you want them gone.`,
      });
    }
    return reply.status(204).send();
  });
}
