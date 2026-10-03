import { Cron } from 'croner';

/**
 * croner in the browser answers the two questions the schedule editor cannot answer on
 * its own: is this pattern acceptable, and when does it actually fire. It is the same
 * library the panel schedules backups with, so the preview cannot drift from the job.
 */

/** A zone this browser's Intl does not know would otherwise poison every preview. */
function usableZone(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    return undefined;
  }
}

function build(expr: string, timezone?: string): Cron {
  const zone = usableZone(timezone);
  return new Cron(expr.trim(), zone ? { timezone: zone, paused: true } : { paused: true });
}

/** croner's verdict on a pattern, or null when it accepts it. */
export function cronPatternError(expr: string, timezone?: string): string | null {
  try {
    build(expr, timezone);
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).replace(/^CronPattern:\s*/, '');
  }
}

/** The next fire times on the server's clock; empty when the pattern can never match. */
export function nextCronRuns(expr: string, count: number, timezone?: string): Date[] {
  try {
    return build(expr, timezone).nextRuns(count);
  } catch {
    return [];
  }
}

export function formatRunTime(date: Date, timezone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: usableZone(timezone),
  }).format(date);
}
