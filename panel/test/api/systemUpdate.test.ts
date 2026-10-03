import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';
import type { UpdateStateDto, UpdateStatusDto } from '../../shared/types.js';

const RELEASE = {
  version: '0.3.0',
  channel: 'stable',
  publishedAt: '2026-10-01T12:00:00Z',
  notesUrl: 'https://example.test/v0.3.0',
  gitSha: 'a'.repeat(40),
  images: { panel: 'ghcr.io/x/y/panel:0.3.0', wordpress: { '8.3': 'ghcr.io/x/y/wordpress:php8.3-0.3.0' } },
  minUpgradeFrom: '0.2.0',
  requiresDowntime: false,
};

async function ready(world?: TestWorld, release: Record<string, unknown> = RELEASE) {
  const w = world ?? (await makeWorld());
  w.github.release(release);
  await w.core.updates.check();
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world: w, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function writeState(world: TestWorld, state: Partial<UpdateStateDto>): void {
  const dir = path.join(world.config.paths.panel, 'update');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      id: '20261001T120000Z',
      from: '0.2.0',
      to: '0.3.0',
      channel: 'stable',
      phase: 'switched',
      rolledBack: null,
      startedAt: '2026-10-01T12:00:00Z',
      finishedAt: null,
      warnings: [],
      error: null,
      logTail: [],
      pid: 4242,
      ...state,
    }),
  );
}

describe('starting an update', () => {
  it('hands it to systemd as the checkout owner and reports 202', async () => {
    const { app, world, headers } = await ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers,
      payload: { version: '0.3.0' },
    });

    expect(res.statusCode).toBe(202);
    const command = world.host.commands.at(-1)!;
    // The unit name is the lock systemd enforces; --collect frees it so a failure can be
    // retried; the uid is the checkout owner because update.sh expects to be that user.
    expect(command).toContain('systemd-run --unit=wpl7-update --collect');
    expect(command).toContain('owner=$(stat -c %U "$dir")');
    expect(command).toContain('--uid="$owner"');
    expect(command).toContain('"$dir/provision/update.sh" --to=0.3.0');
    // Set before the command went out: this process may not exist by the time it would
    // otherwise have got around to it.
    expect(world.system.maintenance()).toMatchObject({ reason: 'Updating to 0.3.0' });
  });

  it('asks for the release tag, not the version, on edge', async () => {
    // Every edge build is published as one moving release tagged `edge` while calling itself
    // 0.3.0-edge.<commit>. Passing the version through would have update.sh look up
    // releases/tags/v0.3.0-edge.<commit>, which has never existed.
    const world = await makeWorld({ env: { WPL7_CHANNEL: 'edge' } });
    const { app, headers } = await ready(world, {
      ...RELEASE,
      version: '0.3.0-edge.abcdef0',
      channel: 'edge',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers,
      payload: { version: '0.3.0-edge.abcdef0' },
    });

    expect(res.statusCode).toBe(202);
    expect(world.host.commands.at(-1)).toContain('"$dir/provision/update.sh" --to=edge');
    // Still the version the operator was offered, everywhere it is a version.
    expect(world.system.maintenance()).toMatchObject({ reason: 'Updating to 0.3.0-edge.abcdef0' });
  });

  it('only accepts the version it has actually resolved a manifest for', async () => {
    const { app, world, headers } = await ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers,
      payload: { version: '9.9.9; rm -rf /' },
    });

    expect(res.statusCode).toBe(400);
    // Refused before it could become an argument to a root-launched script - and the
    // quoting below it would have contained it anyway.
    expect(world.host.commands).toHaveLength(0);
    expect(world.system.maintenance()).toBeNull();
  });

  it('refuses while jobs are still queued or running', async () => {
    const { app, world, headers } = await ready();
    const now = Date.now();
    world.db.insert(jobs).values({ type: 'site.reconcile', status: 'running', payload: '{}', createdAt: now }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers,
      payload: { version: '0.3.0' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message).toContain('site.reconcile');
    expect(world.system.maintenance()).toBeNull();
  });

  it('does not leave the panel read-only when the host cannot be reached', async () => {
    const { app, world, headers } = await ready();
    world.host.failWith = new Error('connect ECONNREFUSED');

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers,
      payload: { version: '0.3.0' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // Nothing is running, so refusing writes would only lock the operator out of the panel
    // they need in order to fix it.
    expect(world.system.maintenance()).toBeNull();
  });
});

