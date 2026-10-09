/**
 * Custom schedules: what one may do, to what, and how a request to create one looks.
 *
 * Shared by the API (validation, and the JSON Schemas `GET /schedules/actions` hands an MCP
 * client) and the schedule editor, so both reject the same things with the same words.
 * The server-side half - turning an action into jobs - is src/jobs/actions.ts.
 */
// @docs automations/custom-jobs, plugins/updates
import { z } from 'zod';
import {
  GODMODE_WAIT_REFUSAL,
  execTimeoutMin,
  siteShellCommand,
  siteSlugParam,
  waitsOnGodmode,
  wpCliArgs,
  wpRestRequest,
  type JobCategory,
  type JobType,
} from './schemas.js';

export const scheduleActions = [
  'backup',
  'site.restart',
  'site.start',
  'site.stop',
  'wp.scan',
  'wp.update',
  'panel.snapshot',
  'wp.cli',
  'site.shell',
  'wp.rest',
] as const;
export type ScheduleAction = (typeof scheduleActions)[number];

/**
 * What a schedule runs against. `server` and `all` are resolved when the schedule fires, to
 * the sites running there at that moment - so a site created next week is included without
 * anyone editing the schedule. `sites` names slugs, which never change; one that has since
 * been deleted is skipped (and reported) rather than failing the run.
 */
export const scheduleTargetKinds = ['sites', 'server', 'all', 'panel'] as const;
export type ScheduleTargetKind = (typeof scheduleTargetKinds)[number];

export const scheduleTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sites'), slugs: z.array(siteSlugParam).min(1).max(200) }).strict(),
  z.object({ kind: z.literal('server'), serverId: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('panel') }).strict(),
]);
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

const noParams = z.object({}).strict();

/**
 * An update policy rather than a list: which kinds of component to bring up to date, decided
 * against a fresh scan when the job runs - a list written into the schedule would be stale
 * by the second night.
 */
export const wpUpdateParams = z
  .object({
    plugins: z.boolean().default(true),
    themes: z.boolean().default(true),
    core: z.boolean().default(false),
    /** Only the updates that clear a known vulnerability ("Fix vulnerable" on the site page). */
    onlyVulnerable: z.boolean().default(false),
    /** A backup before anything changes; kept like a scheduled backup, so retention bounds it. */
    backupFirst: z.boolean().default(true),
    /** Ask the site for its home page afterwards and fail the job when it stops answering. */
    healthCheck: z.boolean().default(true),
  })
  .strict()
  .refine((p) => p.plugins || p.themes || p.core, {
    message: 'Choose plugins, themes or WordPress core (or several)',
  });
export type WpUpdatePolicy = z.infer<typeof wpUpdateParams>;

export const SCHEDULE_ACTION_PARAMS = {
  backup: z.object({ note: z.string().trim().max(200).optional() }).strict(),
  'site.restart': noParams,
  'site.start': noParams,
  'site.stop': noParams,
  'wp.scan': noParams,
  'wp.update': wpUpdateParams,
  'panel.snapshot': noParams,
  // A schedule's command is a job, so a WP Godmode wait is refused here as it is on /wp/cli.
  'wp.cli': z
    .object({ args: wpCliArgs, timeoutMin: execTimeoutMin })
    .strict()
    .refine((p) => !waitsOnGodmode(p.args), { message: GODMODE_WAIT_REFUSAL, path: ['args'] }),
  'site.shell': z.object({ command: siteShellCommand, timeoutMin: execTimeoutMin }).strict(),
  'wp.rest': wpRestRequest,
} satisfies Record<ScheduleAction, z.ZodType>;

export type ScheduleActionParams = { [A in ScheduleAction]: z.infer<(typeof SCHEDULE_ACTION_PARAMS)[A]> };

