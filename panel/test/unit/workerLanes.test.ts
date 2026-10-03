import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../../src/db/schema.js';
import { getRegistry, type RegistryEntry } from '../../src/jobs/registry.js';
import { offsiteLane } from '../../src/services/offsite.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

/** demo jobs here sleep 50ms per step - long enough to observe scheduling order. */
function enqueueDemo(
  w: TestWorld,
  steps: number,
  lanes?: { serverId?: number; auxServerId?: number; lane?: string },
) {
  return w.deps.worker.enqueue('demo', { steps, stepMs: 50 }, undefined, lanes);
}

async function runAll(w: TestWorld, ids: number[], timeoutMs = 20_000) {
  w.worker.start();
  await waitFor(() => {
    return ids.every((id) => {
      const row = w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
      return row.status !== 'queued' && row.status !== 'running';
    });
  }, timeoutMs);
  await w.worker.stop();
  return ids.map((id) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!);
}

describe('per-server job lanes', () => {
  it('runs jobs on different servers in parallel', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    const a = enqueueDemo(w, 3, { serverId: 1 });
    const b = enqueueDemo(w, 3, { serverId: s2.id });
    const [ra, rb] = await runAll(w, [a.id, b.id]);
    expect(ra!.status).toBe('succeeded');
    expect(rb!.status).toBe('succeeded');
    // Both started before either finished => parallel execution.
    expect(rb!.startedAt!).toBeLessThan(ra!.finishedAt!);
    expect(ra!.startedAt!).toBeLessThan(rb!.finishedAt!);
  });

  it('serializes jobs on the same server lane', async () => {
    const w = await makeWorld();
    const a = enqueueDemo(w, 2, { serverId: 1 });
    const b = enqueueDemo(w, 2, { serverId: 1 });
    const [ra, rb] = await runAll(w, [a.id, b.id]);
    expect(rb!.startedAt!).toBeGreaterThanOrEqual(ra!.finishedAt!);
  });

  it('a two-lane job blocks both of its servers', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    const mover = enqueueDemo(w, 3, { serverId: 1, auxServerId: s2.id });
    const onSource = enqueueDemo(w, 1, { serverId: 1 });
    const onTarget = enqueueDemo(w, 1, { serverId: s2.id });
    const [rm, rs, rt] = await runAll(w, [mover.id, onSource.id, onTarget.id]);
    expect(rs!.startedAt!).toBeGreaterThanOrEqual(rm!.finishedAt!);
    expect(rt!.startedAt!).toBeGreaterThanOrEqual(rm!.finishedAt!);
  });

  it('lane-less jobs still serialize among themselves', async () => {
    const w = await makeWorld();
    const a = enqueueDemo(w, 2);
    const b = enqueueDemo(w, 2);
    const [ra, rb] = await runAll(w, [a.id, b.id]);
    expect(rb!.startedAt!).toBeGreaterThanOrEqual(ra!.finishedAt!);
  });

  it('a busy lane does not block other lanes from claiming newer jobs', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    const slow = enqueueDemo(w, 4, { serverId: 1 });
    const blocked = enqueueDemo(w, 1, { serverId: 1 }); // must wait for slow
    const free = enqueueDemo(w, 1, { serverId: s2.id }); // newer, other lane - should not wait
    const [rs, rb, rf] = await runAll(w, [slow.id, blocked.id, free.id]);
    expect(rf!.finishedAt!).toBeLessThan(rs!.finishedAt!);
    expect(rb!.startedAt!).toBeGreaterThanOrEqual(rs!.finishedAt!);
  });

  it('runs a named lane in parallel with the same server\'s lane', async () => {
    const w = await makeWorld();
    // An offsite upload can take hours. Holding server 1's lane for that would mean no site
    // on it could be restarted until the bucket had caught up.
    const upload = enqueueDemo(w, 4, { lane: offsiteLane(1) });
    const siteWork = enqueueDemo(w, 1, { serverId: 1 });
    const [ru, rs] = await runAll(w, [upload.id, siteWork.id]);
    expect(rs!.finishedAt!).toBeLessThan(ru!.finishedAt!);
    expect(rs!.startedAt!).toBeLessThan(ru!.finishedAt!);
  });

  it('serializes two uploads on one server, but not across servers', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    const a = enqueueDemo(w, 2, { lane: offsiteLane(1) });
    const b = enqueueDemo(w, 2, { lane: offsiteLane(1) });
    const other = enqueueDemo(w, 1, { lane: offsiteLane(s2.id) });
    const [ra, rb, ro] = await runAll(w, [a.id, b.id, other.id]);
    expect(rb!.startedAt!).toBeGreaterThanOrEqual(ra!.finishedAt!);
    expect(ro!.finishedAt!).toBeLessThan(rb!.finishedAt!);
  });

  it('a named lane does not block the lane-less queue', async () => {
    const w = await makeWorld();
    const upload = enqueueDemo(w, 4, { lane: offsiteLane(1) });
    const laneless = enqueueDemo(w, 1);
    const [ru, rl] = await runAll(w, [upload.id, laneless.id]);
    expect(rl!.finishedAt!).toBeLessThan(ru!.finishedAt!);
  });

  it('keeps the server lane reserved while a timed-out handler is still unwinding', async () => {
    const registry = getRegistry();
    const original = registry.demo!;
    let finishZombie!: () => void;
    const zombieDone = new Promise<void>((resolve) => (finishZombie = resolve));
    // steps === 1 -> a handler that ignores its 100ms timeout and keeps running.
    registry.demo = {
      payloadSchema: original.payloadSchema,
      timeoutMs: 100,
      handler: async (ctx: { payload: { steps: number } }) => {
        if (ctx.payload.steps === 1) await zombieDone;
      },
    } as unknown as RegistryEntry;

    try {
      const w = await makeWorld();
      const zombie = enqueueDemo(w, 1, { serverId: 1 });
      const next = enqueueDemo(w, 2, { serverId: 1 });
      const row = (id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;

      w.worker.start();
      await waitFor(() => row(zombie.id).status === 'failed', 10_000);
      expect(row(zombie.id).error).toMatch(/timed out/);

      // The row says failed, but the handler is still touching server 1.
      await new Promise((r) => setTimeout(r, 400));
      expect(row(next.id).status).toBe('queued');

      finishZombie();
      await waitFor(() => row(next.id).status === 'succeeded', 10_000);
      await w.worker.stop();
    } finally {
      registry.demo = original;
    }
  });
});
