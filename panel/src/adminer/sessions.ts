// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import { CookieJar } from './cookieJar.js';
import type { AdminerTicket } from './tickets.js';

/**
 * A front-door session: one admin, one site's database user, Adminer's cookies for it. One
 * browser holds several - a tab per site - under the key in its cookie (`browser`).
 */
export interface AdminerSession extends AdminerTicket {
  id: string;
  /**
   * The key in the browser's cookie: every session it opened shares it. Empty until the tab that
   * spent the ticket claims the session (claim()): the link opens cross-site, and the browser
   * sends its Strict cookie only to the page's own requests after that.
   */
  browser: string;
  serverId: number;
  /** The database user Adminer signs in as: the site's own. */
  user: string;
  jar: CookieJar;
  createdAt: number;
  lastUsed: number;
  /** While its server's Adminer starts and signs in; the tab waits for `ready`. */
  state: 'starting' | 'ready' | 'failed';
  message: string | null;
}

export const ADMINER_IDLE_MS = 30 * 60_000;
export const ADMINER_TOTAL_MS = 12 * 3600_000;
/** How long a session waits for its tab to claim it. */
const UNCLAIMED_MS = 2 * 60_000;
/** Sessions one browser keeps at once; claiming another drops the one used longest ago. */
const PER_BROWSER = 20;

/**
 * The front door's sessions, in memory: a panel restart ends them. One holds while its panel
 * session is signed in (`alive`), at most 30 minutes idle and 12 hours in all.
 */
export class AdminerSessions {
  private readonly sessions = new Map<string, AdminerSession>();

  constructor(
    /** Is the panel session behind it still signed in, and its admin still there? */
    private readonly alive: (s: AdminerSession) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new browser key, for a browser whose cookie holds none of this panel session's. */
  static browserKey(): string {
    return randomBytes(32).toString('base64url');
  }

  /** A session for a spent ticket, not yet claimed by a browser. */
  create(fields: Omit<AdminerSession, 'id' | 'browser' | 'jar' | 'createdAt' | 'lastUsed' | 'state' | 'message'>): AdminerSession {
    const at = this.now();
    const session: AdminerSession = {
      ...fields,
      id: randomBytes(32).toString('base64url'),
      browser: '',
      jar: new CookieJar(),
      createdAt: at,
      lastUsed: at,
      state: 'starting',
      message: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * The tab that spent the ticket claims its session, for the browser key its cookie holds -
   * when that key belongs to the same panel session (ownedBy) - or else for a new one. Returns the
   * key, new when the cookie must be set. Other tabs' sessions stay as they are.
   */
  claim(s: AdminerSession, cookie: string | undefined): { browser: string; isNew: boolean } {
    const isNew = !(cookie && this.ownedBy(cookie, s.userId, s.panelSid));
    const browser = isNew ? AdminerSessions.browserKey() : cookie!;
    const others = this.ofBrowser(browser).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const old of others.slice(PER_BROWSER - 1)) this.sessions.delete(old.id);
    s.browser = browser;
    return { browser, isNew };
  }

  /** The session, when it still holds; one that does not is ended here. */
  get(id: string | undefined): AdminerSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const at = this.now();
    const unclaimed = s.browser === '' && at - s.createdAt > UNCLAIMED_MS;
    if (unclaimed || at - s.lastUsed > ADMINER_IDLE_MS || at - s.createdAt > ADMINER_TOTAL_MS || !this.alive(s)) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  /** The browser's sessions that still hold. */
  ofBrowser(browser: string | undefined): AdminerSession[] {
    if (!browser) return [];
    return [...this.sessions.values()].filter((s) => s.browser === browser && this.get(s.id) !== null);
  }

  /**
   * The browser's session for a request: one for the database user its address names, or
   * without one (Adminer's styles and scripts) any. Two tabs on the same site's user may have a
   * session each: either serves, the one signed in and used last first. Null when there is none.
   */
  forRequest(browser: string | undefined, user: string | null): AdminerSession | null {
    const mine = this.ofBrowser(browser).filter((s) => user === null || s.user === user);
    const rank = (s: AdminerSession) => (s.state === 'ready' ? 1 : 0);
    return mine.sort((a, b) => rank(b) - rank(a) || b.lastUsed - a.lastUsed)[0] ?? null;
  }

  /**
   * Whether the browser key belongs to this panel session: only then does a new session join
   * it. A key the panel did not hand to this sign-in - planted, or left from another - never does.
   */
  ownedBy(browser: string | undefined, userId: number, panelSid: string): boolean {
    const mine = this.ofBrowser(browser);
    return mine.length > 0 && mine.every((s) => s.userId === userId && s.panelSid === panelSid);
  }

  touch(s: AdminerSession): void {
    s.lastUsed = this.now();
  }

  end(id: string): void {
    this.sessions.delete(id);
  }

  endAll(): void {
    this.sessions.clear();
  }

  /** Whether a session that still holds is on this server: its Adminer must not stop under it. */
  inUseOn(serverId: number): boolean {
    for (const s of [...this.sessions.values()]) {
      if (s.serverId === serverId && this.get(s.id)) return true;
    }
    return false;
  }
}