/**
 * Does a schedule doing this take backups? They are `scheduled` ones (or panel snapshots), which
 * count toward the retention that keeps the backup history: a schedule taking them often enough
 * pushes that history out. So such a schedule is part of the backup policy, which is Full's
 * (docs/mcp.md), and not work inside a site. An update policy backs up first unless told not to.
 */
export function takesBackups(action: ScheduleAction, params: unknown): boolean {
  if (action === 'backup' || action === 'panel.snapshot') return true;
  if (action !== 'wp.update') return false;
  const policy = wpUpdateParams.safeParse(params ?? {});
  return policy.success ? policy.data.backupFirst : true;
}

/**
 * Is a schedule part of the backup policy - and what to call it in a refusal? Every built-in one
 * is (pausing one stops the backups, the scans or the housekeeping of every site; running one
 * now can prune), and so is a custom one that takes backups. Null: work Manage could do by hand.
 */
export function backupPolicyPart(schedule: {
  kind: 'builtin' | 'custom';
  action: ScheduleAction | null;
  params: unknown;
}): string | null {
  if (schedule.kind === 'builtin') return 'a built-in schedule';
  return schedule.action && takesBackups(schedule.action, schedule.params) ? 'a schedule that takes backups' : null;
}

export interface ScheduleActionInfo {
  label: string;
  description: string;
  category: JobCategory;
  /** Target kinds this action accepts, the first one being what the editor offers first. */
  targets: readonly ScheduleTargetKind[];
  /** The job type it queues (one per site for site targets). */
  jobType: JobType;
  /**
   * It runs on sites hosted elsewhere too (through WPL7 Connect). Those have no container to
   * start, stop or open a shell in, and run only the WP-CLI commands their plugins registered.
   */
  external: boolean;
  /** For a site hosted elsewhere that cannot take it: what it cannot be. */
  externalRefusal?: string;
}

const SITE_TARGETS = ['sites', 'server', 'all'] as const;

export const SCHEDULE_ACTION_INFO = {
  backup: {
    label: 'Back up',
    description:
      'A backup of each site. It counts toward the same retention as the scheduled backups, so keep the number of backups per site in mind.',
    category: 'backups',
    targets: SITE_TARGETS,
    jobType: 'backup.create',
    external: true,
  },
  'site.restart': {
    label: 'Restart sites',
    description: "Restarts each site's container.",
    category: 'sites',
    targets: SITE_TARGETS,
    jobType: 'site.restart',
    external: false,
    externalRefusal: 'cannot be restarted',
  },
  'site.start': {
    label: 'Start sites',
    description: "Starts each site's container (a site that is already running is left alone).",
    category: 'sites',
    targets: ['sites', 'server'],
    jobType: 'site.start',
    external: false,
    externalRefusal: 'cannot be started',
  },
  'site.stop': {
    label: 'Stop sites',
    description: "Stops each site's container until something starts it again.",
    category: 'sites',
    targets: ['sites', 'server'],
    jobType: 'site.stop',
    external: false,
    externalRefusal: 'cannot be stopped',
  },
  'wp.scan': {
    label: 'Scan WordPress inventory',
    description: 'Re-reads what each site has installed and what has an update, and checks it against the vulnerability feed.',
    category: 'wordpress',
    targets: SITE_TARGETS,
    jobType: 'wp.scanAll',
    external: true,
  },
  'wp.update': {
    label: 'Update plugins, themes and WordPress',
    description:
      'Scans each site, then updates what has an update - or only what fixes a known vulnerability - optionally after a backup and with a health check.',
    category: 'wordpress',
    targets: SITE_TARGETS,
    jobType: 'wp.bulkTask',
    external: true,
  },
  'panel.snapshot': {
    label: 'Panel snapshot',
    description: "A copy of the panel's own database, the one the scheduled backups also take.",
    category: 'backups',
    targets: ['panel'],
    jobType: 'panel.snapshot',
    external: false,
  },
  'wp.cli': {
    label: 'WP-CLI command',
    description:
      "Runs a WP-CLI command in each site's container. A site hosted elsewhere runs only the commands its plugins registered with WPL7 Connect. Its output goes to the job log.",
    category: 'wordpress',
    targets: SITE_TARGETS,
    jobType: 'wp.cli',
    external: true,
  },
  'site.shell': {
    label: 'Shell command',
    description:
      "Runs a shell command in each site's container as www-data, in the WordPress folder. Its output goes to the job log.",
    category: 'sites',
    targets: SITE_TARGETS,
    jobType: 'site.shell',
    external: false,
    externalRefusal: 'runs no shell commands',
  },
  'wp.rest': {
    label: 'REST API request',
    description:
      "Sends a request to a WordPress REST API route (/wp-json/…) of each site, optionally signed in with an application password. The response goes to the job log; anything but a 2xx answer fails the job.",
    category: 'wordpress',
    targets: SITE_TARGETS,
    jobType: 'wp.rest',
    external: true,
  },
} as const satisfies Record<ScheduleAction, ScheduleActionInfo>;

