<?php
defined('ABSPATH') || exit;

/**
 * The plugin's one call to the panel: enroll, which sends the report with the enrollment token
 * (docs/internal/connect-protocol.md, Plugin to panel). It carries the token in
 * X-WPL7-Connect-Token, follows no redirect (the token goes to the address the panel gave, and
 * nowhere else) and verifies the certificate. It never goes over plain http unless the panel is
 * on this machine or a private network. Only the admin page calls it.
 */
final class WPL7_Connect_Client
{
    const TIMEOUT = 15;

    public static function https_message()
    {
        return __('The panel address must use https.', 'wpl7-connect');
    }

    /** Sends a fresh report. ['ok' => bool, 'message' => what went wrong, for the admin page]. */
    public static function enroll()
    {
        $panel = WPL7_Connect_Plugin::panel();
        $token = WPL7_Connect_Plugin::token();
        if ($panel === '' || $token === '') {
            return ['ok' => false, 'message' => __('Enter the panel address and the connection code.', 'wpl7-connect')];
        }
        if (!WPL7_Connect_Plugin::panel_allowed($panel)) {
            return ['ok' => false, 'message' => self::https_message()];
        }
        $report = WPL7_Connect_Info::report(self::walk_deadline());
        $response = wp_remote_post($panel . '/api/connect/enroll', [
            'timeout' => self::TIMEOUT,
            'redirection' => 0,
            'sslverify' => true,
            'user-agent' => 'WPL7-Connect/' . WPL7_CONNECT_VERSION,
            'headers' => [
                'Accept' => 'application/json',
                'Content-Type' => 'application/json; charset=utf-8',
                'X-WPL7-Connect-Token' => $token,
            ],
            'body' => wp_json_encode($report),
        ]);
        if (is_wp_error($response)) {
            /* translators: %s: the error, as WordPress's HTTP client gives it */
            return ['ok' => false, 'message' => sprintf(__('The panel cannot be reached: %s', 'wpl7-connect'), $response->get_error_message())];
        }
        $code = (int) wp_remote_retrieve_response_code($response);
        $json = json_decode(wp_remote_retrieve_body($response), true);
        if ($code === 200 && is_array($json) && !empty($json['ok']) && isset($json['connection']['id'])
            && is_int($json['connection']['id']) && $json['connection']['id'] > 0) {
            update_option(WPL7_Connect_Plugin::OPT_CONNECTION, $json['connection']['id'], false);
            // A signed request may have arrived while the report was on its way.
            if (WPL7_Connect_Plugin::state() !== WPL7_Connect_Plugin::STATE_CONNECTED) {
                update_option(WPL7_Connect_Plugin::OPT_STATE, WPL7_Connect_Plugin::STATE_ENROLLED, false);
            }
            update_option(WPL7_Connect_Plugin::OPT_ENROLLED, [
                'panel_version' => isset($json['panel_version']) && is_string($json['panel_version']) ? $json['panel_version'] : '',
                'time' => time(),
            ], false);
            return ['ok' => true, 'message' => ''];
        }
        if ($code === 410) {
            WPL7_Connect_Plugin::forget();
        }
        return ['ok' => false, 'message' => self::failure($code)];
    }

    private static function failure($code)
    {
        switch ($code) {
            case 200:
                return __('The panel\'s answer could not be read.', 'wpl7-connect');
            case 401:
                return __('The panel did not accept the connection code. It may have expired: download the plugin again from the panel.', 'wpl7-connect');
            case 409:
                return __('The panel refused: this connection belongs to another site, or the site was added already.', 'wpl7-connect');
            case 410:
                return __('The panel deleted this connection.', 'wpl7-connect');
            case 422:
                return __('The panel could not read this site\'s report.', 'wpl7-connect');
            case 426:
                return __('This copy of the plugin does not match the panel. Download it again from the panel.', 'wpl7-connect');
            case 503:
                return __('The panel is busy. Try again in a minute.', 'wpl7-connect');
        }
        /* translators: %d: an HTTP status code */
        return sprintf(__('The panel answered with HTTP %d.', 'wpl7-connect'), $code);
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
        $seconds = $limit > 0 ? min(WPL7_Connect_Info::WALK_SECONDS, $limit - self::TIMEOUT - 10) : WPL7_Connect_Info::WALK_SECONDS;
        return microtime(true) + max(2, $seconds);
    }
}
