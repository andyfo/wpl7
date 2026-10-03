import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Open (or create) the panel database with the required PRAGMAs applied. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = connectDb(new Database(file));
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort; file may be on a filesystem without chmod */
    }
  }
  return db;
}

/**
 * The PRAGMAs belong to the connection, not to the file, so every connection gets them here -
 * including the test suite's copies of an already-migrated database.
 */
export function connectDb(sqlite: Database.Database): Db {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  return drizzle(sqlite, { schema }) as Db;
}
