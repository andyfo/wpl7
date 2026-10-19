// @docs backups/overview, databases/overview, reference/manual-recovery
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Writable } from 'node:stream';
import mysql from 'mysql2/promise';
import type { Config } from '../config.js';
import type { DockerPort } from './docker.js';
import { DB_OBJECT_NAME_RE, SYSTEM_DATABASES } from '../../shared/databases.js';

/** One database as the inventory finds it: its tables and their size (services/databases.ts). */
export interface DbInventoryRow {
  name: string;
  tables: number;
  /** Data and indexes, as information_schema reports them. */
  bytes: number;
  collation: string | null;
}

/** MariaDB admin operations, always executed ON the server that owns the database. */
export interface DbAdminPort {
  createSiteDb(dbName: string, dbUser: string, dbPassword: string): Promise<void>;
  dropSiteDb(dbName: string, dbUser: string): Promise<void>;
  recreateDb(dbName: string): Promise<void>;
  ping(): Promise<boolean>;
  /** Write a gzipped dump of dbName to a path ON THAT SERVER. */
  dumpTo(dbName: string, destGzPath: string): Promise<void>;
  /** Import a gzipped dump from a path ON THAT SERVER into dbName. */
  importFrom(srcGzPath: string, dbName: string): Promise<void>;
  /**
   * The same, connected as the site's own database user rather than as root. For a dump the panel
   * did not write itself (an import pulled from another host): whatever it holds can then reach
   * nothing but the site's own database.
   */
  importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string, opts?: { timeoutMs?: number }): Promise<void>;
  /**
   * Make the server take a statement of `bytes`: its max_allowed_packet (16 MiB by default) is
   * raised when it is lower, until the server restarts. The new limit, or null when it was enough.
   */
  raisePacketLimit(bytes: number): Promise<number | null>;
  /** Every database on the server but MariaDB's own, with its tables and their size. */
  inventory(): Promise<DbInventoryRow[]>;
  /**
   * Create another database of a site and grant it to the site's own user. Fails when the name
   * is taken, like createSiteDb: a stray database must surface, not be adopted.
   */
  createExtraDb(dbName: string, dbUser: string): Promise<void>;
  /** Drop a database; one already gone is fine. Quoted, so any name a server can hold is taken. */
  dropDb(dbName: string): Promise<void>;
  /** Drop a user (at any host it has); one already gone is fine. */
  dropUser(dbUser: string): Promise<void>;
  /** Whether the server has a user of that name, at any host. */
  userExists(dbUser: string): Promise<boolean>;
  /** Give a site's user a new password. */
  setUserPassword(dbUser: string, password: string): Promise<void>;
  /** Write a plain (uncompressed) dump of dbName into `out`, as root. */
  dumpToStream(dbName: string, out: Writable, opts?: { signal?: AbortSignal }): Promise<void>;
}

const MIB = 1024 * 1024;

/** The packet limit a statement of `bytes` needs: whole 16 MiB steps, at most MariaDB's 1 GiB. */
export function packetLimitFor(bytes: number): number {
  return Math.min(1024 * MIB, Math.ceil((bytes + MIB) / (16 * MIB)) * 16 * MIB);
}

const IDENT_RE = /^[a-z0-9_]{1,64}$/;

export function assertDbIdentifier(name: string): void {
  // Identifiers cannot be bound parameters; safe because they derive from the locked slug charset.
  if (!IDENT_RE.test(name)) throw new Error(`Unsafe MySQL identifier: ${JSON.stringify(name)}`);
}

/**
 * The database name in `GRANT … ON \`db\`.*` is a LIKE pattern, not a plain identifier:
 * `_` matches any character and `%` any sequence. Slugs routinely contain `_` (dbIdentifier
 * turns dashes into underscores), so an unescaped grant for `wp_my_shop` would also hand
 * that user full rights on `wp_myXshop` - a cross-tenant leak between two real sites.
 * Escaping is only correct HERE; CREATE/DROP DATABASE take a literal identifier.
 */
export function grantPattern(dbName: string): string {
  return dbName.replace(/[_%]/g, '\\$&');
}

/**
 * Removes every database-level grant on exactly this name, for anyone (`?`: the name as GRANT wrote
 * it, `_` and `%` escaped, then as typed). MariaDB keeps a database's grants when the database is
 * dropped, so whoever held them could make it again, and would hold them over the next database
 * of that name: another site's, perhaps. Followed by FLUSH PRIVILEGES.
 */
export const FORGET_GRANTS_SQL = 'DELETE FROM mysql.db WHERE Db IN (?, ?)';

export const DUMP_ARGS =
  '--single-transaction --quick --routines --events --triggers --default-character-set=utf8mb4';

