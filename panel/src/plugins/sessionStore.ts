import type { SessionStore } from '@fastify/session';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { UsersService } from '../services/users.js';

type SetArgs = Parameters<SessionStore['set']>;
type GetArgs = Parameters<SessionStore['get']>;
type DestroyArgs = Parameters<SessionStore['destroy']>;

const WEEK_MS = 7 * 24 * 3600_000;

/**
 * Server-side session store on the panel SQLite DB: restart-proof, and revocable for real.
 *
 * With `rolling: true` every response saves its session again - the response to a request
 * that was already running when that session was signed out or revoked included, and an
 * upsert would put the deleted row straight back. So a session somebody is signed in to is
 * only ever updated here, never created, and only while it is of its account's current
 * generation (UsersService.revokeSessions). Sessions are created empty, by regenerate(),
 * before anyone is signed in to them.
 */
export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly users: UsersService,
  ) {}

  set(sessionId: SetArgs[0], session: SetArgs[1], callback: SetArgs[2]): void {
    try {
      const cookie = (session as { cookie?: { expires?: string | Date | null } }).cookie;
      const expiresAt = cookie?.expires ? new Date(cookie.expires).getTime() : Date.now() + WEEK_MS;
      const data = JSON.stringify(session);
      // A column as well as a field in `data`, so one admin's sessions can be revoked in one
      // statement.
      const userId = session.userId ?? null;
      if (userId === null) {
        this.db
          .insert(sessions)
          .values({ sid: sessionId, data, expiresAt, userId })
          .onConflictDoUpdate({ target: sessions.sid, set: { data, expiresAt, userId } })
          .run();
      } else if (this.users.byId(userId)?.sessionGeneration === (session.generation ?? 0)) {
        // The row is the one regenerate() stored while the session was still empty; the
        // account only arrives with this save, at the end of the request that signed in.
        this.db.update(sessions).set({ data, expiresAt, userId }).where(eq(sessions.sid, sessionId)).run();
      }
      // Otherwise: an account removed, or a generation revoked. Nothing is written, and a
      // session nothing was written for is simply not there when its cookie comes back.
      callback();
    } catch (err) {
      callback(err);
    }
  }

  get(sessionId: GetArgs[0], callback: GetArgs[1]): void {
    try {
      const row = this.db.select().from(sessions).where(eq(sessions.sid, sessionId)).get();
      if (!row || row.expiresAt < Date.now()) return callback(null, undefined);
      const session = JSON.parse(row.data) as { cookie?: { expires?: string | Date | null } };
      if (session.cookie?.expires) {
        session.cookie.expires = new Date(session.cookie.expires);
      }
      callback(null, session as Parameters<GetArgs[1]>[1]);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sessionId: DestroyArgs[0], callback: DestroyArgs[1]): void {
    try {
      this.db.delete(sessions).where(eq(sessions.sid, sessionId)).run();
      callback();
    } catch (err) {
      callback(err);
    }
  }
}
