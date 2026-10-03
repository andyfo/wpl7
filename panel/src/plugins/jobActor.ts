import type { FastifyInstance, RouteOptions } from 'fastify';
import { actorForRequest, runAs } from '../jobs/actor.js';

/**
 * Run every API handler as the admin or API key that made the request, so a job it queues -
 * however deep in a service that happens - records who asked for it (src/jobs/actor.ts).
 *
 * The handler itself is wrapped, not a hook: the auth gate is a preHandler, so by the time
 * the handler runs `req.user` / `req.apiKeyUsed` are settled, and `AsyncLocalStorage.run`
 * around the handler covers everything it awaits. Fastify reads `handler` after the onRoute
 * hooks have run, which is what makes replacing it here supported rather than a trick.
 *
 * Must be registered before the route modules; onRoute only sees routes added after it.
 */
export function registerJobActor(app: FastifyInstance): void {
  app.addHook('onRoute', (route: RouteOptions & { websocket?: boolean }) => {
    // A websocket handler's first argument is the socket, and the terminal queues nothing.
    if (route.websocket) return;
    if (!route.url.startsWith('/api/')) return;
    const handler = route.handler;
    route.handler = function (this: unknown, req, reply) {
      const actor = actorForRequest(req);
      if (!actor) return handler.call(this as never, req, reply);
      return runAs(actor, () => handler.call(this as never, req, reply));
    };
  });
}
