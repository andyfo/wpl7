/**
 * The MCP tools against the real routes over the fake world: every call goes through the API
 * and its auth gate, and comes back attributed, logged and shaped.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobLogs, jobs, settings, sites } from '../../src/db/schema.js';
import { FILE_EXIT } from '../../src/services/siteFilesScripts.js';
import { injectAs } from '../../src/mcp/call.js';
import type { ApiActivityDto } from '../../shared/types.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, mcpClient, runInSh, type TestWorld } from '../helpers.js';

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

  it('upload a small binary file sent as base64, only where nothing is unless asked to overwrite', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const mcp = client('manage');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff]);
    const args = (call: { args: unknown[] }) => (call.args[1] as string[]).slice(4);
    world.docker.execQueue.push({ stdout: 'rw/f/f/11/644/1727000000.25/33/33/logo.png/\0', stderr: '', exitCode: 0 });
    // Wrapped as `base64` prints it, which the tool reads as well.
    const b64 = png.toString('base64').replace(/(.{8})/g, '$1\n');
    const saved = await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'wp-content/uploads/logo.png', contentBase64: b64, sha256: sha(png) });
    expect(saved).toMatchObject({ isError: false, value: { status: 200, path: 'wp-content/uploads/logo.png', bytes: 11, sha256: sha(png) } });
    expect(world.docker.inputs[0]!.equals(png)).toBe(true);
    // Create-only, and no PHP check for a picture.
    expect(args(world.docker.calls.find((c) => c.method === 'execWithInput')!)).toEqual([
      '/var/www/html/wp-content/uploads/logo.png',
      'create',
      '-',
      '11',
      sha(png),
      '-',
    ]);

    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.exists });
    const inTheWay = await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'logo.png', contentBase64: png.toString('base64') });
    expect(inTheWay.value).toMatchObject({ status: 412, hint: 'Something is at that path already. Send overwrite: true to replace it.' });

    world.docker.calls = [];
    world.docker.execQueue.push({ stdout: 'rw/f/f/5/644/1727000000.25/33/33/x.php/\0', stderr: '', exitCode: 0 });
    await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'x.php', contentBase64: Buffer.from('<?php').toString('base64'), overwrite: true });
    // Replace whatever is there, but only with PHP that parses.
    expect(args(world.docker.calls.find((c) => c.method === 'execWithInput')!)).toMatchObject({ 1: 'any', 5: 'php' });

    // The route saves `x.php/` as x.php: checked as PHP all the same.
    world.docker.calls = [];
    world.docker.execQueue.push({ stdout: 'rw/f/f/5/644/1727000000.25/33/33/x.php/\0', stderr: '', exitCode: 0 });
    await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'x.php/', contentBase64: Buffer.from('<?php').toString('base64'), overwrite: true });
    expect(args(world.docker.calls.find((c) => c.method === 'execWithInput')!)).toMatchObject({ 0: '/var/www/html/x.php', 5: 'php' });
  });

  it('refuse base64 that is not, bytes that are not the file meant, and more than one call carries - sending nothing', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const mcp = client('manage');
    const upload = (extra: Record<string, unknown>) => mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'a.bin', ...extra });
    for (const contentBase64 of ['not base64!', 'QR==', 'Q']) {
      const res = await upload({ contentBase64 });
      expect(res.isError, contentBase64).toBe(true);
      expect(res.value.error.message).toMatch(/not base64/);
    }
    const slip = await upload({ contentBase64: Buffer.from('abc').toString('base64'), sha256: sha('abd') });
    expect(slip.value.error.message).toBe(`The bytes' SHA-256 is ${sha('abc')}, not ${sha('abd')}: nothing was saved`);
    const short = await upload({ contentBase64: Buffer.from('abc').toString('base64'), sizeBytes: 4 });
    expect(short.value.error.message).toMatch(/holds 3 bytes, not sizeBytes 4/);
    const big = await upload({ contentBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64') });
    expect(big.value).toMatchObject({ error: { message: expect.stringMatching(/more than one call carries/) }, hint: expect.stringMatching(/sizeBytes and sha256/) });
    // Without the bytes, a file on the app's disk: its size and hash, both.
    const neither = await upload({ sizeBytes: 3 });
    expect(neither.isError).toBe(true);
    expect(world.docker.calls.filter((c) => c.method.startsWith('exec'))).toEqual([]);
  });

  it('never empty a file with text that decodes to nothing: padding alone, misplaced padding, or no bytes asked for by mistake', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const mcp = client('manage');
    const upload = (extra: Record<string, unknown>) =>
      mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'wp-content/uploads/logo.png', overwrite: true, ...extra });
    for (const contentBase64 of ['=', '==', '===', '====', ' = \n=', 'QQ=', 'QUJD==', 'QQ==QQ==', 'data:,QQ==']) {
      const res = await upload({ contentBase64 });
      expect(res.value.error?.message, JSON.stringify(contentBase64)).toBe('contentBase64 is not base64: nothing was saved');
    }
    // An empty file only when asked for in so many words.
    for (const contentBase64 of ['', ' \n ']) {
      const res = await upload({ contentBase64 });
      expect(res.value).toMatchObject({ error: { message: 'contentBase64 holds no bytes: nothing was saved' }, hint: 'To save an empty file, send sizeBytes: 0 with it.' });
    }
    expect(world.docker.calls.filter((c) => c.method.startsWith('exec'))).toEqual([]);
    world.docker.execQueue.push({ stdout: 'rw/f/f/0/644/1727000000.25/33/33/logo.png/\0', stderr: '', exitCode: 0 });
    const empty = await upload({ contentBase64: '', sizeBytes: 0 });
    expect(empty.value).toMatchObject({ status: 200, bytes: 0, sha256: sha('') });
    // Valid text in every form the tool takes: padded, unpadded, URL-safe, wrapped.
    for (const [contentBase64, bytes] of [['QQ==', 'A'], ['QQ', 'A'], ['QUI=', 'AB'], ['QUJD', 'ABC'], ['-_-_', '\xfb\xff\xbf'], ['QU\nJD\r\n', 'ABC']] as const) {
      world.docker.execQueue.push({ stdout: 'rw/f/f/1/644/1727000000.25/33/33/logo.png/\0', stderr: '', exitCode: 0 });
      const res = await upload({ contentBase64 });
      expect(res.value.sha256, contentBase64).toBe(sha(Buffer.from(bytes, 'latin1')));
    }
  });

  it('refuse a long malformed text at once, without holding the panel up', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    // A run of padding followed by one more character: the old decoder took time growing with the
    // square of its length here, about an hour at the tool's 1.5 million characters.
    const started = Date.now();
    const res = await client('manage').call('wpl7_upload_site_file', { site: 'alpha', path: 'a.bin', contentBase64: `${'='.repeat(1_499_999)}A` });
    expect(res.value.error.message).toBe('contentBase64 is not base64: nothing was saved');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("hand out a curl command for a file on the app's own disk, which puts that file there", async () => {
    const { app, world, client, activity } = await panel();
    addSite(world, 'alpha');
    const mcp = client('manage');
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.notFound });
    const res = await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'plugin.zip', sizeBytes: 5, sha256: sha('hello') });
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ status: 201, site: 'alpha', path: 'plugin.zip', sizeBytes: 5, expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    const command = res.value.command as string;
    expect(command).toMatch(
      /^r=\$\(curl -sS -g --fail-with-body -T "FILE" -H 'X-WPL7-Upload-Token: wpl7up_[A-Za-z0-9_-]{43}' 'http:\/\/panel\.example\.test\/api\/file-uploads'\); printf '%s\\n' "\$r"; case "\$r" in \*'"written":\{'\*\) ;; \*\) echo "Not in place: the panel did not take the file\." >&2; false ;; esac$/,
    );
    expect(res.value.next).toMatch(/If curl cannot reach panel\.example\.test/);
    expect((await activity())[0]).toMatchObject({ via: 'mcp', tool: 'wpl7_upload_site_file', route: '/api/sites/:slug/files/upload-links', status: 201 });

    // What the app's shell then does.
    const token = /X-WPL7-Upload-Token: (\S+)'/.exec(command)![1]!;
    world.docker.execQueue.push({ stdout: 'rw/f/f/5/644/1727000000.25/33/33/plugin.zip/\0', stderr: '', exitCode: 0 });
    const put = await app.inject({ method: 'PUT', url: '/api/file-uploads', headers: { 'x-wpl7-upload-token': token }, payload: Buffer.from('hello') });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ received: 5, size: 5, written: { path: 'plugin.zip', etag: sha('hello') } });

    // Over one request's worth, the same in pieces.
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.notFound });
    const big = await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: 'theme.zip', sizeBytes: 20 * 1024 * 1024, sha256: sha('x') });
    expect(big.value.command).toContain('if [ "$(wc -c < "$f" | tr -dc 0-9)" != 20971520 ]; then');
    expect(big.value.command).toContain('while [ $((i * n)) -lt 20971520 ]; do');
    expect(big.value.command).toContain('"http://panel.example.test/api/file-uploads?offset=$((i * n))") || break');
    expect(big.value.command.split('\n').at(-1)).toBe('fi');
  });

  it('stop the links an app made once MCP is switched off', async () => {
    const { app, world, client } = await panel();
    addSite(world, 'alpha');
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.notFound });
    const res = await client('manage').call('wpl7_upload_site_file', { site: 'alpha', path: 'a.bin', sizeBytes: 1, sha256: sha('a') });
    const token = /X-WPL7-Upload-Token: (\S+)'/.exec(res.value.command as string)![1]!;
    world.deps.settings.set('mcpEnabled', false);
    const put = await app.inject({ method: 'PUT', url: '/api/file-uploads', headers: { 'x-wpl7-upload-token': token }, payload: Buffer.from('a') });
    expect(put.statusCode).toBe(403);
  });

  it('make upload links through the upload tool alone', async () => {
    const { world, client } = await panel();
    addSite(world, 'alpha');
    const res = await client('full').call('wpl7_api_dangerous', {
      method: 'POST',
      path: '/api/sites/alpha/files/upload-links',
      body: { path: 'a.zip', size: 1, sha256: sha('a') },
    });
    expect(res.value).toMatchObject({ status: 403, error: { message: expect.stringContaining('wpl7_upload_site_file') } });
  });
});

const curl = spawnSync('curl', ['--version']).status === 0;

/**
 * The commands wpl7_upload_site_file hands out, run as an app runs them: curl in `sh`, against
 * this panel listening, with the site's files faked (the scripts behind them run for real in
 * test/unit/siteFilesScripts.test.ts, on GNU tools). What is held to here is the exit status:
 * 0 must mean the file is in place, as a script that goes on to the next step goes by it.
 */
