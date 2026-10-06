// @docs automations/custom-jobs, automations/schedules
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  MAX_CUSTOM_SCHEDULES,
  MIN_SCHEDULE_GAP_MS,
  SCHEDULE_ACTION_INFO,
  SCHEDULE_ACTION_PARAMS,
  scheduleActions,
  scheduleCreateBody,
  scheduleTargetSchema,
  scheduleUpdateBody,
  backupPolicyPart,
  takesBackups,
  type ScheduleCreateBody,
} from '../../shared/scheduleActions.js';
import type { ScheduleActionsDto, ScheduleDto } from '../../shared/types.js';
import { COMMAND_JOBS, seesCommands, viewerOf } from '../lib/dto.js';
import { requireAccess } from '../plugins/auth.js';
import { actorName, audit } from '../lib/audit.js';
import type { AppDeps } from './deps.js';

/** A numeric id, or a built-in's key (`wp-scan`) - an MCP client knows the latter by heart. */
const scheduleParams = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a schedule id or key') });

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

export function registerScheduleRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const schedulers = deps.schedulers;

  /** At Read only, what a command schedule runs is not shown at all (COMMAND_JOBS, lib/dto.ts). */
  const forCaller = (req: FastifyRequest, schedule: ScheduleDto): ScheduleDto =>
    seesCommands(viewerOf(req)) || !COMMAND_JOBS.has(schedule.action ?? '') ? schedule : { ...schedule, params: null };

  /**
   * A custom schedule does what Manage could do by hand - except take backups, which count
   * toward the retention that keeps the backup history, so a schedule taking them often enough
   * pushes that history out. That, and every built-in schedule, is the backup policy, and
   * Full's (backupPolicyPart). A new or changed definition is checked once it is valid, before
   * it is stored.
   */
  const definitionGuard = (req: FastifyRequest) => (definition: ScheduleCreateBody) => {
    if (takesBackups(definition.action, definition.params)) requireAccess(req, 'full', 'a schedule that takes backups');
  };

  r.get('/api/schedules', async (req) => ({ items: schedulers.list().map((s) => forCaller(req, s)) }));

  // Static, so it outranks /api/schedules/:id. Everything a client needs to build a valid
  // `POST /schedules` without having read this panel's source - and to find out that a newer
  // panel takes more than it knows about.
  r.get('/api/schedules/actions', async (): Promise<ScheduleActionsDto> => ({
    actions: scheduleActions.map((action) => ({
      action,
      ...SCHEDULE_ACTION_INFO[action],
      paramsSchema: jsonSchema(SCHEDULE_ACTION_PARAMS[action]),
    })),
    targetSchema: jsonSchema(scheduleTargetSchema),
    createBodySchema: jsonSchema(scheduleCreateBody),
    minGapMinutes: MIN_SCHEDULE_GAP_MS / 60_000,
    maxCustomSchedules: MAX_CUSTOM_SCHEDULES,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  r.get('/api/schedules/:id', { schema: { params: scheduleParams } }, async (req) => ({
    schedule: forCaller(req, schedulers.get(req.params.id)),
  }));

  r.post('/api/schedules', { schema: { body: scheduleCreateBody } }, async (req, reply) => {
    const schedule = schedulers.createCustom(req.body, actorName(req), Date.now(), definitionGuard(req));
    audit(req, 'schedule', '-', 'create', { schedule: schedule.id, action: schedule.action, target: schedule.target });
    return reply.status(201).send({ schedule });
  });

  r.patch('/api/schedules/:id', { schema: { params: scheduleParams, body: scheduleUpdateBody } }, async (req) => {
    const current = schedulers.get(req.params.id);
    const part = backupPolicyPart(current);
    if (part) requireAccess(req, 'full', `${current.kind === 'builtin' ? 'pausing or resuming' : 'changing'} ${part}`);
    const schedule = schedulers.update(req.params.id, req.body, Date.now(), definitionGuard(req));
    audit(req, 'schedule', '-', 'change', { schedule: schedule.id, fields: Object.keys(req.body) });
    return { schedule };
  });

  r.delete('/api/schedules/:id', { schema: { params: scheduleParams } }, async (req, reply) => {
    const part = backupPolicyPart(schedulers.get(req.params.id));
    if (part) requireAccess(req, 'full', `deleting ${part}`);
    schedulers.removeCustom(req.params.id);
    audit(req, 'schedule', '-', 'delete', { schedule: req.params.id });
    return reply.status(204).send();
  });

  r.post('/api/schedules/:id/run', { schema: { params: scheduleParams } }, async (req, reply) => {
    const part = backupPolicyPart(schedulers.get(req.params.id));
    if (part) requireAccess(req, 'full', `running ${part}`);
    const run = await schedulers.runNow(req.params.id, viewerOf(req));
    audit(req, 'schedule', '-', 'run now', { schedule: req.params.id, jobs: run.jobs.map((j) => j.id) });
    // One job is the common case (a scan, a single-site command): point at it, the way every
    // other 202 in the API does - and the way the API activity log links a request to its job.
    if (run.jobs.length === 1) reply.header('location', `/api/jobs/${run.jobs[0]!.id}`);
    return reply.status(202).send(run);
  });
}
