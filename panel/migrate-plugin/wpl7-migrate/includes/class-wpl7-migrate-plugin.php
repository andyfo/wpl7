<?php
defined('ABSPATH') || exit;

/**
 * An error the protocol reports to the panel: an HTTP status, a code from the protocol's list and
 * the fields that go with it. Sent as { "error": { "code": ..., ...fields } }.
 */
class WPL7_Migrate_Error extends Exception
{
    public $status;
    public $error_code;
    public $fields;

    public function __construct($status, $code, $fields = [])
    {
        parent::__construct($code);
        $this->status = (int) $status;
        $this->error_code = (string) $code;
        $this->fields = $fields;
    }
}

/**
 * Bootstrap, options, state and the plugin's two tables.
 *
 * The state is what the admin page shows: unbound (no panel known), bound (a panel and a code,
 * not connected yet), connected, or disconnected (the panel let go of this site). Whether the
 * panel is pulling, or has finished, comes from the panel itself; see WPL7_Migrate_Admin.
 */
final class WPL7_Migrate_Plugin
{
    const PROTOCOL = 1;
    /** The tables' layout. Moving it makes the plugin create them again where they are older. */
    const SCHEMA = 1;

    const OPT_PANEL = 'wpl7_migrate_panel';
    const OPT_IMPORT = 'wpl7_migrate_import';
    const OPT_TOKEN = 'wpl7_migrate_token';
    const OPT_STATE = 'wpl7_migrate_state';
    /** What the panel answered to the last connect: the import's label and the panel's version. */
    const OPT_CONNECTED = 'wpl7_migrate_connected';
    /** A few facts from the last report, for the admin page. */
    const OPT_FACTS = 'wpl7_migrate_facts';
    const OPT_SNAPSHOT = 'wpl7_migrate_snapshot';
    const OPT_MAINTENANCE = 'wpl7_migrate_maintenance_until';
    const OPT_SCHEMA = 'wpl7_migrate_schema';
    const OPT_REDIRECT = 'wpl7_migrate_redirect';
    /** sha256 of the connection.php last read, so a file that could not be deleted is read once. */
    const OPT_CONSUMED = 'wpl7_migrate_consumed';

    const STATE_UNBOUND = 'unbound';
    const STATE_BOUND = 'bound';
    const STATE_CONNECTED = 'connected';
    const STATE_DISCONNECTED = 'disconnected';

    /** A connection code is the token itself: 32 random bytes, base64url without padding. */
    const TOKEN_RE = '/^[A-Za-z0-9_-]{43}$/D';

    public static function boot()
    {
        add_action('init', [__CLASS__, 'early_init'], 0);
        add_action('rest_api_init', ['WPL7_Migrate_Server', 'register_routes']);
        if (is_admin()) {
            add_action('admin_menu', ['WPL7_Migrate_Admin', 'menu']);
            add_action('admin_init', ['WPL7_Migrate_Admin', 'admin_init']);
            add_action('admin_post_wpl7_migrate_connect', ['WPL7_Migrate_Admin', 'handle_connect']);
            add_action('admin_post_wpl7_migrate_check', ['WPL7_Migrate_Admin', 'handle_check']);
        }
    }

