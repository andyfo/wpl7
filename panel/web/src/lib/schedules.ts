// @docs automations/custom-jobs, automations/schedules
import type { ScheduleDto } from '../../../shared/types';
import { MIN_SCHEDULE_GAP_MS, type ScheduleAction, type ScheduleTarget } from '../../../shared/scheduleActions';
import { splitRestRoute, WP_REST_MAX_BODY, wpRestRoute } from '../../../shared/schemas';
import { cronError } from '../../../shared/cron';
import { cronPatternError, formatRunTime, nextCronRuns } from './cron';

/**
 * The Schedules page's wording and ordering, kept apart from the components so they can be
 * tested without a browser.
 */

export interface ServerName {
  id: number;
  name: string;
}

/** A list of slugs as a phrase: "shop", "shop and blog", "shop, blog and 3 more". */
function slugList(slugs: readonly string[]): string {
  if (slugs.length === 0) return 'no site';
  if (slugs.length === 1) return slugs[0]!;
  if (slugs.length <= 3) return `${slugs.slice(0, -1).join(', ')} and ${slugs[slugs.length - 1]}`;
  return `${slugs.slice(0, 2).join(', ')} and ${slugs.length - 2} more`;
}

const serverName = (servers: readonly ServerName[], id: number) =>
  servers.find((s) => s.id === id)?.name ?? `server #${id}`;

/**
 * What a custom schedule runs on, as the row under its name says it. A server target means
 * the sites running there when it fires - the stopped ones, for "Start sites".
 */
export function targetText(
  target: ScheduleTarget | null,
  servers: readonly ServerName[] = [],
  action?: ScheduleAction | null,
): string {
  if (!target) return '';
  switch (target.kind) {
    case 'sites':
      return slugList(target.slugs);
    case 'server':
      return `${action === 'site.start' ? 'stopped' : 'running'} sites on ${serverName(servers, target.serverId)}`;
    case 'all':
      return 'all running sites';
    case 'panel':
      return 'the panel';
  }
}

/**
 * The next few runs, for a title attribute. The cadence text says "At 03:00, every day"; this
 * is for the reader who wants to check that it means tonight.
 */
export function nextRunsTooltip(
  schedule: Pick<ScheduleDto, 'cadence' | 'nextRunAt'>,
  timezone?: string,
  count = 3,
): string | undefined {
  const zone = timezone ? ` (${timezone})` : '';
  const { cron, runAt } = schedule.cadence;
  if (cron) {
    const runs = nextCronRuns(cron, count, timezone);
    return runs.length > 0 ? `Next: ${runs.map((run) => formatRunTime(run, timezone)).join(' · ')}${zone}` : undefined;
  }
  if (runAt) return `Once: ${formatRunTime(new Date(runAt), timezone)}${zone}`;
  if (schedule.nextRunAt) return `Next: ${formatRunTime(new Date(schedule.nextRunAt), timezone)}${zone}`;
  return undefined;
}

/**
 * Why a custom schedule may not use this cron expression, or null - the checks the panel
 * makes (src/services/schedules.ts), made while typing: five fields, a pattern croner takes,
 * and no two runs closer than MIN_SCHEDULE_GAP_MS. Fifty runs cover any gap a five-field
 * pattern can have, the day boundary included; the panel checks again on save.
 */
export function cronScheduleProblem(expr: string, timezone?: string): string | null {
  const shape = cronError(expr);
  if (shape) return shape;
  const pattern = cronPatternError(expr, timezone);
  if (pattern) return pattern;
  const runs = nextCronRuns(expr, 50, timezone);
  if (runs.length === 0) return 'No date ever matches this.';
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_SCHEDULE_GAP_MS) {
      return `Runs may be at most every ${MIN_SCHEDULE_GAP_MS / 60_000} minutes: every run is a job, with its own log.`;
    }
  }
  return null;
}

/** The target in a name: short, since the name is the first thing in its row. */
function targetInName(target: ScheduleTarget | null, servers: readonly ServerName[]): string {
  if (!target) return 'sites';
  switch (target.kind) {
    case 'sites':
      return target.slugs.length === 1 ? target.slugs[0]! : target.slugs.length === 0 ? 'sites' : `${target.slugs.length} sites`;
    case 'server':
      return `sites on ${serverName(servers, target.serverId)}`;
    case 'all':
      return 'all sites';
    case 'panel':
      return 'the panel';
  }
}

