import { describe, expect, it } from 'vitest';
import { count } from 'drizzle-orm';
import { apiEvents } from '../../src/db/schema.js';
import type { ApiActivityDto } from '../../shared/types.js';
import { ApiActivityService, type ApiEventInput } from '../../src/services/apiActivity.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const fakeEvent = (i: number): ApiEventInput => ({
  keyId: null,
  keyName: '',
  keyPrefix: 'wpl7_x',
  method: 'GET',
  path: `/api/sites?i=${i}`,
  route: '/api/sites',
  status: 200,
  errorCode: null,
  durationMs: 1,
  ip: null,
  userAgent: null,
  jobId: null,
});

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

  const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'billing' } });
  expect(created.statusCode).toBe(201);
  const { token, id } = created.json() as { token: string; id: number };
  return { app, world, headers, token, keyId: id, bearer: { authorization: `Bearer ${token}` } };
}

const activityOf = async (
  app: Awaited<ReturnType<typeof authedApp>>['app'],
  headers: Record<string, string>,
  query = '',
): Promise<ApiActivityDto> => {
  const res = await app.inject({ method: 'GET', url: `/api/api-keys/activity${query}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as ApiActivityDto;
};

/** Backdate rows so retention has something to remove without waiting a month. */
function backdate(world: TestWorld, days: number): void {
  world.db.update(apiEvents).set({ ts: Date.now() - days * 24 * 3600_000 }).run();
}

describe('API activity log', () => {
  it('records key requests, names the key, and leaves the browser session out of it', async () => {
    const { app, headers, bearer, keyId } = await authedApp();

    await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });
    await app.inject({ method: 'GET', url: '/api/meta', headers }); // session: not recorded

    const activity = await activityOf(app, headers);
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]).toMatchObject({
      keyId,
      keyName: 'billing',
      method: 'GET',
      path: '/api/sites',
      route: '/api/sites',
      status: 200,
      outcome: 'ok',
    });
    expect(activity.items[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(activity.last24h).toMatchObject({ requests: 1, errors: 0, denied: 0, keys: 1 });
  });

  it('records a refused token without ever storing the token', async () => {
    const { app, world, headers, token } = await authedApp();

    const refused = await app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { authorization: 'Bearer wpl7_not-a-real-key-at-all' },
    });
    expect(refused.statusCode).toBe(401);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({ keyId: null, status: 401, outcome: 'denied', errorCode: 'unauthorized' });
    // Only the non-secret prefix, and not one character more.
    expect(activity.items[0]!.keyPrefix).toBe('wpl7_not-a-r');
    expect(activity.last24h.denied).toBe(1);

    // The valid token must not be recoverable from the table either.
    const stored = JSON.stringify(world.db.select().from(apiEvents).all());
    expect(stored).not.toContain(token);
  });

  it('records a revoked key\'s requests as refused', async () => {
    const { app, headers, bearer, keyId } = await authedApp();
    await app.inject({ method: 'DELETE', url: `/api/api-keys/${keyId}`, headers });

    const after = await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });
    expect(after.statusCode).toBe(401);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({ keyId: null, status: 401, outcome: 'denied' });
  });

  it('records requests that never reached a handler, and says which key made them', async () => {
    const { app, headers, bearer, keyId } = await authedApp();

    const missing = await app.inject({ method: 'GET', url: '/api/no-such-thing', headers: bearer });
    expect(missing.statusCode).toBe(404);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({
      keyId,
      keyName: 'billing',
      path: '/api/no-such-thing',
      route: null,
      status: 404,
      errorCode: 'not_found',
      outcome: 'error',
    });
  });

  it('strips the query string and keeps the error code of a rejected body', async () => {
    const { app, headers, bearer } = await authedApp();

    const bad = await app.inject({
      method: 'POST',
      url: '/api/sites?dry=1',
      headers: bearer,
      payload: { title: '' },
    });
    expect(bad.statusCode).toBe(400);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({
      path: '/api/sites',
      status: 400,
      errorCode: 'validation_error',
      outcome: 'error',
    });
  });

  it('links an async call to the job it started', async () => {
    const { app, headers, bearer } = await authedApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: bearer,
      payload: { title: 'My Blog', domainMode: 'dev', adminUser: 'boss', adminEmail: 'boss@example.com' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { job: { id: number } }).job.id;

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({ status: 202, jobId });
  });

  it('filters by outcome, method, path and key, and pages', async () => {
    const { app, headers, bearer, keyId } = await authedApp();
    for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });
    await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer });
    await app.inject({ method: 'GET', url: '/api/sites', headers: { authorization: 'Bearer wpl7_wrong' } });

    expect((await activityOf(app, headers)).total).toBe(5);
    expect((await activityOf(app, headers, '?outcome=denied')).total).toBe(1);
    expect((await activityOf(app, headers, '?outcome=ok')).total).toBe(4);
    expect((await activityOf(app, headers, '?search=/api/jobs')).total).toBe(1);
    expect((await activityOf(app, headers, '?method=POST')).total).toBe(0);

    const page = await activityOf(app, headers, '?limit=2&offset=2');
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5); // the count is of matches, not of the page

    const second = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'reports' } });
    const secondId = (second.json() as { id: number }).id;
    expect((await activityOf(app, headers, `?keyId=${secondId}`)).total).toBe(0);
    expect((await activityOf(app, headers, `?keyId=${keyId}`)).total).toBe(4);
  });

  it('honours the window: an old row is outside 24 hours and inside "everything kept"', async () => {
    const { app, world, headers, bearer } = await authedApp();
    await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });
    backdate(world, 3);

    expect((await activityOf(app, headers, '?hours=24')).total).toBe(0);
    expect((await activityOf(app, headers, '?hours=0')).total).toBe(1);
    expect((await activityOf(app, headers, '?hours=0')).last24h.requests).toBe(0);
  });

  it('keeps the retention period, and prunes what is past it', async () => {
    const { app, world, headers, bearer } = await authedApp();
    await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });

    expect((await activityOf(app, headers)).retentionDays).toBe(30);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { apiActivityRetentionDays: 7 },
    });
    expect(saved.statusCode).toBe(200);
    expect((await activityOf(app, headers, '?hours=0')).retentionDays).toBe(7);

    const service = new ApiActivityService(world.db);
    backdate(world, 3);
    expect(service.prune(7)).toBe(0); // three days old, seven-day window: kept
    backdate(world, 9);
    expect(service.prune(7)).toBe(1);
    expect((await activityOf(app, headers, '?hours=0')).total).toBe(0);
  });

  it('caps the table however long the retention period is', async () => {
    const { world } = await authedApp();
    const service = new ApiActivityService(world.db);
    for (let i = 0; i < 5; i++) service.record(fakeEvent(i));
    // Nothing is old enough to expire, so only the cap can remove anything.
    expect(service.prune(365, 2)).toBe(3);
    const left = service.list({ limit: 10, offset: 0 });
    expect(left.total).toBe(2);
    expect(left.items.map((e) => e.path)).toEqual(['/api/sites?i=4', '/api/sites?i=3']);
  });

  /**
   * The nightly run is not the ceiling. Anyone who can reach the panel can make it record
   * a 401, so a cap that is only restored at 04:00 is a cap on nothing in between.
   */
  it('holds the row ceiling as rows are written, without waiting for maintenance', async () => {
    const { world } = await authedApp();
    const service = new ApiActivityService(world.db, { maxRows: 10, capCheckEvery: 4 });

    let highWater = 0;
    for (let i = 0; i < 200; i++) {
      service.record(fakeEvent(i));
      highWater = Math.max(highWater, world.db.select({ n: count() }).from(apiEvents).get()!.n);
    }

    // Bounded at all times by the cap plus one check interval - never by the day.
    expect(highWater).toBeLessThanOrEqual(10 + 4);
    const left = service.list({ limit: 20, offset: 0 });
    expect(left.total).toBeLessThanOrEqual(10 + 4);
    // And what survives is the newest end of the log.
    expect(left.items[0]!.path).toBe('/api/sites?i=199');
  });

  it('records a terminal upgrade, which the response hook never sees', async () => {
    const { app, world, headers, token, keyId } = await authedApp();

    const ws = await app.injectWS('/api/servers/1/terminal?cols=80&rows=24', {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '127.0.0.1' } as never,
    });
    await waitFor(() => world.shell.opened.length === 1);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({
      keyId,
      keyName: 'billing',
      method: 'GET',
      path: '/api/servers/1/terminal',
      route: '/api/servers/:id/terminal',
      status: 101,
      outcome: 'ok',
    });
    // One row per shell, written when it opens - not a second one when it closes.
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await activityOf(app, headers)).total).toBe(1);
    await app.close();
  });

  it('records an escaped path that Fastify routes but validation rejects', async () => {
    const { app, headers, bearer, keyId } = await authedApp();

    // find-my-way decodes before routing, so this reaches the real POST /api/sites.
    const bad = await app.inject({ method: 'POST', url: '/%61pi/sites', headers: bearer, payload: { title: '' } });
    expect(bad.statusCode).toBe(400);

    const activity = await activityOf(app, headers);
    expect(activity.items[0]).toMatchObject({
      keyId,
      path: '/%61pi/sites', // as sent; `route` carries what it matched
      route: '/api/sites',
      status: 400,
      errorCode: 'validation_error',
    });
  });

  it('records an escaped path that matched no route at all', async () => {
    const { app, headers, bearer, keyId } = await authedApp();

    const missing = await app.inject({ method: 'GET', url: '/%61pi/nope', headers: bearer });
    expect(missing.statusCode).toBe(404);

    expect((await activityOf(app, headers)).items[0]).toMatchObject({
      keyId,
      path: '/%61pi/nope',
      route: null,
      status: 404,
    });
  });

  it('empties the log on request, leaving the keys alone', async () => {
    const { app, headers, bearer } = await authedApp();
    await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });

    const cleared = await app.inject({ method: 'DELETE', url: '/api/api-keys/activity', headers });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ removed: 1 });
    expect((await activityOf(app, headers, '?hours=0')).total).toBe(0);

    // The key still works: clearing the log is not revoking anything.
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: bearer })).statusCode).toBe(200);
  });

  it('counts a key\'s recent requests on the key list', async () => {
    const { app, headers, bearer, keyId } = await authedApp();
    await app.inject({ method: 'GET', url: '/api/sites', headers: bearer });
    await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer });

    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    const key = (list.json() as { items: { id: number; requests24h: number }[] }).items.find((k) => k.id === keyId);
    expect(key?.requests24h).toBe(2);
  });

  it('is reachable with a key, and "activity" is not read as a key id', async () => {
    const { app, bearer } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/api-keys/activity', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ApiActivityDto).items).toBeInstanceOf(Array);
  });
});
