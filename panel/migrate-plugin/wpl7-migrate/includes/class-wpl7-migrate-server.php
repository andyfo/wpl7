<?php
defined('ABSPATH') || exit;

/**
 * The panel's way in: both transports, the signature check, the response envelope, and the
 * dispatch to each action. docs/internal/import-protocol.md is the contract; the pure parts
 * (canonical string, signature, time window, limits) are static methods tests/run.php calls
 * without WordPress.
 *
 * Every response is written here and the request ends: the REST server's own JSON encoding would
 * mangle the raw file ranges, and both transports must answer byte for byte the same.
 */
final class WPL7_Migrate_Server
{
    const REST_NAMESPACE = 'wpl7-migrate/v1';
    const ACTIONS = ['ping', 'info', 'snapshot', 'files', 'range', 'bundle', 'tables', 'sql', 'maintenance', 'finish'];
    /** Seconds a request's timestamp may be off the plugin's clock, either way. */
    const WINDOW = 300;
    /** How long a nonce is remembered: twice the window, so no timestamp it accepts can repeat one. */
    const NONCE_TTL = 600;
    /** Request bodies are small JSON objects; anything larger is not from the panel. */
    const MAX_BODY = 1048576;

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

    /** The REST transport: {home}/wp-json/wpl7-migrate/v1/<action>, or ?rest_route=... */
    public static function rest_transport($request)
    {
        // The route's own parameter: get_param() would let a body field called "action" win.
        $url = $request->get_url_params();
        $action = isset($url['action']) && is_string($url['action']) ? $url['action'] : '';
        self::handle($action, strtoupper($request->get_method()), (string) $request->get_body());
    }

    /** The fallback transport: a POST to {home}/?wpl7-migrate=<action>, for hosts that block /wp-json/. */
    public static function query_transport()
    {
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        $action = is_string($_GET['wpl7-migrate']) ? wp_unslash($_GET['wpl7-migrate']) : '';
        $body = file_get_contents('php://input', false, null, 0, self::MAX_BODY + 1);
        self::handle($action, 'POST', is_string($body) ? $body : '');
    }

