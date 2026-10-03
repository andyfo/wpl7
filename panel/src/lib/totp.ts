/**
 * RFC 6238 TOTP - the six-digit codes every authenticator app (Google Authenticator, Aegis,
 * 1Password, Bitwarden...) produces. SHA-1 / 6 digits / 30-second steps is not a choice but
 * the profile those apps assume when a QR carries no explicit parameters.
 *
 * Self-contained on purpose: the whole algorithm is an HMAC and a modulo, and node:crypto
 * already ships both.
 */
import crypto from 'node:crypto';
import { renderSVG } from 'uqr';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** How far either side of "now" a code is still accepted, in steps (one step = 30 s). */
const DEFAULT_WINDOW = 1;

/** Recovery codes: 20 characters from an alphabet with no look-alikes. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_LENGTH = 20;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of the way people retype a secret: spaces, dashes, lower case, `=` padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`"${char}" is not valid base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit shared secret - RFC 4226's recommended size, and what the apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The 30-second slot `nowMs` falls in; the counter both sides feed to HMAC. */
export function totpStepAt(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP: HMAC the counter, then take a 31-bit window at a dynamic offset. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Returns the step the code belongs to, or null if it matches none in the window.
 *
 * The step - not just `true` - is the caller's replay guard: remember the highest one that
 * has been spent and refuse anything at or below it, and a code intercepted while it is
 * still on screen cannot be used a second time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { window?: number; nowMs?: number } = {},
): number | null {
  const digits = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) return null;
  const window = opts.window ?? DEFAULT_WINDOW;
  const center = totpStepAt(opts.nowMs);
  for (let delta = -window; delta <= window; delta++) {
    const step = center + delta;
    if (step < 0) continue;
    if (timingSafeEquals(totpCode(secret, step), digits)) return step;
  }
  return null;
}

/**
 * The `otpauth://` URI the QR encodes. The parameters are all at their defaults, but some
 * apps (and every "why does my code not work" support thread) are happier seeing them.
 */
export function otpauthUrl(opts: { secret: string; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * The QR as a `data:` URL, so the browser can put it in a plain `<img src>`. Handing the
 * page an SVG string instead would mean injecting markup that carries the secret.
 */
export function qrDataUrl(text: string): string {
  const svg = renderSVG(text, { border: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Single-use codes for the day the phone is lost. ~98 bits each, so the stored sha256 needs
 * no password KDF - there is nothing to guess and nothing to look up in a rainbow table.
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(RECOVERY_LENGTH);
  let out = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
  }
  return out;
}

/** People retype these from paper: case and grouping dashes must not decide the outcome. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
