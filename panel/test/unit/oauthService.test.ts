/**
 * The OAuth service on its own, on a clock the test turns: the connection window, codes that
 * work once, refresh tokens that rotate, and what happens to a token that comes back.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { oauthClients, oauthGrants, oauthTokens } from '../../src/db/schema.js';
import { OAuthProblem, OAuthService, pruneOAuth, WINDOW_TTL_MS } from '../../src/services/oauth.js';
import { makeWorld } from '../helpers.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function service() {
  const world = await makeWorld();
  const clock = { now: 1_800_000_000_000 };
  const oauth = new OAuthService(world.db, world.config, world.deps.settings, world.deps.log, () => clock.now);
  const admin = world.deps.users.owner()!;
  const pkce = () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  };
  const query = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st4te',
      ...extra,
    }).toString();
  /** Open a window, register, approve: the code and verifier an app then holds. */
  const approved = (access: 'read' | 'manage' | 'full' = 'read') => {
    oauth.openWindow(admin.id);
    const { client_id } = oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, '203.0.113.9') as { client_id: string };
    const { verifier, challenge } = pkce();
    const { redirectTo } = oauth.decide(query(client_id, challenge), admin.id, true, access);
    const code = new URL(redirectTo).searchParams.get('code')!;
    return { clientId: client_id, code, verifier, redirectTo };
  };
  const exchange = (a: ReturnType<typeof approved>) =>
    oauth.exchangeCode({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT });
  return { world, clock, oauth, admin, pkce, query, approved, exchange };
}

const problem = (fn: () => unknown): OAuthProblem => {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuthProblem) return err;
    throw err;
  }
  throw new Error('expected an OAuth error');
};

describe('the connection window', () => {
  it('refuses registration while no admin has opened one', async () => {
    const { oauth } = await service();
    expect(problem(() => oauth.register({ redirect_uris: [REDIRECT] }, null))).toMatchObject({ status: 403, error: 'access_denied' });
  });

  it('lets exactly one app register, and closes after ten minutes', async () => {
    const { oauth, admin, clock } = await service();
    oauth.openWindow(admin.id);
    oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, null);
    expect(problem(() => oauth.register({ client_name: 'Other', redirect_uris: [REDIRECT] }, null)).status).toBe(403);
    oauth.openWindow(admin.id);
    clock.now += WINDOW_TTL_MS + 1;
    expect(problem(() => oauth.register({ redirect_uris: [REDIRECT] }, null)).status).toBe(403);
  });

  it('lets only the admin who opened it approve, and only once', async () => {
    const { world, oauth, admin, pkce, query } = await service();
    const other = world.deps.users.create({ username: 'colleague', passwordHash: 'x' });
    oauth.openWindow(admin.id);
    const { client_id } = oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, null) as { client_id: string };
    const { challenge } = pkce();
    expect(oauth.check(query(client_id, challenge), other.id)).toMatchObject({ status: 'closed' });
    expect(oauth.check(query(client_id, challenge), admin.id)).toMatchObject({
      status: 'ready',
      client: { name: 'Claude' },
      redirect: { kind: 'web', host: 'claude.ai' },
    });
    oauth.decide(query(client_id, challenge), admin.id, true, 'read');
    // Consumed: the same link is dead now.
    expect(oauth.check(query(client_id, challenge), admin.id)).toMatchObject({ status: 'closed' });
  });

  it('lets a connected app be approved again in a new window, never one nobody approved', async () => {
    const { world, oauth, admin, pkce, query, approved, exchange } = await service();
    const first = approved();
    exchange(first);
    // A second registration, never approved, left over from a window that closed.
    oauth.openWindow(admin.id);
    const { client_id: stranger } = oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, null) as { client_id: string };
    oauth.closeWindow();

    oauth.openWindow(admin.id);
    const { challenge } = pkce();
    expect(oauth.check(query(first.clientId, challenge), admin.id).status).toBe('ready');
    expect(oauth.check(query(stranger, challenge), admin.id)).toMatchObject({
      status: 'closed',
      reason: expect.stringContaining('did not register in this connection window'),
    });
    expect(world.db.select().from(oauthClients).all()).toHaveLength(2);
  });

  it('forgets a revoked app, so connecting it again means registering again', async () => {
    const { world, oauth, admin, pkce, query, approved, exchange } = await service();
    const first = approved();
    exchange(first);
    const grant = world.db.select().from(oauthGrants).get()!;
    oauth.revokeConnection(grant.id);
    expect(world.db.select().from(oauthClients).all()).toHaveLength(0);
    oauth.openWindow(admin.id);
    expect(oauth.check(query(first.clientId, pkce().challenge), admin.id)).toMatchObject({
      status: 'error',
      message: 'This link names no app registered here',
    });
  });

  it("lets its admin discard what registered in the window, and keeps the window for the right app", async () => {
    const { world, oauth, admin } = await service();
    oauth.openWindow(admin.id);
    oauth.register({ client_name: 'Not mine', redirect_uris: ['https://evil.example/cb'] }, '198.51.100.7');
    const colleague = world.deps.users.create({ username: 'colleague', passwordHash: 'x' });
    expect(oauth.discardRegistration(colleague.id)).toBe(false);
    expect(oauth.discardRegistration(admin.id)).toBe(true);
    expect(world.db.select().from(oauthClients).all()).toHaveLength(0);
    expect(oauth.windowFor(admin.id)).toMatchObject({ registered: null });
    oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, null);
    expect(oauth.windowFor(admin.id)).toMatchObject({ registered: { name: 'Claude' } });
    expect(oauth.discardRegistration(admin.id)).toBe(true);
    expect(oauth.discardRegistration(admin.id)).toBe(false);
  });
});

