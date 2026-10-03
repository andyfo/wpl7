import type { FastifyInstance, FastifyRequest } from 'fastify';
import { maintenance } from '../lib/errors.js';
import type { SystemUpdateService } from '../services/systemUpdate.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * While an update is in flight, refuse writes.
 *
 * Not for the panel's sake - it is about to be replaced, and does not care. For the
 * operator's: a site created in the thirty seconds before the container is recreated would
 * land in the database snapshot the rollback restores, and vanish. Better to be told to
 * wait than to watch work disappear.
 *
 * Reading stays open throughout, including the update's own status - that page is the whole
 * point of the flag being visible.
 */
const ALLOWED_WHILE_UPDATING = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  // The Update page's own controls, so a stuck update can still be looked at and retried.
  '/api/system/update',
  '/api/system/update/check',
  // Writes nothing here, and the minute an update has gone wrong is the likeliest minute
  // anyone wants to say so.
  '/api/feedback',
]);

export function registerMaintenanceGuard(app: FastifyInstance, system: SystemUpdateService): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const routeUrl = req.routeOptions?.url;
    if (!routeUrl || !routeUrl.startsWith('/api/')) return;
    if (SAFE_METHODS.has(req.method)) return;
    if (ALLOWED_WHILE_UPDATING.has(routeUrl)) return;

    const active = system.maintenance();
    if (!active) return;
    throw maintenance(
      `${active.reason}. The panel is read-only until the update finishes or is rolled back.`,
    );
  });
}
