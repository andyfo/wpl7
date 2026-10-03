import { describe, expect, it } from 'vitest';
import { checkRedirectUri, cleanClientName, levelOfScope, redirectMatches, scopeOfLevel } from '../../shared/oauth.js';

describe('redirect URIs an app may register', () => {
  it('takes https anywhere, http on this computer only, and the desktop apps by their exact scheme', () => {
    expect(checkRedirectUri('https://claude.ai/api/mcp/auth_callback')).toEqual({ ok: true, kind: 'web', host: 'claude.ai' });
    expect(checkRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect')).toMatchObject({ ok: true, kind: 'web' });
    expect(checkRedirectUri('http://localhost:33418/callback')).toEqual({ ok: true, kind: 'loopback', host: 'localhost:33418' });
    expect(checkRedirectUri('http://127.0.0.1:6274/oauth/callback')).toMatchObject({ ok: true, kind: 'loopback' });
    expect(checkRedirectUri('http://[::1]:8080/cb')).toMatchObject({ ok: true, kind: 'loopback' });
    expect(checkRedirectUri('cursor://anysphere.cursor-retrieval/oauth/user-wpl7/callback')).toEqual({
      ok: true,
      kind: 'app',
      host: 'cursor:',
    });
    expect(checkRedirectUri('vscode://vscode.github-authentication/did-authenticate')).toMatchObject({ ok: true, kind: 'app' });
  });

  it('refuses script, data, files, other schemes, and http that would leave the computer', () => {
    for (const uri of [
      'javascript:alert(document.cookie)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ms-settings:privacy',
      'http://evil.example/cb',
      'http://localhost.evil.com/cb',
      'http://127.0.0.1.evil.com/cb',
      'https://user:pass@claude.ai/cb',
      'https://claude.ai/cb#fragment',
      '/relative/callback',
      'not a url',
    ]) {
      expect(checkRedirectUri(uri).ok, uri).toBe(false);
    }
  });

  it('says where a URI goes, not how long it is: the answer on a registered one may be long', () => {
    // What the approval page follows: code, state and iss added, where state alone may be 2000 characters.
    const answer = `https://client.example/callback?code=wpl7ac_${'c'.repeat(43)}&state=${'s'.repeat(1950)}&iss=https%3A%2F%2Fpanel.example`;
    expect(answer.length).toBeGreaterThan(2000);
    expect(checkRedirectUri(answer)).toEqual({ ok: true, kind: 'web', host: 'client.example' });
  });

  it('shows an international name the way the address bar will: punycode', () => {
    expect(checkRedirectUri('https://clаude.ai/cb')).toMatchObject({ ok: true, host: 'xn--clude-5ve.ai' });
  });

  it('matches exactly, except the port of an app on this computer', () => {
    expect(redirectMatches('https://claude.ai/cb', 'https://claude.ai/cb')).toBe(true);
    expect(redirectMatches('https://claude.ai/cb', 'https://claude.ai/cb/')).toBe(false);
    expect(redirectMatches('https://claude.ai/cb', 'https://claude.ai:8443/cb')).toBe(false);
    expect(redirectMatches('http://localhost:1234/callback', 'http://localhost:5678/callback')).toBe(true);
    expect(redirectMatches('http://localhost:1234/callback', 'http://localhost:5678/other')).toBe(false);
    expect(redirectMatches('http://localhost:1234/callback', 'http://127.0.0.1:1234/callback')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'https://localhost/callback')).toBe(false);
  });
});

describe('app names', () => {
  it('are normalised, stripped of control and direction characters, and kept short', () => {
    expect(cleanClientName('  Claude  ')).toBe('Claude');
    expect(cleanClientName('Evil‮edualc')).toBe('Eviledualc');
    expect(cleanClientName('Ｃｌａｕｄｅ')).toBe('Claude');
    expect(cleanClientName('a\u0000b\nc')).toBe('abc');
    expect(cleanClientName('x'.repeat(200))).toHaveLength(64);
    expect(cleanClientName(undefined)).toBe('An unnamed app');
    expect(cleanClientName('‎')).toBe('An unnamed app');
  });
});

describe('scopes', () => {
  it('reads the highest level asked for, and writes every level a grant includes', () => {
    expect(levelOfScope('wpl7:read wpl7:full')).toBe('full');
    expect(levelOfScope('offline_access wpl7:manage')).toBe('manage');
    expect(levelOfScope('openid profile')).toBeNull();
    expect(levelOfScope(undefined)).toBeNull();
    expect(scopeOfLevel('read')).toBe('wpl7:read');
    expect(scopeOfLevel('full')).toBe('wpl7:read wpl7:manage wpl7:full');
  });
});
