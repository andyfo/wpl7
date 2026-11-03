// @docs sites/caching
import { NOT_FOUND_SECONDS, cachePathRegex, clampKeepSeconds, usableCacheRules, type SiteCacheRules } from '../../shared/cacheRules.js';
import { PAGE_CACHE_DIR_IN_CONTAINER, REDIS_SOCKET_IN_CONTAINER } from './siteStack.js';

/**
 * The WordPress side of a site's caches: `wp-cache.php`, in the read-only runtime folder and
 * required from wp-config.php (WORDPRESS_CONFIG_EXTRA) on stack 2. It settles three things only
 * WordPress can, on every request and under WP-CLI alike, after clearing what PHP-FPM would
 * otherwise show every request of the environment, and putting right two things PHP-FPM does with
 * a page's headers:
 *
 *   - the Redis Object Cache plugin's settings, whether the plugin is there or not;
 *   - whether a page may be stored and for how long, which nginx is told by `X-Accel-Expires`:
 *     nginx has no default time, so a response without that header is never stored;
 *   - when the page cache has to be emptied, because something visitors can see has changed.
 *
 * It is loaded before wp-settings.php, so add_action does not exist yet. It pre-registers one
 * callback in `$wp_filter`, which WordPress turns into hooks since 4.7, and adds the rest from
 * there. A broken cache layer must not take a site down, so what an old WordPress may not have
 * is checked for, and the callback that runs at the very end of a request catches everything:
 * WordPress may be half gone by then.
 *
 * Kept free of backticks and dollar-brace, so it fits in a String.raw literal as it is. What is
 * particular to a site goes in through `phpLiteral`, never by joining strings.
 */

export interface WpCacheOptions {
  pageCache: boolean;
  /** How long this site keeps a page: `siteKeepSeconds`. Clamped here too. */
  keepSeconds: number;
  /** What the site keeps; the rules in force are worked out from it. */
  rules: Pick<SiteCacheRules, 'off' | 'own'>;
  /** Told about each stored rule that is left out, for the job log. */
  warn?: (message: string) => void;
}

