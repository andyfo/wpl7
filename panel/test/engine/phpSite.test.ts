/**
 * A PHP site on the real site image: the image from deploy/wordpress-image through
 * DockerService.buildImage, the container from buildSiteContainerSpec for a site whose app is
 * `php`, its files from the panel's renderers, with MariaDB and a stand-in mail relay beside it.
 * Then a WordPress site's container on the same image, to show that it still gets WordPress.
 *
 * Requests are made from inside the container, through its real nginx, Apache and PHP-FPM, with
 * the Host and X-Forwarded-Proto Traefik would send, as in test/engine/siteStack.test.ts.
 *
 * Docker Desktop's file sharing lets any user in a container write a folder of the host's, so on
 * a Mac the folder's handover to www-data shows only as its owner. On Linux, where CI runs this,
 * the test also sees that www-data cannot write the folder before it.
 *
 * Opt-in: needs Docker, and for a build Docker Hub and Debian.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/phpSite.test.ts
 *
 * WPL7_ENGINE_SITE_IMAGE=<tag> uses an image that is ready instead of building one; the build is
 * left as wpl7-wordpress:php<version>-engine, which siteStack.test.ts uses too. WPL7_ENGINE_PHP
 * picks the PHP version (8.4 by default).
 */
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { DockerService } from '../../src/services/docker.js';
import { defaultMailFrom, mailLogin, renderMsmtprc } from '../../src/services/mailAuth.js';
import { PLACEHOLDER_FILE, renderPlaceholderPage } from '../../src/services/phpSite.js';
import { cronExec } from '../../src/services/siteCron.js';
import { asSiteUser } from '../../src/services/wp.js';
import { renderApacheHardening, renderWpConfigHardening, type ApacheSite } from '../../src/services/siteHardening.js';
import { siteNetworkName } from '../../src/services/siteNetwork.js';
import { DEFAULT_UPLOADS_INI, SITE_APP_LABEL, buildSiteContainerSpec, sitePaths } from '../../src/services/siteSpec.js';
import { REDIS_SOCKET_IN_CONTAINER, renderFpmPool, renderNginxSite, renderPhpIni, renderRedisConf, stackSizing } from '../../src/services/siteStack.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const PHP = process.env.WPL7_ENGINE_PHP ?? '8.4';
const IMAGE = process.env.WPL7_ENGINE_SITE_IMAGE ?? `wpl7-wordpress:php${PHP}-engine`;
const IMAGE_FOLDER = fileURLToPath(new URL('../../../deploy/wordpress-image', import.meta.url));
/** Docker Desktop lets anyone write a shared folder; a Linux daemon checks its owner. */
const PERMISSIONS_HOLD = process.platform === 'linux';

const SLUG = `enginephp${process.pid}`;
const SITE = `wp-${SLUG}`;
const WP_SLUG = `enginephpwp${process.pid}`;
const WP_SITE = `wp-${WP_SLUG}`;
const DATABASE = `wpl7-engine-php-db-${process.pid}`;
const RELAY = `wpl7-engine-php-relay-${process.pid}`;
const SITE_NETWORK = siteNetworkName(SLUG);
const HOST = 'php.example.com';
const DB_NAME = 'wp_enginephp';
const DB_PASSWORD = 'engine-db-password';
const MAIL_PASSWORD = 'engine-mail-password';
const TITLE = 'Engine & PHP';

/** The panel's defaults for a site. */
const LIMITS = { memoryBytes: 512 * 1024 * 1024, nanoCpus: 2_000_000_000, pidsLimit: 512 };

/** The protection a PHP site gets: none of WordPress's rules (shared/security.ts). */
const PHP_POLICY = { blockPhpInUploads: false };

/**
 * A stand-in for the mail relay: a small PHP listener speaking just enough SMTP for msmtp, which
 * prints what it receives. msmtp itself is the real one, with the panel's own config file. As in
 * siteStack.test.ts.
 */
