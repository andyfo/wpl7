// @docs get-started/first-site, sites/wordpress
import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { SiteRow } from '../db/schema.js';
import type { ServerHandle } from '../servers/registry.js';
import { sha256Hex } from '../lib/crypto.js';
import { conflict } from '../lib/errors.js';
import { siteScheme } from './labels.js';

/** Name of the drop-in the panel keeps in every site's wp-content/mu-plugins. */
export const MU_PLUGIN_FILE = 'wpl7-login.php';
/** Where it is, relative to the site's WordPress folder: what a malware scan holds to it. */
export const MU_PLUGIN_PATH = `wp-content/mu-plugins/${MU_PLUGIN_FILE}`;

/** Where the panel notes what it wrote into a site (services/panelFiles.ts). */
export interface PanelFileLog {
  wrote(siteId: number, path: string, content: string): void;
}

/**
 * LEGACY(ceo) - delete in 0.3.0. The drop-in's name before the rename. Two mu-plugins both
 * hooking `init` on the same query parameter would be harmless but confusing, and the old
 * one answers a URL the panel no longer mints, so it is removed whenever the new one is
 * written. Sites that predate the rename get this on the first "Log in to WordPress".
 */
const LEGACY_MU_PLUGIN_FILE = 'ceo-login.php';

/**
 * Lifetime of a minted link: long enough for a redirect plus a first-request certificate
 * handshake, short enough that a link that ends up in a chat log or a proxy access log is
 * already dead. It is single-use on top of that.
 */
export const LOGIN_TOKEN_TTL_SECONDS = 120;

/**
 * The must-use plugin behind the panel's "Log in to WordPress" button. Written as a
 * mu-plugin rather than a real one so it cannot be deactivated by accident, and shipped
 * as source here (not baked into the site image) because /var/www/html is a bind mount:
 * the image's copy would be shadowed by the site directory.
 *
 * String.raw so the PHP is stored byte-for-byte - the token regex contains a backslash
 * escape that a normal template literal would swallow.
 */
export const MU_PLUGIN_SOURCE = String.raw`<?php
/**
 * Plugin Name: WPL7 one-click login
 * Description: Signs an administrator in from the WPL7 control panel, using a
 *              single-use token the panel just minted. Managed file - the panel rewrites
 *              it; edits are lost.
 * Version: 1
 *
 * The panel stores {"u":<user id>,"h":"<sha256 of the verifier>"} in the transient
 * wpl7_login_<selector> and opens <site url>/?wpl7-login=<selector>.<verifier>. Only a
 * request carrying a token that matches an unexpired transient logs anyone in; the
 * transient is deleted the first time its selector is presented, so a link works once.
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('init', static function () {
    if (empty($_GET['wpl7-login']) || !is_string($_GET['wpl7-login'])) {
        return;
    }
    $token = wp_unslash($_GET['wpl7-login']);
    if (!preg_match('/^([0-9a-f]{24})\.([A-Za-z0-9_-]{32,128})$/', $token, $parts)) {
        return;
    }

    $key = 'wpl7_login_' . $parts[1];
    $claim = get_transient($key);
    // Burn the token on sight, whatever the rest of the check decides.
    delete_transient($key);
    if (!is_string($claim)) {
        return;
    }
    $data = json_decode($claim, true);
    if (!is_array($data) || empty($data['u']) || empty($data['h'])) {
        return;
    }
    if (!hash_equals((string) $data['h'], hash('sha256', $parts[2]))) {
        return;
    }
    $user = get_user_by('id', (int) $data['u']);
    if (!$user) {
        return;
    }

    nocache_headers();
    wp_set_current_user($user->ID, $user->user_login);
    wp_set_auth_cookie($user->ID, false);
    do_action('wp_login', $user->user_login, $user);
    wp_safe_redirect(admin_url());
    exit;
}, 1);
`;

export interface AdminLoginLink {
  /** Single-use URL that logs the browser that opens it into wp-admin. */
  url: string;
  /** WordPress login the link signs in as. */
  user: string;
  expiresInSeconds: number;
}

/**
 * Mint a one-click WordPress admin login for a running site.
 *
 * The secret never leaves this process in storable form: WordPress only ever holds the
 * SHA-256 of the verifier, in a transient that expires in two minutes and is deleted the
 * first time its selector is presented. Panel authentication is the gate - anyone who can
 * call this could equally reset the administrator's password through the same API.
 */
export async function createAdminLoginLink(
  server: ServerHandle,
  site: SiteRow,
  config: Config,
  panelFiles?: PanelFileLog,
): Promise<AdminLoginLink> {
  const admin = await pickAdministrator(server, site);
  await ensureMuPlugin(server, site, panelFiles);

  const selector = crypto.randomBytes(12).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  await server.wp.transientSet(
    site.containerName,
    `wpl7_login_${selector}`,
    JSON.stringify({ u: admin.id, h: sha256Hex(verifier) }),
    LOGIN_TOKEN_TTL_SECONDS,
  );

  const base = await loginBaseUrl(server, site, config);
  return { url: `${base}/?wpl7-login=${selector}.${verifier}`, user: admin.login, expiresInSeconds: LOGIN_TOKEN_TTL_SECONDS };
}

/** Who the link signs in: the site's administrator (WpService.siteAdministrator). */
async function pickAdministrator(server: ServerHandle, site: SiteRow): Promise<{ id: number; login: string }> {
  const admin = await server.wp.siteAdministrator(site.containerName, site.wpAdminUser);
  if (!admin) throw conflict('This site has no administrator account to log in as');
  return admin;
}

/**
 * Install/refresh the drop-in. Done on every mint rather than at site creation, so sites
 * that predate the feature - or that were restored from an older backup - get it on first
 * use, and a changed MU_PLUGIN_SOURCE reaches every site without a migration.
 *
 * Written inside the site's container (SiteFilesService.putDropIn), not through the host's
 * copy of the site: a site that turned its mu-plugins folder into a symlink would otherwise
 * have the panel write - as root - wherever that link pointed on the host. Also how a changed
 * copy is put back from the malware scan's findings.
 */
export async function ensureMuPlugin(server: ServerHandle, site: SiteRow, panelFiles?: PanelFileLog): Promise<void> {
  const done = await server.siteFiles.putDropIn(site.containerName, MU_PLUGIN_FILE, MU_PLUGIN_SOURCE, LEGACY_MU_PLUGIN_FILE);
  if (done === 'written' || done === 'same') panelFiles?.wrote(site.id, MU_PLUGIN_PATH, MU_PLUGIN_SOURCE);
}

/**
 * Mint the link on the URL WordPress itself serves wp-admin from. The auth cookie is set
 * for the host the request arrives on and wp-admin redirects to `siteurl`; handing out an
 * alias (or a stale registry domain) would set the cookie on a host the admin screens
 * never see, and the operator would land back on the login form.
 */
async function loginBaseUrl(server: ServerHandle, site: SiteRow, config: Config): Promise<string> {
  const stored = (await server.wp.optionGet(site.containerName, 'siteurl').catch(() => null))?.trim().replace(/\/+$/, '');
  // Kept verbatim when WordPress answers, subdirectory installs included.
  if (stored && /^https?:\/\/[^\s]+$/i.test(stored)) return stored;
  const primary = (JSON.parse(site.domains) as string[])[0] ?? '';
  return `${siteScheme(config.tlsMode)}://${primary}`;
}