/** A value as PHP source. In a single-quoted string only a backslash and the quote mean anything. */
export function phpLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Not a whole number: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return `'${value.replace(/[\\']/g, '\\$&')}'`;
  if (Array.isArray(value)) return `[${value.map(phpLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    return `[${Object.entries(value)
      .map(([key, item]) => `${phpLiteral(key)} => ${phpLiteral(item)}`)
      .join(', ')}]`;
  }
  throw new Error(`Cannot be written as PHP: ${typeof value}`);
}

/** When a visitor's comment last cleared the cache. /run is emptied at every start, as the cache is. */
const COMMENT_STAMP_IN_CONTAINER = '/run/wpl7/comment-clear';

const HEADER = [
  '<?php',
  "// Written by the WPL7 panel from this site's caching settings, and mounted read-only.",
  '// Change them in the panel: an edit here is overwritten.',
];

/**
 * Checked against the plugin's code, 3.0.0: a socket through phpredis; a Redis that is down must
 * not take the site with it; a change the panel can't see heals by itself within 4 hours; and no
 * banners or HTML comment, because the comment would be frozen into stored pages.
 */
const REDIS_CONSTANTS: Record<string, string | number | boolean> = {
  WP_REDIS_SCHEME: 'unix',
  WP_REDIS_PATH: REDIS_SOCKET_IN_CONTAINER,
  WP_REDIS_CLIENT: 'phpredis',
  WP_REDIS_GRACEFUL: true,
  WP_REDIS_MAXTTL: 14_400,
  WP_REDIS_DISABLE_BANNERS: true,
  WP_REDIS_DISABLE_COMMENT: true,
};

/**
 * PHP-FPM with `clear_env = no` copies the whole environment into every request's $_SERVER, which
 * mod_php never did, and plugins print or report $_SERVER (debug bars, error reporters). wp-config.php
 * has read what it needs by now, and it uses getenv() anyway.
 */
const FORGET_ENVIRONMENT = String.raw`foreach (array_keys($_SERVER) as $wpl7_name) {
    if (strpos((string) $wpl7_name, 'WORDPRESS_') === 0) unset($_SERVER[$wpl7_name]);
}
unset($wpl7_name);`;

/**
 * Two things PHP-FPM does that mod_php didn't, fixed as the headers go out.
 *
 * PHP-FPM sends the status line a page set first, and mod_php the code it set last. WordPress calls
 * status_header(200) on every page it finds, so http_response_code(403) from a theme or a plugin
 * went out as a 200 here, with the page's other headers. A plugin registering a callback of its own
 * replaces this one, and is back to that.
 *
 * Apache answers a 500 to a header line with no colon in it, where mod_php passed it over. PHP can
 * only remove such a line by removing them all.
 */
const FIX_HEADERS = String.raw`if (PHP_SAPI !== 'cli') {
    header_register_callback(static function (): void {
        $code = http_response_code();
        if (is_int($code) && $code !== 200) header('HTTP/1.1 ' . $code);
        $lines = headers_list();
        $good = array_filter($lines, static function (string $line): bool { return strpos($line, ':') !== false; });
        if (count($good) !== count($lines)) {
            header_remove();
            foreach ($good as $line) header($line, false);
        }
    });
}`;

/** A site that defined one itself keeps its own: PHP has no way to take a constant back. */
const redisConstants = () =>
  Object.entries(REDIS_CONSTANTS).map(([name, value]) => `if (!defined(${phpLiteral(name)})) define(${phpLiteral(name)}, ${phpLiteral(value)});`);

/**
 * The fixed part. Its functions are all inside one `if`, so a second require defines nothing twice.
 *
 * What it listens to was read in WordPress 7.1.4, WooCommerce 11.2.1 and the other plugins' own
 * code; the versions are on the watchlist (docs/internal/watchlist.md).
 */
const WP_CACHE_CODE = String.raw`
function wpl7_cache_boot(): void {
    static $booted = false;
    if ($booted) return;
    $booted = true;

    // Before redirect_canonical (priority 10): a 301 is stored too, so bots asking for an old
    // address stop costing a full load. The query is parsed by now.
    add_action('template_redirect', 'wpl7_cache_start', -9999, 0);
    add_action('plugins_loaded', 'wpl7_cache_country', -9999, 0);

    $changes = [
        // WordPress. Media only counts when an existing file changes: a new upload is on no page yet.
        'attachment_updated', 'created_term', 'edited_term', 'delete_term',
        'wp_update_nav_menu', 'wp_delete_nav_menu', 'update_option_sidebars_widgets',
        'customize_save_after', 'switch_theme', 'activated_plugin', 'deactivated_plugin',
        'upgrader_process_complete', '_core_updated_successfully',
        // WooCommerce: stock shows on product and shop pages.
        'woocommerce_product_set_stock', 'woocommerce_variation_set_stock',
        'woocommerce_product_set_stock_status', 'woocommerce_variation_set_stock_status',
        // Other cache and optimisation plugins. A stored page pointing at CSS they just deleted is
        // the classic broken page. WP Rocket 3.24:
        'after_rocket_clean_domain', 'after_rocket_clean_cache_dir', 'after_rocket_clean_minify',
        // W3 Total Cache 2.11.0:
        'w3tc_flush_all', 'w3tc_flush_posts', 'w3tc_flush_after_minify',
        // WP Super Cache 3.1.4:
        'wp_cache_cleared',
        // LiteSpeed Cache 7.9.2:
        'litespeed_purged_all', 'litespeed_purged_all_lscache', 'litespeed_purged_all_cssjs',
        // Autoptimize 3.1.17, which fires this from shutdown, at priority 11:
        'autoptimize_action_cachepurged',
        // Elementor 4.3.5:
        'elementor/core/files/clear_cache',
    ];
    foreach ($changes as $hook) add_action($hook, 'wpl7_cache_changed', 10, 0);

    add_action('transition_post_status', 'wpl7_cache_post_status', 10, 3);
    add_action('post_updated', 'wpl7_cache_post_saved', 10, 2);
    add_action('save_post', 'wpl7_cache_post_saved', 10, 2);
    add_action('deleted_post', 'wpl7_cache_post_deleted', 10, 2);
    add_action('trashed_post', 'wpl7_cache_post_trashed', 10, 2);

    add_action('comment_post', 'wpl7_cache_comment_posted', 10, 2);
    add_action('wp_insert_comment', 'wpl7_cache_comment_inserted', 10, 2);
    add_action('transition_comment_status', 'wpl7_cache_comment_status', 10, 2);
    add_action('edit_comment', 'wpl7_cache_comment_edited', 10, 1);
    add_action('deleted_comment', 'wpl7_cache_comment_deleted', 10, 2);

    add_action('updated_option', 'wpl7_cache_option', 10, 1);
    add_action('added_option', 'wpl7_cache_option', 10, 1);
    add_action('deleted_option', 'wpl7_cache_option', 10, 1);

    // Last, so a clear asked for by anything else at shutdown is seen.
    add_action('shutdown', 'wpl7_cache_shutdown', PHP_INT_MAX, 0);

    add_action('admin_bar_menu', 'wpl7_cache_admin_bar', 100, 1);
    add_action('admin_post_wpl7_clear_cache', 'wpl7_cache_clear_request', 10, 0);
    add_action('admin_notices', 'wpl7_cache_admin_notice', 10, 0);
    add_filter('removable_query_args', 'wpl7_cache_removable_args', 10, 1);
    add_filter('site_status_page_cache_supported_cache_headers', 'wpl7_cache_health_headers', 10, 1);
}

