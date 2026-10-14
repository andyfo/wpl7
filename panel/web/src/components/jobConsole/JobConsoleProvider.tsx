// @docs automations/jobs
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { JobDto } from '../../../../shared/types';
import { jobLabel } from '../../../../shared/jobTypes';
import { api } from '../../api/client';
import { afterFailedRead, isTerminal, jobUnreadable, useJob, type JobDetailRes } from '../../api/hooks';
import {
  PREFS_KEY,
  SESSION_KEY,
  prefsFrom,
  reduce,
  sessionFrom,
  type ConsoleEvent,
  type ConsoleState,
  type StoredPlace,
} from '../../lib/jobConsole';
import {
  ConsoleContext,
  ConsoleLogContext,
  FollowContext,
  SnapshotsContext,
  type ConsoleControls,
  type FollowJob,
  type JobSnapshot,
} from './context';

function readStored(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    // Storage refused (a private window): the console starts empty, at its default place.
    return null;
  }
}

function store(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Refused: it lasts until the page is left.
  }
}

/** Forget this tab's console: on signing out, so the next admin to sign in here starts without it. */
export function forgetJobConsole(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing stored to forget.
  }
}

const sameJob = (a: JobDto, b: JobDto) => JSON.stringify(a) === JSON.stringify(b);

/** What a screen reader hears when a followed job ends. */
function endedText(s: JobSnapshot): string {
  const what = `${jobLabel(s.job.type)}${s.job.siteSlug ? `, ${s.job.siteSlug}` : ''}`;
  return `${what}: ${s.lost ? 'can no longer be read' : s.job.status}`;
}

/**
 * The job console's state, and the one reader of the jobs it follows - on every page, so a job
 * keeps being followed when its page is left. Its selected job is read with its log, the others
 * only for how they stand. When a job ends, the queries its starter named are read again, and
 * only then does it count as finished for the buttons waiting on it (useRunJob's `busy`).
 */
