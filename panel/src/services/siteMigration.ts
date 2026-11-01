// @docs reference/limits
import type { SiteRow } from '../db/schema.js';
import type { JobContext } from '../jobs/context.js';
import type { ServerHandle } from '../servers/registry.js';
import type { RunResult } from './docker.js';
import type { CoreServices } from './index.js';
import { siteContainerStack } from './siteCaches.js';
import { siteImage, sitePaths } from './siteSpec.js';

/**
 * A site's own PHP settings, moved from where mod_php read them to where PHP-FPM does, at the
 * moment a site changes from one to the other (jobs/handlers/sites.ts), and again whenever its files
 * come from somewhere else (migrateArrivedFiles).
 *
 * mod_php took settings from `.htaccess` and never read `.user.ini`. PHP-FPM is the other way
 * round, and without mod_php Apache doesn't know `php_value` at all: outside an `<IfModule>` it is
 * a 500 for the folder, inside one it silently stops applying. A `.user.ini` that sat unread for
 * years starts to apply as well, with whatever another host left in it.
 *
 * The work runs where every other change to a site's files runs: in a throwaway container as the
 * site's own user, with nothing but its files mounted, and its limits read-only so that `ini_get`
 * can answer what they are (services/quarantine.ts has the reasoning).
 */

/**
 * Past this a `.htaccess` or `.user.ini` is reported and left alone. Apache reads a `.htaccess` on
 * every request, so real ones stay far under it, long ban lists included, and two at this size made of
 * nothing but directives still fit in the memory the script gives itself.
 */
export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/** What the script prints at most of changes, and again of warnings; past that it only counts. */
const MAX_REPORT_BYTES = 256 * 1024;

/**
 * A site can have hundreds of thousands of files, on a disk others are using. A switch that fails runs
 * this twice, and the job has 20 minutes for that and everything else (jobs/registry.ts).
 */
const MIGRATION_TIMEOUT_MS = 8 * 60_000;

/** Lines of each kind that go in the job log, the rest as a count. */
export const MAX_LOGGED_LINES = 200;

/**
 * Those lines quote the site's files, and a session path can hold a password. So a caller who may not
 * read a command's output gets this instead (lib/dto.ts seesCommands).
 */
const FILE_TEXT_WITHHELD = 'what the file says is not shown at Read only access';

/**
 * PHP for `php -r`, as uid 33: `migrate` or `undo`. Everything it says is JSON lines on stdout,
 * `{"t":"change"|"warn","path","line","what"}` and one `{"t":"summary",…}` last. A run without
 * its summary line was cut short.
 *
 * Both modes can run any number of times: a second run writes nothing. It only says again what
 * still stands and needs a person (a handler line, a file it can't write).
 *
 * It looks in every folder of the site, cache folders too: Apache reads a `.htaccess` wherever it
 * finds one, and a cache plugin's breaks a folder like any other's. It holds one open folder per
 * level it has gone down and no list of anything, so a site's size doesn't change what it needs.
 * It never follows a link: a folder that is one is not entered, and a `.htaccess` or `.user.ini`
 * that is one is reported.
 *
 * Kept free of backticks and dollar-brace, so it fits in a String.raw literal as it is.
 */
export const SITE_MIGRATION_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const ROOT = '/var/www/html';
const MAX_FILE_BYTES = ${MAX_SETTINGS_FILE_BYTES};
const MAX_REPORT_BYTES = ${MAX_REPORT_BYTES};
const S_IFMT = 0170000;
const S_IFDIR = 0040000;
const S_IFREG = 0100000;
const S_IFLNK = 0120000;
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
// What Apache counts as whitespace between the words of a line.
const SPACE = " \t\r\n\f\v";

// Put in front of a .htaccess line that has to go, with its indentation before the mark and nothing
// else touched, so that undo gets back the same bytes. mod_php needs these three back.
const MOVED_MARK = '# Moved to .user.ini by WPL7: ';
const NOT_MOVED_MARK = '# Not moved to .user.ini by WPL7: ';
const HANDLER_MARK = '# Not used with PHP-FPM, by WPL7: ';
const PUT_BACK = '/^([ \t\x0C\x0B]*)(?:# Moved to \.user\.ini by WPL7: |# Not moved to \.user\.ini by WPL7: |# Not used with PHP-FPM, by WPL7: )/';
// This one stays when a switch fails: see the end of undo_folder.
const DENY_MARK = '# Replaced by a deny by WPL7: ';
// The names the panel's own "No PHP in uploads" stops. mod_php with its engine off sent such a file
// as text, and only .php runs on PHP-FPM, so there is nothing else a deny could take away here.
// No line further down could turn PHP back on under mod_php, so none may here: an <If> is applied
// after every other section, where a <FilesMatch> loses to a later <FilesMatch ".*"> with Require all
// granted, here or in a folder below. Satisfy All does the same for a Satisfy Any. All tried on both.
const DENY_OPEN = '<If "%{REQUEST_FILENAME} =~ /\.ph(p[0-9]?|tml|ar|t|ps)$/i">';

// In a .user.ini. The first two also say a .htaccess line has been dealt with: one in a block for
// mod_php stays where it is, and would otherwise be read again, over any later edit of the setting.
const INI_MOVED = '; Moved from .htaccess by WPL7: ';
const INI_LEFT = '; Not moved from .htaccess by WPL7: ';
const INI_UNUSED = '; Not used by WPL7: ';

// <IfModule> blocks for a PHP this Apache doesn't have: what is inside them isn't read, so it can stay
// as it is. A block for anything else is read, so a php_value in it is a 500 like any other.
const PHP_BLOCK = '/^(?:mod_php[0-9]*\.c|php[0-9]*_module|sapi_apache2\.c|mod_lsapi\.c|lsapi_module|litespeed|mod_litespeed\.c)$/i';
// The only two of those mod_php answers to in PHP 8, tried on real Apache and in its source: not
// mod_php7.c, not php8_module. What is in the others never applied here.
const LIVE_PHP_BLOCKS = ['mod_php.c', 'php_module'];
// Sections that apply to less than the folder. A .user.ini can't say that.
const NARROWING_SECTIONS = ['files', 'filesmatch', 'if', 'elseif', 'else', 'limit', 'limitexcept'];

