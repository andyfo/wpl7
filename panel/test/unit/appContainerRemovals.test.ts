/**
 * How a container goes: a container app's with its anonymous volumes, whichever job removes it
 * (an image's VOLUME the app keeps no folder for gets a new one with every container), and a
 * WordPress site's as it always did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appSettings, jobs, sites } from '../../src/db/schema.js';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

/** Image n, with a VOLUME in /usr: no folder of the app's can keep it. */
function push(w: TestWorld, n: number): void {
  w.docker.publish(REF, digest(n), { imageId: `sha256:img${n}`, config: { exposedPorts: ['8000/tcp'], volumes: ['/usr/share/shop/cache'] } });
}

/** A backup needs tar; a chown would fail for any user but the one the tests run as. */
async function world(): Promise<TestWorld> {
  const exec: ExecPort = { ...hostExec, run: async (cmd, args, o) => (cmd === 'chown' ? { stdout: '', stderr: '', exitCode: 0 } : hostExec.run(cmd, args, o)) };
  const w = await makeWorld({ exec });
  w.deps.settings.set('backupBeforeUpdates', 'never');
  w.docker.containers.set(TRAEFIK_CONTAINER, 'running');
  push(w, 1);
  return w;
}

async function finish(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

/** The containers removed from the `from`th Docker call on, each with whether its anonymous volumes went too. */
const removals = (w: TestWorld, from: number): [string, boolean][] =>
  w.docker.calls
    .slice(from)
    .filter((c) => c.method === 'removeContainer')
    .map((c) => [c.args[0] as string, (c.args[1] as { volumes?: boolean } | undefined)?.volumes === true]);

describe('a container app’s containers', () => {
  it('go with their anonymous volumes, whatever removes them', async () => {
    const w = await world();
    /** Run a job, and say what it removed. */
    const step = async (queue: () => { id: number } | Promise<{ id: number }>, status: string): Promise<[string, boolean][]> => {
      const from = w.docker.calls.length;
      const done = await finish(w, (await queue()).id);
      expect(done.status, done.error ?? '').toBe(status);
      return removals(w, from);
    };
    const both: [string, boolean][] = [
      ['wp-shop.previous', true],
      ['wp-shop', true],
    ];
    const body = siteCreateBody.parse({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF } });
    const failing = (siteId: number) => {
      w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, siteId)).run();
      w.docker.appHttp = () => 500;
    };

    // A create that does not pass its gate is undone.
    const first = w.deps.sites.create(body);
    failing(first.site.id);
    expect(await step(() => first.job, 'failed')).toEqual(both);
    w.docker.appHttp = null;
    const made = w.deps.sites.create(body);
    expect(await step(() => made.job, 'succeeded')).toEqual([]);
    const site = w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    const deploy = () => w.deps.apps.deploy('shop', {});
    const reconcile = () => w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });

    // A deploy drops the old container; one that does not pass, its new one.
    push(w, 2);
    expect(await step(deploy, 'succeeded')).toEqual([['wp-shop.previous', true]]);
    failing(site.id);
    push(w, 3);
    expect(await step(deploy, 'failed')).toEqual([['wp-shop', true]]);

    // A recreate with no old container to go back to removes the new one that did not pass.
    w.docker.containers.delete('wp-shop');
    expect(await step(reconcile, 'failed')).toEqual([['wp-shop', true]]);
    w.docker.appHttp = null;
    expect(await step(reconcile, 'succeeded')).toEqual([]);

    // An old container that a panel stopped half-way left aside comes back first, in place of whatever has its name.
    await w.docker.renameContainer('wp-shop', 'wp-shop.previous');
    w.docker.containers.set('wp-shop', 'created');
    expect(await step(reconcile, 'succeeded')).toEqual([
      ['wp-shop', true],
      ['wp-shop.previous', true],
    ]);

    // A restore onto the image its backup was taken with.
    const backup = await w.core.backup.create(site, 'manual');
    expect(backup.status).toBe('complete');
    push(w, 4);
    expect(await step(deploy, 'succeeded')).toEqual([['wp-shop.previous', true]]);
    const restore = () => w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, { id: site.id, slug: 'shop', serverId: 1 });
    expect(await step(restore, 'succeeded')).toEqual(both);

    // And the delete.
    expect(await step(() => w.deps.sites.delete('shop', false), 'succeeded')).toEqual(both);
  });
});

describe('a WordPress site’s containers', () => {
  it('go as they always did', async () => {
    const w = await makeWorld();
    // The site image's entrypoint: core files once the container starts.
    w.docker.onStart = (name) => {
      const p = sitePaths(w.config, name.slice('wp-'.length));
      fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
      fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
      fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
    };
    const { site, job } = w.deps.sites.create({
      title: 'Demo Site',
      domainMode: 'dev',
      adminUser: 'boss',
      adminEmail: 'boss@example.com',
      plugins: { catalogIds: [], extraWporgSlugs: [] },
    } as Parameters<TestWorld['deps']['sites']['create']>[0]);
    // Its create, a recreate (Recreate container), its delete: what each removed, as it was asked to.
    const removed: unknown[][][] = [];
    for (const queue of [() => job, () => w.deps.sites.reconcile(site.slug), () => w.deps.sites.delete(site.slug, false)]) {
      const from = w.docker.calls.length;
      const done = await finish(w, queue().id);
      expect(done.status, done.error ?? '').toBe('succeeded');
      removed.push(w.docker.calls.slice(from).filter((c) => c.method === 'removeContainer').map((c) => c.args));
    }
    // By name alone: not one asked for anything more.
    expect(removed.slice(1)).toEqual([[['wp-demo-site.previous']], [['wp-demo-site.previous'], ['wp-demo-site']]]);
    expect(removed[0]!.filter((args) => args.length > 1)).toEqual([]);
  });
});
