// @docs security/malware-scans, sites/settings
/**
 * What the move to PHP-FPM (services/siteMigration.ts) does to a .htaccess, as PHP that two scripts
 * are built with: the move's own, which changes a site's files, and the malware scan's
 * (services/scanScripts.ts), which takes a plugin's file the move changed back to what it was, holds
 * that to the plugin's checksum, and moves it again to see that nothing else was changed.
 *
 * Each of those scripts defines say(), for the warnings this gives: the scan's says nothing.
 *
 * Kept free of backticks and dollar-brace, so it fits in a String.raw literal as it is.
 */

/**
 * Past this a `.htaccess` or `.user.ini` is reported and left alone. Apache reads a `.htaccess` on
 * every request, so real ones stay far under it, long ban lists included, and two at this size made of
 * nothing but directives still fit in the memory the script gives itself.
 */
export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

export const HTACCESS_MOVE_PHP = String.raw`
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
// Finds that mark, for the malware scan, which takes it back to see what a plugin's file was before.
const DENY_BACK = '/^([ \t\x0C\x0B]*)# Replaced by a deny by WPL7: /';
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

/** The deny for a line inside a section: the section's own, for the files it takes. */
function scoped_deny(string $indent, string $eol): string {
    return $indent . 'Require all denied' . $eol . $indent . 'Satisfy All' . $eol;
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
        // What the job log says of the line: a value can hold a password.
        $shown = $setting && count($words) >= 2 ? $words[0] . ' ' . $words[1] : $text;
        $entry = ['line' => $first, 'last' => $i, 'text' => $text, 'shown' => $shown, 'words' => $words, 'directive' => $directive, 'inert' => $inert, 'live' => $live, 'scope' => $scope];
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

/**
 * What the move makes of a .htaccess, $entries being what read_htaccess finds in it: its new text,
 * and the changes to report. A setting's line is commented out as moved or not, which $fateOf says
 * (moved, left or unknown), a handler that would keep .php from PHP-FPM is commented out, and an
 * engine off becomes a deny.
 */
function migrate_htaccess(string $text, array $entries, string $path, callable $fateOf): array {
    $lines = split_lines($text);
    $hasDeny = strpos($text, DENY_OPEN) !== false;
    $eol = eol_of($lines);
    $changes = [];
    $denyLater = null;
    foreach ($entries as $i => $e) {
        $at = $e['line'] + 1;
        if ($e['kind'] === 'handler') {
            handler_line($e, $lines, $changes, $path);
        } elseif ($e['kind'] === 'setting') {
            if ($e['inert']) continue;
            $fate = $fateOf($i, $e);
            $lines[$e['line']] = comment_out($lines[$e['line']], $fate === 'moved' ? MOVED_MARK : NOT_MOVED_MARK);
            if ($fate === 'moved') $changes[] = [$path, $at, $e['shown'] . ': moved to .user.ini'];
            elseif ($fate === 'unknown') $changes[] = [$path, $at, $e['shown'] . ': commented out, this PHP has no such setting, so it did nothing'];
            else $changes[] = [$path, $at, $e['shown'] . ': commented out'];
        } elseif (engine_is_on($e)) {
            if ($e['inert']) continue;
            $lines[$e['line']] = comment_out($lines[$e['line']], NOT_MOVED_MARK);
            $changes[] = [$path, $at, $e['text'] . ': commented out, PHP-FPM has no such setting. PHP runs here unless a folder above has a deny.'];
        } elseif ($e['inert']) {
            if ($e['scope'] === null) $denyLater ??= $e;
            else say('warn', $path, $at, $e['shown'] . ': it is inside ' . $e['scope']['label'] . ' in a block for mod_php, and does nothing now. PHP runs in those files: deny them if it should not.');
        } else {
            // A deny in place of the line, where it can be read in context. It runs on both setups.
            $indent = indent_of($lines[$e['line']]);
            $lines[$e['line']] = comment_out($lines[$e['line']], DENY_MARK);
            $add = '';
            if ($e['scope'] !== null) {
                $add = scoped_deny($indent, $eol);
            } elseif (!$hasDeny) {
                $add = deny_block($indent, $eol);
                $hasDeny = true;
            }
            $lines[$e['last']] = ending_a_line($lines[$e['last']], $eol) . $add;
            $changes[] = [$path, $at, $e['text'] . ': replaced by a deny for PHP files'];
        }
    }
    // A block for mod_php stays exactly as it is, because plugins compare theirs word for word and add
    // it again when it differs. So the deny goes at the end, outside anything a plugin regenerates.
    if ($denyLater !== null && !$hasDeny) {
        $last = count($lines) - 1;
        $lines[$last] = ending_a_line($lines[$last], $eol);
        $lines[] = DENY_MARK . $denyLater['text'] . $eol . deny_block('', $eol);
        $changes[] = [$path, $denyLater['line'] + 1, $denyLater['text'] . ': this line stays, and does nothing now; a deny for PHP files is added at the end of the file'];
    }
    return [implode('', $lines), $changes];
}
`;
