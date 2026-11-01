/**
 * The old site image against the new one, at a site's default limits (512 MB, 2 CPUs, 512
 * processes): requests per second, p95, failures, the memory it took and whether anything was
 * OOM-killed. Real WordPress with real WooCommerce, MariaDB beside it, and `ab` on the same network.
 * The numbers go in the pull request that changes the image or the sizes in services/siteStack.ts.
 *
 *   npx tsx scripts/site-load-test.ts <old image> <new image> [seconds per run]
 *
 * It starts and removes containers of its own, named wpl7-load-*, and leaves nothing behind.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noCacheRules } from '../shared/cacheRules.js';
import { renderFpmPool, renderNginxSite, renderPhpIni } from '../src/services/siteStack.js';
import { WORDPRESS_CONFIG_EXTRA, WORDPRESS_CONFIG_EXTRA_STACK_2 } from '../src/services/siteSpec.js';
import { renderWpCachePhp } from '../src/services/wpCachePhp.js';

const [oldImage, newImage, secondsArg] = process.argv.slice(2);
if (!oldImage || !newImage) {
  console.error('usage: npx tsx scripts/site-load-test.ts <old image> <new image> [seconds per run]');
  process.exit(2);
}
const SECONDS = Number(secondsArg ?? 30);
const NET = `wpl7-load-${process.pid}`;
const DB = `${NET}-db`;
const HOST = 'load.example.com';
const MEMORY_MB = 512;
const CPUS = 2;

function docker(args: string[], opts: { input?: string; allowFail?: boolean } = {}): string {
  const res = spawnSync('docker', args, { encoding: 'utf8', input: opts.input, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.slice(0, 4).join(' ')}: ${res.stderr.slice(0, 800)}`);
  return res.stdout;
}

const wp = (container: string, ...args: string[]) => docker(['exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', container, 'wp', ...args]);

const WAIT_PLUGIN = String.raw`<?php
// Stands in for a page that waits on something else, such as a payment or shipping API. Half a second
// holds a worker while using almost no CPU, which is what a small pool feels first.
add_action('template_redirect', static function () {
    if (strpos($_SERVER['REQUEST_URI'] ?? '', '/wait/') !== 0) return;
    if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
    usleep(500000);
    status_header(200);
    echo 'waited';
    exit;
});
`;

const HTACCESS = `# BEGIN WordPress
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
# END WordPress
`;

interface Site {
  label: string;
  container: string;
  port: number;
}

function bootSite(label: string, image: string, stack: 1 | 2, runtimeDir: string | null): Site {
  const container = `${NET}-${label}`;
  const database = label.replace(/\W/g, '_');
  docker(['exec', '-i', DB, 'mariadb', '-uroot', '-pload'], {
    input: `CREATE DATABASE ${database} CHARACTER SET utf8mb4; CREATE USER '${database}'@'%' IDENTIFIED BY 'load'; GRANT ALL ON ${database}.* TO '${database}'@'%';`,
  });
  docker([
    'run', '-d', '--name', container, '--network', NET,
    // As the panel makes them, restart policy included: an OOM kill of what runs a container ends it.
    '--restart', 'unless-stopped',
    '--memory', `${MEMORY_MB}m`, '--memory-swap', `${MEMORY_MB * 2}m`, '--cpus', String(CPUS), '--pids-limit', '512',
    '-v', `${container}:/var/www/html`,
    ...(runtimeDir ? ['-v', `${runtimeDir}:/etc/wpl7-runtime:ro`] : []),
    '-e', `WORDPRESS_DB_HOST=${DB}`, '-e', `WORDPRESS_DB_NAME=${database}`, '-e', `WORDPRESS_DB_USER=${database}`, '-e', 'WORDPRESS_DB_PASSWORD=load',
    '-e', `WORDPRESS_CONFIG_EXTRA=${stack === 2 ? WORDPRESS_CONFIG_EXTRA_STACK_2 : WORDPRESS_CONFIG_EXTRA}`,
    image,
  ]);
  const deadline = Date.now() + 180_000;
  while (docker(['exec', container, 'sh', '-c', 'test -f /var/www/html/wp-config.php && echo yes'], { allowFail: true }).trim() !== 'yes') {
    if (Date.now() > deadline) throw new Error(`${label} did not seed WordPress`);
    spawnSync('sleep', ['1']);
  }
  wp(container, 'core', 'install', `--url=http://${HOST}`, '--title=Load', '--admin_user=load', '--admin_email=load@example.com', '--admin_password=load', '--skip-email');
  wp(container, 'rewrite', 'structure', '/%postname%/');
  docker(['exec', '-i', '-u', '33:33', container, 'sh', '-c', 'cat > /var/www/html/.htaccess'], { input: HTACCESS });
  docker(['exec', '-u', '33:33', container, 'mkdir', '-p', '/var/www/html/wp-content/mu-plugins']);
  docker(['exec', '-i', '-u', '33:33', container, 'sh', '-c', 'cat > /var/www/html/wp-content/mu-plugins/load-wait.php'], { input: WAIT_PLUGIN });
  wp(container, 'plugin', 'install', 'woocommerce', '--activate');
  wp(container, 'post', 'generate', '--count=30');
  return { label, container, port: stack === 2 ? 8080 : 80 };
}

interface Result {
  rps: string;
  p95: string;
  failed: string;
  non2xx: string;
}

function ab(site: Site, concurrency: number, urlPath: string, cookie?: string, requests?: number): Result {
  const out = docker([
    'run', '--rm', '--network', NET, 'httpd:2.4-alpine', 'ab', '-q', '-r', '-s', '120',
    ...(requests ? [] : ['-t', String(SECONDS)]), '-n', String(requests ?? 10_000_000), '-c', String(concurrency),
    '-H', `Host: ${HOST}`,
    ...(cookie ? ['-C', cookie] : []),
    `http://${site.container}:${site.port}${urlPath}`,
  ]);
  const grab = (re: RegExp) => re.exec(out)?.[1] ?? '0';
  return {
    rps: grab(/Requests per second:\s+([\d.]+)/),
    p95: grab(/^\s*95%\s+(\d+)/m),
    failed: grab(/Failed requests:\s+(\d+)/),
    non2xx: grab(/Non-2xx responses:\s+(\d+)/),
  };
}

function memoryOf(site: Site): { peakMb: number; ooms: number; restarts: number; running: boolean } {
  const peak = Number(docker(['exec', site.container, 'cat', '/sys/fs/cgroup/memory.peak'], { allowFail: true }).trim() || 0);
  const events = docker(['exec', site.container, 'cat', '/sys/fs/cgroup/memory.events'], { allowFail: true });
  const state = docker(['inspect', '-f', '{{.RestartCount}} {{.State.Running}}', site.container]).trim().split(' ');
  return {
    peakMb: Math.round(peak / 1024 / 1024),
    ooms: Number(/oom_kill (\d+)/.exec(events)?.[1] ?? 0),
    restarts: Number(state[0]),
    running: state[1] === 'true',
  };
}

const runtimeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wpl7-load-'));
try {
  const rules = noCacheRules();
  fs.chmodSync(runtimeDir, 0o755);
  fs.writeFileSync(path.join(runtimeDir, 'nginx-site.conf'), renderNginxSite({ pageCache: true, rules }));
  fs.writeFileSync(path.join(runtimeDir, 'php-fpm-pool.conf'), renderFpmPool(MEMORY_MB, CPUS));
  fs.writeFileSync(path.join(runtimeDir, 'php.ini'), renderPhpIni(MEMORY_MB));
  fs.writeFileSync(path.join(runtimeDir, 'wp-cache.php'), renderWpCachePhp({ pageCache: true, keepSeconds: 36000, rules }));

  docker(['network', 'create', NET]);
  docker(['run', '-d', '--name', DB, '--network', NET, '-e', 'MARIADB_ROOT_PASSWORD=load', 'mariadb:11.4', '--innodb-buffer-pool-size=256M', '--max-connections=400']);
  const deadline = Date.now() + 120_000;
  while (spawnSync('docker', ['exec', DB, 'healthcheck.sh', '--connect', '--innodb_initialized']).status !== 0) {
    if (Date.now() > deadline) throw new Error('MariaDB did not come up');
    spawnSync('sleep', ['1']);
  }

  console.error('Installing WordPress and WooCommerce on both…');
  const old = bootSite('old', oldImage, 1, null);
  const fresh = bootSite('new', newImage, 2, runtimeDir);

  const SKIP = 'wordpress_no_cache=1';
  const runs: { what: string; site: Site; concurrency: number; path: string; cookie?: string; burst?: number; warm?: boolean }[] = [
    { what: 'Old, home page', site: old, concurrency: 10, path: '/' },
    { what: 'New, home page, past the cache', site: fresh, concurrency: 10, path: '/', cookie: SKIP },
    { what: 'New, home page, cached', site: fresh, concurrency: 10, path: '/' },
    { what: 'Old, home page', site: old, concurrency: 50, path: '/' },
    { what: 'New, home page, past the cache', site: fresh, concurrency: 50, path: '/', cookie: SKIP },
    { what: 'New, home page, cached', site: fresh, concurrency: 50, path: '/' },
    { what: 'Old, a page waiting 0.5 s', site: old, concurrency: 50, path: '/wait/' },
    { what: 'New, a page waiting 0.5 s', site: fresh, concurrency: 50, path: '/wait/' },
    // Last: this is where the old image runs out of memory, and it may not come back in time.
    // After 40 s with no request, PHP-FPM is down to its one or two idle workers.
    { what: 'Old, 10 home pages after 40 s idle', site: old, concurrency: 10, path: '/', burst: 10 },
    { what: 'New, 10 home pages after 40 s idle, past the cache', site: fresh, concurrency: 10, path: '/', cookie: SKIP, burst: 10 },
    { what: 'Old, 10 home pages at once, right after', site: old, concurrency: 10, path: '/', burst: 10, warm: true },
    { what: 'New, 10 home pages at once, right after', site: fresh, concurrency: 10, path: '/', cookie: SKIP, burst: 10, warm: true },
    { what: 'Old, home page', site: old, concurrency: 150, path: '/' },
    { what: 'New, home page, past the cache', site: fresh, concurrency: 150, path: '/', cookie: SKIP },
    { what: 'New, home page, cached', site: fresh, concurrency: 150, path: '/' },
  ];

  console.log(`${MEMORY_MB} MB, ${CPUS} CPUs, ${SECONDS} s per run. Old ${oldImage}, new ${newImage}, FPM ${renderFpmPool(MEMORY_MB, CPUS).match(/max_children = (\d+)/)?.[1]} workers.`);
  console.log('');
  console.log('| Run | Concurrent | Requests/s | p95 ms | Failed | Non-2xx | Peak memory MB | OOM kills | Restarts |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const run of runs) {
    console.error(`${run.what}, ${run.concurrency} at once…`);
    if (run.burst && !run.warm) spawnSync('sleep', ['40']);
    const result = ab(run.site, run.concurrency, run.path, run.cookie, run.burst);
    const memory = memoryOf(run.site);
    console.log(`| ${run.what} | ${run.concurrency} | ${result.rps} | ${result.p95} | ${result.failed} | ${result.non2xx} | ${memory.peakMb} | ${memory.ooms} | ${memory.restarts}${memory.running ? '' : ' (down)'} |`);
  }
} finally {
  docker(['rm', '-f', '-v', `${NET}-old`, `${NET}-new`, DB], { allowFail: true });
  docker(['volume', 'rm', `${NET}-old`, `${NET}-new`], { allowFail: true });
  docker(['network', 'rm', NET], { allowFail: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
