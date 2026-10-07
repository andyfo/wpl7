// @docs sites/wordpress
import { SITE_FILES_ROOT } from '../../shared/siteFilePath.js';
import type { WpPluginRow } from '../../shared/types.js';
import { badGateway, conflict } from '../lib/errors.js';
import { generatePassword } from '../lib/crypto.js';
import { compareVersions } from '../lib/wpVersions.js';
import type { DockerPort, RunResult } from './docker.js';

const phpQuote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * What a fresh WordPress install ships in wp-content/plugins: Akismet Anti-Spam (useless
 * without an API key, and a licence decision that is the customer's to make) and Hello
 * Dolly. Both are removed from every new site - core updates do not bring a deleted
 * bundled plugin back, so this runs once, at install.
 */
export const BUNDLED_PLUGINS = ['akismet', 'hello'] as const;

/**
 * Permalink structure every new site is put on.
 *
 * WordPress tries to enable pretty permalinks itself during `core install`, but it only
 * keeps them if a loopback request to a real post URL comes back carrying the X-Pingback
 * header - and the install deliberately runs while the container has no Traefik router
 * yet, so that probe hits the edge's catch-all 404 and WordPress silently falls back to
 * plain permalinks. That fallback is not cosmetic: with no rewrite rules WordPress matches
 * nothing, while the site image's catch-all .htaccess still hands `/wp-json/...` to
 * index.php - so the REST API answers with the home page under a 200, which breaks every
 * REST client (the WordPress app, headless front ends, site-management services) while the
 * site itself looks perfectly healthy.
 */
export const DEFAULT_PERMALINK_STRUCTURE = '/%postname%/';

/**
 * Who and where a command in a site's container runs - every wp-cli call, and the shell jobs:
 * www-data, in the WordPress folder, HOME in /tmp. Files it creates keep the site's ownership,
 * and the container's no-new-privileges keeps it from becoming anything else.
 */
export function asSiteUser(timeoutMs: number, env: string[] = []) {
  return { user: '33:33', env: ['HOME=/tmp', ...env], workdir: SITE_FILES_ROOT, timeoutMs };
}

/**
 * WP-CLI's `--user` for a change to a site's plugins or themes: the WordPress user (an ID or a
 * login) it runs as, as when an admin makes it in wp-admin. Plugins run code of their own then -
 * an activation hook that makes the user who activated them their owner, an uninstall routine
 * that checks that user may - and without it WP-CLI runs that code as nobody.
 */
const actingAs = (actor: string | undefined): string[] => (actor ? [`--user=${actor}`] : []);

/**
 * WP-CLI operations, executed inside the running site container via docker exec.
 * The wpl7-wordpress image bakes in wp-cli, so PHP version and mail setup always match the site.
 * Exec runs as uid 33 (www-data) so files created by wp-cli keep the right ownership.
 */
export class WpService {
  constructor(private readonly docker: DockerPort) {}

  /**
   * `input` goes to the command's stdin (as UTF-8), then end-of-file: what wp-cli reads for a `-`
   * value or a `--prompt`. `signal` hangs up on a command whose caller went away.
   */
  run(
    container: string,
    args: string[],
    timeoutMs = 120_000,
    opts: {
      env?: string[];
      onOutput?: (line: string) => void;
      outputCap?: number;
      input?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunResult> {
    const exec = {
      // Extra `NAME=value` pairs are how a recipe's PHP step receives a license key: read
      // with getenv(), never spliced into the code it runs.
      ...asSiteUser(timeoutMs, opts.env),
      onOutput: opts.onOutput,
      outputCap: opts.outputCap,
      signal: opts.signal,
    };
    return opts.input === undefined
      ? this.docker.exec(container, ['wp', ...args], exec)
      : this.docker.execWithInput(container, ['wp', ...args], Buffer.from(opts.input, 'utf8'), exec);
  }

  /** Run and throw a bad_gateway AppError when wp-cli exits non-zero. */
  async runOk(container: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
    const res = await this.run(container, args, timeoutMs);
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(0, 2000);
      throw badGateway(`wp ${args[0] ?? ''} failed (exit ${res.exitCode})`, detail);
    }
    return res;
  }

  coreInstall(
    container: string,
    opts: { url: string; title: string; adminUser: string; adminPassword: string; adminEmail: string },
  ): Promise<RunResult> {
    return this.runOk(
      container,
      [
        'core',
        'install',
        `--url=${opts.url}`,
        `--title=${opts.title}`,
        `--admin_user=${opts.adminUser}`,
        `--admin_password=${opts.adminPassword}`,
        `--admin_email=${opts.adminEmail}`,
        '--skip-email',
      ],
      300_000,
    );
  }

  /**
   * Set the permalink structure and flush the rewrite rules (`wp rewrite structure` flushes
   * on its own). Soft flush on purpose: .htaccess already carries the catch-all rule from
   * the site image, and wp-cli could not rewrite it anyway - WordPress only touches that
   * file when it believes it is running under Apache, which it never does from the CLI.
   */
  rewriteStructure(container: string, structure: string = DEFAULT_PERMALINK_STRUCTURE): Promise<RunResult> {
    return this.runOk(container, ['rewrite', 'structure', structure], 60_000);
  }

  /**
   * WordPress's "Search engine visibility" (Settings -> Reading). `blog_public = 0` serves a
   * disallow-all robots.txt and a `noindex` robots meta tag - a request crawlers are free to
   * ignore, not a fence. `core install` has no flag for it, hence a plain option update.
   */
  searchEngineVisibility(container: string, visible: boolean): Promise<void> {
    return this.optionUpdate(container, 'blog_public', visible ? '1' : '0');
  }

  installLocale(container: string, locale: string): Promise<RunResult> {
    return this.runOk(container, ['language', 'core', 'install', locale, '--activate'], 300_000);
  }

  /**
   * Delete the plugins WordPress bundles with a fresh install. Only the ones actually
   * present are passed to wp-cli - it exits non-zero on an unknown plugin, and a site
   * whose bundled plugins are already gone (a restore, a re-run) is not a failure.
   * Returns what was removed.
   */
  async deleteBundledPlugins(container: string, actor?: string): Promise<string[]> {
    const installed = new Set((await this.listPlugins(container)).map((p) => p.name));
    const present = BUNDLED_PLUGINS.filter((name) => installed.has(name));
    if (present.length === 0) return [];
    await this.runOk(container, ['plugin', 'delete', ...present, ...actingAs(actor)], 120_000);
    return [...present];
  }

  installPluginSlug(container: string, slug: string, activate: boolean, actor?: string): Promise<RunResult> {
    return this.runOk(
      container,
      ['plugin', 'install', slug, ...(activate ? ['--activate'] : []), ...actingAs(actor)],
      300_000,
    );
  }

  installPluginZip(container: string, zipPath: string, activate: boolean, actor?: string): Promise<RunResult> {
    return this.runOk(
      container,
      ['plugin', 'install', zipPath, ...(activate ? ['--activate'] : []), ...actingAs(actor)],
      300_000,
    );
  }

  async listPlugins(container: string): Promise<WpPluginRow[]> {
    const res = await this.runOk(
      container,
      ['plugin', 'list', '--format=json', '--fields=name,status,version,update_version'],
      30_000,
    );
    return parseWpJsonArray(res.stdout, 'wp plugin list') as WpPluginRow[];
  }

  /**
   * Everything the inventory snapshot needs about the installed plugins or themes.
   *
   * `list` deletes the update transient and re-asks api.wordpress.org (and any premium
   * plugin's own update server) unless `--skip-update-check` is passed, so this call IS
   * the update check - which is also why it takes seconds rather than milliseconds and
   * belongs in a scheduled job rather than on a page load.
   *
   * `skipExtensions` re-runs the listing with WordPress's own plugins and themes not
   * loaded, which is the only way to inventory a site where one of them fatals under
   * wp-cli. The trade-off is recorded by the caller as a `partial` snapshot: without the
   * plugins loaded, nothing that ships its own updater reports an update.
   */
  async listComponents(
    container: string,
    kind: 'plugin' | 'theme',
    opts: { skipExtensions?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const fields =
      kind === 'plugin'
        ? 'name,title,status,version,update,update_version,auto_update,file'
        : 'name,title,status,version,update,update_version,auto_update';
    const res = await this.runOk(
      container,
      [
        kind,
        'list',
        '--format=json',
        `--fields=${fields}`,
        ...(opts.skipExtensions ? ['--skip-plugins', '--skip-themes'] : []),
      ],
      180_000,
    );
    return parseWpJsonArray(res.stdout, `wp ${kind} list`) as Record<string, unknown>[];
  }

  /**
   * The core update on offer, or null when there is none.
   *
   * With `--format=json` an up-to-date site prints *nothing at all* ("WordPress is at the
   * latest version." is table-format only), so empty output is the answer and not a
   * failure. Several offers can come back (a minor and a major); the newest wins, and its
   * `update_type` is what the UI badges as major or minor.
   */
  async coreCheckUpdate(
    container: string,
    opts: { skipExtensions?: boolean } = {},
  ): Promise<{ version: string; updateType: 'major' | 'minor' | null } | null> {
    const res = await this.run(
      container,
      [
        'core',
        'check-update',
        '--format=json',
        '--fields=version,update_type',
        '--force-check',
        // The same escape hatch the listings have: this command boots WordPress too, so a
        // plugin that fatals on load takes it down with it.
        ...(opts.skipExtensions ? ['--skip-plugins', '--skip-themes'] : []),
      ],
      180_000,
    );
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(0, 500);
      throw badGateway(`wp core check-update failed (exit ${res.exitCode})`, detail);
    }
    if (!res.stdout.includes('[')) return null;
    const rows = parseWpJsonArray(res.stdout, 'wp core check-update') as {
      version?: unknown;
      update_type?: unknown;
    }[];
    let best: { version: string; updateType: 'major' | 'minor' | null } | null = null;
    for (const row of rows) {
      if (typeof row.version !== 'string' || !row.version) continue;
      const type = row.update_type === 'major' || row.update_type === 'minor' ? row.update_type : null;
      if (!best || compareVersions(row.version, best.version) > 0) best = { version: row.version, updateType: type };
    }
    return best;
  }

  themeAction(
    container: string,
    name: string,
    action: 'activate' | 'update' | 'delete',
    actor?: string,
  ): Promise<RunResult> {
    // Never --force: wp-cli refuses to delete the active theme or the active theme's
    // parent, and that refusal is a safety rail the panel wants, not an obstacle.
    return this.runOk(container, ['theme', action, name, ...actingAs(actor)], 300_000);
  }

  /**
   * Update several plugins or themes in one wp-cli call and read the per-item outcome.
   *
   * Deliberately not `runOk`: `update --format=json` exits 1 when ANY item failed, even
   * when most of them succeeded, so the exit code alone would throw away the successes.
   * The returned rows are the truth; `exitCode` is only context for the log.
   */
  async updateMany(
    container: string,
    kind: 'plugin' | 'theme',
    names: string[],
    actor?: string,
  ): Promise<{ rows: WpUpdateResultRow[]; exitCode: number; output: string }> {
    const res = await this.run(container, [kind, 'update', ...names, '--format=json', ...actingAs(actor)], 900_000);
    const output = (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim();
    // "No plugin updates available." with nothing pending, and a plain error message when
    // wp-cli could not run at all - neither is JSON.
    const rows = res.stdout.includes('[')
      ? (parseWpJsonArray(res.stdout, `wp ${kind} update`) as Record<string, unknown>[]).map(toUpdateRow)
      : [];
    return { rows, exitCode: res.exitCode, output };
  }

  async coreVersion(container: string, opts: { skipExtensions?: boolean } = {}): Promise<string | null> {
    const res = await this.run(
      container,
      ['core', 'version', ...(opts.skipExtensions ? ['--skip-plugins', '--skip-themes'] : [])],
      30_000,
    );
    return res.exitCode === 0 ? res.stdout.trim() : null;
  }

  async coreUpdate(container: string): Promise<{ update: RunResult; updateDb: RunResult }> {
    const update = await this.runOk(container, ['core', 'update'], 600_000);
    const updateDb = await this.coreUpdateDb(container);
    return { update, updateDb };
  }

  /** Bring the database up to the WordPress version the files are (a no-op when it already is). */
  coreUpdateDb(container: string): Promise<RunResult> {
    return this.runOk(container, ['core', 'update-db'], 300_000);
  }

  /**
   * Define a constant in the site's wp-config.php (`wp config set`): added above the "stop
   * editing" line, or changed where it already is. `raw` writes the value as PHP - `true`, `42`,
   * `null` - instead of as a quoted string, so the caller must only ever pass a literal it made.
   * A value that starts with `--` would reach WP-CLI as one of its own options, and is refused.
   */
  configSet(container: string, name: string, value: string, opts: { raw?: boolean } = {}): Promise<RunResult> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Not a PHP constant name: ${JSON.stringify(name)}`);
    if (value.startsWith('--')) throw new Error(`Refusing a wp-config.php value that reads as a WP-CLI option: ${name}`);
    return this.runOk(container, ['config', 'set', name, value, '--type=constant', ...(opts.raw ? ['--raw'] : [])], 60_000);
  }

  /** Deactivate plugins (folder names, or the file of a one-file plugin) in one call. */
  pluginDeactivate(container: string, names: string[], actor?: string): Promise<RunResult> {
    for (const name of names) {
      if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Not a plugin name: ${JSON.stringify(name)}`);
    }
    return this.runOk(container, ['plugin', 'deactivate', ...names, ...actingAs(actor)], 300_000);
  }

  pluginAction(
    container: string,
    name: string,
    action: 'activate' | 'deactivate' | 'update' | 'delete',
    actor?: string,
  ): Promise<RunResult> {
    return this.runOk(container, ['plugin', action, name, ...actingAs(actor)], 300_000);
  }

  async resetPassword(container: string, user: string): Promise<string> {
    const password = generatePassword(20);
    await this.runOk(container, ['user', 'update', user, `--user_pass=${password}`], 60_000);
    return password;
  }

  /** `wp maintenance-mode is-active` exits 0 when active, 1 when not - a non-zero exit is normal here. */
  async maintenanceStatus(container: string): Promise<boolean> {
    const res = await this.run(container, ['maintenance-mode', 'is-active'], 30_000);
    return res.exitCode === 0;
  }

  /**
   * `force` re-writes an already-present .maintenance marker (wp-cli refuses otherwise).
   * WordPress stops honouring the marker 10 minutes after it was written, so anything that
   * needs the freeze longer than that has to re-arm it periodically.
   */
  maintenance(container: string, enabled: boolean, opts: { force?: boolean } = {}): Promise<RunResult> {
    return this.runOk(
      container,
      ['maintenance-mode', enabled ? 'activate' : 'deactivate', ...(opts.force ? ['--force'] : [])],
      60_000,
    );
  }

  async optionUpdate(container: string, key: string, value: string): Promise<void> {
    await this.runOk(container, ['option', 'update', key, value], 60_000);
  }

  /** Current value of an option, or null when wp-cli cannot read it. */
  async optionGet(container: string, key: string): Promise<string | null> {
    const res = await this.run(container, ['option', 'get', key], 60_000);
    return res.exitCode === 0 ? res.stdout.trim() : null;
  }

  /** Administrator accounts, oldest first (user id order) - [0] is the install's own admin. */
  async administrators(container: string): Promise<{ id: number; login: string }[]> {
    const res = await this.runOk(
      container,
      ['user', 'list', '--role=administrator', '--fields=ID,user_login', '--format=json', '--orderby=ID', '--order=asc'],
      60_000,
    );
    let rows: { ID: number | string; user_login: string }[];
    try {
      rows = JSON.parse(res.stdout) as typeof rows;
    } catch {
      throw badGateway('wp user list returned unparseable output', res.stdout.slice(0, 500));
    }
    return rows
      .map((r) => ({ id: Number(r.ID), login: String(r.user_login) }))
      .filter((r) => Number.isInteger(r.id) && r.id > 0);
  }

  /**
   * The site's administrator: the one the panel created (`preferredLogin`) while it still exists
   * and is one, else the oldest administrator account - a site whose admin was renamed or replaced
   * by the customer still has someone to act as. Null when it has no administrator at all.
   */
  async siteAdministrator(container: string, preferredLogin: string | null): Promise<{ id: number; login: string } | null> {
    const admins = await this.administrators(container);
    return admins.find((a) => a.login === preferredLogin) ?? admins[0] ?? null;
  }

  /** Store a WordPress transient that expires after `seconds` (single-use login tokens). */
  async transientSet(container: string, key: string, value: string, seconds: number): Promise<void> {
    await this.runOk(container, ['transient', 'set', key, value, String(seconds)], 60_000);
  }

  /** True when a WordPress user with this login exists. */
  async userExists(container: string, login: string): Promise<boolean> {
    const res = await this.run(container, ['user', 'get', login, '--field=user_login'], 60_000);
    return res.exitCode === 0;
  }

  searchReplace(container: string, oldValue: string, newValue: string): Promise<RunResult> {
    return this.runOk(
      container,
      ['search-replace', oldValue, newValue, '--all-tables', '--skip-columns=guid', '--report-changed-only'],
      600_000,
    );
  }

  /** End-to-end mail check: goes through PHPMailer -> PHP mail() -> msmtp -> postfix. */
  async testEmail(container: string, to: string, siteName: string): Promise<RunResult> {
    const code =
      `var_export(wp_mail(${phpQuote(to)}, ` +
      `${phpQuote(`Test email from ${siteName}`)}, ` +
      `${phpQuote('This is a test email sent from the WPL7 control panel. If you can read this, wp_mail() works.')}));`;
    return this.runOk(container, ['eval', code], 60_000);
  }

  cronRunDue(container: string): Promise<RunResult> {
    return this.run(container, ['cron', 'event', 'run', '--due-now'], 300_000);
  }
}