/** What this request has found out. A static outlives the globals PHP destroys at its end. */
function &wpl7_cache_state(): array {
    static $state = ['post_type' => '', 'own_path' => '', 'not_found' => false, 'geolocate' => false, 'changed' => false, 'option_changed' => false, 'generation' => null];
    return $state;
}

// ---------------------------------------------------------------------------
// As a request starts

/**
 * Before WordPress reads anything. nginx holds the Referer back on the path that may store a page,
 * because plugins print it into forms. Until the page starts being drawn it is safe to have, and a
 * hotlink check or a click counter needs it: wpl7_cache_start takes it away again.
 */
function wpl7_cache_request_start(): void {
    if (($_SERVER['HTTP_X_WPL7_CACHE'] ?? '') !== '1') return;
    if (($_SERVER['HTTP_X_WPL7_REFERER'] ?? '') !== '') $_SERVER['HTTP_REFERER'] = $_SERVER['HTTP_X_WPL7_REFERER'];
    unset($_SERVER['HTTP_X_WPL7_REFERER']);
    $state = &wpl7_cache_state();
    if ($state['generation'] === null) $state['generation'] = wpl7_cache_generation_now();
}

/**
 * A store whose prices follow the visitor's country reads Cloudflare's header, and nginx holds that
 * back too. Safe to give it: plain Geolocate is never stored, and with page caching support a page
 * is stored under its country's ?v=, which a visitor from elsewhere is redirected away from.
 */
function wpl7_cache_country(): void {
    $country = (string) ($_SERVER['HTTP_X_WPL7_COUNTRY'] ?? '');
    unset($_SERVER['HTTP_X_WPL7_COUNTRY']);
    if ($country === '' || !class_exists('WooCommerce', false)) return;
    $where = get_option('woocommerce_default_customer_address');
    if ($where === 'geolocation' || $where === 'geolocation_ajax') $_SERVER['HTTP_CF_IPCOUNTRY'] = $country;
}

// ---------------------------------------------------------------------------
// A clear that comes while a page is being drawn

/** nginx's start-up leaves a file alone when its name ends so: it is how nginx names a page being written. */
function wpl7_cache_generation_file(): string {
    return wpl7_cache_settings()['dir'] . '/generation.0000000000';
}

/**
 * What the cache was last cleared to. A clear deletes every file in the folder, this one too, so a
 * page drawn from what WordPress read before the clear can tell, whoever cleared: the panel only
 * deletes files. The first request after a clear makes a new one.
 */
function wpl7_cache_generation_now(): string {
    $file = wpl7_cache_generation_file();
    $value = @file_get_contents($file);
    if (is_string($value) && $value !== '') return $value;
    $value = bin2hex(random_bytes(8));
    $handle = @fopen($file, 'x');
    if ($handle === false) {
        // Someone else's by now, or no such folder.
        $other = @file_get_contents($file);
        return is_string($other) ? $other : '';
    }
    fwrite($handle, $value);
    fclose($handle);
    return $value;
}

function wpl7_cache_generation_changed(string $at_start): bool {
    $value = @file_get_contents(wpl7_cache_generation_file());
    return ($value === false ? '' : $value) !== $at_start;
}

// ---------------------------------------------------------------------------
// Storing a page

function wpl7_cache_start(): void {
    // nginx sends this on the path that may store a page and blanks it on the other. There nothing
    // would read the answer, so there is no buffer for a streamed or big response to go through.
    if (($_SERVER['HTTP_X_WPL7_CACHE'] ?? '') !== '1' || headers_sent()) return;

    // From here on what is drawn may reach everyone: see wpl7_cache_request_start.
    unset($_SERVER['HTTP_REFERER']);

    $state = &wpl7_cache_state();
    if (is_singular()) {
        $post = get_queried_object();
        if (is_object($post) && isset($post->post_type)) $state['post_type'] = (string) $post->post_type;
        $own = function_exists('get_permalink') && is_object($post) ? get_permalink($post) : false;
        if (is_string($own)) $state['own_path'] = (string) parse_url($own, PHP_URL_PATH);
    } elseif (is_post_type_archive()) {
        $type = get_query_var('post_type');
        if (is_array($type)) $type = reset($type);
        if (is_string($type)) $state['post_type'] = $type;
    }
    $state['not_found'] = is_404();
    // Prices by country at the same address, with no cookie to go by. The panel keeps such a store
    // Off when it moves here; this is for one that turns it on later.
    $state['geolocate'] = class_exists('WooCommerce', false) && get_option('woocommerce_default_customer_address') === 'geolocation';

    // Past 8 MB PHP passes the output on, which counts as flushing early below, so a plugin sending
    // a big file from here can't run PHP out of memory.
    ob_start('wpl7_cache_finish', 8 * 1024 * 1024);
}

