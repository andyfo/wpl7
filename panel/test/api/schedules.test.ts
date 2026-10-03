import { describe, expect, it } from 'vitest';
import { jobs, sites } from '../../src/db/schema.js';
import type { JobDto, ScheduleActionsDto, ScheduleDto, ScheduleRunDto } from '../../shared/types.js';
import { curlAnswer, makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'mcp' } });
  const { token } = created.json() as { token: string };
  return { app, world, headers, bearer: { authorization: `Bearer ${token}` } };
}

function addSite(w: TestWorld, slug: string, status = 'running'): void {
  const now = Date.now();
  w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status,
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  w.docker.containers.set(`wp-${slug}`, status === 'running' ? 'running' : 'exited');
}

const nightlyCache = {
  name: 'Nightly cache flush',
  action: 'wp.cli',
  target: { kind: 'sites', slugs: ['alpha'] },
  params: { args: ['cache', 'flush'] },
  cron: '0 3 * * *',
};

describe('schedules API', () => {
  it('lists the built-in schedules with their group and whether they can be paused', async () => {
    const ctx = await authedApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/schedules', headers: ctx.bearer });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: ScheduleDto[] };
    expect(items.find((s) => s.key === 'wp-scan')).toMatchObject({ kind: 'builtin', group: 'jobs', pausable: true, enabled: true });
    expect(items.find((s) => s.key === 'ftp')).toMatchObject({ group: 'background', pausable: false });
    // A key works wherever an id does.
    const byKey = await ctx.app.inject({ method: 'GET', url: '/api/schedules/wp-scan', headers: ctx.bearer });
    expect((byKey.json() as { schedule: ScheduleDto }).schedule.name).toBe('WordPress inventory scan');
  });

  it('pauses and resumes a built-in, and nothing else about it', async () => {
    const ctx = await authedApp();
    const pause = await ctx.app.inject({ method: 'PATCH', url: '/api/schedules/backups', headers: ctx.headers, payload: { enabled: false } });
    expect(pause.statusCode).toBe(200);
    expect((pause.json() as { schedule: ScheduleDto }).schedule).toMatchObject({ enabled: false, nextRunAt: null });
    const meta = await ctx.app.inject({ method: 'GET', url: '/api/meta', headers: ctx.headers });
    expect(meta.json().backupsPaused).toBe(true);

    const cadence = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/schedules/backups',
      headers: ctx.headers,
      payload: { cron: '0 5 * * *' },
    });
    expect(cadence.statusCode).toBe(400);
    const locked = await ctx.app.inject({ method: 'PATCH', url: '/api/schedules/ftp', headers: ctx.headers, payload: { enabled: false } });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.message).toMatch(/cannot be paused/);
    const del = await ctx.app.inject({ method: 'DELETE', url: '/api/schedules/backups', headers: ctx.headers });
    expect(del.statusCode).toBe(400);

    const resume = await ctx.app.inject({ method: 'PATCH', url: '/api/schedules/backups', headers: ctx.headers, payload: { enabled: true } });
    expect((resume.json() as { schedule: ScheduleDto }).schedule.enabled).toBe(true);
  });

  it('creates a custom schedule over the API, crediting the key', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/schedules', headers: ctx.bearer, payload: nightlyCache });
    expect(res.statusCode, res.body).toBe(201);
    const { schedule } = res.json() as { schedule: ScheduleDto };
    expect(schedule).toMatchObject({
      kind: 'custom',
      group: 'custom',
      name: 'Nightly cache flush',
      action: 'wp.cli',
      target: { kind: 'sites', slugs: ['alpha'] },
      params: { args: ['cache', 'flush'], timeoutMin: 10 },
      cadence: { cron: '0 3 * * *', text: 'At 03:00, every day.' },
      createdBy: 'API key "mcp"',
      enabled: true,
    });
    expect(schedule.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('answers a bad schedule with a 400 that says what is wrong', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const tooOften = await ctx.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: ctx.headers,
      payload: { ...nightlyCache, cron: '* * * * *' },
    });
    expect(tooOften.statusCode).toBe(400);
    expect(tooOften.json().error.message).toMatch(/at most every 5 minutes/);
    const unknownSite = await ctx.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: ctx.headers,
      payload: { ...nightlyCache, target: { kind: 'sites', slugs: ['nobody'] } },
    });
    expect(unknownSite.statusCode).toBe(400);
    const unknownAction = await ctx.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: ctx.headers,
      payload: { ...nightlyCache, action: 'rm-rf' },
    });
    expect(unknownAction.statusCode).toBe(400);
  });

  it('runs a paused custom schedule on request, and points at its one job', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: ctx.headers,
      payload: { ...nightlyCache, enabled: false },
    });
    const { schedule } = created.json() as { schedule: ScheduleDto };
    expect(schedule).toMatchObject({ enabled: false, nextRunAt: null });

    const run = await ctx.app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/run`, headers: ctx.bearer });
    expect(run.statusCode).toBe(202);
    const body = run.json() as ScheduleRunDto;
    expect(body.jobs).toHaveLength(1);
    expect(run.headers.location).toBe(`/api/jobs/${body.jobs[0]!.id}`);
    expect(body.jobs[0]).toMatchObject({ type: 'wp.cli', origin: 'api', createdBy: 'API key "mcp"', scheduleId: schedule.id });

    const history = await ctx.app.inject({ method: 'GET', url: `/api/jobs?scheduleId=${schedule.id}`, headers: ctx.headers });
    expect((history.json() as { items: JobDto[] }).items).toHaveLength(1);
  });

  it('runs a background task without waiting for it', async () => {
    const ctx = await authedApp();
    const run = await ctx.app.inject({ method: 'POST', url: '/api/schedules/wp-cron/run', headers: ctx.headers });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ jobs: [], skipped: [], running: true });
  });

  it('edits and deletes a custom schedule', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const created = await ctx.app.inject({ method: 'POST', url: '/api/schedules', headers: ctx.headers, payload: nightlyCache });
    const { schedule } = created.json() as { schedule: ScheduleDto };
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/schedules/${schedule.id}`,
      headers: ctx.headers,
      payload: { name: 'Flush twice a day', cron: '0 3,15 * * *' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect((edit.json() as { schedule: ScheduleDto }).schedule).toMatchObject({ name: 'Flush twice a day', cadence: { cron: '0 3,15 * * *' } });
    const empty = await ctx.app.inject({ method: 'PATCH', url: `/api/schedules/${schedule.id}`, headers: ctx.headers, payload: {} });
    expect(empty.statusCode).toBe(400);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/schedules/${schedule.id}`, headers: ctx.headers });
    expect(del.statusCode).toBe(204);
    const gone = await ctx.app.inject({ method: 'GET', url: `/api/schedules/${schedule.id}`, headers: ctx.headers });
    expect(gone.statusCode).toBe(404);
  });

  it('describes every action with a JSON Schema a client can build a request from', async () => {
    const ctx = await authedApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/schedules/actions', headers: ctx.bearer });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScheduleActionsDto;
    expect(body.actions.map((a) => a.action)).toEqual([
      'backup',
      'site.restart',
      'site.start',
      'site.stop',
      'wp.scan',
      'wp.update',
      'panel.snapshot',
      'wp.cli',
      'site.shell',
      'wp.rest',
    ]);
    const cli = body.actions.find((a) => a.action === 'wp.cli')!;
    expect(cli.paramsSchema).toMatchObject({ type: 'object', properties: { args: { type: 'array' } }, required: ['args'] });
    expect(body.actions.find((a) => a.action === 'panel.snapshot')!.targets).toEqual(['panel']);
    expect(body.targetSchema).toHaveProperty('oneOf');
    expect(body).toMatchObject({ minGapMinutes: 5, maxCustomSchedules: 100 });
  });

  it('refuses changes while the panel is updating', async () => {
    const ctx = await authedApp();
    ctx.world.core.settings.setRaw('system.maintenance', { reason: 'Updating to 0.4.0', since: Date.now() });
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/schedules/backups', headers: ctx.headers, payload: { enabled: false } });
    expect(res.statusCode).toBe(503);
    // Reading stays open.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/schedules', headers: ctx.headers })).statusCode).toBe(200);
  });
});

describe('commands in a site, queued', () => {
  it('queues wp-cli with async: true, and a shell command, each answering with its job', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const cli = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers: ctx.bearer,
      payload: { args: ['cache', 'flush'], async: true, timeoutMin: 5 },
    });
    expect(cli.statusCode).toBe(202);
    const cliJob = (cli.json() as { job: JobDto }).job;
    expect(cli.headers.location).toBe(`/api/jobs/${cliJob.id}`);
    expect(cliJob).toMatchObject({ type: 'wp.cli', summary: 'wp cache flush', siteSlug: 'alpha' });
    ctx.world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();

    const shell = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/shell',
      headers: ctx.bearer,
      payload: { command: 'du -sh wp-content' },
    });
    expect(shell.statusCode).toBe(202);
    expect((shell.json() as { job: JobDto }).job).toMatchObject({ type: 'site.shell', summary: 'du -sh wp-content' });

    // One job per site at a time, as everywhere else.
    const busy = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/shell',
      headers: ctx.bearer,
      payload: { command: 'ls' },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('job_conflict');
  });

  it('refuses a stopped site and an empty command', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'asleep', 'stopped');
    addSite(ctx.world, 'alpha');
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/asleep/shell',
      headers: ctx.headers,
      payload: { command: 'ls' },
    });
    expect(stopped.statusCode).toBe(409);
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/shell',
      headers: ctx.headers,
      payload: { command: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('REST API requests', () => {
  const auth = { username: 'sync', applicationPassword: 'abcd efgh ijkl mnop qrst uvwx' };

  it("answers with the site's response, whatever its status", async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const notFound = { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } };
    ctx.world.docker.execQueue.push(curlAnswer({ status: 404, body: JSON.stringify(notFound) }));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/rest',
      headers: ctx.bearer,
      payload: { route: 'nope/v1/thing' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 404,
      statusText: 'Not Found',
      contentType: 'application/json; charset=UTF-8',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      truncated: false,
      error: null,
    });
    expect(JSON.parse(res.json().body)).toEqual(notFound);
  });

  it('answers 502 when nothing answered at all', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    ctx.world.docker.execQueue.push(curlAnswer({ status: 0, exitCode: 7, errormsg: 'Failed to connect to 127.0.0.1 port 80' }));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/sites/alpha/wp/rest', headers: ctx.headers, payload: { route: 'wp/v2' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/Failed to connect/);
  });

  it('queues the request with async: true, and refuses what cannot be sent', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    addSite(ctx.world, 'asleep', 'stopped');
    const queued = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/rest',
      headers: ctx.bearer,
      payload: { method: 'POST', route: 'shop/v1/sync', body: { since: '15m' }, auth, async: true },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    const { job } = queued.json() as { job: JobDto };
    expect(queued.headers.location).toBe(`/api/jobs/${job.id}`);
    expect(job).toMatchObject({ type: 'wp.rest', summary: 'POST /wp-json/shop/v1/sync as sync', siteSlug: 'alpha', origin: 'api' });
    expect(queued.body).not.toContain(auth.applicationPassword);

    const withBody = await ctx.app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/rest',
      headers: ctx.headers,
      payload: { route: 'wp/v2/posts', body: { status: 'draft' } },
    });
    expect(withBody.statusCode).toBe(400);
    const stopped = await ctx.app.inject({ method: 'POST', url: '/api/sites/asleep/wp/rest', headers: ctx.headers, payload: { route: 'wp/v2' } });
    expect(stopped.statusCode).toBe(409);
  });

  it('keeps the application password out of every schedule it answers with', async () => {
    const ctx = await authedApp();
    addSite(ctx.world, 'alpha');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: ctx.bearer,
      payload: {
        name: 'Order sync',
        action: 'wp.rest',
        target: { kind: 'sites', slugs: ['alpha'] },
        params: { method: 'POST', route: 'shop/v1/sync', auth },
        cron: '*/15 * * * *',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { schedule } = created.json() as { schedule: ScheduleDto };
    expect(schedule.params).toMatchObject({ auth: { username: 'sync' } });
    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/schedules/${schedule.id}`,
      headers: ctx.bearer,
      payload: { params: { ...schedule.params, route: 'shop/v1/sync?full=1' } },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const run = await ctx.app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/run`, headers: ctx.bearer });
    expect(run.statusCode).toBe(202);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/schedules', headers: ctx.bearer });
    for (const res of [created, edited, run, list]) expect(res.body).not.toContain(auth.applicationPassword);

    const actions = await ctx.app.inject({ method: 'GET', url: '/api/schedules/actions', headers: ctx.bearer });
    const rest = (actions.json() as ScheduleActionsDto).actions.find((a) => a.action === 'wp.rest')!;
    expect(rest).toMatchObject({ jobType: 'wp.rest', targets: ['sites', 'server', 'all'] });
    expect(rest.paramsSchema).toMatchObject({
      required: ['route'],
      properties: {
        method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        auth: { required: ['username', 'applicationPassword'] },
      },
    });
  });
});
