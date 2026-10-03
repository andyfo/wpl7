import type { JobLogLine } from '../../../shared/types';

/**
 * The job page's log tools, kept apart from the component so they can be tested without a
 * browser: which lines a filter keeps, what Copy and Download produce, and where the first
 * error is for "Show in log".
 */

/** `problems` = warnings and errors, which is what someone opening a failed job looks for. */
export type LogLevelFilter = 'all' | 'problems';

export function levelCounts(logs: readonly JobLogLine[]): Record<JobLogLine['level'], number> {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const line of logs) counts[line.level]++;
  return counts;
}

/** The lines a level and a search keep. The search is case-insensitive and ignores outer spaces. */
export function filterLog(logs: readonly JobLogLine[], level: LogLevelFilter, search: string): JobLogLine[] {
  const needle = search.trim().toLowerCase();
  return logs.filter(
    (line) =>
      (level === 'all' || line.level !== 'info') && (needle === '' || line.message.toLowerCase().includes(needle)),
  );
}

/**
 * The log as a file: one line per entry, UTC timestamps in ISO form - a file outlives the
 * browser it was saved from, and a local time with no zone means nothing on another machine.
 */
export function logToText(logs: readonly JobLogLine[]): string {
  return logs.map((l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.message}\n`).join('');
}

export function firstErrorSeq(logs: readonly JobLogLine[]): number | null {
  return logs.find((l) => l.level === 'error')?.seq ?? null;
}
