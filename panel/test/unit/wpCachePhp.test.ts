/**
 * The WordPress side of a site's caches (services/wpCachePhp.ts). The rendered file runs here under
 * real PHP, with a small stand-in for WordPress: what a page gets as headers under PHP's built-in
 * server, because the command line has no headers to read back, and what clears the cache under
 * the command line, as WP-CLI runs it. The checks on real WordPress are the engine test's.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_KEEP_SECONDS, NOT_FOUND_SECONDS, type CacheRule } from '../../shared/cacheRules.js';
import { PAGE_CACHE_DIR_IN_CONTAINER, REDIS_SOCKET_IN_CONTAINER } from '../../src/services/siteStack.js';
import { phpLiteral, renderWpCachePhp } from '../../src/services/wpCachePhp.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;
const HAS_DOCKER_PHP = !HAS_PHP && spawnSync('docker', ['image', 'inspect', 'php:8.4-cli-alpine']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-wp-cache-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOTHING_CHANGED = { off: [], own: [] };
const own = (id: string, kind: CacheRule['kind'], match: CacheRule['match'], value: string, seconds?: number): CacheRule => ({
  id,
  kind,
  match,
  value,
  ...(seconds === undefined ? {} : { seconds }),
});
const render = (keepSeconds = 36_000, rules: { off: string[]; own: CacheRule[] } = NOTHING_CHANGED, warn?: (message: string) => void) =>
  renderWpCachePhp({ pageCache: true, keepSeconds, rules, warn });

/**
 * What wp-cache.php uses of WordPress. Loaded after it, as wp-settings.php is after wp-config.php,
 * and it reads the hooks pre-registered in $wp_filter the way WP_Hook does. `$GLOBALS['stub']`
 * says what the site looks like: who is logged in, what was asked for, what the options hold.
 */
const STUB_WORDPRESS = String.raw`<?php
$GLOBALS['stub_hooks'] = [];
$GLOBALS['stub_did'] = [];
$GLOBALS['stub_nodes'] = [];
function add_filter($hook, $fn, $priority = 10, $args = 1) {
    $key = is_string($fn) ? $fn : spl_object_id($fn);
    $GLOBALS['stub_hooks'][$hook][$priority][$key] = [$fn, $args];
    return true;
}
function add_action($hook, $fn, $priority = 10, $args = 1) { return add_filter($hook, $fn, $priority, $args); }
function has_stub_hook($hook, $fn) {
    foreach ($GLOBALS['stub_hooks'][$hook] ?? [] as $group) if (isset($group[$fn])) return true;
    return false;
}
function stub_run($hook, array $args, bool $filter) {
    if (!isset($GLOBALS['stub_hooks'][$hook])) return $args[0] ?? null;
    ksort($GLOBALS['stub_hooks'][$hook]);
    $value = $args[0] ?? null;
    foreach ($GLOBALS['stub_hooks'][$hook] as $group) {
        foreach ($group as $entry) {
            $value = call_user_func_array($entry[0], array_slice($filter ? array_merge([$value], array_slice($args, 1)) : $args, 0, $entry[1]));
        }
    }
    return $value;
}
function do_action($hook, ...$args) {
    $GLOBALS['stub_did'][$hook] = ($GLOBALS['stub_did'][$hook] ?? 0) + 1;
    stub_run($hook, $args, false);
}
function apply_filters($hook, ...$args) { return stub_run($hook, $args, true); }
function did_action($hook) { return $GLOBALS['stub_did'][$hook] ?? 0; }
function wp_ob_end_flush_all() {
    $levels = ob_get_level();
    for ($i = 0; $i < $levels; $i++) ob_end_flush();
}
function stub_load_preregistered() {
    $pre = $GLOBALS['wp_filter'] ?? [];
    foreach ($pre as $hook => $groups) foreach ($groups as $priority => $callbacks) foreach ($callbacks as $cb) add_filter($hook, $cb['function'], $priority, $cb['accepted_args']);
}
function is_singular() { return isset($GLOBALS['stub']['singular']); }
function get_queried_object() { return (object) ['post_type' => $GLOBALS['stub']['singular']]; }
function is_post_type_archive() { return isset($GLOBALS['stub']['archive']); }
function get_query_var($name) { return $GLOBALS['stub']['archive']; }
function is_404() { return !empty($GLOBALS['stub']['is_404']); }
function get_option($name) { return $GLOBALS['stub']['options'][$name] ?? false; }
function is_user_logged_in() {
    if (!empty($GLOBALS['stub']['throw'])) throw new Error('half gone');
    return !empty($GLOBALS['stub']['logged_in']);
}
function current_user_can($cap) { return !empty($GLOBALS['stub']['can']); }
function get_permalink($post) { return $GLOBALS['stub']['permalink'] ?? false; }
function sanitize_title($title) { return trim(str_replace(['.', ' '], '-', preg_replace('/[^%a-z0-9 ._-]/', '', strtolower($title))), '-'); }
function is_post_type_viewable($type) { return in_array($type, ['post', 'page', 'product'], true); }
function wp_is_post_revision($id) { return $id === 'revision' ? 1 : false; }
function wp_is_post_autosave($id) { return $id === 'autosave' ? 1 : false; }
function get_post($id) { return (object) ['post_type' => 'post', 'post_status' => 'trash']; }
function get_post_meta($id, $key, $single) { return $GLOBALS['stub']['trash_meta'] ?? ''; }
function get_comment($id) { return (object) ['comment_approved' => $id === 'approved' ? '1' : 'spam']; }
function admin_url($path = '') { return 'https://example.com/wp-admin/' . $path; }
function wp_nonce_url($url, $action) { return $url . '&_wpnonce=' . $action; }
function wp_die($message) { echo 'died: ', $message; exit; }
function check_admin_referer($action) { if (!empty($GLOBALS['stub']['bad_nonce'])) wp_die('nonce'); }
function wp_get_referer() { return $GLOBALS['stub']['referer'] ?? false; }
function add_query_arg($key, $value, $url) { return $url . '?' . $key . '=' . $value; }
function wp_safe_redirect($url) { echo 'redirect: ', $url; }
if (!empty($GLOBALS['stub']['woocommerce'])) { class WooCommerce {} }
if (!empty($GLOBALS['stub']['pluggable'])) { function wp_get_current_user() { return null; } }
class Stub_Bar { public function add_node($node) { $GLOBALS['stub_nodes'][] = $node; } }
`;

/** Rendered once per set of options, with the cache folder moved to where a test can see it. */
function writeSite(code: string, dir: string, cacheDir = path.join(dir, 'cache')): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wp-cache.php'), code.replaceAll(PAGE_CACHE_DIR_IN_CONTAINER, cacheDir).replaceAll('/run/wpl7/comment-clear', path.join(dir, 'comment-clear')));
  fs.writeFileSync(path.join(dir, 'stub.php'), STUB_WORDPRESS);
  return dir;
}

