import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { makeApp, makeWebDist } from '../helpers.js';

const LOGIN = { username: 'admin', password: 'correct-horse-battery' };
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
/** What a browser sends when it is loading a panel page it was pointed at directly. */
const DOCUMENT = { accept: ACCEPT_HTML, 'sec-fetch-site': 'none' };
/** …and when the visitor followed a link from somewhere else entirely. */
const FROM_ELSEWHERE = { accept: ACCEPT_HTML, 'sec-fetch-site': 'cross-site' };

type TestApp = Awaited<ReturnType<typeof makeApp>>['app'];

async function appWithWeb(): Promise<TestApp> {
  const { app } = await makeApp(undefined, { webDist: makeWebDist() });
  return app;
}

async function signIn(app: TestApp): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'panel.sid')!;
  return `${cookie.name}=${cookie.value}`;
}

const get = (app: TestApp, url: string, headers: Record<string, string>, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { ...headers, cookie } : headers });

function redirectedToLogin(res: LightMyRequestResponse): boolean {
  return res.statusCode >= 300 && res.statusCode < 400 && res.headers.location === '/login';
}

describe('serving the panel itself', () => {
  it('sends a signed-out browser to the sign-in page instead of the app shell', async () => {
    const app = await appWithWeb();
    for (const url of ['/', '/index.html', '/sites', '/sites/shop?tab=wordpress', '/settings']) {
      const res = await get(app, url, DOCUMENT);
      expect({ url, login: redirectedToLogin(res) }).toEqual({ url, login: true });
    }
  });

  it('serves the sign-in page itself, unmarked', async () => {
    const app = await appWithWeb();
    const res = await get(app, '/login', DOCUMENT);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('data-session');
  });

  it("serves an AI app's approval page signed out, so it can sign in and come back", async () => {
    const app = await appWithWeb();
    const res = await get(app, '/oauth/authorize?client_id=wpl7ci_x&response_type=code', DOCUMENT);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Every other page still goes to exactly /login, with nothing carried along.
    const other = await get(app, '/integrations/mcp', DOCUMENT);
    expect(other.headers.location).toBe('/login');
  });

  it('serves the pages an emailed link opens to a browser that is not signed in', async () => {
    const app = await appWithWeb();
    // Typed or pasted into the address bar, which is how a link out of a mail client often
    // arrives - the case that would otherwise be sent to /login and lose the token.
    for (const url of ['/reset-password', '/confirm-email']) {
      const res = await get(app, url, DOCUMENT);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expect(res.body).not.toContain('data-session');
    }
  });

  it('refuses to be framed, signed in or not', async () => {
    const app = await appWithWeb();
    const cookie = await signIn(app);
    for (const res of [await get(app, '/login', DOCUMENT), await get(app, '/sites/shop?tab=files', DOCUMENT, cookie)]) {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('marks the document a signed-in browser gets, so the app can paint at once', async () => {
    const app = await appWithWeb();
    const cookie = await signIn(app);
    for (const url of ['/', '/sites', '/login']) {
      const res = await get(app, url, DOCUMENT, cookie);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expect(res.body).toContain('<html data-session="signed-in" lang="en">');
    }
  });

  it('serves the app to a visitor arriving from another site, signed in or not', async () => {
    // `sameSite: strict` holds the session cookie back on a link followed from anywhere
    // off the panel, so this request looks signed out whether it is or not. Answering it
    // with the sign-in page would throw a perfectly good session out; the app's own
    // same-origin requests carry the cookie and settle it a moment later.
    const app = await appWithWeb();
    const cookie = await signIn(app);
    for (const sent of [undefined, cookie]) {
      const res = await get(app, '/sites', FROM_ELSEWHERE, sent);
      expect(res.statusCode).toBe(200);
    }
    // Same for a browser too old to say where the visitor came from.
    const unsaid = await get(app, '/sites', { accept: ACCEPT_HTML });
    expect(unsaid.statusCode).toBe(200);
  });

  it('leaves assets and the API alone', async () => {
    const app = await appWithWeb();
    // No session, and none needed: an asset that redirected to /login would be cached as
    // a redirect and poison the sign-in page it was meant to protect.
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    // An unknown /api path is still a JSON 404, not the app and not a redirect.
    const api = await get(app, '/api/nope', DOCUMENT);
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('answers a signed-out data request with 401, not a redirect', async () => {
    // The gate is for documents only: a 401 is what tells the running app its session is
    // gone, and a 30x with an HTML body would be read as data.
    const app = await appWithWeb();
    const res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
  });

  it('is a plain 404 for everything when the panel was built without the web app', async () => {
    const { app } = await makeApp();
    const res = await get(app, '/sites', DOCUMENT);
    expect(res.statusCode).toBe(404);
  });
});
