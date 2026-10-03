import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';

/** Apply committed drizzle migrations. Runs at every boot; already-applied ones are skipped. */
export function runMigrations(db: Db): void {
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
  // SQLite rejects ALTER TABLE ... ADD COLUMN ... REFERENCES with a non-NULL default
  // while foreign_keys is ON (migration 0001 adds server_id columns that way).
  db.$client.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder });
  } finally {
    db.$client.pragma('foreign_keys = ON');
  }
}
