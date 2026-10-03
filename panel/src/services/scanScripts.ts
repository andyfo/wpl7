/**
 * The code a malware scan runs inside its throwaway containers (services/scanEngines.ts).
 * Both are PHP handed to `php -r`, with the site's files mounted read-only at /var/www/html,
 * no network, and everything they say printed as JSON lines on stdout - one object per line,
 * `{"t":"finding",…}` then one `{"t":"summary",…}` last. A run without its summary line was
 * cut short, and is never read as clean.
 *
 * They never follow a link: every entry is lstat'ed, a folder that is a link is not entered,
 * and a file that is a link is reported when it leads out of the site. Nothing else is
 * mounted, so a link could only ever reach the container's own files anyway.
 *
 * Kept free of backticks and dollar-brace, so each fits in a String.raw literal as it is.
 */

/** Findings a run prints at most; the rest are counted. Keeps the output well under 1 MiB. */
export const MAX_REPORTED_FINDINGS = 500;

/** Files of renamed plugins that did not match, named at most; past it, the whole plugin. */
export const MAX_UNVERIFIED_FILES = 1000;

/** A file header the way WordPress reads one (get_file_data). */
const HEADER_VALUE_PHP = String.raw`
function header_value(string $text, string $name): ?string {
    if (!preg_match('/^[ \t\/*#@]*' . preg_quote($name, '/') . ':(.*)$/mi', $text, $m)) return null;
    $value = trim(preg_replace('/\s*(?:\*\/|\?>).*/', '', $m[1]));
    return $value === '' ? null : substr($value, 0, 60);
}
`;

/**
 * The panel's own check, in the site's image (it has PHP, and the site already trusts it).
 *
 *   inventory          what is installed: WordPress's version and locale, plugins and themes
 *                      with their versions, read from their headers - nothing is executed
 *   check <input.json> the checksums the panel fetched (services/integrityManifests.ts)
 *                      against the files: changed, missing and extra files of WordPress and
 *                      of wordpress.org plugins; PHP and handler tricks in uploads; links
 *                      that lead out of the site. A wordpress.org plugin in a folder of
 *                      another name only has the files that match its list vouched for.
 *                      The panel's own files are held to the hashes it wrote them with, and
 *                      a plugin's deployed copy of one of its files to that file.
 */
export const CHECK_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const ROOT = '/var/www/html';
const MAX_REPORTED = ${MAX_REPORTED_FINDINGS};
const MAX_UNVERIFIED = ${MAX_UNVERIFIED_FILES};
const S_IFMT = 0170000;
const S_IFDIR = 0040000;
const S_IFREG = 0100000;
const S_IFLNK = 0120000;
const PHPISH = '/\.ph(p\d?|tml|ar|t|ps)$/i';
const PHP_ANYWHERE = '/\.ph(p\d?|tml|ar|t|ps)(\.|$)/i';
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
// PHP at the top of a site that is not WordPress's and is still expected: the site's own
// config, the WordPress image's template for it, and Wordfence's firewall loader.
const ROOT_PHP_OF_THEIR_OWN = ['wp-config.php', 'wp-config-docker.php', 'wordfence-waf.php'];
$started = microtime(true);

function emit(array $line): void { echo json_encode($line, JSON_FLAGS), "\n"; }

function kind_of(string $abs): int {
    $st = @lstat($abs);
    return $st === false ? 0 : ($st['mode'] & S_IFMT);
}

/** Names in a folder that is a folder and not a link to one; [] otherwise. */
function list_dir(string $abs): array {
    if (kind_of($abs) !== S_IFDIR) return [];
    $names = @scandir($abs);
    return $names === false ? [] : array_values(array_diff($names, ['.', '..']));
}

/** The first bytes of a regular file that is not a link; null otherwise. */
function head_of(string $abs, int $bytes): ?string {
    if (kind_of($abs) !== S_IFREG) return null;
    $h = @fopen($abs, 'rb');
    if ($h === false) return null;
    $data = fread($h, $bytes);
    fclose($h);
    return $data === false ? null : $data;
}

${HEADER_VALUE_PHP}

function inventory(): array {
    $core = null;
    $version = head_of(ROOT . '/wp-includes/version.php', 65536);
    if ($version !== null && preg_match('/\$wp_version\s*=\s*[\'"]([^\'"]{1,40})[\'"]/', $version, $m)) {
        $locale = preg_match('/\$wp_local_package\s*=\s*[\'"]([^\'"]{1,20})[\'"]/', $version, $l) ? $l[1] : null;
        $core = ['version' => $m[1], 'locale' => $locale];
    }
    $plugins = [];
    $dir = ROOT . '/wp-content/plugins';
    foreach (list_dir($dir) as $name) {
        $abs = $dir . '/' . $name;
        $kind = kind_of($abs);
        if ($kind === S_IFDIR) {
            $files = array_values(array_filter(list_dir($abs), fn($f) => (bool) preg_match('/\.php$/i', $f)));
            sort($files);
            foreach (array_slice($files, 0, 50) as $file) {
                $text = head_of($abs . '/' . $file, 8192);
                if ($text === null || header_value($text, 'Plugin Name') === null) continue;
                $plugins[] = ['slug' => $name, 'version' => header_value($text, 'Version'), 'file' => $name . '/' . $file, 'textDomain' => header_value($text, 'Text Domain')];
                break;
            }
        } elseif ($kind === S_IFREG && preg_match('/\.php$/i', $name)) {
            $text = head_of($abs, 8192);
            if ($text !== null && header_value($text, 'Plugin Name') !== null) {
                $plugins[] = ['slug' => substr($name, 0, -4), 'version' => header_value($text, 'Version'), 'file' => $name, 'single' => true];
            }
        }
    }
    $themes = [];
    $dir = ROOT . '/wp-content/themes';
    foreach (list_dir($dir) as $name) {
        if (kind_of($dir . '/' . $name) !== S_IFDIR) continue;
        $style = head_of($dir . '/' . $name . '/style.css', 8192);
        if ($style === null || header_value($style, 'Theme Name') === null) continue;
        $themes[] = ['slug' => $name, 'version' => header_value($style, 'Version')];
    }
    return ['core' => $core, 'plugins' => $plugins, 'themes' => $themes];
}