/** The buffer's callback: the page goes out untouched, whatever happens in here. */
function wpl7_cache_finish($buffer, $phase) {
    try {
        wpl7_cache_decide((int) $phase);
    } catch (\Throwable $e) {
        // No header: nginx doesn't store a page it isn't told to.
    }
    return $buffer;
}

function wpl7_cache_decide(int $phase): void {
    static $decided = false;
    if ($decided) return;
    $final = ($phase & PHP_OUTPUT_HANDLER_FINAL) !== 0;
    $thrown_away = ($phase & PHP_OUTPUT_HANDLER_CLEAN) !== 0;
    // ob_clean(): what was printed so far is gone, and the page goes on.
    if ($thrown_away && !$final) return;
    $decided = true;
    if (headers_sent()) return;

    // WordPress ends every buffer in its shutdown action, at priority 1. Any other end means the
    // page was sent in parts or never finished, and streaming is then what it wants.
    if (!$final || $thrown_away || did_action('shutdown') < 1) {
        header('X-Accel-Buffering: no');
        wpl7_cache_withhold('page flushed early');
        return;
    }

    $headers = wpl7_cache_response_headers();
    // A CGI Status header: PHP-FPM passes it on, Apache obeys, and PHP doesn't count it as the status.
    $status = isset($headers['status']) ? (int) end($headers['status']) : (int) http_response_code();
    $reason = wpl7_cache_refusal($status, $headers);
    if ($reason !== null) {
        wpl7_cache_withhold($reason);
    } elseif (!isset($headers['x-accel-expires'])) {
        header('X-Accel-Expires: ' . wpl7_cache_seconds($status));
    }
}

/** Sent so far, by lower-case name. headers_list() is the only place that has them all. */
function wpl7_cache_response_headers(): array {
    $headers = [];
    foreach (headers_list() as $line) {
        $parts = explode(':', $line, 2);
        $headers[strtolower(trim($parts[0]))][] = trim($parts[1] ?? '');
    }
    return $headers;
}

/** Why this page must not be stored; null when it may. */
function wpl7_cache_refusal(int $status, array $headers): ?string {
    // Never 302, 303 or 307: those are how a geo redirect looks.
    if ($status !== 200 && $status !== 301 && $status !== 404) return 'status ' . $status;
    if (defined('DONOTCACHEPAGE') && DONOTCACHEPAGE) return 'DONOTCACHEPAGE';

    // WordPress calls nocache_headers() on every 404 of its own, so there they say nothing about the
    // page. nginx makes the same exception.
    if ($status !== 404) {
        foreach ($headers['cache-control'] ?? [] as $value) {
            if (preg_match('/no-cache|no-store|private|(?:^|[,\s])(?:s-maxage|max-age)\s*=\s*0+\s*(?:,|$)/i', $value)) return 'page says no-cache';
        }
        foreach ($headers['expires'] ?? [] as $value) {
            // A date that can't be read counts as a past one: "Expires: 0" is how it is often written.
            $at = strtotime($value);
            if ($at === false || $at <= time()) return 'page says no-cache';
        }
    }
    if (isset($headers['set-cookie'])) return 'page sets a cookie';
    // nginx ignores Vary when it stores: the key already has these, and the page's word about
    // anything else has to be taken here.
    foreach ($headers['vary'] ?? [] as $value) {
        foreach (explode(',', $value) as $token) {
            $token = strtolower(trim($token));
            if ($token !== '' && !in_array($token, ['accept-encoding', 'x-forwarded-proto', 'host'], true)) return 'page varies by ' . substr($token, 0, 64);
        }
    }

    if (function_exists('is_user_logged_in') && is_user_logged_in()) return 'logged in';
    $error = error_get_last();
    if ($error !== null && ($error['type'] & (E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR)) !== 0) return 'PHP error';

    $state = wpl7_cache_state();
    if ($state['geolocate']) return 'WooCommerce Geolocate';
    if ($state['post_type'] !== '' && in_array($state['post_type'], wpl7_cache_settings()['skip_post_types'], true)) return 'post type ' . $state['post_type'];
    // A file someone tried too early, such as a verification file: uploaded over SFTP it is live at once.
    if ($status === 404 && preg_match('/\.[A-Za-z0-9]{1,10}$/', wpl7_cache_request_path()) === 1) return 'missing file';
    if ($status === 200 && wpl7_cache_other_spelling($state['own_path'])) return 'another spelling of this address';
    $unknown = wpl7_cache_unknown_request_header();
    if ($unknown !== null) return 'request header ' . substr($unknown, 0, 64);
    if (wpl7_cache_htaccess_limits()) return '.htaccess limits who can see this';

    // Last, as close as can be to nginx storing it. What is left is the few milliseconds until then.
    if ($state['changed'] || ($state['generation'] !== null && wpl7_cache_generation_changed($state['generation']))) return 'cleared while rendering';
    return null;
}

