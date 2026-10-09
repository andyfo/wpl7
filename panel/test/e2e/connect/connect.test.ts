/**
 * A site hosted elsewhere, end to end: real WordPress on a real MariaDB or MySQL, WPL7 Connect from
 * this repository installed off the zip the panel hands out, and the panel's own enroll route,
 * jobs and API. What the panel reads is compared with what WP-CLI says; what it changes is checked
 * on the site; its backup is restored by hand into a fresh WordPress, as the docs tell people to.
 *
 * Opt-in: needs Docker (the images and wordpress:cli for WP-CLI). Run it when the plugin, the
 * protocol (docs/internal/connect-protocol.md) or the panel's side of it changes:
 *
 *   WPL7_CONNECT_E2E=1 npx vitest run test/e2e/connect
 *
 * WPL7_CONNECT_E2E_CASES=mysql8.0-wp5.2 runs some of the cases.
 *
 * The site is reached the way the panel reaches any: its address resolves to a public one (a
 * documentation address here) and the guard lets it through; only the last step, the socket, goes
 * to the container's published port instead. Updates come from packages the test puts on the site
 * and offers through a must-use plugin of its own, so nothing needs WordPress.org.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backups, siteConnections, sites } from '../../../src/db/schema.js';
import { hostExec } from '../../../src/lib/exec.js';
import { zipOf } from '../../../src/lib/zipWriter.js';
import { ConnectClient } from '../../../src/services/connectClient.js';
import type { PullResponse, PullTransport } from '../../../src/services/pluginClient.js';
import { makeApp, makeWorld, type TestWorld } from '../../helpers.js';
import { runJob } from '../../connectWorld.js';

const ENABLED = process.env.WPL7_CONNECT_E2E === '1';
const ONLY = (process.env.WPL7_CONNECT_E2E_CASES ?? '').split(',').filter(Boolean);
const RUN = `wpl7-connect-e2e-${process.pid}`;
const HOST = 'shop.example';
const ADMIN_PASSWORD = 'e2e-Admin-Password-1';
const LOOKUP = async () => [{ address: '203.0.113.10', family: 4 }];

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
  {
    name: 'mysql8.0-wp5.2',
    db: 'mysql:8.0',
    client: 'mysql',
    // PHP 7.1's mysqli predates MySQL 8's default authentication.
    dbArgs: ['--default-authentication-plugin=mysql_native_password'],
    // The oldest WordPress WPL7 Connect supports, on a PHP without sodium.
    wp: 'wordpress:5.2-php7.1',
    permalinks: '',
  },
];

// ---------------------------------------------------------------------------- docker

/** A docker command, without blocking: the panel answers the plugin's enroll from this same process. */
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

/** WP-CLI, from the wordpress:cli image: the same phar runs on every PHP the cases have. */
async function wpCliPhar(): Promise<string> {
  const file = path.join(os.tmpdir(), 'wpl7-connect-e2e-wp-cli.phar');
  if (fs.existsSync(file)) return file;
  const name = `${RUN}-cli`;
  await docker(['create', '--name', name, 'wordpress:cli']);
  try {
    await docker(['cp', `${name}:/usr/local/bin/wp`, file]);
  } finally {
    await docker(['rm', name], { allowFail: true });
  }
  return file;
}

// ---------------------------------------------------------------------------- http to the site

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

const titleOf = (html: Buffer) => /<title>([^<]*)<\/title>/i.exec(html.toString('utf8'))?.[1]?.trim() ?? null;

// ---------------------------------------------------------------------------- the site's own test code