/** A line of an .htaccess or .user.ini that makes something run, rather than stops it. */
function enabling_line(string $text): ?string {
    foreach (preg_split('/\r?\n/', $text) as $raw) {
        $line = trim($raw);
        if ($line === '' || $line[0] === '#' || $line[0] === ';') continue;
        // A handler or type mapped to PHP - by its name, the first word; what follows are the
        // extensions, and Wordfence's own guard lists .php among them for cgi-script.
        if ((preg_match('/^(?:Add|Set|Force)(?:Handler|Type)\s+"?([^\s"]+)/i', $line, $m) && preg_match('/php|proxy:fcgi|fcgid-script/i', $m[1]))
            || preg_match('/\bphp_(?:admin_)?(?:flag|value)\s+engine\s+(?:on|1|true)\b/i', $line)
            || (preg_match('/^Options\b(?:.*\s)?\+?ExecCGI\b/i', $line) && !preg_match('/-ExecCGI\b/i', $line))
            || preg_match('/\bauto_(?:prepend|append)_file\b/i', $line)
            || preg_match('/^engine\s*=\s*(?:on|1|true)\b/i', $line)) {
            return substr($line, 0, 200);
        }
    }
    return null;
}

/**
 * The package a path belongs to, when there is a published list to hold it to: WordPress's
 * own folders and top level, and plugins the panel has checksums for. Null otherwise.
 */
function package_of(string $rel, ?string $coreVersion, array $plugins): ?array {
    if (str_starts_with($rel, 'wp-content/plugins/')) {
        $rest = substr($rel, strlen('wp-content/plugins/'));
        $slash = strpos($rest, '/');
        if ($slash === false) return null;
        $slug = substr($rest, 0, $slash);
        if (!is_array($plugins[$slug] ?? null)) return null;
        return ['kind' => 'plugin', 'key' => 'plugin:' . $slug, 'package' => ['package' => 'plugin:' . $slug, 'packageVersion' => (string) ($plugins[$slug]['version'] ?? '')], 'vouchOnly' => ($plugins[$slug]['vouchOnly'] ?? false) === true];
    }
    if ($coreVersion === null) return null;
    $package = ['package' => 'core', 'packageVersion' => $coreVersion];
    if (str_starts_with($rel, 'wp-admin/')) return ['kind' => 'core', 'key' => 'core:wp-admin', 'package' => $package];
    if (str_starts_with($rel, 'wp-includes/')) return ['kind' => 'core', 'key' => 'core:wp-includes', 'package' => $package];
    if (!str_contains($rel, '/')) return ['kind' => 'core', 'key' => 'core:root', 'package' => $package];
    return null;
}

/** A regular file reached through folders only - no link anywhere on the way. */
function regular_inside(string $rel): bool {
    $parts = explode('/', $rel);
    $file = array_pop($parts);
    $at = ROOT;
    foreach ($parts as $part) {
        if ($part === '' || $part === '.' || $part === '..') return false;
        $at .= '/' . $part;
        if (kind_of($at) !== S_IFDIR) return false;
    }
    return $file !== '' && kind_of($at . '/' . $file) === S_IFREG;
}

/** Where a link leads, as a path; null when it stays inside the site. */
function outside_target(string $rel): ?string {
    $target = @readlink(ROOT . '/' . $rel);
    if ($target === false) return '(unreadable link)';
    $base = $target !== '' && $target[0] === '/' ? '' : ROOT . '/' . dirname($rel);
    $parts = [];
    foreach (explode('/', $base . '/' . $target) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') { array_pop($parts); continue; }
        $parts[] = $part;
    }
    $resolved = '/' . implode('/', $parts);
    return ($resolved === ROOT || str_starts_with($resolved, ROOT . '/')) ? null : substr($target, 0, 300);
}

