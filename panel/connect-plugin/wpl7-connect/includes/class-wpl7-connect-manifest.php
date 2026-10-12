<?php
// A copy of WPL7 Migrate's class-wpl7-migrate-manifest.php; a fix to one is made in the other in the same change.
defined('ABSPATH') || exit;

/**
 * The files: what to leave out, the snapshot walker, file list pages and file ranges.
 *
 * The walk is kept in {prefix}wpl7_connect_files, so it survives the end of a request: each
 * `snapshot` request walks until its time is up and the next one carries on. Directories are
 * walked breadth first, in id order, which is the order they were found in; names within one
 * directory in byte order. Links are recorded, not followed, unless the panel asks to follow the
 * ones that stay inside the site.
 */
final class WPL7_Connect_Manifest
{
    const TYPE_FILE = 1;
    const TYPE_DIR = 2;
    const TYPE_LINK = 3;

    const FLAG_LINK = 1;
    const FLAG_UNREADABLE = 2;
    const FLAG_TOO_LARGE = 4;
    const FLAG_CYCLE = 8;
    const FLAG_DANGLING = 16;
    const FLAG_TOO_DEEP = 32;
    const FLAG_UNCHANGED = 64;

    const MAX_DEPTH = 48;
    /** The path column's size. A longer path is left out and counted. */
    const MAX_PATH = 4096;
    /** Files up to this size get a sha256 in the file list, and with every range. */
    const HASH_MAX = 1048576;
    const PAGE_MAX = 5000;
    const PAGE_DEFAULT = 1000;
    /** Files one `bundle` request may name. */
    const BUNDLE_MAX = 500;
    /** Rows per INSERT, and the statement's size, kept under every server's max_allowed_packet. */
    const INSERT_ROWS = 500;
    const INSERT_BYTES = 524288;

    /**
     * Left out of every snapshot. A pattern is matched against paths relative to ABSPATH. With a
     * slash it is anchored there; without one it matches a name at any depth. `*` and `?` stay
     * within a name, `**` spans any number of directories, and `dir/**` takes the directory and
     * everything in it. The first pattern that matches is the reason given.
     *
     * Connect's list (docs/internal/connect-protocol.md, Paths and excludes): a backup keeps
     * wp-config.php, and WPL7 Migrate's folder, and leaves out the copies an update keeps to roll
     * back to, WordPress's own among them.
     */
    const DEFAULT_EXCLUDES = [
        '.wpl7-*',
        'wp-content/cache/**',
        'wp-content/upgrade/**',
        'wp-content/updraft/**',
        'wp-content/ai1wm-backups/**',
        'wp-content/backups-dup-lite/**',
        'wp-content/backup*/**',
        '*.log',
        'error_log',
        '.git/**',
        'wp-content/**/node_modules/**',
        'wp-content/wpl7-rollback/**',
        'wp-content/upgrade-temp-backup/**',
    ];

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

    /** The regex a pattern compiles to, and whether it is anchored at ABSPATH. */
    public static function glob_regex($pattern)
    {
        $p = $pattern;
        if (substr($p, -3) === '/**') {
            $p = substr($p, 0, -3);
        }
        $segments = explode('/', $p);
        $last = count($segments) - 1;
        $re = '';
        foreach ($segments as $i => $segment) {
            if ($segment === '**') {
                $re .= '(?:[^/]+/)*';
                continue;
            }
            $re .= strtr(preg_quote($segment, '#'), ['\*' => '[^/]*', '\?' => '[^/]']);
            if ($i < $last) {
                $re .= '/';
            }
        }
        return ['#^' . $re . '$#D', strpos($p, '/') !== false];
    }

    /**
     * The first pattern that leaves $path out, or null. A directory left out takes everything in
     * it, so every leading part of the path is tried too.
     */
    public static function exclude_match($path, $patterns)
    {
        static $compiled = [];
        $segments = explode('/', $path);
        foreach ($patterns as $pattern) {
            if (!isset($compiled[$pattern])) {
                $compiled[$pattern] = self::glob_regex($pattern);
            }
            $re = $compiled[$pattern][0];
            $anchored = $compiled[$pattern][1];
            $prefix = '';
            foreach ($segments as $i => $segment) {
                $prefix = $i === 0 ? $segment : $prefix . '/' . $segment;
                if (preg_match($re, $anchored ? $prefix : $segment)) {
                    return $pattern;
                }
            }
        }
        return null;
    }

    public static function flag_names($flags)
    {
        $names = [
            self::FLAG_LINK => 'link',
            self::FLAG_UNREADABLE => 'unreadable',
            self::FLAG_TOO_LARGE => 'too_large',
            self::FLAG_CYCLE => 'cycle',
            self::FLAG_DANGLING => 'dangling',
            self::FLAG_TOO_DEEP => 'too_deep',
            self::FLAG_UNCHANGED => 'unchanged',
        ];
        $out = [];
        foreach ($names as $bit => $name) {
            if ($flags & $bit) {
                $out[] = $name;
            }
        }
        return $out;
    }

