<?php
defined('ABSPATH') || exit;

/**
 * The report: what the panel needs to know about this site before it copies it. Sent with
 * connect, and the answer to `info` (docs/internal/import-protocol.md, The report). The panel
 * decides what is a problem; this only says what is there.
 */
final class WPL7_Migrate_Info
{
    /**
     * Never sent: what wp-config.php says about this host, its database, its keys and its layout.
     * They mean nothing on the new server, or would break it. The panel drops the same names again.
     */
    const BLOCKLIST = [
        'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_CHARSET', 'DB_COLLATE',
        'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
        'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
        'WP_HOME', 'WP_SITEURL', 'ABSPATH', 'WP_CONTENT_DIR', 'WP_CONTENT_URL', 'WP_PLUGIN_DIR', 'WP_PLUGIN_URL',
        'WPMU_PLUGIN_DIR', 'UPLOADS', 'COOKIE_DOMAIN', 'WP_CACHE', 'WPCACHEHOME', 'DISABLE_WP_CRON', 'WP_TEMP_DIR',
        'FS_METHOD', 'MULTISITE', 'WP_ALLOW_MULTISITE', 'SUBDOMAIN_INSTALL', 'DOMAIN_CURRENT_SITE',
        'PATH_CURRENT_SITE', 'SITE_ID_CURRENT_SITE', 'BLOG_ID_CURRENT_SITE',
    ];
    const BLOCKLIST_PREFIXES = ['FTP_'];
    const NAME_RE = '/^[A-Z][A-Z0-9_]{0,63}$/D';

    /** The panel's caps on a report; past them the report would be refused whole. */
    const MAX_CONSTANTS = 500;
    const MAX_STRING = 2000;
    const MAX_PLUGINS = 2000;
    const MAX_TABLES = 5000;
    /** The quick file count's cap, when the request itself allows that long. */
    const WALK_SECONDS = 20;

    public static function report($deadline)
    {
        global $wpdb, $wp_version;
        $warnings = [];
        $home = home_url();
        $report = [
            'protocol' => WPL7_Migrate_Plugin::PROTOCOL,
            'plugin' => WPL7_MIGRATE_VERSION,
            'time' => time(),
            'endpoint' => rest_url(WPL7_Migrate_Server::REST_NAMESPACE . '/'),
            'home' => self::text($home),
            'siteurl' => self::text(site_url()),
            'abspath' => self::text(ABSPATH),
            'abspath_real' => self::real_dir(ABSPATH),
            'document_root' => isset($_SERVER['DOCUMENT_ROOT']) ? self::real_dir(wp_unslash($_SERVER['DOCUMENT_ROOT'])) : null,
            'content_dir' => self::text(WP_CONTENT_DIR),
            'uploads_dir' => self::uploads_dir(),
            'multisite' => is_multisite(),
            'windows' => WPL7_Migrate_Plugin::is_windows(),
            'table_prefix' => $wpdb->prefix,
            'wp' => self::text($wp_version),
            'php' => PHP_VERSION,
            'locale' => self::text(get_locale()),
            'charset' => self::text($wpdb->charset),
            'collation' => self::text($wpdb->collate),
            'blog_public' => (int) get_option('blog_public') === 1 ? 1 : 0,
            'admin_email' => self::text(get_option('admin_email')),
            'title' => self::text(get_option('blogname')),
            'https' => strtolower((string) wp_parse_url($home, PHP_URL_SCHEME)) === 'https',
            'db' => self::db($warnings),
            'constants' => self::constants($warnings),
        ];
        $report += self::plugins_and_themes($warnings);
        $report['htaccess'] = self::htaccess();
        $report['user_ini'] = @is_file(ABSPATH . '.user.ini');
        $report['php_ini'] = @is_file(ABSPATH . 'php.ini');
        // Last, with what time the request has left.
        $report['files'] = WPL7_Migrate_Manifest::quick_count(min($deadline, microtime(true) + self::WALK_SECONDS));
        $report['warnings'] = $warnings;
        return $report;
    }

    /** A few facts from a report, kept for the admin page. */
    public static function facts($report)
    {
        return [
            'wp' => $report['wp'],
            'php' => $report['php'],
            'prefix' => $report['table_prefix'],
            'files' => $report['files']['count'],
            'files_bytes' => $report['files']['bytes'],
            'partial' => !empty($report['files']['partial']),
            'tables' => count($report['db']['tables']),
            'db_bytes' => $report['db']['bytes'],
            'time' => $report['time'],
        ];
    }

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

