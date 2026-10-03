import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { sessions } from '../../src/db/schema.js';
import { totpCode, totpStepAt } from '../../src/lib/totp.js';
import { makeApp } from '../helpers.js';
import { apiKeys } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import type { MeDto, PanelUserDto } from '../../shared/types.js';

type TestApp = Awaited<ReturnType<typeof makeApp>>['app'];

const LOGIN = { username: 'admin', password: 'correct-horse-battery' };

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'panel.sid')!;
  return `${cookie.name}=${cookie.value}`;
}

async function loginCookie(app: TestApp): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

/** The signed-in admin, as the sidebar reads it. */
async function meOf(app: TestApp, cookie: string): Promise<PanelUserDto> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as MeDto).user!;
}

/** Enrol an authenticator on the signed-in account, the way its page does it. */
async function enableTotp(app: TestApp, cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const { id } = await meOf(app, cookie);
  const setup = await app.inject({
    method: 'POST',
    url: `/api/users/${id}/totp/setup`,
    headers: { cookie, 'x-csrf': '1' },
    payload: { password: LOGIN.password },
  });
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { secret: string };

  const enable = await app.inject({
    method: 'POST',
    url: `/api/users/${id}/totp/enable`,
    headers: { cookie, 'x-csrf': '1' },
    payload: { code: totpCode(secret, totpStepAt()) },
  });
  expect(enable.statusCode).toBe(200);
  return { secret, recoveryCodes: (enable.json() as { recoveryCodes: string[] }).recoveryCodes };
}

/** The lowest six-digit string that is not one of the three codes the window accepts. */
function wrongCode(secret: string): string {
  const accepted = new Set([-1, 0, 1].map((delta) => totpCode(secret, totpStepAt() + delta)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!accepted.has(candidate)) return candidate;
  }
}

