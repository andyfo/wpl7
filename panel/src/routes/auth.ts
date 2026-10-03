import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import argon2 from 'argon2';
import {
  confirmEmailBody,
  forgotPasswordBody,
  loginBody,
  resetPasswordBody,
  twoFactorCodeBody,
} from '../../shared/schemas.js';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

// Constant-time-ish behavior: verify against a real hash even when the username is wrong.
const DUMMY_HASH_PROMISE = argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });

/** How long a password-only session may sit waiting for its code. */
const TOTP_PENDING_MS = 5 * 60_000;

/**
 * Signing in and out. Changing an account - name, password, second factor - is
 * routes/users.ts, since any admin may do some of it to someone else's.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/api/auth/login',
    { schema: { body: loginBody }, config: { rateLimit: { max: 5, timeWindow: 60_000 } } },
    async (req, reply) => {
      // Every admin has an account of their own, and the name says whose password to check.
      // An unknown name - or an owner whose hash was blanked to be re-seeded at the next
      // boot - is checked against a real hash all the same, so the answer takes as long.
      const user = deps.users.byUsername(req.body.username);
      const dummy = await DUMMY_HASH_PROMISE;
      const hash = user && user.passwordHash !== '' ? user.passwordHash : dummy;
      const ok = await argon2.verify(hash, req.body.password).catch(() => false);
      if (!ok || !user || hash === dummy) throw unauthorized('Invalid username or password');
      // Read again after the verify: a password reset that landed while it ran has already
      // revoked every session this account had, and must not be outrun by a new one opened
      // with the password it replaced. One landing from here on raises the generation this
      // session takes, and the store will not save a session of the old one.
      const current = deps.users.byId(user.id);
      if (!current || current.passwordHash !== hash) throw unauthorized('Invalid username or password');
      await rotateSession(req, deps.db);
      req.session.userId = user.id;
      req.session.generation = current.sessionGeneration;
      if (deps.twoFactor.isEnabled(user.id)) {
        // Half a login. The auth gate only ever looks at `authenticated`, so this session
        // can do exactly one thing - present a code to the route below - until it is
        // promoted, and it expires on its own if nobody does.
        req.session.totpPendingUntil = Date.now() + TOTP_PENDING_MS;
        return reply.send({ ok: true, totpRequired: true });
      }
      req.session.authenticated = true;
      deps.users.touchLogin(user.id);
      return reply.send({ ok: true, totpRequired: false });
    },
  );

  /**
   * Second half of the login. Public like the first half: what it acts on is the pending
   * session, and with `sameSite: strict` no other origin can make the browser send that
   * cookie. The session already names whose password was accepted, so the code is checked
   * against that account's authenticator and a wrong one spends that account's budget.
   */
  r.post(
    '/api/auth/login/totp',
    { schema: { body: twoFactorCodeBody }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      // `restart` tells the login page the pending session is gone for good, so it can put
      // the password form back instead of leaving a code box that can never succeed.
      const pendingUntil = req.session?.totpPendingUntil ?? 0;
      if (pendingUntil < Date.now()) {
        if (req.session) await req.session.destroy();
        throw unauthorized('Your sign-in took too long. Start again', { restart: true });
      }
      const user = req.session.userId === undefined ? null : deps.users.byId(req.session.userId);
      const generation = req.session.generation ?? 0;
      if (!user || !deps.twoFactor.isEnabled(user.id) || generation !== user.sessionGeneration) {
        // Removed between the password and the code, revoked, or no longer asked for a code:
        // a colleague turning off a lost phone's 2FA is the usual way back in, and whoever
        // lost it is typically still sitting at this prompt. The password alone opens it now.
        await req.session.destroy();
        throw unauthorized('This sign-in is no longer valid. Start again', { restart: true });
      }
      const verdict = deps.twoFactor.verify(user.id, req.body.code);
      if (!verdict.ok) {
        if (!verdict.lockedOut) throw unauthorized('That code is not right');
        // The guess budget is spent account-wide, so this browser gets nothing more out of
        // its half-login either; drop it and make the password be typed again.
        await req.session.destroy();
        throw unauthorized('Too many wrong codes. Wait a few minutes, then sign in again', {
          restart: true,
        });
      }
      await rotateSession(req, deps.db);
      req.session.userId = user.id;
      req.session.generation = generation;
      req.session.authenticated = true;
      deps.users.touchLogin(user.id);
      return reply.send({ ok: true });
    },
  );

  r.post('/api/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.status(204).send();
  });

  /**
   * "Forgot your password?". The answer is the same whatever the name turns out to be - an
   * account with a confirmed address, one without, no account at all - and the looking is
   * done after answering, so neither the reply nor the time it took gives an account away.
   */
  r.post(
    '/api/auth/forgot-password',
    { schema: { body: forgotPasswordBody }, config: { rateLimit: { max: 5, timeWindow: 60_000 } } },
    async (req) => {
      const { login } = req.body;
      setImmediate(() => {
        deps.recovery
          .requestReset(login)
          .catch((err: unknown) => deps.log.warn(`Password reset request failed: ${String(err)}`));
      });
      return { ok: true };
    },
  );

  /** The emailed link's token and a new password. Every session of the account ends. */
  r.post(
    '/api/auth/reset-password',
    { schema: { body: resetPasswordBody }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req) => {
      const { userId, username } = await deps.recovery.resetPassword(req.body.token, req.body.newPassword);
      // This browser's session ended with the rest if it is signed in as that account; drop
      // it here too, so the response does not hand back a cookie that opens nothing.
      if (req.session?.userId === userId) await req.session.destroy();
      return { ok: true, username };
    },
  );

  /** The link that makes a pending address the account's recovery address. */
  r.post(
    '/api/auth/confirm-email',
    { schema: { body: confirmEmailBody }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req) => deps.recovery.confirmEmail(req.body.token),
  );

  // The stored account rather than a copy taken at sign-in: a rename has to reach the
  // browsers that were already signed in when it happened. An API key is nobody's, so it
  // gets `user: null`.
  r.get('/api/auth/me', async (req) => {
    const row = req.user ? deps.users.byId(req.user.id) : null;
    return { user: row ? deps.users.toDto(row) : null, authVia: req.authVia };
  });

  /**
   * Sign out everywhere: every session of the admin asking, this one included. Nobody
   * else's, and no API key - those are revoked on their own page.
   */
  r.post('/api/auth/logout-all', async (req, reply) => {
    if (!req.user) throw forbidden('Sign in to do this; an API key has no sessions of its own');
    deps.users.revokeSessions(req.user.id);
    // This session went with the rest; destroy() also tells the plugin there is nothing left
    // to save, so the response does not hand back a cookie that opens nothing.
    await req.session.destroy();
    return reply.status(204).send();
  });
}

/**
 * Move to a fresh session id and drop the row the old one lived under. `regenerate()` mints
 * the new session but leaves the old one in the store, so without this a pre-login cookie -
 * or a pending half-login that just got promoted - would stay usable on its own until it
 * expired a week later.
 */
export async function rotateSession(req: FastifyRequest, db: Db): Promise<void> {
  const previous = req.session.sessionId;
  await req.session.regenerate();
  db.delete(sessions).where(eq(sessions.sid, previous)).run();
}
