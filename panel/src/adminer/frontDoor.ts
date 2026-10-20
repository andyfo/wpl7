// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough, pipeline } from 'node:stream';
import type { SiteHold } from '../jobs/worker.js';
import { AdminerSessionEndedError, type AdminerService } from './index.js';
import { adminerRequest, BodyTooLargeError } from './relay.js';
import type { AdminerSession } from './sessions.js';

/**
 * A request body Adminer takes: its import, a gzipped dump counted compressed. Kept small - PHP
 * holds an upload in memory more than once - so bigger dumps go through the Database tab's import.
 */
export const ADMINER_MAX_BODY = 32 * 1024 * 1024;
/** Requests at once to one server's Adminer: each holds a Docker exec there, and jobs need theirs. */
const IN_FLIGHT_PER_SERVER = 4;
/** How often a running change renews its hold on the site: well inside the queue's limit for holds. */
const HOLD_RENEW_MS = 60_000;

/** Headers a browser's request does not pass on: hop-by-hop ones, and ones that claim things. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'forwarded',
  'x-real-ip',
]);
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'x-powered-by']);

/**
 * Adminer's front door: an HTTP server of its own in the panel's process, on its own port and
 * address (`db.<dev domain>`). It serves Adminer and nothing of the panel, and:
 *  - starts a session only from a ticket the panel minted (`/open`), and keeps the browser's
 *    sessions - a tab per site - under one key in a `__Host-` cookie that dev sites, which share
 *    the domain, cannot set;
 *  - takes a request only from Adminer's own pages or an address typed in (Sec-Fetch-Site), so
 *    a dev site cannot drive it either;
 *  - takes a change (POST and the like) only from its own origin: a browser too old for
 *    Sec-Fetch-Site still sends Origin;
 *  - passes on no cookie, forwarded header or `X-Wpl7-*` header a browser sends, nor one with an
 *    `_` (PHP reads `X_Wpl7_Login_Key` as X-Wpl7-Login-Key), and keeps Adminer's cookies in the
 *    session's jar instead.
 */
