import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { execLane } from '../../src/jobs/lanes.js';
import { jobToDto } from '../../src/lib/dto.js';
import { curlConfig, parseCurlOutput, restRequestUrl, wpErrorOf, type WpRestCall } from '../../src/services/wpRest.js';
import { curlAnswer, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const PASSWORD = 'abcd EFGH ijkl MNOP qrst UVWX';

/** The value of a quoted curl config line, unescaped the way curl(1) reads it. */
function configValue(config: string, option: string, nth = 0): string | undefined {
  const lines = config.split('\n').filter((l) => l.startsWith(`${option} = "`));
  const line = lines[nth];
  if (!line) return undefined;
  const quoted = line.slice(option.length + 4, -1);
  return quoted.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', v: '\v' })[c] ?? c);
}

const headersOf = (config: string) =>
  config
    .split('\n')
    .filter((l) => l.startsWith('header = '))
    .map((_, i) => configValue(config, 'header', i)!);

const call = (over: Partial<WpRestCall> = {}): WpRestCall => ({
  method: 'GET',
  route: 'wp/v2/posts',
  host: 'shop.example.com',
  https: true,
  timeoutMs: 60_000,
  bodyCap: 1024 * 1024,
  ...over,
});

describe('the request curl is given', () => {
  it('asks the site itself through ?rest_route=, which needs no pretty permalinks', () => {
    expect(restRequestUrl('wp/v2/posts?per_page=5')).toBe('http://127.0.0.1/?rest_route=/wp/v2/posts&per_page=5');
    expect(restRequestUrl('/wp-json/wp/v2/posts')).toBe('http://127.0.0.1/?rest_route=/wp/v2/posts');
    expect(restRequestUrl('wp-json')).toBe('http://127.0.0.1/?rest_route=/');
    // What would end the value early is escaped; an escape already there is left alone.
    expect(restRequestUrl('shop/v1/a+b&c=d/caf%C3%A9')).toBe('http://127.0.0.1/?rest_route=/shop/v1/a%2Bb%26c%3Dd/caf%C3%A9');
    expect(restRequestUrl('shop/v1/café')).toBe('http://127.0.0.1/?rest_route=/shop/v1/caf%C3%A9');
    // The query string is the caller's, brackets and all (curl's globbing is off).
    expect(restRequestUrl('wp/v2/posts?filter[status]=draft')).toBe(
      'http://127.0.0.1/?rest_route=/wp/v2/posts&filter[status]=draft',
    );
  });

  it("sends the site's hostname, JSON, and nothing it was not asked for", () => {
    const config = curlConfig(call());
    expect(configValue(config, 'url')).toBe('http://127.0.0.1/?rest_route=/wp/v2/posts');
    expect(configValue(config, 'request')).toBe('GET');
    expect(headersOf(config)).toEqual(['Host: shop.example.com', 'Accept: application/json', 'X-Forwarded-Proto: https']);
    expect(config).not.toContain('data-raw');
    expect(config.split('\n')).toEqual(expect.arrayContaining(['globoff', 'noproxy = "*"', 'max-time = 60']));
    // Plain HTTP and nobody signed in: nothing claims otherwise.
    expect(headersOf(curlConfig(call({ https: false })))).not.toContain('X-Forwarded-Proto: https');
  });

  it('signs in with HTTP Basic, and says HTTPS so WordPress accepts the application password', () => {
    const config = curlConfig(call({ https: false, auth: { username: 'editor', applicationPassword: PASSWORD } }));
    const headers = headersOf(config);
    expect(headers).toContain('X-Forwarded-Proto: https');
    const basic = headers.find((h) => h.startsWith('Authorization: Basic '))!;
    expect(Buffer.from(basic.slice('Authorization: Basic '.length), 'base64').toString()).toBe(`editor:${PASSWORD}`);
  });

  it('carries a JSON body through the config quoting unchanged', () => {
    const body = { title: 'He said "hi"', path: 'C:\\temp\\new', lines: 'one\ntwo\ttab', at: '@/etc/passwd' };
    const config = curlConfig(call({ method: 'POST', body }));
    expect(configValue(config, 'request')).toBe('POST');
    expect(headersOf(config)).toContain('Content-Type: application/json');
    expect(JSON.parse(configValue(config, 'data-raw')!)).toEqual(body);
    // One option per line: nothing in the body can start a line of its own.
    expect(config.split('\n').filter((l) => l.startsWith('data-raw'))).toHaveLength(1);
  });
});

describe("reading curl's answer", () => {
  it('takes the status, the headers and the body', () => {
    const res = parseCurlOutput(
      curlAnswer({ body: '[{"id":1}]', headers: { 'x-wp-total': ['12'], link: ['<a>; rel="next"', '<b>; rel="last"'] } }),
    );
    expect(res).toMatchObject({
      status: 200,
      statusText: 'OK',
      contentType: 'application/json; charset=UTF-8',
      body: '[{"id":1}]',
      truncated: false,
      sizeBytes: 10,
      durationMs: 42,
      error: null,
    });
    expect(res.headers).toMatchObject({ 'x-wp-total': '12', link: '<a>; rel="next", <b>; rel="last"' });
  });

  it('tells no answer at all from an answer', () => {
    const refused = parseCurlOutput(
      curlAnswer({ status: 0, exitCode: 7, errormsg: 'Failed to connect to 127.0.0.1 port 80 after 0 ms: Could not connect to server' }),
    );
    expect(refused).toMatchObject({ status: null, error: expect.stringMatching(/^Failed to connect/) });
    // curl missing from the image: no write-out at all, only the runtime's complaint.
    const missing = parseCurlOutput({ stdout: '', stderr: 'exec: "curl": executable file not found in $PATH', exitCode: 127 });
    expect(missing).toMatchObject({ status: null, error: 'exec: "curl": executable file not found in $PATH' });
  });

  it('knows when the body was cut', () => {
    const cut = parseCurlOutput({ ...curlAnswer({ body: 'x'.repeat(10), sizeDownload: 5000 }), stdout: `${'x'.repeat(10)}\n…[output truncated]` });
    expect(cut).toMatchObject({ body: 'x'.repeat(10), truncated: true, sizeBytes: 5000 });
  });

  it("puts WordPress's own error into words", () => {
    const body = JSON.stringify({ code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.', data: { status: 401 } });
    expect(wpErrorOf({ body, contentType: 'application/json' })).toBe('Sorry, you are not allowed to do that. (rest_forbidden)');
    expect(wpErrorOf({ body: '<h1>Error</h1>', contentType: 'text/html' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------- as a job

function addSite(w: TestWorld, slug: string, status = 'running'): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.example.com`, `www.${slug}.example.com`]),
      phpVersion: '8.3',
      status,
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, status === 'running' ? 'running' : 'exited');
  return site;
}

function queue(w: TestWorld, site: SiteRow, payload: Record<string, unknown>) {
  return w.worker.enqueue('wp.rest', { siteId: site.id, method: 'GET', timeoutMin: 10, ...payload }, { id: site.id, slug: site.slug }, {
    lane: execLane(site.serverId),
    siteSlug: site.slug,
  });
}

async function run(w: TestWorld, id: number) {
  w.worker.start();
  await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status), 10_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).orderBy(asc(jobLogs.id)).all().map((l) => l.message);

const curlCalls = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'execWithInput') as { method: string; args: [string, string[], Record<string, unknown>] }[];

describe('REST requests as jobs', () => {
  it("asks the site from inside its container and keeps the answer in the log", async () => {
    const w = await makeWorld();
    const site = addSite(w, 'shop');
    w.docker.execQueue.push(curlAnswer({ body: '[{"id":1,"title":"Hello"}]', headers: { 'x-wp-total': ['1'], 'x-wp-totalpages': ['1'] } }));
    const job = queue(w, site, { route: 'wp/v2/posts?per_page=1' });
    expect(job.summary).toBe('GET /wp-json/wp/v2/posts?per_page=1');
    const done = await run(w, job.id);

    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(JSON.parse(done.result!)).toEqual({ status: 200, contentType: 'application/json; charset=UTF-8', sizeBytes: 26, truncated: false });
    const [name, cmd, opts] = curlCalls(w).at(-1)!.args;
    expect(name).toBe('wp-shop');
    expect(cmd).toEqual(['curl', '-q', '--config', '-']);
    expect(opts).toMatchObject({ user: '33:33', env: ['HOME=/tmp'] });
    const config = w.docker.inputs.at(-1)!.toString();
    // The primary hostname - what the site's WordPress URLs are - not an alias.
    expect(headersOf(config)).toContain('Host: shop.example.com');
    expect(configValue(config, 'url')).toBe('http://127.0.0.1/?rest_route=/wp/v2/posts&per_page=1');

    const log = logOf(w, job.id);
    expect(log[0]).toBe('GET /wp-json/wp/v2/posts?per_page=1 · not signed in');
    expect(log[1]).toMatch(/^HTTP 200 OK · application\/json; charset=UTF-8 · 26 bytes · 42 ms$/);
    expect(log).toContain('X-WP-Total: 1 · X-WP-TotalPages: 1');
    // Indented, one value per line.
    expect(log).toEqual(expect.arrayContaining(['[', '  {', '    "id": 1,', '    "title": "Hello"', '  }', ']']));
    expect(log.at(-1)).toBe('Finished (HTTP 200).');
  });

  it('signs in with the application password without ever showing it', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'shop');
    // An endpoint that echoes what it was sent, credentials and all.
    const token = Buffer.from(`editor:${PASSWORD}`).toString('base64');
    w.docker.execQueue.push(
      curlAnswer({ status: 201, body: JSON.stringify({ id: 7, seen: `Basic ${token}`, pw: PASSWORD.replace(/ /g, '') }) }),
    );
    const job = queue(w, site, {
      method: 'POST',
      route: '/wp-json/shop/v1/sync?api_key=k-123456789',
      body: { since: '15m' },
      auth: { username: 'editor', applicationPassword: PASSWORD },
    });
    const done = await run(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');

    const config = w.docker.inputs.at(-1)!.toString();
    expect(headersOf(config)).toContain(`Authorization: Basic ${token}`);
    expect(JSON.parse(configValue(config, 'data-raw')!)).toEqual({ since: '15m' });
    // Nothing that is stored for reading or shown anywhere carries it.
    const log = logOf(w, job.id);
    const shown = JSON.stringify([log, jobToDto(done), curlCalls(w).map((c) => c.args)]);
    for (const secret of [PASSWORD, PASSWORD.replace(/ /g, ''), token, 'k-123456789']) {
      expect(shown).not.toContain(secret);
    }
    expect(done.summary).toBe('POST /wp-json/shop/v1/sync?api_key=••• as editor');
    expect(log[0]).toBe('POST /wp-json/shop/v1/sync?api_key=••• · as "editor" (application password) · JSON body, 15 bytes');
    // Nor is it kept once the job is over: the stored payload has no password left in it.
    expect(JSON.parse(done.payload)).not.toHaveProperty('auth');
    expect(done.payload).not.toContain(PASSWORD);
  });

  it("fails on anything but a 2xx answer, in WordPress's words", async () => {
    const w = await makeWorld();
    const site = addSite(w, 'shop');
    // What WordPress 7.1 answers a rejected application password with: as if none had been sent.
    const signedOut = { code: 'rest_not_logged_in', message: 'You are not currently logged in.', data: { status: 401 } };
    w.docker.execQueue.push(curlAnswer({ status: 401, body: JSON.stringify(signedOut) }));
    const job = queue(w, site, { route: 'wp/v2/users/me', auth: { username: 'editor', applicationPassword: 'wrong wrong wrong' } });
    const done = await run(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toBe(
      'The site answered HTTP 401 Unauthorized: You are not currently logged in. (rest_not_logged_in)' +
        ' - WordPress did not accept the application password for "editor"',
    );
    expect(JSON.parse(done.result!)).toMatchObject({ status: 401 });

    w.docker.execQueue.push(curlAnswer({ status: 404, body: JSON.stringify({ code: 'rest_no_route', message: 'No route was found.' }) }));
    const missing = await run(w, queue(w, site, { route: 'nope/v1/thing' }).id);
    expect(missing.error).toBe('The site answered HTTP 404 Not Found: No route was found. (rest_no_route)');
  });

  it('fails when nothing answers, with the reason', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'shop');
    w.docker.execQueue.push(curlAnswer({ status: 0, exitCode: 28, errormsg: 'Operation timed out after 60001 milliseconds with 0 bytes received' }));
    const done = await run(w, queue(w, site, { route: 'slow/v1/report' }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toBe('The request did not complete: Operation timed out after 60001 milliseconds with 0 bytes received');
  });

  it('refuses a stopped site instead of starting it', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'asleep', 'stopped');
    const done = await run(w, queue(w, site, { route: 'wp/v2/posts' }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/not running; start the site first/);
    expect(curlCalls(w)).toHaveLength(0);
  });
});
