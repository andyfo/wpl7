<?php
defined('ABSPATH') || exit;

/**
 * One-time login links (docs/internal/connect-protocol.md, login): the panel asks for one, and
 * the browser that opens it is signed in as an administrator. The site keeps only the sha256 of
 * the link's secret, in a transient that lives two minutes and is deleted the first time its
 * selector is presented, so a link works once. As the panel's own login mu-plugin for the sites
 * it hosts (panel/src/services/adminLogin.ts).
 */
final class WPL7_Connect_Login
{
    const TTL = 120;
    /** <selector>.<verifier>: 12 random bytes as hex, then 32 as base64url. */
    const TOKEN_RE = '/^([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/D';
    const TRANSIENT = 'wpl7_connect_login_';

    /** The `login` action: { user? } answers { url, user, expires_in }. */
    public static function action($params)
    {
        $user = null;
        if (array_key_exists('user', $params) && $params['user'] !== null) {
            $user = is_string($params['user']) || is_int($params['user']) ? WPL7_Connect_Rest::find_user((string) $params['user']) : false;
        } else {
            $first = get_users(['role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1]);
            $user = is_array($first) && $first ? $first[0] : false;
        }
        if (!$user || !user_can($user, 'manage_options')) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'user']);
        }
        $selector = bin2hex(random_bytes(12));
        $verifier = WPL7_Connect_Server::base64url_encode(random_bytes(32));
        set_transient(self::TRANSIENT . $selector, wp_json_encode(['u' => (int) $user->ID, 'h' => hash('sha256', $verifier)]), self::TTL);
        return [
            // On the address WordPress serves wp-admin from: the cookie is set for the host the
            // link is opened on, and wp-admin must see it there.
            'url' => site_url('/') . '?wpl7-connect-login=' . $selector . '.' . $verifier,
            'user' => WPL7_Connect_Plugin::utf8_display($user->user_login),
            'expires_in' => self::TTL,
        ];
    }

    /** Whether a token has the link's form. tests/run.php checks it against the vectors. */
    public static function token_parts($token)
    {
        return is_string($token) && preg_match(self::TOKEN_RE, $token, $m) ? [$m[1], $m[2]] : null;
    }

    /**
     * On init at priority 1, for a GET carrying ?wpl7-connect-login. Only a token that matches an
     * unexpired transient signs anyone in; the transient goes the first time its selector is
     * presented, whatever the rest of the check decides. Anything else is the site's ordinary page.
     */
    public static function handle()
    {
        if (!is_string($_GET['wpl7-connect-login'])) {
            return;
        }
        $parts = self::token_parts(wp_unslash($_GET['wpl7-connect-login']));
        if ($parts === null) {
            return;
        }
        $key = self::TRANSIENT . $parts[0];
        $claim = get_transient($key);
        // Burn the token on sight.
        delete_transient($key);
        if (!is_string($claim)) {
            return;
        }
        $data = json_decode($claim, true);
        if (!is_array($data) || empty($data['u']) || !isset($data['h']) || !is_string($data['h'])) {
            return;
        }
        if (!hash_equals($data['h'], hash('sha256', $parts[1]))) {
            return;
        }
        $user = get_user_by('id', (int) $data['u']);
        if (!$user || !user_can($user, 'manage_options')) {
            return;
        }
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        nocache_headers();
        wp_set_current_user($user->ID, $user->user_login);
        wp_set_auth_cookie($user->ID, false);
        do_action('wp_login', $user->user_login, $user);
        wp_safe_redirect(admin_url());
        exit;
    }
}
