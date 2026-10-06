/**
 * Zip archives for Web FTP, done by PHP inside the site's container.
 *
 * PHP, because the site image already has what is needed: the official `wordpress` image
 * builds the zip extension (WordPress's own updater uses it), while it ships no `zip` or
 * `unzip` binary - so nothing about the image has to change, and no site has to be
 * rebuilt before it can unzip a plugin.
 *
 * Run as `php -n -r CODE -- args`: `-n` leaves the site's own php.ini out (a hardened
 * `disable_functions` or an `open_basedir` there must not break the panel's tool), which
 * also leaves out the ini line that loads the zip extension - so the script loads it itself,
 * with dl(), when it is not built in. Both scripts print progress lines while they work and,
 * last, one JSON line with what they did; a refusal is an exit code from FILE_EXIT with the
 * reason as the last line on stderr. Written for PHP 8.0, the oldest a site can run.
 */
// @docs sites/files
import { FILE_EXIT } from './siteFilesScripts.js';

const E = FILE_EXIT;

export const PHP_ZIP_ARGS = ['php', '-n', '-d', 'memory_limit=512M', '-d', 'display_errors=stderr'];

const COMMON = `
error_reporting(E_ALL);
function bail($code, $message, $data = null) {
    fwrite(STDERR, $message . "\\n");
    if ($data !== null) echo json_encode($data), "\\n";
    exit($code);
}
if (!class_exists('ZipArchive') && function_exists('dl')) @dl('zip.so');
if (!class_exists('ZipArchive')) bail(1, 'This site\\'s PHP has no zip support');
`;

/**
 * args: archive, destination folder, overwrite (1|0), min-free-bytes.
 *
 * Every entry is checked before anything is written, and the archive is refused whole
 * rather than partly extracted when one is unsafe:
 * - a name that climbs out (`../`, an absolute path, a drive letter, backslashes that
 *   become either on the way) is "zip-slip", the classic archive attack;
 * - symlink entries are skipped - a link planted by an archive is how a later entry
 *   escapes, and a WordPress plugin has no business shipping one;
 * - nothing is written THROUGH a symlink already on disk, and nothing existing is replaced
 *   unless overwrite is set;
 * - the declared sizes must fit in the free space, and an entry that inflates past its
 *   declared size (a zip bomb lying about itself) stops the extraction.
 * Each file is written to a temporary name and renamed into place, so a visitor never
 * runs a half-extracted PHP file.
 */
