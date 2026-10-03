import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, sites, systemUpdates } from '../../src/db/schema.js';
import { makeTestConfig, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { hooksFor, type UpdateHook } from '../../src/updates/hooks.js';
import { releaseIdentity, serverProvisionPayload } from '../../src/jobs/handlers/servers.js';
import { PANEL_VERSION } from '../../src/lib/version.js';
import type { UpdateStateDto } from '../../shared/types.js';

function writeState(world: TestWorld, state: Partial<UpdateStateDto>): void {
  const dir = path.join(world.config.paths.panel, 'update');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      id: 'U1',
      from: '0.1.0',
      to: '0.2.0',
      channel: 'stable',
      phase: 'switched',
      rolledBack: null,
      startedAt: '2026-10-01T12:00:00Z',
      finishedAt: '2026-10-01T12:05:00Z',
      warnings: [],
      error: null,
      logTail: [],
      pid: 4242,
      ...state,
    }),
  );
}

function addSite(w: TestWorld, slug: string, serverId = 1): number {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      serverId,
      title: slug,
      domains: JSON.stringify([`${slug}.example.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: sites.id })
    .get()!.id;
}

async function runPostUpdate(w: TestWorld, hookJobId: number): Promise<string> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, hookJobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, hookJobId)).get()!.status;
}

describe('which hooks an update runs', () => {
  const hooks: UpdateHook[] = [
    { version: '0.2.0', title: 'a', run: async () => 'a' },
    { version: '0.3.0', title: 'b', run: async () => 'b' },
    { version: '0.4.0', title: 'c', run: async () => 'c' },
  ];

  it('runs everything the jump crossed, oldest first', () => {
    // Skipping a release must not skip its hooks: that is the whole reason for the window.
    expect(hooksFor('0.1.0', '0.4.0', hooks).map((h) => h.version)).toEqual(['0.2.0', '0.3.0', '0.4.0']);
    expect(hooksFor('0.2.0', '0.3.0', hooks).map((h) => h.version)).toEqual(['0.3.0']);
  });

  it('runs none of them twice', () => {
    expect(hooksFor('0.4.0', '0.4.0', hooks)).toEqual([]);
    expect(hooksFor('0.4.0', '0.5.0', hooks)).toEqual([]);
  });

  it('runs all of them when it cannot tell where the install came from', () => {
    // `dev` and a fresh install both land here. Every hook is idempotent, so running them
    // is the safe direction to be wrong in.
    expect(hooksFor('dev', '0.4.0', hooks)).toHaveLength(3);
    expect(hooksFor('', '0.3.0', hooks)).toHaveLength(2);
  });
});

describe('the post-update job', () => {
  it('queues a reconcile per site, then the workers, and records what it did', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    addSite(w, 'beta');
    const worker = w.addSshServer('worker-1');
    w.system.setMaintenance({ reason: 'Updating to 0.2.0', since: Date.now() });

    const job = w.worker.enqueue('system.postUpdate', { updateId: 'U1', from: '0.1.0', to: '0.2.0' });
    expect(await runPostUpdate(w, job.id)).toBe('succeeded');

    // By status-agnostic type: the worker is still running, so some of these have already
    // been claimed by the time the assertion looks.
    const all = w.db.select().from(jobs).all();
    expect(all.filter((j) => j.type === 'site.reconcile')).toHaveLength(2);
    // Panel first, then workers: a worker must never run a newer bundle than the panel
    // driving it, which is why this is queued here and not by update.sh.
    const provision = all.filter((j) => j.type === 'server.provision');
    expect(provision).toHaveLength(1);
    expect(provision[0]!.serverId).toBe(worker.id);
    // ...and a job the worker can actually claim. Nothing validates a payload at enqueue
    // time, so an incomplete one is only rejected when it is dispatched - long after this
    // step has recorded itself as done and the operator has been told the update finished.
    expect(() => serverProvisionPayload.parse(JSON.parse(provision[0]!.payload))).not.toThrow();

    const row = w.db.select().from(systemUpdates).where(eq(systemUpdates.id, 'U1')).get()!;
    expect(row.status).toBe('done');
    expect(row.toVersion).toBe('0.2.0');
    const steps = JSON.parse(row.steps) as { title: string; outcome: string }[];
    expect(steps.map((s) => s.outcome)).not.toContain('failed');
    expect(steps.some((s) => s.title.includes('container policy'))).toBe(true);
    expect(steps.some((s) => s.title === 'Update worker servers')).toBe(true);

    // Whatever happened, the panel has to accept writes again.
    expect(w.system.maintenance()).toBeNull();
  });

  it('fails the job without rolling anything back, and still clears maintenance', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    // The relay step talks to every server; make server 1's refuse.
    w.docker.failOn.set('exec', 'relay is on fire');
    w.system.setMaintenance({ reason: 'Updating to 0.2.0', since: Date.now() });

    const job = w.worker.enqueue('system.postUpdate', { updateId: 'U2', from: '0.1.0', to: '0.2.0' });
    expect(await runPostUpdate(w, job.id)).toBe('failed');

    const row = w.db.select().from(systemUpdates).where(eq(systemUpdates.id, 'U2')).get()!;
    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
    // By the time a hook runs, the new version is the one serving this page - there is
    // nothing to roll back to, and leaving the panel read-only would help nobody.
    expect(w.system.maintenance()).toBeNull();
  });
});

describe('noticing that an update landed', () => {
  it('queues the follow-up once, however often the panel restarts', async () => {
    const w = await makeWorld();
    writeState(w, { phase: 'switched', from: '0.1.0', to: '0.2.0' });

    const first = w.system.enqueuePostUpdate(w.worker);
    expect(first).not.toBeNull();
    expect(JSON.parse(first!.payload)).toMatchObject({ updateId: 'U1', from: '0.1.0', to: '0.2.0' });

    // Same update, restarted container: the job already ran (or is queued), so nothing new.
    w.db.insert(systemUpdates).values({
      id: 'U1',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      startedAt: Date.now(),
      status: 'done',
      steps: '[]',
    }).run();
    expect(w.system.enqueuePostUpdate(w.worker)).toBeNull();

    // ...unless the operator asks, having fixed whatever a hook complained about.
    expect(w.system.enqueuePostUpdate(w.worker, { force: true })).not.toBeNull();
  });

  it('stays quiet when the last update failed or never happened', async () => {
    const w = await makeWorld();
    expect(w.system.enqueuePostUpdate(w.worker)).toBeNull(); // no state file at all

    writeState(w, { phase: 'failed', rolledBack: true });
    expect(w.system.enqueuePostUpdate(w.worker)).toBeNull();

    // A rollback leaves `from` and `to` equal in practice; a no-op update has nothing to do.
    writeState(w, { phase: 'switched', from: '0.2.0', to: '0.2.0' });
    expect(w.system.enqueuePostUpdate(w.worker)).toBeNull();
  });

  it('waits for update.sh to record an outcome instead of asking during its health gate', async () => {
    const w = await makeWorld();
    w.system.setMaintenance({ reason: 'Updating to 0.2.0', since: Date.now() });
    // The state every new panel boots into: update.sh is blocked on the health check that
    // THIS process is about to answer, so it has not written `switched` yet.
    writeState(w, { phase: 'healthcheck', from: '0.1.0', to: '0.2.0' });
    w.host.fallback = { stdout: '', stderr: '', exitCode: 0 }; // is-active: yes

    const reconciled = w.system.reconcileHostUpdate(w.worker, { pollMs: 5, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 40));
    // Asking now - which is what boot used to do - answers "no update has landed" on the one
    // boot where one definitely has, and leaves the panel read-only with nothing to lift it.
    expect(w.db.select().from(jobs).all()).toHaveLength(0);
    expect(w.system.maintenance()).not.toBeNull();

    writeState(w, { phase: 'switched', from: '0.1.0', to: '0.2.0' });
    await reconciled;

    expect(w.db.select().from(jobs).all().map((j) => j.type)).toEqual(['system.postUpdate']);
    expect(w.system.maintenance()).toBeNull();
  });

  it('lifts the read-only flag for the panel a rollback brought back', async () => {
    const w = await makeWorld();
    w.system.setMaintenance({ reason: 'Updating to 0.2.0', since: Date.now() });
    writeState(w, { phase: 'healthcheck', from: '0.1.0', to: '0.2.0' });
    w.host.fallback = { stdout: '', stderr: '', exitCode: 0 };

    const reconciled = w.system.reconcileHostUpdate(w.worker, { pollMs: 5, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    writeState(w, { phase: 'failed', rolledBack: true, error: 'migration threw' });
    await reconciled;

    // This is the OLD panel, running the version that worked. There is nothing to follow up
    // on - but somebody still has to let the operator write again.
    expect(w.db.select().from(jobs).all()).toHaveLength(0);
    expect(w.system.maintenance()).toBeNull();
  });

  it('watches an update that systemd never knew about', async () => {
    const w = await makeWorld();
    writeState(w, { phase: 'healthcheck', from: '0.1.0', to: '0.2.0', pid: 4242 });
    w.host.fallback = { stdout: '', stderr: '', exitCode: 0 };

    const reconciled = w.system.reconcileHostUpdate(w.worker, { pollMs: 5, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 40));

    // Only the Update button creates a wpl7-update unit. `provision/update.sh` run by hand -
    // and deploy.sh's image-mode handoff, which is how every edge build lands - is just a
    // process, so asking systemd alone calls it finished the instant it starts, and the
    // hooks and worker updates the new panel owes it are never queued.
    expect(w.host.commands.at(-1)).toContain('systemctl is-active --quiet wpl7-update');
    expect(w.host.commands.at(-1)).toContain('kill -0 4242');
    expect(w.db.select().from(jobs).all()).toHaveLength(0);

    writeState(w, { phase: 'switched', from: '0.1.0', to: '0.2.0', pid: 4242 });
    await reconciled;

    expect(w.db.select().from(jobs).all().map((j) => j.type)).toEqual(['system.postUpdate']);
  });

  it('asks about the unit alone when the state file records no pid', async () => {
    const w = await makeWorld();
    writeState(w, { phase: 'healthcheck', from: '0.1.0', to: '0.2.0', pid: null });
    w.host.fallback = { stdout: '', stderr: '', exitCode: 1 }; // nothing is running

    await w.system.reconcileHostUpdate(w.worker, { pollMs: 5, timeoutMs: 5_000 });

    // `kill -0 0` signals the whole process group; never send it a pid the file does not have.
    expect(w.host.commands.at(-1)).not.toContain('kill -0');
  });

  it('costs an ordinary restart nothing', async () => {
    const w = await makeWorld();
    await w.system.reconcileHostUpdate(w.worker, { pollMs: 5, timeoutMs: 5_000 });
    // No state file, so no update has ever run here: no waiting, and not a single round trip
    // to the host to find that out.
    expect(w.host.commands).toEqual([]);
    expect(w.db.select().from(jobs).all()).toHaveLength(0);
  });
});

describe('the release a worker server is given', () => {
  it('is the panel\'s own, because the worker has no other way to know', () => {
    const identity = releaseIdentity(makeTestConfig({ WPL7_CHANNEL: 'stable', WPL7_IMAGE_TAG: '0.3.0' }));
    expect(identity.split('\n')).toContain('WPL7_SOURCE=image');
    expect(identity.split('\n')).toContain(`WPL7_VERSION=${PANEL_VERSION}`);
    expect(identity.split('\n')).toContain('WPL7_IMAGE_TAG=0.3.0');
    // setup.sh refuses image mode without a version, so an empty one is the whole bug.
    expect(identity).not.toMatch(/WPL7_VERSION=\s*$/m);
  });

  it('names the moving tag on edge, where the tag is not the version', () => {
    // An edge build calls itself 0.3.0-edge.<commit> but is published as `edge`. Handing a
    // worker the version would have it pull an image tag that was never created.
    const identity = releaseIdentity(makeTestConfig({ WPL7_CHANNEL: 'edge' }));
    expect(identity.split('\n')).toContain('WPL7_IMAGE_TAG=edge');
    expect(identity.split('\n')).toContain('WPL7_CHANNEL=edge');
  });

  it('leaves the registry to setup.sh unless this install overrides it', () => {
    // A blank value would have the worker pull `<registry>/wordpress:php8.3-` on every run.
    expect(releaseIdentity(makeTestConfig())).not.toContain('WPL7_WORDPRESS_IMAGE');
    expect(releaseIdentity(makeTestConfig({ WPL7_WORDPRESS_IMAGE: 'ghcr.io/fork/wordpress' }))).toContain(
      'WPL7_WORDPRESS_IMAGE=ghcr.io/fork/wordpress',
    );
  });

  it('gives a panel compiled on the box workers that compile too', () => {
    // There is no published image to hand anyone; the worker builds its site images from
    // the Dockerfile in the bundle, exactly as it did before image mode existed. The version
    // rides along because a worker cannot derive one - its bundle has no panel/package.json -
    // and "which panel build pushed this" is otherwise unanswerable on the machine.
    const identity = releaseIdentity(makeTestConfig({ WPL7_SOURCE: 'build' }));
    expect(identity.trim().split('\n')).toEqual(['WPL7_SOURCE=build', `WPL7_VERSION=${PANEL_VERSION}`]);
  });
});