describe('phpLiteral', () => {
  const NASTY = ["it's", 'back\\slash', "\\'", "'; system('id'); //", '?>', '<?php', '$x', '${x}', '{$x}', '"', 'a\nb', '\\', "\\\\'", 'café', '%s', '`id`'];

  it('writes values as PHP source', () => {
    expect(phpLiteral(null)).toBe('null');
    expect(phpLiteral(true)).toBe('true');
    expect(phpLiteral(false)).toBe('false');
    expect(phpLiteral(36_000)).toBe('36000');
    expect(phpLiteral('a')).toBe("'a'");
    expect(phpLiteral("it's")).toBe("'it\\'s'");
    expect(phpLiteral('a\\b')).toBe("'a\\\\b'");
    expect(phpLiteral(['a', 1])).toBe("['a', 1]");
    expect(phpLiteral({ a: ['b'], "it's": 1 })).toBe("['a' => ['b'], 'it\\'s' => 1]");
    expect(phpLiteral([])).toBe('[]');
    expect(phpLiteral({})).toBe('[]');
  });

  it('refuses what has no plain literal, rather than writing something else', () => {
    expect(() => phpLiteral(1.5)).toThrow();
    expect(() => phpLiteral(Number.NaN)).toThrow();
    expect(() => phpLiteral(undefined)).toThrow();
    expect(() => phpLiteral(() => 1)).toThrow();
  });

  it.skipIf(!HAS_PHP)('comes back from PHP as it went in, whatever the string', () => {
    const res = spawnSync('php', ['-n', '-r', `echo json_encode(${phpLiteral(NASTY)});`], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(NASTY);
  });
});

describe('the file', () => {
  it('always has the object cache plugin’s settings, page cache or not', () => {
    for (const code of [render(), renderWpCachePhp({ pageCache: false, keepSeconds: 36_000, rules: NOTHING_CHANGED })]) {
      expect(code).toContain("if (!defined('WP_REDIS_SCHEME')) define('WP_REDIS_SCHEME', 'unix');");
      expect(code).toContain(`if (!defined('WP_REDIS_PATH')) define('WP_REDIS_PATH', '${REDIS_SOCKET_IN_CONTAINER}');`);
      expect(code).toContain("if (!defined('WP_REDIS_CLIENT')) define('WP_REDIS_CLIENT', 'phpredis');");
      expect(code).toContain("if (!defined('WP_REDIS_GRACEFUL')) define('WP_REDIS_GRACEFUL', true);");
      expect(code).toContain("if (!defined('WP_REDIS_MAXTTL')) define('WP_REDIS_MAXTTL', 14400);");
      expect(code).toContain("if (!defined('WP_REDIS_DISABLE_BANNERS')) define('WP_REDIS_DISABLE_BANNERS', true);");
      expect(code).toContain("if (!defined('WP_REDIS_DISABLE_COMMENT')) define('WP_REDIS_DISABLE_COMMENT', true);");
    }
  });

  it('is only those settings with the page cache off', () => {
    const off = renderWpCachePhp({ pageCache: false, keepSeconds: 36_000, rules: { off: [], own: [own('a', 'skip', 'postType', 'event')] } });
    expect(off).not.toContain('ob_start');
    expect(off).not.toContain('wp_filter');
    expect(off).not.toContain('add_action');
    expect(off).not.toContain('event');
  });

  it('never leaves PHP mode, and has nothing PHP would take for a shell command', () => {
    const code = render(600, { off: [], own: [own('a', 'keep', 'path', '/café/*', 60)] });
    expect(code.startsWith('<?php\n')).toBe(true);
    expect(code).not.toContain('?>');
    expect(code).not.toContain('`');
    expect(code).not.toContain('${');
  });

  it('holds the keep time to the 10-hour ceiling', () => {
    expect(render(999_999)).toContain(`'keep_seconds' => ${MAX_KEEP_SECONDS}`);
    expect(render(600)).toContain("'keep_seconds' => 600");
    expect(render(0)).toContain(`'keep_seconds' => ${MAX_KEEP_SECONDS}`);
    expect(render(Number.NaN)).toContain(`'keep_seconds' => ${MAX_KEEP_SECONDS}`);
    expect(render(90.5)).toContain("'keep_seconds' => 90");
    expect(render()).toContain(`'not_found_seconds' => ${NOT_FOUND_SECONDS}`);
  });

  it('carries the rules that run in PHP, and no others', () => {
    const code = render(36_000, {
      off: [],
      own: [
        own('a', 'skip', 'postType', 'event'),
        own('b', 'keep', 'path', '/news/*', 60),
        own('c', 'keep', 'path', '/café/', 70),
        own('d', 'keep', 'postType', 'product', 80),
        own('e', 'keep', 'postType', 'product', 90),
        own('f', 'skip', 'path', '/somewhere-else/'),
        own('g', 'skip', 'cookie', 'cookie_elsewhere'),
      ],
    });
    expect(code).toContain("'skip_post_types' => ['event']");
    expect(code).toContain("'keep_paths' => [['#^/news(?:/|$)#i', 60], ['#^/caf\\\\xC3\\\\xA9/?$#i', 70]]");
    // The first rule for a post type wins.
    expect(code).toContain("'keep_post_types' => ['product' => 80]");
    expect(code).not.toContain('somewhere-else');
    expect(code).not.toContain('cookie_elsewhere');
  });

  it.each<[string, CacheRule]>([
    ['a keep time past the ceiling', own('a', 'keep', 'path', '/evil', MAX_KEEP_SECONDS + 1)],
    ['a keep rule with no time', own('a', 'keep', 'postType', 'evil')],
    ['a path breaking out of the string', own('a', 'keep', 'path', "/evil'.system('id').'", 60)],
    ['a post type breaking out of the string', own('a', 'skip', 'postType', "evil'];system('id');//")],
    ['a regex delimiter', own('a', 'keep', 'path', '/evil#e', 60)],
  ])('drops a stored rule that fails its check, with a warning: %s', (_, bad) => {
    const warnings: string[] = [];
    const code = render(36_000, { off: [], own: [bad] }, (m) => warnings.push(m));
    expect(code).toBe(render());
    expect(code).not.toContain('evil');
    expect(warnings).toHaveLength(1);
  });

  // Delegates to whichever PHP this machine has, so the check can't silently never run on a developer's.
  it.skipIf(!HAS_PHP && !HAS_DOCKER_PHP).each([
    ['the page cache on', render(600, { off: [], own: [own('a', 'keep', 'path', '/café/*', 60), own('b', 'skip', 'postType', 'event')] })],
    ['the page cache off', renderWpCachePhp({ pageCache: false, keepSeconds: 36_000, rules: NOTHING_CHANGED })],
  ])('lints with %s', (_, code) => {
    const file = path.join(tmp, `lint-${Math.random().toString(36).slice(2)}.php`);
    fs.writeFileSync(file, code);
    const res = HAS_PHP
      ? spawnSync('php', ['-n', '-d', 'error_reporting=E_ALL', '-d', 'display_errors=1', '-l', file], { encoding: 'utf8' })
      : spawnSync('docker', ['run', '--rm', '-i', 'php:8.4-cli-alpine', 'php', '-d', 'error_reporting=E_ALL', '-d', 'display_errors=1', '-l'], { input: code, encoding: 'utf8' });
    expect(res.stdout + res.stderr).toContain('No syntax errors');
    expect(res.stdout + res.stderr).not.toMatch(/Deprecated|Warning|Notice/);
    expect(res.status).toBe(0);
  });
});

describe.skipIf(!HAS_PHP)('loading the file', () => {
  const dir = writeSite(render(600), path.join(tmp, 'load'));
  const php = (code: string) => {
    const file = path.join(dir, `run-${Math.random().toString(36).slice(2)}.php`);
    fs.writeFileSync(file, `<?php\n${code}\n`);
    const res = spawnSync('php', ['-n', '-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', file], { encoding: 'utf8' });
    fs.rmSync(file);
    return res;
  };
  const load = `require ${JSON.stringify(path.join(dir, 'wp-cache.php'))};`;
  const stub = `require ${JSON.stringify(path.join(dir, 'stub.php'))};`;

  it('needs nothing of WordPress, and pre-registers one callback the way WP_Hook reads it', () => {
    const res = php(`${load} echo json_encode($GLOBALS['wp_filter']);`);
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({ muplugins_loaded: [{ wpl7_cache_boot: { function: 'wpl7_cache_boot', accepted_args: 0 } }] });
  });

  it('can be required twice', () => {
    const res = php(`${load} ${load} ${stub} stub_load_preregistered(); do_action('muplugins_loaded'); echo count($GLOBALS['stub_hooks']['template_redirect'][-9999]);`);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('1');
  });

  it('adds to what was pre-registered before it', () => {
    const res = php(`$GLOBALS['wp_filter']['muplugins_loaded'][0]['other'] = ['function' => 'other', 'accepted_args' => 0]; ${load} echo count($GLOBALS['wp_filter']['muplugins_loaded'][0]);`);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('2');
  });

  it('adds its hooks from muplugins_loaded, once', () => {
    const res = php(`${load} ${stub} stub_load_preregistered(); echo isset($GLOBALS['stub_hooks']['template_redirect']) ? 'early' : 'waits'; do_action('muplugins_loaded'); do_action('muplugins_loaded'); wpl7_cache_boot(); echo ' ', count($GLOBALS['stub_hooks']['template_redirect'][-9999]), ' ', isset($GLOBALS['stub_hooks']['shutdown'][PHP_INT_MAX]) ? 'last' : 'no';`);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('waits 1 last');
  });

  it('still works when something loads it after WordPress', () => {
    const before = php(`${stub} ${load} do_action('muplugins_loaded'); echo isset($GLOBALS['stub_hooks']['template_redirect']) ? 'hooked' : 'not';`);
    expect(before.stderr).toBe('');
    expect(before.stdout).toBe('hooked');
    const after = php(`${stub} do_action('muplugins_loaded'); ${load} echo isset($GLOBALS['stub_hooks']['template_redirect']) ? 'hooked' : 'not';`);
    expect(after.stderr).toBe('');
    expect(after.stdout).toBe('hooked');
  });

  it('leaves a constant the site set for itself alone', () => {
    const res = php(`define('WP_REDIS_PATH', '/elsewhere.sock'); ${load} echo WP_REDIS_PATH, ' ', WP_REDIS_SCHEME;`);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe(`/elsewhere.sock unix`);
  });

  it.each<[string, () => string]>([
    ['with the page cache on', () => load],
    [
      'with the page cache off',
      () => {
        const off = path.join(tmp, 'load-off.php');
        fs.writeFileSync(off, renderWpCachePhp({ pageCache: false, keepSeconds: 600, rules: NOTHING_CHANGED }));
        return `require ${JSON.stringify(off)};`;
      },
    ],
  ])("takes the environment out of $_SERVER, where PHP-FPM copies it and mod_php didn't, and leaves getenv() alone: %s", (_name, loading) => {
    const res = php(`
$_SERVER['WORDPRESS_DB_PASSWORD'] = 'secret';
$_SERVER['WORDPRESS_CONFIG_EXTRA'] = 'x';
$_SERVER['HTTP_HOST'] = 'example.com';
putenv('WORDPRESS_DB_PASSWORD=secret');
${loading()}
echo json_encode([array_keys(array_filter($_SERVER, function ($v, $k) { return strpos((string) $k, 'WORDPRESS_') === 0; }, ARRAY_FILTER_USE_BOTH)), $_SERVER['HTTP_HOST'], getenv('WORDPRESS_DB_PASSWORD'), isset($wpl7_name)]);`);
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual([[], 'example.com', 'secret', false]);
  });
});

describe.skipIf(!HAS_PHP)('what a page gets', () => {
  const dir = path.join(tmp, 'pages');
  let server: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    writeSite(
      render(600, {
        off: [],
        own: [
          own('a', 'skip', 'postType', 'event'),
          own('b', 'keep', 'path', '/news/*', 77),
          own('c', 'keep', 'path', '/café/', 88),
          own('d', 'keep', 'postType', 'product', 99),
        ],
      }),
      dir,
    );
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    // As WordPress runs a page: wp-config.php, wp-settings.php, then the theme.
    fs.writeFileSync(
      path.join(dir, 'router.php'),
      String.raw`<?php
ini_set('display_errors', '0');
$c = json_decode($_GET['c'] ?? '{}', true) ?: [];
$GLOBALS['stub'] = $c;
// fetch() adds this, and nginx blanks it on the path that may store a page.
unset($_SERVER['HTTP_SEC_FETCH_MODE']);
if (isset($c['abspath'])) define('ABSPATH', $c['abspath']);
require __DIR__ . '/wp-cache.php';
require __DIR__ . '/stub.php';
stub_load_preregistered();
do_action('muplugins_loaded');
register_shutdown_function(function () { do_action('shutdown'); });
if (empty($c['no_flush_all'])) add_action('shutdown', 'wp_ob_end_flush_all', 1);
do_action('plugins_loaded');
$referer_early = $_SERVER['HTTP_REFERER'] ?? 'none';
do_action('template_redirect');
echo 'level=', ob_get_level(), "\n";
echo 'referer-early=', $referer_early, ' referer-late=', $_SERVER['HTTP_REFERER'] ?? 'none', ' country=', $_SERVER['HTTP_CF_IPCOUNTRY'] ?? 'none', ' raw-country=', $_SERVER['HTTP_X_WPL7_COUNTRY'] ?? 'none', "\n";
foreach ($c['steps'] ?? [] as $step) {
    switch ($step[0]) {
        case 'status': http_response_code($step[1]); break;
        case 'header': header($step[1]); break;
        case 'cookie': setcookie('a', '1'); break;
        case 'action': do_action($step[1]); break;
        case 'comment': do_action('comment_post', 1, 1, []); break;
        case 'wipe': foreach (scandir($step[1]) as $name) if (is_file($step[1] . '/' . $name)) unlink($step[1] . '/' . $name); break;
        case 'define': define($step[1], $step[2] ?? true); break;
        case 'echo': echo $step[1]; break;
        case 'bytes': for ($i = 0; $i < $step[1]; $i++) echo str_repeat('y', 1024 * 1024); break;
        case 'ob_clean': ob_clean(); break;
        case 'ob_flush': ob_flush(); break;
        case 'ob_end_flush': ob_end_flush(); break;
        case 'ob_end_clean': ob_end_clean(); break;
        case 'inner_ob': ob_start(); break;
        case 'fatal': ini_set('display_errors', '1'); undefined_function_for_the_test(); break;
        case 'exit': exit;
    }
}
echo "the page\n";
`,
    );
    port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const free = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(free));
      });
    });
    server = spawn('php', ['-n', '-S', `127.0.0.1:${port}`, path.join(dir, 'router.php')], { stdio: 'ignore', cwd: dir });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error('PHP server did not start');
  });
  afterAll(() => server?.kill());

  interface Config {
    steps?: unknown[][];
    singular?: string;
    archive?: string | string[];
    is_404?: boolean;
    logged_in?: boolean;
    woocommerce?: boolean;
    options?: Record<string, string>;
    throw?: boolean;
    no_flush_all?: boolean;
    permalink?: string;
    abspath?: string;
  }

  async function page(config: Config = {}, urlPath = '/', mark = true, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}?c=${encodeURIComponent(JSON.stringify(config))}`, {
      redirect: 'manual',
      headers: { ...(mark ? { 'X-Wpl7-Cache': '1' } : {}), ...headers },
    });
    return {
      status: res.status,
      expires: res.headers.get('x-accel-expires'),
      skipped: res.headers.get('x-cache-skipped'),
      buffering: res.headers.get('x-accel-buffering'),
      body: await res.text(),
    };
  }

  it('is stored for the site’s keep time', async () => {
    const res = await page();
    expect(res).toMatchObject({ status: 200, expires: '600', skipped: null, buffering: null });
    expect(res.body).toContain('the page');
  });

  it('is not touched unless nginx says it may be stored: no buffer, no headers', async () => {
    const res = await page({}, '/', false);
    expect(res).toMatchObject({ expires: null, skipped: null, buffering: null });
    expect(res.body).toContain('level=0');
    expect((await page()).body).toContain('level=1');
  });

  it.each<[string, unknown[][]]>([
    ['status 500', [['status', 500]]],
    ['status 503', [['status', 503]]],
    ['status 302', [['status', 302]]],
    ['status 303', [['status', 303]]],
    ['status 307', [['status', 307]]],
    ['status 403', [['status', 403]]],
    ['DONOTCACHEPAGE', [['define', 'DONOTCACHEPAGE']]],
    ['page says no-cache', [['header', 'Cache-Control: no-cache']]],
    ['page says no-cache', [['header', 'Cache-Control: no-store']]],
    ['page says no-cache', [['header', 'cache-control: PRIVATE']]],
    ['page says no-cache', [['header', 'Cache-Control: max-age=0']]],
    ['page says no-cache', [['header', 'Cache-Control: public, s-maxage=0']]],
    ['page says no-cache', [['header', 'Cache-Control: no-cache, must-revalidate, max-age=0, no-store, private']]],
    ['page says no-cache', [['header', 'Expires: Wed, 11 Jan 1984 05:00:00 GMT']]],
    ['page says no-cache', [['header', 'Expires: 0']]],
    ['page says no-cache', [['header', 'Expires: not a date']]],
    ['page sets a cookie', [['cookie']]],
    ['page sets a cookie', [['header', 'SET-COOKIE: a=b']]],
    ['page varies by cookie', [['header', 'Vary: Cookie']]],
    ['page varies by user-agent', [['header', 'vary: Accept-Encoding, User-Agent']]],
    ['page varies by *', [['header', 'Vary: *']]],
    ['page flushed early', [['echo', 'x'], ['ob_flush']]],
    ['page flushed early', [['ob_end_flush'], ['exit']]],
    ['page flushed early', [['echo', 'x'], ['ob_end_clean'], ['exit']]],
    ['page flushed early', [['bytes', 9]]],
  ])('is withheld with the reason "%s": %j', async (reason, steps) => {
    const res = await page({ steps });
    expect(res.expires).toBeNull();
    expect(res.skipped).toBe(reason);
  });

  it.each<[string, Config]>([
    ['logged in', { logged_in: true }],
    ['WooCommerce Geolocate', { woocommerce: true, options: { woocommerce_default_customer_address: 'geolocation' } }],
    ['post type event', { singular: 'event' }],
    ['post type event', { archive: 'event' }],
    ['post type event', { archive: ['event', 'other'] }],
  ])('is withheld with the reason "%s": %j', async (reason, config) => {
    const res = await page(config);
    expect(res.expires).toBeNull();
    expect(res.skipped).toBe(reason);
  });

  it('says it streams when it flushes early, so nginx passes it on as it comes', async () => {
    expect((await page({ steps: [['echo', 'x'], ['ob_flush']] })).buffering).toBe('no');
    expect((await page({ steps: [['bytes', 9]] })).buffering).toBe('no');
    expect((await page()).buffering).toBeNull();
  });

  it('holds on to less than the chunk size, and hands the whole page over either way', async () => {
    const small = await page({ steps: [['bytes', 7]] });
    expect(small.expires).toBe('600');
    expect(small.body.length).toBeGreaterThan(7 * 1024 * 1024);
    const big = await page({ steps: [['bytes', 9]] });
    expect(big.body.length).toBeGreaterThan(9 * 1024 * 1024);
    expect(big.body).toContain('the page');
  });

  it('goes on after ob_clean(), which only throws output away', async () => {
    const res = await page({ steps: [['echo', 'gone'], ['ob_clean']] });
    expect(res.expires).toBe('600');
    expect(res.body).not.toContain('gone');
    expect(res.body).toContain('the page');
  });

  it('counts a buffer opened inside its own as the page’s', async () => {
    const res = await page({ steps: [['inner_ob'], ['echo', 'inner']] });
    expect(res.expires).toBe('600');
    expect(res.body).toContain('inner');
  });

  it('keeps a page with a date in the future or a cache time of its own', async () => {
    expect((await page({ steps: [['header', 'Expires: Wed, 11 Jan 2034 05:00:00 GMT']] })).expires).toBe('600');
    expect((await page({ steps: [['header', 'Cache-Control: public, max-age=60']] })).expires).toBe('600');
    expect((await page({ steps: [['header', 'Cache-Control: max-age=10']] })).expires).toBe('600');
    expect((await page({ steps: [['header', 'Vary: Accept-Encoding']] })).expires).toBe('600');
    expect((await page({ steps: [['header', 'Vary: X-Forwarded-Proto, Host']] })).expires).toBe('600');
    expect((await page({ steps: [['define', 'DONOTCACHEPAGE', false]] })).expires).toBe('600');
  });

  it('stores what a redirect to the right address is, and a page not found for less time', async () => {
    expect((await page({ steps: [['status', 301]] }))).toMatchObject({ status: 301, expires: '600', skipped: null });
    expect((await page({ steps: [['status', 404]] }))).toMatchObject({ status: 404, expires: String(NOT_FOUND_SECONDS), skipped: null });
    expect((await page({ is_404: true }))).toMatchObject({ expires: String(NOT_FOUND_SECONDS), skipped: null });
  });

  it('takes WordPress’s own no-cache headers on a 404 for what they are', async () => {
    const res = await page({
      steps: [
        ['status', 404],
        ['header', 'Cache-Control: no-cache, must-revalidate, max-age=0, no-store, private'],
        ['header', 'Expires: Wed, 11 Jan 1984 05:00:00 GMT'],
      ],
    });
    expect(res).toMatchObject({ status: 404, expires: String(NOT_FOUND_SECONDS), skipped: null });
  });

  it('holds a 404 to the other reasons', async () => {
    expect((await page({ steps: [['status', 404], ['cookie']] })).skipped).toBe('page sets a cookie');
    expect((await page({ steps: [['status', 404], ['define', 'DONOTCACHEPAGE']] })).skipped).toBe('DONOTCACHEPAGE');
  });

  it('uses a keep rule: path first, then post type, then the site’s', async () => {
    expect((await page({}, '/news/')).expires).toBe('77');
    expect((await page({}, '/news/a/b/')).expires).toBe('77');
    expect((await page({ singular: 'product' }, '/news/x/')).expires).toBe('77');
    expect((await page({ singular: 'product' }, '/shoes/')).expires).toBe('99');
    expect((await page({ archive: 'product' }, '/products/')).expires).toBe('99');
    expect((await page({ singular: 'post' }, '/shoes/')).expires).toBe('600');
    expect((await page({}, '/newsletter/')).expires).toBe('600');
  });

  it('matches a non-ASCII keep path against the decoded request', async () => {
    expect((await page({}, '/caf%C3%A9/')).expires).toBe('88');
    expect((await page({}, '/caf%c3%a9')).expires).toBe('88');
    expect((await page({}, '/cafe/')).expires).toBe('600');
  });

  it('gives a 404 its five minutes over any keep rule', async () => {
    expect((await page({ steps: [['status', 404]] }, '/news/x/')).expires).toBe(String(NOT_FOUND_SECONDS));
  });

  it('respects an X-Accel-Expires already sent, and takes it back when the page is withheld', async () => {
    expect((await page({ steps: [['header', 'X-Accel-Expires: 5']] })).expires).toBe('5');
    expect((await page({ steps: [['header', 'x-accel-expires: 0']] })).expires).toBe('0');
    const withheld = await page({ steps: [['header', 'X-Accel-Expires: 5'], ['cookie']] });
    expect(withheld.expires).toBeNull();
    expect(withheld.skipped).toBe('page sets a cookie');
  });

  it('does not store a page PHP could not finish', async () => {
    const res = await page({ steps: [['echo', 'partial '], ['fatal']] });
    expect(res.expires).toBeNull();
    expect(res.skipped).toBe('PHP error');
  });

  it('leaves a store on any other customer location alone', async () => {
    expect((await page({ woocommerce: true, options: { woocommerce_default_customer_address: 'geolocation_ajax' } })).expires).toBe('600');
    expect((await page({ woocommerce: true, options: { woocommerce_default_customer_address: 'base' } })).expires).toBe('600');
    // The option alone, left behind by a plugin that is gone, says nothing.
    expect((await page({ options: { woocommerce_default_customer_address: 'geolocation' } })).expires).toBe('600');
  });

  it('keeps the page and stores nothing when WordPress throws at the very end', async () => {
    const res = await page({ throw: true });
    expect(res.status).toBe(200);
    expect(res.expires).toBeNull();
    expect(res.body).toContain('the page');
  });

  it('gets through when something took WordPress’s flush away, so PHP ends the buffer itself', async () => {
    const res = await page({ no_flush_all: true });
    expect(res.status).toBe(200);
    expect(res.body).toContain('the page');
  });

  it('counts a CGI Status header as the status: PHP-FPM obeys it, and http_response_code() never hears', async () => {
    const res = await page({ steps: [['header', 'Status: 503 Service Unavailable']] });
    expect(res.expires).toBeNull();
    expect(res.skipped).toBe('status 503');
    const notFound = await page({ steps: [['header', 'Status: 404 Not Found']] });
    expect(notFound.expires).toBe(String(NOT_FOUND_SECONDS));
  });

  it('drops a header line with no colon, which Apache answers with a 500, and keeps the rest', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/?c=${encodeURIComponent(JSON.stringify({ steps: [['header', 'This has no colon'], ['header', 'X-Kept: yes'], ['cookie']] }))}`, { headers: { 'X-Wpl7-Cache': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kept')).toBe('yes');
    expect(res.headers.get('set-cookie')).toContain('a=1');
  });

  it.each<[number]>([[403], [404], [410], [500], [503]])('sends the code http_response_code(%i) set last, after status_header(200) on the way', async (code) => {
    const res = await page({ steps: [['header', 'HTTP/1.1 200 OK'], ['status', code]] });
    expect(res.status).toBe(code);
  });

  describe('what a request says about itself', () => {
    it('may not store with a header nginx does not know, though PHP sees it', async () => {
      const res = await page({}, '/', true, { 'X-Forwarded-Scheme': 'http' });
      expect(res.expires).toBeNull();
      expect(res.skipped).toBe('request header x-forwarded-scheme');
    });

    it('nor with a Content-Type, which PHP has under another name', async () => {
      const res = await page({}, '/', true, { 'Content-Type': 'application/json' });
      expect(res.expires).toBeNull();
      expect(res.skipped).toBe('request header content-type');
    });

    it.each(['Accept-Language', 'X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host', 'X-Forwarded-Port', 'X-Forwarded-Server', 'X-Real-IP', 'Sec-CH-UA-Mobile', 'Cookie'])('may store with %s, which nginx passes on purpose', async (header) => {
      expect((await page({}, '/', true, { [header]: 'x=1' })).expires).toBe('600');
    });

    it('takes a header a .htaccess only copies, and left empty, for what it is', async () => {
      expect((await page({ steps: [] }, '/', true, { 'X-Copied': '' })).expires).toBe('600');
    });

    it('has the Referer until the page is drawn, and then not', async () => {
      const res = await page({}, '/', true, { 'X-Wpl7-Referer': 'https://elsewhere.example.net/secret' });
      expect(res.body).toContain('referer-early=https://elsewhere.example.net/secret referer-late=none');
      expect(res.expires).toBe('600');
    });

    it('is not told about a Referer nginx did not hold back', async () => {
      const res = await page({}, '/', false, { 'X-Wpl7-Referer': 'https://elsewhere.example.net/secret' });
      expect(res.body).toContain('referer-early=none');
    });

    it('gives Cloudflare\'s country to a store that geolocates, and to nothing else', async () => {
      const header = { 'X-Wpl7-Country': 'DE' };
      const store = (where: string) => ({ woocommerce: true, options: { woocommerce_default_customer_address: where } });
      expect((await page(store('geolocation'), '/', true, header)).body).toContain('country=DE raw-country=none');
      expect((await page(store('geolocation_ajax'), '/', true, header)).body).toContain('country=DE raw-country=none');
      expect((await page(store('base'), '/', true, header)).body).toContain('country=none raw-country=none');
      // The option alone, left behind by a plugin that is gone, says nothing.
      expect((await page({ options: { woocommerce_default_customer_address: 'geolocation' } }, '/', true, header)).body).toContain('country=none raw-country=none');
    });
  });

  describe('a clear while the page is being drawn', () => {
    it('stops it being stored, whoever cleared: the panel only deletes files', async () => {
      const res = await page({ steps: [['wipe', path.join(dir, 'cache')]] });
      expect(res.expires).toBeNull();
      expect(res.skipped).toBe('cleared while rendering');
    });

    it('from this very request too', async () => {
      const res = await page({ steps: [['action', 'switch_theme']] });
      expect(res.expires).toBeNull();
      expect(res.skipped).toBe('cleared while rendering');
    });

    it('leaves the next page alone', async () => {
      await page({ steps: [['wipe', path.join(dir, 'cache')]] });
      expect((await page()).expires).toBe('600');
      expect((await page()).expires).toBe('600');
    });

    it('keeps its mark where nginx leaves it alone, and only there', async () => {
      await page();
      expect(fs.readdirSync(path.join(dir, 'cache')).filter((name) => fs.statSync(path.join(dir, 'cache', name)).isFile())).toEqual(['generation.0000000000']);
    });
  });

  it('does not store a 404 for what looks like a file, so one uploaded after it is live at once', async () => {
    for (const url of ['/ads.txt', '/google123.html', '/a/b.xml', '/x.json']) {
      const res = await page({ steps: [['status', 404]] }, url);
      expect(res.expires, url).toBeNull();
      expect(res.skipped, url).toBe('missing file');
    }
    expect((await page({ steps: [['status', 404]] }, '/no-such-page/')).expires).toBe(String(NOT_FOUND_SECONDS));
  });

  describe('another spelling of a page’s address', () => {
    const post = { singular: 'page', permalink: 'https://example.com/members/' };

    it.each(['/Members/', '/MEMBERS/', '/members./', '/members%20/', '/mem!bers/', '/Members'])('is not stored: %s', async (url) => {
      const res = await page(post, url);
      expect(res.expires).toBeNull();
      expect(res.skipped).toBe('another spelling of this address');
    });

    it.each(['/members/', '/members', '/members/2/', '/members/print/'])('is: %s', async (url) => {
      expect((await page(post, url)).expires).toBe('600');
    });

    it('a redirect to the right spelling is stored, as ever', async () => {
      expect((await page({ ...post, steps: [['status', 301]] }, '/Members/')).expires).toBe('600');
    });

    it('takes a permalink in another alphabet as WordPress writes it', async () => {
      const cafe = { singular: 'page', permalink: 'https://example.com/caf%c3%a9/' };
      // 88 is this page's keep rule, further up.
      expect((await page(cafe, '/caf%C3%A9/')).expires).toBe('88');
      expect((await page(cafe, '/caf%c3%a9')).expires).toBe('88');
    });

    it('takes the front page', async () => {
      expect((await page({ singular: 'page', permalink: 'https://example.com/' }, '/')).expires).toBe('600');
    });
  });

  it('matches a keep rule whatever the case, as nginx does a skip rule', async () => {
    expect((await page({}, '/NEWS/')).expires).toBe('77');
  });

  it('does not store a page behind a .htaccess saying who may see it', async () => {
    const site = path.join(dir, 'limited');
    const inner = path.join(site, 'blog');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(site, '.htaccess'), 'Require ip 192.0.2.1\n');
    const res = await page({ abspath: `${site}/` });
    expect(res.expires).toBeNull();
    expect(res.skipped).toBe('.htaccess limits who can see this');
    fs.writeFileSync(path.join(site, '.htaccess'), 'Require all granted\n');
    expect((await page({ abspath: `${site}/` })).expires).toBe('600');
    expect((await page({ abspath: path.join(tmp, 'no-such-folder/') })).expires).toBe('600');
  });

  describe('a visitor’s comment', () => {
    const stamp = path.join(dir, 'comment-clear');
    const stored = path.join(dir, 'cache', 'a', 'bc', 'page');
    const store = () => {
      fs.mkdirSync(path.dirname(stored), { recursive: true });
      fs.writeFileSync(stored, 'x');
    };
    const reset = () => {
      fs.rmSync(stamp, { force: true });
      fs.rmSync(`${stamp}.waiting`, { force: true });
      store();
    };

    it('clears the first time, and not again within the minute', async () => {
      reset();
      await page({ steps: [['comment']] });
      expect(fs.existsSync(stored)).toBe(false);
      store();
      await page({ steps: [['comment']] });
      expect(fs.existsSync(stored)).toBe(true);
      expect(fs.existsSync(`${stamp}.waiting`)).toBe(true);
    });

    it('that had to wait clears on the first request after the minute', async () => {
      reset();
      fs.writeFileSync(stamp, '');
      fs.writeFileSync(`${stamp}.waiting`, '');
      await page();
      expect(fs.existsSync(stored), 'still inside the minute').toBe(true);
      const longAgo = new Date(Date.now() - 120_000);
      fs.utimesSync(stamp, longAgo, longAgo);
      await page();
      expect(fs.existsSync(stored)).toBe(false);
      expect(fs.existsSync(`${stamp}.waiting`)).toBe(false);
    });

    it('from someone logged in always clears: an editor is working', async () => {
      reset();
      fs.writeFileSync(stamp, '');
      await page({ logged_in: true, steps: [['comment']] });
      expect(fs.existsSync(stored)).toBe(false);
    });
  });

  it('keeps a reason ASCII', async () => {
    const res = await page({ steps: [['header', 'Vary: Café']] });
    expect(res.expires).toBeNull();
    expect(res.skipped).toMatch(/^page varies by caf/);
    // eslint-disable-next-line no-control-regex
    expect(res.skipped).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe.skipIf(!HAS_PHP)('what a .htaccess says about who may see a page', () => {
  const dir = writeSite(render(), path.join(tmp, 'htaccess'));

  /** All in one PHP, as each case is one call. */
  function read(cases: readonly string[]): boolean[] {
    const file = path.join(dir, 'batch.php');
    fs.writeFileSync(file, `<?php\nrequire ${JSON.stringify(path.join(dir, 'wp-cache.php'))};\necho json_encode(array_map('wpl7_cache_htaccess_text_limits', ${phpLiteral(cases)}));\n`);
    const res = spawnSync('php', ['-n', '-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', file], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
    return JSON.parse(res.stdout) as boolean[];
  }

  const LIMITS = [
    'Require ip 203.0.113.7',
    'require  host example.com',
    'Require valid-user',
    'Require user bob',
    'Require group staff',
    'Require local',
    `Require expr "%{REMOTE_ADDR} == '203.0.113.7'"`,
    '  Allow from 203.0.113.7',
    'allow from env=ok',
    'AuthType Basic',
    'AuthUserFile /x',
    'Satisfy any',
    'RewriteCond %{REMOTE_ADDR} !^203\\.0\\.113\\.7$',
    'RewriteCond %{REMOTE_HOST} example',
    'RewriteCond %{REMOTE_USER} bob',
    'RewriteCond %{LA-U:REMOTE_USER} bob',
    'RewriteCond %{HTTP:X-Forwarded-For} !^203',
    'RewriteCond %{HTTP:CF-Connecting-IP} !^203',
    `<If "%{REMOTE_ADDR} != '203.0.113.7'">\nRequire all denied\n</If>`,
    `<If "-R '10.0.0.0/8'">\nRequire all granted\n</If>`,
    '<RequireAny>\nRequire ip 203.0.113.7\nRequire valid-user\n</RequireAny>',
    '<IfModule mod_authz_core.c>\nRequire ip 203.0.113.7\n</IfModule>',
    '<FilesMatch "\\.php$">\nRequire ip 203.0.113.7\n</FilesMatch>',
    '<Files index.php>\nAuthType Basic\n</Files>',
    '<Files *.php>\nRequire ip 203.0.113.7\n</Files>',
    '<Files ~ "\\.php$">\nRequire ip 203.0.113.7\n</Files>',
    // A pattern that can't be read counts as covering it.
    '<FilesMatch "(">\nRequire ip 203.0.113.7\n</FilesMatch>',
    // A section for other files doesn't hide what comes after it.
    '<Files wp-login.php>\nRequire all denied\n</Files>\nRequire ip 203.0.113.7',
  ];

  it.each(LIMITS)('limits: %s', (text) => {
    expect(read([text])).toEqual([true]);
  });

  const PUBLIC = [
    '',
    '# Require ip 203.0.113.7',
    '  # AuthType Basic',
    'Require all granted',
    'Require all denied',
    'Require not ip 203.0.113.7',
    '<RequireAll>\nRequire all granted\nRequire not ip 203.0.113.7\n</RequireAll>',
    'Allow from all',
    'Order allow,deny\nAllow from all\nDeny from 203.0.113.7',
    'Deny from 203.0.113.7',
    'RewriteCond %{HTTP_USER_AGENT} BadBot [NC]\nRewriteRule .* - [F]',
    'RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]',
    '<Files wp-login.php>\nAuthType Basic\nAuthName "Staff"\nAuthUserFile /x\nRequire valid-user\n</Files>',
    '<Files "xmlrpc.php">\nOrder deny,allow\nDeny from all\nAllow from 127.0.0.1\n</Files>',
    "<Files 'wp-config.php'>\nRequire ip 203.0.113.7\n</Files>",
    '<FilesMatch "^(xmlrpc|wp-login)\\.php$">\nRequire ip 203.0.113.7\n</FilesMatch>',
    '<Files ~ "\\.(js|css)$">\nAllow from 203.0.113.7\n</Files>',
    '<files WP-LOGIN.PHP>\nauthtype basic\n</files>',
  ];

  it.each(PUBLIC)('leaves pages public: %s', (text) => {
    expect(read([text])).toEqual([false]);
  });

  it('counts a file its regexes give up on as limiting: better a page not stored', () => {
    const file = path.join(dir, 'give-up.php');
    fs.writeFileSync(file, `<?php\nini_set('pcre.jit', '0'); ini_set('pcre.backtrack_limit', '1');\nrequire ${JSON.stringify(path.join(dir, 'wp-cache.php'))};\nvar_export(wpl7_cache_htaccess_text_limits('<Files wp-login.php>\\nAuthType Basic\\n</Files>\\nRewriteEngine On\\n'));\n`);
    const res = spawnSync('php', ['-n', '-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', file], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('true');
  });

  it('reads WordPress’s own block as public', () => {
    expect(read(['# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n# END WordPress\n'])).toEqual([false]);
  });
});

describe.skipIf(!HAS_PHP)('what clears the cache', () => {
  const dir = writeSite(render(), path.join(tmp, 'clears'));

  /** Runs under the command line, as WP-CLI does. Returns whether the files went, and what PHP said. */
  function run(code: string, setup = '') {
    const cache = path.join(dir, 'cache');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(path.join(cache, 'a', 'bc'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'a', 'bc', 'page'), 'x');
    const file = path.join(dir, `run-${Math.random().toString(36).slice(2)}.php`);
    fs.writeFileSync(
      file,
      `<?php
${setup}
require ${JSON.stringify(path.join(dir, 'wp-cache.php'))};
require ${JSON.stringify(path.join(dir, 'stub.php'))};
stub_load_preregistered();
do_action('muplugins_loaded');
register_shutdown_function(function () { do_action('shutdown'); });
add_action('shutdown', 'wp_ob_end_flush_all', 1);
${code}
`,
    );
    const res = spawnSync('php', ['-n', '-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', file], { encoding: 'utf8' });
    fs.rmSync(file);
    return { cleared: !fs.existsSync(path.join(cache, 'a', 'bc', 'page')), err: res.stderr, out: res.stdout, status: res.status };
  }
  const clears = (code: string, setup = '') => {
    const res = run(code, setup);
    expect(res.err).toBe('');
    return res.cleared;
  };

  it('nothing changed: nothing goes', () => {
    expect(clears('')).toBe(false);
    expect(clears("do_action('wpl7_some_other_hook');")).toBe(false);
  });

  /**
   * Whether each bit of code asks for a clear. All in one PHP: starting one per case would be most
   * of this file's time, and the note a change leaves is what `clears` above acts on.
   */
  function asksToClear(cases: Record<string, string>): Record<string, boolean> {
    const file = path.join(dir, `batch-${Math.random().toString(36).slice(2)}.php`);
    fs.writeFileSync(
      file,
      `<?php
require ${JSON.stringify(path.join(dir, 'wp-cache.php'))};
require ${JSON.stringify(path.join(dir, 'stub.php'))};
stub_load_preregistered();
do_action('muplugins_loaded');
$state = &wpl7_cache_state();
$results = [];
foreach (${phpLiteral(cases)} as $name => $code) {
    $state['changed'] = false;
    eval($code);
    $results[$name] = $state['changed'];
}
echo json_encode($results);
`,
    );
    const res = spawnSync('php', ['-n', '-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', file], { encoding: 'utf8' });
    fs.rmSync(file);
    expect(res.stderr).toBe('');
    return JSON.parse(res.stdout) as Record<string, boolean>;
  }
  /** Each case with what it should say, as the name it is reported under when they differ. */
  const expectClears = (table: Record<string, [code: string, expected: boolean]>) => {
    const asked = asksToClear(Object.fromEntries(Object.entries(table).map(([name, [code]]) => [name, code])));
    expect(asked).toEqual(Object.fromEntries(Object.entries(table).map(([name, [, expected]]) => [name, expected])));
  };

  const post = (type: string, status: string) => `(object) ['post_type' => '${type}', 'post_status' => '${status}']`;
  const transition = (to: string, from: string, type: string) => `do_action('transition_post_status', '${to}', '${from}', ${post(type, to)});`;

  it('a post status changing: to or from published, on what visitors can see', () => {
    expectClears({
      'published from draft': [transition('publish', 'draft', 'post'), true],
      'published from scheduled': [transition('publish', 'future', 'post'), true],
      'published post updated': [transition('publish', 'publish', 'post'), true],
      unpublished: [transition('draft', 'publish', 'post'), true],
      trashed: [transition('trash', 'publish', 'page'), true],
      'a product': [transition('publish', 'draft', 'product'), true],
      'a template': [transition('publish', 'publish', 'wp_template'), true],
      'a template part': [transition('publish', 'publish', 'wp_template_part'), true],
      'global styles': [transition('publish', 'publish', 'wp_global_styles'), true],
      'a navigation': [transition('publish', 'publish', 'wp_navigation'), true],
      'a synced pattern': [transition('publish', 'publish', 'wp_block'), true],
      'a new draft': [transition('draft', 'auto-draft', 'post'), false],
      'a draft saved': [transition('draft', 'draft', 'post'), false],
      'a draft sent for review': [transition('pending', 'draft', 'post'), false],
      'a new attachment': [transition('inherit', 'new', 'attachment'), false],
      'a menu item': [transition('publish', 'publish', 'nav_menu_item'), false],
      'a revision': [transition('publish', 'draft', 'revision'), false],
      'a changeset': [transition('publish', 'publish', 'customize_changeset'), false],
      'nonsense for a post': ["do_action('transition_post_status', 'publish', 'draft', 'not a post');", false],
      'no post at all': ["do_action('transition_post_status', 'publish', 'draft');", false],
    });
  });

  it.each(['post_updated', 'save_post'])('%s: a published post, not a draft, a revision or an autosave', (hook) => {
    expectClears({
      published: [`do_action('${hook}', 1, ${post('post', 'publish')});`, true],
      draft: [`do_action('${hook}', 1, ${post('post', 'draft')});`, false],
      'not viewable': [`do_action('${hook}', 1, ${post('nav_menu_item', 'publish')});`, false],
      revision: [`do_action('${hook}', 'revision', ${post('post', 'publish')});`, false],
      autosave: [`do_action('${hook}', 'autosave', ${post('post', 'publish')});`, false],
      'no post at all': [`do_action('${hook}', 1);`, false],
    });
  });

  it('a post going away: only one that was published', () => {
    expectClears({
      'deleted while published': [`do_action('deleted_post', 1, ${post('post', 'publish')});`, true],
      'deleted from the trash': [`do_action('deleted_post', 1, ${post('post', 'trash')});`, false],
      'deleted, not viewable': [`do_action('deleted_post', 1, ${post('nav_menu_item', 'publish')});`, false],
      // WordPress before 5.5 passes no post, and it is gone by then.
      'deleted, on an old WordPress': ["do_action('deleted_post', 1);", true],
      'trashed while published': ["do_action('trashed_post', 1, 'publish');", true],
      'trashed as a draft': ["do_action('trashed_post', 1, 'draft');", false],
      // WordPress before 6.3 passes no status: it is in the post's meta.
      'trashed while published, on an old WordPress': ["$GLOBALS['stub'] = ['trash_meta' => 'publish']; do_action('trashed_post', 1);", true],
      'trashed as a draft, on an old WordPress': ["$GLOBALS['stub'] = ['trash_meta' => 'draft']; do_action('trashed_post', 1);", false],
      'an attachment updated': ["do_action('attachment_updated', 1, null, null);", true],
    });
  });

  it('comments: only what is, or was, on a page, so spam clears nothing', () => {
    const comment = (approved: string) => `(object) ['comment_approved' => '${approved}']`;
    const status = (to: string, from: string) => `do_action('transition_comment_status', '${to}', '${from}', ${comment('0')});`;
    expectClears({
      'sent, approved as a number': ["do_action('comment_post', 1, 1, []);", true],
      'sent, approved as a string': ["do_action('comment_post', 1, '1', []);", true],
      'sent, held': ["do_action('comment_post', 1, 0, []);", false],
      'sent, spam': ["do_action('comment_post', 1, 'spam', []);", false],
      'sent, trash': ["do_action('comment_post', 1, 'trash', []);", false],
      'inserted by WP-CLI, approved': [`do_action('wp_insert_comment', 1, ${comment('1')});`, true],
      'inserted by WP-CLI, held': [`do_action('wp_insert_comment', 1, ${comment('0')});`, false],
      'inserted by WP-CLI, spam': [`do_action('wp_insert_comment', 1, ${comment('spam')});`, false],
      approved: [status('approved', 'unapproved'), true],
      unapproved: [status('unapproved', 'approved'), true],
      'marked as spam': [status('spam', 'approved'), true],
      trashed: [status('trash', 'approved'), true],
      deleted: [status('delete', 'approved'), true],
      'held, then spam': [status('spam', 'unapproved'), false],
      'spam, then trash': [status('trash', 'spam'), false],
      'spam, then held': [status('unapproved', 'spam'), false],
      'spam, then deleted': [status('delete', 'spam'), false],
      'editing an approved one': ["do_action('edit_comment', 'approved', []);", true],
      'editing spam': ["do_action('edit_comment', 'spam', []);", false],
      'deleting an approved one': [`do_action('deleted_comment', 1, ${comment('1')});`, true],
      'deleting spam': [`do_action('deleted_comment', 1, ${comment('spam')});`, false],
      'deleting, no comment passed': ["do_action('deleted_comment', 1);", false],
    });
  });

  it('everything else that shows on pages, and other cache plugins clearing', () => {
    const hooks = [
      'created_term',
      'edited_term',
      'delete_term',
      'wp_update_nav_menu',
      'wp_delete_nav_menu',
      'customize_save_after',
      'switch_theme',
      'activated_plugin',
      'deactivated_plugin',
      'upgrader_process_complete',
      '_core_updated_successfully',
      'update_option_sidebars_widgets',
      'woocommerce_product_set_stock',
      'woocommerce_variation_set_stock',
      'woocommerce_product_set_stock_status',
      'woocommerce_variation_set_stock_status',
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
    ];
    expectClears(Object.fromEntries(hooks.map((hook) => [hook, [`do_action('${hook}', 1, 2, 3);`, true]])));
  });

  it('a change is acted on: the files go', () => {
    expect(clears("do_action('switch_theme');")).toBe(true);
    expect(clears(transition('publish', 'draft', 'post'))).toBe(true);
    expect(clears(transition('draft', 'draft', 'post'))).toBe(false);
  });

  describe('options', () => {
    const write = "do_action('updated_option', 'blogname', 'a', 'b');";
    const cli = "define('WP_CLI', true); $_SERVER['argv'] = ['wp', 'option', 'update', 'blogname', 'x'];";
    const post = "$_SERVER['REQUEST_METHOD'] = 'POST'; $_SERVER['argv'] = [];";
    const admin = "$GLOBALS['stub'] = ['can' => true, 'pluggable' => true];";

    it('under WP-CLI: every kind of write clears, whatever comes before the command', () => {
      expect(clears("do_action('updated_option', 'blogname', 'a', 'b');", cli)).toBe(true);
      expect(clears("do_action('added_option', 'blogname', 'a');", cli)).toBe(true);
      expect(clears("do_action('deleted_option', 'blogname');", cli)).toBe(true);
      expect(clears(write, "define('WP_CLI', true); $_SERVER['argv'] = ['wp', '--path=/x', 'option', 'update'];")).toBe(true);
    });

    it('a transient clears nothing, nor does the list of scheduled tasks', () => {
      const anyOf = "do_action('updated_option', '_transient_x', 'a', 'b'); do_action('added_option', '_site_transient_x', 'a'); do_action('deleted_option', '_transient_timeout_x'); do_action('updated_option', 'cron', [], []);";
      expect(clears(anyOf, cli)).toBe(false);
    });

    it('under cron clears nothing, though a post it publishes does', () => {
      const cron = "define('WP_CLI', true); define('DOING_CRON', true); $_SERVER['argv'] = ['wp', 'cron', 'event', 'run', '--due-now'];";
      expect(clears(write, cron)).toBe(false);
      expect(clears(transition('publish', 'future', 'post'), cron)).toBe(true);
    });

    it('from the panel’s cron command, before WP-CLI says DOING_CRON, clears nothing', () => {
      expect(clears(write, "define('WP_CLI', true); $_SERVER['argv'] = ['wp', 'cron', 'event', 'run', '--due-now'];")).toBe(false);
      expect(clears(write, "define('WP_CLI', true); $_SERVER['argv'] = ['wp', '--path=/x', 'cron', 'event', 'run'];")).toBe(false);
    });

    it('an administrator saving clears', () => {
      expect(clears(write, `${post} ${admin}`)).toBe(true);
      expect(clears("do_action('added_option', 'blogname', 'a');", `${post} ${admin}`)).toBe(true);
      expect(clears("do_action('deleted_option', 'blogname');", `${post} ${admin}`)).toBe(true);
    });

    it('anyone else writing clears nothing, nor does a request that only reads', () => {
      expect(clears(write, `${post} $GLOBALS['stub'] = ['can' => false, 'pluggable' => true];`)).toBe(false);
      expect(clears(write, `$_SERVER['REQUEST_METHOD'] = 'GET'; $_SERVER['argv'] = []; ${admin}`)).toBe(false);
      expect(clears(write, `$_SERVER['REQUEST_METHOD'] = 'HEAD'; $_SERVER['argv'] = []; ${admin}`)).toBe(false);
      expect(clears(write, `$_SERVER['argv'] = []; ${admin}`)).toBe(false);
    });

    it('a request the browser sends by itself clears nothing', () => {
      for (const action of ['heartbeat', 'as_async_request_queue_runner']) {
        expect(clears(write, `${post} ${admin} define('DOING_AJAX', true); $_REQUEST['action'] = '${action}';`)).toBe(false);
      }
      expect(clears(write, `${post} ${admin} define('DOING_AJAX', true); $_REQUEST['action'] = 'save_my_settings';`)).toBe(true);
    });

    it('a write before WordPress can say who is asking clears nothing, and is no fatal', () => {
      const res = run(write, `${post} $GLOBALS['stub'] = ['can' => true];`);
      expect(res.err).toBe('');
      expect(res.cleared).toBe(false);
    });
  });

  describe('deleting the files', () => {
    const anyChange = "do_action('wp_cache_cleared');";

    it('empties every folder, leaving the folders', () => {
      const cache = path.join(dir, 'cache');
      expect(clears(`${anyChange} add_action('shutdown', function () { file_put_contents(${JSON.stringify(path.join(cache, 'a', 'second'))}, 'x'); }, 5);`)).toBe(true);
      expect(fs.existsSync(path.join(cache, 'a', 'second'))).toBe(false);
      expect(fs.statSync(path.join(cache, 'a', 'bc')).isDirectory()).toBe(true);
    });

    it('waits for the rest of shutdown, so a clear asked for there counts', () => {
      // Autoptimize fires its action from shutdown, at priority 11.
      expect(clears("add_action('shutdown', function () { do_action('autoptimize_action_cachepurged'); }, 11);")).toBe(true);
    });

    it('happens after the page is on its way', () => {
      const cache = path.join(dir, 'cache');
      const res = run(`${anyChange} add_action('shutdown', function () { echo file_exists(${JSON.stringify(path.join(cache, 'a', 'bc', 'page'))}) ? 'still there' : 'gone'; }, 2);`);
      expect(res.out).toBe('still there');
      expect(res.cleared).toBe(true);
    });

    it('never follows a link out', () => {
      const cache = path.join(dir, 'cache');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(path.join(outside, 'folder'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'file'), 'keep me');
      fs.writeFileSync(path.join(outside, 'folder', 'inner'), 'keep me');
      const links = `symlink(${JSON.stringify(path.join(outside, 'file'))}, ${JSON.stringify(path.join(cache, 'link-to-file'))}); symlink(${JSON.stringify(path.join(outside, 'folder'))}, ${JSON.stringify(path.join(cache, 'link-to-folder'))});`;
      expect(clears(`${links} ${anyChange}`)).toBe(true);
      expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe('keep me');
      expect(fs.readFileSync(path.join(outside, 'folder', 'inner'), 'utf8')).toBe('keep me');
      expect(fs.lstatSync(path.join(cache, 'a')).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(cache, 'link-to-file'))).toBe(false);
      expect(fs.existsSync(path.join(cache, 'link-to-folder'))).toBe(false);
    });

    it('takes a missing folder in its stride', () => {
      const res = run(`${anyChange} add_action('shutdown', function () { @rmdir(${JSON.stringify(path.join(dir, 'cache'))}); exec('rm -rf ' . escapeshellarg(${JSON.stringify(path.join(dir, 'cache'))})); }, 5);`);
      expect(res.err).toBe('');
      expect(res.status).toBe(0);
    });
  });

  describe('the button', () => {
    const bar = 'global $bar; $bar = new Stub_Bar(); do_action(\'admin_bar_menu\', $bar); echo json_encode($GLOBALS[\'stub_nodes\']);';

    it('is there for an administrator', () => {
      const res = run(bar, "$GLOBALS['stub'] = ['can' => true];");
      expect(res.err).toBe('');
      const nodes = JSON.parse(res.out);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ id: 'wpl7-clear-cache', title: 'Clear cache' });
      expect(nodes[0].href).toBe('https://example.com/wp-admin/admin-post.php?action=wpl7_clear_cache&_wpnonce=wpl7_clear_cache');
    });

    it('is not there for anyone else', () => {
      expect(JSON.parse(run(bar, "$GLOBALS['stub'] = ['can' => false];").out)).toEqual([]);
    });

    it('says it is done on the front of the site', () => {
      const res = run(bar, "$GLOBALS['stub'] = ['can' => true]; $_GET['wpl7_cache_cleared'] = '1';");
      expect(JSON.parse(res.out)[0].title).toBe('Cache cleared');
    });

    it('clears at once, and goes back where it came from', () => {
      const res = run("do_action('admin_post_wpl7_clear_cache');", "$GLOBALS['stub'] = ['can' => true, 'referer' => 'https://example.com/a/'];");
      expect(res.err).toBe('');
      expect(res.cleared).toBe(true);
      expect(res.out).toBe('redirect: https://example.com/a/?wpl7_cache_cleared=1');
    });

    it('goes to wp-admin when it cannot tell where it came from', () => {
      const res = run("do_action('admin_post_wpl7_clear_cache');", "$GLOBALS['stub'] = ['can' => true];");
      expect(res.out).toBe('redirect: https://example.com/wp-admin/?wpl7_cache_cleared=1');
    });

    it('refuses anyone who is not an administrator', () => {
      const res = run("do_action('admin_post_wpl7_clear_cache');", "$GLOBALS['stub'] = ['can' => false];");
      expect(res.cleared).toBe(false);
      expect(res.out).toMatch(/^died:/);
    });

    it('refuses a bad nonce', () => {
      const res = run("do_action('admin_post_wpl7_clear_cache');", "$GLOBALS['stub'] = ['can' => true, 'bad_nonce' => true];");
      expect(res.cleared).toBe(false);
      expect(res.out).toBe('died: nonce');
    });

    it('shows a notice in wp-admin, to an administrator, once asked', () => {
      const notice = "do_action('admin_notices');";
      expect(run(notice, "$GLOBALS['stub'] = ['can' => true]; $_GET['wpl7_cache_cleared'] = '1';").out).toContain('Cache cleared.');
      expect(run(notice, "$GLOBALS['stub'] = ['can' => true];").out).toBe('');
      expect(run(notice, "$GLOBALS['stub'] = ['can' => false]; $_GET['wpl7_cache_cleared'] = '1';").out).toBe('');
    });

    it('asks wp-admin to take the mark off the address', () => {
      const res = run("echo json_encode(apply_filters('removable_query_args', ['a']));");
      expect(JSON.parse(res.out)).toEqual(['a', 'wpl7_cache_cleared']);
    });
  });

  describe('Site Health', () => {
    const filter = "apply_filters('site_status_page_cache_supported_cache_headers'";

    it('is told what x-cache-status means, on a WordPress that does not know', () => {
      const res = run(`$h = ${filter}, ['age' => null]); echo json_encode(array_keys($h)), ' ', var_export(($h['x-cache-status'])('HIT'), true), ' ', var_export(($h['x-cache-status'])('MISS'), true);`);
      expect(res.err).toBe('');
      expect(res.out).toBe('["age","x-cache-status"] true false');
    });

    it('is left alone on one that does, from 7.0 on', () => {
      const res = run(`$h = ${filter}, ['x-cache-status' => 'its_own']); echo $h['x-cache-status'];`);
      expect(res.out).toBe('its_own');
    });

    it('stands up to another filter having broken the list', () => {
      const res = run(`echo json_encode(${filter}, 'nonsense'));`);
      expect(res.err).toBe('');
      expect(res.out).toBe('"nonsense"');
    });
  });
});
