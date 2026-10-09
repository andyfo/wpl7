<?php
defined('ABSPATH') || exit;

/**
 * The must-use loader (docs/internal/connect-protocol.md, The must-use loader):
 * wp-content/mu-plugins/wpl7-connect-loader.php, written from the template below. It lets the
 * panel reach a site that a plugin or theme update broke: WordPress loads must-use plugins before
 * any other, and a request the panel signed may then leave the broken plugins, or the theme, out
 * of itself.
 *
 * The file is self-contained: it loads nothing of this plugin, so a broken copy of the plugin
 * cannot break it. Its checks are WPL7_Connect_Server's, written again; tests/run.php runs the
 * same vectors through both. It carries the plugin's version, and the plugin writes it again
 * when its own differs: at activation, on admin pages, and when the panel asks for the report or
 * pings.
 */
final class WPL7_Connect_Loader
{
    const FILE = 'wpl7-connect-loader.php';
    /** Every copy says this, so only the plugin's own file is ever removed. */
    const MARK = 'Plugin Name: WPL7 Connect loader';

    public static function path()
    {
        return untrailingslashit(WPMU_PLUGIN_DIR) . '/' . self::FILE;
    }

    /** The loader for this version of the plugin. */
    public static function source()
    {
        $actions = "array('" . implode("', '", WPL7_Connect_Server::ACTIONS) . "')";
        return strtr(self::TEMPLATE, ['{{VERSION}}' => WPL7_CONNECT_VERSION, '{{ACTIONS}}' => $actions]);
    }

    /** Whether this version's loader is in place. */
    public static function installed()
    {
        return @is_file(self::path()) && @file_get_contents(self::path()) === self::source();
    }

    /**
     * Writes the loader where it is missing or another version's, where wp-content/mu-plugins can
     * be written (it is created when missing). Whether this version's loader is in place now.
     */
    public static function ensure()
    {
        $source = self::source();
        $path = self::path();
        if (@is_file($path) && @file_get_contents($path) === $source) {
            return true;
        }
        $dir = dirname($path);
        if (!@is_dir($dir) && !wp_mkdir_p($dir)) {
            return false;
        }
        if (!@is_writable($dir) || (@file_exists($path) && !@is_writable($path))) {
            return false;
        }
        // Written beside it and renamed into place, so a request never loads half a file. The
        // temporary name does not end in .php: WordPress loads every .php file in the folder.
        $temp = $dir . '/.wpl7-connect-loader-' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($temp, $source) !== strlen($source)) {
            @unlink($temp);
            return false;
        }
        @chmod($temp, defined('FS_CHMOD_FILE') ? FS_CHMOD_FILE : ((@fileperms(ABSPATH . 'index.php') & 0777) | 0644));
        if (!@rename($temp, $path)) {
            @unlink($temp);
            return false;
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($path, true);
        }
        return true;
    }

    /** Removes the loader, if the file there is this plugin's. */
    public static function remove()
    {
        $path = self::path();
        if (!@is_file($path)) {
            return;
        }
        $head = @file_get_contents($path, false, null, 0, 1024);
        if (is_string($head) && strpos($head, self::MARK) !== false) {
            @unlink($path);
        }
    }

    /**
     * The loader's source. {{VERSION}} and {{ACTIONS}} are filled in by source(). It must keep
     * parsing on every PHP WordPress runs on, and do nothing on any request but a POST to
     * ?wpl7-connect=<action>.
     */
    const TEMPLATE = <<<'WPL7_CONNECT_LOADER'