const LIMITS = ['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_time', 'max_input_vars'];
// What belongs to the server a site is on, each with why it has to go when it comes from another.
const HOST_SETTINGS = [
    'open_basedir' => 'it would shut PHP out of files it needs here',
    'session.save_path' => 'sessions have their own folder here',
    'session.save_handler' => 'sessions are kept in files here, and session_start fails without its service',
    'error_log' => 'errors go to the container log here',
    'sys_temp_dir' => 'temporary files have their own folder here',
    'upload_tmp_dir' => 'temporary files have their own folder here',
];

$stats = ['folders' => 0, 'files' => 0, 'written' => 0, 'changes' => 0, 'warnings' => 0, 'unreported' => 0, 'changeBytes' => 0, 'warnBytes' => 0];
$own = [];

function emit(array $line): void { echo json_encode($line, JSON_FLAGS), "\n"; }

/** One line of the report. Changes and warnings each have their own budget: thousands of one can't hide the other. */
function say(string $level, string $path, int $line, string $what): void {
    global $stats;
    $stats[$level === 'warn' ? 'warnings' : 'changes']++;
    $text = json_encode(['t' => $level, 'path' => substr($path, 0, 500), 'line' => $line, 'what' => substr($what, 0, 500)], JSON_FLAGS) . "\n";
    if ($stats[$level . 'Bytes'] + strlen($text) > MAX_REPORT_BYTES) {
        $stats['unreported']++;
        return;
    }
    $stats[$level . 'Bytes'] += strlen($text);
    echo $text;
}

/** A file to work on, or why not: state is ok, absent, or blocked (and the report says why). */
function site_file(string $rel): array {
    global $stats;
    $abs = ROOT . '/' . $rel;
    $none = ['state' => 'absent', 'text' => '', 'mode' => 0644];
    $st = @lstat($abs);
    if ($st === false) return $none;
    $type = $st['mode'] & S_IFMT;
    $why = null;
    if ($type === S_IFDIR) return $none;
    if ($type === S_IFLNK) $why = 'a link, which is not followed, so it was not changed';
    elseif ($type !== S_IFREG) $why = 'not a regular file, so it was not changed';
    elseif ($st['size'] > MAX_FILE_BYTES) $why = $st['size'] . ' bytes, more than is read, so it was not changed';
    $text = $why === null ? @file_get_contents($abs) : false;
    if ($text === false) {
        say('warn', $rel, 0, $why ?? 'could not be read, so it was not changed');
        return ['state' => 'blocked'] + $none;
    }
    $stats['files']++;
    return ['state' => 'ok', 'text' => $text, 'mode' => $st['mode'] & 0777];
}

/**
 * Replaces a file in one step, keeping its mode: a temp file in the same folder, renamed over it.
 * The name is one Apache refuses to serve, should a run be killed in between, and the temp file is
 * created new, so nothing planted under that name is followed. A file the site's user may not
 * write counts as such even when the folder would allow the rename: it is read-only on purpose, or
 * not the site's.
 */
function save(string $rel, string $text, int $mode): bool {
    global $stats;
    $abs = ROOT . '/' . $rel;
    if (@lstat($abs) !== false && !is_writable($abs)) return false;
    $tmp = dirname($abs) . '/.ht-wpl7-' . bin2hex(random_bytes(6));
    $h = @fopen($tmp, 'xb');
    if ($h === false) return false;
    $ok = @fwrite($h, $text) === strlen($text) && @fflush($h);
    fclose($h);
    $ok = $ok && @chmod($tmp, $mode) && @rename($tmp, $abs);
    if (!$ok) {
        @unlink($tmp);
        return false;
    }
    $stats['written']++;
    return true;
}

/** The lines of a file with their own line endings, so that joining them gives the same bytes. */
function split_lines(string $text): array {
    if ($text === '') return [];
    $parts = explode("\n", $text);
    $last = array_pop($parts);
    foreach ($parts as $i => $part) $parts[$i] = $part . "\n";
    if ($last !== '') $parts[] = $last;
    return $parts;
}

function without_eol(string $line): string {
    if (substr($line, -2) === "\r\n") return substr($line, 0, -2);
    return substr($line, -1) === "\n" ? substr($line, 0, -1) : $line;
}

function eol_of(array $lines): string {
    return substr($lines[0] ?? '', -2) === "\r\n" ? "\r\n" : "\n";
}

function ending_a_line(string $line, string $eol): string {
    return substr($line, -1) === "\n" ? $line : $line . $eol;
}

function indent_of(string $line): string {
    return substr($line, 0, strspn($line, " \t\f\v"));
}

function comment_out(string $line, string $mark): string {
    $indent = indent_of($line);
    return $indent . $mark . substr($line, strlen($indent));
}

function deny_block(string $indent, string $eol): string {
    return $indent . DENY_OPEN . $eol . $indent . '    Require all denied' . $eol . $indent . '    Satisfy All' . $eol . $indent . '</If>' . $eol;
}

/** A line cut into words the way Apache does (ap_getword_conf). A backslash only escapes a quote or a backslash. */
function conf_words(string $line): array {
    $words = [];
    $n = strlen($line);
    $i = strspn($line, SPACE);
    while ($i < $n) {
        $quote = $line[$i] === '"' || $line[$i] === "'" ? $line[$i] : '';
        if ($quote !== '') $i++;
        $word = '';
        while ($i < $n && ($quote !== '' ? $line[$i] !== $quote : strpos(SPACE, $line[$i]) === false)) {
            if ($line[$i] === '\\' && $i + 1 < $n && ($line[$i + 1] === '\\' || ($quote !== '' && $line[$i + 1] === $quote))) $i++;
            $word .= $line[$i++];
        }
        if ($quote !== '') $i++;
        $words[] = $word;
        $i += strspn($line, SPACE, min($i, $n));
    }
    return $words;
}