/**
 * The name the editor offers when none is typed: what it does to what, like "Back up shop"
 * or "wp cache flush on all sites". Never longer than a name may be.
 */
export function suggestName(
  action: ScheduleAction,
  target: ScheduleTarget | null,
  opts: { servers?: readonly ServerName[]; params?: Record<string, unknown> | null } = {},
): string {
  const on = targetInName(target, opts.servers ?? []);
  const params = opts.params ?? {};
  const name = (() => {
    switch (action) {
      case 'backup':
        return `Back up ${on}`;
      case 'site.restart':
        return `Restart ${on}`;
      case 'site.start':
        return `Start ${on}`;
      case 'site.stop':
        return `Stop ${on}`;
      case 'wp.scan':
        return `Scan ${on}`;
      case 'wp.update':
        return params.onlyVulnerable === true ? `Security updates on ${on}` : `Update ${on}`;
      case 'panel.snapshot':
        return 'Panel snapshot';
      case 'wp.cli': {
        const args = Array.isArray(params.args) ? params.args.filter((a): a is string => typeof a === 'string') : [];
        return args.length > 0 ? `wp ${args.slice(0, 3).join(' ')} on ${on}` : `WP-CLI on ${on}`;
      }
      case 'site.shell':
        return `Shell command on ${on}`;
      case 'wp.rest': {
        const typed = typeof params.route === 'string' ? params.route : '';
        const route = wpRestRoute.safeParse(typed).success ? splitRestRoute(typed).route : null;
        const method = typeof params.method === 'string' ? params.method : 'GET';
        return route ? `${method} /wp-json${route} on ${on}` : `REST request on ${on}`;
      }
      default:
        return `${String(action)} on ${on}`;
    }
  })();
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

/** Why a REST request's route would be refused, or null - in the editor's words. */
export function restRouteProblem(route: string): string | null {
  if (!route.trim()) return 'Type the route to request, such as wp/v2/posts.';
  const parsed = wpRestRoute.safeParse(route);
  if (parsed.success) return null;
  const message = parsed.error.issues[0]?.message ?? 'this route cannot be requested';
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
}

/**
 * A REST request's body as typed: the JSON it sends, or why it cannot be sent. An empty box is
 * no body at all.
 */
export function parseRestBody(text: string): { value?: unknown; problem: string | null } {
  if (!text.trim()) return { problem: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { problem: `The body is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (value === null || typeof value !== 'object') return { problem: 'The body is a JSON object ({…}) or a list ([…]).' };
  if (JSON.stringify(value).length > WP_REST_MAX_BODY) return { problem: `The body may be at most ${WP_REST_MAX_BODY / 1024} KB.` };
  return { value, problem: null };
}

/** Paused by someone - not a one-off that has run and switched itself off. */
export const isPaused = (s: Pick<ScheduleDto, 'enabled' | 'finished'>): boolean => !s.enabled && !s.finished;

const sortRank = (s: ScheduleDto): number => {
  if (s.running) return 0;
  if (s.finished) return 4;
  if (!s.enabled) return 3;
  return s.nextRunAt !== null ? 1 : 2;
};

/**
 * What is happening now first, then what happens next, soonest first; paused schedules after
 * that, and one-offs that are done at the very end.
 */
export function sortSchedules(items: readonly ScheduleDto[]): ScheduleDto[] {
  return [...items].sort(
    (a, b) =>
      sortRank(a) - sortRank(b) ||
      (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name) ||
      a.id - b.id,
  );
}

const nameList = (items: readonly ScheduleDto[]) =>
  items.length <= 2
    ? items.map((s) => s.name).join(', ')
    : `${items
        .slice(0, 2)
        .map((s) => s.name)
        .join(', ')} and ${items.length - 2} more`;

/**
 * One line for the folded Background tasks card: "12 tasks · all ok", or what needs a look -
 * "12 tasks · 1 failing: Mail log".
 */
export function backgroundSummary(items: readonly ScheduleDto[]): string {
  const failing = items.filter((s) => s.lastOutcome === 'failed');
  const paused = items.filter(isPaused);
  const parts = [`${items.length} ${items.length === 1 ? 'task' : 'tasks'}`];
  if (failing.length > 0) parts.push(`${failing.length} failing: ${nameList(failing)}`);
  if (paused.length > 0) parts.push(`${paused.length} paused: ${nameList(paused)}`);
  if (failing.length === 0 && paused.length === 0) parts.push('all ok');
  return parts.join(' · ');
}