describe('maintenance mode', () => {
  it('refuses writes but keeps the panel readable', async () => {
    const { app, world, headers } = await ready();
    world.system.setMaintenance({ reason: 'Updating to 0.3.0', since: Date.now() });

    const write = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'k' } });
    expect(write.statusCode).toBe(503);
    expect((write.json() as { error: { code: string } }).error.code).toBe('maintenance');

    // Reading is how an operator finds out what is going on.
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/system/update/status', headers })).statusCode).toBe(200);
    // ...and the update page's own controls keep working, so a stuck update can be retried.
    expect((await app.inject({ method: 'POST', url: '/api/system/update/check', headers })).statusCode).toBe(200);
  });

  it('shows up in /api/meta so every page can say so', async () => {
    const { app, world, headers } = await ready();
    world.system.setMaintenance({ reason: 'Updating to 0.3.0', since: 1000 });

    const meta = (await app.inject({ method: 'GET', url: '/api/meta', headers })).json() as {
      maintenance: { reason: string } | null;
    };
    expect(meta.maintenance).toMatchObject({ reason: 'Updating to 0.3.0' });
  });

  it('stops the worker claiming new jobs', async () => {
    const world = await makeWorld();
    world.system.setMaintenance({ reason: 'Updating to 0.3.0', since: Date.now() });
    const now = Date.now();
    world.db.insert(jobs).values({ type: 'site.reconcile', status: 'queued', payload: '{"siteId":1}', createdAt: now }).run();

    world.worker.start();
    await new Promise((r) => setTimeout(r, 120));
    await world.worker.stop();

    // Still queued: a job started here would be killed part-way through the panel's own
    // container recreate.
    expect(world.db.select().from(jobs).all()[0]!.status).toBe('queued');
  });

  it('is cleared at boot when nothing is running', async () => {
    const world = await makeWorld();
    world.system.setMaintenance({ reason: 'Updating to 0.3.0', since: Date.now() });
    writeState(world, { phase: 'failed', rolledBack: true, error: 'migration threw' });

    await world.system.clearStaleMaintenance();

    // This panel is the one a rollback brought back. Nothing else will ever clear the flag.
    expect(world.system.maintenance()).toBeNull();
  });

  it('is kept at boot while systemd still has the unit', async () => {
    const world = await makeWorld();
    world.system.setMaintenance({ reason: 'Updating to 0.3.0', since: Date.now() });
    writeState(world, { phase: 'healthcheck' });
    world.host.fallback = { stdout: '', stderr: '', exitCode: 0 }; // is-active: yes

    await world.system.clearStaleMaintenance();

    expect(world.system.maintenance()).not.toBeNull();
    expect(world.host.commands.at(-1)).toContain('systemctl is-active --quiet wpl7-update');
  });
});

describe('the status endpoint', () => {
  it('serves what update.sh wrote, plus the log it is writing', async () => {
    const world = await makeWorld();
    writeState(world, { phase: 'failed', rolledBack: true, error: 'health gate timed out', warnings: ['low disk'] });
    fs.writeFileSync(path.join(world.config.paths.panel, 'update', 'current.log'), 'one\ntwo\nthree\n');
    const { app, headers } = await ready(world);

    const status = (await app.inject({ method: 'GET', url: '/api/system/update/status', headers })).json() as UpdateStatusDto;

    expect(status.state).toMatchObject({ phase: 'failed', rolledBack: true, error: 'health gate timed out' });
    expect(status.state?.warnings).toEqual(['low disk']);
    expect(status.log).toEqual(['one', 'two', 'three']);
    // A finished update is not a running one, whatever systemd would say.
    expect(status.running).toBe(false);
  });

  it('says nothing has ever run here rather than inventing a state', async () => {
    const { app, headers } = await ready();
    const status = (await app.inject({ method: 'GET', url: '/api/system/update/status', headers })).json() as UpdateStatusDto;
    expect(status.state).toBeNull();
    expect(status.log).toEqual([]);
    expect(status.running).toBe(false);
  });
});
