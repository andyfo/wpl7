import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { sessions, settings, users } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { totpCode, totpStepAt } from '../../src/lib/totp.js';
import type { MeDto, PanelUserDto } from '../../shared/types.js';
import { createTestDb, makeApp, makeTestConfig, makeWorld, waitFor, type TestWorld } from '../helpers.js';

type TestApp = Awaited<ReturnType<typeof makeApp>>['app'];
type Login = { username: string; password: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const OWNER: Login = { username: 'admin', password: 'correct-horse-battery' };

/**
 * Each sign-in from an address of its own. The login routes allow a handful of attempts a
 * minute per address, and these tests sign in far more often than any one person would.
 */
let addresses = 0;
const nextAddress = () => {
  addresses++;
  return `10.20.${addresses >> 8}.${addresses & 255}`;
};

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'panel.sid')!;
  return `${cookie.name}=${cookie.value}`;
}

/** A request the way the browser sends it (cookie + CSRF header), or the way a script does (Bearer). */
function send(app: TestApp, auth: { cookie: string } | { token: string }, method: Method, url: string, payload?: object) {
  const headers: Record<string, string> =
    'cookie' in auth ? { cookie: auth.cookie, 'x-csrf': '1' } : { authorization: `Bearer ${auth.token}` };
  return app.inject({ method, url, headers, payload });
}

const passwordStep = (app: TestApp, { username, password }: Login) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, remoteAddress: nextAddress() });

async function signIn(app: TestApp, login: Login = OWNER): Promise<string> {
  const res = await passwordStep(app, login);
  expect(res.json()).toEqual({ ok: true, totpRequired: false });
  return cookieOf(res);
}

/** Both halves of a 2FA sign-in; answers with the second. */
async function codeStep(app: TestApp, login: Login, code: string): Promise<LightMyRequestResponse> {
  const password = await passwordStep(app, login);
  expect(password.json()).toEqual({ ok: true, totpRequired: true });
  return app.inject({
    method: 'POST',
    url: '/api/auth/login/totp',
    headers: { cookie: cookieOf(password) },
    payload: { code },
    remoteAddress: nextAddress(),
  });
}

async function me(app: TestApp, cookie: string): Promise<PanelUserDto> {
  const res = await send(app, { cookie }, 'GET', '/api/auth/me');
  expect(res.statusCode).toBe(200);
  return (res.json() as MeDto).user!;
}

