<?php
defined('ABSPATH') || exit;

/**
 * The report: what the panel needs to know about this site. The body of enroll, and the answer to
 * `info` (docs/internal/connect-protocol.md, The report). It is WPL7 Migrate's report without the
 * settings from wp-config.php and the server's own files (.htaccess, .user.ini, php.ini), and with
 * the administrators, how WordPress may write files, the must-use loader and the registered
 * commands. The panel decides what is a problem; this only says what is there.
 */
final class WPL7_Connect_Info
{
    /** The panel's caps on a report; past them the report would be refused whole. */
    const MAX_PLUGINS = 2000;
    const MAX_TABLES = 5000;
    const MAX_ADMINS = 50;
    /** The quick file count's cap, when the request itself allows that long. */
    const WALK_SECONDS = 20;

    public static function report($deadline)
    {
        global $wpdb, $wp_version;
        $warnings = [];
        $home = WPL7_Connect_Plugin::home();
        $report = [
            'protocol' => WPL7_Connect_Plugin::PROTOCOL,
            'plugin' => WPL7_CONNECT_VERSION,
            'time' => time(),
            'endpoint' => rest_url(WPL7_Connect_Server::REST_NAMESPACE . '/'),
            'home' => self::text($home),
            'siteurl' => self::text(site_url()),
            'abspath' => self::text(ABSPATH),
            'abspath_real' => self::real_dir(ABSPATH),
            'document_root' => isset($_SERVER['DOCUMENT_ROOT']) ? self::real_dir(wp_unslash($_SERVER['DOCUMENT_ROOT'])) : null,
            'content_dir' => self::text(WP_CONTENT_DIR),
            'uploads_dir' => self::uploads_dir(),
            'multisite' => is_multisite(),
            'windows' => WPL7_Connect_Plugin::is_windows(),
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
        ];
        $report += self::plugins_and_themes($warnings);
        $report['admins'] = self::admins();
        $report['fs_method'] = self::fs_method();
        $report['file_mods'] = self::file_mods();
        $report['loader'] = WPL7_Connect_Loader::ensure();
        $report['commands'] = WPL7_Connect_Commands::names();
        // Last, with what time the request has left.
        $report['files'] = WPL7_Connect_Manifest::quick_count(min($deadline, microtime(true) + self::WALK_SECONDS));
        $report['warnings'] = $warnings;
        return $report;
    }

    /**
     * How WordPress would write files here: direct, ssh2, ftpext or ftpsockets. Anything but
     * direct needs the FTP or SSH details in wp-config.php before the panel can update the site.
     */
    public static function fs_method()
    {
        if (!function_exists('get_filesystem_method')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }
        $method = get_filesystem_method();
        return is_string($method) ? $method : '';
    }

    /** False when DISALLOW_FILE_MODS (or a filter on it) forbids changing plugins, themes and core. */
    public static function file_mods()
    {
        if (function_exists('wp_is_file_mod_allowed')) {
            return (bool) wp_is_file_mod_allowed('wpl7_connect');
        }
        return !(defined('DISALLOW_FILE_MODS') && DISALLOW_FILE_MODS);
    }

    /** Whether updates over FTP or SSH can get their details from wp-config.php. */
    public static function fs_credentials_defined()
    {
        return defined('FTP_HOST') && defined('FTP_USER') && (defined('FTP_PASS') || defined('FTP_PRIKEY'));
    }

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

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
        return WPL7_Connect_Plugin::utf8_display((string) $value);
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
        $info = WPL7_Connect_Sql::tables_info();
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

    /** The users with the administrator role, by id, at most MAX_ADMINS. */
    private static function admins()
    {
        $users = get_users([
            'role' => 'administrator',
            'orderby' => 'ID',
            'order' => 'ASC',
            'number' => self::MAX_ADMINS,
            'fields' => ['ID', 'user_login', 'display_name'],
        ]);
        $out = [];
        foreach (is_array($users) ? $users : [] as $user) {
            $out[] = ['id' => (int) $user->ID, 'login' => self::text($user->user_login), 'name' => self::text($user->display_name)];
        }
        return $out;
    }
}
