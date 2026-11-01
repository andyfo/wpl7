/**
 * The script that moves a site's PHP settings for PHP-FPM (services/siteMigration.ts), run by real
 * PHP over a site built on the spot in a temp folder. The samples are what the software really
 * writes: Wordfence's blocks are copied from its code (9.0.2: lib/wfConfig.php, lib/wordfenceClass.php)
 * and cPanel's from files it generated. What Apache and PHP-FPM then make of the result is the engine
 * test's to check. Skipped where there is no PHP.
 *
 * Starting PHP is what costs time here, so most cases are a folder each of one shared site, and every
 * case goes through the same real runs: migrate, migrate again, undo. Nothing the script does in one
 * folder depends on another.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import type { SiteRow } from '../../src/db/schema.js';
import { sites } from '../../src/db/schema.js';
import type { JobContext } from '../../src/jobs/context.js';
import type { RunResult } from '../../src/services/docker.js';
import {
  MAX_LOGGED_LINES,
  MAX_SETTINGS_FILE_BYTES,
  SITE_MIGRATION_SCRIPT,
  migrateSiteForStack2,
  parseMigrationOutput,
  undoSiteMigration,
  type MigrationLine,
} from '../../src/services/siteMigration.js';
import { DEFAULT_UPLOADS_INI, sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;
const HAS_DOCKER_PHP = !HAS_PHP && spawnSync('docker', ['image', 'inspect', 'php:8.4-cli-alpine']).status === 0;
const CAN_RUN = HAS_PHP || HAS_DOCKER_PHP;
// Root can write anything, so the files it can't touch can't be built. Nor do Docker Desktop's bind
// mounts hold a container to a file's mode.
const CAN_LOCK_FILES = HAS_PHP && process.getuid?.() !== 0;

const MOVED = '# Moved to .user.ini by WPL7: ';
const NOT_MOVED = '# Not moved to .user.ini by WPL7: ';
const HANDLER = '# Not used with PHP-FPM, by WPL7: ';
const DENY = '# Replaced by a deny by WPL7: ';
const DENY_BLOCK = '<If "%{REQUEST_FILENAME} =~ /\\.ph(p[0-9]?|tml|ar|t|ps)$/i">\n    Require all denied\n    Satisfy All\n</If>\n';
const INI_MOVED = '; Moved from .htaccess by WPL7: ';
const INI_LEFT = '; Not moved from .htaccess by WPL7: ';
const INI_UNUSED = '; Not used by WPL7: ';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-migration-')));
let serial = 0;

/** Folders a test locked: rm can't go through them. */
function unlockAll(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockAll(path.join(dir, entry.name));
  }
}
afterAll(() => {
  unlockAll(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** PHP with nothing configured but what it is given, the way the throwaway container has it. */
function php(args: string[], env: Record<string, string> = {}) {
  const options = { encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  if (HAS_PHP) return spawnSync('php', args, { ...options, env: { ...process.env, ...env } });
  const user = `${process.getuid!()}:${process.getgid!()}`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  // All of the temp folder: a fake world keeps its site's files in a folder of its own there.
  const everything = fs.realpathSync(os.tmpdir());
  return spawnSync('docker', ['run', '--rm', '--user', user, ...envArgs, '-v', `${everything}:${everything}`, 'php:8.4-cli-alpine', 'php', ...args], options);
}

function put(root: string, rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function makeSite(files: Record<string, string> = {}): string {
  const root = path.join(tmp, `site-${++serial}`);
  fs.mkdirSync(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  return root;
}

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, rel));

function runScript(root: string, mode: string, siteIni: string) {
  const conf = path.join(tmp, `conf-${++serial}`);
  fs.mkdirSync(conf);
  fs.writeFileSync(path.join(conf, 'zz-site.ini'), siteIni);
  const script = SITE_MIGRATION_SCRIPT.replace("const ROOT = '/var/www/html';", `const ROOT = ${JSON.stringify(root)};`);
  // No php.ini in that folder: -c is what keeps the machine's own out of this.
  return php(['-c', conf, '-r', script, mode], { PHP_INI_SCAN_DIR: conf });
}

/** One run of the real script. */
function run(root: string, mode: 'migrate' | 'undo' = 'migrate', siteIni: string = DEFAULT_UPLOADS_INI) {
  const res = runScript(root, mode, siteIni);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  const report = parseMigrationOutput(res.stdout);
  expect(report.summary).not.toBeNull();
  const lines = (level: string) => report.lines.filter((l) => l.level === level);
  return { stdout: res.stdout, summary: report.summary!, changes: lines('change'), warnings: lines('warn') };
}

/** The .user.ini files named, as PHP reads them: this is the scanner PHP-FPM uses for one. */
function inisAsPhpReadsThem(root: string, rels: string[]): Record<string, Record<string, string>> {
  if (rels.length === 0) return {};
  const res = php(['-n', '-r', 'foreach (array_slice($argv, 1) as $f) $out[$f] = (object) @parse_ini_file($f); echo json_encode($out);', ...rels.map((r) => path.join(root, r))]);
  expect(res.stderr).toBe('');
  const out = JSON.parse(res.stdout) as Record<string, Record<string, string>>;
  return Object.fromEntries(rels.map((r) => [r, out[path.join(root, r)]!]));
}

const iniAsPhpReadsIt = (root: string, rel: string): Record<string, string> => inisAsPhpReadsThem(root, [rel])[rel]!;

/** Everything about the site's files that a write would change. */
function fingerprint(root: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const st = fs.lstatSync(file, { bigint: true });
        seen[path.relative(root, file)] = `${st.ino} ${st.mtimeNs} ${st.mode} ${fs.readFileSync(file, 'base64')}`;
      }
    }
  };
  walk(root);
  return seen;
}

/** Each file's text as it stands, by path from the site's top. */
function texts(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  for (const [rel, print] of Object.entries(fingerprint(root))) seen.set(rel, Buffer.from(print.split(' ').pop()!, 'base64').toString('utf8'));
  return seen;
}

interface Outcome {
  /** A file, after the two runs. */
  read(rel: string): string;
  has(rel: string): boolean;
  /** A .user.ini as PHP reads it. */
  ini(rel: string): Record<string, string>;
  afterUndo(rel: string): string;
  changes: MigrationLine[];
  warnings: MigrationLine[];
  said(needle: string): MigrationLine[];
  second: { changes: MigrationLine[]; warnings: MigrationLine[] };
}

/**
 * A site that is many cases, each a folder of its own. The runs happen when the first test needs
 * them, on everything added by then, which is everything: cases are added while tests are collected.
 * The second run is held here, for all of them, to what a second run is.
 */
class SharedSite {
  private readonly root = makeSite();
  private cases = 0;
  private ran: {
    first: ReturnType<typeof run>;
    second: ReturnType<typeof run>;
    migrated: Map<string, string>;
    inis: Record<string, Record<string, string>>;
    undone: Map<string, string>;
  } | null = null;

  /** `firstRunOnly`: for cases that are only about what the first run says. */
  constructor(
    private readonly siteIni: string = DEFAULT_UPLOADS_INI,
    private readonly firstRunOnly = false,
  ) {}

  add(files: Record<string, string> | ((dir: string) => Record<string, string>)): { dir: string; result: () => Outcome } {
    const name = `case-${++this.cases}`;
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir);
    for (const [rel, text] of Object.entries(typeof files === 'function' ? files(dir) : files)) put(dir, rel, text);
    return { dir, result: () => this.outcome(name) };
  }

  private runAll() {
    const first = run(this.root, 'migrate', this.siteIni);
    if (this.firstRunOnly) return { first, second: first, migrated: texts(this.root), inis: {}, undone: new Map<string, string>() };
    const before = fingerprint(this.root);
    const second = run(this.root, 'migrate', this.siteIni);
    expect(fingerprint(this.root)).toEqual(before);
    expect(second.changes).toEqual([]);
    expect(second.summary.written).toBe(0);
    const firstSaid = new Set(first.warnings.map((w) => `${w.path} ${w.what}`));
    for (const w of second.warnings) expect(firstSaid).toContain(`${w.path} ${w.what}`);
    const migrated = texts(this.root);
    const inis = inisAsPhpReadsThem(this.root, [...migrated.keys()].filter((rel) => path.basename(rel) === '.user.ini'));
    run(this.root, 'undo', this.siteIni);
    return { first, second, migrated, inis, undone: texts(this.root) };
  }

  private outcome(name: string): Outcome {
    this.ran ??= this.runAll();
    const { first, second, migrated, inis, undone } = this.ran;
    const mine = (lines: MigrationLine[]) => lines.filter((l) => l.path.startsWith(`${name}/`)).map((l) => ({ ...l, path: l.path.slice(name.length + 1) }));
    const changes = mine(first.changes);
    const warnings = mine(first.warnings);
    return {
      read: (rel) => migrated.get(`${name}/${rel}`) ?? '(no such file)',
      has: (rel) => migrated.has(`${name}/${rel}`),
      ini: (rel) => inis[`${name}/${rel}`] ?? { '(no such file)': rel },
      afterUndo: (rel) => undone.get(`${name}/${rel}`) ?? '(no such file)',
      changes,
      warnings,
      said: (needle) => [...changes, ...warnings].filter((l) => l.what.includes(needle)),
      second: { changes: mine(second.changes), warnings: mine(second.warnings) },
    };
  }
}

// Wordfence's "Disable Code Execution for Uploads", as lib/wfConfig.php writes it.
const WORDFENCE_UPLOADS = `# BEGIN Wordfence code execution protection
<IfModule mod_php5.c>
php_flag engine 0
</IfModule>
<IfModule mod_php7.c>
php_flag engine 0
</IfModule>
<IfModule mod_php.c>
php_flag engine 0
</IfModule>

AddHandler cgi-script .php .phtml .php3 .pl .py .jsp .asp .htm .shtml .sh .cgi
Options -ExecCGI
# END Wordfence code execution protection
`;

// Wordfence's firewall on Apache with mod_php, as lib/wordfenceClass.php writes it.
const wordfenceWaf = (file: string) => `# Wordfence WAF
<IfModule mod_php5.c>
\tphp_value auto_prepend_file '${file}'
</IfModule>
<IfModule mod_php7.c>
\tphp_value auto_prepend_file '${file}'
</IfModule>
<IfModule mod_php.c>
\tphp_value auto_prepend_file '${file}'
</IfModule>
<Files ".user.ini">
<IfModule mod_authz_core.c>
\tRequire all denied
</IfModule>
<IfModule !mod_authz_core.c>
\tOrder deny,allow
\tDeny from all
</IfModule>
</Files>

# END Wordfence WAF
`;

// The same on LiteSpeed.
const wordfenceWafLitespeed = (file: string) => `# Wordfence WAF
<IfModule LiteSpeed>
php_value auto_prepend_file '${file}'
</IfModule>
<IfModule lsapi_module>
php_value auto_prepend_file '${file}'
</IfModule>
# END Wordfence WAF
`;

// And the .user.ini it writes under PHP-FPM.
const wordfenceUserIni = (file: string) => `; Wordfence WAF
auto_prepend_file = '${file}'
; END Wordfence WAF
`;

// Wordfence's fix for full path disclosure.
const WORDFENCE_DISPLAY_ERRORS = '<IfModule mod_php5.c>\n\tphp_value display_errors 0\n</IfModule>\n<IfModule mod_php7.c>\n\tphp_value display_errors 0\n</IfModule>\n<IfModule mod_php.c>\n\tphp_value display_errors 0\n</IfModule>';

// A cPanel account's .htaccess and .user.ini, from its MultiPHP INI Editor.
const CPANEL_HTACCESS = `# php -- BEGIN cPanel-generated handler, do not edit
# Set the “ea-php81” package as the default “PHP” programming language.
<IfModule mime_module>
  AddHandler application/x-httpd-ea-php81 .php .php8 .phtml
</IfModule>
# php -- END cPanel-generated handler, do not edit

# BEGIN cPanel-generated php ini directives, do not edit
# Manual editing of this file may result in unexpected behavior.
# To make changes to this file, use the cPanel MultiPHP INI Editor (Home >> Software >> MultiPHP INI Editor)
# For more information, read our documentation (https://go.cpanel.net/EA4ModifyINI)
<IfModule php8_module>
   php_flag display_errors Off
   php_value max_execution_time 30
   php_value max_input_time 600
   php_value max_input_vars 10000
   php_value memory_limit 512M
   php_value post_max_size 8M
   php_value session.gc_maxlifetime 1440
   php_value session.save_path "/var/cpanel/php/sessions/ea-php81"
   php_value upload_max_filesize 200M
   php_flag zlib.output_compression Off
</IfModule>
<IfModule lsapi_module>
   php_flag display_errors Off
   php_value max_execution_time 30
   php_value max_input_time 600
   php_value max_input_vars 10000
   php_value memory_limit 512M
   php_value post_max_size 8M
   php_value session.gc_maxlifetime 1440
   php_value session.save_path "/var/cpanel/php/sessions/ea-php81"
   php_value upload_max_filesize 200M
   php_flag zlib.output_compression Off
</IfModule>
# END cPanel-generated php ini directives, do not edit
`;

