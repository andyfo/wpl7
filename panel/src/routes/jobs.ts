// @docs automations/jobs
import { and, asc, desc, eq, gt, gte, inArray, lte, notInArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { jobLogs, jobs } from '../db/schema.js';
import { jobDetailQuery, jobStatuses, jobsListQuery, type JobStatus, type JobType } from '../../shared/schemas.js';
import { JOB_TYPE_INFO, typesInCategories, typesMatching, type JobTypeInfo } from '../../shared/jobTypes.js';
import type { JobListDto, JobTypeInfoDto, ScheduleDto } from '../../shared/types.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { COMMAND_JOBS, jobToDto, liveJobToDto, ofASite, seesCommands, viewerOf } from '../lib/dto.js';
import { requireAccess } from '../plugins/auth.js';
import type { JobRow } from '../db/schema.js';
import { backupPolicyPart } from '../../shared/scheduleActions.js';
import { getRegistry } from '../jobs/registry.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** The worker's default, for a type whose registry entry sets no limit of its own. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * `#123` or `123` is that job. Anything else: a case-insensitive substring of what a person
 * would recognise a job by - its summary, type, site, error or who started it - or of a job
 * type's label, so "inventory" finds the scans without anyone knowing they are `wp.scanAll`.
 *
 * `hideCommands`: the caller may not see a command's summary or error (lib/dto.ts), so it may
 * not search them either - a search is a question with a yes or no answer, asked as often as
 * one likes, and enough of them spell out a password.
 */
function searchCondition(raw: string, hideCommands: boolean): SQL {
  const id = /^#?(\d{1,12})$/.exec(raw);
  if (id) return eq(jobs.id, Number(id[1]));
  const needle = raw.toLowerCase();
  const contains = (col: AnyColumn) => sql`instr(lower(coalesce(${col}, '')), ${needle}) > 0`;
  const unlessCommand = (condition: SQL) =>
    hideCommands ? and(notInArray(jobs.type, [...COMMAND_JOBS]), condition)! : condition;
  const conditions: SQL[] = [
    unlessCommand(contains(jobs.summary)),
    contains(jobs.type),
    contains(jobs.siteSlug),
    unlessCommand(contains(jobs.error)),
    contains(jobs.createdBy),
  ];
  const labelled = typesMatching(raw);
  if (labelled.length > 0) conditions.push(inArray(jobs.type, labelled));
  return or(...conditions)!;
}

export function registerJobRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/jobs', { schema: { querystring: jobsListQuery } }, async (req): Promise<JobListDto> => {
    const q = req.query;
    // Every filter except status: the status chips count within the rest of the selection,
    // so "Failed 3" means three failures among what is on screen, not in all of history.
    const rest: SQL[] = [];
    let types: string[] | null = q.type.length > 0 ? q.type : null;
    if (q.category.length > 0) {
      const inCategory: string[] = typesInCategories(q.category);
      types = types ? types.filter((t) => inCategory.includes(t)) : inCategory;
    }
    if (types) rest.push(types.length > 0 ? inArray(jobs.type, types) : sql`0`);
    if (q.origin.length > 0) rest.push(inArray(jobs.origin, q.origin));
    if (q.siteSlug) rest.push(eq(jobs.siteSlug, q.siteSlug));
    if (q.serverId !== undefined) {
      // Named lanes carry their server in the name instead of server_id (src/jobs/lanes.ts).
      rest.push(
        or(eq(jobs.serverId, q.serverId), eq(jobs.auxServerId, q.serverId), sql`${jobs.lane} GLOB ${`*:${q.serverId}`}`)!,
      );
    }
    if (q.scheduleId !== undefined) rest.push(eq(jobs.scheduleId, q.scheduleId));
    if (q.batchId !== undefined) rest.push(eq(jobs.batchId, q.batchId));
    if (q.since !== undefined) rest.push(gte(jobs.createdAt, q.since));
    if (q.until !== undefined) rest.push(lte(jobs.createdAt, q.until));
    if (q.q) rest.push(searchCondition(q.q, !seesCommands(viewerOf(req))));
    const restWhere = rest.length > 0 ? and(...rest) : undefined;
    const where = q.status.length > 0 ? and(restWhere, inArray(jobs.status, q.status)) : restWhere;

    const items = deps.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.id))
      .limit(q.limit)
      .offset(q.offset)
      .all()
      .map((row) => liveJobToDto(row, deps.worker.cancelRequested(row.id), viewerOf(req)));

    const counts = Object.fromEntries(jobStatuses.map((s) => [s, 0])) as Record<JobStatus, number>;
    const grouped = deps.db
      .select({ status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(restWhere)
      .groupBy(jobs.status)
      .all();
    for (const g of grouped) if (g.status in counts) counts[g.status as JobStatus] = g.count;
    const counted: readonly JobStatus[] = q.status.length > 0 ? q.status : jobStatuses;
    const total = counted.reduce((n, s) => n + counts[s], 0);

    return { items, total, counts, retentionDays: deps.settings.get('jobsRetentionDays') || 90 };
  });

  // Static, so it outranks /api/jobs/:id.
  r.get('/api/jobs/types', async (): Promise<{ items: JobTypeInfoDto[] }> => {
    const registry = getRegistry();
    const info: Record<string, JobTypeInfo> = JOB_TYPE_INFO;
    return {
      items: (Object.keys(JOB_TYPE_INFO) as JobType[]).map((type) => ({
        type,
        label: info[type]!.label,
        description: info[type]!.description,
        category: info[type]!.category,
        internal: info[type]!.internal === true,
        timeoutMs: registry[type]?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })),
    };
  });

  r.get('/api/jobs/:id', { schema: { params: idParams, querystring: jobDetailQuery } }, async (req) => {
    const job = deps.db.select().from(jobs).where(eq(jobs.id, req.params.id)).get();
    if (!job) throw notFound(`Job #${req.params.id} not found`);
    const viewer = viewerOf(req);
    // A command's output is whatever the command printed - `wp config get DB_PASSWORD` prints
    // the password - so only a caller who could have run it may read it.
    if (COMMAND_JOBS.has(job.type) && !seesCommands(viewer)) {
      return {
        job: liveJobToDto(job, deps.worker.cancelRequested(job.id), viewer),
        logs: [],
        lastSeq: req.query.logAfter,
        logsWithheld: true,
      };
    }
    // Other jobs run commands too - a site's creation runs its plugin recipes - and a line that
    // holds what one printed says so, with the line to show instead.
    const shown = seesCommands(viewer);
    const logs = deps.db
      .select()
      .from(jobLogs)
      .where(and(eq(jobLogs.jobId, job.id), gt(jobLogs.id, req.query.logAfter)))
      .orderBy(asc(jobLogs.id))
      .limit(500)
      .all()
      .map((l) => ({
        seq: l.id,
        ts: l.ts,
        level: l.level as 'info' | 'warn' | 'error',
        message: shown || l.withoutOutput === null ? l.message : l.withoutOutput,
      }));
    const lastSeq = logs.length > 0 ? logs[logs.length - 1]!.seq : req.query.logAfter;
    return { job: liveJobToDto(job, deps.worker.cancelRequested(job.id), viewer), logs, lastSeq };
  });

  r.post('/api/jobs/:id/cancel', { schema: { params: idParams } }, async (req) => {
    const before = deps.db.select().from(jobs).where(eq(jobs.id, req.params.id)).get();
    if (!before) throw notFound(`Job #${req.params.id} not found`);
    const needsFull = cancelNeedsFull(before, (id) => {
      try {
        return deps.schedulers.get(String(id));
      } catch {
        return null; // deleted since: the job is judged on its own
      }
    });
    if (needsFull) requireAccess(req, 'full', needsFull);
    const outcome = deps.worker.cancel(req.params.id);
    const job = deps.db.select().from(jobs).where(eq(jobs.id, req.params.id)).get();
    if (!job) throw notFound(`Job #${req.params.id} not found`);
    if (outcome === 'canceled') return { job: jobToDto(job, viewerOf(req)) };
    if (outcome === 'requested') {
      // Still a 409, as it always was - but one a client can tell apart from "cannot be
      // canceled": the request was taken, and the job stops at its next safe step.
      throw new AppError(
        'conflict',
        409,
        'Job is already running; cancellation was requested and applies at the next safe step',
        { cancelRequested: true },
      );
    }
    throw conflict(`Job is ${job.status} and cannot be canceled`);
  });
}

/**
 * Cancelling stops work, which is mostly the safe direction - but not for the backup policy,
 * which is Full's (docs/mcp.md): cancelled night after night, its jobs would be the backups
 * switched off. So Full cancels what a policy schedule started (whoever pressed "Run now"), a
 * backup or an offsite copy the panel took on its own, and the panel's own jobs - a panel
 * snapshot, housekeeping, a server being set up - except a fleet scan. What Full takes, or null.
 */
function cancelNeedsFull(
  job: JobRow,
  scheduleOf: (id: number) => Pick<ScheduleDto, 'kind' | 'action' | 'params'> | null,
): string | null {
  const schedule = job.scheduleId === null ? null : scheduleOf(job.scheduleId);
  const part = schedule ? backupPolicyPart(schedule) : null;
  if (part) return `cancelling what ${part} started`;
  if (!ofASite(job) && job.type !== 'wp.scanAll') return 'cancelling a job of the panel itself';
  const safetyNet = job.type === 'backup.create' || job.type === 'backup.offsite';
  const panelStarted = job.origin === 'schedule' || job.origin === 'system';
  return safetyNet && panelStarted ? 'cancelling a backup the panel took on its own' : null;
}