<?php
/**
 * Plugin Name: WPL7 Connect loader
 * Description: Lets the WPL7 panel reach this site when an update broke a plugin or the theme. WPL7 Connect writes this file, and writes it again when it changes; edits are lost.
 * Version: {{VERSION}}
 * Author: WPL7
 * License: AGPL-3.0-only
 *
 * The must-use part of WPL7 Connect (docs/internal/connect-protocol.md, section 10, in the WPL7
 * repository). It acts on a POST to ?wpl7-connect=<action> only. Such a request is checked here
 * as WPL7 Connect checks it, before any plugin loads, and its nonce recorded. A request the panel
 * signed may then leave plugins ("skip_plugins") or the theme ("skip_theme") out of this one
 * request, so that WPL7 Connect can answer while an update has broken one of them; WPL7 Connect
 * itself is never left out. Every other request, and one that fails any check, is left alone.
 *
 * It loads nothing of WPL7 Connect, so a broken copy of the plugin cannot break it.
 */

defined('ABSPATH') || exit;

/** The actions WPL7 Connect answers. */
function wpl7_connect_loader_actions()
{
    return {{ACTIONS}};
}

/** Exactly $bytes bytes from base64url without padding, strictly, or null. As WPL7_Connect_Server::base64url_decode(). */
function wpl7_connect_loader_base64url_decode($text, $bytes)
{
    $chars = (int) ceil($bytes * 4 / 3);
    if (!is_string($text) || strlen($text) !== $chars || !preg_match('/^[A-Za-z0-9_-]+$/D', $text)) {
        return null;
    }
    $raw = base64_decode(strtr($text, '-_', '+/') . str_repeat('=', (4 - $chars % 4) % 4), true);
    if (!is_string($raw) || strlen($raw) !== $bytes || rtrim(strtr(base64_encode($raw), '+/', '-_'), '=') !== $text) {
        return null;
    }
    return $raw;
}

/** The home a request names, decoded, or null. As WPL7_Connect_Server::decode_home(). */
function wpl7_connect_loader_decode_home($value)
{
    $home = rawurldecode((string) $value);
    if ($home === '' || strlen($home) > 2048 || preg_match('/[\x00-\x1f\x7f]/', $home)) {
        return null;
    }
    return $home;
}

/** The five signing values, checked for form, or null. As WPL7_Connect_Server::parse_auth(). */
function wpl7_connect_loader_parse_auth($headers, $query)
{
    $values = array();
    foreach (array('site', 'home', 'ts', 'nonce', 'sig') as $key) {
        if (isset($headers[$key]) && is_string($headers[$key]) && $headers[$key] !== '') {
            $values[$key] = trim($headers[$key]);
        } elseif (isset($query[$key]) && is_string($query[$key])) {
            $values[$key] = trim($query[$key]);
        } else {
            return null;
        }
    }
    if (!preg_match('/^[1-9][0-9]{0,18}$/D', $values['site'])
        || !preg_match('/^(?:0|[1-9][0-9]{0,11})$/D', $values['ts'])
        || !preg_match('/^[0-9a-f]{32}$/D', $values['nonce'])
        || !preg_match('/^ed25519=([A-Za-z0-9_-]{86})$/D', $values['sig'], $m)) {
        return null;
    }
    $home = wpl7_connect_loader_decode_home($values['home']);
    $sig = wpl7_connect_loader_base64url_decode($m[1], 64);
    if ($home === null || $sig === null) {
        return null;
    }
    return array('site' => $values['site'], 'home' => $home, 'ts' => (int) $values['ts'], 'nonce' => $values['nonce'], 'sig' => $sig);
}

/** The string the panel signs. As WPL7_Connect_Server::canonical(). */
function wpl7_connect_loader_canonical($site, $home, $action, $timestamp, $nonce, $body)
{
    return "WPL7-CONNECT-V1\n" . $site . "\n" . $home . "\n" . $action . "\n" . $timestamp . "\n" . $nonce . "\n"
        . hash('sha256', $body);
}

function wpl7_connect_loader_timestamp_ok($timestamp, $now)
{
    return abs($now - $timestamp) <= 300;
}