/** 200 while the cookie is a live session, 401 once it is not. */
const status = async (app: TestApp, cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode;

async function addAdmin(app: TestApp, cookie: string, username: string): Promise<PanelUserDto & Login> {
  const password = `${username}-password-1`;
  const res = await send(app, { cookie }, 'POST', '/api/users', { username, password });
  expect(res.statusCode).toBe(201);
  return { ...(res.json() as PanelUserDto), password };
}

/** Enrol an authenticator from the account's own session; answers with its secret. */
async function enrol(app: TestApp, cookie: string, id: number, password: string): Promise<string> {
  const setup = await send(app, { cookie }, 'POST', `/api/users/${id}/totp/setup`, { password });
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { secret: string };
  const enable = await send(app, { cookie }, 'POST', `/api/users/${id}/totp/enable`, {
    code: totpCode(secret, totpStepAt()),
  });
  expect(enable.statusCode).toBe(200);
  return secret;
}

/** Enrolment spends the code that confirmed it, so the next sign-in needs a fresh one. */
const nextCode = (secret: string) => totpCode(secret, totpStepAt() + 1);

/** The lowest six-digit string that is not one of the three codes the window accepts. */
function wrongCode(secret: string): string {
  const accepted = new Set([-1, 0, 1].map((delta) => totpCode(secret, totpStepAt() + delta)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!accepted.has(candidate)) return candidate;
  }
}

const sessionsOf = (w: TestWorld, userId: number) =>
  w.db.select().from(sessions).where(eq(sessions.userId, userId)).all();

describe('admin accounts', () => {
  it('starts with the owner, and adds admins who sign in as themselves', async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const list = await send(app, { cookie: owner }, 'GET', '/api/users');
    expect(list.json().items).toEqual([
      expect.objectContaining({
        username: 'admin',
        isOwner: true,
        twoFactor: { enabled: false, confirmedAt: null, recoveryCodesLeft: 0 },
      }),
    ]);

    const anna = await addAdmin(app, owner, 'anna');
    expect(anna).toMatchObject({ username: 'anna', isOwner: false, lastLoginAt: null });
    const annaCookie = await signIn(app, anna);
    const annaMe = await me(app, annaCookie);
    expect(annaMe).toMatchObject({ id: anna.id, username: 'anna', isOwner: false });
    expect(annaMe.lastLoginAt).toBeGreaterThan(0);

    const items = (await send(app, { cookie: annaCookie }, 'GET', '/api/users')).json().items as PanelUserDto[];
    expect(items.map((u) => u.username)).toEqual(['admin', 'anna']);
    const one = await send(app, { cookie: annaCookie }, 'GET', `/api/users/${anna.id}`);
    expect(one.json()).toEqual(annaMe);
    expect((await send(app, { cookie: owner }, 'GET', '/api/users/999')).statusCode).toBe(404);

    // The login box compares names exactly, as it always has.
    expect((await passwordStep(app, { username: 'ANNA', password: anna.password })).statusCode).toBe(401);
  });

  it('refuses a name taken in any case, a bad name, a short password and a second owner', async () => {
    const { app, world } = await makeApp();
    const cookie = await signIn(app);
    const add = (body: object) => send(app, { cookie }, 'POST', '/api/users', body);

    expect((await add({ username: 'admin', password: 'long-enough-1' })).statusCode).toBe(409);
    const caseOnly = await add({ username: 'ADMIN', password: 'long-enough-1' });
    expect(caseOnly.statusCode).toBe(409);
    expect(caseOnly.json().error.message).toBe('Username "ADMIN" is already taken');
    expect((await add({ username: 'the boss', password: 'long-enough-1' })).statusCode).toBe(400);
    expect((await add({ username: 'anna', password: 'too-short' })).statusCode).toBe(400);
    // Setup makes the one owner there is; a request body has no say in it.
    expect((await add({ username: 'anna', password: 'long-enough-1', isOwner: true })).statusCode).toBe(400);
    expect(world.deps.users.list()).toHaveLength(1);
  });

  it('never removes the owner or the admin asking, and 404s an unknown id', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const ownerId = (await me(app, owner)).id;
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);

    expect((await send(app, { cookie: annaCookie }, 'DELETE', `/api/users/${ownerId}`)).statusCode).toBe(409);
    expect((await send(app, { cookie: owner }, 'DELETE', `/api/users/${ownerId}`)).statusCode).toBe(409);
    expect((await send(app, { cookie: annaCookie }, 'DELETE', `/api/users/${anna.id}`)).statusCode).toBe(409);
    expect((await send(app, { cookie: owner }, 'DELETE', '/api/users/999')).statusCode).toBe(404);
    expect(world.deps.users.list()).toHaveLength(2);
  });

  it('removing an admin signs them out at once, everywhere', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const laptop = await signIn(app, anna);
    const phone = await signIn(app, anna);
    // Every session row says whose it is, which is what a revocation goes by. The owner is
    // only known at the end of the request that signed in, after regenerate() had stored it
    // empty - so this is also the session store writing it on update, not just on insert.
    expect(sessionsOf(world, anna.id)).toHaveLength(2);

    expect((await send(app, { cookie: owner }, 'DELETE', `/api/users/${anna.id}`)).statusCode).toBe(204);
    expect(await status(app, laptop)).toBe(401);
    expect(await status(app, phone)).toBe(401);
    expect(sessionsOf(world, anna.id)).toEqual([]);
    expect((await passwordStep(app, anna)).statusCode).toBe(401);
    expect(await status(app, owner)).toBe(200);
  });

  it('drops a session whose account is gone, whatever saved it back', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const cookie = await signIn(app, anna);
    // Behind the service's back, the way a request still in flight when the account was
    // removed leaves its own session saved again after the revocation.
    world.db.delete(users).where(eq(users.id, anna.id)).run();

    expect(await status(app, cookie)).toBe(401);
    expect(sessionsOf(world, anna.id)).toEqual([]);
  });

  it('keeps two-factor authentication per account, guess budget included', async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const ownerId = (await me(app, owner)).id;
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);

    const ownerSecret = await enrol(app, owner, ownerId, OWNER.password);
    expect((await passwordStep(app, OWNER)).json()).toEqual({ ok: true, totpRequired: true });
    expect((await passwordStep(app, anna)).json()).toEqual({ ok: true, totpRequired: false });
    expect((await me(app, annaCookie)).twoFactor.enabled).toBe(false);

    // Each authenticator entry is labelled with its own account.
    const setup = await send(app, { cookie: annaCookie }, 'POST', `/api/users/${anna.id}/totp/setup`, {
      password: anna.password,
    });
    expect(setup.json().otpauthUrl).toContain(':anna?');
    const annaSecret = await enrol(app, annaCookie, anna.id, anna.password);

    // Someone burning through the owner's guesses locks the owner out, and nobody else.
    const pending = cookieOf(await passwordStep(app, OWNER));
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { cookie: pending },
        payload: { code: wrongCode(ownerSecret) },
        remoteAddress: nextAddress(),
      });
    }
    expect((await codeStep(app, OWNER, nextCode(ownerSecret))).statusCode).toBe(401);
    expect((await codeStep(app, anna, nextCode(annaSecret))).statusCode).toBe(200);
  });

  it("lets a colleague set a new password, which ends every session the account had", async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const laptop = await signIn(app, anna);
    const phone = await signIn(app, anna);
    const reset = (password: string) =>
      send(app, { cookie: owner }, 'PUT', `/api/users/${anna.id}/password`, {
        password,
        newPassword: 'reset-by-a-colleague',
      });

    // Proved with the caller's own password, never the one being replaced.
    const wrong = await reset(anna.password);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.message).toBe('Your password is incorrect');
    expect(await status(app, laptop)).toBe(200);

    expect((await reset(OWNER.password)).statusCode).toBe(204);
    expect(await status(app, laptop)).toBe(401);
    expect(await status(app, phone)).toBe(401);
    expect(await status(app, owner)).toBe(200);
    expect((await passwordStep(app, anna)).statusCode).toBe(401);
    await signIn(app, { username: 'anna', password: 'reset-by-a-colleague' });
  });

  it("keeps the owner's account the owner's", async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const ownerId = (await me(app, owner)).id;
    await enrol(app, owner, ownerId, OWNER.password);
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);

    for (const [method, path, payload] of [
      ['PUT', 'username', { password: anna.password, username: 'mine-now' }],
      ['PUT', 'password', { password: anna.password, newPassword: 'taken-over-123' }],
      ['DELETE', 'totp', { password: anna.password }],
    ] as const) {
      const res = await send(app, { cookie: annaCookie }, method, `/api/users/${ownerId}/${path}`, payload);
      expect({ path, status: res.statusCode }).toEqual({ path, status: 403 });
      expect(res.json().error.message).toBe("Only the owner can change the owner's account");
    }
    expect(await me(app, owner)).toMatchObject({ username: 'admin', twoFactor: { enabled: true } });

    // The owner does all of it themself.
    const mine = (method: Method, path: string, payload: object) =>
      send(app, { cookie: owner }, method, `/api/users/${ownerId}/${path}`, payload);
    expect((await mine('PUT', 'username', { password: OWNER.password, username: 'boss' })).statusCode).toBe(204);
    expect((await mine('DELETE', 'totp', { password: OWNER.password })).statusCode).toBe(204);
    const changed = await mine('PUT', 'password', { password: OWNER.password, newPassword: 'owner-password-2' });
    expect(changed.statusCode).toBe(204);
    expect(await status(app, cookieOf(changed))).toBe(200);
    await signIn(app, { username: 'boss', password: 'owner-password-2' });
  });

  it('sets two-factor up only from the account itself, but lets a colleague turn it off', async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);

    for (const [path, payload] of [
      ['setup', { password: OWNER.password }],
      ['enable', { code: '123456' }],
      ['recovery-codes', { password: OWNER.password }],
    ] as const) {
      const res = await send(app, { cookie: owner }, 'POST', `/api/users/${anna.id}/totp/${path}`, payload);
      expect({ path, status: res.statusCode }).toEqual({ path, status: 403 });
    }
    expect((await me(app, annaCookie)).twoFactor.enabled).toBe(false);

    // Anna enrols her own phone, loses it, and a colleague switches it off for her - while
    // she is still sitting at the code prompt, which sends her back to the password.
    const secret = await enrol(app, annaCookie, anna.id, anna.password);
    const stuck = await passwordStep(app, anna);
    expect(stuck.json().totpRequired).toBe(true);
    const off = await send(app, { cookie: owner }, 'DELETE', `/api/users/${anna.id}/totp`, {
      password: OWNER.password,
    });
    expect(off.statusCode).toBe(204);
    const code = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: { cookie: cookieOf(stuck) },
      payload: { code: nextCode(secret) },
      remoteAddress: nextAddress(),
    });
    expect(code.statusCode).toBe(401);
    expect(code.json().error.details).toEqual({ restart: true });
    expect((await passwordStep(app, anna)).json()).toEqual({ ok: true, totpRequired: false });
  });

  it('lets an API key list, add and remove admins, but never re-prove a password', async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const ownerId = (await me(app, owner)).id;
    const key = { token: (await send(app, { cookie: owner }, 'POST', '/api/api-keys', { name: 'ops' })).json().token };

    expect((await send(app, key, 'GET', '/api/users')).statusCode).toBe(200);
    const created = await send(app, key, 'POST', '/api/users', { username: 'made-by-a-key', password: 'from-a-script-1' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as PanelUserDto).id;
    expect((await send(app, key, 'GET', `/api/users/${id}`)).statusCode).toBe(200);

    // Even with the right password in the body: a key has no account for it to belong to.
    for (const target of [ownerId, id]) {
      for (const [method, path, payload] of [
        ['PUT', 'username', { password: OWNER.password, username: 'renamed' }],
        ['PUT', 'password', { password: OWNER.password, newPassword: 'set-by-a-key-1' }],
        ['POST', 'totp/setup', { password: OWNER.password }],
        ['POST', 'totp/enable', { code: '123456' }],
        ['POST', 'totp/recovery-codes', { password: OWNER.password }],
        ['DELETE', 'totp', { password: OWNER.password }],
      ] as const) {
        const res = await send(app, key, method, `/api/users/${target}/${path}`, payload);
        expect({ target, path, status: res.statusCode }).toEqual({ target, path, status: 403 });
      }
    }
    expect((await send(app, key, 'GET', '/api/auth/me')).json()).toEqual({ user: null, authVia: 'apiKey' });
    expect((await send(app, key, 'POST', '/api/auth/logout-all')).statusCode).toBe(403);
    expect(await status(app, owner)).toBe(200);
    expect((await send(app, key, 'DELETE', `/api/users/${id}`)).statusCode).toBe(204);
  });

  it('signs out everywhere only the admin who asks', async () => {
    const { app } = await makeApp();
    const owner = await signIn(app);
    const ownerElsewhere = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);

    expect((await send(app, { cookie: owner }, 'POST', '/api/auth/logout-all')).statusCode).toBe(204);
    expect(await status(app, owner)).toBe(401);
    expect(await status(app, ownerElsewhere)).toBe(401);
    expect(await status(app, annaCookie)).toBe(200);
  });

  it('renames: to the same name, into a clash, yourself and a colleague', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const ownerElsewhere = await signIn(app);
    const ownerId = (await me(app, owner)).id;
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);
    const rename = (id: number, username: string) =>
      send(app, { cookie: owner }, 'PUT', `/api/users/${id}/username`, { password: OWNER.password, username });

    // The name it already has is nothing to do.
    world.db.update(users).set({ updatedAt: 1 }).where(eq(users.id, ownerId)).run();
    expect((await rename(ownerId, 'admin')).statusCode).toBe(204);
    expect(world.deps.users.byId(ownerId)!.updatedAt).toBe(1);

    // Someone else's name in other letters is still theirs; your own is yours to recase.
    expect((await rename(ownerId, 'ANNA')).statusCode).toBe(409);
    expect((await rename(ownerId, 'Admin')).statusCode).toBe(204);

    // A rename signs nobody out, and the other browser reads the new name on its next poll.
    expect((await rename(ownerId, 'boss')).statusCode).toBe(204);
    expect((await me(app, ownerElsewhere)).username).toBe('boss');

    expect((await rename(anna.id, 'anna.k')).statusCode).toBe(204);
    expect((await me(app, annaCookie)).username).toBe('anna.k');
    await signIn(app, { username: 'anna.k', password: anna.password });
  });

  it('stamps a sign-in when it completes, not at the password or on a refresh', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const secret = await enrol(app, await signIn(app, anna), anna.id, anna.password);
    const lastLogin = () => world.deps.users.byId(anna.id)!.lastLoginAt;

    world.db.update(users).set({ lastLoginAt: null }).where(eq(users.id, anna.id)).run();
    const pending = cookieOf(await passwordStep(app, anna));
    expect(lastLogin()).toBeNull();
    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: { cookie: pending },
      payload: { code: nextCode(secret) },
      remoteAddress: nextAddress(),
    });
    expect(done.statusCode).toBe(200);
    expect(lastLogin()).toBeGreaterThan(0);

    world.db.update(users).set({ lastLoginAt: 1 }).where(eq(users.id, anna.id)).run();
    await me(app, cookieOf(done));
    expect(lastLogin()).toBe(1);
  });
});