/**
 * The lines of a .htaccess that matter here, each with what is around it. Apache joins a line ending
 * in a backslash to the next before it looks at either, comments included, so a mark on the first
 * line of such a run comments out all of it.
 */
function read_htaccess(array $lines): array {
    $entries = [];
    $open = [];
    $total = count($lines);
    for ($i = 0; $i < $total; $i++) {
        $first = $i;
        $joined = without_eol($lines[$i]);
        while (substr($joined, -1) === '\\' && substr($lines[$i], -1) === "\n" && $i + 1 < $total) {
            $i++;
            $joined = substr($joined, 0, -1) . without_eol($lines[$i]);
        }
        $text = str_replace("\r", ' ', trim($joined, SPACE));
        if ($text === '' || $text[0] === '#') continue;
        if ($text[0] === '<') {
            if (($text[1] ?? '') === '/') {
                array_pop($open);
            } else {
                $words = conf_words(rtrim(substr($text, 1), '>' . SPACE));
                $open[] = ['name' => strtolower($words[0] ?? ''), 'args' => array_slice($words, 1), 'label' => substr($text, 0, 120)];
            }
            continue;
        }
        $words = conf_words($text);
        $directive = strtolower($words[0] ?? '');
        $setting = preg_match('/^php_(admin_)?(value|flag)$/', $directive, $m) === 1;
        if (!$setting && !in_array($directive, ['addhandler', 'addtype', 'sethandler', 'forcetype'], true)) continue;
        // Skipped unread on the new setup. "live": mod_php read it, or nothing stands in the way.
        $inert = false;
        $live = true;
        $scope = null;
        foreach ($open as $section) {
            if ($section['name'] === 'ifmodule' && preg_match(PHP_BLOCK, $section['args'][0] ?? '') === 1) {
                $inert = true;
                if (!in_array($section['args'][0], LIVE_PHP_BLOCKS, true)) $live = false;
            } elseif (in_array($section['name'], NARROWING_SECTIONS, true)) {
                $scope = $section;
            }
        }
        $entry = ['line' => $first, 'last' => $i, 'text' => $text, 'words' => $words, 'directive' => $directive, 'inert' => $inert, 'live' => $live, 'scope' => $scope];
        if (!$setting) {
            $entries[] = ['kind' => 'handler'] + $entry;
            continue;
        }
        $wellFormed = count($words) === 3;
        $problem = null;
        if (!$wellFormed) $problem = 'Apache takes a name and one value here, and refuses anything else';
        elseif ($scope !== null) $problem = 'it is inside ' . $scope['label'] . ', and a .user.ini applies to the whole folder';
        $entries[] = [
            'kind' => $wellFormed && $words[1] === 'engine' ? 'engine' : 'setting',
            'flag' => $m[2] === 'flag',
            'admin' => $m[1] !== '',
            'name' => $words[1] ?? '',
            'value' => $words[2] ?? '',
            // php_admin_* is a 500 in a .htaccess under mod_php, wherever mod_php reads it.
            'ran' => $live && $m[1] === '',
            'problem' => $problem,
        ] + $entry;
    }
    return $entries;
}

function flag_is_on(string $value): bool {
    return strcasecmp($value, 'on') === 0 || $value === '1';
}

/** php_flag takes On or 1 for on and anything else for off, php_value what PHP itself reads as true. Tried on real mod_php. */
function engine_is_on(array $e): bool {
    if ($e['flag']) return flag_is_on($e['value']);
    return in_array(strtolower($e['value']), ['on', 'yes', 'true'], true) || (int) $e['value'] !== 0;
}

/** What mod_php hands to PHP for a line (sapi/apache2handler/apache_config.c). */
function literal_of(array $e): string {
    if ($e['flag']) return flag_is_on($e['value']) ? '1' : '0';
    return strcasecmp($e['value'], 'none') === 0 ? '' : $e['value'];
}

/**
 * A value as a .user.ini has to say it to mean the same string: mod_php passed it on as it was, so
 * nothing in it may be read as a constant, an expression or an on/off. Null when no spelling can.
 */
function ini_value(string $value): ?string {
    if ($value === '') $text = '""';
    elseif (strpos($value, "'") === false) $text = "'" . $value . "'";
    else $text = '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
    $read = @parse_ini_string('k = ' . $text, false, INI_SCANNER_NORMAL);
    return is_array($read) && ($read['k'] ?? null) === $value ? $text : null;
}

/** How PHP reads a size. A float, because nothing stops a file from saying a number no int can hold. */
function quantity(string $value): float {
    if (preg_match('/^\s*([-+]?[0-9]+)\s*([kKmMgG]?)/', $value, $m) !== 1) return 0.0;
    return (float) $m[1] * ['' => 1, 'k' => 1024, 'm' => 1048576, 'g' => 1073741824][strtolower($m[2])];
}

/** A limit as a number to compare, no limit being the most. Each of these has its own word for none. */
function limit_of(string $key, string $value): float {
    $n = quantity($value);
    if ($key === 'memory_limit') return $n < 0 ? INF : $n;
    if ($key === 'max_input_vars') return $n;
    // Without a value of its own (-1) max_input_time follows max_execution_time, so it limits nothing further.
    return $n <= 0 ? INF : $n;
}

function own_limit(string $key): float {
    global $own;
    if ($key === 'max_input_time' && quantity($own[$key]) < 0) return limit_of('max_execution_time', $own['max_execution_time']);
    return limit_of($key, $own[$key]);
}

/**
 * The site's own value. The command line forces these two to no limit whatever the ini files say,
 * and PHP-FPM goes by the files, with PHP's own defaults when they don't say. So they are read
 * from the files, in the order PHP reads them; ini_get is right about the rest.
 */
