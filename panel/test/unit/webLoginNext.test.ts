import { describe, expect, it } from 'vitest';
import { isAllowedNext, loginFor, nextAfterLogin } from '../../web/src/lib/loginNext.js';

describe('coming back after signing in', () => {
  it('returns to the approval page an AI app sent the admin to, query and all', () => {
    const approval = '/oauth/authorize?client_id=wpl7ci_x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=a%20b';
    const login = loginFor('/oauth/authorize', approval.slice('/oauth/authorize'.length));
    expect(login).toBe(`/login?next=${encodeURIComponent(approval)}`);
    expect(nextAfterLogin(login.slice('/login'.length))).toBe(approval);
  });

  it('goes to the dashboard from every other page, and for every other target', () => {
    expect(loginFor('/sites', '?tab=wordpress')).toBe('/login');
    expect(nextAfterLogin('')).toBe('/');
    for (const next of [
      '/sites',
      '//evil.example/oauth/authorize',
      'https://evil.example/oauth/authorize',
      '/oauth/authorize/../../sites',
      '/oauth/authorizeX',
      '/\\evil.example',
      '/oauth/authorize#frag',
      'javascript:alert(1)',
    ]) {
      expect(isAllowedNext(next), next).toBe(false);
      expect(nextAfterLogin(`?next=${encodeURIComponent(next)}`), next).toBe('/');
    }
  });
});
