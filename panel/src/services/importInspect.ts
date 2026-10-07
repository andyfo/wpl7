import { z } from 'zod';
import {
  CONSTANT_NAME_RE,
  MU_PLUGIN_FILE_RE,
  TABLE_PREFIX_RE,
  WORDPRESS_DROPINS,
  type ImportRunBody,
} from '../../shared/schemas.js';
import type { ImportConstantDto, ImportSuggestionsDto, ImportWarning } from '../../shared/types.js';
import { slugify } from '../lib/slug.js';

/**
 * What the panel makes of an old site before importing it: the report the migration plugin sends
 * (docs/internal/import-protocol.md, A.4) checked and capped, the warnings it gives the admin, and
 * what the Confirm step starts ticked. Pure: no database, no network.
 */

/** The protocol versions this panel speaks. */
export const MIGRATE_PROTOCOL = { min: 1, max: 1 } as const;

const text = (max = 2000) => z.string().max(max);
/** A count or a size. PHP hands numbers out of MySQL as strings; either is taken. */
const count = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const migrateReportSchema = z
  .object({
    protocol: z.number().int(),
    plugin: text(64),
    /** The old site's clock (unix seconds), for the skew the panel signs with. */
    time: z.number().int().optional(),
    endpoint: text(),
    home: text(),
    siteurl: text(),
    abspath: text(),
    /** Null when the host does not say, or the folder cannot be resolved. */
    document_root: text().nullable().optional(),
    content_dir: text(),
    /** Null when WordPress could not work it out. */
    uploads_dir: text().nullable().default(null),
    multisite: z.boolean(),
    windows: z.boolean().default(false),
    table_prefix: text(64),
    wp: text(32),
    php: text(32),
    locale: text(32).default('en_US'),
    charset: text(32).optional(),
    collation: text(64).optional(),
    blog_public: z.union([z.boolean(), z.coerce.number().int()]).transform((v) => (v === true || v === 1 ? 1 : 0)),
    admin_email: text(320).optional(),
    title: text(500).default(''),
    https: z.boolean().optional(),
    db: z
      .object({
        server: text(200),
        bytes: count,
        tables: z
          .array(
            z
              .object({
                name: text(64),
                rows: count.default(0),
                bytes: count.default(0),
                pk: z.array(text(64)).max(64).nullable().default(null),
                collation: text(64).nullable().optional(),
              })
              .loose(),
          )
          .max(5000),
        views: count.default(0),
        triggers: count.default(0),
        routines: count.default(0),
      })
      .loose(),
    files: z
      .object({
        count,
        bytes: count,
        dirs: count.default(0),
        links: count.default(0),
        unreadable: count.default(0),
        excluded: z.array(text(300)).max(200).default([]),
        partial: z.boolean().default(false),
      })
      .loose(),
    constants: z
      .array(
        z
          .object({
            name: text(64),
            value: z.union([text(2000), z.number(), z.boolean(), z.null()]),
            type: z.enum(['string', 'bool', 'int', 'float', 'null']),
          })
          .loose(),
      )
      .max(500)
      .default([]),
    dropins: z.array(text(200)).max(50).default([]),
    mu_plugins: z.array(z.object({ file: text(300), name: text(300).default('') }).loose()).max(500).default([]),
    plugins: z
      .array(
        z
          .object({
            file: text(300),
            slug: text(200),
            name: text(300).default(''),
            version: text(64).default(''),
            active: z.boolean(),
          })
          .loose(),
      )
      .max(2000)
      .default([]),
    theme: z
      .object({ slug: text(200), name: text(300).default(''), version: text(64).default('') })
      .loose()
      .nullable()
      .default(null),
    htaccess: z.object({ present: z.boolean(), custom: z.boolean() }).loose().default({ present: false, custom: false }),
    user_ini: z.boolean().default(false),
    php_ini: z.boolean().default(false),
    warnings: z.array(z.object({ code: text(64), detail: text().optional() }).loose()).max(200).default([]),
  })
  .loose();
export type MigrateReport = z.infer<typeof migrateReportSchema>;

/**
 * Never carried into the new wp-config.php, whatever the old one said: the panel's container
 * sets them (database, keys and salts, addresses, cron), they name the old host's paths, or
 * they make a multisite. The plugin leaves them out of its report; the panel drops them again.
 */
