/**
 * The rules OAuth sign-in for MCP (docs/mcp.md) holds redirect URIs, app names and scopes to -
 * one copy, used where an app registers, where an admin's approval is decided, and in the
 * approval page itself before it sends the browser anywhere. The page navigates with
 * `location.href`, so a redirect URI this lets through as `javascript:` would be script running
 * in the panel's own origin.
 */
import { accessLevels, type AccessLevel } from './access.js';

/** Custom schemes of the desktop apps that sign in with one. Exact names, nothing looser. */
export const APP_SCHEMES = ['cursor', 'vscode', 'vscode-insiders'] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where a redirect goes: a website, an app on this computer (loopback), or a desktop app's scheme. */
export type RedirectKind = 'web' | 'loopback' | 'app';

export type RedirectCheck =
  | { ok: true; kind: RedirectKind; /** Punycode for an international name - what the address bar will show. */ host: string }
  | { ok: false; problem: string };

/** The longest redirect URI an app may register - a bound on what the panel stores for it. */
export const MAX_REDIRECT_URI_LENGTH = 2000;

/**
 * Where a redirect URI sends the browser, and whether it may. No length: the approval page asks
 * this of the answer it follows - a registered URI with code, state and iss added, where state
 * alone may be 2000 characters before percent-encoding - and registration holds the URIs it keeps
 * to MAX_REDIRECT_URI_LENGTH.
 */
export function checkRedirectUri(uri: string): RedirectCheck {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, problem: 'is not an absolute URL' };
  }
  if (url.username || url.password) return { ok: false, problem: 'carries a user name or password' };
  if (url.hash || uri.includes('#')) return { ok: false, problem: 'has a fragment' };
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') {
    return url.hostname ? { ok: true, kind: 'web', host: url.host } : { ok: false, problem: 'has no host' };
  }
  if (scheme === 'http') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return { ok: false, problem: 'uses http for a host other than this computer; only https may leave it' };
    }
    return { ok: true, kind: 'loopback', host: url.host };
  }
  if ((APP_SCHEMES as readonly string[]).includes(scheme)) return { ok: true, kind: 'app', host: `${scheme}:` };
  return { ok: false, problem: `uses the scheme "${scheme}:", which is not accepted` };
}

/**
 * Does `requested` match a registered redirect URI? Exactly - except that an app on this
 * computer listens on whatever port it could get, so for loopback the port is not compared
 * (RFC 8252 section 7.3).
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = checkRedirectUri(registered);
  const b = checkRedirectUri(requested);
  if (!a.ok || !b.ok || a.kind !== 'loopback' || b.kind !== 'loopback') return false;
  const x = new URL(registered);
  const y = new URL(requested);
  return x.protocol === y.protocol && x.hostname === y.hostname && x.pathname === y.pathname && x.search === y.search;
}

/**
 * An app's name as it is shown: normalised, with control and direction-changing characters
 * taken out - a name that reverses the text after it could make "Claude" out of anything -
 * and cut to 64 characters. Always shown quoted, as a claim, never as a fact.
 */
export function cleanClientName(name: unknown): string {
  if (typeof name !== 'string') return 'An unnamed app';
  const cleaned = name
    .normalize('NFKC')
    // Control characters, and the bidi embeddings, overrides, isolates and marks.
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return cleaned || 'An unnamed app';
}

/** The scope names, one per level. `wpl7:full` implies the other two, `wpl7:manage` implies read. */
export const SCOPE_OF: Record<AccessLevel, string> = {
  read: 'wpl7:read',
  manage: 'wpl7:manage',
  full: 'wpl7:full',
};

/** The highest level a scope string asks for, or null when it names none of ours. */
export function levelOfScope(scope: string | undefined): AccessLevel | null {
  const asked = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  let best: AccessLevel | null = null;
  for (const level of accessLevels) if (asked.has(SCOPE_OF[level])) best = level;
  return best;
}

/** What a token of `level` may do, as the scope parameter says it: every level it includes. */
export function scopeOfLevel(level: AccessLevel): string {
  return accessLevels.slice(0, accessLevels.indexOf(level) + 1).map((l) => SCOPE_OF[l]).join(' ');
}
