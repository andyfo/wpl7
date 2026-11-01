/**
 * A real site on stack 2, built the way the panel builds one: the image from deploy/wordpress-image
 * through DockerService.buildImage, the container from buildSiteContainerSpec, its files from the
 * panel's renderers, with MariaDB beside it and WordPress installed by WP-CLI. Nothing else boots
 * the site image. Everything goes through the real nginx, Apache and PHP-FPM.
 *
 * There is no Traefik here, and Docker Desktop cannot route to a container's address, so requests
 * are made from inside the container: `docker exec <c> curl http://127.0.0.1:8080/...`, with the
 * Host and X-Forwarded-Proto Traefik would send.
 *
 * Opt-in: needs Docker and the internet (wordpress.org's plugins, and for a build Docker Hub and
 * Debian). A download that fails, fails the test. Run it when the image, the renderers or
 * wp-cache.php move:
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts
 *
 * WPL7_ENGINE_SITE_IMAGE=<tag> uses an image that is ready instead of building one; the build is
 * left as wpl7-wordpress:php<version>-engine, so that tag does for a second run.
 * WPL7_ENGINE_PHP=8.2 picks what to build (8.4 by default).
 * WPL7_ENGINE_KEEP=1 leaves the site running at the end, to look at it or to measure it. It prints
 * what to remove afterwards.
 *
 * The last part moves a second real site from the image before all this (WPL7_ENGINE_OLD_SITE_IMAGE,
 * by default wpl7-wordpress:php<version>-stack1, built from git history when this Docker has none) to
 * this one, by the panel's own image sweep and job. It does have a real Traefik: that is what a move
 * is checked through. Its header says what in it isn't real.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSiteCacheRules, type CacheRule } from '../../shared/cacheRules.js';
import type { Config } from '../../src/config.js';
import { backups, jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import { WORDPRESS_HTACCESS } from '../../src/jobs/handlers/import.js';
import { restoreSiteOnServer, type ProtectionHold, type StagedSiteSource } from '../../src/jobs/handlers/restoreSite.js';
import { startSiteContainer } from '../../src/jobs/handlers/shared.js';
import { GEOLOCATE_OFF_REASON } from '../../src/jobs/handlers/sites.js';
import { hostExec, type ExecPort } from '../../src/lib/exec.js';
import { DockerService, type ConnectOpts, type NetworkSpec, type SiteContainerSpec } from '../../src/services/docker.js';
import { mailLogin, renderMsmtprc } from '../../src/services/mailAuth.js';
import { renderApacheHardening, renderWpConfigHardening } from '../../src/services/siteHardening.js';
import { sweepSiteImages } from '../../src/services/siteImages.js';
import { checkSiteUrl, clearSiteCaches } from '../../src/services/siteCaches.js';
import { undoSiteMigration } from '../../src/services/siteMigration.js';
import { EGRESS_NETWORK as PANEL_EGRESS_NETWORK, siteNetworkName } from '../../src/services/siteNetwork.js';
import { DEFAULT_UPLOADS_INI, buildSiteContainerSpec, siteContainerSpec, siteImage, sitePaths, siteRollbackImage, siteRuntimeFrom } from '../../src/services/siteSpec.js';
import {
  FPM_SOCKET_IN_CONTAINER,
  PAGE_CACHE_DIR_IN_CONTAINER,
  REDIS_SOCKET_IN_CONTAINER,
  SITE_STACK_LABEL,
  SITE_STACK_PORT,
  renderFpmPool,
  renderNginxSite,
  renderPhpIni,
  renderRedisConf,
  stackSizing,
} from '../../src/services/siteStack.js';
import { MAIL_CONTAINER, MARIADB_CONTAINER, TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { DEFAULT_PERMALINK_STRUCTURE, WpService } from '../../src/services/wp.js';
import { renderWpCachePhp } from '../../src/services/wpCachePhp.js';
import { sendWpRest } from '../../src/services/wpRest.js';
import { makeTestConfig, makeWorld, waitFor as waitUntil, type TestWorld } from '../helpers.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const KEEP = process.env.WPL7_ENGINE_KEEP === '1';
const PHP = process.env.WPL7_ENGINE_PHP ?? '8.4';
const IMAGE = process.env.WPL7_ENGINE_SITE_IMAGE ?? `wpl7-wordpress:php${PHP}-engine`;
const IMAGE_FOLDER = fileURLToPath(new URL('../../../deploy/wordpress-image', import.meta.url));

const SLUG = `enginestack${process.pid}`;
const SITE = `wp-${SLUG}`;
const DATABASE = `wpl7-engine-site-db-${process.pid}`;
const RELAY = `wpl7-engine-site-relay-${process.pid}`;
const SITE_NETWORK = siteNetworkName(SLUG);
const EGRESS_NETWORK = `wpl7-engine-site-egress-${process.pid}`;
const HOST = 'stack.example.com';
const ADMIN = 'boss';
const ADMIN_PASSWORD = 'engine-admin-password';
const DB_PASSWORD = 'engine-db-password';
const MAIL_PASSWORD = 'engine-mail-password';
const PROBE = 'wpl7-probe/1';

/** The panel's defaults for a site. */
const LIMITS = { memoryBytes: 512 * 1024 * 1024, nanoCpus: 2_000_000_000, pidsLimit: 512 };

const SEPARATE_COPY = 'separate copy value';
const LATER_LAYER = '.htaccess or Apache says no-cache';

const skip = (id: string, match: CacheRule['match'], value: string): CacheRule => ({ id, kind: 'skip', match, value });
const copy = (id: string, match: CacheRule['match'], value: string): CacheRule => ({ id, kind: 'copy', match, value });
const keep = (id: string, match: CacheRule['match'], value: string, seconds: number): CacheRule => ({ id, kind: 'keep', match, value, seconds });

/** One rule of every kind and match, on top of the built-in groups, which every site has. */
const OWN_RULES: CacheRule[] = [
  skip('wildcard', 'path', '/t/skip-below/*'),
  skip('exact', 'path', '/t/skip-exact/'),
  skip('prefix', 'path', '/t/skip-pre*'),
  skip('accented', 'path', '/t/café/*'),
  skip('encoded', 'path', '/t/enc%C3%A9/'),
  skip('member', 'cookie', 'member_'),
  skip('queryarg', 'query', 'nocache'),
  skip('robot', 'agent', 'SkipBot/2 (x)'),
  skip('skiptype', 'postType', 'skipme'),
  copy('edition', 'cookie', 'my.edition'),
  copy('country', 'query', 'country'),
  keep('short', 'path', '/t/keep2/*', 2),
  keep('toggles', 'path', '/t/toggle/*', 2),
  keep('accentedkeep', 'path', '/t/naïve/', 77),
  keep('keeptype', 'postType', 'keepme', 88),
  { id: 'promo', kind: 'ignore', match: 'query', value: 'promo_*' },
];

/**
 * What a test asks for. By path, because a query string the cache doesn't know skips it. Each is a
 * page of its own; what comes after the first folder only makes the address unique.
 */
const TEST_PLUGIN = String.raw`<?php
function wpl7t_path() {
    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $end = strpos($uri, '?');
    return $end === false ? $uri : substr($uri, 0, $end);
}

add_action('init', function () {
    foreach (['skipme', 'keepme'] as $type) {
        register_post_type($type, ['public' => true, 'label' => $type, 'has_archive' => true, 'rewrite' => ['slug' => $type]]);
    }
});

// A path WordPress has no rule for would otherwise be a 404, with its no-cache headers, whatever
// comes next: this has it read as the home page, and the action below answers before that is sent.
add_action('parse_request', function ($wp) {
    $path = wpl7t_path();
    if (strpos($path, '/t/') === 0) $wp->query_vars = [];
    // How a download plugin answers: before the page's buffer starts, as Download Monitor does.
    if (strpos($path, '/t/early-referer/') === 0) {
        wpl7t_json(['referer' => $_SERVER['HTTP_REFERER'] ?? '']);
        exit;
    }
    if (strpos($path, '/t/early-download/') === 0) {
        while (ob_get_level() > 0) ob_end_clean();
        $megabytes = (int) explode('/', trim($path, '/'))[2];
        header('Content-Type: application/octet-stream');
        for ($i = 0; $i < $megabytes; $i++) { echo str_repeat('z', 1024 * 1024); flush(); }
        exit;
    }
}, 0);

// A stand-in for a slow page, for a post whose content says so.
add_filter('the_content', function ($content) {
    if (strpos($content, 'WPL7T-SLOW') !== false) sleep(3);
    return $content;
}, 1);

function wpl7t_page($text) {
    echo '<!doctype html><html><head><title>', $text, '</title></head><body><p>', $text, '</p><p>', bin2hex(random_bytes(8)), '</p>';
    echo str_repeat('<p>Some text, so that compression has something to do.</p>', 30), '</body></html>';
}

function wpl7t_json($value) {
    header('Content-Type: application/json');
    echo json_encode($value, JSON_UNESCAPED_SLASHES);
}

function wpl7t_end_buffers() {
    while (ob_get_level() > 0) ob_end_flush();
    flush();
}

add_action('template_redirect', function () {
    $path = wpl7t_path();
    if (strpos($path, '/t/') !== 0) return;
    $parts = explode('/', trim(substr($path, 3), '/'));
    $what = $parts[0];
    switch ($what) {
        case 'cookie': setcookie('wpl7t', '1', 0, '/'); break;
        case 'nocache': nocache_headers(); break;
        case 'donotcache': define('DONOTCACHEPAGE', true); break;
        case 'vary': header('Vary: Accept-Encoding, Cookie'); break;
        case 'vary-encoding': header('Vary: Accept-Encoding'); break;
        case 'redirect': wp_redirect(home_url('/'), 302); exit;
        case 'status500': status_header(500); break;
        case 'status-header': header('Status: ' . $parts[1] . ' By CGI'); break;
        case 'code': http_response_code((int) $parts[1]); break;
        case 'no-colon': header('This has no colon'); header('X-Kept: yes'); break;
        case 'away': wp_redirect('https://partner.example.net/landing', 301); exit;
        case 'refresh': header('Refresh: 5; url=https://stack.example.com/elsewhere/'); break;
        case 'here-with-query': wp_redirect(home_url('/elsewhere/?ref=1'), 301); exit;
        case 'late-referer': wpl7t_page('referer=' . ($_SERVER['HTTP_REFERER'] ?? 'none')); exit;
        case 'member': wpl7t_page(array_intersect(['_gateway_session', '_hjMember', '_gid_member', '_fbp_login', '_ga_member', 'CookieConsent', 'cmplz_marketing'], array_keys($_COOKIE)) ? 'PRIVATE PAGE OF MEMBER' : 'public page'); exit;
        case 'ranged':
            while (ob_get_level() > 0) ob_end_clean();
            $data = str_repeat('0123456789', 100000);
            header('Accept-Ranges: bytes');
            if (isset($_SERVER['HTTP_RANGE']) && preg_match('/bytes=(\d+)-(\d+)/', $_SERVER['HTTP_RANGE'], $m)) {
                http_response_code(206);
                header('Content-Range: bytes ' . $m[1] . '-' . $m[2] . '/' . strlen($data));
                echo substr($data, (int) $m[1], (int) $m[2] - (int) $m[1] + 1);
            } else {
                echo $data;
            }
            exit;
        case 'download':
            while (ob_get_level() > 0) ob_end_clean();
            $megabytes = (int) $parts[1];
            header('Content-Type: application/octet-stream');
            header('Content-Length: ' . ($megabytes * 1024 * 1024));
            for ($i = 0; $i < $megabytes; $i++) { echo str_repeat('z', 1024 * 1024); flush(); }
            exit;
        case 'fatal': echo 'partial'; wpl7t_no_such_function(); break;
        case 'flush': echo str_repeat('x', 100); wpl7t_end_buffers(); break;
        case 'stream':
            wpl7t_end_buffers();
            for ($i = 1; $i <= 5; $i++) { echo "chunk $i\n"; flush(); usleep(600000); }
            exit;
        case 'big':
            for ($i = 0; $i < (int) $parts[1]; $i++) echo str_repeat('y', 1024 * 1024);
            exit;
        case 'toggle':
            // A page that starts refusing to be stored, with nothing changing that would clear it.
            if (file_exists(WP_CONTENT_DIR . '/wpl7t-toggle')) setcookie('wpl7t', '1', 0, '/');
            break;
        case 'sleep': sleep((int) $parts[1]); break;
        case 'keep2':
            if (($parts[1] ?? '') === 'slow') sleep(4);
            break;
        case 'is-mobile': wpl7t_page(wp_is_mobile() ? 'wp_is_mobile yes' : 'wp_is_mobile no'); exit;
        case 'headers':
            for ($i = 0; $i < (int) $parts[1]; $i++) header('X-Long-' . $i . ': ' . str_repeat('h', (int) $parts[2]));
            break;
        case 'image':
            header('Content-Type: image/png');
            echo base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
            exit;
        case 'error':
            error_log('wpl7t-error-log ' . $parts[1]);
            trigger_error('wpl7t-warning ' . $parts[1], E_USER_WARNING);
            break;
        case 'mail':
            wpl7t_json(['sent' => mail('someone@example.com', 'Engine marker ' . $parts[1], "The body.\n", 'From: wordpress@stack.example.com')]);
            exit;
        case 'upload':
            $file = $_FILES['f'] ?? null;
            wpl7t_json(['size' => $file['size'] ?? -1, 'error' => $file['error'] ?? -1, 'md5' => $file ? md5_file($file['tmp_name']) : '']);
            exit;
        case 'opcache':
            wpl7t_json([
                'sapi' => PHP_SAPI,
                'status' => function_exists('opcache_get_status') ? opcache_get_status(false) : false,
                'memory' => ini_get('opcache.memory_consumption'),
                'strings' => ini_get('opcache.interned_strings_buffer'),
                'files' => ini_get('opcache.max_accelerated_files'),
                'assertions' => ini_get('zend.assertions'),
                'n' => bin2hex(random_bytes(8)),
            ]);
            exit;
        case 'cache-set':
            wp_cache_set('from-site', $parts[1], 'wpl7t', 300);
            wpl7t_json(['using' => wp_using_ext_object_cache()]);
            exit;
        case 'cache-get':
            wpl7t_json(['value' => wp_cache_get('from-cli', 'wpl7t'), 'using' => wp_using_ext_object_cache()]);
            exit;
        case 'echo':
            $headers = [];
            foreach ($_SERVER as $name => $value) {
                if (strpos($name, 'HTTP_') === 0) $headers[strtolower(str_replace('_', '-', substr($name, 5)))] = $value;
            }
            wpl7t_json([
                'n' => bin2hex(random_bytes(8)),
                'method' => $_SERVER['REQUEST_METHOD'],
                'uri' => $_SERVER['REQUEST_URI'],
                'query' => $_SERVER['QUERY_STRING'] ?? '',
                'get' => (object) $_GET,
                'headers' => (object) $headers,
                'cookies' => (object) $_COOKIE,
                'remote' => $_SERVER['REMOTE_ADDR'] ?? '',
                'https' => $_SERVER['HTTPS'] ?? '',
                'isSsl' => is_ssl(),
                'serverPort' => $_SERVER['SERVER_PORT'] ?? '',
                'serverAddr' => $_SERVER['SERVER_ADDR'] ?? '',
                'serverVars' => array_values(array_filter(array_keys($_SERVER), function ($name) { return strpos($name, 'WORDPRESS_') === 0; })),
                'bodyLength' => strlen(file_get_contents('php://input')),
            ]);
            exit;
        default: break;
    }
    wpl7t_page($what);
    exit;
}, 5);
`;

/** Reads a response as it arrives, inside the container: docker exec's own stream can't show the timing. */
const STREAM_CLIENT = String.raw`
$s = fsockopen('127.0.0.1', 8080, $errno, $error, 5);
$request = "GET " . $argv[1] . " HTTP/1.1\r\nHost: " . $argv[2] . "\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n" . $argv[3] . "\r\n";
fwrite($s, $request);
$reads = [];
$head = '';
while (!feof($s)) {
    $bytes = fread($s, 65536);
    if ($bytes === false || $bytes === '') continue;
    $reads[] = [microtime(true), strlen($bytes)];
    if (strpos($head, "\r\n\r\n") === false) $head .= $bytes;
}
echo json_encode(['reads' => $reads, 'head' => substr($head, 0, (int) strpos($head, "\r\n\r\n"))]);
`;

/**
 * A stand-in for the mail relay: a small PHP listener speaking just enough SMTP for msmtp, which
 * prints what it receives. msmtp itself is the real one, with the panel's own config file.
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

/** Inside the site's container, as root like the panel's reloads, or as the site's user. */
function inSite(command: string[], opts: { user?: string; input?: string | Buffer } = {}): Promise<Done> {
  const args = ['exec', ...(opts.input === undefined ? [] : ['-i']), ...(opts.user ? ['-u', opts.user] : []), SITE, ...command];
  return run('docker', args, opts.input);
}

const asSite = { user: '33:33' };

/** Runs in the site's own user's shell, as a plugin or the panel's shell job would. */
const shell = (script: string) => must(inSite(['sh', '-c', script], asSite), script);

async function writeInSite(file: string, content: string | Buffer): Promise<void> {
  await must(inSite(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], { ...asSite, input: content }), `writing ${file}`);
}

/** As the panel runs WP-CLI: services/wp.ts, asSiteUser. */
function wp(...args: string[]): Promise<string> {
  return must(dockerCli('exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', SITE, 'wp', ...args), `wp ${args.join(' ')}`);
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, everyMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Waited ${timeoutMs} ms for ${what}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Asking the site

interface AskOpts {
  method?: string;
  headers?: Record<string, string>;
  cookie?: string;
  agent?: string;
  /** A request body, sent as it is. */
  data?: string;
  /** 8080 is nginx. 80 is the Apache behind it, on the loopback. */
  port?: number;
  /** null sends no X-Forwarded-Proto. */
  proto?: string | null;
  host?: string;
  maxTime?: number;
  extraArgs?: string[];
}

class Answer {
  constructor(
    readonly status: number,
    private readonly headers: Map<string, string[]>,
    readonly raw: Buffer,
  ) {}

  get body() {
    return this.raw.toString('utf8');
  }

  get json() {
    return JSON.parse(this.body);
  }

  get(name: string): string | undefined {
    return this.headers.get(name)?.join(', ');
  }

  all(name: string): string[] {
    return this.headers.get(name) ?? [];
  }

  /** What nginx did with it. */
  get cache() {
    return this.get('x-cache-status');
  }

  get skipped() {
    return this.get('x-cache-skipped');
  }
}

function parseAnswer(output: Buffer): Answer {
  let rest = output;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    const head = (end === -1 ? rest : rest.subarray(0, end)).toString('latin1');
    const lines = head.split('\r\n');
    const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0);
    rest = end === -1 ? Buffer.alloc(0) : rest.subarray(end + 4);
    if (status >= 100 && status < 200 && status !== 101) continue;
    const headers = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).toLowerCase();
      headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
    }
    return new Answer(status, headers, rest);
  }
}

function curlArgs(url: string, opts: AskOpts): string[] {
  const args = ['curl', '-sS', '-i', '--http1.1', '--path-as-is', '--globoff', '--noproxy', '*', '--max-time', String(opts.maxTime ?? 60)];
  args.push('-H', `Host: ${opts.host ?? HOST}`);
  if (opts.proto !== null) args.push('-H', `X-Forwarded-Proto: ${opts.proto ?? 'https'}`);
  if (opts.agent) args.push('-A', opts.agent);
  if (opts.cookie) args.push('-H', `Cookie: ${opts.cookie}`);
  for (const [name, value] of Object.entries(opts.headers ?? {})) args.push('-H', `${name}: ${value}`);
  if (opts.method === 'HEAD') args.push('--head');
  else if (opts.method) args.push('-X', opts.method);
  if (opts.data !== undefined) args.push('--data-binary', opts.data);
  args.push(...(opts.extraArgs ?? []), `http://127.0.0.1:${opts.port ?? 8080}${url}`);
  return args;
}

async function ask(url: string, opts: AskOpts = {}): Promise<Answer> {
  const done = await inSite(curlArgs(url, opts));
  if (done.status !== 0) throw new Error(`curl ${url} failed (${done.status}): ${done.stderr}`);
  return parseAnswer(done.stdout);
}

/** What PHP says to nginx, seen before nginx hides it: Apache directly, told the page may be stored. */
const askPhpDirectly = (url: string, opts: AskOpts = {}) =>
  ask(url, { ...opts, port: 80, headers: { 'X-Wpl7-Cache': '1', ...opts.headers } });

/** How the panel will clear a page cache: nginx treats a missing file as a miss. */
const clearCache = () => shell(`find ${PAGE_CACHE_DIR_IN_CONTAINER} -type f -delete`);

/** Stored: the first request fills the cache, and the second gets the very same bytes. */
async function expectStored(url: string, opts: AskOpts = {}): Promise<Answer> {
  // A clear can land on the first one: the watcher on the root .htaccess goes by its own clock.
  let first = await ask(url, opts);
  if (first.skipped === 'cleared while rendering') first = await ask(url, opts);
  const second = await ask(url, opts);
  expect([first.cache, second.cache], `${url} (${first.status}, skipped: ${first.skipped})`).toEqual(['MISS', 'HIT']);
  expect(second.body).toBe(first.body);
  expect(first.skipped).toBeUndefined();
  return first;
}

/** Went to PHP both times, and nothing was kept. */
async function expectNotStored(url: string, reason: string | undefined, opts: AskOpts = {}): Promise<Answer> {
  const first = await ask(url, opts);
  const second = await ask(url, opts);
  expect([first.cache, second.cache], `${url} (${first.status}, skipped: ${first.skipped})`).toEqual(['MISS', 'MISS']);
  expect(first.skipped).toBe(reason);
  return first;
}

async function expectBypass(url: string, reason: string, opts: AskOpts = {}): Promise<Answer> {
  const answer = await ask(url, opts);
  expect([answer.cache, answer.skipped], `${url} (${answer.status})`).toEqual(['BYPASS', reason]);
  return answer;
}

// ---------------------------------------------------------------------------
// The site

const dockerService = new DockerService('none', 'none');
// Named here and made in beforeAll, so that a run with the test switched off leaves nothing behind.
const root = path.join(fs.realpathSync(os.tmpdir()), `wpl7-site-stack-${process.pid}`);
const config = {
  paths: { sites: path.join(root, 'sites'), plugins: path.join(root, 'plugins') },
  mariadb: { host: 'mariadb' },
  tlsMode: 'letsencrypt',
  acmeResolver: 'letsencrypt',
} as unknown as Config;
const site = {
  slug: SLUG,
  phpVersion: PHP,
  dbName: 'wp_engine',
  dbUser: 'wp_engine',
  dbPassword: DB_PASSWORD,
  containerName: SITE,
  tablePrefix: 'wp_',
};
const paths = sitePaths(config, SLUG);

interface RuntimeChoice {
  pageCache?: boolean;
  redis?: boolean;
  off?: string[];
  own?: CacheRule[];
  keepSeconds?: number;
  memoryMb?: number;
  cpus?: number | null;
  maxBodyMb?: number;
}

function writeFileWhole(file: string, content: string): void {
  const next = `${file}.next`;
  fs.writeFileSync(next, content, { mode: 0o644 });
  fs.renameSync(next, file);
}

/**
 * The runtime folder as the panel will write it (services/siteCaches.ts in a later stage): the
 * renderers' files, each replaced whole. Any warning a renderer gives is a mistake in this test.
 */
function writeRuntime(choice: RuntimeChoice = {}): void {
  const sizing = stackSizing(LIMITS);
  const memoryMb = choice.memoryMb ?? sizing.memoryMb;
  const cpus = choice.cpus === undefined ? sizing.cpus : choice.cpus;
  const rules = { off: choice.off ?? [], own: choice.own ?? OWN_RULES };
  const pageCache = choice.pageCache ?? true;
  const warn = (message: string) => {
    throw new Error(message);
  };
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileWhole(path.join(paths.runtimeDir, 'nginx-site.conf'), renderNginxSite({ pageCache, rules, warn, maxBodyMb: choice.maxBodyMb }));
  writeFileWhole(path.join(paths.runtimeDir, 'wp-cache.php'), renderWpCachePhp({ pageCache, keepSeconds: choice.keepSeconds ?? 3600, rules, warn }));
  writeFileWhole(path.join(paths.runtimeDir, 'php-fpm-pool.conf'), renderFpmPool(memoryMb, cpus));
  writeFileWhole(path.join(paths.runtimeDir, 'php.ini'), renderPhpIni(memoryMb));
  const redisConf = path.join(paths.runtimeDir, 'redis.conf');
  if (choice.redis) writeFileWhole(redisConf, renderRedisConf(memoryMb));
  else fs.rmSync(redisConf, { force: true });
}

type StackService = 'apache' | 'nginx' | 'php' | 'redis';

