import type { FastifyRequest } from 'fastify';
import type { BackupRow, JobRow, ServerRow } from '../db/schema.js';
import type { BackupCopyDto, BackupDto, JobDto, ServerDto } from '../../shared/types.js';
import { allows, type AccessLevel } from '../../shared/access.js';
import { laneServerId } from '../jobs/lanes.js';
import { maskResult } from '../jobs/summaries.js';
import { withoutStepOutput, type RecipeOutcome } from '../services/licenses.js';

/**
 * The jobs whose details are a command - WP-CLI arguments, a shell command line, a REST request -
 * and whose log is that command's own output. Anything can be typed into a command, a password
 * included, and no pattern catches every way of writing one, so a caller who could not have run
 * it - Read only - is shown none of it: not the summary, the error, the log (routes/jobs.ts), or
 * a schedule's params (routes/schedules.ts). Manage can run the same commands on the same sites,
 * and read whatever they would print, so it sees them. A recipe run is one too: its steps are
 * WP-CLI and PHP holding a licence key, which its log hides only where the plugin repeats it exactly.
 * So Read only is not told what a failed step printed anywhere else either: in a recipe run's
 * result, on the site's recipe status (routes/recipes.ts), or in the log of another job that ran
 * the recipes (job_logs.without_output).
 */
export const COMMAND_JOBS: ReadonlySet<string> = new Set(['wp.cli', 'site.shell', 'wp.rest', 'wp.recipes']);

const WITHHELD_ERROR = 'The command failed; what it said is not shown at Read only access';

/**
 * `viewer` is the access of whoever the answer is for - `viewerOf(req)`. At Read only, a result's
 * credentials are masked (jobs/summaries.ts maskResult) and a command's details withheld; at
 * Manage, only a panel job's result stays masked. It has no default, so that no route can show a
 * job without saying to whom.
 */
export function jobToDto(row: JobRow, viewer: AccessLevel): JobDto {
  return liveJobToDto(row, false, viewer);
}

/** The access of the caller a route is answering, for jobToDto. */
export const viewerOf = (req: FastifyRequest): AccessLevel => req.access ?? 'read';

/**
 * Could this caller have run the command a job holds, and read whatever it printed? Manage runs
 * WP-CLI, shell and REST calls on every site, so from Manage up it sees them; Read only never.
 */
export const seesCommands = (viewer: AccessLevel): boolean => allows(viewer, 'manage');

/**
 * Is this a site's job, rather than one of the panel's own? Those carry no slug - or `panel`,
 * which the copies of a panel snapshot are filed under, and which no site can be called.
 */
export const ofASite = (row: Pick<JobRow, 'siteSlug'>): boolean => row.siteSlug !== null && row.siteSlug !== 'panel';

/**
 * `cancelRequested` lives in the worker's memory, not in the row: the Jobs routes pass it for
 * the jobs they show. Everywhere else the job has only just been queued.
 */
export function liveJobToDto(row: JobRow, cancelRequested: boolean, viewer: AccessLevel): JobDto {
  const command = COMMAND_JOBS.has(row.type) && !seesCommands(viewer);
  const stored = row.result ? (JSON.parse(row.result) as Record<string, unknown>) : null;
  // The other command jobs' results are counts and codes; a recipe run's say why each recipe
  // failed, in what its step printed.
  const result = stored && command && row.type === 'wp.recipes' ? recipesWithoutOutput(stored) : stored;
  // A site's job shows Manage the credentials in its result: it could reset them anyway. A job
  // of the panel itself keeps them masked below Full - none holds one today, and Manage has no
  // business with one that would.
  const masked = !allows(viewer, 'full') && !(ofASite(row) && seesCommands(viewer));
  return {
    id: row.id,
    type: row.type as JobDto['type'],
    status: row.status as JobDto['status'],
    siteSlug: row.siteSlug,
    batchId: row.batchId,
    error: command && row.error ? WITHHELD_ERROR : row.error,
    result: result && masked ? maskResult(result) : result,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    summary: command ? null : row.summary,
    origin: row.origin as JobDto['origin'],
    createdBy: row.createdBy,
    scheduleId: row.scheduleId,
    serverId: row.serverId ?? laneServerId(row.lane),
    cancelRequested: cancelRequested && row.status === 'running',
  };
}

function recipesWithoutOutput(result: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(result.outcomes)) return result;
  return { ...result, outcomes: result.outcomes.map((o: RecipeOutcome) => withoutStepOutput(o)) };
}

export function backupToDto(row: BackupRow, copies: BackupCopyDto[] = []): BackupDto {
  return {
    id: row.id,
    siteSlug: row.siteSlug,
    serverId: row.serverId,
    type: row.type as BackupDto['type'],
    status: row.status as BackupDto['status'],
    sizeBytes: row.sizeBytes,
    wpVersion: row.wpVersion,
    phpVersion: row.phpVersion,
    note: row.note,
    jobId: row.jobId,
    filesPresent: row.filesPresent === 1,
    rootPath: row.rootPath,
    copies,
    createdAt: row.createdAt,
  };
}

export function serverToDto(row: ServerRow, sitesCount: number): ServerDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ServerDto['kind'],
    sshHost: row.sshHost,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    hostKeySha256: row.hostKeySha256,
    publicIp: row.publicIp,
    devDomain: row.devDomain,
    dnsProvider: row.dnsProvider,
    status: row.status as ServerDto['status'],
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
    sitesCount,
    createdAt: row.createdAt,
  };
}