/**
 * Put a database back the way a panel from before accounts left it: the one login in the
 * settings table, no users, and sessions that name nobody.
 */
function legacyLogin(w: TestWorld, admin: { username?: string; passwordHash?: string; totp?: unknown }): void {
  w.db.delete(users).run();
  if (admin.username !== undefined) w.deps.settings.setRaw('admin.username', admin.username);
  if (admin.passwordHash !== undefined) w.deps.settings.setRaw('admin.passwordHash', admin.passwordHash);
  if (admin.totp !== undefined) w.deps.settings.setRaw('admin.totp', admin.totp);
  for (const row of w.db.select().from(sessions).all()) {
    const { userId: _, generation: __, ...data } = JSON.parse(row.data) as Record<string, unknown>;
    w.db.update(sessions).set({ data: JSON.stringify(data), userId: null }).where(eq(sessions.sid, row.sid)).run();
  }
}

const legacyRows = (w: TestWorld) => w.db.select().from(settings).all().filter((r) => r.key.startsWith('admin.'));

describe('seeding the owner', () => {
  it('creates the owner on first boot, printing the password only when it made one up', async () => {
    const generated = await seed(createTestDb(), makeTestConfig({ PANEL_ADMIN_PASSWORD: '' }));
    expect(generated).toEqual({
      generatedOwnerPassword: { username: 'admin', password: expect.any(String), reason: 'first-boot' },
      adoptedLegacyAdmin: false,
    });

    const db = createTestDb();
    expect(await seed(db, makeTestConfig())).toEqual({ generatedOwnerPassword: null, adoptedLegacyAdmin: false });
    expect(db.select().from(users).all()).toEqual([expect.objectContaining({ username: 'admin', isOwner: 1 })]);
  });

  it('changes nothing on a database that already has its owner', async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    const cookie = await signIn(app);
    const before = w.db.select().from(users).all();

    expect(await seed(w.db, w.config)).toEqual({ generatedOwnerPassword: null, adoptedLegacyAdmin: false });
    expect(w.db.select().from(users).all()).toEqual(before);
    expect(await status(app, cookie)).toBe(200);
  });

  it('adopts the login from before accounts as the owner, sessions and all', async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    const cookie = await signIn(app);
    const secret = await enrol(app, cookie, w.deps.users.owner()!.id, OWNER.password);
    const { passwordHash, totp } = w.deps.users.owner()!;
    legacyLogin(w, { username: 'admin', passwordHash, totp: JSON.parse(totp!) });

    expect(await seed(w.db, w.config)).toEqual({ generatedOwnerPassword: null, adoptedLegacyAdmin: true });
    expect(w.db.select().from(users).all()).toEqual([
      expect.objectContaining({ username: 'admin', isOwner: 1, passwordHash }),
    ]);
    expect(legacyRows(w)).toEqual([]);
    // The browser that was signed in before the update still is, now as the owner.
    expect(await me(app, cookie)).toMatchObject({ username: 'admin', isOwner: true, twoFactor: { enabled: true } });
    // And the password still needs the code it needed.
    expect((await codeStep(app, OWNER, nextCode(secret))).statusCode).toBe(200);
  });

  it('after the old recovery recipe, restores the bootstrap name and keeps the second factor', async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    const cookie = await signIn(app);
    const secret = await enrol(app, cookie, w.deps.users.owner()!.id, OWNER.password);
    // Renamed once, then `delete from settings where key = 'admin.passwordHash'` to get back in.
    legacyLogin(w, { username: 'boss', totp: JSON.parse(w.deps.users.owner()!.totp!) });

    expect(await seed(w.db, w.config)).toEqual({ generatedOwnerPassword: null, adoptedLegacyAdmin: false });
    expect(w.db.select().from(users).all()).toEqual([expect.objectContaining({ username: 'admin', isOwner: 1 })]);
    expect(legacyRows(w)).toEqual([]);
    expect(await status(app, cookie)).toBe(401);
    expect((await codeStep(app, OWNER, nextCode(secret))).statusCode).toBe(200);
  });

  it("re-seeds a blanked owner password from PANEL_ADMIN_PASSWORD, keeping the owner's name", async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    const cookie = await signIn(app);
    const ownerId = w.deps.users.owner()!.id;
    const mine = (path: string, payload: object) =>
      send(app, { cookie }, 'PUT', `/api/users/${ownerId}/${path}`, payload);
    expect((await mine('username', { password: OWNER.password, username: 'boss' })).statusCode).toBe(204);
    const changed = await mine('password', { password: OWNER.password, newPassword: 'since-forgotten-1' });
    const signedIn = cookieOf(changed);

    w.db.update(users).set({ passwordHash: '' }).where(eq(users.isOwner, 1)).run();
    // Blank is not "any password": until the restart nothing opens it, not even the string
    // the timing dummy was hashed from.
    expect((await passwordStep(app, { username: 'boss', password: 'dummy-password-for-timing' })).statusCode).toBe(401);

    expect(await seed(w.db, w.config)).toEqual({ generatedOwnerPassword: null, adoptedLegacyAdmin: false });
    expect(await status(app, signedIn)).toBe(401);
    expect((await passwordStep(app, { username: 'boss', password: 'since-forgotten-1' })).statusCode).toBe(401);
    await signIn(app, { username: 'boss', password: OWNER.password });
  });

  it('prints a new owner password when there is no PANEL_ADMIN_PASSWORD to re-seed from', async () => {
    const w = await makeWorld({ env: { PANEL_ADMIN_PASSWORD: '' } });
    const { app } = await makeApp(w);
    w.db.update(users).set({ passwordHash: '' }).where(eq(users.isOwner, 1)).run();

    const { generatedOwnerPassword } = await seed(w.db, w.config);
    expect(generatedOwnerPassword).toEqual({ username: 'admin', password: expect.any(String), reason: 'reset' });
    await signIn(app, { username: 'admin', password: generatedOwnerPassword!.password });
  });
});

