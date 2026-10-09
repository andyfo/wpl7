<?php
defined('ABSPATH') || exit;

/**
 * Changes to the site's code (docs/internal/connect-protocol.md, Actions: update, op, rollback,
 * cleanup, component): updates of plugins, themes, WordPress and its database, with a copy of a
 * plugin or theme kept to roll back to, and activating, deactivating, deleting and installing
 * plugins and themes. Everything goes through WordPress's own upgrader classes and
 * WP_Filesystem, as WP-CLI's commands do, and runs quietly: the upgraders print as they work,
 * and none of that may reach the response.
 *
 * An update's state lives in the option wpl7_connect_op_<op>, so a panel that lost the answer
 * can ask `op`. The copies an update keeps are under wp-content/wpl7-rollback/<op>/, recorded in
 * that option with where they came from; `rollback` puts back only what is recorded there.
 */
final class WPL7_Connect_Updates
{
    /** The panel's id for one change. */
    const OP_RE = '/^[a-z0-9]{16,64}$/D';
    /** Rollback copies and op records older than this go before the next update starts: 7 days. */
    const KEEP_SECONDS = 604800;
    const ROLLBACK_DIR = 'wpl7-rollback';
    /** The plugin refuses to switch itself off, in the protocol's words. */
    const SELF_REFUSAL = 'WPL7 Connect connects this site to the panel.';

    // -- update ------------------------------------------------------------------------------