function check(array $input): void {
    global $started;
    $core = is_array($input['core'] ?? null) ? $input['core'] : null;
    $plugins = is_array($input['plugins'] ?? null) ? $input['plugins'] : [];
    $coreVersion = (string) ($input['coreVersion'] ?? '');
    // The panel's own files, each with every hash the panel wrote it with.
    $panel = is_array($input['panel'] ?? null) ? $input['panel'] : [];
    // Copies a plugin deploys of one of its files, each with the file it is a copy of.
    $copies = is_array($input['copies'] ?? null) ? $input['copies'] : [];
    // What package_of() is told: no version at all when there is no list to check against.
    $checkedCore = $core === null ? null : $coreVersion;
    $stats = ['files' => 0, 'dirs' => 0, 'links' => 0, 'other' => 0, 'unreadable' => 0];
    $unreadable = [];
    $found = 0;
    $seenCore = [];
    $seenPlugin = [];
    // Per package ('core:wp-admin', 'core:wp-includes', 'core:root', 'plugin:<slug>'): how many
    // of its files matched, and how many did not. A package with nothing changed and nothing
    // extra is left out of the signature scan - its files are the published ones.
    $packages = [];
    // WordPress's two folders are also counted one level down ('core:wp-includes/js'), so one
    // stray file in wp-includes keeps its own subfolder in the scan rather than all of it.
    $count = function (string $key, string $what, ?string $rel = null) use (&$packages): void {
        $keys = [$key];
        if ($rel !== null && preg_match('#^(wp-admin|wp-includes)/([^/]+)/#', $rel, $m)) $keys[] = 'core:' . $m[1] . '/' . $m[2];
        foreach ($keys as $k) {
            $packages[$k] ??= ['files' => 0, 'verified' => 0, 'modified' => 0, 'extra' => 0, 'missing' => 0];
            if ($what !== 'missing') $packages[$k]['files']++;
            $packages[$k][$what]++;
        }
    };
    $links = [];
    $finding = function (string $kind, string $rel, array $extra = []) use (&$found): void {
        $found++;
        if ($found > MAX_REPORTED) return;
        emit(['t' => 'finding', 'kind' => $kind, 'path' => $rel] + $extra);
    };
    $sha = fn(string $rel) => @hash_file('sha256', ROOT . '/' . $rel) ?: null;
    // A plugin in a folder of another name, held to the list of the wordpress.org plugin it says
    // it is (vouchOnly): a file that matches is vouched for; one that does not is only not
    // vouched for - the folder may hold another edition of the plugin, a premium one, whose own
    // files are no finding. Those are named, so the scanner's findings on them are kept; past
    // the ceiling the whole plugin is.
    $unverifiedLines = 0;
    $unverifiedWhole = [];
    $unvouched = function (string $slug, string $rel) use (&$unverifiedLines, &$unverifiedWhole): void {
        if (isset($unverifiedWhole[$slug])) return;
        if ($unverifiedLines >= MAX_UNVERIFIED) {
            $unverifiedWhole[$slug] = true;
            emit(['t' => 'unverified-package', 'package' => 'plugin:' . $slug]);
            return;
        }
        $unverifiedLines++;
        emit(['t' => 'unverified', 'path' => $rel]);
    };
    $unread = function (string $rel) use (&$stats, &$unreadable): void {
        $stats['unreadable']++;
        if (count($unreadable) < 20) $unreadable[] = $rel;
    };

    $stack = [''];
    while ($stack) {
        $dirRel = array_pop($stack);
        $h = @opendir($dirRel === '' ? ROOT : ROOT . '/' . $dirRel);
        if ($h === false) { $unread($dirRel === '' ? '.' : $dirRel); continue; }
        while (($name = readdir($h)) !== false) {
            if ($name === '.' || $name === '..') continue;
            $rel = $dirRel === '' ? $name : $dirRel . '/' . $name;
            $abs = ROOT . '/' . $rel;
            $st = @lstat($abs);
            if ($st === false) { $unread($rel); continue; }
            $type = $st['mode'] & S_IFMT;
            if ($type === S_IFDIR) { $stats['dirs']++; $stack[] = $rel; continue; }
            if ($type === S_IFLNK) {
                $stats['links']++;
                if (count($links) < 1000) $links[] = $rel;
                $target = outside_target($rel);
                if ($target !== null) { $finding('link-outside', $rel, ['detail' => $target]); }
                // The panel never writes its own file as a link.
                if (is_array($panel[$rel] ?? null)) {
                    $link = @readlink($abs);
                    $finding('panel-modified', $rel, ['detail' => 'a link to ' . substr((string) $link, 0, 280)]);
                    continue;
                }
                // A link among WordPress's own files or a checked plugin's is an extra entry
                // there: Apache follows it, so it can make any file answer as that name.
                $where = package_of($rel, $checkedCore, $plugins);
                if ($where !== null) {
                    $count($where['key'], 'extra', $rel);
                    if ($target === null && empty($where['vouchOnly'])) {
                        $link = @readlink($abs);
                        $finding($where['kind'] . '-extra', $rel, $where['package'] + ['detail' => 'a link to ' . substr((string) $link, 0, 280)]);
                    }
                }
                continue;
            }
            if ($type !== S_IFREG) { $stats['other']++; continue; }
            $stats['files']++;
            $lower = strtolower($name);

            // A copy a plugin deploys of one of its own files is that file, wherever it is.
            $source = $copies[$rel] ?? null;
            if (is_string($source) && regular_inside($source)) {
                $mine = $sha($rel);
                if ($mine !== null && $mine === $sha($source)) {
                    emit(['t' => 'copy', 'path' => $rel, 'source' => $source]);
                    continue;
                }
            }

            // The panel's own file: what it wrote, or a finding.
            if (is_array($panel[$rel] ?? null)) {
                $hash = $sha($rel);
                if ($hash === null) { $unread($rel); continue; }
                if (!in_array($hash, $panel[$rel], true)) $finding('panel-modified', $rel, ['sha256' => $hash]);
                continue;
            }

            if (str_starts_with($rel, 'wp-content/uploads/')) {
                if (preg_match(PHP_ANYWHERE, $name)) {
                    $finding('upload-php', $rel, ['sha256' => $sha($rel)]);
                } elseif (in_array($lower, ['.htaccess', '.user.ini', 'php.ini'], true)) {
                    $text = head_of($abs, 65536);
                    if ($text === null) { $unread($rel); continue; }
                    $line = enabling_line($text);
                    if ($line !== null) $finding('upload-handler', $rel, ['sha256' => $sha($rel), 'detail' => $line]);
                }
                continue;
            }

            if (str_starts_with($rel, 'wp-content/plugins/')) {
                $rest = substr($rel, strlen('wp-content/plugins/'));
                $slash = strpos($rest, '/');
                if ($slash === false) continue;
                $slug = substr($rest, 0, $slash);
                $inner = substr($rest, $slash + 1);
                $manifest = $plugins[$slug] ?? null;
                if (!is_array($manifest)) continue;
                $vouchOnly = ($manifest['vouchOnly'] ?? false) === true;
                $package = ['package' => 'plugin:' . $slug, 'packageVersion' => (string) ($manifest['version'] ?? '')];
                $hashes = $manifest['files'][$inner] ?? null;
                if (is_array($hashes)) {
                    $seenPlugin[$slug][$inner] = true;
                    $hash = @hash_file('sha256', $abs);
                    if ($hash === false) { $unread($rel); continue; }
                    if (in_array($hash, $hashes, true)) { $count('plugin:' . $slug, 'verified'); continue; }
                    $count('plugin:' . $slug, 'modified');
                    if ($vouchOnly) { $unvouched($slug, $rel); continue; }
                    $finding('plugin-modified', $rel, $package + ['sha256' => $hash]);
                } else {
                    $count('plugin:' . $slug, 'extra');
                    if ($vouchOnly) continue;
                    // Reported when it can run; a stray image or log file only keeps the
                    // plugin in the signature scan.
                    if (preg_match(PHPISH, $name) || in_array($lower, ['.htaccess', '.user.ini'], true)) {
                        $finding('plugin-extra', $rel, $package + ['sha256' => $sha($rel)]);
                    }
                }
                continue;
            }

            $where = package_of($rel, $checkedCore, $plugins);
            if ($where === null || $where['kind'] !== 'core') continue;
            $package = $where['package'];
            $hashes = $core['files'][$rel] ?? null;
            if (is_array($hashes)) {
                $seenCore[$rel] = true;
                $hash = @md5_file($abs);
                if ($hash === false) { $unread($rel); continue; }
                if (in_array($hash, $hashes, true)) { $count($where['key'], 'verified', $rel); continue; }
                $count($where['key'], 'modified', $rel);
                $finding('core-modified', $rel, $package + ['sha256' => $sha($rel)]);
            } elseif ($where['key'] !== 'core:root') {
                $count($where['key'], 'extra', $rel);
                if (!in_array($lower, ['error_log', '.ds_store', 'thumbs.db', 'desktop.ini'], true)) {
                    $finding('core-extra', $rel, $package + ['sha256' => $sha($rel)]);
                }
            } elseif (preg_match(PHPISH, $name) && !in_array($lower, ROOT_PHP_OF_THEIR_OWN, true)) {
                $count($where['key'], 'extra');
                $finding('core-extra', $rel, $package + ['sha256' => $sha($rel)]);
            }
        }
        closedir($h);
    }

    // Missing files: WordPress's own outside wp-content (which a site may prune and update on
    // its own), minus the three a hardened site deletes on purpose; a plugin's, all of them.
    $missing = 0;
    if ($core !== null) {
        foreach ($core['files'] as $path => $_) {
            $path = (string) $path;
            if (str_starts_with($path, 'wp-content/') || isset($seenCore[$path])) continue;
            if (in_array($path, ['readme.html', 'license.txt', 'wp-config-sample.php'], true)) continue;
            $where = package_of($path, $coreVersion, []);
            if ($where !== null) $count($where['key'], 'missing', $path);
            if (++$missing <= 50) $finding('core-missing', $path, ['package' => 'core', 'packageVersion' => $coreVersion]);
        }
    }
    foreach ($plugins as $slug => $manifest) {
        if (!is_array($manifest) || !is_array($manifest['files'] ?? null)) continue;
        if (($manifest['vouchOnly'] ?? false) === true) continue;
        $gone = 0;
        foreach ($manifest['files'] as $path => $_) {
            if (isset($seenPlugin[$slug][(string) $path])) continue;
            $count('plugin:' . $slug, 'missing');
            if (++$gone <= 50) $finding('plugin-missing', 'wp-content/plugins/' . $slug . '/' . $path, ['package' => 'plugin:' . $slug, 'packageVersion' => (string) ($manifest['version'] ?? '')]);
        }
    }

    emit([
        't' => 'summary',
        'engine' => 'check',
        'complete' => $stats['unreadable'] === 0,
        'files' => $stats['files'],
        'dirs' => $stats['dirs'],
        'linkCount' => $stats['links'],
        'unreadable' => $stats['unreadable'],
        'unreadableSample' => $unreadable,
        'findings' => $found,
        'truncated' => $found > MAX_REPORTED,
        'packages' => (object) $packages,
        'links' => $links,
        'linksTruncated' => $stats['links'] > count($links),
        'elapsedMs' => (int) round((microtime(true) - $started) * 1000),
        'peakMemory' => memory_get_peak_usage(true),
    ]);
}