/** Update offers for the test's plugins, from packages on the site; and a registered command. */
const E2E_MU_PLUGIN = `<?php
// WPL7 Connect's end-to-end test: update offers from packages on this machine, and a command.
add_filter('site_transient_update_plugins', function ($value) {
    if (!is_object($value)) {
        $value = new stdClass();
    }
    if (!isset($value->response) || !is_array($value->response)) {
        $value->response = array();
    }
    foreach (array('e2e-sample' => '1.1', 'e2e-breaker' => '2.0') as $slug => $version) {
        $file = $slug . '/' . $slug . '.php';
        if (!is_file(WP_PLUGIN_DIR . '/' . $file)) {
            continue;
        }
        $data = get_file_data(WP_PLUGIN_DIR . '/' . $file, array('Version' => 'Version'));
        if (version_compare($data['Version'], $version, '<')) {
            $value->response[$file] = (object) array(
                'slug' => $slug,
                'plugin' => $file,
                'new_version' => $version,
                'package' => '/tmp/' . $slug . '-' . $version . '.zip',
                'url' => '',
            );
        }
    }
    return $value;
});
add_filter('wpl7_connect_commands', function (array $commands) {
    $commands['hello'] = array(
        'summary' => 'Says hello',
        'help' => function (array $words) {
            return "NAME\\n\\n  wp hello\\n";
        },
        'run' => function (array $args, array $context) {
            return array('stdout' => 'Hello ' . (isset($args[1]) ? $args[1] : 'world') . "\\n", 'stderr' => '', 'exit_code' => 0);
        },
    );
    return $commands;
});
`;

const pluginFile = (slug: string, version: string, body = '') =>
  `<?php\n/**\n * Plugin Name: ${slug === 'e2e-breaker' ? 'E2E Breaker' : 'E2E Sample'}\n * Version: ${version}\n */\n${body}\n`;

const PRETTY_HTACCESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;

// ---------------------------------------------------------------------------- the cases

const cases = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.name));