/**
 * What every client that loads a dump runs with. A dump is data, whoever wrote it: without these
 * the client itself would act on `\!` and `system` (a shell), `source` (a local file) and
 * `LOAD DATA LOCAL INFILE` (a local file sent to the server), inside its container, where a
 * remote server's root password is in the environment. `--binary-mode` and `--sandbox` each turn
 * the client commands off; only `--local-infile=0` stops LOAD DATA LOCAL.
 */
export const IMPORT_CLIENT_ARGS = '--binary-mode --sandbox --local-infile=0';

/**
 * A name a server already holds, quoted for SQL: whatever is in it, as long as MariaDB could have
 * made a folder of it. For the drop of a database the panel did not create (the unused list).
 */
export function quoteDbObject(name: string): string {
  if (!DB_OBJECT_NAME_RE.test(name)) throw new Error(`Unsafe MySQL name: ${JSON.stringify(name)}`);
  return `\`${name.replace(/`/g, '``')}\``;
}

/** The inventory's one query: every database but MariaDB's own, its tables and their size. */
export const INVENTORY_SQL = `SELECT s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME, COUNT(t.TABLE_NAME), COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0)
FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
WHERE s.SCHEMA_NAME NOT IN (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ')})
GROUP BY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME`;

/** One line of the mariadb client's batch output, its escapes undone (`\t`, `\n`, `\\`, `\0`). */
export function parseBatchLine(line: string): string[] {
  return line.split('\t').map((field) =>
    field.replace(/\\([\\tn0])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : '\\')),
  );
}

/** The inventory rows in the mariadb client's batch output (`-N -B`). */
export function parseInventory(stdout: string): DbInventoryRow[] {
  const rows: DbInventoryRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [name, collation, tables, bytes] = parseBatchLine(line);
    if (!name) continue;
    rows.push({
      name,
      collation: !collation || collation === 'NULL' ? null : collation,
      tables: Number(tables) || 0,
      bytes: Number(bytes) || 0,
    });
  }
  return rows;
}

export class DbAdminService implements DbAdminPort {
  private pool: mysql.Pool;

  constructor(
    private readonly config: Config,
    private readonly docker: DockerPort,
  ) {
    this.pool = mysql.createPool({
      host: config.mariadb.host,
      user: 'root',
      password: config.mariadb.rootPassword,
      connectionLimit: 3,
      connectTimeout: 10_000,
    });
  }