$mode = $argv[1] ?? '';
if ($mode === 'inventory') {
    emit(['t' => 'inventory'] + inventory());
    exit(0);
}
if ($mode === 'check') {
    $raw = @file_get_contents($argv[2] ?? '');
    $input = $raw === false ? null : json_decode($raw, true);
    if (!is_array($input)) { fwrite(STDERR, "unreadable input\n"); exit(2); }
    check($input);
    exit(0);
}
fwrite(STDERR, "usage: inventory | check <input.json>\n");
exit(2);
`;

/** Where AMWScan's image keeps the scanner: a phar, its definitions inside it. */
export const SCANNER_IN_IMAGE = '/usr/local/bin/scanner';
/** The local-rules folder the scanner is pointed at (scanEngines.ts), in its tmpfs. */
export const LOCAL_RULES_DIR = '/tmp/amwscan/rules';

/**
 * Before the scanner runs: WPL7's exploit overrides (services/scanTuning.ts) written into its
 * local-rules folder - only those whose pattern AMWScan still has exactly as it was replaced,
 * read from the definitions inside the scanner itself. Any doubt, and the scanner runs on its
 * own patterns: an override never outlives the pattern it was written against. Prints one
 * {"t":"tuning"} line, applied and skipped.
 *
 *   argv[1] the scanner (or, for a test, a definitions archive itself), argv[2] the tuning
 *   (JSON), argv[3] the local-rules folder
 */
export const RULES_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
function emit(array $line): void { echo json_encode($line, JSON_FLAGS), "\n"; }
$scanner = (string) ($argv[1] ?? '');
$tuning = json_decode((string) ($argv[2] ?? ''), true);
$dir = (string) ($argv[3] ?? '');
$overrides = array_values(array_filter(
    is_array($tuning['overrides'] ?? null) ? $tuning['overrides'] : [],
    fn($o) => is_array($o) && is_string($o['name'] ?? null) && is_string($o['replaces'] ?? null) && is_string($o['pattern'] ?? null),
));
$none = function (string $why) use ($overrides): void {
    emit(['t' => 'tuning', 'applied' => [], 'skipped' => array_map(fn($o) => ['name' => $o['name'], 'why' => $why], $overrides)]);
    exit(0);
};
if ($overrides === []) $none('');

// The definitions are a gzipped tar inside the scanner's phar; exploits.json is one entry.
$gz = false;
if (str_ends_with($scanner, '.amwdb')) {
    $gz = @file_get_contents($scanner);
} else {
    try {
        Phar::loadPhar($scanner, 'wpl7-amwscan-rules.phar');
        $gz = @file_get_contents('phar://wpl7-amwscan-rules.phar/resources/definitions/definitions.amwdb');
    } catch (Throwable $e) {
        $gz = false;
    }
}
$tar = is_string($gz) ? @gzdecode($gz, 33554432) : false;
if (!is_string($tar)) $none('definitions unreadable');
$official = null;
for ($at = 0; $at + 512 <= strlen($tar);) {
    $name = rtrim(substr($tar, $at, 100), "\0");
    if ($name === '') break;
    $size = octdec(trim(substr($tar, $at + 124, 12), "\0 "));
    if ($name === 'exploits.json') {
        $official = json_decode(substr($tar, $at + 512, $size), true);
        break;
    }
    $at += 512 + (int) ceil($size / 512) * 512;
}
if (!is_array($official) || !is_array($official['default'] ?? null)) $none('definitions unreadable');

$rules = [];
$applied = [];
$skipped = [];
foreach ($overrides as $o) {
    $theirs = $official['default'][$o['name']] ?? null;
    if (!is_array($theirs)) {
        $skipped[] = ['name' => $o['name'], 'why' => 'gone upstream'];
    } elseif (($theirs['pattern'] ?? null) !== $o['replaces']) {
        $skipped[] = ['name' => $o['name'], 'why' => 'changed upstream'];
    } elseif (@preg_match($o['pattern'], '') === false) {
        $skipped[] = ['name' => $o['name'], 'why' => 'does not compile'];
    } else {
        $rules[$o['name']] = ['pattern' => $o['pattern']] + $theirs;
        $applied[] = $o['name'];
    }
}
if ($rules !== []) {
    $file = json_encode([
        'schemaVersion' => $official['schemaVersion'] ?? 1,
        'default' => $rules,
        'liteOverrides' => new stdClass(),
        'liteExclusions' => [],
    ], JSON_UNESCAPED_SLASHES);
    if (!(is_dir($dir) || @mkdir($dir, 0700, true)) || @file_put_contents($dir . '/exploits.json', $file) !== strlen((string) $file)) {
        foreach ($applied as $name) $skipped[] = ['name' => $name, 'why' => 'rules not written'];
        $applied = [];
    }
}
emit(['t' => 'tuning', 'applied' => $applied, 'skipped' => $skipped]);
`;

