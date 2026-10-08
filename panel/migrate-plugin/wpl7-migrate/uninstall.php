<?php
// Deleting the plugin removes everything it kept: its two tables, its options and its transients.
// Deactivating it does not, so an import can go on after the plugin is switched on again.

defined('WP_UNINSTALL_PLUGIN') || exit;

global $wpdb;

$wpdb->query('DROP TABLE IF EXISTS `' . $wpdb->prefix . 'wpl7_migrate_files`');
$wpdb->query('DROP TABLE IF EXISTS `' . $wpdb->prefix . 'wpl7_migrate_nonces`');

foreach ([
    'wpl7_migrate_panel',
    'wpl7_migrate_import',
    'wpl7_migrate_token',
    'wpl7_migrate_state',
    'wpl7_migrate_connected',
    'wpl7_migrate_facts',
    'wpl7_migrate_snapshot',
    'wpl7_migrate_maintenance_until',
    'wpl7_migrate_schema',
    'wpl7_migrate_redirect',
    'wpl7_migrate_consumed',
] as $option) {
    delete_option($option);
}
delete_transient('wpl7_migrate_status');
delete_transient('wpl7_migrate_auto');

// Messages kept for one user each, for a minute; with an object cache they expire there on their own.
$wpdb->query(
    "DELETE FROM `{$wpdb->options}` WHERE `option_name` LIKE '\\_transient\\_wpl7\\_migrate\\_flash\\_%'
    OR `option_name` LIKE '\\_transient\\_timeout\\_wpl7\\_migrate\\_flash\\_%'"
);
