<?php
defined('ABSPATH') || exit;

/**
 * Updates of WPL7 Connect itself (docs/internal/connect-protocol.md, Self-update). The panel
 * offers a newer version with `ping`: a version, a package link the panel signed, and when the
 * link expires. While the offer holds, the plugin adds itself to the update_plugins site
 * transient as it is read, and WordPress, WP-CLI and the panel's own `update` see an update for
 * WPL7 Connect like any other. The package comes only from the panel this plugin enrolled with.
 */
final class WPL7_Connect_Selfupdate
{
    const SLUG = 'wpl7-connect';
    const PACKAGE_PATH = '/api/connect/package?';
    const VERSION_RE = '/^[0-9][0-9A-Za-z.+-]{0,63}$/D';

    /**
     * `ping`'s `offer`, kept when it is well formed and its package is on the panel this plugin
     * enrolled with; one from anywhere else is ignored.
     */
    public static function receive($params)
    {
        if (!array_key_exists('offer', $params) || $params['offer'] === null) {
            return;
        }
        $offer = $params['offer'];
        if (!is_array($offer) || !isset($offer['version'], $offer['package'], $offer['expires'])
            || !is_string($offer['version']) || !preg_match(self::VERSION_RE, $offer['version'])
            || !is_string($offer['package']) || !is_int($offer['expires']) || $offer['expires'] < 0) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'offer']);
        }
        if (!self::package_allowed($offer['package'], WPL7_Connect_Plugin::panel())) {
            return;
        }
        update_option(WPL7_Connect_Plugin::OPT_OFFER, [
            'version' => $offer['version'],
            'package' => $offer['package'],
            'expires' => $offer['expires'],
        ], false);
    }

    /** The version of the offer the plugin holds, or null. */
    public static function seen()
    {
        $offer = self::stored();
        return $offer === null ? null : $offer['version'];
    }

    /** Whether a package link is the panel's: under <panel>/api/connect/package?, one line, not too long. */
    public static function package_allowed($package, $panel)
    {
        return WPL7_Connect_Plugin::panel_link($package, self::PACKAGE_PATH, $panel);
    }

    /**
     * The offer to show WordPress now, or null: one that has not expired, is above this plugin's
     * version, and still points at the panel this plugin is bound to.
     */
    public static function current($now = null, $version = null, $panel = null)
    {
        $offer = self::stored();
        $now = $now === null ? time() : $now;
        $version = $version === null ? WPL7_CONNECT_VERSION : $version;
        $panel = $panel === null ? WPL7_Connect_Plugin::panel() : $panel;
        if ($offer === null || $offer['expires'] <= $now || !version_compare($offer['version'], $version, '>')
            || !self::package_allowed($offer['package'], $panel)) {
            return null;
        }
        return $offer;
    }

    private static function stored()
    {
        $offer = get_option(WPL7_Connect_Plugin::OPT_OFFER);
        if (!is_array($offer) || !isset($offer['version'], $offer['package'], $offer['expires'])
            || !is_string($offer['version']) || !is_string($offer['package'])) {
            return null;
        }
        return ['version' => $offer['version'], 'package' => $offer['package'], 'expires' => (int) $offer['expires']];
    }

    /**
     * site_transient_update_plugins: the panel's offer, while it holds, as WordPress's own entry for
     * this plugin. Any other entry for it goes: its updates come from the panel only, and WordPress
     * before 5.8 ignores `Update URI` and would offer a wordpress.org plugin of the same name.
     */
    public static function filter($transient)
    {
        $file = plugin_basename(WPL7_CONNECT_FILE);
        $offer = self::current();
        if ($offer === null) {
            if (is_object($transient) && isset($transient->response) && is_array($transient->response)) {
                unset($transient->response[$file]);
            }
            return $transient;
        }
        if (!is_object($transient)) {
            $transient = new stdClass();
        }
        if (!isset($transient->response) || !is_array($transient->response)) {
            $transient->response = [];
        }
        $transient->response[$file] = (object) [
            'id' => self::SLUG,
            'slug' => self::SLUG,
            'plugin' => $file,
            'new_version' => $offer['version'],
            'package' => $offer['package'],
            'url' => '',
            'tested' => '',
            'requires' => '5.2',
            'requires_php' => '7.0',
            'icons' => [],
            'banners' => [],
            'banners_rtl' => [],
            'compatibility' => new stdClass(),
        ];
        if (isset($transient->no_update) && is_array($transient->no_update)) {
            unset($transient->no_update[$file]);
        }
        return $transient;
    }
}
