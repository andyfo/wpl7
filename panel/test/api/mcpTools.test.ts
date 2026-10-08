/**
 * The MCP tools against the real routes over the fake world: every call goes through the API
 * and its auth gate, and comes back attributed, logged and shaped.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobLogs, jobs, settings, sites } from '../../src/db/schema.js';
import { FILE_EXIT } from '../../src/services/siteFilesScripts.js';
import { injectAs } from '../../src/mcp/call.js';
import type { ApiActivityDto } from '../../shared/types.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, mcpClient, type TestWorld } from '../helpers.js';

async function panel() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  world.deps.settings.set('mcpEnabled', true);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const session = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const client = (access: AccessLevel, opts: { remoteAddress?: string } = {}) =>
    mcpClient(app, { authorization: `Bearer ${world.deps.apiKeys.create('ci', access).token}`, 'user-agent': 'claude-code/2.1' }, opts);
  const activity = async () =>
    ((await app.inject({ method: 'GET', url: '/api/api-keys/activity', headers: session })).json() as ApiActivityDto).items;
  return { app, world, session, client, activity };
}

function addSite(w: TestWorld, slug: string): void {
  const now = Date.now();
  w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  w.docker.containers.set(`wp-${slug}`, 'running');
}

const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('calls through the MCP tools', () => {
  it('queue work as the MCP caller, log it with the tool and the real address, and say what to call next', async () => {
    const { world, client, activity } = await panel();
    addSite(world, 'alpha');
    const mcp = client('manage', { remoteAddress: '203.0.113.7' });

    const { isError, value } = await mcp.call('wpl7_api_change', { method: 'POST', path: '/api/sites/alpha/restart' });
    expect(isError).toBe(false);
    expect(value).toMatchObject({
      status: 202,
      endpoint: 'POST /api/sites/:slug/restart',
      body: { job: { type: 'site.restart', origin: 'mcp', createdBy: 'API key "ci" via MCP' } },
      next: expect.stringContaining('wpl7_wait_for_job {"jobId": '),
    });
    expect(world.db.select().from(jobs).get()).toMatchObject({ origin: 'mcp', createdBy: 'API key "ci" via MCP' });

    const [row] = await activity();
    expect(row).toMatchObject({
      keyName: 'ci',
      method: 'POST',
      path: '/api/sites/alpha/restart',
      route: '/api/sites/:slug/restart',
      status: 202,
      via: 'mcp',
      tool: 'wpl7_api_change',
      connectionId: null,
      ip: '203.0.113.7',
      userAgent: 'claude-code/2.1',
      jobId: value.body.job.id,
    });
  });

  it('reads with a query, and trims lists to the fields asked for', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    addSite(world, 'bravo');
    const { value } = await client('read').call('wpl7_api_get', { path: '/api/sites', select: ['slug', 'status'] });
    expect(value.body.items).toEqual([
      { slug: 'alpha', status: 'running' },
      { slug: 'bravo', status: 'running' },
    ]);
    const jobsPage = await client('read').call('wpl7_api_get', { path: '/api/jobs', query: { limit: 1, status: 'failed' } });
    expect(jobsPage.value).toMatchObject({ status: 200, body: { items: [], total: 0 } });
  });

  it('refuses an endpoint through the wrong tool, naming the right one', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const full = client('full');

    const viaDangerous = await full.call('wpl7_api_dangerous', { method: 'POST', path: '/api/sites/alpha/restart' });
    expect(viaDangerous).toMatchObject({
      isError: true,
      value: { status: 403, error: { message: 'POST /api/sites/:slug/restart is reached through wpl7_api_change, not wpl7_api_dangerous' } },
    });
    const viaChange = await full.call('wpl7_api_change', { method: 'DELETE', path: '/api/sites/alpha' });
    expect(viaChange.value.error.message).toBe('DELETE /api/sites/:slug is reached through wpl7_api_dangerous, not wpl7_api_change');
    const fileViaGet = await full.call('wpl7_api_get', { path: '/api/sites/alpha/files/content', query: { path: 'wp-config.php' } });
    expect(fileViaGet.value.error.message).toMatch(/reached through wpl7_read_site_file/);
    // Nothing was queued by any of it.
    expect(world.db.select().from(jobs).all()).toHaveLength(0);
  });

  it('gives Manage the destructive tool for what is inside a site, and holds the panel to Full', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const manage = client('manage');

    const stop = await manage.call('wpl7_api_dangerous', { method: 'POST', path: '/api/sites/alpha/stop' });
    expect(stop.value, JSON.stringify(stop.value)).toMatchObject({ status: 202, endpoint: 'POST /api/sites/:slug/stop' });

    const del = await manage.call('wpl7_api_dangerous', { method: 'DELETE', path: '/api/sites/alpha' });
    expect(del).toMatchObject({
      isError: true,
      value: { status: 403, error: { message: 'This key is Manage; DELETE /api/sites/:slug needs Full' } },
    });
  });

  it('never reaches sign-in, accounts, keys, or binary streams', async () => {
    const { client } = await panel();
    const full = client('full');
    const refusals = [
      await full.call('wpl7_api_change', { method: 'POST', path: '/api/auth/login', body: { username: 'admin', password: 'x' } }),
      await full.call('wpl7_api_get', { path: '/api/auth/me' }),
      await full.call('wpl7_api_get', { path: '/api/health' }),
      await full.call('wpl7_api_get', { path: '/api/users' }),
      await full.call('wpl7_api_get', { path: '/api/api-keys' }),
      await full.call('wpl7_api_dangerous', { method: 'POST', path: '/api/api-keys', body: { name: 'mine' } }),
      await full.call('wpl7_api_dangerous', { method: 'DELETE', path: '/api/api-keys/activity' }),
      await full.call('wpl7_api_get', { path: '/api/backups/1/download' }),
    ];
    for (const r of refusals) {
      expect(r.isError).toBe(true);
      expect(r.value.status, r.value.endpoint).toBe(403);
      expect(r.value.error.message).toMatch(/is not available through MCP$/);
    }
  });

  it('refuses a level the caller does not have, even if a tool were to ask', async () => {
    const { app, world } = await panel();
    addSite(world, 'alpha');
    // The tool list already hides wpl7_api_change from a Read only caller; the gate holds anyway.
    const res = await injectAs(
      app,
      {
        principal: { kind: 'apiKey', access: 'read', label: 'API key "r" via MCP', apiKey: { id: 1, name: 'r', prefix: 'wpl7_r' }, connection: null },
        group: 'change',
        tool: 'wpl7_api_change',
        matched: null,
      },
      { method: 'POST', url: '/api/sites/alpha/restart' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('This key is Read only; POST /api/sites/:slug/restart needs Manage');
  });

  it('takes no path the router would decode, and no query or dot segments in it', async () => {
    const { client } = await panel();
    const read = client('read');
    for (const path of ['/api/%73ites', '/api/sites?limit=1', '/api/sites#x', '/api/sites/../users', '/api//sites', '/mcp']) {
      const r = await read.call('wpl7_api_get', { path });
      expect(r.isError, path).toBe(true);
      expect(String(r.value), path).toMatch(/validation/i);
    }
  });

  it('turns errors into a hint about what to do', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const manage = client('manage');

    await manage.call('wpl7_api_change', { method: 'POST', path: '/api/sites/alpha/restart' });
    const running = world.db.select().from(jobs).get()!;
    const busy = await manage.call('wpl7_api_change', { method: 'POST', path: '/api/sites/alpha/restart' });
    expect(busy.value).toMatchObject({ status: 409, error: { code: 'job_conflict' } });
    expect(busy.value.hint).toContain(`wpl7_wait_for_job {"jobId": ${running.id}}`);

    const invalid = await manage.call('wpl7_api_change', { method: 'POST', path: '/api/sites', body: {} });
    expect(invalid.value).toMatchObject({ status: 400, error: { code: 'validation_error' } });
    expect(invalid.value.hint).toContain('wpl7_api_docs {"endpoint": "POST /api/sites"}');

    const noRoute = await manage.call('wpl7_api_get', { path: '/api/nothing-here' });
    expect(noRoute.value).toMatchObject({ status: 404, endpoint: 'GET /api/nothing-here' });
    expect(noRoute.value.hint).toMatch(/No such endpoint/);
    const noSite = await manage.call('wpl7_api_get', { path: '/api/sites/nope-site' });
    expect(noSite.value).toMatchObject({ status: 404, endpoint: 'GET /api/sites/:slug' });
    expect(noSite.value.hint).toMatch(/Nothing by that id/);

    world.db
      .insert(settings)
      .values({ key: 'system.maintenance', value: JSON.stringify({ reason: 'Updating to 0.3.0', since: Date.now() }), updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify({ reason: 'Updating to 0.3.0', since: Date.now() }) } })
      .run();
    const during = await manage.call('wpl7_api_change', { method: 'POST', path: '/api/wp/scan' });
    expect(during.value).toMatchObject({ status: 503, error: { code: 'maintenance' } });
    expect(during.value.hint).toMatch(/Reading still works/);
    expect((await manage.call('wpl7_api_get', { path: '/api/sites' })).isError).toBe(false);
  });
});

describe('wpl7_wait_for_job', () => {
  it('answers at once for a finished job, with its result and log, as one request in the log', async () => {
    const { world, client, activity } = await panel();
    const job = world.db
      .insert(jobs)
      .values({ type: 'wp.scanAll', status: 'succeeded', payload: '{}', result: JSON.stringify({ scanned: 3 }), createdAt: 1, finishedAt: 2 })
      .returning()
      .get();
    world.db.insert(jobLogs).values([
      { jobId: job.id, ts: 1, level: 'info', message: 'Scanning 3 sites' },
      { jobId: job.id, ts: 2, level: 'warn', message: 'bravo is stopped' },
    ]).run();

    const { value } = await client('read').call('wpl7_wait_for_job', { jobId: job.id });
    expect(value).toMatchObject({
      done: true,
      status: 'succeeded',
      job: { id: job.id, type: 'wp.scanAll', result: { scanned: 3 } },
      log: ['Scanning 3 sites', '[warn] bravo is stopped'],
    });
    const again = await client('read').call('wpl7_wait_for_job', { jobId: job.id, logAfter: value.lastSeq });
    expect(again.value.log).toEqual([]);
    expect((await activity()).filter((r) => r.tool === 'wpl7_wait_for_job')).toHaveLength(2);
  });

  it('gives up after the timeout on a job still running, and says it is not done', async () => {
    const { world, client } = await panel();
    const job = world.db.insert(jobs).values({ type: 'wp.scanAll', status: 'running', payload: '{}', createdAt: 1 }).returning().get();
    const started = Date.now();
    const { value } = await client('read').call('wpl7_wait_for_job', { jobId: job.id, timeoutSeconds: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(value).toMatchObject({ done: false, status: 'running' });
  });

  it('returns as soon as the job finishes', async () => {
    const { world, client } = await panel();
    const job = world.db.insert(jobs).values({ type: 'wp.scanAll', status: 'running', payload: '{}', createdAt: 1 }).returning().get();
    setTimeout(() => world.db.update(jobs).set({ status: 'failed', error: 'boom' }).where(eq(jobs.id, job.id)).run(), 300);
    const started = Date.now();
    const { value } = await client('read').call('wpl7_wait_for_job', { jobId: job.id, timeoutSeconds: 20 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(value).toMatchObject({ done: true, status: 'failed', job: { error: 'boom' } });
  });

  it('masks what a Read only caller may not see, as the API does', async () => {
    const { world, client } = await panel();
    const job = world.db
      .insert(jobs)
      .values({ type: 'site.create', status: 'succeeded', payload: '{}', result: JSON.stringify({ adminPassword: 'hunter2' }), createdAt: 1 })
      .returning()
      .get();
    const { value } = await client('read').call('wpl7_wait_for_job', { jobId: job.id });
    expect(value.job.result).toEqual({ adminPassword: '•••' });
  });

  it('says so when there is no such job', async () => {
    const { client } = await panel();
    const { isError, value } = await client('read').call('wpl7_wait_for_job', { jobId: 999 });
    expect(isError).toBe(true);
    expect(value).toMatchObject({ status: 404 });
  });
});

describe('the file tools', () => {
  it('read a file by lines with its etag, and say what is left', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    world.docker.streamQueue.push({ stdout: file });
    const { value } = await client('full').call('wpl7_read_site_file', { site: 'alpha', path: 'wp-config.php', startLine: 11, maxLines: 5 });
    expect(value).toMatchObject({
      site: 'alpha',
      path: 'wp-config.php',
      etag: sha(file),
      totalLines: 30,
      startLine: 11,
      endLine: 15,
      text: 'line 11\nline 12\nline 13\nline 14\nline 15',
      more: expect.stringContaining('startLine 16'),
    });
  });

  it('never cut a line short: a long file comes back as whole lines that fit, and says where to go on', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    // 500 lines of ~90 characters, with quotes that cost double in JSON.
    const lines = Array.from({ length: 500 }, (_, i) => `$config['option_${i}'] = "${'x'.repeat(60)}"; // line ${i + 1}`);
    world.docker.streamQueue.push({ stdout: lines.join('\n') });
    const res = await client('full').send('tools/call', { name: 'wpl7_read_site_file', arguments: { site: 'alpha', path: 'big.php', maxLines: 2000 } });
    const raw = (res.message!.result!.content as { text: string }[])[0]!.text;
    expect(raw.length).toBeLessThanOrEqual(40_000);
    const value = JSON.parse(raw);
    expect(value.endLine).toBeLessThan(500);
    expect(value.text.split('\n')).toEqual(lines.slice(0, value.endLine));
    expect(value.more).toContain(`startLine ${value.endLine + 1}`);
    expect(raw).not.toContain('more characters]');
  });

  it('describe a binary file instead of dumping it', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    world.docker.streamQueue.push({ stdout: 'PNG\0\0\0binary' });
    const { value } = await client('full').call('wpl7_read_site_file', { site: 'alpha', path: 'logo.png' });
    expect(value).toMatchObject({ binary: true, sizeBytes: 12 });
    expect(value).not.toHaveProperty('text');
    // Nothing shown, so nothing to save over: without an etag there is no blind overwrite.
    expect(value).not.toHaveProperty('etag');
  });

  it('save only over the version that was read, syntax-checking PHP', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const full = client('full');
    world.docker.execQueue.push({ stdout: 'rw/f/f/9/644/1727000000.25/33/33/functions.php/\0', stderr: '', exitCode: 0 });
    const saved = await full.call('wpl7_write_site_file', {
      site: 'alpha',
      path: 'wp-content/themes/t/functions.php',
      content: '<?php //\n',
      etag: sha('old'),
    });
    expect(saved).toMatchObject({ isError: false, value: { status: 200, etag: sha('<?php //\n'), bytes: 9 } });
    expect(world.docker.inputs[0]!.toString()).toBe('<?php //\n');
    const put = world.docker.calls.find((c) => c.method === 'execWithInput')!;
    // replace, conditional on the etag, and linted as PHP.
    expect((put.args[1] as string[]).slice(4)).toEqual([
      '/var/www/html/wp-content/themes/t/functions.php',
      'replace',
      sha('old'),
      '9',
      sha('<?php //\n'),
      'php',
    ]);

    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.changed });
    const stale = await full.call('wpl7_write_site_file', { site: 'alpha', path: 'index.php', content: 'x', etag: sha('older') });
    expect(stale.value).toMatchObject({ status: 412, error: { code: 'precondition_failed' } });
    expect(stale.value.hint).toMatch(/Read it again with wpl7_read_site_file/);

    world.docker.execQueue.push({ stdout: '', stderr: "PHP Parse error: syntax error, unexpected token \"}\" in index.php on line 1", exitCode: FILE_EXIT.syntax });
    const broken = await full.call('wpl7_write_site_file', { site: 'alpha', path: 'index.php', content: '<?php }', etag: sha('x') });
    expect(broken.value).toMatchObject({ status: 422, error: { code: 'syntax_error' } });
    expect(broken.value.hint).toMatch(/nothing was saved/);
  });

  it('create a new file only where there is none, and never overwrite blind', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const full = client('full');
    world.docker.execQueue.push({ stdout: 'rw/f/f/2/644/1727000000.25/33/33/new.txt/\0', stderr: '', exitCode: 0 });
    const created = await full.call('wpl7_write_site_file', { site: 'alpha', path: 'new.txt', content: 'hi', createOnly: true });
    expect(created.isError).toBe(false);
    const put = world.docker.calls.find((c) => c.method === 'execWithInput')!;
    expect((put.args[1] as string[]).slice(5, 6)).toEqual(['create']);

    const blind = await full.call('wpl7_write_site_file', { site: 'alpha', path: 'new.txt', content: 'hi' });
    expect(blind.isError).toBe(true);
    expect(String(blind.value)).toMatch(/exactly one of etag/);
  });
});

describe('wpl7_api_docs', () => {
  it("gives an endpoint's schema as the live route validates it", async () => {
    const { client } = await panel();
    const { value } = await client('read').call('wpl7_api_docs', { endpoint: 'POST /api/sites' });
    expect(value).toMatchObject({ endpoint: 'POST /api/sites', tool: 'wpl7_api_change', needs: 'Manage' });
    expect(value.schema.body.properties).toHaveProperty('title');
    expect(value.schema.body.required).toEqual(expect.arrayContaining(['title', 'adminUser']));
    // Optional: a create that leaves it out gets the default admin email from Settings.
    expect(value.schema.body.properties).toHaveProperty('adminEmail');
    expect(value.schema.body.required).not.toContain('adminEmail');
  });
});