    /**
     * The `update` action: { op, kind: plugin | theme | core | db, slug?, version? }, one item.
     * A plugin, theme or db update answers when it is done. A core update answers `running` and
     * goes on after the answer has gone where PHP-FPM can finish the response early; elsewhere
     * it runs within the request. Returns a response, or [response, what runs after it].
     */
    public static function update($params)
    {
        $op = self::op_param($params);
        $kind = isset($params['kind']) ? $params['kind'] : null;
        if (!in_array($kind, ['plugin', 'theme', 'core', 'db'], true)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'kind']);
        }
        $slug = $kind === 'plugin' || $kind === 'theme' ? self::slug_param($params) : null;
        $version = $kind === 'core' ? self::version_param($params) : null;
        self::require_admin();
        WPL7_Connect_Server::long_request(0);
        if ($kind === 'db') {
            self::expire();
            return WPL7_Connect_Server::json(200, self::update_db($op));
        }
        // What the update acts on must be there before anything else is looked at.
        $target = null;
        if ($kind === 'plugin') {
            $target = self::find_plugin($slug);
        } elseif ($kind === 'theme') {
            $target = self::find_theme($slug);
        }
        self::require_file_mods();
        self::filesystem();
        self::expire();
        self::allow_panel_downloads();
        if ($kind === 'core') {
            return self::update_core($op, $version);
        }
        $answer = $kind === 'plugin' ? self::update_plugin($op, $slug, $target) : self::update_theme($op, $slug, $target);
        return WPL7_Connect_Server::json(200, $answer);
    }

    private static function update_plugin($op, $slug, $file)
    {
        $from = self::plugin_version($file);
        self::begin($op, 'plugin', $slug, null);
        wp_update_plugins();
        $current = get_site_transient('update_plugins');
        if (!is_object($current) || !isset($current->response[$file])) {
            return self::done($op, self::result(false, $from, $from, false, 'No update is available.'));
        }
        $rollback = self::keep_copy($op, 'plugin', $slug, self::plugin_path($file));
        WPL7_Connect_Plugin::load_all();
        $skin = new WP_Ajax_Upgrader_Skin();
        $upgrader = new Plugin_Upgrader($skin);
        try {
            $result = self::quietly(function () use ($upgrader, $file) {
                return $upgrader->bulk_upgrade([$file]);
            });
            $error = self::upgrade_error($result, $file, $skin);
        } catch (Throwable $e) {
            $error = WPL7_Connect_Server::describe($e);
        }
        self::forget_compiled(self::plugin_path($file));
        $to = self::plugin_version($file);
        return self::done($op, self::result($error === null, $from, $to, $rollback, $error));
    }

    private static function update_theme($op, $slug, $theme)
    {
        $from = self::theme_version($theme);
        self::begin($op, 'theme', $slug, null);
        wp_update_themes();
        $current = get_site_transient('update_themes');
        if (!is_object($current) || !isset($current->response[$slug])) {
            return self::done($op, self::result(false, $from, $from, false, 'No update is available.'));
        }
        $folder = untrailingslashit($theme->get_stylesheet_directory());
        $rollback = self::keep_copy($op, 'theme', $slug, $folder);
        WPL7_Connect_Plugin::load_all();
        $skin = new WP_Ajax_Upgrader_Skin();
        $upgrader = new Theme_Upgrader($skin);
        try {
            $result = self::quietly(function () use ($upgrader, $slug) {
                return $upgrader->bulk_upgrade([$slug]);
            });
            $error = self::upgrade_error($result, $slug, $skin);
        } catch (Throwable $e) {
            $error = WPL7_Connect_Server::describe($e);
        }
        self::forget_compiled($folder);
        $to = self::theme_version(wp_get_theme($slug));
        return self::done($op, self::result($error === null, $from, $to, $rollback, $error));
    }

    /**
     * WordPress itself: the offer for this version and the site's locale, else the English one,
     * as the update page offers both. No rollback copy. The database is updated by a request of
     * its own (kind db): the old code is still loaded in this one.
     */
    private static function update_core($op, $version)
    {
        global $wp_version;
        $from = (string) $wp_version;
        self::begin($op, 'core', null, $version);
        $offer = find_core_update($version, get_locale());
        if (!$offer && get_locale() !== 'en_US') {
            $offer = find_core_update($version, 'en_US');
        }
        if (!$offer) {
            return WPL7_Connect_Server::json(200, self::done($op, self::result(false, $from, $from, false, 'WordPress ' . $version . ' is not on offer.')));
        }
        if (!function_exists('fastcgi_finish_request')) {
            return WPL7_Connect_Server::json(200, self::run_core($op, $offer, $from));
        }
        $after = function ($log_id = 0) use ($op, $offer, $from, $version) {
            $answer = self::run_core($op, $offer, $from);
            $ok = !empty($answer['result']['ok']);
            WPL7_Connect_Server::log_update($log_id, WPL7_Connect_Server::summary('update', ['kind' => 'core', 'version' => $version], $answer, $ok), $ok);
        };
        return [WPL7_Connect_Server::json(200, self::answer(self::record($op))), $after];
    }

    private static function run_core($op, $offer, $from)
    {
        WPL7_Connect_Plugin::load_all();
        register_shutdown_function([__CLASS__, 'record_fatal'], $op);
        $skin = new WP_Ajax_Upgrader_Skin();
        $upgrader = new Core_Upgrader($skin);
        try {
            $result = self::quietly(function () use ($upgrader, $offer) {
                return $upgrader->upgrade($offer);
            });
            $error = self::upgrade_error($result, null, $skin);
        } catch (Throwable $e) {
            $error = WPL7_Connect_Server::describe($e);
        }
        $to = self::core_version_on_disk();
        return self::done($op, self::result($error === null, $from, $to !== null ? $to : null, false, $error));
    }

    /** The database brought up to the WordPress files, as `wp core update-db` does. */
    private static function update_db($op)
    {
        global $wp_db_version;
        self::begin($op, 'db', null, null);
        $files = (int) $wp_db_version;
        $from = (int) get_option('db_version');
        $error = null;
        if ($from < $files) {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            try {
                self::quietly(function () {
                    wp_upgrade();
                });
            } catch (Throwable $e) {
                $error = WPL7_Connect_Server::describe($e);
            }
            wp_cache_delete('db_version', 'options');
        }
        $to = (int) get_option('db_version');
        if ($error === null && $to < $files) {
            $error = 'The database is at ' . $to . '; the WordPress files need ' . $files . '.';
        }
        return self::done($op, self::result($error === null, (string) $from, (string) $to, false, $error));
    }

    /**
     * After a fatal error, which no catch sees: an update that was running is recorded as failed,
     * so the panel does not wait for it. WordPress's own error page may end PHP first.
     */
    public static function record_fatal($op)
    {
        $error = error_get_last();
        if (!is_array($error) || !in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
            return;
        }
        $record = self::record($op);
        if ($record !== null && $record['state'] === 'running') {
            self::done($op, self::result(false, isset($record['from']) ? $record['from'] : null, null, false,
                self::message('PHP stopped: ' . $error['message'])));
        }
    }

    // -- op, rollback, cleanup ---------------------------------------------------------------

    /** The `op` action: { op } answers as `update` did. */
    public static function op($params)
    {
        $record = self::record(self::op_param($params));
        if ($record === null) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'op']);
        }
        return self::answer($record);
    }

    /** The `rollback` action: { op, items: [{ kind, slug }] } puts each recorded copy back. */
    public static function rollback($params)
    {
        $op = self::op_param($params);
        $items = isset($params['items']) ? $params['items'] : null;
        if (!is_array($items) || !$items || count($items) > 100 || array_values($items) !== $items) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'items']);
        }
        foreach ($items as $item) {
            if (!is_array($item) || !isset($item['kind'], $item['slug']) || !in_array($item['kind'], ['plugin', 'theme'], true)
                || !self::valid_slug($item['slug'])) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'items']);
            }
        }
        self::require_admin();
        self::require_file_mods();
        self::filesystem();
        WPL7_Connect_Server::long_request(0);
        $record = self::record($op);
        $copies = $record !== null && isset($record['copies']) && is_array($record['copies']) ? $record['copies'] : [];
        $out = [];
        foreach ($items as $item) {
            $key = $item['kind'] . ':' . $item['slug'];
            $error = isset($copies[$key]) && is_array($copies[$key]) ? self::restore($copies[$key]) : 'No copy to roll back to.';
            $row = ['kind' => $item['kind'], 'slug' => WPL7_Connect_Plugin::utf8_display($item['slug']), 'ok' => $error === null];
            if ($error !== null) {
                $row['error'] = $error;
            }
            $out[] = $row;
        }
        wp_clean_plugins_cache();
        wp_clean_themes_cache();
        return ['items' => $out];
    }

    /** The `cleanup` action: { op } deletes the op's rollback copies and its record. */
    public static function cleanup($params)
    {
        $op = self::op_param($params);
        self::require_admin();
        // The copies were made through WP_Filesystem; where it cannot be had, PHP removes what it can.
        try {
            self::filesystem();
        } catch (WPL7_Connect_Error $e) {
            // Removed below without it.
        }
        $dir = self::rollback_root() . '/' . $op;
        self::delete_tree($dir);
        delete_option(self::option($op));
        clearstatcache();
        if (@file_exists($dir)) {
            return ['ok' => false, 'error' => 'The rollback copies could not be removed.'];
        }
        return ['ok' => true];
    }

    // -- component ---------------------------------------------------------------------------

    /**
     * The `component` action: { kind: plugin | theme, slug, action: activate | deactivate |
     * delete | install, source?, activate? }. Answers { ok, status } or { ok: false, error } when
     * WordPress refused.
     */
    public static function component($params)
    {
        $kind = isset($params['kind']) ? $params['kind'] : null;
        $action = isset($params['action']) ? $params['action'] : null;
        if ($kind !== 'plugin' && $kind !== 'theme') {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'kind']);
        }
        if (!in_array($action, $kind === 'plugin' ? ['activate', 'deactivate', 'delete', 'install'] : ['activate', 'delete', 'install'], true)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'action']);
        }
        $slug = self::slug_param($params);
        self::require_admin();
        if ($action === 'install') {
            return self::install($kind, $params);
        }
        return $kind === 'plugin' ? self::plugin_action($action, self::find_plugin($slug)) : self::theme_action($action, self::find_theme($slug));
    }

    private static function plugin_action($action, $file)
    {
        if ($file === plugin_basename(WPL7_CONNECT_FILE) && $action !== 'activate') {
            return ['ok' => false, 'error' => self::SELF_REFUSAL];
        }
        if ($action === 'activate') {
            $result = self::quietly(function () use ($file) {
                return activate_plugin($file);
            });
            if (is_wp_error($result)) {
                return ['ok' => false, 'error' => self::message($result->get_error_message())];
            }
            return ['ok' => true, 'status' => 'active'];
        }
        if ($action === 'deactivate') {
            self::quietly(function () use ($file) {
                deactivate_plugins($file);
            });
            if (is_plugin_active($file)) {
                return ['ok' => false, 'error' => 'WordPress did not deactivate the plugin.'];
            }
            return ['ok' => true, 'status' => 'inactive'];
        }
        self::require_file_mods();
        self::filesystem();
        $result = self::quietly(function () use ($file) {
            if (is_plugin_active($file)) {
                deactivate_plugins($file);
            }
            return delete_plugins([$file]);
        });
        if (is_wp_error($result)) {
            return ['ok' => false, 'error' => self::message($result->get_error_message())];
        }
        if ($result !== true) {
            return ['ok' => false, 'error' => 'WordPress did not delete the plugin.'];
        }
        return ['ok' => true, 'status' => 'deleted'];
    }

    private static function theme_action($action, $theme)
    {
        $stylesheet = $theme->get_stylesheet();
        if ($action === 'activate') {
            $errors = $theme->errors();
            if (is_wp_error($errors)) {
                return ['ok' => false, 'error' => self::message($errors->get_error_message())];
            }
            self::quietly(function () use ($stylesheet) {
                switch_theme($stylesheet);
            });
            if (get_stylesheet() !== $stylesheet) {
                return ['ok' => false, 'error' => 'WordPress did not switch to the theme.'];
            }
            return ['ok' => true, 'status' => 'active'];
        }
        if ($stylesheet === get_stylesheet()) {
            return ['ok' => false, 'error' => 'The active theme cannot be deleted.'];
        }
        if ($stylesheet === get_template()) {
            return ['ok' => false, 'error' => "The active theme's parent cannot be deleted."];
        }
        self::require_file_mods();
        self::filesystem();
        $result = self::quietly(function () use ($stylesheet) {
            return delete_theme($stylesheet);
        });
        if (is_wp_error($result)) {
            return ['ok' => false, 'error' => self::message($result->get_error_message())];
        }
        if ($result !== true) {
            return ['ok' => false, 'error' => 'WordPress did not delete the theme.'];
        }
        return ['ok' => true, 'status' => 'deleted'];
    }

    /**
     * A plugin or theme from WordPress.org, or from the panel's catalog: a URL under the panel
     * this plugin enrolled with, and nothing else. A plugin is activated unless `activate` is
     * false; a theme only when `activate` is true, as switching themes changes the site.
     */
    private static function install($kind, $params)
    {
        $activate = array_key_exists('activate', $params) ? $params['activate'] : ($kind === 'plugin');
        if (!is_bool($activate)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'activate']);
        }
        $source = self::source_param($params);
        self::require_file_mods();
        self::filesystem();
        $package = self::package($kind, $source);
        if (is_array($package)) {
            return $package;
        }
        WPL7_Connect_Server::long_request(0);
        self::allow_panel_downloads();
        $skin = new WP_Ajax_Upgrader_Skin();
        $upgrader = $kind === 'plugin' ? new Plugin_Upgrader($skin) : new Theme_Upgrader($skin);
        try {
            $result = self::quietly(function () use ($upgrader, $package) {
                return $upgrader->install($package);
            });
            $error = self::upgrade_error($result, null, $skin);
        } catch (Throwable $e) {
            $error = WPL7_Connect_Server::describe($e);
        }
        if ($error !== null) {
            return ['ok' => false, 'error' => $error];
        }
        if ($kind === 'plugin') {
            $file = $upgrader->plugin_info();
            if (!$activate || !is_string($file) || $file === '') {
                return ['ok' => true, 'status' => 'inactive'];
            }
            return self::plugin_action('activate', $file);
        }
        $theme = $upgrader->theme_info();
        if (!$activate || !($theme instanceof WP_Theme)) {
            return ['ok' => true, 'status' => 'inactive'];
        }
        return self::theme_action('activate', $theme);
    }

    /**
     * `source`: { wporg: <slug> } or { url: <a link under the panel's /api/connect/catalog/> }.
     * Anything else, a URL elsewhere included, is 422 `source`.
     */
    private static function source_param($params)
    {
        $source = isset($params['source']) ? $params['source'] : null;
        if (!is_array($source) || count($source) !== 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'source']);
        }
        if (isset($source['url'])) {
            if (!is_string($source['url']) || !WPL7_Connect_Plugin::panel_link($source['url'], '/api/connect/catalog/')) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'source']);
            }
            return $source;
        }
        if (!isset($source['wporg']) || !is_string($source['wporg']) || !preg_match('/^[a-z0-9][a-z0-9_-]{0,199}$/D', $source['wporg'])) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'source']);
        }
        return $source;
    }

    /** The package to install: its URL, or { ok: false, error } when WordPress.org has none. */
    private static function package($kind, $source)
    {
        if (isset($source['url'])) {
            return $source['url'];
        }
        $fields = ['sections' => false, 'reviews' => false, 'banners' => false, 'icons' => false, 'screenshots' => false];
        if ($kind === 'plugin') {
            require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
            $api = plugins_api('plugin_information', ['slug' => $source['wporg'], 'fields' => $fields]);
        } else {
            $api = themes_api('theme_information', ['slug' => $source['wporg'], 'fields' => $fields]);
        }
        if (is_wp_error($api)) {
            return ['ok' => false, 'error' => self::message($api->get_error_message())];
        }
        $link = is_object($api) && isset($api->download_link) && is_string($api->download_link) ? $api->download_link : '';
        if ($link === '') {
            return ['ok' => false, 'error' => 'WordPress.org has no download for ' . $source['wporg'] . '.'];
        }
        return $link;
    }

    // -- What the actions act on -------------------------------------------------------------

    /** A plugin's main file from its inventory name: its folder, or its file for one of one file. */
    private static function find_plugin($slug)
    {
        $names = WPL7_Connect_Inventory::plugin_names(array_keys(get_plugins()));
        $file = array_search($slug, $names, true);
        if (!is_string($file)) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'plugin']);
        }
        return $file;
    }

    /** A theme by its stylesheet (its folder). */
    private static function find_theme($slug)
    {
        $theme = wp_get_theme($slug);
        if (!$theme->exists()) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'theme']);
        }
        return $theme;
    }

    /** The plugin's folder, or its file for a plugin of one file. */
    private static function plugin_path($file)
    {
        return WP_PLUGIN_DIR . '/' . (strpos($file, '/') !== false ? dirname($file) : $file);
    }

    private static function plugin_version($file)
    {
        if (!is_file(WP_PLUGIN_DIR . '/' . $file)) {
            return null;
        }
        $data = get_file_data(WP_PLUGIN_DIR . '/' . $file, ['Version' => 'Version']);
        return self::version_text($data['Version']);
    }

    private static function theme_version($theme)
    {
        $css = untrailingslashit($theme->get_stylesheet_directory()) . '/style.css';
        if (!is_file($css)) {
            return null;
        }
        $data = get_file_data($css, ['Version' => 'Version']);
        return self::version_text($data['Version']);
    }

    /** WordPress's version as its files now say, without loading them. */
    private static function core_version_on_disk()
    {
        $source = @file_get_contents(ABSPATH . WPINC . '/version.php');
        return is_string($source) && preg_match('/^\$wp_version\s*=\s*[\'"]([^\'"]+)[\'"]\s*;/m', $source, $m) ? self::version_text($m[1]) : null;
    }

    private static function version_text($version)
    {
        $version = trim((string) $version);
        return $version === '' ? null : WPL7_Connect_Plugin::cut($version, 64);
    }

    // -- Rollback copies ---------------------------------------------------------------------

    public static function rollback_root()
    {
        return untrailingslashit(wp_normalize_path(WP_CONTENT_DIR)) . '/' . self::ROLLBACK_DIR;
    }

    /**
     * Copies a plugin's or theme's folder (or a plugin's one file) to
     * wp-content/wpl7-rollback/<op>/<plugins|themes>/<name> and records it in the op. A copy that
     * fails is no error: the update goes on, with nothing to roll back to.
     */
    private static function keep_copy($op, $kind, $slug, $source)
    {
        global $wp_filesystem;
        try {
            $source = wp_normalize_path($source);
            $dir = self::rollback_root() . '/' . $op . '/' . ($kind === 'plugin' ? 'plugins' : 'themes');
            $copy = $dir . '/' . self::name_of($source);
            $fs_source = self::fs_path($source);
            $fs_copy = self::fs_path($copy);
            if ($fs_source === false || $fs_copy === false || !self::make_dirs($dir)) {
                return false;
            }
            if ($wp_filesystem->exists($fs_copy)) {
                $wp_filesystem->delete($fs_copy, true);
            }
            $type = $wp_filesystem->is_dir($fs_source) ? 'dir' : 'file';
            if ($type === 'dir') {
                $done = $wp_filesystem->mkdir($fs_copy, FS_CHMOD_DIR) && !is_wp_error(copy_dir($fs_source, $fs_copy));
            } else {
                $done = $wp_filesystem->copy($fs_source, $fs_copy, true, FS_CHMOD_FILE);
            }
            if (!$done) {
                $wp_filesystem->delete($fs_copy, true);
                return false;
            }
        } catch (Throwable $e) {
            return false;
        }
        $record = self::record($op);
        if ($record === null) {
            return false;
        }
        $record['copies'][$kind . ':' . $slug] = ['dest' => $source, 'copy' => $copy, 'type' => $type];
        update_option(self::option($op), $record, false);
        return true;
    }

    /** Puts one recorded copy back: the current folder (or file) goes, the copy takes its place. Null, or why not. */
    private static function restore($copy)
    {
        global $wp_filesystem;
        if (!isset($copy['dest'], $copy['copy'], $copy['type']) || !is_string($copy['dest']) || !is_string($copy['copy'])) {
            return 'No copy to roll back to.';
        }
        // Only what update recorded: a copy under the rollback folder, back into a plugins or themes folder.
        if (!self::inside($copy['copy'], self::rollback_root()) || !self::code_path($copy['dest'])) {
            return 'No copy to roll back to.';
        }
        $from = self::fs_path($copy['copy']);
        $dest = self::fs_path($copy['dest']);
        if ($from === false || $dest === false || !$wp_filesystem->exists($from)) {
            return 'No copy to roll back to.';
        }
        if ($wp_filesystem->exists($dest) && !$wp_filesystem->delete($dest, true)) {
            return 'The current files could not be removed.';
        }
        if ($copy['type'] === 'dir') {
            $moved = function_exists('move_dir') ? move_dir($from, $dest) : $wp_filesystem->move($from, $dest);
            if ($moved !== true) {
                if (!$wp_filesystem->is_dir($dest) && !$wp_filesystem->mkdir($dest, FS_CHMOD_DIR)) {
                    return 'The copy could not be put back.';
                }
                $copied = copy_dir($from, $dest);
                if (is_wp_error($copied)) {
                    return self::message($copied->get_error_message());
                }
            }
        } else {
            if (!$wp_filesystem->move($from, $dest, true) && !$wp_filesystem->copy($from, $dest, true, FS_CHMOD_FILE)) {
                return 'The copy could not be put back.';
            }
        }
        self::forget_compiled($copy['dest']);
        return null;
    }

    /**
     * Tells PHP's opcode cache that the files under $path changed. WordPress does it on updates
     * itself from 5.5 on; before that, and for what this plugin puts back, PHP could go on running
     * the old code for a while, and a broken update would answer as if it were fine.
     */
    private static function forget_compiled($path)
    {
        if (!function_exists('opcache_invalidate') || !is_string($path) || $path === '' || !file_exists($path)) {
            return;
        }
        $restrict = (string) ini_get('opcache.restrict_api');
        if ($restrict !== '' && strpos(__FILE__, $restrict) !== 0) {
            return;
        }
        if (is_file($path)) {
            if (substr($path, -4) === '.php') {
                @opcache_invalidate($path, true);
            }
            return;
        }
        try {
            $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS));
            foreach ($files as $file) {
                if ($file->isFile() && substr($file->getFilename(), -4) === '.php') {
                    @opcache_invalidate($file->getPathname(), true);
                }
            }
        } catch (Exception $e) {
            // A folder that cannot be read keeps what PHP compiled, until PHP looks at it again.
        }
    }

    /** wp-content/wpl7-rollback, with an index.php and an .htaccess so nothing in it is served. */
    private static function make_dirs($dir)
    {
        global $wp_filesystem;
        $root = self::rollback_root();
        $fs_root = self::fs_path($root);
        if ($fs_root === false) {
            return false;
        }
        if (!$wp_filesystem->is_dir($fs_root)) {
            if (!$wp_filesystem->mkdir($fs_root, FS_CHMOD_DIR)) {
                return false;
            }
            $wp_filesystem->put_contents($fs_root . '/index.php', "<?php\n// Silence is golden.\n", FS_CHMOD_FILE);
            $wp_filesystem->put_contents($fs_root . '/.htaccess', "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n"
                . "<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n", FS_CHMOD_FILE);
        }
        $path = $root;
        foreach (explode('/', substr($dir, strlen($root) + 1)) as $part) {
            $path .= '/' . $part;
            $fs = self::fs_path($path);
            if ($fs === false || (!$wp_filesystem->is_dir($fs) && !$wp_filesystem->mkdir($fs, FS_CHMOD_DIR))) {
                return false;
            }
        }
        return true;
    }

    /** Copies and op records older than KEEP_SECONDS: they would never be rolled back to now. */
    private static function expire()
    {
        global $wpdb;
        $cutoff = time() - self::KEEP_SECONDS;
        $names = $wpdb->get_col($wpdb->prepare(
            "SELECT `option_name` FROM `{$wpdb->options}` WHERE `option_name` LIKE %s",
            $wpdb->esc_like(WPL7_Connect_Plugin::OPT_OP_PREFIX) . '%'
        ));
        foreach (is_array($names) ? $names : [] as $name) {
            $record = get_option($name);
            if (!is_array($record) || !isset($record['started']) || (int) $record['started'] < $cutoff) {
                delete_option($name);
            }
        }
        $root = self::rollback_root();
        $entries = @scandir($root);
        foreach (is_array($entries) ? $entries : [] as $name) {
            $dir = $root . '/' . $name;
            if (preg_match(self::OP_RE, $name) && @is_dir($dir) && !@is_link($dir) && self::record($name) === null
                && (int) @filemtime($dir) < $cutoff) {
                self::delete_tree($dir);
            }
        }
    }

    /** Deletes a folder under the rollback folder: through WP_Filesystem when it is set up, else with PHP. */
    private static function delete_tree($path)
    {
        global $wp_filesystem;
        if (!self::inside($path, self::rollback_root())) {
            return false;
        }
        if (is_object($wp_filesystem) && $wp_filesystem instanceof WP_Filesystem_Base) {
            $fs = self::fs_path($path);
            if ($fs !== false && (!$wp_filesystem->exists($fs) || $wp_filesystem->delete($fs, true))) {
                return true;
            }
        }
        return self::unlink_tree($path);
    }

    /** Removes files and folders without following links, which are removed as links. */
    private static function unlink_tree($path)
    {
        $st = @lstat($path);
        if ($st === false) {
            return true;
        }
        if (($st['mode'] & 0170000) === 0040000) {
            $entries = @scandir($path);
            foreach (is_array($entries) ? $entries : [] as $name) {
                if ($name !== '.' && $name !== '..') {
                    self::unlink_tree($path . '/' . $name);
                }
            }
            return @rmdir($path);
        }
        return @unlink($path);
    }

    /**
     * A local path as WP_Filesystem names it. The same for the direct method; over FTP or SSH the
     * server's view of the folders differs, and WordPress's own mapping of its folders is used.
     */
    private static function fs_path($local)
    {
        global $wp_filesystem;
        $local = untrailingslashit(wp_normalize_path($local));
        if (!is_object($wp_filesystem) || $wp_filesystem->method === 'direct') {
            return $local;
        }
        $roots = [
            [WP_PLUGIN_DIR, 'wp_plugins_dir'],
            [WP_CONTENT_DIR, 'wp_content_dir'],
            [ABSPATH, 'abspath'],
        ];
        foreach ($roots as $root) {
            $base = untrailingslashit(wp_normalize_path($root[0]));
            if ($local === $base || strpos($local, $base . '/') === 0) {
                $remote = call_user_func([$wp_filesystem, $root[1]]);
                return is_string($remote) && $remote !== '' ? untrailingslashit($remote) . substr($local, strlen($base)) : false;
            }
        }
        return false;
    }

    /** Whether $path is $root or below it, compared as normalized paths. */
    public static function inside($path, $root)
    {
        $path = untrailingslashit(wp_normalize_path((string) $path));
        $root = untrailingslashit(wp_normalize_path((string) $root));
        return $root !== '' && strpos($path . '/', $root . '/') === 0 && strpos($path, '/../') === false && substr($path, -3) !== '/..';
    }

    /** A plugin's or theme's own place: inside the plugins folder or a theme folder, never one of them itself. */
    private static function code_path($path)
    {
        $roots = [WP_PLUGIN_DIR];
        foreach (isset($GLOBALS['wp_theme_directories']) ? (array) $GLOBALS['wp_theme_directories'] : [WP_CONTENT_DIR . '/themes'] as $root) {
            $roots[] = $root;
        }
        foreach ($roots as $root) {
            if (self::inside($path, $root) && untrailingslashit(wp_normalize_path($path)) !== untrailingslashit(wp_normalize_path($root))) {
                return true;
            }
        }
        return false;
    }

    private static function name_of($path)
    {
        $pos = strrpos($path, '/');
        return $pos === false ? $path : substr($path, $pos + 1);
    }

    // -- Op records --------------------------------------------------------------------------

    private static function option($op)
    {
        return WPL7_Connect_Plugin::OPT_OP_PREFIX . $op;
    }

    private static function record($op)
    {
        $record = get_option(self::option($op));
        return is_array($record) && isset($record['op'], $record['state']) ? $record : null;
    }

    /** An update starts: running, keeping the copies an earlier update under the same op made. */
    private static function begin($op, $kind, $slug, $version)
    {
        global $wp_version;
        $record = self::record($op);
        update_option(self::option($op), [
            'op' => $op,
            'state' => 'running',
            'kind' => $kind,
            'slug' => $slug,
            'version' => $version,
            'from' => $kind === 'core' ? (string) $wp_version : null,
            'started' => time(),
            'copies' => $record !== null && isset($record['copies']) && is_array($record['copies']) ? $record['copies'] : [],
        ], false);
    }

    private static function done($op, $result)
    {
        $record = self::record($op);
        if ($record === null) {
            $record = ['op' => $op, 'started' => time(), 'copies' => []];
        }
        $record['state'] = 'done';
        $record['result'] = $result;
        update_option(self::option($op), $record, false);
        return self::answer($record);
    }

    private static function answer($record)
    {
        $out = ['op' => $record['op'], 'state' => $record['state'] === 'done' ? 'done' : 'running'];
        if ($out['state'] === 'done') {
            $out['result'] = $record['result'];
        }
        return $out;
    }

    private static function result($ok, $from, $to, $rollback, $error)
    {
        $result = ['ok' => (bool) $ok, 'from' => $from, 'to' => $to, 'rollback' => (bool) $rollback];
        if (!$ok) {
            $result['error'] = $error !== null ? $error : 'The update failed.';
        }
        return $result;
    }

    // -- Checks and WordPress's machinery ----------------------------------------------------

    private static function op_param($params)
    {
        if (!isset($params['op']) || !is_string($params['op']) || !preg_match(self::OP_RE, $params['op'])) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'op']);
        }
        return $params['op'];
    }

    private static function slug_param($params)
    {
        if (!isset($params['slug']) || !self::valid_slug($params['slug'])) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'slug']);
        }
        return $params['slug'];
    }

    /** A plugin's or theme's name as the inventory gives it: a folder or file name, `a/b` for a duplicate. */
    private static function valid_slug($slug)
    {
        return is_string($slug) && $slug !== '' && strlen($slug) <= 200 && !preg_match('/[\x00-\x1f\x7f\\\\]/', $slug)
            && strpos($slug, '..') === false && $slug[0] !== '/' && substr($slug, -1) !== '/';
    }

    private static function version_param($params)
    {
        if (!isset($params['version']) || !is_string($params['version']) || !preg_match('/^[0-9][0-9A-Za-z.+-]{0,63}$/D', $params['version'])) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'version']);
        }
        return $params['version'];
    }

    private static function require_admin()
    {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/template.php';
        require_once ABSPATH . 'wp-admin/includes/update.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        if (!function_exists('wp_update_plugins')) {
            require_once ABSPATH . WPINC . '/update.php';
        }
    }

    private static function require_file_mods()
    {
        if (!WPL7_Connect_Info::file_mods()) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'file_mods']);
        }
    }

    /**
     * WP_Filesystem as an update needs it, never asking anyone: the direct method, or FTP or SSH
     * with their details in wp-config.php. request_filesystem_credentials() would print a form
     * for the rest, which no request can fill in.
     */
    private static function filesystem()
    {
        global $wp_filesystem;
        $method = get_filesystem_method();
        $credentials = false;
        if ($method !== 'direct') {
            $credentials = self::quietly(function () use ($method) {
                return request_filesystem_credentials('', $method, false, '', null);
            });
            if (!$credentials) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'filesystem']);
            }
        }
        $ok = self::quietly(function () use ($credentials) {
            return WP_Filesystem(is_array($credentials) ? $credentials : false);
        });
        if (!$ok || !is_object($wp_filesystem) || (is_wp_error($wp_filesystem->errors) && $wp_filesystem->errors->has_errors())) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'filesystem']);
        }
    }

    /**
     * Lets WordPress's downloads reach the panel this plugin enrolled with, where it is on a
     * private network (a panel's own test): wp_safe_remote_get() refuses those addresses. Only
     * that host, only for this request.
     */
    private static function allow_panel_downloads()
    {
        $host = wp_parse_url(WPL7_Connect_Plugin::panel(), PHP_URL_HOST);
        if (!is_string($host) || $host === '' || !WPL7_Connect_Plugin::panel_allowed(WPL7_Connect_Plugin::panel())) {
            return;
        }
        add_filter('http_request_host_is_external', function ($external, $asked) use ($host) {
            return $external || strtolower((string) $asked) === strtolower(trim($host, '[]'));
        }, 10, 2);
    }

    /** Runs $work with everything it prints caught and dropped, buffers it leaves open included. */
    private static function quietly($work)
    {
        $level = ob_get_level();
        ob_start();
        try {
            return $work();
        } finally {
            while (ob_get_level() > $level) {
                ob_end_clean();
            }
        }
    }

    /**
     * WordPress's message for a failed upgrade, or null when it went well. A result that says it
     * went well is believed: bulk_upgrade's install result for the item, install()'s true,
     * Core_Upgrader's new version. Otherwise the result's error, else what the skin collected.
     *
     * @param string|null $key the item, for bulk_upgrade's results by item
     */
    private static function upgrade_error($result, $key, $skin)
    {
        if (is_wp_error($result)) {
            return self::message($result->get_error_message());
        }
        if ($key !== null && is_array($result)) {
            $item = array_key_exists($key, $result) ? $result[$key] : null;
            if (is_wp_error($item)) {
                return self::message($item->get_error_message());
            }
            if ($item === true) {
                // bulk_upgrade's word for "nothing to update".
                return 'No update is available.';
            }
            if (is_array($item)) {
                return null;
            }
        } elseif ($result !== false && $result !== null) {
            return null;
        }
        $errors = $skin->get_errors();
        if (is_wp_error($errors) && $errors->has_errors()) {
            return self::message($skin->get_error_messages());
        }
        return 'WordPress could not finish the change.';
    }

    /** A message from WordPress, as plain text for the panel. */
    private static function message($text)
    {
        $text = html_entity_decode(wp_strip_all_tags((string) $text), ENT_QUOTES, 'UTF-8');
        return WPL7_Connect_Plugin::cut(trim(preg_replace('/\s+/', ' ', $text)), 1000);
    }
}
