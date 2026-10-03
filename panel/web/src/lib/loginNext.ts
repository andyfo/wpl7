/**
 * Where the sign-in page goes once someone has signed in: back to the approval page an AI app
 * sent them to (`/oauth/authorize?…`), and nowhere else. A general "return to where you were"
 * is a redirect anyone can aim by sending a link, so this one path is all it honours - and only
 * as a path on this panel, never `//elsewhere` or a URL with a scheme.
 */

const APPROVAL_PAGE = '/oauth/authorize';

/** The sign-in page's address for someone who has to sign in before approving an app. */
export function loginFor(path: string, search: string): string {
  const next = `${path}${search}`;
  return isAllowedNext(next) ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

/** The page to go to after signing in, from the sign-in page's own query string. */
export function nextAfterLogin(search: string): string {
  const next = new URLSearchParams(search).get('next');
  return next !== null && isAllowedNext(next) ? next : '/';
}

export function isAllowedNext(next: string): boolean {
  if (next !== APPROVAL_PAGE && !next.startsWith(`${APPROVAL_PAGE}?`)) return false;
  // Nothing that a browser would read as another origin or another path.
  if (/[\\\u0000-\u001f]/.test(next) || next.includes('#')) return false;
  const url = new URL(next, 'https://panel.invalid');
  return url.origin === 'https://panel.invalid' && url.pathname === APPROVAL_PAGE;
}