describe('authorization requests', () => {
  it('shows an unknown app or a foreign redirect here, with nowhere to send it', async () => {
    const { oauth, admin, pkce, query, approved } = await service();
    const { clientId } = approved();
    oauth.openWindow(admin.id);
    const { challenge } = pkce();
    expect(oauth.check(query('wpl7ci_nope', challenge), admin.id)).toEqual({
      status: 'error',
      message: 'This link names no app registered here',
      returnTo: null,
    });
    expect(oauth.check(query(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }), admin.id)).toMatchObject({
      status: 'error',
      returnTo: null,
    });
  });

  it('sends every other error back to the app - but only when the admin clicks', async () => {
    const { oauth, admin, query, approved } = await service();
    const { clientId } = approved();
    oauth.openWindow(admin.id);
    const plain = oauth.check(query(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' }), admin.id);
    expect(plain).toMatchObject({ status: 'error', message: expect.stringContaining('S256') });
    const back = new URL((plain as { returnTo: string }).returnTo);
    expect(Object.fromEntries(back.searchParams)).toMatchObject({ error: 'invalid_request', state: 'st4te', iss: 'http://panel.example.test' });
    const twice = oauth.check(`${query(clientId, 'y'.repeat(43))}&scope=a&scope=b`, admin.id);
    expect(twice).toMatchObject({ status: 'error', message: 'Sent more than once: scope' });
    const target = oauth.check(query(clientId, 'y'.repeat(43), { resource: 'https://elsewhere.example/mcp' }), admin.id);
    expect(new URL((target as { returnTo: string }).returnTo).searchParams.get('error')).toBe('invalid_target');
  });

  it('returns a code with state and iss, and a refusal as access_denied', async () => {
    const { oauth, admin, pkce, query } = await service();
    oauth.openWindow(admin.id);
    const { client_id } = oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, null) as { client_id: string };
    const { challenge } = pkce();
    const denied = new URL(oauth.decide(query(client_id, challenge), admin.id, false, 'read').redirectTo);
    expect(denied.origin + denied.pathname).toBe(REDIRECT);
    expect(Object.fromEntries(denied.searchParams)).toMatchObject({ error: 'access_denied', state: 'st4te', iss: 'http://panel.example.test' });
    // Declining did not use the window up.
    const approved = new URL(oauth.decide(query(client_id, challenge), admin.id, true, 'manage').redirectTo);
    expect(approved.searchParams.get('code')).toMatch(/^wpl7ac_/);
    expect(approved.searchParams.get('state')).toBe('st4te');
  });
});