export function createFrontDoor(service: AdminerService, opts: { host: string; secure: boolean; panelUrl: string }): http.Server {
  const cookieName = opts.secure ? '__Host-wpl7_adminer' : 'wpl7_adminer';
  const origin = `${opts.secure ? 'https' : 'http'}://${opts.host}`.toLowerCase();
  const inFlight = new Map<number, number>();

  /** The browser's session for a request: the one for the database user its address names. */
  const sessionOf = (req: IncomingMessage, url: URL): AdminerSession | null =>
    service.sessions.forRequest(readCookie(req, cookieName), url.searchParams.get('username'));

  async function open(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') return page(res, 405, 'Not here', 'Open the database again from the panel.', opts.panelUrl);
    const ticket = service.tickets.take(url.searchParams.get('ticket') ?? '');
    if (!ticket) return page(res, 410, 'This link has been used', 'Each link opens Adminer once, within a minute. Open the database again from the panel.', opts.panelUrl);
    const off = service.unavailable();
    if (off) return page(res, 409, 'Adminer is off', off, opts.panelUrl);
    let session: AdminerSession;
    try {
      session = service.begin(ticket);
    } catch (err) {
      return page(res, 404, 'Not there any more', err instanceof Error ? err.message : String(err), opts.panelUrl);
    }
    // A page, not a redirect, and no cookie yet: right after a navigation from another site the
    // browser leaves a Strict cookie out, so this request cannot tell which key the browser
    // holds. The page's own first request claims the session (state()).
    return startingPage(res, session.id);
  }

  /**
   * How the tab's session is coming along. The first ask claims it for the browser's key - the
   * one its cookie holds when that belongs to the same panel session, or a new one it is given:
   * other tabs' sessions stay. A session already claimed answers only to its own browser's key,
   * or moves to another key of the same panel session (two tabs opened at once).
   */
  function state(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const s = service.sessions.get(url.searchParams.get('s') ?? '');
    const cookie = readCookie(req, cookieName);
    const ended = () => send(res, 200, 'application/json', JSON.stringify({ state: 'ended' }));
    if (!s) return ended();
    if (s.browser === '' || (s.browser !== cookie && service.sessions.ownedBy(cookie, s.userId, s.panelSid))) {
      const { browser, isNew } = service.sessions.claim(s, cookie);
      if (isNew) res.setHeader('set-cookie', `${cookieName}=${browser}; Path=/; HttpOnly; SameSite=Strict${opts.secure ? '; Secure' : ''}`);
    } else if (s.browser !== cookie) {
      return ended();
    }
    send(res, 200, 'application/json', JSON.stringify({ state: s.state, message: s.message, location: service.adminerPath(s) }));
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const s = sessionOf(req, url);
    if (!s) return page(res, 401, 'This Adminer session has ended', 'Open the database again from the panel.', opts.panelUrl);
    if (s.state !== 'ready') return startingPage(res, s.id);
    const tooLarge = () =>
      page(res, 413, 'Too large', `Adminer takes at most ${ADMINER_MAX_BODY / 1024 / 1024} MB at once. Import bigger dumps on the site's Database tab.`);
    if (Number(req.headers['content-length'] ?? 0) > ADMINER_MAX_BODY) return tooLarge();
    const change = req.method !== 'GET' && req.method !== 'HEAD';
    let hold: SiteHold;
    try {
      hold = service.hold(s, change);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AdminerSessionEndedError) return page(res, 401, 'This Adminer session has ended', message, opts.panelUrl);
      return page(res, 409, 'The site is busy', message, opts.panelUrl);
    }
    // In use from the moment a request starts: a long upload is use too.
    service.sessions.touch(s);
    service.containers.used(s.serverId);
    // A change is tagged: its Adminer connection takes a lock named after the tag (wpl7.php), by
    // which MariaDB says whether the change still runs once the front door is done with it.
    const tag = change ? randomBytes(16).toString('base64url') : null;
    /** Whether Adminer was asked at all, and if so whether its answer came whole. */
    let sent = false;
    let whole = false;
    // A read goes with its browser, and so does a change not yet sent, or whose body has not all
    // come: Adminer runs nothing it does not have whole. A change Adminer has may be running: it
    // runs to its end.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished && (!change || !sent || !req.complete)) abort.abort();
    });
    // The site stays held as long as the change runs, past the queue's limit for holds.
    const renewal = change ? setInterval(() => hold.renew(), HOLD_RENEW_MS) : null;
    renewal?.unref();
    try {
      if (!(await slot(s.serverId))) return page(res, 503, 'Busy', 'Adminer is answering other requests on this server. Try again in a moment.');
      try {
        if (abort.signal.aborted) return;
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.includes('_')) continue;
          if (name.startsWith('x-forwarded-') || name.startsWith('x-wpl7-')) continue;
          headers[name] = value;
        }
        const jar = s.jar.header();
        if (jar) headers.cookie = jar;
        if (tag) headers['x-wpl7-request'] = tag;
        sent = true;
        const upstream = await adminerRequest(service.servers.handleFor(s.serverId).docker, {
          method: req.method ?? 'GET',
          path: url.pathname + url.search,
          headers,
          // Through a stream of its own: one too large is cut off there, while the browser's request
          // stays whole for the 413.
          body: change ? req.pipe(new PassThrough()) : undefined,
          maxBody: ADMINER_MAX_BODY,
          signal: abort.signal,
        });
        s.jar.take(upstream.headers['set-cookie']);
        service.sessions.touch(s);
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) out[name] = value;
        }
        res.writeHead(upstream.statusCode ?? 502, out);
        if (change) whole = await toTheEnd(upstream, res);
        else await new Promise<void>((resolve) => pipeline(upstream, res, () => resolve()));
      } catch (err) {
        if (res.headersSent || res.destroyed) res.destroy();
        else if (err instanceof BodyTooLargeError) {
          // The rest of the body is read and thrown away: a browser still sending when the
          // connection closes would lose the answer.
          req.unpipe();
          req.resume();
          tooLarge();
        }
        else page(res, 502, 'Adminer did not answer', `${err instanceof Error ? err.message : String(err)}. Open the database again from the panel.`, opts.panelUrl);
      } finally {
        inFlight.set(s.serverId, (inFlight.get(s.serverId) ?? 1) - 1);
      }
      // Done for the front door, a change lets go of the site once it is done in MariaDB too.
      if (tag && sent) await service.settle(s, tag, { cut: !whole, renew: () => hold.renew() });
    } finally {
      if (renewal) clearInterval(renewal);
      hold();
    }
  }

  /** One of the server's request slots, waited for a little; false when none came free. */
  async function slot(serverId: number): Promise<boolean> {
    for (let waited = 0; ; waited += 100) {
      const n = inFlight.get(serverId) ?? 0;
      if (n < IN_FLIGHT_PER_SERVER) {
        inFlight.set(serverId, n + 1);
        return true;
      }
      if (waited >= 30_000) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return http.createServer((req, res) => {
    const handle = async () => {
      // Only its own address answers: anything else that reaches the port is not for it.
      if ((req.headers.host ?? '').toLowerCase() !== opts.host.toLowerCase()) return page(res, 404, 'Not found', '');
      const url = new URL(req.url ?? '/', 'http://adminer');
      if (url.pathname === '/open') return open(req, res, url);
      // Every other request is Adminer's own page asking, or an address typed in; a change, only
      // Adminer's own page.
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return page(res, 403, 'Not from here', 'Adminer opens from the panel only.', opts.panelUrl);
      }
      const change = req.method !== 'GET' && req.method !== 'HEAD';
      if (change && site !== 'same-origin' && (req.headers.origin ?? '').toLowerCase() !== origin) {
        return page(res, 403, 'Not from here', 'Adminer opens from the panel only.', opts.panelUrl);
      }
      // Turned off: sessions already open end too. It is the switch for when an advisory is out.
      const off = service.unavailable();
      if (off) return page(res, 409, 'Adminer is off', off, opts.panelUrl);
      if (url.pathname === '/.wpl7/state') return state(req, res, url);
      return proxy(req, res, url);
    };
    handle().catch((err: unknown) => {
      if (!res.headersSent) page(res, 500, 'Something went wrong', err instanceof Error ? err.message : String(err));
      else res.destroy();
    });
  });
}

