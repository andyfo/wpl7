import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'wpl7_';

/**
 * LEGACY(ceo) - delete in 0.3.0. Keys minted before the rename. The prefix is decoration on
 * a token that is verified by hash, so accepting the old one costs nothing and saves every
 * existing install from re-issuing the key its CI and scripts authenticate with.
 */
export const LEGACY_API_KEY_PREFIXES = ['cak_'];

/** Prefixes `verify()` will look at. Anything else is rejected without touching the database. */
export const isApiKeyToken = (token: string): boolean =>
  token.startsWith(API_KEY_PREFIX) || LEGACY_API_KEY_PREFIXES.some((p) => token.startsWith(p));

/** Generate a new API key token. 256 bits of entropy, shown to the user exactly once. */
export function generateApiKey(): { token: string; hash: string; prefix: string } {
  const token = API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 12) };
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Human-usable generated password (WP admin, resets) without ambiguous characters. */
export function generatePassword(length = 24): string {
  const charset = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#%+=';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i]! % charset.length];
  return out;
}

/** Machine credential (site DB password). */
export function generateSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Whether two secrets are the same, in time that does not depend on where they first differ: a
 * plain `===` returns sooner the earlier the difference, which is what a guesser times. A length
 * difference is told at once; the length of a token is not the secret part of it.
 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