/** As nginx compares it: decoded, without the query. */
function wpl7_cache_request_path(): string {
    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $end = strpos($uri, '?');
    return rawurldecode($end === false ? $uri : substr($uri, 0, $end));
}

/**
 * WordPress finds a page by its slug however the address is spelled: /Members/, /members./ and
 * /mem!bers/ all show /members/. A rule for that page wouldn't match them, and a stored copy of each
 * would only be junk. What differs in more than spelling (a page number, an endpoint) stays a page.
 */
function wpl7_cache_other_spelling(string $own_path): bool {
    if ($own_path === '' || !function_exists('sanitize_title')) return false;
    $asked = trim(wpl7_cache_request_path(), '/');
    $own = trim(rawurldecode($own_path), '/');
    if ($asked === $own) return false;
    $plain = static function (string $path): string { return implode('/', array_map('sanitize_title', explode('/', $path))); };
    return $plain($asked) === $plain($own);
}

/**
 * Only a request with no header nginx doesn't know may store a page, as with cookies. PHP sees the
 * rest, as it always did, so a plugin's own header goes on working. It can't end up in what everyone
 * gets. The list here is what nginx leaves on this path: services/siteStack.ts. Cloudflare adds more
 * headers each year, for bots and for clients' certificates, and those nginx doesn't know of say nothing
 * a page draws: the ones it might are blanked there.
 */
function wpl7_cache_unknown_request_header(): ?string {
    foreach ($_SERVER as $name => $value) {
        // Empty ones are a .htaccess copying a header that wasn't sent, as WordPress's own rule does.
        if (strncmp((string) $name, 'HTTP_', 5) !== 0 || $value === '') continue;
        if (preg_match('/^HTTP_(?:HOST|CONNECTION|UPGRADE|COOKIE|USER_AGENT|ACCEPT|ACCEPT_LANGUAGE|ACCEPT_ENCODING|SEC_CH_UA_MOBILE|X_WPL7_[A-Z_]+|X_FORWARDED_(?:FOR|PROTO|HOST|PORT|SERVER)|X_REAL_IP|MOD_REWRITE|CF_[A-Z0-9_]+)$/', (string) $name) !== 1) {
            return strtolower(str_replace('_', '-', substr((string) $name, 5)));
        }
    }
    // PHP has this one under another name, and a GET has no use for it.
    return ($_SERVER['CONTENT_TYPE'] ?? '') !== '' ? 'content-type' : null;
}

/**
 * A .htaccess between the site's root and WordPress can say who may see a page. The first visitor
 * let through would then store it for everyone else. Asked here, on every page about to be stored,
 * because such a line can be added at any time, over SFTP as easily as anywhere.
 */
function wpl7_cache_htaccess_limits(): bool {
    if (!defined('ABSPATH')) return false;
    $folder = rtrim(ABSPATH, '/');
    $root = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    for ($depth = 0; $depth < 8; $depth++) {
        $text = @file_get_contents($folder . '/.htaccess', false, null, 0, 4 * 1024 * 1024);
        if (is_string($text) && wpl7_cache_htaccess_text_limits($text)) return true;
        if ($folder === $root || $folder === '' || $folder === '/' || $root === '' || strpos($folder, $root . '/') !== 0) return false;
        $folder = dirname($folder);
    }
    return false;
}

/**
 * Every page of WordPress is index.php by the time these apply, so a section for other files doesn't
 * count: a password on wp-login.php is common, and every other page is as public as it was. Nor does
 * a list that only bans someone, Deny from or Require not, because what it leaves is public anyway.
 */