const CPANEL_USER_INI = `; cPanel-generated php ini directives, do not edit
; Manual editing of this file may result in unexpected behavior.
; To make changes to this file, use the cPanel MultiPHP INI Editor (Home >> Software >> MultiPHP INI Editor)
; For more information, read our documentation (https://go.cpanel.net/EA4ModifyINI)

[PHP]
display_errors = Off
max_execution_time = 30
max_input_time = 60
max_input_vars = 1000
memory_limit = 128M
post_max_size = 16M
session.gc_maxlifetime = 1440
session.save_path = "/var/cpanel/php/sessions/ea-php73"
upload_max_filesize = 8M
zlib.output_compression = On
`;

const S = new SharedSite();
const addHtaccess = (text: string) => S.add({ '.htaccess': text });

describe.skipIf(!CAN_RUN)('a php_value or php_flag in a .htaccess', () => {
  const simple = addHtaccess('# BEGIN WordPress\nRewriteEngine On\n# END WordPress\nphp_value memory_limit 512M\n');
  it('moves to the .user.ini beside it, and the line is commented out with the mark', () => {
    const r = simple.result();
    expect(r.read('.htaccess')).toBe(`# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n${MOVED}php_value memory_limit 512M\n`);
    expect(r.read('.user.ini')).toBe(`${INI_MOVED}php_value memory_limit 512M\nmemory_limit = '512M'\n`);
    expect(r.changes.map((c) => [c.path, c.line, c.what])).toEqual([['.htaccess', 4, 'php_value memory_limit: moved to .user.ini']]);
    expect(r.warnings).toEqual([]);
  });

  it.each(
    (
      [
        ['php_value memory_limit 512M', 'memory_limit', '512M'],
        ['php_flag display_errors off', 'display_errors', '0'],
        ['php_flag display_errors On', 'display_errors', '1'],
        ['php_flag display_errors 1', 'display_errors', '1'],
        // mod_php's reading: On or 1 is on, and anything else is off, "true" included.
        ['php_flag display_errors true', 'display_errors', '0'],
        ['PHP_VALUE memory_limit 512M', 'memory_limit', '512M'],
        ['Php_Flag display_errors ON', 'display_errors', '1'],
        ['php_value\tdate.timezone\tAsia/Seoul', 'date.timezone', 'Asia/Seoul'],
        // Apache reads these as well, tried on mod_php.
        ['"php_value" date.timezone Asia/Tokyo', 'date.timezone', 'Asia/Tokyo'],
        ['php_value "date.timezone" "Asia/Tokyo"', 'date.timezone', 'Asia/Tokyo'],
        ["php_value date.timezone 'Asia/Tokyo'", 'date.timezone', 'Asia/Tokyo'],
        ['php_value session.cookie_path "/a b/c"', 'session.cookie_path', '/a b/c'],
        ['php_value arg_separator.output "&amp;"', 'arg_separator.output', '&amp;'],
        ["php_value include_path '.:/usr/local/lib/php'", 'include_path', '.:/usr/local/lib/php'],
        ['php_value session.name "it\'s"', 'session.name', "it's"],
        ['php_value session.name \'a"b\'', 'session.name', 'a"b'],
        ['php_value session.name "a\\"b"', 'session.name', 'a"b'],
        ['php_value session.name "it\'s \\"this\\""', 'session.name', 'it\'s "this"'],
        ['php_value session.name "a\\\\b"', 'session.name', 'a\\b'],
        ['php_value default_charset ""', 'default_charset', ''],
        // What an ini file would read as something else: mod_php passed it on as it is.
        ['php_value session.name "a;b=c(d)!{e}$f|g&h~i^j"', 'session.name', 'a;b=c(d)!{e}$f|g&h~i^j'],
        ['php_value session.name "${HOME}"', 'session.name', '${HOME}'],
        ['php_value error_reporting "E_ALL & ~E_NOTICE"', 'error_reporting', 'E_ALL & ~E_NOTICE'],
        ['php_value error_reporting E_ALL', 'error_reporting', 'E_ALL'],
        ['php_value session.name on', 'session.name', 'on'],
        ['php_value session.name null', 'session.name', 'null'],
        // The word mod_php turns into nothing, however it is written.
        ['php_value auto_prepend_file none', 'auto_prepend_file', ''],
        ['php_value auto_prepend_file "NONE"', 'auto_prepend_file', ''],
      ] as const
    ).map(([line, name, literal]) => ({ line, name, literal, c: addHtaccess(`${line}\n`) })),
  )('$line says the same to PHP in .user.ini', ({ line, name, literal, c }) => {
    const r = c.result();
    expect(r.warnings).toEqual([]);
    expect(r.read('.htaccess')).toBe(`${MOVED}${line}\n`);
    expect(r.ini('.user.ini')).toEqual({ [name]: literal });
  });

  const unwritable = addHtaccess('php_value session.name "it\'s ${HOME}"\n');
  it('warns about a value no spelling in a .user.ini can say', () => {
    const r = unwritable.result();
    expect(r.read('.htaccess')).toBe(`${NOT_MOVED}php_value session.name "it's \${HOME}"\n`);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.warnings[0]!.what).toContain('cannot be written');
  });

  const comments = '# php_value memory_limit 64M\n  #php_flag display_errors on\n# a comment that goes on \\\nphp_value memory_limit 64M\n\n';
  const commented = addHtaccess(comments);
  it('leaves comments alone, and what a backslash joins to one', () => {
    const r = commented.result();
    expect(r.read('.htaccess')).toBe(comments);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.changes).toEqual([]);
  });

  const indented = addHtaccess('  \tphp_value memory_limit 512M  \n');
  it('keeps its indentation, for undo', () => {
    expect(indented.result().read('.htaccess')).toBe(`  \t${MOVED}php_value memory_limit 512M  \n`);
  });

  const crlf = S.add({ '.htaccess': 'RewriteEngine On\r\nphp_value memory_limit 512M\r\n', '.user.ini': 'date.timezone = UTC\r\n' });
  it('keeps a Windows line ending, on each line and in a new line of .user.ini', () => {
    const r = crlf.result();
    expect(r.read('.htaccess')).toBe(`RewriteEngine On\r\n${MOVED}php_value memory_limit 512M\r\n`);
    expect(r.read('.user.ini')).toBe(`date.timezone = UTC\r\n${INI_MOVED}php_value memory_limit 512M\r\nmemory_limit = '512M'\r\n`);
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'UTC', memory_limit: '512M' });
  });

  const noEnding = S.add({ '.htaccess': 'php_value memory_limit 512M', '.user.ini': 'date.timezone = UTC' });
  it('copes with a file that has no line ending at the end', () => {
    const r = noEnding.result();
    expect(r.read('.htaccess')).toBe(`${MOVED}php_value memory_limit 512M`);
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'UTC', memory_limit: '512M' });
  });

  const continued = addHtaccess('php_value date.timezone \\\nEurope/Paris\nRewriteEngine On\n');
  it('marks only the first line of a line that goes on: Apache joins the rest into the comment', () => {
    const r = continued.result();
    expect(r.read('.htaccess')).toBe(`${MOVED}php_value date.timezone \\\nEurope/Paris\nRewriteEngine On\n`);
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'Europe/Paris' });
  });

  const malformed = addHtaccess('php_value date.timezone Europe/Berlin extra\nphp_value memory_limit\n');
  it('does not write what Apache would have refused: a line that is a 500 under mod_php as well', () => {
    const r = malformed.result();
    expect(r.read('.htaccess')).toBe(`${NOT_MOVED}php_value date.timezone Europe/Berlin extra\n${NOT_MOVED}php_value memory_limit\n`);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.warnings.map((w) => w.line)).toEqual([1, 2]);
    expect(r.warnings[0]!.what).toContain('one value');
  });

  const notAllowed = addHtaccess('php_value sendmail_path /bin/true\nphp_value disable_functions exec\nphp_value memory_limit 512M\n');
  it('drops with a warning what PHP does not allow in a .user.ini', () => {
    const r = notAllowed.result();
    expect(r.read('.htaccess')).toBe(`${NOT_MOVED}php_value sendmail_path /bin/true\n${NOT_MOVED}php_value disable_functions exec\n${MOVED}php_value memory_limit 512M\n`);
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '512M' });
    expect(r.warnings.map((w) => [w.path, w.line])).toEqual([['.htaccess', 1], ['.htaccess', 2]]);
    expect(r.warnings[0]!.what).toContain('does not allow this setting');
  });

  // Setting names are case-sensitive in PHP, unlike the directive: mod_php ignored the second, tried for real.
  const unknown = addHtaccess('php_flag magic_quotes_gpc off\nphp_value Date.Timezone Asia/Tokyo\n');
  it('comments out a setting this PHP has no such name for, which did nothing, without a warning', () => {
    const r = unknown.result();
    expect(r.read('.htaccess')).toBe(`${NOT_MOVED}php_flag magic_quotes_gpc off\n${NOT_MOVED}php_value Date.Timezone Asia/Tokyo\n`);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.changes[0]!.what).toContain('no such setting');
  });

  const admin = addHtaccess('php_admin_value date.timezone Asia/Tokyo\nphp_admin_value upload_max_filesize 128M\nphp_admin_value disable_functions exec\nphp_admin_flag log_errors on\n');
  it('says when php_admin_* could not be changed by a script and now can', () => {
    const r = admin.result();
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'Asia/Tokyo', upload_max_filesize: '128M', log_errors: '1' });
    // upload_max_filesize can't be changed at run time in any case. disable_functions isn't moved at all.
    expect(r.said('ini_set').map((w) => w.line)).toEqual([1, 4]);
    expect(r.said('does not allow').map((w) => w.line)).toEqual([3]);
  });

  const narrow = addHtaccess(
    '<FilesMatch "\\.css$">\nphp_value default_mimetype text/css\n</FilesMatch>\n' +
      '<Files feed.php>\nphp_value memory_limit 1G\n</Files>\n' +
      '<If "%{REQUEST_URI} =~ /x/">\nphp_flag display_errors on\n</If>\n' +
      '<IfModule mod_php.c>\n<Files y.php>\nphp_value date.timezone UTC\n</Files>\n</IfModule>\n',
  );
  it('does not spread a setting meant for some files over the whole folder', () => {
    const r = narrow.result();
    expect(r.read('.htaccess')).toBe(
      `<FilesMatch "\\.css$">\n${NOT_MOVED}php_value default_mimetype text/css\n</FilesMatch>\n` +
        `<Files feed.php>\n${NOT_MOVED}php_value memory_limit 1G\n</Files>\n` +
        `<If "%{REQUEST_URI} =~ /x/">\n${NOT_MOVED}php_flag display_errors on\n</If>\n` +
        '<IfModule mod_php.c>\n<Files y.php>\nphp_value date.timezone UTC\n</Files>\n</IfModule>\n',
    );
    expect(r.ini('.user.ini')).toEqual({});
    expect(r.warnings.map((w) => w.line)).toEqual([2, 5, 8, 12]);
    expect(r.warnings[0]!.what).toContain('<FilesMatch "\\.css$">');
    expect(r.second.warnings).toEqual([]);
  });

  const loaded = addHtaccess('<IfModule mod_rewrite.c>\n  php_value memory_limit 512M\n</IfModule>\n<IfModule !mod_php.c>\n  php_flag display_errors off\n</IfModule>\n');
  it('treats a block for a module Apache has as no block at all: the line would be a 500', () => {
    const r = loaded.result();
    expect(r.read('.htaccess')).toBe(`<IfModule mod_rewrite.c>\n  ${MOVED}php_value memory_limit 512M\n</IfModule>\n<IfModule !mod_php.c>\n  ${MOVED}php_flag display_errors off\n</IfModule>\n`);
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '512M', display_errors: '0' });
  });

  const twice = addHtaccess('php_value memory_limit 300M\nphp_value memory_limit 512M\n');
  it('takes the last of several lines for a setting, as Apache did', () => {
    const r = twice.result();
    expect(r.read('.htaccess')).toBe(`${MOVED}php_value memory_limit 300M\n${MOVED}php_value memory_limit 512M\n`);
    expect(r.read('.user.ini')).toBe(`${INI_MOVED}php_value memory_limit 512M\nmemory_limit = '512M'\n`);
  });

  // A folder's own low limit is the owner's choice. It only goes when it never applied (below).
  const ownLow = addHtaccess('php_value memory_limit 64M\nphp_value upload_max_filesize 2M\nphp_value max_execution_time 10\n');
  it("keeps what the site was running with even when it is lower than the site's own limit", () => {
    const r = ownLow.result();
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '64M', upload_max_filesize: '2M', max_execution_time: '10' });
    expect(r.warnings).toEqual([]);
  });

  const paths = S.add((dir) => ({
    'real/.keep': '',
    'app/.htaccess': `php_value session.save_path "${dir}/real"\nphp_value error_log "${dir}/real/php.log"\nphp_value open_basedir "${path.dirname(dir)}:/tmp"\n`,
    'gone/.htaccess': 'php_value session.save_path "/home/olduser/tmp"\nphp_value error_log /home/olduser/logs/php.log\nphp_value open_basedir /home/olduser/public_html:/tmp\n',
  }));
  it('keeps a path the site was running with, unless it is not here', () => {
    const r = paths.result();
    expect(r.ini('app/.user.ini')).toEqual({ 'session.save_path': `${paths.dir}/real`, error_log: `${paths.dir}/real/php.log`, open_basedir: `${path.dirname(paths.dir)}:/tmp` });
    expect(r.has('gone/.user.ini')).toBe(false);
    expect(r.warnings.map((w) => [w.path, w.line])).toEqual([['gone/.htaccess', 1], ['gone/.htaccess', 2], ['gone/.htaccess', 3]]);
    expect(r.warnings[0]!.what).toContain('not here');
  });

  const prepend = S.add((dir) => ({
    'waf.php': '<?php\n',
    '.htaccess': `php_value auto_prepend_file "${dir}/waf.php"\nphp_value auto_append_file /home/olduser/public_html/end.php\n`,
    // PHP looks for a relative one from each script's folder, under mod_php as under PHP-FPM.
    'app/.htaccess': 'php_value auto_prepend_file init.php\n',
  }));
  it('does not bring along an auto_prepend_file that is not here, a 500 for every script below it', () => {
    const r = prepend.result();
    expect(r.ini('.user.ini')).toEqual({ auto_prepend_file: `${prepend.dir}/waf.php` });
    expect(r.ini('app/.user.ini')).toEqual({ auto_prepend_file: 'init.php' });
    expect(r.warnings.map((w) => w.line)).toEqual([2]);
  });
});

