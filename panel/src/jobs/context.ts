import type { Db } from '../db/index.js';
import { jobLogs } from '../db/schema.js';
import { JobCanceledError } from '../lib/errors.js';

export type Compensation = { name: string; fn: () => Promise<void> };

/** Per-job execution context: step logging, cancellation, and rollback bookkeeping. */
export class JobContext<TPayload = unknown> {
  private compensations: Compensation[] = [];
  private result: Record<string, unknown> | null = null;
  cancelRequested = false;

  constructor(
    readonly jobId: number,
    readonly payload: TPayload,
    private readonly db: Db,
  ) {}

  /**
   * `withoutOutput`: the line without what a command printed, for a caller who may not read that
   * (routes/jobs.ts) - given only where the line holds some.
   */
  log(level: 'info' | 'warn' | 'error', message: string, withoutOutput?: string): void {
    this.db.insert(jobLogs).values({ jobId: this.jobId, ts: Date.now(), level, message, withoutOutput }).run();
  }

  info = (message: string) => this.log('info', message);
  warn = (message: string, withoutOutput?: string) => this.log('warn', message, withoutOutput);
  error = (message: string) => this.log('error', message);

  /** Register an undo for a resource that was just created. Runs in reverse order on failure. */
  pushCompensation(name: string, fn: () => Promise<void>): void {
    this.compensations.push({ name, fn });
  }

  /** Handlers call this between steps; a pending cancellation aborts the job cleanly. */
  checkCanceled(): void {
    if (this.cancelRequested) throw new JobCanceledError();
  }

  setResult(result: Record<string, unknown>): void {
    this.result = result;
  }

  getResult(): Record<string, unknown> | null {
    return this.result;
  }

  /** Run compensations newest-first. Returns true when every one succeeded. */
  async runCompensations(): Promise<boolean> {
    let allClean = true;
    for (const comp of [...this.compensations].reverse()) {
      try {
        this.info(`Rolling back: ${comp.name}`);
        await comp.fn();
      } catch (err) {
        allClean = false;
        this.error(`Rollback step "${comp.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return allClean;
  }

  clearCompensations(): void {
    this.compensations = [];
  }
}