/** One row of `wp plugin|theme update --format=json`. */
export interface WpUpdateResultRow {
  name: string;
  oldVersion: string | null;
  newVersion: string | null;
  /** wp-cli's own word: 'Updated' | 'Error' | … - compared case-insensitively. */
  status: string;
}

function toUpdateRow(raw: Record<string, unknown>): WpUpdateResultRow {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    name: String(raw.name ?? ''),
    // A real run reports old_version/new_version; --dry-run reports version/update_version
    // (wp-cli/extension-command#160). Reading both keeps the parser honest either way.
    oldVersion: str(raw.old_version) ?? str(raw.version),
    newVersion: str(raw.new_version) ?? str(raw.update_version),
    status: String(raw.status ?? ''),
  };
}

/**
 * Parse a wp-cli JSON array out of stdout, tolerating anything printed before or after it.
 *
 * A plugin that emits a PHP notice on load puts that notice ahead of wp-cli's JSON, and a
 * raw `JSON.parse` then fails on output that is perfectly usable - which used to turn one
 * sloppy plugin into "this site has no plugins". Taking the span from the first `[` to the
 * last `]` costs nothing and survives it.
 */
export function parseWpJsonArray(stdout: string, what: string): unknown[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw badGateway(`${what} returned unparseable output`, stdout.trim().slice(0, 500));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw badGateway(`${what} returned unparseable output`, stdout.trim().slice(0, 500));
  }
  if (!Array.isArray(parsed)) {
    throw badGateway(`${what} did not return a JSON array`, stdout.trim().slice(0, 500));
  }
  return parsed;
}