function wpl7_cache_htaccess_text_limits(string $text): bool {
    $text = preg_replace('/^[ \t]*#.*$/m', '', $text);
    if (is_string($text)) {
        $text = preg_replace_callback(
            '~<(Files(?:Match)?)[ \t]+(\~[ \t]+)?("[^"\n]*"|\'[^\'\n]*\'|[^>\n]*)>(.*?)</\1[ \t]*>~is',
            static function (array $section): string {
                $regex = strcasecmp($section[1], 'FilesMatch') === 0 || $section[2] !== '';
                return wpl7_cache_section_covers_index($regex, trim($section[3], "\"' \t")) ? $section[4] : '';
            },
            $text
        );
    }
    // A file too odd for these regexes: better a page not stored than one stored for all.
    if (!is_string($text)) return true;
    $limits = '/^[ \t]*(?:Require[ \t]+(?!all\b|not\b)|Allow[ \t]+from[ \t]+(?!all\b)|Auth[A-Za-z]+[ \t]|Satisfy\b)'
        . '|%\{(?:LA-U:)?REMOTE_(?:ADDR|HOST|USER)\}'
        . '|%\{HTTP:(?:X-Forwarded-For|X-Real-IP|CF-Connecting-IP|True-Client-IP)\}'
        . '|<(?:Else)?If\b[^>\n]*["\s(]-R\s/im';
    return preg_match($limits, $text) !== 0;
}

/** One that can't be read counts as covering it, for the same reason. */
function wpl7_cache_section_covers_index(bool $regex, string $pattern): bool {
    if (!$regex) return function_exists('fnmatch') ? fnmatch($pattern, 'index.php') : true;
    $matched = @preg_match('~' . str_replace('~', '\~', $pattern) . '~', 'index.php');
    return $matched !== 0;
}

/** Not stored, and the header says why. A header is ASCII, whatever a plugin's Vary held. */
function wpl7_cache_withhold(string $reason): void {
    header_remove('X-Accel-Expires');
    $ascii = preg_replace_callback('/[^\x20-\x7e]/', static function (array $m): string { return rawurlencode($m[0]); }, $reason);
    header('X-Cache-Skipped: ' . $ascii);
}

function wpl7_cache_seconds(int $status): int {
    $settings = wpl7_cache_settings();
    $state = wpl7_cache_state();
    if ($status === 404 || $state['not_found']) return $settings['not_found_seconds'];
    $path = wpl7_cache_request_path();
    foreach ($settings['keep_paths'] as $rule) {
        if (preg_match($rule[0], $path) === 1) return $rule[1];
    }
    return $settings['keep_post_types'][$state['post_type']] ?? $settings['keep_seconds'];
}

// ---------------------------------------------------------------------------
// Knowing when to clear

/** Every change ends here. It only takes a note: the files go once, when the request is done. */
function wpl7_cache_changed(): void {
    $state = &wpl7_cache_state();
    $state['changed'] = true;
}

/**
 * A post visitors can see, or part of what every page is built from: a block theme's templates,
 * its styles and navigation, and synced patterns. None of those is viewable by itself.
 */
function wpl7_cache_post_shows($post): bool {
    if (!is_object($post) || !isset($post->post_type)) return false;
    if (in_array($post->post_type, ['wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_block'], true)) return true;
    return function_exists('is_post_type_viewable') && is_post_type_viewable($post->post_type);
}

/** Publishing, updating, unpublishing and trashing all come through here. */
function wpl7_cache_post_status($new_status, $old_status, $post = null): void {
    if (($new_status === 'publish' || $old_status === 'publish') && wpl7_cache_post_shows($post)) wpl7_cache_changed();
}

function wpl7_cache_post_saved($post_id, $post = null): void {
    if (function_exists('wp_is_post_revision') && wp_is_post_revision($post_id)) return;
    if (function_exists('wp_is_post_autosave') && wp_is_post_autosave($post_id)) return;
    if (is_object($post) && ($post->post_status ?? '') === 'publish' && wpl7_cache_post_shows($post)) wpl7_cache_changed();
}

/** WordPress before 5.5 doesn't pass the post, and the post is gone: then assume it showed. */
function wpl7_cache_post_deleted($post_id, $post = null): void {
    if ($post === null || (is_object($post) && ($post->post_status ?? '') === 'publish' && wpl7_cache_post_shows($post))) wpl7_cache_changed();
}

/** WordPress before 6.3 doesn't pass the old status; it is in the post's meta from then on too. */
function wpl7_cache_post_trashed($post_id, $previous_status = null): void {
    $status = is_string($previous_status) ? $previous_status : get_post_meta($post_id, '_wp_trash_meta_status', true);
    if ($status === 'publish' && wpl7_cache_post_shows(get_post($post_id))) wpl7_cache_changed();
}