describe('codes', () => {
  it('trade for tokens once; a second try ends the connection the first one made', async () => {
    const { world, oauth, approved, exchange } = await service();
    const a = approved('manage');
    const tokens = exchange(a);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'wpl7:read wpl7:manage' });
    expect(tokens.access_token).toMatch(/^wpl7at_/);
    expect(tokens.refresh_token).toMatch(/^wpl7rt_/);
    expect(oauth.principalFor(tokens.access_token)).toMatchObject({ kind: 'connection', access: 'manage', label: 'Claude via MCP (approved by admin)' });

    expect(problem(() => exchange(a))).toMatchObject({ error: 'invalid_grant' });
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(0);
    expect(oauth.principalFor(tokens.access_token)).toBeNull();
  });

  it('burn on a wrong verifier', async () => {
    const { oauth, approved, exchange } = await service();
    const a = approved();
    expect(problem(() => oauth.exchangeCode({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, code_verifier: 'z'.repeat(43) })).error).toBe(
      'invalid_grant',
    );
    // The right verifier is too late now.
    expect(problem(() => exchange(a)).error).toBe('invalid_grant');
  });

  it('expire after two minutes, and belong to one app and one redirect', async () => {
    const { clock, oauth, approved, exchange } = await service();
    const a = approved();
    expect(problem(() => oauth.exchangeCode({ grant_type: 'authorization_code', client_id: 'wpl7ci_other', code: a.code, code_verifier: a.verifier })).status).toBe(
      401,
    );
    expect(
      problem(() =>
        oauth.exchangeCode({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, code_verifier: a.verifier, redirect_uri: 'https://claude.ai/other' }),
      ).error,
    ).toBe('invalid_grant');
    const b = approved();
    clock.now += 121_000;
    expect(problem(() => exchange(b)).error).toBe('invalid_grant');
  });

  it('replace an earlier connection of the same app and admin', async () => {
    const { world, oauth, admin, pkce, query, approved, exchange } = await service();
    const first = approved();
    exchange(first);
    // The same app, connecting again with the registration it kept.
    oauth.openWindow(admin.id);
    const { verifier, challenge } = pkce();
    const code = new URL(oauth.decide(query(first.clientId, challenge), admin.id, true, 'full').redirectTo).searchParams.get('code')!;
    oauth.exchangeCode({ grant_type: 'authorization_code', client_id: first.clientId, code, code_verifier: verifier });
    const grants = world.db.select().from(oauthGrants).all();
    expect(grants.map((g) => g.access)).toEqual(['full']);
  });
});

describe('refresh tokens', () => {
  it('rotate on use, keep the level, and last two months from the last use', async () => {
    const { oauth, clock, approved, exchange } = await service();
    const a = approved('full');
    const first = exchange(a);
    clock.now += 59 * 24 * 3600_000;
    const second = oauth.refresh({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: first.refresh_token });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe('wpl7:read wpl7:manage wpl7:full');
    clock.now += 59 * 24 * 3600_000;
    expect(oauth.refresh({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: second.refresh_token }).access_token).toMatch(/^wpl7at_/);
  });

  it('may be used again within a minute - a response lost on the way - and end the connection after that', async () => {
    const { world, oauth, clock, approved, exchange } = await service();
    const a = approved();
    const first = exchange(a);
    const refresh = (token: string) => oauth.refresh({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: token });
    const second = refresh(first.refresh_token);
    clock.now += 30_000;
    const retried = refresh(first.refresh_token);
    expect(retried.access_token).not.toBe(second.access_token);
    clock.now += 60_000;
    expect(problem(() => refresh(first.refresh_token))).toMatchObject({ error: 'invalid_grant' });
    // Reuse after the grace means a copy exists: the whole connection is gone.
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(0);
    expect(oauth.principalFor(second.access_token)).toBeNull();
  });

  it('never widen the grant, and belong to their app', async () => {
    const { oauth, approved, exchange } = await service();
    const a = approved('read');
    const t = exchange(a);
    expect(problem(() => oauth.refresh({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: t.refresh_token, scope: 'wpl7:full' })).error).toBe(
      'invalid_scope',
    );
    expect(problem(() => oauth.refresh({ grant_type: 'refresh_token', client_id: 'wpl7ci_x', refresh_token: t.refresh_token })).status).toBe(401);
    // An access token is not a refresh token.
    expect(problem(() => oauth.refresh({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: t.access_token })).error).toBe('invalid_grant');
  });
});

