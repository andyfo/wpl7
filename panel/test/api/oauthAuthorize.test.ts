/**
 * The approval page's two calls: what an admin is shown for an app asking to connect, and
 * what their click does. Browser session only, from the panel's own page, inside the window.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkRedirectUri } from '../../shared/oauth.js';
import type { OAuthCheckDto } from '../../shared/types.js';
import { makeApp, makeWorld } from '../helpers.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function panel() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  world.deps.settings.set('mcpEnabled', true);
  const signIn = async (username: string, password: string) => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    return { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  };
  const session = await signIn('admin', 'correct-horse-battery');
  const openWindow = async (headers = session) => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers });
    expect(res.statusCode, res.body).toBe(200);
  };
  const registerClaude = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    });
    return res.json().client_id as string;
  };
  const challenge = crypto.createHash('sha256').update('v'.repeat(50)).digest('base64url');
  const query = (clientId: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'wpl7:full',
      ...extra,
    }).toString();
  const check = (q: string, headers: Record<string, string> = session) =>
    app.inject({ method: 'POST', url: '/api/oauth/authorize/check', headers, payload: { query: q } });
  const decide = (q: string, body: Record<string, unknown>, headers: Record<string, string> = session) =>
    app.inject({ method: 'POST', url: '/api/oauth/authorize/decision', headers, payload: { query: q, ...body } });
  return { app, world, session, signIn, openWindow, registerClaude, query, check, decide };
}

describe('the approval page', () => {
  it('shows where the browser will go, the app’s claim, and what it asked for', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    const res = await p.check(p.query(id));
    expect(res.statusCode).toBe(200);
    expect(res.json() as OAuthCheckDto).toEqual({
      status: 'ready',
      client: { name: 'Claude' },
      redirect: { kind: 'web', host: 'claude.ai' },
      requested: 'full',
    });
  });

  it('shows "no connection is being set up" to a link arriving at any other moment', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    await p.app.inject({ method: 'DELETE', url: '/api/mcp/connect-window', headers: p.session });
    expect((await p.check(p.query(id))).json()).toMatchObject({ status: 'closed' });
    const decided = await p.decide(p.query(id), { approve: true, access: 'full' });
    expect(decided.statusCode).toBe(409);
  });

  it("is another admin's window's business only", async () => {
    const p = await panel();
    p.world.deps.users.create({ username: 'colleague', passwordHash: await (await import('argon2')).default.hash('colleague-password') });
    const colleague = await p.signIn('colleague', 'colleague-password');
    await p.openWindow();
    const id = await p.registerClaude();
    expect((await p.check(p.query(id), colleague)).json()).toMatchObject({ status: 'closed' });
  });

  it('approves at the level the admin chose, whatever the app asked for, and only once', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    const res = await p.decide(p.query(id), { approve: true });
    expect(res.statusCode).toBe(200);
    const to = new URL(res.json().redirectTo);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('code')).toMatch(/^wpl7ac_/);
    expect(to.searchParams.get('state')).toBe('xyz');
    expect(to.searchParams.get('iss')).toBe('http://panel.example.test');
    // The window is spent.
    expect((await p.decide(p.query(id), { approve: true })).statusCode).toBe(409);
  });

  it('answers with a redirect the page will follow, however long the state makes it', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    // As long as state may be: with the code and iss beside it, longer than any registered URI.
    const state = 's'.repeat(2000);
    const res = await p.decide(p.query(id, { state }), { approve: true });
    expect(res.statusCode, res.body).toBe(200);
    const to = res.json().redirectTo as string;
    expect(to.length).toBeGreaterThan(2000);
    expect(new URL(to).searchParams.get('state')).toBe(state);
    // The page checks it again before it goes (pages/OAuthAuthorize.tsx) - after the window is spent.
    expect(checkRedirectUri(to)).toMatchObject({ ok: true, host: 'claude.ai' });
  });

  it('declines back to the app, and the window stays open for the right one', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    const res = await p.decide(p.query(id), { approve: false });
    expect(new URL(res.json().redirectTo).searchParams.get('error')).toBe('access_denied');
    expect((await p.check(p.query(id))).json()).toMatchObject({ status: 'ready' });
  });

  it('refuses an API key, a request without X-CSRF, and one another site started', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    const key = { authorization: `Bearer ${p.world.deps.apiKeys.create('ci', 'full').token}` };
    expect((await p.check(p.query(id), key)).statusCode).toBe(403);
    expect((await p.decide(p.query(id), { approve: true }, key)).statusCode).toBe(403);
    expect((await p.check(p.query(id), { cookie: p.session.cookie })).statusCode).toBe(403);
    const crossSite = await p.decide(p.query(id), { approve: true }, { ...p.session, 'sec-fetch-site': 'same-site' });
    expect(crossSite.statusCode).toBe(403);
    // A key cannot open the window either.
    expect((await p.app.inject({ method: 'POST', url: '/api/mcp/connect-window', headers: key })).statusCode).toBe(403);
  });

  it('shows a request it cannot trust here, and hands errors back to the app only on a click', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    expect((await p.check(p.query(id, { redirect_uri: 'https://evil.example/cb' }))).json()).toMatchObject({
      status: 'error',
      returnTo: null,
    });
    const noPkce = (await p.check(p.query(id, { code_challenge_method: 'plain' }))).json();
    expect(noPkce).toMatchObject({ status: 'error', returnTo: expect.stringContaining('error=invalid_request') });
    // Deciding on it is that click: the answer is where to go, with the error.
    const decided = await p.decide(p.query(id, { code_challenge_method: 'plain' }), { approve: true });
    expect(new URL(decided.json().redirectTo).searchParams.get('error')).toBe('invalid_request');
  });

  it('is refused while the panel is updating', async () => {
    const p = await panel();
    await p.openWindow();
    const id = await p.registerClaude();
    p.world.deps.settings.setRaw('system.maintenance', { reason: 'Updating to 0.3.0', since: Date.now() });
    const res = await p.decide(p.query(id), { approve: true });
    expect(res.statusCode).toBe(503);
  });
});