/** Only an approved comment is on a page, so spam clears nothing. */
function wpl7_cache_comment_posted($comment_id, $approved = null): void {
    if ((string) $approved === '1') wpl7_cache_comment_approved();
}

/** What an import or WP-CLI goes through: comment_post is only for a comment a visitor sent. */
function wpl7_cache_comment_inserted($comment_id, $comment = null): void {
    if (is_object($comment) && (string) $comment->comment_approved === '1') wpl7_cache_comment_approved();
}

/**
 * An anonymous visitor can have a comment approved at once, under a name that has been approved
 * before, and could empty the cache that way over and over. So a visitor's comment clears once a
 * minute at most. One that comes in between leaves a note, and the first request after the minute
 * clears for it. A visitor who ticked "save my name" has a cookie by then, which skips the cache.
 */
function wpl7_cache_comment_approved(): void {
    if (PHP_SAPI === 'cli' || (function_exists('is_user_logged_in') && is_user_logged_in())) {
        wpl7_cache_changed();
        return;
    }
    $settings = wpl7_cache_settings();
    $last = @filemtime($settings['comment_stamp']);
    if ($last !== false && time() - $last < 60) {
        @touch($settings['comment_stamp'] . '.waiting');
        return;
    }
    @touch($settings['comment_stamp']);
    wpl7_cache_changed();
}

function wpl7_cache_comment_waiting(): void {
    $stamp = wpl7_cache_settings()['comment_stamp'];
    if (!@file_exists($stamp . '.waiting')) return;
    if (time() - (int) @filemtime($stamp) < 60) return;
    @unlink($stamp . '.waiting');
    @touch($stamp);
    wpl7_cache_changed();
}

function wpl7_cache_comment_status($new_status, $old_status): void {
    if ($new_status === 'approved' || $old_status === 'approved') wpl7_cache_changed();
}

function wpl7_cache_comment_edited($comment_id): void {
    $comment = get_comment($comment_id);
    if (is_object($comment) && (string) $comment->comment_approved === '1') wpl7_cache_changed();
}

function wpl7_cache_comment_deleted($comment_id, $comment = null): void {
    if (is_object($comment) && (string) $comment->comment_approved === '1') wpl7_cache_changed();
}

/**
 * Plugin settings pages change what pages show, and the panel can't see those. WordPress and its
 * plugins also write options all the time for reasons of their own, which is what the checks at
 * shutdown are for. The list of tasks can't change a page, and rewrites itself on most requests.
 */
function wpl7_cache_option($option): void {
    if (!is_string($option) || $option === 'cron') return;
    if (strpos($option, '_transient_') === 0 || strpos($option, '_site_transient_') === 0) return;
    $state = &wpl7_cache_state();
    $state['option_changed'] = true;
}

/**
 * Whether the options written in this request were someone saving settings. Asked at the end,
 * because an early write can come before WordPress has loaded what can tell who is asking.
 */