describe.skipIf(!curl)('the upload commands, run with curl', () => {
  const PIECE = 8 * 1024 * 1024;
  /** What the panel's append script prints once a file is in place: its entry. */
  const inPlace = (name: string, size: number) => ({ stdout: `rw/f/f/${size}/644/1727000000.25/33/33/${name}/\0`, stderr: '', exitCode: 0 });

  async function listening() {
    const { app, world, client } = await panel();
    addSite(world, 'alpha');
    await app.listen({ port: 0, host: '127.0.0.1' });
    // The links point where the panel listens.
    Object.assign(world.config, { panelDomain: `127.0.0.1:${(app.server.address() as AddressInfo).port}` });
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-app-'));
    const mcp = client('manage');
    /** The command for a link to a file like `declared`, at the site's top folder. */
    const commandFor = async (name: string, declared: Buffer) => {
      world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.notFound });
      const res = await mcp.call('wpl7_upload_site_file', { site: 'alpha', path: name, sizeBytes: declared.length, sha256: sha(declared) });
      expect(res.isError, JSON.stringify(res.value)).toBe(false);
      return res.value.command as string;
    };
    /** Run a command with `onDisk` as the file on the app's disk, under `name` there. */
    const run = (command: string, name: string, onDisk: Buffer) => {
      const file = path.join(local, name);
      fs.writeFileSync(file, onDisk);
      return runInSh(command.replace('FILE', file));
    };
    const sent = () => world.docker.inputs.map((b) => b.length);
    const close = async () => {
      await app.close();
      fs.rmSync(local, { recursive: true, force: true });
    };
    return { world, commandFor, run, sent, close };
  }

  /** A server that answers every request with a redirect to a sign-in page, as a proxy might. */
  async function redirecting() {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      req.resume();
      req.on('end', () => {
        res.writeHead(302, { location: 'https://sign-in.example.com/' });
        res.end('<html>Sign in</html>');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-uploads`;
    return { url, requests: () => requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('exit 0 once the panel has the file in place: in one request, with a name curl would read as a pattern, and in pieces', async () => {
    const p = await listening();
    try {
      const small = crypto.randomBytes(3000);
      const single = await p.commandFor('photo.png', small);
      p.world.docker.execQueue.push(inPlace('photo.png', 3000));
      const one = await p.run(single, 'photo[1].png', small);
      expect(one.code, one.out).toBe(0);
      expect(one.out).toContain('"written":{');
      expect(p.sent()).toEqual([3000]);

      const big = crypto.randomBytes(PIECE + 1000);
      const command = await p.commandFor('theme.zip', big);
      p.world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 }, inPlace('theme.zip', PIECE + 1000));
      const pieces = await p.run(command, 'theme.zip', big);
      expect(pieces.code, pieces.out).toBe(0);
      expect(p.sent()).toEqual([3000, PIECE, 1000]);
    } finally {
      await p.close();
    }
  });

  it('exit non-zero for anything else: a redirect, a refusal, a file of another size, a last piece that left it short', async () => {
    const p = await listening();
    const proxy = await redirecting();
    try {
      // A redirect, which curl calls success: nothing goes further, and a loop stops at its first piece.
      const small = crypto.randomBytes(3000);
      const redirected = await p.run((await p.commandFor('a.png', small)).replace(/http:\/\/127\.0\.0\.1:\d+\/api\/file-uploads/, proxy.url), 'a.png', small);
      expect(redirected.code).not.toBe(0);
      expect(redirected.out).toContain('Not in place: the panel did not take the file.');
      const big = crypto.randomBytes(PIECE + 1000);
      const loop = await p.run((await p.commandFor('b.zip', big)).replace(/http:\/\/127\.0\.0\.1:\d+\/api\/file-uploads/g, proxy.url), 'b.zip', big);
      expect(loop.code).not.toBe(0);
      expect(proxy.requests()).toBe(2);

      // The panel's refusal: another file of the same size.
      const refused = await p.commandFor('c.png', small);
      p.world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.digest });
      const other = await p.run(refused, 'c.png', crypto.randomBytes(3000));
      expect(other.code).not.toBe(0);
      expect(other.out).toContain('its SHA-256 differs');

      // A file one byte longer than an exact number of pieces: the loop would stop at the old end.
      const exact = Buffer.alloc(2 * PIECE, 1);
      const grew = await p.run(await p.commandFor('d.zip', exact), 'd.zip', Buffer.concat([exact, Buffer.from('x')]));
      expect(grew.code).not.toBe(0);
      expect(grew.out).toContain('Not sent: ');
      expect(grew.out).toContain(`is not the ${2 * PIECE} bytes this link is for`);

      // Every piece answered 200 and the last one not finishing the file, as when it shrank meanwhile.
      const before = p.sent().length;
      const shortCommand = await p.commandFor('e.zip', big);
      p.world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 }, { stdout: '', stderr: '', exitCode: 0 });
      const short = await p.run(shortCommand, 'e.zip', big);
      expect(short.code).not.toBe(0);
      expect(short.out).toContain('"written":null');
      expect(short.out).toContain('got shorter while it was sent');
      // Of all of it, only the refused file and the two pieces of the last one reached the site.
      expect(p.sent().slice(before)).toEqual([PIECE, 1000]);
    } finally {
      await proxy.close();
      await p.close();
    }
  });
});

describe('wpl7_api_docs', () => {
  it("gives an endpoint's schema as the live route validates it", async () => {
    const { client } = await panel();
    const { value } = await client('read').call('wpl7_api_docs', { endpoint: 'POST /api/sites' });
    expect(value).toMatchObject({ endpoint: 'POST /api/sites', tool: 'wpl7_api_change', needs: 'Manage' });
    expect(value.schema.body.properties).toHaveProperty('title');
    expect(value.schema.body.required).toEqual(expect.arrayContaining(['title']));
    // Required for a WordPress site only, which the route checks and the docs say: a PHP site has none.
    expect(value.schema.body.properties).toHaveProperty('adminUser');
    expect(value.schema.body.properties.app).toMatchObject({ enum: ['wordpress', 'php', 'container'], default: 'wordpress' });
    // Optional: a create that leaves it out gets the default admin email from Settings.
    expect(value.schema.body.properties).toHaveProperty('adminEmail');
    expect(value.schema.body.required).not.toContain('adminEmail');
  });
});
