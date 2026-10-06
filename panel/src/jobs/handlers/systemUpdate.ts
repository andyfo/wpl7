// @docs panel/updating, servers/add
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { servers, systemUpdates } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import { hooksFor } from '../../updates/hooks.js';
import type { JobContext } from '../context.js';

export const systemPostUpdatePayload = z.object({
  /** update.sh's run id, so this job is tied to one particular update. */
  updateId: z.string().min(1),
  from: z.string(),
  to: z.string(),
});

export interface UpdateStep {
  key: string;
  title: string;
  outcome: 'done' | 'failed';
  detail: string;
}

/**
 * Finish the job an update started.
 *
 * `provision/update.sh` declares success when the new panel is healthy, and stops there on
 * purpose: everything after that point needs a panel, and a panel is a better place to do it
 * from than a shell script that has no job queue, no per-site rollback and nothing to write
 * a log to. So the new panel picks it up itself - per-version hooks first, then the worker
 * servers, which go last so a worker is never running a newer bundle than the panel driving
 * it.
 *
 * Nothing here rolls anything back. By the time this runs the new version *is* the running
 * one; a failure is a job with a red status and a log, and a button to try again.
 */
export async function systemPostUpdate(
  ctx: JobContext<z.infer<typeof systemPostUpdatePayload>>,
  s: CoreServices,
): Promise<void> {
  const { updateId, from, to } = ctx.payload;
  const steps: UpdateStep[] = [];
  const now = Date.now();

  s.db
    .insert(systemUpdates)
    .values({ id: updateId, fromVersion: from, toVersion: to, startedAt: now, status: 'running', steps: '[]' })
    .onConflictDoUpdate({
      target: systemUpdates.id,
      // A re-run starts the record again rather than appending to it: the steps below are
      // idempotent, so the interesting record is the most recent attempt.
      set: { startedAt: now, finishedAt: null, status: 'running', steps: '[]' },
    })
    .run();

  const record = (): void => {
    s.db.update(systemUpdates).set({ steps: JSON.stringify(steps) }).where(eq(systemUpdates.id, updateId)).run();
  };

  const finish = (status: 'done' | 'failed'): void => {
    s.db
      .update(systemUpdates)
      .set({ status, finishedAt: Date.now(), steps: JSON.stringify(steps) })
      .where(eq(systemUpdates.id, updateId))
      .run();
  };

  let failed = 0;

  const hooks = hooksFor(from, to);
  ctx.info(hooks.length === 0 ? `No per-version steps between ${from} and ${to}.` : `${hooks.length} per-version step(s) to run.`);
  for (const hook of hooks) {
    ctx.checkCanceled();
    ctx.info(`${hook.version}: ${hook.title}`);
    try {
      const detail = await hook.run({ job: ctx, services: s });
      steps.push({ key: hook.version, title: hook.title, outcome: 'done', detail });
      ctx.info(`  ${detail}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ key: hook.version, title: hook.title, outcome: 'failed', detail });
      ctx.error(`  failed: ${detail}`);
      failed++;
    }
    record();
  }

  // Workers last, and only after the hooks: the bundle they are about to be given is this
  // panel's, so the panel has to be the converged one first.
  const workers = s.db.select().from(servers).where(eq(servers.kind, 'ssh')).all();
  if (workers.length === 0) {
    ctx.info('No worker servers to update.');
  } else {
    const queued: string[] = [];
    for (const server of workers) {
      try {
        // The same payload the "Update / retry" button sends. serverProvisionPayload requires
        // all three, and a job missing them is rejected as an invalid payload the moment the
        // worker claims it - after this step has already recorded itself as done. The empty
        // acmeEmail is deliberate: it tells setup.sh to keep the address already in the
        // worker's own .env rather than being handed a blank one to validate.
        s.worker.enqueue(
          'server.provision',
          { serverId: server.id, rootUser: 'root', acmeEmail: '' },
          undefined,
          { serverId: server.id },
        );
        queued.push(server.name);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        ctx.warn(`Could not queue an update for "${server.name}": ${detail}`);
      }
    }
    steps.push({
      key: 'workers',
      title: 'Update worker servers',
      outcome: queued.length === workers.length ? 'done' : 'failed',
      detail: `${queued.length}/${workers.length} queued: ${queued.join(', ') || 'none'}`,
    });
    if (queued.length !== workers.length) failed++;
    record();
  }

  // Whatever happened above, this panel is the running one and writes have to come back.
  s.system.setMaintenance(null);
  finish(failed > 0 ? 'failed' : 'done');
  ctx.setResult({ updateId, steps: steps.length, failed });
  if (failed > 0) {
    throw new Error(`${failed} post-update step(s) failed - the update itself is applied; re-run them from Settings → Updates.`);
  }
  ctx.info(`Post-update tasks complete (${from} → ${to}).`);
}
