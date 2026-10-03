import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { jobLogs, jobs } from '../../src/db/schema.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

describe('nightly housekeeping as a job', () => {
  it('prunes, says what it did in its own log, and reports the counts', async () => {
    const w = await makeWorld();
    const longAgo = Date.now() - 200 * 24 * 3600_000;
    const old = w.db
      .insert(jobs)
      .values({ type: 'demo', payload: '{}', status: 'succeeded', createdAt: longAgo, finishedAt: longAgo })
      .returning()
      .get();

    const report = await w.deps.schedulers.run('housekeeping', 'timer');
    const job = report!.jobs[0]!;
    expect(job).toMatchObject({ type: 'system.housekeeping', lane: 'housekeeping', origin: 'schedule', createdBy: 'Nightly housekeeping' });

    const done = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');
    expect(JSON.parse(done.result!)).toMatchObject({ jobsPruned: 1, backupsPruned: 0 });
    expect(w.db.select().from(jobs).where(eq(jobs.id, old.id)).get()).toBeUndefined();

    const log = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).orderBy(asc(jobLogs.id)).all().map((l) => l.message);
    expect(log[0]).toMatch(/^Backup retention/);
    expect(log).toContain('Job retention: removed 1 finished job(s) older than 90 days');
    expect(log.at(-1)).toBe('Housekeeping done.');
  });

  it('does not wait behind the lane-less queue', async () => {
    const w = await makeWorld();
    // A fleet scan holds the lane-less queue; housekeeping has a lane of its own.
    const scan = w.worker.enqueue('wp.scanAll', {});
    w.db.update(jobs).set({ status: 'running', startedAt: Date.now() }).where(eq(jobs.id, scan.id)).run();
    const report = await w.deps.schedulers.runNow('housekeeping', 'full');
    const done = await runJob(w, report.jobs[0]!.id);
    expect(done.status).toBe('succeeded');
  });
});
