// @docs automations/schedules
import { Cron } from 'croner';
import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schedules, type ScheduleRow } from '../db/schema.js';
import { cronError } from '../../shared/cron.js';
import { MIN_SCHEDULE_GAP_MS, type ScheduleCreateBody } from '../../shared/scheduleActions.js';
import type { ScheduleOutcome, ScheduleRunResult } from '../../shared/types.js';

/**
 * The `schedules` table: one row per built-in task (its pause switch and how its last run
 * went) and one per custom schedule (everything about it). Rows only - what a schedule
 * *does* is src/jobs/schedulers.ts and src/jobs/actions.ts.
 */

const MIN = 60_000;

/** croner with the panel's own clock, never armed: this is arithmetic, not a timer. */
function pattern(expr: string): Cron {
  return new Cron(expr, { paused: true });
}

/** When a cron expression next fires after `after`; null when it never does again. */
export function nextCronRun(expr: string, after: Date = new Date()): number | null {
  try {
    return pattern(expr).nextRun(after)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/**
 * Why a custom schedule may not use this expression, or null. Stricter than the backup cron:
 * only what the five-box editor can show (no seconds field, no `L`), croner must accept it,
 * and no two runs may come closer than MIN_SCHEDULE_GAP_MS - every run is a job with a log,
 * and holds its site against everything else while it runs.
 */
export function customCronProblem(expr: string, now: Date = new Date()): string | null {
  const shape = cronError(expr);
  if (shape) return shape;
  let runs: Date[];
  try {
    // A thousand runs span at least three days of even an every-five-minutes pattern, which is
    // where any gap a five-field expression can produce shows up (day boundaries included).
    runs = pattern(expr).nextRuns(1000, now);
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).replace(/^CronPattern:\s*/, '');
  }
  if (runs.length === 0) return 'This schedule never runs';
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_SCHEDULE_GAP_MS) {
      return `Runs may be at most every ${MIN_SCHEDULE_GAP_MS / MIN} minutes`;
    }
  }
  return null;
}

/**
 * How late a run may still start. A panel that was down (an update, a reboot) catches up on
 * a run it just missed, but not on one from the middle of the night: half the interval,
 * between two minutes and an hour. A one-off gets the full hour - it has no next time.
 */
export function graceMs(row: Pick<ScheduleRow, 'cron' | 'runAt' | 'nextRunAt'>): number {
  if (!row.cron) return 60 * MIN;
  const from = row.nextRunAt ?? Date.now();
  const after = nextCronRun(row.cron, new Date(from));
  const interval = after !== null ? after - from : 60 * MIN;
  return Math.min(60 * MIN, Math.max(2 * MIN, Math.floor(interval / 2)));
}

export interface RunRecord {
  at: number;
  durationMs: number;
  outcome: ScheduleOutcome;
  error: string | null;
  result: ScheduleRunResult | null;
}

export class ScheduleStore {
  constructor(private readonly db: Db) {}

  /** One row per built-in, created on first sight; existing rows keep their state. */
  ensureBuiltins(tasks: readonly { key: string; name: string }[], now = Date.now()): void {
    for (const task of tasks) {
      this.db
        .insert(schedules)
        .values({ key: task.key, name: task.name, enabled: 1, createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: schedules.key })
        .run();
    }
  }

  list(): ScheduleRow[] {
    return this.db.select().from(schedules).orderBy(asc(schedules.id)).all();
  }

  byId(id: number): ScheduleRow | null {
    return this.db.select().from(schedules).where(eq(schedules.id, id)).get() ?? null;
  }

  byKey(key: string): ScheduleRow | null {
    return this.db.select().from(schedules).where(eq(schedules.key, key)).get() ?? null;
  }

  /** `12` or a built-in's key (`wp-scan`), as the API accepts either. */
  resolve(idOrKey: string): ScheduleRow | null {
    return /^\d+$/.test(idOrKey) ? this.byId(Number(idOrKey)) : this.byKey(idOrKey);
  }

  customCount(): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(schedules).where(isNull(schedules.key)).get()?.n ?? 0;
  }

  setEnabled(id: number, enabled: boolean, nextRunAt: number | null, now = Date.now()): ScheduleRow {
    const row = this.byId(id)!;
    return this.db
      .update(schedules)
      .set({
        enabled: enabled ? 1 : 0,
        // Kept from the first pause, so "paused 3 days ago" survives a second click.
        pausedAt: enabled ? null : (row.pausedAt ?? now),
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(schedules.id, id))
      .returning()
      .get();
  }

  record(id: number, run: RunRecord): void {
    this.db
      .update(schedules)
      .set({
        lastRunAt: run.at,
        lastDurationMs: run.durationMs,
        lastOutcome: run.outcome,
        lastError: run.error,
        lastResult: run.result ? JSON.stringify(run.result) : null,
      })
      .where(eq(schedules.id, id))
      .run();
  }

  create(body: ScheduleCreateBody, createdBy: string | null, nextRunAt: number | null, now = Date.now()): ScheduleRow {
    return this.db
      .insert(schedules)
      .values({
        key: null,
        name: body.name,
        description: body.description ?? null,
        action: body.action,
        target: JSON.stringify(body.target),
        params: JSON.stringify(body.params),
        cron: body.cron ?? null,
        runAt: body.runAt ?? null,
        enabled: body.enabled ? 1 : 0,
        pausedAt: body.enabled ? null : now,
        nextRunAt,
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  /**
   * Replace a custom schedule's definition with an already-validated one. Only a schedule that
   * was on and is now off counts as paused: one that was already off keeps what it was - a
   * finished one-off being renamed is still finished, not paused.
   */
  replace(id: number, body: ScheduleCreateBody, nextRunAt: number | null, now = Date.now()): ScheduleRow {
    const row = this.byId(id)!;
    const pausedAt = body.enabled ? null : row.enabled === 1 ? now : row.pausedAt;
    return this.db
      .update(schedules)
      .set({
        name: body.name,
        description: body.description ?? null,
        action: body.action,
        target: JSON.stringify(body.target),
        params: JSON.stringify(body.params),
        cron: body.cron ?? null,
        runAt: body.runAt ?? null,
        enabled: body.enabled ? 1 : 0,
        pausedAt,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(schedules.id, id))
      .returning()
      .get();
  }

  remove(id: number): void {
    this.db.delete(schedules).where(eq(schedules.id, id)).run();
  }

  /** Enabled custom schedules whose time has come. */
  due(now: number): ScheduleRow[] {
    return this.db
      .select()
      .from(schedules)
      .where(
        and(isNull(schedules.key), eq(schedules.enabled, 1), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, now)),
      )
      .orderBy(asc(schedules.nextRunAt))
      .all();
  }

  /**
   * Move a due schedule on before it fires - so a run happens at most once even if firing
   * throws halfway. A repeating schedule gets its next occurrence after `now` (missed ones
   * collapse into this one); a one-off is done and switches itself off.
   */
  advance(row: ScheduleRow, now: number): void {
    if (row.cron) {
      this.db
        .update(schedules)
        .set({ nextRunAt: nextCronRun(row.cron, new Date(now)) })
        .where(eq(schedules.id, row.id))
        .run();
    } else {
      this.db.update(schedules).set({ nextRunAt: null, enabled: 0 }).where(eq(schedules.id, row.id)).run();
    }
  }
}