function own_setting(string $key): string {
    if ($key !== 'max_execution_time' && $key !== 'max_input_time') return (string) ini_get($key);
    $value = $key === 'max_execution_time' ? '30' : '-1';
    $files = array_merge([(string) php_ini_loaded_file()], explode(',', (string) php_ini_scanned_files()));
    foreach ($files as $file) {
        $file = trim($file);
        $read = $file === '' ? false : @parse_ini_file($file);
        if (is_array($read) && isset($read[$key])) $value = (string) $read[$key];
    }
    return $value;
}

/** A path the site ran with is only in the way when it isn't here. */
function path_is_here(string $key, string $value): bool {
    if ($key === 'open_basedir') {
        // It is about the site itself: one that leaves the site out shuts it down.
        foreach (explode(':', $value) as $base) {
            $base = rtrim($base, '/');
            if ($base === '' || strncmp(ROOT . '/', $base . '/', strlen($base) + 1) === 0) return true;
        }
        return false;
    }
    if ($key === 'session.save_path') $value = substr((string) strrchr(';' . $value, ';'), 1);
    if ($value === '' || $value[0] !== '/' || strpos($value, '://') !== false) return true;
    return is_dir($key === 'error_log' ? dirname($value) : $value);
}

/**
 * Why a setting would hurt where it stands; null when it wouldn't.
 *
 * "ran" says the site has been running with it, under mod_php. That is kept unless what it names is
 * gone. What stack 1 never read is another matter: a leftover from another host, where a path from
 * there takes the site down (a 500 for an auto_prepend_file, a 403 for open_basedir, both reproduced
 * on the real image) and a limit from there quietly lowers its own. It is not worth having for what
 * it might add.
 */
function harm(string $key, string $value, string $folder, bool $ran): ?string {
    global $own;
    if ($value === '') return null;
    if ($key === 'auto_prepend_file' || $key === 'auto_append_file') {
        // PHP looks for a relative one from each script's own folder, so all that can be said
        // is that it works beside this file, and mod_php's cwd gave the same answer.
        if ($value[0] !== '/' && $ran) return null;
        $file = $value[0] === '/' ? $value : $folder . '/' . $value;
        return is_file($file) && is_readable($file) ? null : 'the file it names is not here';
    }
    if ($key === 'session.save_handler' && $value === 'files') return null;
    if (isset(HOST_SETTINGS[$key])) {
        if (!$ran) return HOST_SETTINGS[$key];
        return path_is_here($key, $value) ? null : 'the path it names is not here';
    }
    if (!$ran && in_array($key, LIMITS, true) && limit_of($key, $value) < own_limit($key)) {
        if (is_infinite(own_limit($key))) return 'the site has no such limit of its own';
        $shown = $key === 'max_input_time' && quantity($own[$key]) < 0 ? $own['max_execution_time'] : $own[$key];
        return 'it is lower than the site\'s own limit, ' . $shown;
    }
    return null;
}

function not_used(array &$ini, int $i, string $text, string $why): void {
    $ini['lines'][$i] = comment_out($ini['lines'][$i], INI_UNUSED);
    $ini['changes'][] = [$ini['path'], $i + 1, $text . ': commented out, ' . $why];
}

/**
 * A .user.ini that was already there, which mod_php never read: what would hurt now is commented
 * out, and what stays is noted, for what comes from the .htaccess beside it.
 */
function clean_user_ini(array &$ini): void {
    $inSpecial = false;
    foreach ($ini['lines'] as $i => $line) {
        $text = trim(without_eol($line));
        if ($text === '' || $text[0] === ';') continue;
        if ($text[0] === '[') {
            // PHP-FPM's workers crash on these in a .user.ini, an empty one too (a 503 on every
            // script below it, tried on 8.4). What is under one was meant for one path or host.
            $inSpecial = preg_match('/^\[[ \t]*(?:path|host)/i', $text) === 1;
            if ($inSpecial) not_used($ini, $i, $text, 'PHP-FPM\'s workers crash on such a section');
            continue;
        }
        if ($inSpecial) {
            not_used($ini, $i, $text, 'it was in a section PHP-FPM\'s workers crash on');
            continue;
        }
        if (preg_match('/^([^=\s]+)\s*=(.*)$/s', $text, $m) !== 1) continue;
        $read = @parse_ini_string($text, false, INI_SCANNER_NORMAL);
        $value = is_array($read) && is_string($read[$m[1]] ?? null) ? $read[$m[1]] : trim($m[2], " \t\"'");
        $why = harm($m[1], $value, $ini['folder'], isset($ini['movedKeys'][$m[1]]));
        if ($why !== null) {
            not_used($ini, $i, $text, $why);
            continue;
        }
        $ini['active'][$m[1]]['lines'][] = $i;
        $ini['active'][$m[1]]['value'] = $value;
    }
}

function ini_access(string $name): ?int {
    static $all = null;
    $all ??= ini_get_all(null, true);
    return isset($all[$name]) ? (int) $all[$name]['access'] : null;
}

function leave(array $e, array &$ini, string $why): string {
    if ($e['inert']) $ini['add'][] = INI_LEFT . $e['text'];
    say('warn', $ini['htaccess'], $e['line'] + 1, $e['text'] . ': not moved to .user.ini, ' . $why);
    return 'left';
}

/**
 * Decides what becomes of one setting from a .htaccess: moved, left, or unknown to this PHP. Nothing
 * is written yet.
 *
 * When the .user.ini beside it already has the setting: mod_php never read that file, so a line
 * mod_php read is the value the site has been running with, and it wins, the other line being
 * commented out. A line it did not read has no claim over a file another PHP did read, on another
 * host, so that one stays.
 */
