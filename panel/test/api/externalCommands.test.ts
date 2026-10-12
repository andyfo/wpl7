import { describe, expect, it } from 'vitest';
import { makeApp } from '../helpers.js';
import { externalWorld, runJob } from '../connectWorld.js';

/**
 * Commands, REST requests, WP Godmode and logins on a site hosted elsewhere: the same calls as on
 * a hosted site, answered through WPL7 Connect (option B, registered commands).
 */

async function app(opts: Parameters<typeof externalWorld>[0] = {}) {
  const ext = await externalWorld(opts);
  const { app } = await makeApp(ext.w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  return { ...ext, app, headers };
}

describe('commands and requests on a site hosted elsewhere', () => {
  it('runs a command a plugin registered, with its stdin and global flags passed on', async () => {
    const { app: a, headers, fake } = await app();
    const seen: { args: string[]; stdin: string | null }[] = [];
    fake.registerCommand('hello', 'Says hello', (args, stdin) => {
      seen.push({ args, stdin });
      return { stdout: `Hello ${args[1] ?? 'world'}\n`, stderr: '', exitCode: 0 };
    });
    const res = await a.inject({ method: 'POST', url: '/api/sites/shop/wp/cli', headers, payload: { args: ['hello', 'there', '--user=admin'], stdin: 'input' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stdout: 'Hello there\n', stderr: '', exitCode: 0 });
    expect(seen).toEqual([{ args: ['hello', 'there', '--user=admin'], stdin: 'input' }]);
  });

  it('answers a command nobody registered as WP-CLI answers an unknown one', async () => {
    const { app: a, headers } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/sites/shop/wp/cli', headers, payload: { args: ['plugin', 'list'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 1, stdout: '' });
    expect(res.json().stderr).toBe(
      "Error: 'plugin' is not a registered wp command on this external site. Only commands a plugin registered with WPL7 Connect run here; GET /api/sites/shop/wp/cli/help lists them.\n",
    );
    // Godmode's endpoints turn that into the 409 a site without WP Godmode gets.
    const godmode = await a.inject({ method: 'GET', url: '/api/sites/shop/godmode/chats', headers });
    expect(godmode.statusCode).toBe(409);
    expect(godmode.json().error.message).toMatch(/WP Godmode is not installed/);
  });

  it('lists the registered commands and shows their help', async () => {
    const { app: a, headers, fake } = await app();
    fake.registerCommand('hello', 'Says hello', () => ({ stdout: '', stderr: '', exitCode: 0 }), 'NAME\n\n  wp hello\n');
    const list = await a.inject({ method: 'GET', url: '/api/sites/shop/wp/cli/help', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().help).toContain('hello  Says hello');
    const one = await a.inject({ method: 'GET', url: '/api/sites/shop/wp/cli/help?command=hello', headers });
    expect(one.json()).toEqual({ command: 'hello', help: 'NAME\n\n  wp hello' });
    const none = await a.inject({ method: 'GET', url: '/api/sites/shop/wp/cli/help?command=core', headers });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.message).toMatch(/no plugin here registered it with WPL7 Connect/);
  });

  it('queues a command as a job in the external lanes', async () => {
    const { app: a, headers, fake, w, site } = await app();
    fake.registerCommand('hello', 'Says hello', () => ({ stdout: 'one\ntwo\n', stderr: '', exitCode: 0 }));
    const res = await a.inject({ method: 'POST', url: '/api/sites/shop/wp/cli', headers, payload: { args: ['hello'], async: true } });
    expect(res.statusCode, res.body).toBe(202);
    const jobId = res.json().job.id as number;
    const { job, log } = await runJob(w, jobId);
    expect(job.lane).toBe(`external-${site.id % 2}`);
    expect(job.status, log.join('\n')).toBe('succeeded');
    expect(log).toEqual(expect.arrayContaining(['info: $ wp hello', 'info: one', 'info: two', 'info: Finished (exit code 0).']));
  });

  it("drives WP Godmode with the hosted site's calls, a long wait split into steps the host lets through", async () => {
    const { app: a, headers, fake } = await app();
    const calls: string[][] = [];
    let waits = 0;
    fake.registerCommand('godmode', 'Drive WP Godmode', (args) => {
      calls.push(args);
      if (args[2] === 'wait') {
        waits++;
        const state = waits < 2 ? 'working' : 'idle';
        return { stdout: `${JSON.stringify({ ok: true, state, after: waits })}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: `${JSON.stringify({ ok: true, chats: [] })}\n`, stderr: '', exitCode: 0 };
    });
    const list = await a.inject({ method: 'GET', url: '/api/sites/shop/godmode/chats', headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ ok: true, chats: [] });
    const chat = '0d9a3d39-5c3b-4c55-9f2e-56a6f1a3e0b1';
    const wait = await a.inject({ method: 'GET', url: `/api/sites/shop/godmode/chats/${chat}?wait=40`, headers });
    expect(wait.statusCode, wait.body).toBe(200);
    expect(wait.json()).toMatchObject({ ok: true, state: 'idle' });
    const waitCalls = calls.filter((c) => c[2] === 'wait');
    expect(waitCalls).toHaveLength(2);
    expect(waitCalls[0]).toContain('--timeout=25');
    expect(waitCalls[1]!.find((x) => x.startsWith('--timeout='))).toMatch(/^--timeout=1[0-5]$/);
  });

  it('sends a REST request through the bridge, as the user the auth names', async () => {
    const { app: a, headers, fake } = await app();
    fake.restAnswers.set('GET /wp/v2/users/me', { status: 200, body: { id: 1, name: 'Admin' }, headers: { 'x-wp-total': '1' } });
    const res = await a.inject({
      method: 'POST',
      url: '/api/sites/shop/wp/rest',
      headers,
      payload: { method: 'GET', route: 'wp/v2/users/me?context=edit', auth: { username: 'admin', applicationPassword: 'not needed here' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 200, contentType: 'application/json; charset=UTF-8', body: '{"id":1,"name":"Admin"}', truncated: false });
    expect(fake.restCalls).toEqual([{ method: 'GET', route: '/wp/v2/users/me', query: 'context=edit', body: undefined, user: 'admin' }]);
  });

  it('mints a login link as the administrator the site acts as', async () => {
    const { app: a, headers, fake } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/sites/shop/wp/admin-login', headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ user: 'admin', expiresInSeconds: 120, url: expect.stringMatching(/^https:\/\/shop\.example\.org\/\?wpl7-connect-login=[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/) });
    expect(fake.logins).toHaveLength(1);
  });

  it('refuses the hosted-only WordPress routes', async () => {
    const { app: a, headers } = await app();
    for (const [method, url, payload] of [
      ['GET', '/api/sites/shop/wp/plugins', undefined],
      ['GET', '/api/sites/shop/wp/maintenance', undefined],
      ['POST', '/api/sites/shop/wp/users/reset-password', { user: 'admin' }],
      ['POST', '/api/sites/shop/wp/test-email', { to: 'someone@example.org' }],
    ] as const) {
      const res = await a.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect([url, res.statusCode]).toEqual([url, 409]);
    }
  });
});