/** Whether the panel's key signed $message. As WPL7_Connect_Server::verify_signature(). */
function wpl7_connect_loader_verify($signature, $message, $key)
{
    if (!function_exists('sodium_crypto_sign_verify_detached') && defined('WPINC')
        && is_file(ABSPATH . WPINC . '/sodium_compat/autoload.php')) {
        require_once ABSPATH . WPINC . '/sodium_compat/autoload.php';
    }
    if (!function_exists('sodium_crypto_sign_verify_detached') || !is_string($signature) || !is_string($key)
        || strlen($signature) !== 64 || strlen($key) !== 32) {
        return false;
    }
    try {
        return sodium_crypto_sign_verify_detached($signature, (string) $message, $key) === true;
    } catch (Exception $e) {
        return false;
    } catch (Throwable $e) {
        return false;
    }
}

/** The site's home as the protocol binds it. As WPL7_Connect_Plugin::home(). */
function wpl7_connect_loader_home()
{
    $scheme = wp_parse_url((string) get_option('home'), PHP_URL_SCHEME);
    $scheme = is_string($scheme) && in_array(strtolower($scheme), array('http', 'https'), true) ? strtolower($scheme) : null;
    return untrailingslashit(home_url('', $scheme));
}

/** Records a nonce; false when it was seen before. The nonce table is made again when it is missing. */
function wpl7_connect_loader_remember($nonce, $now)
{
    global $wpdb;
    $table = $wpdb->prefix . 'wpl7_connect_nonces';
    $quiet = $wpdb->suppress_errors(true);
    $wpdb->query($wpdb->prepare("DELETE FROM `$table` WHERE `seen_at` < %d", $now - 600));
    $insert = $wpdb->prepare("INSERT IGNORE INTO `$table` (`nonce`, `seen_at`) VALUES (%s, %d)", $nonce, $now);
    $inserted = $wpdb->query($insert);
    if ($inserted === false) {
        $wpdb->query("CREATE TABLE IF NOT EXISTS `$table` (
            `nonce` char(32) NOT NULL,
            `seen_at` int unsigned NOT NULL,
            PRIMARY KEY (`nonce`),
            KEY `seen_at` (`seen_at`)
        ) " . $wpdb->get_charset_collate());
        $inserted = $wpdb->query($insert);
    }
    $wpdb->suppress_errors($quiet);
    return $inserted !== false && (int) $inserted === 1;
}

/**
 * Steps 1 to 7 of WPL7 Connect's check (section 3), for the query transport only. Returns the
 * action, the nonce and the body's parameters, or null when the request is not one the panel
 * signed just now. WordPress adds its slashes to the request only after plugins load, so nothing
 * here is unslashed.
 */
function wpl7_connect_loader_check()
{
    if (!isset($_GET['wpl7-connect'], $_SERVER['REQUEST_METHOD']) || $_SERVER['REQUEST_METHOD'] !== 'POST'
        || !is_string($_GET['wpl7-connect'])) {
        return null;
    }
    $action = $_GET['wpl7-connect'];
    if (!in_array($action, wpl7_connect_loader_actions(), true)) {
        return null;
    }
    $body = file_get_contents('php://input', false, null, 0, 1048577);
    if (!is_string($body) || strlen($body) > 1048576) {
        return null;
    }
    $key = wpl7_connect_loader_base64url_decode(get_option('wpl7_connect_key', ''), 32);
    $connection = (int) get_option('wpl7_connect_connection', 0);
    if ($key === null || $connection < 1) {
        return null;
    }
    $names = array(
        'site' => array('HTTP_X_WPL7_SITE', '_site'),
        'home' => array('HTTP_X_WPL7_HOME', '_home'),
        'ts' => array('HTTP_X_WPL7_TIMESTAMP', '_ts'),
        'nonce' => array('HTTP_X_WPL7_NONCE', '_nonce'),
        'sig' => array('HTTP_X_WPL7_SIGNATURE', '_sig'),
    );
    $headers = array();
    $query = array();
    foreach ($names as $name => $pair) {
        if (isset($_SERVER[$pair[0]]) && is_string($_SERVER[$pair[0]])) {
            $headers[$name] = $_SERVER[$pair[0]];
        }
        if (isset($_GET[$pair[1]]) && is_string($_GET[$pair[1]])) {
            $query[$name] = $_GET[$pair[1]];
        }
    }
    $auth = wpl7_connect_loader_parse_auth($headers, $query);
    if ($auth === null || $auth['site'] !== (string) $connection) {
        return null;
    }
    $canonical = wpl7_connect_loader_canonical($auth['site'], $auth['home'], $action, $auth['ts'], $auth['nonce'], $body);
    if (!wpl7_connect_loader_verify($auth['sig'], $canonical, $key) || $auth['home'] !== wpl7_connect_loader_home()) {
        return null;
    }
    $now = time();
    if (!wpl7_connect_loader_timestamp_ok($auth['ts'], $now) || !wpl7_connect_loader_remember($auth['nonce'], $now)) {
        return null;
    }
    $params = json_decode($body, true);
    return array('action' => $action, 'nonce' => $auth['nonce'], 'params' => is_array($params) ? $params : array());
}