describe.skipIf(!CAN_RUN)('a line in a block for mod_php', () => {
  const block = '<IfModule mod_php.c>\n\tphp_value memory_limit 512M\n</IfModule>\n';
  const live = addHtaccess(block);
  it('stays exactly as it is, and its setting still moves', () => {
    const r = live.result();
    expect(r.read('.htaccess')).toBe(block);
    expect(r.read('.user.ini')).toBe(`${INI_MOVED}php_value memory_limit 512M\nmemory_limit = '512M'\n`);
    expect(r.changes.map((c) => [c.path, c.line])).toEqual([['.htaccess', 2]]);
    expect(r.changes[0]!.what).toContain('this line stays');
  });

  it.each(
    ['mod_php.c', 'php_module', 'mod_php8.c', 'php8_module', 'mod_php7.c', 'php7_module', 'mod_php5.c', 'php5_module', 'sapi_apache2.c', 'lsapi_module', 'mod_lsapi.c', 'LiteSpeed', '"mod_php.c"', "'php_module'"].map((name) => {
      const htaccess = `<IfModule ${name}>\n  php_value memory_limit 512M\n</IfModule>\n`;
      return { name, htaccess, c: addHtaccess(htaccess) };
    }),
  )('counts <IfModule $name> as one', ({ htaccess, c }) => {
    const r = c.result();
    expect(r.read('.htaccess')).toBe(htaccess);
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '512M' });
  });

  const nested = addHtaccess('<IfModule mod_rewrite.c>\n<IfModule mod_php.c>\nphp_value memory_limit 512M\n</IfModule>\nphp_value upload_max_filesize 128M\n</IfModule>\nphp_flag display_errors off\n');
  it('counts as one however deep it is, and a block closing means the next line is bare again', () => {
    const r = nested.result();
    expect(r.read('.htaccess')).toBe(`<IfModule mod_rewrite.c>\n<IfModule mod_php.c>\nphp_value memory_limit 512M\n</IfModule>\n${MOVED}php_value upload_max_filesize 128M\n</IfModule>\n${MOVED}php_flag display_errors off\n`);
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '512M', upload_max_filesize: '128M', display_errors: '0' });
  });

  const older = addHtaccess('<IfModule mod_php.c>\nphp_value memory_limit 1G\n</IfModule>\n<IfModule mod_php7.c>\nphp_value memory_limit 512M\n</IfModule>\n');
  it('prefers the line mod_php read over one for an older PHP, wherever each is', () => {
    expect(older.result().ini('.user.ini')).toEqual({ memory_limit: '1G' });
  });

  const never = addHtaccess('<IfModule php7_module>\nphp_value memory_limit 64M\nphp_value session.save_path "/var/cpanel/php/sessions/ea-php74"\nphp_value date.timezone Asia/Tokyo\nphp_flag magic_quotes_gpc off\n</IfModule>\n');
  it('does not bring back what would hurt from a block that never applied, and says so once', () => {
    const r = never.result();
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'Asia/Tokyo' });
    expect(r.warnings.map((w) => w.line)).toEqual([2, 3]);
    expect(r.warnings[0]!.what).toContain("lower than the site's own limit, 256M");
    expect(r.second.warnings).toEqual([]);
    expect(r.read('.user.ini')).toContain(`${INI_LEFT}php_value memory_limit 64M\n`);
  });

  it("is only moved once: a later edit of the setting in .user.ini is the owner's", () => {
    const root = makeSite({ '.htaccess': '<IfModule mod_php.c>\nphp_value memory_limit 512M\n</IfModule>\n' });
    run(root);
    put(root, '.user.ini', read(root, '.user.ini').replace("'512M'", "'1G'"));
    const before = fingerprint(root);
    const again = run(root);
    expect(again.changes).toEqual([]);
    expect(fingerprint(root)).toEqual(before);
    expect(iniAsPhpReadsIt(root, '.user.ini')).toEqual({ memory_limit: '1G' });
  });
});

describe.skipIf(!CAN_RUN)('a setting the .user.ini beside it has already', () => {
  const live = S.add({ '.user.ini': 'memory_limit = 300M\ndate.timezone = UTC\n', '.htaccess': 'php_value memory_limit 512M\n' });
  it('takes the value mod_php read: it never read the other file, so this is what the site ran with', () => {
    const r = live.result();
    expect(r.read('.user.ini')).toBe(`${INI_UNUSED}memory_limit = 300M\ndate.timezone = UTC\n${INI_MOVED}php_value memory_limit 512M\nmemory_limit = '512M'\n`);
    expect(r.changes.map((c) => [c.path, c.line]).sort()).toEqual([['.htaccess', 1], ['.user.ini', 1]]);
  });

  const several = S.add({ '.user.ini': 'memory_limit = 300M\nmemory_limit = 400M\n', '.htaccess': 'php_value memory_limit 512M\n' });
  it('comments out every line for it, since PHP takes the last', () => {
    const r = several.result();
    expect(r.ini('.user.ini')).toEqual({ memory_limit: '512M' });
    expect(r.read('.user.ini').split(INI_UNUSED).length).toBe(3);
  });

  const unread = S.add({ '.user.ini': 'memory_limit = 300M\n', '.htaccess': '<IfModule php7_module>\nphp_value memory_limit 512M\n</IfModule>\n' });
  it('leaves it alone for a line in a block mod_php did not read', () => {
    const r = unread.result();
    expect(r.read('.user.ini')).toBe('memory_limit = 300M\n');
    expect(r.changes).toEqual([]);
  });

  const same = S.add({ '.user.ini': 'memory_limit = "512M"\ndisplay_errors = Off\nlog_errors = On\n', '.htaccess': 'php_value memory_limit 512M\nphp_flag display_errors off\nphp_flag log_errors on\n' });
  it('writes nothing to it when both say the same, in whichever words', () => {
    const r = same.result();
    expect(r.read('.user.ini')).toBe('memory_limit = "512M"\ndisplay_errors = Off\nlog_errors = On\n');
    expect(r.changes.map((c) => c.path)).toEqual(['.htaccess', '.htaccess', '.htaccess']);
  });

  const inTheWay = S.add({ '.user.ini': 'memory_limit = 64M\n', '.htaccess': '<IfModule php7_module>\nphp_value memory_limit 512M\n</IfModule>\n' });
  it('is no longer in the way when the line there is one that had to go', () => {
    expect(inTheWay.result().read('.user.ini')).toBe(`${INI_UNUSED}memory_limit = 64M\n${INI_MOVED}php_value memory_limit 512M\nmemory_limit = '512M'\n`);
  });
});

describe.skipIf(!CAN_RUN)('php_flag engine off', () => {
  it.each(
    [
      'php_flag engine off',
      'php_flag engine 0',
      'PHP_FLAG engine OFF',
      // Real mod_php: php_flag reads anything but On or 1 as off, php_value what PHP reads as false.
      'php_flag engine true',
      'php_flag engine yes',
      'php_value engine off',
      'php_value engine no',
      'php_value engine 0',
      'php_admin_flag engine off',
    ].map((line) => ({ line, c: addHtaccess(`Options -Indexes\n${line}\nOptions -ExecCGI\n`) })),
  )('$line becomes a deny for PHP files, where the line was', ({ line, c }) => {
    const r = c.result();
    expect(r.read('.htaccess')).toBe(`Options -Indexes\n${DENY}${line}\n${DENY_BLOCK}Options -ExecCGI\n`);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.changes[0]!.what).toContain('replaced by a deny');
    expect(r.afterUndo('.htaccess')).toBe(r.read('.htaccess'));
  });

  const crlf = addHtaccess('  php_flag engine off\r\nRewriteEngine On\r\n');
  it('keeps its indentation and line ending', () => {
    expect(crlf.result().read('.htaccess')).toBe(`  ${DENY}php_flag engine off\r\n  <If "%{REQUEST_FILENAME} =~ /\\.ph(p[0-9]?|tml|ar|t|ps)$/i">\r\n      Require all denied\r\n      Satisfy All\r\n  </If>\r\nRewriteEngine On\r\n`);
  });

  const lastLine = addHtaccess('php_flag engine off');
  it('copes with being the last line, with no line ending', () => {
    expect(lastLine.result().read('.htaccess')).toBe(`${DENY}php_flag engine off\n${DENY_BLOCK}`);
  });

  const several = addHtaccess('php_flag engine off\nphp_value engine 0\n');
  it('adds one deny for a file that has several', () => {
    expect(several.result().read('.htaccess')).toBe(`${DENY}php_flag engine off\n${DENY_BLOCK}${DENY}php_value engine 0\n`);
  });

  const inSection = addHtaccess('<Files xmlrpc.php>\nphp_flag engine off\n</Files>\n');
  it('stays inside a section, for only the files that section takes', () => {
    expect(inSection.result().read('.htaccess')).toBe(`<Files xmlrpc.php>\n${DENY}php_flag engine off\nRequire all denied\nSatisfy All\n</Files>\n`);
  });

  const wrapped = addHtaccess('<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n<FilesMatch ".*">\nRequire all granted\n</FilesMatch>');
  it('in a block for mod_php stays as it is, with the deny after everything else in the file', () => {
    const r = wrapped.result();
    expect(r.read('.htaccess')).toBe(`<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n<FilesMatch ".*">\nRequire all granted\n</FilesMatch>\n${DENY}php_flag engine off\n${DENY_BLOCK}`);
    expect(r.changes[0]!.line).toBe(2);
    expect(r.read('.htaccess').split('Require all denied').length).toBe(2);
  });

  const nowhere = '<IfModule mod_php.c>\n<Files x.php>\nphp_flag engine off\n</Files>\n</IfModule>\n';
  const blockAndSection = addHtaccess(nowhere);
  it('in a block and in a section at once has nowhere to go, and says so', () => {
    const r = blockAndSection.result();
    expect(r.read('.htaccess')).toBe(nowhere);
    expect(r.warnings.map((w) => w.line)).toEqual([3]);
  });

  const on = S.add({ 'a/.htaccess': 'php_flag engine on\nphp_value engine true\nphp_flag engine 1\n', 'b/.htaccess': '<IfModule mod_php.c>\nphp_flag engine on\n</IfModule>\n' });
  it('engine on needs nothing in a block, and is commented out outside one', () => {
    const r = on.result();
    expect(r.read('a/.htaccess')).toBe(`${NOT_MOVED}php_flag engine on\n${NOT_MOVED}php_value engine true\n${NOT_MOVED}php_flag engine 1\n`);
    expect(r.read('b/.htaccess')).toBe('<IfModule mod_php.c>\nphp_flag engine on\n</IfModule>\n');
    expect(r.has('a/.user.ini')).toBe(false);
    expect(r.changes[0]!.what).toContain('a folder above has a deny');
    expect(r.afterUndo('a/.htaccess')).toBe('php_flag engine on\nphp_value engine true\nphp_flag engine 1\n');
  });

  const capital = addHtaccess('php_flag Engine off\n');
  it("is only the setting called engine: PHP's names are case-sensitive, and mod_php ran PHP under this one", () => {
    expect(capital.result().read('.htaccess')).toBe(`${NOT_MOVED}php_flag Engine off\n`);
  });
});

