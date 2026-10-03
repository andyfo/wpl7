import type { JobContext } from '../jobs/context.js';
import type { CoreServices } from '../services/index.js';
import { asc } from 'drizzle-orm';
import { sites } from '../db/schema.js';
import { compareVersions } from '../services/updates.js';
import { sweepHardening } from '../services/siteHardening.js';

/**
 * Per-version work that only the new panel can do.
 *
 * `provision/update.sh` finishes when the new panel is healthy. Some of what a release needs
 * happens after that and cannot happen in a shell script: recreating every site container
 * under a changed policy is one job per site, in its server's lane, each with its own
 * rollback. Those are the things that used to be a paragraph in the docs beginning "after
 * upgrading, run…" - which is a step every operator either misses or does at the wrong
 * moment.
 *
 * Rules:
 *   - a hook runs when `from < version <= to`, so a jump across three releases runs all
 *     three in order and a re-run of the same update runs none of them twice;
 *   - every hook is idempotent, because the "Re-run post-update tasks" button exists and
 *     because a panel can be restarted mid-job;
 *   - a hook that fails fails the job, with a log. It never rolls anything back: by the time
 *     one runs, the new version is the running one and update.sh has already declared
 *     success.
 */
export interface UpdateHook {
  /** The release this belongs to; it runs for any update that crosses it. */
  version: string;
  /** Shown in the job log and recorded in the system_updates row. */
  title: string;
  run(ctx: HookContext): Promise<string>;
}

export interface HookContext {
  job: JobContext<unknown>;
  services: CoreServices;
}

/**
 * 0.2.0 is the rename release. Its first two hooks are the two "after upgrading, run this"
 * paragraphs that existed before it: recreating site containers under the current policy,
 * and republishing the relay's credentials and the DKIM material. The third gives every
 * site container the read-only mounts its protection lives in (services/siteHardening.ts).
 *
 * All are no-ops on an install that is already converged, which is what makes them safe to
 * run on every update that crosses 0.2.0 and safe to re-run by hand.
 */
export const HOOKS: UpdateHook[] = [
  {
    version: '0.2.0',
    title: 'Re-apply the container policy to every site',
    async run({ job, services }) {
      const rows = services.db.select().from(sites).orderBy(asc(sites.id)).all();
      const queued: string[] = [];
      const busy: string[] = [];
      for (const site of rows) {
        if (site.status === 'provisioning' || site.status === 'deleting') {
          busy.push(site.slug);
          continue;
        }
        try {
          services.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
          queued.push(site.slug);
        } catch {
          // Another job holds the site's lane. Re-run the task later, or use the site's own
          // "Re-apply security policy" - either way it is one click, not a lost site.
          busy.push(site.slug);
        }
      }
      if (busy.length > 0) job.warn(`Skipped (busy): ${busy.join(', ')}`);
      // One job per site, each in its server's lane with its own rollback; this hook only
      // queues them, so the update page is not blocked behind a fleet-wide recreate.
      return `${queued.length} site(s) queued for reconcile${busy.length ? `, ${busy.length} skipped` : ''}`;
    },
  },
  {
    version: '0.2.0',
    title: 'Republish the relay credentials and DKIM material',
    async run({ job, services }) {
      const results = await services.mail.syncMailAuthEverywhere();
      const failed = results.filter((r) => !r.ok);
      for (const server of failed) {
        job.warn(`Relay auth not published on "${server.name}": ${server.detail}`);
      }
      // Loudly, not quietly: a server whose credentials were not republished is a server
      // whose sites cannot send, and the operator has to be told rather than left to
      // discover it from a customer.
      if (failed.length > 0) {
        throw new Error(`Relay auth not published on: ${failed.map((f) => f.name).join(', ')}`);
      }
      return `${results.length}/${results.length} server(s) converged`;
    },
  },
  {
    version: '0.2.0',
    title: 'Rebuild site containers with the protection mounts',
    async run({ job, services }) {
      // By the container's own label, so a container is rebuilt once however many times this
      // runs. The boot sweep does the same (services/siteHardening.ts): an install that builds
      // from its own checkout gets no hooks, and one that does must not see the two collide.
      const { queued, busy } = await sweepHardening(services, services.worker);
      if (busy.length > 0) job.warn(`Busy, rebuilt within the hour instead: ${busy.join(', ')}`);
      return `${queued.length} site(s) queued for reconcile${busy.length ? `, ${busy.length} busy` : ''}`;
    },
  },
];

/**
 * Hooks an update from `from` to `to` has to run, oldest first.
 *
 * A missing or unparseable `from` (a first install, or a hand-built panel) means every hook
 * up to `to` - they are idempotent, and running them all is the safe direction to be wrong in.
 */
export function hooksFor(from: string, to: string, hooks: UpdateHook[] = HOOKS): UpdateHook[] {
  return hooks
    .filter((h) => compareVersions(h.version, to) <= 0 && compareVersions(from, h.version) < 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}