describe('access tokens and revocation', () => {
  it('expire after an hour, and follow the connection level as it changes', async () => {
    const { world, oauth, clock, approved, exchange } = await service();
    const t = exchange(approved('read'));
    const grant = world.db.select().from(oauthGrants).get()!;
    oauth.setAccess(grant.id, 'full');
    expect(oauth.principalFor(t.access_token)?.access).toBe('full');
    clock.now += 3600_001;
    expect(oauth.principalFor(t.access_token)).toBeNull();
  });

  it('revokes one access token, or with a refresh token the whole connection', async () => {
    const { world, oauth, approved, exchange } = await service();
    const a = approved();
    const t = exchange(a);
    oauth.revoke({ token: t.access_token, client_id: a.clientId });
    expect(oauth.principalFor(t.access_token)).toBeNull();
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(1);
    // Another app's revocation of it does nothing.
    oauth.revoke({ token: t.refresh_token, client_id: 'wpl7ci_other' });
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(1);
    oauth.revoke({ token: t.refresh_token });
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(0);
  });
});

describe('pruning', () => {
  it('drops expired tokens, connections left without any, and apps nobody approved', async () => {
    const { world, oauth, admin, clock, approved, exchange } = await service();
    exchange(approved());
    oauth.openWindow(admin.id);
    oauth.register({ client_name: 'Never approved', redirect_uris: [REDIRECT] }, null);
    const now = clock.now;
    expect(pruneOAuth(world.db, now)).toBe(0);

    // A day later the unapproved one is gone; the connected one stays.
    expect(pruneOAuth(world.db, now + 25 * 3600_000)).toBeGreaterThan(0);
    expect(world.db.select().from(oauthClients).all().map((c) => c.name)).toEqual(['Claude']);

    // A month on, only the access token has run out; the connection lives on its refresh token.
    pruneOAuth(world.db, now + 31 * 24 * 3600_000);
    expect(world.db.select().from(oauthTokens).all().map((t) => t.kind)).toEqual(['refresh']);
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(1);

    // Sixty-one days unused: the refresh token expired, so the connection goes - and the app,
    // unused for more than a month with no connection left.
    pruneOAuth(world.db, now + 61 * 24 * 3600_000);
    expect(world.db.select().from(oauthTokens).all()).toHaveLength(0);
    expect(world.db.select().from(oauthGrants).all()).toHaveLength(0);
    expect(world.db.select().from(oauthClients).all()).toHaveLength(0);
  });

  it("removes an admin's connections with the admin, and nobody else's", async () => {
    const { world, oauth, approved, exchange, pkce, query } = await service();
    const mine = exchange(approved());
    const colleague = world.deps.users.create({ username: 'colleague', passwordHash: 'x' });
    oauth.openWindow(colleague.id);
    const { client_id } = oauth.register({ client_name: 'Cursor', redirect_uris: [REDIRECT] }, null) as { client_id: string };
    const { verifier, challenge } = pkce();
    const code = new URL(oauth.decide(query(client_id, challenge), colleague.id, true, 'read').redirectTo).searchParams.get('code')!;
    const theirs = oauth.exchangeCode({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier });

    world.deps.users.remove(colleague.id);
    expect(oauth.principalFor(theirs.access_token)).toBeNull();
    expect(oauth.principalFor(mine.access_token)).not.toBeNull();
    // A password change is not a revocation: like an API key, the connection stays.
    const admin = world.deps.users.owner()!;
    world.deps.users.setPasswordHash(admin.id, 'new-hash');
    world.deps.users.revokeSessions(admin.id);
    expect(oauth.principalFor(mine.access_token)).not.toBeNull();
  });
});
