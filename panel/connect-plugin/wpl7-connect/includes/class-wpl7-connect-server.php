<?php
defined('ABSPATH') || exit;

/**
 * The panel's way in: both transports, the Ed25519 check, the response envelope, the dispatch to
 * each action, and the activity log. docs/internal/connect-protocol.md is the contract; the pure
 * parts (canonical string, signing values, base64url, time window, limits, log summaries) are
 * static methods tests/run.php calls without WordPress.
 *
 * Every response is written here and the request ends: the REST server's own JSON encoding would
 * mangle the raw file ranges, and both transports must answer byte for byte the same. The
 * must-use loader (class-wpl7-connect-loader.php) checks the query transport's requests the same
 * way before plugins load; the two must agree.
 */
final class WPL7_Connect_Server
{
    const REST_NAMESPACE = 'wpl7-connect/v1';
    const ACTIONS = ['ping', 'info', 'snapshot', 'files', 'range', 'bundle', 'tables', 'sql', 'inventory', 'update', 'op',
        'rollback', 'cleanup', 'component', 'rest', 'commands', 'help', 'run', 'login', 'disconnect'];
    /** Actions that write no row to the activity log: the panel's reading and polling. `snapshot` writes one at `start`. */
    const UNLOGGED = ['ping', 'op', 'files', 'range', 'bundle', 'tables', 'sql'];
    /** Seconds a request's timestamp may be off the plugin's clock, either way. */
    const WINDOW = 300;
    /** How long a nonce is remembered: twice the window, so no timestamp it accepts can repeat one. */
    const NONCE_TTL = 600;
    /** Request bodies are JSON objects; anything larger is not from the panel. */
    const MAX_BODY = 1048576;
    /** Rows the activity log keeps; older ones go as rows are added. */
    const LOG_ROWS = 200;

    public static function register_routes()
    {
        // One route for every action, and every method: an unknown action or a GET must still get
        // the protocol's envelope, not the REST server's own 404.
        register_rest_route(self::REST_NAMESPACE, '/(?P<action>[^/]+)', [
            'methods' => 'GET, POST, PUT, PATCH, DELETE',
            'callback' => [__CLASS__, 'rest_transport'],
            'permission_callback' => '__return_true',
        ]);
    }

    /** The REST transport: {home}/wp-json/wpl7-connect/v1/<action>, or ?rest_route=... */
    public static function rest_transport($request)
    {
        // The route's own parameter: get_param() would let a body field called "action" win.
        $url = $request->get_url_params();
        $action = isset($url['action']) && is_string($url['action']) ? $url['action'] : '';
        self::handle($action, strtoupper($request->get_method()), (string) $request->get_body());
    }

    /** The fallback transport: a POST to {home}/?wpl7-connect=<action>, for hosts that block /wp-json/. */
    public static function query_transport()
    {
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        $action = is_string($_GET['wpl7-connect']) ? wp_unslash($_GET['wpl7-connect']) : '';
        $body = file_get_contents('php://input', false, null, 0, self::MAX_BODY + 1);
        self::handle($action, 'POST', is_string($body) ? $body : '');
    }