/**
 * AMWScan's side. The scanner writes its JSON report into the container's tmpfs - it can run
 * to many megabytes - and this reads it there and prints what the panel keeps: the findings,
 * the most serious first and at most MAX_REPORTED_FINDINGS of them, then a summary with the
 * scanner's own account of how far it got. Paths come back relative to the site.
 *
 * Left out (services/scanTuning.ts says why):
 *   - "integrity" notes - a file matching some older WordPress release; the check says more
 *     about those files than that, and on a stock install they outnumber everything else
 *   - presence checks at the warning level - a call to eval(), exec() and the like, or to a
 *     framework's process runner: what plugins do; counted, not reported
 *   - oversized scripts - files only partly read: listed in the summary, not findings
 *   - inert signatures, by the signature's own id
 *
 * A signature finding is renamed after the signature that matched (signature:<id>): AMWScan
 * names it after its place in a merged list of regexes, which moves whenever its definitions
 * do. Where the scanner's own code cannot say which signature it was, AMWScan's name stays.
 *
 *   argv[1] the report, argv[2] the scanner's exit code (0 clean, 1 findings, 2 failed),
 *   argv[3] the container's peak memory in bytes, argv[4] what the scanner printed,
 *   argv[5] the tuning (JSON), argv[6] the scanner (or, for a test, a JSON file of its merged
 *   signatures by name)
 */
