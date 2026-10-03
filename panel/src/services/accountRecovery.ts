import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { Config } from '../config.js';
import type { UserRow } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { panelUrl } from '../lib/panelUrl.js';
import { badGateway, badRequest, conflict, notFound } from '../lib/errors.js';
import type { Logger } from './index.js';
import type { UsersService } from './users.js';

/** How long a reset link works: long enough to find the mail, useless in a leaked inbox later. */
const RESET_TTL_MS = 30 * 60_000;

/** A confirmation waits for someone to get round to their mail, which can take a day. */
const CONFIRM_TTL_MS = 24 * 3600_000;

/**
 * At most one reset email per account per minute, however often the form is sent. It is a
 * public form, and without this it is a way to fill somebody's inbox.
 */
const RESET_COOLDOWN_MS = 60_000;

/** What the panel sends mail with; MailService in the app, a spy in the tests. */
export interface PanelMailer {
  sendPanelMail(to: string, subject: string, body: string): Promise<boolean>;
}

/**
 * Getting back into an account by email: the recovery address (set on the account page,
 * confirmed by following a link sent to it) and "Forgot your password?" on the sign-in page,
 * which sends that address a link to choose a new password.
 *
 * Every link carries `<account id>.<secret>` after the `#`, so the token never reaches a
 * server log or a Referer header, and only its sha256 is stored. A link works once, and only
 * the newest one of its kind works at all. A reset changes the password and nothing else:
 * the account's second factor is still asked for at the next sign-in, so a mailbox alone is
 * not enough to get in where 2FA is on.
 */