describe.skipIf(!CAN_RUN)("Wordfence's own blocks", () => {
  const uploads = addHtaccess(WORDFENCE_UPLOADS);
  it('code execution protection in uploads: the block stays word for word, which Wordfence itself checks, and gets its deny', () => {
    const r = uploads.result();
    expect(r.read('.htaccess')).toBe(`${WORDFENCE_UPLOADS}${DENY}php_flag engine 0\n${DENY_BLOCK}`);
    expect(r.has('.user.ini')).toBe(false);
    // cgi-script is what it hands those files to, on purpose, and no PHP handler.
    expect(r.warnings).toEqual([]);
    expect(r.afterUndo('.htaccess')).toBe(r.read('.htaccess'));
  });

  const waf = S.add((dir) => ({ 'wordfence-waf.php': '<?php\n', '.htaccess': wordfenceWaf(`${dir}/wordfence-waf.php`) }));
  it('the firewall on this site moves to .user.ini, with its file there', () => {
    const r = waf.result();
    const file = `${waf.dir}/wordfence-waf.php`;
    expect(r.read('.htaccess')).toBe(wordfenceWaf(file));
    expect(r.ini('.user.ini')).toEqual({ auto_prepend_file: file });
    expect(r.warnings).toEqual([]);
    expect(r.changes).toHaveLength(1);
  });

  const wafElsewhere = addHtaccess(wordfenceWaf('/home/olduser/public_html/wordfence-waf.php'));
  it('the firewall brought from another host stays behind: it would be a 500 for every script', () => {
    const r = wafElsewhere.result();
    expect(r.read('.htaccess')).toBe(wordfenceWaf('/home/olduser/public_html/wordfence-waf.php'));
    expect(r.ini('.user.ini')).toEqual({});
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.what).toContain('the file it names is not here');
    expect(r.second.warnings).toEqual([]);
  });

  const quoted = S.add((dir) => ({ "it's/wordfence-waf.php": '<?php\n', '.htaccess': wordfenceWaf(`${dir}/it\\'s/wordfence-waf.php`) }));
  it('a path with a quote in it, which Wordfence escapes', () => {
    expect(quoted.result().ini('.user.ini')).toEqual({ auto_prepend_file: `${quoted.dir}/it's/wordfence-waf.php` });
  });

  const litespeed = S.add((dir) => ({ 'wordfence-waf.php': '<?php\n', '.htaccess': wordfenceWafLitespeed(`${dir}/wordfence-waf.php`) }));
  it('the firewall on LiteSpeed never applied here, and moves the same', () => {
    const r = litespeed.result();
    const file = `${litespeed.dir}/wordfence-waf.php`;
    expect(r.read('.htaccess')).toBe(wordfenceWafLitespeed(file));
    expect(r.ini('.user.ini')).toEqual({ auto_prepend_file: file });
  });

  const inIni = S.add((dir) => ({
    'wordfence-waf.php': '<?php\n',
    '.user.ini': wordfenceUserIni(`${dir}/wordfence-waf.php`),
    'old/.user.ini': wordfenceUserIni('/home/olduser/public_html/wordfence-waf.php'),
  }));
  it('the firewall in a .user.ini stays when its file is here, and goes when it is not', () => {
    const r = inIni.result();
    expect(r.read('.user.ini')).toBe(wordfenceUserIni(`${inIni.dir}/wordfence-waf.php`));
    expect(r.read('old/.user.ini')).toBe(`; Wordfence WAF\n${INI_UNUSED}auto_prepend_file = '/home/olduser/public_html/wordfence-waf.php'\n; END Wordfence WAF\n`);
    expect(r.changes.map((c) => [c.path, c.line])).toEqual([['old/.user.ini', 2]]);
  });

  const errors = addHtaccess(WORDFENCE_DISPLAY_ERRORS);
  it('its fix for full path disclosure moves once', () => {
    const r = errors.result();
    expect(r.read('.htaccess')).toBe(WORDFENCE_DISPLAY_ERRORS);
    expect(r.read('.user.ini')).toBe(`${INI_MOVED}php_value display_errors 0\ndisplay_errors = '0'\n`);
  });
});

