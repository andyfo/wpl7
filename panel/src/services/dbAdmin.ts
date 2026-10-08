// @docs backups/overview, reference/manual-recovery
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';
import type { Config } from '../config.js';
import type { DockerPort } from './docker.js';

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
  importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string): Promise<void>;
  /**
   * Make the server take a statement of `bytes`: its max_allowed_packet (16 MiB by default) is
   * raised when it is lower, until the server restarts. The new limit, or null when it was enough.
   */
  raisePacketLimit(bytes: number): Promise<number | null>;
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

export const DUMP_ARGS =
  '--single-transaction --quick --routines --events --triggers --default-character-set=utf8mb4';

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
      cmd: ['sh', '-c', 'zcat "/work/$DUMP_FILE" | exec mariadb -h"$DB_HOST" -uroot -p"$DB_PASS" "$DB_NAME"'],
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

  async importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const res = await this.docker.runEphemeral({
      image: this.config.mariadb.clientImage,
      // The client's own packet limit is 16 MiB too; the server's is raised apart (raisePacketLimit).
      cmd: ['sh', '-c', 'zcat "/work/$DUMP_FILE" | exec mariadb --max-allowed-packet=1G -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"'],
      env: [
        `DB_HOST=${this.config.mariadb.host}`,
        `DB_USER=${dbUser}`,
        `DB_PASS=${dbPassword}`,
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

  async raisePacketLimit(bytes: number): Promise<number | null> {
    const wanted = packetLimitFor(bytes);
    const [rows] = await this.pool.query('SELECT @@GLOBAL.max_allowed_packet AS v');
    if (Number((rows as { v: number | string }[])[0]?.v ?? 0) >= wanted) return null;
    await this.pool.query(`SET GLOBAL max_allowed_packet = ${wanted}`);
    return wanted;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
