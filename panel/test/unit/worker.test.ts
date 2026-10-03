import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, jobLogs, jobs, sites } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import { makeWorld, waitFor } from '../helpers.js';

describe('JobWorker', () => {
  it('runs queued jobs in order and records logs with a cursor', async () => {
    const w = await makeWorld();
    // Steps long enough for "b started after a finished" to mean something.
    const a = w.worker.enqueue('demo', { steps: 2, stepMs: 20 });
    const b = w.worker.enqueue('demo', { steps: 1, stepMs: 20 });
    w.worker.start();
    await waitFor(() => {
      const rows = w.db.select().from(jobs).all();
      return rows.every((r) => r.status === 'succeeded');
    }, 10_000);
    await w.worker.stop();

    const rowA = w.db.select().from(jobs).where(eq(jobs.id, a.id)).get()!;
    const rowB = w.db.select().from(jobs).where(eq(jobs.id, b.id)).get()!;
    expect(rowA.finishedAt!).toBeLessThanOrEqual(rowB.startedAt!);
    expect(JSON.parse(rowA.result!)).toEqual({ steps: 2 });

    const logsA = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, a.id)).all();
    expect(logsA.map((l) => l.message)).toEqual(['Demo step 1/2', 'Demo step 2/2']);
    // rowid is strictly increasing -> usable as a polling cursor
    const seqs = logsA.map((l) => l.id);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it('rejects a second active job for the same site', async () => {
    const w = await makeWorld();
    const site = { id: 42, slug: 'demo' };
    w.worker.enqueue('demo', { steps: 1 }, site);
    expect(() => w.worker.enqueue('demo', { steps: 1 }, site)).toThrowError(/active job/);
  });

  it('holds a site for a change outside the queue: refused while a job has it, and its jobs wait', async () => {
    const w = await makeWorld();
    const status = (id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;
    const site = { id: 42, slug: 'demo' };
    const busy = w.worker.enqueue('demo', { steps: 1, stepMs: 0 }, site);
    expect(() => w.worker.holdSite(site)).toThrowError(/busy with job/);
    // Beside a job of a type it names, it is not refused.
    w.worker.holdSite(site, new Set(['demo']))();
    w.worker.cancel(busy.id);

    const release = w.worker.holdSite(site);
    const waits = w.worker.enqueue('demo', { steps: 1, stepMs: 0 }, site);
    const other = w.worker.enqueue('demo', { steps: 1, stepMs: 0 }, { id: 43, slug: 'other' });
    w.worker.start();
    try {
      await waitFor(() => status(other.id) === 'succeeded');
      expect(status(waits.id)).toBe('queued');
      release();
      await waitFor(() => status(waits.id) === 'succeeded');
    } finally {
      await w.worker.stop();
    }
  });

  it('lets go of a hold older than any change takes, so a leak cannot stop a site’s jobs for good', async () => {
    const w = await makeWorld();
    const warn = vi.spyOn(w.core.log, 'warn');
    const site = { id: 42, slug: 'demo' };
    w.worker.holdSite(site); // never released
    const job = w.worker.enqueue('demo', { steps: 1, stepMs: 0 }, site);
    const now = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => now() + 16 * 60_000);
    w.worker.start();
    try {
      await waitFor(() => w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status === 'succeeded');
    } finally {
      await w.worker.stop();
      later.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Site #42 was held .* letting its jobs start/));
  });

  it('cancels queued jobs and reports running/terminal as not cancelable', async () => {
    const w = await makeWorld();
    const job = w.worker.enqueue('demo', { steps: 1 });
    expect(w.worker.cancel(job.id)).toBe('canceled');
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('canceled');
    expect(w.worker.cancel(job.id)).toBe('not_cancelable');
  });

  it('fails jobs with invalid payloads', async () => {
    const w = await makeWorld();
    const job = w.worker.enqueue('demo', { steps: 'NaN' });
    w.worker.start();
    await waitFor(() => w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status === 'failed');
    await w.worker.stop();
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.error).toMatch(/Invalid job payload/);
  });

  it('reconciles interrupted jobs, orphaned sites and half-written backups on boot', async () => {
    const w = await makeWorld();
    w.db
      .insert(jobs)
      .values({ type: 'demo', payload: '{}', status: 'running', createdAt: Date.now() })
      .run();
    w.db
      .insert(sites)
      .values({
        slug: 'stuck',
        title: 'Stuck',
        domains: '["stuck.dev.example.test"]',
        phpVersion: '8.3',
        status: 'provisioning',
        dbName: 'wp_stuck',
        dbUser: 'wp_stuck',
        dbPassword: 'x',
        containerName: 'wp-stuck',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const halfWritten = w.db
      .insert(backups)
      .values({ siteSlug: 'stuck', type: 'manual', status: 'creating', path: `${w.config.paths.backups}/stuck/1`, createdAt: Date.now() })
      .returning()
      .get();
    w.worker.reconcileOnBoot();
    expect(w.db.select().from(jobs).all()[0]!.status).toBe('failed');
    expect(w.db.select().from(sites).all()[0]!.status).toBe('error');
    // Failed rather than "creating" for good, which nothing may delete.
    expect(w.db.select().from(backups).where(eq(backups.id, halfWritten.id)).get()!.status).toBe('failed');
  });

  it('drops the secrets of every ended job at boot - a REST password kept from before, a command a restart cut short', async () => {
    const w = await makeWorld();
    const auth = { username: 'sync', applicationPassword: 'abcd efgh ijkl mnop qrst uvwx' };
    const add = (type: string, status: string, payload: Record<string, unknown>) =>
      w.db
        .insert(jobs)
        .values({ type, payload: JSON.stringify(payload), status, createdAt: Date.now() })
        .returning({ id: jobs.id })
        .get().id;
    const done = add('wp.rest', 'succeeded', { siteId: 1, method: 'GET', route: 'wp/v2/users/me', auth, timeoutMin: 10 });
    const cut = add('wp.cli', 'running', { siteId: 1, args: ['user', 'update', '1', '--prompt=user_pass'], stdin: 'hunter2hunter2', timeoutMin: 10 });
    const waiting = add('wp.rest', 'queued', { siteId: 1, method: 'GET', route: 'wp/v2/users/me', auth, timeoutMin: 10 });
    const payload = (id: number) => JSON.parse(w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.payload) as Record<string, unknown>;

    w.worker.reconcileOnBoot();
    expect(payload(done)).toEqual({ siteId: 1, method: 'GET', route: 'wp/v2/users/me', timeoutMin: 10 });
    expect(payload(cut)).toEqual({ siteId: 1, args: ['user', 'update', '1', '--prompt=user_pass'], timeoutMin: 10 });
    // A job still to run needs what it was given.
    expect(payload(waiting).auth).toEqual(auth);
  });
});

describe('JobContext compensations', () => {
  it('runs in reverse order and reports clean/unclean', async () => {
    const w = await makeWorld();
    const job = w.worker.enqueue('demo', {});
    const ctx = new JobContext(job.id, {}, w.db);
    const order: string[] = [];
    ctx.pushCompensation('first', async () => {
      order.push('first');
    });
    ctx.pushCompensation('second', async () => {
      order.push('second');
    });
    expect(await ctx.runCompensations()).toBe(true);
    expect(order).toEqual(['second', 'first']);

    const ctx2 = new JobContext(job.id, {}, w.db);
    ctx2.pushCompensation('boom', async () => {
      throw new Error('nope');
    });
    expect(await ctx2.runCompensations()).toBe(false);
  });
});
