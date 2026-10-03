import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { wpBatchesQuery, wpFleetBulkBody, wpInventoryQuery } from '../../shared/schemas.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Fleet-wide WordPress management: one inventory of every plugin, theme and core version
 * across every site, and the bulk runs over it.
 *
 * Everything here reads the snapshot (`site_wp_components`, `site_wp_status`) joined against
 * the cached vulnerability feed - no `docker exec` on any of these paths. The only endpoint
 * that touches a container is `POST /wp/scan`, and it does it in a job.
 */
export function registerWpFleetRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/wp/inventory', { schema: { querystring: wpInventoryQuery } }, async (req) => {
    const inventory = deps.wpInventory.fleetInventory(req.query);
    const scan = deps.wpBulk.activeScanJob() ?? deps.wpBulk.lastScanJob();
    return { ...inventory, scanJob: scan ? jobToDto(scan, viewerOf(req)) : null };
  });

  /**
   * Start a bulk run: one `wp.bulkTask` job per site, all sharing a batch id.
   *
   * 400 with the list of offending targets when anything cannot run the action (a stale
   * tab, a component deleted since the last scan) - nothing is queued in that case, so a
   * partly-invalid selection never half-runs. Sites whose job lane is busy come back in
   * `skipped`, because that one is worth retrying rather than fixing.
   */
  r.post('/api/wp/bulk', { schema: { body: wpFleetBulkBody } }, async (req, reply) => {
    const { batch, jobs, skipped } = deps.wpBulk.createBatch(req.body.action, req.body.targets, {
      backupFirst: req.body.backupFirst,
      healthCheck: req.body.healthCheck,
    });
    return reply
      .status(202)
      .header('location', `/api/wp/batches/${batch.id}`)
      .send({ batch: deps.wpBulk.toDto(batch, jobs), jobs: jobs.map((job) => jobToDto(job, viewerOf(req))), skipped });
  });

  r.get('/api/wp/batches', { schema: { querystring: wpBatchesQuery } }, async (req) => ({
    items: deps.wpBulk.list(req.query.limit),
  }));

  /** Batch + its jobs: one poll drives the whole progress table. */
  r.get('/api/wp/batches/:id', { schema: { params: idParams } }, async (req) => {
    const row = deps.wpBulk.batchRow(req.params.id);
    const jobs = deps.wpBulk.jobsOf(row.id);
    return { batch: deps.wpBulk.toDto(row, jobs), jobs: jobs.map((job) => jobToDto(job, viewerOf(req))) };
  });

  /** Rescan the whole fleet now. 409 while one is already queued or running. */
  r.post('/api/wp/scan', async (req, reply) => {
    deps.wpBulk.assertNoActiveScan();
    const job = deps.worker.enqueue('wp.scanAll', {});
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });
}
