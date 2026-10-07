<?php
defined('ABSPATH') || exit;

/**
 * Tools > WPL7 Migrate. Opening it connects a site that has a code but no connection yet, which
 * after activation (the plugin takes the administrator there) is what makes the site connect on
 * its own. Nothing else ever calls the panel: no cron, no background request.
 */
final class WPL7_Migrate_Admin
{
    const SLUG = 'wpl7-migrate';

    public static function menu()
    {
        add_management_page(
            __('WPL7 Migrate', 'wpl7-migrate'),
            __('WPL7 Migrate', 'wpl7-migrate'),
            'manage_options',
            self::SLUG,
            [__CLASS__, 'render']
        );
    }

    public static function url()
    {
        return admin_url('tools.php?page=' . self::SLUG);
    }

    public static function admin_init()
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        // A new zip uploaded over the plugin while it stays active brings a new connection.php.
        WPL7_Migrate_Plugin::read_connection_file();
        if (get_option(WPL7_Migrate_Plugin::OPT_REDIRECT)) {
            delete_option(WPL7_Migrate_Plugin::OPT_REDIRECT);
            if (!isset($_GET['activate-multi']) && !wp_doing_ajax()) {
                wp_safe_redirect(self::url());
                exit;
            }
        }
    }

    public static function handle_connect()
    {
        self::check('wpl7_migrate_connect');
        $panel = WPL7_Migrate_Plugin::panel_url(isset($_POST['panel']) ? wp_unslash($_POST['panel']) : '');
        $code = isset($_POST['code']) && is_string($_POST['code']) ? trim(wp_unslash($_POST['code'])) : '';
        if ($panel === null) {
            self::flash(__('Enter the panel address, like https://panel.example.com.', 'wpl7-migrate'));
        } elseif (!WPL7_Migrate_Plugin::panel_allowed($panel)) {
            self::flash(WPL7_Migrate_Client::https_message());
        } elseif (!preg_match(WPL7_Migrate_Plugin::TOKEN_RE, $code)) {
            self::flash(__('The connection code is 43 characters long.', 'wpl7-migrate'));
        } else {
            WPL7_Migrate_Plugin::bind($panel, $code);
            self::connect();
        }
        wp_safe_redirect(self::url());
        exit;
    }

    public static function handle_check()
    {
        self::check('wpl7_migrate_check');
        self::connect();
        wp_safe_redirect(self::url());
        exit;
    }

    private static function check($action)
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You cannot change this.', 'wpl7-migrate'), '', ['response' => 403]);
        }
        check_admin_referer($action);
    }

    private static function connect()
    {
        $result = WPL7_Migrate_Client::connect();
        if (!$result['ok']) {
            self::flash($result['message']);
        }
    }

    private static function flash($message)
    {
        set_transient('wpl7_migrate_flash_' . get_current_user_id(), (string) $message, 60);
    }

    public static function render()
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You cannot see this page.', 'wpl7-migrate'), '', ['response' => 403]);
        }
        $key = 'wpl7_migrate_flash_' . get_current_user_id();
        $error = get_transient($key);
        delete_transient($key);
        $state = WPL7_Migrate_Plugin::state();
        // Connects on its own once a minute at most: a panel that is down would otherwise hold
        // every reload of the page for the full timeout.
        if ($state === WPL7_Migrate_Plugin::STATE_BOUND && $error === false && !get_transient('wpl7_migrate_auto')) {
            set_transient('wpl7_migrate_auto', 1, 60);
            $result = WPL7_Migrate_Client::connect();
            $error = $result['ok'] ? false : $result['message'];
            $state = WPL7_Migrate_Plugin::state();
        }
        $status = null;
        if ($state === WPL7_Migrate_Plugin::STATE_CONNECTED) {
            $status = WPL7_Migrate_Client::status();
            $state = WPL7_Migrate_Plugin::state();
        }

        echo '<div class="wrap"><h1>' . esc_html__('WPL7 Migrate', 'wpl7-migrate') . '</h1>';
        if (WPL7_Migrate_Maintenance::active()) {
            self::notice('warning', __('Visitors see a maintenance page while the panel copies the database.', 'wpl7-migrate'));
        }
        if (is_string($error) && $error !== '') {
            self::notice('error', $error);
        }
        switch ($state) {
            case WPL7_Migrate_Plugin::STATE_BOUND:
                self::render_bound();
                break;
            case WPL7_Migrate_Plugin::STATE_CONNECTED:
                self::render_connected($status);
                break;
            case WPL7_Migrate_Plugin::STATE_DISCONNECTED:
                echo '<p>' . esc_html__('Disconnected from the panel.', 'wpl7-migrate') . '</p>';
                self::deactivate_button();
                echo '<details><summary>' . esc_html__('Connect again', 'wpl7-migrate') . '</summary>';
                self::connect_form();
                echo '</details>';
                break;
            default:
                echo '<p>' . esc_html__('Not connected.', 'wpl7-migrate') . '</p>';
                self::connect_form();
        }
        echo '</div>';
    }

    private static function render_bound()
    {
        echo '<p>' . esc_html(sprintf(
            /* translators: %s: the panel's host name */
            __('Panel: %s', 'wpl7-migrate'),
            self::host(WPL7_Migrate_Plugin::panel())
        )) . '</p>';
        self::button_form('wpl7_migrate_check', __('Connect', 'wpl7-migrate'), true);
        echo '<details><summary>' . esc_html__('Use another panel or code', 'wpl7-migrate') . '</summary>';
        self::connect_form();
        echo '</details>';
    }

    private static function render_connected($status)
    {
        $panel = self::host(WPL7_Migrate_Plugin::panel());
        $import = isset($status['status']) && is_array($status['status']) ? $status['status'] : null;
        $name = $import !== null ? $import['status'] : '';
        if ($name === 'done') {
            self::notice('success', __('The site was imported. You can deactivate and delete this plugin.', 'wpl7-migrate'));
            if (!empty($import['siteUrl']) && is_string($import['siteUrl'])) {
                echo '<p>' . esc_html__('Imported site:', 'wpl7-migrate') . ' <a href="' . esc_url($import['siteUrl']) . '">'
                    . esc_html($import['siteUrl']) . '</a></p>';
            }
            self::deactivate_button();
            return;
        }
        /* translators: %s: the panel's host name */
        echo '<p>' . esc_html(sprintf(__('Connected to %s.', 'wpl7-migrate'), $panel)) . '</p>';
        if (in_array($name, ['queued', 'pulling', 'pulled', 'finishing'], true)) {
            self::render_progress($import);
            return;
        }
        if ($name === 'failed') {
            self::notice('error', __('The import stopped on the panel. Continue it there.', 'wpl7-migrate')
                . (!empty($import['message']) && is_string($import['message']) ? ' ' . $import['message'] : ''));
        } elseif ($name === 'expired') {
            self::notice('warning', __('The import expired on the panel. Start a new one there.', 'wpl7-migrate'));
        } elseif ($status !== null && empty($status['ok']) && !empty($status['message'])) {
            /* translators: %s: why the panel's progress could not be read */
            echo '<p>' . esc_html(sprintf(__('Progress unavailable: %s', 'wpl7-migrate'), $status['message'])) . '</p>';
        }
        $connected = get_option(WPL7_Migrate_Plugin::OPT_CONNECTED);
        if (is_array($connected) && !empty($connected['label'])) {
            /* translators: %s: the import's name on the panel */
            echo '<p>' . esc_html(sprintf(__('Import: %s', 'wpl7-migrate'), $connected['label'])) . '</p>';
        }
        self::facts();
        if ($name !== 'failed' && $name !== 'expired') {
            echo '<p>' . esc_html__('Continue on the panel.', 'wpl7-migrate') . '</p>';
        }
        self::button_form('wpl7_migrate_check', __('Check again', 'wpl7-migrate'), false);
    }

    private static function render_progress($import)
    {
        $lines = [
            'queued' => __('Waiting for the panel to start.', 'wpl7-migrate'),
            'pulling' => __('The panel is copying this site.', 'wpl7-migrate'),
            'pulled' => __('Copied. The panel is setting the site up.', 'wpl7-migrate'),
            'finishing' => __('Copied. The panel is setting the site up.', 'wpl7-migrate'),
        ];
        echo '<p><strong>' . esc_html($lines[$import['status']]) . '</strong></p>';
        // Whatever the panel leaves out counts as nothing.
        $import += ['filesDone' => 0, 'filesTotal' => 0, 'bytesDone' => 0, 'bytesTotal' => 0, 'tablesDone' => 0, 'tablesTotal' => 0];
        $rows = [];
        if ((int) $import['filesTotal'] > 0) {
            $rows[__('Files', 'wpl7-migrate')] = sprintf(
                /* translators: 1: files copied, 2: all files, 3: bytes copied, 4: all bytes */
                __('%1$s of %2$s (%3$s of %4$s)', 'wpl7-migrate'),
                number_format_i18n((int) $import['filesDone']),
                number_format_i18n((int) $import['filesTotal']),
                size_format((float) $import['bytesDone'], 1),
                size_format((float) $import['bytesTotal'], 1)
            );
        }
        if ((int) $import['tablesTotal'] > 0) {
            /* translators: 1: tables copied, 2: all tables */
            $rows[__('Tables', 'wpl7-migrate')] = sprintf(__('%1$s of %2$s', 'wpl7-migrate'),
                number_format_i18n((int) $import['tablesDone']), number_format_i18n((int) $import['tablesTotal']));
        }
        self::table($rows);
        // The page follows the panel on its own while it works.
        echo '<script>setTimeout(function () { window.location.reload(); }, 10000);</script>';
    }

    private static function facts()
    {
        $facts = get_option(WPL7_Migrate_Plugin::OPT_FACTS);
        if (!is_array($facts)) {
            return;
        }
        $files = sprintf(
            /* translators: 1: number of files, 2: their size */
            _n('%1$s file, %2$s', '%1$s files, %2$s', (int) $facts['files'], 'wpl7-migrate'),
            number_format_i18n((int) $facts['files']),
            size_format((float) $facts['files_bytes'], 1)
        );
        if (!empty($facts['partial'])) {
            /* translators: %s: files and their size, counted before the count stopped */
            $files = sprintf(__('at least %s', 'wpl7-migrate'), $files);
        }
        self::table([
            __('WordPress', 'wpl7-migrate') => $facts['wp'],
            __('PHP', 'wpl7-migrate') => $facts['php'],
            __('Table prefix', 'wpl7-migrate') => $facts['prefix'],
            __('Files', 'wpl7-migrate') => $files,
            __('Database', 'wpl7-migrate') => sprintf(
                /* translators: 1: number of tables, 2: their size */
                _n('%1$s table, %2$s', '%1$s tables, %2$s', (int) $facts['tables'], 'wpl7-migrate'),
                number_format_i18n((int) $facts['tables']),
                size_format((float) $facts['db_bytes'], 1)
            ),
        ]);
    }

    private static function table($rows)
    {
        if (!$rows) {
            return;
        }
        echo '<table class="form-table" role="presentation"><tbody>';
        foreach ($rows as $label => $value) {
            echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html((string) $value) . '</td></tr>';
        }
        echo '</tbody></table>';
    }

    private static function connect_form()
    {
        $panel = WPL7_Migrate_Plugin::panel();
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="wpl7_migrate_connect">';
        wp_nonce_field('wpl7_migrate_connect');
        echo '<table class="form-table" role="presentation"><tbody>';
        echo '<tr><th scope="row"><label for="wpl7-migrate-panel">' . esc_html__('Panel address', 'wpl7-migrate') . '</label></th>'
            . '<td><input type="url" class="regular-text" id="wpl7-migrate-panel" name="panel" value="' . esc_attr($panel)
            . '" placeholder="https://panel.example.com" required></td></tr>';
        // The code is never shown back: the field starts empty, and the code is not in the page.
        echo '<tr><th scope="row"><label for="wpl7-migrate-code">' . esc_html__('Connection code', 'wpl7-migrate') . '</label></th>'
            . '<td><input type="password" class="regular-text" id="wpl7-migrate-code" name="code" value="" maxlength="43" autocomplete="off" required>'
            . '<p class="description">' . esc_html__('43 characters, from the panel.', 'wpl7-migrate') . '</p></td></tr>';
        echo '</tbody></table>';
        submit_button(__('Connect', 'wpl7-migrate'));
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

    private static function deactivate_button()
    {
        $plugin = plugin_basename(WPL7_MIGRATE_FILE);
        $url = wp_nonce_url(admin_url('plugins.php?action=deactivate&plugin=' . rawurlencode($plugin)), 'deactivate-plugin_' . $plugin);
        echo '<p><a class="button" href="' . esc_url($url) . '">' . esc_html__('Deactivate', 'wpl7-migrate') . '</a></p>';
    }

    private static function notice($type, $message)
    {
        echo '<div class="notice notice-' . esc_attr($type) . '"><p>' . esc_html($message) . '</p></div>';
    }

    private static function host($url)
    {
        $host = wp_parse_url($url, PHP_URL_HOST);
        $port = wp_parse_url($url, PHP_URL_PORT);
        return is_string($host) ? $host . ($port ? ':' . $port : '') : $url;
    }
}
