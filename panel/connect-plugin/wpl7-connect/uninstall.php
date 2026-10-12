<?php
// Deleting the plugin removes everything it kept: its three tables, its options and transients,
// the copies updates kept to roll back to, and the must-use loader. Deactivating it does not
// touch the connection, so activating the plugin again picks it up.

defined('WP_UNINSTALL_PLUGIN') || exit;

global $wpdb;

foreach (['files', 'nonces', 'log'] as $table) {
    $wpdb->query('DROP TABLE IF EXISTS `' . $wpdb->prefix . 'wpl7_connect_' . $table . '`');
}

foreach ([
    'wpl7_connect_panel',
    'wpl7_connect_connection',
    'wpl7_connect_token',
    'wpl7_connect_key',
    'wpl7_connect_state',
    'wpl7_connect_enrolled',
    'wpl7_connect_since',
    'wpl7_connect_last',
    'wpl7_connect_snapshot',
    'wpl7_connect_offer',
    'wpl7_connect_schema',
    'wpl7_connect_redirect',
    'wpl7_connect_consumed',
] as $option) {
    delete_option($option);
}
// One record per update: wpl7_connect_op_<op>.
$wpdb->query("DELETE FROM `{$wpdb->options}` WHERE `option_name` LIKE 'wpl7\\_connect\\_op\\_%'");
delete_transient('wpl7_connect_auto');

// Messages kept for one user each, for a minute, and login links, for two; with an object cache
// they expire there on their own.
$wpdb->query(
    "DELETE FROM `{$wpdb->options}` WHERE `option_name` LIKE '\\_transient\\_wpl7\\_connect\\_flash\\_%'
    OR `option_name` LIKE '\\_transient\\_timeout\\_wpl7\\_connect\\_flash\\_%'
    OR `option_name` LIKE '\\_transient\\_wpl7\\_connect\\_login\\_%'
    OR `option_name` LIKE '\\_transient\\_timeout\\_wpl7\\_connect\\_login\\_%'"
);

// The copies updates kept: wp-content/wpl7-rollback. Links are removed as links, never followed.
$wpl7_connect_unlink = function ($path) use (&$wpl7_connect_unlink) {
    $st = @lstat($path);
    if ($st === false) {
        return;
    }
    if (($st['mode'] & 0170000) === 0040000) {
        $entries = @scandir($path);
        foreach (is_array($entries) ? $entries : [] as $name) {
            if ($name !== '.' && $name !== '..') {
                $wpl7_connect_unlink($path . '/' . $name);
            }
        }
        @rmdir($path);
        return;
    }
    @unlink($path);
};
$wpl7_connect_unlink(rtrim(WP_CONTENT_DIR, '/') . '/wpl7-rollback');

// The must-use loader, if the file there is this plugin's.
$wpl7_connect_loader = rtrim(WPMU_PLUGIN_DIR, '/') . '/wpl7-connect-loader.php';
$wpl7_connect_head = @is_file($wpl7_connect_loader) ? @file_get_contents($wpl7_connect_loader, false, null, 0, 1024) : false;
if (is_string($wpl7_connect_head) && strpos($wpl7_connect_head, 'Plugin Name: WPL7 Connect loader') !== false) {
    @unlink($wpl7_connect_loader);
}