export const REDUCER_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const ROOT = '/var/www/html/';
const MAX_REPORTED = ${MAX_REPORTED_FINDINGS};
const MAX_PARTIAL = 50;
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
function emit(array $line): void { echo json_encode($line, JSON_FLAGS), "\n"; }
function short($v, int $n): ?string { return is_scalar($v) ? substr((string) $v, 0, $n) : null; }
function tail_of(string $file, int $bytes): string {
    $size = @filesize($file);
    if ($size === false || $size === 0) return '';
    $h = @fopen($file, 'rb');
    if ($h === false) return '';
    fseek($h, max(0, $size - $bytes));
    $text = (string) fread($h, $bytes);
    fclose($h);
    return trim(preg_replace('/\e\[[0-9;]*m/', '', $text));
}
function relative(string $subject): string {
    return substr(str_starts_with($subject, ROOT) ? substr($subject, strlen(ROOT)) : $subject, 0, 1024);
}

$exit = (int) ($argv[2] ?? 2);
$peak = (int) ($argv[3] ?? 0);
$said = tail_of($argv[4] ?? '', 600);
$tuning = json_decode((string) ($argv[5] ?? ''), true);
$inert = array_fill_keys(array_filter(is_array($tuning['inert'] ?? null) ? $tuning['inert'] : [], 'is_string'), true);
$scanner = (string) ($argv[6] ?? '');
$raw = @file_get_contents($argv[1] ?? '');
$report = $raw === false ? null : json_decode($raw, true);
unset($raw);
if (!is_array($report)) {
    emit(['t' => 'summary', 'engine' => 'signatures', 'exit' => $exit, 'report' => false, 'peakMemory' => $peak, 'said' => $said]);
    exit(0);
}

// AMWScan's merged signature regexes by the name it reports them under - crc32b of their place
// in its list - each with a named group (?<X + crc32b of the signature>) after every signature
// in it. Matching the reported text again says which signature it was. Loaded on first need.
$groups = null;
$signatureOf = function (string $rule, string $match) use (&$groups, $scanner): ?string {
    if ($match === '') return null;
    if ($groups === null) {
        $groups = [];
        try {
            if (str_ends_with($scanner, '.json')) {
                $groups = json_decode((string) @file_get_contents($scanner), true) ?: [];
            } elseif ($scanner !== '' && is_file($scanner)) {
                Phar::loadPhar($scanner, 'wpl7-amwscan-reducer.phar');
                require 'phar://wpl7-amwscan-reducer.phar/bootstrap/autoload.php';
                foreach (\AMWScan\Detection\Signatures::getAll() as $i => $p) $groups[hash('crc32b', (string) $i)] = $p;
            }
        } catch (Throwable $e) {
            $groups = [];
        }
    }
    $p = $groups[substr($rule, strlen('sign:'))] ?? null;
    if (!is_string($p) || @preg_match('#' . $p . '#smiS', $match, $m, PREG_UNMATCHED_AS_NULL) !== 1) return null;
    foreach ($m as $k => $v) {
        if (is_string($k) && preg_match('/^X([0-9a-f]{8})$/', $k, $id) && $v !== null) return $id[1];
    }
    return null;
};