function settle(int $index, array $e, array &$ini): string {
    if (isset($ini['records'][INI_MOVED . $e['text']])) return 'moved';
    if (isset($ini['records'][INI_LEFT . $e['text']])) return 'left';
    if ($e['problem'] !== null) return leave($e, $ini, $e['problem']);
    $access = ini_access($e['name']);
    // mod_php took a name PHP doesn't have without a word, so it did nothing, and it does nothing now.
    if ($access === null) return 'unknown';
    // PHP's own test: a .user.ini is read as PHP_INI_PERDIR, which is what a mode of 2 or 7 allows.
    if (($access & 2) === 0) return leave($e, $ini, 'PHP does not allow this setting in .user.ini');
    $literal = literal_of($e);
    $why = harm($e['name'], $literal, $ini['folder'], $e['ran']);
    if ($why !== null) return leave($e, $ini, $why);
    $text = $e['flag'] ? $literal : ini_value($literal);
    if ($text === null) return leave($e, $ini, 'its value cannot be written in a .user.ini');
    $name = $e['name'];
    if (isset($ini['active'][$name])) {
        $current = $ini['active'][$name]['value'];
        $same = $e['flag'] ? filter_var($current, FILTER_VALIDATE_BOOLEAN) === ($literal === '1') : $current === $literal;
        if ($same) return 'moved';
        if (!$e['ran']) return 'left';
        foreach ($ini['active'][$name]['lines'] as $old) {
            not_used($ini, $old, trim(without_eol($ini['lines'][$old])), 'the .htaccess beside it says otherwise, and that is what the site has been running with');
        }
    }
    $ini['add'][] = INI_MOVED . $e['text'];
    $ini['add'][] = $name . ' = ' . $text;
    $ini['added'][] = $index;
    // php_admin_* can't be changed at run time, and a .user.ini doesn't stop that where PHP allows it.
    if ($e['admin'] && ($access & 1) !== 0) say('warn', $ini['htaccess'], $e['line'] + 1, $e['text'] . ': a script can now change this with ini_set, which php_admin_* did not allow');
    if ($e['inert']) $ini['changes'][] = [$ini['htaccess'], $e['line'] + 1, $e['text'] . ': set in .user.ini; this line stays, and does nothing now'];
    return 'moved';
}

/**
 * Which files a <Files> or <FilesMatch> section takes: anything named .php, and anything else. The
 * pattern is tried on names rather than read, so that any way of writing it counts the same.
 */
function section_takes(array $section): array {
    $args = $section['args'];
    $regex = $section['name'] === 'filesmatch' || ($args[0] ?? '') === '~';
    $pattern = ($args[0] ?? '') === '~' ? ($args[1] ?? '') : ($args[0] ?? '');
    $match = $regex
        ? fn(string $name) => @preg_match('~' . str_replace('~', '\~', $pattern) . '~', $name) === 1
        : fn(string $name) => @fnmatch($pattern, $name);
    $other = false;
    foreach (['index.html', 'index.phtml', 'index.php5', 'index.txt', 'index'] as $name) $other = $other || $match($name);
    // A section for one script takes no other name, and still is about .php.
    $php = $match('index.php') || (!$other && preg_match('/\.php\$?$/i', $pattern) === 1);
    return ['php' => $php, 'other' => $other || !$php];
}

/**
 * A line that hands files to PHP by name, all of it checked on the real thing. Only files named .php
 * reach PHP-FPM, and the image's own rule for them beats an AddHandler or AddType, so a line that
 * only names .php needs nothing. A SetHandler in a section is another matter: the section is applied
 * after the image's, so it takes .php away from PHP-FPM, and every one of them answers 403, or sends
 * its source when the handler is one Apache doesn't have. That line is what has to go, and mod_php
 * gets it back from undo. Unless it also takes other files, under mod_php's own name: they'd go from
 * a 403 to sending their source.
 */
function handler_line(array $e, array &$lines, array &$changes, string $path): void {
    $handler = $e['words'][1] ?? '';
    // The new setup's own socket, which someone has set here for it. All that is its own business.
    if (stripos($handler, 'php') === false || stripos($handler, 'proxy:unix:/run/wpl7/') === 0) return;
    if ($e['inert'] && !$e['live']) return;
    $own = preg_match('#^(?:application/x-httpd-php(?:-source)?|php-script)$#i', $handler) === 1;
    if ($e['inert']) $effect = 'are sent as they are, source included, because this block does nothing now';
    elseif ($own) $effect = 'now answer 403';
    else $effect = 'are sent as they are, source included, because Apache has no such handler';
    $warn = fn(string $files, string $verb) => say('warn', $path, $e['line'] + 1, $e['text'] . ': ' . $files . ' ' . $verb . '. Rename them to .php.');

    if ($e['directive'] === 'addhandler' || $e['directive'] === 'addtype') {
        $others = array_filter(array_slice($e['words'], 2), fn($ext) => strcasecmp(ltrim($ext, '.'), 'php') !== 0);
        if ($others !== []) $warn('files named ' . implode(' ', $others), $effect);
        return;
    }
    if ($e['scope'] === null) {
        // Outside any section the image's rule for .php comes later, and wins.
        $warn('all files here but .php', $effect);
        return;
    }
    $isFiles = $e['scope']['name'] === 'files' || $e['scope']['name'] === 'filesmatch';
    $takes = $isFiles ? section_takes($e['scope']) : ['php' => false, 'other' => true];
    if ($e['directive'] === 'forcetype' || $e['inert']) {
        // These don't choose the handler .php has, so .php is not their problem.
        if ($takes['other']) $warn('the files in that section', $effect);
        return;
    }
    if (!$takes['php']) {
        $warn('the files in that section', $effect);
        return;
    }
    if ($own && $takes['other']) {
        say('warn', $path, $e['line'] + 1, $e['text'] . ': every file in that section now answers 403, .php included. Take .php out of the section, and rename the others to .php.');
        return;
    }
    $lines[$e['line']] = comment_out($lines[$e['line']], HANDLER_MARK);
    $changes[] = [$path, $e['line'] + 1, $e['text'] . ': commented out, .php files here go to PHP-FPM and this line would stop that'];
    if ($takes['other']) $warn('the other files in that section', $effect);
}