const reload = (service: StackService) => must(inSite(['wpl7-reload', service]), `wpl7-reload ${service}`);

/**
 * Docker Desktop's file sharing can show a replaced file's old size for a moment, and nginx then
 * refuses it for being short. A server's bind mount has no such delay. So a test waits until the
 * container sees what was written, before it applies it.
 */
async function seenByContainer(): Promise<void> {
  const here = fs.readdirSync(paths.runtimeDir).map((name) => {
    const hash = crypto.createHash('md5').update(fs.readFileSync(path.join(paths.runtimeDir, name))).digest('hex');
    return `${hash}  ${name}`;
  });
  await waitFor('the container to see the runtime files', async () => {
    const there = await inSite(['sh', '-c', 'cd /etc/wpl7-runtime && md5sum *']);
    return there.stdout.toString('utf8').trim().split('\n').sort().join('\n') === here.sort().join('\n');
  }, 15_000, 100);
}

/** The runtime folder as `choice` says, applied to the running container. */
async function apply(choice: RuntimeChoice, ...services: StackService[]): Promise<void> {
  writeRuntime(choice);
  await seenByContainer();
  for (const service of services) await reload(service);
}

/**
 * Redis on or off. Docker Desktop's file sharing can go on showing a removed file, or none yet, to a
 * test of that one path after a listing has shown otherwise, so wpl7-reload is asked until it has
 * happened. A server's bind mount has no such delay.
 */
async function redisTo(on: boolean): Promise<void> {
  writeRuntime(on ? { redis: true } : {});
  await seenByContainer();
  await waitFor(`Redis to ${on ? 'start' : 'stop'}`, async () => {
    await inSite(['wpl7-reload', 'redis']);
    return (await inSite(['test', '-S', REDIS_SOCKET_IN_CONTAINER])).status === (on ? 0 : 1);
  }, 15_000, 500);
}

/** What ensureSiteMountSources writes before a container is created, from the same renderers. */
function writeMountSources(): void {
  fs.mkdirSync(paths.wordpress, { recursive: true });
  fs.mkdirSync(paths.securityDir, { recursive: true });
  fs.mkdirSync(config.paths.plugins, { recursive: true });
  // The panel's default, with room for the 100 MB upload below.
  fs.writeFileSync(paths.uploadsIni, DEFAULT_UPLOADS_INI.replace(/64M/g, '200M'));
  fs.writeFileSync(paths.msmtprc, renderMsmtprc(mailLogin(SLUG), MAIL_PASSWORD), { mode: 0o644 });
  fs.writeFileSync(paths.securityApacheConf, renderApacheHardening({ blockPhpInUploads: true }), { mode: 0o644 });
  fs.writeFileSync(paths.securityWpPhp, renderWpConfigHardening({ disallowFileEdit: true, disallowFileMods: false }), { mode: 0o644 });
  writeRuntime();
}

/** Whether nginx answers, with a file, so that it says nothing about PHP. */
const siteAnswers = async () => (await inSite(['curl', '-fsS', '-o', '/dev/null', '--max-time', '2', '-H', `Host: ${HOST}`, 'http://127.0.0.1:8080/wp-includes/images/blank.gif'])).status === 0;

const logsOf = async (container: string) => {
  const done = await dockerCli('logs', container);
  return done.stdout.toString('utf8') + done.stderr;
};