/**
 * What a `wp godmode …` command answered. Every one prints one line of compact JSON on stdout -
 * `{"ok":true,…}`, or `{"ok":false,"error":{"code","message"},…}` with a non-zero exit - and sends
 * PHP's notices to stderr. The plugin only starts catching stray output once WordPress has loaded,
 * so what a noisy plugin prints before that (a database error, an HTML comment, often without a
 * newline) can come before the answer, even on its line: the answer is the last `{"ok":` that
 * parses to the end of its line.
 *
 * `ok: false` comes back as it is: it is WP Godmode's answer (a chat that does not exist, a card
 * that changed), not the panel failing to get one. A site without the plugin's commands is a
 * 409 - it will not change by asking again - and anything else, a fatal error while WordPress
 * loads, a 502 carrying what the command did print.
 */
export function godmodeAnswer(res: RunResult, command: string): Record<string, unknown> {
  const lines = res.stdout.split('\n').reverse();
  for (const line of lines) {
    for (let at = line.indexOf('{"ok":'); at !== -1; at = line.indexOf('{"ok":', at + 1)) {
      try {
        const answer = JSON.parse(line.slice(at)) as unknown;
        if (answer && typeof answer === 'object' && typeof (answer as { ok?: unknown }).ok === 'boolean') {
          return answer as Record<string, unknown>;
        }
      } catch {
        // Not the plugin's answer, or not all of it.
      }
    }
  }
  const printed = { exitCode: res.exitCode, stdout: res.stdout.trim().slice(0, 2000), stderr: res.stderr.trim().slice(0, 2000) };
  const said = `${res.stderr}\n${res.stdout}`;
  // "'godmode' is not a registered wp command", or - a plugin older than the command asked for -
  // "'wait' is not a registered subcommand of 'godmode chat'".
  if (/'godmode' is not a registered wp command|is not a registered subcommand of 'godmode/.test(said)) {
    throw conflict(
      `This site has no \`wp ${command}\`: WP Godmode is not installed, not active, or older than these WP-CLI ` +
        'commands. Install or update the plugin, then try again.',
      printed,
    );
  }
  throw badGateway(`wp ${command} did not answer with WP Godmode's JSON (exit ${res.exitCode})`, printed);
}