    public static function handle($action, $method, $body)
    {
        // Anything printed before the response, a PHP warning on a host that displays them
        // included, would corrupt it. It is caught and dropped.
        @ini_set('display_errors', '0');
        ob_start();
        $signed = false;
        $params = [];
        $after = null;
        try {
            if (!in_array($action, self::ACTIONS, true)) {
                throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'action']);
            }
            if ($method !== 'POST') {
                throw new WPL7_Connect_Error(405, 'method_not_allowed');
            }
            if (strlen($body) > self::MAX_BODY) {
                throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'body']);
            }
            // Steps 2 to 5 need nothing but options, so nothing is written for a request that is
            // not the panel's; then the tables, which the nonce goes into.
            $auth = self::verify($action, $body);
            WPL7_Connect_Plugin::ensure_tables();
            if (!self::remember_nonce($action, $auth['nonce'], time())) {
                throw new WPL7_Connect_Error(401, 'replay');
            }
            $signed = true;
            WPL7_Connect_Plugin::mark_request();
            $params = self::params($body);
            if (function_exists('wp_raise_memory_limit')) {
                wp_raise_memory_limit('admin');
            }
            $response = self::dispatch($action, $params);
            // An action that goes on after its answer (a core update) gives the answer and what is left.
            if (isset($response[0], $response[1]) && is_callable($response[1])) {
                $after = $response[1];
                $response = $response[0];
            }
        } catch (WPL7_Connect_Error $e) {
            $response = self::error_response($e);
        } catch (Throwable $e) {
            $response = self::error_response(new WPL7_Connect_Error(500, 'internal', ['detail' => self::describe($e)]));
        }
        $log_id = $signed ? self::log_request($action, $params, $response) : 0;
        self::send($response);
        if ($after !== null) {
            // The panel has its answer; the rest runs with the connection closed. Whatever it
            // throws is recorded by the action itself; nothing of it reaches the panel.
            try {
                call_user_func($after, $log_id);
            } catch (Throwable $e) {
                // Nothing to answer to any more.
            }
        }
        exit;
    }

    private static function dispatch($action, $params)
    {
        switch ($action) {
            case 'ping':
                return self::json(200, self::ping($params));
            case 'info':
                return self::json(200, WPL7_Connect_Info::report(self::deadline()));
            case 'snapshot':
                return self::json(200, WPL7_Connect_Manifest::snapshot($params, self::deadline(self::budget($params))));
            case 'files':
                return self::json(200, WPL7_Connect_Manifest::files($params, self::deadline(self::budget($params))));
            case 'range':
                return WPL7_Connect_Manifest::range($params, self::limits());
            case 'bundle':
                return self::json(200, WPL7_Connect_Manifest::bundle($params, self::limits(), self::deadline(self::budget($params))));
            case 'tables':
                return self::json(200, WPL7_Connect_Sql::tables_response());
            case 'sql':
                return self::json(200, WPL7_Connect_Sql::page($params, self::limits(), self::deadline(self::budget($params))));
            case 'inventory':
                return self::json(200, WPL7_Connect_Inventory::action($params));
            case 'update':
                return WPL7_Connect_Updates::update($params);
            case 'op':
                return self::json(200, WPL7_Connect_Updates::op($params));
            case 'rollback':
                return self::json(200, WPL7_Connect_Updates::rollback($params));
            case 'cleanup':
                return self::json(200, WPL7_Connect_Updates::cleanup($params));
            case 'component':
                return self::json(200, WPL7_Connect_Updates::component($params));
            case 'rest':
                return self::json(200, WPL7_Connect_Rest::action($params));
            case 'commands':
                return self::json(200, WPL7_Connect_Commands::list_action());
            case 'help':
                return self::json(200, WPL7_Connect_Commands::help_action($params));
            case 'run':
                return self::json(200, WPL7_Connect_Commands::run_action($params));
            case 'login':
                return self::json(200, WPL7_Connect_Login::action($params));
            case 'disconnect':
                WPL7_Connect_Plugin::forget();
                return self::json(200, ['ok' => true]);
        }
        throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'action']);
    }

    /** `budget_ms`, where an action takes it: a positive integer that shortens the request's time. */
    private static function budget($params)
    {
        if (!array_key_exists('budget_ms', $params)) {
            return null;
        }
        $budget = $params['budget_ms'];
        if (!is_int($budget) || $budget < 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'budget_ms']);
        }
        return $budget;
    }

    private static function ping($params)
    {
        global $wp_version;
        WPL7_Connect_Selfupdate::receive($params);
        return [
            'protocol' => WPL7_Connect_Plugin::PROTOCOL,
            'plugin' => WPL7_CONNECT_VERSION,
            'time' => time(),
            'limits' => self::limits(),
            'transports' => ['rest', 'query'],
            // How `range` can answer; gzip also means `sql` and `bundle` can.
            'encodings' => function_exists('gzencode') ? ['raw', 'base64', 'gzip'] : ['raw', 'base64'],
            'actions' => self::ACTIONS,
            'home' => WPL7_Connect_Plugin::utf8_display(WPL7_Connect_Plugin::home()),
            'wp' => WPL7_Connect_Plugin::utf8_display((string) $wp_version),
            'php' => PHP_VERSION,
            'commands' => WPL7_Connect_Commands::names(),
            'loader' => WPL7_Connect_Loader::ensure(),
            'fs_method' => WPL7_Connect_Info::fs_method(),
            'file_mods' => WPL7_Connect_Info::file_mods(),
            'offer_seen' => WPL7_Connect_Selfupdate::seen(),
        ];
    }

    // -- Signing ------------------------------------------------------------------------------

    /** The string the panel signs: docs/internal/connect-protocol.md, Signing. */
    public static function canonical($site, $home, $action, $timestamp, $nonce, $body)
    {
        return "WPL7-CONNECT-V1\n" . $site . "\n" . $home . "\n" . $action . "\n" . $timestamp . "\n" . $nonce . "\n"
            . hash('sha256', $body);
    }

    public static function timestamp_ok($timestamp, $now)
    {
        return abs($now - $timestamp) <= self::WINDOW;
    }

    /** base64url without padding, as the panel writes keys and signatures. */
    public static function base64url_encode($bytes)
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /**
     * Exactly $bytes bytes from their base64url form without padding, or null. Strict: only the
     * 64 characters, the one length that many bytes take, and no stray bits in the last
     * character, so one value has one spelling. Nothing malformed ever reaches sodium, which
     * throws on a wrong length.
     */
    public static function base64url_decode($text, $bytes)
    {
        $chars = (int) ceil($bytes * 4 / 3);
        if (!is_string($text) || strlen($text) !== $chars || !preg_match('/^[A-Za-z0-9_-]+$/D', $text)) {
            return null;
        }
        $raw = base64_decode(strtr($text, '-_', '+/') . str_repeat('=', (4 - $chars % 4) % 4), true);
        if (!is_string($raw) || strlen($raw) !== $bytes || self::base64url_encode($raw) !== $text) {
            return null;
        }
        return $raw;
    }

    /**
     * The home a request names, from its percent-encoded form (encodeURIComponent on the panel's
     * side; any encoding of the same text decodes to the same home). Null when it is empty, too
     * long, or holds control characters, which no home has and which would blur the canonical
     * string's lines.
     */
    public static function decode_home($value)
    {
        $home = rawurldecode((string) $value);
        if ($home === '' || strlen($home) > 2048 || preg_match('/[\x00-\x1f\x7f]/', $home)) {
            return null;
        }
        return $home;
    }

    /**
     * The five signing values, each from its header or else from its query parameter (for hosts
     * that strip custom headers), checked for form. Null when one is missing or malformed.
     * `home` comes back decoded and `sig` as the signature's 64 bytes.
     */
    public static function parse_auth($headers, $query)
    {
        $values = [];
        foreach (['site', 'home', 'ts', 'nonce', 'sig'] as $key) {
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
        $home = self::decode_home($values['home']);
        $sig = self::base64url_decode($m[1], 64);
        if ($home === null || $sig === null) {
            return null;
        }
        return ['site' => $values['site'], 'home' => $home, 'ts' => (int) $values['ts'], 'nonce' => $values['nonce'], 'sig' => $sig];
    }

    /**
     * Whether $signature (64 bytes) is the panel's over $message, by $key (32 bytes). PHP has
     * sodium from 7.2; WordPress bundles sodium_compat for older PHP and loads it itself, and is
     * asked for it here when the function is still missing. sodium throws on what it cannot take;
     * that is a signature that does not verify.
     */
    public static function verify_signature($signature, $message, $key)
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
        } catch (Throwable $e) {
            return false;
        }
    }

    /**
     * Steps 2 to 5 of docs/internal/connect-protocol.md, Signing: the values, the signature, the
     * home and the time window. Reads options and writes nothing. Returns the signing values; the
     * caller remembers the nonce.
     */
    private static function verify($action, $body)
    {
        $key = WPL7_Connect_Plugin::key_bytes();
        $connection = WPL7_Connect_Plugin::connection_id();
        if ($key === null || $connection < 1) {
            throw new WPL7_Connect_Error(401, 'unauthorized');
        }
        $auth = self::parse_auth(self::request_values('header'), self::request_values('query'));
        if ($auth === null || $auth['site'] !== (string) $connection) {
            throw new WPL7_Connect_Error(401, 'unauthorized');
        }
        $canonical = self::canonical($auth['site'], $auth['home'], $action, $auth['ts'], $auth['nonce'], $body);
        if (!self::verify_signature($auth['sig'], $canonical, $key)) {
            throw new WPL7_Connect_Error(401, 'unauthorized');
        }
        // Only a request the panel signed gets this far, so only the panel learns the new address.
        $home = WPL7_Connect_Plugin::home();
        if ($auth['home'] !== $home) {
            throw new WPL7_Connect_Error(409, 'home_changed', ['home' => WPL7_Connect_Plugin::utf8_display($home)]);
        }
        // Checked after the signature, so only the panel learns the plugin's clock from it; the
        // panel corrects its offset by `time` and tries once more.
        $now = time();
        if (!self::timestamp_ok($auth['ts'], $now)) {
            throw new WPL7_Connect_Error(401, 'stale', ['time' => $now]);
        }
        return $auth;
    }

    /** The signing values as this request carries them, from its headers or its query string. */
    private static function request_values($where)
    {
        $names = [
            'site' => ['HTTP_X_WPL7_SITE', '_site'],
            'home' => ['HTTP_X_WPL7_HOME', '_home'],
            'ts' => ['HTTP_X_WPL7_TIMESTAMP', '_ts'],
            'nonce' => ['HTTP_X_WPL7_NONCE', '_nonce'],
            'sig' => ['HTTP_X_WPL7_SIGNATURE', '_sig'],
        ];
        $out = [];
        foreach ($names as $key => $pair) {
            $source = $where === 'header' ? $_SERVER : $_GET;
            $name = $where === 'header' ? $pair[0] : $pair[1];
            if (isset($source[$name]) && is_string($source[$name])) {
                $out[$key] = wp_unslash($source[$name]);
            }
        }
        return $out;
    }

    /**
     * False when the nonce was seen before. The primary key makes the check and the insert one
     * step. A request the must-use loader checked before plugins loaded has its nonce recorded
     * already, and the loader says so for that one action and nonce.
     */
    private static function remember_nonce($action, $nonce, $now)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('nonces');
        $wpdb->query($wpdb->prepare("DELETE FROM `$table` WHERE `seen_at` < %d", $now - self::NONCE_TTL));
        $checked = isset($GLOBALS['wpl7_connect_verified']) ? $GLOBALS['wpl7_connect_verified'] : null;
        if (is_array($checked) && isset($checked['action'], $checked['nonce'])
            && $checked['action'] === $action && $checked['nonce'] === $nonce) {
            unset($GLOBALS['wpl7_connect_verified']);
            return true;
        }
        $inserted = $wpdb->query($wpdb->prepare("INSERT IGNORE INTO `$table` (`nonce`, `seen_at`) VALUES (%s, %d)", $nonce, $now));
        if ($inserted === false) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The nonce table cannot be written.']);
        }
        return (int) $inserted === 1;
    }

    /** The body as a JSON object. Never anything but JSON: nothing from a request is unserialized. */
    private static function params($body)
    {
        if (trim($body) === '') {
            return [];
        }
        $params = json_decode($body, true);
        if (!is_array($params) || ($params !== [] && array_values($params) === $params)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'The body is not a JSON object.']);
        }
        return $params;
    }

    // -- The activity log ---------------------------------------------------------------------

    /** One row for a signed request, as the admin page shows it. Returns its id, or 0. */
    private static function log_request($action, $params, $response)
    {
        $data = isset($response['data']) ? $response['data'] : null;
        $ok = $response['status'] >= 200 && $response['status'] < 300 && self::succeeded($action, $data);
        $summary = self::summary($action, $params, $data, $ok);
        return $summary === null ? 0 : self::log($action, $summary, $ok);
    }

    /** Whether an answered action did what was asked: some answer 200 with a failure inside. */
    private static function succeeded($action, $data)
    {
        if (!is_array($data)) {
            return true;
        }
        switch ($action) {
            case 'update':
                return !isset($data['result']['ok']) || $data['result']['ok'] === true;
            case 'rollback':
                foreach (isset($data['items']) && is_array($data['items']) ? $data['items'] : [] as $item) {
                    if (empty($item['ok'])) {
                        return false;
                    }
                }
                return true;
            case 'run':
                return isset($data['exit_code']) && $data['exit_code'] === 0;
            case 'rest':
                return isset($data['status']) && $data['status'] < 400;
        }
        return !isset($data['ok']) || $data['ok'] === true;
    }

    /**
     * What a log row says about a request: the action and what it acted on, at most 255
     * characters. Built from the parameters' names, slugs and route path only, never from a body,
     * a query string, stdin or a URL. Null for the actions that write no row.
     */
    public static function summary($action, $params, $data, $ok)
    {
        if (in_array($action, self::UNLOGGED, true)) {
            return null;
        }
        $name = function ($key) use ($params) {
            return isset($params[$key]) && is_string($params[$key]) ? self::word($params[$key]) : '';
        };
        switch ($action) {
            case 'snapshot':
                if ($name('op') !== 'start') {
                    return null;
                }
                $text = $ok ? 'Backup started' : 'Could not start a backup';
                break;
            case 'info':
                $text = $ok ? 'Sent the site report' : 'Could not send the site report';
                break;
            case 'inventory':
                $check = !array_key_exists('check', $params) || $params['check'] === true;
                $text = $ok ? ($check ? 'Checked plugins, themes and WordPress for updates' : 'Listed plugins, themes and WordPress')
                    : 'Could not list plugins, themes and WordPress';
                break;
            case 'update':
                $text = self::update_summary($params, $data, $ok);
                break;
            case 'rollback':
                $items = [];
                foreach (isset($params['items']) && is_array($params['items']) ? $params['items'] : [] as $item) {
                    if (is_array($item) && isset($item['kind'], $item['slug']) && is_string($item['kind']) && is_string($item['slug'])) {
                        $items[] = self::word($item['kind']) . ' ' . self::word($item['slug']);
                    }
                }
                $text = ($ok ? 'Rolled back ' : 'Could not roll back ') . ($items ? implode(', ', $items) : 'nothing');
                break;
            case 'cleanup':
                $text = $ok ? 'Removed rollback copies' : 'Could not remove rollback copies';
                break;
            case 'component':
                $verbs = ['activate' => 'Activated', 'deactivate' => 'Deactivated', 'delete' => 'Deleted', 'install' => 'Installed'];
                $verb = $name('action');
                $what = trim($name('kind') . ' ' . $name('slug'));
                $text = isset($verbs[$verb]) ? ($ok ? $verbs[$verb] . ' ' . $what : 'Could not ' . $verb . ' ' . $what) : 'Change ' . $what;
                break;
            case 'rest':
                $route = isset($params['route']) && is_string($params['route']) ? $params['route'] : '';
                $cut = strcspn($route, '?#');
                $text = 'REST ' . $name('method') . ' ' . self::word(substr($route, 0, $cut));
                break;
            case 'commands':
                $text = 'Listed commands';
                break;
            case 'help':
                $words = self::command_words(isset($params['words']) ? $params['words'] : []);
                $text = $words === '' ? 'Help' : 'Help: ' . $words;
                break;
            case 'run':
                $text = 'Command: ' . self::command_words(isset($params['args']) ? $params['args'] : []);
                break;
            case 'login':
                $user = is_array($data) && isset($data['user']) && is_string($data['user']) ? self::word($data['user']) : '';
                $text = $ok ? 'Login link for ' . $user : 'Could not make a login link';
                break;
            case 'disconnect':
                $text = 'Disconnected';
                break;
            default:
                $text = $action;
        }
        return WPL7_Connect_Plugin::cut(trim(preg_replace('/\s+/', ' ', $text)), 255);
    }

    private static function update_summary($params, $data, $ok)
    {
        $kind = isset($params['kind']) && is_string($params['kind']) ? $params['kind'] : '';
        $result = is_array($data) && isset($data['result']) && is_array($data['result']) ? $data['result'] : null;
        $versions = '';
        if ($result !== null && isset($result['from'], $result['to']) && is_string($result['from']) && is_string($result['to'])) {
            $versions = ' ' . self::word($result['from']) . ' → ' . self::word($result['to']);
        }
        if ($kind === 'core') {
            $version = isset($params['version']) && is_string($params['version']) ? self::word($params['version']) : '';
            if (is_array($data) && isset($data['state']) && $data['state'] === 'running') {
                return 'Updating WordPress to ' . $version;
            }
            return $ok ? 'Updated WordPress' . ($versions !== '' ? $versions : ' to ' . $version) : 'Could not update WordPress to ' . $version;
        }
        if ($kind === 'db') {
            return $ok ? 'Updated the database' . $versions : 'Could not update the database';
        }
        $what = self::word($kind) . ' ' . (isset($params['slug']) && is_string($params['slug']) ? self::word($params['slug']) : '');
        return $ok ? 'Updated ' . $what . $versions : 'Could not update ' . $what;
    }

    /** A name for the log: displayable, one line, short. */
    private static function word($text)
    {
        return WPL7_Connect_Plugin::cut(preg_replace('/[\x00-\x1f\x7f]+/', ' ', (string) $text), 120);
    }

    /** The command's words: the leading arguments that look like command names, at most four. */
    private static function command_words($args)
    {
        $words = [];
        foreach (is_array($args) ? array_values($args) : [] as $arg) {
            if (!is_string($arg) || !preg_match('/^[a-z][a-z0-9-]{0,39}$/D', $arg) || count($words) >= 4) {
                break;
            }
            $words[] = $arg;
        }
        return implode(' ', $words);
    }

    /** Adds a row, and drops what is older than the last LOG_ROWS. Returns its id, or 0. */
    public static function log($action, $summary, $ok)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('log');
        $done = $wpdb->insert($table, [
            'at' => time(),
            'action' => substr((string) $action, 0, 32),
            'summary' => WPL7_Connect_Plugin::cut($summary, 255),
            'ok' => $ok ? 1 : 0,
        ], ['%d', '%s', '%s', '%d']);
        if (!$done) {
            return 0;
        }
        $id = (int) $wpdb->insert_id;
        if ($id > self::LOG_ROWS) {
            $wpdb->query($wpdb->prepare("DELETE FROM `$table` WHERE `id` <= %d", $id - self::LOG_ROWS));
        }
        return $id;
    }

    /** Changes a row once an action that went on after its answer is done. */
    public static function log_update($id, $summary, $ok)
    {
        global $wpdb;
        if ($id > 0) {
            $wpdb->update(WPL7_Connect_Plugin::table('log'), ['summary' => WPL7_Connect_Plugin::cut($summary, 255), 'ok' => $ok ? 1 : 0],
                ['id' => (int) $id], ['%s', '%d'], ['%d']);
        }
    }

    /** The last rows, newest first, for the admin page. */
    public static function recent($count)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('log');
        $rows = $wpdb->get_results($wpdb->prepare("SELECT `at`, `action`, `summary`, `ok` FROM `$table` ORDER BY `id` DESC LIMIT %d", $count), ARRAY_A);
        return is_array($rows) ? $rows : [];
    }

    // -- Limits -------------------------------------------------------------------------------

    public static function limits()
    {
        $memory = function_exists('wp_convert_hr_to_bytes') ? wp_convert_hr_to_bytes((string) ini_get('memory_limit')) : -1;
        return self::limits_for((int) ini_get('max_execution_time'), $memory);
    }

    /**
     * What one request may do on this host. Time: half of max_execution_time, at most 10 s, so a
     * request ends well before PHP would kill it. Bytes: a page of data is held two or three times
     * over while it is encoded, so it stays at a twelfth of memory_limit, at most 8 MiB. A row is
     * held about three times as it becomes SQL: at most an eighth of memory_limit, 15 MiB at most.
     */
    public static function limits_for($max_execution_time, $memory_limit)
    {
        $ms = 10000;
        if ($max_execution_time > 0) {
            $ms = min($ms, (int) floor($max_execution_time * 1000 / 2));
        }
        $bytes = 8 * 1048576;
        $row = 15 * 1048576;
        if ($memory_limit > 0) {
            $bytes = min($bytes, max(262144, (int) floor($memory_limit / 12)));
            $row = min($row, max(1048576, (int) floor($memory_limit / 8)));
        }
        return ['max_ms' => $ms, 'max_bytes' => $bytes, 'max_row_bytes' => $row];
    }

    /** When this request must stop working, counted from its start, WordPress's own loading included. */
    public static function deadline($budget_ms = null)
    {
        $limits = self::limits();
        $ms = $limits['max_ms'];
        if ($budget_ms !== null && $budget_ms > 0) {
            $ms = min($ms, $budget_ms);
        }
        return self::request_start() + $ms / 1000;
    }

    public static function request_start()
    {
        return isset($_SERVER['REQUEST_TIME_FLOAT']) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime(true);
    }

    /**
     * For work that takes as long as it takes (updates): the panel hanging up does not stop it,
     * and neither does max_execution_time, where the host allows raising it.
     */
    public static function long_request($seconds = 0)
    {
        ignore_user_abort(true);
        // A host may disable set_time_limit(); on PHP 8 calling it then is a fatal error.
        if (function_exists('set_time_limit')) {
            return @set_time_limit($seconds) !== false;
        }
        return false;
    }

    // -- Responses ----------------------------------------------------------------------------

    public static function json($status, $data, $headers = [])
    {
        $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            $status = 500;
            $data = ['error' => ['code' => 'internal', 'detail' => 'JSON: ' . json_last_error_msg()]];
            $body = json_encode($data);
        }
        $headers['Content-Type'] = 'application/json; charset=utf-8';
        return ['status' => $status, 'headers' => $headers, 'body' => $body, 'data' => $data];
    }

    public static function raw($bytes, $headers)
    {
        $headers['Content-Type'] = 'application/octet-stream';
        return ['status' => 200, 'headers' => $headers, 'body' => $bytes];
    }

    private static function error_response(WPL7_Connect_Error $e)
    {
        $headers = $e->status === 405 ? ['Allow' => 'POST'] : [];
        return self::json($e->status, ['error' => array_merge(['code' => $e->error_code], $e->fields)], $headers);
    }

    /** An unexpected failure, in words the panel can log. Never with a secret: nothing here has one. */
    public static function describe($e)
    {
        return WPL7_Connect_Plugin::cut(get_class($e) . ': ' . $e->getMessage(), 2000);
    }

    private static function send($response)
    {
        while (ob_get_level() > 0) {
            if (!@ob_end_clean()) {
                break;
            }
        }
        if (headers_sent()) {
            echo $response['body'];
            return;
        }
        // PHP's own compression would make Content-Length wrong, and a range must arrive exactly.
        if (ini_get('zlib.output_compression')) {
            @ini_set('zlib.output_compression', '0');
        }
        http_response_code($response['status']);
        header('X-WPL7-Connect: ' . WPL7_Connect_Plugin::PROTOCOL);
        header('Cache-Control: no-store, no-transform');
        header('X-Content-Type-Options: nosniff');
        header('X-Robots-Tag: noindex, nofollow');
        foreach ($response['headers'] as $name => $value) {
            header($name . ': ' . $value);
        }
        if (!ini_get('zlib.output_compression')) {
            header('Content-Length: ' . strlen($response['body']));
        }
        echo $response['body'];
        // The request still runs WordPress's shutdown hooks, and whatever a plugin prints there
        // (a cache's HTML comment, a debug bar) would land after the body. The response ends
        // here; anything printed later is dropped.
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } else {
            flush();
        }
        ob_start([__CLASS__, 'discard']);
    }

    public static function discard($output)
    {
        return '';
    }
}
