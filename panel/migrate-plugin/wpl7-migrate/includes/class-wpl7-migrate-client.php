<?php
defined('ABSPATH') || exit;

/**
 * The plugin's two calls to the panel: connect, which sends the report, and status, which the
 * admin page shows. Both carry the token in X-WPL7-Import-Token, follow no redirect (the token
 * goes to the address the panel gave, and nowhere else) and verify the certificate. Neither goes
 * over plain http unless the panel is on this machine or a private network.
 */
final class WPL7_Migrate_Client
{
    const TIMEOUT = 15;
    const STATUS_TTL = 5;

    public static function https_message()
    {
        return __('The panel address must use https.', 'wpl7-migrate');
    }

    /** Sends a fresh report. ['ok' => bool, 'message' => what went wrong, for the admin page]. */
    public static function connect()
    {
        $panel = WPL7_Migrate_Plugin::panel();
        $token = WPL7_Migrate_Plugin::token();
        if ($panel === '' || $token === '') {
            return ['ok' => false, 'message' => __('Enter the panel address and the connection code.', 'wpl7-migrate')];
        }
        if (!WPL7_Migrate_Plugin::panel_allowed($panel)) {
            return ['ok' => false, 'message' => self::https_message()];
        }
        $report = WPL7_Migrate_Info::report(self::walk_deadline());
        $response = wp_remote_post($panel . '/api/migrate/connect', self::args($token, [
            'Content-Type' => 'application/json; charset=utf-8',
        ], wp_json_encode($report)));
        if (is_wp_error($response)) {
            /* translators: %s: the error, as WordPress's HTTP client gives it */
            return ['ok' => false, 'message' => sprintf(__('The panel cannot be reached: %s', 'wpl7-migrate'), $response->get_error_message())];
        }
        $code = (int) wp_remote_retrieve_response_code($response);
        $json = json_decode(wp_remote_retrieve_body($response), true);
        if ($code === 200 && is_array($json) && !empty($json['ok']) && isset($json['import']['id']) && (int) $json['import']['id'] > 0) {
            update_option(WPL7_Migrate_Plugin::OPT_IMPORT, (int) $json['import']['id'], false);
            update_option(WPL7_Migrate_Plugin::OPT_STATE, WPL7_Migrate_Plugin::STATE_CONNECTED, false);
            update_option(WPL7_Migrate_Plugin::OPT_CONNECTED, [
                'label' => isset($json['import']['label']) && is_string($json['import']['label']) ? $json['import']['label'] : '',
                'panel_version' => isset($json['panel_version']) && is_string($json['panel_version']) ? $json['panel_version'] : '',
                'time' => time(),
            ], false);
            update_option(WPL7_Migrate_Plugin::OPT_FACTS, WPL7_Migrate_Info::facts($report), false);
            delete_transient('wpl7_migrate_status');
            return ['ok' => true, 'message' => ''];
        }
        if ($code === 410) {
            WPL7_Migrate_Plugin::disconnect();
        }
        return ['ok' => false, 'message' => self::failure($code)];
    }

    /**
     * The import as the panel sees it, at most five seconds old. A panel that no longer knows the
     * code (401) or the import (410) has let go of this site, and so does the plugin.
     */
    public static function status()
    {
        $cached = get_transient('wpl7_migrate_status');
        if (is_array($cached)) {
            return $cached;
        }
        $token = WPL7_Migrate_Plugin::token();
        if ($token === '') {
            return ['ok' => false, 'message' => ''];
        }
        if (!WPL7_Migrate_Plugin::panel_allowed(WPL7_Migrate_Plugin::panel())) {
            return ['ok' => false, 'message' => self::https_message()];
        }
        $response = wp_remote_get(WPL7_Migrate_Plugin::panel() . '/api/migrate/status', self::args($token, [], null));
        if (is_wp_error($response)) {
            /* translators: %s: the error, as WordPress's HTTP client gives it */
            $out = ['ok' => false, 'message' => sprintf(__('The panel cannot be reached: %s', 'wpl7-migrate'), $response->get_error_message())];
        } else {
            $code = (int) wp_remote_retrieve_response_code($response);
            $json = json_decode(wp_remote_retrieve_body($response), true);
            if ($code === 200 && is_array($json) && isset($json['status']) && is_string($json['status'])) {
                $out = ['ok' => true, 'status' => $json];
            } else {
                if ($code === 401 || $code === 410) {
                    WPL7_Migrate_Plugin::disconnect();
                }
                $out = ['ok' => false, 'message' => self::failure($code)];
            }
        }
        set_transient('wpl7_migrate_status', $out, self::STATUS_TTL);
        return $out;
    }

    private static function args($token, $headers, $body)
    {
        $args = [
            'timeout' => self::TIMEOUT,
            'redirection' => 0,
            'sslverify' => true,
            'user-agent' => 'WPL7-Migrate/' . WPL7_MIGRATE_VERSION,
            'headers' => array_merge(['Accept' => 'application/json', 'X-WPL7-Import-Token' => $token], $headers),
        ];
        if ($body !== null) {
            $args['body'] = $body;
        }
        return $args;
    }

    private static function failure($code)
    {
        switch ($code) {
            case 401:
                return __('The panel did not accept the connection code.', 'wpl7-migrate');
            case 409:
                return __('The panel refused: this import is running already, or belongs to another site.', 'wpl7-migrate');
            case 410:
                return __('The panel deleted this import.', 'wpl7-migrate');
            case 426:
                return __('This copy of the plugin does not match the panel. Download it again from the panel.', 'wpl7-migrate');
            case 503:
                return __('The panel is busy. Try again in a minute.', 'wpl7-migrate');
        }
        /* translators: %d: an HTTP status code */
        return sprintf(__('The panel answered with HTTP %d.', 'wpl7-migrate'), $code);
    }

    /**
     * How long the report's file count may take on this request, which also waits up to 15 s
     * for the panel. A short max_execution_time is raised where the host allows it.
     */
    private static function walk_deadline()
    {
        $limit = (int) ini_get('max_execution_time');
        // A host may disable set_time_limit(); on PHP 8 calling it then is a fatal error.
        if ($limit > 0 && $limit < 60 && function_exists('set_time_limit') && @set_time_limit(60)) {
            $limit = 60;
        }
        $seconds = $limit > 0 ? min(WPL7_Migrate_Info::WALK_SECONDS, $limit - self::TIMEOUT - 10) : WPL7_Migrate_Info::WALK_SECONDS;
        return microtime(true) + max(2, $seconds);
    }
}
