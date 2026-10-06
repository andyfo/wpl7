// @docs automations/jobs
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import type { JobOrigin } from '../../shared/schemas.js';
import type { JobRow } from '../db/schema.js';
import { actorName } from '../lib/audit.js';

/**
 * Who is queueing work right now: an admin's request, an API key's, an MCP tool call's, a
 * schedule firing, or nobody in particular (the panel itself).
 *
 * Carried in async context rather than passed along, because jobs are queued from some forty
 * places - routes, services, the reconcilers - and threading "who" through every one of them
 * would touch all of those signatures for a field none of them otherwise needs. The request
 * wrapper (plugins/jobActor.ts) and the scheduler's runner set it; `JobWorker.enqueue` reads it.
 */
export interface JobActor {
  origin: JobOrigin;
  /** The admin's username, `API key "<name>"`, the MCP caller's label, or the schedule's name. */
  createdBy: string | null;
  scheduleId?: number | null;
  /** Every job queued while this actor was current - how a schedule learns what it created. */
  jobs?: JobRow[];
}

const storage = new AsyncLocalStorage<JobActor>();

/** Run `fn` - and everything it awaits or schedules - as `actor`. */
export function runAs<T>(actor: JobActor, fn: () => T): T {
  return storage.run(actor, fn);
}

export function currentActor(): JobActor | undefined {
  return storage.getStore();
}

/**
 * Run `fn` outside any actor. The worker executes every handler this way, so a job a handler
 * queues is always the panel's own - never credited to whoever's request happened to wake
 * the worker loop, whatever Node version decides about context across that wake-up.
 */
export function withoutActor<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** The actor behind an API request; null for the few routes that need no sign-in. */
export function actorForRequest(req: FastifyRequest): JobActor | null {
  if (req.authVia === 'mcp') return { origin: 'mcp', createdBy: actorName(req) };
  if (req.authVia === 'apiKey') return { origin: 'api', createdBy: actorName(req) };
  if (req.authVia === 'session') return { origin: 'user', createdBy: actorName(req) };
  return null;
}
