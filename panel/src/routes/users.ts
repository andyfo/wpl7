import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  passwordConfirmBody,
  twoFactorCodeBody,
  userCreateBody,
  userEmailBody,
  userPasswordBody,
  userRenameBody,
} from '../../shared/schemas.js';
import type { UserRow } from '../db/schema.js';
import { conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import type { PanelUserRef } from '../services/users.js';
import { rotateSession } from './auth.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** A key belongs to the panel, not to a person, so there is no password behind it to re-prove. */
const NOT_WITH_A_KEY = 'Sign in as a user to do this; an API key has no password to confirm';

/**
 * The admin accounts. Any admin may add another, remove anyone but the owner and themself,
 * and change any account but the owner's: rename it, set a new password or a recovery email,
 * turn its two-factor off. Setting a password and turning 2FA off are how a colleague gets
 * someone back in; the owner, whose account nobody else may touch, has "Forgot your
 * password?" with a confirmed recovery address, and the database after that
 * (docs/troubleshooting.md).
 *
 * Listing, adding and removing accounts works with an API key, as the keys' own routes do.
 * Everything that re-asks for a password needs a signed-in admin: the password it asks for
 * is always the caller's own, and a key has none.
 */
export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/users', async () => ({ items: deps.users.list().map((row) => deps.users.toDto(row)) }));

  r.post('/api/users', { schema: { body: userCreateBody } }, async (req, reply) => {
    const passwordHash = await argon2.hash(req.body.password, { type: argon2.argon2id });
    const row = deps.users.create({ username: req.body.username, passwordHash });
    return reply.status(201).send(deps.users.toDto(row));
  });

  r.get('/api/users/:id', { schema: { params: idParams } }, async (req) =>
    deps.users.toDto(userOr404(deps, req.params.id)),
  );

  r.delete('/api/users/:id', { schema: { params: idParams } }, async (req, reply) => {
    const target = userOr404(deps, req.params.id);
    if (target.isOwner === 1) throw conflict('The owner cannot be removed');
    // Someone else has to do it, which leaves someone behind who can still sign in.
    if (target.id === req.user?.id) throw conflict('You cannot remove your own account');
    deps.users.remove(target.id);
    return reply.status(204).send();
  });

  /**
   * Rename an account. The password guards it like any other change to a login, but unlike
   * one this rotates no secret: every session stays signed in, because revoking them would
   * cost their owner their other devices and protect nothing. They read the new name off
   * `/auth/me` on their next poll.
   *
   * The name a site's WordPress administrator has is a different thing entirely, changed on
   * the site page - this is only the panel login.
   */
  r.put(
    '/api/users/:id/username',
    { schema: { params: idParams, body: userRenameBody } },
    async (req, reply) => {
      const { target } = await manageable(req, deps, req.params.id, req.body.password);
      deps.users.rename(target.id, req.body.username);
      return reply.status(204).send();
    },
  );

  /**
   * A new password. On your own account every OTHER session is revoked and this one is
   * re-issued: a session opened before the change used to survive it - and could keep acting
   * as you, minting API keys included. On a colleague's, all of theirs end, since each was
   * opened with a password that no longer works. API keys are unaffected either way.
   */
  r.put(
    '/api/users/:id/password',
    { schema: { params: idParams, body: userPasswordBody } },
    async (req, reply) => {
      const { target, self } = await manageable(req, deps, req.params.id, req.body.password);
      const hash = await argon2.hash(req.body.newPassword, { type: argon2.argon2id });
      // Only the hash: a rename that landed while it was being computed must survive.
      deps.users.setPasswordHash(target.id, hash);
      if (self) {
        await rotateSession(req, deps.db);
        req.session.userId = target.id;
        req.session.authenticated = true;
        req.session.generation = deps.users.revokeSessions(target.id, req.session.sessionId);
      } else {
        deps.users.revokeSessions(target.id);
      }
      return reply.status(204).send();
    },
  );

  /**
   * The address "Forgot your password?" sends its link to. It becomes that only once the link
   * sent to it is followed; until then an address already confirmed keeps the job, so a typo
   * can neither lock anyone out nor send a working reset link to a stranger.
   */
  r.put(
    '/api/users/:id/email',
    { schema: { params: idParams, body: userEmailBody } },
    async (req, reply) => {
      const { me, target } = await manageable(req, deps, req.params.id, req.body.password);
      await deps.recovery.startEmailConfirmation(target, req.body.email, me.username);
      return reply.status(204).send();
    },
  );

  r.delete(
    '/api/users/:id/email',
    { schema: { params: idParams, body: passwordConfirmBody } },
    async (req, reply) => {
      const { target } = await manageable(req, deps, req.params.id, req.body.password);
      deps.users.clearEmail(target.id);
      return reply.status(204).send();
    },
  );

  // ------------------------------------------------------- two-factor management
  //
  // Anything that changes where a second factor lives re-checks the caller's password first:
  // a borrowed session, or a laptop left unlocked, must not be enough on its own. `enable` is
  // the exception only because it cannot be reached without `setup`, which did ask.
  //
  // Setting it up is for the account itself - nobody can enrol a phone they are not holding.
  // Turning it off is not: that is how a colleague who lost theirs gets back in.

  r.post(
    '/api/users/:id/totp/setup',
    { schema: { params: idParams, body: passwordConfirmBody } },
    async (req) => {
      const me = await selfWithPassword(req, deps, req.params.id, req.body.password);
      return deps.twoFactor.startEnrollment(me);
    },
  );

  r.post(
    '/api/users/:id/totp/enable',
    { schema: { params: idParams, body: twoFactorCodeBody } },
    async (req) => {
      const me = requireSelf(req, req.params.id);
      const recoveryCodes = deps.twoFactor.confirmEnrollment(me.id, req.body.code);
      // Sessions opened before this moment never passed a second factor. Turning 2FA on and
      // leaving them alive would mean the protection starts at the next sign-in, not now.
      req.session.generation = deps.users.revokeSessions(me.id, req.session.sessionId);
      return { recoveryCodes };
    },
  );

  r.post(
    '/api/users/:id/totp/recovery-codes',
    { schema: { params: idParams, body: passwordConfirmBody } },
    async (req) => {
      const me = await selfWithPassword(req, deps, req.params.id, req.body.password);
      return { recoveryCodes: deps.twoFactor.regenerateRecoveryCodes(me.id) };
    },
  );

  r.delete(
    '/api/users/:id/totp',
    { schema: { params: idParams, body: passwordConfirmBody } },
    async (req, reply) => {
      const { target } = await manageable(req, deps, req.params.id, req.body.password);
      deps.twoFactor.disable(target.id);
      return reply.status(204).send();
    },
  );
}