  async createSiteDb(dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const conn = await this.pool.getConnection();
    try {
      // Fail loudly (no IF NOT EXISTS) so name collisions surface instead of adopting stray data.
      await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await conn.query(`CREATE USER '${dbUser}'@'%' IDENTIFIED BY ${conn.escape(dbPassword)}`);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${grantPattern(dbName)}\`.* TO '${dbUser}'@'%'`);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      conn.release();
    }
  }

  async dropSiteDb(dbName: string, dbUser: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await conn.query(`DROP USER IF EXISTS '${dbUser}'@'%'`);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      conn.release();
    }
  }

  /** Drop and recreate an (empty) database, keeping the user/grants. Used by restore. */
  async recreateDb(dbName: string): Promise<void> {
    assertDbIdentifier(dbName);
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      conn.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      const conn = await this.pool.getConnection();
      try {
        await conn.query('SELECT 1');
        return true;
      } finally {
        conn.release();
      }
    } catch {
      return false;
    }
  }

  async dumpTo(dbName: string, destGzPath: string): Promise<void> {
    assertDbIdentifier(dbName);
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(destGzPath);
    gzip.pipe(out);
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      gzip.on('error', reject);
    });
    // Root password stays inside the mariadb container (referenced from its own env).
    const res = await this.docker.execToStream(
      this.config.mariadb.container,
      ['sh', '-c', `exec mariadb-dump ${DUMP_ARGS} -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}`],
      gzip,
      { timeoutMs: 60 * 60_000 },
    );
    gzip.end();
    await done;
    if (res.exitCode !== 0) {
      throw new Error(`mariadb-dump failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
    const { size } = await fsp.stat(destGzPath);
    if (size < 64) throw new Error('mariadb-dump produced an implausibly small file');
  }

  /** Import via an ephemeral mariadb client container (the dump dir is bind-mounted read-only). */
  async importFrom(srcGzPath: string, dbName: string): Promise<void> {
    assertDbIdentifier(dbName);
    const res = await this.docker.runEphemeral({
      image: this.config.mariadb.clientImage,
      // bash for pipefail: a dump that cannot be read must fail the import, not load nothing.
      cmd: ['bash', '-c', `set -o pipefail; gzip -dc "/work/$DUMP_FILE" | mariadb ${IMPORT_CLIENT_ARGS} -h"$DB_HOST" -uroot -p"$DB_PASS" "$DB_NAME"`],
      env: [
        `DB_HOST=${this.config.mariadb.host}`,
        `DB_PASS=${this.config.mariadb.rootPassword}`,
        `DB_NAME=${dbName}`,
        `DUMP_FILE=${path.basename(srcGzPath)}`,
      ],
      binds: [`${path.dirname(srcGzPath)}:/work:ro`],
      networks: [this.config.dbNetwork],
      timeoutMs: 60 * 60_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`Database import failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }

  async importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const res = await this.docker.runEphemeral({
      image: this.config.mariadb.clientImage,
      // The client's own packet limit is 16 MiB too; the server's is raised apart (raisePacketLimit).
      cmd: [
        'bash',
        '-c',
        `set -o pipefail; gzip -dc "/work/$DUMP_FILE" | mariadb ${IMPORT_CLIENT_ARGS} --max-allowed-packet=1G -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"`,
      ],
      env: [
        `DB_HOST=${this.config.mariadb.host}`,
        `DB_USER=${dbUser}`,
        `DB_PASS=${dbPassword}`,
        `DB_NAME=${dbName}`,
        `DUMP_FILE=${path.basename(srcGzPath)}`,
      ],
      binds: [`${path.dirname(srcGzPath)}:/work:ro`],
      networks: [this.config.dbNetwork],
      timeoutMs: opts.timeoutMs ?? 60 * 60_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`Database import failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }

  async raisePacketLimit(bytes: number): Promise<number | null> {
    const wanted = packetLimitFor(bytes);
    const [rows] = await this.pool.query('SELECT @@GLOBAL.max_allowed_packet AS v');
    if (Number((rows as { v: number | string }[])[0]?.v ?? 0) >= wanted) return null;
    await this.pool.query(`SET GLOBAL max_allowed_packet = ${wanted}`);
    return wanted;
  }

  async inventory(): Promise<DbInventoryRow[]> {
    const [rows] = await this.pool.query({ sql: INVENTORY_SQL, rowsAsArray: true });
    return (rows as [string, string | null, number | string, number | string][]).map(([name, collation, tables, bytes]) => ({
      name,
      collation: collation ?? null,
      tables: Number(tables) || 0,
      bytes: Number(bytes) || 0,
    }));
  }

  async createExtraDb(dbName: string, dbUser: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      try {
        // The new database is this site's alone, whatever grants an earlier one of that name left.
        await conn.query(FORGET_GRANTS_SQL, [grantPattern(dbName), dbName]);
        await conn.query(`GRANT ALL PRIVILEGES ON \`${grantPattern(dbName)}\`.* TO '${dbUser}'@'%'`);
        await conn.query('FLUSH PRIVILEGES');
      } catch (err) {
        // Made here, so undone here: a caller that gets the error owns nothing on the server, and
        // never drops a database of that name that was there before.
        await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => undefined);
        throw err;
      }
    } finally {
      conn.release();
    }
  }

  async dropDb(dbName: string): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS ${quoteDbObject(dbName)}`);
      await conn.query(FORGET_GRANTS_SQL, [grantPattern(dbName), dbName]);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      conn.release();
    }
  }

  async dropUser(dbUser: string): Promise<void> {
    assertDbIdentifier(dbUser);
    const [rows] = await this.pool.query('SELECT Host FROM mysql.user WHERE User = ?', [dbUser]);
    for (const { Host } of rows as { Host: string }[]) {
      await this.pool.query('DROP USER IF EXISTS ?@?', [dbUser, Host]);
    }
  }

  async userExists(dbUser: string): Promise<boolean> {
    const [rows] = await this.pool.query('SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?', [dbUser]);
    return Number((rows as { n: number | string }[])[0]?.n ?? 0) > 0;
  }

  async setUserPassword(dbUser: string, password: string): Promise<void> {
    assertDbIdentifier(dbUser);
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`ALTER USER '${dbUser}'@'%' IDENTIFIED BY ${conn.escape(password)}`);
    } finally {
      conn.release();
    }
  }

  async dumpToStream(dbName: string, out: Writable, opts: { signal?: AbortSignal } = {}): Promise<void> {
    assertDbIdentifier(dbName);
    const res = await this.docker.execToStream(
      this.config.mariadb.container,
      ['sh', '-c', `exec mariadb-dump ${DUMP_ARGS} -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}`],
      out,
      { timeoutMs: 6 * 3600_000, signal: opts.signal },
    );
    if (res.exitCode !== 0) {
      throw new Error(`mariadb-dump failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