    /**
     * On init at priority 0: after plugins have loaded, before most of them start work, and before
     * a page cache could hand back a stored page. First the fallback transport: only a POST that
     * names an action is ours; everything else, a GET with the same parameter included, is the
     * site's ordinary page. Then the maintenance gate, which costs one autoloaded option on every
     * request, nothing more.
     */
    public static function early_init()
    {
        if (isset($_GET['wpl7-migrate'], $_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'POST') {
            WPL7_Migrate_Server::query_transport();
        }
        if ((int) get_option(self::OPT_MAINTENANCE, 0) > time()) {
            WPL7_Migrate_Maintenance::gate();
        }
    }

    /** Why the plugin cannot run here, or null. */
    public static function requirements_problem()
    {
        global $wp_version;
        if (is_multisite()) {
            return __('WPL7 cannot import a multisite network.', 'wpl7-migrate');
        }
        if (self::is_windows()) {
            return __('WPL7 cannot import a site from a Windows server.', 'wpl7-migrate');
        }
        if (version_compare(PHP_VERSION, '7.0', '<')) {
            /* translators: %s: the PHP version this site runs */
            return sprintf(__('WPL7 Migrate needs PHP 7.0 or later. This site runs PHP %s.', 'wpl7-migrate'), PHP_VERSION);
        }
        if (version_compare($wp_version, '5.0', '<')) {
            /* translators: %s: the WordPress version this site runs */
            return sprintf(__('WPL7 Migrate needs WordPress 5.0 or later. This site runs %s.', 'wpl7-migrate'), $wp_version);
        }
        return null;
    }

    public static function is_windows()
    {
        return strtoupper(substr(PHP_OS, 0, 3)) === 'WIN';
    }

    public static function activate()
    {
        $problem = self::requirements_problem();
        if ($problem !== null) {
            deactivate_plugins(plugin_basename(WPL7_MIGRATE_FILE));
            wp_die(esc_html($problem), esc_html__('WPL7 Migrate', 'wpl7-migrate'), ['back_link' => true]);
        }
        self::install_tables();
        // Autoloaded and always present: a missing option would cost a query on every page view.
        add_option(self::OPT_MAINTENANCE, 0);
        if (!self::read_connection_file() && !get_option(self::OPT_STATE)) {
            update_option(self::OPT_STATE, self::token() !== '' ? self::STATE_BOUND : self::STATE_UNBOUND, false);
        }
        // The admin page connects when it opens, so taking the admin there is what makes the site
        // connect "on its own" after activation. Not from WP-CLI: nobody would see the page.
        if (!(defined('WP_CLI') && WP_CLI)) {
            update_option(self::OPT_REDIRECT, 1, false);
        }
    }

    /** Leaves the connection in place, so the import can go on after activating the plugin again. */
    public static function deactivate()
    {
        update_option(self::OPT_MAINTENANCE, 0);
        delete_option(self::OPT_REDIRECT);
        delete_transient('wpl7_migrate_status');
    }

    public static function table($name)
    {
        global $wpdb;
        return $wpdb->prefix . 'wpl7_migrate_' . $name;
    }

    /**
     * Creates both tables (docs/internal/import-protocol.md, Plugin tables). Paths are VARBINARY:
     * a file name is bytes, not text, and must come back exactly as it was read.
     */
    public static function install_tables()
    {
        global $wpdb;
        $collate = $wpdb->get_charset_collate();
        $files = self::table('files');
        $nonces = self::table('nonces');
        $wpdb->query(
            "CREATE TABLE IF NOT EXISTS `$files` (
                `id` bigint unsigned NOT NULL AUTO_INCREMENT,
                `parent` bigint unsigned NOT NULL DEFAULT 0,
                `seq` int unsigned NOT NULL DEFAULT 0,
                `type` tinyint unsigned NOT NULL,
                `path` varbinary(4096) NOT NULL,
                `real` varbinary(4096) DEFAULT NULL,
                `size` bigint unsigned NOT NULL DEFAULT 0,
                `mtime` bigint NOT NULL DEFAULT 0,
                `mode` smallint unsigned NOT NULL DEFAULT 0,
                `flags` smallint unsigned NOT NULL DEFAULT 0,
                `target` varbinary(4096) DEFAULT NULL,
                `walked` tinyint unsigned NOT NULL DEFAULT 0,
                `pos` int unsigned NOT NULL DEFAULT 0,
                PRIMARY KEY (`id`),
                KEY `walk` (`type`, `walked`, `id`),
                KEY `parent` (`parent`)
            ) $collate"
        );
        $wpdb->query(
            "CREATE TABLE IF NOT EXISTS `$nonces` (
                `nonce` char(32) NOT NULL,
                `seen_at` int unsigned NOT NULL,
                PRIMARY KEY (`nonce`),
                KEY `seen_at` (`seen_at`)
            ) $collate"
        );
        update_option(self::OPT_SCHEMA, self::SCHEMA, false);
    }

    /**
     * Creates the tables again when one is missing, or older than this plugin. For requests that
     * reach them without the activation hook having run, as after a copy or a restore. Called for
     * signed requests only, after the signature: nothing unsigned writes to the database.
     */
    public static function ensure_tables()
    {
        global $wpdb;
        $found = (array) $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->prefix . 'wpl7_migrate_') . '%'));
        if (array_diff([self::table('files'), self::table('nonces')], $found) || (int) get_option(self::OPT_SCHEMA, 0) !== self::SCHEMA) {
            self::install_tables();
        }
    }

    /**
     * Reads connection.php, which the panel writes into the zip, into options, and deletes it: the
     * token should not sit in a file. Reading it again when it could not be deleted would undo a
     * code entered by hand since, so a file is read only once.
     */
    public static function read_connection_file()
    {
        $file = dirname(WPL7_MIGRATE_FILE) . '/connection.php';
        if (!is_file($file)) {
            return false;
        }
        $hash = (string) @hash_file('sha256', $file);
        if ($hash === '' || $hash === get_option(self::OPT_CONSUMED)) {
            return false;
        }
        $data = include $file;
        @unlink($file);
        update_option(self::OPT_CONSUMED, $hash, false);
        if (!is_array($data) || !isset($data['panel'], $data['import'], $data['token'])) {
            return false;
        }
        $panel = self::panel_url($data['panel']);
        $import = (int) $data['import'];
        if ($panel === null || $import < 1 || !is_string($data['token']) || !preg_match(self::TOKEN_RE, $data['token'])) {
            return false;
        }
        self::bind($panel, $data['token'], $import);
        return true;
    }

    /** Remembers a panel and a code. The import's id comes with the file, or from the panel at connect. */
    public static function bind($panel, $token, $import = 0)
    {
        update_option(self::OPT_PANEL, $panel, false);
        update_option(self::OPT_TOKEN, $token, false);
        if ($import > 0) {
            update_option(self::OPT_IMPORT, $import, false);
        } else {
            delete_option(self::OPT_IMPORT);
        }
        update_option(self::OPT_STATE, self::STATE_BOUND, false);
        delete_option(self::OPT_CONNECTED);
        delete_transient('wpl7_migrate_status');
    }

    /** Forgets the token: from now on no request from any panel is answered. */
    public static function disconnect()
    {
        delete_option(self::OPT_TOKEN);
        delete_option(self::OPT_IMPORT);
        delete_option(self::OPT_CONNECTED);
        update_option(self::OPT_STATE, self::STATE_DISCONNECTED, false);
        update_option(self::OPT_MAINTENANCE, 0);
        delete_transient('wpl7_migrate_status');
    }

    public static function token()
    {
        $token = get_option(self::OPT_TOKEN, '');
        return is_string($token) ? $token : '';
    }

    public static function import_id()
    {
        return (int) get_option(self::OPT_IMPORT, 0);
    }

    public static function panel()
    {
        $panel = get_option(self::OPT_PANEL, '');
        return is_string($panel) ? $panel : '';
    }

    public static function state()
    {
        $state = get_option(self::OPT_STATE, '');
        $known = [self::STATE_UNBOUND, self::STATE_BOUND, self::STATE_CONNECTED, self::STATE_DISCONNECTED];
        if (in_array($state, $known, true)) {
            return $state;
        }
        return self::token() !== '' ? self::STATE_BOUND : self::STATE_UNBOUND;
    }

    /**
     * A panel's address as the plugin keeps it: http or https, a host, an optional port and path,
     * no credentials, query or fragment, no trailing slash. Null when it is not one.
     */
    public static function panel_url($url)
    {
        if (!is_string($url) || strlen($url) > 2000) {
            return null;
        }
        $parts = wp_parse_url(trim($url));
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        if (($scheme !== 'https' && $scheme !== 'http') || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }
        if (!preg_match('/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/D', $parts['host'])) {
            return null;
        }
        $out = $scheme . '://' . strtolower($parts['host']);
        if (isset($parts['port'])) {
            $out .= ':' . (int) $parts['port'];
        }
        if (isset($parts['path'])) {
            $out .= rtrim($parts['path'], '/');
        }
        return $out;
    }

    /**
     * Whether the token may travel to this panel address: always over https, and over plain http
     * only to this machine or a private network, where nobody on the way can read it. That is an
     * IP address in a loopback or private range, `localhost`, or a name that resolves to such
     * addresses only, as `host.docker.internal` does in a panel's own test. Asked again before
     * every call, since what a name resolves to can change.
     *
     * @param callable|null $resolve host => [ip, ...]; the system's resolver when null
     */
    public static function panel_allowed($url, $resolve = null)
    {
        $parts = is_string($url) ? wp_parse_url($url) : false;
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return false;
        }
        $scheme = strtolower($parts['scheme']);
        if ($scheme === 'https') {
            return true;
        }
        if ($scheme !== 'http') {
            return false;
        }
        $host = strtolower(trim($parts['host'], '[]'));
        if ($host === 'localhost' || substr($host, -10) === '.localhost') {
            return true;
        }
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            return self::local_ip($host);
        }
        $addresses = $resolve !== null ? call_user_func($resolve, $host) : self::resolve_host($host);
        if (!$addresses) {
            return false;
        }
        foreach ($addresses as $ip) {
            if (!self::local_ip($ip)) {
                return false;
            }
        }
        return true;
    }

    /** Loopback (127.0.0.0/8, ::1) or private (10/8, 172.16/12, 192.168/16, fc00::/7), mapped IPv4 included. */
    public static function local_ip($ip)
    {
        $packed = function_exists('inet_pton') ? @inet_pton(trim((string) $ip, '[]')) : false;
        if ($packed === false) {
            $long = ip2long((string) $ip);
            if ($long === false) {
                return false;
            }
            $packed = pack('N', $long);
        }
        if (strlen($packed) === 16) {
            if (substr($packed, 0, 12) !== str_repeat("\0", 10) . "\xff\xff") {
                return $packed === str_repeat("\0", 15) . "\x01" || (ord($packed[0]) & 0xfe) === 0xfc;
            }
            $packed = substr($packed, 12);
        }
        if (strlen($packed) !== 4) {
            return false;
        }
        $a = ord($packed[0]);
        $b = ord($packed[1]);
        return $a === 127 || $a === 10 || ($a === 172 && $b >= 16 && $b <= 31) || ($a === 192 && $b === 168);
    }

    /** Every address a name has, IPv4 and IPv6. None when it does not resolve. */
    private static function resolve_host($host)
    {
        $addresses = @gethostbynamel($host);
        $addresses = is_array($addresses) ? $addresses : [];
        if (function_exists('dns_get_record') && defined('DNS_AAAA')) {
            $records = @dns_get_record($host, DNS_AAAA);
            foreach (is_array($records) ? $records : [] as $record) {
                if (isset($record['ipv6'])) {
                    $addresses[] = $record['ipv6'];
                }
            }
        }
        return $addresses;
    }

    /** True for valid UTF-8. A file name or a column value that is not goes as bytes. */
    public static function is_utf8($s)
    {
        return preg_match('//u', $s) === 1;
    }

    /**
     * $s with every ill-formed sequence replaced by U+FFFD, the way the WHATWG decoder (and so
     * Node) does it: one replacement per maximal subpart. Only for display; the exact bytes travel
     * beside it.
     */
    public static function utf8_display($s)
    {
        if (self::is_utf8($s)) {
            return $s;
        }
        $out = '';
        $len = strlen($s);
        $i = 0;
        while ($i < $len) {
            $b = ord($s[$i]);
            if ($b < 0x80) {
                $out .= $s[$i];
                $i++;
                continue;
            }
            $need = 0;
            $lower = 0x80;
            $upper = 0xBF;
            if ($b >= 0xC2 && $b <= 0xDF) {
                $need = 1;
            } elseif ($b >= 0xE0 && $b <= 0xEF) {
                $need = 2;
                if ($b === 0xE0) {
                    $lower = 0xA0;
                } elseif ($b === 0xED) {
                    $upper = 0x9F;
                }
            } elseif ($b >= 0xF0 && $b <= 0xF4) {
                $need = 3;
                if ($b === 0xF0) {
                    $lower = 0x90;
                } elseif ($b === 0xF4) {
                    $upper = 0x8F;
                }
            } else {
                $out .= "\xEF\xBF\xBD";
                $i++;
                continue;
            }
            $j = $i + 1;
            $seen = 0;
            while ($seen < $need && $j < $len) {
                $c = ord($s[$j]);
                if ($c < $lower || $c > $upper) {
                    break;
                }
                $lower = 0x80;
                $upper = 0xBF;
                $seen++;
                $j++;
            }
            $out .= $seen === $need ? substr($s, $i, $j - $i) : "\xEF\xBF\xBD";
            $i = $j;
        }
        return $out;
    }
}