function migrate_folder(string $dir): void {
    $prefix = $dir === '' ? '' : $dir . '/';
    $htPath = $prefix . '.htaccess';
    $iniPath = $prefix . '.user.ini';
    $ht = site_file($htPath);
    $iniFile = site_file($iniPath);
    if ($ht['state'] !== 'ok' && $iniFile['state'] !== 'ok') return;

    $lines = split_lines($ht['text']);
    $entries = read_htaccess($lines);
    $ini = [
        'path' => $iniPath,
        'htaccess' => $htPath,
        'folder' => $dir === '' ? ROOT : ROOT . '/' . $dir,
        'lines' => split_lines($iniFile['text']),
        'records' => [],
        'movedKeys' => [],
        'active' => [],
        'changes' => [],
        'add' => [],
        'added' => [],
    ];
    foreach ($ini['lines'] as $line) {
        $text = trim(without_eol($line));
        if (strncmp($text, INI_MOVED, strlen(INI_MOVED)) === 0) {
            $ini['records'][$text] = true;
            $key = conf_words(substr($text, strlen(INI_MOVED)))[1] ?? '';
            if ($key !== '') $ini['movedKeys'][$key] = true;
        } elseif (strncmp($text, INI_LEFT, strlen(INI_LEFT)) === 0) {
            $ini['records'][$text] = true;
        }
    }
    clean_user_ini($ini);

    // Of several lines for one setting the last counts, as it did in Apache, but one mod_php read
    // beats any it did not: a block for an older PHP further down never applied.
    $winners = [];
    foreach ($entries as $i => $e) {
        if ($e['kind'] !== 'setting' || $e['problem'] !== null) continue;
        $winner = $winners[$e['name']] ?? null;
        if ($winner === null || $e['ran'] || !$entries[$winner]['ran']) $winners[$e['name']] = $i;
    }
    $fates = [];
    foreach ($entries as $i => $e) {
        if ($e['kind'] === 'setting' && ($e['problem'] !== null || $winners[$e['name']] === $i)) $fates[$i] = settle($i, $e, $ini);
    }

    // The .user.ini goes first. A setting it could not take is still lost from the .htaccess, because
    // the line would be a 500 for the folder, but the report says so and the mark tells the truth.
    $iniText = implode('', $ini['lines']);
    if ($ini['add'] !== []) {
        $eol = eol_of($ini['lines']);
        if ($iniText !== '') $iniText = ending_a_line($iniText, $eol);
        foreach ($ini['add'] as $line) $iniText .= $line . $eol;
    }
    if ($iniText !== $iniFile['text'] && ($iniFile['state'] === 'blocked' || !save($iniPath, $iniText, $iniFile['mode']))) {
        $lost = array_map(fn($i) => $entries[$i]['name'], $ini['added']);
        say('warn', $iniPath, 0, 'could not be written, so nothing changed in it' . ($lost === [] ? '' : '. These settings were not moved: ' . implode(', ', $lost)));
        foreach ($ini['added'] as $i) $fates[$i] = 'left';
    } elseif ($iniText !== '') {
        foreach ($ini['changes'] as $change) say('change', ...$change);
        error_clear_last();
        if (@parse_ini_string($iniText, false, INI_SCANNER_NORMAL) === false) {
            $message = error_get_last()['message'] ?? 'a syntax error';
            say('warn', $iniPath, 0, 'PHP stops reading this file where it goes wrong, so what comes after does not apply: ' . $message);
        }
    }
    if ($ht['state'] !== 'ok') return;

    $hasDeny = strpos($ht['text'], DENY_OPEN) !== false;
    $eol = eol_of($lines);
    $changes = [];
    $denyLater = null;
    foreach ($entries as $i => $e) {
        $at = $e['line'] + 1;
        if ($e['kind'] === 'handler') {
            handler_line($e, $lines, $changes, $htPath);
        } elseif ($e['kind'] === 'setting') {
            if ($e['inert']) continue;
            $fate = $fates[$i] ?? $fates[$winners[$e['name']]];
            $lines[$e['line']] = comment_out($lines[$e['line']], $fate === 'moved' ? MOVED_MARK : NOT_MOVED_MARK);
            if ($fate === 'moved') $changes[] = [$htPath, $at, $e['text'] . ': moved to .user.ini'];
            elseif ($fate === 'unknown') $changes[] = [$htPath, $at, $e['text'] . ': commented out, this PHP has no such setting, so it did nothing'];
            else $changes[] = [$htPath, $at, $e['text'] . ': commented out'];
        } elseif (engine_is_on($e)) {
            if ($e['inert']) continue;
            $lines[$e['line']] = comment_out($lines[$e['line']], NOT_MOVED_MARK);
            $changes[] = [$htPath, $at, $e['text'] . ': commented out, PHP-FPM has no such setting. PHP runs here unless a folder above has a deny.'];
        } elseif ($e['inert']) {
            if ($e['scope'] === null) $denyLater ??= $e;
            else say('warn', $htPath, $at, $e['text'] . ': it is inside ' . $e['scope']['label'] . ' in a block for mod_php, and does nothing now. PHP runs in those files: deny them if it should not.');
        } else {
            // A deny in place of the line, where it can be read in context. It runs on both setups.
            $indent = indent_of($lines[$e['line']]);
            $lines[$e['line']] = comment_out($lines[$e['line']], DENY_MARK);
            $add = '';
            if ($e['scope'] !== null) {
                $add = $indent . 'Require all denied' . $eol . $indent . 'Satisfy All' . $eol;
            } elseif (!$hasDeny) {
                $add = deny_block($indent, $eol);
                $hasDeny = true;
            }
            $lines[$e['last']] = ending_a_line($lines[$e['last']], $eol) . $add;
            $changes[] = [$htPath, $at, $e['text'] . ': replaced by a deny for PHP files'];
        }
    }
    // A block for mod_php stays exactly as it is, because plugins compare theirs word for word and add
    // it again when it differs. So the deny goes at the end, outside anything a plugin regenerates.
    if ($denyLater !== null && !$hasDeny) {
        $last = count($lines) - 1;
        $lines[$last] = ending_a_line($lines[$last], $eol);
        $lines[] = DENY_MARK . $denyLater['text'] . $eol . deny_block('', $eol);
        $changes[] = [$htPath, $denyLater['line'] + 1, $denyLater['text'] . ': this line stays, and does nothing now; a deny for PHP files is added at the end of the file'];
    }
    $text = implode('', $lines);
    if ($text === $ht['text']) return;
    if (save($htPath, $text, $ht['mode'])) {
        foreach ($changes as $change) say('change', ...$change);
    } else {
        $shown = array_map(fn($c) => $c[2], array_slice($changes, 0, 3));
        say('warn', $htPath, 0, 'could not be written. Apache answers 500 for this folder while a bare php_value or php_flag stays in it. Still to change: ' . implode('; ', $shown));
    }
}

