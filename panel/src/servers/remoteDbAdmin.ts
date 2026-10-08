import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ExecPort } from '../lib/exec.js';
import { assertDbIdentifier, DUMP_ARGS, grantPattern, packetLimitFor, type DbAdminPort } from '../services/dbAdmin.js';

/** MySQL string literal escaping (backslash escapes are active in MariaDB's default sql_mode). */
const sqlQuote = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/**
 * DB admin on a remote server, via `docker exec` into that server's mariadb container.
 * The root password is referenced from the container's own environment, so it never
 * leaves the server; SQL travels over stdin, so nothing sensitive appears in argv.
 */
export class RemoteDbAdminService implements DbAdminPort {
  constructor(
    private readonly exec: ExecPort,
    private readonly container = 'wpl7-mariadb',
  ) {}

  private async sql(statements: string): Promise<void> {
    const res = await this.exec.runWithInput(
      'docker',
      ['exec', '-i', this.container, 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"'],
      Readable.from([statements]),
      { timeoutMs: 5 * 60_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`mariadb admin command failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }

  async createSiteDb(dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    await this.sql(
      [
        // Fail loudly (no IF NOT EXISTS) so name collisions surface instead of adopting stray data.
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `CREATE USER '${dbUser}'@'%' IDENTIFIED BY ${sqlQuote(dbPassword)};`,
        `GRANT ALL PRIVILEGES ON \`${grantPattern(dbName)}\`.* TO '${dbUser}'@'%';`,
        `FLUSH PRIVILEGES;`,
      ].join('\n'),
    );
  }

  async dropSiteDb(dbName: string, dbUser: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    await this.sql(
      [
        `DROP DATABASE IF EXISTS \`${dbName}\`;`,
        `DROP USER IF EXISTS '${dbUser}'@'%';`,
        `FLUSH PRIVILEGES;`,
      ].join('\n'),
    );
  }

  async recreateDb(dbName: string): Promise<void> {
    assertDbIdentifier(dbName);
    await this.sql(
      [
        `DROP DATABASE IF EXISTS \`${dbName}\`;`,
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      ].join('\n'),
    );
  }

  async ping(): Promise<boolean> {
    const res = await this.exec.run('docker', ['exec', this.container, 'healthcheck.sh', '--connect'], {
      timeoutMs: 30_000,
    });
    return res.exitCode === 0;
  }

  async dumpTo(dbName: string, destGzPath: string): Promise<void> {
    assertDbIdentifier(dbName);
    const script =
      `set -o pipefail; docker exec ${this.container} sh -c ` +
      `'exec mariadb-dump ${DUMP_ARGS} -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}'` +
      ` | gzip > ${q(destGzPath)}`;
    const res = await this.exec.run('bash', ['-c', script], { timeoutMs: 60 * 60_000 });
    if (res.exitCode !== 0) {
      throw new Error(`mariadb-dump failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
    const size = await this.exec.run('stat', ['-c', '%s', destGzPath]);
    if (size.exitCode !== 0 || Number(size.stdout.trim()) < 64) {
      throw new Error('mariadb-dump produced an implausibly small file');
    }
  }

  async importFrom(srcGzPath: string, dbName: string): Promise<void> {
    assertDbIdentifier(dbName);
    const script =
      `set -o pipefail; zcat ${q(srcGzPath)} | docker exec -i ${this.container} sh -c ` +
      `'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}'`;
    const res = await this.exec.run('bash', ['-c', script], { timeoutMs: 60 * 60_000 });
    if (res.exitCode !== 0) {
      throw new Error(`Database import failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }

  /**
   * As the site's own user. Its password never appears in an argv, here or on the server: it goes
   * over stdin into an option file inside the MariaDB container (mode 600, removed afterwards), and
   * the client reads it from there.
   */
  async importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    const cnf = `/run/wpl7-import-${randomBytes(8).toString('hex')}.cnf`;
    const written = await this.exec.runWithInput(
      'docker',
      ['exec', '-i', this.container, 'sh', '-c', `umask 077; cat > ${cnf}`],
      Readable.from([`[client]\nuser=${dbUser}\npassword=${optionQuote(dbPassword)}\n`]),
      { timeoutMs: 60_000 },
    );
    if (written.exitCode !== 0) {
      throw new Error(`Could not hand the database login to the import (exit ${written.exitCode}): ${written.stderr.slice(0, 500)}`);
    }
    try {
      const script =
        `set -o pipefail; zcat ${q(srcGzPath)} | docker exec -i ${this.container} ` +
        `mariadb --defaults-extra-file=${cnf} --max-allowed-packet=1G ${dbName}`;
      const res = await this.exec.run('bash', ['-c', script], { timeoutMs: 60 * 60_000 });
      if (res.exitCode !== 0) {
        throw new Error(`Database import failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
      }
    } finally {
      await this.exec.run('docker', ['exec', this.container, 'rm', '-f', cnf], { timeoutMs: 60_000 }).catch(() => undefined);
    }
  }

  async raisePacketLimit(bytes: number): Promise<number | null> {
    const wanted = packetLimitFor(bytes);
    const res = await this.exec.runWithInput(
      'docker',
      ['exec', '-i', this.container, 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B'],
      Readable.from(['SELECT @@GLOBAL.max_allowed_packet;\n']),
      { timeoutMs: 60_000 },
    );
    if (res.exitCode !== 0) throw new Error(`mariadb admin command failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    if (Number(res.stdout.trim()) >= wanted) return null;
    await this.sql(`SET GLOBAL max_allowed_packet = ${wanted};`);
    return wanted;
  }
}

const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** A value in a MySQL option file: double-quoted, with the two characters that need it escaped. */
const optionQuote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
