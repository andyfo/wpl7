import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { apiEvents, jobs, sites } from '../../src/db/schema.js';
import { FILE_EXIT } from '../../src/services/siteFilesScripts.js';
import type { SiteDirListingDto } from '../../shared/types.js';
import { makeApp, makeWorld, waitFor } from '../helpers.js';

/**
 * The Web FTP routes over the fake Docker: what each request is allowed to do, and what it
 * hands to the container. What the scripts then do with it is test/unit/siteFilesScripts.test.ts.
 */

type World = Awaited<ReturnType<typeof makeWorld>>;

async function siteReady() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  await app.inject({
    method: 'POST',
    url: '/api/sites',
    headers,
    payload: { title: 'My Blog', domainMode: 'dev', adminUser: 'boss', adminEmail: 'boss@example.com' },
  });
  // The worker never runs in API tests; settle the queued create by hand.
  world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
  world.db.update(sites).set({ status: 'running' }).run();
  world.docker.containers.set('wp-my-blog', 'running');
  world.docker.calls = [];
  return { app, world, headers };
}

/** One entry record, as the scripts print it. */
const record = (name: string, opts: { type?: string; size?: number; mode?: string; flags?: string; target?: string } = {}) =>
  `${opts.flags ?? 'rw'}/${opts.type ?? 'f'}/${opts.type === 'l' ? 'f' : (opts.type ?? 'f')}/${opts.size ?? 5}/${opts.mode ?? '644'}/1727000000.25/33/33/${name}/${opts.target ?? ''}\0`;

const callsOf = (world: World, method: string) => world.docker.calls.filter((c) => c.method === method);
/** The positional arguments a script was given (after `sh -c SCRIPT sh`). */
const scriptArgs = (call: { args: unknown[] }) => (call.args[1] as string[]).slice(4);

const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('Web FTP: reading', () => {
  it('lists a folder from inside the container, as www-data', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.streamQueue.push({
      stdout: record('', { type: 'd', mode: '755' }) + record('wp-config.php', { size: 3100, mode: '640' }) + record('uploads', { type: 'd' }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/sites/my-blog/files?path=/wp-content/', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SiteDirListingDto;
    expect(body).toMatchObject({ path: 'wp-content', writable: true, truncated: false });
    expect(body.entries.map((e) => [e.name, e.type, e.mode])).toEqual([
      ['wp-config.php', 'file', '640'],
      ['uploads', 'dir', '644'],
    ]);
    const [call] = callsOf(world, 'execToStream');
    expect(call!.args[0]).toBe('wp-my-blog');
    expect(scriptArgs(call!)).toEqual(['/var/www/html/wp-content', '10002']);
    expect(call!.args[2]).toMatchObject({ user: '33:33', env: expect.arrayContaining(['LC_ALL=C']) });
  });

  it('refuses paths that climb out, before anything runs', async () => {
    const { app, world, headers } = await siteReady();
    for (const path of ['../etc', 'wp-content/../../x', 'a//b', 'a/./b']) {
      const res = await app.inject({ method: 'GET', url: `/api/sites/my-blog/files?path=${encodeURIComponent(path)}`, headers });
      expect(res.statusCode, path).toBe(400);
    }
    expect(world.docker.calls.filter((c) => c.method.startsWith('exec'))).toEqual([]);
  });

  it('needs the site running', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.containers.set('wp-my-blog', 'exited');
    const res = await app.inject({ method: 'GET', url: '/api/sites/my-blog/files', headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/start the site/);
  });

  it('serves raw content as an inert download, with its ETag', async () => {
    const { app, world, headers } = await siteReady();
    const html = '<script>alert(document.cookie)</script>';
    world.docker.streamQueue.push({ stdout: html });
    const res = await app.inject({ method: 'GET', url: '/api/sites/my-blog/files/content?path=evil.html', headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html);
    expect(res.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
      etag: `"${sha(html)}"`,
    });
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="evil.html"/);
  });

  it('refuses raw reads a dev site’s page started, even with the session cookie', async () => {
    const { app, headers } = await siteReady();
    for (const from of ['same-site', 'cross-site']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sites/my-blog/files/content?path=wp-config.php',
        headers: { ...headers, 'sec-fetch-site': from },
      });
      expect(res.statusCode, from).toBe(403);
    }
    const download = await app.inject({
      method: 'GET',
      url: '/api/sites/my-blog/files/download?path=wp-config.php',
      headers: { ...headers, 'sec-fetch-site': 'same-site' },
    });
    expect(download.statusCode).toBe(403);
  });

  it('downloads a file with its length, and the site folder as <slug>.tar.gz', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.execQueue.push({ stdout: 'f 5', stderr: '', exitCode: 0 });
    world.docker.streamQueue.push({ stdout: 'hello' });
    const file = await app.inject({
      method: 'GET',
      url: '/api/sites/my-blog/files/download?path=wp-content/a.txt',
      headers: { ...headers, 'sec-fetch-site': 'same-origin' },
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('hello');
    expect(file.headers['content-length']).toBe('5');
    expect(file.headers['content-disposition']).toMatch(/filename="a.txt"/);

    world.docker.execQueue.push({ stdout: 'd', stderr: '', exitCode: 0 });
    world.docker.streamQueue.push({ stdout: Buffer.from([0x1f, 0x8b]) });
    const folder = await app.inject({ method: 'GET', url: '/api/sites/my-blog/files/download', headers });
    expect(folder.statusCode).toBe(200);
    expect(folder.headers['content-disposition']).toMatch(/filename="my-blog.tar.gz"/);
    const tar = callsOf(world, 'execToStream').at(-1)!;
    expect(scriptArgs(tar)).toEqual(['/var/www', 'html', 'my-blog']);
  });

  it('searches file contents and reports matches by line', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.streamQueue.push({
      // grep runs inside the searched folder, so its paths are relative to it.
      stdout: './plugins/x/evil.php\x0012:eval(base64_decode($_POST["x"]));\n',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sites/my-blog/files/search?path=wp-content&q=base64_decode&mode=content&include=*.php,*.inc',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'content',
      path: 'wp-content',
      matches: [{ path: 'wp-content/plugins/x/evil.php', line: 12, text: 'eval(base64_decode($_POST["x"]));' }],
      truncated: false,
      timedOut: false,
    });
    expect(scriptArgs(callsOf(world, 'execToStream')[0]!)).toEqual([
      '/var/www/html/wp-content',
      'base64_decode',
      '1001',
      '1',
      '0',
      '--include=*.php',
      '--include=*.inc',
    ]);
  });
});

