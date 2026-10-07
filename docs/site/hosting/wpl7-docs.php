<?php
/**
 * Plugin Name: WPL7 docs
 * Description: Installs the WPL7 documentation into /docs and keeps it current: wp wpl7-docs update.
 * Version: 1.0.0
 * Requires PHP: 8.0
 * License: AGPL-3.0-or-later
 */

// The website's half of publishing the docs (docs/site/hosting/README.md in the WPL7 repository).
// CI attaches every build of the docs to the repository's `docs-site` release: a zip, and
// wpl7-docs.json naming it with its size and SHA-256. `wp wpl7-docs update`, run on a schedule,
// installs the zip that json names when /docs has another one.
//
// Nothing in the zip can run on the server. Only static files of the types a docs build is made
// of are installed, under plain names, and the folder's .htaccess is this file's own, never the
// zip's. The new build is unpacked beside /docs and swapped in once complete, so a failed update
// leaves the docs as they were.

defined('ABSPATH') || exit;

final class WPL7_Docs
{
    /** Where CI publishes. WPL7_DOCS_MANIFEST_URL in wp-config.php points elsewhere, a fork's. */
    const MANIFEST_URL = 'https://github.com/andyfo/wpl7/releases/download/docs-site/wpl7-docs.json';

    /** What a docs build is made of. A zip with anything else is refused, and the job says what. */
    const TYPES = [
        'html', 'css', 'js', 'json', 'xml', 'txt', 'svg', 'ico', 'png', 'webp', 'avif', 'jpg', 'jpeg',
        'gif', 'woff2', 'woff', 'pagefind', 'pf_meta', 'pf_index', 'pf_fragment', 'pf_filter',
    ];

    const MAX_ZIP_BYTES = 256 * 1024 * 1024;
    const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
    const MAX_FILES = 10000;

    /** The folder's .htaccess, written with every build. The docs are built for /docs. */
    const HTACCESS = <<<'APACHE'
        # Written by the wpl7-docs must-use plugin with every build of the docs: edits do not last.

        # Nothing in this folder is a WordPress URL.
        <IfModule mod_rewrite.c>
            RewriteEngine Off
        </IfModule>

        Options -Indexes
        DirectoryIndex index.html
        DirectorySlash On
        ErrorDocument 404 /docs/404.html

        # Static files only: nothing here runs as PHP.
        <IfModule php_module>
            php_flag engine off
        </IfModule>
        <FilesMatch "(?i)\.ph(p[0-9]?|tml|ar|t|ps)$">
            Require all denied
        </FilesMatch>

        # Pages and the search's entry point change with every build: five minutes. Files named
        # after their content never change: a year.
        <IfModule mod_headers.c>
            Header set Cache-Control "public, max-age=300"
            <If "%{REQUEST_URI} =~ m#^/docs/(_astro/|pagefind/(fragment|index)/|pagefind/pagefind\.[^/]+\.pf_meta$)#">
                Header set Cache-Control "public, max-age=31536000, immutable"
            </If>
        </IfModule>
        <IfModule !mod_headers.c>
            <IfModule mod_expires.c>
                ExpiresActive On
                ExpiresDefault "access plus 5 minutes"
                <If "%{REQUEST_URI} =~ m#^/docs/(_astro/|pagefind/(fragment|index)/|pagefind/pagefind\.[^/]+\.pf_meta$)#">
                    ExpiresDefault "access plus 1 year"
                </If>
            </IfModule>
        </IfModule>

        APACHE;

    public static function dir(): string
    {
        return ABSPATH . 'docs';
    }

    public static function manifest_url(): string
    {
        return defined('WPL7_DOCS_MANIFEST_URL') ? (string) WPL7_DOCS_MANIFEST_URL : self::MANIFEST_URL;
    }

    /** What /docs has, from the build.json this plugin wrote there. Null: none, or docs from elsewhere. */
    public static function installed(): ?array
    {
        $file = self::dir() . '/build.json';
        if (!is_file($file) || is_link($file)) return null;
        $build = json_decode((string) file_get_contents($file), true);
        return is_array($build) && is_string($build['sha256'] ?? null) ? $build : null;
    }

    /** The build wpl7-docs.json names. */
    public static function latest(): array
    {
        $url = self::manifest_url();
        $res = wp_remote_get($url, ['timeout' => 30]);
        self::answered($url, $res);
        $m = json_decode(wp_remote_retrieve_body($res), true);
        $valid = is_array($m)
            && is_string($m['commit'] ?? null) && preg_match('/^[0-9a-f]{40}$/D', $m['commit'])
            && is_string($m['builtAt'] ?? null)
            && is_string($m['zip'] ?? null) && preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/D', $m['zip'])
            && is_int($m['size'] ?? null) && $m['size'] > 0 && $m['size'] <= self::MAX_ZIP_BYTES
            && is_string($m['sha256'] ?? null) && preg_match('/^[0-9a-f]{64}$/D', $m['sha256']);
        if (!$valid) throw new RuntimeException("$url does not describe a build of the docs.");
        return $m;
    }