interface SentMail {
  to: string;
  subject: string;
  body: string;
}

/**
 * A panel with its outgoing mail captured rather than handed to a relay, signed in as the
 * owner. `mailWorks` is what the relay answers; `requests` is the forgot-password work the
 * route leaves running after it has answered.
 */
async function recoveryPanel(env?: Record<string, string>) {
  const w = await makeWorld(env ? { env } : {});
  const { app } = await makeApp(w);
  const sent: SentMail[] = [];
  const mailWorks = { value: true };
  /** While `hold` is set, every email waits in `waiting` until released - a slow relay. */
  const mailGate = { hold: false, waiting: [] as Array<() => void> };
  vi.spyOn(w.core.mail, 'sendPanelMail').mockImplementation(async (to, subject, body) => {
    if (mailGate.hold) await new Promise<void>((release) => mailGate.waiting.push(release));
    if (mailWorks.value) sent.push({ to, subject, body });
    return mailWorks.value;
  });
  const requests = vi.spyOn(w.deps.recovery, 'requestReset');
  const owner = await signIn(app);
  return { w, app, sent, mailWorks, mailGate, requests, owner, ownerId: w.deps.users.owner()!.id };
}

/**
 * A request made with `cookie` that is still running: it waits inside GET /api/mail/status
 * until `finish` lets it go - and then saves its session on the way out, as every response
 * does with `rolling: true`.
 */