describe('Web FTP: writing', () => {
  it('saves exactly the bytes sent, conditionally on the version that was read', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.execQueue.push({ stdout: record('functions.php', { size: 9 }), stderr: '', exitCode: 0 });
    const body = Buffer.from('<?php //\n');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=wp-content/themes/t/functions.php&lint=php',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'if-match': `"${sha('old')}"` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: 'wp-content/themes/t/functions.php', etag: sha(body), entry: { name: 'functions.php', size: 9 } });
    expect(world.docker.inputs[0]!.equals(body)).toBe(true);
    const [call] = callsOf(world, 'execWithInput');
    expect(scriptArgs(call!)).toEqual([
      '/var/www/html/wp-content/themes/t/functions.php',
      'replace',
      sha('old'),
      String(body.length),
      sha(body),
      'php',
    ]);
    expect(call!.args[2]).toMatchObject({ user: '33:33' });
  });

  it('answers 412 when the file changed, and 422 with the line when PHP does not parse', async () => {
    const { app, world, headers } = await siteReady();
    const put = (extra: Record<string, string> = {}) =>
      app.inject({
        method: 'PUT',
        url: '/api/sites/my-blog/files/content?path=index.php&lint=php',
        headers: { ...headers, 'content-type': 'application/octet-stream', ...extra },
        payload: '<?php }',
      });
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.changed });
    const changed = await put({ 'if-match': `"${sha('x')}"` });
    expect(changed.statusCode).toBe(412);
    expect(changed.json().error.code).toBe('precondition_failed');

    world.docker.execQueue.push({
      stdout: '',
      stderr: 'PHP Parse error:  Unmatched \'}\' in Standard input code on line 1\nErrors parsing Standard input code\n',
      exitCode: FILE_EXIT.syntax,
    });
    const broken = await put();
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error).toMatchObject({ code: 'syntax_error', details: { line: 1 } });
    expect(broken.json().error.message).toMatch(/Unmatched/);
  });

  it('creates only when nothing has the name, with If-None-Match: *', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.exists });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=new.txt',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'if-none-match': '*' },
      payload: '',
    });
    expect(res.statusCode).toBe(412);
    expect(scriptArgs(callsOf(world, 'execWithInput')[0]!)[1]).toBe('create');
  });

  it('takes If-Match: * as "only over a file that exists", never as an ETag', async () => {
    const { app, world, headers } = await siteReady();
    const put = () =>
      app.inject({
        method: 'PUT',
        url: '/api/sites/my-blog/files/content?path=robots.txt',
        headers: { ...headers, 'content-type': 'application/octet-stream', 'if-match': '*' },
        payload: 'User-agent: *',
      });
    world.docker.execQueue.push({ stdout: record('robots.txt', { size: 13 }), stderr: '', exitCode: 0 });
    expect((await put()).statusCode).toBe(200);
    // Replace mode with no version to compare: the script only checks the file is there.
    expect(scriptArgs(callsOf(world, 'execWithInput')[0]!).slice(1, 3)).toEqual(['replace', '-']);

    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.changed });
    const missing = await put();
    expect(missing.statusCode).toBe(412);
    expect(missing.json().error.message).toMatch(/does not exist/);
  });

  it('wants octet-stream, a length, the CSRF header, and a name that is not the panel’s', async () => {
    const { app, headers } = await siteReady();
    const noCsrf = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=a.txt',
      headers: { cookie: headers.cookie, 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    expect(noCsrf.statusCode).toBe(403);
    const text = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=a.txt',
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(text.statusCode).toBe(415);
    const big = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=a.txt',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(8 * 1024 * 1024 + 1),
    });
    expect(big.statusCode).toBe(413);
    const reserved = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=.wpl7-edit.abc',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    expect(reserved.statusCode).toBe(400);
  });

  it('keeps hands off while a restore or a move owns the site, but not during a backup', async () => {
    const { app, world, headers } = await siteReady();
    const site = world.db.select().from(sites).where(eq(sites.slug, 'my-blog')).get()!;
    const job = world.db
      .insert(jobs)
      .values({ type: 'backup.restore', siteId: site.id, siteSlug: site.slug, serverId: 1, payload: '{}', status: 'running', createdAt: Date.now() })
      .returning()
      .get();
    const mkdir = () =>
      app.inject({ method: 'POST', url: '/api/sites/my-blog/files/mkdir', headers, payload: { path: 'wp-content/new' } });
    const busy = await mkdir();
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('job_conflict');

    world.db.update(jobs).set({ type: 'backup.create' }).where(eq(jobs.id, job.id)).run();
    world.docker.execQueue.push({ stdout: record('new', { type: 'd' }), stderr: '', exitCode: 0 });
    expect((await mkdir()).statusCode).toBe(200);
    // Reading never waits for anything.
    world.db.update(jobs).set({ type: 'site.move' }).where(eq(jobs.id, job.id)).run();
    world.docker.streamQueue.push({ stdout: record('', { type: 'd' }) });
    expect((await app.inject({ method: 'GET', url: '/api/sites/my-blog/files', headers })).statusCode).toBe(200);
  });

  it('holds the site until the change is done: a job queued meanwhile waits for it', async () => {
    const { app, world, headers } = await siteReady();
    const site = world.db.select().from(sites).where(eq(sites.slug, 'my-blog')).get()!;
    const status = (id: number) => world.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;
    // Stop the change where it once had no protection: past the job check, looking up the container.
    let reached!: () => void;
    const atLookup = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const containerState = world.docker.containerState.bind(world.docker);
    world.docker.containerState = async (name) => {
      reached();
      await paused;
      return containerState(name);
    };
    world.docker.execQueue.push({ stdout: record('new', { type: 'd' }), stderr: '', exitCode: 0 });
    const mkdir = app.inject({ method: 'POST', url: '/api/sites/my-blog/files/mkdir', headers, payload: { path: 'new' } });
    await atLookup;

    const job = world.worker.enqueue('demo', { steps: 1, stepMs: 0 }, { id: site.id, slug: site.slug, serverId: site.serverId });
    // start() makes its first claim before it returns, and nothing wakes the worker again
    // while the change is paused: one turn of the event loop is as long as any wait here.
    world.worker.start();
    try {
      await new Promise((r) => setImmediate(r));
      expect(status(job.id)).toBe('queued');
      // And with a job waiting, no new change starts: the job goes next.
      world.docker.containerState = containerState;
      const next = await app.inject({ method: 'POST', url: '/api/sites/my-blog/files/mkdir', headers, payload: { path: 'x' } });
      expect(next.json().error.code).toBe('job_conflict');

      resume();
      expect((await mkdir).statusCode).toBe(200);
      await waitFor(() => status(job.id) === 'succeeded');
    } finally {
      await world.worker.stop();
    }
  });

  it('uploads in chunks next to the target, and says where to resume', async () => {
    const { app, world, headers } = await siteReady();
    const id = 'Xr4nd0mUpl0adId_1';
    const chunk = Buffer.from('0123456789');
    const put = (offset: number) =>
      app.inject({
        method: 'PUT',
        url: `/api/sites/my-blog/files/uploads/${id}?path=wp-content/uploads/v.mp4&offset=${offset}&size=30`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: chunk,
      });
    const first = await put(0);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: 10, written: null });
    expect(scriptArgs(callsOf(world, 'execWithInput')[0]!)).toEqual([
      `/var/www/html/wp-content/uploads/.wpl7-upload-${id}.part`,
      '0',
      '10',
      sha(chunk),
      '30',
      '/var/www/html/wp-content/uploads/v.mp4',
      '0',
      String(1024 ** 3),
      // No whole-file SHA-256 to match, and no PHP check: the Files tab uploads what it is given.
      '-',
      '-',
    ]);

    world.docker.execQueue.push({ stdout: '20', stderr: '', exitCode: FILE_EXIT.offset });
    const lost = await put(10);
    expect(lost.statusCode).toBe(409);
    expect(lost.json().error.details).toEqual({ received: 20 });

    world.docker.execQueue.push({ stdout: record('v.mp4', { size: 30 }), stderr: '', exitCode: 0 });
    const last = await put(20);
    expect(last.json()).toMatchObject({ received: 30, written: { path: 'wp-content/uploads/v.mp4', entry: { size: 30 } } });
    // Its answer lost, the client sends the last chunk again: the same answer, and nothing runs.
    const execs = callsOf(world, 'execWithInput').length;
    const again = await put(20);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(last.json());
    expect(callsOf(world, 'execWithInput')).toHaveLength(execs);

    const badId = await app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/uploads/..%2F..%2Fx?path=a&offset=0&size=1',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    expect(badId.statusCode).toBe(400);

    // An empty offset is no offset - not 0, which would start a file over from its first byte.
    const execsBefore = callsOf(world, 'execWithInput').length;
    const noOffset = await app.inject({
      method: 'PUT',
      url: `/api/sites/my-blog/files/uploads/${id}?path=wp-content/uploads/v.mp4&offset=&size=30`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    expect(noOffset.statusCode).toBe(400);
    expect(callsOf(world, 'execWithInput')).toHaveLength(execsBefore);
  });

  it('moves, copies, deletes and changes permissions with the arguments it validated', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.execQueue.push(
      { stdout: record('b.txt'), stderr: '', exitCode: 0 },
      { stdout: record('c.txt'), stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: record('c.txt', { mode: '600' }), stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    );
    const post = (what: string, payload: unknown) =>
      app.inject({ method: 'POST', url: `/api/sites/my-blog/files/${what}`, headers, payload });
    expect((await post('move', { from: 'a.txt', to: 'b.txt' })).json()).toMatchObject({ entry: { name: 'b.txt' } });
    expect((await post('copy', { from: 'b.txt', to: 'c.txt' })).statusCode).toBe(200);
    expect((await post('delete', { paths: ['b.txt', 'old'] })).json()).toEqual({ deleted: 2 });
    expect((await post('chmod', { path: 'c.txt', mode: '600' })).json()).toMatchObject({ entry: { mode: '600' } });
    expect((await post('fix-ownership', {})).statusCode).toBe(200);

    const execs = callsOf(world, 'exec');
    expect(execs.map(scriptArgs)).toEqual([
      ['/var/www/html/a.txt', '/var/www/html/b.txt', '0'],
      ['/var/www/html/b.txt', '/var/www/html/c.txt', String(1024 ** 3)],
      ['/var/www/html/b.txt', '/var/www/html/old'],
      ['/var/www/html/c.txt', '600'],
      ['/var/www/html'],
    ]);
    // Everything as www-data - except handing files back to it, which only root can.
    expect(execs.map((c) => (c.args[2] as { user: string }).user)).toEqual(['33:33', '33:33', '33:33', '33:33', '0:0']);

    expect((await post('delete', { paths: [''] })).statusCode).toBe(400);
    expect((await post('chmod', { path: 'c.txt', mode: '4755' })).statusCode).toBe(400);
    expect((await post('mkdir', { path: 'bad\nname' })).statusCode).toBe(400);
  });

  it('extracts and compresses as jobs, and keeps an archive in one folder', async () => {
    const { app, world, headers } = await siteReady();
    const extract = await app.inject({
      method: 'POST',
      url: '/api/sites/my-blog/files/extract',
      headers,
      payload: { path: 'wp-content/plugins/x.zip', to: 'wp-content/plugins' },
    });
    expect(extract.statusCode).toBe(202);
    expect(extract.headers.location).toMatch(/^\/api\/jobs\/\d+$/);
    const job = world.db.select().from(jobs).where(eq(jobs.type, 'files.extract')).get()!;
    expect(JSON.parse(job.payload)).toMatchObject({ path: 'wp-content/plugins/x.zip', to: 'wp-content/plugins', overwrite: false });

    world.db.update(jobs).set({ status: 'succeeded' }).run();
    const outside = await app.inject({
      method: 'POST',
      url: '/api/sites/my-blog/files/compress',
      headers,
      payload: { paths: ['wp-content/a', 'b'], to: 'wp-content/all.zip' },
    });
    expect(outside.statusCode).toBe(400);
    const notZip = await app.inject({
      method: 'POST',
      url: '/api/sites/my-blog/files/extract',
      headers,
      payload: { path: 'backup.tar.gz' },
    });
    expect(notZip.statusCode).toBe(400);
  });
});

