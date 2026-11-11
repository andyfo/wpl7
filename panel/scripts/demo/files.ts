/**
 * A site's files, as the Files tab sees them: a small virtual tree the demo answers the panel's
 * file scripts from (services/siteFilesScripts.ts list, stat, read, probe), in the record format
 * `find -printf` would print. Nothing is on disk, and nothing a click changes is kept. A WordPress
 * site has WordPress's files; Northwind Bakery has a child theme of its own, which the editor shot
 * opens. The PHP site has its own app's: a Laravel app, its web root `public` among them.
 */
import type { Writable } from 'node:stream';
import { FILE_EXIT, SCRIPTS } from '../../src/services/siteFilesScripts.js';
import type { RunResult } from '../../src/services/docker.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { SITES, isPhp, siteDomains, type DemoSite } from './data.js';

interface Node {
  dir: boolean;
  size: number;
  mtime: number;
  content?: string;
}

const ROOT = '/var/www/html';

const FUNCTIONS_PHP = `<?php
/**
 * Northwind Bakery: a child theme of Twenty Twenty-Five.
 */

add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_style(
		'northwind-style',
		get_stylesheet_uri(),
		array( 'twentytwentyfive-style' ),
		wp_get_theme()->get( 'Version' )
	);
} );

// Opening hours, shown in the footer and on the Visit page.
add_shortcode( 'opening_hours', function () {
	$hours = array(
		'Mon-Fri' => '7:00-18:00',
		'Sat'     => '8:00-16:00',
		'Sun'     => 'closed',
	);
	$out = '<dl class="opening-hours">';
	foreach ( $hours as $days => $time ) {
		$out .= sprintf( '<dt>%s</dt><dd>%s</dd>', esc_html( $days ), esc_html( $time ) );
	}
	return $out . '</dl>';
} );

// Orders placed after 15:00 are baked the next morning.
add_filter( 'woocommerce_get_availability_text', function ( $text, $product ) {
	if ( (int) wp_date( 'G' ) >= 15 ) {
		return __( 'Baked fresh tomorrow morning', 'northwind' );
	}
	return $text;
}, 10, 2 );
`;

const STYLE_CSS = `/*
Theme Name: Northwind
Template: twentytwentyfive
Version: 1.4.0
Text Domain: northwind
*/

.opening-hours {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 0.25rem 1rem;
}
`;

/** The Laravel app's front controller, in its web root. */
const INDEX_PHP = `<?php

use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

// Determine if the application is in maintenance mode...
if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {
    require $maintenance;
}

// Register the Composer autoloader...
require __DIR__.'/../vendor/autoload.php';

// Bootstrap Laravel and handle the request...
(require_once __DIR__.'/../bootstrap/app.php')
    ->handleRequest(Request::capture());
`;

const PUBLIC_HTACCESS = `<IfModule mod_rewrite.c>
    RewriteEngine On

    # Send requests to the front controller...
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^ index.php [L]
</IfModule>
`;

const ROUTES_WEB_PHP = `<?php

use App\\Http\\Controllers\\BikeController;
use App\\Http\\Controllers\\BookingController;
use Illuminate\\Support\\Facades\\Route;

Route::view('/', 'home');
Route::view('/prices', 'prices');
Route::view('/faq', 'faq');
Route::view('/contact', 'contact');

Route::get('/bikes', [BikeController::class, 'index']);
Route::get('/bikes/{kind}', [BikeController::class, 'kind']);

Route::get('/book', [BookingController::class, 'create']);
Route::post('/book', [BookingController::class, 'store']);
Route::get('/my-booking', [BookingController::class, 'show']);
`;

const COMPOSER_JSON = `{
    "name": "bayside/bookings",
    "type": "project",
    "description": "Online bookings for Bayside Bike Rentals.",
    "require": {
        "php": "^8.3",
        "laravel/framework": "^12.0"
    },
    "autoload": {
        "psr-4": {
            "App\\\\": "app/"
        }
    },
    "scripts": {
        "post-autoload-dump": [
            "@php artisan package:discover --ansi"
        ]
    },
    "config": {
        "optimize-autoloader": true,
        "sort-packages": true
    }
}
`;