$presence = 0;
$dropped = 0;
$unnamed = 0;
$partial = [];
$partialCount = 0;
$findings = [];
foreach (is_array($report['findings'] ?? null) ? $report['findings'] : [] as $f) {
    if (!is_array($f)) continue;
    $rule = (string) ($f['rule_id'] ?? '');
    $family = strstr($rule, ':', true) ?: $rule;
    $evidence = is_array($f['evidence'] ?? null) ? $f['evidence'] : [];
    if ($family === 'integrity') continue;
    if (($family === 'function' || $family === 'process') && ($f['severity'] ?? '') !== 'danger') {
        $presence++;
        continue;
    }
    if ($family === 'file_size') {
        if (++$partialCount <= MAX_PARTIAL) {
            $bytes = preg_match('/File size: (\d+) bytes/', (string) ($evidence['match'] ?? ''), $b) ? (int) $b[1] : null;
            $partial[] = ['path' => relative((string) ($f['subject'] ?? '')), 'bytes' => $bytes];
        }
        continue;
    }
    if ($family === 'sign') {
        $id = $signatureOf($rule, is_string($evidence['match'] ?? null) ? $evidence['match'] : '');
        if ($id === null) {
            $unnamed++;
        } elseif (isset($inert[$id])) {
            $dropped++;
            continue;
        } else {
            $f['rule_id'] = 'signature:' . $id;
            $f['message'] = 'Malware signature ' . $id;
        }
    }
    $findings[] = $f;
}

$severityRank = ['danger' => 0, 'warn' => 1, 'info' => 2];
$ruleRank = function (string $rule): int {
    $prefix = strstr($rule, ':', true) ?: $rule;
    return ['sign' => 0, 'signature' => 0, 'hash' => 0, 'exploit' => 1, 'function' => 3][$prefix] ?? 2;
};
usort($findings, fn($a, $b) =>
    [($severityRank[$a['severity'] ?? 'info'] ?? 3), $ruleRank((string) ($a['rule_id'] ?? ''))]
    <=> [($severityRank[$b['severity'] ?? 'info'] ?? 3), $ruleRank((string) ($b['rule_id'] ?? ''))]);
