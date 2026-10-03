/**
 * How an app finds the panel's sign-in (RFC 9728, RFC 8414) and registers (RFC 7591): only
 * while MCP is on, only in a connection window, and in OAuth's own dialect.
 */
import { describe, expect, it } from 'vitest';
import { oauthClients } from '../../src/db/schema.js';
import { MAX_CLIENTS } from '../../src/services/oauth.js';
import { makeApp, makeWorld } from '../helpers.js';

async function panel(opts: { enabled?: boolean } = {}) {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  if (opts.enabled !== false) world.deps.settings.set('mcpEnabled', true);
  const admin = world.deps.users.owner()!;
  return { app, world, openWindow: () => world.deps.oauth.openWindow(admin.id) };
}

const register = (app: Awaited<ReturnType<typeof panel>>['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });

const claude = { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };

describe('OAuth discovery', () => {
  it('says where to sign in, with one issuer everywhere', async () => {
    const { app } = await panel();
    const resource = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(resource.statusCode).toBe(200);
    expect(resource.json()).toEqual({
      resource: 'http://panel.example.test/mcp',
      authorization_servers: ['http://panel.example.test'],
      scopes_supported: ['wpl7:read', 'wpl7:manage', 'wpl7:full'],
      bearer_methods_supported: ['header'],
      resource_name: 'WPL7',
    });
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json()).toEqual(resource.json());

    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server).toMatchObject({
      issuer: 'http://panel.example.test',
      authorization_endpoint: 'http://panel.example.test/oauth/authorize',
      token_endpoint: 'http://panel.example.test/oauth/token',
      registration_endpoint: 'http://panel.example.test/oauth/register',
      revocation_endpoint: 'http://panel.example.test/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
    // Client ID metadata documents are the one feature that fetches a URL a stranger chose: not yet.
    expect(server).not.toHaveProperty('client_id_metadata_document_supported');
  });

  it('does not exist while MCP is off', async () => {
    const { app } = await panel({ enabled: false });
    for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await register(app, claude)).statusCode).toBe(404);
    const token = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token' });
    expect(token.statusCode).toBe(404);
  });
});

describe('registration', () => {
  it('is refused while no connection window is open', async () => {
    const { app } = await panel();
    const res = await register(app, claude);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'access_denied', error_description: expect.stringContaining('Connect an app') });
  });

  it('registers one public client per window, ignoring what it does not know', async () => {
    const { app, world, openWindow } = await panel();
    openWindow();
    const res = await register(app, {
      ...claude,
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
      logo_uri: 'https://evil.example/logo.png',
      software_statement: 'whatever',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      client_id: expect.stringMatching(/^wpl7ci_[A-Za-z0-9_-]{22}$/),
      client_name: 'Claude',
      redirect_uris: claude.redirect_uris,
      token_endpoint_auth_method: 'none',
    });
    expect(body).not.toHaveProperty('client_secret');
    expect(body).not.toHaveProperty('logo_uri');
    expect(world.db.select().from(oauthClients).get()).toMatchObject({ name: 'Claude', createdIp: '127.0.0.1' });

    const second = await register(app, { ...claude, client_name: 'Also me' });
    expect(second.statusCode).toBe(403);
  });

  it('refuses redirect URIs that could run script, leave the computer over http, are too long or too many', async () => {
    const { app, openWindow } = await panel();
    openWindow();
    for (const redirect_uris of [
      ['javascript:alert(1)'],
      ['http://evil.example/cb'],
      ['data:text/html,x'],
      [`https://claude.ai/${'a'.repeat(2000)}`],
      [],
      Array.from({ length: 6 }, (_, i) => `https://claude.ai/cb/${i}`),
      'https://claude.ai/cb',
    ]) {
      const res = await register(app, { client_name: 'x', redirect_uris });
      expect(res.statusCode, JSON.stringify(redirect_uris)).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
  });

  it('answers in OAuth’s dialect, and never takes a form', async () => {
    const { app, openWindow } = await panel();
    openWindow();
    const form = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'redirect_uris=https://claude.ai/cb',
    });
    expect(form.statusCode).toBe(400);
    expect(form.json()).toMatchObject({ error: 'invalid_client_metadata' });
    const grant = await register(app, { ...claude, grant_types: ['client_credentials'] });
    expect(grant.json()).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('refuses a web page on another site, and an opaque origin', async () => {
    const { app, openWindow } = await panel();
    openWindow();
    for (const origin of ['https://evil.example', 'null']) {
      const res = await register(app, claude, { origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().error).toBe('access_denied');
    }
  });

  it('is limited to ten a minute per address, and to a hundred apps', async () => {
    const { app, world } = await panel();
    const admin = world.deps.users.owner()!;
    let last = 0;
    for (let i = 0; i < 11; i++) {
      world.deps.oauth.openWindow(admin.id);
      last = (await register(app, claude, { 'x-forwarded-for': '198.51.100.4' })).statusCode;
    }
    expect(last).toBe(429);

    const now = Date.now();
    world.db
      .insert(oauthClients)
      .values(Array.from({ length: MAX_CLIENTS }, (_, i) => ({ clientId: `wpl7ci_filler${i}`, name: `f${i}`, redirectUris: '[]', createdAt: now, lastUsedAt: now })))
      .run();
    world.deps.oauth.openWindow(admin.id);
    const full = await register(app, claude, { 'x-forwarded-for': '198.51.100.5' });
    expect(full.statusCode).toBe(503);
    expect(full.json().error).toBe('temporarily_unavailable');
  });
});
