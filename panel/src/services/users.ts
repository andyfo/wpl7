import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users, type UserRow } from '../db/schema.js';
import type { PanelUserDto } from '../../shared/types.js';
import { conflict, notFound } from '../lib/errors.js';
import { twoFactorStatusOf } from './twoFactor.js';

/** Armed two-factor authentication for one admin. Absent = 2FA is off. */
export interface TotpState {
  /** Base32 shared secret, as handed to the authenticator app. */
  secret: string;
  /** When a first valid code proved the app really holds the secret. */
  confirmedAt: number;
  /** Highest 30-second step already spent, so a code cannot be used twice. */
  lastStep: number;
  /** sha256 of each recovery code that has not been used yet. */
  recoveryCodes: string[];
  /**
   * Wrong codes in the current run, and when the run that hit the cap stops locking the
   * account out. Both live here rather than on the session because the guess budget has to
   * hold across every browser and every IP at once - see TwoFactorService.verify.
   */
  failedAttempts: number;
  lockedUntil: number;
}

/** A secret minted for an enrolment that nobody has proved works yet. */
export interface TotpEnrollment {
  secret: string;
  createdAt: number;
}

/** An address set on an account that nobody has confirmed yet, and the token its link carries. */
export interface PendingEmail {
  email: string;
  /** sha256 of the token in the emailed link; the link itself is never stored. */
  tokenHash: string;
  expiresAt: number;
}

/** An emailed reset link that has not been used yet. Only the newest one works. */
export interface PasswordReset {
  tokenHash: string;
  expiresAt: number;
  /** When it went out, which is what the per-account cooldown on the reset form reads. */
  sentAt: number;
  /** Where it went. The link works only while that is still the account's recovery email. */
  sentTo: string;
}

/** Who a signed-in request is. The auth gate sets it from the session, per request. */
export interface PanelUserRef {
  id: number;
  username: string;
  isOwner: boolean;
}

export const userRef = (row: UserRow): PanelUserRef => ({
  id: row.id,
  username: row.username,
  isOwner: row.isOwner === 1,
});

const parseJson = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));

/**
 * The panel's admin accounts. Every admin can do everything; the owner is the one account
 * nobody else may change or delete, so there is always someone who can get back in.
 *
 * Usernames are compared exactly at sign-in, as they always were, but a new name that differs
 * from an existing one only in case is refused: "Anna" and "anna" would be two logins that
 * nobody could tell apart in a list.
 */
export class UsersService {
  constructor(private readonly db: Db) {}

  /** The owner first, then everyone else in the order they were added. */
  list(): UserRow[] {
    return this.db.select().from(users).orderBy(desc(users.isOwner), asc(users.id)).all();
  }

  count(): number {
    return this.db.select({ id: users.id }).from(users).all().length;
  }

  byId(id: number): UserRow | null {
    return this.db.select().from(users).where(eq(users.id, id)).get() ?? null;
  }

  /** Exact match - the login box is not case-insensitive, and never was. */
  byUsername(username: string): UserRow | null {
    return this.db.select().from(users).where(eq(users.username, username)).get() ?? null;
  }

  owner(): UserRow | null {
    return (
      this.db.select().from(users).where(eq(users.isOwner, 1)).orderBy(asc(users.id)).limit(1).get() ?? null
    );
  }