$count = 0;
foreach ($findings as $f) {
    if (++$count > MAX_REPORTED) continue;
    $evidence = is_array($f['evidence'] ?? null) ? $f['evidence'] : [];
    emit([
        't' => 'finding',
        'path' => relative((string) ($f['subject'] ?? '')),
        'kind' => short($f['kind'] ?? null, 40),
        'rule' => short($f['rule_id'] ?? null, 200),
        'severity' => short($f['severity'] ?? null, 10),
        'message' => short($f['message'] ?? null, 300),
        'line' => is_int($evidence['line'] ?? null) ? $evidence['line'] : null,
        'match' => short($evidence['match'] ?? null, 200),
        // The file's SHA-256 as the scanner read it: what a quarantine checks before it moves.
        'sha256' => is_string($evidence['content_hash'] ?? null) && preg_match('/^[0-9a-f]{64}$/', $evidence['content_hash']) ? $evidence['content_hash'] : null,
    ]);
}
$coverage = is_array($report['coverage'] ?? null) ? $report['coverage'] : [];
$reasons = is_array($coverage['reasons'] ?? null) ? $coverage['reasons'] : [];
emit([
    't' => 'summary',
    'engine' => 'signatures',
    'exit' => $exit,
    'report' => true,
    'scanned' => is_int($report['scanned'] ?? null) ? $report['scanned'] : null,
    'complete' => ($coverage['complete'] ?? null) === true,
    'discovered' => is_int($coverage['discovered'] ?? null) ? $coverage['discovered'] : null,
    'errors' => is_int($coverage['errors'] ?? null) ? $coverage['errors'] : null,
    'unreadable' => is_int($reasons['unreadable'] ?? null) ? $reasons['unreadable'] : null,
    'definitions' => short($report['signature_indexes']['amwscan_bundle']['version'] ?? null, 40),
    'findings' => $count,
    'truncated' => $count > MAX_REPORTED,
    'presence' => $presence,
    'inert' => $dropped,
    'unnamed' => $unnamed,
    'partial' => $partial,
    'partialCount' => $partialCount,
    'peakMemory' => $peak,
    'said' => $exit >= 2 ? $said : '',
]);
`;

/**
 * Runs the tuning, the scanner, then the reducer over its report, in the same container.
 * Positional arguments only: the tuning's code, the tuning, the reducer's code, PHP's memory
 * limit, then the scanner's own arguments.
 */
export const SIGNATURES_SHELL = [
  'set -u',
  'rules=$1; tuning=$2; reducer=$3; memory=$4; shift 4',
  'mkdir -p /tmp/amwscan',
  `php -d memory_limit=64M -r "$rules" ${SCANNER_IN_IMAGE} "$tuning" ${LOCAL_RULES_DIR}`,
  `php -d memory_limit="$memory" ${SCANNER_IN_IMAGE} "$@" >/tmp/amwscan/output 2>&1`,
  'code=$?',
  'peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)',
  `exec php -d memory_limit=128M -r "$reducer" /tmp/amwscan/report.json "$code" "$peak" /tmp/amwscan/output "$tuning" ${SCANNER_IN_IMAGE}`,
].join('\n');

/** Files of a catalog zip that are hashed at most; past that the check is incomplete. */
export const MAX_ZIP_FILES = 20_000;

/**
 * A catalog zip's check (services/pluginZipChecks.ts), in AMWScan's container. The zip is
 * unpacked into a tmpfs at /var/www/html - nothing of it touches the host - and this hashes
 * every regular file of its folder, without following a link, and reads its plugin header
 * the way WordPress finds it: a PHP file at the top of the folder. The scanner and the
 * reducer then run over the same files, exactly as over a site.
 *
 *   argv[1] where it was unpacked, argv[2] the folder, argv[3] unzip's exit code,
 *   argv[4] what unzip printed
 */
export const ZIP_MANIFEST_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const MAX_FILES = ${MAX_ZIP_FILES};
const S_IFMT = 0170000;
const S_IFDIR = 0040000;
const S_IFREG = 0100000;
const S_IFLNK = 0120000;
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
function emit(array $line): void { echo json_encode($line, JSON_FLAGS), "\n"; }
${HEADER_VALUE_PHP}
$base = $argv[1] . '/' . $argv[2];
$unzipped = (int) ($argv[3] ?? 0);
$said = trim((string) @file_get_contents($argv[4] ?? ''));
$said = substr((string) (preg_split('/\r?\n/', $said) ?: [''])[0], 0, 300);
$st = @lstat($base);
if ($st === false || ($st['mode'] & S_IFMT) !== S_IFDIR) {
    emit(['t' => 'zipsummary', 'folder' => $argv[2], 'found' => false, 'unzip' => $unzipped, 'said' => $said]);
    exit(0);
}
$files = 0; $bytes = 0; $links = 0; $other = 0; $unreadable = 0; $truncated = false;
$stack = [''];
while ($stack) {
    $dirRel = array_pop($stack);
    $h = @opendir($dirRel === '' ? $base : $base . '/' . $dirRel);
    if ($h === false) { $unreadable++; continue; }
    while (($name = readdir($h)) !== false) {
        if ($name === '.' || $name === '..') continue;
        $rel = $dirRel === '' ? $name : $dirRel . '/' . $name;
        $s = @lstat($base . '/' . $rel);
        if ($s === false) { $unreadable++; continue; }
        $type = $s['mode'] & S_IFMT;
        if ($type === S_IFDIR) { $stack[] = $rel; continue; }
        if ($type === S_IFLNK) { $links++; continue; }
        if ($type !== S_IFREG) { $other++; continue; }
        if ($files >= MAX_FILES) { $truncated = true; continue; }
        $hash = @hash_file('sha256', $base . '/' . $rel);
        if ($hash === false) { $unreadable++; continue; }
        $files++;
        $bytes += $s['size'];
        emit(['t' => 'zipfile', 'path' => $rel, 'sha256' => $hash]);
    }
    closedir($h);
}
$name = null;
$version = null;
$top = array_values(array_filter(scandir($base) ?: [], fn($f) => (bool) preg_match('/\.php$/i', $f)));
sort($top);
foreach (array_slice($top, 0, 50) as $f) {
    $s = @lstat($base . '/' . $f);
    if ($s === false || ($s['mode'] & S_IFMT) !== S_IFREG) continue;
    $text = @file_get_contents($base . '/' . $f, false, null, 0, 8192);
    if ($text === false || header_value($text, 'Plugin Name') === null) continue;
    $name = header_value($text, 'Plugin Name');
    $version = header_value($text, 'Version');
    break;
}
emit([
    't' => 'zipsummary',
    'folder' => $argv[2],
    'found' => true,
    'files' => $files,
    'bytes' => $bytes,
    'links' => $links,
    'other' => $other,
    'unreadable' => $unreadable,
    'truncated' => $truncated,
    'name' => $name,
    'version' => $version,
    'unzip' => $unzipped,
    'said' => $said,
]);
`;

/**
 * The zip check's container: unpack, hash, then the tuning, the scanner and the reducer as
 * for a site. Nothing but the zip is mounted, read-only; it is unpacked into the tmpfs at
 * /var/www/html.
 *
 *   argv: the manifest script, the tuning's code, the tuning, the reducer, PHP's memory for
 *   the scanner, the zip's folder, then the scanner's own arguments
 */
export const ZIP_CHECK_SHELL = [
  'set -u',
  'manifest=$1; rules=$2; tuning=$3; reducer=$4; memory=$5; folder=$6; shift 6',
  'mkdir -p /tmp/amwscan',
  "unzip -q -o /wpl7-zip/plugin.zip -d /var/www/html -x '__MACOSX/*' >/tmp/amwscan/unzip 2>&1",
  'unzipped=$?',
  'php -d memory_limit=128M -r "$manifest" /var/www/html "$folder" "$unzipped" /tmp/amwscan/unzip || exit 3',
  `php -d memory_limit=64M -r "$rules" ${SCANNER_IN_IMAGE} "$tuning" ${LOCAL_RULES_DIR}`,
  `php -d memory_limit="$memory" ${SCANNER_IN_IMAGE} "$@" >/tmp/amwscan/output 2>&1`,
  'code=$?',
  'peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)',
  `exec php -d memory_limit=128M -r "$reducer" /tmp/amwscan/report.json "$code" "$peak" /tmp/amwscan/output "$tuning" ${SCANNER_IN_IMAGE}`,
].join('\n');