describe.skipIf(!CAN_RUN)('what other plugins write', () => {
  // WPForms 1.10, includes/functions/filesystem-media.php, through WordPress's insert_with_markers.
  const WPFORMS = `# BEGIN WPForms
# The directives (lines) between "BEGIN WPForms" and "END WPForms" are
# dynamically generated, and should only be modified via WordPress filters.
# Any changes to the directives between these markers will be overwritten.
# Disable PHP and Python scripts parsing.
<Files *>
  SetHandler none
  SetHandler default-handler
  RemoveHandler .cgi .php .php3 .php4 .php5 .phtml .pl .py .pyc .pyo
  RemoveType .cgi .php .php3 .php4 .php5 .phtml .pl .py .pyc .pyo
</Files>
<IfModule mod_php5.c>
  php_flag engine off
</IfModule>
<IfModule mod_php7.c>
  php_flag engine off
</IfModule>
<IfModule mod_php8.c>
  php_flag engine off
</IfModule>
<IfModule headers_module>
  Header set X-Robots-Tag "noindex"
</IfModule>
# END WPForms
`;
  const wpforms = addHtaccess(WPFORMS);
  it('WPForms: its block stays as it is, and PHP stays off in its folder', () => {
    const r = wpforms.result();
    expect(r.read('.htaccess')).toBe(`${WPFORMS}${DENY}php_flag engine off\n${DENY_BLOCK}`);
    expect(r.has('.user.ini')).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  // All-In-One Security 5, classes/wp-security-block-htaccess.php.
  const aios = (file: string) => `\n# Begin AIOWPSEC Firewall\n\t<IfModule mod_php5.c>\n\t\tphp_value auto_prepend_file '${file}'\n\t</IfModule>\n\t<IfModule mod_php7.c>\n\t\tphp_value auto_prepend_file '${file}'\n\t</IfModule>\n\t<IfModule mod_php.c>\n\t\tphp_value auto_prepend_file '${file}'\n\t</IfModule>\n# End AIOWPSEC Firewall`;
  const firewall = S.add((dir) => ({ 'aios-bootstrap.php': '<?php\n', '.htaccess': aios(`${dir}/aios-bootstrap.php`) }));
  it('All-In-One Security: its firewall moves, indented as it is', () => {
    const r = firewall.result();
    expect(r.read('.htaccess')).toBe(aios(`${firewall.dir}/aios-bootstrap.php`));
    expect(r.ini('.user.ini')).toEqual({ auto_prepend_file: `${firewall.dir}/aios-bootstrap.php` });
    expect(r.changes).toHaveLength(1);
  });
});

describe.skipIf(!CAN_RUN)("cPanel's generated files", () => {
  const blocks = addHtaccess(CPANEL_HTACCESS);
  it('nothing in a generated block was in force, so what would hurt stays out and the rest moves', () => {
    const r = blocks.result();
    expect(r.read('.htaccess')).toBe(CPANEL_HTACCESS);
    expect(r.ini('.user.ini')).toEqual({
      display_errors: '0',
      max_input_time: '600',
      max_input_vars: '10000',
      memory_limit: '512M',
      'session.gc_maxlifetime': '1440',
      upload_max_filesize: '200M',
      'zlib.output_compression': '0',
    });
    // 30 s is under the site's 120, 8M under its 64M, and the sessions folder is on another host.
    const left = r.warnings.filter((w) => w.what.includes('not moved'));
    expect(left.map((w) => w.what.split(':')[0]!.split(' ')[1])).toEqual(['max_execution_time', 'post_max_size', 'session.save_path']);
    // The handler line is a warning that still stands, and nothing else is said again.
    expect(r.second.warnings.map((w) => w.line)).toEqual([4]);
  });

  it('its handler line: .php needs nothing, and the rest is named', () => {
    const handler = blocks.result().said('AddHandler');
    expect(handler.map((w) => [w.path, w.line, w.level])).toEqual([['.htaccess', 4, 'warn']]);
    expect(handler[0]!.what).toContain('files named .php8 .phtml are sent as they are, source included');
  });

  const userIni = S.add({ '.user.ini': CPANEL_USER_INI });
  it("its .user.ini: limits under the site's own go, and the rest stays", () => {
    const r = userIni.result();
    expect(r.ini('.user.ini')).toEqual({ display_errors: '', 'session.gc_maxlifetime': '1440', 'zlib.output_compression': '1' });
    expect(r.changes.map((c) => c.what.split(':')[0])).toEqual(['max_execution_time', 'max_input_time', 'max_input_vars', 'memory_limit', 'post_max_size', 'session.save_path', 'upload_max_filesize']);
    expect(r.read('.user.ini')).toContain(`${INI_UNUSED}session.save_path = "/var/cpanel/php/sessions/ea-php73"\n`);
    expect(r.read('.user.ini')).toContain('[PHP]\ndisplay_errors = Off\n');
    expect(r.afterUndo('.user.ini')).toBe(r.read('.user.ini'));
  });

  const both = S.add({ '.htaccess': CPANEL_HTACCESS, '.user.ini': CPANEL_USER_INI });
  it('both at once, the way an account has them', () => {
    const r = both.result();
    expect(r.read('.htaccess')).toBe(CPANEL_HTACCESS);
    const ini = r.ini('.user.ini');
    expect(ini).not.toHaveProperty('session.save_path');
    // The one under the site's limit went, so the block's better value has its place.
    expect(ini.memory_limit).toBe('512M');
    expect(ini.upload_max_filesize).toBe('200M');
    expect(ini.max_input_vars).toBe('10000');
    // A value the .user.ini has of its own stays: it is what an FPM host really read.
    expect(ini['zlib.output_compression']).toBe('1');
  });
});

describe.skipIf(!CAN_RUN)('a .user.ini that was already there', () => {
  /** One line in a file of its own, and whether it stayed. */
  const oneLine = (site: SharedSite, line: string) => {
    const c = site.add({ '.user.ini': `${line}\n` });
    return () => {
      const r = c.result();
      const kept = r.read('.user.ini') === `${line}\n`;
      if (!kept) expect(r.read('.user.ini')).toBe(`${INI_UNUSED}${line}\n`);
      expect(r.changes.map((l) => [l.path, l.line])).toEqual(kept ? [] : [['.user.ini', 1]]);
      return kept;
    };
  };

  it.each(
    [
      "auto_prepend_file = '/home/olduser/public_html/wordfence-waf.php'",
      'auto_prepend_file=/home/olduser/waf.php',
      'auto_append_file = "/home/olduser/end.php"',
      'auto_prepend_file = missing-beside-this.php',
      'open_basedir = /home/olduser/public_html:/tmp',
      'open_basedir=/var/www/html',
      'session.save_path = "/var/cpanel/php/sessions/ea-php74"',
      'session.save_path = /tmp',
      // Tried on real PHP-FPM: session_start fails on each, and mod_php never read them.
      'session.save_handler = memcached',
      'session.save_handler = redis',
      'session.save_handler = user',
      'error_log = /home/olduser/logs/php.log',
      'error_log = error_log',
      'sys_temp_dir = /home/olduser/tmp',
      'upload_tmp_dir = /home/olduser/tmp',
    ].map((line) => ({ line, kept: oneLine(S, line) })),
  )('comments out $line', ({ kept }) => {
    expect(kept()).toBe(false);
  });

  const here = S.add((dir) => ({ 'waf.php': '<?php\n', 'app/init.php': '<?php\n', 'app/.user.ini': 'auto_append_file = init.php\n', '.user.ini': `auto_prepend_file = '${dir}/waf.php'\n` }));
  it('keeps an auto_prepend_file that is here, as a full path or beside the file', () => {
    const r = here.result();
    expect(r.read('.user.ini')).toBe(`auto_prepend_file = '${here.dir}/waf.php'\n`);
    expect(r.read('app/.user.ini')).toBe('auto_append_file = init.php\n');
  });

  const aFolder = S.add((dir) => ({ 'waf.php/.keep': '', '.user.ini': `auto_prepend_file = ${dir}/waf.php\n` }));
  it('counts a folder where a file should be as not there', () => {
    expect(aFolder.result().read('.user.ini').startsWith(INI_UNUSED)).toBe(true);
  });

  it.each(['auto_prepend_file =', 'auto_prepend_file = none', 'auto_prepend_file = ""', 'open_basedir =', 'error_log = ""', 'session.save_path =', 'session.save_handler = files'].map((line) => ({ line, kept: oneLine(S, line) })))('keeps $line, which names nothing of another host', ({ kept }) => {
    expect(kept()).toBe(true);
  });

  // DEFAULT_UPLOADS_INI: 64M uploads and posts, 256M of memory, 120 s, 3000 fields.
  it.each(
    (
      [
        ['memory_limit = 64M', false],
        ['memory_limit = "64M"', false],
        ["memory_limit = '64M'", false],
        ['memory_limit=64m', false],
        ['memory_limit = 255M', false],
        ['memory_limit = 0', false],
        ['memory_limit = 256M', true],
        ['memory_limit = 262144K', true],
        ['memory_limit = 1G', true],
        ['memory_limit = 2g', true],
        ['memory_limit = -1', true],
        // Nothing stops a file from saying this.
        ['memory_limit = 99999999999999999999999G', true],
        ['memory_limit = not a number', false],
        ['upload_max_filesize = 2M', false],
        ['upload_max_filesize = 64M', true],
        ['upload_max_filesize = 128M', true],
        // 0 means no limit, here and for posts.
        ['upload_max_filesize = 0', true],
        ['post_max_size = 8M', false],
        ['post_max_size = 67108864', true],
        ['post_max_size = 0', true],
        ['max_execution_time = 30', false],
        ['max_execution_time = 120', true],
        ['max_execution_time = 300', true],
        ['max_execution_time = 0', true],
        // No value of its own (-1) means it follows max_execution_time, the site's 120.
        ['max_input_time = 60', false],
        ['max_input_time = 300', true],
        ['max_input_time = 0', true],
        ['max_input_time = -1', true],
        ['max_input_vars = 1000', false],
        ['max_input_vars = 3000', true],
        ['max_input_vars = 5000', true],
      ] as const
    ).map(([line, kept]) => ({ line, kept, check: oneLine(S, line) })),
  )("$line against the site's limits: kept = $kept", ({ kept, check }) => {
    expect(check()).toBe(kept);
  });

  // On the command line ini_get only ever answers no limit for these two, whatever the files say.
  const noTime = new SharedSite('max_execution_time = 0\nmax_input_time = 0\n', true);
  const lowTime = new SharedSite('max_execution_time = 10\nmax_input_time = 10\n', true);
  const notSaid = new SharedSite('memory_limit = 256M\n', true);
  const noMemoryLimit = new SharedSite('memory_limit = -1\n', true);
  it.each(
    (
      [
        ['no limit', noTime, 'max_execution_time = 300', false],
        ['no limit', noTime, 'max_input_time = 300', false],
        ['no limit', noTime, 'max_execution_time = 0', true],
        ['10 s', lowTime, 'max_execution_time = 30', true],
        ['10 s', lowTime, 'max_execution_time = 5', false],
        ['10 s', lowTime, 'max_input_time = 30', true],
        ['10 s', lowTime, 'max_input_time = 5', false],
        // PHP's own 30, which its file doesn't mention.
        ['nothing', notSaid, 'max_execution_time = 20', false],
        ['nothing', notSaid, 'max_execution_time = 30', true],
        ['nothing', notSaid, 'max_input_time = 20', false],
        ['nothing', notSaid, 'max_input_time = 30', true],
        ['no memory limit', noMemoryLimit, 'memory_limit = 8G', false],
        ['no memory limit', noMemoryLimit, 'memory_limit = -1', true],
      ] as const
    ).map(([own, site, line, kept]) => ({ own, line, kept, check: oneLine(site, line) })),
  )("reads the site's own limits from its files: with $own, $line is kept = $kept", ({ kept, check }) => {
    expect(check()).toBe(kept);
  });

  const others = '; a comment about memory_limit = 1M\n\n;error_log = /x\n  ; indented comment\n[PHP]\ndisplay_errors = Off\ndate.timezone = "Europe/Berlin"\nshort_open_tag = Off\nzlib.output_compression = On\nasp_tags = Off\nengine = off\n# memory_limit = 1M\n';
  const everythingElse = S.add({ '.user.ini': others });
  it('keeps everything else, comments and blank lines and all', () => {
    const r = everythingElse.result();
    expect(r.read('.user.ini')).toBe(others);
    expect(r.changes).toEqual([]);
  });

  const crlf = S.add({ '.user.ini': '  memory_limit = 64M\r\ndate.timezone = UTC\r\n' });
  it('keeps its indentation and a Windows line ending on a line it comments out', () => {
    expect(crlf.result().read('.user.ini')).toBe(`  ${INI_UNUSED}memory_limit = 64M\r\ndate.timezone = UTC\r\n`);
  });

  const each = S.add({ '.user.ini': 'date.timezone = UTC\nmemory_limit = 64M\n; note\nerror_log = /x/y\n' });
  it('reports each line, and only the lines it changed', () => {
    const r = each.result();
    expect(r.changes.map((c) => [c.path, c.line])).toEqual([['.user.ini', 2], ['.user.ini', 4]]);
    expect(r.changes[0]!.what).toBe("memory_limit: commented out, it is lower than the site's own limit, 256M");
    expect(r.changes[1]!.what).toBe('error_log: commented out, errors go to the container log here');
  });

  const sections = S.add({ '.user.ini': 'date.timezone = UTC\n[PATH=/var/www/html/x]\nmemory_limit = 1G\n[PHP]\nlog_errors = On\n[host=example.com]\nshort_open_tag = On\n[ HOST=example.org]\n' });
  it("comments out sections for one path or host and what is in them: PHP-FPM's workers crash on them", () => {
    const r = sections.result();
    expect(r.read('.user.ini')).toBe(`date.timezone = UTC\n${INI_UNUSED}[PATH=/var/www/html/x]\n${INI_UNUSED}memory_limit = 1G\n[PHP]\nlog_errors = On\n${INI_UNUSED}[host=example.com]\n${INI_UNUSED}short_open_tag = On\n${INI_UNUSED}[ HOST=example.org]\n`);
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'UTC', log_errors: '1' });
  });

  const broken = S.add({ '.user.ini': 'date.timezone = UTC\nbad = /x/err(1).log\n', '.htaccess': 'php_value memory_limit 512M\n' });
  it('comments out a line PHP cannot read, because it stops there and what is moved goes after it', () => {
    const r = broken.result();
    expect(r.read('.user.ini')).toContain(`${INI_UNUSED}bad = /x/err(1).log\n`);
    expect(r.ini('.user.ini')).toEqual({ 'date.timezone': 'UTC', memory_limit: '512M' });
    expect(r.warnings).toEqual([]);
  });

  const quotedSections = S.add({ '.user.ini': '\uFEFF[PATH=/x]\nmemory_limit = 1G\n["HOST=y"]\nlog_errors = On\n' });
  it("finds the sections PHP-FPM's workers crash on behind a byte-order mark, or in quotes", () => {
    const text = quotedSections.result().read('.user.ini');
    expect(text.match(new RegExp(INI_UNUSED, 'g'))).toHaveLength(4);
  });

  const showing = S.add({ '.user.ini': 'display_errors = On\ndisplay_startup_errors = 1\nsession.name = 12345\nsession.name = a,b\n' });
  it('comments out what shows errors to visitors, and a session name PHP refuses', () => {
    const r = showing.result();
    expect(r.changes.map((c) => c.what.split(':')[0])).toEqual(['display_errors', 'display_startup_errors', 'session.name', 'session.name']);
  });

  const secret = S.add({ '.htaccess': 'php_value session.save_path "tcp://user:hunter2@cache.example.com:6379"\n', '.user.ini': "session.save_path = 'tcp://other:hunter3@cache.example.com'\n" });
  it('names a setting in its report, and never prints a value that can hold a password', () => {
    const r = secret.result();
    const said = JSON.stringify([...r.changes, ...r.warnings]);
    expect(said).toContain('session.save_path');
    expect(said).not.toContain('hunter');
  });

  const itsOwn = addHtaccess('php_value memory_limit 64M\nphp_value session.save_path /tmp\nphp_value session.save_handler files\n');
  it('does not take what it moved itself for a leftover', () => {
    expect(itsOwn.result().ini('.user.ini')).toEqual({ memory_limit: '64M', 'session.save_path': '/tmp', 'session.save_handler': 'files' });
  });

  const noLimitOwn = noMemoryLimit.add({ '.user.ini': 'memory_limit = 1G\n' });
  it('says plainly when the site has no limit of its own to be lower than', () => {
    expect(noLimitOwn.result().changes[0]!.what).toBe('memory_limit: commented out, the site has no such limit of its own');
  });

  it('does comment out what it moved once its file has gone', () => {
    const root = makeSite({ 'waf.php': '<?php\n' });
    put(root, '.htaccess', `php_value auto_prepend_file ${path.join(root, 'waf.php')}\n`);
    run(root);
    fs.rmSync(path.join(root, 'waf.php'));
    const again = run(root);
    expect(iniAsPhpReadsIt(root, '.user.ini')).toEqual({});
    expect(again.changes.map((c) => c.path)).toEqual(['.user.ini']);
  });
});

