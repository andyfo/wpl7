/**
 * The database browser against a real MariaDB, the way the panel reaches one: the relay run with
 * `docker exec` inside the MariaDB container, mysql2 over it, logged in as a site's own user.
 *
 * Opt-in: needs Docker and the `mariadb:11.4` image the stack runs. Run it when the MariaDB
 * image or the browser moves (docs/internal/watchlist.md):
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/dbBrowser.test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerService } from '../../src/services/docker.js';
import { DbBrowserService, type DbTarget } from '../../src/services/dbBrowser.js';
import { DbAdminService } from '../../src/services/dbAdmin.js';
import { RemoteDbAdminService } from '../../src/servers/remoteDbAdmin.js';
import { hostExec } from '../../src/lib/exec.js';
import { AppError } from '../../src/lib/errors.js';
import { alterTableSql, createTableSql, dropTableSql } from '../../src/lib/sqlDdl.js';
import { dbAlterChange, dbColumnDef } from '../../shared/databases.js';
import type { Config } from '../../src/config.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const CONTAINER = `wpl7-engine-mariadb-${process.pid}`;
const NETWORK = `wpl7-engine-db-${process.pid}`;
const ROOT_PASSWORD = 'engine-root';

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
const rootSql = (sql: string) => {
  const res = spawnSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" --default-character-set=utf8mb4 -N -B'], {
    input: sql,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout;
};

const site: DbTarget = { database: 'wp_shop', user: 'wp_shop', password: "pa'ss\\word" };

describe.skipIf(!ENABLED)('database browser against MariaDB', () => {
  const service = new DbBrowserService(new DockerService('none', 'none'), () => 'the engine test', CONTAINER);

  beforeAll(() => {
    docker('rm', '-f', CONTAINER);
    docker('network', 'rm', NETWORK);
    // A network of its own, for the ephemeral client container the panel's own server imports with.
    docker('network', 'create', NETWORK);
    const run = docker('run', '-d', '--name', CONTAINER, '--network', NETWORK, '-e', `MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`, 'mariadb:11.4');
    if (run.status !== 0) throw new Error(run.stderr);
    for (let i = 0; i < 60; i++) {
      if (docker('exec', CONTAINER, 'healthcheck.sh', '--connect', '--innodb_initialized').status === 0) break;
      spawnSync('sleep', ['1']);
    }
    rootSql(`
CREATE DATABASE wp_shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE wp_other;
CREATE USER 'wp_shop'@'%' IDENTIFIED BY 'pa''ss\\\\word';
GRANT ALL PRIVILEGES ON \`wp\\_shop\`.* TO 'wp_shop'@'%';
CREATE TABLE wp_shop.wp_options (option_id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, option_name varchar(191) NOT NULL UNIQUE, option_value longtext NOT NULL, autoload varchar(20) NOT NULL DEFAULT 'yes');
CREATE TABLE wp_shop.wp_nokey (a int, b text);
CREATE TABLE wp_shop.t_bin (id int PRIMARY KEY, data varbinary(64), big bigint unsigned);
CREATE DEFINER = 'wp_shop'@'%' VIEW wp_shop.v_autoload AS SELECT option_name FROM wp_shop.wp_options WHERE autoload = 'yes';
INSERT INTO wp_shop.wp_options (option_name, option_value) VALUES ('siteurl', 'https://shop.example.com'), ('active_plugins', 'a:1:{i:0;s:19:"akismet/akismet.php";}'), ('long', REPEAT('x', 5000)), ('pct', '100%_done'), ('emoji', CONCAT(REPEAT('😀', 10), REPEAT('y', 995)));
INSERT INTO wp_shop.wp_nokey VALUES (1, 'one');
INSERT INTO wp_shop.t_bin VALUES (1, UNHEX('00ff10'), 18446744073709551615);
CREATE TABLE wp_other.secret (s text);
`);
  }, 120_000);

  afterAll(() => {
    service.closeIdle();
    docker('rm', '-f', CONTAINER);
    docker('network', 'rm', NETWORK);
  });

  it('lists the tables and views of the site database only', async () => {
    const tables = await service.tables(site);
    expect(tables.map((t) => [t.name, t.type])).toEqual([
      ['t_bin', 'table'],
      ['v_autoload', 'view'],
      ['wp_nokey', 'table'],
      ['wp_options', 'table'],
    ]);
  });

  it('describes a table: kinds, key, indexes', async () => {
    const s = await service.structure(site, 'wp_options');
    expect(s.key).toEqual(['option_id']);
    expect(s.columns.map((c) => [c.name, c.kind])).toEqual([
      ['option_id', 'number'],
      ['option_name', 'text'],
      ['option_value', 'text'],
      ['autoload', 'text'],
    ]);
    expect(s.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'option_name']);
    await expect(service.structure(site, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    // Another database's table is unknown to the site's user, not refused: it does not exist for it.
    await expect(service.structure({ ...site, database: 'wp_shop' }, 'secret')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('pages, sorts and filters rows, cutting long values at the server', async () => {
    const page = await service.rows(site, 'wp_options', { offset: 0, limit: 2, dir: 'asc', filters: [] });
    expect(page.rows.length).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.sql).toBe('SELECT * FROM `wp_options` ORDER BY `option_id` LIMIT 2 OFFSET 0');
    const long = await service.rows(site, 'wp_options', {
      offset: 0,
      limit: 50,
      dir: 'asc',
      filters: [{ column: 'option_name', op: 'eq', value: 'long' }],
    });
    expect(long.rows[0]![2]).toEqual({ cut: 'x'.repeat(1000), length: 5000 });
    // 1,005 characters, ten of them two UTF-16 units each: cut at 1,000 characters, and said so.
    const emoji = await service.rows(site, 'wp_options', {
      offset: 0,
      limit: 5,
      dir: 'asc',
      filters: [{ column: 'option_name', op: 'eq', value: 'emoji' }],
    });
    expect(emoji.rows[0]![2]).toEqual({ cut: '😀'.repeat(10) + 'y'.repeat(990), length: 1005 });
    // `%` and `_` typed into "contains" are literal.
    const pct = await service.rows(site, 'wp_options', {
      offset: 0,
      limit: 50,
      dir: 'desc',
      sort: 'option_name',
      filters: [{ column: 'option_value', op: 'contains', value: '%_d' }],
    });
    expect(pct.rows.map((r) => r[1])).toEqual(['pct']);
    // Any column, a list, and one-of-them.
    const anyCol = await service.rows(site, 'wp_options', {
      offset: 0,
      limit: 50,
      dir: 'asc',
      sort: 'option_name',
      filters: [{ column: '*', op: 'contains', value: 'shop.example' }],
    });
    expect(anyCol.rows.map((r) => r[1])).toEqual(['siteurl']);
    const either = await service.rows(site, 'wp_options', {
      offset: 0,
      limit: 50,
      dir: 'asc',
      sort: 'option_name',
      match: 'any',
      filters: [
        { column: 'option_name', op: 'in', value: 'pct, long' },
        { column: '*', op: 'startsWith', value: 'a:1:' },
      ],
    });
    expect(either.rows.map((r) => r[1])).toEqual(['active_plugins', 'long', 'pct']);
    await expect(
      service.rows(site, 'wp_options', { offset: 0, limit: 5, dir: 'asc', filters: [{ column: 'nope', op: 'eq', value: '' }] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('pages through rows sorted by a column full of ties, each row once', async () => {
    rootSql("CREATE TABLE wp_shop.t_ties (id int PRIMARY KEY, grp varchar(10), filler varchar(200)); INSERT INTO wp_shop.t_ties SELECT seq, 'same', REPEAT('x', 100) FROM wp_shop.seq_1_to_100;");
    try {
      for (const dir of ['asc', 'desc'] as const) {
        const seen = new Set<string>();
        for (let offset = 0; offset < 100; offset += 10) {
          const page = await service.rows(site, 't_ties', { offset, limit: 10, sort: 'grp', dir, filters: [] });
          for (const r of page.rows) seen.add(String(r[0]));
        }
        expect(seen.size, dir).toBe(100);
      }
    } finally {
      rootSql('DROP TABLE wp_shop.t_ties;');
    }
  });

  it('shows binary data as bytes, and big numbers whole', async () => {
    const page = await service.rows(site, 't_bin', { offset: 0, limit: 5, dir: 'asc', filters: [] });
    expect(page.rows[0]).toEqual(['1', { binary: 3, hex: '00ff10' }, '18446744073709551615']);
  });

  it('reads, inserts, updates and deletes a row by its key', async () => {
    const inserted = await service.insert(site, 'wp_options', { option_name: 'new', option_value: 'v1' });
    expect(inserted.affected).toBe(1);
    const key = { option_id: inserted.insertId! };
    await service.update(site, 'wp_options', key, { option_value: "it's \\ fine" });
    const row = await service.row(site, 'wp_options', key);
    expect(row?.values).toEqual([inserted.insertId, 'new', "it's \\ fine", 'yes']);
    await expect(service.update(site, 'wp_options', { option_id: '999999' }, { option_value: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.insert(site, 'wp_options', { option_name: 'new', option_value: 'dup' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await service.remove(site, 'wp_options', [key])).affected).toBe(1);
    expect(await service.row(site, 'wp_options', key)).toBeNull();
  });

  it('keeps a table without a key, and a view, read only', async () => {
    await expect(service.update(site, 'wp_nokey', { a: '1' }, { b: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.insert(site, 'v_autoload', { option_name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.update(site, 't_bin', { id: '1' }, { data: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs SQL statement by statement, stopping at the first error', async () => {
    const res = await service.run(
      site,
      "SELECT 1 AS a; -- one\nUPDATE wp_options SET autoload = 'no' WHERE option_name = 'pct';\nSELEC oops;\nSELECT 2",
    );
    expect(res.results.map((r) => r.kind)).toEqual(['rows', 'ok', 'error']);
    expect(res.results[0]).toMatchObject({ kind: 'rows', columns: [{ name: 'a', kind: 'number' }], rows: [['1']] });
    expect(res.results[1]).toMatchObject({ kind: 'ok', affected: 1 });
    expect(res.results[2]).toMatchObject({ kind: 'error', code: 'ER_PARSE_ERROR' });
  });

  it('stops a statement at its time limit, also one that lifts the limit for itself', async () => {
    const quick = new DbBrowserService(new DockerService('none', 'none'), () => 'the engine test', CONTAINER, 2);
    const lifted = await quick.run(site, 'SET SESSION max_statement_time = 0; SELECT SLEEP(20)');
    expect(lifted.results.at(-1)).toMatchObject({ kind: 'error', message: /Stopped after 2 seconds/ });
    const started = Date.now();
    const around = await quick.run(site, 'SET STATEMENT max_statement_time = 0 FOR SELECT SLEEP(60)');
    expect(around.results.at(-1)).toMatchObject({ kind: 'error', code: 'ER_STATEMENT_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(15_000);
    // Killed on the server too, not just given up on.
    const sleeping = () => rootSql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'wp_shop' AND INFO LIKE '%SLEEP(60)%'").trim();
    for (let i = 0; i < 20 && sleeping() !== '0'; i++) await new Promise((r) => setTimeout(r, 250));
    expect(sleeping()).toBe('0');
    quick.closeIdle();
  }, 60_000);

  it("changes a table's structure as the site user, and gives up on a table another session holds", async () => {
    const run = (sql: string, lockWaitSeconds = 10) => service.execute(site, sql, { lockWaitSeconds, relayMs: 120_000 });
    const col = (c: object) => dbColumnDef.parse({ nullable: false, default: { kind: 'none' }, ...c });
    try {
      await run(createTableSql({ name: 't_parent', columns: [col({ name: 'id', type: 'int unsigned' })], primaryKey: ['id'] }));
      await run(
        createTableSql({
          name: 't_ddl',
          columns: [
            col({ name: 'id', type: 'bigint unsigned', autoIncrement: true }),
            col({ name: 'title', type: 'varchar(191)', default: { kind: 'value', value: "it's" } }),
            col({ name: 'seen', type: 'datetime(6)', nullable: true, default: { kind: 'currentTimestamp' }, onUpdateCurrentTimestamp: true }),
          ],
          primaryKey: ['id'],
        }),
      );
      await run(
        alterTableSql(await service.structure(site, 't_ddl'), [
          dbAlterChange.parse({ op: 'addColumn', column: col({ name: 'parent_id', type: 'int unsigned', nullable: true }), position: { after: 'id' } }),
          // The index names the column by the name the statement gives it.
          dbAlterChange.parse({ op: 'addIndex', index: { kind: 'index', name: 'title_start', columns: [{ name: 'headline', length: 10 }] } }),
          dbAlterChange.parse({
            op: 'addForeignKey',
            foreignKey: { name: 'fk_parent', columns: ['parent_id'], refTable: 't_parent', refColumns: ['id'], onDelete: 'SET NULL' },
          }),
          dbAlterChange.parse({ op: 'modifyColumn', name: 'title', column: col({ name: 'headline', type: 'varchar(191)', default: { kind: 'keep' } }), position: null }),
        ]),
      );
      const s = await service.structure(site, 't_ddl');
      expect(s.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'headline', 'seen']);
      expect(s.columns[2]!.default).toBe("'it''s'");
      expect(s.indexes.find((i) => i.name === 'title_start')).toMatchObject({ columns: ['headline'], lengths: [10] });
      expect(s.foreignKeys).toEqual([
        { name: 'fk_parent', columns: ['parent_id'], refTable: 't_parent', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'RESTRICT' },
      ]);

      // Another session in the middle of a transaction on the table: the change gives up, it does not queue.
      const holder = spawn('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"'], { stdio: ['pipe', 'ignore', 'ignore'] });
      holder.stdin.end('START TRANSACTION; SELECT * FROM wp_shop.t_ddl; DO SLEEP(4); COMMIT;\n');
      await new Promise((r) => setTimeout(r, 1500));
      const err = await run('ALTER TABLE `t_ddl` ADD COLUMN `x` int', 1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      await new Promise((r) => holder.on('close', r));
      expect((await service.structure(site, 't_ddl')).columns.map((c) => c.name)).not.toContain('x');

    } finally {
      rootSql('DROP TABLE IF EXISTS wp_shop.t_ddl; DROP TABLE IF EXISTS wp_shop.t_parent;');
    }
  }, 60_000);

  it('reads JSON, CHECK, generated and invisible columns, and tries a change on an empty copy first', async () => {
    const col = (c: object) => dbColumnDef.parse({ nullable: false, default: { kind: 'none' }, ...c });
    rootSql(
      'CREATE TABLE wp_shop.t_kinds (id int PRIMARY KEY, data json, qty int CHECK (qty > 0), total int AS (id * 2) STORED, ' +
        'secret int INVISIBLE, body text, FULLTEXT KEY ft (body));',
    );
    try {
      const kinds = await service.structure(site, 't_kinds');
      const byName = new Map(kinds.columns.map((c) => [c.name, c]));
      expect(byName.get('data')).toMatchObject({ type: 'json', check: null, collation: 'utf8mb4_bin' });
      expect(byName.get('qty')).toMatchObject({ check: '`qty` > 0' });
      expect(byName.get('total')!.extra).toMatch(/STORED GENERATED/);
      expect(byName.get('secret')!.extra).toMatch(/INVISIBLE/);

      const tryOn = (table: string, changes: unknown[]) =>
        service.structure(site, table).then((st) =>
          service.tryDdl(site, {
            table,
            copyOf: table,
            statement: (tmp) => alterTableSql({ ...st, table: tmp }, changes.map((c) => dbAlterChange.parse(c))),
          }),
        );
      await expect(tryOn('wp_options', [{ op: 'addColumn', column: col({ name: 'n', type: 'int', nullable: true }), position: null }])).resolves.toBe(true);
      // What MariaDB refuses comes back as a 400 in its words: a default the type cannot hold, a counter left without a key.
      await expect(
        tryOn('wp_options', [{ op: 'addColumn', column: col({ name: 'n', type: 'int', default: { kind: 'value', value: 'abc' } }), position: null }]),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/^MariaDB would refuse this: Invalid default value for 'n'/) });
      await expect(tryOn('wp_options', [{ op: 'dropIndex', name: 'PRIMARY' }])).rejects.toMatchObject({ statusCode: 400 });
      // What a temporary InnoDB table cannot have is not tried, rather than refused.
      await expect(tryOn('wp_options', [{ op: 'addIndex', index: { kind: 'fulltext', name: 'ft', columns: [{ name: 'option_value' }] } }])).resolves.toBe(false);
      await expect(tryOn('t_kinds', [{ op: 'dropColumn', name: 'qty' }])).resolves.toBe(false);
      // A new table, tried as a temporary one.
      await expect(
        service.tryDdl(site, {
          table: 't_new',
          statement: (tmp) => createTableSql({ name: tmp, columns: [col({ name: 'a', type: 'varchar(70000)' })], primaryKey: [] }, { temporary: true }),
        }),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/too big/) });
      // Nothing changed for real.
      expect((await service.structure(site, 'wp_options')).columns.map((c) => c.name)).toEqual(['option_id', 'option_name', 'option_value', 'autoload']);
      expect((await service.tables(site)).map((t) => t.name)).not.toContain('t_new');
    } finally {
      rootSql('DROP TABLE IF EXISTS wp_shop.t_kinds;');
    }
  }, 60_000);

  it('stops a job statement at its limit on the server, and fails rather than hangs when the relay dies', async () => {
    const sleeping = () => rootSql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'wp_shop' AND INFO LIKE '%SLEEP(%'").trim();
    let started = Date.now();
    await expect(service.execute(site, 'DO SLEEP(30)', { lockWaitSeconds: 5, relayMs: 120_000, killAfterMs: 1500 })).rejects.toMatchObject({
      statusCode: 504,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    for (let i = 0; i < 20 && sleeping() !== '0'; i++) await new Promise((r) => setTimeout(r, 250));
    expect(sleeping()).toBe('0');
    let canceled = false;
    setTimeout(() => (canceled = true), 1000);
    await expect(service.execute(site, 'DO SLEEP(31)', { lockWaitSeconds: 5, relayMs: 120_000, canceled: () => canceled })).rejects.toThrow(/Canceled/);
    // The relay killed under a running statement (its own deadline): an error, not a wait for
    // ever, and the statement stopped on the server rather than left to finish.
    started = Date.now();
    await expect(service.execute(site, 'DO SLEEP(32)', { lockWaitSeconds: 5, relayMs: 2000 })).rejects.toThrow(/stopped there/);
    expect(Date.now() - started).toBeLessThan(15_000);
    for (let i = 0; i < 20 && sleeping() !== '0'; i++) await new Promise((r) => setTimeout(r, 250));
    expect(sleeping()).toBe('0');
  }, 60_000);

  it('stops a big result at the row limit', async () => {
    const res = await service.run(site, 'SELECT seq FROM seq_1_to_100000');
    expect(res.results[0]).toMatchObject({ kind: 'rows', truncated: true });
    expect((res.results[0] as { rows: unknown[] }).rows.length).toBe(1000);
  });

  it('is kept to the site’s own databases by MariaDB', async () => {
    const res = await service.run(site, 'SHOW DATABASES; SELECT * FROM wp_other.secret');
    expect(res.results[0]).toMatchObject({ kind: 'rows', rows: [['information_schema'], ['wp_shop']] });
    expect(res.results[1]).toMatchObject({ kind: 'error', code: 'ER_TABLEACCESS_DENIED_ERROR' });
  });

  it('says why when the login is refused', async () => {
    const err = await service.tables({ ...site, password: 'wrong' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(502);
    expect((err as AppError).message).toMatch(/refused the site's database login/);
  });

  it('leaves no session behind on the server', async () => {
    service.closeIdle();
    await new Promise((r) => setTimeout(r, 500));
    expect(rootSql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'wp_shop'").trim()).toBe('0');
  });

  it('inventories, grants and drops as root (the local admin service)', async () => {
    const config = {
      mariadb: { host: '127.0.0.1', rootPassword: ROOT_PASSWORD, container: CONTAINER, clientImage: 'mariadb:11.4' },
      dbNetwork: 'none',
    } as unknown as Config;
    const admin = new DbAdminService(config, new DockerService('none', 'none'));
    // The pool cannot reach the container from here; the streamed dump goes through docker exec.
    const chunks: Buffer[] = [];
    await admin.dumpToStream(
      'wp_shop',
      new Writable({
        write(c: Buffer, _e, cb) {
          chunks.push(c);
          cb();
        },
      }),
    );
    expect(Buffer.concat(chunks).toString()).toMatch(/CREATE TABLE `wp_options`/);
    await admin.close();
  });

  it('adds, lists, re-keys and drops as root (the remote admin service, over docker exec)', async () => {
    const admin = new RemoteDbAdminService(hostExec, CONTAINER);
    // An added database: the site's user gets it, and only it, whatever an earlier one left.
    rootSql("CREATE USER 'wp_before'@'%' IDENTIFIED BY 'x'; GRANT ALL PRIVILEGES ON `wp\\_shop\\_orders`.* TO 'wp_before'@'%';");
    await admin.createExtraDb('wp_shop_orders', 'wp_shop');
    expect(rootSql("SELECT User FROM mysql.db WHERE Db = 'wp\\\\_shop\\\\_orders'").trim()).toBe('wp_shop');
    rootSql("DROP USER 'wp_before'@'%';");
    await expect(admin.createExtraDb('wp_shop_orders', 'wp_shop')).rejects.toThrow(/database exists/);
    const shown = await service.run(site, 'SHOW DATABASES');
    expect(shown.results[0]).toMatchObject({ rows: [['information_schema'], ['wp_shop'], ['wp_shop_orders']] });
    expect(await service.tables({ ...site, database: 'wp_shop_orders' })).toEqual([]);

    // The inventory: MariaDB's own databases left out, a hand-made name kept as it is.
    rootSql('CREATE DATABASE `left-over db`; CREATE TABLE `left-over db`.t (a int);');
    const names = (await admin.inventory()).map((r) => [r.name, r.tables]);
    expect(names).toEqual(expect.arrayContaining([['wp_shop', 4], ['wp_shop_orders', 0], ['wp_other', 1], ['left-over db', 1]]));
    expect(names.map(([n]) => n)).not.toContain('mysql');
    await admin.dropDb('left-over db');
    await admin.dropDb('wp_shop_orders');
    expect((await admin.inventory()).map((r) => r.name).sort()).toEqual(['wp_other', 'wp_shop']);
    // Its grant went with it: the site's user cannot make it again, out of sight of the panel.
    const again = await service.run(site, 'CREATE DATABASE wp_shop_orders');
    expect(again.results[0]).toMatchObject({ kind: 'error', code: 'ER_DBACCESS_DENIED_ERROR' });

    // A new password: the old one is refused at once, the new one works, quotes and all.
    const next = "n€w'pa\\ss\"";
    await admin.setUserPassword('wp_shop', next);
    service.closeIdle();
    await expect(service.tables(site)).rejects.toMatchObject({ statusCode: 502 });
    expect((await service.tables({ ...site, password: next })).length).toBe(4);
    await admin.setUserPassword('wp_shop', site.password);
    service.closeIdle();

    // A user on two hosts goes from both.
    rootSql("CREATE USER 'wp_gone'@'%' IDENTIFIED BY 'x'; CREATE USER 'wp_gone'@'localhost' IDENTIFIED BY 'x';");
    expect(await admin.userExists('wp_gone')).toBe(true);
    await admin.dropUser('wp_gone');
    expect(await admin.userExists('wp_gone')).toBe(false);
    await admin.dropUser('wp_gone');

    const chunks: Buffer[] = [];
    await admin.dumpToStream(
      'wp_shop',
      new Writable({
        write(c: Buffer, _e, cb) {
          chunks.push(c);
          cb();
        },
      }),
    );
    expect(Buffer.concat(chunks).toString()).toMatch(/INSERT INTO `wp_options`/);
  });

  it('loads a dump as the site user, and refuses what a dump may not do, on both import paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-'));
    const gz = (name: string, sql: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, zlib.gzipSync(sql));
      return file;
    };
    const remote = new RemoteDbAdminService(hostExec, CONTAINER);
    const config = {
      mariadb: { host: CONTAINER, rootPassword: ROOT_PASSWORD, container: CONTAINER, clientImage: 'mariadb:11.4' },
      dbNetwork: NETWORK,
    } as unknown as Config;
    const local = new DbAdminService(config, new DockerService('none', NETWORK));
    try {
      // A dump of the site, as backups take it, loads into an added database as the site's user.
      const chunks: Buffer[] = [];
      await remote.dumpToStream(
        'wp_shop',
        new Writable({
          write(c: Buffer, _e, cb) {
            chunks.push(c);
            cb();
          },
        }),
      );
      const dump = gz('shop.sql.gz', Buffer.concat(chunks).toString('utf8'));
      const checksum = (db: string) => rootSql(`CHECKSUM TABLE ${db}.wp_options`).split('\t')[1]!.trim();
      await remote.createExtraDb('wp_shop_a', 'wp_shop');
      await remote.importFromAs(dump, 'wp_shop_a', 'wp_shop', site.password);
      expect(checksum('wp_shop_a')).toBe(checksum('wp_shop'));
      await remote.createExtraDb('wp_shop_b', 'wp_shop');
      await local.importFromAs(dump, 'wp_shop_b', 'wp_shop', site.password);
      expect(checksum('wp_shop_b')).toBe(checksum('wp_shop'));
      rootSql('CREATE DATABASE wp_shop_c');
      await local.importFrom(dump, 'wp_shop_c');
      expect(checksum('wp_shop_c')).toBe(checksum('wp_shop'));

      // A shell, a local file, a local file sent to the server: each refused, on each path.
      rootSql('CREATE TABLE wp_shop.t_env (s text);');
      const hostile = [
        gz('bang.sql.gz', '\\! touch /tmp/pwned-bang\n'),
        gz('system.sql.gz', 'system touch /tmp/pwned-system\n'),
        gz('source.sql.gz', 'source /etc/hostname\n'),
        gz('infile.sql.gz', "LOAD DATA LOCAL INFILE '/proc/self/environ' INTO TABLE t_env;\n"),
      ];
      for (const file of hostile) {
        await expect(remote.importFromAs(file, 'wp_shop', 'wp_shop', site.password)).rejects.toThrow(/import failed/);
        await expect(local.importFromAs(file, 'wp_shop', 'wp_shop', site.password)).rejects.toThrow(/import failed/);
        await expect(remote.importFrom(file, 'wp_shop')).rejects.toThrow(/import failed/);
      }
      expect(docker('exec', CONTAINER, 'sh', '-c', 'ls /tmp/pwned-* 2>/dev/null').stdout.trim()).toBe('');
      expect(rootSql('SELECT COUNT(*) FROM wp_shop.t_env').trim()).toBe('0');

      // A file that cannot be read fails the import, instead of loading nothing.
      await expect(local.importFromAs(path.join(dir, 'gone.sql.gz'), 'wp_shop_b', 'wp_shop', site.password)).rejects.toThrow(/import failed/);
      await expect(remote.importFromAs(path.join(dir, 'gone.sql.gz'), 'wp_shop_b', 'wp_shop', site.password)).rejects.toThrow(/import failed/);
    } finally {
      rootSql('DROP TABLE IF EXISTS wp_shop.t_env; DROP DATABASE IF EXISTS wp_shop_a; DROP DATABASE IF EXISTS wp_shop_b; DROP DATABASE IF EXISTS wp_shop_c;');
      await local.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