const STAND_IN_RELAY = String.raw`
$server = stream_socket_server('tcp://0.0.0.0:587');
while ($c = stream_socket_accept($server, -1)) {
    fwrite($c, "220 stand-in ESMTP\r\n");
    $inData = false;
    while (($line = fgets($c)) !== false) {
        echo $line;
        if ($inData) {
            if (rtrim($line) === '.') { $inData = false; fwrite($c, "250 ok\r\n"); }
            continue;
        }
        $command = strtoupper(substr($line, 0, 4));
        if ($command === 'EHLO') fwrite($c, "250-stand-in\r\n250 AUTH PLAIN\r\n");
        elseif ($command === 'AUTH') fwrite($c, "235 ok\r\n");
        elseif ($command === 'DATA') { $inData = true; fwrite($c, "354 go on\r\n"); }
        elseif ($command === 'QUIT') { fwrite($c, "221 bye\r\n"); break; }
        else fwrite($c, "250 ok\r\n");
    }
    fclose($c);
}
`;

// ---------------------------------------------------------------------------
// Running things

interface Done {
  status: number;
  stdout: Buffer;
  stderr: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command: string, args: string[], input?: string | Buffer): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    if (input !== undefined) child.stdin!.end(input);
  });
}

const dockerCli = (...args: string[]) => run('docker', args);

async function must(done: Done | Promise<Done>, what: string): Promise<string> {
  const result = await done;
  if (result.status !== 0) throw new Error(`${what} failed (${result.status}): ${result.stderr}${result.stdout.toString('utf8').slice(-2000)}`);
  return result.stdout.toString('utf8').trim();
}

/** Inside a container, as root like the panel's reloads, or as the site's user. */
function inContainer(container: string, command: string[], opts: { user?: string; input?: string | Buffer } = {}): Promise<Done> {
  const args = ['exec', ...(opts.input === undefined ? [] : ['-i']), ...(opts.user ? ['-u', opts.user] : []), container, ...command];
  return run('docker', args, opts.input);
}

const inSite = (command: string[], opts: { user?: string; input?: string | Buffer } = {}) => inContainer(SITE, command, opts);

const asSite = { user: '33:33' };

/** As the Files tab writes: www-data, inside the site's container (services/siteFiles.ts). */
async function writeInSite(file: string, content: string | Buffer): Promise<void> {
  await must(inSite(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], { ...asSite, input: content }), `writing ${file}`);
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, everyMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Waited ${timeoutMs} ms for ${what}`);
    await sleep(everyMs);
  }
}

const logsOf = async (container: string) => {
  const done = await dockerCli('logs', container);
  return done.stdout.toString('utf8') + done.stderr;
};

// ---------------------------------------------------------------------------
// Asking the site

interface AskOpts {
  /** null sends no X-Forwarded-Proto. */
  proto?: string | null;
  container?: string;
}

interface Answer {
  status: number;
  headers: Map<string, string>;
  body: string;
}

async function ask(url: string, opts: AskOpts = {}): Promise<Answer> {
  const args = ['curl', '-sS', '-i', '--http1.1', '--path-as-is', '--max-time', '20', '-H', `Host: ${HOST}`];
  if (opts.proto !== null) args.push('-H', `X-Forwarded-Proto: ${opts.proto ?? 'https'}`);
  args.push(`http://127.0.0.1:8080${url}`);
  const done = await inContainer(opts.container ?? SITE, args);
  if (done.status !== 0) throw new Error(`curl ${url} failed (${done.status}): ${done.stderr}`);
  const raw = done.stdout.toString('utf8');
  const end = raw.indexOf('\r\n\r\n');
  const lines = raw.slice(0, end).split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) headers.set(line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim());
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0), headers, body: raw.slice(end + 4) };
}