describe.skipIf(!CAN_RUN)('handler lines', () => {
  const onlyPhp = ['AddHandler application/x-httpd-php .php', 'AddType application/x-httpd-php .php', 'AddType application/x-httpd-php php', 'AddHandler application/x-httpd-ea-php74 .php', 'addhandler application/x-httpd-php5 .PHP', '<FilesMatch "\\.php$">', 'ForceType application/x-httpd-php', '</FilesMatch>', ''].join('\n');
  const onlyPhpCase = addHtaccess(onlyPhp);
  it("say nothing for lines that only hand .php to PHP: the image's own rule beats these", () => {
    const r = onlyPhpCase.result();
    expect(r.read('.htaccess')).toBe(onlyPhp);
    expect(r.changes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  const elsewhere = 'AddHandler cgi-script .php .phtml\nAddType text/plain .php\nSetHandler none\nForceType text/plain\n<FilesMatch "\\.php$">\nSetHandler default-handler\n</FilesMatch>\n';
  const elsewhereCase = addHtaccess(elsewhere);
  it('say nothing about what hands a file to something else', () => {
    const r = elsewhereCase.result();
    expect(r.read('.htaccess')).toBe(elsewhere);
    expect(r.warnings).toEqual([]);
  });

  it.each(
    (
      [
        ['AddHandler application/x-httpd-php .html', 'files named .html now answer 403'],
        ['AddHandler application/x-httpd-php .php .php5', 'files named .php5 now answer 403'],
        ['ADDHANDLER application/x-httpd-php .HTML', 'files named .HTML now answer 403'],
        ['AddType application/x-httpd-php .html .htm', 'files named .html .htm now answer 403'],
        ['AddHandler php-script .html', 'files named .html now answer 403'],
        ['AddHandler application/x-httpd-php-source .phps', 'files named .phps now answer 403'],
        ['SetHandler application/x-httpd-php', 'all files here but .php now answer 403'],
        ['ForceType application/x-httpd-php', 'all files here but .php now answer 403'],
        // Handlers Apache has never heard of: on both setups, the file is sent as it is.
        ['AddHandler application/x-httpd-ea-php74 .php .php7 .phtml', 'files named .php7 .phtml are sent as they are, source included'],
        ['AddHandler application/x-httpd-php74 .html', 'files named .html are sent as they are'],
        ['AddType application/x-httpd-ea-php81 .phtml', 'files named .phtml are sent as they are'],
        ['SetHandler application/x-httpd-ea-php74', 'all files here but .php are sent as they are'],
      ] as const
    ).map(([line, effect]) => ({ line, effect, c: S.add({ 'sub/dir/.htaccess': `RewriteEngine On\n${line}\n` }) })),
  )('warn about $line', ({ line, effect, c }) => {
    const r = c.result();
    expect(r.read('sub/dir/.htaccess')).toBe(`RewriteEngine On\n${line}\n`);
    expect(r.warnings.map((w) => [w.path, w.line])).toEqual([['sub/dir/.htaccess', 2]]);
    expect(r.warnings[0]!.what).toContain(line);
    expect(r.warnings[0]!.what).toContain(effect);
    expect(r.warnings[0]!.what).toContain('Rename them to .php.');
    // Each run says it again for as long as it is true.
    expect(r.second.warnings.map((w) => w.what)).toEqual(r.warnings.map((w) => w.what));
  });

  it.each(
    (
      [
        ['<FilesMatch "\\.php$">', 'SetHandler application/x-httpd-php', '</FilesMatch>'],
        ['<FilesMatch \\.php$>', 'SetHandler application/x-httpd-php', '</FilesMatch>'],
        ['<FilesMatch "\\.php$">', 'SetHandler php-script', '</FilesMatch>'],
        ['<FilesMatch "^wp-login\\.php$">', 'SetHandler application/x-httpd-php', '</FilesMatch>'],
        ['<Files *.php>', 'SetHandler application/x-httpd-php', '</Files>'],
        ['<Files "*.php">', 'SetHandler application/x-httpd-php', '</Files>'],
        ['<Files ~ "\\.php$">', 'SetHandler application/x-httpd-php', '</Files>'],
        ['<Files index.php>', 'SetHandler application/x-httpd-php', '</Files>'],
        ['<FilesMatch "\\.php$">', 'SetHandler application/x-lsphp74', '</FilesMatch>'],
        ['<FilesMatch "\\.php$">', 'SetHandler application/x-httpd-ea-php74', '</FilesMatch>'],
        ['<FilesMatch "\\.php$">', 'SetHandler "proxy:unix:/var/run/php/php7.4-fpm.sock|fcgi://localhost"', '</FilesMatch>'],
      ] as const
    ).map(([open, line, close]) => ({ open, line, close, c: addHtaccess(`${open}\n${line}\n${close}\n`) })),
  )('comment out $open $line: it takes .php away from PHP-FPM, a 403 for each or its source', ({ open, line, close, c }) => {
    const r = c.result();
    expect(r.read('.htaccess')).toBe(`${open}\n${HANDLER}${line}\n${close}\n`);
    expect(r.warnings).toEqual([]);
    expect(r.changes.map((l) => l.line)).toEqual([2]);
    expect(r.afterUndo('.htaccess')).toBe(`${open}\n${line}\n${close}\n`);
  });

  const mixed = '<FilesMatch "\\.(php|phtml)$">\nSetHandler application/x-httpd-php\n</FilesMatch>\n';
  const mixedCase = addHtaccess(mixed);
  it("stay when the section also takes other files, under mod_php's own name: they would send their source", () => {
    const r = mixedCase.result();
    expect(r.read('.htaccess')).toBe(mixed);
    expect(r.warnings[0]!.what).toContain('every file in that section now answers 403, .php included');
  });

  const litespeed = addHtaccess('<FilesMatch "\\.(php4|php5|php3|php2|php|phtml)$">\nSetHandler application/x-lsphp74\n</FilesMatch>\n');
  it("go when the section takes others under a name Apache doesn't have: .php starts to run, and the rest are sent as before", () => {
    const r = litespeed.result();
    expect(r.read('.htaccess')).toBe(`<FilesMatch "\\.(php4|php5|php3|php2|php|phtml)$">\n${HANDLER}SetHandler application/x-lsphp74\n</FilesMatch>\n`);
    expect(r.warnings[0]!.what).toContain('the other files in that section are sent as they are');
  });

  const noPhp = '<FilesMatch "\\.html$">\nSetHandler application/x-httpd-php\n</FilesMatch>\n<Files noext>\nForceType application/x-httpd-php\n</Files>\n<Files x.html>\nSetHandler php-script\n</Files>\n';
  const noPhpCase = addHtaccess(noPhp);
  it('warn about a section with no .php in it', () => {
    const r = noPhpCase.result();
    expect(r.read('.htaccess')).toBe(noPhp);
    expect(r.warnings.map((w) => w.line)).toEqual([2, 5, 8]);
    expect(r.warnings[0]!.what).toContain('the files in that section now answer 403');
  });

  const liveBlock = '<IfModule mod_php.c>\nAddHandler application/x-httpd-php .html\nAddHandler application/x-httpd-php .php\n</IfModule>\n';
  const liveBlockCase = addHtaccess(liveBlock);
  it('warn about a line in the block mod_php read: it did run those files, and now they send their source', () => {
    const r = liveBlockCase.result();
    expect(r.read('.htaccess')).toBe(liveBlock);
    expect(r.warnings.map((w) => w.line)).toEqual([2]);
    expect(r.warnings[0]!.what).toContain('source included, because this block does nothing now');
  });

  const deadBlock = addHtaccess('<IfModule mod_php7.c>\nAddHandler application/x-httpd-php .html\n</IfModule>\n');
  it('say nothing about one in a block that never applied: nothing changes for those files', () => {
    expect(deadBlock.result().warnings).toEqual([]);
  });

  const socket = '<FilesMatch "\\.(html|htm)$">\nSetHandler "proxy:unix:/run/wpl7/php-fpm.sock|fcgi://localhost"\n</FilesMatch>\n<FilesMatch "\\.php$">\nSetHandler "proxy:unix:/run/wpl7/php-fpm.sock|fcgi://localhost"\n</FilesMatch>\n';
  const socketCase = addHtaccess(socket);
  it("leave the new setup's own socket alone, which only someone on it can have written", () => {
    const r = socketCase.result();
    expect(r.read('.htaccess')).toBe(socket);
    expect(r.warnings).toEqual([]);
  });
});

describe.skipIf(!CAN_RUN)('going through a site', () => {
  it('handles every folder for itself, and a setting stays in its own folder', () => {
    const root = makeSite({
      '.htaccess': 'php_value memory_limit 300M\n',
      'wp-content/.htaccess': 'php_value memory_limit 400M\n',
      'wp-content/uploads/2026/10/.htaccess': 'php_flag display_errors off\n',
      'wp-content/cache/supercache/.htaccess': 'php_value max_input_vars 5000\n',
      'wp-content/plugins/foo/deep/er/.user.ini': 'memory_limit = 1M\n',
    });
    const first = run(root);
    const inis = inisAsPhpReadsThem(root, ['.user.ini', 'wp-content/.user.ini', 'wp-content/uploads/2026/10/.user.ini', 'wp-content/cache/supercache/.user.ini']);
    expect(inis['.user.ini']).toEqual({ memory_limit: '300M' });
    expect(inis['wp-content/.user.ini']).toEqual({ memory_limit: '400M' });
    expect(inis['wp-content/uploads/2026/10/.user.ini']).toEqual({ display_errors: '0' });
    expect(inis['wp-content/cache/supercache/.user.ini']).toEqual({ max_input_vars: '5000' });
    expect(has(root, 'wp-content/uploads/.user.ini')).toBe(false);
    expect(read(root, 'wp-content/plugins/foo/deep/er/.user.ini')).toBe(`${INI_UNUSED}memory_limit = 1M\n`);
    expect(first.summary.written).toBe(9);
    expect(first.summary.files).toBe(5);
    // Every level counted, from the site's own top down to the deepest.
    expect(first.summary.folders).toBe(11);
  });

  it('is fine with a site that has neither file', () => {
    const root = makeSite({ 'index.php': '<?php\n', 'wp-content/themes/x/style.css': '' });
    const first = run(root);
    expect(first.summary.changes + first.summary.warnings + first.summary.written).toBe(0);
    expect(first.summary.folders).toBe(4);
  });

  const elsewhere = makeSite({ '.htaccess': 'php_value memory_limit 300M\n', '.user.ini': 'memory_limit = 1M\n', 'sub/.htaccess': 'php_value memory_limit 300M\n' });
  const elsewhereBefore = fingerprint(elsewhere);
  const links = S.add({ 'real/x.txt': '' });
  fs.symlinkSync(elsewhere, path.join(links.dir, 'folder-link'));
  fs.symlinkSync(path.join(elsewhere, '.htaccess'), path.join(links.dir, '.htaccess'));
  fs.symlinkSync(path.join(elsewhere, '.user.ini'), path.join(links.dir, '.user.ini'));
  fs.symlinkSync('/nowhere', path.join(links.dir, 'real', '.htaccess'));
  fs.symlinkSync('.', path.join(links.dir, 'real', 'loop'));
  it('never follows a link, to a folder or a file, and says so of a file', () => {
    const r = links.result();
    expect(fingerprint(elsewhere)).toEqual(elsewhereBefore);
    expect(fs.lstatSync(path.join(links.dir, '.htaccess')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(links.dir, '.user.ini')).isSymbolicLink()).toBe(true);
    expect(r.warnings.map((w) => w.path).sort()).toEqual(['.htaccess', '.user.ini', 'real/.htaccess']);
    expect(r.warnings[0]!.what).toContain('a link');
  });

  const notFiles = S.add({ '.htaccess/x.txt': '' });
  const fifo = spawnSync('mkfifo', [path.join(notFiles.dir, '.user.ini')]);
  it('does not open what is not a file', () => {
    const r = notFiles.result();
    if (fifo.status === 0) expect(r.warnings.map((w) => w.path)).toEqual(['.user.ini']);
    expect(r.changes).toEqual([]);
  });

  it('holds on to nothing about the folders it has been through', () => {
    const peakOf = (folders: number) => {
      const root = makeSite();
      for (let i = 0; i < folders; i++) fs.mkdirSync(path.join(root, `folder-${i}-with-a-long-enough-name-to-count`));
      return (JSON.parse(run(root).stdout.trim()) as { peakMemory: number }).peakMemory;
    };
    expect(peakOf(4000)).toBe(peakOf(10));
  });
});

describe.skipIf(!CAN_LOCK_FILES)('a file it cannot read or write', () => {
  it('a .htaccess that is read-only is reported, the lines stay, and the rest of the site goes on', () => {
    const root = makeSite({ 'a/.htaccess': 'php_value memory_limit 300M\n', 'b/.htaccess': 'php_value memory_limit 400M\n' });
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o444);
    const res = run(root);
    expect(read(root, 'a/.htaccess')).toBe('php_value memory_limit 300M\n');
    expect(fs.statSync(path.join(root, 'a/.htaccess')).mode & 0o777).toBe(0o444);
    expect(read(root, 'b/.htaccess')).toBe(`${MOVED}php_value memory_limit 400M\n`);
    expect(res.warnings.map((w) => w.path)).toEqual(['a/.htaccess']);
    expect(res.warnings[0]!.what).toContain('could not be written');
    expect(res.warnings[0]!.what).toContain('php_value memory_limit');
    // Its setting has moved already, and the next run finishes the job.
    expect(iniAsPhpReadsIt(root, 'a/.user.ini')).toEqual({ memory_limit: '300M' });
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o644);
    const again = run(root);
    expect(read(root, 'a/.htaccess')).toBe(`${MOVED}php_value memory_limit 300M\n`);
    expect(again.warnings).toEqual([]);
    expect(iniAsPhpReadsIt(root, 'a/.user.ini')).toEqual({ memory_limit: '300M' });
  });

  it('a folder it cannot write in: no temp file, no new .user.ini, reported, and the site goes on', () => {
    const root = makeSite({ 'locked/.htaccess': 'php_value memory_limit 300M\n', 'open/.htaccess': 'php_value memory_limit 400M\n' });
    fs.chmodSync(path.join(root, 'locked'), 0o555);
    const res = run(root);
    fs.chmodSync(path.join(root, 'locked'), 0o755);
    expect(read(root, 'locked/.htaccess')).toBe('php_value memory_limit 300M\n');
    expect(fs.readdirSync(path.join(root, 'locked'))).toEqual(['.htaccess']);
    expect(read(root, 'open/.htaccess')).toBe(`${MOVED}php_value memory_limit 400M\n`);
    expect(res.warnings.map((w) => w.path).sort()).toEqual(['locked/.htaccess', 'locked/.user.ini']);
    expect(res.warnings.find((w) => w.path === 'locked/.user.ini')!.what).toContain('These settings were not moved: memory_limit');
  });

  it('a .user.ini it cannot write: the line must still go, it would be a 500, and the mark tells the truth', () => {
    const root = makeSite({ '.htaccess': 'php_value memory_limit 300M\n', '.user.ini': 'date.timezone = UTC\n' });
    fs.chmodSync(path.join(root, '.user.ini'), 0o444);
    const res = run(root);
    expect(read(root, '.user.ini')).toBe('date.timezone = UTC\n');
    expect(read(root, '.htaccess')).toBe(`${NOT_MOVED}php_value memory_limit 300M\n`);
    expect(res.warnings.map((w) => w.path)).toEqual(['.user.ini']);
    expect(res.warnings[0]!.what).toContain('These settings were not moved: memory_limit');
  });

  it('a .user.ini with a line to comment out that it cannot write is reported too', () => {
    const root = makeSite({ '.user.ini': 'memory_limit = 1M\n' });
    fs.chmodSync(path.join(root, '.user.ini'), 0o444);
    const res = run(root);
    expect(read(root, '.user.ini')).toBe('memory_limit = 1M\n');
    expect(res.changes).toEqual([]);
    expect(res.warnings[0]!.what).toContain('could not be written');
  });

  it('a file it cannot read is reported', () => {
    const root = makeSite({ 'a/.htaccess': 'php_value memory_limit 300M\n', 'a/.user.ini': 'memory_limit = 1M\n', 'b/.htaccess': 'php_value memory_limit 400M\n' });
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o000);
    fs.chmodSync(path.join(root, 'a/.user.ini'), 0o000);
    const res = run(root);
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o644);
    fs.chmodSync(path.join(root, 'a/.user.ini'), 0o644);
    expect(res.warnings.map((w) => w.path).sort()).toEqual(['a/.htaccess', 'a/.user.ini']);
    expect(res.warnings[0]!.what).toContain('could not be read');
    expect(read(root, 'b/.htaccess')).toBe(`${MOVED}php_value memory_limit 400M\n`);
  });

  it('a folder it cannot read or go into is reported', () => {
    const root = makeSite({ 'closed/.htaccess': 'php_value memory_limit 300M\n', 'nolist/.htaccess': 'php_value memory_limit 300M\n', 'nosearch/x.txt': '', 'open/.htaccess': 'php_value memory_limit 400M\n' });
    fs.chmodSync(path.join(root, 'closed'), 0o000);
    fs.chmodSync(path.join(root, 'nolist'), 0o311);
    fs.chmodSync(path.join(root, 'nosearch'), 0o444);
    const res = run(root);
    for (const dir of ['closed', 'nolist', 'nosearch']) fs.chmodSync(path.join(root, dir), 0o755);
    expect(res.warnings.map((w) => w.path).sort()).toEqual(['closed', 'nolist', 'nosearch']);
    expect(read(root, 'open/.htaccess')).toBe(`${MOVED}php_value memory_limit 400M\n`);
    // It can't list that one, but going in was allowed: its files are still there to be read by name.
    expect(read(root, 'nolist/.htaccess')).toBe(`${MOVED}php_value memory_limit 300M\n`);
  });

  it('undo reports what it cannot put back, and goes on', () => {
    const root = makeSite({ 'a/.htaccess': 'php_value memory_limit 300M\n', 'b/.htaccess': 'php_value memory_limit 400M\n' });
    run(root);
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o444);
    const res = run(root, 'undo');
    expect(res.warnings.map((w) => w.path)).toEqual(['a/.htaccess']);
    expect(res.warnings[0]!.what).toContain('stay commented out');
    expect(read(root, 'b/.htaccess')).toBe('php_value memory_limit 400M\n');
  });
});