describe.skipIf(!ENABLED).each(cases)('a site on $wp with $db, through WPL7 Connect', (c) => {
  const label = `wpl7-connect-e2e=${RUN}-${c.name}`;
  const names = {
    net: `${RUN}-${c.name}`,
    db: `${RUN}-${c.name}-db`,
    wp: `${RUN}-${c.name}-wp`,
    net2: `${RUN}-${c.name}-restored`,
    db2: `${RUN}-${c.name}-db2`,
    wp2: `${RUN}-${c.name}-wp2`,
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-connect-e2e-'));
  let port = 0;
  let w: TestWorld;
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let headers: Record<string, string> = {};
  let scanJobId = 0;
  let close: () => Promise<void> = async () => undefined;
  let connectionId = 0;
  const dbEnv =
    c.client === 'mariadb'
      ? ['-e', 'MARIADB_ROOT_PASSWORD=rootpw', '-e', 'MARIADB_DATABASE=wp', '-e', 'MARIADB_USER=wp', '-e', 'MARIADB_PASSWORD=wppw']
      : ['-e', 'MYSQL_ROOT_PASSWORD=rootpw', '-e', 'MYSQL_DATABASE=wp', '-e', 'MYSQL_USER=wp', '-e', 'MYSQL_PASSWORD=wppw'];
  const wpEnv = (dbHost: string) => [
    '-e', `WORDPRESS_DB_HOST=${dbHost}`, '-e', 'WORDPRESS_DB_USER=wp', '-e', 'WORDPRESS_DB_PASSWORD=wppw', '-e', 'WORDPRESS_DB_NAME=wp',
    '-e', 'WORDPRESS_TABLE_PREFIX=shp_',
  ];

  const wp = (args: string[], opts: { allowFail?: boolean; container?: string } = {}) =>
    docker(['exec', '-u', 'www-data', '-w', '/var/www/html', opts.container ?? names.wp, 'php', '/usr/local/bin/wp', ...args], opts);
  const sh = (script: string, container = names.wp) => docker(['exec', '-u', 'www-data', '-w', '/var/www/html', container, 'sh', '-c', script]);
  const put = async (file: string, data: Buffer | string, container = names.wp) => {
    const local = path.join(work, path.basename(file));
    fs.writeFileSync(local, data);
    await docker(['cp', local, `${container}:${file}`]);
    await docker(['exec', container, 'chown', 'www-data:www-data', file]);
  };
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const site = () => w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
  const pluginVersion = async (slug: string) => (await wp(['plugin', 'get', slug, '--field=version'])).stdout.trim();

  beforeAll(async () => {
    // -------------------------------------------------------------- the site
    await docker(['network', 'create', '--label', label, names.net]);
    await docker(['run', '-d', '--name', names.db, '--label', label, '--network', names.net, ...dbEnv, c.db, ...c.dbArgs]);
    await until("the site's database", async () => (await docker(['exec', '-e', 'MYSQL_PWD=wppw', names.db, c.client, '-uwp', '-e', 'SELECT 1', 'wp'], { allowFail: true })).status === 0);
    await docker([
      'run', '-d', '--name', names.wp, '--label', label, '--network', names.net,
      '-p', '127.0.0.1::80', '--add-host', 'host.docker.internal:host-gateway',
      ...wpEnv(names.db),
      c.wp,
    ]);
    port = Number((await docker(['port', names.wp, '80/tcp'])).stdout.trim().split('\n')[0]!.split(':').at(-1));
    await until('WordPress', async () => (await request(port, 'GET', '/wp-admin/install.php').catch(() => ({ status: 0 }))).status === 200);

    await docker(['cp', await wpCliPhar(), `${names.wp}:/usr/local/bin/wp`]);
    await docker(['exec', names.wp, 'chmod', '755', '/usr/local/bin/wp']);
    await wp(['core', 'install', `--url=http://${HOST}`, '--title=Example Shop', '--admin_user=admin', `--admin_password=${ADMIN_PASSWORD}`, '--admin_email=admin@example.com', '--skip-email']);
    if (c.permalinks) {
      await wp(['rewrite', 'structure', c.permalinks]);
      await put('/var/www/html/.htaccess', PRETTY_HTACCESS);
    }
    await wp(['post', 'generate', '--count=20']);
    await wp(['post', 'create', '--post_title=Opening hours', '--post_status=publish', '--post_content=Monday to Friday']);
    await sh('mkdir -p wp-content/uploads/2026/10 wp-content/mu-plugins && printf photo > wp-content/uploads/2026/10/photo.jpg && printf gone > wp-content/uploads/2026/10/old.jpg');
    await put('/var/www/html/wp-content/mu-plugins/e2e.php', E2E_MU_PLUGIN);
    for (const slug of ['e2e-sample', 'e2e-breaker']) {
      await sh(`mkdir -p wp-content/plugins/${slug}`);
      await put(`/var/www/html/wp-content/plugins/${slug}/${slug}.php`, pluginFile(slug, '1.0'));
      await wp(['plugin', 'activate', slug]);
    }
    await put('/tmp/e2e-sample-1.1.zip', zipOf([{ name: 'e2e-sample/' }, { name: 'e2e-sample/e2e-sample.php', data: pluginFile('e2e-sample', '1.1') }]));
    // Fatal on every request once it is loaded: the update the health check must catch.
    await put(
      '/tmp/e2e-breaker-2.0.zip',
      zipOf([{ name: 'e2e-breaker/' }, { name: 'e2e-breaker/e2e-breaker.php', data: pluginFile('e2e-breaker', '2.0', 'e2e_breaker_no_such_function();') }]),
    );

    // -------------------------------------------------------------- the panel
    w = await makeWorld({ exec: hostExec });
    (w.config as { connectPluginDir: string }).connectPluginDir = path.resolve('connect-plugin');
    app = (await makeApp(w)).app;
    await app.listen({ host: process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0', port: 0 });
    close = () => app.close();
    const panelPort = (app.server.address() as AddressInfo).port;
    w.core.connections.origin = () => `http://host.docker.internal:${panelPort}`;
    w.core.connections.lookup = LOOKUP;
    w.core.connections.transport = containerTransport(port);
    w.core.connections.probe = async (url) => {
      const started = Date.now();
      const u = new URL(url);
      try {
        const res = await request(port, 'GET', `${u.pathname}${u.search}`, { headers: { host: u.host } });
        return { ok: res.status < 400, status: res.status, ms: Date.now() - started, certExpiresAt: null };
      } catch (err) {
        return { ok: false, status: null, ms: Date.now() - started, certExpiresAt: null, error: String(err) };
      }
    };
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const cookie = login.cookies.find((x) => x.name === 'panel.sid')!;
    headers = { cookie: `${cookie.name}=${cookie.value}`, 'x-csrf': '1' };
    connectionId = w.core.connections.create({ allowHttp: true }, 'admin').id;
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

  it("enrolls from the plugin installed off the panel's zip, and is added", async () => {
    await put('/tmp/wpl7-connect.zip', w.core.connections.pluginZip(connectionId).data);
    await wp(['plugin', 'install', '/tmp/wpl7-connect.zip', '--activate']);
    expect((await sh('test -e wp-content/plugins/wpl7-connect/connection.php || echo gone')).stdout.trim()).toBe('gone');
    expect((await sh('test -e wp-content/mu-plugins/wpl7-connect-loader.php && echo there')).stdout.trim()).toBe('there');
    const enroll = (await wp(['eval', 'echo wp_json_encode(WPL7_Connect_Client::enroll());'])).stdout;
    expect(JSON.parse(enroll.trim().split('\n').at(-1)!), enroll).toEqual({ ok: true, message: '' });

    const dto = w.core.connections.toDto(w.core.connections.get(connectionId));
    expect(dto.status).toBe('enrolled');
    expect(dto.report).toMatchObject({ home: `http://${HOST}`, tablePrefix: 'shp_', title: 'Example Shop', loader: true, fsMethod: 'direct', fileMods: true });
    expect(dto.report!.admins.map((a) => a.login)).toEqual(['admin']);
    expect(dto.blockedReason).toBeNull();

    const check = await api('POST', `/api/connections/${connectionId}/check`);
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json().check).toMatchObject({ reachable: true, error: null });
    const added = await api('POST', `/api/connections/${connectionId}/add`, { slug: 'shop', backups: true });
    expect(added.statusCode, added.body).toBe(201);
    const jobs = added.json().jobs as { id: number; type: string }[];
    expect(jobs.map((j) => j.type)).toEqual(['wp.scanAll', 'backup.create']);
    scanJobId = jobs[0]!.id;
    // The backups are the backup test's.
    await api('POST', `/api/jobs/${jobs[1]!.id}/cancel`);
    expect((await wp(['option', 'get', 'wpl7_connect_state'])).stdout.trim()).toBe('connected');
  }, 20 * 60_000);

  it('reads the plugins and themes as WP-CLI lists them', async () => {
    const scan = await runJob(w, scanJobId, 5 * 60_000);
    expect(scan.job.status, scan.log.join('\n')).toBe('succeeded');
    const status = (await api('GET', '/api/sites/shop/wp/status')).json() as {
      core: { version: string };
      plugins: { slug: string; status: string; version: string; updateVersion: string | null }[];
      themes: { slug: string; status: string; version: string }[];
    };
    const cli = (kind: 'plugin' | 'theme') =>
      wp([kind, 'list', '--format=json', '--fields=name,status,version']).then(
        (r) => (JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { name: string; status: string; version: string }[]).map((p) => `${p.name}:${p.status}:${p.version}`).sort(),
      );
    expect(status.plugins.map((p) => `${p.slug}:${p.status}:${p.version}`).sort()).toEqual(await cli('plugin'));
    expect(status.themes.map((t) => `${t.slug}:${t.status}:${t.version}`).sort()).toEqual(await cli('theme'));
    expect(status.core.version).toBe((await wp(['core', 'version'])).stdout.trim());
    expect(status.plugins.find((p) => p.slug === 'e2e-sample')).toMatchObject({ updateVersion: '1.1' });
  }, 20 * 60_000);

  it('updates a plugin, and rolls back one whose update breaks the site', async () => {
    const good = await api('POST', '/api/sites/shop/wp/bulk', { ops: [{ kind: 'plugin', slug: 'e2e-sample', action: 'update' }], backupFirst: false, healthCheck: true });
    expect(good.statusCode, good.body).toBe(202);
    const first = await runJob(w, good.json().job.id, 5 * 60_000);
    expect(first.job.status, first.log.join('\n')).toBe('succeeded');
    expect(await pluginVersion('e2e-sample')).toBe('1.1');
    // The copy kept for a rollback is gone once the site answered; the folder keeps its guard.
    expect((await sh('ls wp-content/wpl7-rollback 2>/dev/null | grep -v "^index.php$" | wc -l')).stdout.trim()).toBe('0');

    const bad = await api('POST', '/api/sites/shop/wp/bulk', { ops: [{ kind: 'plugin', slug: 'e2e-breaker', action: 'update' }], backupFirst: false, healthCheck: true });
    expect(bad.statusCode, bad.body).toBe(202);
    const second = await runJob(w, bad.json().job.id, 5 * 60_000);
    expect(second.job.status, second.log.join('\n')).toBe('failed');
    expect(second.log.join('\n')).toMatch(/put back/);
    expect(await pluginVersion('e2e-breaker')).toBe('1.0');
    expect((await request(port, 'GET', '/')).status).toBe(200);
    expect((await wp(['plugin', 'is-active', 'e2e-breaker'], { allowFail: true })).status).toBe(0);
  }, 20 * 60_000);

  let firstBackup = 0;
  let secondBackup = 0;

  it('backs the site up, and the next backup pulls what changed and drops what is gone', async () => {
    const queued = await api('POST', '/api/sites/shop/backups', { note: 'e2e' });
    expect(queued.statusCode, queued.body).toBe(202);
    const one = await runJob(w, queued.json().job.id, 10 * 60_000);
    expect(one.job.status, one.log.join('\n')).toBe('succeeded');
    firstBackup = w.db.select().from(backups).where(eq(backups.siteSlug, 'shop')).all().at(-1)!.id;

    await sh('printf changed > wp-content/uploads/2026/10/photo.jpg && rm wp-content/uploads/2026/10/old.jpg');
    await wp(['post', 'create', '--post_title=Written after the first backup', '--post_status=publish']);
    const again = await api('POST', '/api/sites/shop/backups', {});
    const two = await runJob(w, again.json().job.id, 10 * 60_000);
    expect(two.job.status, two.log.join('\n')).toBe('succeeded');
    const rows = w.db.select().from(backups).where(eq(backups.siteSlug, 'shop')).all();
    secondBackup = rows.at(-1)!.id;
    expect(secondBackup).not.toBe(firstBackup);
    expect(rows.find((b) => b.id === secondBackup)).toMatchObject({ status: 'complete', type: 'manual' });
    expect(w.db.select().from(siteConnections).where(eq(siteConnections.siteId, site().id)).get()!.lastBackupAt).not.toBeNull();
  }, 20 * 60_000);

  it('hands out the files and the database as two downloads, and they restore by hand', async () => {
    const files = await api('GET', `/api/backups/${secondBackup}/download?part=files`);
    expect(files.statusCode).toBe(200);
    expect(files.headers['content-disposition']).toMatch(/files\.tar\.gz/);
    const database = await api('GET', `/api/backups/${secondBackup}/download?part=database`);
    expect(database.statusCode).toBe(200);
    expect(database.headers['content-disposition']).toMatch(/database\.sql\.gz/);
    const tarball = path.join(work, 'files.tar.gz');
    fs.writeFileSync(tarball, files.rawPayload);
    const sql = zlib.gunzipSync(database.rawPayload).toString('utf8');
    expect(sql).toContain('Written after the first backup');
    expect(sql).not.toMatch(/shp_wpl7_connect_(files|nonces)/);

    const unpacked = path.join(work, 'restored');
    fs.mkdirSync(unpacked);
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', unpacked]);
    expect(untar.status, untar.stderr.toString()).toBe(0);
    // As in every WPL7 backup, the site's files are the archive's `wordpress` folder.
    const tree = path.join(unpacked, 'wordpress');
    expect(fs.readFileSync(path.join(tree, 'wp-content/uploads/2026/10/photo.jpg'), 'utf8')).toBe('changed');
    expect(fs.existsSync(path.join(tree, 'wp-content/uploads/2026/10/old.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(tree, 'wp-config.php'))).toBe(true);

    // A fresh host: its database answers to the old one's name, so wp-config.php works as it is.
    await docker(['network', 'create', '--label', label, names.net2]);
    await docker(['run', '-d', '--name', names.db2, '--label', label, '--network', names.net2, '--network-alias', names.db, ...dbEnv, c.db, ...c.dbArgs]);
    await until('the new database', async () => (await docker(['exec', '-e', 'MYSQL_PWD=wppw', names.db2, c.client, '-uwp', '-e', 'SELECT 1', 'wp'], { allowFail: true })).status === 0);
    await docker(['exec', '-i', '-e', 'MYSQL_PWD=rootpw', names.db2, c.client, '-uroot', '--default-character-set=utf8mb4', 'wp'], { input: sql });
    await docker(['run', '-d', '--name', names.wp2, '--label', label, '--network', names.net2, '-p', '127.0.0.1::80', ...wpEnv(names.db), c.wp]);
    const port2 = Number((await docker(['port', names.wp2, '80/tcp'])).stdout.trim().split('\n')[0]!.split(':').at(-1));
    await until('the new WordPress', async () => (await request(port2, 'GET', '/wp-login.php').catch(() => ({ status: 0 }))).status === 200);
    await docker(['cp', `${tree}/.`, `${names.wp2}:/var/www/html/`]);
    await docker(['exec', names.wp2, 'chown', '-R', 'www-data:www-data', '/var/www/html']);

    for (const page of ['/', '/?p=1', '/?s=Opening']) {
      const [was, now] = await Promise.all([request(port, 'GET', page), request(port2, 'GET', page)]);
      expect([page, now.status]).toEqual([page, was.status]);
      expect(titleOf(now.body)).toBe(titleOf(was.body));
    }
  }, 20 * 60_000);

  it('runs a registered command, and lists it', async () => {
    const res = await api('POST', '/api/sites/shop/wp/cli', { args: ['hello', 'there'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stdout: 'Hello there\n', stderr: '', exitCode: 0 });
    const unknown = (await api('POST', '/api/sites/shop/wp/cli', { args: ['plugin', 'list'] })).json();
    expect(unknown).toMatchObject({ exitCode: 1 });
    const help = await api('GET', '/api/sites/shop/wp/cli/help');
    expect(help.json().help).toContain('hello');
  }, 20 * 60_000);

  it('sends a REST request as the user the auth names', async () => {
    const res = await api('POST', '/api/sites/shop/wp/rest', { method: 'GET', route: 'wp/v2/users/me', auth: { username: 'admin', applicationPassword: 'not needed here' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe(200);
    expect(JSON.parse(res.json().body)).toMatchObject({ slug: 'admin' });
  }, 20 * 60_000);

  it('logs in to wp-admin once through a login link', async () => {
    const res = await api('POST', '/api/sites/shop/wp/admin-login');
    expect(res.statusCode, res.body).toBe(200);
    const link = new URL(res.json().url as string);
    expect(link.host).toBe(HOST);
    const jar = new Map<string, string>();
    const open = await request(port, 'GET', `${link.pathname}${link.search}`);
    expect(open.status, open.body.toString('utf8').slice(0, 300)).toBe(302);
    const admin = await request(port, 'GET', '/wp-admin/', { headers: { cookie: withCookies(jar, open) } });
    expect(admin.status).toBe(200);
    // Once only.
    const twice = await request(port, 'GET', `${link.pathname}${link.search}`);
    expect(withCookies(new Map(), twice)).not.toMatch(/wordpress_logged_in/);
  }, 20 * 60_000);

  it('lets go on Disconnect: the plugin refuses the key afterwards', async () => {
    const conn = w.db.select().from(siteConnections).where(eq(siteConnections.siteId, site().id)).get()!;
    const res = await api('POST', '/api/sites/shop/connection/disconnect');
    expect(res.statusCode, res.body).toBe(200);
    expect(site().status).toBe('disconnected');
    expect((await wp(['option', 'get', 'wpl7_connect_state'])).stdout.trim()).toBe('disconnected');
    const client = new ConnectClient({
      connectionId: conn.id,
      privateKey: conn.privateKey!,
      home: conn.homeUrl!,
      endpoint: conn.endpointUrl!,
      allowHttp: true,
      transport: containerTransport(port),
      lookup: LOOKUP,
      sleep: async () => undefined,
    });
    try {
      await expect(client.ping()).rejects.toThrow();
    } finally {
      client.close();
    }
    expect((await request(port, 'GET', '/')).status).toBe(200);
  }, 20 * 60_000);
});