/** Nothing fires more often than this: every run is a job with a log, and holds its site. */
export const MIN_SCHEDULE_GAP_MS = 5 * 60_000;
export const MAX_CUSTOM_SCHEDULES = 100;

const scheduleFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  target: scheduleTargetSchema,
  /** Five-field cron on the panel's clock (`GET /meta` timezone). Exactly one of cron / runAt. */
  cron: z.string().trim().min(1).max(100).optional(),
  /** Run once, at this time (ms since the epoch). */
  runAt: z.number().int().positive().optional(),
  /** false = created paused. */
  enabled: z.boolean().default(true),
};

// One variant per action, so `params` is validated against that action's own schema. `prefault`
// rather than `default`: zod 4 returns a `default` as-is, and `{}` must go through the schema
// to pick up the defaults inside it.
export const scheduleCreateBody = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('backup'), params: SCHEDULE_ACTION_PARAMS.backup.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('site.restart'), params: noParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('site.start'), params: noParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('site.stop'), params: noParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('wp.scan'), params: noParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('wp.update'), params: wpUpdateParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('panel.snapshot'), params: noParams.prefault({}), ...scheduleFields }).strict(),
    z.object({ action: z.literal('wp.cli'), params: SCHEDULE_ACTION_PARAMS['wp.cli'], ...scheduleFields }).strict(),
    z.object({ action: z.literal('site.shell'), params: SCHEDULE_ACTION_PARAMS['site.shell'], ...scheduleFields }).strict(),
    z.object({ action: z.literal('wp.rest'), params: SCHEDULE_ACTION_PARAMS['wp.rest'], ...scheduleFields }).strict(),
  ])
  .superRefine((body, ctx) => {
    if ((body.cron === undefined) === (body.runAt === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Give either "cron" (repeat) or "runAt" (once), not both', path: ['cron'] });
    }
    const allowed: readonly string[] = SCHEDULE_ACTION_INFO[body.action].targets;
    if (!allowed.includes(body.target.kind)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${body.action}" runs on ${allowed.map((k) => `"${k}"`).join(' or ')} targets, not "${body.target.kind}"`,
        path: ['target', 'kind'],
      });
    }
  });
export type ScheduleCreateBody = z.infer<typeof scheduleCreateBody>;

/**
 * A partial change. The server merges it into the stored schedule and validates the result
 * with `scheduleCreateBody`, so a patch can never produce a schedule a create would refuse.
 * `null` clears `cron`, `runAt` or `description` (switching a schedule from repeat to once).
 * Built-in schedules accept `enabled` and nothing else.
 */
export const scheduleUpdateBody = z
  .object({
    name: scheduleFields.name.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    action: z.enum(scheduleActions).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    target: scheduleTargetSchema.optional(),
    cron: z.string().trim().min(1).max(100).nullable().optional(),
    runAt: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' });
export type ScheduleUpdateBody = z.infer<typeof scheduleUpdateBody>;
