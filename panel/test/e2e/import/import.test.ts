/**
 * An import end to end: real WordPress on a real MariaDB or MySQL, the migration plugin from this
 * repository installed from the zip the panel hands out, the panel's own connect route and import
 * jobs. What arrives is compared with what was there: every file byte for byte, every row column
 * by column. The new site's container and its database import are the suite's fakes; the dump the
 * import hands over is imported into a scratch MariaDB of the panel's version instead.
 *
 * Opt-in: needs Docker, and the network for the images and WP-CLI. Run it when the plugin, the
 * protocol (docs/internal/import-protocol.md) or the pull changes:
 *
 *   WPL7_IMPORT_E2E=1 npx vitest run test/e2e/import
 *
 * WPL7_IMPORT_E2E_CASES=mariadb10.6-wp-latest,mysql8.0-wp5.1 runs some of the cases.
 *
 * The old site is reached the way the panel reaches any: its address resolves to a public one
 * (a documentation address here) and the guard lets it through; only the last step, the socket,
 * goes to the container's published port instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { hostExec } from '../../../src/lib/exec.js';
import type { PullResponse, PullTransport } from '../../../src/services/importPull.js';
import { sitePaths } from '../../../src/services/siteSpec.js';
import type { ImportRunBody } from '../../../shared/schemas.js';
import { makeApp, makeWorld, type TestWorld } from '../../helpers.js';
import { logOf, settle } from '../../importWorld.js';

const ENABLED = process.env.WPL7_IMPORT_E2E === '1';
const ONLY = (process.env.WPL7_IMPORT_E2E_CASES ?? '').split(',').filter(Boolean);
const RUN = `wpl7-e2e-${process.pid}`;
const HOST = 'willow-pediatrics.example';
const ADMIN_PASSWORD = 'e2e-Admin-Password-1';
const MIB = 1024 * 1024;
const WP_CLI = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

interface Case {
  name: string;
  db: string;
  client: 'mariadb' | 'mysql';
  dbArgs: string[];
  wp: string;
  permalinks: string;
}

const CASES: Case[] = [
  { name: 'mariadb10.6-wp-latest', db: 'mariadb:10.6', client: 'mariadb', dbArgs: [], wp: 'wordpress:latest', permalinks: '/%postname%/' },
  { name: 'mysql8.0-wp-latest', db: 'mysql:8.0', client: 'mysql', dbArgs: [], wp: 'wordpress:latest', permalinks: '' },
  { name: 'mariadb10.6-wp5.1', db: 'mariadb:10.6', client: 'mariadb', dbArgs: [], wp: 'wordpress:5.1-php7.1-apache', permalinks: '' },
  {
    name: 'mysql8.0-wp5.1',
    db: 'mysql:8.0',
    client: 'mysql',
    // PHP 7.1's mysqli predates MySQL 8's default authentication.
    dbArgs: ['--default-authentication-plugin=mysql_native_password'],
    wp: 'wordpress:5.1-php7.1-apache',
    permalinks: '/%postname%/',
  },
];

// ---------------------------------------------------------------------------- docker

/**
 * A docker command, without blocking: the panel answers the plugin's calls from this same process,
 * and a command waiting on one of those calls would otherwise wait on itself.
 */
