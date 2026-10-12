<?php
defined('ABSPATH') || exit;

/**
 * Settings > WPL7 Connect. Opening it enrolls a site that has a code but has not enrolled yet,
 * which after activation (the plugin takes the administrator there) is what makes the site enroll
 * on its own. Nothing else ever calls the panel: no cron, no background request. Connected, it is
 * the site owner's view of the panel's requests, and the switch that ends the connection.
 *
 * Everything it prints is escaped: the request log holds names that the site's plugins chose.
 */
final class WPL7_Connect_Admin
{
    const SLUG = 'wpl7-connect';
    const LOG_ROWS = 20;

    public static function menu()
    {
        add_options_page(
            __('WPL7 Connect', 'wpl7-connect'),
            __('WPL7 Connect', 'wpl7-connect'),
            'manage_options',
            self::SLUG,
            [__CLASS__, 'render']
        );
    }

    public static function url()
    {
        return admin_url('options-general.php?page=' . self::SLUG);
    }

    public static function admin_init()
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        // A new zip uploaded over the plugin while it stays active brings a new connection.php,
        // and a new version of the plugin a new loader.
        WPL7_Connect_Plugin::read_connection_file();
        WPL7_Connect_Loader::ensure();
        if (get_option(WPL7_Connect_Plugin::OPT_REDIRECT)) {
            delete_option(WPL7_Connect_Plugin::OPT_REDIRECT);
            if (!isset($_GET['activate-multi']) && !wp_doing_ajax()) {
                wp_safe_redirect(self::url());
                exit;
            }
        }
    }

    public static function handle_connect()
    {
        self::check('wpl7_connect_connect');
        $panel = WPL7_Connect_Plugin::panel_url(isset($_POST['panel']) ? wp_unslash($_POST['panel']) : '');
        $code = isset($_POST['code']) && is_string($_POST['code']) ? trim(wp_unslash($_POST['code'])) : '';
        if ($panel === null) {
            self::flash(__('Enter the panel address, like https://panel.example.com.', 'wpl7-connect'));
        } elseif (!WPL7_Connect_Plugin::panel_allowed($panel)) {
            self::flash(WPL7_Connect_Client::https_message());
        } elseif (!preg_match(WPL7_Connect_Plugin::CODE_RE, $code, $m) || WPL7_Connect_Plugin::key_bytes($m[2]) === null) {
            self::flash(__('The connection code is 87 characters long.', 'wpl7-connect'));
        } else {
            WPL7_Connect_Plugin::bind($panel, $m[1], $m[2]);
            self::enroll();
        }
        wp_safe_redirect(self::url());
        exit;
    }

    public static function handle_check()
    {
        self::check('wpl7_connect_check');
        self::enroll();
        wp_safe_redirect(self::url());
        exit;
    }

    public static function handle_disconnect()
    {
        self::check('wpl7_connect_disconnect');
        WPL7_Connect_Plugin::forget();
        wp_safe_redirect(self::url());
        exit;
    }

    private static function check($action)
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You cannot change this.', 'wpl7-connect'), '', ['response' => 403]);
        }
        check_admin_referer($action);
    }

    private static function enroll()
    {
        $result = WPL7_Connect_Client::enroll();
        if (!$result['ok']) {
            self::flash($result['message']);
        }
    }

    private static function flash($message)
    {
        set_transient('wpl7_connect_flash_' . get_current_user_id(), (string) $message, 60);
    }

    public static function render()
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You cannot see this page.', 'wpl7-connect'), '', ['response' => 403]);
        }
        $key = 'wpl7_connect_flash_' . get_current_user_id();
        $error = get_transient($key);
        delete_transient($key);
        $state = WPL7_Connect_Plugin::state();
        // Enrolls on its own once a minute at most: a panel that is down would otherwise hold
        // every reload of the page for the full timeout.
        if ($state === WPL7_Connect_Plugin::STATE_BOUND && $error === false && !get_transient('wpl7_connect_auto')) {
            set_transient('wpl7_connect_auto', 1, 60);
            $result = WPL7_Connect_Client::enroll();
            $error = $result['ok'] ? false : $result['message'];
            $state = WPL7_Connect_Plugin::state();
        }

        echo '<div class="wrap"><h1>' . esc_html__('WPL7 Connect', 'wpl7-connect') . '</h1>';
        if (is_string($error) && $error !== '') {
            self::notice('error', $error);
        }
        switch ($state) {
            case WPL7_Connect_Plugin::STATE_BOUND:
                self::panel_line();
                self::button_form('wpl7_connect_check', __('Connect', 'wpl7-connect'), true);
                self::other_panel_form();
                break;
            case WPL7_Connect_Plugin::STATE_ENROLLED:
                echo '<p><strong>' . esc_html__('Finish in the panel: Sites > Connect a site.', 'wpl7-connect') . '</strong></p>';
                self::panel_line();
                self::button_form('wpl7_connect_check', __('Check again', 'wpl7-connect'), false);
                self::other_panel_form();
                break;
            case WPL7_Connect_Plugin::STATE_CONNECTED:
                self::render_connected();
                break;
            case WPL7_Connect_Plugin::STATE_DISCONNECTED:
                echo '<p>' . esc_html__('Disconnected from the panel.', 'wpl7-connect') . '</p>';
                echo '<details><summary>' . esc_html__('Connect again', 'wpl7-connect') . '</summary>';
                self::connect_form();
                echo '</details>';
                break;
            default:
                echo '<p>' . esc_html__('Not connected.', 'wpl7-connect') . '</p>';
                self::connect_form();
        }
        echo '</div>';
    }

    private static function render_connected()
    {
        $method = WPL7_Connect_Info::fs_method();
        if ($method !== 'direct' && !WPL7_Connect_Info::fs_credentials_defined()) {
            self::notice('warning', __('Updates need FTP details in wp-config.php.', 'wpl7-connect'));
        }
        if (!WPL7_Connect_Info::file_mods()) {
            self::notice('warning', __('DISALLOW_FILE_MODS is on: the panel cannot update this site.', 'wpl7-connect'));
        }
        if (!WPL7_Connect_Loader::installed()) {
            self::notice('warning', __('Rollback after a broken update is off: wp-content/mu-plugins is not writable.', 'wpl7-connect'));
        }
        $since = (int) get_option(WPL7_Connect_Plugin::OPT_SINCE, 0);
        $last = (int) get_option(WPL7_Connect_Plugin::OPT_LAST, 0);
        echo '<table class="form-table" role="presentation"><tbody>';
        self::row(__('Panel', 'wpl7-connect'), self::host(WPL7_Connect_Plugin::panel()));
        self::row(__('Connected since', 'wpl7-connect'), $since > 0 ? self::when($since) : '');
        self::row(__('Last request', 'wpl7-connect'), $last > 0 ? self::when($last) : '');
        echo '</tbody></table>';

        echo '<h2>' . esc_html__('Recent requests', 'wpl7-connect') . '</h2>';
        $rows = WPL7_Connect_Server::recent(self::LOG_ROWS);
        if (!$rows) {
            echo '<p>' . esc_html__('None yet.', 'wpl7-connect') . '</p>';
        } else {
            echo '<table class="widefat striped"><thead><tr>'
                . '<th scope="col">' . esc_html__('Time', 'wpl7-connect') . '</th>'
                . '<th scope="col">' . esc_html__('Request', 'wpl7-connect') . '</th>'
                . '<th scope="col">' . esc_html__('Result', 'wpl7-connect') . '</th>'
                . '</tr></thead><tbody>';
            foreach ($rows as $row) {
                echo '<tr><td>' . esc_html(self::when((int) $row['at'])) . '</td>'
                    . '<td>' . esc_html((string) $row['summary']) . '</td>'
                    . '<td>' . esc_html((int) $row['ok'] === 1 ? __('Done', 'wpl7-connect') : __('Failed', 'wpl7-connect')) . '</td></tr>';
            }
            echo '</tbody></table>';
        }

        $confirm = __('Disconnect this site from the panel? The panel can then no longer update or back it up.', 'wpl7-connect');
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin-top:1.5em"'
            . ' onsubmit="return window.confirm(\'' . esc_js($confirm) . '\');">';
        echo '<input type="hidden" name="action" value="wpl7_connect_disconnect">';
        wp_nonce_field('wpl7_connect_disconnect');
        submit_button(__('Disconnect', 'wpl7-connect'), 'secondary', 'submit', false);
        echo '</form>';
    }

    private static function panel_line()
    {
        echo '<p>' . esc_html(sprintf(
            /* translators: %s: the panel's host name */
            __('Panel: %s', 'wpl7-connect'),
            self::host(WPL7_Connect_Plugin::panel())
        )) . '</p>';
    }

    private static function other_panel_form()
    {
        echo '<details><summary>' . esc_html__('Use another panel or code', 'wpl7-connect') . '</summary>';
        self::connect_form();
        echo '</details>';
    }

    private static function connect_form()
    {
        $panel = WPL7_Connect_Plugin::panel();
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="wpl7_connect_connect">';
        wp_nonce_field('wpl7_connect_connect');
        echo '<table class="form-table" role="presentation"><tbody>';
        echo '<tr><th scope="row"><label for="wpl7-connect-panel">' . esc_html__('Panel address', 'wpl7-connect') . '</label></th>'
            . '<td><input type="url" class="regular-text" id="wpl7-connect-panel" name="panel" value="' . esc_attr($panel)
            . '" placeholder="https://panel.example.com" required></td></tr>';
        // The code is never shown back: the field starts empty, and the code is not in the page.
        echo '<tr><th scope="row"><label for="wpl7-connect-code">' . esc_html__('Connection code', 'wpl7-connect') . '</label></th>'
            . '<td><input type="password" class="regular-text" id="wpl7-connect-code" name="code" value="" maxlength="87" autocomplete="off" required>'
            . '<p class="description">' . esc_html__('87 characters, from the panel.', 'wpl7-connect') . '</p></td></tr>';
        echo '</tbody></table>';
        submit_button(__('Connect', 'wpl7-connect'));
        echo '</form>';
    }

    private static function button_form($action, $label, $primary)
    {
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="' . esc_attr($action) . '">';
        wp_nonce_field($action);
        submit_button($label, $primary ? 'primary' : 'secondary', 'submit', false);
        echo '</form>';
    }

    private static function row($label, $value)
    {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html($value !== '' ? $value : '–') . '</td></tr>';
    }

    private static function notice($type, $message)
    {
        echo '<div class="notice notice-' . esc_attr($type) . '"><p>' . esc_html($message) . '</p></div>';
    }

    /** A time in the site's date and time format and time zone. */
    private static function when($timestamp)
    {
        $format = get_option('date_format') . ' ' . get_option('time_format');
        if (function_exists('wp_date')) {
            return (string) wp_date($format, $timestamp);
        }
        return (string) date_i18n($format, $timestamp + (int) round((float) get_option('gmt_offset') * HOUR_IN_SECONDS));
    }

    private static function host($url)
    {
        $host = wp_parse_url($url, PHP_URL_HOST);
        $port = wp_parse_url($url, PHP_URL_PORT);
        return is_string($host) ? $host . ($port ? ':' . $port : '') : (string) $url;
    }
}