  create(input: {
    username: string;
    passwordHash: string;
    isOwner?: boolean;
    totp?: TotpState | null;
    totpEnrollment?: TotpEnrollment | null;
  }): UserRow {
    this.assertNameFree(input.username);
    if (input.isOwner && this.owner()) throw conflict('This panel already has an owner');
    const now = Date.now();
    try {
      return this.db
        .insert(users)
        .values({
          username: input.username,
          passwordHash: input.passwordHash,
          isOwner: input.isOwner ? 1 : 0,
          totp: input.totp ? JSON.stringify(input.totp) : null,
          totpEnrollment: input.totpEnrollment ? JSON.stringify(input.totpEnrollment) : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    } catch (err) {
      throw takenOr(err, input.username);
    }
  }

  /** Writes the name and nothing else; see setPasswordHash for why that matters. */
  rename(id: number, username: string): void {
    const row = this.byIdOr404(id);
    if (row.username === username) return;
    this.assertNameFree(username, id);
    try {
      this.db.update(users).set({ username, updatedAt: Date.now() }).where(eq(users.id, id)).run();
    } catch (err) {
      throw takenOr(err, username);
    }
  }

  /**
   * Writes the hash and nothing else. A caller holding a row it read before hashing - a
   * whole argon2 run earlier - and writing it back would undo whatever landed in between: a
   * password change would restore the name the account had before a rename.
   *
   * Any new password also retires an emailed reset link still in someone's inbox: it was
   * sent to replace a password that is gone now.
   */
  setPasswordHash(id: number, passwordHash: string): void {
    this.byIdOr404(id);
    this.db
      .update(users)
      .set({ passwordHash, passwordReset: null, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  /** The account and every session it has open, together: nobody stays signed in as no one. */
  remove(id: number): void {
    const row = this.byIdOr404(id);
    if (row.isOwner === 1) throw conflict('The owner cannot be removed');
    this.db.transaction(() => {
      this.db.delete(sessions).where(eq(sessions.userId, id)).run();
      this.db.delete(users).where(eq(users.id, id)).run();
    });
  }

  /** A completed sign-in. Its own column, so it never passes for a change to the account. */
  touchLogin(id: number): void {
    this.db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, id)).run();
  }

  getTotp(id: number): TotpState | null {
    return parseJson<TotpState>(this.byId(id)?.totp ?? null);
  }

  setTotp(id: number, state: TotpState): void {
    this.db.update(users).set({ totp: JSON.stringify(state), updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  /** Turning 2FA off must not leave a half-finished enrolment behind to be confirmed later. */
  clearTotp(id: number): void {
    this.db
      .update(users)
      .set({ totp: null, totpEnrollment: null, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  getTotpEnrollment(id: number): TotpEnrollment | null {
    return parseJson<TotpEnrollment>(this.byId(id)?.totpEnrollment ?? null);
  }

  setTotpEnrollment(id: number, enrollment: TotpEnrollment): void {
    this.db
      .update(users)
      .set({ totpEnrollment: JSON.stringify(enrollment), updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  clearTotpEnrollment(id: number): void {
    this.db.update(users).set({ totpEnrollment: null, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  getPendingEmail(id: number): PendingEmail | null {
    return parseJson<PendingEmail>(this.byId(id)?.pendingEmail ?? null);
  }

  setPendingEmail(id: number, pending: PendingEmail | null): void {
    this.db
      .update(users)
      .set({ pendingEmail: pending ? JSON.stringify(pending) : null, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  /**
   * The address a link was followed from becomes the recovery address. Reset links already
   * sent to the previous one stop working: they belong to a mailbox this account has left.
   */
  confirmEmail(id: number, email: string): void {
    this.db
      .update(users)
      .set({ email, pendingEmail: null, passwordReset: null, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  /** No recovery address, nothing on its way to one, and no reset link left to use. */
  clearEmail(id: number): void {
    this.db
      .update(users)
      .set({ email: null, pendingEmail: null, passwordReset: null, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
  }

  getPasswordReset(id: number): PasswordReset | null {
    return parseJson<PasswordReset>(this.byId(id)?.passwordReset ?? null);
  }

  setPasswordReset(id: number, reset: PasswordReset | null): void {
    this.db
      .update(users)
      .set({ passwordReset: reset ? JSON.stringify(reset) : null })
      .where(eq(users.id, id))
      .run();
  }

  /**
   * Signs one admin out everywhere, but for `exceptSid` - the session asking, usually - and
   * answers the account's new session generation.
   *
   * Deleting the rows is not what makes it stick. A request of a revoked session that is
   * still running saves that session again on its way out (`rolling: true`), which would
   * bring the row straight back; what it cannot bring back is the generation it was signed in
   * under, and the session store and the auth gate both refuse an old one. The session kept
   * moves to the new generation here and now - any later request of it would otherwise count
   * as revoked until the one asking has finished - and whoever holds it in memory has to
   * carry the returned number into `req.session.generation` so its own save is not refused.
   */
  revokeSessions(userId: number, exceptSid?: string): number {
    return this.db.transaction(() => {
      const raised = this.db
        .update(users)
        .set({ sessionGeneration: sql`${users.sessionGeneration} + 1` })
        .where(eq(users.id, userId))
        .returning({ generation: users.sessionGeneration })
        .get();
      const generation = raised?.generation ?? 0;
      const mine = eq(sessions.userId, userId);
      if (exceptSid === undefined) {
        this.db.delete(sessions).where(mine).run();
      } else {
        this.db.delete(sessions).where(and(mine, ne(sessions.sid, exceptSid))).run();
        this.db
          .update(sessions)
          .set({ data: sql`json_set(${sessions.data}, '$.generation', ${generation})` })
          .where(eq(sessions.sid, exceptSid))
          .run();
      }
      return generation;
    });
  }

  toDto(row: UserRow): PanelUserDto {
    const pending = parseJson<PendingEmail>(row.pendingEmail);
    return {
      id: row.id,
      username: row.username,
      isOwner: row.isOwner === 1,
      email: row.email,
      // An expired confirmation is as good as none; showing it would promise a link that fails.
      pendingEmail: pending && pending.expiresAt > Date.now() ? pending.email : null,
      twoFactor: twoFactorStatusOf(parseJson<TotpState>(row.totp)),
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    };
  }

  private byIdOr404(id: number): UserRow {
    const row = this.byId(id);
    if (!row) throw notFound(`User #${id} not found`);
    return row;
  }

  /**
   * A scan in code rather than `lower()` in SQL: SQLite folds ASCII only, and a name seeded
   * from PANEL_ADMIN_USER was never held to the ASCII-only rule new names follow.
   */
  private assertNameFree(username: string, exceptId?: number): void {
    const folded = username.toLowerCase();
    const clash = this.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .all()
      .some((u) => u.id !== exceptId && u.username.toLowerCase() === folded);
    if (clash) throw conflict(`Username "${username}" is already taken`);
  }
}

function takenOr(err: unknown, username: string): unknown {
  return err instanceof Error && /UNIQUE constraint failed: users\.username/.test(err.message)
    ? conflict(`Username "${username}" is already taken`)
    : err;
}