export function JobConsoleProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ConsoleState>(() => ({
    session: sessionFrom(readStored(() => sessionStorage, SESSION_KEY)),
    prefs: prefsFrom(readStored(() => localStorage, PREFS_KEY)),
  }));
  /**
   * Every job this tab followed, as last read. Never trimmed while the tab is open (it is small):
   * Close and the limit of five change the console's list only, and a page still shows its own
   * job's result - New site's one-time password among them.
   */
  const [snapshots, setSnapshots] = useState<ReadonlyMap<number, JobSnapshot>>(() => new Map());
  const latest = useRef(snapshots);
  latest.current = snapshots;
  /** The queries each job's starter asked to have read again when it ends. */
  const refreshKeys = useRef(new Map<number, QueryKey[]>());
  const focusNext = useRef<'chip' | 'console' | null>(null);

  useEffect(() => store(() => sessionStorage, SESSION_KEY, JSON.stringify(state.session)), [state.session]);
  useEffect(() => store(() => localStorage, PREFS_KEY, JSON.stringify(state.prefs)), [state.prefs]);

  const dispatch = useCallback((event: ConsoleEvent) => {
    setState((s) => reduce(s, event, (id) => latest.current.get(id)?.ended ?? false));
  }, []);

  const setPosition = useCallback((position: StoredPlace | null) => {
    setState((s) => ({ ...s, prefs: { ...s.prefs, position } }));
  }, []);

  /** A read of a job: a new state of it, or a failure (only one saying it is gone for good counts). */
  const record = useCallback((id: number, job: JobDto | null | undefined, error: unknown) => {
    setSnapshots((prev) => {
      const old = prev.get(id);
      const now = job ?? old?.job;
      if (!now) return prev;
      const lost = old?.lost === true || jobUnreadable(error);
      const ended = isTerminal(now.status) || lost;
      if (old && old.ended === ended && old.lost === lost && sameJob(old.job, now)) return prev;
      return new Map(prev).set(id, {
        job: now,
        ended,
        lost,
        error: old?.error ?? (jobUnreadable(error) ? error : null),
        refreshed: old?.refreshed ?? false,
      });
    });
  }, []);

  const follow = useCallback<FollowJob>(
    (job, opts) => {
      if (opts?.refresh?.length) {
        refreshKeys.current.set(job.id, [...(refreshKeys.current.get(job.id) ?? []), ...opts.refresh]);
      }
      // The job as the request that queued it answered: the bar can name it before the first read.
      setSnapshots((prev) =>
        prev.has(job.id)
          ? prev
          : new Map(prev).set(job.id, { job, ended: isTerminal(job.status), lost: false, error: null, refreshed: false }),
      );
      dispatch({ type: 'follow', id: job.id });
    },
    [dispatch],
  );

  // The selected job, with its log - read as the job page reads one, under a key of its own.
  const selectedId = state.session.selected;
  const selected = useJob(selectedId, 'console');
  useEffect(() => {
    if (selectedId !== null) record(selectedId, selected.job, selected.error);
  }, [selectedId, selected.job, selected.error, record]);

  // The others, until they end: how they stand, without their logs. Log lines are numbered
  // across every job, so `logAfter` at the largest number asks for none. After a reload this is
  // also the one read that tells an ended job from a running one.
  const others = state.session.jobs.filter((id) => id !== selectedId && !snapshots.get(id)?.ended);
  const statuses = useQueries({
    queries: others.map((id) => ({
      queryKey: ['job-status', id],
      queryFn: () => api<JobDetailRes>(`/api/jobs/${id}?logAfter=${Number.MAX_SAFE_INTEGER}`).then((res) => res.job),
      retry: false,
      refetchInterval: (q: { state: { status: string; data?: JobDto; error: unknown } }) =>
        q.state.status === 'error' ? afterFailedRead(q.state.error) : isTerminal(q.state.data?.status) ? false : 2000,
    })),
  });
  useEffect(() => {
    others.forEach((id, i) => {
      const status = statuses[i];
      if (status) record(id, status.data, status.error);
    });
  });

  // A job that ended: read again what it changed, wherever the user is now, then count it as
  // finished, and say so to a screen reader. A job first seen already over - read after a reload
  // - has nothing waiting on it here and nothing to announce.
  const [announcement, setAnnouncement] = useState<{ n: number; text: string } | null>(null);
  const before = useRef(snapshots);
  const refreshing = useRef(new Set<number>());
  useEffect(() => {
    const was = before.current;
    before.current = snapshots;
    const markRefreshed = (id: number) =>
      setSnapshots((prev) => {
        const now = prev.get(id);
        return now && !now.refreshed ? new Map(prev).set(id, { ...now, refreshed: true }) : prev;
      });
    for (const [id, s] of snapshots) {
      if (!s.ended || s.refreshed || refreshing.current.has(id)) continue;
      refreshing.current.add(id);
      const prior = was.get(id);
      if (!prior && !refreshKeys.current.has(id)) {
        markRefreshed(id);
        continue;
      }
      if (prior && !prior.ended) setAnnouncement((a) => ({ n: (a?.n ?? 0) + 1, text: endedText(s) }));
      const keys: QueryKey[] = [['sites'], ['jobs'], ...(refreshKeys.current.get(id) ?? [])];
      void Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))).finally(() => markRefreshed(id));
    }
  }, [snapshots, qc]);

  const controls = useMemo<ConsoleControls>(
    () => ({ state, dispatch, setPosition, focusNext }),
    [state, dispatch, setPosition],
  );
  const log = useMemo(
    () => ({ jobId: selectedId, logs: selected.logs, draining: selected.draining }),
    [selectedId, selected.logs, selected.draining],
  );

  return (
    <FollowContext.Provider value={follow}>
      <SnapshotsContext.Provider value={snapshots}>
        <ConsoleContext.Provider value={controls}>
          <ConsoleLogContext.Provider value={log}>
            {children}
            <div className="sr-only" aria-live="polite">
              {announcement && <span key={announcement.n}>{announcement.text}</span>}
            </div>
          </ConsoleLogContext.Provider>
        </ConsoleContext.Provider>
      </SnapshotsContext.Provider>
    </FollowContext.Provider>
  );
}