export const EXTRACT_ZIP_PHP = `${COMMON}
$a = array_slice($argv, 1);
$archive = $a[0];
$dest = rtrim($a[1], '/');
$overwrite = $a[2] === '1';
$minFree = (int) $a[3];
if (!is_file($archive)) bail(${E.notFound}, 'The archive does not exist');
if (!is_readable($archive)) bail(${E.denied}, 'The archive is not readable');
if (!is_dir($dest)) bail(${E.notFound}, 'The folder to extract into does not exist');
if (!is_writable($dest)) bail(${E.denied}, 'The folder to extract into is not writable by the site');
$zip = new ZipArchive();
$opened = $zip->open($archive);
if ($opened !== true) bail(${E.badArchive}, 'Not a zip archive, or a damaged one (libzip error ' . $opened . ')');
$count = $zip->numFiles;
if ($count > 100000) bail(${E.tooLarge}, 'The archive has more than 100000 entries');
$plan = [];
$unsafe = [];
$skipped = 0;
$total = 0;
for ($i = 0; $i < $count; $i++) {
    $st = $zip->statIndex($i);
    if ($st === false) bail(${E.badArchive}, 'The archive index is damaged');
    $raw = $st['name'];
    $name = str_replace('\\\\', '/', $raw);
    $opsys = 0;
    $attr = 0;
    $zip->getExternalAttributesIndex($i, $opsys, $attr);
    if ($opsys === ZipArchive::OPSYS_UNIX && (($attr >> 16) & 0170000) === 0120000) {
        $skipped++;
        continue;
    }
    $isDir = substr($name, -1) === '/';
    $rel = trim($name, '/');
    if ($rel === '') continue;
    $bad = strpos($rel, "\\0") !== false || $name[0] === '/' || preg_match('/^[A-Za-z]:/', $rel) === 1;
    foreach (explode('/', $rel) as $seg) {
        if ($seg === '' || $seg === '.' || $seg === '..') $bad = true;
    }
    if ($bad) {
        $unsafe[] = $raw;
        continue;
    }
    if (strncmp(basename($rel), '.wpl7-', 6) === 0) {
        $skipped++;
        continue;
    }
    $plan[] = [$i, $rel, $isDir, (int) $st['size']];
    if (!$isDir) $total += (int) $st['size'];
}
if ($unsafe) {
    bail(${E.unsafeArchive}, 'The archive has entries that would land outside the folder: ' . implode(', ', array_slice($unsafe, 0, 5)));
}
$free = @disk_free_space($dest);
if ($free !== false && $free - $total < $minFree) {
    bail(${E.noSpace}, 'Extracting needs ' . $total . ' bytes, which would leave less free space than the server must keep');
}
$conflicts = [];
$seen = [];
foreach ($plan as $item) {
    [$i, $rel, $isDir] = $item;
    $parts = explode('/', $rel);
    $path = $dest;
    $last = count($parts) - 1;
    foreach ($parts as $k => $seg) {
        $path .= '/' . $seg;
        $shown = substr($path, strlen($dest) + 1);
        if ($k < $last) {
            if (isset($seen[$path])) continue;
            $seen[$path] = true;
            if (is_link($path)) { $conflicts[] = $shown . ' (a symlink)'; break; }
            if (file_exists($path) && !is_dir($path)) { $conflicts[] = $shown . ' (a file where a folder is needed)'; break; }
            continue;
        }
        if (is_link($path)) { $conflicts[] = $shown . ' (a symlink)'; break; }
        if (!file_exists($path)) break;
        if ($isDir && !is_dir($path)) $conflicts[] = $shown . ' (a file where a folder is needed)';
        elseif (!$isDir && is_dir($path)) $conflicts[] = $shown . ' (a folder where a file is needed)';
        elseif (!$isDir && !$overwrite) $conflicts[] = $shown;
    }
}
if ($conflicts) {
    bail(${E.exists}, count($conflicts) . ' entries are in the way', ['conflicts' => array_slice($conflicts, 0, 50), 'count' => count($conflicts)]);
}
$files = 0;
$folders = 0;
$bytes = 0;
$done = 0;
$planned = count($plan);
foreach ($plan as $item) {
    [$i, $rel, $isDir, $size] = $item;
    if (++$done % 500 === 0) echo 'Extracted ', $done, ' of ', $planned, " entries\\n";
    $target = $dest . '/' . $rel;
    if ($isDir) {
        if (!is_dir($target) && !@mkdir($target, 0755, true)) bail(${E.denied}, 'Could not create the folder ' . $rel);
        $folders++;
        continue;
    }
    $parent = dirname($target);
    if (!is_dir($parent) && !@mkdir($parent, 0755, true)) bail(${E.denied}, 'Could not create the folder ' . dirname($rel));
    $in = method_exists($zip, 'getStreamIndex') ? $zip->getStreamIndex($i) : $zip->getStream($zip->getNameIndex($i));
    if (!$in) bail(${E.badArchive}, 'Could not read ' . $rel . ' from the archive (is it encrypted?)');
    $tmp = $parent . '/.wpl7-x.' . bin2hex(random_bytes(6));
    $out = @fopen($tmp, 'xb');
    if (!$out) bail(${E.denied}, 'Could not write into ' . (dirname($rel) === '.' ? 'the folder' : dirname($rel)));
    $got = 0;
    while (!feof($in)) {
        $buf = fread($in, 1048576);
        if ($buf === false) { fclose($out); @unlink($tmp); bail(${E.badArchive}, 'Reading ' . $rel . ' from the archive failed'); }
        $got += strlen($buf);
        if ($got > $size) { fclose($out); @unlink($tmp); bail(${E.badArchive}, $rel . ' inflates past the size the archive declares; refusing it'); }
        if (fwrite($out, $buf) !== strlen($buf)) { fclose($out); @unlink($tmp); bail(${E.noSpace}, 'Writing ' . $rel . ' failed - is the disk full?'); }
    }
    fclose($in);
    fclose($out);
    if ($got !== $size) { @unlink($tmp); bail(${E.badArchive}, $rel . ' is damaged in the archive'); }
    chmod($tmp, 0644);
    if (!@rename($tmp, $target)) { @unlink($tmp); bail(${E.denied}, 'Could not put ' . $rel . ' in place'); }
    $files++;
    $bytes += $got;
}
$zip->close();
echo json_encode(['files' => $files, 'folders' => $folders, 'bytes' => $bytes, 'skipped' => $skipped]), "\\n";
`;

