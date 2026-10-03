/**
 * The whole OAuth round trip an app makes, over HTTP: register in the window, get approved,
 * trade the code, call tools, refresh, disconnect - and every way the token endpoint says no.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jobs, sites } from '../../src/db/schema.js';
import type { ApiActivityDto } from '../../shared/types.js';
import { makeApp, makeWorld, mcpClient } from '../helpers.js';

const REDIRECT = 'http://127.0.0.1:33418/callback';

async function connected(access: 'read' | 'manage' | 'full' = 'manage') {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  world.deps.settings.set('mcpEnabled', true);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const session = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };

  await app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers: session });
  const registered = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'] }),
  });
  const clientId = registered.json().client_id as string;
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // The app listens on whatever port it got: 33418 today, registered without one.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'http://panel.example.test/mcp',
  }).toString();
  const decided = await app.inject({
    method: 'POST',
    url: '/api/oauth/authorize/decision',
    headers: session,
    payload: { query, approve: true, access },
  });
  const code = new URL(decided.json().redirectTo).searchParams.get('code')!;
  const form = (fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  return { app, world, session, clientId, code, verifier, form };
}

describe('the token endpoint', () => {
  it('trades the code for tokens that work at /mcp, as the connected app', async () => {
    const { app, world, session, clientId, code, verifier, form } = await connected('manage');
    const res = await form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    const tokens = res.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'wpl7:read wpl7:manage' });

    const now = Date.now();
    world.db
      .insert(sites)
      .values({ slug: 'alpha', title: 'a', domains: '["alpha.test"]', phpVersion: '8.3', status: 'running', dbName: 'a', dbUser: 'a', dbPassword: 'x', containerName: 'wp-alpha', createdAt: now, updatedAt: now })
      .run();
    world.docker.containers.set('wp-alpha', 'running');
    const mcp = mcpClient(app, { authorization: `Bearer ${tokens.access_token}` });
    expect((await mcp.tools()).sort()).toEqual([
      'wpl7_api_change',
      'wpl7_api_dangerous',
      'wpl7_api_docs',
      'wpl7_api_get',
      'wpl7_read_site_file',
      'wpl7_wait_for_job',
      'wpl7_write_site_file',
    ]);
    const restart = await mcp.call('wpl7_api_change', { method: 'POST', path: '/api/sites/alpha/restart' });
    expect(restart.value.body.job).toMatchObject({ origin: 'mcp', createdBy: 'Claude Code via MCP (approved by admin)' });
    expect(world.db.select().from(jobs).get()!.createdBy).toBe('Claude Code via MCP (approved by admin)');

    const activity = (await app.inject({ method: 'GET', url: '/api/api-keys/activity', headers: session })).json() as ApiActivityDto;
    expect(activity.items[0]).toMatchObject({ keyId: null, keyName: 'Claude Code', via: 'mcp', tool: 'wpl7_api_change', connectionId: expect.any(Number) });

    // Never a key for the REST API.
    const rest = await app.inject({ method: 'GET', url: '/api/sites', headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(rest.statusCode).toBe(401);
  });

  it('refreshes, rotating the refresh token, and disconnects on revoke', async () => {
    const { app, clientId, code, verifier, form } = await connected();
    const first = (await form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier })).json();
    const second = await form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
    expect(second.statusCode).toBe(200);
    expect(second.json().refresh_token).not.toBe(first.refresh_token);

    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token: second.json().refresh_token, client_id: clientId }).toString(),
    });
    expect(revoked.statusCode).toBe(200);
    const after = await mcpClient(app, { authorization: `Bearer ${second.json().access_token}` }).send('tools/list');
    expect(after.res.statusCode).toBe(401);
    expect(after.res.headers['www-authenticate']).toMatch(/error="invalid_token"/);
    // Revoking what does not exist is still "done".
    const nothing = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=wpl7rt_nope',
    });
    expect(nothing.statusCode).toBe(200);
  });

  it('says no in OAuth’s words, with the right status for each', async () => {
    const { app, clientId, code, verifier, form } = await connected();
    const cases: [Record<string, string>, number, string][] = [
      [{ grant_type: 'password', username: 'a', password: 'b' }, 400, 'unsupported_grant_type'],
      [{ grant_type: 'authorization_code', client_id: 'wpl7ci_unknown', code, code_verifier: verifier }, 401, 'invalid_client'],
      [{ grant_type: 'authorization_code', client_id: clientId, code: 'wpl7ac_forged', code_verifier: verifier }, 400, 'invalid_grant'],
      [{ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, resource: 'https://other.example/mcp' }, 400, 'invalid_target'],
      [{ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'wpl7rt_forged' }, 400, 'invalid_grant'],
    ];
    for (const [fields, status, error] of cases) {
      const res = await form(fields);
      expect(res.statusCode, error).toBe(status);
      expect(res.json(), error).toMatchObject({ error, error_description: expect.any(String) });
    }

    const json = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier }),
    });
    expect(json.statusCode).toBe(400);
    expect(json.json().error).toBe('invalid_request');
    const twice = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&client_id=${clientId}&code=${code}&code=${code}&code_verifier=${verifier}`,
    });
    expect(twice.json()).toMatchObject({ error: 'invalid_request', error_description: 'Sent more than once: code' });
  });

  it('ends the connection when a code comes back a second time', async () => {
    const { app, clientId, code, verifier, form } = await connected();
    const first = (await form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier })).json();
    expect((await form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier })).json().error).toBe('invalid_grant');
    const mcp = await mcpClient(app, { authorization: `Bearer ${first.access_token}` }).send('tools/list');
    expect(mcp.res.statusCode).toBe(401);
  });
});