/** Whether nginx answers at all, and Apache behind it: any answer but nginx's own 502. */
async function answers(container = SITE): Promise<boolean> {
  const done = await inContainer(container, ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', '-H', `Host: ${HOST}`, 'http://127.0.0.1:8080/']);
  const code = done.stdout.toString('utf8');
  return done.status === 0 && code !== '000' && code !== '502';
}

const dockerService = new DockerService('none', 'none');
// Named here and made in beforeAll, so that a run with the test switched off leaves nothing behind.
const root = path.join(fs.realpathSync(os.tmpdir()), `wpl7-php-site-${process.pid}`);
const config = {
  paths: { sites: path.join(root, 'sites'), plugins: path.join(root, 'plugins') },
  mariadb: { host: 'mariadb' },
  tlsMode: 'letsencrypt',
  acmeResolver: 'letsencrypt',
} as unknown as Config;
const site = {
  slug: SLUG,
  app: 'php',
  phpVersion: PHP,
  dbName: DB_NAME,
  dbUser: DB_NAME,
  dbPassword: DB_PASSWORD,
  containerName: SITE,
  tablePrefix: 'wp_',
};
const paths = sitePaths(config, SLUG);
const wpPaths = sitePaths(config, WP_SLUG);
const tls = { devDomain: 'dev.example.com', wildcardProvider: '' };

function writeFileWhole(file: string, content: string): void {
  const next = `${file}.next`;
  fs.writeFileSync(next, content, { mode: 0o644 });
  fs.renameSync(next, file);
}

/** The runtime folder as services/siteCaches.ts writes it for a PHP site: no page cache. */
function writeRuntime(opts: { redis?: boolean } = {}): void {
  const { memoryMb, cpus } = stackSizing(LIMITS);
  const warn = (message: string) => {
    throw new Error(message);
  };
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileWhole(path.join(paths.runtimeDir, 'nginx-site.conf'), renderNginxSite({ pageCache: false, rules: { off: [], own: [] }, warn }));
  writeFileWhole(path.join(paths.runtimeDir, 'php-fpm-pool.conf'), renderFpmPool(memoryMb, cpus));
  writeFileWhole(path.join(paths.runtimeDir, 'php.ini'), renderPhpIni(memoryMb));
  writeFileWhole(path.join(paths.runtimeDir, 'mail-from'), `${defaultMailFrom('php', HOST)}\n`);
  const redisConf = path.join(paths.runtimeDir, 'redis.conf');
  if (opts.redis) writeFileWhole(redisConf, renderRedisConf(memoryMb));
  else fs.rmSync(redisConf, { force: true });
}

/**
 * Docker Desktop's file sharing can show a replaced file's old content for a moment. A server's
 * bind mount has no such delay. So a test waits until the container sees what was written.
 */
async function seenByContainer(file: string, inContainerPath: string): Promise<void> {
  const here = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  await waitFor(`the container to see ${inContainerPath}`, async () => (await inSite(['md5sum', inContainerPath])).stdout.toString('utf8').startsWith(here), 15_000, 100);
}

/**
 * The site's own Apache file, as the protection writes it: in place, because a single-file mount
 * keeps the inode it was given, then checked and reloaded (services/security.ts).
 */
async function applyApache(apacheSite: ApacheSite): Promise<void> {
  fs.writeFileSync(paths.securityApacheConf, renderApacheHardening(PHP_POLICY, apacheSite));
  await seenByContainer(paths.securityApacheConf, '/etc/apache2/conf-enabled/zz-wpl7-security.conf');
  await must(inSite(['wpl7-reload', 'apache']), 'wpl7-reload apache');
  // A graceful reload is in force once the next request is answered by a new child.
  await sleep(1_000);
}

/** What ensureSiteMountSources writes before a container is created, from the same renderers. */
function writeMountSources(p: typeof paths): void {
  fs.mkdirSync(p.wordpress, { recursive: true });
  fs.mkdirSync(p.securityDir, { recursive: true });
  fs.writeFileSync(p.uploadsIni, DEFAULT_UPLOADS_INI);
  fs.writeFileSync(p.msmtprc, renderMsmtprc(mailLogin(SLUG), MAIL_PASSWORD), { mode: 0o644 });
  fs.writeFileSync(p.securityWpPhp, renderWpConfigHardening({ disallowFileEdit: false, disallowFileMods: false }), { mode: 0o644 });
}

/** What's in the site's folder, as the container sees it. */
const folderEntries = async (container = SITE) =>
  (await must(inContainer(container, ['find', '/var/www/html', '-mindepth', '1', '-printf', '%P\n']), 'listing the folder')).split('\n').filter(Boolean).sort();

/** `docker restart`, then until the site answers again. */
async function restart(container = SITE): Promise<void> {
  await must(dockerCli('restart', '-t', '20', container), `restarting ${container}`);
  await waitFor(`${container} to answer after its restart`, () => answers(container), 60_000, 250);
}

/** As the create job hands a new site's folder over: `chown -R 33:33`, by root on the server. */
const handOver = (folder: string) => must(dockerCli('run', '--rm', '--entrypoint', 'chown', '-v', `${folder}:/f`, IMAGE, '-R', '33:33', '/f'), 'chown -R 33:33');

describe.skipIf(!ENABLED)('a PHP site on the site image', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    if (!process.env.WPL7_ENGINE_SITE_IMAGE) {
      await dockerService.buildImage(IMAGE, IMAGE_FOLDER, { PHP_TAG: `php${PHP}` });
    }

    await must(dockerCli('network', 'create', '--internal', SITE_NETWORK), 'site network');
    await must(dockerCli('run', '-d', '--name', DATABASE, '--network', SITE_NETWORK, '--network-alias', 'mariadb', '-e', 'MARIADB_ROOT_PASSWORD=engine-root', 'mariadb:11.4'), 'MariaDB');
    await waitFor('MariaDB', async () => (await dockerCli('exec', DATABASE, 'healthcheck.sh', '--connect', '--innodb_initialized')).status === 0, 120_000, 500);
    // As the create job makes a site's own database (services/dbAdmin.ts).
    await must(
      run('docker', ['exec', '-i', DATABASE, 'mariadb', '-uroot', '-pengine-root'], `CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4; CREATE USER '${DB_NAME}'@'%' IDENTIFIED BY '${DB_PASSWORD}'; GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_NAME}'@'%';`),
      'the site database',
    );
    await must(dockerCli('run', '-d', '--name', RELAY, '--network', SITE_NETWORK, '--network-alias', 'mail', '--entrypoint', 'php', IMAGE, '-r', STAND_IN_RELAY), 'the stand-in relay');

    writeMountSources(paths);
    fs.writeFileSync(paths.securityApacheConf, renderApacheHardening(PHP_POLICY, { app: 'php', webRoot: '' }), { mode: 0o644 });
    writeRuntime();
    const spec = buildSiteContainerSpec(config, site, [HOST], tls, LIMITS, { stack: 2, image: IMAGE });
    await dockerService.createSiteContainer({ ...spec, networks: [SITE_NETWORK] });
    await dockerService.startContainer(SITE);
    await waitFor('the site to answer', () => answers(), 120_000, 250);
  }, 1_200_000);

  afterAll(async () => {
    // Files the container made may be its user's alone, so they are removed from in there.
    await inSite(['find', '/var/www/html', '-mindepth', '1', '-delete']);
    await inContainer(WP_SITE, ['find', '/var/www/html', '-mindepth', '1', '-delete']);
    // -v: MariaDB's image and the site image's each make an anonymous volume.
    await dockerCli('rm', '-f', '-v', SITE, WP_SITE, DATABASE, RELAY);
    await dockerCli('network', 'rm', SITE_NETWORK);
    fs.rmSync(root, { recursive: true, force: true });
  }, 180_000);

  describe('the container', () => {
    it("has none of WordPress's variables, no plugin catalog, and says it is a PHP site", async () => {
      const [info] = JSON.parse(await must(dockerCli('inspect', SITE), 'inspect')) as {
        Config: { Env: string[]; Labels: Record<string, string> };
        Mounts: { Source: string; Destination: string }[];
      }[];
      expect(info!.Config.Env.filter((line) => line.startsWith('WORDPRESS_'))).toEqual([]);
      expect(info!.Config.Labels[SITE_APP_LABEL]).toBe('php');
      expect(info!.Config.Labels['wpl7.role']).toBe('wordpress');
      expect(info!.Mounts.map((mount) => mount.Destination)).not.toContain(config.paths.plugins);
    });

    it('the image says it can run PHP sites', async () => {
      expect(await dockerService.imageApps(IMAGE)).toEqual(['wordpress', 'php']);
    });
  });

  describe("the site's folder is its own", () => {
    it('an empty folder stays empty after the start, and after a restart', async () => {
      expect(await folderEntries()).toEqual([]);
      await restart();
      expect(await folderEntries()).toEqual([]);
      // An empty folder: Apache lists nothing.
      expect((await ask('/')).status).toBe(403);
    });

    it('the placeholder page alone stays alone, across a restart, and is what a visitor gets', async () => {
      // As the create job writes it: as root on the server, then handed over.
      fs.writeFileSync(path.join(paths.wordpress, PLACEHOLDER_FILE), renderPlaceholderPage(TITLE));
      await handOver(paths.wordpress);
      await restart();
      expect(await folderEntries()).toEqual([PLACEHOLDER_FILE]);
      const page = await ask('/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('<h1>Engine &#38; PHP</h1>');
      expect(page.body).toContain('This site is ready. Upload your files to replace this page.');
    });

    it('once handed over, FTP, the Files tab and PHP can all write there', async () => {
      const owner = await must(inSite(['stat', '-c', '%u:%g', '/var/www/html']), 'stat');
      expect(owner).toBe('33:33');
      // The Files tab: www-data, inside the site's container.
      await writeInSite('/var/www/html/from-files-tab.txt', 'files tab\n');
      // PHP-FPM's worker, which runs as www-data.
      await writeInSite('/var/www/html/write.php', "<?php echo file_put_contents(__DIR__ . '/from-php.txt', 'php') === 3 ? 'written' : 'refused';");
      expect((await ask('/write.php')).body).toBe('written');
      // A stand-in for the FTP file server: a container of its own, as uid 33 with the folder
      // mounted, as the panel runs SFTPGo for the site (services/ftpConfig.ts). Not SFTPGo itself.
      await must(dockerCli('run', '--rm', '--user', '33:33', '--entrypoint', 'sh', '-v', `${paths.wordpress}:/srv/site`, IMAGE, '-c', 'echo ftp > /srv/site/from-ftp.txt'), 'the FTP stand-in');
      expect(await folderEntries()).toEqual(expect.arrayContaining(['from-files-tab.txt', 'from-php.txt', 'from-ftp.txt']));
      for (const file of ['write.php', 'from-files-tab.txt', 'from-php.txt', 'from-ftp.txt']) await must(inSite(['rm', `/var/www/html/${file}`], asSite), `removing ${file}`);
    });

    it.skipIf(!PERMISSIONS_HOLD)('before the handover, www-data could not write a folder root made', async () => {
      const folder = path.join(root, 'root-made');
      await must(dockerCli('run', '--rm', '--entrypoint', 'sh', '-v', `${root}:/r`, IMAGE, '-c', 'mkdir /r/root-made && chown 0:0 /r/root-made'), 'a folder of root');
      const done = await dockerCli('run', '--rm', '--user', '33:33', '--entrypoint', 'sh', '-v', `${folder}:/f`, IMAGE, '-c', 'echo x > /f/x');
      expect(done.status).not.toBe(0);
    });

    it("a WordPress site's container on the same image still gets WordPress", async () => {
      writeMountSources(wpPaths);
      // A WordPress site's container mounts the plugin catalog.
      fs.mkdirSync(config.paths.plugins, { recursive: true });
      fs.writeFileSync(wpPaths.securityApacheConf, renderApacheHardening({ blockPhpInUploads: true }, { app: 'wordpress', webRoot: '' }), { mode: 0o644 });
      fs.mkdirSync(wpPaths.runtimeDir, { recursive: true });
      const wpSite = { ...site, slug: WP_SLUG, app: 'wordpress', containerName: WP_SITE };
      const spec = buildSiteContainerSpec(config, wpSite, ['wp.example.com'], tls, LIMITS, { stack: 2, image: IMAGE });
      expect(Object.keys(spec.env)).toContain('WORDPRESS_DB_HOST');
      await dockerService.createSiteContainer({ ...spec, networks: [SITE_NETWORK] });
      await dockerService.startContainer(WP_SITE);
      // wp-config.php is written after the copy, from WordPress's variables, which only this container has.
      await waitFor('WordPress to be copied in', async () => (await inContainer(WP_SITE, ['test', '-f', '/var/www/html/wp-config.php'])).status === 0, 120_000, 500);
      expect(await folderEntries(WP_SITE)).toEqual(expect.arrayContaining(['index.php', 'wp-config.php', 'wp-login.php', 'wp-includes/version.php']));
    });
  });

  describe('PHP', () => {
    it('a PHP file runs', async () => {
      await writeInSite('/var/www/html/hello.php', "<?php echo 'hello from ', PHP_SAPI, ' ', PHP_MAJOR_VERSION, '.', PHP_MINOR_VERSION;");
      const answer = await ask('/hello.php');
      expect([answer.status, answer.body]).toEqual([200, `hello from fpm-fcgi ${PHP}`]);
    });

    it('a .htaccess rewrite works', async () => {
      await writeInSite('/var/www/html/app/.htaccess', 'RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^(.*)$ index.php?route=$1 [L,QSA]\n');
      await writeInSite('/var/www/html/app/index.php', "<?php echo 'route=', $_GET['route'] ?? '';");
      const answer = await ask('/app/some/pretty/path');
      expect([answer.status, answer.body]).toEqual([200, 'route=some/pretty/path']);
    });

    it('a .user.ini applies, and is refused over HTTP', async () => {
      await writeInSite('/var/www/html/ini/.user.ini', 'memory_limit = 111M\n');
      await writeInSite('/var/www/html/ini/check.php', "<?php echo ini_get('memory_limit');");
      const answer = await ask('/ini/check.php');
      expect([answer.status, answer.body]).toEqual([200, '111M']);
      expect((await ask('/ini/.user.ini')).status).toBe(403);
    });

    it("PDO connects to MariaDB with the site's own login", async () => {
      await writeInSite(
        '/var/www/html/pdo.php',
        `<?php $db = new PDO('mysql:host=mariadb;dbname=${DB_NAME};charset=utf8mb4', '${DB_NAME}', '${DB_PASSWORD}', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
echo $db->query('SELECT 6 * 7')->fetchColumn(), ' ', $db->getAttribute(PDO::ATTR_DRIVER_NAME);`,
      );
      const answer = await ask('/pdo.php');
      expect([answer.status, answer.body]).toEqual([200, '42 mysql']);
    });

    it('HTTPS is on for PHP when the visitor came over HTTPS, and only then', async () => {
      await writeInSite('/var/www/html/https.php', "<?php echo json_encode($_SERVER['HTTPS'] ?? null);");
      expect((await ask('/https.php')).body).toBe('"on"');
      expect((await ask('/https.php', { proto: 'http' })).body).toBe('null');
      expect((await ask('/https.php', { proto: null })).body).toBe('null');
    });
  });

  describe('every answer says it came from the site', () => {
    // The uptime check counts a PHP site's 404 as an answer only when it carries this header,
    // because Traefik answers 404 for a host it doesn't route (lib/httpProbe.ts).
    it("Apache's own 404 and 403, and a 404 PHP makes", async () => {
      await writeInSite('/var/www/html/missing.php', "<?php http_response_code(404); echo 'not here';");
      for (const [url, status] of [['/no-such-file.html', 404], ['/ini/.user.ini', 403], ['/missing.php', 404], ['/no-such-script.php', 404]] as const) {
        const answer = await ask(url);
        expect([url, answer.status, answer.headers.get('x-cache-status')]).toEqual([url, status, 'BYPASS']);
      }
    });

    it("nginx's 502 while Apache is down", async () => {
      // wpl7-start would end the container the moment Apache went, and Docker start it again, so it
      // is paused while Apache is away. Its own shell, not tini's PID 1, whose command line names it
      // too, and the oldest of them: its watcher of the .htaccess is a second shell.
      const starter = await must(inSite(['pgrep', '-o', '-f', '^/bin/bash /usr/local/bin/wpl7-start$']), 'wpl7-start');
      await must(inSite(['kill', '-STOP', starter]), 'pausing wpl7-start');
      try {
        await must(inSite(['pkill', '-KILL', 'apache2']), 'stopping Apache');
        // By its port: the paused shell can't reap Apache, which stays on the process list.
        await waitFor('Apache to be gone', async () => (await inSite(['curl', '-s', '-o', '/dev/null', '--max-time', '1', 'http://127.0.0.1:80/'])).status === 7, 10_000, 100);
        const answer = await ask('/');
        expect([answer.status, answer.headers.get('x-cache-status')]).toEqual([502, 'BYPASS']);
      } finally {
        await must(inSite(['kill', '-CONT', starter]), 'resuming wpl7-start');
      }
      // It sees Apache gone, stops the rest, and Docker starts the container again.
      await waitFor('the site to come back', () => answers().catch(() => false), 90_000, 500);
    });
  });

  describe('the web root', () => {
    it('a folder in the site serves the site, and what is above it is not served', async () => {
      await writeInSite('/var/www/html/public/index.php', "<?php echo 'public ', json_encode($_SERVER['HTTPS'] ?? null);");
      await writeInSite('/var/www/html/public/.htaccess', 'RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^ index.php [L]\n');
      await writeInSite('/var/www/html/.env', 'APP_KEY=engine-secret\n');
      await applyApache({ app: 'php', webRoot: 'public' });
      expect((await ask('/')).body).toBe('public "on"');
      expect((await ask('/', { proto: 'http' })).body).toBe('public null');
      // .env is above the web root: the request goes to the app, and the file's content never shows.
      const env = await ask('/.env');
      expect(env.body).not.toContain('engine-secret');
      expect(env.body).toBe('public "on"');
      expect((await ask('/hello.php')).body).toBe('public "on"');
    });

    it('a web root that goes missing answers 404, survives a restart, and is back with its folder', async () => {
      await must(inSite(['mv', '/var/www/html/public', '/var/www/html/public-away'], asSite), 'renaming the web root');
      try {
        const missing = await ask('/');
        expect([missing.status, missing.headers.get('x-cache-status')]).toEqual([404, 'BYPASS']);
        // A warning, not an error: Apache takes the file, and starts with it.
        const check = await inSite(['apache2ctl', '-t']);
        expect(check.status, check.stderr).toBe(0);
        expect(check.stderr).toContain('AH00112');
        await restart();
        expect((await ask('/')).status).toBe(404);
      } finally {
        await must(inSite(['mv', '/var/www/html/public-away', '/var/www/html/public'], asSite), 'putting the web root back');
      }
      // No reload: Apache finds the folder again on the next request.
      expect((await ask('/')).body).toBe('public "on"');
    });

    it('back to the site folder', async () => {
      await applyApache({ app: 'php', webRoot: '' });
      expect((await ask('/hello.php')).body).toBe(`hello from fpm-fcgi ${PHP}`);
      await must(inSite(['rm', '-rf', '/var/www/html/public', '/var/www/html/.env'], asSite), 'removing the web root');
    });
  });

  describe('mail', () => {
    async function sends(script: string): Promise<string> {
      const marker = `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      await writeInSite('/var/www/html/mail.php', `<?php $marker = '${marker}';\n${script}`);
      const answer = await ask('/mail.php');
      expect(answer.body).toBe('true');
      await waitFor('the relay to see it', async () => (await logsOf(RELAY)).includes(`Subject: Engine marker ${marker}`), 15_000);
      const log = await logsOf(RELAY);
      return log.slice(log.lastIndexOf('EHLO', log.indexOf(`Subject: Engine marker ${marker}`)));
    }

    it('sendmail, and what PHP runs, are the wrapper', async () => {
      expect(await must(inSite(['readlink', '-f', '/usr/sbin/sendmail']), 'readlink')).toBe('/usr/local/bin/wpl7-sendmail');
      expect(await must(inSite(['php', '-r', "echo ini_get('sendmail_path');"]), 'sendmail_path')).toBe('/usr/local/bin/wpl7-sendmail -t');
    });

    it("mail() with no From header leaves as noreply@ the site's domain, from PHP-FPM as www-data", async () => {
      const session = await sends("echo json_encode(mail('someone@example.com', 'Engine marker ' . $marker, \"The body.\\n\"));");
      expect(session).toContain(`MAIL FROM:<noreply@${HOST}>`);
      expect(session).toContain(`From: noreply@${HOST}`);
      expect(session).toContain(`AUTH PLAIN ${Buffer.from(`\0${mailLogin(SLUG)}\0${MAIL_PASSWORD}`).toString('base64')}`);
      // The message waited in /tmp while the wrapper read its headers, and is gone.
      expect(await must(inSite(['sh', '-c', 'ls /tmp | grep -c wpl7-mail || true']), 'temporary files')).toBe('0');
    });

    it('a From header, and -f beside it, are kept', async () => {
      const header = await sends("echo json_encode(mail('someone@example.com', 'Engine marker ' . $marker, \"The body.\\n\", 'From: app@php.example.com'));");
      expect(header).toContain('MAIL FROM:<app@php.example.com>');
      const both = await sends("echo json_encode(mail('someone@example.com', 'Engine marker ' . $marker, \"The body.\\n\", 'From: app@php.example.com', '-fbounce@php.example.com'));");
      expect(both).toContain('MAIL FROM:<bounce@php.example.com>');
      expect(both).toContain('From: app@php.example.com');
    });
  });

  describe('cron', () => {
    /** A cron line run as services/siteCron.ts runs one, through the panel's own DockerService. */
    /** What the last run printed, kept whatever became of it. */
    let lastCronOutput: string[] = [];

    async function cronRun(command: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
      const chunks: Buffer[] = [];
      lastCronOutput = [];
      const out = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          lastCronOutput.push(chunk.toString('utf8'));
          done();
        },
      });
      const { exitCode } = await dockerService.execToStream(SITE, cronExec(command), out, asSiteUser(timeoutMs));
      return { exitCode, output: Buffer.concat(chunks).toString('utf8') };
    }

    it("runs as www-data in the site's folder, with what it prints to stderr among the rest", async () => {
      const run = await cronRun('id -u; pwd; echo "$HOME"; echo oops >&2; exit 3', 60_000);
      expect(run).toEqual({ exitCode: 3, output: '33\n/var/www/html\n/tmp\noops\n' });
    });

    it('is stopped at its time inside the container, and what it printed until then is there', async () => {
      const started = Date.now();
      // DockerService reads timeout's exit as a timeout; services/siteCron.ts keeps the output it got.
      const run = await cronRun('echo started; sleep 30', 2_000).catch((err: unknown) => ({ exitCode: -1, output: String(err) }));
      expect(run.output).toContain('timed out after 2000ms');
      expect(lastCronOutput.join('')).toBe('started\n');
      expect(Date.now() - started).toBeLessThan(15_000);
      // Nothing of it is left running.
      expect((await inSite(['pgrep', '-f', 'sleep 30'])).status).toBe(1);
    });
  });

  describe('Redis', () => {
    it('answers on its socket when it is on, to the site’s user and to PHP', async () => {
      writeRuntime({ redis: true });
      await seenByContainer(path.join(paths.runtimeDir, 'redis.conf'), '/etc/wpl7-runtime/redis.conf');
      await must(inSite(['wpl7-reload', 'redis']), 'wpl7-reload redis');
      expect(await must(inSite(['redis-cli', '-s', REDIS_SOCKET_IN_CONTAINER, 'PING'], asSite), 'PING')).toBe('PONG');
      await writeInSite('/var/www/html/redis.php', `<?php $r = new Redis(); $r->connect('${REDIS_SOCKET_IN_CONTAINER}'); $r->set('k', 'v'); echo $r->get('k');`);
      expect((await ask('/redis.php')).body).toBe('v');
      writeRuntime();
      await waitFor('redis.conf to be gone in the container', async () => (await inSite(['test', '-f', '/etc/wpl7-runtime/redis.conf'])).status === 1, 15_000, 100);
      await must(inSite(['wpl7-reload', 'redis']), 'wpl7-reload redis');
      expect((await inSite(['test', '-S', REDIS_SOCKET_IN_CONTAINER])).status).toBe(1);
    });
  });
});