function wpl7_cache_someone_saved(): bool {
    if (defined('DOING_CRON') && DOING_CRON) return false;
    if (defined('WP_CLI') && WP_CLI) {
        // The panel runs "wp cron event run --due-now" every minute. WP-CLI says DOING_CRON only
        // once it runs an event, so a plugin writing an option as it loads would slip past above.
        foreach (array_slice((array) ($_SERVER['argv'] ?? []), 1) as $arg) {
            if (is_string($arg) && strpos($arg, '-') !== 0) return $arg !== 'cron';
        }
        return true;
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET' || $method === 'HEAD') return false;
    // Requests the browser sends by itself, carrying an administrator's cookies: Heartbeat every
    // minute or so, and Action Scheduler's queue runner after every wp-admin page in a store.
    if (defined('DOING_AJAX') && DOING_AJAX && in_array($_REQUEST['action'] ?? '', ['heartbeat', 'as_async_request_queue_runner'], true)) return false;
    return function_exists('wp_get_current_user') && function_exists('current_user_can') && current_user_can('manage_options');
}

function wpl7_cache_shutdown(): void {
    wpl7_cache_comment_waiting();
    $state = wpl7_cache_state();
    if ($state['changed'] || ($state['option_changed'] && wpl7_cache_someone_saved())) wpl7_cache_clear_files();
}

/**
 * Deleting a file is all a purge takes: nginx treats a missing one as a miss. Another request can
 * delete the same files at the same time and nginx can write new ones, hence the @. A link is
 * deleted like a file, never followed. Folders stay, because nginx would only make them again.
 */
function wpl7_cache_clear_files(): void {
    $folders = [wpl7_cache_settings()['dir']];
    while ($folders !== []) {
        $folder = array_pop($folders);
        $names = @scandir($folder);
        if ($names === false) continue;
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = $folder . '/' . $name;
            if (!is_link($path) && is_dir($path)) {
                $folders[] = $path;
            } else {
                @unlink($path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The button, and Site Health

function wpl7_cache_admin_bar($bar): void {
    if (!is_object($bar) || !current_user_can('manage_options')) return;
    $bar->add_node([
        'id' => 'wpl7-clear-cache',
        // Also the notice on the front of the site, where admin_notices doesn't run.
        'title' => isset($_GET['wpl7_cache_cleared']) ? 'Cache cleared' : 'Clear cache',
        'href' => wp_nonce_url(admin_url('admin-post.php?action=wpl7_clear_cache'), 'wpl7_clear_cache'),
    ]);
}

function wpl7_cache_clear_request(): void {
    if (!current_user_can('manage_options')) wp_die('You are not allowed to clear the cache.', '', ['response' => 403]);
    check_admin_referer('wpl7_clear_cache');
    wpl7_cache_clear_files();
    $back = wp_get_referer();
    wp_safe_redirect(add_query_arg('wpl7_cache_cleared', '1', $back ?: admin_url()));
    exit;
}

function wpl7_cache_admin_notice(): void {
    if (isset($_GET['wpl7_cache_cleared']) && current_user_can('manage_options')) {
        echo '<div class="notice notice-success is-dismissible"><p>Cache cleared.</p></div>';
    }
}

function wpl7_cache_removable_args($args) {
    if (is_array($args)) $args[] = 'wpl7_cache_cleared';
    return $args;
}

/** WordPress names this header itself from 7.0 on. An older one has to be told what it means. */
function wpl7_cache_health_headers($headers) {
    if (is_array($headers) && !isset($headers['x-cache-status'])) $headers['x-cache-status'] = 'wpl7_cache_health_hit';
    return $headers;
}

function wpl7_cache_health_hit($value): bool {
    return stripos((string) $value, 'hit') !== false;
}
`;

/**
 * Loaded before WordPress in the normal case, when only the array exists; a script that loads
 * this after WordPress gets the real thing. Either way it is safe to do twice.
 */
const WP_CACHE_LOADER = String.raw`
if (function_exists('add_action')) {
    if (did_action('muplugins_loaded')) wpl7_cache_boot();
    else add_action('muplugins_loaded', 'wpl7_cache_boot', 0, 0);
} else {
    $GLOBALS['wp_filter']['muplugins_loaded'][0]['wpl7_cache_boot'] = ['function' => 'wpl7_cache_boot', 'accepted_args' => 0];
}
wpl7_cache_request_start();
`;

/**
 * The file for a site. With the page cache off it is only the Redis settings: nginx stores nothing
 * and the file has nothing else to do. The panel clears the cache when it is switched back on.
 */
export function renderWpCachePhp(opts: WpCacheOptions): string {
  const lines = [...HEADER, '', FORGET_ENVIRONMENT, '', FIX_HEADERS, '', ...redisConstants()];
  if (opts.pageCache) {
    const rules = usableCacheRules(opts.rules, opts.warn);
    const keep = rules.filter((r) => r.kind === 'keep');
    const settings = {
      dir: PAGE_CACHE_DIR_IN_CONTAINER,
      comment_stamp: COMMENT_STAMP_IN_CONTAINER,
      keep_seconds: clampKeepSeconds(opts.keepSeconds),
      not_found_seconds: NOT_FOUND_SECONDS,
      skip_post_types: rules.filter((r) => r.kind === 'skip' && r.match === 'postType').map((r) => r.value),
      // `#` can't be in one of these: anything but a letter, a digit and / _ ~ - . comes out as \xHH.
      // Any case, as nginx's skip rules: WordPress serves a page under any spelling of its address.
      keep_paths: keep.filter((r) => r.match === 'path').map((r) => [`#${cachePathRegex(r.value)}#i`, r.seconds]),
      // Reversed, so the first rule for a post type is the one left standing.
      keep_post_types: Object.fromEntries(
        keep
          .filter((r) => r.match === 'postType')
          .reverse()
          .map((r) => [r.value, r.seconds]),
      ),
    };
    lines.push(
      '',
      "if (!function_exists('wpl7_cache_boot')) {",
      '',
      `function wpl7_cache_settings(): array { return ${phpLiteral(settings)}; }`,
      WP_CACHE_CODE,
      '}',
      WP_CACHE_LOADER.trimEnd(),
    );
  }
  return `${lines.join('\n')}\n`;
}