/** The plugin files a request asks to leave out: strings, at most 500. */
function wpl7_connect_loader_skip_list($value)
{
    $out = array();
    foreach (is_array($value) ? $value : array() as $file) {
        if (is_string($file) && $file !== '' && strlen($file) <= 400 && count($out) < 500) {
            $out[] = $file;
        }
    }
    return $out;
}

/** $plugins without the ones in $skip; WPL7 Connect itself stays, whatever its folder is called. */
function wpl7_connect_loader_without($plugins, $skip)
{
    if (!is_array($plugins)) {
        return $plugins;
    }
    $out = array();
    foreach ($plugins as $key => $file) {
        $name = is_string($key) ? $key : $file;
        if (!is_string($name) || !in_array($name, $skip, true) || basename($name) === 'wpl7-connect.php') {
            $out[$key] = $file;
        }
    }
    return is_string(key($plugins)) ? $out : array_values($out);
}

/**
 * The active plugins as something saves them during the request: the ones left out of it, and
 * active before it, stay active. They are skipped for this one request, never deactivated.
 */
function wpl7_connect_loader_keep($value, $original, $skip)
{
    if (!is_array($value) || !is_array($original)) {
        return $value;
    }
    foreach ($original as $file) {
        if (is_string($file) && in_array($file, $skip, true) && !in_array($file, $value, true)) {
            $value[] = $file;
        }
    }
    return $value;
}

function wpl7_connect_loader_main()
{
    try {
        $checked = wpl7_connect_loader_check();
    } catch (Exception $e) {
        return;
    } catch (Throwable $e) {
        return;
    }
    if ($checked === null) {
        return;
    }
    // WPL7 Connect, reaching this request on init, takes this action and nonce as checked.
    $GLOBALS['wpl7_connect_verified'] = array('action' => $checked['action'], 'nonce' => $checked['nonce']);
    $params = $checked['params'];
    $skip = wpl7_connect_loader_skip_list(isset($params['skip_plugins']) ? $params['skip_plugins'] : null);
    if ($skip) {
        $original = get_option('active_plugins', array());
        $filter = function ($plugins) use ($skip) {
            return wpl7_connect_loader_without($plugins, $skip);
        };
        add_filter('option_active_plugins', $filter, PHP_INT_MAX);
        add_filter('site_option_active_sitewide_plugins', $filter, PHP_INT_MAX);
        $keep = function ($value) use ($original, $skip) {
            return wpl7_connect_loader_keep($value, $original, $skip);
        };
        add_filter('pre_update_option_active_plugins', $keep, PHP_INT_MAX);
    }
    if (isset($params['skip_theme']) && $params['skip_theme'] === true) {
        // A theme that does not exist: no theme's functions.php loads for this request.
        $none = function () {
            return 'wpl7-connect-no-theme';
        };
        add_filter('pre_option_template', $none, PHP_INT_MAX);
        add_filter('pre_option_stylesheet', $none, PHP_INT_MAX);
    }
}

if (!defined('WPL7_CONNECT_LOADER_TEST')) {
    wpl7_connect_loader_main();
}

WPL7_CONNECT_LOADER;
}