/**
 * A switch that failed: mod_php is back, and it wants its lines. The .user.ini stays as it is: mod_php
 * doesn't read it, so what was added does nothing, and "; Not used by WPL7:" lines did nothing under
 * it before they were commented out either. The deny that replaced an engine off stays, because it
 * does the same job under mod_php, with a 403 for the source it used to send. A line in a block was
 * never touched.
 */
function undo_folder(string $dir): void {
    $path = ($dir === '' ? '' : $dir . '/') . '.htaccess';
    $file = site_file($path);
    if ($file['state'] !== 'ok') return;
    $lines = split_lines($file['text']);
    $changes = [];
    foreach ($lines as $i => $line) {
        if (preg_match(PUT_BACK, $line, $m) !== 1) continue;
        $lines[$i] = $m[1] . substr($line, strlen($m[0]));
        $changes[] = [$path, $i + 1, trim(without_eol($lines[$i])) . ': put back'];
    }
    if ($changes === []) return;
    if (save($path, implode('', $lines), $file['mode'])) {
        foreach ($changes as $change) say('change', ...$change);
    } else {
        say('warn', $path, 0, 'could not be written, so ' . count($changes) . ' PHP line(s) in it stay commented out');
    }
}

function walk(callable $visit): void {
    global $stats;
    // One folder per level on the way down, and that is all that is ever held.
    $open = [];
    $enter = function (string $dir) use (&$open, &$stats, $visit): void {
        $stats['folders']++;
        // Before its entries are read: a file replaced in a folder being read may or may not show up.
        $visit($dir);
        $h = @opendir($dir === '' ? ROOT : ROOT . '/' . $dir);
        if ($h === false) {
            say('warn', $dir === '' ? '.' : $dir, 0, 'this folder could not be read, so nothing below it was looked at');
            return;
        }
        $open[] = ['handle' => $h, 'dir' => $dir, 'warned' => false];
    };
    $enter('');
    while ($open !== []) {
        $top = count($open) - 1;
        $name = readdir($open[$top]['handle']);
        if ($name === false) {
            closedir($open[$top]['handle']);
            array_pop($open);
            continue;
        }
        if ($name === '.' || $name === '..') continue;
        $dir = $open[$top]['dir'];
        $rel = $dir === '' ? $name : $dir . '/' . $name;
        $st = @lstat(ROOT . '/' . $rel);
        if ($st === false) {
            if (!$open[$top]['warned']) say('warn', $dir === '' ? '.' : $dir, 0, 'the files in this folder could not be looked at');
            $open[$top]['warned'] = true;
            continue;
        }
        if (($st['mode'] & S_IFMT) === S_IFDIR) $enter($rel);
    }
}

