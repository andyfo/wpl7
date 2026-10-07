<?php
defined('ABSPATH') || exit;

/**
 * Maintenance mode while the panel copies the database: visitors get a 503 with Retry-After, so
 * nothing they do is written to a database that is being read. Administrators and the panel's
 * signed requests pass. It ends on its own: the panel sets a time (an hour by default) and renews
 * it while it works, so a panel that goes away cannot leave the site closed.
 */
final class WPL7_Migrate_Maintenance
{
    const DEFAULT_TTL = 3600;
    const MAX_TTL = 7200;

    public static function until()
    {
        return (int) get_option(WPL7_Migrate_Plugin::OPT_MAINTENANCE, 0);
    }

    public static function active()
    {
        return self::until() > time();
    }

    /** The `maintenance` action: { on, ttl_s? } turns it on until now + ttl_s, or off. */
    public static function action($params)
    {
        if (!isset($params['on']) || !is_bool($params['on'])) {
            throw new WPL7_Migrate_Error(422, 'unsupported', ['detail' => 'on']);
        }
        if (!$params['on']) {
            update_option(WPL7_Migrate_Plugin::OPT_MAINTENANCE, 0);
            return ['on' => false, 'until' => 0];
        }
        $ttl = array_key_exists('ttl_s', $params) ? $params['ttl_s'] : self::DEFAULT_TTL;
        if (!is_int($ttl) || $ttl < 1 || $ttl > self::MAX_TTL) {
            throw new WPL7_Migrate_Error(422, 'unsupported', ['detail' => 'ttl_s']);
        }
        $until = time() + $ttl;
        update_option(WPL7_Migrate_Plugin::OPT_MAINTENANCE, $until);
        return ['on' => true, 'until' => $until];
    }

    /**
     * On init at priority 0, while maintenance is on: before the rest of init, wp_loaded,
     * parse_request and wp, where shop and form plugins save what visitors send. Every request is
     * decided here. Only one the panel signed, for the plugin's own REST route, goes on: the route
     * WordPress would dispatch, URL-decoded and compared without regard to case, as the REST
     * server compares it. It is checked again once the REST server has matched it, and stopped
     * before any template. Administrators and the login page pass.
     */
    public static function gate()
    {
        if (self::exempt()) {
            return;
        }
        $action = self::own_action();
        if ($action !== null) {
            $body = file_get_contents('php://input', false, null, 0, WPL7_Migrate_Server::MAX_BODY + 1);
            if (is_string($body) && WPL7_Migrate_Server::signed($action, $body)) {
                add_filter('rest_pre_dispatch', [__CLASS__, 'rest_gate'], 0, 3);
                add_action('template_redirect', [__CLASS__, 'block'], 0);
                return;
            }
        }
        self::block();
    }

    private static function exempt()
    {
        if ((defined('WP_CLI') && WP_CLI) || WPL7_Migrate_Server::is_query_request()) {
            return true;
        }
        // The login page stays open, or an administrator who is logged out could not get in.
        if (isset($GLOBALS['pagenow']) && $GLOBALS['pagenow'] === 'wp-login.php') {
            return true;
        }
        return current_user_can('manage_options');
    }

    /** The plugin's action this request would reach through the REST API, or null. */
    private static function own_action()
    {
        // Only the front controller serves the REST API, and never inside wp-admin.
        $script = isset($_SERVER['SCRIPT_NAME']) ? basename(wp_unslash($_SERVER['SCRIPT_NAME'])) : '';
        if ($script !== 'index.php' || is_admin()) {
            return null;
        }
        $uri = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '';
        return self::rest_action(
            isset($_POST['rest_route']) ? wp_unslash($_POST['rest_route']) : null,
            isset($_GET['rest_route']) ? wp_unslash($_GET['rest_route']) : null,
            (string) wp_parse_url($uri, PHP_URL_PATH),
            (string) wp_parse_url(home_url('/'), PHP_URL_PATH),
            get_option('permalink_structure') ? rest_get_url_prefix() : null
        );
    }

    /**
     * The action of the plugin's own REST route that WordPress would dispatch a request to, or
     * null. WordPress takes `rest_route` from the POST body before the query string (and refuses
     * a request whose two differ); only without either does a pretty permalink's path,
     * /wp-json/<route> below home's path, give the route. The REST server matches routes
     * without regard to case.
     *
     * @param mixed       $post   $_POST['rest_route'], unslashed, or null
     * @param mixed       $get    $_GET['rest_route'], unslashed, or null
     * @param string      $path   the request's path as sent
     * @param string      $home   the path of home_url('/')
     * @param string|null $prefix the REST prefix with pretty permalinks (`wp-json`), else null
     */
    public static function rest_action($post, $get, $path, $home, $prefix)
    {
        if ($post !== null || $get !== null) {
            if ($post !== null && $get !== null && $post !== $get) {
                return null;
            }
            $route = $post !== null ? $post : $get;
        } elseif ($prefix !== null) {
            $path = rawurldecode($path);
            $home = rtrim($home, '/');
            if ($home !== '' && stripos($path, $home . '/') === 0) {
                $path = substr($path, strlen($home));
            }
            if (!preg_match('#^/(?:index\.php/)?' . preg_quote($prefix, '#') . '(/.*)?$#D', $path, $m)) {
                return null;
            }
            $route = isset($m[1]) ? $m[1] : '/';
        } else {
            return null;
        }
        if (!is_string($route)) {
            return null;
        }
        return preg_match('#^/' . preg_quote(WPL7_Migrate_Server::REST_NAMESPACE, '#') . '/([^/]+)/?$#Di', $route, $m) ? $m[1] : null;
    }

    /** The second line, once the REST server has matched the route: only the plugin's own. */
    public static function rest_gate($result, $server, $request)
    {
        if (stripos($request->get_route(), '/' . WPL7_Migrate_Server::REST_NAMESPACE . '/') === 0) {
            return $result;
        }
        if (!headers_sent()) {
            header('Retry-After: ' . self::retry_after());
        }
        return new WP_Error('wpl7_maintenance', 'Briefly unavailable for maintenance.', ['status' => 503]);
    }

    public static function block()
    {
        if (!headers_sent()) {
            nocache_headers();
            header('Retry-After: ' . self::retry_after());
        }
        wp_die(
            esc_html__('Briefly unavailable for maintenance. Check back in a few minutes.', 'wpl7-migrate'),
            esc_html__('Maintenance', 'wpl7-migrate'),
            ['response' => 503]
        );
    }

    private static function retry_after()
    {
        return max(60, min(3600, self::until() - time()));
    }
}
