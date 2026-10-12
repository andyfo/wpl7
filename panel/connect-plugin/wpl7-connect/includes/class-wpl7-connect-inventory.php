<?php
defined('ABSPATH') || exit;

/**
 * The inventory: the plugins, themes and WordPress itself with their updates, as WP-CLI's
 * `plugin list`, `theme list` and `core check-update` print them on the same site
 * (docs/internal/connect-protocol.md, inventory). The rows are made by pure functions from plain
 * inputs, which tests/run.php checks against the vectors; read() gathers those inputs from
 * WordPress.
 */
final class WPL7_Connect_Inventory
{
    /** WP-CLI's word for an installed version above what the update check knows. */
    const HIGHER = 'version higher than expected';

    /** The `inventory` action: { check?: bool }, a fresh update check first unless check is false. */
    public static function action($params)
    {
        $check = array_key_exists('check', $params) ? $params['check'] : true;
        if (!is_bool($check)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'check']);
        }
        self::require_admin();
        if ($check) {
            // As `wp plugin list`, `wp theme list` and `wp core check-update --force-check` do: a
            // premium plugin's updater that hooks WordPress's check reports through this too.
            delete_site_transient('update_plugins');
            delete_site_transient('update_themes');
            wp_update_plugins();
            wp_update_themes();
            wp_version_check([], true);
        }
        return self::read();
    }

    private static function require_admin()
    {
        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        if (!function_exists('wp_update_plugins')) {
            require_once ABSPATH . WPINC . '/update.php';
        }
    }

    /** The inventory from what WordPress has now, its cached update data included. */
    public static function read()
    {
        global $wp_version;
        self::require_admin();
        $plugins = [];
        $active = [];
        $network = [];
        foreach (get_plugins() as $file => $data) {
            $plugins[$file] = self::headers($data);
            if (is_multisite() && is_plugin_active_for_network($file)) {
                $network[] = $file;
            } elseif (is_plugin_active($file)) {
                $active[] = $file;
            }
        }
        $mu = [];
        foreach (get_mu_plugins() as $file => $data) {
            $mu[$file] = self::headers($data);
        }
        $dropins = [];
        foreach (get_dropins() as $file => $data) {
            $dropins[$file] = self::headers($data);
        }
        $plugin_updates = get_site_transient('update_plugins');
        $theme_updates = get_site_transient('update_themes');
        $core_updates = get_site_transient('update_core');

        $themes = [];
        foreach (wp_get_themes() as $stylesheet => $theme) {
            $themes[$stylesheet] = ['Name' => (string) $theme->get('Name'), 'Version' => (string) $theme->get('Version')];
        }
        $offers = [];
        if (is_object($core_updates) && isset($core_updates->updates) && is_array($core_updates->updates)) {
            foreach ($core_updates->updates as $offer) {
                if (is_object($offer) && isset($offer->version) && is_string($offer->version)) {
                    $offers[] = $offer->version;
                }
            }
        }
        return [
            'core' => ['version' => self::text($wp_version), 'update' => self::core_update((string) $wp_version, $offers)],
            'plugins' => self::plugin_rows([
                'plugins' => $plugins,
                'active' => $active,
                'network' => $network,
                'response' => self::entries($plugin_updates, 'response'),
                'no_update' => self::entries($plugin_updates, 'no_update'),
                'auto_updates' => self::site_list('auto_update_plugins'),
                'mu' => $mu,
                'dropins' => $dropins,
                'php' => PHP_VERSION,
                'wp' => (string) $wp_version,
            ]),
            'themes' => self::theme_rows([
                'themes' => $themes,
                'stylesheet' => get_stylesheet(),
                'template' => get_template(),
                'response' => self::entries($theme_updates, 'response'),
                'no_update' => self::entries($theme_updates, 'no_update'),
                'auto_updates' => self::site_list('auto_update_themes'),
                'php' => PHP_VERSION,
                'wp' => (string) $wp_version,
            ]),
            // The update columns say nothing when WordPress has no update data: the check failed,
            // or a plugin turned update checks off.
            'partial' => !self::has_entries($plugin_updates) || !self::has_entries($theme_updates)
                || !(is_object($core_updates) && isset($core_updates->updates) && is_array($core_updates->updates)),
        ];
    }

    private static function headers($data)
    {
        return [
            'Name' => isset($data['Name']) ? (string) $data['Name'] : '',
            'Version' => isset($data['Version']) ? (string) $data['Version'] : '',
        ];
    }

    /** An update transient's `response` or `no_update`, as name => [new_version, requires, requires_php]. */
    private static function entries($transient, $key)
    {
        $out = [];
        if (!is_object($transient) || !isset($transient->$key) || !is_array($transient->$key)) {
            return $out;
        }
        foreach ($transient->$key as $name => $entry) {
            $entry = is_object($entry) ? get_object_vars($entry) : $entry;
            if (!is_array($entry)) {
                continue;
            }
            $row = [];
            foreach (['new_version', 'requires', 'requires_php'] as $field) {
                if (isset($entry[$field]) && (is_string($entry[$field]) || is_int($entry[$field]) || is_float($entry[$field]))) {
                    $row[$field] = (string) $entry[$field];
                }
            }
            $out[(string) $name] = $row;
        }
        return $out;
    }

    private static function has_entries($transient)
    {
        return is_object($transient) && isset($transient->response) && is_array($transient->response);
    }

    private static function site_list($option)
    {
        $list = get_site_option($option, []);
        return is_array($list) ? array_values(array_filter($list, 'is_string')) : [];
    }

    private static function text($value)
    {
        return WPL7_Connect_Plugin::utf8_display((string) $value);
    }

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

    /**
     * The inventory's names for plugin files, as WP-CLI gives them: the folder, or the file name
     * without .php for a plugin of one file; where two would share a name, each takes its file
     * path without the extension.
     *
     * @param string[] $files
     * @return array file => name
     */
    public static function plugin_names($files)
    {
        $names = [];
        $count = [];
        foreach ($files as $file) {
            $name = strpos($file, '/') !== false ? dirname($file) : preg_replace('/\.php$/', '', $file);
            $names[$file] = $name;
            $count[$name] = isset($count[$name]) ? $count[$name] + 1 : 1;
        }
        foreach ($names as $file => $name) {
            if ($count[$name] > 1) {
                $names[$file] = preg_replace('/\.[^.\/]*$/', '', $file);
            }
        }
        return $names;
    }

    /**
     * `wp plugin list` rows from plain inputs: every plugin, then the must-use plugins, then the
     * drop-ins. The vectors' `inventory.plugins` case gives an input and its rows.
     */
    public static function plugin_rows($input)
    {
        $rows = [];
        $names = self::plugin_names(array_keys($input['plugins']));
        foreach ($input['plugins'] as $file => $data) {
            if (in_array($file, $input['network'], true)) {
                $status = 'active-network';
            } elseif (in_array($file, $input['active'], true)) {
                $status = 'active';
            } else {
                $status = 'inactive';
            }
            $update = self::update_state(
                $data['Version'],
                isset($input['response'][$file]) ? $input['response'][$file] : null,
                isset($input['no_update'][$file]) ? $input['no_update'][$file] : null,
                $input['php'],
                $input['wp']
            );
            $rows[] = [
                'name' => self::text($names[$file]),
                'title' => self::text($data['Name']),
                'status' => $status,
                'version' => self::text($data['Version']),
                'update' => $update[0],
                'update_version' => self::text($update[1]),
                'auto_update' => in_array($file, $input['auto_updates'], true) ? 'on' : 'off',
                'file' => self::text($file),
            ];
        }
        foreach ($input['mu'] as $file => $data) {
            $rows[] = [
                'name' => self::text(strpos($file, '/') !== false ? dirname($file) : preg_replace('/\.php$/', '', $file)),
                'title' => self::text($data['Name']),
                'status' => 'must-use',
                'version' => self::text($data['Version']),
                'update' => 'none',
                'update_version' => '',
                'auto_update' => 'off',
                'file' => self::text($file),
            ];
        }
        foreach ($input['dropins'] as $file => $data) {
            $rows[] = [
                'name' => self::text($file),
                'title' => self::text($data['Name']),
                'status' => 'dropin',
                'version' => self::text($data['Version']),
                'update' => 'none',
                'update_version' => '',
                'auto_update' => 'off',
                'file' => self::text($file),
            ];
        }
        return $rows;
    }

    /** `wp theme list` rows from plain inputs; the vectors' `inventory.themes` case. */
    public static function theme_rows($input)
    {
        $rows = [];
        foreach ($input['themes'] as $stylesheet => $data) {
            $stylesheet = (string) $stylesheet;
            if ($stylesheet === $input['stylesheet']) {
                $status = 'active';
            } elseif ($stylesheet === $input['template']) {
                $status = 'parent';
            } else {
                $status = 'inactive';
            }
            $update = self::update_state(
                $data['Version'],
                isset($input['response'][$stylesheet]) ? $input['response'][$stylesheet] : null,
                isset($input['no_update'][$stylesheet]) ? $input['no_update'][$stylesheet] : null,
                $input['php'],
                $input['wp']
            );
            $rows[] = [
                'name' => self::text($stylesheet),
                'title' => self::text($data['Name']),
                'status' => $status,
                'version' => self::text($data['Version']),
                'update' => $update[0],
                'update_version' => self::text($update[1]),
                'auto_update' => in_array($stylesheet, $input['auto_updates'], true) ? 'on' : 'off',
            ];
        }
        return $rows;
    }

    /**
     * [update, update_version] for one plugin or theme, in WP-CLI's words: `available` when the
     * update check offers one, `unavailable` when that one needs a newer PHP or WordPress than
     * the site runs, `version higher than expected` when the installed version is above what the
     * check knows as current, otherwise `none`.
     */
    public static function update_state($version, $response, $no_update, $php, $wp)
    {
        if (is_array($response)) {
            $new = isset($response['new_version']) ? (string) $response['new_version'] : '';
            $requires_php = isset($response['requires_php']) ? (string) $response['requires_php'] : '';
            $requires = isset($response['requires']) ? (string) $response['requires'] : '';
            if (($requires_php !== '' && version_compare($php, $requires_php, '<'))
                || ($requires !== '' && version_compare($wp, $requires, '<'))) {
                return ['unavailable', $new];
            }
            return ['available', $new];
        }
        if (is_array($no_update) && isset($no_update['new_version'])
            && version_compare((string) $version, (string) $no_update['new_version'], '>')) {
            return [self::HIGHER, ''];
        }
        return ['none', ''];
    }

    /**
     * WordPress's own update: the newest offer above the installed version, or null. `minor` for
     * a new release of the installed branch (7.1.2 to 7.1.3), `major` for anything newer, as
     * `wp core check-update` says it. The vectors' `inventory.core` cases.
     */
    public static function core_update($version, $offers)
    {
        $installed = self::normal_version($version);
        $best = null;
        foreach ($offers as $offer) {
            $offer = (string) $offer;
            if (version_compare(self::normal_version($offer), $installed, '>')
                && ($best === null || version_compare(self::normal_version($offer), self::normal_version($best), '>'))) {
                $best = $offer;
            }
        }
        if ($best === null) {
            return null;
        }
        return ['version' => self::text($best), 'type' => self::branch($best) === self::branch($version) ? 'minor' : 'major'];
    }

    /** `7.1` and `7.1.0` are one version, as WP-CLI compares them; `-src` is a checkout's suffix. */
    public static function normal_version($version)
    {
        $version = preg_replace('/-src$/', '', trim((string) $version));
        if (preg_match('/^\d+(?:\.\d+)*$/D', $version)) {
            $parts = explode('.', $version);
            while (count($parts) < 3) {
                $parts[] = '0';
            }
            return implode('.', $parts);
        }
        return $version;
    }

    /** `7.1` for 7.1, 7.1.0 and 7.1.3: a version's first two numbers. */
    private static function branch($version)
    {
        $parts = explode('.', self::normal_version($version));
        return (int) $parts[0] . '.' . (isset($parts[1]) ? (int) $parts[1] : 0);
    }
}