describe('Web FTP with an API key', () => {
  it('works with a key, which leaves a row in the activity log', async () => {
    const { app, world, headers } = await siteReady();
    const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'deployer' } });
    const { token } = created.json() as { token: string };
    world.docker.streamQueue.push({ stdout: record('', { type: 'd' }) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sites/my-blog/files?path=wp-content',
      headers: { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(200);
    const rows = world.db.select().from(apiEvents).all();
    expect(rows.map((r) => [r.method, r.route, r.status])).toContainEqual(['GET', '/api/sites/:slug/files', 200]);
  });
});

describe('Web FTP: upload links', () => {
  /** A link as the API hands it out, for `size` bytes with this SHA-256, at a path whose folder exists. */
  async function link(
    s: Awaited<ReturnType<typeof siteReady>>,
    body: Record<string, unknown>,
    auth: Record<string, string> = s.headers,
  ) {
    return s.app.inject({ method: 'POST', url: '/api/sites/my-blog/files/upload-links', headers: auth, payload: body });
  }
  const send = (s: Awaited<ReturnType<typeof siteReady>>, token: string | undefined, chunk: Buffer, offset?: number) =>
    s.app.inject({
      method: 'PUT',
      url: `/api/file-uploads${offset === undefined ? '' : `?offset=${offset}`}`,
      // No session and no key, and no Content-Type: what `curl -T` sends.
      headers: token === undefined ? {} : { 'x-wpl7-upload-token': token },
      payload: chunk,
    });
  const missing = { stdout: '', stderr: '', exitCode: FILE_EXIT.notFound };

  it('makes a link for one declared file, which puts that file in place and is then spent', async () => {
    const s = await siteReady();
    const { world } = s;
    const data = crypto.randomBytes(30);
    world.docker.execQueue.push(missing, { stdout: record('uploads', { type: 'd' }), stderr: '', exitCode: 0 });
    const made = await link(s, { path: 'wp-content/uploads/plugin.zip', size: 30, sha256: sha(data) });
    expect(made.statusCode).toBe(201);
    const { url, method, header, token, expiresAt, chunkBytes } = made.json() as Record<string, string & number>;
    expect(url).toBe('http://panel.example.test/api/file-uploads');
    expect({ method, header, chunkBytes }).toEqual({ method: 'PUT', header: 'X-WPL7-Upload-Token', chunkBytes: 8 * 1024 * 1024 });
    expect(expiresAt - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(token).toMatch(/^wpl7up_[A-Za-z0-9_-]{43}$/);

    world.docker.calls = [];
    const first = await send(s, token, data.subarray(0, 20), 0);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: 20, written: null, size: 30 });
    const args = scriptArgs(callsOf(world, 'execWithInput')[0]!);
    expect(args[0]).toMatch(/^\/var\/www\/html\/wp-content\/uploads\/\.wpl7-upload-[A-Za-z0-9_-]{24}\.part$/);
    // The whole file's SHA-256 travels with every piece, for the script to hold the last one to.
    expect(args.slice(1)).toEqual(['0', '20', sha(data.subarray(0, 20)), '30', '/var/www/html/wp-content/uploads/plugin.zip', '0', String(1024 ** 3), sha(data), '-']);

    world.docker.execQueue.push({ stdout: record('plugin.zip', { size: 30 }), stderr: '', exitCode: 0 });
    const last = await send(s, token, data.subarray(20), 20);
    expect(last.json()).toMatchObject({ received: 30, size: 30, written: { path: 'wp-content/uploads/plugin.zip', etag: sha(data), entry: { size: 30 } } });

    // The last piece again, its answer lost: the same answer, and nothing runs.
    const execs = callsOf(world, 'execWithInput').length;
    const again = await send(s, token, data.subarray(20), 20);
    expect(again.json()).toEqual(last.json());
    expect(callsOf(world, 'execWithInput')).toHaveLength(execs);
    // Anything else: spent.
    const reuse = await send(s, token, data, 0);
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.message).toMatch(/has been used/);
    expect(callsOf(world, 'execWithInput')).toHaveLength(execs);
  });

  it('opens nothing without its token, and nothing to a key or a session', async () => {
    const s = await siteReady();
    for (const token of [undefined, 'wpl7up_nope', 'x'.repeat(50)]) {
      const res = await send(s, token, Buffer.from('x'));
      expect(res.statusCode).toBe(401);
    }
    const asSession = await s.app.inject({ method: 'PUT', url: '/api/file-uploads', headers: s.headers, payload: Buffer.from('x') });
    expect(asSession.statusCode).toBe(401);
    expect(callsOf(s.world, 'execWithInput')).toEqual([]);
  });

  it('says at once what would refuse the upload: a file in the way, a folder there, no folder to put it in', async () => {
    const s = await siteReady();
    const body = { path: 'wp-content/uploads/logo.png', size: 3, sha256: sha('new') };
    s.world.docker.execQueue.push({ stdout: record('logo.png'), stderr: '', exitCode: 0 });
    const inTheWay = await link(s, body);
    expect(inTheWay.statusCode).toBe(409);
    expect(inTheWay.json().error.message).toMatch(/already exists; send overwrite: true/);

    s.world.docker.execQueue.push({ stdout: record('logo.png'), stderr: '', exitCode: 0 });
    expect((await link(s, { ...body, overwrite: true })).statusCode).toBe(201);

    s.world.docker.execQueue.push({ stdout: record('logo.png', { type: 'd' }), stderr: '', exitCode: 0 });
    expect((await link(s, { ...body, overwrite: true })).json().error.message).toMatch(/is a folder/);

    s.world.docker.execQueue.push(missing, missing);
    const noFolder = await link(s, body);
    expect(noFolder.statusCode).toBe(404);
    expect(noFolder.json().error.message).toBe('The folder "wp-content/uploads" does not exist; create it first');

    // What no link may name: the panel's own temporary files, a bad hash, more than an upload takes.
    for (const bad of [
      { ...body, path: 'wp-content/.wpl7-upload-x.part' },
      { ...body, sha256: 'ABC' },
      { ...body, size: 3 * 1024 ** 3 },
    ]) {
      expect((await link(s, bad)).statusCode).toBe(400);
    }
  });

  it('answers a file that is not the one declared with 400, and checks a PHP file before it takes its place', async () => {
    const s = await siteReady();
    const { world } = s;
    world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'index.php', size: 7, sha256: sha('<?php }') })).json().token as string;
    world.docker.calls = [];
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.digest });
    const wrong = await send(s, token, Buffer.from('<?php {'));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/not the one declared .*SHA-256/);
    expect(scriptArgs(callsOf(world, 'execWithInput')[0]!).slice(-2)).toEqual([sha('<?php }'), 'php']);

    // Not spent by a refusal: the right file can still come.
    world.docker.execQueue.push({ stdout: '', stderr: 'PHP Parse error: syntax error, unexpected token "}" on line 1', exitCode: FILE_EXIT.syntax });
    const broken = await send(s, token, Buffer.from('<?php }'));
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.code).toBe('syntax_error');
  });

  it('wants a file over 8 MiB in pieces, and says how', async () => {
    const s = await siteReady();
    s.world.docker.execQueue.push(missing);
    const size = 9 * 1024 * 1024;
    const token = (await link(s, { path: 'big.zip', size, sha256: sha('x') })).json().token as string;
    const res = await send(s, token, Buffer.alloc(size));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.message).toMatch(/in pieces, in order, each with \?offset=/);
    // An empty offset is no offset - not 0, which would start the file over.
    const empty = await s.app.inject({ method: 'PUT', url: '/api/file-uploads?offset=', headers: { 'x-wpl7-upload-token': token }, payload: 'x' });
    expect(empty.statusCode).toBe(400);
  });

  it('takes a request without an offset as the whole file, and refuses one of another size', async () => {
    const s = await siteReady();
    const { world } = s;
    const data = crypto.randomBytes(30);
    world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'a.zip', size: 30, sha256: sha(data) })).json().token as string;
    world.docker.calls = [];
    // `curl -T` with a file that shrank, or grew, since the link was made.
    for (const sent of [data.subarray(0, 20), Buffer.concat([data, Buffer.from('x')])]) {
      const res = await send(s, token, sent);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(
        `Not saved: the file sent is ${sent.length} bytes, and this link is for one of 30. Ask for a new link with its size and sha256`,
      );
    }
    expect(callsOf(world, 'execWithInput')).toEqual([]);
    // With an offset, the same bytes are the first piece of it.
    expect((await send(s, token, data.subarray(0, 20), 0)).json()).toEqual({ received: 20, written: null, size: 30 });
  });

  it('writes nothing into a site deleted and made again under its name while the request arrived', async () => {
    const s = await siteReady();
    const { app, world, headers } = s;
    world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'a.txt', size: 1, sha256: sha('a') })).json().token as string;
    world.docker.calls = [];
    /** The site goes, and another takes its name: a new id, and the same container name. */
    const replaceSite = () => {
      const old = world.db.select().from(sites).where(eq(sites.slug, 'my-blog')).get()!;
      world.db.delete(sites).where(eq(sites.id, old.id)).run();
      world.db.insert(sites).values({ ...old, id: undefined }).run();
    };

    const piece = new PassThrough();
    const put = app.inject({ method: 'PUT', url: '/api/file-uploads', headers: { 'x-wpl7-upload-token': token, 'content-length': '1' }, payload: piece });
    // The link's site was looked up, and the piece is being read.
    await waitFor(() => world.deps.uploadLinks.find(token)?.busy === true);
    replaceSite();
    piece.end('a');
    const res = await put;
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Site "my-blog" was deleted while this request arrived; nothing was changed');

    // The same for a save addressed by the site's name: the request was for the site it found.
    const lookups = vi.spyOn(world.deps.sites, 'bySlug');
    const body = new PassThrough();
    const save = app.inject({
      method: 'PUT',
      url: '/api/sites/my-blog/files/content?path=new.txt',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '2', 'if-none-match': '*' },
      payload: body,
    });
    await waitFor(() => lookups.mock.calls.length > 0);
    lookups.mockRestore();
    replaceSite();
    body.end('hi');
    expect((await save).statusCode).toBe(404);
    expect(callsOf(world, 'execWithInput')).toEqual([]);
  });

  it('ends a link made in a session when its admin signs out everywhere', async () => {
    const s = await siteReady();
    s.world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'a.bin', size: 1, sha256: sha('a') })).json().token as string;
    expect((await s.app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: s.headers })).statusCode).toBe(204);
    expect((await send(s, token, Buffer.from('a'))).statusCode).toBe(403);
  });

  it('holds each key to 20 unfinished links, which a finished one no longer counts toward', async () => {
    const s = await siteReady();
    const { world } = s;
    const auth = { authorization: `Bearer ${world.deps.apiKeys.create('app', 'manage').token}` };
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) {
      world.docker.execQueue.push(missing);
      const made = await link(s, { path: `f${i}.bin`, size: 1, sha256: sha('x') }, auth);
      expect(made.statusCode, String(i)).toBe(201);
      tokens.push(made.json().token as string);
    }
    world.docker.execQueue.push(missing);
    const over = await link(s, { path: 'more.bin', size: 1, sha256: sha('x') }, auth);
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toMatch(/20 upload links are open already/);
    // Another key, and the panel's admins, have links of their own.
    world.docker.execQueue.push(missing);
    expect((await link(s, { path: 'mine.bin', size: 1, sha256: sha('x') })).statusCode).toBe(201);

    world.docker.execQueue.push({ stdout: record('f0.bin', { size: 1 }), stderr: '', exitCode: 0 });
    expect((await send(s, tokens[0], Buffer.from('x'))).json().written).not.toBeNull();
    world.docker.execQueue.push(missing);
    expect((await link(s, { path: 'more.bin', size: 1, sha256: sha('x') }, auth)).statusCode).toBe(201);
  });

  it('takes one piece at a time, lasts an hour from its last piece, and clears what arrived when it runs out', async () => {
    const s = await siteReady();
    const { world } = s;
    world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'big.bin', size: 20, sha256: sha(Buffer.alloc(20)) })).json().token as string;
    const open = world.deps.uploadLinks.find(token)!;
    open.busy = true;
    const second = await send(s, token, Buffer.alloc(10));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/still arriving/);
    open.busy = false;

    const start = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(start + 50 * 60_000);
      expect((await send(s, token, Buffer.alloc(10), 0)).json()).toMatchObject({ received: 10, written: null });
      // Fifty minutes later: 100 since it was made, 50 since its last piece.
      clock.mockReturnValue(start + 100 * 60_000);
      world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: FILE_EXIT.offset });
      expect((await send(s, token, Buffer.alloc(10), 10)).statusCode).toBe(409);

      world.docker.calls = [];
      clock.mockReturnValue(start + 161 * 60_000);
      expect((await send(s, token, Buffer.alloc(10), 10)).statusCode).toBe(401);
      await waitFor(() => callsOf(world, 'exec').length > 0);
      const abort = callsOf(world, 'exec').at(-1)!;
      expect(scriptArgs(abort)).toEqual([expect.stringMatching(/^\/var\/www\/html\/\.wpl7-upload-[A-Za-z0-9_-]{24}\.part$/)]);
    } finally {
      clock.mockRestore();
    }
  });

  it('answers only the piece that finished it for ten minutes, then nothing', async () => {
    const s = await siteReady();
    s.world.docker.execQueue.push(missing);
    const token = (await link(s, { path: 'a.txt', size: 1, sha256: sha('a') })).json().token as string;
    s.world.docker.execQueue.push({ stdout: record('a.txt', { size: 1 }), stderr: '', exitCode: 0 });
    const done = await send(s, token, Buffer.from('a'));
    expect(done.statusCode).toBe(200);
    // Same offset and length, other bytes: no replay.
    expect((await send(s, token, Buffer.from('b'))).statusCode).toBe(409);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000 + 1);
    try {
      expect((await send(s, token, Buffer.from('a'))).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it('stops working once the key that made it is revoked, the site it was for is gone, or an hour has passed', async () => {
    const s = await siteReady();
    const { app, world, headers } = s;
    const key = (await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'deployer', access: 'manage' } })).json() as {
      id: number;
      token: string;
    };
    world.docker.execQueue.push(missing);
    const made = await link(s, { path: 'a.bin', size: 1, sha256: sha('a') }, { authorization: `Bearer ${key.token}` });
    expect(made.statusCode).toBe(201);
    const token = made.json().token as string;
    world.deps.apiKeys.revoke(key.id);
    const revoked = await send(s, token, Buffer.from('a'));
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error.message).toMatch(/revoked, or is below Manage/);

    // Read only never makes one.
    const reader = world.deps.apiKeys.create('reader', 'read').token;
    expect((await link(s, { path: 'a.bin', size: 1, sha256: sha('a') }, { authorization: `Bearer ${reader}` })).statusCode).toBe(403);

    world.docker.execQueue.push(missing);
    const later = (await link(s, { path: 'b.bin', size: 1, sha256: sha('b') })).json().token as string;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60_000 + 1);
    try {
      expect((await send(s, later, Buffer.from('b'))).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }

    world.docker.execQueue.push(missing);
    const orphan = (await link(s, { path: 'c.bin', size: 1, sha256: sha('c') })).json().token as string;
    // The site deleted, and another made under its name: not the site the link was for.
    world.deps.uploadLinks.find(orphan)!.siteId += 1000;
    expect((await send(s, orphan, Buffer.from('c'))).statusCode).toBe(404);
  });
});