/** Logs in through the real form, and returns the Cookie header a browser would then send. */
async function logIn(): Promise<string> {
  const jar = new Map<string, string>();
  const take = (answer: Answer) => {
    for (const line of answer.all('set-cookie')) {
      const pair = line.split(';')[0]!;
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
  };
  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  take(await ask('/wp-login.php'));
  const form = new URLSearchParams({ log: ADMIN, pwd: ADMIN_PASSWORD, 'wp-submit': 'Log In', redirect_to: '/wp-admin/', testcookie: '1' });
  const answer = await ask('/wp-login.php', { method: 'POST', cookie: header(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: form.toString() });
  expect(answer.status, answer.body.slice(0, 500)).toBe(302);
  take(answer);
  return header();
}

/** wpl7-start looks at the root .htaccess every 10 s, and a change empties the cache. */
const WATCHER_MS = 11_000;

/**
 * A root .htaccess with this on top, for as long as `during` runs, as someone would add it over
 * SFTP. The watcher's clear for putting it back is over before anything else runs.
 */
async function withRootHtaccess(extra: string, during: () => Promise<void>): Promise<void> {
  await writeInSite('/var/www/html/.htaccess', `${extra}\n${WORDPRESS_HTACCESS}`);
  try {
    await during();
  } finally {
    await writeInSite('/var/www/html/.htaccess', WORDPRESS_HTACCESS);
    await sleep(WATCHER_MS);
  }
}

const SEED = '/t/page/seed/';

/** A stored page, to see whether what comes next clears it. */
async function seed(): Promise<void> {
  await ask(SEED);
  expect((await ask(SEED)).cache).toBe('HIT');
}

async function expectClears(what: string, change: () => Promise<unknown>): Promise<void> {
  await seed();
  await change();
  expect((await ask(SEED)).cache, what).toBe('MISS');
}

async function expectKeeps(what: string, change: () => Promise<unknown>): Promise<void> {
  await seed();
  await change();
  expect((await ask(SEED)).cache, what).toBe('HIT');
}

describe.skipIf(!ENABLED)('a site on nginx, Apache and PHP-FPM', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    if (!process.env.WPL7_ENGINE_SITE_IMAGE) {
      await dockerService.buildImage(IMAGE, IMAGE_FOLDER, { PHP_TAG: `php${PHP}` });
    }

    // The site's network as the panel makes it: internal, with what the site must reach on it. The
    // way out is one of this test's own, because wpl7_egress may be in use by a stack on this Docker.
    await must(dockerCli('network', 'create', '--internal', SITE_NETWORK), 'site network');
    await must(dockerCli('network', 'create', '-o', 'com.docker.network.bridge.enable_icc=false', EGRESS_NETWORK), 'egress network');

    await must(dockerCli('run', '-d', '--name', DATABASE, '--network', SITE_NETWORK, '--network-alias', 'mariadb', '-e', 'MARIADB_ROOT_PASSWORD=engine-root', 'mariadb:11.4'), 'MariaDB');
    await waitFor('MariaDB', async () => (await dockerCli('exec', DATABASE, 'healthcheck.sh', '--connect', '--innodb_initialized')).status === 0, 120_000, 500);
    await must(
      run('docker', ['exec', '-i', DATABASE, 'mariadb', '-uroot', '-pengine-root'], `CREATE DATABASE wp_engine CHARACTER SET utf8mb4; CREATE USER 'wp_engine'@'%' IDENTIFIED BY '${DB_PASSWORD}'; GRANT ALL PRIVILEGES ON wp_engine.* TO 'wp_engine'@'%';`),
      'the site database',
    );
    await must(dockerCli('run', '-d', '--name', RELAY, '--network', SITE_NETWORK, '--network-alias', 'mail', '--entrypoint', 'php', IMAGE, '-r', STAND_IN_RELAY), 'the stand-in relay');

    writeMountSources();
    const spec = buildSiteContainerSpec(config, site, [HOST], { devDomain: 'dev.example.com', wildcardProvider: '' }, LIMITS, { stack: 2, image: IMAGE });
    await dockerService.createSiteContainer({ ...spec, networks: [SITE_NETWORK, EGRESS_NETWORK] });
    await dockerService.startContainer(SITE);

    // The first start copies WordPress into the empty folder before it starts anything.
    await waitFor('the site to answer', siteAnswers, 180_000, 500);
    // Owned by root when Docker or a test runner made it; a site's folder is its user's.
    await must(inSite(['chown', '33:33', '/var/www/html']), 'the folder');
    await wp('core', 'install', `--url=https://${HOST}`, '--title=Engine test', `--admin_user=${ADMIN}`, `--admin_password=${ADMIN_PASSWORD}`, '--admin_email=boss@example.com', '--skip-email');
    await wp('rewrite', 'structure', DEFAULT_PERMALINK_STRUCTURE);
    await writeInSite('/var/www/html/.htaccess', WORDPRESS_HTACCESS);
    await writeInSite('/var/www/html/wp-content/mu-plugins/wpl7-engine-test.php', TEST_PLUGIN);
    await wp('rewrite', 'flush');
    // The watcher has seen a new root .htaccess, and is about to clear.
    await sleep(WATCHER_MS);
    await clearCache();
  }, 1_200_000);

  afterAll(async () => {
    if (KEEP) {
      process.stderr.write(`Left running: docker rm -f -v ${SITE} ${DATABASE} ${RELAY}; docker network rm ${SITE_NETWORK} ${EGRESS_NETWORK}; rm -rf ${root}\n`);
      return;
    }
    // Files the container made may be its user's alone, so they are removed from in there.
    await inSite(['find', '/var/www/html', '-mindepth', '1', '-delete']);
    // -v: MariaDB's image and the site image's each make an anonymous volume.
    await dockerCli('rm', '-f', '-v', SITE, DATABASE, RELAY);
    await dockerCli('network', 'rm', SITE_NETWORK);
    await dockerCli('network', 'rm', EGRESS_NETWORK);
    fs.rmSync(root, { recursive: true, force: true });
  }, 180_000);

  describe('the container', () => {
    it("is what the panel's spec says", async () => {
      const [info] = JSON.parse(await must(dockerCli('inspect', SITE), 'inspect')) as {
        Config: { Labels: Record<string, string> };
        HostConfig: { Memory: number; NanoCpus: number; PidsLimit: number; CapDrop: string[]; SecurityOpt: string[] };
        Mounts: { Destination: string; RW: boolean }[];
      }[];
      expect(info!.Config.Labels[SITE_STACK_LABEL]).toBe('2');
      expect(info!.Config.Labels[`traefik.http.services.${SITE}.loadbalancer.server.port`]).toBe('8080');
      expect(info!.HostConfig.Memory).toBe(LIMITS.memoryBytes);
      expect(info!.HostConfig.PidsLimit).toBe(LIMITS.pidsLimit);
      expect(info!.HostConfig.CapDrop).toContain('NET_RAW');
      expect(info!.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(info!.Mounts.find((mount) => mount.Destination === '/etc/wpl7-runtime')?.RW).toBe(false);

      const [image] = JSON.parse(await must(dockerCli('image', 'inspect', IMAGE), 'image inspect')) as { Config: { Labels: Record<string, string> } }[];
      expect(image!.Config.Labels[SITE_STACK_LABEL]).toBe('2');
    });

    it('runs every service but Redis, under tini', async () => {
      const processes = (await must(inSite(['ps', '-eo', 'pid,comm']), 'ps')).split('\n').map((line) => line.trim());
      expect(processes.find((line) => line.startsWith('1 '))).toMatch(/tini/);
      for (const service of ['nginx', 'apache2', 'php-fpm']) expect(processes.some((line) => line.includes(service)), service).toBe(true);
      expect(processes.some((line) => line.includes('redis'))).toBe(false);
    });

    it('takes requests from the network on nginx, and only there', async () => {
      const fromNeighbour = (port: number) => dockerCli('exec', RELAY, 'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', '-H', `Host: ${HOST}`, `http://${SITE}:${port}/wp-includes/images/blank.gif`);
      expect((await fromNeighbour(8080)).stdout.toString()).toBe('200');
      expect((await fromNeighbour(80)).status).not.toBe(0);
      expect((await fromNeighbour(9000)).status).not.toBe(0);
    });

    it('loads wp-cache.php under WP-CLI too', async () => {
      expect(await wp('eval', "echo function_exists('wpl7_cache_boot') ? 'yes' : 'no';")).toBe('yes');
    });
  });

  describe('page cache: what is stored', () => {
    it('a real WordPress page: MISS, then HIT with the same bytes', async () => {
      // The first page of a new site saves its widgets, which counts as a change.
      await ask('/');
      await clearCache();
      for (const url of ['/', '/hello-world/', '/sample-page/', '/feed/', '/t/page/plain/']) await expectStored(url);
    });

    it('keeps X-Accel-Expires from the visitor, though PHP sends it', async () => {
      await clearCache();
      const miss = await ask('/t/page/expires/');
      const hit = await ask('/t/page/expires/');
      expect(miss.get('x-accel-expires')).toBeUndefined();
      expect(hit.get('x-accel-expires')).toBeUndefined();
      expect((await askPhpDirectly('/t/page/expires/')).get('x-accel-expires')).toBe('3600');
    });

    it('says nothing to a request nginx did not mark, so the panel asking Apache gets a plain page', async () => {
      const direct = await ask('/t/page/unmarked/', { port: 80 });
      expect(direct.status).toBe(200);
      expect(direct.get('x-accel-expires')).toBeUndefined();
      expect(direct.cache).toBeUndefined();
    });

    it('a 404 for 5 minutes, though WordPress says no-cache on every one, and the browser still hears it', async () => {
      const first = await expectStored('/no-such-page/');
      expect(first.status).toBe(404);
      expect(first.get('cache-control')).toMatch(/no-cache/);
      expect((await askPhpDirectly('/no-such-page/')).get('x-accel-expires')).toBe('300');
    });

    it('the canonical 301, with its Location unchanged', async () => {
      const first = await expectStored('/sample-page');
      expect(first.status).toBe(301);
      expect(first.get('location')).toBe(`https://${HOST}/sample-page/`);
    });

    it('a page that only says Vary: Accept-Encoding', async () => {
      await expectStored('/t/vary-encoding/x/');
    });

    it('a HEAD fills the cache as a GET would, and sends no body', async () => {
      const head = await ask('/t/page/head/', { method: 'HEAD' });
      expect([head.status, head.cache, head.raw.length]).toEqual([200, 'MISS', 0]);
      expect((await ask('/t/page/head/')).cache).toBe('HIT');
      expect((await ask('/t/page/head/', { method: 'HEAD' })).cache).toBe('HIT');
    });

    it('a page PHP can still hold whole: 5 MB, stored and complete', async () => {
      const first = await expectStored('/t/big/5/');
      expect(first.raw.length).toBe(5 * 1024 * 1024);
    });

    it('a stopped site never serves a page from before: every start empties the cache', async () => {
      await expectStored('/t/page/restart/');
      await must(dockerCli('restart', '-t', '20', SITE), 'restart');
      await waitFor('the site to answer', siteAnswers);
      expect((await ask('/t/page/restart/')).cache).toBe('MISS');
    });
  });

  describe('page cache: what goes past it', () => {
    const SKIPS: [string, string, AskOpts, string][] = [
      ['a logged-in cookie', '/t/echo/s1/', { cookie: 'wordpress_logged_in_abc=1' }, 'cookie wordpress_logged_in_'],
      ['a logged-in cookie after another', '/t/echo/s2/', { cookie: 'x=1; wordpress_logged_in_abc=1' }, 'cookie wordpress_logged_in_'],
      ['a post password', '/t/echo/s3/', { cookie: 'wp-postpass_abc=1' }, 'cookie wp-postpass_'],
      ['a comment author', '/t/echo/s4/', { cookie: 'comment_author_abc=me' }, 'cookie comment_author_'],
      ['a PHP session', '/t/echo/s5/', { cookie: 'PHPSESSID=abc' }, 'cookie PHPSESSID'],
      ['a POST', '/t/echo/s6/', { method: 'POST', data: 'a=1' }, 'method'],
      ['a PUT', '/t/echo/s7/', { method: 'PUT', data: 'a=1' }, 'method'],
      ['wp-admin', '/wp-admin/', {}, 'path /wp-admin/*'],
      ['wp-admin without its slash', '/wp-admin', {}, 'path /wp-admin/*'],
      ['wp-admin, encoded', '/%77p-admin/', {}, 'path /wp-admin/*'],
      ['wp-json', '/wp-json/', {}, 'path /wp-json/*'],
      ['a query string', '/t/echo/s8/?s=word', {}, 'query string'],
      ['add-to-cart', '/t/echo/s9/?add-to-cart=12', {}, 'query string'],
      ['Authorization', '/t/echo/s10/', { headers: { Authorization: 'Basic eDp5' } }, 'authorization'],
      ['the probe user agent', '/t/echo/s11/', { agent: PROBE }, `agent ${PROBE}`],
      ['a file', '/wp-includes/js/jquery/jquery.min.js', {}, 'file'],
      ['a PHP script', '/wp-login.php', {}, 'file'],
      ['xmlrpc', '/xmlrpc.php', {}, 'file'],
      ['a folder under wp-content', '/wp-content/uploads/', {}, 'path /wp-content/*'],
      ['a websocket upgrade', '/t/echo/s12/', { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }, 'upgrade'],
      ['an XMLHttpRequest', '/t/echo/s13/', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }, 'ajax'],
      ['PJAX', '/t/echo/s14/', { headers: { 'X-PJAX': 'true' } }, 'ajax'],
      ['htmx', '/t/echo/s15/', { headers: { 'HX-Request': 'true' } }, 'ajax'],
      ['a Turbo frame', '/t/echo/s16/', { headers: { 'Turbo-Frame': 'main' } }, 'ajax'],
      ['another site asking', '/t/echo/s17/', { headers: { Origin: 'https://elsewhere.example.net' } }, 'ajax'],
      ['Range', '/t/echo/s18/', { headers: { Range: 'bytes=0-9' } }, 'range'],
      ['a GET with a body', '/t/echo/s19/', { method: 'GET', data: 'a=1' }, 'body'],
    ];

    it.each(SKIPS)('%s', async (_name, url, opts, reason) => {
      await expectBypass(url, reason, opts);
    });

    it('tells PHP nothing may be stored, whatever a visitor sends', async () => {
      const answer = await expectBypass('/t/echo/spoof/', 'cookie wordpress_no_cache', { cookie: 'wordpress_no_cache=1', headers: { 'X-Wpl7-Cache': '1' } });
      expect(answer.json.headers).not.toHaveProperty('x-wpl7-cache');
      expect(answer.get('x-accel-expires')).toBeUndefined();
    });

    it('passes a skipped request on as it came', async () => {
      const answer = await expectBypass('/t/echo/caf%C3%A9/./x/../y?utm_source=x&s=1', 'query string');
      expect(answer.json.uri).toBe('/t/echo/caf%C3%A9/./x/../y?utm_source=x&s=1');
    });
  });

  describe('page cache: what is refused by the page', () => {
    const REFUSALS: [string, string, number, string][] = [
      ['no-cache headers', '/t/nocache/x/', 200, 'page says no-cache'],
      ['DONOTCACHEPAGE', '/t/donotcache/x/', 200, 'DONOTCACHEPAGE'],
      ['a cookie being set', '/t/cookie/x/', 200, 'page sets a cookie'],
      ['Vary on anything else', '/t/vary/x/', 200, 'page varies by cookie'],
      ['a 302', '/t/redirect/x/', 302, 'status 302'],
      ['a 500', '/t/status500/x/', 500, 'status 500'],
      ['a fatal error', '/t/fatal/x/', 500, 'status 500'],
      ['an early flush', '/t/flush/x/', 200, 'page flushed early'],
      ['a CGI Status header, which PHP-FPM obeys and http_response_code() never hears: 503', '/t/status-header/503/', 503, 'status 503'],
      ['a CGI Status header: 403', '/t/status-header/403/', 403, 'status 403'],
      ['a missing file, so one uploaded after it is live at once', '/no-such-file.txt', 404, 'missing file'],
      ['another missing file', '/no-such-file.html', 404, 'missing file'],
    ];

    it.each(REFUSALS)('%s', async (_name, url, status, reason) => {
      const first = await expectNotStored(url, reason);
      expect(first.status).toBe(status);
    });

    it('a page bigger than the buffer, which also counts as flushing early, arrives whole', async () => {
      const first = await expectNotStored('/t/big/10/', 'page flushed early');
      expect(first.raw.length).toBe(10 * 1024 * 1024);
    });

    it('a no-cache from a layer after PHP: a .htaccess Header line', async () => {
      // Its own script, because a rewrite to the root's index.php would leave this folder's rules behind.
      await writeInSite('/var/www/html/t/later/index.php', "<?php require '/var/www/html/index.php';");
      await writeInSite('/var/www/html/t/later/.htaccess', 'Header set Cache-Control "no-store"\n');
      const direct = await askPhpDirectly('/t/later/');
      expect([direct.get('x-accel-expires'), direct.get('cache-control')]).toEqual(['3600', 'no-store']);
      await expectNotStored('/t/later/', LATER_LAYER);
    });

    it.each<[string, string, string]>([
      ['Vary: Cookie', 'vary-cookie', 'Header append Vary Cookie'],
      ['Vary: User-Agent', 'vary-agent', 'Header append Vary User-Agent'],
      ['Expires in the past', 'expires', 'Header set Expires "Thu, 01 Jan 1970 00:00:00 GMT"'],
      ['Pragma: no-cache', 'pragma', 'Header set Pragma no-cache'],
    ])('%s from a layer after PHP', async (_name, folder, line) => {
      await writeInSite(`/var/www/html/t/${folder}/index.php`, "<?php require '/var/www/html/index.php';");
      await writeInSite(`/var/www/html/t/${folder}/.htaccess`, `${line}\n`);
      expect((await askPhpDirectly(`/t/${folder}/`)).get('x-accel-expires')).toBe('3600');
      await expectNotStored(`/t/${folder}/`, LATER_LAYER);
    });

    it('a later layer saying something harmless changes nothing', async () => {
      await writeInSite('/var/www/html/t/later-ok/index.php', "<?php require '/var/www/html/index.php';");
      await writeInSite('/var/www/html/t/later-ok/.htaccess', 'Header set Cache-Control "public, max-age=60"\nHeader set Expires "Wed, 11 Jan 2034 05:00:00 GMT"\n');
      await expectStored('/t/later-ok/');
    });

    it('a visitor only WordPress knows is logged in: a custom login, with a cookie nginx has no rule for', async () => {
      // Logged in from init, WordPress itself says no-cache. Logged in later, only wp-cache.php can tell.
      await writeInSite(
        '/var/www/html/wp-content/mu-plugins/wpl7-engine-login.php',
        `<?php
if (strpos($_SERVER['REQUEST_URI'] ?? '', '/t/login-early/') === 0) add_action('init', function () { wp_set_current_user(1); });
if (strpos($_SERVER['REQUEST_URI'] ?? '', '/t/login-late/') === 0) add_action('template_redirect', function () { wp_set_current_user(1); }, 1);
`,
      );
      try {
        await expectNotStored('/t/login-early/x/', 'page says no-cache');
        await expectNotStored('/t/login-late/x/', 'logged in');
      } finally {
        await shell('rm -f /var/www/html/wp-content/mu-plugins/wpl7-engine-login.php');
      }
    });
  });

  describe('page cache: files', () => {
    it('a file written straight to disk is live at once', async () => {
      await shell('printf one > /var/www/html/live.html');
      const first = await ask('/live.html');
      expect([first.status, first.body, first.cache]).toEqual([200, 'one', 'MISS']);
      await shell('printf two > /var/www/html/live.html');
      const second = await ask('/live.html');
      expect([second.status, second.body, second.cache]).toEqual([200, 'two', 'MISS']);
    });

    it('a file asked for too early, and uploaded after that, is live at once', async () => {
      const file = `/verify-${Date.now()}.txt`;
      expect((await ask(file)).status).toBe(404);
      await shell(`printf found > /var/www/html${file}`);
      const found = await ask(file);
      expect([found.status, found.body]).toEqual([200, 'found']);
      await shell(`rm -f /var/www/html${file}`);
    });

    it('a PHP script of its own is never stored: only a WordPress page says it may be', async () => {
      await writeInSite('/var/www/html/own-page/index.php', '<?php echo microtime(true);');
      const first = await ask('/own-page/');
      const second = await ask('/own-page/');
      expect([first.cache, second.cache]).toEqual(['MISS', 'MISS']);
      expect(second.body).not.toBe(first.body);
    });

    it('it has the Referer and any header of its own, though it stands where a stored page could', async () => {
      await writeInSite('/var/www/html/own-app/index.php', "<?php header('Content-Type: application/json'); echo json_encode([$_SERVER['HTTP_REFERER'] ?? '', $_SERVER['HTTP_X_API_KEY'] ?? '']);");
      const answer = await ask('/own-app/', { headers: { Referer: 'https://elsewhere.example.net/', 'X-Api-Key': 'key' } });
      expect(answer.cache).toBe('MISS');
      expect(answer.json).toEqual(['https://elsewhere.example.net/', 'key']);
    });
  });

  describe('page cache: clearing', () => {
    it('deleting the cache files as the panel will', async () => {
      const first = await expectStored('/t/page/clear/');
      await clearCache();
      const after = await ask('/t/page/clear/');
      expect(after.cache).toBe('MISS');
      expect(after.body).not.toBe(first.body);
      expect((await ask('/t/page/clear/')).cache).toBe('HIT');
    });

    it('the files are www-data’s, so a clear from WordPress or WP-CLI can delete them', async () => {
      await seed();
      const owners = await must(inSite(['sh', '-c', `find ${PAGE_CACHE_DIR_IN_CONTAINER} -type f -printf '%u\\n' | sort -u`]), 'owners');
      expect(owners).toBe('www-data');
    });

    it('publishing through WP-CLI', async () => {
      await expectClears('wp post create --post_status=publish', () => wp('post', 'create', '--post_title=By WP-CLI', '--post_status=publish'));
    });

    it('publishing through wp-admin: logged in with curl, the real form posted', async () => {
      const cookie = await logIn();
      const editor = await ask('/wp-admin/post-new.php', { cookie });
      expect(editor.status).toBe(200);
      const nonce = /name="_wpnonce" value="([0-9a-f]+)"/.exec(editor.body)?.[1];
      const postId = /name=['"]post_ID['"] value=['"](\d+)['"]/.exec(editor.body)?.[1];
      expect(nonce, 'the form has a nonce').toBeTruthy();
      expect(postId, 'the form has a post').toBeTruthy();
      await seed();
      const form = new URLSearchParams({ _wpnonce: nonce!, post_ID: postId!, action: 'editpost', originalaction: 'editpost', post_type: 'post', post_title: 'By wp-admin', content: 'Words.', publish: 'Publish' });
      const saved = await ask('/wp-admin/post.php', { method: 'POST', cookie, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: form.toString() });
      expect(saved.status, saved.body.slice(0, 300)).toBe(302);
      expect(await wp('post', 'get', postId!, '--field=post_status')).toBe('publish');
      // The redirect can reach curl just before PHP has finished its shutdown, where the clear is.
      await waitFor('the clear', async () => (await ask(SEED)).cache === 'MISS', 5_000);
    });

    it('the Clear cache button in the admin bar', async () => {
      const cookie = await logIn();
      const admin = await expectBypass('/wp-admin/', 'path /wp-admin/*', { cookie });
      const link = /id=['"]wp-admin-bar-wpl7-clear-cache['"][^>]*>\s*<a[^>]*href=['"]([^'"]+)['"][^>]*>Clear cache</.exec(admin.body)?.[1];
      expect(link, 'the admin bar has the button').toBeTruthy();
      const target = new URL(link!.replace(/&amp;/g, '&').replace(/#038;/g, ''));
      await seed();
      const clicked = await ask(target.pathname + target.search, { cookie, headers: { Referer: `https://${HOST}/wp-admin/edit.php` } });
      expect(clicked.status).toBe(302);
      expect(clicked.get('location')).toContain('wpl7_cache_cleared=1');
      expect((await ask(SEED)).cache).toBe('MISS');

      await seed();
      const noNonce = await ask('/wp-admin/admin-post.php?action=wpl7_clear_cache', { cookie });
      expect(noNonce.status).toBe(403);
      await ask(target.pathname + target.search);
      expect((await ask(SEED)).cache, 'a visitor with the link clears nothing').toBe('HIT');
    });

    it('a change to a post, through WP-CLI, only when visitors can see it', async () => {
      const id = await wp('post', 'create', '--post_title=Draft', '--post_status=draft', '--porcelain');
      await expectKeeps('editing a draft', () => wp('post', 'update', id, '--post_title=Draft 2'));
      await expectClears('publishing it', () => wp('post', 'update', id, '--post_status=publish'));
      await expectClears('editing it', () => wp('post', 'update', id, '--post_title=Published 2'));
      await expectClears('unpublishing it', () => wp('post', 'update', id, '--post_status=draft'));
      await expectClears('republishing it', () => wp('post', 'update', id, '--post_status=publish'));
      await expectClears('trashing it', () => wp('post', 'delete', id));
      await expectKeeps('deleting it from the trash', () => wp('post', 'delete', id, '--force'));
      await expectKeeps('a draft template part', () => wp('post', 'create', '--post_type=wp_template_part', '--post_title=Part', '--post_status=draft'));
      await expectClears('a published template', () => wp('post', 'create', '--post_type=wp_template', '--post_title=Template', '--post_status=publish'));
      await expectClears('a published synced pattern', () => wp('post', 'create', '--post_type=wp_block', '--post_title=Pattern', '--post_status=publish'));
      await expectKeeps('a published post of a type with no pages', () => wp('post', 'create', '--post_type=nav_menu_item', '--post_title=Item', '--post_status=publish'));
    });

    it('comments, only approved ones', async () => {
      const post = await wp('post', 'list', '--name=hello-world', '--field=ID');
      let comment = '';
      await expectKeeps('an unapproved comment', async () => {
        comment = await wp('comment', 'create', `--comment_post_ID=${post}`, '--comment_content=One', '--comment_approved=0', '--porcelain');
      });
      await expectKeeps('a spam comment', () => wp('comment', 'create', `--comment_post_ID=${post}`, '--comment_content=Two', '--comment_approved=spam', '--porcelain'));
      await expectClears('approving one', () => wp('comment', 'approve', comment));
      await expectClears('editing an approved one', () => wp('comment', 'update', comment, '--comment_content=Three'));
      await expectClears('unapproving one', () => wp('comment', 'unapprove', comment));
      await expectClears('an approved one created', async () => {
        comment = await wp('comment', 'create', `--comment_post_ID=${post}`, '--comment_content=Four', '--comment_approved=1', '--porcelain');
      });
      await expectClears('deleting an approved one', () => wp('comment', 'delete', comment, '--force'));
    });

    it('terms, menus, options and plugins', async () => {
      let term = '';
      await expectClears('a new term', async () => {
        term = await wp('term', 'create', 'category', 'Fresh', '--porcelain');
      });
      await expectClears('editing a term', () => wp('term', 'update', 'category', term, '--name=Fresher'));
      await expectClears('deleting a term', () => wp('term', 'delete', 'category', term));
      await expectClears('a menu', () => wp('menu', 'create', 'Main'));
      await expectClears('a menu deleted', () => wp('menu', 'delete', 'Main'));
      await expectClears('wp option update', () => wp('option', 'update', 'blogdescription', 'Words'));
      await expectClears('wp option add', () => wp('option', 'add', 'wpl7t_option', '1'));
      await expectClears('wp option delete', () => wp('option', 'delete', 'wpl7t_option'));
      await expectClears('a plugin activated', () => wp('plugin', 'activate', 'hello'));
      await expectClears('a plugin deactivated', () => wp('plugin', 'deactivate', 'hello'));
      await expectClears('widgets', () => wp('option', 'update', 'sidebars_widgets', '{"wp_inactive_widgets":[]}', '--format=json'));
      await expectClears('a theme switched', async () => {
        const themes = (await wp('theme', 'list', '--status=inactive', '--field=name')).split('\n');
        await wp('theme', 'activate', themes[0]!);
      });
    });

    it('nothing that only reads, or that the panel runs by itself', async () => {
      await expectKeeps('a transient', () => wp('transient', 'set', 'wpl7t', 'x', '3600'));
      await expectKeeps('wp option get', () => wp('option', 'get', 'blogname'));
      await expectKeeps('wp plugin list', () => wp('plugin', 'list'));
      await expectKeeps('wp post list', () => wp('post', 'list'));
      await expectKeeps('wp cron with nothing due', () => wp('cron', 'event', 'run', '--due-now'));
      await writeInSite('/var/www/html/wp-content/mu-plugins/wpl7-engine-cron.php', `<?php add_action('wpl7t_event', function () { update_option('wpl7t_cron', time()); });\n`);
      await wp('cron', 'event', 'schedule', 'wpl7t_event', 'now');
      await expectKeeps('wp cron running a task that writes an option', () => wp('cron', 'event', 'run', '--due-now'));
      await shell('rm -f /var/www/html/wp-content/mu-plugins/wpl7-engine-cron.php');
    });

    // These plugins aren't installed here. The action names were read in their code, and the
    // versions are on the watchlist. What this shows is that each name is listened to.
    it.each([
      'after_rocket_clean_domain',
      'after_rocket_clean_cache_dir',
      'after_rocket_clean_minify',
      'w3tc_flush_all',
      'w3tc_flush_posts',
      'w3tc_flush_after_minify',
      'wp_cache_cleared',
      'litespeed_purged_all',
      'litespeed_purged_all_lscache',
      'litespeed_purged_all_cssjs',
      'autoptimize_action_cachepurged',
      'elementor/core/files/clear_cache',
    ])('another cache plugin’s clear, fired with do_action: %s', async (hook) => {
      await expectClears(hook, () => wp('eval', `do_action('${hook}');`));
    });

    it('an action nobody listens to clears nothing', async () => {
      await expectKeeps('do_action of something else', () => wp('eval', "do_action('wpl7t_other');"));
    });

    it('a page being drawn when the cache is cleared is not stored: what it read may be gone', async () => {
      const id = await wp('post', 'create', '--post_title=Racy', '--post_name=racy-page', '--post_status=publish', '--post_content=WPL7T-SLOW RETRACTED-WORDS', '--porcelain');
      await wp('rewrite', 'flush');
      await clearCache();
      const inFlight = ask('/racy-page/');
      await sleep(1_000);
      await wp('post', 'update', id, '--post_status=draft');
      const answer = await inFlight;
      expect([answer.status, answer.cache, answer.skipped]).toEqual([200, 'MISS', 'cleared while rendering']);
      const next = await ask('/racy-page/');
      expect(next.status).toBe(404);
      expect(next.body).not.toContain('RETRACTED-WORDS');
      await wp('post', 'delete', id, '--force');
    });

    it('whoever cleared: the panel only deletes the files', async () => {
      const id = await wp('post', 'create', '--post_title=Racy two', '--post_name=racy-two', '--post_status=publish', '--post_content=WPL7T-SLOW', '--porcelain');
      await clearCache();
      const inFlight = ask('/racy-two/');
      await sleep(1_000);
      await clearCache();
      const answer = await inFlight;
      expect([answer.cache, answer.skipped]).toEqual(['MISS', 'cleared while rendering']);
      await expectStored('/racy-two/');
      await wp('post', 'delete', id, '--force');
    });

    it('nginx leaves the mark alone, and it does not count as a page', async () => {
      await clearCache();
      await seed();
      const names = (await must(inSite(['sh', '-c', `cd ${PAGE_CACHE_DIR_IN_CONTAINER} && find . -maxdepth 1 -type f`]), 'the folder')).split('\n');
      expect(names).toEqual(['./generation.0000000000']);
    });

    it('a visitor’s approved comment clears, but once a minute at most, and one in between catches up', async () => {
      const post = await wp('post', 'list', '--name=hello-world', '--field=ID');
      // The default comment makes this identity one that has been approved before.
      const comment = (text: string) =>
        ask('/wp-comments-post.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: new URLSearchParams({ comment_post_ID: post, author: 'A WordPress Commenter', email: 'wapuu@wordpress.example', comment: text }).toString(),
        });
      await must(inSite(['sh', '-c', 'rm -f /run/wpl7/comment-clear /run/wpl7/comment-clear.waiting']), 'the stamp');
      await sleep(16_000); // WordPress's own flood check
      await seed();
      expect((await comment('The first one.')).status).toBe(302);
      await waitFor('the clear', async () => (await ask(SEED)).cache === 'MISS', 5_000);

      await sleep(16_000);
      await seed();
      expect((await comment('The second one.')).status).toBe(302);
      await sleep(500);
      expect((await ask(SEED)).cache, 'within the minute').toBe('HIT');

      await must(inSite(['touch', '-d', '2 minutes ago', '/run/wpl7/comment-clear']), 'the minute passing');
      await ask('/t/page/after-the-minute/', { cookie: 'wordpress_no_cache=1' });
      await waitFor('the clear', async () => (await ask(SEED)).cache === 'MISS', 5_000);
    }, 120_000);
  });

  describe('page cache: a visitor with a cookie', () => {
    it('an unknown cookie gets a HIT, but cannot store (design change 4)', async () => {
      const url = '/t/page/unknown-cookie/';
      const opts = { cookie: 'session_id=abc' };
      await expectNotStored(url, undefined, opts);
      const stored = await expectStored(url);
      const hit = await ask(url, opts);
      expect(hit.cache).toBe('HIT');
      expect(hit.body).toBe(stored.body);
    });

    it('harmless cookies may store and share a copy', async () => {
      const url = '/t/page/harmless-cookie/';
      const first = await ask(url, { cookie: '_ga=GA1.2.3; _ga_ABC=1; wp-settings-1=x; wp-settings-time-1=2; wordpress_test_cookie=WP%20Cookie%20check' });
      const second = await ask(url);
      expect([first.cache, second.cache]).toEqual(['MISS', 'HIT']);
    });

    it.each(['_gateway_session', '_hjMember', '_gid_member', '_fbp_login', '_ga_member'])('a member cookie that only starts like an analytics one stores nothing: %s', async (name) => {
      await clearCache();
      const member = await ask('/t/member/x/', { cookie: `${name}=alice` });
      expect(member.body).toContain('PRIVATE PAGE');
      const anyone = await ask('/t/member/x/');
      expect([anyone.cache, anyone.body.includes('PRIVATE PAGE')]).toEqual(['MISS', false]);
    });

    it.each(['CookieConsent', 'cmplz_marketing'])('a consent cookie stores nothing, as PHP can draw by it: %s', async (name) => {
      await clearCache();
      expect((await ask('/t/member/x/', { cookie: `${name}=allow` })).body).toContain('PRIVATE PAGE');
      expect((await ask('/t/member/x/')).body).not.toContain('PRIVATE PAGE');
      // And it can read what another stored.
      expect((await ask('/t/member/x/', { cookie: `${name}=allow` })).cache).toBe('HIT');
    });

    it('two Cookie lines: PHP reads what the key says, not what Apache would make of them', async () => {
      await clearCache();
      const url = '/t/echo/two-lines/';
      const both = await ask(url, { extraArgs: ['-H', 'Cookie: wmc_current_currency=EUR', '-H', 'Cookie: _ga=1'] });
      expect(both.cache).toBe('MISS');
      expect(both.json.headers.cookie).toBe('wmc_current_currency=EUR; _ga=1');
      expect(both.json.cookies).toEqual({ wmc_current_currency: 'EUR', _ga: '1' });
      const honest = await ask(url, { cookie: 'wmc_current_currency=EUR' });
      expect([honest.cache, honest.json.n]).toEqual(['HIT', both.json.n]);
    });

    it('a space before the semicolon, which PHP keeps in the value, is no token', async () => {
      const answer = await expectBypass('/t/echo/space-cookie/', SEPARATE_COPY, { cookie: 'wmc_current_currency=USD ; _ga=1' });
      expect(answer.json.cookies.wmc_current_currency).toBe('USD ');
    });

    it('a tab before the first cookie, which PHP skips, is still that cookie', async () => {
      await clearCache();
      const url = '/t/echo/tab-cookie/';
      const usd = await ask(url, { extraArgs: ['-H', 'Cookie: \twmc_current_currency=USD'] });
      expect(usd.json.cookies.wmc_current_currency).toBe('USD');
      const none = await ask(url);
      expect(none.cache, 'the visitor with no cookie gets a copy of their own').toBe('MISS');
      expect(none.json.cookies).toEqual({});
    });

    it('`_ga; session=1` does not pass session off as harmless', async () => {
      const url = '/t/page/no-value-cookie/';
      const first = await ask(url, { cookie: '_ga; session=1' });
      const second = await ask(url);
      expect([first.cache, second.cache]).toEqual(['MISS', 'MISS']);
    });
  });

  /** A page kept for 2 s has expired by now. nginx counts in whole seconds, and `valid < now` is strict. */
  const pastKeepTime = () => sleep(3_200);

  describe('page cache: under trouble', () => {
    const SHORT = '/t/keep2/';

    it('an expired page is drawn again for whoever asks next, and the rest go on as before', async () => {
      const url = `${SHORT}slow/`;
      const other = `${SHORT.replace('keep2', 'page')}other/`;
      await expectStored(other);
      const first = await ask(url);
      expect(first.cache).toBe('MISS');
      const hit = await ask(url);
      expect([hit.cache, hit.body]).toEqual(['HIT', first.body]);
      await pastKeepTime();
      const refreshing = ask(url);
      await sleep(1_000);
      const started = Date.now();
      expect((await ask(other)).cache).toBe('HIT');
      expect(Date.now() - started, 'someone else’s refresh holds nobody up').toBeLessThan(2_000);
      const fresh = await refreshing;
      expect(fresh.cache).toBe('EXPIRED');
      expect(fresh.body).not.toBe(first.body);
      const next = await ask(url);
      expect([next.cache, next.body]).toEqual(['HIT', fresh.body]);
    });

    it('a stored page after PHP goes away is served stale, and the panel’s probe sees the failure', async () => {
      const url = `${SHORT}php-gone/`;
      const first = await ask(url);
      expect(first.cache).toBe('MISS');
      await pastKeepTime();
      await must(inSite(['mv', FPM_SOCKET_IN_CONTAINER, `${FPM_SOCKET_IN_CONTAINER}.away`]), 'moving the socket');
      try {
        const stale = await ask(url);
        expect([stale.status, stale.cache, stale.body]).toEqual([200, 'STALE', first.body]);
        const again = await ask(url);
        expect([again.status, again.cache, again.body]).toEqual([200, 'STALE', first.body]);

        const probe = await ask(url, { agent: PROBE });
        expect([probe.status, probe.cache, probe.skipped]).toEqual([503, 'BYPASS', `agent ${PROBE}`]);

        const neverStored = await ask('/t/page/php-gone-never-stored/');
        expect(neverStored.status).toBe(503);
      } finally {
        await must(inSite(['mv', `${FPM_SOCKET_IN_CONTAINER}.away`, FPM_SOCKET_IN_CONTAINER]), 'putting the socket back');
      }
      await waitFor('the page to come back', async () => {
        const next = await ask(url);
        return next.cache === 'HIT' && next.body !== first.body;
      }, 5_000, 100);
    });

    it('the same with the database gone: WordPress answers 500', async () => {
      const url = `${SHORT}db-gone/`;
      const first = await ask(url);
      expect(first.cache).toBe('MISS');
      await pastKeepTime();
      await must(dockerCli('stop', '-t', '2', DATABASE), 'stopping MariaDB');
      try {
        const stale = await ask(url);
        expect([stale.status, stale.cache, stale.body]).toEqual([200, 'STALE', first.body]);
        const probe = await ask(url, { agent: PROBE });
        expect([probe.status, probe.cache]).toEqual([500, 'BYPASS']);
      } finally {
        await must(dockerCli('start', DATABASE), 'starting MariaDB');
        await waitFor('MariaDB', async () => (await dockerCli('exec', DATABASE, 'healthcheck.sh', '--connect', '--innodb_initialized')).status === 0, 60_000, 500);
      }
      await waitFor('the page to come back', async () => {
        const next = await ask(url);
        return next.cache === 'HIT' && next.body !== first.body;
      }, 10_000, 200);
    });

    it('an expired page whose refresh is refused is gone at once: nginx does not go on serving the old one', async () => {
      const url = '/t/toggle/refused/';
      const flag = '/var/www/html/wp-content/wpl7t-toggle';
      const first = await ask(url);
      expect(first.cache).toBe('MISS');
      await shell(`touch ${flag}`);
      try {
        await pastKeepTime();
        const refused = await ask(url);
        expect([refused.cache, refused.skipped]).toEqual(['EXPIRED', 'page sets a cookie']);
        expect(refused.body).not.toBe(first.body);
        const again = await ask(url);
        expect(again.body).not.toBe(first.body);
      } finally {
        await shell(`rm -f ${flag}`);
      }
    });
  });

  describe('a site that says who may see it', () => {
    const allowed = { headers: { 'X-Forwarded-For': '203.0.113.7' } };
    const stranger = { headers: { 'X-Forwarded-For': '198.51.100.9' } };
    const LIMITED = '.htaccess limits who can see this';

    it.each<[string, string, number]>([
      ['Require ip', 'Require ip 203.0.113.7', 403],
      ['a nested Require ip', '<RequireAny>\nRequire ip 203.0.113.7\nRequire ip 203.0.113.8\n</RequireAny>', 403],
      ['Basic auth or an address', 'AuthType Basic\nAuthName "x"\nAuthUserFile /nonexistent\n<RequireAny>\nRequire ip 203.0.113.7\nRequire valid-user\n</RequireAny>', 401],
      ['Allow from, as Apache 2.2 said it', 'Order deny,allow\nDeny from all\nAllow from 203.0.113.7', 403],
      ['a rewrite on the address', 'RewriteEngine On\nRewriteCond %{REMOTE_ADDR} !^203\\.0\\.113\\.7$\nRewriteRule ^ - [F]', 403],
    ])('%s: the first visitor let through stores nothing for the others', async (_name, rule, refused) => {
      await withRootHtaccess(rule, async () => {
        await clearCache();
        const url = '/t/page/limited/';
        expect((await ask(url, stranger)).status).toBe(refused);
        const inside = await ask(url, allowed);
        expect([inside.status, inside.cache, inside.skipped]).toEqual([200, 'MISS', LIMITED]);
        const after = await ask(url, stranger);
        expect(after.status).toBe(refused);
        expect(after.body).not.toContain('Some text');
      });
    });

    it.each<[string, string]>([
      ['a password on wp-login.php alone', '<Files wp-login.php>\nAuthType Basic\nAuthName "x"\nAuthUserFile /nonexistent\nRequire valid-user\n</Files>'],
      ['a ban list', 'Order allow,deny\nAllow from all\nDeny from 192.0.2.1\n<RequireAll>\nRequire all granted\nRequire not ip 198.51.100.7\n</RequireAll>'],
      ['an address on xmlrpc.php alone', '<FilesMatch "^xmlrpc\\.php$">\nRequire ip 203.0.113.7\n</FilesMatch>'],
    ])('%s leaves every other page public, and stored', async (_name, rule) => {
      await withRootHtaccess(rule, async () => {
        await clearCache();
        await expectStored('/t/page/not-limited/');
      });
    });

    it('a lock added over SFTP reaches stored pages within seconds, and an expired one refuses at once', async () => {
      const url = '/t/keep2/locked/';
      const stored = '/t/page/stored-before-the-lock/';
      await expectStored(stored);
      const page = await ask(url);
      expect(page.status).toBe(200);
      await withRootHtaccess('AuthType Basic\nAuthName "x"\nAuthUserFile /nonexistent\nRequire valid-user', async () => {
        await pastKeepTime();
        const expired = await ask(url);
        expect(expired.status).toBe(401);
        expect(expired.body).not.toContain('Some text');
        const probe = await ask(stored, { agent: PROBE });
        expect(probe.status).toBe(401);
        await waitFor('the watcher to clear', async () => (await ask(stored)).status === 401, WATCHER_MS + 2_000, 500);
      });
    });

    it('so does any other rule added to that file', async () => {
      const url = '/t/page/before-a-rule/';
      await expectStored(url);
      await withRootHtaccess('RewriteEngine On\nRewriteRule .* - [R=503,L]', async () => {
        await waitFor('the watcher to clear', async () => (await ask(url)).status === 503, WATCHER_MS + 2_000, 500);
      });
    });

    it('the same file written again clears nothing: some plugins do that all the time', async () => {
      const url = '/t/page/same-file/';
      await expectStored(url);
      await writeInSite('/var/www/html/.htaccess', WORDPRESS_HTACCESS);
      await sleep(WATCHER_MS);
      expect((await ask(url)).cache).toBe('HIT');
    });
  });

  describe('page cache: Off and bad files', () => {
    it('Off: everything goes straight through, reloaded in place', async () => {
      await expectStored('/t/page/off/');
      await apply({ pageCache: false }, 'nginx');
      const off = await expectBypass('/t/echo/off/?utm_source=x&s=1', 'off');
      expect(off.json.uri).toBe('/t/echo/off/?utm_source=x&s=1');
      expect(off.json.headers).not.toHaveProperty('x-wpl7-cache');
      expect(off.json.serverVars, 'the file with the cache off still clears these').toEqual([]);
      expect((await ask('/t/page/off/')).cache).toBe('BYPASS');
      await apply({}, 'nginx');
      await clearCache();
      await expectStored('/t/page/off/');
    });

    it('a file nginx refuses leaves what runs alone, and says so', async () => {
      await expectStored('/t/page/bad-file/');
      writeFileWhole(path.join(paths.runtimeDir, 'nginx-site.conf'), 'this is not a config;\n');
      await seenByContainer();
      const refused = await inSite(['wpl7-reload', 'nginx']);
      expect(refused.status).not.toBe(0);
      expect((await ask('/t/page/bad-file/')).cache).toBe('HIT');
      await apply({}, 'nginx');
      expect((await ask('/t/page/bad-file/')).cache).toBe('HIT');
    });

    it('files refused at a start leave the site up on the image’s defaults, and say so', async () => {
      writeFileWhole(path.join(paths.runtimeDir, 'nginx-site.conf'), 'this is not a config;\n');
      writeFileWhole(path.join(paths.runtimeDir, 'php-fpm-pool.conf'), '[www]\npm.max_children = banana\n');
      await seenByContainer();
      const since = new Date().toISOString();
      await must(dockerCli('restart', '-t', '20', SITE), 'restart');
      try {
        await waitFor('the site to answer', siteAnswers);
        const page = await ask('/t/page/refused-at-start/');
        expect([page.status, page.cache, page.skipped]).toEqual([200, 'BYPASS', 'off']);
        const log = (await dockerCli('logs', '--since', since, SITE)).stderr;
        expect(log).toContain("nginx refused the panel's nginx-site.conf");
        expect(log).toContain("PHP-FPM refused the panel's php-fpm-pool.conf");
      } finally {
        await apply({}, 'nginx', 'php');
      }
      await expectStored('/t/page/refused-at-start/');
    });

    // From inside, and that matters: `docker kill`, with any signal, marks a container as stopped by
    // hand, and `unless-stopped` then won't bring it back when something in it dies.
    it('Apache reloads on USR1 to PID 1 and on wpl7-reload, keeping its pid', async () => {
      const before = await must(inSite(['pgrep', '-o', 'apache2']), 'pgrep');
      await must(inSite(['sh', '-c', 'kill -USR1 1']), 'USR1');
      await sleep(500);
      expect((await ask('/wp-includes/images/blank.gif')).status).toBe(200);
      await reload('apache');
      await sleep(500);
      expect((await ask('/wp-includes/images/blank.gif')).status).toBe(200);
      expect(await must(inSite(['pgrep', '-o', 'apache2']), 'pgrep')).toBe(before);
    });
  });

  describe('rules', () => {
    it.each<[string, string, AskOpts, string]>([
      ['a path and what is under it', '/t/skip-below/', {}, 'path /t/skip-below/*'],
      ['a path and what is under it, deeper', '/t/skip-below/a/b/', {}, 'path /t/skip-below/*'],
      ['one page', '/t/skip-exact/', {}, 'path /t/skip-exact/'],
      ['one page, without its slash', '/t/skip-exact', {}, 'path /t/skip-exact/'],
      ['whatever starts so', '/t/skip-prefixed-thing/', {}, 'path /t/skip-pre*'],
      ['a path in another alphabet', '/t/caf%C3%A9/a/', {}, 'path /t/caf%C3%A9/*'],
      ['a path in another alphabet, the page itself', '/t/caf%C3%A9', {}, 'path /t/caf%C3%A9/*'],
      ['a rule typed percent-encoded', '/t/enc%C3%A9/', {}, 'path /t/enc%C3%A9/'],
      ['a rule typed percent-encoded, lower-case hex from the client', '/t/enc%c3%a9/', {}, 'path /t/enc%C3%A9/'],
      ['any case', '/T/SKIP-EXACT/', {}, 'path /t/skip-exact/'],
      ['any case, under a wildcard', '/T/Skip-Below/a/', {}, 'path /t/skip-below/*'],
      ['any case, on a locked rule', '/WP-ADMIN/', {}, 'path /wp-admin/*'],
      ['a cookie, by name prefix', '/t/echo/r1/', { cookie: 'member_x=abc' }, 'cookie member_'],
      ['a query parameter', '/t/echo/r2/?nocache=1', {}, 'query nocache'],
      ['a user agent', '/t/echo/r3/', { agent: 'x SkipBot/2 (x) y' }, 'agent SkipBot/2 (x)'],
    ])('skip: %s', async (_name, url, opts, reason) => {
      await expectBypass(url, reason, opts);
    });

    it('skip: one page rule leaves what is below it alone', async () => {
      await expectStored('/t/skip-exact/below/');
    });

    it('skip: a post type, which only WordPress knows, and so on a miss', async () => {
      const post = await wp('post', 'create', '--post_type=skipme', '--post_title=Skip one', '--post_name=one', '--post_status=publish', '--porcelain');
      expect(await wp('post', 'get', post, '--field=post_type')).toBe('skipme');
      await wp('rewrite', 'flush');
      await clearCache();
      const page = await expectNotStored('/skipme/one/', 'post type skipme');
      expect(page.status).toBe(200);
      await expectNotStored('/skipme/', 'post type skipme');
    });

    it('a separate copy per cookie, a junk value skipping, and no cookie being a copy too', async () => {
      const url = '/t/page/copy-cookie/';
      const a = await expectStored(url, { cookie: 'my.edition=a' });
      const b = await expectStored(url, { cookie: 'my.edition=b' });
      const none = await expectStored(url);
      expect(new Set([a.body, b.body, none.body]).size).toBe(3);
      expect((await ask(url, { cookie: 'my.edition=a; _ga=1' })).body).toBe(a.body);
      await expectBypass(url, SEPARATE_COPY, { cookie: 'my.edition=<script>' });
      await expectBypass(url, SEPARATE_COPY, { cookie: `my.edition=${'a'.repeat(33)}` });
      await expectBypass(url, SEPARATE_COPY, { cookie: 'my.edition=a; my.edition=b' });
    });

    it('a dot in a copy cookie name is only a dot', async () => {
      const url = '/t/page/copy-dot/';
      await expectNotStored(url, undefined, { cookie: 'myXedition=a' });
    });

    it('built-in separate copies: a currency and a language', async () => {
      const url = '/t/page/copy-built-in/';
      const eur = await expectStored(url, { cookie: 'wmc_current_currency=EUR' });
      const usd = await expectStored(url, { cookie: 'wmc_current_currency=USD' });
      const lang = await expectStored(url, { cookie: 'wp-wpml_current_language=de' });
      expect(new Set([eur.body, usd.body, lang.body]).size).toBe(3);
    });

    it('a separate copy per ?v=, with PHP seeing only that', async () => {
      const url = '/t/echo/copy-v/';
      const first = await ask(`${url}?v=a`);
      expect(first.cache).toBe('MISS');
      expect(first.json.get).toEqual({ v: 'a' });
      expect(first.json.uri).toBe(`${url}?v=a`);
      const again = await ask(`${url}?v=a`);
      expect([again.cache, again.json.n]).toEqual(['HIT', first.json.n]);
      const other = await ask(`${url}?v=b`);
      expect(other.cache).toBe('MISS');
      expect(other.json.get).toEqual({ v: 'b' });
      const none = await ask(url);
      expect(none.cache).toBe('MISS');
      expect(none.json.get).toEqual({});
    });

    it('two copy parameters in any order are one copy', async () => {
      const url = '/t/echo/copy-two/';
      const first = await ask(`${url}?country=de&v=a`);
      const second = await ask(`${url}?v=a&country=de`);
      expect([first.cache, second.cache]).toEqual(['MISS', 'HIT']);
      expect(first.json.uri).toBe(`${url}?v=a&country=de`);
    });

    it.each<[string, string, string]>([
      ['a doubled ?v=a&v=b, because PHP reads the last and a regex the first', '?v=a&v=b', SEPARATE_COPY],
      ['?v&v=b', '?v&v=b', SEPARATE_COPY],
      ['a junk value', '?v=a%20b', SEPARATE_COPY],
      ['no value', '?v', SEPARATE_COPY],
      ['a percent-encoded name, which reaches PHP as v', '?%76=a', 'query string'],
      ['a percent-encoded ignored name, which reaches PHP as utm_source', '?%75tm_source=a', 'query string'],
      ['an array name', '?v[]=a', 'query string'],
      ['a dotted name, which reaches PHP as utm_source', '?utm.source=a', 'query string'],
      ['an empty segment', '?gclid=a&&_ga=b', 'query string'],
    ])('skips the cache on %s', async (_name, query, reason) => {
      await expectBypass(`/t/echo/odd-query/${query}`, reason);
    });

    it('an ignored parameter is gone from what PHP sees, its value absent from the page', async () => {
      const url = '/t/echo/ignored/';
      const answer = await ask(`${url}?utm_source=VALUE-ONE&fbclid=VALUE-TWO&promo_code=VALUE-THREE`);
      expect(answer.cache).toBe('MISS');
      expect(answer.body).not.toContain('VALUE-');
      expect(answer.json.get).toEqual({});
      expect(answer.json.uri).toBe(url);
      expect(answer.json.query).toBe('');
      const same = await ask(url);
      expect([same.cache, same.json.n]).toEqual(['HIT', answer.json.n]);
      const everyDefault = await ask(`${url}?gclid=1&gbraid=1&wbraid=1&msclkid=1&mc_cid=1&mc_eid=1&_ga=1&_gl=1&utm_medium=1&promo_x=1`);
      expect([everyDefault.cache, everyDefault.json.n]).toEqual(['HIT', answer.json.n]);
    });

    it('?v=a&utm_source=b keeps v and drops utm_source', async () => {
      const url = '/t/echo/keep-drop/';
      const answer = await ask(`${url}?v=a&utm_source=b-value`);
      expect(answer.cache).toBe('MISS');
      expect(answer.json.get).toEqual({ v: 'a' });
      expect(answer.json.uri).toBe(`${url}?v=a`);
      expect(answer.body).not.toContain('b-value');
      const again = await ask(`${url}?utm_campaign=c&v=a`);
      expect([again.cache, again.json.n]).toEqual(['HIT', answer.json.n]);
    });

    it('a keep-time rule, by path, by post type, and on a path in another alphabet', async () => {
      await wp('post', 'create', '--post_type=keepme', '--post_title=Keep one', '--post_name=one', '--post_status=publish');
      await wp('rewrite', 'flush');
      const expires = async (url: string) => (await askPhpDirectly(url)).get('x-accel-expires');
      expect(await expires('/t/keep2/any/')).toBe('2');
      expect(await expires('/keepme/one/')).toBe('88');
      expect(await expires('/t/na%C3%AFve/')).toBe('77');
      expect(await expires('/t/page/not-a-rule/')).toBe('3600');
    });

    it('a keep-time rule holds: the page really expires', async () => {
      const url = '/t/keep2/holds/';
      await ask(url);
      expect((await ask(url)).cache).toBe('HIT');
      await pastKeepTime();
      expect((await ask(url)).cache).toBe('EXPIRED');
    });

    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
    const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
    const KINDLE = 'Mozilla/5.0 (X11; U; Linux armv7l) AppleWebKit/538.1 Kindle/3.0';
    const OPERA = 'Opera/9.80 (J2ME/MIDP; Opera Mini/5.0) Presto/2.12.423';

    it('phones get their own copy, and their answer is wp_is_mobile()’s', async () => {
      const url = '/t/is-mobile/own-copy/';
      const desktop = await expectStored(url, { agent: DESKTOP });
      const phone = await expectStored(url, { agent: IPHONE });
      expect(desktop.body).toContain('wp_is_mobile no');
      expect(phone.body).toContain('wp_is_mobile yes');
      expect((await ask(url, { agent: ANDROID })).body).toBe(phone.body);
      expect((await ask(url, { agent: DESKTOP })).body).toBe(desktop.body);
    });

    it.each<[string, string, string | undefined]>([
      ['an iPhone', IPHONE, undefined],
      ['an Android phone', ANDROID, undefined],
      ['a desktop', DESKTOP, undefined],
      ['a Kindle', KINDLE, undefined],
      ['Opera Mini', OPERA, undefined],
      ['a desktop agent saying ?1', DESKTOP, '?1'],
      ['a phone agent saying ?0', IPHONE, '?0'],
      ['a phone agent saying nonsense', IPHONE, '?1|x'],
      ['a desktop agent saying nonsense', DESKTOP, 'yes'],
    ])('what nginx decides is what wp_is_mobile() decides, asked of PHP directly: %s', async (name, agent, hint) => {
      const headers = hint === undefined ? undefined : { 'Sec-CH-UA-Mobile': hint };
      const url = `/t/is-mobile/${encodeURIComponent(name.replace(/\W+/g, '-'))}/`;
      const throughNginx = await ask(url, { agent, headers });
      const direct = await ask(url, { agent, headers, port: 80 });
      const answerOf = (answer: Answer) => /wp_is_mobile (yes|no)/.exec(answer.body)?.[1];
      expect(answerOf(throughNginx)).toBeDefined();
      expect(answerOf(throughNginx)).toBe(answerOf(direct));
    });

    it('a hint and a user agent that disagree skip the cache, and PHP sees them as they came', async () => {
      const lying = await expectBypass('/t/echo/hint-1/', 'device', { agent: IPHONE, headers: { 'Sec-CH-UA-Mobile': '?0' } });
      expect(lying.json.headers['sec-ch-ua-mobile']).toBe('?0');
      await expectBypass('/t/echo/hint-2/', 'device', { agent: DESKTOP, headers: { 'Sec-CH-UA-Mobile': '?1' } });
      // An Android tablet says this, and is no reason to skip.
      await expectStored('/t/echo/hint-3/', { agent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) Chrome/120 Safari/537.36', headers: { 'Sec-CH-UA-Mobile': '?0' } });
    });

    it('another spelling of a real page’s address is not stored, because a rule for the page would not match it', async () => {
      await clearCache();
      for (const url of ['/SAMPLE-PAGE/', '/Sample-Page/', '/sample-page./', '/sample-page%20/']) {
        const page = await expectNotStored(url, 'another spelling of this address');
        expect(page.status, url).toBe(200);
      }
      await expectStored('/sample-page/');
    });

    it('a built-in group switched off, and a rule of it: the cookie is only unknown then', async () => {
      await apply({ off: ['php-sessions', 'phones', 'tracking.gclid'] }, 'nginx');
      try {
        await expectNotStored('/t/page/group-off/', undefined, { cookie: 'PHPSESSID=abc' });
        await expectBypass('/t/page/group-off/?gclid=1', 'query string');
        const desktop = await ask('/t/is-mobile/group-off/', { agent: DESKTOP });
        const phone = await ask('/t/is-mobile/group-off/', { agent: IPHONE });
        expect([desktop.cache, phone.cache]).toEqual(['MISS', 'HIT']);
        expect(phone.body).toBe(desktop.body);
      } finally {
        await apply({}, 'nginx');
      }
    });

    it('a host with a port, another host and another scheme are other copies, and Host goes through as it came', async () => {
      const url = '/t/echo/key/';
      expect((await ask(url)).cache).toBe('MISS');
      expect((await ask(url)).cache).toBe('HIT');
      const port = await ask(url, { host: `${HOST}:8443` });
      expect(port.cache).toBe('MISS');
      expect(port.json.headers.host).toBe(`${HOST}:8443`);
      expect((await ask(url, { host: 'other.example.com' })).cache).toBe('MISS');
      const http = await ask(url, { proto: 'http' });
      expect(http.cache).toBe('MISS');
      expect(http.json.headers['x-forwarded-proto']).toBe('http');
    });

    it('headers that aren’t in the key cannot change a stored page', async () => {
      const headers = { 'X-Original-URL': '/evil', 'X-Rewrite-URL': '/evil', 'X-Host': 'evil.example.com', Forwarded: 'host=evil.example.com', 'X-HTTP-Method-Override': 'PUT', 'X-HTTP-Method': 'PUT', 'X-Method-Override': 'PUT' };
      const answer = await ask('/t/echo/poison/', { headers });
      for (const name of Object.keys(headers)) expect(answer.json.headers, name).not.toHaveProperty(name.toLowerCase());
      const skipped = await ask('/t/echo/poison/?s=1', { headers });
      expect(skipped.json.headers['x-original-url'], 'a skipped request keeps them').toBe('/evil');
    });

    it('a visitor’s Referer never reaches a page that can be stored', async () => {
      await clearCache();
      const url = '/t/late-referer/x/';
      const first = await ask(url, { headers: { Referer: 'https://intranet.example.com/reset?token=SECRET' } });
      expect(first.cache).toBe('MISS');
      expect(first.body).toContain('referer=none');
      const next = await ask(url);
      expect([next.cache, next.body]).toEqual(['HIT', first.body]);
    });

    it('what runs before the page is drawn still has it: a hotlink check, a click counter', async () => {
      const answer = await ask('/t/early-referer/x/', { headers: { Referer: 'https://elsewhere.example.net/' } });
      expect(answer.json).toEqual({ referer: 'https://elsewhere.example.net/' });
    });

    it('a skipped request has it where it always was', async () => {
      const answer = await ask('/t/echo/referer/?s=1', { headers: { Referer: 'https://elsewhere.example.net/' } });
      expect(answer.json.headers.referer).toBe('https://elsewhere.example.net/');
      expect(answer.json.headers).not.toHaveProperty('x-wpl7-referer');
    });

    it.each(['X-Forwarded-Scheme', 'X-Forwarded-Ssl', 'X-Url-Scheme', 'Front-End-Https', 'Client-IP', 'Via', 'X-Api-Key'])('a header nginx does not know reaches PHP, and that page is not stored: %s', async (name) => {
      await clearCache();
      const url = `/t/echo/unknown-header-${name.toLowerCase()}/`;
      const answer = await expectNotStored(url, `request header ${name.toLowerCase()}`, { headers: { [name]: 'canary' } });
      expect(answer.json.headers[name.toLowerCase()]).toBe('canary');
      // A page someone else stored is another matter: nothing of this visitor's went into it.
      const stored = await expectStored(url);
      const hit = await ask(url, { headers: { [name]: 'canary' } });
      expect([hit.cache, hit.json.n]).toEqual(['HIT', stored.json.n]);
    });

    it('a real browser’s own headers, and Cloudflare’s, do not stop a page being stored, and PHP sees none of them', async () => {
      await clearCache();
      const headers = {
        'Sec-CH-UA': '"Chromium";v="120"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Linux"',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Accept-Language': 'de,en;q=0.9',
        Priority: 'u=0, i',
        DNT: '1',
        'Cache-Control': 'max-age=0',
        Pragma: 'no-cache',
        TE: 'trailers',
        From: 'googlebot(at)googlebot.com',
        'CF-Connecting-IP': '203.0.113.9',
        'CF-IPCountry': 'DE',
        'CF-Ray': 'abc-FRA',
        'CF-Visitor': '{"scheme":"https"}',
        'CDN-Loop': 'cloudflare',
        'True-Client-IP': '203.0.113.9',
        Referer: `https://${HOST}/`,
      };
      const url = '/t/echo/browser/';
      const first = await ask(url, { headers });
      expect([first.cache, first.skipped]).toEqual(['MISS', undefined]);
      for (const name of Object.keys(headers)) {
        if (name !== 'Accept-Language' && name !== 'Sec-CH-UA-Mobile') expect(first.json.headers, name).not.toHaveProperty(name.toLowerCase());
      }
      expect(first.json.headers).not.toHaveProperty('x-wpl7-referer');
      expect(first.json.headers).not.toHaveProperty('x-wpl7-country');
      expect((await ask(url)).cache).toBe('HIT');
    });
  });

  describe('what must keep working', () => {
    let applicationPassword = '';
    const basic = () => `Basic ${Buffer.from(`${ADMIN}:${applicationPassword}`).toString('base64')}`;

    beforeAll(async () => {
      applicationPassword = await wp('user', 'application-password', 'create', ADMIN, 'engine', '--porcelain');
    });

    it('Application Password REST calls through nginx', async () => {
      const me = await expectBypass('/wp-json/wp/v2/users/me?context=edit', 'authorization', { headers: { Authorization: basic() } });
      expect(me.status, me.body.slice(0, 300)).toBe(200);
      expect(me.json.slug).toBe(ADMIN);

      const created = await ask('/wp-json/wp/v2/posts', {
        method: 'POST',
        headers: { Authorization: basic(), 'Content-Type': 'application/json' },
        data: JSON.stringify({ title: 'By REST', status: 'draft' }),
      });
      expect(created.status, created.body.slice(0, 300)).toBe(201);

      const wrong = await ask('/wp-json/wp/v2/users/me', { headers: { Authorization: `Basic ${Buffer.from(`${ADMIN}:wrong`).toString('base64')}` } });
      expect(wrong.status).toBe(401);
    });

    it('the panel’s REST tool: services/wpRest.ts, curl on 127.0.0.1 with Authorization, as www-data', async () => {
      const call = { host: HOST, https: true, timeoutMs: 30_000, bodyCap: 1_000_000, auth: { username: ADMIN, applicationPassword } };
      const me = await sendWpRest(dockerService, SITE, { ...call, method: 'GET', route: 'wp/v2/users/me?context=edit' });
      expect(me.status, me.body.slice(0, 300)).toBe(200);
      expect(JSON.parse(me.body).slug).toBe(ADMIN);
      expect(me.headers).not.toHaveProperty('x-cache-status');

      const created = await sendWpRest(dockerService, SITE, { ...call, method: 'POST', route: 'wp/v2/posts', body: { title: 'By the REST tool', status: 'draft' } });
      expect(created.status, created.body.slice(0, 300)).toBe(201);
    });

    it('PATH_INFO permalinks', async () => {
      const canonical = await ask('/index.php/sample-page/');
      expect([canonical.status, canonical.get('location')]).toEqual([301, `https://${HOST}/sample-page/`]);
      await wp('rewrite', 'structure', '/index.php/%postname%/');
      try {
        const page = await expectStored('/index.php/sample-page/');
        expect(page.status).toBe(200);
        expect(page.body).toContain('Sample Page');
      } finally {
        await wp('rewrite', 'structure', DEFAULT_PERMALINK_STRUCTURE);
      }
    });

    it('a 100 MB upload', async () => {
      await must(inSite(['sh', '-c', 'head -c 104857600 /dev/urandom > /tmp/upload.bin']), 'making the file');
      const md5 = (await must(inSite(['md5sum', '/tmp/upload.bin']), 'md5sum')).split(/\s+/)[0];
      const answer = await ask('/t/upload/', { extraArgs: ['-F', 'f=@/tmp/upload.bin'], maxTime: 170 });
      expect(answer.status).toBe(200);
      expect(answer.cache).toBe('BYPASS');
      expect(answer.json).toEqual({ size: 104_857_600, error: 0, md5 });
      await inSite(['rm', '-f', '/tmp/upload.bin']);
    });

    it('a request body sent chunked, which FastCGI needs the length of', async () => {
      const answer = await ask('/t/echo/chunked/', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/octet-stream' }, data: 'x'.repeat(100_000) });
      expect(answer.json.bodyLength).toBe(100_000);
    });

    it('a GET with a body goes past the cache, and PHP reads it: nginx spools it, as www-data', async () => {
      const answer = await expectBypass('/t/echo/get-body/', 'body', { method: 'GET', data: 'x'.repeat(100_000) });
      expect([answer.status, answer.json.bodyLength]).toEqual([200, 100_000]);
      await expectStored('/t/echo/get-body/');
    });

    describe('request bodies', () => {
      const slowPost = (n: number) =>
        must(inSite(['sh', '-c', `head -c 200000 /dev/zero | curl -s -o /dev/null --limit-rate 2k --max-time 120 -X POST -H 'Host: ${HOST}' -H 'X-Forwarded-Proto: https' --data-binary @- 'http://127.0.0.1:8080/?slow=${n}' >/dev/null 2>&1 &`]), 'a slow POST');
      const stopSenders = () => inSite(['sh', '-c', 'pkill -f limit-rate; true']);

      it('as many slow senders as the pool has workers hold no PHP worker', async () => {
        try {
          // 512 MB and 2 CPUs: 10 workers.
          for (let n = 0; n < 10; n++) await slowPost(n);
          await sleep(3_000);
          const started = Date.now();
          const page = await ask('/wp-login.php');
          expect(page.status).toBe(200);
          expect(Date.now() - started).toBeLessThan(3_000);
        } finally {
          await stopSenders();
        }
      });

      it('has a ceiling, and the panel can say what it is for a site', async () => {
        expect(await must(inSite(['nginx', '-T', '-q']), 'nginx -T')).toContain('client_max_body_size 1g;');
        await apply({ maxBodyMb: 20 }, 'nginx');
        try {
          await must(inSite(['sh', '-c', 'head -c 31457280 /dev/zero > /tmp/thirty; head -c 10485760 /dev/zero > /tmp/ten']), 'the files');
          const big = await ask('/t/echo/body-limit/', { method: 'POST', extraArgs: ['--data-binary', '@/tmp/thirty'] });
          expect(big.status).toBe(413);
          const small = await ask('/t/echo/body-limit/', { method: 'POST', extraArgs: ['--data-binary', '@/tmp/ten'] });
          expect([small.status, small.json.bodyLength]).toEqual([200, 10_485_760]);
          // A sender that keeps going: this is the one that has no length to refuse it by up front.
          const script = `cat /tmp/thirty | curl -s -o /dev/null -w '%{http_code}' --max-time 60 -X POST -H 'Host: ${HOST}' -H 'X-Forwarded-Proto: https' -H 'Transfer-Encoding: chunked' -T - http://127.0.0.1:8080/wp-login.php`;
          expect(await must(inSite(['sh', '-c', script]), 'the chunked POST')).toBe('413');
          expect(await must(inSite(['sh', '-c', 'find /var/lib/nginx/body -type f | wc -l']), 'the temporary files')).toBe('0');
        } finally {
          await apply({}, 'nginx');
          await inSite(['rm', '-f', '/tmp/thirty', '/tmp/ten']);
        }
      });

      it('takes 16 big bodies at a time, so what visitors can put on the disk has a ceiling', async () => {
        const sender = (n: number) => `dd if=/dev/zero bs=1M count=5 2>/dev/null | curl -s -o /dev/null --limit-rate 50k --max-time 120 -X POST -H 'Host: ${HOST}' -H 'X-Forwarded-Proto: https' -H 'Transfer-Encoding: chunked' -T - 'http://127.0.0.1:8080/?big=${n}' >/dev/null 2>&1 &`;
        try {
          for (let n = 0; n < 16; n++) await must(inSite(['sh', '-c', sender(n)]), 'a big body');
          await sleep(1_500);
          const seventeenth = await ask('/t/echo/big-seventeen/', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' }, data: 'x'.repeat(100) });
          expect(seventeenth.status).toBe(429);
          // A small one is not counted.
          const small = await ask('/t/echo/small-body/', { method: 'POST', data: 'x'.repeat(100) });
          expect(small.status).toBe(200);
        } finally {
          await stopSenders();
        }
      });
    });

    it('everything between a visitor and PHP allows an hour, because mod_php had no wall clock', async () => {
      const nginx = await must(inSite(['nginx', '-T', '-q']), 'nginx -T');
      for (const line of ['proxy_read_timeout 3600s;', 'proxy_send_timeout 3600s;', 'send_timeout 3600s;']) expect(nginx).toContain(line);
      const apache = await must(inSite(['cat', '/etc/apache2/conf-enabled/wpl7-site.conf']), 'Apache');
      expect(apache).toMatch(/^Timeout 3600$/m);
      expect(apache).toMatch(/^ProxyTimeout 3600$/m);
      const pool = await must(inSite(['cat', '/usr/local/etc/php-fpm.d/zz-wpl7.conf']), 'the pool');
      expect(pool).toMatch(/^request_terminate_timeout = 3600s$/m);
    });

    it('a 90-second request, on both paths', async () => {
      const [cachedPath, directPath] = await Promise.all([
        ask('/t/sleep/90/cached/', { maxTime: 120 }),
        ask('/t/sleep/90/direct/', { maxTime: 120, cookie: 'wordpress_no_cache=1' }),
      ]);
      expect([cachedPath.status, cachedPath.cache]).toEqual([200, 'MISS']);
      expect([directPath.status, directPath.cache]).toEqual([200, 'BYPASS']);
    });

    /** Reads inside the container, so that it sees when each part really arrived. */
    async function readAsItArrives(url: string, extraHeaders = ''): Promise<{ head: string; gaps: number[]; parts: number }> {
      const done = await must(inSite(['php', '-r', STREAM_CLIENT, '--', url, HOST, extraHeaders]), 'the stream client');
      const { reads, head } = JSON.parse(done) as { reads: [number, number][]; head: string };
      // Parts closer than this are one chunk that took two reads.
      const parts = reads.filter(([at], i) => i === 0 || at - reads[i - 1]![0] > 0.25);
      return { head, parts: parts.length, gaps: parts.slice(1).map(([at], i) => at - parts[i]![0]) };
    }

    it.each<[string, string]>([
      ['plain', ''],
      ['Brotli', 'Accept-Encoding: br\r\n'],
      ['gzip', 'Accept-Encoding: gzip\r\n'],
    ])('a streamed response on a skipped path arrives chunk by chunk: %s', async (_name, encoding) => {
      const { head, parts, gaps } = await readAsItArrives('/t/stream/skipped/?s=1', encoding);
      expect(head).toMatch(/X-Cache-Status: BYPASS/);
      expect(parts, head).toBeGreaterThanOrEqual(5);
      for (const gap of gaps) expect(gap).toBeGreaterThan(0.3);
    });

    it('a streamed response on the cached path too, once it has flushed', async () => {
      const { head, parts, gaps } = await readAsItArrives('/t/stream/cached/');
      expect(head).toMatch(/X-Cache-Status: MISS/);
      expect(head).toMatch(/X-Cache-Skipped: page flushed early/);
      expect(parts, head).toBeGreaterThanOrEqual(5);
      for (const gap of gaps) expect(gap).toBeGreaterThan(0.3);
      expect((await ask('/t/stream/cached/')).cache).toBe('MISS');
    });

    it('Range requests on a big file give 206, and the right bytes', async () => {
      const file = '/var/www/html/wp-content/uploads/big.mp4';
      const size = 50 * 1024 * 1024;
      await shell(`mkdir -p /var/www/html/wp-content/uploads && head -c ${size} /dev/urandom > ${file}`);
      const part = await expectBypass('/wp-content/uploads/big.mp4', 'file', { headers: { Range: 'bytes=1000-1999' } });
      expect(part.status).toBe(206);
      expect(part.get('content-range')).toBe(`bytes 1000-1999/${size}`);
      expect(part.raw.length).toBe(1000);
      expect(part.get('accept-ranges')).toBe('bytes');
      const onDisk = await must(inSite(['sh', '-c', `tail -c +1001 ${file} | head -c 1000 | md5sum`]), 'the same bytes');
      expect(onDisk.split(/\s+/)[0]).toBe(crypto.createHash('md5').update(part.raw).digest('hex'));

      const tail = await ask('/wp-content/uploads/big.mp4', { headers: { Range: `bytes=${size - 100}-` } });
      expect([tail.status, tail.raw.length]).toEqual([206, 100]);
      const whole = await ask('/wp-content/uploads/big.mp4', { method: 'HEAD' });
      expect([whole.status, whole.get('content-length')]).toEqual([200, String(size)]);
      await shell(`rm -f ${file}`);
    });

    it('a HEAD request on a skipped path stays a HEAD', async () => {
      const head = await expectBypass('/t/echo/head/?s=1', 'query string', { method: 'HEAD' });
      expect([head.status, head.raw.length]).toEqual([200, 0]);
    });

    it('websocket upgrade headers reach Apache and PHP', async () => {
      const answer = await expectBypass('/t/echo/upgrade/', 'upgrade', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
      expect(answer.json.headers.upgrade).toBe('websocket');
      expect(answer.json.headers.connection).toMatch(/upgrade/i);
      expect(answer.json.headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    });

    it('big cookies: as long a line as Apache takes, on both paths', async () => {
      const big = 'c'.repeat(8000);
      const cached = await ask('/t/echo/big-cookie/', { cookie: `session=${big}` });
      expect(cached.status).toBe(200);
      expect(cached.json.cookies.session).toBe(big);
      const direct = await ask('/t/echo/big-cookie/', { cookie: `wordpress_no_cache=1; session=${big}` });
      expect(direct.status).toBe(200);
      expect(direct.json.cookies.session).toBe(big);
    });

    it('20 KB of request headers in several lines reach PHP', async () => {
      const headers = { 'X-Pad-1': 'a'.repeat(7000), 'X-Pad-2': 'b'.repeat(7000), 'X-Pad-3': 'c'.repeat(7000) };
      const answer = await ask('/t/echo/big-request/', { headers });
      expect(answer.status).toBe(200);
      expect(answer.json.headers['x-pad-3']).toBe(headers['X-Pad-3']);
    });

    it('a single line longer than that gets Apache’s own 400, as it did with Apache alone', async () => {
      const answer = await ask('/t/echo/too-long/', { cookie: `session=${'c'.repeat(12_000)}` });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatch(/exceeds server limit/);
    });

    it('a line longer than Apache would ever take stops at nginx, with a 400 too: regexes have less to read', async () => {
      const answer = await ask('/t/echo/too-long-2/', { cookie: `session=${'c'.repeat(20_000)}` });
      expect(answer.status).toBe(400);
    });

    it('regexes run under JIT, and a long query or cookie makes none of them fail', async () => {
      const config = await must(inSite(['nginx', '-T', '-q']), 'nginx -T');
      expect(config).toContain('pcre_jit on;');
      const since = new Date().toISOString();
      const query = await ask(`/t/echo/long-query/?${'utm_a=1&'.repeat(1_900)}utm_a=1`);
      expect(query.status).toBe(200);
      const cookie = await ask('/t/echo/long-cookie/', { cookie: '_ga=;'.repeat(1_500) });
      expect(cookie.status).toBe(200);
      expect((await dockerCli('logs', '--since', since, SITE)).stderr).not.toMatch(/pcre2?_\w+\(\) failed/);
    });

    it('long response headers: 20 KB in several, on both paths and from the cache', async () => {
      const url = '/t/headers/5/4000/';
      const first = await expectStored(url);
      expect(first.all('x-long-4')[0]).toHaveLength(4000);
      const hit = await ask(url);
      expect(hit.all('x-long-0')[0]).toHaveLength(4000);
      const direct = await expectBypass(url, 'cookie wordpress_no_cache', { cookie: 'wordpress_no_cache=1' });
      expect(direct.all('x-long-4')[0]).toHaveLength(4000);
    });

    it('a header line with no colon is dropped, where Apache would answer 500, on both paths, and the rest stay', async () => {
      const cached = await ask('/t/no-colon/x/');
      expect([cached.status, cached.get('x-kept')]).toEqual([200, 'yes']);
      const direct = await expectBypass('/t/no-colon/x/?s=1', 'query string');
      expect([direct.status, direct.get('x-kept')]).toEqual([200, 'yes']);
    });

    it.each([403, 404, 410, 401, 500, 503])('http_response_code(%i) after WordPress’s status_header(200), which PHP-FPM alone would send as a 200', async (code) => {
      const direct = await ask(`/t/code/${code}/?s=1`);
      expect(direct.status).toBe(code);
      const cached = await ask(`/t/code/${code}/`);
      expect(cached.status).toBe(code);
    });

    it('a PHP download keeps its Content-Length, so a browser shows its size', async () => {
      const whole = await ask('/t/download/2/?s=1');
      expect(whole.get('content-length')).toBe(String(2 * 1024 * 1024));
      expect(whole.get('transfer-encoding')).toBeUndefined();
      expect(whole.raw.length).toBe(2 * 1024 * 1024);
      const head = await ask('/t/download/2/?s=1', { method: 'HEAD' });
      expect(head.get('content-length')).toBe(String(2 * 1024 * 1024));
    });

    it('and a download PHP-FPM cuts short fails, instead of looking complete', async () => {
      writeFileWhole(path.join(paths.runtimeDir, 'php-fpm-pool.conf'), '[www]\npm.max_children = 10\nrequest_terminate_timeout = 3s\n');
      await seenByContainer();
      await reload('php');
      try {
        const done = await inSite(['curl', '-sS', '-o', '/dev/null', '--limit-rate', '5M', '--max-time', '60', '-H', `Host: ${HOST}`, '-H', 'X-Forwarded-Proto: https', 'http://127.0.0.1:8080/t/download/200/?s=1']);
        expect(done.status, done.stderr).toBe(18);
      } finally {
        await apply({}, 'php');
      }
    }, 120_000);

    it('a compressed answer goes on working: the length PHP gave is not the length that goes out', async () => {
      await writeInSite('/var/www/html/speed-length/page.php', `<?php $body = str_repeat('Words that compress. ', 500); header('Content-Type: text/html'); header('Content-Length: ' . strlen($body)); echo $body;`);
      const plain = await ask('/speed-length/page.php');
      expect(plain.get('content-length')).toBe(String(plain.raw.length));
      const br = await ask('/speed-length/page.php', { headers: { 'Accept-Encoding': 'br' } });
      expect(br.get('content-encoding')).toBe('br');
      expect(zlib.brotliDecompressSync(br.raw).length).toBe(plain.raw.length);
      expect(br.get('content-length') === undefined || Number(br.get('content-length')) === br.raw.length).toBe(true);
    });

    it('Range at an address with no extension reaches PHP, whatever answers there', async () => {
      const part = await expectBypass('/t/ranged/x/', 'range', { headers: { Range: 'bytes=100-199' } });
      expect([part.status, part.get('content-range')]).toEqual([206, `bytes 100-199/1000000`]);
      expect(part.raw.length).toBe(100);
      const whole = await ask('/t/ranged/x/');
      expect(whole.status).toBe(200);
      expect(whole.raw.length).toBe(1_000_000);
    });

    it('a PHP download from before the page’s buffer goes as it comes, and puts nothing on the disk', async () => {
      const started = inSite(['curl', '-s', '-o', '/dev/null', '--limit-rate', '512k', '--max-time', '6', '-H', `Host: ${HOST}`, '-H', 'X-Forwarded-Proto: https', 'http://127.0.0.1:8080/t/early-download/400/']);
      await sleep(3_000);
      const files = await must(inSite(['sh', '-c', 'find /var/lib/nginx/proxy -type f -size +1M | wc -l; du -sm /var/lib/nginx/proxy | cut -f1']), 'the temporary files');
      expect(files.split('\n')[0]).toBe('0');
      await started;
    });

    it('PHP sees the address the visitor reached, and a visitor can’t say otherwise', async () => {
      const fromNeighbour = (extra: string[]) => must(dockerCli('exec', RELAY, 'curl', '-sS', '--max-time', '20', '-H', `Host: ${HOST}`, '-H', 'X-Forwarded-Proto: https', ...extra, `http://${SITE}:8080/t/echo/address/?s=${Date.now()}`), 'from the neighbour');
      const address = (await must(inSite(['hostname', '-i']), 'its address')).split(/\s+/);
      const answer = JSON.parse(await fromNeighbour([]));
      expect(address).toContain(answer.serverAddr);
      expect(answer.headers).not.toHaveProperty('x-wpl7-server-addr');
      const spoofed = JSON.parse(await fromNeighbour(['-H', 'X-Wpl7-Server-Addr: 203.0.113.9']));
      expect(address).toContain(spoofed.serverAddr);
      const direct = await ask('/t/echo/address-direct/?s=1', { port: 80 });
      expect(direct.json.serverAddr, 'asked on the loopback, as the panel’s REST tool does').toBe('127.0.0.1');
    });

    it('one response header up to Apache’s 8 KB limit passes; past it is a 500, which mod_php never gave', async () => {
      const fits = await ask('/t/headers/1/8100/');
      expect(fits.status).toBe(200);
      expect(fits.all('x-long-0')[0]).toHaveLength(8100);
      const tooLong = await ask('/t/headers/1/20000/');
      expect(tooLong.status).toBe(500);
    });

    it('REMOTE_ADDR follows X-Forwarded-For', async () => {
      const one = await ask('/t/echo/remote/?s=1', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      expect(one.json.remote).toBe('203.0.113.7');
      const chain = await ask('/t/echo/remote/?s=2', { headers: { 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' } });
      expect(chain.json.remote).toBe('203.0.113.7');
      const cachedPath = await ask('/t/echo/remote-cached/', { headers: { 'X-Forwarded-For': '203.0.113.8' } });
      expect(cachedPath.json.remote).toBe('203.0.113.8');
    });

    it('HTTPS is on from X-Forwarded-Proto', async () => {
      const secure = await ask('/t/echo/https/');
      expect([secure.json.https, secure.json.isSsl]).toEqual(['on', true]);
      const plain = await ask('/t/echo/http/', { proto: 'http' });
      expect(plain.json.isSsl).toBe(false);
      expect(plain.json.https).not.toBe('on');
    });

    it('X-Forwarded-Proto in capitals is not https to WordPress, so it is not the https copy either', async () => {
      await clearCache();
      const capitals = await ask('/t/echo/proto-case/', { proto: 'HTTPS' });
      expect([capitals.cache, capitals.json.isSsl]).toEqual(['MISS', false]);
      const https = await ask('/t/echo/proto-case/');
      expect([https.cache, https.json.isSsl]).toEqual(['MISS', true]);
    });

    it('the database password stays out of $_SERVER, as with mod_php, though wp-config.php reads it', async () => {
      const answer = await ask('/t/echo/secrets/');
      expect(answer.json.serverVars).toEqual([]);
      expect(answer.body).not.toContain(DB_PASSWORD);
    });

    it('PHP mail() reaches msmtp from FPM, and msmtp a stand-in relay (a small PHP SMTP listener, not Postfix)', async () => {
      const marker = `m${Date.now()}`;
      const answer = await ask(`/t/mail/${marker}/`);
      expect(answer.json).toEqual({ sent: true });
      await waitFor('the relay to see it', async () => (await logsOf(RELAY)).includes(`Subject: Engine marker ${marker}`), 15_000);
      const log = await logsOf(RELAY);
      expect(log).toContain('MAIL FROM:<wordpress@stack.example.com>');
      expect(log).toContain(`AUTH PLAIN ${Buffer.from(`\0${mailLogin(SLUG)}\0${MAIL_PASSWORD}`).toString('base64')}`);
    });

    it('PHP errors reach docker logs', async () => {
      const marker = `e${Date.now()}`;
      await ask(`/t/error/${marker}/`);
      await waitFor('the log', async () => {
        const log = await logsOf(SITE);
        return log.includes(`wpl7t-error-log ${marker}`) && log.includes(`wpl7t-warning ${marker}`);
      }, 10_000);
    });

    it('.user.ini applies, and is refused over HTTP', async () => {
      await writeInSite('/var/www/html/user-ini/.user.ini', 'memory_limit = 111M\n');
      await writeInSite('/var/www/html/user-ini/check.php', "<?php echo ini_get('memory_limit');");
      const applied = await ask('/user-ini/check.php');
      expect([applied.status, applied.body]).toEqual([200, '111M']);
      expect((await ask('/user-ini/.user.ini')).status).toBe(403);
      expect((await ask('/.htaccess')).status).toBe(403);
    });

    it('php_value in a .htaccess gives a 500 for its folder: why the migration exists', async () => {
      await writeInSite('/var/www/html/php-value/.htaccess', 'php_value memory_limit 99M\n');
      await writeInSite('/var/www/html/php-value/check.php', "<?php echo ini_get('memory_limit');");
      expect((await ask('/php-value/check.php')).status).toBe(500);
      await waitFor('the log', async () => /Invalid command 'php_value'/.test(await logsOf(SITE)), 5_000);
    });

    it('php_value wrapped in <IfModule mod_php…> gives no error, and silently stops applying: Wordfence’s firewall is written that way', async () => {
      await writeInSite('/var/www/html/php-wrapped/.htaccess', '<IfModule mod_php.c>\nphp_value memory_limit 99M\n</IfModule>\n<IfModule mod_php8.c>\nphp_value memory_limit 99M\n</IfModule>\n');
      await writeInSite('/var/www/html/php-wrapped/check.php', "<?php echo ini_get('memory_limit');");
      const answer = await ask('/php-wrapped/check.php');
      expect([answer.status, answer.body]).toEqual([200, '256M']);
    });

    it('Apache’s status page is off: with nginx in front, Require local could see every visitor as local', async () => {
      const answer = await ask('/server-status', { headers: { 'X-Forwarded-For': '127.0.0.1' } });
      expect(answer.body).not.toContain('Apache Server Status');
      expect(answer.status).toBe(404);
    });

    it('PHP in uploads is refused, as the panel’s hardening says', async () => {
      await writeInSite('/var/www/html/wp-content/uploads/evil.php', "<?php echo 'php-ran';");
      const answer = await ask('/wp-content/uploads/evil.php');
      expect(answer.status).toBe(403);
      expect(answer.body).not.toContain('php-ran');
      await shell('rm -f /var/www/html/wp-content/uploads/evil.php');
    });

    it.each<[string, string, string]>([
      ['AddHandler', 'addhandler', 'AddHandler application/x-httpd-php .html .htm'],
      ['AddType', 'addtype', 'AddType application/x-httpd-php .html'],
      ['SetHandler', 'sethandler', '<FilesMatch "\\.html$">\nSetHandler application/x-httpd-php\n</FilesMatch>'],
      ['ForceType', 'forcetype', '<FilesMatch "\\.html$">\nForceType application/x-httpd-php\n</FilesMatch>'],
      ['the source handler', 'source', 'AddHandler application/x-httpd-php-source .html'],
    ])('a file a .htaccess hands to mod_php gets a 403, never its source: %s', async (_name, folder, rule) => {
      await writeInSite(`/var/www/html/handlers/${folder}/page.html`, "<?php echo 'ran'; ?>THE SOURCE IS NOT SHOWN");
      await writeInSite(`/var/www/html/handlers/${folder}/.htaccess`, `${rule}\n`);
      const answer = await ask(`/handlers/${folder}/page.html`);
      expect(answer.status).toBe(403);
      expect(answer.body).not.toContain('THE SOURCE');
      expect(answer.body).not.toContain('<?php');
    });

    it('a .php file under such a line still runs: the hosting panels’ AddHandler is everywhere', async () => {
      await writeInSite('/var/www/html/handlers/php/page.php', "<?php echo 'ran';");
      await writeInSite('/var/www/html/handlers/php/.htaccess', 'AddHandler application/x-httpd-php .php\nAddHandler application/x-httpd-ea-php74 .php\n');
      expect((await ask('/handlers/php/page.php')).body).toBe('ran');
    });

    it('PHP runs only in files named .php', async () => {
      await writeInSite('/var/www/html/named/image.php.jpg', "<?php echo 'ran';");
      await writeInSite('/var/www/html/named/page.phtml', "<?php echo 'ran';");
      for (const file of ['image.php.jpg', 'page.phtml']) {
        const answer = await ask(`/named/${file}`);
        expect(answer.body, file).toContain('<?php');
      }
      const missing = await ask('/named/missing.php');
      expect(missing.status).toBe(404);
    });
  });

  describe('a redirect on the path that may store a page', () => {
    const location = async (url: string, opts: AskOpts = {}) => {
      const answer = await ask(url, opts);
      return [answer.status, answer.get('location')];
    };

    it('keeps the tracking parameters PHP never saw, and gives each visitor their own from the stored 301', async () => {
      await clearCache();
      const first = await ask('/sample-page?gclid=first');
      expect([first.status, first.cache, first.get('location')]).toEqual([301, 'MISS', `https://${HOST}/sample-page/?gclid=first`]);
      const second = await ask('/sample-page?gclid=second&utm_source=x');
      expect([second.status, second.cache, second.get('location')]).toEqual([301, 'HIT', `https://${HOST}/sample-page/?gclid=second&utm_source=x`]);
      const plain = await ask('/sample-page');
      expect([plain.cache, plain.get('location')]).toEqual(['HIT', `https://${HOST}/sample-page/`]);
    });

    it.each<[string, string]>([
      ['/index.php?utm_source=news', `https://${HOST}/?utm_source=news`],
      ['/feed?utm_source=x', `https://${HOST}/feed/?utm_source=x`],
      ['/category/uncategorized?mc_cid=9', `https://${HOST}/category/uncategorized/?mc_cid=9`],
    ])('%s', async (url, target) => {
      expect(await location(url)).toEqual([301, target]);
    });

    it('never hands them to another site', async () => {
      expect(await location('/t/away/x/?gclid=abc')).toEqual([301, 'https://partner.example.net/landing']);
    });

    it('adds them to a query the address already has', async () => {
      expect(await location('/t/here-with-query/x/?gclid=abc')).toEqual([301, `https://${HOST}/elsewhere/?ref=1&gclid=abc`]);
    });

    it('counts www as the same site', async () => {
      expect(await location('/sample-page?gclid=abc', { host: `www.${HOST}` })).toEqual([301, `https://${HOST}/sample-page/?gclid=abc`]);
    });

    it('leaves a Refresh header as PHP wrote it, and adds no Location of its own', async () => {
      const page = await ask('/t/refresh/x/?gclid=abc');
      expect(page.status).toBe(200);
      expect(page.get('refresh')).toBe('5; url=https://stack.example.com/elsewhere/');
      expect(page.get('location')).toBeUndefined();
    });
  });

  describe('a burst', () => {
    const burst = String.raw`
    $mh = curl_multi_init(); $handles = [];
    for ($i = 0; $i < (int) $argv[2]; $i++) {
        $h = curl_init($argv[1] . '?burst=' . $i);
        curl_setopt_array($h, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120, CURLOPT_FORBID_REUSE => true, CURLOPT_HTTPHEADER => ['Host: ' . $argv[3], 'X-Forwarded-Proto: https']]);
        curl_multi_add_handle($mh, $h); $handles[] = $h;
    }
    do { $status = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 0.05); } while ($running && $status === CURLM_OK);
    $codes = [];
    foreach ($handles as $h) { $code = curl_getinfo($h, CURLINFO_HTTP_CODE); $codes[$code] = ($codes[$code] ?? 0) + 1; }
    echo json_encode($codes);
    `;

    it('fits: nginx has room for 2500 at once, each of its own connections', async () => {
      const worker = await must(inSite(['sh', '-c', 'pgrep -P "$(cat /run/nginx.pid)" -f "worker process" | head -1']), 'the worker');
      expect(await must(inSite(['sh', '-c', `grep 'open files' /proc/${worker}/limits | awk '{print $4}'`]), 'its limit')).toBe('20000');
      expect(await must(inSite(['nginx', '-T', '-q']), 'nginx -T')).toContain('worker_connections 10000;');
      const answer = await must(inSite(['php', '-r', burst, '--', 'http://127.0.0.1:8080/wp-includes/images/blank.gif', '2500', HOST]), 'the burst');
      expect(JSON.parse(answer)).toEqual({ 200: 2500 });
      expect((await logsOf(SITE))).not.toMatch(/worker_connections are not enough|Too many open files/);
    }, 150_000);
  });

  describe('speed defaults', () => {
    const asset = async (name: string, content: string | Buffer) => writeInSite(`/var/www/html/speed/${name}`, content);
    const words = 'Some words that compress well. '.repeat(200);

    it('Brotli, gzip and identity, each its own stored copy', async () => {
      const url = '/t/page/encodings/';
      const plain = await expectStored(url);
      expect(plain.get('content-encoding')).toBeUndefined();
      expect(plain.body).toContain('</html>');

      const br = await ask(url, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      expect([br.cache, br.get('content-encoding')]).toEqual(['MISS', 'br']);
      expect(zlib.brotliDecompressSync(br.raw).toString()).toContain('</html>');
      expect(br.raw.length).toBeLessThan(plain.raw.length);
      expect(br.get('vary')).toMatch(/Accept-Encoding/i);
      const brAgain = await ask(url, { headers: { 'Accept-Encoding': 'br' } });
      expect([brAgain.cache, brAgain.get('content-encoding'), brAgain.raw.equals(br.raw)]).toEqual(['HIT', 'br', true]);

      const gzip = await ask(url, { headers: { 'Accept-Encoding': 'gzip' } });
      expect([gzip.cache, gzip.get('content-encoding')]).toEqual(['MISS', 'gzip']);
      expect(zlib.gunzipSync(gzip.raw).toString()).toContain('</html>');
      const gzipAgain = await ask(url, { headers: { 'Accept-Encoding': 'br;q=0, gzip' } });
      expect([gzipAgain.cache, gzipAgain.get('content-encoding')]).toEqual(['HIT', 'gzip']);

      const none = await ask(url, { headers: { 'Accept-Encoding': 'identity' } });
      expect([none.cache, none.get('content-encoding')]).toEqual(['HIT', undefined]);
    });

    it.each<[string, string, string]>([
      ['SVG', 'image.svg', '<svg xmlns="http://www.w3.org/2000/svg"><!-- '],
      ['JSON', 'data.json', '{"words": "'],
      ['CSS', 'style.css', 'body { /* '],
      ['JavaScript', 'app.js', '// '],
      ['XML', 'feed.xml', '<feed><!-- '],
      ['a web manifest', 'app.webmanifest', '{"words": "'],
    ])('%s is compressed', async (_name, file, start) => {
      await asset(file, start + words);
      const br = await ask(`/speed/${file}`, { headers: { 'Accept-Encoding': 'br' } });
      expect([br.status, br.get('content-encoding')]).toEqual([200, 'br']);
      expect(br.raw.length).toBeLessThan(words.length / 2);
      const gzip = await ask(`/speed/${file}`, { headers: { 'Accept-Encoding': 'gzip' } });
      expect(gzip.get('content-encoding')).toBe('gzip');
      const none = await ask(`/speed/${file}`);
      expect(none.get('content-encoding')).toBeUndefined();
      expect(none.body.startsWith(start)).toBe(true);
    });

    it('a picture is left as it is', async () => {
      await asset('photo.jpg', Buffer.alloc(5000, 7));
      const answer = await ask('/speed/photo.jpg', { headers: { 'Accept-Encoding': 'br, gzip' } });
      expect(answer.get('content-encoding')).toBeUndefined();
      expect(answer.raw.length).toBe(5000);
    });

    it.each<[string, string]>([
      ['a.png', 'max-age=2592000'],
      ['a.JPG', 'max-age=2592000'],
      ['a.webp', 'max-age=2592000'],
      ['a.avif', 'max-age=2592000'],
      ['a.svg', 'max-age=2592000'],
      ['a.ico', 'max-age=2592000'],
      ['a.woff2', 'max-age=2592000'],
      ['a.ttf', 'max-age=2592000'],
      ['a.mp3', 'max-age=2592000'],
      ['a.mp4', 'max-age=2592000'],
      ['a.css', 'max-age=604800'],
      ['a.js', 'max-age=604800'],
      ['a.mjs', 'max-age=604800'],
    ])('a static file: %s for %s', async (file, cacheControl) => {
      await asset(file, 'content');
      const answer = await ask(`/speed/${file}`);
      expect(answer.status).toBe(200);
      expect(answer.get('cache-control')).toBe(cacheControl);
    });

    it.each(['a.html', 'a.pdf', 'a.txt'])('no time on %s', async (file) => {
      await asset(file, 'content');
      expect((await ask(`/speed/${file}`)).get('cache-control')).toBeUndefined();
    });

    it('a PHP-made image is left alone', async () => {
      const page = await ask('/t/image/made/');
      expect(page.get('content-type')).toBe('image/png');
      expect(page.get('cache-control')).toBeUndefined();
      expect(page.get('expires')).toBeUndefined();
      await asset('picture.php', `<?php header('Content-Type: image/png'); echo 'x';`);
      for (const url of ['/speed/picture.php', '/speed/picture.php/name.png']) {
        const script = await ask(url);
        expect(script.get('content-type'), url).toBe('image/png');
        expect(script.get('cache-control'), url).toBeUndefined();
      }
    });

    it('a plugin’s own .htaccess rules win', async () => {
      await writeInSite('/var/www/html/own-expires/.htaccess', 'ExpiresActive On\nExpiresByType image/png "access plus 1 hour"\n');
      await writeInSite('/var/www/html/own-expires/a.png', 'content');
      const expires = await ask('/own-expires/a.png');
      expect(expires.get('cache-control')).toBe('max-age=3600');
      expect(expires.get('expires')).toBeTruthy();

      await writeInSite('/var/www/html/own-header/.htaccess', 'Header set Cache-Control "public, max-age=60"\n');
      await writeInSite('/var/www/html/own-header/a.css', 'content');
      expect((await ask('/own-header/a.css')).get('cache-control')).toBe('public, max-age=60');
    });
  });

  describe('PHP', () => {
    const opcache = async (name: string) => (await ask(`/t/opcache/${name}/`)).json;

    it('OPcache is on in FPM, with the sizes for 512 MB', async () => {
      const first = await opcache('sizes');
      expect(first.sapi).toBe('fpm-fcgi');
      expect(first.status.opcache_enabled).toBe(true);
      expect([first.memory, first.strings, first.files]).toEqual(['192', '16', '20000']);
      const { used_memory, free_memory, wasted_memory } = first.status.memory_usage;
      expect(used_memory + free_memory + wasted_memory).toBe(192 * 1024 * 1024);
      expect(first.status.interned_strings_usage.buffer_size).toBe(16 * 1024 * 1024);
    });

    it('it keeps scripts between requests: hits go up', async () => {
      const before = (await opcache('hits-1')).status.opcache_statistics.hits;
      for (const name of ['hits-2', 'hits-3']) await opcache(name);
      expect((await opcache('hits-4')).status.opcache_statistics.hits).toBeGreaterThan(before);
    });

    it('zend.assertions is -1', async () => {
      expect((await opcache('assertions')).assertions).toBe('-1');
      expect(await wp('eval', "echo ini_get('zend.assertions');")).toBe('-1');
    });

    it('OPcache is on after a pool reload, and takes the new sizes', async () => {
      await apply({ memoryMb: 256 }, 'php');
      try {
        const smaller = await opcache('after-reload');
        expect(smaller.status.opcache_enabled).toBe(true);
        expect([smaller.memory, smaller.strings]).toEqual(['96', '8']);
      } finally {
        await apply({}, 'php');
      }
      const back = await opcache('after-second-reload');
      expect(back.status.opcache_enabled).toBe(true);
      expect(back.memory).toBe('192');
    });

    it('10 workers at 512 MB and 2 CPUs: requests that only wait take that many, and no more', async () => {
      const workers = async () => {
        const list = await must(inSite(['sh', '-c', "ps -eo cmd | grep -c '^php-fpm: pool www' || true"]), 'ps');
        return Number(list);
      };
      // Twelve, to see the ceiling. PHP-FPM starts more each second while none is idle, so all at once.
      const asked = Array.from({ length: 12 }, (_, n) => ask(`/t/sleep/20/ten-${n}/`, { maxTime: 90 }));
      let most = 0;
      const until = Date.now() + 18_000;
      while (Date.now() < until && most < 10) {
        most = Math.max(most, await workers());
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 1_000));
      most = Math.max(most, await workers());
      expect(most).toBe(10);
      await Promise.all(asked);
    }, 120_000);

    it('two slow requests at once don’t wait for each other, from an idle pool either', async () => {
      // Long enough for the pool to have shrunk back to what it keeps ready.
      await new Promise((r) => setTimeout(r, 15_000));
      const started = Date.now();
      await Promise.all([ask('/t/sleep/4/together-a/'), ask('/t/sleep/4/together-b/')]);
      // One after the other would be 8 s. PHP-FPM's ondemand mode does just that.
      expect(Date.now() - started).toBeLessThan(7_000);
    }, 60_000);

    it('the pool size from the panel’s file is in force: 2 workers make 4 one-second requests take 2 seconds', async () => {
      await apply({ memoryMb: 128, cpus: 1 }, 'php');
      try {
        const started = Date.now();
        await Promise.all([1, 2, 3, 4].map((n) => ask(`/t/sleep/1/pool-${n}/`)));
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      } finally {
        await apply({}, 'php');
      }
    });

    it('a pool file PHP-FPM refuses leaves the pool as it is', async () => {
      writeFileWhole(path.join(paths.runtimeDir, 'php-fpm-pool.conf'), '[www]\npm.max_children = banana\n');
      await seenByContainer();
      const refused = await inSite(['wpl7-reload', 'php']);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('refused');
      expect((await ask('/t/page/after-bad-pool/')).status).toBe(200);
      await apply({}, 'php');
    });

    it('Site Health’s page cache check finds the cache: WP_Site_Health::get_test_page_cache run with wp eval, home_url pointed at nginx', async () => {
      await clearCache();
      const code = [
        "add_filter('home_url', function () { return 'http://127.0.0.1:8080/'; });",
        `add_filter('http_request_args', function ($args) { $args['headers']['Host'] = '${HOST}'; $args['headers']['X-Forwarded-Proto'] = 'https'; return $args; });`,
        '$health = new WP_Site_Health();',
        '$test = $health->get_test_page_cache();',
        "echo $test['status'], '|', wp_strip_all_tags($test['label']), '|', wp_strip_all_tags($test['description']);",
      ].join(' ');
      const result = await wp('eval', code);
      expect(result, result).toMatch(/^good\|/);
      expect(result).toMatch(/x-cache-status/i);
    });
  });

  describe('object cache, with the real Redis Object Cache plugin from wordpress.org', () => {
    const redis = (...args: string[]) => must(inSite(['redis-cli', '-s', REDIS_SOCKET_IN_CONTAINER, ...args], asSite), `redis-cli ${args.join(' ')}`);

    beforeAll(async () => {
      await apply({ redis: true }, 'redis');
      await wp('plugin', 'install', 'redis-cache', '--activate');
      await wp('redis', 'enable');
    }, 180_000);

    afterAll(async () => {
      await wp('redis', 'disable');
      await wp('plugin', 'deactivate', 'redis-cache');
      await apply({}, 'redis');
    }, 60_000);

    it('wp redis status says connected, over the socket, with phpredis', async () => {
      const status = await wp('redis', 'status');
      expect(status, status).toMatch(/^Status:\s*Connected$/m);
      expect(status).toMatch(/^Client:\s*PhpRedis/m);
      expect(status).toMatch(/^Drop-in:\s*Valid$/m);
      expect(status).toContain(`WP_REDIS_PATH: "${REDIS_SOCKET_IN_CONTAINER}"`);
      expect(status).toContain('WP_REDIS_MAXTTL: 14400');
    });

    it('Redis has the panel’s settings: no port, an eighth of the memory, least recently used out first', async () => {
      expect(await redis('CONFIG', 'GET', 'port')).toBe('port\n0');
      expect(await redis('CONFIG', 'GET', 'maxmemory')).toBe(`maxmemory\n${64 * 1024 * 1024}`);
      expect(await redis('CONFIG', 'GET', 'maxmemory-policy')).toBe('maxmemory-policy\nallkeys-lru');
      expect(await must(inSite(['sh', '-c', "ps -o user= -C redis-server"]), 'ps')).toBe('www-data');
    });

    it('WP-CLI and the site share it, both ways', async () => {
      await wp('eval', "wp_cache_set('from-cli', 'cli-value', 'wpl7t', 300);");
      const seen = await ask('/t/cache-get/share/');
      expect(seen.json).toEqual({ value: 'cli-value', using: true });

      const set = await ask('/t/cache-set/site-value/');
      expect(set.json).toEqual({ using: true });
      expect(await wp('eval', "echo wp_cache_get('from-site', 'wpl7t');")).toBe('site-value');
    });

    it('FLUSHALL empties it for both', async () => {
      await wp('eval', "wp_cache_set('from-cli', 'cli-value', 'wpl7t', 300);");
      expect(await redis('FLUSHALL')).toBe('OK');
      expect(await wp('eval', "var_export(wp_cache_get('from-cli', 'wpl7t'));")).toBe('false');
      const seen = await ask('/t/cache-get/flushed/');
      expect(seen.json.value).toBe(false);
    });

    it('nothing of it is frozen into a stored page: no HTML comment', async () => {
      await clearCache();
      const page = await expectStored('/');
      expect(page.body).toContain('</html>');
      expect(page.body).not.toMatch(/redis/i);
      expect(page.body).not.toMatch(/Performance optimized/i);
    });

    it('Redis off leaves the site working, on the plugin’s own graceful path, and it comes back', async () => {
      await redisTo(false);
      expect((await inSite(['test', '-e', REDIS_SOCKET_IN_CONTAINER])).status).not.toBe(0);
      await clearCache();
      const page = await expectStored('/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('</html>');
      expect(await wp('option', 'get', 'blogname')).toContain('Engine test');
      // `wp redis status` alone refuses to be graceful: it fails, so the panel's job can't take it for connected.
      const status = await dockerCli('exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', SITE, 'wp', 'redis', 'status');
      expect(status.status).not.toBe(0);
      expect(status.stderr).toContain('Error establishing a Redis connection');

      await redisTo(true);
      expect(await wp('redis', 'status')).toMatch(/^Status:\s*Connected$/m);
    });

    it('wp redis disable works with Redis down, so switching it off can’t get stuck', async () => {
      await redisTo(false);
      await wp('redis', 'disable');
      expect((await inSite(['test', '-e', '/var/www/html/wp-content/object-cache.php'])).status).not.toBe(0);
      expect((await ask('/t/page/redis-disabled/')).status).toBe(200);
      await redisTo(true);
      await wp('redis', 'enable');
      expect(await wp('redis', 'status')).toMatch(/^Status:\s*Connected$/m);
    });

    it('it refuses a drop-in that isn’t its own, and says so: the reason the panel’s switch has to show', async () => {
      await wp('redis', 'disable');
      await writeInSite('/var/www/html/wp-content/object-cache.php', '<?php\n/*\nPlugin Name: Someone Else’s Cache\n*/\n');
      const refused = await dockerCli('exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', SITE, 'wp', 'redis', 'enable');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/foreign/i);
      await shell('rm -f /var/www/html/wp-content/object-cache.php');
      await wp('redis', 'enable');
      expect(await wp('redis', 'status')).toMatch(/^Status:\s*Connected$/m);
    });

    it('turning it down in place: wpl7-reload applies a new maxmemory', async () => {
      await apply({ redis: true, memoryMb: 256 }, 'redis');
      expect(await redis('CONFIG', 'GET', 'maxmemory')).toBe(`maxmemory\n${32 * 1024 * 1024}`);
      await apply({ redis: true }, 'redis');
    });
  });

  describe('WooCommerce, the real plugin from wordpress.org', () => {
    let product = '';

    beforeAll(async () => {
      await wp('plugin', 'install', 'woocommerce', '--activate');
      // Activation leaves the rest for the next request that loads WordPress.
      await wp('wc', 'tool', 'run', 'install_pages', `--user=${ADMIN}`);
      product = await wp('eval', "$p = new WC_Product_Simple(); $p->set_name('Thing'); $p->set_slug('thing'); $p->set_regular_price('10'); $p->set_status('publish'); echo $p->save();");
      await wp('rewrite', 'flush');
      await clearCache();
    }, 600_000);

    it('a shop page is stored for a visitor with no cart', async () => {
      await clearCache();
      for (const url of ['/', '/shop/', '/product/thing/']) {
        const page = await expectStored(url);
        expect(page.status, url).toBe(200);
      }
    });

    it('the cart, the checkout and the account page aren’t, under any slug', async () => {
      // An empty cart's checkout sends the visitor back to the cart, which isn't stored for its own reason.
      const pages: [string, number, string][] = [
        ['woocommerce_cart_page_id', 200, 'DONOTCACHEPAGE'],
        ['woocommerce_checkout_page_id', 302, 'status 302'],
        ['woocommerce_myaccount_page_id', 200, 'DONOTCACHEPAGE'],
      ];
      for (const [option, status, reason] of pages) {
        const url = new URL(await wp('eval', `echo get_permalink(get_option('${option}'));`)).pathname;
        const page = await expectNotStored(url, reason);
        expect(page.status, url).toBe(status);
      }
      await wp('post', 'update', await wp('option', 'get', 'woocommerce_cart_page_id'), '--post_name=basket');
      await wp('rewrite', 'flush');
      const renamed = await expectNotStored('/basket/', 'DONOTCACHEPAGE');
      expect(renamed.status).toBe(200);
      await wp('post', 'update', await wp('option', 'get', 'woocommerce_cart_page_id'), '--post_name=cart');
      await wp('rewrite', 'flush');
    });

    it('a real cart: its cookies skip the cache, and a visitor without one gets a stored page that knows nothing of it', async () => {
      const added = await expectBypass(`/?add-to-cart=${product}`, 'query string');
      const cookies = added.all('set-cookie').map((line) => line.split(';')[0]!);
      expect(cookies.some((c) => c.startsWith('woocommerce_items_in_cart='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('woocommerce_cart_hash='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('wp_woocommerce_session_'))).toBe(true);
      const cookie = cookies.filter((c) => !c.endsWith('=deleted')).join('; ');

      await expectBypass('/shop/', 'cookie woocommerce_items_in_cart', { cookie });
      expect((await ask('/cart/', { cookie })).cache).toBe('BYPASS');
      await expectBypass('/shop/', 'cookie woocommerce_items_in_cart', { cookie: 'woocommerce_items_in_cart=1' });
      await expectBypass('/shop/', 'cookie woocommerce_cart_hash', { cookie: 'woocommerce_cart_hash=abc' });
      await expectBypass('/shop/', 'cookie wp_woocommerce_session_', { cookie: 'wp_woocommerce_session_abc=1' });
    });

    it('a stock change clears', async () => {
      await expectClears('a stock change', () =>
        wp('eval', `$p = wc_get_product(${product}); $p->set_manage_stock(true); $p->set_stock_quantity(5); $p->save(); wc_update_product_stock($p, 3, 'set');`),
      );
    });

    it('plain Geolocate turns storing off, with its reason', async () => {
      await wp('option', 'update', 'woocommerce_default_customer_address', 'geolocation');
      try {
        await clearCache();
        for (const url of ['/', '/shop/', '/product/thing/']) {
          const page = await expectNotStored(url, 'WooCommerce Geolocate');
          expect(page.status, url).toBe(200);
        }
      } finally {
        await wp('option', 'update', 'woocommerce_default_customer_address', 'base');
      }
      await clearCache();
      await expectStored('/shop/');
    });

    it('real CURCY (woo-multi-currency): two Cookie lines cannot put the wrong price in a separate copy', async () => {
      await wp('plugin', 'install', 'woo-multi-currency', '--activate');
      await wp('eval', "update_option('woo_multi_currency_params', array_merge((array) get_option('woo_multi_currency_params', []), ['enable' => 1, 'currency_default' => 'USD', 'currency' => ['USD', 'EUR'], 'currency_rate' => [1, 0.5], 'currency_rate_fee' => [0, 0], 'currency_decimals' => [2, 2], 'currency_custom' => ['', ''], 'currency_pos' => ['left', 'left'], 'auto_detect' => 0]));");
      try {
        const currency = (answer: Answer) => /"priceCurrency":"([A-Z]+)"/.exec(answer.body)?.[1];
        await clearCache();
        expect(currency(await ask('/product/thing/', { cookie: 'wmc_current_currency=EUR' }))).toBe('EUR');
        expect(currency(await ask('/product/thing/'))).toBe('USD');
        await clearCache();
        const attacker = await ask('/product/thing/', { extraArgs: ['-H', 'Cookie: wmc_current_currency=EUR', '-H', 'Cookie: _ga=1'] });
        expect([attacker.cache, currency(attacker)]).toEqual(['MISS', 'EUR']);
        const honest = await ask('/product/thing/', { cookie: 'wmc_current_currency=EUR' });
        expect([honest.cache, currency(honest)]).toEqual(['HIT', 'EUR']);
        await expectBypass('/product/thing/', SEPARATE_COPY, { cookie: 'wmc_current_currency=USD ; _ga=1' });
      } finally {
        await wp('plugin', 'deactivate', 'woo-multi-currency');
        await clearCache();
      }
    });

    it('Cloudflare’s country reaches a store that geolocates, and only that', async () => {
      await wp('option', 'update', 'woocommerce_default_customer_address', 'geolocation_ajax');
      try {
        await clearCache();
        const hash = async (country: string) => new URL((await ask('/shop/', { headers: { 'CF-IPCountry': country } })).get('location')!).searchParams.get('v');
        const germany = await hash('DE');
        const france = await hash('FR');
        expect(germany).toBeTruthy();
        expect(france).not.toBe(germany);
        await expectStored(`/shop/?v=${germany}`, { headers: { 'CF-IPCountry': 'DE' } });
      } finally {
        await wp('option', 'update', 'woocommerce_default_customer_address', 'base');
        await clearCache();
      }
    });

    it('Geolocate with page caching support: a redirect that isn’t stored, then a copy per ?v=', async () => {
      await wp('option', 'update', 'woocommerce_default_customer_address', 'geolocation_ajax');
      try {
        await clearCache();
        const redirect = await expectNotStored('/shop/', 'status 307');
        expect(redirect.status).toBe(307);
        const location = new URL(redirect.get('location')!);
        const hash = location.searchParams.get('v');
        expect(hash).toBeTruthy();
        const page = await expectStored(`/shop/?v=${hash}`);
        expect(page.status).toBe(200);
      } finally {
        await wp('option', 'update', 'woocommerce_default_customer_address', 'base');
      }
    });
  });

  describe('other real plugins from wordpress.org', () => {
    it('WPForms Lite: one visitor’s Referer is not frozen into the form everyone gets', async () => {
      await wp('plugin', 'install', 'wpforms-lite', '--activate');
      try {
        const form = await wp('eval', "$id = wpforms()->obj('form')->add('Contact', [], ['builder' => false]); wpforms()->obj('form')->update($id, ['id' => $id, 'field_id' => 3, 'fields' => [1 => ['id' => 1, 'type' => 'text', 'label' => 'Name', 'size' => 'medium']], 'settings' => ['form_title' => 'Contact', 'submit_text' => 'Send', 'antispam_v3' => '0'], 'meta' => ['template' => 'blank']]); echo $id;", `--user=${ADMIN}`);
        await wp('post', 'create', '--post_type=page', '--post_title=Contact', '--post_name=contact', '--post_status=publish', `--post_content=[wpforms id="${form}"]`);
        await clearCache();
        const first = await ask('/contact/', { headers: { Referer: 'https://intranet.example.com/reset?token=SECRET-TOKEN' } });
        expect(first.cache).toBe('MISS');
        expect(first.body).toContain('name="url_referer"');
        expect(first.body).not.toContain('SECRET-TOKEN');
        const second = await ask('/contact/');
        expect([second.cache, second.body]).toEqual(['HIT', first.body]);
      } finally {
        await wp('plugin', 'deactivate', 'wpforms-lite');
      }
    });

    it('Complianz: a visitor who agreed does not store a page for one who refused', async () => {
      await wp('plugin', 'install', 'complianz-gdpr', '--activate');
      try {
        await wp('eval', "update_option('cmplz_options', array_merge((array) get_option('cmplz_options', []), ['regions' => 'eu', 'country_company' => 'NL', 'eu_consent_regions' => 'yes', 'uses_cookies' => 'yes']));");
        expect(await wp('eval', 'echo COMPLIANZ::$company->get_default_consenttype();')).toBe('optin');
        await wp('post', 'create', '--post_type=page', '--post_title=Consent', '--post_name=consent', '--post_status=publish', '--post_content=[cmplz-consent-area category="marketing"]ONLY-AFTER-CONSENT[/cmplz-consent-area]');
        await clearCache();
        const agreed = await ask('/consent/', { cookie: 'cmplz_marketing=allow' });
        expect(agreed.body).toContain('ONLY-AFTER-CONSENT');
        const nobody = await ask('/consent/');
        expect([nobody.cache, nobody.body.includes('ONLY-AFTER-CONSENT')]).toEqual(['MISS', false]);
        const refused = await ask('/consent/', { cookie: 'cmplz_marketing=deny' });
        expect(refused.body).not.toContain('ONLY-AFTER-CONSENT');
      } finally {
        await wp('plugin', 'deactivate', 'complianz-gdpr');
      }
    });

    it('Download Monitor: its address has no extension, and resume, its size, its XHR and its hotlink check go on working', async () => {
      await wp('plugin', 'install', 'download-monitor', '--activate');
      try {
        await shell('mkdir -p /var/www/html/wp-content/uploads/dlm_uploads && head -c 5242880 /dev/urandom > /var/www/html/wp-content/uploads/dlm_uploads/five.bin');
        const id = await wp('eval', `$d = wp_insert_post(['post_title' => 'Five', 'post_status' => 'publish', 'post_type' => 'dlm_download']); $v = wp_insert_post(['post_title' => 'v1', 'post_status' => 'publish', 'post_type' => 'dlm_download_version', 'post_parent' => $d]); update_post_meta($v, '_version', '1'); update_post_meta($v, '_files', wp_json_encode(['https://${HOST}/wp-content/uploads/dlm_uploads/five.bin'])); update_post_meta($v, '_filesize', 5242880); update_post_meta($d, '_members_only', 'no'); echo $d;`, `--user=${ADMIN}`);
        await wp('rewrite', 'flush');
        await wp('transient', 'delete', '--all');
        await clearCache();
        const url = `/download/${id}/`;
        const whole = await ask(url);
        expect([whole.status, whole.get('content-length'), whole.raw.length]).toEqual([200, '5242880', 5_242_880]);
        const part = await expectBypass(url, 'range', { headers: { Range: 'bytes=100-199' } });
        expect([part.status, part.get('content-range'), part.raw.length]).toEqual([206, 'bytes 100-199/5242880', 100]);
        const xhr = await ask(url, { headers: { 'dlm-xhr-request': 'dlm_XMLHttpRequest' } });
        expect(xhr.get('x-dlm-download-id')).toBe(id);
        await wp('option', 'update', 'dlm_hotlink_protection_enabled', '1');
        const hotlinked = await ask(url, { headers: { Referer: 'https://elsewhere.example.net/' } });
        expect(hotlinked.status).toBe(302);
        const linked = await ask(url, { headers: { Referer: `https://${HOST}/somewhere/` } });
        expect(linked.status).toBe(200);
      } finally {
        await wp('option', 'delete', 'dlm_hotlink_protection_enabled');
        await wp('plugin', 'deactivate', 'download-monitor');
        await shell('rm -f /var/www/html/wp-content/uploads/dlm_uploads/five.bin');
      }
    });
  });

  describe('after all of that', () => {
    it('nothing crashed: the container never restarted by itself, and its log shows no signal 11', async () => {
      expect(await must(dockerCli('inspect', '-f', '{{.RestartCount}}', SITE), 'inspect')).toBe('0');
      // nginx's one complaint is about the broken file a test above starts it with on purpose.
      const log = (await logsOf(SITE)).replace(/.*\[emerg\].*unknown directive "this".*\n/g, '');
      expect(log).not.toMatch(/exited by itself/);
      expect(log).not.toMatch(/signal 11|segfault|\[emerg\]/);
      // The watcher keeps quiet about a site with no root .htaccess yet, as this one had at its start.
      expect(log).not.toMatch(/\.htaccess: No such file/);
    });

    it('a stop is graceful: inside Docker’s 20 s, exit 0, and a start brings it all back', async () => {
      const started = Date.now();
      await must(dockerCli('stop', '-t', '20', SITE), 'stop');
      expect(Date.now() - started).toBeLessThan(19_000);
      expect(await must(dockerCli('inspect', '-f', '{{.State.ExitCode}}', SITE), 'inspect')).toBe('0');
      await dockerService.startContainer(SITE);
      await waitFor('the site to answer', siteAnswers);
    });

    it('a stop with a long request running: it gets 5 s, and then the site is on its way', async () => {
      const running = inSite(['curl', '-s', '-o', '/dev/null', '--max-time', '30', '-H', `Host: ${HOST}`, '-H', 'X-Forwarded-Proto: https', 'http://127.0.0.1:8080/t/sleep/60/stopping/']);
      await sleep(1_000);
      const started = Date.now();
      await must(dockerCli('stop', '-t', '20', SITE), 'stop');
      expect(Date.now() - started).toBeLessThan(10_000);
      await running;
      expect(await must(dockerCli('inspect', '-f', '{{.State.ExitCode}}', SITE), 'inspect')).toBe('0');
      await dockerService.startContainer(SITE);
      await waitFor('the site to answer', siteAnswers);
    });

    it.each<[string, string]>([
      ['nginx', 'kill -9 "$(cat /run/nginx.pid)"'],
      ['PHP-FPM', 'kill -9 "$(cat /run/php-fpm.pid)"'],
      ['Apache', 'kill -9 "$(cat /var/run/apache2/apache2.pid)"'],
    ])('%s dying takes the container with it, and the restart policy brings the site back, its cache empty', async (service, kill) => {
      const url = `/t/page/dies-${service}/`;
      const restarts = Number(await must(dockerCli('inspect', '-f', '{{.RestartCount}}', SITE), 'inspect'));
      const page = await expectStored(url);
      await inSite(['sh', '-c', kill]);
      await waitFor('the restart', async () => Number(await must(dockerCli('inspect', '-f', '{{.RestartCount}}', SITE), 'inspect')) === restarts + 1, 30_000);
      await waitFor('the site to answer', siteAnswers);
      const after = await ask(url);
      expect(after.cache).toBe('MISS');
      expect(after.body).not.toBe(page.body);
    });
  });

  /**
   * A real site from before all this, moved the way every site will be: an update moves the image's
   * tag, the image sweep sees that, and queues site.reconcile, which goes through replaceContainer.
   *
   * Real: both images; a real Traefik of the version the panel's stack pins, reading the labels of each
   * container, and the panel's own check of the site through it, so that an answer is an answer;
   * WordPress and MariaDB; WooCommerce and Wordfence from wordpress.org, Wordfence's firewall set up by
   * its own code; the sweep, the jobs, the panel's Docker service and its files; the migration script in
   * its throwaway container; a backup and a restore with real archives.
   *
   * Stand-ins, all of them:
   * - the panel's database is a test world's, with the real schema, and its worker runs in this process;
   * - the panel's names for its infrastructure lead to this test's containers, so that a stack on this
   *   Docker is left alone: Traefik is the one here, MariaDB and the mail relay the ones above (the
   *   relay is a small PHP listener, and the panel's login sync with it fails, which a job only warns about);
   * - the way out is this test's own network, for the same reason;
   * - TLS_MODE=none, so Traefik's plain entrypoint and no certificates: labels, routing and answers are the same;
   * - tar writing an archive, and chown, run as root in a throwaway container: a panel is root on
   *   its server, and a test runner isn't;
   * - a restore's database half is the test world's fake, so MariaDB keeps what it has: it is the
   *   files that are at stake here;
   * - the second time this site is on the old image is this test's doing. No panel goes back once it has
   *   moved, but it is the same store on another setting, and one WooCommerce install less;
   * - a move's arrival and an import's are the real restoreSiteOnServer on this same Docker, which is
   *   playing a server that has never had the site. The jobs around it, with the transfer and the pull,
   *   are in test/unit/siteArrivals.test.ts, with real tar and the real script, and no real Docker.
   *
   * What it can't see: amd64 and a real SSH server. What a real check can't reach, a create that fails
   * and a stopped site, is in test/engine/siteSwitch.test.ts.
   */
  describe('a real site moving from mod_php to PHP-FPM, by the panel’s own sweep and job', { timeout: 600_000 }, () => {
    const SLUG_MOVED = `enginemove${process.pid}`;
    const MOVED = `wp-${SLUG_MOVED}`;
    const HOST_MOVED = 'move.example.com';
    const NETWORK_MOVED = siteNetworkName(SLUG_MOVED);
    const PHP_MOVED = `move${process.pid}`;
    const TAG_MOVED = siteImage(PHP_MOVED);
    const ROLLBACK_TAG = siteRollbackImage(SLUG_MOVED);
    const EDGE = `wpl7-engine-site-edge-${process.pid}`;
    const BROKEN_IMAGE = `wpl7-engine-site-broken:${process.pid}`;
    const OLD_IMAGE = process.env.WPL7_ENGINE_OLD_SITE_IMAGE ?? `wpl7-wordpress:php${PHP}-stack1`;
    /** The last commit with the image from before stack 2. */
    const LAST_OLD_IMAGE_COMMIT = '028ea18';
    const REPO = fileURLToPath(new URL('../../..', import.meta.url));
    const movedRoot = path.join(fs.realpathSync(os.tmpdir()), `wpl7-site-moved-${process.pid}`);

    /** What each folder of the site ran with, as PHP sees it. */
    const CHECK_PHP = String.raw`<?php
header('Content-Type: application/json');
echo json_encode([
    'sapi' => PHP_SAPI,
    'maxInputVars' => ini_get('max_input_vars'),
    'uploadMax' => ini_get('upload_max_filesize'),
    'strictSessions' => ini_get('session.use_strict_mode'),
    'memory' => ini_get('memory_limit'),
    'prepend' => ini_get('auto_prepend_file'),
    'basedir' => ini_get('open_basedir'),
    'firewall' => defined('WFWAF_AUTO_PREPEND') && WFWAF_AUTO_PREPEND,
]);
`;
    const BARE_LINE = 'php_value max_input_vars 4321';
    const SOURCE_ONLY = 'only-in-the-source';
    const SECRET_PHP = `<?php /* ${SOURCE_ONLY} */ echo 'php-' . 'ran';\n`;
    /** What another host left, which mod_php never read: PHP-FPM would. */
    const OLD_HOST_INI = "; Wordfence WAF\nauto_prepend_file = '/home/olduser/public_html/wordfence-waf.php'\n; END Wordfence WAF\nopen_basedir = /home/olduser/public_html:/tmp\nmemory_limit = 64M\n";
    /** The .htaccess files that have to come back byte for byte. */
    const HTACCESS_FILES = ['.htaccess', 'settings/.htaccess', 'crlf/.htaccess'];
    /** Real WordPress files for Traefik's first answer: says nothing about PHP. */
    const STATIC_FILE = '/wp-includes/images/blank.gif';
    const FAILS_ON_FPM = 'wp-content/mu-plugins/wpl7-engine-fails-on-fpm.php';
    /**
     * A home page that takes longer than the panel's usual check waits, as a store's can. Only for that
     * check, so that nothing else here has to wait: its answer is what a move goes by.
     */
    const SLOW_FOR_THE_CHECK = 'wp-content/mu-plugins/wpl7-engine-slow-for-the-check.php';
    const STALE_RUNTIME_FILES = ['nginx-site.conf', 'redis.conf', 'from-another-version.conf'];
    /** What the panel writes there for this site: no object cache. */
    const RUNTIME_FILES = ['nginx-site.conf', 'php-fpm-pool.conf', 'php.ini', 'wp-cache.php'];

    /**
     * A server's Docker, on a Docker that may have a real stack on it (see above). Everything else is
     * the panel's own service.
     */
    class MovedDocker extends DockerService {
      private readonly theirs = new Map([
        [TRAEFIK_CONTAINER, EDGE],
        [MARIADB_CONTAINER, DATABASE],
        [MAIL_CONTAINER, RELAY],
      ]);

      override containerState(name: string) {
        return super.containerState(this.theirs.get(name) ?? name);
      }

      override containerNetworks(name: string) {
        return super.containerNetworks(this.theirs.get(name) ?? name);
      }

      override connectContainer(network: string, container: string, opts?: ConnectOpts) {
        return super.connectContainer(network, this.theirs.get(container) ?? container, opts);
      }

      override async ensureNetwork(spec: NetworkSpec) {
        if (spec.name === PANEL_EGRESS_NETWORK) return { outcome: 'existing' as const, detached: [] };
        return super.ensureNetwork(spec);
      }

      override createSiteContainer(spec: SiteContainerSpec) {
        return super.createSiteContainer({ ...spec, networks: [NETWORK_MOVED, EGRESS_NETWORK] });
      }
    }

    const movedDocker = new MovedDocker('wpl7_proxy', 'wpl7_db');
    let w: TestWorld;
    let siteId = 0;
    let oldId = '';
    let newId = '';
    let brokenId = '';
    let edgePort = 0;
    let postId = '';
    let backupId = 0;
    /** What the site's files were before anything moved them. */
    const before = new Map<string, string>();
    /** And what they are once the panel has. */
    const moved = new Map<string, string>();

    const fresh = (): SiteRow => w.db.select().from(sites).where(eq(sites.id, siteId)).get()!;
    const jobRow = (id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    const logOf = (id: number) => w.db.select().from(jobLogs).where(eq(jobLogs.jobId, id)).all().map((line) => line.message);
    const handle = () => w.servers.handleFor(1);
    const inMoved = (command: string[], opts: { user?: string; input?: string | Buffer } = {}) =>
      run('docker', ['exec', ...(opts.input === undefined ? [] : ['-i']), ...(opts.user ? ['-u', opts.user] : []), MOVED, ...command], opts.input);
    const wpMoved = (...args: string[]) => must(dockerCli('exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', MOVED, 'wp', ...args), `wp ${args.join(' ')}`);
    const writeInMoved = (file: string, content: string) => must(inMoved(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `/var/www/html/${file}`], { ...asSite, input: content }), `writing ${file}`);
    const inspectMoved = (format: string) => must(dockerCli('inspect', '-f', format, MOVED), 'inspect');
    const portLabel = () => inspectMoved(`{{index .Config.Labels "traefik.http.services.${MOVED}.loadbalancer.server.port"}}`);

    /** A file as it is in the site, every byte of it. */
    async function fileInMoved(file: string): Promise<string> {
      const done = await inMoved(['cat', `/var/www/html/${file}`]);
      if (done.status !== 0) throw new Error(`reading ${file} failed: ${done.stderr}`);
      return done.stdout.toString('utf8');
    }

    /** A request the way a visitor makes it: to Traefik, for the site's name. */
    async function viaEdge(url: string, opts: AskOpts = {}): Promise<Answer> {
      const [command, ...args] = curlArgs(url, { host: HOST_MOVED, proto: null, port: edgePort, ...opts });
      const done = await run(command!, args);
      if (done.status !== 0) throw new Error(`curl ${url} through Traefik failed (${done.status}): ${done.stderr}`);
      return parseAnswer(done.stdout);
    }

    /** Traefik goes by Docker's events, so it finds a new container a moment after it starts. */
    const routed = () => waitFor('Traefik to reach the site', async () => (await viaEdge(STATIC_FILE)).status === 200, 60_000, 250);

    interface Checked {
      sapi: string;
      maxInputVars: string;
      uploadMax: string;
      strictSessions: string;
      memory: string;
      prepend: string;
      basedir: string;
      firewall: boolean;
    }

    async function checked(folder = ''): Promise<Checked> {
      const answer = await viaEdge(`${folder}/check.php`);
      expect(answer.status, `${folder}/check.php: ${answer.body.slice(0, 300)}`).toBe(200);
      return answer.json as Checked;
    }

    const buildImage = async (tag: string, dockerfile: string) => {
      await must(run('docker', ['build', '-q', '-t', tag, '-'], dockerfile), `building ${tag}`);
      return must(dockerCli('image', 'inspect', '-f', '{{.Id}}', tag), 'image id');
    };

    /** What an update does: the tag goes to another image, and the one it left may have no name now. */
    const moveTag = (id: string) => must(dockerCli('tag', id, TAG_MOVED), 'moving the tag');

    const namesOf = async (id: string): Promise<string[] | null> => {
      const done = await dockerCli('image', 'inspect', '-f', '{{json .RepoTags}}', id);
      return done.status === 0 ? (JSON.parse(done.stdout.toString('utf8')) as string[]) : null;
    };

    async function runJob(id: number) {
      w.worker.start();
      await waitUntil(() => !['queued', 'running'].includes(jobRow(id).status), 400_000);
      await w.worker.stop();
      return jobRow(id);
    }

    /** The hourly sweep finds the tag has moved, and the job it queues runs. */
    async function sweepAndRun() {
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [SLUG_MOVED], busy: [] });
      return runJob(w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all().at(-1)!.id);
    }

    /** The same site on its old image, with its files as they were, and with what mod_php reads put back. */
    async function expectBackOnOldImage(reason: RegExp, failedOn: string): Promise<void> {
      await routed();
      expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: oldId, stack: 1 });
      expect(await inspectMoved('{{.Image}}')).toBe(oldId);
      expect(await inspectMoved(`{{index .Config.Labels "${SITE_STACK_LABEL}"}}`)).toBe('');
      expect(await portLabel()).toBe('80');

      expect(await must(inMoved(['apache2ctl', '-M']), 'modules')).toContain('php_module');
      const php = await checked();
      expect(php).toMatchObject({ sapi: 'apache2handler', maxInputVars: '4321', firewall: true });
      expect((await viaEdge('/')).status).toBe(200);

      for (const file of HTACCESS_FILES) expect(await fileInMoved(file), file).toBe(before.get(file));
      // The deny stays: it does the same job under mod_php, with a 403 for the source it used to send.
      const noPhp = await viaEdge('/no-php/secret.php');
      expect(noPhp.status).toBe(403);
      expect(noPhp.body).not.toContain(SOURCE_ONLY);

      // Still there, with no name, kept by the container that runs it: nothing else could undo this.
      expect(await namesOf(oldId)).toEqual([]);
      expect(await movedDocker.imageId(ROLLBACK_TAG)).toBeNull();
      expect(fresh().stackSwitchError).toMatch(reason);
      expect(fresh().stackSwitchImage).toBe(failedOn);
      expect((await w.deps.sites.detail(SLUG_MOVED)).stack).toBe(1);
    }

    beforeAll(async () => {
      if ((await dockerCli('image', 'inspect', OLD_IMAGE)).status !== 0) {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-old-image-'));
        await must(run('sh', ['-c', 'git -C "$1" archive "$2" deploy/wordpress-image | tar -x -C "$3"', 'sh', REPO, LAST_OLD_IMAGE_COMMIT, folder]), 'the old image’s files');
        await dockerService.buildImage(OLD_IMAGE, path.join(folder, 'deploy/wordpress-image'), { PHP_TAG: `php${PHP}` });
        fs.rmSync(folder, { recursive: true, force: true });
      }
      // Built here so that its id is this test's alone, and nothing else keeps it alive.
      oldId = await buildImage(TAG_MOVED, `FROM ${OLD_IMAGE}\nLABEL wpl7.engine.move=${process.pid}\n`);
      newId = await must(dockerCli('image', 'inspect', '-f', '{{.Id}}', IMAGE), 'image id');
      // A real stack 2 image whose nginx can't start. Its PHP works, so the migration still runs.
      brokenId = await buildImage(BROKEN_IMAGE, `FROM ${IMAGE}\nLABEL wpl7.engine.move=${process.pid}\nRUN sed -i '1i this is not nginx;' /etc/nginx/nginx.conf\n`);

      const compose = fs.readFileSync(path.join(REPO, 'deploy/docker-compose.yml'), 'utf8');
      const traefik = /^\s*image:\s*(traefik:\S+)/m.exec(compose)![1]!;
      await must(
        dockerCli(
          'run', '-d', '--name', EDGE, '-p', '127.0.0.1::80', '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', traefik,
          '--log.level=ERROR', '--providers.docker=true', '--providers.docker.exposedbydefault=false',
          // Only this site: there may be others on this Docker.
          `--providers.docker.constraints=Label(\`wpl7.site\`,\`${SLUG_MOVED}\`)`,
          '--entrypoints.web.address=:80',
        ),
        'Traefik',
      );
      edgePort = Number((await must(dockerCli('port', EDGE, '80/tcp'), 'its port')).split(':').pop());

      await must(
        run('docker', ['exec', '-i', DATABASE, 'mariadb', '-uroot', '-pengine-root'], `CREATE DATABASE wp_moved CHARACTER SET utf8mb4; CREATE USER 'wp_moved'@'%' IDENTIFIED BY '${DB_PASSWORD}'; GRANT ALL PRIVILEGES ON wp_moved.* TO 'wp_moved'@'%';`),
        'the database',
      );

      fs.mkdirSync(movedRoot, { recursive: true });
      const moveConfig = makeTestConfig({ SRV_ROOT: movedRoot });
      /** See above: root on the server, for what can't do without. */
      const asRoot = async (cmd: string, args: string[]) => {
        const done = await dockerCli('run', '--rm', '-v', `${movedRoot}:${movedRoot}`, '--entrypoint', cmd, IMAGE, ...args);
        return { stdout: done.stdout.toString('utf8'), stderr: done.stderr, exitCode: done.status };
      };
      const exec: ExecPort = {
        run: (cmd, args, opts) => (cmd === 'chown' || (cmd === 'tar' && args.includes('-czf')) ? asRoot(cmd, args) : hostExec.run(cmd, args, opts)),
        runWithInput: (cmd, args, input, opts) => hostExec.runWithInput(cmd, args, input, opts),
        runToStream: (cmd, args, stdout, opts) => hostExec.runToStream(cmd, args, stdout, opts),
      };
      w = await makeWorld({ config: moveConfig, exec });
      // A live panel's checks, rather than a test's, which go by the container's state.
      Object.assign(w.core.config, { nodeEnv: 'production', probeTimeoutMs: 30_000 });
      Object.assign(handle(), { docker: movedDocker, wp: new WpService(movedDocker), probeUrlFor: () => `http://127.0.0.1:${edgePort}/` });

      const now = Date.now();
      siteId = w.db
        .insert(sites)
        .values({
          slug: SLUG_MOVED,
          title: 'Moved',
          serverId: 1,
          domains: JSON.stringify([HOST_MOVED]),
          phpVersion: PHP_MOVED,
          status: 'running',
          dbName: 'wp_moved',
          dbUser: 'wp_moved',
          dbPassword: DB_PASSWORD,
          mailPassword: MAIL_PASSWORD,
          containerName: MOVED,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get().id;

      fs.mkdirSync(sitePaths(moveConfig, SLUG_MOVED).wordpress, { recursive: true });
      // The job that repairs a site with no container, on the only image there is: stack 1.
      const first = await runJob(w.deps.sites.reconcile(SLUG_MOVED).id);
      expect(first.status, first.error ?? '').toBe('succeeded');
      expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: oldId, stack: 1 });
      await waitFor('WordPress’s files', async () => (await inMoved(['test', '-f', '/var/www/html/wp-config.php'])).status === 0, 180_000, 500);
      await must(inMoved(['chown', '33:33', '/var/www/html']), 'the folder');
      await wpMoved('core', 'install', `--url=http://${HOST_MOVED}`, '--title=Moved', `--admin_user=${ADMIN}`, `--admin_password=${ADMIN_PASSWORD}`, '--admin_email=boss@example.com', '--skip-email');
      await wpMoved('rewrite', 'structure', DEFAULT_PERMALINK_STRUCTURE);
      await wpMoved('rewrite', 'flush', '--hard');
      await wpMoved('plugin', 'install', 'woocommerce', '--activate');
      await wpMoved('option', 'update', 'woocommerce_default_customer_address', 'geolocation');
      postId = await wpMoved('post', 'create', '--post_title=Written on mod_php', '--post_status=publish', '--porcelain');
      await wpMoved('option', 'update', 'wpl7_engine_marker', 'still here');
      // Wordfence's firewall, by its own code, as it sets itself up on Apache with mod_php. That is
      // the block in the .htaccess, with the file it names. The firewall runs from those alone, so its
      // plugin goes off again: until it has a licence it looks up the site's name on every page, and a
      // name like this one can take 16 s to come back empty, which is a test of DNS and not of this.
      await wpMoved('plugin', 'install', 'wordfence', '--activate');
      await wpMoved(
        'eval',
        "require_once ABSPATH . 'wp-admin/includes/file.php'; define('FS_METHOD', 'direct'); WP_Filesystem(); global $wp_filesystem; wfWAFAutoPrependHelper::helper('apache-mod_php')->performInstallation($wp_filesystem);",
      );
      await wpMoved('plugin', 'deactivate', 'wordfence');

      await must(inMoved(['sh', '-c', 'printf "%s\\n" "$1" >> /var/www/html/.htaccess', 'sh', BARE_LINE], asSite), 'the bare line');
      await writeInMoved('.user.ini', OLD_HOST_INI);
      await writeInMoved('check.php', CHECK_PHP);
      await writeInMoved('settings/.htaccess', 'php_value upload_max_filesize 77M\nphp_flag session.use_strict_mode on\n');
      await writeInMoved('settings/check.php', CHECK_PHP);
      await writeInMoved('crlf/.htaccess', 'php_value upload_max_filesize 55M\r\nOptions -Indexes\r\n');
      await writeInMoved('crlf/check.php', CHECK_PHP);
      await writeInMoved('no-php/.htaccess', 'php_flag engine off\n');
      await writeInMoved('no-php/secret.php', SECRET_PHP);
      await writeInMoved('no-php/note.txt', 'not PHP');
      // The form WPForms and Wordfence write theirs in. Nothing in the block changes, and the deny comes after it.
      await writeInMoved('no-php-in-block/.htaccess', '<IfModule mod_php.c>\n\tphp_flag engine off\n</IfModule>\n');
      await writeInMoved('no-php-in-block/secret.php', SECRET_PHP);
      for (const file of HTACCESS_FILES) before.set(file, await fileInMoved(file));

      // What an archive can hold of the folder the panel writes: a file it wouldn't write for this site
      // now, one from another version, and one nginx would refuse. Nothing on stack 1 reads them.
      const runtime = sitePaths(moveConfig, SLUG_MOVED).runtimeDir;
      for (const file of STALE_RUNTIME_FILES) fs.writeFileSync(path.join(runtime, file), 'this is not nginx;\n');
      backupId = (await w.core.backup.create(fresh(), 'manual', {})).id;
      for (const file of STALE_RUNTIME_FILES) fs.rmSync(path.join(runtime, file));
      await routed();
    }, 1_200_000);

    afterAll(async () => {
      if (KEEP) {
        process.stderr.write(`Left running as well: docker rm -f -v ${MOVED} ${EDGE}; docker network rm ${NETWORK_MOVED}; docker rmi -f ${TAG_MOVED} ${BROKEN_IMAGE} ${ROLLBACK_TAG}; rm -rf ${movedRoot}\n`);
        return;
      }
      await w?.worker.stop();
      await dockerCli('rm', '-f', '-v', MOVED, EDGE);
      await dockerCli('network', 'disconnect', '-f', NETWORK_MOVED, DATABASE);
      await dockerCli('network', 'disconnect', '-f', NETWORK_MOVED, RELAY);
      await dockerCli('network', 'rm', NETWORK_MOVED);
      await dockerCli('rmi', '-f', TAG_MOVED, BROKEN_IMAGE, ROLLBACK_TAG);
      // Once a tag has moved off an image nothing else names it, and a build without BuildKit leaves
      // a nameless image for each of its steps. All of them have this label, and nothing else does.
      await dockerCli('image', 'prune', '-f', '--filter', `label=wpl7.engine.move=${process.pid}`);
      // Files the site's user made, in a folder the runner doesn't own on every system.
      await dockerCli('run', '--rm', '-v', `${movedRoot}:/moved`, '--entrypoint', 'find', IMAGE, '/moved', '-mindepth', '1', '-delete');
      fs.rmSync(movedRoot, { recursive: true, force: true });
    }, 180_000);

    it('starts on stack 1: mod_php reads the .htaccess, and has never read the .user.ini', async () => {
      expect(await portLabel()).toBe('80');
      expect((await viaEdge('/')).status).toBe(200);
      expect(await checked()).toEqual({
        sapi: 'apache2handler',
        maxInputVars: '4321',
        uploadMax: '64M',
        strictSessions: '0',
        memory: '256M',
        prepend: '/var/www/html/wordfence-waf.php',
        basedir: '',
        firewall: true,
      });
      expect(await checked('/settings')).toMatchObject({ uploadMax: '77M', strictSessions: '1' });
      expect(await checked('/crlf')).toMatchObject({ uploadMax: '55M' });
      // mod_php's way of not running a file is to send it as it is.
      for (const folder of ['/no-php', '/no-php-in-block']) {
        const answer = await viaEdge(`${folder}/secret.php`);
        expect(answer.body, folder).not.toBe('php-ran');
        expect(answer.body, folder).toContain(SOURCE_ONLY);
      }
      // Wordfence's own block, as it wrote it: three of them, of which only one has ever been read here.
      expect(before.get('.htaccess')).toMatch(/# Wordfence WAF\n<IfModule mod_php5\.c>[\s\S]*<IfModule mod_php\.c>\n\tphp_value auto_prepend_file '\/var\/www\/html\/wordfence-waf\.php'\n<\/IfModule>[\s\S]*# END Wordfence WAF/);
    });

    it('goes back to the same image by id from a site that answers 500 only under PHP-FPM', async () => {
      // What a site can do that nothing can foresee, and only the check finds.
      await writeInMoved(FAILS_ON_FPM, "<?php if (PHP_SAPI === 'fpm-fcgi') { http_response_code(500); exit('not on PHP-FPM'); }\n");
      await writeInMoved(SLOW_FOR_THE_CHECK, `<?php if (($_SERVER['HTTP_USER_AGENT'] ?? '') === '${PROBE}' && ($_SERVER['REQUEST_URI'] ?? '') === '/') { sleep(9); }\n`);
      expect((await viaEdge('/')).status).toBe(200);

      await moveTag(newId);
      expect(await namesOf(oldId)).toEqual([]);
      const done = await sweepAndRun();

      expect(done.status).toBe('failed');
      expect(done.error).toBe('This site still runs the old PHP setup: the check on the new setup failed: it answered HTTP 500.');
      await expectBackOnOldImage(/^the check on the new setup failed: it answered HTTP 500$/, newId);
      const log = logOf(done.id).join('\n');
      expect(log).toContain(`.htaccess:`);
      expect(log).toContain('php_value max_input_vars: moved to .user.ini');
      expect(log).toMatch(/\.htaccess files put back: \d+ lines?\./);
      expect(log).toContain(`The temporary name ${ROLLBACK_TAG} is gone.`);
      expect(log).not.toContain('The site answers on the new setup');
    });

    it('asked real WooCommerce before it tried: a store on plain Geolocate has its Off, with the reason, even when the move then fails', () => {
      const site = fresh();
      expect(site.pageCache).toBe('off');
      expect(parseSiteCacheRules(site.cacheRules).offReason).toBe(GEOLOCATE_OFF_REASON);
    });

    it('leaves it alone while the tag names the image it failed on', async () => {
      expect(await sweepSiteImages(w.core, w.worker)).toEqual({ queued: [], busy: [] });
    });

    it('tries again on a new image, and goes back the same way from one whose nginx does not start', async () => {
      await must(inMoved(['rm', '-f', `/var/www/html/${FAILS_ON_FPM}`], asSite), 'the plugin');
      await moveTag(brokenId);
      const done = await sweepAndRun();

      expect(done.status).toBe('failed');
      // Traefik's own answer, once the container has gone from under it.
      expect(done.error).toMatch(/^This site still runs the old PHP setup: the check on the new setup failed: (it answered HTTP \d+|nothing answered)\.$/);
      await expectBackOnOldImage(/^the check on the new setup failed: /, brokenId);
    });

    describe('once it moves', () => {
      beforeAll(async () => {
        // As a site that never tried: this is the switch that has to decide.
        w.db.update(sites).set({ pageCache: null, cacheRules: null }).where(eq(sites.id, siteId)).run();
        await moveTag(newId);
        const done = await sweepAndRun();
        expect(done.status, done.error ?? '').toBe('succeeded');
        expect((JSON.parse(done.result!) as { changed: string[] }).changed).toContain('moved to PHP-FPM');
        await routed();
        await must(inMoved(['rm', '-f', `/var/www/html/${SLOW_FOR_THE_CHECK}`], asSite), 'the plugin');
        for (const file of [...HTACCESS_FILES, '.user.ini']) moved.set(file, await fileInMoved(file));
      }, 600_000);

      it('runs on the new image and answers through nginx, with nothing left of the old one', async () => {
        expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: newId, stack: 2 });
        expect(await inspectMoved(`{{index .Config.Labels "${SITE_STACK_LABEL}"}}`)).toBe('2');
        expect(await portLabel()).toBe(String(SITE_STACK_PORT));
        expect(fresh()).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });
        expect(await w.deps.sites.detail(SLUG_MOVED)).toMatchObject({ stack: 2, stackSwitchError: null });
        const home = await viaEdge('/');
        expect(home.status).toBe(200);
        expect(home.cache).toBe('BYPASS');
        // The temporary name went, and with it the image: nothing runs it now, and it had no other name.
        expect(await movedDocker.imageId(ROLLBACK_TAG)).toBeNull();
        expect(await namesOf(oldId)).toBeNull();
      });

      it('has every post and option it had', async () => {
        expect(await wpMoved('post', 'get', postId, '--field=post_title')).toBe('Written on mod_php');
        expect(await wpMoved('option', 'get', 'wpl7_engine_marker')).toBe('still here');
        await wpMoved('plugin', 'is-active', 'woocommerce');
        const url = new URL(await wpMoved('post', 'url', postId));
        const page = await viaEdge(url.pathname);
        expect(page.status).toBe(200);
        expect(page.body).toContain('Written on mod_php');
      });

      it('a bare php_value is no 500 any more, and its setting applies from .user.ini', async () => {
        expect(await checked()).toMatchObject({ sapi: 'fpm-fcgi', maxInputVars: '4321' });
        expect(moved.get('.htaccess')).toContain(`# Moved to .user.ini by WPL7: ${BARE_LINE}`);
        expect(moved.get('.user.ini')).toContain("max_input_vars = '4321'");
        expect(await checked('/settings')).toMatchObject({ sapi: 'fpm-fcgi', uploadMax: '77M', strictSessions: '1' });
        expect(await checked('/crlf')).toMatchObject({ uploadMax: '55M' });
        // Its other line ending, untouched, for the undo and for anyone reading the file.
        expect(moved.get('crlf/.htaccess')).toBe('# Moved to .user.ini by WPL7: php_value upload_max_filesize 55M\r\nOptions -Indexes\r\n');
      });

      it.each(['/no-php', '/no-php-in-block'])('PHP stays off in %s: it does not run, and its source is not shown', async (folder) => {
        const answer = await viaEdge(`${folder}/secret.php`);
        expect(answer.status).toBe(403);
        expect(answer.body).not.toContain('php-ran');
        expect(answer.body).not.toContain(SOURCE_ONLY);
        expect(answer.body).not.toContain('<?php');
      });

      it('what isn’t PHP in such a folder is still served', async () => {
        expect((await viaEdge('/no-php/note.txt')).body).toBe('not PHP');
      });

      it('Wordfence’s block stays word for word, and its real firewall still runs on every request', async () => {
        expect(await checked()).toMatchObject({ prepend: '/var/www/html/wordfence-waf.php', firewall: true });
        const block = /# Wordfence WAF[\s\S]*?# END Wordfence WAF/.exec(before.get('.htaccess')!)![0];
        expect(moved.get('.htaccess')).toContain(block);
        expect(moved.get('.user.ini')).toContain("auto_prepend_file = '/var/www/html/wordfence-waf.php'");
      });

      it('a .user.ini from another host no longer takes the site down: its paths and its lower limit are out', async () => {
        const php = await checked();
        expect(php.basedir).toBe('');
        expect(php.memory).toBe('256M');
        const ini = moved.get('.user.ini')!;
        expect(ini).toContain('; Not used by WPL7: open_basedir = /home/olduser/public_html:/tmp');
        expect(ini).toContain("; Not used by WPL7: auto_prepend_file = '/home/olduser/public_html/wordfence-waf.php'");
        expect(ini).toContain('; Not used by WPL7: memory_limit = 64M');
        // Not served, either way.
        expect((await viaEdge('/.user.ini')).status).toBe(403);
      });

      it('which it would: the same lines, left where nothing moved them, are a 500 and a refusal', async () => {
        await writeInMoved('leftover-prepend/.user.ini', "auto_prepend_file = '/home/olduser/public_html/wordfence-waf.php'\n");
        await writeInMoved('leftover-prepend/check.php', CHECK_PHP);
        await writeInMoved('leftover-basedir/.user.ini', 'open_basedir = /home/olduser/public_html:/tmp\n');
        await writeInMoved('leftover-basedir/check.php', CHECK_PHP);
        await writeInMoved('leftover-line/.htaccess', `${BARE_LINE}\n`);
        await writeInMoved('leftover-line/check.php', CHECK_PHP);
        expect((await viaEdge('/leftover-prepend/check.php')).status).toBe(500);
        expect((await viaEdge('/leftover-basedir/check.php')).status).toBe(403);
        expect((await viaEdge('/leftover-line/check.php')).status).toBe(500);
      });

      it('a store on plain Geolocate stays Off at the switch, with its reason, and nginx goes by that', async () => {
        const site = fresh();
        expect(site.pageCache).toBe('off');
        expect(parseSiteCacheRules(site.cacheRules).offReason).toBe(GEOLOCATE_OFF_REASON);
        const home = await viaEdge('/');
        expect([home.status, home.cache, home.skipped]).toEqual([200, 'BYPASS', 'off']);
      });

      it('an old backup brings it all back, and a real restore moves it again before the site starts', async () => {
        const job = w.worker.enqueue('backup.restore', { backupId, skipPreRestoreBackup: true }, { id: siteId, slug: SLUG_MOVED, serverId: 1 });
        const done = await runJob(job.id);
        expect(done.status, `${done.error ?? ''}\n${logOf(job.id).join('\n')}`).toBe('succeeded');
        await routed();

        expect(logOf(job.id).join('\n')).toContain('php_value max_input_vars: moved to .user.ini');
        for (const [file, text] of moved) expect(await fileInMoved(file), file).toBe(text);
        expect((await viaEdge('/')).status).toBe(200);
        expect(await checked()).toMatchObject({ sapi: 'fpm-fcgi', maxInputVars: '4321', prepend: '/var/www/html/wordfence-waf.php', firewall: true, memory: '256M', basedir: '' });
        expect(await checked('/settings')).toMatchObject({ uploadMax: '77M' });
        expect((await viaEdge('/no-php/secret.php')).status).toBe(403);
        // What the panel writes is what it says now, and the store's Off with it: not the archive's.
        expect(fresh().pageCache).toBe('off');
        expect((await viaEdge('/')).skipped).toBe('off');
        expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: newId, stack: 2 });
      });

      describe('its caches, through the panel', () => {
        const asRedis = ['redis-cli', '-s', REDIS_SOCKET_IN_CONTAINER];

        // This store went Off at the switch, for its Geolocate setting. It goes back to that after,
        // because what comes next expects it.
        beforeAll(async () => {
          await wpMoved('option', 'update', 'woocommerce_default_customer_address', 'base');
          await w.deps.sites.setCache(SLUG_MOVED, { page: 'default' });
        }, 120_000);

        afterAll(async () => {
          await wpMoved('option', 'update', 'woocommerce_default_customer_address', 'geolocation');
          await w.deps.sites.setCache(SLUG_MOVED, { page: 'off' });
        }, 120_000);

        /** Until it has held. The test before changed the root .htaccess, and the watcher on it clears within 10 s. */
        const stored = async (url: string) => {
          let last: unknown;
          await waitFor(`${url} to be stored`, async () => {
            last = await checkSiteUrl(handle(), w.config, fresh(), url);
            return (last as { state: string }).state === 'cached';
          }, 20_000, 1_000);
          return last;
        };

        it('says through Check a URL what the cache does with a page', async () => {
          const check = (url: string) => checkSiteUrl(handle(), w.config, fresh(), url);
          expect(await stored('/')).toEqual({ state: 'cached', reason: null, status: 200 });
          expect(await check('/wp-admin/')).toMatchObject({ state: 'skipped', reason: 'path /wp-admin/*' });
          expect(await check('/?anything=1')).toMatchObject({ state: 'skipped', reason: 'query string' });
          expect(await check('/no-such-page/')).toMatchObject({ state: 'cached', status: 404 });
        });

        it('applies a rule in the running container, and clears', async () => {
          const check = (url: string) => checkSiteUrl(handle(), w.config, fresh(), url);
          await w.deps.sites.setCache(SLUG_MOVED, { own: [{ kind: 'skip', match: 'path', value: '/no-cache-here/*' }] });
          expect(await check('/no-cache-here/page/')).toMatchObject({ state: 'skipped', reason: 'path /no-cache-here/*' });
          await w.deps.sites.setCache(SLUG_MOVED, { page: 'off' });
          expect(await check('/')).toMatchObject({ state: 'off' });
          await w.deps.sites.setCache(SLUG_MOVED, { page: 'default', own: [] });
          expect(await stored('/')).toMatchObject({ state: 'cached' });
        });

        it('empties the page cache with the panel’s clear', async () => {
          const cached = async () => (await inMoved(['find', PAGE_CACHE_DIR_IN_CONTAINER, '-type', 'f', '!', '-name', 'generation.*'], asSite)).stdout.toString('utf8').trim();
          await stored('/');
          expect(await cached()).not.toBe('');
          expect(await clearSiteCaches(handle(), fresh())).toBe(true);
          expect(await cached()).toBe('');
        });

        it('switches the object cache on with its job, and a clear flushes it, and off again', async () => {
          const objectCache = (on: boolean) => w.worker.enqueue('site.objectCache', { siteId, on }, { id: siteId, slug: SLUG_MOVED, serverId: 1 }).id;
          const on = await runJob(objectCache(true));
          expect(on.status, on.error ?? '').toBe('succeeded');
          expect(fresh().objectCache).toBe(1);
          expect(await wpMoved('redis', 'status')).toMatch(/Status: Connected/);

          await must(inMoved([...asRedis, 'SET', 'wpl7-engine', 'stored'], asSite), 'a key in Redis');
          await clearSiteCaches(handle(), fresh());
          expect((await inMoved([...asRedis, 'EXISTS', 'wpl7-engine'], asSite)).stdout.toString('utf8').trim()).toBe('0');

          const off = await runJob(objectCache(false));
          expect(off.status, off.error ?? '').toBe('succeeded');
          expect(fresh().objectCache).toBe(0);
          // See redisTo: Docker Desktop's file sharing can keep showing the file for a moment.
          await waitFor('Redis to stop', async () => {
            await inMoved(['wpl7-reload', 'redis']);
            return (await inMoved(['test', '-S', REDIS_SOCKET_IN_CONTAINER])).status !== 0;
          }, 15_000, 500);
          expect((await viaEdge('/')).status).toBe(200);
        });
      });

      describe('arriving on a server that has never had the site', () => {
        const job = () => w.db.select().from(jobs).all().at(-1)!.id;

        /** That server: no container and no files. The database is the world's fake, so MariaDB keeps what it has. */
        async function asIfNeverHere(): Promise<void> {
          await movedDocker.removeContainer(MOVED);
          await must(dockerCli('run', '--rm', '-v', `${movedRoot}:${movedRoot}`, '--entrypoint', 'rm', IMAGE, '-rf', sitePaths(w.config, SLUG_MOVED).root), 'the site’s files');
        }

        const arrive = async (source: StagedSiteSource, opts: { requireWpConfig: boolean; probed: boolean }) => {
          const protection: ProtectionHold = { release: null };
          const said = logOf(job()).length;
          await restoreSiteOnServer(new JobContext(job(), {}, w.db), w.core, handle(), fresh(), [HOST_MOVED], source, {
            routing: true,
            requireWpConfig: opts.requireWpConfig,
            protection,
            // Nothing in a test's way: the same check a move goes by, or none, as for an import.
            probe: opts.probed ? { host: HOST_MOVED, timeoutMs: 30_000, message: 'Probing the site…' } : null,
          });
          protection.release?.();
          return logOf(job()).slice(said).join('\n');
        };

        /** What arrived runs as a site that has always been on stack 2. */
        async function expectAtHome(log: string): Promise<void> {
          await routed();
          expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: newId, stack: 2 });
          expect(log).toContain('php_value max_input_vars: moved to .user.ini');
          for (const [file, text] of moved) expect(await fileInMoved(file), file).toBe(text);
          const home = await viaEdge('/');
          // The panel's word for this site, whatever the archive's nginx file said.
          expect([home.status, home.cache, home.skipped]).toEqual([200, 'BYPASS', 'off']);
          expect(await checked()).toMatchObject({ sapi: 'fpm-fcgi', maxInputVars: '4321', prepend: '/var/www/html/wordfence-waf.php', firewall: true, basedir: '', memory: '256M' });
          expect(await checked('/settings')).toMatchObject({ uploadMax: '77M', strictSessions: '1' });
          expect((await viaEdge('/no-php/secret.php')).status).toBe(403);
          expect(await wpMoved('option', 'get', 'wpl7_engine_marker')).toBe('still here');
        }

        it('a move: an archive from when it was on stack 1 has its lines moved, and none of its runtime folder stays', async () => {
          const backup = w.db.select().from(backups).where(eq(backups.id, backupId)).get()!;
          await asIfNeverHere();
          const log = await arrive({ kind: 'archive', filesTarGz: path.join(backup.path, 'files.tar.gz'), dbSqlGz: path.join(backup.path, 'db.sql.gz') }, { requireWpConfig: true, probed: true });
          await expectAtHome(log);
          const runtime = (await must(inMoved(['ls', '-A', '/etc/wpl7-runtime']), 'the folder')).split('\n').sort();
          expect(runtime).toEqual(RUNTIME_FILES);
          // A redis.conf is what starts Redis, and the archive had one.
          expect((await must(inMoved(['ps', '-eo', 'comm']), 'ps'))).not.toContain('redis');
        });

        it('an import: another host’s tree has its lines moved before the first start, which writes its wp-config.php', async () => {
          const backup = w.db.select().from(backups).where(eq(backups.id, backupId)).get()!;
          const staging = path.join(movedRoot, 'staging');
          fs.mkdirSync(staging, { recursive: true });
          const untar = await hostExec.run('tar', ['-xzf', path.join(backup.path, 'files.tar.gz'), '-C', staging]);
          expect(untar.exitCode, untar.stderr).toBe(0);
          fs.rmSync(path.join(staging, 'wordpress', 'wp-config.php'));
          await asIfNeverHere();
          const log = await arrive({ kind: 'tree', wordpressDir: path.join(staging, 'wordpress'), dbSqlGz: path.join(backup.path, 'db.sql.gz') }, { requireWpConfig: false, probed: false });
          await waitFor('the image to write wp-config.php', async () => (await inMoved(['test', '-s', '/var/www/html/wp-config.php'])).status === 0);
          await expectAtHome(log);
          expect(await fileInMoved('wp-config.php')).toContain("getenv_docker('WORDPRESS_DB_HOST'");
        });
      });

      it('a store on Geolocate with page caching stays on: its pages are stored from the first', async () => {
        // This test's own way back to stack 1, with its lines where mod_php wants them (see above).
        const site = fresh();
        const ctx = new JobContext(w.db.select().from(jobs).all().at(-1)!.id, {}, w.db);
        const again = await buildImage(TAG_MOVED, `FROM ${OLD_IMAGE}\nLABEL wpl7.engine.move=${process.pid}\nLABEL wpl7.engine.again=1\n`);
        await undoSiteMigration(ctx, handle(), w.core, site);
        await movedDocker.removeContainer(MOVED);
        await movedDocker.createSiteContainer(await siteContainerSpec(w.core, handle(), site, [HOST_MOVED], siteRuntimeFrom(w.core.settings, site)));
        await startSiteContainer(handle(), w.core, site, ctx);
        expect(await movedDocker.containerStack(MOVED)).toEqual({ imageId: again, stack: 1 });
        await routed();
        expect(await checked()).toMatchObject({ sapi: 'apache2handler', maxInputVars: '4321' });

        await wpMoved('option', 'update', 'woocommerce_default_customer_address', 'geolocation_ajax');
        w.db.update(sites).set({ pageCache: null, cacheRules: null }).where(eq(sites.id, siteId)).run();
        await moveTag(newId);
        const done = await sweepAndRun();
        expect(done.status, done.error ?? '').toBe('succeeded');
        await routed();
        expect(fresh()).toMatchObject({ pageCache: null, cacheRules: null });
        // A second move over the first one's files, line for line.
        for (const [file, text] of moved) expect(await fileInMoved(file), file).toBe(text);

        const home = await viaEdge('/');
        expect([home.status, home.skipped]).toEqual([307, 'status 307']);
        const hash = new URL(home.get('location')!).searchParams.get('v');
        expect(hash).toBeTruthy();
        const first = await viaEdge(`/?v=${hash}`);
        const second = await viaEdge(`/?v=${hash}`);
        expect([first.status, first.cache, second.cache], first.skipped).toEqual([200, 'MISS', 'HIT']);
        expect(second.body).toBe(first.body);
      });
    });
  });

});