async function requestInFlight(w: TestWorld, app: TestApp, cookie: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const status = vi.spyOn(w.core.mail, 'status');
  const before = status.mock.calls.length;
  status.mockImplementationOnce(async () => {
    await held;
    return [];
  });
  const response = app.inject({ method: 'GET', url: '/api/mail/status', headers: { cookie } });
  await waitFor(() => status.mock.calls.length > before);
  return {
    finish: async () => {
      release();
      return response;
    },
  };
}
type RecoveryPanel = Awaited<ReturnType<typeof recoveryPanel>>;

/** The link in an email, and the token after its `#`. */
function linkIn(mail: SentMail): { page: string; token: string } {
  const url = new URL(/https?:\/\/\S+/.exec(mail.body)![0]);
  return { page: `${url.origin}${url.pathname}`, token: url.hash.slice(1) };
}

const confirm = (app: TestApp, token: string) =>
  app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token }, remoteAddress: nextAddress() });

const resetWith = (app: TestApp, token: string, newPassword: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/reset-password',
    payload: { token, newPassword },
    headers: cookie ? { cookie } : {},
    remoteAddress: nextAddress(),
  });

/** "Forgot your password?", then wait for what the route does after answering. */
async function forgot(p: RecoveryPanel, login: string, headers: Record<string, string> = {}): Promise<void> {
  const before = p.requests.mock.calls.length;
  const res = await p.app.inject({
    method: 'POST',
    url: '/api/auth/forgot-password',
    payload: { login },
    headers,
    remoteAddress: nextAddress(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  await waitFor(() => p.requests.mock.calls.length > before);
  await p.requests.mock.results.at(-1)!.value;
}

/** Set an address on an account and follow the link it gets, as its owner would. */
async function confirmAddress(p: RecoveryPanel, cookie: string, id: number, password: string, email: string) {
  const set = await send(p.app, { cookie }, 'PUT', `/api/users/${id}/email`, { password, email });
  expect(set.statusCode).toBe(204);
  const res = await confirm(p.app, linkIn(p.sent.at(-1)!).token);
  expect(res.statusCode).toBe(200);
}

const resetMails = (p: RecoveryPanel) => p.sent.filter((m) => m.subject === 'Reset your password');

/** Wind an account's reset link back, as if it had gone out `ms` ago. */
function ageReset(p: RecoveryPanel, id: number, ms: number): void {
  const reset = p.w.deps.users.getPasswordReset(id)!;
  p.w.deps.users.setPasswordReset(id, { ...reset, sentAt: reset.sentAt - ms, expiresAt: reset.expiresAt - ms });
}

describe('recovery email and forgotten passwords', () => {
  it('makes an address the recovery address only through the link sent to it', async () => {
    const p = await recoveryPanel();
    const set = await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'Owner@Example.test',
    });
    expect(set.statusCode).toBe(204);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ to: 'Owner@Example.test', subject: 'Confirm your recovery email address' });
    expect(p.sent[0]!.body).toContain('You set this address as the recovery email of your WPL7 panel account "admin"');
    const { page, token } = linkIn(p.sent[0]!);
    expect(page).toBe('http://panel.example.test/confirm-email');
    expect(await me(p.app, p.owner)).toMatchObject({ email: null, pendingEmail: 'Owner@Example.test' });

    // Not the token that was sent: another secret, or another account's id.
    const otherSecret = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const bad of [otherSecret, token.replace(/^\d+/, '999'), 'not-a-token-at-all-really']) {
      expect((await confirm(p.app, bad)).statusCode).toBe(400);
    }
    const ok = await confirm(p.app, token);
    expect(ok.json()).toEqual({ username: 'admin', email: 'Owner@Example.test' });
    expect(await me(p.app, p.owner)).toMatchObject({ email: 'Owner@Example.test', pendingEmail: null });
    expect((await confirm(p.app, token)).statusCode).toBe(400);
  });

  it('keeps sending resets to the confirmed address until a new one is confirmed', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'old@example.test');
    await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'new@example.test',
    });
    expect(await me(p.app, p.owner)).toMatchObject({ email: 'old@example.test', pendingEmail: 'new@example.test' });

    await forgot(p, 'admin');
    expect(resetMails(p).map((m) => m.to)).toEqual(['old@example.test']);
  });

  it('emails a reset link that works once, signs everyone out and still asks for the code', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    const secret = await enrol(p.app, p.owner, p.ownerId, OWNER.password);

    await forgot(p, 'admin');
    const mail = resetMails(p)[0]!;
    expect(mail.to).toBe('owner@example.test');
    expect(mail.body).toContain('Signing in afterwards still asks for the code from your authenticator app.');
    const { page, token } = linkIn(mail);
    expect(page).toBe('http://panel.example.test/reset-password');

    const res = await resetWith(p.app, token, 'chosen-from-the-link');
    expect(res.json()).toEqual({ ok: true, username: 'admin' });
    expect(await status(p.app, p.owner)).toBe(401);
    expect((await passwordStep(p.app, OWNER)).statusCode).toBe(401);
    expect((await codeStep(p.app, { username: 'admin', password: 'chosen-from-the-link' }, nextCode(secret))).statusCode)
      .toBe(200);
    expect((await resetWith(p.app, token, 'and-once-more-1')).statusCode).toBe(400);

    await waitFor(() => p.sent.some((m) => m.subject === 'Your password was changed'));
    expect(p.sent.at(-1)).toMatchObject({ to: 'owner@example.test', subject: 'Your password was changed' });
  });

  it('answers the same whether it sends anything or not', async () => {
    const p = await recoveryPanel();
    const anna = await addAdmin(p.app, p.owner, 'anna');
    // A colleague sets it; the link goes to the address, and says who set it.
    await confirmAddress(p, p.owner, anna.id, OWNER.password, 'anna@example.test');
    expect(p.sent[0]!.body).toContain('admin set this address as the recovery email of the WPL7 panel account "anna"');
    // The owner has an address set but not confirmed, which is not somewhere to send a reset.
    await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'unconfirmed@example.test',
    });

    for (const login of ['nobody', 'admin', 'unconfirmed@example.test']) await forgot(p, login);
    expect(resetMails(p)).toEqual([]);

    // By username, or by the confirmed address in any case.
    await forgot(p, 'ANNA@example.test');
    expect(resetMails(p).map((m) => m.to)).toEqual(['anna@example.test']);
  });

  it('sends one reset email a minute per account, and only the newest link works', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    await forgot(p, 'admin');
    await forgot(p, 'admin');
    expect(resetMails(p)).toHaveLength(1);

    ageReset(p, p.ownerId, 61_000);
    await forgot(p, 'admin');
    const [first, second] = resetMails(p).map((m) => linkIn(m).token);
    expect((await resetWith(p.app, first!, 'from-the-older-link')).statusCode).toBe(400);
    expect((await resetWith(p.app, second!, 'from-the-newer-link')).statusCode).toBe(200);
  });

  it('retires a reset link when the password or the address changes, or when it expires', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    const nextLink = async () => {
      if (p.w.deps.users.getPasswordReset(p.ownerId)) ageReset(p, p.ownerId, 61_000);
      await forgot(p, 'admin');
      return linkIn(resetMails(p).at(-1)!).token;
    };

    // A password set some other way.
    let token = await nextLink();
    const changed = await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/password`, {
      password: OWNER.password,
      newPassword: 'set-on-the-page-1',
    });
    const owner = cookieOf(changed);
    expect((await resetWith(p.app, token, 'too-late-for-this')).statusCode).toBe(400);

    // A new address confirmed: the old mailbox's link belongs to a mailbox the account left.
    token = await nextLink();
    await confirmAddress(p, owner, p.ownerId, 'set-on-the-page-1', 'moved@example.test');
    expect((await resetWith(p.app, token, 'too-late-for-this')).statusCode).toBe(400);

    // Out of time.
    token = await nextLink();
    ageReset(p, p.ownerId, 31 * 60_000);
    expect((await resetWith(p.app, token, 'too-late-for-this')).statusCode).toBe(400);

    // The address removed: the link dies, and nothing is sent any more.
    ageReset(p, p.ownerId, 61_000);
    token = await nextLink();
    const removed = await send(p.app, { cookie: owner }, 'DELETE', `/api/users/${p.ownerId}/email`, {
      password: 'set-on-the-page-1',
    });
    expect(removed.statusCode).toBe(204);
    expect(await me(p.app, owner)).toMatchObject({ email: null, pendingEmail: null });
    expect((await resetWith(p.app, token, 'too-late-for-this')).statusCode).toBe(400);
    const count = resetMails(p).length;
    await forgot(p, 'admin');
    expect(resetMails(p)).toHaveLength(count);
  });

  it('forgets a confirmation that was not followed in time', async () => {
    const p = await recoveryPanel();
    await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'slow@example.test',
    });
    const pending = p.w.deps.users.getPendingEmail(p.ownerId)!;
    p.w.deps.users.setPendingEmail(p.ownerId, { ...pending, expiresAt: Date.now() - 1 });
    expect(await me(p.app, p.owner)).toMatchObject({ email: null, pendingEmail: null });
    expect((await confirm(p.app, linkIn(p.sent[0]!).token)).statusCode).toBe(400);
  });

  it('builds links from PANEL_DOMAIN, whatever Host the request claimed', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    await forgot(p, 'admin', { host: 'attacker.test', 'x-forwarded-host': 'attacker.test' });
    expect(linkIn(resetMails(p)[0]!).page).toBe('http://panel.example.test/reset-password');
  });

  it("follows the account rules: the owner's address is the owner's, and a key cannot set one", async () => {
    const p = await recoveryPanel();
    const anna = await addAdmin(p.app, p.owner, 'anna');
    const annaCookie = await signIn(p.app, anna);
    const key = { token: (await send(p.app, { cookie: p.owner }, 'POST', '/api/api-keys', { name: 'k' })).json().token };

    const toOwner = await send(p.app, { cookie: annaCookie }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: anna.password,
      email: 'mine-now@example.test',
    });
    expect(toOwner.statusCode).toBe(403);
    for (const [method, payload] of [
      ['PUT', { password: OWNER.password, email: 'k@example.test' }],
      ['DELETE', { password: OWNER.password }],
    ] as const) {
      expect((await send(p.app, key, method, `/api/users/${anna.id}/email`, payload)).statusCode).toBe(403);
    }
    expect(p.sent).toEqual([]);

    const own = await send(p.app, { cookie: annaCookie }, 'PUT', `/api/users/${anna.id}/email`, {
      password: anna.password,
      email: 'anna@example.test',
    });
    expect(own.statusCode).toBe(204);
  });

  it('refuses an address it could not send the link to, and keeps nothing', async () => {
    const p = await recoveryPanel();
    p.mailWorks.value = false;
    const res = await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'owner@example.test',
    });
    expect(res.statusCode).toBe(502);
    expect(await me(p.app, p.owner)).toMatchObject({ email: null, pendingEmail: null });
  });

  it('refuses to set an address when the panel has no domain to link back to', async () => {
    const p = await recoveryPanel({ PANEL_DOMAIN: '' });
    const res = await send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'owner@example.test',
    });
    expect(res.statusCode).toBe(409);
    expect(p.sent).toEqual([]);
  });

  it('does not bring back an address withdrawn while its confirmation was being sent', async () => {
    const p = await recoveryPanel();
    p.mailGate.hold = true;
    const put = send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
      email: 'withdrawn@example.test',
    });
    await waitFor(() => p.mailGate.waiting.length === 1);
    p.mailGate.hold = false;
    const removed = await send(p.app, { cookie: p.owner }, 'DELETE', `/api/users/${p.ownerId}/email`, {
      password: OWNER.password,
    });
    expect(removed.statusCode).toBe(204);
    p.mailGate.waiting.shift()!();
    expect((await put).statusCode).toBe(204);

    expect(await me(p.app, p.owner)).toMatchObject({ email: null, pendingEmail: null });
    expect((await confirm(p.app, linkIn(p.sent.at(-1)!).token)).statusCode).toBe(400);
    expect(await me(p.app, p.owner)).toMatchObject({ email: null });
  });

  it('keeps the address set last, whichever confirmation finishes sending first', async () => {
    const p = await recoveryPanel();
    const setAddress = (email: string) =>
      send(p.app, { cookie: p.owner }, 'PUT', `/api/users/${p.ownerId}/email`, { password: OWNER.password, email });
    p.mailGate.hold = true;
    const older = setAddress('older@example.test');
    await waitFor(() => p.mailGate.waiting.length === 1);
    p.mailGate.hold = false;
    expect((await setAddress('newer@example.test')).statusCode).toBe(204);
    p.mailGate.waiting.shift()!();
    expect((await older).statusCode).toBe(204);

    expect(await me(p.app, p.owner)).toMatchObject({ pendingEmail: 'newer@example.test' });
    const tokenTo = (to: string) => linkIn(p.sent.find((m) => m.to === to)!).token;
    expect((await confirm(p.app, tokenTo('older@example.test'))).statusCode).toBe(400);
    expect((await confirm(p.app, tokenTo('newer@example.test'))).statusCode).toBe(200);
  });

  it('sends no reset link to an address an account dropped while another link was on its way', async () => {
    const p = await recoveryPanel();
    const anna = await addAdmin(p.app, p.owner, 'anna');
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'shared@example.test');
    await confirmAddress(p, p.owner, anna.id, OWNER.password, 'shared@example.test');

    p.mailGate.hold = true;
    const before = p.requests.mock.calls.length;
    const asked = await p.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { login: 'shared@example.test' },
      remoteAddress: nextAddress(),
    });
    expect(asked.statusCode).toBe(200);
    await waitFor(() => p.mailGate.waiting.length === 1); // the owner's link, on its way
    p.mailGate.hold = false;
    const dropped = await send(p.app, { cookie: p.owner }, 'DELETE', `/api/users/${anna.id}/email`, {
      password: OWNER.password,
    });
    expect(dropped.statusCode).toBe(204);
    p.mailGate.waiting.shift()!();
    await waitFor(() => p.requests.mock.calls.length > before);
    await p.requests.mock.results.at(-1)!.value;

    expect(resetMails(p)).toHaveLength(1);
    expect(p.w.deps.users.getPasswordReset(anna.id)).toBeNull();
  });

  it('lets a reset link work only while the address it went to is still the account\'s', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    await forgot(p, 'admin');
    // Changed underneath the link, by anything that did not retire the link itself.
    p.w.db.update(users).set({ email: 'elsewhere@example.test' }).where(eq(users.id, p.ownerId)).run();
    expect((await resetWith(p.app, linkIn(resetMails(p)[0]!).token, 'not-from-here-1')).statusCode).toBe(400);
  });

  it('keeps sessions a reset revoked revoked, even one with a request still running', async () => {
    const p = await recoveryPanel();
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');
    const running = await requestInFlight(p.w, p.app, p.owner);

    await forgot(p, 'admin');
    expect((await resetWith(p.app, linkIn(resetMails(p)[0]!).token, 'chosen-from-the-link')).statusCode).toBe(200);
    expect(await status(p.app, p.owner)).toBe(401);

    // The request that was already running answers - and saves its session on the way out.
    expect((await running.finish()).statusCode).toBe(200);
    expect(await status(p.app, p.owner)).toBe(401);
  });

  it("signs out the browser the reset was done in when it was that account's, and only then", async () => {
    const p = await recoveryPanel();
    const anna = await addAdmin(p.app, p.owner, 'anna');
    await confirmAddress(p, p.owner, anna.id, OWNER.password, 'anna@example.test');
    await confirmAddress(p, p.owner, p.ownerId, OWNER.password, 'owner@example.test');

    // Anna's link, followed in the owner's browser: the owner stays signed in.
    await forgot(p, 'anna');
    expect((await resetWith(p.app, linkIn(resetMails(p).at(-1)!).token, 'anna-chose-this', p.owner)).statusCode).toBe(200);
    expect(await status(p.app, p.owner)).toBe(200);

    // The owner's own link in the owner's browser: that session goes with the old password.
    await forgot(p, 'admin');
    expect((await resetWith(p.app, linkIn(resetMails(p).at(-1)!).token, 'owner-chose-this', p.owner)).statusCode).toBe(200);
    expect(await status(p.app, p.owner)).toBe(401);
    expect(p.w.db.select().from(sessions).where(eq(sessions.userId, p.ownerId)).all()).toEqual([]);
  });
});

describe('revoked sessions stay revoked', () => {
  it('stays signed out after signing out, even with a request of that session still running', async () => {
    const { app, world } = await makeApp();
    const cookie = await signIn(app);
    const running = await requestInFlight(world, app, cookie);
    expect((await send(app, { cookie }, 'POST', '/api/auth/logout')).statusCode).toBe(204);
    await running.finish();
    expect(await status(app, cookie)).toBe(401);
  });

  it('keeps the other sessions a new password ended ended, whatever they had running', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const anna = await addAdmin(app, owner, 'anna');
    const annaCookie = await signIn(app, anna);
    const running = await requestInFlight(world, app, annaCookie);
    const reset = await send(app, { cookie: owner }, 'PUT', `/api/users/${anna.id}/password`, {
      password: OWNER.password,
      newPassword: 'set-by-the-owner-1',
    });
    expect(reset.statusCode).toBe(204);
    await running.finish();
    expect(await status(app, annaCookie)).toBe(401);
  });

  it('keeps the session that turned 2FA on signed in, whatever it had running', async () => {
    const { app, world } = await makeApp();
    const owner = await signIn(app);
    const other = await signIn(app);
    const running = await requestInFlight(world, app, owner);
    // Revokes every other session of the account, keeps this one...
    await enrol(app, owner, world.deps.users.owner()!.id, OWNER.password);
    // ...and a save of it made from before the revocation must not undo that.
    await running.finish();
    expect(await status(app, owner)).toBe(200);
    expect(await status(app, other)).toBe(401);
  });

  it('moves the session a revocation keeps to the new generation at once', async () => {
    const { app, world } = await makeApp();
    const kept = await signIn(app);
    const [row] = world.db.select().from(sessions).all();
    // No request of its own finishing afterwards to save the new number: the row has it.
    world.deps.users.revokeSessions(world.deps.users.owner()!.id, row!.sid);
    expect(await status(app, kept)).toBe(200);
  });

  it('does not let a sign-in that was under way outlive a revocation', async () => {
    const { app, world } = await makeApp();
    const ownerId = world.deps.users.owner()!.id;
    // The revocation lands after the password was accepted, before the new session is saved.
    vi.spyOn(world.deps.twoFactor, 'isEnabled').mockImplementationOnce(() => {
      world.deps.users.revokeSessions(ownerId);
      return false;
    });
    const res = await passwordStep(app, OWNER);
    expect(res.statusCode).toBe(200);
    expect(await status(app, cookieOf(res))).toBe(401);
  });
});