    /** A path the walker could have written: relative, no empty, `.` or `..` part, no NUL. */
    public static function safe_relative($path)
    {
        if (!is_string($path) || $path === '' || strpos($path, "\0") !== false) {
            return false;
        }
        foreach (explode('/', $path) as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') {
                return false;
            }
        }
        return true;
    }

    /** The path below $root, '' for $root itself, null when outside it. */
    public static function relative($real, $root)
    {
        if ($real === $root) {
            return '';
        }
        $prefix = $root . '/';
        return strpos($real, $prefix) === 0 ? substr($real, strlen($prefix)) : null;
    }

    /**
     * Whether a folder is still where the walk expects it: its real path, every link on the way
     * resolved, is the one expected, and inside the site. A folder listed in one request and walked
     * in a later one can meanwhile become, or sit under, a link to anywhere.
     */
    private static function in_place($abs, $expected, $root)
    {
        clearstatcache(true, $abs);
        $real = @realpath($abs);
        return $real !== false && $real === $expected && self::relative($real, $root) !== null;
    }

    /** basename() depends on the locale and can cut multibyte names; this does not. */
    private static function name_of($path)
    {
        $pos = strrpos($path, '/');
        return $pos === false ? $path : substr($path, $pos + 1);
    }

    // -- The site ----------------------------------------------------------------------------

    public static function root()
    {
        $real = realpath(ABSPATH);
        return rtrim($real !== false ? $real : ABSPATH, '/');
    }

    /**
     * The default excludes and what the panel added. Unlike WPL7 Migrate, this plugin's own folder
     * is not left out: a backup restored by hand brings the connection back with it.
     */
    public static function patterns($extra)
    {
        $patterns = self::DEFAULT_EXCLUDES;
        foreach ($extra as $pattern) {
            if (!in_array($pattern, $patterns, true)) {
                $patterns[] = $pattern;
            }
        }
        return $patterns;
    }

    /**
     * Counts for the report, without writing anything: files, bytes, folders, links, what could
     * not be read and which patterns left something out. Stops at $deadline and says so.
     */
    public static function quick_count($deadline)
    {
        $root = self::root();
        $patterns = self::patterns([]);
        $out = ['count' => 0, 'bytes' => 0, 'dirs' => 0, 'links' => 0, 'unreadable' => 0, 'excluded' => []];
        $excluded = [];
        $queue = [''];
        $head = 0;
        $partial = false;
        while ($head < count($queue)) {
            if (microtime(true) >= $deadline) {
                $partial = true;
                break;
            }
            $dir = $queue[$head];
            $queue[$head] = null;
            $head++;
            // A folder that became a link since it was found is not counted through.
            $abs_dir = $dir === '' ? $root : $root . '/' . $dir;
            $names = self::in_place($abs_dir, $abs_dir, $root) ? @scandir($abs_dir) : false;
            if ($names === false) {
                $out['unreadable']++;
                continue;
            }
            $depth = $dir === '' ? 1 : substr_count($dir, '/') + 2;
            foreach ($names as $name) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $rel = $dir === '' ? $name : $dir . '/' . $name;
                $pattern = self::exclude_match($rel, $patterns);
                if ($pattern !== null) {
                    $excluded[$pattern] = true;
                    continue;
                }
                $abs = $root . '/' . $rel;
                $st = @lstat($abs);
                if ($st === false) {
                    $out['unreadable']++;
                    continue;
                }
                $format = $st['mode'] & 0170000;
                if ($format === 0120000) {
                    $out['links']++;
                } elseif ($format === 0040000) {
                    $out['dirs']++;
                    if ($depth < self::MAX_DEPTH) {
                        $queue[] = $rel;
                    }
                } elseif ($format === 0100000) {
                    $out['count']++;
                    $out['bytes'] += $st['size'];
                    if (!@is_readable($abs)) {
                        $out['unreadable']++;
                    }
                }
            }
        }
        $out['excluded'] = array_keys($excluded);
        if ($partial) {
            $out['partial'] = true;
        }
        return $out;
    }

    // -- snapshot ----------------------------------------------------------------------------

    public static function current()
    {
        $snap = get_option(WPL7_Connect_Plugin::OPT_SNAPSHOT);
        return is_array($snap) && isset($snap['id']) ? $snap : null;
    }

    /** The `snapshot` action: { op: start | continue | status, follow?, since?, exclude?, budget_ms? }. */
    public static function snapshot($params, $deadline)
    {
        $op = isset($params['op']) && is_string($params['op']) ? $params['op'] : '';
        if ($op === 'status') {
            return self::status(self::current());
        }
        if ($op !== 'start' && $op !== 'continue') {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'op']);
        }
        if ($op === 'start') {
            $follow = isset($params['follow']) ? $params['follow'] : 'none';
            if ($follow !== 'none' && $follow !== 'inside') {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'follow']);
            }
            $since = isset($params['since']) ? $params['since'] : null;
            if ($since !== null && (!is_int($since) || $since < 0)) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'since']);
            }
            $exclude = isset($params['exclude']) ? $params['exclude'] : [];
            if (!self::valid_excludes($exclude)) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'exclude']);
            }
        }
        if (!self::lock()) {
            throw new WPL7_Connect_Error(409, 'busy');
        }
        try {
            if ($op === 'start') {
                self::begin($follow, $since, array_values($exclude));
            } else {
                $snap = self::current();
                if ($snap === null || (isset($params['snapshot_id']) && $params['snapshot_id'] !== $snap['id'])) {
                    throw new WPL7_Connect_Error(409, 'snapshot_stale');
                }
            }
            $snap = self::walk($deadline);
        } finally {
            self::unlock();
        }
        return self::status($snap);
    }

    private static function valid_excludes($exclude)
    {
        if (!is_array($exclude) || count($exclude) > 200 || array_values($exclude) !== $exclude) {
            return false;
        }
        foreach ($exclude as $pattern) {
            if (!is_string($pattern) || $pattern === '' || strlen($pattern) > 512 || strpos($pattern, "\0") !== false) {
                return false;
            }
        }
        return true;
    }

    /**
     * One walk at a time per site, held by a MySQL named lock: it is released when the request's
     * connection closes, however the request ends. A server that will not answer gets no lock.
     */
    private static function lock()
    {
        global $wpdb;
        $got = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', self::lock_name()));
        return $got === null || (string) $got === '1';
    }

    private static function unlock()
    {
        global $wpdb;
        $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', self::lock_name()));
    }

    private static function lock_name()
    {
        global $wpdb;
        return 'wpl7_connect_' . substr(md5(DB_NAME . '|' . $wpdb->prefix . '|' . ABSPATH), 0, 24);
    }

    private static function begin($follow, $since, $exclude)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        if ($wpdb->query("TRUNCATE TABLE `$table`") === false) {
            $wpdb->query("DELETE FROM `$table`");
        }
        // The walk starts from a row for ABSPATH itself, which the file list never shows.
        $root = self::root();
        $real = $follow === 'inside' ? self::hex($root) : 'NULL';
        $wpdb->query("INSERT INTO `$table` (`parent`, `seq`, `type`, `path`, `real`, `walked`) VALUES (0, 0, " . self::TYPE_DIR . ", X'', $real, 0)");
        update_option(WPL7_Connect_Plugin::OPT_SNAPSHOT, [
            'id' => bin2hex(random_bytes(8)),
            'started' => time(),
            'done' => false,
            'follow' => $follow,
            'since' => $since,
            'exclude' => $exclude,
            'special' => 0,
            'too_long' => 0,
            'excluded' => [],
        ], false);
    }

    private static function context($snap)
    {
        return [
            'root' => self::root(),
            'patterns' => self::patterns($snap !== null && isset($snap['exclude']) ? $snap['exclude'] : []),
            'follow' => $snap !== null && isset($snap['follow']) ? $snap['follow'] : 'none',
            'since' => $snap !== null && isset($snap['since']) ? $snap['since'] : null,
            'dirs' => [],
            'progress' => 0,
        ];
    }

    private static function walk($deadline)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        $snap = self::current();
        $ctx = self::context($snap);
        while (empty($snap['done'])) {
            $dir = $wpdb->get_row(
                "SELECT `id`, `parent`, `path`, `real`, `pos` FROM `$table` WHERE `type` = " . self::TYPE_DIR . ' AND `walked` = 0 ORDER BY `id` LIMIT 1',
                ARRAY_A
            );
            if (!$dir) {
                $snap['done'] = true;
                break;
            }
            if (!self::walk_dir($dir, $ctx, $snap, $deadline) || microtime(true) >= $deadline) {
                break;
            }
        }
        update_option(WPL7_Connect_Plugin::OPT_SNAPSHOT, $snap, false);
        return $snap;
    }

    /**
     * Lists one directory into the table. False when time ran out half way: `pos` then says how
     * far it got, and the next request skips the names it already has.
     */
    private static function walk_dir($dir, &$ctx, &$snap, $deadline)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        $id = (int) $dir['id'];
        $base = $dir['path'];
        $abs_dir = $base === '' ? $ctx['root'] : $ctx['root'] . '/' . $base;
        // Where the folder must still be: under the site's root at its own path, or, for a
        // followed link and what is walked with follow: inside, where its real path was found.
        // Checked before and after the listing, and before each batch of rows is written: PHP
        // cannot list a folder it has checked, only narrow the time between the two.
        $expected = $dir['real'] !== null ? $dir['real'] : $abs_dir;
        $names = self::in_place($abs_dir, $expected, $ctx['root']) ? @scandir($abs_dir) : false;
        if ($names === false || !self::in_place($abs_dir, $expected, $ctx['root'])) {
            return self::give_up($id, $ctx);
        }
        $names = array_values(array_diff($names, ['.', '..']));
        sort($names, SORT_STRING);
        $pos = (int) $dir['pos'];
        $have = [];
        if ($pos > 0) {
            foreach ((array) $wpdb->get_col("SELECT `path` FROM `$table` WHERE `parent` = $id") as $path) {
                $have[self::name_of($path)] = true;
            }
        }
        $depth = $base === '' ? 1 : substr_count($base, '/') + 2;
        $rows = [];
        $count = count($names);
        for ($seq = 0; $seq < $count; $seq++) {
            $name = $names[$seq];
            if (isset($have[$name])) {
                continue;
            }
            $counted = $seq >= $pos;
            $rel = $base === '' ? $name : $base . '/' . $name;
            $pattern = self::exclude_match($rel, $ctx['patterns']);
            if ($pattern !== null) {
                if ($counted) {
                    $snap['excluded'][$pattern] = (isset($snap['excluded'][$pattern]) ? $snap['excluded'][$pattern] : 0) + 1;
                }
                continue;
            }
            if (strlen($rel) > self::MAX_PATH) {
                if ($counted) {
                    $snap['too_long']++;
                }
                continue;
            }
            $row = self::examine($abs_dir . '/' . $name, $rel, $depth, $id, $ctx);
            if ($row === null) {
                if ($counted) {
                    $snap['special']++;
                }
                continue;
            }
            $row['parent'] = $id;
            $row['seq'] = $seq;
            $rows[] = $row;
            $ctx['progress']++;
            $out_of_time = microtime(true) >= $deadline;
            if (count($rows) >= self::INSERT_ROWS || $out_of_time) {
                if (!self::in_place($abs_dir, $expected, $ctx['root'])) {
                    return self::give_up($id, $ctx);
                }
                self::insert($rows);
                $rows = [];
            }
            if ($out_of_time) {
                $wpdb->query("UPDATE `$table` SET `pos` = " . ($seq + 1) . " WHERE `id` = $id");
                return false;
            }
        }
        if (!self::in_place($abs_dir, $expected, $ctx['root'])) {
            return self::give_up($id, $ctx);
        }
        self::insert($rows);
        $wpdb->query("UPDATE `$table` SET `walked` = 1, `pos` = $count WHERE `id` = $id");
        $ctx['progress']++;
        return true;
    }

    /** A folder that cannot be listed, or is no longer where it was found: flagged, and not walked. */
    private static function give_up($id, &$ctx)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        $wpdb->query("UPDATE `$table` SET `walked` = 1, `flags` = `flags` | " . self::FLAG_UNREADABLE . ' WHERE `id` = ' . (int) $id);
        $ctx['progress']++;
        return true;
    }

    /** The row for one directory entry, or null for what cannot be copied (sockets, fifos, devices). */
    private static function examine($abs, $rel, $depth, $parent, &$ctx)
    {
        $row = ['type' => self::TYPE_FILE, 'path' => $rel, 'real' => null, 'size' => 0, 'mtime' => 0, 'mode' => 0,
            'flags' => 0, 'target' => null, 'walked' => 1];
        $st = @lstat($abs);
        if ($st === false) {
            $row['flags'] = self::FLAG_UNREADABLE;
            return $row;
        }
        $row['mtime'] = (int) $st['mtime'];
        $row['mode'] = $st['mode'] & 07777;
        $format = $st['mode'] & 0170000;
        if ($format === 0120000) {
            return self::examine_link($abs, $depth, $parent, $row, $ctx);
        }
        if ($format === 0040000) {
            $row['type'] = self::TYPE_DIR;
            if ($depth >= self::MAX_DEPTH) {
                $row['flags'] |= self::FLAG_TOO_DEEP;
            } else {
                $row['walked'] = 0;
            }
            if ($ctx['follow'] === 'inside') {
                $real = @realpath($abs);
                $row['real'] = $real === false ? null : $real;
            }
            return $row;
        }
        if ($format === 0100000) {
            self::file_facts($abs, $st, $row, $ctx);
            return $row;
        }
        return null;
    }

    /**
     * A link is recorded as a link. Asked to follow links inside the site, one whose target is
     * there, and not left out, is recorded as what it points to: the panel writes it as a real
     * file or folder. A folder that contains the link itself is marked as a cycle and not walked.
     */
    private static function examine_link($abs, $depth, $parent, $row, &$ctx)
    {
        $row['flags'] |= self::FLAG_LINK;
        $target = @readlink($abs);
        $row['target'] = $target === false ? null : $target;
        if ($ctx['follow'] === 'inside') {
            $real = @realpath($abs);
            $rel = $real === false ? null : self::relative($real, $ctx['root']);
            $st = $rel === null ? false : @stat($abs);
            if ($st !== false && ($rel === '' || self::exclude_match($rel, $ctx['patterns']) === null)) {
                $format = $st['mode'] & 0170000;
                if ($format === 0040000) {
                    $row['type'] = self::TYPE_DIR;
                    $row['real'] = $real;
                    $row['mtime'] = (int) $st['mtime'];
                    $row['mode'] = $st['mode'] & 07777;
                    if (self::is_cycle($real, $parent, $ctx)) {
                        $row['flags'] |= self::FLAG_CYCLE;
                    } elseif ($depth >= self::MAX_DEPTH) {
                        $row['flags'] |= self::FLAG_TOO_DEEP;
                    } else {
                        $row['walked'] = 0;
                    }
                    return $row;
                }
                if ($format === 0100000) {
                    $row['mtime'] = (int) $st['mtime'];
                    $row['mode'] = $st['mode'] & 07777;
                    self::file_facts($abs, $st, $row, $ctx);
                    return $row;
                }
            }
        }
        $row['type'] = self::TYPE_LINK;
        if (!@file_exists($abs)) {
            $row['flags'] |= self::FLAG_DANGLING;
        }
        return $row;
    }

    private static function file_facts($abs, $st, &$row, $ctx)
    {
        $row['type'] = self::TYPE_FILE;
        $size = $st['size'];
        // 32-bit PHP cannot say how big a file of 2 GiB or more is, nor read all of it.
        if (PHP_INT_SIZE < 8 && ($size < 0 || $size >= 2147483647)) {
            $row['flags'] |= self::FLAG_TOO_LARGE;
            $size = 0;
        }
        $row['size'] = max(0, (int) $size);
        if (!@is_readable($abs)) {
            $row['flags'] |= self::FLAG_UNREADABLE;
        }
        if ($ctx['since'] !== null && max((int) $st['mtime'], (int) $st['ctime']) < $ctx['since']) {
            $row['flags'] |= self::FLAG_UNCHANGED;
        }
    }

    /**
     * Whether following a link to the folder $real would walk into itself: $real is the folder the
     * link sits in, or one of the folders above it as the walk reached them, or contains one.
     */
    private static function is_cycle($real, $id, &$ctx)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        for ($guard = 0; $id > 0 && $guard <= self::MAX_DEPTH + 1; $guard++) {
            if (!isset($ctx['dirs'][$id])) {
                $r = $wpdb->get_row("SELECT `parent`, `real` FROM `$table` WHERE `id` = " . (int) $id, ARRAY_A);
                if (!$r) {
                    return false;
                }
                $ctx['dirs'][$id] = [(int) $r['parent'], $r['real']];
            }
            $above = $ctx['dirs'][$id][1];
            if ($above !== null && strpos($above . '/', $real . '/') === 0) {
                return true;
            }
            $id = $ctx['dirs'][$id][0];
        }
        return false;
    }

    private static function insert($rows)
    {
        global $wpdb;
        $table = WPL7_Connect_Plugin::table('files');
        $head = "INSERT INTO `$table` (`parent`, `seq`, `type`, `path`, `real`, `size`, `mtime`, `mode`, `flags`, `target`, `walked`, `pos`) VALUES ";
        $values = [];
        $bytes = 0;
        foreach ($rows as $r) {
            // Paths go as hex literals: wpdb strips what is not valid in the connection's charset
            // from a query, and a file name need not be valid in any.
            $value = '(' . (int) $r['parent'] . ',' . (int) $r['seq'] . ',' . (int) $r['type'] . ',' . self::hex($r['path'])
                . ',' . self::hex($r['real']) . ',' . sprintf('%.0f', $r['size']) . ',' . (int) $r['mtime'] . ',' . (int) $r['mode']
                . ',' . (int) $r['flags'] . ',' . self::hex($r['target']) . ',' . (int) $r['walked'] . ',0)';
            $values[] = $value;
            $bytes += strlen($value);
            if ($bytes >= self::INSERT_BYTES) {
                self::run_insert($head . implode(',', $values));
                $values = [];
                $bytes = 0;
            }
        }
        if ($values) {
            self::run_insert($head . implode(',', $values));
        }
    }

    private static function run_insert($sql)
    {
        global $wpdb;
        if ($wpdb->query($sql) === false) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The file list cannot be written: ' . $wpdb->last_error]);
        }
    }

    private static function hex($bytes)
    {
        return $bytes === null ? 'NULL' : "X'" . bin2hex($bytes) . "'";
    }

    private static function status($snap)
    {
        global $wpdb;
        if ($snap === null) {
            return ['snapshot_id' => null, 'done' => false, 'entries' => 0, 'bytes' => 0, 'files' => 0, 'dirs' => 0,
                'dirs_pending' => 0, 'warnings' => []];
        }
        $table = WPL7_Connect_Plugin::table('files');
        $t = $wpdb->get_row(
            "SELECT COALESCE(SUM(`path` <> ''), 0) AS n_entries,
                COALESCE(SUM(CASE WHEN `type` = 1 THEN `size` ELSE 0 END), 0) AS n_bytes,
                COALESCE(SUM(`type` = 1), 0) AS n_files, COALESCE(SUM(`type` = 2 AND `path` <> ''), 0) AS n_dirs,
                COALESCE(SUM(`type` = 2 AND `walked` = 0), 0) AS n_pending,
                SUM((`flags` & 1) <> 0) AS n_link, SUM((`flags` & 2) <> 0) AS n_unreadable,
                SUM((`flags` & 4) <> 0) AS n_too_large, SUM((`flags` & 8) <> 0) AS n_cycle,
                SUM((`flags` & 16) <> 0) AS n_dangling, SUM((`flags` & 32) <> 0) AS n_too_deep
            FROM `$table`",
            ARRAY_A
        );
        $warnings = [];
        foreach (['link', 'unreadable', 'too_large', 'cycle', 'dangling', 'too_deep'] as $code) {
            if (!empty($t['n_' . $code])) {
                $warnings[] = ['code' => $code, 'count' => (int) $t['n_' . $code]];
            }
        }
        foreach (['special', 'too_long'] as $code) {
            if (!empty($snap[$code])) {
                $warnings[] = ['code' => $code, 'count' => (int) $snap[$code]];
            }
        }
        foreach ((array) $snap['excluded'] as $pattern => $count) {
            $warnings[] = ['code' => 'excluded', 'detail' => (string) $pattern, 'count' => (int) $count];
        }
        return [
            'snapshot_id' => $snap['id'],
            'done' => !empty($snap['done']),
            'entries' => (int) $t['n_entries'],
            'bytes' => (int) $t['n_bytes'],
            'files' => (int) $t['n_files'],
            'dirs' => (int) $t['n_dirs'],
            'dirs_pending' => (int) $t['n_pending'],
            'warnings' => $warnings,
        ];
    }

    // -- files -------------------------------------------------------------------------------

    /** The `files` action: { snapshot_id, after, limit } gives entries in id order. */
    public static function files($params, $deadline)
    {
        global $wpdb;
        $snap = self::require_snapshot($params);
        if (empty($snap['done'])) {
            throw new WPL7_Connect_Error(409, 'busy', ['detail' => 'walking']);
        }
        $after = isset($params['after']) ? $params['after'] : 0;
        $limit = isset($params['limit']) ? $params['limit'] : self::PAGE_DEFAULT;
        if (!is_int($after) || $after < 0) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'after']);
        }
        if (!is_int($limit) || $limit < 1 || $limit > self::PAGE_MAX) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'limit']);
        }
        $table = WPL7_Connect_Plugin::table('files');
        $rows = (array) $wpdb->get_results(
            "SELECT `id`, `type`, `path`, `size`, `mtime`, `mode`, `flags`, `target` FROM `$table`
            WHERE `id` > $after AND `path` <> '' ORDER BY `id` LIMIT " . ($limit + 1),
            ARRAY_A
        );
        $more = count($rows) > $limit;
        if ($more) {
            array_pop($rows);
        }
        $ctx = self::context($snap);
        $entries = [];
        foreach ($rows as $row) {
            $entries[] = self::entry($row, $ctx, $deadline);
        }
        $last = end($entries);
        return ['entries' => $entries, 'next' => $more && $last ? $last['id'] : null];
    }

    private static function require_snapshot($params)
    {
        $snap = self::current();
        if ($snap === null || !isset($params['snapshot_id']) || $params['snapshot_id'] !== $snap['id']) {
            throw new WPL7_Connect_Error(409, 'snapshot_stale');
        }
        return $snap;
    }

    /** One file list entry. Keys are short because there can be hundreds of thousands. */
    private static function entry($row, $ctx, $deadline)
    {
        $types = [self::TYPE_FILE => 'f', self::TYPE_DIR => 'd', self::TYPE_LINK => 'l'];
        $type = (int) $row['type'];
        $path = $row['path'];
        $flags = (int) $row['flags'];
        $e = [
            'id' => (int) $row['id'],
            'p' => WPL7_Connect_Plugin::utf8_display($path),
            's' => (int) $row['size'],
            'm' => (int) $row['mtime'],
            'md' => sprintf('%04o', (int) $row['mode']),
            't' => isset($types[$type]) ? $types[$type] : 'f',
        ];
        if (!WPL7_Connect_Plugin::is_utf8($path)) {
            $e['pb'] = base64_encode($path);
        }
        if ($flags) {
            $e['f'] = self::flag_names($flags);
        }
        if ($row['target'] !== null) {
            $e['l'] = WPL7_Connect_Plugin::utf8_display($row['target']);
            if (!WPL7_Connect_Plugin::is_utf8($row['target'])) {
                $e['lb'] = base64_encode($row['target']);
            }
        }
        // A hash while it is cheap: small files, and only while the request has time. It is of
        // the file as it is now, so only when the file still matches its listing.
        if ($type === self::TYPE_FILE && !($flags & (self::FLAG_UNREADABLE | self::FLAG_TOO_LARGE))
            && $e['s'] <= self::HASH_MAX && microtime(true) < $deadline) {
            $open = self::open_checked($row, $ctx);
            if (is_array($open)) {
                if ((int) $open['st']['size'] === $e['s'] && (int) $open['st']['mtime'] === $e['m']) {
                    $hash = hash_init('sha256');
                    hash_update_stream($hash, $open['fh']);
                    $hash = hash_final($hash);
                    if (self::unchanged($open)) {
                        $e['h'] = $hash;
                    }
                }
                fclose($open['fh']);
            }
        }
        return $e;
    }

    /**
     * Where an entry's bytes are now, checked again: still a regular file, still inside the site
     * once every link on the way is resolved, and not left out. Otherwise the reason, as the
     * `detail` of a 404.
     */
    private static function resolve($row, $ctx)
    {
        $path = $row['path'];
        if (!self::safe_relative($path)) {
            return 'missing';
        }
        if (self::exclude_match($path, $ctx['patterns']) !== null) {
            return 'excluded';
        }
        $abs = $ctx['root'] . '/' . $path;
        clearstatcache(true);
        $real = @realpath($abs);
        if ($real === false) {
            return 'missing';
        }
        $rel = self::relative($real, $ctx['root']);
        if ($rel === null || $rel === '') {
            return 'missing';
        }
        // Without links followed, an entry's real path is its own path: anything else means a
        // folder on the way has become a link since the listing.
        if ($ctx['follow'] !== 'inside' && $real !== $abs) {
            return 'missing';
        }
        if (self::exclude_match($rel, $ctx['patterns']) !== null) {
            return 'excluded';
        }
        $st = ((int) $row['flags'] & self::FLAG_LINK) ? @stat($abs) : @lstat($abs);
        if ($st === false || ($st['mode'] & 0170000) !== 0100000) {
            return 'missing';
        }
        return ['abs' => $abs, 'real' => $real, 'st' => $st];
    }

    /**
     * An entry opened for reading, or the reason it cannot be. PHP cannot open a file relative to
     * a folder it has checked, so the time between the check and the open is narrowed instead:
     * the file is opened right after the check, and must be the very file the check found (device
     * and inode), still at the same real path. A file replaced between the two is checked again,
     * once. The caller closes the handle.
     */
    private static function open_checked($row, $ctx)
    {
        for ($try = 0; $try < 2; $try++) {
            $found = self::resolve($row, $ctx);
            if (!is_array($found)) {
                return $found;
            }
            $fh = @fopen($found['abs'], 'rb');
            if ($fh === false) {
                return 'unreadable';
            }
            $st = @fstat($fh);
            clearstatcache(true);
            $real = @realpath($found['abs']);
            $at = $real === false ? false : @stat($real);
            if ($st !== false && $at !== false && $real === $found['real']
                && self::same_file($st, $found['st']) && self::same_file($st, $at)) {
                return ['fh' => $fh, 'abs' => $found['abs'], 'flags' => (int) $row['flags'], 'st' => $st];
            }
            fclose($fh);
        }
        return 'missing';
    }

    private static function same_file($a, $b)
    {
        return (int) $a['dev'] === (int) $b['dev'] && (int) $a['ino'] === (int) $b['ino'];
    }

    /**
     * After a read: the path still leads to the file that was read, by device and inode, and the
     * file's size and mtime did not change while it was read.
     */
    private static function unchanged($open)
    {
        clearstatcache(true);
        $now = @fstat($open['fh']);
        $path = ($open['flags'] & self::FLAG_LINK) ? @stat($open['abs']) : @lstat($open['abs']);
        return $now !== false && $path !== false && self::same_file($path, $open['st'])
            && (int) $now['size'] === (int) $open['st']['size'] && (int) $now['mtime'] === (int) $open['st']['mtime'];
    }

    private static function read_handle($fh, $offset, $length)
    {
        if ($length <= 0) {
            return '';
        }
        if ($offset > 0 && fseek($fh, $offset) !== 0) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The file cannot be read from that offset.']);
        }
        $data = '';
        while (strlen($data) < $length && !feof($fh)) {
            $chunk = fread($fh, min(1048576, $length - strlen($data)));
            if ($chunk === false || $chunk === '') {
                break;
            }
            $data .= $chunk;
        }
        return $data;
    }

    // -- range -------------------------------------------------------------------------------

    /**
     * The `range` action: { id, offset, length, encoding?, if_changed?, snapshot_id? }. A file that
     * changed since it was listed is refused with its new size and mtime, or, asked to refresh at
     * offset 0, served and listed anew.
     */
    public static function range($params, $limits)
    {
        global $wpdb;
        $id = isset($params['id']) ? $params['id'] : null;
        $offset = isset($params['offset']) ? $params['offset'] : 0;
        $length = isset($params['length']) ? $params['length'] : null;
        $encoding = isset($params['encoding']) ? $params['encoding'] : 'raw';
        $if_changed = isset($params['if_changed']) ? $params['if_changed'] : 'error';
        if (!is_int($id) || $id < 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'id']);
        }
        if (!is_int($offset) || $offset < 0) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'offset']);
        }
        if (!is_int($length) || $length < 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'length']);
        }
        if ($length > $limits['max_bytes']) {
            throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'length', 'max_bytes' => $limits['max_bytes']]);
        }
        if (!in_array($encoding, ['raw', 'base64', 'gzip'], true) || ($encoding === 'gzip' && !function_exists('gzencode'))) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'encoding']);
        }
        if ($if_changed !== 'error' && $if_changed !== 'refresh') {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'if_changed']);
        }
        $snap = self::current();
        if ($snap === null || (isset($params['snapshot_id']) && $params['snapshot_id'] !== $snap['id'])) {
            throw new WPL7_Connect_Error(409, 'snapshot_stale');
        }
        $table = WPL7_Connect_Plugin::table('files');
        $row = $wpdb->get_row("SELECT `id`, `type`, `path`, `size`, `mtime`, `flags` FROM `$table` WHERE `id` = $id AND `path` <> ''", ARRAY_A);
        if (!$row || (int) $row['type'] !== self::TYPE_FILE) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'missing']);
        }
        $flags = (int) $row['flags'];
        if ($flags & self::FLAG_UNREADABLE) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'unreadable']);
        }
        if ($flags & self::FLAG_TOO_LARGE) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'too_large']);
        }
        $ctx = self::context($snap);
        $open = self::open_checked($row, $ctx);
        if (!is_array($open)) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => $open]);
        }
        try {
            $size = (int) $open['st']['size'];
            $mtime = (int) $open['st']['mtime'];
            if ($size !== (int) $row['size'] || $mtime !== (int) $row['mtime']) {
                if ($if_changed !== 'refresh' || $offset !== 0) {
                    throw new WPL7_Connect_Error(409, 'changed', ['size' => $size, 'mtime' => $mtime]);
                }
                $wpdb->query("UPDATE `$table` SET `size` = $size, `mtime` = $mtime WHERE `id` = $id");
            }
            $data = self::read_handle($open['fh'], $offset, min($length, max(0, $size - $offset)));
            $range_sha = hash('sha256', $data);
            $file_sha = null;
            if ($size <= self::HASH_MAX) {
                if ($offset === 0 && strlen($data) === $size) {
                    $file_sha = $range_sha;
                } elseif (rewind($open['fh'])) {
                    $hash = hash_init('sha256');
                    hash_update_stream($hash, $open['fh']);
                    $file_sha = hash_final($hash);
                }
            }
            $same = self::unchanged($open);
        } finally {
            fclose($open['fh']);
        }
        // A file written to, or replaced, while it was read is no copy of anything. What its path
        // leads to now is checked before anything about it is said.
        if (!$same) {
            $now = self::resolve($row, $ctx);
            if (!is_array($now)) {
                throw new WPL7_Connect_Error(404, 'not_found', ['detail' => $now]);
            }
            throw new WPL7_Connect_Error(409, 'changed', ['size' => (int) $now['st']['size'], 'mtime' => (int) $now['st']['mtime']]);
        }
        $headers = ['X-WPL7-Size' => $size, 'X-WPL7-Mtime' => $mtime, 'X-WPL7-Range-Sha256' => $range_sha];
        if (is_string($file_sha)) {
            $headers['X-WPL7-Sha256'] = $file_sha;
        }
        if ($encoding === 'raw') {
            return WPL7_Connect_Server::raw($data, $headers);
        }
        $out = [
            'data' => base64_encode($encoding === 'gzip' ? gzencode($data, 6) : $data),
            'size' => $size,
            'mtime' => $mtime,
            'sha256' => $range_sha,
        ];
        if (is_string($file_sha)) {
            $out['file_sha256'] = $file_sha;
        }
        return WPL7_Connect_Server::json(200, $out, $headers);
    }

    // -- bundle ------------------------------------------------------------------------------

    /**
     * The `bundle` action: { snapshot_id, ids, max_bytes?, encoding? } gives several small files
     * whole, in the order asked, so a site of many small files does not cost a request each. It
     * stops before the files read would pass max_bytes, but always answers for the first id. A
     * file larger than 1 MiB, or than a range may be here, when it is opened or by the time it
     * has been read, is refused: those go through `range`. What each entry says is the file as it
     * was read now; `changed` marks one that differs from its listing.
     */
    public static function bundle($params, $limits, $deadline)
    {
        global $wpdb;
        $ids = isset($params['ids']) ? $params['ids'] : null;
        $max = isset($params['max_bytes']) ? $params['max_bytes'] : $limits['max_bytes'];
        $encoding = isset($params['encoding']) ? $params['encoding'] : 'base64';
        if (!is_array($ids) || !$ids || count($ids) > self::BUNDLE_MAX || array_values($ids) !== $ids) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'ids']);
        }
        foreach ($ids as $id) {
            if (!is_int($id) || $id < 1) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'ids']);
            }
        }
        if (!is_int($max) || $max < 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'max_bytes']);
        }
        if ($max > $limits['max_bytes']) {
            throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'max_bytes', 'max_bytes' => $limits['max_bytes']]);
        }
        if (($encoding !== 'base64' && $encoding !== 'gzip') || ($encoding === 'gzip' && !function_exists('gzencode'))) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'encoding']);
        }
        $snap = self::require_snapshot($params);
        $ctx = self::context($snap);
        $table = WPL7_Connect_Plugin::table('files');
        $rows = [];
        foreach ((array) $wpdb->get_results(
            "SELECT `id`, `type`, `path`, `size`, `mtime`, `flags` FROM `$table` WHERE `path` <> '' AND `id` IN (" . implode(',', $ids) . ')',
            ARRAY_A
        ) as $row) {
            $rows[(int) $row['id']] = $row;
        }
        $cap = min(self::HASH_MAX, $limits['max_bytes']);
        $files = [];
        $total = 0;
        $next = null;
        foreach ($ids as $n => $id) {
            if ($n > 0 && microtime(true) >= $deadline) {
                $next = $id;
                break;
            }
            $problem = null;
            $open = null;
            if (!isset($rows[$id])) {
                $problem = 'missing';
            } elseif ((int) $rows[$id]['type'] !== self::TYPE_FILE) {
                $problem = 'not_a_file';
            } elseif ((int) $rows[$id]['flags'] & self::FLAG_UNREADABLE) {
                $problem = 'unreadable';
            } elseif ((int) $rows[$id]['flags'] & self::FLAG_TOO_LARGE) {
                $problem = 'too_large';
            } else {
                $open = self::open_checked($rows[$id], $ctx);
                if (!is_array($open)) {
                    $problem = $open;
                    $open = null;
                } elseif ((int) $open['st']['size'] > $cap) {
                    $problem = 'too_large';
                }
            }
            if ($problem !== null) {
                if ($open !== null) {
                    fclose($open['fh']);
                }
                $files[] = ['id' => $id, 'error' => $problem];
                continue;
            }
            if ($n > 0 && $total + (int) $open['st']['size'] > $max) {
                fclose($open['fh']);
                $next = $id;
                break;
            }
            $read = self::read_entry($rows[$id], $ctx, $cap, $open);
            if (!is_array($read)) {
                $files[] = ['id' => $id, 'error' => $read];
                continue;
            }
            $data = $read[0];
            $total += strlen($data);
            $entry = [
                'id' => $id,
                'size' => strlen($data),
                'mtime' => $read[1],
                'sha256' => hash('sha256', $data),
                'data' => base64_encode($encoding === 'gzip' ? gzencode($data, 6) : $data),
            ];
            if (strlen($data) !== (int) $rows[$id]['size'] || $read[1] !== (int) $rows[$id]['mtime']) {
                $entry['changed'] = true;
            }
            $files[] = $entry;
        }
        return ['files' => $files, 'next' => $next];
    }

    /**
     * A whole small file, through the handle $open checked, and its mtime; or the reason it cannot
     * be had. Up to one byte more than $cap is read, so a file that grew past the cap is
     * `too_large`, and the panel fetches it with `range`, rather than arriving cut short. A file
     * that changed while it was read is opened and read once more; still changing, the last read
     * is returned, and its size and hash describe those bytes. Closes every handle it uses.
     */
    private static function read_entry($row, $ctx, $cap, $open)
    {
        $last = null;
        for ($try = 0; $try < 2; $try++) {
            if ($try > 0) {
                $open = self::open_checked($row, $ctx);
                if (!is_array($open)) {
                    return $open;
                }
            }
            try {
                $data = (int) $open['st']['size'] > $cap ? '' : self::read_handle($open['fh'], 0, $cap + 1);
                $same = self::unchanged($open);
            } finally {
                fclose($open['fh']);
            }
            if ((int) $open['st']['size'] > $cap || strlen($data) > $cap) {
                return 'too_large';
            }
            $last = [$data, (int) $open['st']['mtime']];
            if ($same && strlen($data) === (int) $open['st']['size']) {
                break;
            }
        }
        return $last;
    }
}
