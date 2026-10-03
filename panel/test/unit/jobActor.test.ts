import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../../src/db/schema.js';
import { currentActor, runAs, withoutActor, type JobActor } from '../../src/jobs/actor.js';
import { getRegistry, type RegistryEntry } from '../../src/jobs/registry.js';
import { makeWorld, waitFor } from '../helpers.js';

describe('job attribution (src/jobs/actor.ts)', () => {
  it('stamps who queued a job, carried across awaits into enqueue', async () => {
    const w = await makeWorld();
    const actor: JobActor = { origin: 'user', createdBy: 'alice', jobs: [] };
    const job = await runAs(actor, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return w.worker.enqueue('demo', { steps: 1 });
    });
    expect(job.origin).toBe('user');
    expect(job.createdBy).toBe('alice');
    expect(job.scheduleId).toBeNull();
    expect(actor.jobs?.map((j) => j.id)).toEqual([job.id]);
  });

  it('is the panel itself when nobody in particular asked', async () => {
    const w = await makeWorld();
    const job = w.worker.enqueue('demo', { steps: 1 });
    expect(job.origin).toBe('system');
    expect(job.createdBy).toBeNull();
  });

  it('records the schedule a job came from', async () => {
    const w = await makeWorld();
    const job = runAs({ origin: 'schedule', createdBy: 'Nightly', scheduleId: 7 }, () => w.worker.enqueue('demo', { steps: 1 }));
    expect(job).toMatchObject({ origin: 'schedule', createdBy: 'Nightly', scheduleId: 7 });
  });

  it('withoutActor leaves the context for good', () => {
    runAs({ origin: 'api', createdBy: 'API key "x"' }, () => {
      expect(currentActor()?.origin).toBe('api');
      withoutActor(() => expect(currentActor()).toBeUndefined());
    });
  });

  it("credits a handler's follow-up jobs to the panel, not to the request that started the worker", async () => {
    const w = await makeWorld();
    const registry = getRegistry();
    const original = registry.demo!;
    let followUp: number | null = null;
    // A handler that queues more work, the way system.postUpdate queues its reconciles.
    registry.demo = {
      ...original,
      handler: async () => {
        followUp = w.worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 }).id;
      },
    } as RegistryEntry;
    try {
      const queued = runAs({ origin: 'user', createdBy: 'alice' }, () => {
        const row = w.worker.enqueue('demo', { steps: 1 });
        // Started from inside the request's context - the worst case for context leaks.
        w.worker.start();
        return row;
      });
      await waitFor(() => w.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()!.status === 'succeeded', 5000);
      await w.worker.stop();
      expect(queued.origin).toBe('user');
      const child = w.db.select().from(jobs).where(eq(jobs.id, followUp!)).get()!;
      expect(child.origin).toBe('system');
      expect(child.createdBy).toBeNull();
    } finally {
      registry.demo = original;
    }
  });
});