export const CONSTANT_BLOCKLIST = new Set([
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_HOST',
  'DB_CHARSET',
  'DB_COLLATE',
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
  'WP_HOME',
  'WP_SITEURL',
  'ABSPATH',
  'WP_CONTENT_DIR',
  'WP_CONTENT_URL',
  'WP_PLUGIN_DIR',
  'WP_PLUGIN_URL',
  'WPMU_PLUGIN_DIR',
  'WPMU_PLUGIN_URL',
  'UPLOADS',
  'COOKIE_DOMAIN',
  'WP_CACHE',
  'WPCACHEHOME',
  'DISABLE_WP_CRON',
  'WP_TEMP_DIR',
  'FS_METHOD',
  'MULTISITE',
  'WP_ALLOW_MULTISITE',
  'SUBDOMAIN_INSTALL',
  'DOMAIN_CURRENT_SITE',
  'PATH_CURRENT_SITE',
  'SITE_ID_CURRENT_SITE',
  'BLOG_ID_CURRENT_SITE',
]);
const blocked = (name: string) => CONSTANT_BLOCKLIST.has(name) || name.startsWith('FTP_');

/** Carried only when ticked: each one changes how the new site behaves in a way to choose. */
export const UNTICKED_BY_DEFAULT: Record<string, string> = {
  DISALLOW_FILE_MODS: 'Blocks plugin and theme updates in WordPress.',
  WP_DEBUG: 'Debug output on a site that will go live.',
  WP_DEBUG_LOG: 'Writes a debug log into wp-content.',
  WP_DEBUG_DISPLAY: 'Shows PHP errors to visitors.',
  SAVEQUERIES: 'Slows every page down.',
};

/** Names whose values are shown masked: they read like a key, a password, a token or a license. */
const SECRET_NAME_RE = /pass|secret|token|key|salt|auth|licen[cs]e/i;

/**
 * Plugins that talk to their old host's own services - a cache server, a host's CDN - and are
 * suggested for deactivation (by exact slug).
 */
export const HOST_BOUND_PLUGINS = new Set([
  'redis-cache',
  'wp-redis',
  'object-cache-pro',
  'litespeed-cache',
  'sg-cachepress',
  'breeze',
  'nginx-helper',
  'w3-total-cache',
  'wp-super-cache',
  'wpcomsh',
]);

/** Must-use plugins hosts install for themselves, suggested for removal. */
export const HOST_BOUND_MU_PLUGINS_RE =
  /^(wpengine|wpe-|kinsta|flywheel|pantheon|pressable|cloudways|sg-|siteground|endurance|bluehost|wpcomsh|jetpack-mu-wpcom)/i;

/** Drop-ins that plug the old host's cache or database layer in, suggested for removal. */
const HOST_BOUND_DROPINS = new Set(['advanced-cache.php', 'object-cache.php', 'db.php', 'sunrise.php']);

/** Above this, the pull is a matter of hours on most links, and the admin is told. */
const LARGE_BYTES = 20 * 1024 ** 3;

const isDropin = (name: string): name is (typeof WORDPRESS_DROPINS)[number] =>
  (WORDPRESS_DROPINS as readonly string[]).includes(name);

/** `/var/www/html/` and `/var/www/html` are one folder. */
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function urlPath(raw: string): string | null {
  try {
    return trimSlash(new URL(raw).pathname) || '/';
  } catch {
    return null;
  }
}