    /** Install the latest build, unless /docs has it. Says what it did, in a sentence. */
    public static function update(bool $force = false): string
    {
        $lock = fopen(get_temp_dir() . 'wpl7-docs.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new RuntimeException('Another update of the docs is running.');
        }
        try {
            $latest = self::latest();
            $have = self::installed();
            if (!$force && $have !== null && hash_equals($have['sha256'], $latest['sha256'])) {
                return 'The docs are up to date: ' . self::describe($have) . '.';
            }
            $zip = self::download($latest);
            try {
                $files = self::install($zip, $latest);
            } finally {
                unlink($zip);
            }
            return 'Installed the docs: ' . self::describe($latest) . ", $files files.";
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * Unpack a docs zip beside /docs and swap it in. Checks every entry first: anything that is
     * not part of a docs build stops it before a file is written.
     */
    public static function install(string $zip_file, array $build): int
    {
        $zip = new ZipArchive();
        $opened = $zip->open($zip_file);
        if ($opened !== true) throw new RuntimeException("The zip does not open (ZipArchive error $opened).");

        $dir = self::dir();
        self::clear_leftovers(dirname($dir));
        $new = dirname($dir) . '/.wpl7-docs-new-' . bin2hex(random_bytes(6));
        try {
            $files = self::check($zip);
            if (!mkdir($new, 0755)) throw new RuntimeException("Could not create $new.");
            if (!$zip->extractTo($new)) throw new RuntimeException('The zip did not unpack: ' . $zip->getStatusString());
            $record = [
                'commit' => $build['commit'] ?? null,
                'builtAt' => $build['builtAt'] ?? null,
                'zip' => $build['zip'] ?? basename($zip_file),
                'sha256' => hash_file('sha256', $zip_file),
                'installedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            ];
            if (
                file_put_contents("$new/.htaccess", self::HTACCESS) === false
                || file_put_contents("$new/build.json", json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false
            ) {
                throw new RuntimeException("Could not write into $new.");
            }
        } catch (Throwable $e) {
            self::remove($new);
            throw $e;
        } finally {
            $zip->close();
        }
        self::swap($new, $dir);
        return $files;
    }

    /** Every entry of the zip, before anything is written. Returns the number of files. */
    private static function check(ZipArchive $zip): int
    {
        $count = $zip->numFiles;
        if ($count < 1 || $count > self::MAX_FILES) {
            throw new RuntimeException("The zip has $count entries; a build of the docs has 1 to " . self::MAX_FILES . '.');
        }
        $files = 0;
        $bytes = 0;
        for ($i = 0; $i < $count; $i++) {
            $entry = $zip->statIndex($i);
            if ($entry === false) throw new RuntimeException("Entry $i of the zip cannot be read.");
            $name = $entry['name'];
            $problem = self::name_problem($name);
            if ($problem === null && $zip->getExternalAttributesIndex($i, $system, $attributes)
                && $system === ZipArchive::OPSYS_UNIX && (($attributes >> 16) & 0xF000) === 0xA000) {
                $problem = 'links are not installed';
            }
            if ($problem !== null) throw new RuntimeException("The zip has \"$name\": $problem. Nothing changed.");
            $bytes += $entry['size'];
            if ($bytes > self::MAX_UNPACKED_BYTES) throw new RuntimeException('The zip unpacks to more than ' . self::MAX_UNPACKED_BYTES . ' bytes.');
            if (!str_ends_with($name, '/')) $files++;
        }
        foreach (['index.html', '404.html'] as $page) {
            if ($zip->locateName($page) === false) throw new RuntimeException("The zip has no $page at the top: it is not a build of the docs. Nothing changed.");
        }
        return $files;
    }

    /** Why an entry is not installed; null when it is. */
    private static function name_problem(string $name): ?string
    {
        $path = str_ends_with($name, '/') ? substr($name, 0, -1) : $name;
        // Each part starts with a letter, digit or one of _@~+-: no absolute path, no "..", and no
        // dot file such as .htaccess or .user.ini.
        if (!preg_match('#^[A-Za-z0-9_@~+-][A-Za-z0-9._@~+-]*(/[A-Za-z0-9_@~+-][A-Za-z0-9._@~+-]*)*$#D', $path)) {
            return 'only plain names are installed, no dot files and no ".."';
        }
        if (preg_match('/\.ph(p[0-9]?|tml|ar|t|ps)([.\/]|$)/iD', $path)) return 'PHP is never installed';
        if ($path !== $name) return null;
        $type = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if ($type === '') return 'a build of the docs has no files without a type';
        return in_array($type, self::TYPES, true) ? null : "a build of the docs has no .$type files";
    }

    /** The zip wpl7-docs.json names, downloaded and held to its size and checksum. */
    private static function download(array $latest): string
    {
        $base = self::manifest_url();
        $url = substr($base, 0, strrpos($base, '/') + 1) . $latest['zip'];
        $file = tempnam(get_temp_dir(), 'wpl7-docs-');
        if ($file === false) throw new RuntimeException('Could not create a temporary file.');
        try {
            $res = wp_remote_get($url, [
                'timeout' => 300,
                'stream' => true,
                'filename' => $file,
                'limit_response_size' => self::MAX_ZIP_BYTES,
            ]);
            self::answered($url, $res);
            clearstatcache(true, $file);
            if (filesize($file) !== $latest['size'] || !hash_equals($latest['sha256'], (string) hash_file('sha256', $file))) {
                throw new RuntimeException("$url is not the zip wpl7-docs.json describes: its size or checksum differs.");
            }
        } catch (Throwable $e) {
            unlink($file);
            throw $e;
        }
        return $file;
    }

    /** @param array|WP_Error $res */
    private static function answered(string $url, $res): void
    {
        if (is_wp_error($res)) throw new RuntimeException("Could not fetch $url: " . $res->get_error_message());
        $code = (int) wp_remote_retrieve_response_code($res);
        if ($code !== 200) throw new RuntimeException("$url answered $code.");
    }

    /** Put $new where $dir is. The old docs are deleted only once the new ones are in place. */
    private static function swap(string $new, string $dir): void
    {
        if (is_link($dir) || (file_exists($dir) && !is_dir($dir))) {
            self::remove($new);
            throw new RuntimeException("$dir is not a folder. Move it away, then update again.");
        }
        $old = null;
        if (is_dir($dir)) {
            $old = dirname($dir) . '/.wpl7-docs-old-' . bin2hex(random_bytes(6));
            if (!rename($dir, $old)) {
                self::remove($new);
                throw new RuntimeException("Could not move $dir aside.");
            }
        }
        if (!rename($new, $dir)) {
            if ($old !== null) rename($old, $dir);
            self::remove($new);
            throw new RuntimeException("Could not move the new docs into $dir.");
        }
        if ($old !== null) self::remove($old);
    }

    /** Folders an update that was killed left beside /docs. */
    private static function clear_leftovers(string $parent): void
    {
        foreach (['new', 'old'] as $kind) {
            foreach (glob("$parent/.wpl7-docs-$kind-*", GLOB_ONLYDIR) ?: [] as $path) self::remove($path);
        }
    }

    /** Delete a file or folder, never following a link out of it. */
    private static function remove(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            unlink($path);
            return;
        }
        if (!is_dir($path)) return;
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            if ($item->isDir() && !$item->isLink()) rmdir($item->getPathname());
            else unlink($item->getPathname());
        }
        rmdir($path);
    }

    /** "commit a1b2c3d, built 2026-10-06T12:00:00Z" */
    public static function describe(array $build): string
    {
        $commit = is_string($build['commit'] ?? null) ? substr($build['commit'], 0, 7) : 'unknown';
        $built = is_string($build['builtAt'] ?? null) ? ', built ' . $build['builtAt'] : '';
        return "commit $commit$built";
    }
}

if (defined('WP_CLI') && WP_CLI) {
    /**
     * Keeps /docs at the latest build of the WPL7 docs.
     */
    final class WPL7_Docs_Command
    {
        /**
         * Installs the latest build of the docs, unless /docs has it already.
         *
         * ## OPTIONS
         *
         * [--force]
         * : Install it even when /docs has it.
         *
         * ## EXAMPLES
         *
         *     wp wpl7-docs update
         */
        public function update(array $args, array $assoc_args): void
        {
            try {
                WP_CLI::success(WPL7_Docs::update((bool) WP_CLI\Utils\get_flag_value($assoc_args, 'force', false)));
            } catch (Throwable $e) {
                WP_CLI::error($e->getMessage());
            }
        }

        /**
         * Shows the build in /docs and the latest one.
         */
        public function status(array $args, array $assoc_args): void
        {
            $have = WPL7_Docs::installed();
            if ($have !== null) $now = WPL7_Docs::describe($have);
            else $now = is_dir(WPL7_Docs::dir()) ? 'docs this plugin did not install' : 'no docs';
            WP_CLI::log(WPL7_Docs::dir() . ": $now");
            try {
                $latest = WPL7_Docs::latest();
            } catch (Throwable $e) {
                WP_CLI::error($e->getMessage());
            }
            WP_CLI::log('Latest: ' . WPL7_Docs::describe($latest));
            WP_CLI::log($have !== null && hash_equals($have['sha256'], $latest['sha256'])
                ? 'Up to date.'
                : 'An update is waiting: wp wpl7-docs update');
        }
    }

    WP_CLI::add_command('wpl7-docs', 'WPL7_Docs_Command');
}