function docker(args: string[], opts: { input?: Buffer | string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = { status: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (res.status !== 0 && !opts.allowFail) {
        reject(new Error(`docker ${args.slice(0, 4).join(' ')} … failed (${res.status}): ${(res.stderr || res.stdout).slice(0, 2000)}`));
      } else resolve(res);
    });
    child.stdin.end(opts.input);
  });
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------- http to the old site

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, method: string, pathAndQuery: string, opts: { headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathAndQuery,
        headers: { host: HOST, ...(body ? { 'content-length': String(body.length) } : {}), ...opts.headers },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** The panel's requests, carried to the container's published port: everything before the socket is the panel's own. */
function containerTransport(port: number): PullTransport {
  return async (req) => {
    const res = await request(port, 'POST', `${req.url.pathname}${req.url.search}`, {
      headers: { ...req.headers, host: req.url.host },
      body: req.body,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    return { status: res.status, headers, body: res.body } satisfies PullResponse;
  };
}

/** The cookies a response sets, as a Cookie header adds them to the ones before. */
function withCookies(jar: Map<string, string>, res: Answer): string {
  for (const c of [res.headers['set-cookie'] ?? []].flat()) {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------------------------------------------------------------------------- comparing

interface TreeEntry {
  type: 'file' | 'dir' | 'link';
  sha256?: string;
}

/** Every entry under `root`, by its path's bytes (latin1, so a name that is not UTF-8 survives as a key). */
function tree(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (dir: Buffer, rel: Buffer | null) => {
    for (const name of fs.readdirSync(dir, { encoding: 'buffer' })) {
      const abs = Buffer.concat([dir, Buffer.from('/'), name]);
      const key = rel ? Buffer.concat([rel, Buffer.from('/'), name]) : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.set(key.toString('latin1'), { type: 'link' });
      else if (st.isDirectory()) {
        out.set(key.toString('latin1'), { type: 'dir' });
        walk(abs, key);
      } else if (st.isFile()) {
        out.set(key.toString('latin1'), { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
      }
    }
  };
  walk(Buffer.from(root), null);
  return out;
}

/** What the plugin leaves out of every listing (its DEFAULT_EXCLUDES), in the cases this site has. */
function leftOutByPlugin(rel: string): boolean {
  const base = rel.split('/').at(-1)!;
  return (
    rel === 'wp-config.php' ||
    rel === 'wp-content/plugins/wpl7-migrate' ||
    rel.startsWith('wp-content/plugins/wpl7-migrate/') ||
    /^wp-content\/(cache|upgrade|updraft)(\/|$)/.test(rel) ||
    base.endsWith('.log') ||
    base === 'error_log'
  );
}

// ---------------------------------------------------------------------------- the cases

const cases = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.name));

describe.skipIf(!ENABLED).each(cases)('importing from $wp on $db', (c) => {
  const label = `wpl7-import-e2e=${RUN}-${c.name}`;
  const names = {
    net: `${RUN}-${c.name}`,
    db: `${RUN}-${c.name}-db`,
    wp: `${RUN}-${c.name}-wp`,
    scratch: `${RUN}-${c.name}-scratch`,
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-import-e2e-'));
  let port = 0;
  let w: TestWorld;
  let close: () => Promise<void> = async () => undefined;
  let importId = 0;
  const dumps: string[] = [];

  const sql = async (query: string, db = 'wp') =>
    (await docker(['exec', '-i', '-e', 'MYSQL_PWD=rootpw', names.db, c.client, '-uroot', '--default-character-set=utf8mb4', '-N', '-B', db], { input: query })).stdout;
  const scratchSql = async (query: string) =>
    (await docker(['exec', '-i', '-e', 'MYSQL_PWD=rootpw', names.scratch, 'mariadb', '-uroot', '--default-character-set=utf8mb4', '-N', '-B', 'scratch'], { input: query })).stdout;
  const wp = (args: string[], opts: { allowFail?: boolean } = {}) =>
    docker(['exec', '-u', 'www-data', '-w', '/var/www/html', names.wp, 'php', '/usr/local/bin/wp', ...args], opts);
  const sh = (script: string) => docker(['exec', '-u', 'www-data', '-w', '/var/www/html', names.wp, 'sh', '-c', script]);

  beforeAll(async () => {
    // -------------------------------------------------------------- the old site
    await docker(['network', 'create', '--label', label, names.net]);
    const env =
      c.client === 'mariadb'
        ? ['-e', 'MARIADB_ROOT_PASSWORD=rootpw', '-e', 'MARIADB_DATABASE=wp', '-e', 'MARIADB_USER=wp', '-e', 'MARIADB_PASSWORD=wppw']
        : ['-e', 'MYSQL_ROOT_PASSWORD=rootpw', '-e', 'MYSQL_DATABASE=wp', '-e', 'MYSQL_USER=wp', '-e', 'MYSQL_PASSWORD=wppw'];
    await docker(['run', '-d', '--name', names.db, '--label', label, '--network', names.net, ...env, c.db, ...c.dbArgs]);
    // The panel's own MariaDB, which an imported site's dump has to load into.
    await docker(['run', '-d', '--name', names.scratch, '--label', label, '--network', names.net, '-e', 'MARIADB_ROOT_PASSWORD=rootpw', '-e', 'MARIADB_DATABASE=scratch', loadConfig().mariadb.clientImage]);
    await until('the old site\'s database', async () => (await docker(['exec', '-e', 'MYSQL_PWD=wppw', names.db, c.client, '-uwp', '-e', 'SELECT 1', 'wp'], { allowFail: true })).status === 0);
    await docker([
      'run', '-d', '--name', names.wp, '--label', label, '--network', names.net,
      '-p', '127.0.0.1::80', '--add-host', 'host.docker.internal:host-gateway',
      '-e', `WORDPRESS_DB_HOST=${names.db}`, '-e', 'WORDPRESS_DB_USER=wp', '-e', 'WORDPRESS_DB_PASSWORD=wppw', '-e', 'WORDPRESS_DB_NAME=wp',
      '-e', 'WORDPRESS_TABLE_PREFIX=wpx_',
      c.wp,
    ]);
    port = Number((await docker(['port', names.wp, '80/tcp'])).stdout.trim().split('\n')[0]!.split(':').at(-1));
    await until('WordPress', async () => (await request(port, 'GET', '/wp-admin/install.php').catch(() => ({ status: 0 }))).status === 200);

    const cli = path.join(os.tmpdir(), 'wpl7-import-e2e-wp-cli.phar');
    if (!fs.existsSync(cli)) fs.writeFileSync(cli, Buffer.from(await (await fetch(WP_CLI)).arrayBuffer()));
    await docker(['cp', cli, `${names.wp}:/usr/local/bin/wp`]);
    await docker(['exec', names.wp, 'chmod', '755', '/usr/local/bin/wp']);
    await wp(['core', 'install', `--url=http://${HOST}`, '--title=Willow Pediatrics', '--admin_user=admin', `--admin_password=${ADMIN_PASSWORD}`, '--admin_email=admin@example.com', '--skip-email']);
    if (c.permalinks) await wp(['rewrite', 'structure', c.permalinks]);

    // What makes a site hard to copy: many rows, a big file, links, odd names and odd columns.
    await wp(['post', 'generate', '--count=500']);
    await wp(['option', 'update', 'blogdescription', "Quotes ' \" a backslash \\ and an emoji 😀"]);
    await sh(
      [
        'cd wp-content/uploads',
        `head -c ${5 * MIB} /dev/urandom > big.bin`,
        'mkdir -p 2024/01 && printf hello > 2024/01/hello.txt && : > empty.txt',
        'ln -s ../../index.php inside-link && ln -s /etc/passwd outside-link',
        // A name that is not UTF-8. The host side stores it under macOS too, which refuses one.
        ...(process.platform === 'darwin' ? [] : ["printf latin1 > \"$(printf 'caf\\351').txt\""]),
      ].join(' && '),
    );
    await sql(
      [
        'CREATE TABLE wpx_e2e_nopk (a INT, b TEXT) DEFAULT CHARSET=utf8mb4;',
        "INSERT INTO wpx_e2e_nopk VALUES (1, 'one'), (1, 'one'), (2, NULL);",
        'CREATE TABLE wpx_e2e_types (id INT NOT NULL PRIMARY KEY, bin VARBINARY(32), ts TIMESTAMP NULL DEFAULT NULL, d DATE, dt DATETIME, txt LONGTEXT) DEFAULT CHARSET=utf8mb4;',
        "SET SESSION sql_mode = '';",
        "INSERT INTO wpx_e2e_types VALUES (1, X'00010200ff00', '2024-02-29 12:34:56', '0000-00-00', '0000-00-00 00:00:00', 'tab\\there, a quote '' a backslash \\\\ and 😀'), (2, NULL, NULL, NULL, NULL, NULL);",
        'CREATE TABLE other_stats (id INT NOT NULL PRIMARY KEY);',
        'INSERT INTO other_stats VALUES (1);',
      ].join('\n'),
    );

    // -------------------------------------------------------------- the panel
    w = await makeWorld({ exec: hostExec });
    const pluginDir = process.env.WPL7_MIGRATE_PLUGIN_DIR ?? path.resolve('migrate-plugin');
    (w.config as { migratePluginDir: string }).migratePluginDir = pluginDir;
    const { app } = await makeApp(w);
    await app.listen({ host: process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0', port: 0 });
    close = () => app.close();
    const panelPort = (app.server.address() as AddressInfo).port;
    w.core.imports.origin = () => `http://host.docker.internal:${panelPort}`;
    w.core.imports.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    w.core.imports.transport = containerTransport(port);
    // The image's entrypoint: wp-config.php, from the container's settings, at its first start.
    w.docker.onStart = (name) => {
      if (!name.startsWith('wp-')) return;
      const config = path.join(sitePaths(w.config, name.slice(3)).wordpress, 'wp-config.php');
      if (fs.existsSync(path.dirname(config)) && !fs.existsSync(config)) fs.writeFileSync(config, '<?php // written by the image');
    };
    const importFromAs = w.dbAdmin.importFromAs.bind(w.dbAdmin);
    w.dbAdmin.importFromAs = async (src, db, user, password) => {
      const copy = path.join(work, `dump-${dumps.length}.sql.gz`);
      fs.copyFileSync(src, copy);
      dumps.push(copy);
      return importFromAs(src, db, user, password);
    };
    importId = w.core.imports.create({ allowHttp: true }, 'admin').id;
  }, 20 * 60_000);

  afterAll(async () => {
    await close();
    for (const kind of ['container', 'network'] as const) {
      const ids = (await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=${label}`], { allowFail: true })).stdout.split('\n').filter(Boolean);
      // -v: the images declare volumes, which would otherwise stay behind, one per container.
      if (ids.length > 0) await docker([kind === 'container' ? 'rm' : 'network', ...(kind === 'container' ? ['-f', '-v'] : ['rm']), ...ids], { allowFail: true });
    }
    fs.rmSync(work, { recursive: true, force: true });
  }, 5 * 60_000);

  it('connects from the plugin installed off the panel\'s zip', async () => {
    const zip = path.join(work, 'wpl7-migrate.zip');
    fs.writeFileSync(zip, w.core.imports.pluginZip(importId).data);
    await docker(['cp', zip, `${names.wp}:/tmp/wpl7-migrate.zip`]);
    await docker(['exec', names.wp, 'chmod', '644', '/tmp/wpl7-migrate.zip']);
    await wp(['plugin', 'install', '/tmp/wpl7-migrate.zip', '--activate']);
    expect((await sh('test -e wp-content/plugins/wpl7-migrate/connection.php || echo gone')).stdout.trim()).toBe('gone');
    const connect = (await wp(['eval', 'echo wp_json_encode(WPL7_Migrate_Client::connect());'])).stdout;
    expect(JSON.parse(connect.trim().split('\n').at(-1)!), connect).toEqual({ ok: true, message: '' });

    const row = w.core.imports.get(importId);
    expect(row.status).toBe('connected');
    const dto = w.core.imports.toDto(row);
    expect(dto.report).toMatchObject({ home: `http://${HOST}`, tablePrefix: 'wpx_' });
    expect(dto.blockedReason).toBeNull();
  }, 20 * 60_000);

  it('copies every file byte for byte, and leaves out what it should', async () => {
    const choices: ImportRunBody = {
      title: 'Willow Pediatrics',
      slug: 'willow',
      carryConstants: [],
      deactivatePlugins: [],
      removeDropins: [],
      removeMuPlugins: [],
      rewritePaths: true,
    };
    const { job } = w.core.imports.start(importId, choices);
    const row = await settle(w, importId, 15 * 60_000);
    expect(row.status, [row.lastError, ...logOf(w, job.id)].join('\n')).toBe('done');

    const source = path.join(work, 'source');
    fs.mkdirSync(source);
    await docker(['cp', `${names.wp}:/var/www/html/.`, source]);
    const before = tree(source);
    const after = tree(sitePaths(w.config, 'willow').wordpress);
    const missing: string[] = [];
    const differ: string[] = [];
    for (const [rel, e] of before) {
      if (leftOutByPlugin(rel)) {
        if (rel !== 'wp-config.php') expect(after.has(rel), rel).toBe(false);
        continue;
      }
      if (e.type === 'link') {
        expect(after.has(rel), `the link ${rel} was not copied`).toBe(false);
        continue;
      }
      const got = after.get(rel);
      if (!got || got.type !== e.type) missing.push(rel);
      else if (e.type === 'file' && got.sha256 !== e.sha256) differ.push(rel);
    }
    expect(missing).toEqual([]);
    expect(differ).toEqual([]);
    const extra = [...after.keys()].filter((rel) => !before.has(rel));
    // The new site's own: wp-config.php from its image, the panel's must-use plugins.
    expect(extra.filter((rel) => rel !== 'wp-config.php' && !rel.startsWith('wp-content/mu-plugins'))).toEqual([]);
    expect(before.get('wp-content/uploads/big.bin')).toMatchObject({ type: 'file' });
  }, 20 * 60_000);

  it('copies every row of every table with the prefix, column by column', async () => {
    expect(dumps).toHaveLength(1);
    await docker(['exec', '-i', '-e', 'MYSQL_PWD=rootpw', names.scratch, 'mariadb', '-uroot', 'scratch'], { input: zlib.gunzipSync(fs.readFileSync(dumps[0]!)) });
    const tables = (await sql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'wp' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;"))
      .split('\n')
      .filter((t) => t.startsWith('wpx_') && !t.startsWith('wpx_wpl7_migrate_'));
    const copied = (await scratchSql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'scratch' ORDER BY TABLE_NAME;")).split('\n').filter(Boolean);
    expect(copied.sort()).toEqual([...tables].sort());
    expect(tables).toContain('wpx_e2e_types');
    expect(Number(await scratchSql("SELECT COUNT(*) FROM wpx_posts WHERE post_type = 'post';"))).toBeGreaterThanOrEqual(500);
    for (const table of tables) {
      const columns = (await sql(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'wp' AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION;`))
        .split('\n')
        .filter(Boolean);
      // The plugin's own settings, its token among them, never leave the old site.
      const where = table === 'wpx_options' ? " WHERE option_name NOT LIKE 'wpl7\\_migrate\\_%'" : '';
      const rows = `SET time_zone = '+00:00'; SELECT CONCAT_WS(',', ${columns.map((col) => `IFNULL(HEX(CAST(\`${col}\` AS BINARY)), 'N')`).join(', ')}) AS r FROM \`${table}\`${where} ORDER BY r;`;
      expect(await scratchSql(rows), table).toBe(await sql(rows));
    }
    expect((await scratchSql("SELECT COUNT(*) FROM wpx_options WHERE option_name LIKE 'wpl7\\_migrate\\_%';")).trim()).toBe('0');
    // The collation of a MySQL 8 table is one MariaDB has.
    expect((await scratchSql("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'scratch' AND TABLE_NAME = 'wpx_e2e_nopk';")).trim()).toMatch(
      /^utf8mb4_(unicode_520_ci|general_ci|unicode_ci)$/,
    );
  }, 20 * 60_000);

  it('shows visitors a maintenance page while an administrator still gets in', async () => {
    const client = w.core.imports.clientFor(w.core.imports.get(importId));
    try {
      await client.ping();
      await client.maintenance(true, 300);
      expect((await request(port, 'GET', '/')).status).toBe(503);
      const jar = new Map<string, string>([['wordpress_test_cookie', 'WP%20Cookie%20check']]);
      const login = await request(port, 'POST', '/wp-login.php', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: withCookies(jar, { status: 0, headers: {}, body: Buffer.alloc(0) }) },
        body: new URLSearchParams({ log: 'admin', pwd: ADMIN_PASSWORD, 'wp-submit': 'Log In', testcookie: '1' }).toString(),
      });
      expect(login.status, login.body.toString('utf8').slice(0, 500)).toBe(302);
      const admin = await request(port, 'GET', '/wp-admin/', { headers: { cookie: withCookies(jar, login) } });
      expect(admin.status).toBe(200);
      await client.maintenance(false);
      expect((await request(port, 'GET', '/')).status).toBe(200);
    } finally {
      client.close();
    }
  }, 20 * 60_000);

  it('lets go of the old site on Disconnect', async () => {
    await w.core.imports.disconnect(importId);
    expect((await wp(['plugin', 'is-active', 'wpl7-migrate'], { allowFail: true })).status).not.toBe(0);
    expect((await wp(['option', 'get', 'wpl7_migrate_token'], { allowFail: true })).status).not.toBe(0);
    expect((await request(port, 'GET', '/')).status).toBe(200);
  }, 20 * 60_000);
});
