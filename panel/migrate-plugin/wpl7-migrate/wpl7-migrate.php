<?php
/**
 * Plugin Name: WPL7 Migrate
 * Description: Connects this site to a WPL7 panel, which then copies the site's files and database.
 * Version: 0.0.0-dev
 * Requires at least: 5.0
 * Requires PHP: 7.0
 * Author: WPL7
 * License: AGPL-3.0-only
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 * Text Domain: wpl7-migrate
 */

// The old site's half of an import into WPL7. The protocol is docs/internal/import-protocol.md in
// the WPL7 repository, and this plugin is maintained with it.
//
// The panel names itself in connection.php, which it writes into the zip it hands out. Activation
// reads that file into options and deletes it. From then on the panel pulls: it signs every
// request with the connection's token, and the plugin answers with the site's facts, its file list,
// file contents and table rows. The plugin calls the panel only from its admin page, to connect and
// to show progress.
//
// This file must still parse on PHP 5: it is what tells an old PHP that the plugin needs 7.0. So
// no closures and no short arrays here; the classes it loads are PHP 7.

defined('ABSPATH') || exit;

define('WPL7_MIGRATE_VERSION', '0.0.0-dev');
define('WPL7_MIGRATE_FILE', __FILE__);

if (version_compare(PHP_VERSION, '7.0', '<')) {
    function wpl7_migrate_refuse_old_php()
    {
        deactivate_plugins(plugin_basename(WPL7_MIGRATE_FILE));
        wp_die(
            esc_html(sprintf(
                /* translators: %s: the PHP version this site runs */
                __('WPL7 Migrate needs PHP 7.0 or later. This site runs PHP %s.', 'wpl7-migrate'),
                PHP_VERSION
            )),
            esc_html__('WPL7 Migrate', 'wpl7-migrate'),
            array('back_link' => true)
        );
    }
    register_activation_hook(__FILE__, 'wpl7_migrate_refuse_old_php');
    return;
}

/**
 * Loads a class of this plugin when it is first used. Most requests to the site only need the
 * maintenance gate and the two transports; the walker, the SQL export and the admin page load
 * when a request needs them.
 */
function wpl7_migrate_autoload($class)
{
    if (strpos($class, 'WPL7_Migrate_') !== 0) {
        return;
    }
    $file = dirname(__FILE__) . '/includes/class-' . strtolower(str_replace('_', '-', $class)) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
}
spl_autoload_register('wpl7_migrate_autoload');

register_activation_hook(__FILE__, array('WPL7_Migrate_Plugin', 'activate'));
register_deactivation_hook(__FILE__, array('WPL7_Migrate_Plugin', 'deactivate'));
WPL7_Migrate_Plugin::boot();
