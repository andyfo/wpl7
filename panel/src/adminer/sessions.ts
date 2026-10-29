// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import { CookieJar } from './cookieJar.js';
import type { AdminerTicket } from './tickets.js';

/**
 * A front-door session: one panel sign-in, one site's database user on one server, and
 * Adminer's cookies for it - one Adminer sign-in. Every tab of that panel sign-in on that site
 * uses it, whichever of the site's databases it opened, so its forms' tokens hold in all of them.
 */
export interface AdminerSession extends AdminerTicket {
  id: string;
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

/** A tab that spent a ticket: its starting page asks after it until its session is ready. */
export interface AdminerTab {
  id: string;
  ticket: AdminerTicket;
  createdAt: number;
  /** The session it uses, once its page has asked (AdminerService.claim). */
  sessionId: string | null;
}

/** Whose browser a key in a cookie is: the panel sign-in it was given to. */
interface BrowserKey {
  userId: number;
  panelSid: string;
  createdAt: number;
}

export const ADMINER_IDLE_MS = 30 * 60_000;
export const ADMINER_TOTAL_MS = 12 * 3600_000;
/** How long a tab's starting page may take to see its session ready. */
const TAB_MS = 10 * 60_000;

/**
 * The front door's sessions, in memory: a panel restart ends them. One holds while its panel
 * sign-in does (`alive`), at most 30 minutes idle and 12 hours in all. The browser holds a key
 * in its cookie that stands for its panel sign-in, not for any one session: two tabs opened at
 * once may each be given one, and whichever the browser keeps reaches every session.
 */
export class AdminerSessions {
  private readonly sessions = new Map<string, AdminerSession>();
  private readonly keys = new Map<string, BrowserKey>();
  private readonly tabs = new Map<string, AdminerTab>();

  constructor(
    /** Is that panel sign-in still signed in, and its admin still there? */
    private readonly alive: (signIn: { userId: number; panelSid: string }) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** A tab for a spent ticket, until its page has asked for its session. */
  openTab(ticket: AdminerTicket): AdminerTab {
    const at = this.now();
    for (const [id, t] of this.tabs) if (at - t.createdAt > TAB_MS) this.tabs.delete(id);
    const tab: AdminerTab = { id: randomBytes(32).toString('base64url'), ticket, createdAt: at, sessionId: null };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  tab(id: string | undefined): AdminerTab | null {
    const t = id ? this.tabs.get(id) : undefined;
    if (!t) return null;
    if (this.now() - t.createdAt > TAB_MS || !this.alive(t.ticket)) {
      this.tabs.delete(t.id);
      return null;
    }
    return t;
  }

  /**
   * The key for a browser asking on behalf of a panel sign-in: the one its cookie holds when that
   * was given to the same sign-in, or a new one to set. A key from another sign-in - planted, or
   * left from before - is never taken over.
   */
  keyFor(cookie: string | undefined, signIn: { userId: number; panelSid: string }): { key: string; isNew: boolean } {
    const known = cookie ? this.owner(cookie) : null;
    if (cookie && known && known.userId === signIn.userId && known.panelSid === signIn.panelSid) return { key: cookie, isNew: false };
    // Keys of sign-ins that have ended go, as new ones come.
    for (const k of [...this.keys.keys()]) this.owner(k);
    const key = randomBytes(32).toString('base64url');
    this.keys.set(key, { userId: signIn.userId, panelSid: signIn.panelSid, createdAt: this.now() });
    return { key, isNew: true };
  }

  /** The panel sign-in's session for a site's user on a server, if one is signed in or signing in. */
  find(signIn: { userId: number; panelSid: string }, user: string, serverId: number): AdminerSession | null {
    for (const s of [...this.sessions.values()]) {
      if (s.userId !== signIn.userId || s.panelSid !== signIn.panelSid || s.user !== user || s.serverId !== serverId) continue;
      if (s.state !== 'failed' && this.get(s.id)) return s;
    }
    return null;
  }

  create(fields: Omit<AdminerSession, 'id' | 'jar' | 'createdAt' | 'lastUsed' | 'state' | 'message'>): AdminerSession {
    const at = this.now();
    const session: AdminerSession = {
      ...fields,
      id: randomBytes(32).toString('base64url'),
      jar: new CookieJar(),
      createdAt: at,
      lastUsed: at,
      state: 'starting',
      message: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** The session, when it still holds; one that does not is ended here. */
  get(id: string | undefined): AdminerSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const at = this.now();
    if (at - s.lastUsed > ADMINER_IDLE_MS || at - s.createdAt > ADMINER_TOTAL_MS || !this.alive(s)) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  /**
   * The session a request goes with: its browser key's panel sign-in's, for the database user
   * its address names - or without one (Adminer's styles and scripts) any of them. Null when
   * there is none: no key, a key the panel did not give, or a site this sign-in has not opened.
   */
  forRequest(cookie: string | undefined, user: string | null): AdminerSession | null {
    const signIn = cookie ? this.owner(cookie) : null;
    if (!signIn) return null;
    const mine = [...this.sessions.values()].filter(
      (s) => s.userId === signIn.userId && s.panelSid === signIn.panelSid && (user === null || s.user === user) && this.get(s.id),
    );
    const rank = (s: AdminerSession) => (s.state === 'ready' ? 2 : s.state === 'starting' ? 1 : 0);
    return mine.sort((a, b) => rank(b) - rank(a) || b.lastUsed - a.lastUsed)[0] ?? null;
  }

  touch(s: AdminerSession): void {
    s.lastUsed = this.now();
  }

  end(id: string): void {
    this.sessions.delete(id);
  }

  endAll(): void {
    this.sessions.clear();
    this.tabs.clear();
  }

  /** Whether a session that still holds is on this server: its Adminer must not stop under it. */
  inUseOn(serverId: number): boolean {
    for (const s of [...this.sessions.values()]) {
      if (s.serverId === serverId && this.get(s.id)) return true;
    }
    return false;
  }

  /** The panel sign-in a key stands for, while that sign-in holds. */
  private owner(key: string): BrowserKey | null {
    const k = this.keys.get(key);
    if (!k) return null;
    if (!this.alive(k)) {
      this.keys.delete(key);
      return null;
    }
    return k;
  }
}
