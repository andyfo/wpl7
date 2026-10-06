// @docs backups/offsite
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { backupCopies, backupDestinations, backups } from '../db/schema.js';
import {
  destinationCopiesQuery,
  destinationCreateBody,
  destinationDeleteQuery,
  destinationUpdateBody,
} from '../../shared/schemas.js';
import { destinationPayloadSchema, providerByKey } from '../../shared/backupProviders.js';
import { allows } from '../../shared/access.js';
import type { BackupDestinationDto } from '../../shared/types.js';
import { badRequest } from '../lib/errors.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { offsiteLane } from '../services/offsite.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * The provider half of a destination body: `{ provider, config, secrets }`, validated by
 * the catalog-derived discriminated union so a new preset is covered the day it is listed.
 * Kept separate from the policy half (name, retention, bandwidth) because only this part
 * depends on which provider was picked.
 */
const providerPart = destinationPayloadSchema();

function splitBody(body: Record<string, unknown>) {
  const parsed = providerPart.safeParse({
    provider: body.provider,
    config: body.config ?? {},
    secrets: body.secrets ?? {},
  });
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid destination configuration', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data as { provider: string; config: Record<string, string>; secrets: Record<string, string> };
}

export function registerBackupDestinationRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Below Full, a custom rclone remote's hand-written options show their names only: they are
   * where somebody would type a key, and the form's own secret fields are never shown to anyone.
   */
  const forCaller = (req: FastifyRequest, dto: BackupDestinationDto): BackupDestinationDto => {
    if (allows(viewerOf(req), 'full')) return dto;
    const declared = new Set(providerByKey(dto.provider)?.fields.map((f) => f.key) ?? []);
    return { ...dto, config: Object.fromEntries(Object.entries(dto.config).map(([k, v]) => [k, declared.has(k) ? v : '•••'])) };
  };

  r.get('/api/backup-destinations', async (req) => ({
    items: deps.offsite.list().map((row) => forCaller(req, deps.offsite.toDto(row))),
  }));

  /** Everything the Storage page (Backups -> Storage) and the Dashboard line need, in one call. */
  r.get('/api/backups/overview', async (req) => {
    const overview = deps.offsite.overview();
    return { ...overview, destinations: overview.destinations.map((d) => forCaller(req, d)) };
  });

  /**
   * Probe a configuration before it is stored. Unsaved values, so an operator can iterate
   * on an endpoint or a key without leaving a half-working destination behind.
   */
  r.post('/api/backup-destinations/test', { schema: { body: destinationCreateBody } }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const { provider, config, secrets } = splitBody(body);
    return deps.offsite.test({
      name: String(body.name ?? 'test'),
      provider,
      config,
      secrets,
      encryption: body.encryption as string | undefined,
      cryptPassword: body.cryptPassword as string | undefined,
      cryptSalt: body.cryptSalt as string | undefined,
    });
  });

  /** Probe a stored destination, using the credentials already on file. */
  r.post('/api/backup-destinations/:id/test', { schema: { params: idParams } }, async (req) => {
    const row = deps.offsite.byId(req.params.id);
    const crypt = deps.offsite.cryptOf(row);
    return deps.offsite.test({
      name: row.name,
      provider: row.provider,
      config: deps.offsite.configOf(row),
      secrets: deps.offsite.secretsOf(row),
      encryption: row.encryption,
      cryptPassword: crypt?.password,
      cryptSalt: crypt?.salt,
    });
  });

  r.post('/api/backup-destinations', { schema: { body: destinationCreateBody } }, async (req, reply) => {
    const body = req.body as Record<string, unknown> & { backfill?: 'none' | 'latest' | 'all' };
    const { provider, config, secrets } = splitBody(body);
    const row = deps.offsite.create({
      name: String(body.name),
      provider,
      config,
      secrets,
      enabled: body.enabled as boolean | undefined,
      copyTypes: body.copyTypes as string[] | undefined,
      retentionScheduled: body.retentionScheduled as number | undefined,
      retentionMode: body.retentionMode as string | undefined,
      bwlimit: body.bwlimit as string | undefined,
      encryption: body.encryption as string | undefined,
      cryptPassword: body.cryptPassword as string | undefined,
      cryptSalt: body.cryptSalt as string | undefined,
      backfill: body.backfill,
    });
    // Pick up whatever is already eligible straight away, rather than at the next tick.
    deps.offsite.kick();
    const crypt = deps.offsite.cryptOf(row);
    // The one time the passphrase is volunteered rather than asked for: there is no second
    // copy of it anywhere but this database, and a bucket of ciphertext without it is lost.
    return reply.status(201).send({ ...deps.offsite.toDto(row), ...(crypt ? { crypt } : {}) });
  });

  r.patch('/api/backup-destinations/:id', { schema: { params: idParams, body: destinationUpdateBody } }, async (req) => {
    const existing = deps.offsite.byId(req.params.id);
    const body = req.body as Record<string, unknown>;
    // The provider itself is immutable: its config keys and its remote layout are different
    // shapes, and silently reinterpreting one as the other would orphan every stored copy.
    if (body.provider !== undefined && body.provider !== existing.provider) {
      throw badRequest('The provider of a destination cannot be changed; add a new destination instead');
    }
    const { config, secrets } =
      body.config !== undefined || body.secrets !== undefined
        ? splitBody({ ...body, provider: existing.provider })
        : { config: undefined, secrets: undefined };
    const row = deps.offsite.update(req.params.id, {
      name: body.name as string | undefined,
      config,
      secrets,
      enabled: body.enabled as boolean | undefined,
      copyTypes: body.copyTypes as string[] | undefined,
      retentionScheduled: body.retentionScheduled as number | undefined,
      retentionMode: body.retentionMode as string | undefined,
      bwlimit: body.bwlimit as string | undefined,
      encryption: body.encryption as string | undefined,
      cryptPassword: body.cryptPassword as string | undefined,
      cryptSalt: body.cryptSalt as string | undefined,
    });
    deps.offsite.kick();
    const crypt = deps.offsite.cryptOf(row);
    const wasEncrypted = existing.encryption === 'crypt';
    // Only when encryption was just switched on: a new passphrase exists that nobody has
    // written down yet. An unchanged one is read back through /passphrase on demand.
    return { ...deps.offsite.toDto(row), ...(crypt && !wasEncrypted ? { crypt } : {}) };
  });

  /**
   * `?deleteRemote=false` (the default) forgets the copies and leaves the objects: removing
   * a destination from the panel is not the same decision as destroying the backups in it.
   */
  r.delete(
    '/api/backup-destinations/:id',
    { schema: { params: idParams, querystring: destinationDeleteQuery } },
    async (req, reply) => {
      const row = deps.offsite.byId(req.params.id);
      if (req.query.deleteRemote) {
        const job = deps.worker.enqueue('backup.offsitePurge', { destinationId: row.id }, undefined, {
          lane: offsiteLane(1),
        });
        return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
      }
      const forgotten = deps.offsite.forgetCopies(row.id);
      deps.db.delete(backupDestinations).where(eq(backupDestinations.id, row.id)).run();
      const dropped = deps.offsite.dropEmptyBackups();
      deps.log.info(
        `Offsite destination "${row.name}" removed; ${forgotten} copy record(s) forgotten, objects left in place`,
      );
      return reply.send({ removed: row.name, forgotten, droppedBackups: dropped });
    },
  );

  /**
   * Read the passphrase back. POST rather than GET so it stays out of browser history and
   * proxy logs — it is the only endpoint that returns a stored secret, and it exists
   * because the alternative to remembering it is losing every backup at this destination.
   */
  r.post('/api/backup-destinations/:id/passphrase', { schema: { params: idParams } }, async (req) => {
    const row = deps.offsite.byId(req.params.id);
    deps.log.info(`Offsite destination "${row.name}": passphrase revealed`);
    return deps.offsite.revealCrypt(row.id);
  });

  /** Copy rows for one destination — the failures view and the per-destination detail. */
  r.get(
    '/api/backup-destinations/:id/copies',
    { schema: { params: idParams, querystring: destinationCopiesQuery } },
    async (req) => {
      const row = deps.offsite.byId(req.params.id);
      const where = req.query.status
        ? and(eq(backupCopies.destinationId, row.id), eq(backupCopies.status, req.query.status))
        : eq(backupCopies.destinationId, row.id);
      const total = Number(
        deps.db.select({ n: sql<number>`count(*)` }).from(backupCopies).where(where).get()?.n ?? 0,
      );
      const items = deps.db
        .select({ copy: backupCopies, backup: backups })
        .from(backupCopies)
        .innerJoin(backups, eq(backups.id, backupCopies.backupId))
        .where(where)
        .orderBy(desc(backupCopies.id))
        .limit(req.query.limit)
        .offset(req.query.offset)
        .all()
        .map((r2) => deps.offsite.copyToDto(r2.copy, row.name, r2.backup));
      return { items, total };
    },
  );
}
