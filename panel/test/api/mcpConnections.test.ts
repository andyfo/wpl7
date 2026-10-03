/**
 * The MCP page's data and controls: the switch, the connection window, and the connected apps
 * - whose access changes take effect on their next call, and whose revocation is immediate.
 */
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import type { McpPageDto } from '../../shared/types.js';
import { makeApp, makeWorld, mcpClient } from '../helpers.js';

async function panel() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const signIn = async (username: string, password: string) => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    return { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  };
  const session = await signIn('admin', 'correct-horse-battery');
  const page = async (headers = session) => (await app.inject({ method: 'GET', url: '/api/mcp', headers })).json() as McpPageDto;
  /** Connect an app as the admin behind `headers`; its access token. */
  const connect = async (name: string, access: 'read' | 'manage' | 'full', headers = session) => {
    await app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers });
    const clientId = (
      await app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ client_name: name, redirect_uris: ['https://claude.ai/cb'] }),
      })
    ).json().client_id as string;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const decided = await app.inject({ method: 'POST', url: '/api/oauth/authorize/decision', headers, payload: { query, approve: true, access } });
    const code = new URL(decided.json().redirectTo).searchParams.get('code')!;
    const tokens = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier }).toString(),
    });
    return tokens.json().access_token as string;
  };
  return { app, world, session, signIn, page, connect };
}

describe('the MCP page', () => {
  it('is switched on through the settings, and then gives the URL to hand an app', async () => {
    const { app, session, page } = await panel();
    expect(await page()).toMatchObject({ enabled: false, unavailable: null, url: 'http://panel.example.test/mcp', window: null, connections: [] });
    const on = await app.inject({ method: 'PUT', url: '/api/settings', headers: session, payload: { mcpEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect((await page()).enabled).toBe(true);
  });

  it('will not open a connection window while MCP is off', async () => {
    const { app, session } = await panel();
    const res = await app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers: session });
    expect(res.statusCode).toBe(409);
  });

  it('shows the open window, the app that registered in it, and closes it', async () => {
    const { app, world, session, page } = await panel();
    world.deps.settings.set('mcpEnabled', true);
    const opened = await app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers: session });
    expect(opened.json().window).toMatchObject({ byMe: true, openedBy: 'admin', registered: null });
    await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
    });
    expect((await page()).window).toMatchObject({ registered: { name: 'Claude', redirectHosts: ['claude.ai'] } });

    // Not the app being connected: discard it, and the window takes another.
    const discarded = await app.inject({ method: 'DELETE', url: '/api/mcp/connect-window/registration', headers: session });
    expect(discarded.statusCode).toBe(204);
    expect((await page()).window).toMatchObject({ registered: null });
    const again = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
    });
    expect(again.statusCode).toBe(201);
    const key = { authorization: `Bearer ${world.deps.apiKeys.create('ci', 'full').token}` };
    expect((await app.inject({ method: 'DELETE', url: '/api/mcp/connect-window/registration', headers: key })).statusCode).toBe(403);

    expect((await app.inject({ method: 'DELETE', url: '/api/mcp/connect-window', headers: session })).statusCode).toBe(204);
    expect((await page()).window).toBeNull();
  });

  it('lists connections with who approved them, and changes their access on the next call', async () => {
    const { app, world, session, page, connect } = await panel();
    world.deps.settings.set('mcpEnabled', true);
    const token = await connect('Claude', 'read');
    const [connection] = (await page()).connections;
    expect(connection).toMatchObject({ app: 'Claude', redirectHost: 'claude.ai', approvedBy: { username: 'admin' }, access: 'read' });

    const mcp = mcpClient(app, { authorization: `Bearer ${token}` });
    expect(await mcp.tools()).not.toContain('wpl7_api_change');
    const raised = await app.inject({
      method: 'PATCH',
      url: `/api/mcp/connections/${connection!.id}`,
      headers: session,
      payload: { access: 'manage' },
    });
    expect(raised.json().connection.access).toBe('manage');
    expect(await mcp.tools()).toContain('wpl7_api_change');

    // Its calls show on the page.
    await mcp.call('wpl7_api_get', { path: '/api/sites' });
    expect((await page()).activity[0]).toMatchObject({ via: 'mcp', tool: 'wpl7_api_get', connectionId: connection!.id });
  });

  it('revokes at once', async () => {
    const { app, world, session, page, connect } = await panel();
    world.deps.settings.set('mcpEnabled', true);
    const token = await connect('Claude', 'full');
    const id = (await page()).connections[0]!.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/mcp/connections/${id}`, headers: session })).statusCode).toBe(204);
    expect((await mcpClient(app, { authorization: `Bearer ${token}` }).send('tools/list')).res.statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/api/mcp/connections/${id}`, headers: session })).statusCode).toBe(404);
  });

  it("pauses the connections while MCP is off, and deletes none of them", async () => {
    const { app, world, session, page, connect } = await panel();
    world.deps.settings.set('mcpEnabled', true);
    const token = await connect('Claude', 'read');
    await app.inject({ method: 'PUT', url: '/api/settings', headers: session, payload: { mcpEnabled: false } });
    expect((await mcpClient(app, { authorization: `Bearer ${token}` }).send('tools/list')).res.statusCode).toBe(404);
    expect((await page()).connections).toHaveLength(1);
    await app.inject({ method: 'PUT', url: '/api/settings', headers: session, payload: { mcpEnabled: true } });
    expect((await mcpClient(app, { authorization: `Bearer ${token}` }).send('tools/list')).res.statusCode).toBe(200);
  });

  it("removes an admin's connections with the admin; a password change leaves them", async () => {
    const { app, world, session, signIn, page, connect } = await panel();
    world.deps.settings.set('mcpEnabled', true);
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: session,
      payload: { username: 'colleague', password: 'colleague-password-1' },
    });
    expect(created.statusCode).toBe(201);
    const colleague = await signIn('colleague', 'colleague-password-1');
    const theirs = await connect('Cursor', 'read', colleague);
    const mine = await connect('Claude', 'read');
    expect((await page()).connections.map((c) => c.app).sort()).toEqual(['Claude', 'Cursor']);

    const owner = world.deps.users.owner()!;
    world.deps.users.setPasswordHash(owner.id, await argon2.hash('a-new-password-2'));
    expect((await mcpClient(app, { authorization: `Bearer ${mine}` }).send('tools/list')).res.statusCode).toBe(200);

    await app.inject({ method: 'DELETE', url: `/api/users/${created.json().id}`, headers: session });
    expect((await mcpClient(app, { authorization: `Bearer ${theirs}` }).send('tools/list')).res.statusCode).toBe(401);
    expect((await page()).connections.map((c) => c.app)).toEqual(['Claude']);
  });
});
