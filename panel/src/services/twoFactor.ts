import { sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import {
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  qrDataUrl,
  verifyTotp,
} from '../lib/totp.js';
import type { TotpState, UsersService } from './users.js';

/** A secret nobody has confirmed is worthless; it only has to outlive scanning a QR. */
const ENROLLMENT_TTL_MS = 15 * 60_000;

const RECOVERY_CODE_COUNT = 10;

/**
 * Wrong codes in a row before the account stops accepting any of them for a while. Three
 * of a million codes are live at any moment, so an attacker who already has the password
 * needs on the order of 10^5 guesses; this puts a ceiling on how fast those can be spent
 * no matter how many browsers or addresses they come from.
 */
const MAX_FAILED_ATTEMPTS = 5;

const LOCKOUT_MS = 5 * 60_000;

/** Applied on every accepted code: a good one ends the run of failures. */
const COUNTERS_RESET = { failedAttempts: 0, lockedUntil: 0 } as const;

export interface TwoFactorStatus {
  enabled: boolean;
  confirmedAt: number | null;
  /** Recovery codes still unspent - the panel nags when this gets low. */
  recoveryCodesLeft: number;
}

export interface TwoFactorEnrollment {
  secret: string;
  otpauthUrl: string;
  /** `data:image/svg+xml;base64,…` - drop it straight into an `<img src>`. */
  qrDataUrl: string;
}

/** `lockedOut` = this code was not even looked at; the guess budget is spent. */
export type TwoFactorVerdict = { ok: true } | { ok: false; lockedOut: boolean };

/** What an account's 2FA looks like from outside. Pure, so a list can show it for every row. */
export function twoFactorStatusOf(totp: TotpState | null): TwoFactorStatus {
  return {
    enabled: totp !== null,
    confirmedAt: totp?.confirmedAt ?? null,
    recoveryCodesLeft: totp?.recoveryCodes.length ?? 0,
  };
}

/**
 * Optional TOTP second factor on the panel login, per admin account.
 *
 * Enrolment is deliberately two steps: the secret is parked as "pending" until a code
 * generated from it comes back, so a mistyped setup cannot lock an admin out of their own
 * panel. Both a live code and a recovery code are spent on use.
 *
 * API keys are not covered by this - they are their own credential, revocable on their own
 * page, and a machine cannot be handed a phone.
 */
export class TwoFactorService {
  constructor(
    private readonly users: UsersService,
    /** What the authenticator app lists the entry under; the panel domain keeps two apart. */
    private readonly issuer: string,
  ) {}

  isEnabled(userId: number): boolean {
    return this.users.getTotp(userId) !== null;
  }

  status(userId: number): TwoFactorStatus {
    return twoFactorStatusOf(this.users.getTotp(userId));
  }

  /**
   * Step one: mint a secret and show it. Nothing about the login changes yet. The app lists
   * the entry under the username, which is what tells two admins' entries apart on a phone
   * that holds both.
   */
  startEnrollment(user: { id: number; username: string }): TwoFactorEnrollment {
    if (this.isEnabled(user.id)) throw conflict('Two-factor authentication is already on; turn it off first');
    const secret = generateTotpSecret();
    this.users.setTotpEnrollment(user.id, { secret, createdAt: Date.now() });
    const url = otpauthUrl({ secret, issuer: this.issuer, account: user.username });
    return { secret, otpauthUrl: url, qrDataUrl: qrDataUrl(url) };
  }

  /**
   * Step two: a code from the app arms 2FA. Returns the recovery codes, which exist in
   * readable form here and nowhere else, ever.
   */
  confirmEnrollment(userId: number, code: string): string[] {
    if (this.isEnabled(userId)) throw conflict('Two-factor authentication is already on');
    const enrollment = this.users.getTotpEnrollment(userId);
    if (!enrollment) throw badRequest('Start the setup first');
    if (Date.now() - enrollment.createdAt > ENROLLMENT_TTL_MS) {
      this.users.clearTotpEnrollment(userId);
      throw badRequest('This setup has expired — start it again');
    }
    const step = verifyTotp(enrollment.secret, code);
    if (step === null) {
      throw badRequest('That code is not right. Check your phone’s clock if it keeps failing');
    }
    const codes = this.issueRecoveryCodes(userId, {
      secret: enrollment.secret,
      confirmedAt: Date.now(),
      // The code that proved the enrolment is spent, so it cannot also open the first session.
      lastStep: step,
      ...COUNTERS_RESET,
    });
    this.users.clearTotpEnrollment(userId);
    return codes;
  }

  /**
   * Login check: a live code from the app, or one of the recovery codes. Either way the
   * credential is consumed - the step is remembered, the recovery code is struck off - and
   * the wrong ones are counted towards the lockout.
   *
   * Synchronous end to end, and deliberately so. The panel is one Node process and
   * better-sqlite3 is synchronous, so read, decide and write happen in a single turn of the
   * event loop and cannot interleave: codes racing each other can neither both spend the
   * same step nor both slip past the guess budget. Holding that budget on the session
   * instead does not work - concurrent requests each restore their own copy of the session
   * and the last save wins, so a burst of wrong codes counts as one.
   *
   * And per account: one admin's budget is nobody else's. Someone guessing at one login
   * cannot lock a colleague out of theirs.
   */
  verify(userId: number, input: string): TwoFactorVerdict {
    const totp = this.users.getTotp(userId);
    if (!totp) return { ok: false, lockedOut: false };

    const now = Date.now();
    if (totp.lockedUntil > now) return { ok: false, lockedOut: true };

    const step = verifyTotp(totp.secret, input);
    // A code is good for one window only: at or below the highest step already spent is a
    // replay, which counts as a wrong code rather than a second use.
    if (step !== null && step > totp.lastStep) {
      this.users.setTotp(userId, { ...totp, lastStep: step, ...COUNTERS_RESET });
      return { ok: true };
    }
    if (step === null) {
      const index = totp.recoveryCodes.indexOf(sha256Hex(normalizeRecoveryCode(input)));
      if (index >= 0) {
        this.users.setTotp(userId, {
          ...totp,
          recoveryCodes: totp.recoveryCodes.filter((_, i) => i !== index),
          ...COUNTERS_RESET,
        });
        return { ok: true };
      }
    }
    return this.recordFailure(userId, totp, now);
  }

  /** Replaces the whole list; the old codes stop working the moment this returns. */
  regenerateRecoveryCodes(userId: number): string[] {
    const totp = this.users.getTotp(userId);
    if (!totp) throw conflict('Two-factor authentication is not on');
    return this.issueRecoveryCodes(userId, totp);
  }

  disable(userId: number): void {
    this.users.clearTotp(userId);
  }

  /**
   * One wrong code. The run resets rather than resumes after a lockout expires, so the
   * next attacker starts from a full budget too - otherwise a single stored failure would
   * make every later attempt lock the admin out on its first typo.
   */
  private recordFailure(userId: number, totp: TotpState, now: number): TwoFactorVerdict {
    const failedAttempts = (totp.lockedUntil > 0 ? 0 : totp.failedAttempts) + 1;
    const lockedOut = failedAttempts >= MAX_FAILED_ATTEMPTS;
    this.users.setTotp(userId, {
      ...totp,
      failedAttempts: lockedOut ? 0 : failedAttempts,
      lockedUntil: lockedOut ? now + LOCKOUT_MS : 0,
    });
    return { ok: false, lockedOut };
  }

  /** Swaps the code list and nothing else, so regenerating cannot clear a live lockout. */
  private issueRecoveryCodes(userId: number, base: Omit<TotpState, 'recoveryCodes'>): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    // Hash the normalized form, which is what a retyped code turns into on the way back in.
    this.users.setTotp(userId, {
      ...base,
      recoveryCodes: codes.map((c) => sha256Hex(normalizeRecoveryCode(c))),
    });
    return codes;
  }
}
