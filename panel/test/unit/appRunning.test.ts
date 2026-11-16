/**
 * A container app while it runs: its log, a command in it, a restart, its uptime asked through the
 * way in, the emails it sends when a deploy fails or an update waits, and a new database password.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteCreateBody } from '../../shared/schemas.js';
import { appDeploys, appSettings, jobLogs, jobs, sites } from '../../src/db/schema.js';
import { appRoutesFileName } from '../../src/services/appRoutes.js';
import { appLogLines } from '../../src/services/appSpec.js';
import type { EphemeralOpts } from '../../src/services/docker.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const REF = 'ghcr.io/example/shop:stable';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

function push(w: TestWorld, n: number): void {
  w.docker.publish(REF, digest(n), { imageId: `sha256:img${n}`, config: { exposedPorts: ['8000/tcp'] } });
}

async function world(): Promise<TestWorld> {
  const w = await makeWorld();
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

async function createShop(w: TestWorld, extra: Record<string, unknown> = {}) {
  const { job } = w.deps.sites.create(
    siteCreateBody.parse({ title: 'Shop', slug: 'shop', app: 'container', image: { reference: REF }, health: { path: '/healthz' }, ...extra }),
  );
  const done = await finish(w, job.id);
  expect(done.status, done.error ?? '').toBe('succeeded');
  return w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
}

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function mailbox(w: TestWorld): { subject: string; body: string }[] {
  const sent: { subject: string; body: string }[] = [];
  w.core.settings.set('alertEmail', 'ops@example.com');
  w.core.mail.notifyOperator = async (subject, body) => {
    sent.push({ subject, body });
    return true;
  };
  return sent;
}

describe('a container app’s log', () => {
  it('comes in the order it was logged, stdout and stderr together, and from a point on', () => {
    const raw =
      '2026-11-14T20:00:00.1Z out one\n2026-11-14T20:00:02Z out three\n' + // stdout
      '2026-11-14T20:00:01.000000005Z err two\n2026-11-14T20:00:03.5Z err four\n'; // stderr
    expect(appLogLines(raw).map((l) => l.text)).toEqual(['out one', 'err two', 'out three', 'err four']);
    expect(appLogLines(raw, '2026-11-14T20:00:02Z').map((l) => l.text)).toEqual(['err four']);
  });

  it('is read at Manage, with timestamps, from what is new only', async () => {
    const w = await world();
    await createShop(w);
    w.docker.logs.set('wp-shop', '2026-11-14T20:00:00Z listening on 8000\n2026-11-14T20:00:05Z GET /healthz 200\n');
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'GET', url: '/api/sites/shop/app/logs?tail=100&since=2026-11-14T20:00:00Z', headers });
    expect(res.json()).toEqual({ lines: [{ ts: '2026-11-14T20:00:05Z', text: 'GET /healthz 200' }] });
    const call = w.docker.calls.filter((c) => c.method === 'containerLogs').at(-1)!;
    expect(call.args).toEqual(['wp-shop', { tail: 100, timestamps: true, sinceSec: Date.parse('2026-11-14T20:00:00Z') / 1000 }]);
    const read = w.deps.apiKeys.create('read', 'read');
    const asRead = await app.inject({ method: 'GET', url: '/api/sites/shop/app/logs', headers: { authorization: `Bearer ${read.token}` } });
    expect(asRead.statusCode).toBe(403);
  });
});

describe('a command in a container app', () => {
  it('runs as the user the app runs as, after the image says it has a shell', async () => {
    const w = await world();
    const site = await createShop(w, { hardening: { runAs: '1000:1000' } });
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'POST', url: '/api/sites/shop/shell', headers, payload: { command: 'ls /data' } });
    expect(res.statusCode).toBe(202);
    const done = await finish(w, res.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const execs = w.docker.calls.filter((c) => c.method === 'exec' && c.args[0] === 'wp-shop').map((c) => [c.args[1], (c.args[2] as { user?: string; workdir?: string })]);
    expect(execs[0]![0]).toEqual(['sh', '-c', 'command -v timeout >/dev/null']);
    expect(execs.at(-1)![0]).toEqual(['sh', '-c', 'ls /data']);
    expect(execs.at(-1)![1]).toMatchObject({ user: '1000:1000', env: ['HOME=/tmp'] });
    expect(execs.at(-1)![1].workdir).toBeUndefined();
    void site;
  });

  it('is refused for an image with no shell, before anything is queued', async () => {
    const w = await world();
    await createShop(w);
    const { app, headers } = await authed(w);
    w.docker.execQueue.push({ stdout: '', stderr: 'OCI runtime exec failed: exec: "timeout": executable file not found in $PATH', exitCode: 127 });
    const res = await app.inject({ method: 'POST', url: '/api/sites/shop/shell', headers, payload: { command: 'ls' } });
    expect([res.statusCode, res.json().error.message]).toEqual([409, "This app's image has no shell (sh and timeout) to run a command with."]);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.shell')).all()).toEqual([]);
  });
});

describe('a container app’s restart', () => {
  it('brings a stopped app’s routes back with it, as a start does', async () => {
    const w = await world();
    const site = await createShop(w);
    expect(site.status).toBe('running');
    const routes = path.join(w.config.srvRoot, 'traefik', 'dynamic', appRoutesFileName('shop'));
    expect((await finish(w, w.deps.sites.action('shop', 'stop').id)).status).toBe('succeeded');
    await w.deps.appRoutes.idle();
    expect(fs.existsSync(routes)).toBe(false);
    const done = await finish(w, w.deps.sites.action('shop', 'restart').id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    await w.deps.appRoutes.idle();
    expect(fs.readFileSync(routes, 'utf8')).toContain('url: "http://wp-shop:8000"');
  });
});

describe('a container app’s uptime', () => {
  it('is its health path, asked on its own network: up below 400, down without an answer', async () => {
    const w = await world();
    const site = await createShop(w);
    const asked: EphemeralOpts[] = [];
    let status: number | null = 200;
    w.docker.appHttp = (req) => {
      asked.push({ cmd: [req.path, req.host] } as unknown as EphemeralOpts);
      return status;
    };
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: true, httpStatus: 200 });
    expect(asked.at(-1)!.cmd).toEqual(['/healthz', 'shop.dev.example.test']);
    status = 503;
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: false, httpStatus: 503 });
    status = null;
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: false, httpStatus: null });
  });
});

describe('a container app’s emails', () => {
  it('says once that a deploy failed and the app goes on with its image, and tries that image no more by itself', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    push(w, 2);
    w.docker.appHttp = () => 500;
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 1 });
    const first = w.db.select().from(jobs).where(eq(jobs.type, 'app.deploy')).get()!;
    expect((await finish(w, first.id)).status).toBe('failed');
    expect(sent.map((m) => m.subject)).toEqual(['The deploy of Shop failed']);
    expect(sent[0]!.body).toContain(`ghcr.io/example/shop@${digest(2)}`);
    expect(sent[0]!.body).toContain('The app goes on with the image it ran before.');
    // The broken image is not deployed again at every check; a new push is.
    w.db.update(appSettings).set({ checkedAt: null }).where(eq(appSettings.siteId, site.id)).run();
    expect(await w.deps.apps.updatesTick()).toEqual({ checked: 1, queued: 0 });
    // Deploy now tries it again, and its failure sends no second email.
    expect((await finish(w, (await w.deps.apps.deploy('shop', {})).id)).status).toBe('failed');
    expect(sent).toHaveLength(1);
    expect(w.db.select().from(appDeploys).where(eq(appDeploys.siteId, site.id)).all().map((d) => d.result)).toEqual(['ok', 'failed', 'failed']);
  });

  it('says once that an update waits, for an app that asks first', async () => {
    const w = await world();
    const sent = mailbox(w);
    const site = await createShop(w, { updates: { mode: 'ask' } });
    push(w, 2);
    w.db.update(appSettings).set({ checkedAt: null }).where(eq(appSettings.siteId, site.id)).run();
    await w.deps.apps.updatesTick();
    w.db.update(appSettings).set({ checkedAt: null }).where(eq(appSettings.siteId, site.id)).run();
    await w.deps.apps.updatesTick();
    expect(sent.map((m) => m.subject)).toEqual(['A new image of Shop is waiting']);
    expect(sent[0]!.body).toContain(`${REF} names a new image, ${digest(2).slice(0, 19)}…`);
  });

  it('sends nothing about a failed deploy when its switch is off', async () => {
    const w = await world();
    const sent = mailbox(w);
    w.core.settings.set('alertsDeployFailed', false);
    const site = await createShop(w);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    push(w, 2);
    w.docker.appHttp = () => 500;
    expect((await finish(w, (await w.deps.apps.deploy('shop', {})).id)).status).toBe('failed');
    expect(sent).toEqual([]);
  });
});

describe('a container app’s database password', () => {
  const withDb = { database: true, env: [{ name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}/{{db.name}}' }] };

  it('goes into a new container, behind the health check', async () => {
    const w = await world();
    const site = await createShop(w, withDb);
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'POST', url: '/api/sites/shop/database-password', headers });
    expect(res.statusCode).toBe(202);
    const done = await finish(w, res.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const now = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(now.dbPassword).not.toBe(site.dbPassword);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'setUserPassword').map((c) => c.args)).toEqual([['wp_shop', now.dbPassword]]);
    const spec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { env: Record<string, string> };
    expect(spec.env.DATABASE_URL).toContain(`:${now.dbPassword}@`);
  });

  it('stays the new one once the new container is in, though a step after that fails', async () => {
    const w = await world();
    const site = await createShop(w, withDb);
    // The site.json the recreate writes once its container is in: refused once.
    const files = w.servers.handleFor(1).files;
    const writeFile = files.writeFile.bind(files);
    let refused = 0;
    files.writeFile = async (file, content, opts) => {
      if (file.endsWith('/shop/site.json') && refused++ === 0) throw new Error('the disk is full');
      return writeFile(file, content, opts);
    };
    const job = w.worker.enqueue('database.password', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });
    const done = await finish(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(refused).toBeGreaterThan(0);
    const now = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(now.dbPassword).not.toBe(site.dbPassword);
    // MariaDB has the one the running container was made with, and never got the old one back.
    expect(w.dbAdmin.calls.filter((c) => c.method === 'setUserPassword').map((c) => c.args)).toEqual([['wp_shop', now.dbPassword]]);
    const spec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { env: Record<string, string> };
    expect(spec.env.DATABASE_URL).toContain(`:${now.dbPassword}@`);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
    const log = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all().map((l) => l.message);
    expect(log).toContain("Could not write the app's site.json (the disk is full).");
  });

  it('comes back as it was when the new container fails its check', async () => {
    const w = await world();
    const site = await createShop(w, withDb);
    w.db.update(appSettings).set({ healthTimeoutSec: 1 }).where(eq(appSettings.siteId, site.id)).run();
    w.docker.appHttp = () => 500;
    const job = w.worker.enqueue('database.password', { siteId: site.id }, { id: site.id, slug: 'shop', serverId: 1 });
    const done = await finish(w, job.id);
    expect(done.status).toBe('failed');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.dbPassword).toBe(site.dbPassword);
    const sets = w.dbAdmin.calls.filter((c) => c.method === 'setUserPassword').map((c) => c.args[1]);
    expect(sets.at(-1)).toBe(site.dbPassword);
    expect(w.docker.containers.get('wp-shop')).toBe('running');
  });
});