$mode = $argv[1] ?? '';
if ($mode !== 'migrate' && $mode !== 'undo') {
    fwrite(STDERR, "usage: migrate | undo\n");
    exit(2);
}
$started = microtime(true);
foreach (LIMITS as $key) $own[$key] = own_setting($key);
// That was only to compare with. This run needs room for a big .htaccess, whatever the site allows itself.
ini_set('memory_limit', '192M');
walk($mode === 'migrate' ? 'migrate_folder' : 'undo_folder');
emit([
    't' => 'summary',
    'mode' => $mode,
    'folders' => $stats['folders'],
    'files' => $stats['files'],
    'written' => $stats['written'],
    'changes' => $stats['changes'],
    'warnings' => $stats['warnings'],
    'unreported' => $stats['unreported'],
    'elapsedMs' => (int) round((microtime(true) - $started) * 1000),
    'peakMemory' => memory_get_peak_usage(true),
]);
`;

export interface MigrationLine {
  level: 'change' | 'warn';
  path: string;
  line: number;
  what: string;
}

export interface MigrationSummary {
  folders: number;
  files: number;
  written: number;
  changes: number;
  warnings: number;
}

export interface MigrationReport {
  lines: MigrationLine[];
  /** Null when the run was cut short. */
  summary: MigrationSummary | null;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, 700) : '');

/** What the script said, each line on its own: nothing a container prints is trusted, and a stray line is only a stray line. */
export function parseMigrationOutput(stdout: string): MigrationReport {
  const lines: MigrationLine[] = [];
  let summary: MigrationSummary | null = null;
  for (const raw of stdout.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const item = parsed as Record<string, unknown>;
    if (item.t === 'change' || item.t === 'warn') {
      lines.push({ level: item.t, path: text(item.path), line: count(item.line), what: text(item.what) });
    } else if (item.t === 'summary') {
      summary = {
        folders: count(item.folders),
        files: count(item.files),
        written: count(item.written),
        changes: count(item.changes),
        warnings: count(item.warnings),
      };
    }
  }
  return { lines, summary };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Every change and warning, one line each, up to the cap and then how many more. */
function logReport(ctx: JobContext<unknown>, report: MigrationReport): void {
  const place = (l: MigrationLine) => (l.line > 0 ? `${l.path}:${l.line}` : l.path);
  const changes = report.lines.filter((l) => l.level === 'change');
  const warnings = report.lines.filter((l) => l.level === 'warn');
  for (const l of changes.slice(0, MAX_LOGGED_LINES)) ctx.log('info', `${place(l)}: ${l.what}`, `${place(l)}: ${FILE_TEXT_WITHHELD}`);
  for (const l of warnings.slice(0, MAX_LOGGED_LINES)) ctx.warn(`${place(l)}: ${l.what}`, `${place(l)}: ${FILE_TEXT_WITHHELD}`);
  const moreChanges = (report.summary?.changes ?? changes.length) - Math.min(changes.length, MAX_LOGGED_LINES);
  const moreWarnings = (report.summary?.warnings ?? warnings.length) - Math.min(warnings.length, MAX_LOGGED_LINES);
  if (moreChanges > 0) ctx.info(`…and ${plural(moreChanges, 'more change')}.`);
  if (moreWarnings > 0) ctx.warn(`…and ${plural(moreWarnings, 'more warning')}.`);
}

/** Why a run does not count as finished; null when it does. */
function failureOf(res: RunResult, report: MigrationReport): string | null {
  const said = res.stderr.trim().slice(-300);
  if (res.exitCode !== 0) return `its script failed (exit ${res.exitCode})${said ? `: ${said}` : ''}`;
  if (report.summary === null) return `its script was cut short${said ? `: ${said}` : ''}`;
  return null;
}

async function runSiteMigration(server: ServerHandle, s: CoreServices, site: SiteRow, mode: 'migrate' | 'undo'): Promise<RunResult> {
  const p = sitePaths(s.config, site.slug);
  const binds = [`${p.wordpress}:/var/www/html`];
  // A bind whose source is missing fails the run, and undo compares nothing with the site's limits.
  if (mode === 'migrate' && (await server.files.exists(p.uploadsIni))) binds.push(`${p.uploadsIni}:/usr/local/etc/php/conf.d/zz-site.ini:ro`);
  return server.docker.runEphemeral({
    image: siteImage(site.phpVersion),
    entrypoint: ['php'],
    // No memory_limit here, or ini_get would answer that. The two -d are there because that file is
    // the site's to edit, and is only read for its limits, not to say what this script may do.
    cmd: ['-d', 'disable_functions=', '-d', 'open_basedir=', '-r', SITE_MIGRATION_SCRIPT, mode],
    user: '33:33',
    binds,
    labels: { 'wpl7.migration': mode },
    timeoutMs: MIGRATION_TIMEOUT_MS,
    lockdown: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1e9, pidsLimit: 32, tmpfs: { '/tmp': 8 } },
  });
}

/**
 * Moves the site's PHP settings for PHP-FPM, and says what it did. What it reports goes in the job
 * log even when it fails: a run that stops half-way has changed some files. Throws then, and the
 * switch rolls back. A single file it can't change only gets a warning, because the site's own
 * probe says whether that matters.
 */
export async function migrateSiteForStack2(ctx: JobContext<unknown>, server: ServerHandle, s: CoreServices, site: SiteRow): Promise<void> {
  const res = await runSiteMigration(server, s, site, 'migrate');
  const report = parseMigrationOutput(res.stdout);
  logReport(ctx, report);
  const failure = failureOf(res, report);
  if (failure) throw new Error(failure);
  const done = report.summary!;
  ctx.info(
    done.changes === 0 && done.warnings === 0
      ? `No PHP settings to move in ${plural(done.folders, 'folder')}.`
      : `PHP settings: ${plural(done.changes, 'change')}, ${plural(done.warnings, 'warning')}, in ${plural(done.folders, 'folder')}.`,
  );
}

/**
 * The same for files that have just come from somewhere else: an import, a refresh, a restore, the
 * arrival of a move. An old backup or another host brings back what Apache now refuses, and a
 * .user.ini written for a server this isn't. Called once the container is what it is going to be
 * and before it starts, so that no request meets those lines, and what decides is that container:
 * on stack 1 they are what mod_php reads, and they move with the site when it does.
 *
 * Here a failure is only a warning. At the switch there is an old container to go back to; here the
 * site's files and database have already been replaced, and it is better up with one folder answering
 * 500 than not up at all.
 */
export async function migrateArrivedFiles(ctx: JobContext<unknown>, server: ServerHandle, s: CoreServices, site: SiteRow): Promise<void> {
  try {
    if ((await siteContainerStack(server.docker, site.containerName)) !== 2) return;
    ctx.info('Checking the PHP settings in the files that came in…');
    await migrateSiteForStack2(ctx, server, s, site);
  } catch (err) {
    ctx.warn(
      `The PHP settings in this site's files could not be checked: ${err instanceof Error ? err.message : String(err)}. ` +
        'A folder whose .htaccess has a php_value or php_flag line answers 500 until the setting is moved to .user.ini.',
    );
  }
}

/**
 * Puts back what mod_php needs after a switch failed. Never throws: the old container is going back
 * either way, and it is better up with a setting missing than not up.
 */
export async function undoSiteMigration(ctx: JobContext<unknown>, server: ServerHandle, s: CoreServices, site: SiteRow): Promise<void> {
  const unfinished = (why: string) =>
    ctx.warn(`Putting the .htaccess files back did not finish: ${why}. A "# Moved to .user.ini by WPL7:" line that is still there has to be put back by hand, or its setting does not apply.`);
  try {
    const res = await runSiteMigration(server, s, site, 'undo');
    const report = parseMigrationOutput(res.stdout);
    logReport(ctx, report);
    const failure = failureOf(res, report);
    if (failure) unfinished(failure);
    else ctx.info(`.htaccess files put back: ${plural(report.summary!.changes, 'line')}.`);
  } catch (err) {
    unfinished(err instanceof Error ? err.message : String(err));
  }
}