/** The app's settings: stand-ins for every secret, as the rest of the demo has. */
function dotEnv(site: DemoSite): string {
  const db = `wp_${site.slug.replace(/-/g, '_')}`;
  const domain = siteDomains(site)[0]!;
  return `APP_NAME="${site.title}"
APP_ENV=production
APP_KEY=base64:ZGVtby1ub3QtYS1yZWFsLWtleS0wMDAwMDAwMDAwMDA=
APP_DEBUG=false
APP_URL=https://${domain}

DB_CONNECTION=mariadb
DB_HOST=mariadb
DB_PORT=3306
DB_DATABASE=${db}
DB_USERNAME=${db}
DB_PASSWORD=demo-database-password

CACHE_STORE=redis
SESSION_DRIVER=redis
QUEUE_CONNECTION=database
REDIS_CLIENT=phpredis
REDIS_HOST=/run/wpl7/redis.sock
REDIS_PORT=0

MAIL_MAILER=sendmail
MAIL_SENDMAIL_PATH="/usr/sbin/sendmail -t -i"
MAIL_FROM_ADDRESS=noreply@${domain}
MAIL_FROM_NAME="\${APP_NAME}"
`;
}

/**
 * A PHP site's folder: a Laravel app, uploaded when the site was made and deployed again nine days
 * ago, with `public` as its web root and its code, settings and vendor/ above it.
 */
function phpTree(site: DemoSite): Map<string, Node> {
  const t = new Map<string, Node>();
  const dir = (p: string, age: number) => t.set(p, { dir: true, size: 4096, mtime: ago(age) });
  const file = (p: string, size: number, age: number, content?: string) =>
    t.set(p, { dir: false, size: content ? Buffer.byteLength(content) : size, mtime: ago(age), ...(content ? { content } : {}) });
  const deployed = 9 * DAY;
  const created = site.ageDays * DAY;
  dir('', 2 * HOUR);
  for (const d of ['/app', '/app/Console', '/app/Http', '/app/Http/Controllers', '/app/Models', '/app/Providers', '/config', '/database', '/database/migrations', '/public', '/public/build', '/resources', '/resources/css', '/resources/js', '/resources/views', '/routes', '/vendor']) dir(d, deployed);
  for (const d of ['/bootstrap', '/bootstrap/cache', '/storage', '/storage/app', '/storage/framework']) dir(d, created);
  dir('/storage/logs', 2 * HOUR);
  for (const d of ['/vendor/composer', '/vendor/laravel', '/vendor/symfony', '/vendor/nesbot', '/vendor/monolog']) dir(d, deployed);
  file('/.env', 0, deployed, dotEnv(site));
  file('/artisan', 425, created);
  file('/composer.json', 0, deployed, COMPOSER_JSON);
  file('/composer.lock', 298_412, deployed);
  file('/bootstrap/app.php', 518, created);
  for (const f of ['app.php', 'cache.php', 'database.php', 'mail.php', 'queue.php', 'session.php']) file(`/config/${f}`, 2_400, deployed);
  for (const f of ['BikeController.php', 'BookingController.php']) file(`/app/Http/Controllers/${f}`, 3_100, deployed);
  for (const f of ['Bike.php', 'Booking.php', 'Customer.php', 'User.php']) file(`/app/Models/${f}`, 1_200, deployed);
  file('/public/.htaccess', 0, created, PUBLIC_HTACCESS);
  file('/public/index.php', 0, created, INDEX_PHP);
  file('/public/favicon.ico', 4_286, created);
  file('/public/robots.txt', 24, created);
  file('/routes/web.php', 0, deployed, ROUTES_WEB_PHP);
  file('/routes/console.php', 612, deployed);
  file('/storage/logs/laravel.log', 18_204, 2 * HOUR);
  file('/vendor/autoload.php', 748, deployed);
  return t;
}

