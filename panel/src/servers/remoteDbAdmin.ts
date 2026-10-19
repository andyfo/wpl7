// @docs databases/overview
import { randomBytes } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import type { ExecPort } from '../lib/exec.js';
import {
  INVENTORY_SQL,
  assertDbIdentifier,
  DUMP_ARGS,
  FORGET_GRANTS_SQL,
  IMPORT_CLIENT_ARGS,
  grantPattern,
  packetLimitFor,
  parseInventory,
  quoteDbObject,
  type DbAdminPort,
  type DbInventoryRow,
} from '../services/dbAdmin.js';

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
    await this.run(statements, 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"');
  }

  /** As sql(), with the client's batch output (`-N -B`: no headers, tab-separated) handed back. */
  private async sqlOutput(statements: string): Promise<string> {
    return this.run(statements, 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B');
  }

  private async run(statements: string, client: string): Promise<string> {
    const res = await this.exec.runWithInput(
      'docker',
      ['exec', '-i', this.container, 'sh', '-c', client],
      Readable.from([statements]),
      { timeoutMs: 5 * 60_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`mariadb admin command failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
    return res.stdout;
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
      `set -o pipefail; gzip -dc ${q(srcGzPath)} | docker exec -i ${this.container} sh -c ` +
      `'exec mariadb ${IMPORT_CLIENT_ARGS} -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}'`;
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
  async importFromAs(srcGzPath: string, dbName: string, dbUser: string, dbPassword: string, opts: { timeoutMs?: number } = {}): Promise<void> {
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
        `set -o pipefail; gzip -dc ${q(srcGzPath)} | docker exec -i ${this.container} ` +
        `mariadb --defaults-extra-file=${cnf} ${IMPORT_CLIENT_ARGS} --max-allowed-packet=1G ${dbName}`;
      const res = await this.exec.run('bash', ['-c', script], { timeoutMs: opts.timeoutMs ?? 60 * 60_000 });
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

  async inventory(): Promise<DbInventoryRow[]> {
    return parseInventory(await this.sqlOutput(`${INVENTORY_SQL};\n`));
  }

  async createExtraDb(dbName: string, dbUser: string): Promise<void> {
    assertDbIdentifier(dbName);
    assertDbIdentifier(dbUser);
    await this.sql(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    try {
      await this.sql(
        [
          // The new database is this site's alone, whatever grants an earlier one of that name left.
          `${forgetGrants(dbName)};`,
          `GRANT ALL PRIVILEGES ON \`${grantPattern(dbName)}\`.* TO '${dbUser}'@'%';`,
          `FLUSH PRIVILEGES;`,
        ].join('\n'),
      );
    } catch (err) {
      // Made here, so undone here: a caller that gets the error owns nothing on the server, and
      // never drops a database of that name that was there before.
      await this.sql(`DROP DATABASE IF EXISTS \`${dbName}\`;`).catch(() => undefined);
      throw err;
    }
  }

  async dropDb(dbName: string): Promise<void> {
    await this.sql([`DROP DATABASE IF EXISTS ${quoteDbObject(dbName)};`, `${forgetGrants(dbName)};`, 'FLUSH PRIVILEGES;'].join('\n'));
  }

  async dropUser(dbUser: string): Promise<void> {
    assertDbIdentifier(dbUser);
    const hosts = (await this.sqlOutput(`SELECT Host FROM mysql.user WHERE User = ${sqlQuote(dbUser)};\n`))
      .split('\n')
      .filter(Boolean);
    if (hosts.length === 0) return;
    await this.sql(hosts.map((host) => `DROP USER IF EXISTS ${sqlQuote(dbUser)}@${sqlQuote(host)};`).join('\n'));
  }

  async userExists(dbUser: string): Promise<boolean> {
    const out = await this.sqlOutput(`SELECT COUNT(*) FROM mysql.user WHERE User = ${sqlQuote(dbUser)};\n`);
    return Number(out.trim()) > 0;
  }

  async setUserPassword(dbUser: string, password: string): Promise<void> {
    assertDbIdentifier(dbUser);
    // Over stdin, like every statement here: the password appears in no argv on either side.
    await this.sql(`ALTER USER '${dbUser}'@'%' IDENTIFIED BY ${sqlQuote(password)};`);
  }

  /** A reader that goes away errors `out`, and an errored destination closes the SSH channel (sshConnection.ts). */
  async dumpToStream(dbName: string, out: Writable): Promise<void> {
    assertDbIdentifier(dbName);
    const res = await this.exec.runToStream(
      'docker',
      ['exec', this.container, 'sh', '-c', `exec mariadb-dump ${DUMP_ARGS} -uroot -p"$MARIADB_ROOT_PASSWORD" ${dbName}`],
      out,
      { timeoutMs: 6 * 3600_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`mariadb-dump failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
  }
}

const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** FORGET_GRANTS_SQL with its two names in place, for the client over stdin. */
const forgetGrants = (dbName: string) => {
  const names = [grantPattern(dbName), dbName];
  return FORGET_GRANTS_SQL.replace(/\?/g, () => sqlQuote(names.shift()!));
};

/** A value in a MySQL option file: double-quoted, with the two characters that need it escaped. */
const optionQuote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