/**
 * A change's answer: to the browser while it is there, and on into nothing once it has gone, so
 * Adminer finishes rather than stopping half-way. True when the answer came whole: Adminer is done.
 */
function toTheEnd(upstream: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let listening = !res.destroyed;
    res.on('close', () => {
      listening = false;
      upstream.resume();
    });
    upstream.on('data', (chunk: Buffer) => {
      if (listening && !res.write(chunk)) {
        upstream.pause();
        res.once('drain', () => upstream.resume());
      }
    });
    upstream.on('error', () => undefined);
    upstream.on('close', () => {
      if (listening) {
        if (upstream.complete) res.end();
        else res.destroy();
      }
      resolve(upstream.complete);
    });
  });
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#262626}' +
  'h1{font-size:1.15rem;margin:0 0 .5rem}p{color:#525252}a{color:inherit}';

/** One of the front door's own pages: a heading, a sentence, and the way back to the panel. */
function page(res: ServerResponse, status: number, title: string, text: string, back?: string): void {
  const link = back ? `<p><a href="${escapeHtml(back)}">Back to the panel</a></p>` : '';
  send(
    res,
    status,
    'text/html',
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>` +
      `<style>${STYLE}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${link}</html>`,
    { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
  );
}

/** "Starting Adminer…": asks how its session is coming along, and moves on once it is ready. */
function startingPage(res: ServerResponse, sessionId: string): void {
  const nonce = randomBytes(16).toString('base64');
  const script =
    'const m=document.getElementById("m");' +
    `async function tick(){try{const r=await fetch("/.wpl7/state?s=${encodeURIComponent(sessionId)}",{credentials:"same-origin",cache:"no-store"});const s=await r.json();` +
    'if(s.state==="ready"){location.replace(s.location);return}' +
    'if(s.state==="failed"){m.textContent=s.message||"Adminer could not start.";return}' +
    'if(s.state==="ended"){m.textContent="This Adminer session has ended. Open the database again from the panel.";return}' +
    'if(s.message)m.textContent=s.message}catch(e){}setTimeout(tick,1000)}tick();';
  send(
    res,
    200,
    'text/html',
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Starting Adminer</title>` +
      `<style>${STYLE}</style><h1>Starting Adminer…</h1><p id="m">Signing in as the site's database user.</p>` +
      `<script nonce="${nonce}">${script}</script></html>`,
    { 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'` },
  );
}
