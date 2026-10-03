import { and, count, desc, eq, gte, isNotNull, like, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiEvents, type ApiEventRow } from '../db/schema.js';
import type { ApiEventDto, ApiEventOutcome } from '../../shared/types.js';

/**
 * A ceiling the retention period cannot lift. A script polling a job once a second writes
 * 86k rows a day, so "keep 90 days" could mean millions of rows in a database that is
 * backed up whole every night. Retention is what the operator sets; this is the guard that
 * stops a runaway client turning that setting into a disk problem.
 */
export const API_ACTIVITY_MAX_ROWS = 100_000;

/**
 * Rows between two cap checks. The ceiling is enforced here, on the way in, rather than
 * only by the nightly prune: refused tokens and rate-limited requests are recorded too, so
 * "what the table can grow to before 04:00" would otherwise be a function of how hard
 * somebody is hammering the panel, not of the cap. A check is one `count(*)` over an
 * index, so it is cheap at this spacing - and the table can never exceed the cap by more
 * than this many rows.
 */
const CAP_CHECK_EVERY = 200;

/** Oversized values are the client's, not ours - store enough to identify, not the whole thing. */
const MAX_PATH = 400;
const MAX_UA = 200;

export interface ApiEventInput {
  keyId: number | null;
  keyName: string;
  keyPrefix: string;
  method: string;
  path: string;
  route: string | null;
  status: number;
  errorCode: string | null;
  durationMs: number;
  ip: string | null;
  userAgent: string | null;
  jobId: number | null;
  /** Set on the calls the MCP server made for one of its tools. */
  mcp?: { connectionId: number | null; tool: string | null } | null;
}

export interface ApiActivityFilter {
  keyId?: number;
  /** Only the calls the MCP server made for its tools. */
  via?: 'mcp';
  outcome?: ApiEventOutcome;
  method?: string;
  /** Substring of the path. */
  search?: string;
  sinceHours?: number;
  limit: number;
  offset: number;
}

/** 401/403 is "the panel said no", which reads differently from a 500 and is filtered apart. */
export function outcomeOf(status: number): ApiEventOutcome {
  if (status === 401 || status === 403) return 'denied';
  return status >= 400 ? 'error' : 'ok';
}

const toDto = (row: ApiEventRow): ApiEventDto => ({
  id: row.id,
  ts: row.ts,
  keyId: row.keyId,
  keyName: row.keyName,
  keyPrefix: row.keyPrefix,
  method: row.method,
  path: row.path,
  route: row.route,
  status: row.status,
  outcome: outcomeOf(row.status),
  errorCode: row.errorCode,
  durationMs: row.durationMs,
  ip: row.ip,
  userAgent: row.userAgent,
  jobId: row.jobId,
  via: row.via === 'mcp' ? 'mcp' : null,
  connectionId: row.connectionId,
  tool: row.tool,
});

/**
 * The API request log behind the Activity tab.
 *
 * Written from the `onResponse` hook, so a row exists whatever the handler did - including
 * the requests that never reached one, which are the interesting ones: a rejected token,
 * a 404 from a client calling a path that moved, a 429 from one that is polling too hard.
 *
 * The row cap is enforced here, on the way in. Retention is a nightly job, but the writes
 * are not: anyone who can reach the panel can make it record a 401, so the ceiling has to
 * hold between maintenance runs rather than be restored by it.
 */
export class ApiActivityService {
  readonly maxRows: number;
  private readonly capCheckEvery: number;
  /** Inserts since the last cap check; see CAP_CHECK_EVERY. */
  private sinceCapCheck = 0;

  constructor(
    private readonly db: Db,
    /** Overridable so a test does not have to write a hundred thousand rows. */
    opts: { maxRows?: number; capCheckEvery?: number } = {},
  ) {
    this.maxRows = opts.maxRows ?? API_ACTIVITY_MAX_ROWS;
    this.capCheckEvery = opts.capCheckEvery ?? CAP_CHECK_EVERY;
  }

  record(event: ApiEventInput): void {
    this.db
      .insert(apiEvents)
      .values({
        ts: Date.now(),
        keyId: event.keyId,
        keyName: event.keyName.slice(0, 120),
        keyPrefix: event.keyPrefix.slice(0, 16),
        method: event.method,
        path: event.path.slice(0, MAX_PATH),
        route: event.route,
        status: event.status,
        errorCode: event.errorCode,
        durationMs: Math.round(event.durationMs),
        ip: event.ip,
        userAgent: event.userAgent ? event.userAgent.slice(0, MAX_UA) : null,
        jobId: event.jobId,
        via: event.mcp ? 'mcp' : null,
        connectionId: event.mcp?.connectionId ?? null,
        tool: event.mcp?.tool ?? null,
      })
      .run();

