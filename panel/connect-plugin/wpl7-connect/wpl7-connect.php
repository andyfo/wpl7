<?php
/**
 * Plugin Name: WPL7 Connect
 * Description: Connects this site to a WPL7 panel, which then keeps it updated, backed up and watched.
 * Version: 0.0.0-dev
 * Requires at least: 5.2
 * Requires PHP: 7.0
 * Author: WPL7
 * License: AGPL-3.0-only
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 * Text Domain: wpl7-connect
 * Update URI: false
 */

// A site hosted elsewhere, managed from a WPL7 panel. The protocol is
// docs/internal/connect-protocol.md in the WPL7 repository, and this plugin is maintained with it.
//
// The panel names itself in connection.php, which it writes into the zip it hands out: its
// address, the connection's id, an enrollment token and the panel's public key. Activation reads
// that file into options and deletes it, and the admin page then sends the site's report to the
// panel once, with the token. From then on the panel calls: it signs every request with the
// connection's Ed25519 key, of which the site keeps only the public half, and the plugin answers
// with the site's facts, its plugins and themes, its files and tables for a backup, and makes the
// updates and changes the panel asks for. The plugin stays: nothing makes it switch itself off.
//
// `Update URI: false` keeps WordPress.org from offering a plugin of the same name as an update.
// Updates of this plugin come from the panel (class-wpl7-connect-selfupdate.php).
//
// This file must still parse on PHP 5: it is what tells an old PHP that the plugin needs 7.0. So
// no closures and no short arrays here; the classes it loads are PHP 7.

defined('ABSPATH') || exit;

define('WPL7_CONNECT_VERSION', '0.0.0-dev');
define('WPL7_CONNECT_FILE', __FILE__);

if (version_compare(PHP_VERSION, '7.0', '<')) {
    function wpl7_connect_refuse_old_php()
    {
        deactivate_plugins(plugin_basename(WPL7_CONNECT_FILE));
        wp_die(
            esc_html(sprintf(
                /* translators: %s: the PHP version this site runs */
                __('WPL7 Connect needs PHP 7.0 or later. This site runs PHP %s.', 'wpl7-connect'),
                PHP_VERSION
            )),
            esc_html__('WPL7 Connect', 'wpl7-connect'),
            array('back_link' => true)
        );
    }
    register_activation_hook(__FILE__, 'wpl7_connect_refuse_old_php');
    return;
}

/**
 * Loads a class of this plugin when it is first used. Most requests to the site only need the
 * two transports' cheap checks; everything else loads when a request needs it.
 */
function wpl7_connect_autoload($class)
{
    if (strpos($class, 'WPL7_Connect_') !== 0) {
        return;
    }
    $file = dirname(__FILE__) . '/includes/class-' . strtolower(str_replace('_', '-', $class)) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
}
spl_autoload_register('wpl7_connect_autoload');

register_activation_hook(__FILE__, array('WPL7_Connect_Plugin', 'activate'));
register_deactivation_hook(__FILE__, array('WPL7_Connect_Plugin', 'deactivate'));
WPL7_Connect_Plugin::boot();