/**
 * args: folder, archive path, overwrite (1|0), min-free-bytes, names...
 *
 * The named entries of one folder go into one archive, stored under their own names.
 * Symlinks are never followed - a link to `/` would otherwise archive the whole container -
 * and the panel's temporary files are left out. The archive is written to a temporary name
 * and renamed into place; without overwrite, a hard link claims the name so a file that
 * appeared meanwhile is not replaced.
 */
export const COMPRESS_ZIP_PHP = `${COMMON}
$a = array_slice($argv, 1);
$cwd = $a[0];
$target = $a[1];
$overwrite = $a[2] === '1';
$minFree = (int) $a[3];
$names = array_slice($a, 4);
if (!@chdir($cwd)) bail(${E.notFound}, 'The folder does not exist');
if (file_exists($target) || is_link($target)) {
    if (!$overwrite) bail(${E.exists}, 'An entry with the archive\\'s name already exists');
    if (is_dir($target) && !is_link($target)) bail(${E.wrongType}, 'A folder has the archive\\'s name');
}
$dir = dirname($target);
if (!is_writable($dir)) bail(${E.denied}, 'The folder is not writable by the site');
$tmp = $dir . '/.wpl7-zip.' . bin2hex(random_bytes(6)) . '.part';
$zip = new ZipArchive();
if ($zip->open($tmp, ZipArchive::CREATE | ZipArchive::EXCL) !== true) bail(${E.denied}, 'Could not create the archive');
$stats = ['files' => 0, 'folders' => 0, 'bytes' => 0, 'skipped' => 0];
$add = function ($rel) use (&$add, $zip, &$stats) {
    if (is_link($rel)) { $stats['skipped']++; return; }
    if (is_dir($rel)) {
        $zip->addEmptyDir($rel);
        $stats['folders']++;
        $children = @scandir($rel);
        if ($children === false) { $stats['skipped']++; return; }
        foreach ($children as $child) {
            if ($child === '.' || $child === '..' || strncmp($child, '.wpl7-', 6) === 0) continue;
            $add($rel . '/' . $child);
        }
        return;
    }
    if (!is_file($rel) || !is_readable($rel)) { $stats['skipped']++; return; }
    if ($stats['files'] >= 100000) bail(${E.tooLarge}, 'More than 100000 files to compress');
    $zip->addFile($rel, $rel);
    $stats['files']++;
    $stats['bytes'] += (int) filesize($rel);
};
foreach ($names as $name) {
    if (!file_exists($name) && !is_link($name)) bail(${E.notFound}, $name . ' does not exist');
    $add($name);
}
$free = @disk_free_space($dir);
if ($free !== false && $free - $stats['bytes'] < $minFree) {
    bail(${E.noSpace}, 'The archive could need ' . $stats['bytes'] . ' bytes, which would leave less free space than the server must keep');
}
echo 'Compressing ', $stats['files'], ' files (', $stats['bytes'], " bytes)\\n";
if (method_exists($zip, 'registerProgressCallback')) {
    $zip->registerProgressCallback(0.1, function ($rate) { echo 'Written ', (int) round($rate * 100), "%\\n"; });
}
if (!$zip->close()) {
    @unlink($tmp);
    bail(${E.denied}, 'Writing the archive failed: ' . $zip->getStatusString());
}
chmod($tmp, 0644);
if ($overwrite) {
    if (!@rename($tmp, $target)) { @unlink($tmp); bail(${E.denied}, 'Could not put the archive in place'); }
} else {
    if (!@link($tmp, $target)) { @unlink($tmp); bail(file_exists($target) ? ${E.exists} : ${E.denied}, 'Could not put the archive in place'); }
    @unlink($tmp);
}
echo json_encode($stats), "\\n";
`;