function userOr404(deps: AppDeps, id: number): UserRow {
  const row = deps.users.byId(id);
  if (!row) throw notFound(`User #${id} not found`);
  return row;
}

/**
 * Step-up check in front of a sensitive change, against the caller's own password. A wrong
 * password here is a 403, not a 401: the request WAS authenticated - the session cookie is
 * valid and stays valid - and it is this one action that is refused. The distinction is not
 * pedantry. The browser client treats a 401 as "your session is gone" and sends you to
 * /login, so answering 401 would throw away a working session over a typo, which is worst
 * precisely for the person disabling 2FA because they just lost their authenticator.
 */
async function requireSelfPassword(req: FastifyRequest, deps: AppDeps, password: string): Promise<UserRow> {
  if (!req.user) throw forbidden(NOT_WITH_A_KEY);
  const me = deps.users.byId(req.user.id);
  if (!me) throw unauthorized();
  const ok = await argon2.verify(me.passwordHash, password).catch(() => false);
  if (!ok) throw forbidden('Your password is incorrect');
  return me;
}

/**
 * The account `id`, if the caller may change it: their own, or anyone's but the owner's.
 * The cheap refusals come first - no such account, the owner's asked for by someone else - so
 * that a request bound to fail does not spend an argon2 verify on the way.
 */
async function manageable(
  req: FastifyRequest,
  deps: AppDeps,
  id: number,
  password: string,
): Promise<{ me: UserRow; target: UserRow; self: boolean }> {
  if (!req.user) throw forbidden(NOT_WITH_A_KEY);
  const target = userOr404(deps, id);
  const self = target.id === req.user.id;
  if (target.isOwner === 1 && !self) throw forbidden("Only the owner can change the owner's account");
  const me = await requireSelfPassword(req, deps, password);
  return { me, target, self };
}

/** Setting up a second factor happens on the account itself, or not at all. */
function requireSelf(req: FastifyRequest, id: number): PanelUserRef {
  if (!req.user) throw forbidden(NOT_WITH_A_KEY);
  if (req.user.id !== id) throw forbidden('Two-factor authentication can only be set up from the account itself');
  return req.user;
}

async function selfWithPassword(req: FastifyRequest, deps: AppDeps, id: number, password: string): Promise<UserRow> {
  requireSelf(req, id);
  return requireSelfPassword(req, deps, password);
}
