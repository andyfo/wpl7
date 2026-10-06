/**
 * A WordPress site's files, as the Files tab sees them: a small virtual tree the demo answers the
 * panel's file scripts from (services/siteFilesScripts.ts list, stat, read, probe), in the record
 * format `find -printf` would print. Nothing is on disk, and nothing a click changes is kept.
 * Northwind Bakery has a child theme of its own, which the editor shot opens.
 */
import type { Writable } from 'node:stream';
import { FILE_EXIT, SCRIPTS } from '../../src/services/siteFilesScripts.js';
import type { RunResult } from '../../src/services/docker.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';

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

function tree(slug: string): Map<string, Node> {
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

export function writeTo(stdout: Writable, data: Buffer | string): void {
  if (data.length > 0) stdout.write(data);
}
