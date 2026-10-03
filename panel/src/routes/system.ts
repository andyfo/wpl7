import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import type { SystemAboutDto, UpdateStatusDto } from '../../shared/types.js';
import { notFound } from '../lib/errors.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import type { AppDeps } from './deps.js';

const updateBody = z.object({ version: z.string().min(1).max(64) }).strict();

/** The panel's own version, whether there is a newer one, and applying it. */
export function registerSystemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Served entirely from the cached check - no page view ever waits on GitHub.
  r.get('/api/system/version', async () => deps.updates.status());

  /**
   * What the About page shows about this install. Server 1 is the panel's own machine, so
   * its facts are the panel's facts; both halves are cached behind this (a minute for the
   * host reading, ten for the PTR), which is what keeps opening the page cheap.
   */
  r.get('/api/system/about', async (): Promise<SystemAboutDto> => {
    // The seeded row is the record; the environment variable is only what seeded it, and
    // on a box whose address has since been corrected in the panel it is the stale one.
    const publicIp = deps.servers.rowById(1)?.publicIp || deps.config.serverPublicIp || null;
    const [host, ptr] = await Promise.all([
      deps.serverInfo.describe(1),
      publicIp ? deps.serverInfo.reverseDns(publicIp) : Promise.resolve(null),
    ]);
    return {
      repoUrl: deps.config.repoUrl,
      host,
      publicIp,
      reverseDns: ptr,
      communityUrl: deps.config.communityUrl,
      panelDomain: deps.config.panelDomain,
      node: process.version,
      panelUptimeSeconds: Math.floor(process.uptime()),
    };
  });

  // "Check now". The hourly tick is what normally keeps this fresh; this is for someone
  // who has just published a release and does not want to wait for their minute of the hour.
  r.post('/api/system/update/check', async (_req, reply) => reply.send(await deps.updates.check()));

  /**
   * Start the update. 202, not 200: by the time it means anything this process is gone.
   * The client watches /api/system/update/status, and keeps watching through the gap where
   * the panel does not answer at all - that gap is the update working.
   */
  r.post('/api/system/update', { schema: { body: updateBody } }, async (req, reply) => {
    const { unit } = await deps.system.start(req.body.version);
    return reply.status(202).send({ unit, version: req.body.version });
  });

  /**
   * "Re-run post-update tasks". For the case where a hook failed, the operator has fixed
   * whatever it was complaining about, and wants the follow-up to happen without pretending
   * to update again. Every hook is idempotent, so this is always safe.
   */
  r.post('/api/system/update/post-update', async (req, reply) => {
    const job = deps.system.enqueuePostUpdate(deps.worker, { force: true });
    if (!job) throw notFound('No applied update to follow up on.');
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  /**
   * Both outcomes land here. After a rollback it is the OLD panel that answers, reads
   * `phase: "failed"` out of the same file, and shows why - so the page that showed the
   * progress is the page that shows the post-mortem.
   */
  r.get('/api/system/update/status', async (): Promise<UpdateStatusDto> => {
    const state = deps.system.state();
    return {
      running: await deps.system.isRunning(),
      maintenance: deps.system.maintenance(),
      state,
      log: deps.system.logTail(),
      history: deps.system.history().map((row) => ({
        id: row.id,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        status: row.status as 'running' | 'done' | 'failed',
        steps: JSON.parse(row.steps) as UpdateStatusDto['history'][number]['steps'],
      })),
    };
  });
}