function bytesText(bytes: number): string {
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return bytes < 1024 ? `${bytes} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** `8.1.27` -> `8.1`. */
export function phpMinor(version: string): string | null {
  return /^(\d+\.\d+)/.exec(version)?.[1] ?? null;
}

/**
 * The offered PHP version for a site that ran `version`: the same minor when offered, else the
 * lowest one above it (code written for an older PHP is likelier to run on the next one than on a
 * previous one), else the newest there is.
 */
export function nearestPhp(version: string, offered: string[]): string | null {
  const sorted = [...offered].sort((a, b) => compareMinor(a, b));
  if (sorted.length === 0) return null;
  const minor = phpMinor(version);
  if (!minor) return sorted.at(-1)!;
  if (sorted.includes(minor)) return minor;
  return sorted.find((v) => compareMinor(v, minor) > 0) ?? sorted.at(-1)!;
}

function compareMinor(a: string, b: string): number {
  const [aMaj = 0, aMin = 0] = a.split('.').map(Number);
  const [bMaj = 0, bMin = 0] = b.split('.').map(Number);
  return aMaj - bMaj || aMin - bMin;
}

/** What a value looks like on the Confirm step: as it is, or masked when the name reads secret. */
function preview(name: string, value: string | number | boolean | null): string {
  const shown = value === null ? 'null' : typeof value === 'string' ? value : String(value);
  if (!SECRET_NAME_RE.test(name)) return shown.length > 120 ? `${shown.slice(0, 117)}…` : shown;
  if (typeof value !== 'string' || value.length === 0) return shown;
  return value.length <= 8 ? '••••' : `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

/** A constant's value as WP-CLI is to write it, or null when it cannot be carried as one. */
export function constantLiteral(c: MigrateReport['constants'][number]): { value: string; raw: boolean } | null {
  switch (c.type) {
    case 'bool':
      return typeof c.value === 'boolean' ? { value: c.value ? 'true' : 'false', raw: true } : null;
    case 'int':
      return typeof c.value === 'number' && Number.isSafeInteger(c.value) ? { value: String(c.value), raw: true } : null;
    case 'float':
      return typeof c.value === 'number' && Number.isFinite(c.value) ? { value: String(c.value), raw: true } : null;
    case 'null':
      return c.value === null ? { value: 'null', raw: true } : null;
    case 'string':
      // WP-CLI would read a value starting with `--` as one of its own options.
      return typeof c.value === 'string' && !c.value.startsWith('--') ? { value: c.value, raw: false } : null;
    default:
      return null;
  }
}

export interface Inspection {
  warnings: ImportWarning[];
  suggestions: ImportSuggestionsDto;
  constants: ImportConstantDto[];
}

/**
 * Everything the Confirm step shows about a reported site. `offeredPhp` is the panel's list;
 * `allowHttp` whether the admin let the import go over plain http.
 */
export function inspectReport(report: MigrateReport, opts: { offeredPhp: string[]; allowHttp: boolean }): Inspection {
  const warnings: ImportWarning[] = [];
  const block = (code: string, message: string) => warnings.push({ code, blocking: true, message });
  const warn = (code: string, message: string) => warnings.push({ code, blocking: false, message });

  if (report.multisite) block('multisite', 'A multisite network. Only single sites can be imported.');
  if (report.windows) block('windows', 'The old site runs on Windows, which the import does not support.');
  if (!TABLE_PREFIX_RE.test(report.table_prefix)) {
    block('table-prefix', `The table prefix "${report.table_prefix}" is not one WordPress allows.`);
  }
  const homePath = urlPath(report.home);
  const sitePath = urlPath(report.siteurl);
  if (homePath === null || sitePath === null) {
    block('address', 'The old site reported an address that is not a URL.');
  } else if (homePath !== '/' || sitePath !== homePath) {
    const where = sitePath !== homePath ? sitePath : homePath;
    block('subdirectory', `WordPress is in the subfolder ${where}. Only sites at the root of their domain can be imported.`);
  }
  const abspath = trimSlash(report.abspath);
  if (trimSlash(report.content_dir) !== `${abspath}/wp-content`) {
    block('content-dir', `wp-content is not in the WordPress folder (${report.content_dir}).`);
  }
  if (report.uploads_dir === null) {
    warn('uploads-dir', 'The old site did not say where its uploads are. Check them after the import.');
  } else {
    const uploads = trimSlash(report.uploads_dir);
    if (!uploads.startsWith(`${abspath}/`)) {
      block('uploads-dir', `Uploads are outside the WordPress folder (${report.uploads_dir}).`);
    } else if (uploads !== `${abspath}/wp-content/uploads`) {
      warn('uploads-dir', `Uploads are in ${uploads.slice(abspath.length + 1)}. Leave Rewrite file paths on.`);
    }
  }

  if (opts.allowHttp && report.home.startsWith('http://')) {
    warn('http-only', 'The old site has no HTTPS: what the panel pulls can be read on the way.');
  }
  const prefix = report.table_prefix;
  const foreign = report.db.tables.filter((t) => !t.name.startsWith(prefix));
  if (foreign.length > 0) {
    warn('foreign-tables', `${plural(foreign.length, 'table')} without the prefix ${prefix} will be left behind.`);
  }
  const noKey = report.db.tables.filter((t) => t.name.startsWith(prefix) && !t.pk?.length);
  if (noKey.length > 0) {
    warn(
      'no-primary-key',
      `${plural(noKey.length, 'table')} without a primary key: rows changed during the copy can be missed (${noKey
        .slice(0, 3)
        .map((t) => t.name)
        .join(', ')}${noKey.length > 3 ? ', …' : ''}).`,
    );
  }
  if (report.files.links > 0) warn('links', `${plural(report.files.links, 'symbolic link')} will be skipped.`);
  if (report.files.unreadable > 0) {
    warn('unreadable', `${plural(report.files.unreadable, 'file')} cannot be read on the old host and will be skipped.`);
  }
  const total = report.files.bytes + report.db.bytes;
  if (total > LARGE_BYTES) warn('large', `The site is ${bytesText(total)}: copying it can take hours.`);
  const php = nearestPhp(report.php, opts.offeredPhp);
  const oldMinor = phpMinor(report.php);
  if (php && oldMinor && oldMinor !== php) {
    warn('php-not-offered', `The old site runs PHP ${oldMinor}, which this panel does not offer. It gets PHP ${php}.`);
  }
  if (report.db.tables.some((t) => /_0900_/.test(t.collation ?? '')) || /_0900_/.test(report.collation ?? '')) {
    warn('mysql8-collation', 'MySQL 8 collations become their MariaDB equivalents.');
  }
  const extras = report.db.views + report.db.triggers + report.db.routines;
  if (extras > 0) {
    warn('views-triggers', `${plural(extras, 'view, trigger or routine', 'views, triggers or routines')} will not be copied.`);
  }
  if (report.htaccess.custom) {
    warn('htaccess-custom', '.htaccess has rules of its own. Check them once the site is up (Files tab).');
  }
  if (report.user_ini || report.php_ini) {
    warn('user-ini', 'PHP settings in .user.ini or php.ini are not used here.');
  }
  if (report.files.partial) warn('partial-count', 'Sizes are estimates: the old host took too long to count.');
  for (const w of report.warnings) {
    if (warnings.some((mine) => mine.code === w.code)) continue;
    warn(w.code, w.detail ? `${w.detail}` : w.code);
  }

  const constants: ImportConstantDto[] = [];
  for (const c of report.constants) {
    if (!CONSTANT_NAME_RE.test(c.name) || blocked(c.name) || constants.some((k) => k.name === c.name)) continue;
    const literal = constantLiteral(c);
    if (!literal) continue;
    const note = UNTICKED_BY_DEFAULT[c.name] ?? null;
    constants.push({ name: c.name, type: c.type, preview: preview(c.name, c.value), ticked: note === null, note });
  }

  const suggestions: ImportSuggestionsDto = {
    title: report.title.trim() || hostOf(report.home) || 'Imported site',
    slug: slugify(hostOf(report.home) ?? report.title),
    phpVersion: php,
    locale: report.locale || 'en_US',
    deactivatePlugins: report.plugins.filter((p) => p.active && HOST_BOUND_PLUGINS.has(p.slug)).map((p) => p.slug),
    removeDropins: report.dropins.filter((d) => isDropin(d) && HOST_BOUND_DROPINS.has(d)),
    removeMuPlugins: report.mu_plugins
      .map((m) => m.file)
      .filter((f) => MU_PLUGIN_FILE_RE.test(f) && HOST_BOUND_MU_PLUGINS_RE.test(f)),
  };
  return { warnings, suggestions, constants };
}

/** What Start import is refused for, or null when it may start. */
export function blockingReason(warnings: ImportWarning[]): string | null {
  return warnings.find((w) => w.blocking)?.message ?? null;
}

/** The choices for a run, checked against what the report says the old site has. */
export function checkChoices(report: MigrateReport, choices: ImportRunBody, constants: ImportConstantDto[]): string | null {
  const names = new Set(constants.map((c) => c.name));
  const unknown = choices.carryConstants.find((n) => !names.has(n));
  if (unknown) return `The old site has no setting ${unknown} that can be carried over.`;
  const plugins = new Set(report.plugins.map((p) => p.slug));
  const plugin = choices.deactivatePlugins.find((p) => !plugins.has(p));
  if (plugin) return `The old site has no plugin ${plugin}.`;
  const dropin = choices.removeDropins.find((d) => !report.dropins.includes(d));
  if (dropin) return `The old site has no drop-in ${dropin}.`;
  const mu = choices.removeMuPlugins.find((m) => !report.mu_plugins.some((x) => x.file === m));
  if (mu) return `The old site has no must-use plugin ${mu}.`;
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