export class AccountRecoveryService {
  constructor(
    private readonly users: UsersService,
    private readonly mail: PanelMailer,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /**
   * Park `email` on the account and send it a confirmation link.
   *
   * Stored before it is sent, not after: sending takes a while, and whatever happens to the
   * account in the meantime - the address removed, another one set - is newer than this and
   * has to stand. Written after the send, this would bring back a removed address, or let a
   * slow send overwrite the address set after it. A send that fails takes its own attempt
   * back, and only its own, so the address is refused on the spot rather than left waiting
   * for a link that never left.
   */
  async startEmailConfirmation(user: UserRow, email: string, setBy: string): Promise<void> {
    const base = this.panelUrl();
    if (!base) throw conflict('This panel has no PANEL_DOMAIN set, so an email to it could not link back');
    const account = this.users.byId(user.id);
    if (!account) throw notFound(`User #${user.id} not found`);
    if (email === account.email) {
      // The address it already has: whatever was pending is withdrawn, and nothing is sent.
      this.users.setPendingEmail(account.id, null);
      return;
    }
    const { token, tokenHash } = mintToken(account.id);
    this.users.setPendingEmail(account.id, { email, tokenHash, expiresAt: Date.now() + CONFIRM_TTL_MS });
    const sent = await this.mail.sendPanelMail(
      email,
      'Confirm your recovery email address',
      confirmMessage({ user: account, setBy, link: `${base}/confirm-email#${token}`, host: this.config.panelDomain }),
    );
    if (!sent) {
      if (this.users.getPendingEmail(account.id)?.tokenHash === tokenHash) this.users.setPendingEmail(account.id, null);
      throw badGateway('The confirmation email could not be sent; check that the mail relay is running (Mail page)');
    }
  }

  confirmEmail(token: string): { username: string; email: string } {
    const user = this.accountOf(token);
    const pending = user ? this.users.getPendingEmail(user.id) : null;
    if (!user || !pending || pending.expiresAt < Date.now() || !sameHash(pending.tokenHash, sha256Hex(token))) {
      throw badRequest('This link has expired or was already used. Set the address again to get a new one');
    }
    this.users.confirmEmail(user.id, pending.email);
    this.log.info(`Recovery email of "${user.username}" confirmed`);
    return { username: user.username, email: pending.email };
  }

  /**
   * "Forgot your password?" for a username or a confirmed address. Settles nothing for the
   * caller: the route has already answered, the same way whatever this finds.
   */
  async requestReset(login: string): Promise<void> {
    const folded = login.toLowerCase();
    const matches = (u: UserRow): u is UserRow & { email: string } =>
      u.email !== null && (u.username === login || u.email.toLowerCase() === folded);
    const ids = this.users.list().filter(matches).map((u) => u.id);
    for (const id of ids) {
      // Read again for every account: sending to the one before took a while, and in it
      // this one may have changed or dropped its address. A link must never go to a
      // mailbox the account has left.
      const user = this.users.byId(id);
      if (!user || !matches(user)) continue;
      const base = this.panelUrl();
      if (!base) {
        this.log.warn(`No password reset email for "${user.username}": PANEL_DOMAIN is not set`);
        return;
      }
      const now = Date.now();
      const previous = this.users.getPasswordReset(user.id);
      if (previous && now - previous.sentAt < RESET_COOLDOWN_MS) continue;
      const { token, tokenHash } = mintToken(user.id);
      // Stored before it is sent, so the link works the moment it arrives. Replacing the
      // previous one is what makes only the newest link work.
      this.users.setPasswordReset(user.id, {
        tokenHash,
        expiresAt: now + RESET_TTL_MS,
        sentAt: now,
        sentTo: user.email,
      });
      const sent = await this.mail.sendPanelMail(
        user.email,
        'Reset your password',
        resetMessage({
          user,
          link: `${base}/reset-password#${token}`,
          host: this.config.panelDomain,
          twoFactor: user.totp !== null,
        }),
      );
      if (sent) this.log.info(`Password reset link emailed for "${user.username}"`);
      else this.log.warn(`Password reset link for "${user.username}" could not be emailed`);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<{ userId: number; username: string }> {
    // Spent before the hash is computed, not after: two requests racing with one link would
    // otherwise both get through while the first was still hashing.
    const user = this.accountOf(token);
    const reset = user ? this.users.getPasswordReset(user.id) : null;
    if (
      !user ||
      !reset ||
      reset.expiresAt < Date.now() ||
      // The address it went to has to still be the account's: a mailbox the account has
      // left gets no say over its password, however the link came to outlive the change.
      reset.sentTo !== user.email ||
      !sameHash(reset.tokenHash, sha256Hex(token))
    ) {
      throw badRequest('This link has expired or was already used. Ask for a new one');
    }
    this.users.setPasswordReset(user.id, null);

    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    this.users.setPasswordHash(user.id, hash);
    // Whatever was opened with the old password goes with it. The second factor stays as it was.
    this.users.revokeSessions(user.id);
    this.log.info(`Password of "${user.username}" reset from an emailed link`);
    if (user.email) {
      const to = user.email;
      void this.mail
        .sendPanelMail(to, 'Your password was changed', changedMessage({ user, host: this.config.panelDomain }))
        .catch((err: unknown) => this.log.warn(`Could not send the password-changed notice: ${String(err)}`));
    }
    return { userId: user.id, username: user.username };
  }

  /** Where the links point: lib/panelUrl.ts, which never takes it from the request. */
  private panelUrl(): string | null {
    return panelUrl(this.config);
  }

  /** The account a token names; its secret is checked against what that account has stored. */
  private accountOf(token: string): UserRow | null {
    const match = /^(\d{1,10})\.[A-Za-z0-9_-]{43}$/.exec(token);
    return match ? this.users.byId(Number(match[1])) : null;
  }
}

function mintToken(userId: number): { token: string; tokenHash: string } {
  const token = `${userId}.${crypto.randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: sha256Hex(token) };
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function confirmMessage(o: { user: UserRow; setBy: string; link: string; host: string }): string {
  const who =
    o.setBy === o.user.username
      ? `You set this address as the recovery email of your WPL7 panel account "${o.user.username}"`
      : `${o.setBy} set this address as the recovery email of the WPL7 panel account "${o.user.username}"`;
  return [
    `${who} at ${o.host}.`,
    '',
    'To confirm it, open this link within 24 hours and press Confirm:',
    '',
    o.link,
    '',
    'From then on, "Forgot your password?" on the sign-in page sends its links here.',
    'If you did not expect this, ignore this email: nothing changes unless the link is used.',
  ].join('\n');
}

function resetMessage(o: { user: UserRow; link: string; host: string; twoFactor: boolean }): string {
  return [
    `Someone asked to reset the password of the WPL7 panel account "${o.user.username}" at ${o.host}.`,
    '',
    'To choose a new password, open this link within 30 minutes:',
    '',
    o.link,
    '',
    `The link works once.${o.twoFactor ? ' Signing in afterwards still asks for the code from your authenticator app.' : ''}`,
    'If you did not ask for this, ignore this email: your password stays as it is.',
  ].join('\n');
}

function changedMessage(o: { user: UserRow; host: string }): string {
  return [
    `The password of the WPL7 panel account "${o.user.username}" at ${o.host} was just changed`,
    'with a reset link sent to this address, and every session of the account was signed out.',
    '',
    'If that was not you, someone else can read this mailbox. Secure the email account first,',
    'then have the panel password changed again: another admin can set one, and for the owner',
    'the WPL7 troubleshooting guide has a way back in from the server.',
  ].join('\n');
}