    /** The names wp-config.php passes to define(), in order, from its tokens. Nothing is run. */
    public static function define_names($source)
    {
        $tokens = token_get_all($source);
        $count = count($tokens);
        $names = [];
        $skip = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT];
        for ($i = 0; $i < $count; $i++) {
            $t = $tokens[$i];
            if (!is_array($t)) {
                continue;
            }
            $word = strtolower(ltrim($t[1], '\\'));
            // PHP 8 reads `\define` as one token, which PHP 7 does not have.
            $is_name = $t[0] === T_STRING || (defined('T_NAME_FULLY_QUALIFIED') && $t[0] === constant('T_NAME_FULLY_QUALIFIED'));
            if (!$is_name || $word !== 'define') {
                continue;
            }
            // A method or a function of that name is not the define() of PHP.
            $p = $i - 1;
            while ($p >= 0 && is_array($tokens[$p]) && in_array($tokens[$p][0], $skip, true)) {
                $p--;
            }
            if ($p >= 0 && is_array($tokens[$p]) && in_array($tokens[$p][0], [T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_FUNCTION], true)) {
                continue;
            }
            $j = $i + 1;
            while ($j < $count && is_array($tokens[$j]) && in_array($tokens[$j][0], $skip, true)) {
                $j++;
            }
            if ($j >= $count || $tokens[$j] !== '(') {
                continue;
            }
            $j++;
            while ($j < $count && is_array($tokens[$j]) && in_array($tokens[$j][0], $skip, true)) {
                $j++;
            }
            if ($j < $count && is_array($tokens[$j]) && $tokens[$j][0] === T_CONSTANT_ENCAPSED_STRING) {
                $name = substr($tokens[$j][1], 1, -1);
                if (preg_match(self::NAME_RE, $name) && !in_array($name, $names, true)) {
                    $names[] = $name;
                }
            }
        }
        return $names;
    }

    public static function blocklisted($name)
    {
        if (in_array($name, self::BLOCKLIST, true)) {
            return true;
        }
        foreach (self::BLOCKLIST_PREFIXES as $prefix) {
            if (strpos($name, $prefix) === 0) {
                return true;
            }
        }
        return false;
    }

    /** Whether an .htaccess has rules of its own, outside WordPress's block. */
    public static function htaccess_custom($text)
    {
        $text = preg_replace('/^[ \t]*# BEGIN WordPress[ \t]*$.*?^[ \t]*# END WordPress[ \t]*$/ms', '', $text);
        foreach (preg_split('/\r\n|\r|\n/', (string) $text) as $line) {
            $line = trim($line);
            if ($line !== '' && $line[0] !== '#') {
                return true;
            }
        }
        return false;
    }

    /** `MariaDB 11.4.3` or `MySQL 8.0.36`, from SELECT VERSION(). */
    public static function server_label($version)
    {
        $version = trim((string) $version);
        // Some MariaDB builds put 5.5.5- in front, for clients that expect a MySQL version.
        $bare = preg_replace('/^5\.5\.5-/', '', $version);
        $number = preg_match('/^(\d+\.\d+(?:\.\d+)?)/', $bare, $m) ? $m[1] : $bare;
        return (stripos($version, 'mariadb') !== false ? 'MariaDB ' : 'MySQL ') . $number;
    }

    // -- Parts of the report -----------------------------------------------------------------

    /** Valid UTF-8 for the JSON, whatever a plugin header or an option holds. */
    public static function text($value)
    {
        return WPL7_Migrate_Plugin::utf8_display((string) $value);
    }

    private static function real_dir($dir)
    {
        $real = @realpath((string) $dir);
        return $real === false ? null : self::text(rtrim($real, '/') . '/');
    }

    private static function uploads_dir()
    {
        $uploads = wp_upload_dir(null, false);
        return is_array($uploads) && !empty($uploads['basedir']) ? self::text($uploads['basedir']) : null;
    }

    private static function db(&$warnings)
    {
        global $wpdb;
        $info = WPL7_Migrate_Sql::tables_info();
        $bytes = 0;
        $tables = [];
        foreach ($info['tables'] as $t) {
            $bytes += $t['bytes'];
            if (count($tables) < self::MAX_TABLES) {
                $tables[] = ['name' => $t['name'], 'rows' => $t['rows'], 'bytes' => $t['bytes'], 'pk' => $t['pk'], 'collation' => $t['collation']];
            }
        }
        if (count($info['tables']) > self::MAX_TABLES) {
            $warnings[] = ['code' => 'tables_truncated', 'count' => count($info['tables'])];
        }
        return [
            'server' => self::server_label($wpdb->get_var('SELECT VERSION()')),
            'bytes' => $bytes,
            'tables' => $tables,
            'views' => $info['views'],
            'triggers' => (int) $wpdb->get_var('SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()'),
            'routines' => (int) $wpdb->get_var('SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()'),
            'events' => (int) $wpdb->get_var('SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()'),
        ];
    }

    /**
     * Settings from wp-config.php to carry to the new site. The names come from reading the file's
     * tokens; the values are the constants' values now, so a value wp-config.php computes is sent
     * as it came out. Only strings, numbers, booleans and null.
     */
    private static function constants(&$warnings)
    {
        $file = self::config_file();
        $source = $file === null ? false : @file_get_contents($file, false, null, 0, 1048576);
        if (!is_string($source) || !function_exists('token_get_all')) {
            $warnings[] = ['code' => 'constants_unread'];
            return [];
        }
        $types = ['string' => 'string', 'boolean' => 'bool', 'integer' => 'int', 'double' => 'float', 'NULL' => 'null'];
        $out = [];
        foreach (self::define_names($source) as $name) {
            if (self::blocklisted($name) || !defined($name)) {
                continue;
            }
            $value = constant($name);
            $type = gettype($value);
            if (!isset($types[$type]) || (is_float($value) && (is_nan($value) || is_infinite($value)))) {
                continue;
            }
            if (is_string($value) && (strlen($value) > self::MAX_STRING || !WPL7_Migrate_Plugin::is_utf8($value))) {
                $warnings[] = ['code' => 'constant_skipped', 'detail' => $name];
                continue;
            }
            $out[] = ['name' => $name, 'value' => $value, 'type' => $types[$type]];
            if (count($out) >= self::MAX_CONSTANTS) {
                break;
            }
        }
        return $out;
    }

    /** Where WordPress found its wp-config.php: next to it, or one folder up. */
    private static function config_file()
    {
        if (@is_file(ABSPATH . 'wp-config.php')) {
            return ABSPATH . 'wp-config.php';
        }
        $up = dirname(ABSPATH) . '/wp-config.php';
        if (@is_file($up) && !@is_file(dirname(ABSPATH) . '/wp-settings.php')) {
            return $up;
        }
        return null;
    }

    private static function plugins_and_themes(&$warnings)
    {
        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        $plugins = [];
        $all = get_plugins();
        foreach ($all as $file => $data) {
            if (count($plugins) >= self::MAX_PLUGINS) {
                $warnings[] = ['code' => 'plugins_truncated', 'count' => count($all)];
                break;
            }
            $slug = strpos($file, '/') !== false ? dirname($file) : preg_replace('/\.php$/', '', $file);
            $plugins[] = [
                'file' => self::text($file),
                'slug' => self::text($slug),
                'name' => self::text(isset($data['Name']) ? $data['Name'] : ''),
                'version' => self::text(isset($data['Version']) ? $data['Version'] : ''),
                'active' => is_plugin_active($file),
            ];
        }
        $mu = [];
        foreach (get_mu_plugins() as $file => $data) {
            $mu[] = ['file' => self::text($file), 'name' => self::text(isset($data['Name']) ? $data['Name'] : '')];
        }
        $theme = wp_get_theme();
        return [
            'dropins' => array_map([__CLASS__, 'text'], array_keys(get_dropins())),
            'mu_plugins' => $mu,
            'plugins' => $plugins,
            'theme' => [
                'slug' => self::text(get_stylesheet()),
                'name' => self::text($theme->get('Name')),
                'version' => self::text($theme->get('Version')),
                'template' => self::text(get_template()),
            ],
        ];
    }

    private static function htaccess()
    {
        $file = ABSPATH . '.htaccess';
        if (!@is_file($file)) {
            return ['present' => false, 'custom' => false];
        }
        $text = @file_get_contents($file, false, null, 0, 1048576);
        return ['present' => true, 'custom' => is_string($text) && self::htaccess_custom($text)];
    }
}