describe('auth & CSRF', () => {
  it('rejects unauthenticated API access with the error envelope', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('percent-encoded /api paths cannot skip the auth gate', async () => {
    const { app } = await makeApp();
    // find-my-way decodes before routing, so these all reach the real /api handlers.
    for (const url of ['/%61pi/sites', '/api/%73ites', '/%61pi/api-keys', '/%61pi/auth/me']) {
      const res = await app.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 401 });
    }
  });

  it('health and login are public', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects wrong credentials', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('session cookie: GET ok, mutation requires X-CSRF, logout revokes', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);

    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } })).statusCode).toBe(200);

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie },
      payload: { name: 'k' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const withCsrf = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie, 'x-csrf': '1' },
      payload: { name: 'k' },
    });
    expect(withCsrf.statusCode).toBe(201);

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf': '1' } });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } })).statusCode).toBe(401);
  });

  it('still accepts a key minted before the rename', async () => {
    // LEGACY(ceo) - delete in 0.3.0. The prefix is decoration on a token checked by hash,
    // and the alternative is every existing install's CI losing its credential on upgrade.
    const { app, world } = await makeApp();
    const token = 'cak_xhTmQ6mvNrfB3yS8dW1pKzLuA0cEgJ4R';
    world.db
      .insert(apiKeys)
      .values({ name: 'pre-rename', tokenHash: sha256Hex(token), prefix: token.slice(0, 12), createdAt: Date.now() })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'wporg', slug: 'akismet' },
    });
    expect(res.statusCode).toBe(201);

    // A token with neither prefix is still rejected before the database is touched.
    const bogus = await app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { authorization: 'Bearer nope_xhTmQ6mvNrfB3yS8dW1pKzLuA0cEgJ4R' },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('API keys authenticate without CSRF, are shown once, and revoke', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie, 'x-csrf': '1' },
      payload: { name: 'ext-tool' },
    });
    const { token, id } = created.json() as { token: string; id: number };
    expect(token).toMatch(/^wpl7_/);

    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie } });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const bearer = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'wporg', slug: 'akismet' },
    });
    expect(bearer.statusCode).toBe(201);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/api-keys/${id}`,
      headers: { cookie, 'x-csrf': '1' },
    });
    expect(revoke.statusCode).toBe(204);
    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('rate limits the login route', async () => {
    const { app } = await makeApp();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        remoteAddress: '10.9.9.9',
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it('unknown /api routes return the JSON envelope, not SPA HTML', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { accept: 'text/html', cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('changes the admin password only with the current one', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { id } = await meOf(app, cookie);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/password`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: 'wrong', newPassword: 'new-password-123' },
    });
    // 403, not 401: the session is valid and has to stay valid, or the web client bounces
    // the user to /login for mistyping a box on their account page.
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/password`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, newPassword: 'new-password-123' },
    });
    expect(good.statusCode).toBe(204);
    const relog = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'new-password-123' },
    });
    expect(relog.statusCode).toBe(200);
  });

  it('changes the admin username only with the current password', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { id } = await meOf(app, cookie);

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/username`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: 'wrong', username: 'boss' },
    });
    expect(bad.statusCode).toBe(403);

    // A name with a space in it would be a login box nobody can answer reliably.
    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/username`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, username: 'the boss' },
    });
    expect(invalid.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/username`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, username: 'boss' },
    });
    expect(good.statusCode).toBe(204);

    // Same password, new name only - and the session that made the change survives it.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN })).statusCode).toBe(401);
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'boss', password: LOGIN.password },
    });
    expect(relogin.statusCode).toBe(200);
    expect((await meOf(app, cookie)).username).toBe('boss');
  });

  it('a password change in flight does not undo a rename that lands during it', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { id } = await meOf(app, cookie);

    // The password route reads the account, then spends a whole argon2 hash before it
    // writes anything back. A rename that lands inside that window used to be overwritten
    // by the name the route had already read - both calls answering 204 while the name the
    // panel had just confirmed as saved no longer opened the login.
    const passwordChange = app.inject({
      method: 'PUT',
      url: `/api/users/${id}/password`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, newPassword: 'new-password-123' },
    });
    await new Promise((resolve) => setImmediate(resolve)); // let it get as far as hashing
    const rename = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}/username`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, username: 'boss' },
    });
    expect(rename.statusCode).toBe(204);
    expect((await passwordChange).statusCode).toBe(204);

    // Both halves survive: the new name AND the new password.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'boss', password: 'new-password-123' },
    });
    expect(relogin.statusCode).toBe(200);
  });
});

/**
 * A code one step ahead of now. Enrolment spends the code that confirmed it, so the very
 * next sign-in has to use a fresh one - both here and on a real phone.
 */
function nextCode(secret: string): string {
  return totpCode(secret, totpStepAt() + 1);
}

async function totpLogin(app: TestApp, code: string): Promise<{ pending: string; final: LightMyRequestResponse }> {
  const password = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
  expect(password.json()).toEqual({ ok: true, totpRequired: true });
  const pending = cookieOf(password);
  const final = await app.inject({
    method: 'POST',
    url: '/api/auth/login/totp',
    headers: { cookie: pending, 'x-csrf': '1' },
    payload: { code },
  });
  return { pending, final };
}

describe('two-factor authentication', () => {
  it('is off until it is switched on', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    expect((await meOf(app, cookie)).twoFactor).toEqual({ enabled: false, confirmedAt: null, recoveryCodesLeft: 0 });

    const { secret } = await enableTotp(app, cookie);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const me = await meOf(app, cookie);
    expect(me.twoFactor).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect(me.twoFactor.confirmedAt).toBeGreaterThan(0);
  });

  it('will not hand out a secret without the password', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { id } = await meOf(app, cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${id}/totp/setup`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(403);
    expect((await meOf(app, cookie)).twoFactor.enabled).toBe(false);
    // The session survives the typo - anything else sends the web client to /login.
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } })).statusCode).toBe(200);
  });

  it('only arms once a code proves the app really has the secret', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { id } = await meOf(app, cookie);
    const setup = await app.inject({
      method: 'POST',
      url: `/api/users/${id}/totp/setup`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password },
    });
    const { secret, otpauthUrl, qrDataUrl } = setup.json() as Record<string, string>;
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(qrDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/users/${id}/totp/enable`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { code: wrongCode(secret) },
    });
    expect(rejected.statusCode).toBe(400);
    // A failed confirmation leaves the login exactly as it was.
    const stillOneStep = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    expect(stillOneStep.json()).toEqual({ ok: true, totpRequired: false });
  });

  it('turns the login into two steps, and the half-done one can do nothing', async () => {
    const { app } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));

    const { pending, final } = await totpLogin(app, nextCode(secret));
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: pending } })).statusCode).toBe(401);
    expect(final.statusCode).toBe(200);

    const session = cookieOf(final);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: session } })).statusCode).toBe(200);
    // The id the code was presented under is retired, not left lying around as a second key.
    expect(session).not.toBe(pending);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: pending } })).statusCode).toBe(401);
  });

  it('refuses a wrong code and a code that has already been used', async () => {
    const { app } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));

    const bad = await totpLogin(app, wrongCode(secret));
    expect(bad.final.statusCode).toBe(401);

    const code = nextCode(secret);
    expect((await totpLogin(app, code)).final.statusCode).toBe(200);
    // Same code, fresh password step: someone who read it off the screen gets nothing.
    expect((await totpLogin(app, code)).final.statusCode).toBe(401);
  });

  it('accepts a recovery code once, then strikes it off', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { recoveryCodes } = await enableTotp(app, cookie);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const used = recoveryCodes[0]!;
    // Retyped off a printout: upper case, spaces instead of the grouping dashes.
    const first = await totpLogin(app, used.replace(/-/g, ' ').toUpperCase());
    expect(first.final.statusCode).toBe(200);
    expect((await meOf(app, cookieOf(first.final))).twoFactor.recoveryCodesLeft).toBe(9);

    expect((await totpLogin(app, used)).final.statusCode).toBe(401);
    expect((await totpLogin(app, recoveryCodes[1]!)).final.statusCode).toBe(200);
  });

  it('stops accepting codes at all after a run of wrong ones', async () => {
    const { app } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));

    const password = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    const pending = cookieOf(password);
    const attempt = (code: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login/totp', headers: { cookie: pending }, payload: { code } });

    for (let i = 0; i < 4; i++) expect((await attempt(wrongCode(secret))).statusCode).toBe(401);
    const lockout = await attempt(wrongCode(secret));
    expect(lockout.statusCode).toBe(401);
    expect(lockout.json().error.message).toMatch(/too many/i);
    // The attempt is over: even the right code cannot rescue this pending session now.
    expect((await attempt(nextCode(secret))).statusCode).toBe(401);
    // And the budget is the account's, not the cookie's - a clean browser gets nowhere
    // either, which is the whole point when the guesses come from a botnet.
    expect((await totpLogin(app, nextCode(secret))).final.statusCode).toBe(401);
  });

  it('counts wrong codes that arrive all at once', async () => {
    const { app } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));

    const password = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    const pending = cookieOf(password);
    const attempt = (code: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login/totp', headers: { cookie: pending }, payload: { code } });

    // Held on the session, this counted as ONE failure however many arrived together:
    // each request restores its own copy of the session and the last save wins, so a
    // burst straight past the cap left the budget untouched and the next code worked.
    await Promise.all(Array.from({ length: 6 }, () => attempt(wrongCode(secret))));
    expect((await attempt(nextCode(secret))).statusCode).toBe(401);
  });

  it('expires a login left half-finished', async () => {
    const { app, world } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));
    const password = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    const pending = cookieOf(password);

    // Wind the pending window back rather than waiting five minutes for it.
    const rows = world.db.select().from(sessions).all();
    const row = rows.find((r) => JSON.parse(r.data).totpPendingUntil !== undefined)!;
    const data = JSON.parse(row.data) as { totpPendingUntil: number };
    data.totpPendingUntil = Date.now() - 1;
    world.db.update(sessions).set({ data: JSON.stringify(data) }).where(eq(sessions.sid, row.sid)).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: { cookie: pending },
      payload: { code: nextCode(secret) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/too long/i);
  });

  it('cannot be finished by a browser that never passed the password step', async () => {
    const { app } = await makeApp();
    const { secret } = await enableTotp(app, await loginCookie(app));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      payload: { code: nextCode(secret) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('signs out sessions that were opened before it existed', async () => {
    const { app } = await makeApp();
    const other = await loginCookie(app);
    const mine = await loginCookie(app);
    await enableTotp(app, mine);

    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: other } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: mine } })).statusCode).toBe(200);
  });

  it('replaces the recovery codes on request', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { recoveryCodes: old } = await enableTotp(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${(await meOf(app, cookie)).id}/totp/recovery-codes`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password },
    });
    expect(res.statusCode).toBe(200);
    const { recoveryCodes } = res.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.filter((c) => old.includes(c))).toEqual([]);

    expect((await totpLogin(app, old[0]!)).final.statusCode).toBe(401);
    expect((await totpLogin(app, recoveryCodes[0]!)).final.statusCode).toBe(200);
  });

  it('turns off with the password, putting the login back to one step', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    await enableTotp(app, cookie);
    const { id } = await meOf(app, cookie);

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}/totp`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: 'not-the-password' },
    });
    expect(refused.statusCode).toBe(403);

    const off = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}/totp`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password },
    });
    expect(off.statusCode).toBe(204);

    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    expect(res.json()).toEqual({ ok: true, totpRequired: false });
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: cookieOf(res) } })).statusCode)
      .toBe(200);
  });

  it('survives a password change: the new password still only gets you half way in', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const { secret } = await enableTotp(app, cookie);

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/users/${(await meOf(app, cookie)).id}/password`,
      headers: { cookie, 'x-csrf': '1' },
      payload: { password: LOGIN.password, newPassword: 'new-password-123' },
    });
    expect(changed.statusCode).toBe(204);

    const password = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'new-password-123' },
    });
    expect(password.json()).toEqual({ ok: true, totpRequired: true });
    const finished = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: { cookie: cookieOf(password) },
      payload: { code: nextCode(secret) },
    });
    expect(finished.statusCode).toBe(200);
  });

  it('leaves API keys alone - a machine has no phone to ask', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie, 'x-csrf': '1' },
      payload: { name: 'ext-tool' },
    });
    const { token } = created.json() as { token: string };
    await enableTotp(app, cookie);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