    /** Whether this request is for the fallback transport, which the maintenance gate lets through. */
    public static function is_query_request()
    {
        return isset($_GET['wpl7-migrate'], $_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'POST';
    }

    public static function handle($action, $method, $body)
    {
        // Anything printed before the response, a PHP warning on a host that displays them
        // included, would corrupt it. It is caught and dropped.
        @ini_set('display_errors', '0');
        ob_start();
        try {
            if (!in_array($action, self::ACTIONS, true)) {
                throw new WPL7_Migrate_Error(404, 'not_found', ['detail' => 'action']);
            }
            if ($method !== 'POST') {
                throw new WPL7_Migrate_Error(405, 'method_not_allowed');
            }
            if (strlen($body) > self::MAX_BODY) {
                throw new WPL7_Migrate_Error(413, 'too_large', ['detail' => 'body']);
            }
            // The signature needs nothing but the token, so nothing is written for a request that
            // is not the panel's; then the tables, which the nonce goes into.
            $auth = self::verify($action, $body);
            WPL7_Migrate_Plugin::ensure_tables();
            if (!self::remember_nonce($auth['nonce'], time())) {
                throw new WPL7_Migrate_Error(401, 'replay');
            }
            $params = self::params($body);
            if (function_exists('wp_raise_memory_limit')) {
                wp_raise_memory_limit('admin');
            }
            $response = self::dispatch($action, $params);
        } catch (WPL7_Migrate_Error $e) {
            $response = self::error_response($e);
        } catch (Throwable $e) {
            $response = self::error_response(new WPL7_Migrate_Error(500, 'internal', ['detail' => self::describe($e)]));
        }
        self::send($response);
        exit;
    }

    private static function dispatch($action, $params)
    {
        switch ($action) {
            case 'ping':
                return self::json(200, self::ping());
            case 'info':
                return self::json(200, WPL7_Migrate_Info::report(self::deadline()));
            case 'snapshot':
                $budget = null;
                if (array_key_exists('budget_ms', $params)) {
                    $budget = $params['budget_ms'];
                    if (!is_int($budget) || $budget < 1) {
                        throw new WPL7_Migrate_Error(422, 'unsupported', ['detail' => 'budget_ms']);
                    }
                }
                return self::json(200, WPL7_Migrate_Manifest::snapshot($params, self::deadline($budget)));
            case 'files':
                return self::json(200, WPL7_Migrate_Manifest::files($params, self::deadline()));
            case 'range':
                return WPL7_Migrate_Manifest::range($params, self::limits());
            case 'bundle':
                return self::json(200, WPL7_Migrate_Manifest::bundle($params, self::limits(), self::deadline()));
            case 'tables':
                return self::json(200, WPL7_Migrate_Sql::tables_response());
            case 'sql':
                return self::json(200, WPL7_Migrate_Sql::page($params, self::limits(), self::deadline()));
            case 'maintenance':
                return self::json(200, WPL7_Migrate_Maintenance::action($params));
            case 'finish':
                return self::json(200, self::finish());
        }
        throw new WPL7_Migrate_Error(404, 'not_found', ['detail' => 'action']);
    }

    private static function ping()
    {
        return [
            'protocol' => WPL7_Migrate_Plugin::PROTOCOL,
            'plugin' => WPL7_MIGRATE_VERSION,
            'time' => time(),
            'limits' => self::limits(),
            'transports' => ['rest', 'query'],
            // How `range` can answer; gzip also means `sql` and `bundle` can.
            'encodings' => function_exists('gzencode') ? ['raw', 'base64', 'gzip'] : ['raw', 'base64'],
            'actions' => self::ACTIONS,
        ];
    }

    /**
     * The panel let go of this site: forget the connection, the panel's address included, lift
     * maintenance, and switch the plugin off. Its tables stay until the plugin is deleted
     * (uninstall.php); the file list in them is emptied now, as nothing will read it again.
     */
    private static function finish()
    {
        global $wpdb;
        WPL7_Migrate_Plugin::disconnect();
        delete_option(WPL7_Migrate_Plugin::OPT_PANEL);
        delete_option(WPL7_Migrate_Plugin::OPT_SNAPSHOT);
        delete_option(WPL7_Migrate_Plugin::OPT_FACTS);
        $wpdb->query('TRUNCATE TABLE `' . WPL7_Migrate_Plugin::table('files') . '`');
        if (!function_exists('deactivate_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        deactivate_plugins(plugin_basename(WPL7_MIGRATE_FILE));
        return ['ok' => true];
    }

    // -- Signing ------------------------------------------------------------------------------

    /** The string both sides sign: docs/internal/import-protocol.md, Signing. */
    public static function canonical($import_id, $action, $timestamp, $nonce, $body)
    {
        return "WPL7-MIGRATE-V1\n" . $import_id . "\n" . $action . "\n" . $timestamp . "\n" . $nonce . "\n"
            . hash('sha256', $body);
    }

    /** Lowercase hex HMAC-SHA256 of the canonical string, keyed by the token's UTF-8 bytes. */
    public static function sign($token, $canonical)
    {
        return hash_hmac('sha256', $canonical, $token);
    }

    public static function timestamp_ok($timestamp, $now)
    {
        return abs($now - $timestamp) <= self::WINDOW;
    }

    /**
     * The four signing values, each from its header or else from its query parameter (for hosts
     * that strip custom headers). Null when one is missing or malformed.
     */
    public static function parse_auth($headers, $query)
    {
        $values = [];
        foreach (['id', 'ts', 'nonce', 'sig'] as $key) {
            if (isset($headers[$key]) && is_string($headers[$key]) && $headers[$key] !== '') {
                $values[$key] = trim($headers[$key]);
            } elseif (isset($query[$key]) && is_string($query[$key])) {
                $values[$key] = trim($query[$key]);
            } else {
                return null;
            }
        }
        if (!preg_match('/^[1-9][0-9]{0,18}$/D', $values['id'])
            || !preg_match('/^(?:0|[1-9][0-9]{0,11})$/D', $values['ts'])
            || !preg_match('/^[0-9a-f]{32}$/D', $values['nonce'])
            || !preg_match('/^v1=([0-9a-f]{64})$/D', $values['sig'], $m)) {
            return null;
        }
        return ['id' => $values['id'], 'ts' => (int) $values['ts'], 'nonce' => $values['nonce'], 'sig' => $m[1]];
    }

    /**
     * Whether the panel signed this request: the maintenance gate's question on init. Not the time
     * window, so a panel whose clock is off still gets its `stale` answer, and not the nonce: the
     * request is checked fully once it reaches the plugin's route.
     */
    public static function signed($action, $body)
    {
        try {
            self::check_signature($action, $body);
            return true;
        } catch (WPL7_Migrate_Error $e) {
            return false;
        }
    }

    /**
     * The signature and the time window (docs/internal/import-protocol.md, Signing). Reads options
     * and writes nothing. Returns the signing values; the caller remembers the nonce.
     */
    private static function verify($action, $body)
    {
        $auth = self::check_signature($action, $body);
        // Checked after the signature, so only the panel learns the plugin's clock from it; the
        // panel corrects its offset by `time` and tries once more.
        $now = time();
        if (!self::timestamp_ok($auth['ts'], $now)) {
            throw new WPL7_Migrate_Error(401, 'stale', ['time' => $now]);
        }
        return $auth;
    }

    private static function check_signature($action, $body)
    {
        $token = WPL7_Migrate_Plugin::token();
        $import = WPL7_Migrate_Plugin::import_id();
        if ($token === '' || $import < 1) {
            throw new WPL7_Migrate_Error(401, 'unauthorized');
        }
        $headers = [];
        $query = [];
        $names = [
            'id' => ['HTTP_X_WPL7_IMPORT_ID', '_id'],
            'ts' => ['HTTP_X_WPL7_TIMESTAMP', '_ts'],
            'nonce' => ['HTTP_X_WPL7_NONCE', '_nonce'],
            'sig' => ['HTTP_X_WPL7_SIGNATURE', '_sig'],
        ];
        foreach ($names as $key => $pair) {
            if (isset($_SERVER[$pair[0]]) && is_string($_SERVER[$pair[0]])) {
                $headers[$key] = wp_unslash($_SERVER[$pair[0]]);
            }
            if (isset($_GET[$pair[1]]) && is_string($_GET[$pair[1]])) {
                $query[$key] = wp_unslash($_GET[$pair[1]]);
            }
        }
        $auth = self::parse_auth($headers, $query);
        if ($auth === null || $auth['id'] !== (string) $import) {
            throw new WPL7_Migrate_Error(401, 'unauthorized');
        }
        $expected = self::sign($token, self::canonical($auth['id'], $action, $auth['ts'], $auth['nonce'], $body));
        if (!hash_equals($expected, $auth['sig'])) {
            throw new WPL7_Migrate_Error(401, 'unauthorized');
        }
        return $auth;
    }

    /** False when the nonce was seen before. The primary key makes the check and the insert one step. */
    private static function remember_nonce($nonce, $now)
    {
        global $wpdb;
        $table = WPL7_Migrate_Plugin::table('nonces');
        $wpdb->query($wpdb->prepare("DELETE FROM `$table` WHERE `seen_at` < %d", $now - self::NONCE_TTL));
        $inserted = $wpdb->query($wpdb->prepare("INSERT IGNORE INTO `$table` (`nonce`, `seen_at`) VALUES (%s, %d)", $nonce, $now));
        if ($inserted === false) {
            throw new WPL7_Migrate_Error(500, 'internal', ['detail' => 'The nonce table cannot be written.']);
        }
        return (int) $inserted === 1;
    }

    private static function params($body)
    {
        if (trim($body) === '') {
            return [];
        }
        $params = json_decode($body, true);
        if (!is_array($params) || ($params !== [] && array_values($params) === $params)) {
            throw new WPL7_Migrate_Error(422, 'unsupported', ['detail' => 'The body is not a JSON object.']);
        }
        return $params;
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
        $start = isset($_SERVER['REQUEST_TIME_FLOAT']) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime(true);
        return $start + $ms / 1000;
    }

    // -- Responses ----------------------------------------------------------------------------

    public static function json($status, $data, $headers = [])
    {
        $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            $status = 500;
            $body = json_encode(['error' => ['code' => 'internal', 'detail' => 'JSON: ' . json_last_error_msg()]]);
        }
        $headers['Content-Type'] = 'application/json; charset=utf-8';
        return ['status' => $status, 'headers' => $headers, 'body' => $body];
    }

    public static function raw($bytes, $headers)
    {
        $headers['Content-Type'] = 'application/octet-stream';
        return ['status' => 200, 'headers' => $headers, 'body' => $bytes];
    }

    private static function error_response(WPL7_Migrate_Error $e)
    {
        $headers = $e->status === 405 ? ['Allow' => 'POST'] : [];
        return self::json($e->status, ['error' => array_merge(['code' => $e->error_code], $e->fields)], $headers);
    }

    /** An unexpected failure, in words the panel can log. Never with the token: nothing here has it. */
    private static function describe($e)
    {
        return get_class($e) . ': ' . $e->getMessage();
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
        header('X-WPL7-Protocol: ' . WPL7_Migrate_Plugin::PROTOCOL);
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