function tree(slug: string): Map<string, Node> {
  const php = SITES.find((s) => s.slug === slug && isPhp(s));
  if (php) return phpTree(php);
  const t = new Map<string, Node>();
  const dir = (p: string, age: number) => t.set(p, { dir: true, size: 4096, mtime: ago(age) });
  const file = (p: string, size: number, age: number, content?: string) =>
    t.set(p, { dir: false, size: content ? Buffer.byteLength(content) : size, mtime: ago(age), ...(content ? { content } : {}) });
  dir('', 2 * HOUR);
  for (const d of ['wp-admin', 'wp-includes']) dir(`/${d}`, 30 * DAY);
  dir('/wp-content', 3 * DAY);
  dir('/wp-content/plugins', 3 * DAY);
  dir('/wp-content/themes', 9 * DAY);
  dir('/wp-content/uploads', 2 * HOUR);
  dir('/wp-content/languages', 30 * DAY);
  dir('/wp-content/mu-plugins', 12 * DAY);
  file('/.htaccess', 523, 60 * DAY);
  file('/index.php', 405, 30 * DAY);
  file('/license.txt', 19903, 30 * DAY);
  file('/readme.html', 7425, 30 * DAY);
  file('/wp-activate.php', 7349, 30 * DAY);
  file('/wp-blog-header.php', 351, 30 * DAY);
  file('/wp-comments-post.php', 2323, 30 * DAY);
  file('/wp-config.php', 3346, 60 * DAY);
  file('/wp-cron.php', 5617, 30 * DAY);
  file('/wp-links-opml.php', 2493, 30 * DAY);
  file('/wp-load.php', 3937, 30 * DAY);
  file('/wp-login.php', 51367, 30 * DAY);
  file('/wp-mail.php', 8727, 30 * DAY);
  file('/wp-settings.php', 30081, 30 * DAY);
  file('/wp-signup.php', 34516, 30 * DAY);
  file('/wp-trackback.php', 5102, 30 * DAY);
  file('/xmlrpc.php', 3205, 30 * DAY);
  for (const theme of ['twentytwentyfive']) dir(`/wp-content/themes/${theme}`, 40 * DAY);
  if (slug === 'northwind-bakery') {
    dir('/wp-content/themes/northwind', 47 * MINUTE);
    file('/wp-content/themes/northwind/functions.php', 0, 47 * MINUTE, FUNCTIONS_PHP);
    file('/wp-content/themes/northwind/style.css', 0, 9 * DAY, STYLE_CSS);
    file('/wp-content/themes/northwind/theme.json', 1874, 9 * DAY);
    file('/wp-content/themes/northwind/screenshot.png', 41_233, 9 * DAY);
    dir('/wp-content/themes/northwind/parts', 9 * DAY);
    dir('/wp-content/themes/northwind/templates', 9 * DAY);
  }
  for (const p of ['wordpress-seo', 'contact-form-7', 'redirection', 'woocommerce']) dir(`/wp-content/plugins/${p}`, 3 * DAY);
  return t;
}

const trees = new Map<string, Map<string, Node>>();
const treeOf = (slug: string) => trees.get(slug) ?? trees.set(slug, tree(slug)).get(slug)!;

function record(name: string, node: Node): string {
  const mode = node.dir ? '755' : '644';
  const y = node.dir ? 'd' : 'f';
  return `rw/${y}/${y}/${node.size}/${mode}/${(node.mtime / 1000).toFixed(10)}/33/33/${name}/\0`;
}

const fail = (code: number): RunResult => ({ stdout: '', stderr: '', exitCode: code });

/** Answers one of the panel's file scripts for a site, or null when it is not one of these. */
export function answerFileScript(slug: string, cmd: string[]): { stdout: Buffer | string; exitCode: number; stderr: string } | null {
  if (cmd[0] !== 'sh' || cmd[1] !== '-c') return null;
  const script = cmd[2];
  const args = cmd.slice(4);
  const rel = (abs: string | undefined) => (abs ?? ROOT).replace(ROOT, '').replace(/\/$/, '');
  const t = treeOf(slug);
  if (script === SCRIPTS.list) {
    const at = rel(args[0]);
    const node = t.get(at);
    if (!node) return fail(FILE_EXIT.notFound);
    if (!node.dir) return fail(FILE_EXIT.wrongType);
    const children = [...t.entries()]
      .filter(([p]) => p !== at && p.startsWith(`${at}/`) && !p.slice(at.length + 1).includes('/'))
      .map(([p, n]) => record(p.slice(at.length + 1), n));
    return { stdout: record('', node) + children.join(''), exitCode: 0, stderr: '' };
  }
  if (script === SCRIPTS.stat) {
    const at = rel(args[0]);
    const node = t.get(at);
    if (!node) return fail(FILE_EXIT.notFound);
    return { stdout: record(at.split('/').pop() ?? '', node), exitCode: 0, stderr: '' };
  }
  if (script === SCRIPTS.read || script === SCRIPTS.probe) {
    const node = t.get(rel(args[0]));
    if (!node) return fail(FILE_EXIT.notFound);
    if (script === SCRIPTS.probe) return { stdout: node.dir ? 'd' : `f ${node.size}`, exitCode: 0, stderr: '' };
    if (node.dir) return fail(FILE_EXIT.wrongType);
    return { stdout: node.content ?? `<?php\n// ${rel(args[0]).split('/').pop()}\n`, exitCode: 0, stderr: '' };
  }
  return null;
}

/** `test -d <folder>`, as the site page asks whether a PHP site's web root is there (services/sites.ts). */
export function answerTestDir(slug: string, cmd: string[]): RunResult | null {
  if (cmd.length !== 3 || cmd[0] !== 'test' || cmd[1] !== '-d' || !cmd[2]!.startsWith(ROOT)) return null;
  const at = cmd[2]!.slice(ROOT.length).replace(/\/+$/, '');
  return { stdout: '', stderr: '', exitCode: treeOf(slug).get(at)?.dir ? 0 : 1 };
}

export function writeTo(stdout: Writable, data: Buffer | string): void {
  if (data.length > 0) stdout.write(data);
}