describe.skipIf(!CAN_RUN)('what it writes', () => {
  it('skips a file over the size it reads, and says so', () => {
    const big = `php_value memory_limit 300M\n${'# padding\n'.repeat(Math.ceil(MAX_SETTINGS_FILE_BYTES / 10))}`;
    const root = makeSite({ 'a/.htaccess': big, 'a/.user.ini': `memory_limit = 1M\n; ${'x'.repeat(MAX_SETTINGS_FILE_BYTES)}\n`, 'b/.htaccess': `${'# padding\n'.repeat(1000)}php_value memory_limit 400M\n` });
    const before = fingerprint(root);
    const res = run(root);
    expect(res.warnings.map((w) => w.path).sort()).toEqual(['a/.htaccess', 'a/.user.ini']);
    expect(res.warnings[0]!.what).toContain('more than is read');
    const after = fingerprint(root);
    expect(after['a/.htaccess']).toBe(before['a/.htaccess']);
    expect(after['a/.user.ini']).toBe(before['a/.user.ini']);
    expect(read(root, 'b/.htaccess').endsWith(`${MOVED}php_value memory_limit 400M\n`)).toBe(true);
  });

  it('has room for two files at that size, made of nothing but what it has to look at', () => {
    const root = makeSite({
      '.htaccess': 'php_flag x y\n'.repeat(Math.floor(MAX_SETTINGS_FILE_BYTES / 13)),
      '.user.ini': 'a=1\n'.repeat(Math.floor(MAX_SETTINGS_FILE_BYTES / 4)),
      'other/.htaccess': 'a\n'.repeat(Math.floor(MAX_SETTINGS_FILE_BYTES / 2)),
    });
    const res = run(root);
    expect(res.warnings).toEqual([]);
    expect(res.summary.changes).toBe(Math.floor(MAX_SETTINGS_FILE_BYTES / 13));
  });

  it('replaces a file in one step, and leaves nothing beside it', () => {
    const root = makeSite({ '.htaccess': 'php_value memory_limit 300M\n' });
    const ino = fs.statSync(path.join(root, '.htaccess')).ino;
    run(root);
    expect(fs.statSync(path.join(root, '.htaccess')).ino).not.toBe(ino);
    expect(fs.readdirSync(root).sort()).toEqual(['.htaccess', '.user.ini']);
  });

  it("keeps a file's mode, and gives a new .user.ini an ordinary one", () => {
    const root = makeSite({ '.htaccess': 'php_value memory_limit 300M\n', 'a/.htaccess': 'php_value memory_limit 300M\n', 'a/.user.ini': 'date.timezone = UTC\n' });
    fs.chmodSync(path.join(root, '.htaccess'), 0o640);
    fs.chmodSync(path.join(root, 'a/.htaccess'), 0o600);
    fs.chmodSync(path.join(root, 'a/.user.ini'), 0o664);
    run(root);
    expect(fs.statSync(path.join(root, '.htaccess')).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(root, '.user.ini')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(root, 'a/.htaccess')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, 'a/.user.ini')).mode & 0o777).toBe(0o664);
    run(root, 'undo');
    expect(fs.statSync(path.join(root, '.htaccess')).mode & 0o777).toBe(0o640);
  });

  it('touches nothing when nothing has to change', () => {
    const root = makeSite({ '.htaccess': '# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n', '.user.ini': 'date.timezone = UTC\n', 'a/.htaccess': '<IfModule mod_rewrite.c>\nRewriteEngine On\n</IfModule>\n' });
    const before = fingerprint(root);
    expect(run(root).summary.written).toBe(0);
    expect(fingerprint(root)).toEqual(before);
    expect(run(root, 'undo').summary.written).toBe(0);
    expect(fingerprint(root)).toEqual(before);
  });

  it('keeps bytes that are not text as they are', () => {
    const htaccess = 'php_value session.name "caf\xe9"\n# caf\xe9\nRewriteEngine On\n';
    const root = makeSite();
    fs.writeFileSync(path.join(root, '.htaccess'), Buffer.from(htaccess, 'latin1'));
    const res = run(root);
    expect(fs.readFileSync(path.join(root, '.htaccess')).toString('latin1')).toBe(`${MOVED}${htaccess}`);
    expect(fs.readFileSync(path.join(root, '.user.ini')).toString('latin1')).toContain("session.name = 'caf\xe9'\n");
    // The report goes through JSON, which can't carry that byte: it still has to arrive.
    expect(res.changes).toHaveLength(1);
    run(root, 'undo');
    expect(fs.readFileSync(path.join(root, '.htaccess')).toString('latin1')).toBe(htaccess);
  });
});

describe.skipIf(!CAN_RUN)('the report', () => {
  it('has a limit, and a summary line that counts everything past it', () => {
    const lines = Array.from({ length: 12_000 }, (_, i) => `php_value no.such.setting.${i} ${'x'.repeat(40)}`).join('\n');
    const root = makeSite({ '.htaccess': `${lines}\n`, 'z/.htaccess': 'AddHandler application/x-httpd-php .html\n' });
    const res = run(root);
    expect(Buffer.byteLength(res.stdout)).toBeLessThan(1024 * 1024);
    expect(res.summary.changes).toBe(12_000);
    expect(res.changes.length).toBeLessThan(12_000);
    expect(res.changes.length).toBeGreaterThan(1000);
    // A warning still gets through however many changes went before it.
    expect(res.warnings.map((w) => w.path)).toEqual(['z/.htaccess']);
    const last = JSON.parse(res.stdout.trim().split('\n').at(-1)!) as { t: string; unreported: number };
    expect(last.t).toBe('summary');
    expect(last.unreported).toBe(12_000 - res.changes.length);
  });

  it('prints only JSON lines, ending in the summary', () => {
    const root = makeSite({ '.htaccess': 'php_value memory_limit 300M\nAddHandler application/x-httpd-php .html\n', '.user.ini': 'error_log = /x\n' });
    const lines = run(root).stdout.trim().split('\n').map((l) => JSON.parse(l) as { t: string });
    expect(lines.at(-1)!.t).toBe('summary');
    expect(lines.slice(0, -1).every((l) => l.t === 'change' || l.t === 'warn')).toBe(true);
    expect(lines.length).toBe(4);
  });

  it('refuses a mode it does not know, and has no summary then', () => {
    const res = runScript(makeSite(), 'wrong', '');
    expect(res.status).toBe(2);
    expect(parseMigrationOutput(res.stdout).summary).toBeNull();
  });
});

describe.skipIf(!CAN_RUN)('undo', () => {
  /** Every kind of line it must restore, with the indentation, line endings and odd spacing they came with. */
  const ALL_THE_LINES = [
    '# BEGIN WordPress\n',
    'php_value memory_limit 300M\n',
    '  php_flag display_errors off\r\n',
    '\t\tPHP_VALUE   date.timezone   "Asia/Tokyo"  \n',
    'php_value session.name \\\n',
    'continued\n',
    'php_value sendmail_path /bin/true\n',
    'php_flag magic_quotes_gpc off\n',
    '<Files x.php>\n',
    '  php_value default_mimetype text/css\n',
    '</Files>\n',
    '<FilesMatch "\\.php$">\n',
    '    SetHandler application/x-httpd-php\n',
    '</FilesMatch>\n',
    '<IfModule mod_php.c>\n',
    'php_value upload_max_filesize 128M\n',
    '</IfModule>\n',
    'php_value max_input_vars 5000',
  ].join('');

  it('restores a .htaccess byte for byte, in every folder', () => {
    const root = makeSite({ '.htaccess': ALL_THE_LINES, 'deep/er/.htaccess': ALL_THE_LINES });
    run(root);
    expect(read(root, '.htaccess')).not.toBe(ALL_THE_LINES);
    const res = run(root, 'undo');
    expect(read(root, '.htaccess')).toBe(ALL_THE_LINES);
    expect(read(root, 'deep/er/.htaccess')).toBe(ALL_THE_LINES);
    expect(res.summary.written).toBe(2);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]!.what).toBe('php_value memory_limit 300M: put back');
    expect(res.changes[0]!.line).toBe(2);
    // Nothing more to do the second time.
    const before = fingerprint(root);
    expect(run(root, 'undo').changes).toEqual([]);
    expect(fingerprint(root)).toEqual(before);
  });

  it('leaves the .user.ini as it is: mod_php does not read it', () => {
    const root = makeSite({ '.htaccess': 'php_value memory_limit 300M\n', '.user.ini': 'error_log = /x\n' });
    run(root);
    const ini = read(root, '.user.ini');
    expect(ini).toContain(`${INI_UNUSED}error_log = /x\n`);
    expect(ini).toContain("memory_limit = '300M'\n");
    run(root, 'undo');
    expect(read(root, '.user.ini')).toBe(ini);
  });

  it('leaves the deny that replaced engine off: it does the same job under mod_php', () => {
    const root = makeSite({ 'a/.htaccess': 'php_flag engine off\nphp_value memory_limit 300M\n' });
    run(root);
    run(root, 'undo');
    expect(read(root, 'a/.htaccess')).toBe(`${DENY}php_flag engine off\n${DENY_BLOCK}php_value memory_limit 300M\n`);
  });

  it('can be followed by another migration, and lands in the same place', () => {
    const root = makeSite({ '.htaccess': ALL_THE_LINES, 'a/.htaccess': WORDFENCE_UPLOADS, 'b/.user.ini': 'memory_limit = 1M\n', 'c/.htaccess': 'php_flag engine off\n' });
    const first = run(root);
    const once = texts(root);
    run(root, 'undo');
    const again = run(root);
    expect(texts(root)).toEqual(once);
    // Nothing that is settled is warned about again, and what isn't still is.
    expect(again.warnings.map((w) => w.what)).toEqual(first.warnings.map((w) => w.what));
  });
});

