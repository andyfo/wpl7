// @docs automations/jobs
import { createContext, useContext, type MutableRefObject } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import type { JobDto, JobLogLine } from '../../../../shared/types';
import type { ConsoleEvent, ConsoleState, StoredPlace } from '../../lib/jobConsole';

/**
 * What the job console shares, apart from the provider so that api/hooks.ts can follow jobs
 * without importing the provider, which imports it. Four contexts, so that each reader only
 * re-renders for what it reads: a page holding a useRunJob must not re-render with every log line.
 */

/** A followed job as last read. */
export interface JobSnapshot {
  job: JobDto;
  /** Over: finished, or no longer readable. */
  ended: boolean;
  /** It can no longer be read (deleted, or never was); `error` says why. */
  lost: boolean;
  error: Error | null;
  /** Over, and the queries it changed have been read again: the page shows what it did. */
  refreshed: boolean;
}

export type FollowJob = (job: JobDto, opts?: { refresh?: QueryKey[] }) => void;

export interface ConsoleControls {
  state: ConsoleState;
  dispatch: (event: ConsoleEvent) => void;
  setPosition: (position: StoredPlace | null) => void;
  /** Where focus goes once the console or the chip has been drawn: set by the one handing it over. */
  focusNext: MutableRefObject<'chip' | 'console' | null>;
}

export interface ConsoleLog {
  /** The job the lines are of. */
  jobId: number | null;
  logs: JobLogLine[];
  /** The job is over, and the rest of its log is still being read. */
  draining: boolean;
}

export const FollowContext = createContext<FollowJob | null>(null);
export const SnapshotsContext = createContext<ReadonlyMap<number, JobSnapshot> | null>(null);
export const ConsoleContext = createContext<ConsoleControls | null>(null);
export const ConsoleLogContext = createContext<ConsoleLog | null>(null);

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} is only available inside JobConsoleProvider (Layout)`);
  return value;
}

/**
 * Show a job in the console, and read `refresh` again when it ends - wherever the user is by
 * then, and even after whatever started it is gone (a dialog that closed).
 */
export const useFollowJob = () => required(useContext(FollowContext), 'useFollowJob');
/** The followed jobs as last read. */
export const useJobSnapshots = () => required(useContext(SnapshotsContext), 'useJobSnapshots');
export const useConsoleControls = () => required(useContext(ConsoleContext), 'useConsoleControls');
export const useConsoleLog = () => required(useContext(ConsoleLogContext), 'useConsoleLog');
