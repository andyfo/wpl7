// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import { CookieJar } from './cookieJar.js';
import type { AdminerTicket } from './tickets.js';

/** A front-door session: one admin, one database, Adminer's cookies for it. */
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

export const ADMINER_IDLE_MS = 30 * 60_000;
export const ADMINER_TOTAL_MS = 12 * 3600_000;

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