/** The site in a fake world, with the real script for its throwaway container. */
function worldSite(w: TestWorld): { site: SiteRow; wordpress: string } {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug: 'alpha',
      title: 'alpha',
      serverId: 1,
      domains: '["alpha.test"]',
      phpVersion: '8.4',
      status: 'running',
      dbName: 'alpha',
      dbUser: 'alpha',
      dbPassword: 'x',
      containerName: 'wp-alpha',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const wordpress = sitePaths(w.config, 'alpha').wordpress;
  fs.mkdirSync(wordpress, { recursive: true });
  return { site, wordpress };
}

function jobLog() {
  const info: string[] = [];
  const warn: string[] = [];
  const withheld: string[] = [];
  const log = (level: string, message: string, withoutOutput?: string) => {
    (level === 'warn' ? warn : info).push(message);
    if (withoutOutput !== undefined) withheld.push(withoutOutput);
  };
  const ctx = { log, info: (m: string) => log('info', m), warn: (m: string, w?: string) => log('warn', m, w) } as unknown as JobContext<unknown>;
  return { ctx, info, warn, withheld };
}

const summaryLine = (extra: Record<string, number> = {}) => `${JSON.stringify({ t: 'summary', mode: 'migrate', folders: 3, files: 1, written: 1, changes: 0, warnings: 0, ...extra })}\n`;

describe('running it in the site', () => {
  it("runs from the site's image, locked down, as its user, with its files and its limits", async () => {
    const w = await makeWorld();
    const { site, wordpress } = worldSite(w);
    const p = sitePaths(w.config, 'alpha');
    fs.mkdirSync(path.dirname(p.uploadsIni), { recursive: true });
    fs.writeFileSync(p.uploadsIni, DEFAULT_UPLOADS_INI);
    const opts: Parameters<NonNullable<typeof w.docker.ephemeral>>[0][] = [];
    w.docker.ephemeral = (o) => {
      opts.push(o);
      return { stdout: summaryLine(), stderr: '', exitCode: 0 };
    };
    await migrateSiteForStack2(jobLog().ctx, w.core.servers.handleFor(1), w.core, site);
    const o = opts[0]!;
    expect(o.image).toBe('wpl7-wordpress:php8.4');
    expect(o.entrypoint).toEqual(['php']);
    expect(o.user).toBe('33:33');
    expect(o.binds).toEqual([`${wordpress}:/var/www/html`, `${p.uploadsIni}:/usr/local/etc/php/conf.d/zz-site.ini:ro`]);
    expect(o.lockdown).toBeDefined();
    expect(o.networks).toBeUndefined();
    expect(o.cmd.at(-1)).toBe('migrate');
    expect(o.cmd[o.cmd.indexOf('-r') + 1]).toBe(SITE_MIGRATION_SCRIPT);
    // ini_get has to answer the site's own limit.
    expect(o.cmd.join(' ')).not.toContain('memory_limit=');
    // Generous, and a switch that fails can still run it twice inside its job's 20 minutes.
    expect(o.timeoutMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(o.timeoutMs! * 2).toBeLessThan(20 * 60_000);
  });

  it('goes without the limits when the site has no file for them: a missing source would fail the run', async () => {
    const w = await makeWorld();
    const { site, wordpress } = worldSite(w);
    const binds: (string[] | undefined)[] = [];
    w.docker.ephemeral = (o) => {
      binds.push(o.binds);
      return { stdout: summaryLine(), stderr: '', exitCode: 0 };
    };
    await migrateSiteForStack2(jobLog().ctx, w.core.servers.handleFor(1), w.core, site);
    await undoSiteMigration(jobLog().ctx, w.core.servers.handleFor(1), w.core, site);
    expect(binds).toEqual([[`${wordpress}:/var/www/html`], [`${wordpress}:/var/www/html`]]);
  });

  it('puts every change and warning in the job log, one line each', async () => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    w.docker.ephemeral = () => ({
      stdout:
        `${JSON.stringify({ t: 'change', path: '.htaccess', line: 3, what: 'php_value a b: moved to .user.ini' })}\n` +
        `${JSON.stringify({ t: 'warn', path: 'x/.user.ini', line: 0, what: 'could not be written' })}\n` +
        'not json at all\n' +
        '[1,2]\n' +
        summaryLine({ changes: 1, warnings: 1 }),
      stderr: 'PHP Notice: harmless',
      exitCode: 0,
    });
    const log = jobLog();
    await migrateSiteForStack2(log.ctx, w.core.servers.handleFor(1), w.core, site);
    expect(log.warn).toEqual(['x/.user.ini: could not be written']);
    expect(log.info).toEqual(['.htaccess:3: php_value a b: moved to .user.ini', 'PHP settings: 1 change, 1 warning, in 3 folders.']);
  });

  it('shows what a file says only to a caller who may read a command\'s output', async () => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    const secret = 'php_value session.save_path "tcp://10.0.0.1:6379?auth=hunter2"';
    w.docker.ephemeral = () => ({
      stdout: `${JSON.stringify({ t: 'warn', path: 'x/.htaccess', line: 3, what: `${secret}: not moved to .user.ini` })}\n${JSON.stringify({ t: 'change', path: 'y/.htaccess', line: 4, what: `${secret}: moved` })}\n${summaryLine({ changes: 1, warnings: 1 })}`,
      stderr: '',
      exitCode: 0,
    });
    const log = jobLog();
    await migrateSiteForStack2(log.ctx, w.core.servers.handleFor(1), w.core, site);
    expect(log.warn[0]).toContain('hunter2');
    expect(log.info[0]).toContain('hunter2');
    expect(log.withheld).toEqual(['y/.htaccess:4: what the file says is not shown at Read only access', 'x/.htaccess:3: what the file says is not shown at Read only access']);
  });

  it('caps the log with a count of the rest, for each kind', async () => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    const line = (t: string, i: number) => `${JSON.stringify({ t, path: '.htaccess', line: i + 1, what: 'x' })}\n`;
    const count = MAX_LOGGED_LINES + 25;
    w.docker.ephemeral = () => ({
      stdout: `${Array.from({ length: count }, (_, i) => line('change', i) + line('warn', i)).join('')}${summaryLine({ changes: count + 1000, warnings: count })}`,
      stderr: '',
      exitCode: 0,
    });
    const log = jobLog();
    await migrateSiteForStack2(log.ctx, w.core.servers.handleFor(1), w.core, site);
    expect(log.warn).toHaveLength(MAX_LOGGED_LINES + 1);
    expect(log.warn.at(-1)).toBe('…and 25 more warnings.');
    expect(log.info).toHaveLength(MAX_LOGGED_LINES + 2);
    expect(log.info.at(-2)).toBe('…and 1025 more changes.');
  });

  it('says little about a site with nothing to move', async () => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    w.docker.ephemeral = () => ({ stdout: summaryLine(), stderr: '', exitCode: 0 });
    const log = jobLog();
    await migrateSiteForStack2(log.ctx, w.core.servers.handleFor(1), w.core, site);
    expect(log.info).toEqual(['No PHP settings to move in 3 folders.']);
    expect(log.warn).toEqual([]);
  });

  it.each<[string, RunResult | Error, RegExp]>([
    ['its script failing', { stdout: '', stderr: 'PHP Fatal error: nope', exitCode: 255 }, /failed \(exit 255\): PHP Fatal error: nope/],
    ['a run with no summary line', { stdout: `${JSON.stringify({ t: 'change', path: '.htaccess', line: 1, what: 'half way' })}\n`, stderr: '', exitCode: 0 }, /cut short/],
    ['a summary and a bad exit', { stdout: summaryLine(), stderr: '', exitCode: 137 }, /exit 137/],
    ['no output at all', { stdout: '', stderr: '', exitCode: 0 }, /cut short/],
    ['Docker giving up on it', new Error('Container timed out after 1800000ms'), /timed out/],
  ])('fails the migration on %s, and the undo only warns', async (_, outcome, why) => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    w.docker.ephemeral = () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const handle = w.core.servers.handleFor(1);
    await expect(migrateSiteForStack2(jobLog().ctx, handle, w.core, site)).rejects.toThrow(why);
    const log = jobLog();
    await expect(undoSiteMigration(log.ctx, handle, w.core, site)).resolves.toBeUndefined();
    expect(log.warn.at(-1)).toMatch(why);
    expect(log.warn.at(-1)).toContain('Putting the .htaccess files back did not finish');
  });

  it('logs what a run that failed half-way did: those files have changed', async () => {
    const w = await makeWorld();
    const { site } = worldSite(w);
    w.docker.ephemeral = () => ({ stdout: `${JSON.stringify({ t: 'change', path: '.htaccess', line: 1, what: 'half way' })}\n`, stderr: '', exitCode: 1 });
    const log = jobLog();
    await expect(migrateSiteForStack2(log.ctx, w.core.servers.handleFor(1), w.core, site)).rejects.toThrow(/exit 1/);
    expect(log.info).toEqual(['.htaccess:1: half way']);
  });

  it('does not trust what the container prints', () => {
    const report = parseMigrationOutput(
      [
        JSON.stringify({ t: 'warn', path: 'a\nb\u0007c', line: -4, what: 'x'.repeat(5000) }),
        JSON.stringify({ t: 'change', path: 12, line: 'y', what: null }),
        JSON.stringify({ t: 'other', path: 'z' }),
        JSON.stringify({ t: 'summary', folders: 'lots', changes: -1, warnings: 1.5 }),
        'null',
        '"text"',
      ].join('\n'),
    );
    expect(report.lines[0]).toEqual({ level: 'warn', path: 'a b c', line: 0, what: 'x'.repeat(700) });
    expect(report.lines[1]).toEqual({ level: 'change', path: '', line: 0, what: '' });
    expect(report.lines).toHaveLength(2);
    expect(report.summary).toEqual({ folders: 0, files: 0, written: 0, changes: 0, warnings: 0 });
  });

  it.skipIf(!CAN_RUN)('moves and puts back through the real script, end to end', async () => {
    const w = await makeWorld();
    const { site, wordpress } = worldSite(w);
    const p = sitePaths(w.config, 'alpha');
    fs.mkdirSync(path.dirname(p.uploadsIni), { recursive: true });
    fs.writeFileSync(p.uploadsIni, DEFAULT_UPLOADS_INI);
    const htaccess = 'php_value memory_limit 512M\nAddHandler application/x-httpd-php .html\n';
    fs.writeFileSync(path.join(wordpress, '.htaccess'), htaccess);
    fs.writeFileSync(path.join(wordpress, '.user.ini'), 'upload_max_filesize = 2M\n');
    w.docker.ephemeral = (o) => {
      const [siteDir, ini] = o.binds!.map((b) => b.split(':')[0]!);
      const res = runScript(fs.realpathSync(siteDir!), o.cmd.at(-1)!, ini ? fs.readFileSync(ini, 'utf8') : '');
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? -1 };
    };
    const handle = w.core.servers.handleFor(1);
    const log = jobLog();
    await migrateSiteForStack2(log.ctx, handle, w.core, site);
    expect(read(wordpress, '.htaccess')).toBe(`${MOVED}php_value memory_limit 512M\nAddHandler application/x-httpd-php .html\n`);
    expect(log.info.join('\n')).toContain('.htaccess:1: php_value memory_limit: moved to .user.ini');
    expect(log.info.join('\n')).toContain("upload_max_filesize: commented out, it is lower than the site's own limit, 64M");
    expect(log.warn.join('\n')).toContain('.htaccess:2: AddHandler application/x-httpd-php .html: files named .html now answer 403');
    await undoSiteMigration(log.ctx, handle, w.core, site);
    expect(read(wordpress, '.htaccess')).toBe(htaccess);
    expect(log.info.at(-1)).toBe('.htaccess files put back: 1 line.');
  });
});