    if (++this.sinceCapCheck >= this.capCheckEvery) {
      this.sinceCapCheck = 0;
      this.trimToCap();
    }
  }

  list(filter: ApiActivityFilter): { items: ApiEventDto[]; total: number } {
    const conditions = [];
    if (filter.keyId !== undefined) conditions.push(eq(apiEvents.keyId, filter.keyId));
    if (filter.via) conditions.push(eq(apiEvents.via, filter.via));
    if (filter.method) conditions.push(eq(apiEvents.method, filter.method));
    if (filter.sinceHours) conditions.push(gte(apiEvents.ts, Date.now() - filter.sinceHours * 3600_000));
    if (filter.search) conditions.push(like(apiEvents.path, `%${filter.search}%`));
    if (filter.outcome === 'denied') {
      conditions.push(or(eq(apiEvents.status, 401), eq(apiEvents.status, 403)));
    } else if (filter.outcome === 'error') {
      conditions.push(
        and(gte(apiEvents.status, 400), sql`${apiEvents.status} not in (401, 403)`),
      );
    } else if (filter.outcome === 'ok') {
      conditions.push(lt(apiEvents.status, 400));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = this.db.select({ n: count() }).from(apiEvents).where(where).get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(apiEvents)
      .where(where)
      .orderBy(desc(apiEvents.ts), desc(apiEvents.id))
      .limit(filter.limit)
      .offset(filter.offset)
      .all();
    return { items: rows.map(toDto), total };
  }

  /** Headline counters, always over the same window whatever the table is filtered to. */
  last24h(): { requests: number; errors: number; denied: number; keys: number } {
    const since = Date.now() - 24 * 3600_000;
    const row = this.db
      .select({
        requests: count(),
        errors: sql<number>`sum(case when ${apiEvents.status} >= 400 and ${apiEvents.status} not in (401, 403) then 1 else 0 end)`,
        denied: sql<number>`sum(case when ${apiEvents.status} in (401, 403) then 1 else 0 end)`,
        keys: sql<number>`count(distinct ${apiEvents.keyId})`,
      })
      .from(apiEvents)
      .where(gte(apiEvents.ts, since))
      .get();
    return {
      requests: row?.requests ?? 0,
      errors: Number(row?.errors ?? 0),
      denied: Number(row?.denied ?? 0),
      keys: Number(row?.keys ?? 0),
    };
  }

  /** Oldest first out: anything past the retention window, then anything past the row cap. */
  prune(retentionDays: number, maxRows = this.maxRows): number {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 3600_000;
    const removed = this.db.delete(apiEvents).where(lt(apiEvents.ts, cutoff)).run().changes;
    return removed + this.trimToCap(maxRows);
  }

  /** Drop everything below the newest `maxRows` rows. Cheap no-op while under the cap. */
  trimToCap(maxRows = this.maxRows): number {
    const total = this.db.select({ n: count() }).from(apiEvents).get()?.n ?? 0;
    if (total <= maxRows) return 0;
    // Cut by id rather than by timestamp: ids are monotonic here and a clock that went
    // backwards must not make two rows undeletable.
    const boundary = this.db
      .select({ id: apiEvents.id })
      .from(apiEvents)
      .orderBy(desc(apiEvents.id))
      .limit(1)
      .offset(maxRows - 1)
      .get();
    if (!boundary) return 0;
    return this.db.delete(apiEvents).where(lt(apiEvents.id, boundary.id)).run().changes;
  }

  /** "Forget what my keys have been doing", from the Activity tab. */
  clear(): number {
    return this.db.delete(apiEvents).run().changes;
  }

  /** Requests per key in the window, for the "in use" column on the key list. */
  countsByKey(sinceHours: number): Map<number, number> {
    const rows = this.db
      .select({ keyId: apiEvents.keyId, n: count() })
      .from(apiEvents)
      .where(and(isNotNull(apiEvents.keyId), gte(apiEvents.ts, Date.now() - sinceHours * 3600_000)))
      .groupBy(apiEvents.keyId)
      .all();
    return new Map(rows.filter((r) => r.keyId !== null).map((r) => [r.keyId as number, r.n]));
  }
}
