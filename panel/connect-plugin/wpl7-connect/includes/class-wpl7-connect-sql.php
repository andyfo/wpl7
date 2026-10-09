<?php
// A copy of WPL7 Migrate's class-wpl7-migrate-sql.php; a fix to one is made in the other in the same change.
defined('ABSPATH') || exit;

/**
 * The database: the table list, and each table as pages of SQL in WPL7's own grammar
 * (docs/internal/import-protocol.md, SQL the plugin writes). One statement per line, so the
 * panel can check every line before it runs any: DROP TABLE IF EXISTS and CREATE TABLE on a
 * table's first page, then INSERT lines only.
 *
 * Rows are paged by key: the primary key, or else a unique index over NOT NULL columns, so a page
 * starts where the last one ended whatever was written in between. A table with neither is paged
 * by offset, which a write between two pages can shift; the panel warns about those tables.
 *
 * The pure parts (literals, cursors, CREATE TABLE, the choice of key) are static methods that
 * tests/run.php calls without WordPress, with the escaper passed in.
 */
final class WPL7_Connect_Sql
{
    /** An INSERT line holds rows up to about this much SQL; a larger row is a line of its own. */
    const LINE_BYTES = 1048576;

    /** BIT counts as a number: it is read as `col + 0`, see select_expr(). */
    const NUMERIC = ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'dec',
        'fixed', 'float', 'double', 'real', 'bit'];
    const BINARY = ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'geometry', 'point',
        'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection',
        'vector'];
    /** Types whose values can be large enough to matter for max_row_bytes. */
    const BIG = ['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'json',
        'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon',
        'geometrycollection', 'geomcollection', 'vector'];
    /**
     * Types a key may have for paging by key: compared to a literal, they order the way ORDER BY
     * does. Floats compare inexactly, and ENUM sorts by position but compares as text.
     */
    const KEYABLE = ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'dec',
        'fixed', 'char', 'varchar', 'binary', 'varbinary', 'date', 'datetime', 'timestamp', 'time', 'year'];

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

    /** `bigint(20) unsigned` -> `bigint`. */
    public static function base_type($type)
    {
        return preg_match('/^\s*([a-z]+)/i', (string) $type, $m) ? strtolower($m[1]) : '';
    }

    /** How a column's values are written: numeric, binary or string. */
    public static function classify($type)
    {
        $base = self::base_type($type);
        if (in_array($base, self::NUMERIC, true)) {
            return 'numeric';
        }
        if (in_array($base, self::BINARY, true)) {
            return 'binary';
        }
        return 'string';
    }

    public static function is_big($type)
    {
        return in_array(self::base_type($type), self::BIG, true);
    }

    public static function keyable($type)
    {
        return in_array(self::base_type($type), self::KEYABLE, true);
    }

    public static function ident($name)
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }

    /**
     * How a column is read. A BIT value arrives as decimal digits from mysqlnd and as raw bytes
     * from libmysqlclient; `col + 0` is a number from both, and a number is what BIT takes back.
     */
    public static function select_expr($name, $type)
    {
        return self::base_type($type) === 'bit' ? '(' . self::ident($name) . ' + 0)' : self::ident($name);
    }

    /**
     * What mysqli_real_escape_string does on a utf8mb4 connection without NO_BACKSLASH_ESCAPES:
     * a backslash before NUL, line feed, carriage return, backslash, both quotes and Ctrl-Z.
     * Multibyte UTF-8 never contains those bytes, so byte by byte is exact. Used where WordPress's
     * connection is not mysqli: core's own fallback there is addslashes(), which leaves line breaks
     * as they are and so would break an INSERT across lines.
     */
    public static function escape($s)
    {
        return strtr($s, ["\\" => "\\\\", "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "'" => "\\'", '"' => '\\"', "\x1a" => "\\Z"]);
    }

    /**
     * A value as an SQL literal. NULL; numbers unquoted, as the server wrote them; binary values,
     * and text that is not valid UTF-8, as X'<hex>'; other text quoted, escaped by $escape, which
     * in the plugin is mysqli_real_escape_string on WordPress's own connection, or escape().
     */
    public static function literal($kind, $value, $escape)
    {
        if ($value === null) {
            return 'NULL';
        }
        $value = (string) $value;
        if ($kind === 'numeric') {
            if (preg_match('/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/D', $value)) {
                return $value;
            }
            $kind = 'string';
        }
        if ($kind === 'binary' || !WPL7_Connect_Plugin::is_utf8($value)) {
            return "X'" . bin2hex($value) . "'";
        }
        return "'" . call_user_func($escape, $value) . "'";
    }

    /** Key values as a cursor's items: text as it is, bytes that are not UTF-8 as { "x": hex }. */
    public static function cursor_items($values)
    {
        $items = [];
        foreach ($values as $value) {
            $value = (string) $value;
            $items[] = WPL7_Connect_Plugin::is_utf8($value) ? $value : ['x' => bin2hex($value)];
        }
        return $items;
    }

    /** `k:[...]`, the key of the last row sent; `k:[]` is a table's first row. */
    public static function encode_cursor($values)
    {
        return 'k:' . json_encode(self::cursor_items($values), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /** `o:<n>`, rows sent so far, for a table without a usable key. */
    public static function offset_cursor($offset)
    {
        return 'o:' . (int) $offset;
    }

    /** A cursor back into ['mode' => start | k | o, ...]; null when it is no cursor of ours. */
    public static function decode_cursor($cursor)
    {
        if (!is_string($cursor)) {
            return null;
        }
        if ($cursor === '') {
            return ['mode' => 'start'];
        }
        if (preg_match('/^o:(0|[1-9][0-9]{0,17})$/D', $cursor, $m)) {
            return ['mode' => 'o', 'offset' => (int) $m[1]];
        }
        // A JSON array: decoded to PHP, `{}` would pass for an empty one.
        if (strncmp($cursor, 'k:[', 3) !== 0) {
            return null;
        }
        $items = json_decode(substr($cursor, 2), true);
        if (!is_array($items) || array_values($items) !== $items) {
            return null;
        }
        $values = [];
        foreach ($items as $item) {
            if (is_string($item)) {
                $values[] = $item;
            } elseif (is_array($item) && count($item) === 1 && isset($item['x']) && is_string($item['x'])
                && preg_match('/^(?:[0-9a-f]{2})*$/D', $item['x'])) {
                $values[] = (string) hex2bin($item['x']);
            } else {
                return null;
            }
        }
        return ['mode' => 'k', 'values' => $values];
    }

    /**
     * SHOW CREATE TABLE as one line. White space outside quotes and identifiers, line breaks
     * included, becomes a single space; inside quotes MySQL has escaped line breaks already.
     * Comments go. On MySQL those are versioned clauses, such as MySQL 8's DEFAULT
     * ENCRYPTION='N' or a partitioning clause. Removing anything but ENCRYPTION='N' changes the
     * table, and is reported as a warning.
     */
    public static function normalize_create($sql)
    {
        $out = '';
        $removed = [];
        $len = strlen($sql);
        $quote = '';
        $i = 0;
        while ($i < $len) {
            $c = $sql[$i];
            if ($quote !== '') {
                $out .= $c;
                $i++;
                if ($c === '\\' && $quote !== '`' && $i < $len) {
                    $out .= $sql[$i];
                    $i++;
                } elseif ($c === $quote) {
                    if ($i < $len && $sql[$i] === $quote) {
                        $out .= $quote;
                        $i++;
                    } else {
                        $quote = '';
                    }
                }
                continue;
            }
            if ($c === "'" || $c === '"' || $c === '`') {
                $quote = $c;
                $out .= $c;
                $i++;
                continue;
            }
            // A comment counts as white space, as it does to MySQL's parser.
            if ($c === '/' && $i + 1 < $len && $sql[$i + 1] === '*') {
                $end = strpos($sql, '*/', $i + 2);
                $stop = $end === false ? $len : $end;
                $removed[] = trim(substr($sql, $i + 2, $stop - $i - 2));
                $i = $end === false ? $len : $end + 2;
                if ($out !== '' && substr($out, -1) !== ' ') {
                    $out .= ' ';
                }
                continue;
            }
            if ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r") {
                if ($out !== '' && substr($out, -1) !== ' ') {
                    $out .= ' ';
                }
                $i++;
                continue;
            }
            $out .= $c;
            $i++;
        }
        $warning = false;
        foreach ($removed as $comment) {
            $body = strtoupper(preg_replace('/\s+/', ' ', trim(preg_replace('/^M?!\d*/', '', $comment))));
            if ($body !== "DEFAULT ENCRYPTION='N'" && $body !== "ENCRYPTION='N'") {
                $warning = true;
            }
        }
        return ['sql' => rtrim($out, ' '), 'removed' => $removed, 'warning' => $warning];
    }

    /**
     * The columns a table is paged by: the primary key, or else the unique index over NOT NULL
     * columns with the fewest columns. Null when there is none whose columns all have a type that
     * pages correctly (KEYABLE) and none of them is generated.
     *
     * @param array $columns name => ['type' => ..., 'nullable' => bool, 'generated' => bool]
     * @param array $indexes [['name' => ..., 'unique' => bool, 'columns' => [name or null, ...]], ...]
     */
    public static function choose_key($columns, $indexes)
    {
        $best = null;
        foreach ($indexes as $index) {
            if (empty($index['unique']) || empty($index['columns'])) {
                continue;
            }
            $usable = true;
            foreach ($index['columns'] as $name) {
                if ($name === null || !isset($columns[$name]) || $columns[$name]['nullable']
                    || $columns[$name]['generated'] || !self::keyable($columns[$name]['type'])) {
                    $usable = false;
                    break;
                }
            }
            if (!$usable) {
                continue;
            }
            if ($best === null || self::better_key($index, $best)) {
                $best = $index;
            }
        }
        return $best === null ? null : array_values($best['columns']);
    }

    private static function better_key($a, $b)
    {
        $a_primary = $a['name'] === 'PRIMARY';
        $b_primary = $b['name'] === 'PRIMARY';
        if ($a_primary !== $b_primary) {
            return $a_primary;
        }
        if (count($a['columns']) !== count($b['columns'])) {
            return count($a['columns']) < count($b['columns']);
        }
        return strcmp($a['name'], $b['name']) < 0;
    }

    /**
     * Rows after a key, as a WHERE condition: (a > x) OR (a = x AND b > y) ... An OR of ranges, not
     * a row comparison, because older servers do not use an index for (a, b) > (x, y).
     *
     * @param array $keys [[name, kind], ...]
     */
    public static function keyset_where($keys, $values, $escape)
    {
        $or = [];
        foreach ($keys as $i => $key) {
            $and = [];
            for ($j = 0; $j < $i; $j++) {
                $and[] = self::ident($keys[$j][0]) . ' = ' . self::literal($keys[$j][1], $values[$j], $escape);
            }
            $and[] = self::ident($key[0]) . ' > ' . self::literal($key[1], $values[$i], $escape);
            $or[] = '(' . implode(' AND ', $and) . ')';
        }
        return implode(' OR ', $or);
    }

    public static function insert_head($table, $columns)
    {
        return 'INSERT INTO ' . self::ident($table) . ' (' . implode(',', array_map([__CLASS__, 'ident'], $columns)) . ') VALUES ';
    }

    // -- The database ------------------------------------------------------------------------

    private static function own_tables()
    {
        return [WPL7_Connect_Plugin::table('files'), WPL7_Connect_Plugin::table('nonces'), WPL7_Connect_Plugin::table('log')];
    }

    /** WordPress's mysqli connection, or null when a drop-in replaced it with something else. */
    private static function dbh()
    {
        global $wpdb;
        $dbh = isset($wpdb->dbh) ? $wpdb->dbh : null;
        return $dbh instanceof mysqli ? $dbh : null;
    }

    /** The same escaping whatever the connection: see escape(). */
    private static function escaper()
    {
        $dbh = self::dbh();
        if ($dbh !== null) {
            return function ($s) use ($dbh) {
                return mysqli_real_escape_string($dbh, $s);
            };
        }
        return [__CLASS__, 'escape'];
    }

    /**
     * The connection as the export needs it, for this request only. utf8mb4, so text arrives as
     * UTF-8 whatever its columns use. UTC, so TIMESTAMP values read back as they are stored. An
     * empty sql_mode, because ANSI_QUOTES changes how SHOW CREATE TABLE quotes, and
     * NO_BACKSLASH_ESCAPES how strings are escaped.
     */
    private static function prepare_connection()
    {
        global $wpdb;
        $dbh = self::dbh();
        if ($dbh !== null) {
            if (!@mysqli_set_charset($dbh, 'utf8mb4')) {
                @mysqli_set_charset($dbh, 'utf8');
            }
        } else {
            $wpdb->query('SET NAMES utf8mb4');
        }
        if ($wpdb->query("SET SESSION sql_mode = '', SESSION time_zone = '+00:00'") === false) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The database connection cannot be prepared: ' . $wpdb->last_error]);
        }
        $wpdb->query('SET SESSION sql_quote_show_create = 1');
    }

    /** Every table of the database, with what the panel needs to plan the copy. */
    public static function tables_info()
    {
        global $wpdb;
        $own = self::own_tables();
        $rows = (array) $wpdb->get_results(
            'SELECT TABLE_NAME AS t_name, TABLE_TYPE AS t_type, ENGINE AS t_engine, TABLE_ROWS AS t_rows,
                DATA_LENGTH AS t_data, INDEX_LENGTH AS t_index, AVG_ROW_LENGTH AS t_avg, TABLE_COLLATION AS t_collation
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
            ARRAY_A
        );
        $columns = [];
        foreach ((array) $wpdb->get_results(
            'SELECT TABLE_NAME AS t_name, COLUMN_NAME AS c_name, COLUMN_TYPE AS c_type, IS_NULLABLE AS c_null, EXTRA AS c_extra
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION',
            ARRAY_A
        ) as $c) {
            $columns[$c['t_name']][$c['c_name']] = [
                'type' => $c['c_type'],
                'nullable' => $c['c_null'] === 'YES',
                'generated' => self::is_generated($c['c_extra']),
            ];
        }
        $indexes = [];
        foreach ((array) $wpdb->get_results(
            'SELECT TABLE_NAME AS t_name, INDEX_NAME AS i_name, NON_UNIQUE AS i_non_unique, COLUMN_NAME AS c_name
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
            ARRAY_A
        ) as $k) {
            $indexes[$k['t_name']][$k['i_name']]['name'] = $k['i_name'];
            $indexes[$k['t_name']][$k['i_name']]['unique'] = (string) $k['i_non_unique'] === '0';
            $indexes[$k['t_name']][$k['i_name']]['columns'][] = $k['c_name'];
        }
        $tables = [];
        $views = 0;
        foreach ($rows as $r) {
            if ($r['t_type'] === 'VIEW') {
                $views++;
                continue;
            }
            if (!self::is_base_table($r['t_type']) || in_array($r['t_name'], $own, true)) {
                continue;
            }
            $name = $r['t_name'];
            $tables[] = [
                'name' => $name,
                'rows' => (int) $r['t_rows'],
                'bytes' => (int) $r['t_data'] + (int) $r['t_index'],
                'pk' => self::choose_key(
                    isset($columns[$name]) ? $columns[$name] : [],
                    isset($indexes[$name]) ? array_values($indexes[$name]) : []
                ),
                'collation' => $r['t_collation'],
                'engine' => $r['t_engine'],
                'avg_row' => (int) $r['t_avg'],
            ];
        }
        return ['tables' => $tables, 'views' => $views];
    }

    /** The `tables` action. */
    public static function tables_response()
    {
        global $wpdb;
        $info = self::tables_info();
        return ['tables' => $info['tables'], 'prefix' => $wpdb->prefix];
    }

    private static function is_base_table($type)
    {
        // MariaDB reports a system-versioned table as its own type. Its current rows are copied.
        return $type === 'BASE TABLE' || $type === 'SYSTEM VERSIONED';
    }

    /** MySQL says VIRTUAL GENERATED or STORED GENERATED, older MariaDB VIRTUAL or PERSISTENT. */
    private static function is_generated($extra)
    {
        return preg_match('/\b(VIRTUAL|STORED|PERSISTENT)\b/i', (string) $extra) === 1;
    }

    // -- sql ---------------------------------------------------------------------------------

    /** The `sql` action: { table, cursor, max_bytes?, encoding? } gives the next page of a table. */
    public static function page($params, $limits, $deadline)
    {
        global $wpdb;
        $table = isset($params['table']) ? $params['table'] : null;
        $cursor = isset($params['cursor']) ? $params['cursor'] : '';
        $max = isset($params['max_bytes']) ? $params['max_bytes'] : $limits['max_bytes'];
        $encoding = isset($params['encoding']) ? $params['encoding'] : 'json';
        // Only this site's tables: where several sites share a database, the others' are not the
        // panel's to read. `tables` still lists every table, for the panel's warning.
        if (!is_string($table) || !preg_match('/^[A-Za-z0-9_]{1,64}$/D', $table) || strpos($table, $wpdb->prefix) !== 0) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'table']);
        }
        if (!is_int($max) || $max < 1) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'max_bytes']);
        }
        if ($max > $limits['max_bytes']) {
            throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'max_bytes', 'max_bytes' => $limits['max_bytes']]);
        }
        if (($encoding !== 'json' && $encoding !== 'gzip') || ($encoding === 'gzip' && !function_exists('gzencode'))) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'encoding']);
        }
        $state = self::decode_cursor($cursor);
        if ($state === null) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'cursor']);
        }
        if (in_array($table, self::own_tables(), true)) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'table']);
        }
        $meta = $wpdb->get_row($wpdb->prepare(
            'SELECT TABLE_NAME AS t_name, TABLE_TYPE AS t_type, AVG_ROW_LENGTH AS t_avg FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s',
            $table
        ), ARRAY_A);
        if (!$meta || $meta['t_name'] !== $table) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'table']);
        }
        if (!self::is_base_table($meta['t_type'])) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => $meta['t_type'] === 'VIEW' ? 'view' : 'table type']);
        }

        self::prepare_connection();
        $columns = self::columns($table);
        $key = self::choose_key($columns, self::indexes($table));
        if (($state['mode'] === 'k' && ($key === null || ($state['values'] && count($state['values']) !== count($key))))
            || ($state['mode'] === 'o' && $key !== null)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'cursor']);
        }

        $warnings = [];
        $out = '';
        if ($state['mode'] === 'start') {
            $out = 'DROP TABLE IF EXISTS ' . self::ident($table) . ";\n" . self::create_line($table, $warnings) . ";\n";
            $state = $key === null ? ['mode' => 'o', 'offset' => 0] : ['mode' => 'k', 'values' => []];
        }

        $insertable = [];
        foreach ($columns as $name => $column) {
            if (!$column['generated']) {
                $insertable[] = $name;
            }
        }
        // Unlike WPL7 Migrate, every row of the options goes, this plugin's own included: they hold
        // the panel's public key and settings, nothing secret once the site is connected, and a
        // database restored by hand then keeps the connection (docs/internal/connect-protocol.md,
        // Paths and excludes).
        $where = null;
        $result = ['rows' => 0, 'skipped' => [], 'done' => true];
        if ($insertable) {
            $result = self::rows($table, $columns, $insertable, $key, $state, $out, [
                'max' => $max,
                'max_row' => $limits['max_row_bytes'],
                'deadline' => $deadline,
                'avg_row' => (int) $meta['t_avg'],
                'where' => $where,
            ]);
        }

        $response = [
            'next' => $result['done'] ? null : ($state['mode'] === 'o' ? self::offset_cursor($state['offset']) : self::encode_cursor($state['values'])),
            'rows' => $result['rows'],
            'skipped' => $result['skipped'],
            'sha256' => hash('sha256', $out),
        ];
        if ($encoding === 'gzip') {
            $response['gz'] = base64_encode(gzencode($out, 6));
        } elseif (WPL7_Connect_Plugin::is_utf8($out)) {
            $response['sql'] = $out;
        } else {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The page is not valid UTF-8; ask for it with encoding gzip.']);
        }
        if ($warnings) {
            $response['warnings'] = $warnings;
        }
        return $response;
    }

    private static function columns($table)
    {
        global $wpdb;
        $columns = [];
        foreach ((array) $wpdb->get_results('SHOW FULL COLUMNS FROM ' . self::ident($table), ARRAY_A) as $c) {
            // A line break in a column name would break the one-statement-per-line grammar.
            if (preg_match('/[\x00-\x1f]/', $c['Field'])) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'column name']);
            }
            $columns[$c['Field']] = [
                'type' => $c['Type'],
                'nullable' => $c['Null'] === 'YES',
                'generated' => self::is_generated($c['Extra']),
            ];
        }
        if (!$columns) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'The table has no columns: ' . $wpdb->last_error]);
        }
        return $columns;
    }

    private static function indexes($table)
    {
        global $wpdb;
        $indexes = [];
        foreach ((array) $wpdb->get_results('SHOW KEYS FROM ' . self::ident($table), ARRAY_A) as $k) {
            $name = $k['Key_name'];
            $indexes[$name]['name'] = $name;
            $indexes[$name]['unique'] = (string) $k['Non_unique'] === '0';
            $indexes[$name]['columns'][(int) $k['Seq_in_index']] = isset($k['Column_name']) ? $k['Column_name'] : null;
        }
        foreach ($indexes as $name => $index) {
            ksort($index['columns']);
            $indexes[$name]['columns'] = array_values($index['columns']);
        }
        return array_values($indexes);
    }

    private static function create_line($table, &$warnings)
    {
        global $wpdb;
        $row = $wpdb->get_row('SHOW CREATE TABLE ' . self::ident($table), ARRAY_N);
        if (!is_array($row) || !isset($row[1]) || !is_string($row[1])) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'SHOW CREATE TABLE failed: ' . $wpdb->last_error]);
        }
        $create = self::normalize_create($row[1]);
        if ($create['warning']) {
            $warnings[] = ['code' => 'create_comment', 'detail' => substr(implode(' ', $create['removed']), 0, 1000)];
        }
        $line = $create['sql'];
        if (strpos($line, "\n") !== false || strpos($line, "\r") !== false) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'line break in an identifier']);
        }
        if (strpos($line, 'CREATE TABLE ' . self::ident($table) . ' (') !== 0) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'SHOW CREATE TABLE gave something else.']);
        }
        return $line;
    }

    /**
     * Appends rows to $out from $state on, until the page is full, time is up or the table ends.
     * Each query asks for a batch; values of rows above max_row_bytes come back as NULL from the
     * server, so such a row never reaches PHP's memory, and the length beside it says what was
     * skipped. With mysqli the batch is read unbuffered: one row in memory at a time, and the
     * rest of a batch dropped once the page is full.
     */
    private static function rows($table, $columns, $insertable, $key, &$state, &$out, $opts)
    {
        $escape = self::escaper();
        $kinds = [];
        $big = [];
        foreach ($insertable as $name) {
            $kinds[] = self::classify($columns[$name]['type']);
            if (self::is_big($columns[$name]['type'])) {
                $big[] = 'COALESCE(LENGTH(' . self::ident($name) . '), 0)';
            }
        }
        $length = $big ? '(' . implode(' + ', $big) . ')' : null;
        // Every value gets a name of its own. Rows read through wpdb come back keyed by name, and
        // the server cuts an expression's own name short, so the IF() of two long columns, which
        // only differ at the end, would share one and lose a column.
        $select = [];
        foreach ($insertable as $i => $name) {
            $expr = $length !== null && self::is_big($columns[$name]['type'])
                ? 'IF(' . $length . ' > ' . (int) $opts['max_row'] . ', NULL, ' . self::ident($name) . ')'
                : self::select_expr($name, $columns[$name]['type']);
            $select[] = $expr . ' AS `c' . $i . '`';
        }
        if ($length !== null) {
            $select[] = $length . ' AS `row_bytes`';
        }
        $keys = [];
        $key_pos = [];
        if ($key !== null) {
            foreach ($key as $name) {
                $keys[] = [$name, self::classify($columns[$name]['type'])];
                $key_pos[] = array_search($name, $insertable, true);
            }
        }
        // About two pages' worth of rows a query, by the table's average row: a full page then
        // drops at most a page's worth of the batch, read unbuffered. Buffered, a batch is held
        // whole, so it is one page's worth.
        $dbh = self::dbh();
        $avg = max(64, $opts['avg_row']);
        $batch = $dbh !== null
            ? (int) max(10, min(5000, ceil(2 * $opts['max'] / $avg)))
            : (int) max(10, min(1000, floor($opts['max'] / $avg)));

        $page = [
            'head' => self::insert_head($table, $insertable),
            'line' => '',
            'rows' => 0,
            'skipped' => [],
            'full' => false,
            'length_at' => $length !== null ? count($insertable) : null,
        ];
        $done = false;
        // A first page may already be full with its CREATE TABLE; every later page takes a row.
        if (strlen($out) < $opts['max'] && ($out === '' || microtime(true) < $opts['deadline'])) {
            while (true) {
                $sql = 'SELECT ' . implode(', ', $select) . ' FROM ' . self::ident($table);
                // Rows a filter leaves out never count against LIMIT, so a short batch still means
                // the table's end, and the cursor stays the last row sent.
                $where = [];
                if ($key !== null && $state['values']) {
                    $where[] = '(' . self::keyset_where($keys, $state['values'], $escape) . ')';
                }
                if ($opts['where'] !== null) {
                    $where[] = '(' . $opts['where'] . ')';
                }
                if ($where) {
                    $sql .= ' WHERE ' . implode(' AND ', $where);
                }
                if ($key !== null) {
                    $sql .= ' ORDER BY ' . implode(', ', array_map([__CLASS__, 'ident'], $key)) . ' LIMIT ' . $batch;
                } else {
                    $sql .= ' LIMIT ' . (int) $state['offset'] . ', ' . $batch;
                }
                $taken = self::each_row($dbh, $sql, function ($row) use (&$page, &$state, &$out, $kinds, $key_pos, $escape, $opts) {
                    return self::take_row($row, $page, $state, $out, $kinds, $key_pos, $escape, $opts);
                });
                if ($page['full']) {
                    break;
                }
                if ($taken < $batch) {
                    $done = true;
                    break;
                }
                if (microtime(true) >= $opts['deadline']) {
                    break;
                }
            }
        }
        if ($page['line'] !== '') {
            $out .= $page['line'] . ";\n";
        }
        return ['rows' => $page['rows'], 'skipped' => $page['skipped'], 'done' => $done];
    }

    /** Runs $sql and hands each row to $take until it says stop. Returns how many rows it saw. */
    private static function each_row($dbh, $sql, $take)
    {
        global $wpdb;
        $seen = 0;
        if ($dbh !== null) {
            $result = mysqli_query($dbh, $sql, MYSQLI_USE_RESULT);
            if ($result === false) {
                throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'SQL: ' . mysqli_error($dbh)]);
            }
            while ($row = mysqli_fetch_row($result)) {
                $seen++;
                if (!$take($row)) {
                    break;
                }
            }
            mysqli_free_result($result);
            if (mysqli_errno($dbh)) {
                throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'SQL: ' . mysqli_error($dbh)]);
            }
            return $seen;
        }
        $rows = $wpdb->get_results($sql, ARRAY_N);
        if ($wpdb->last_error) {
            throw new WPL7_Connect_Error(500, 'internal', ['detail' => 'SQL: ' . $wpdb->last_error]);
        }
        foreach ((array) $rows as $row) {
            $seen++;
            if (!$take($row)) {
                break;
            }
        }
        return $seen;
    }

    /** One row into the page. False once the page is full or time is up. */
    private static function take_row($row, &$page, &$state, &$out, $kinds, $key_pos, $escape, $opts)
    {
        if ($state['mode'] === 'k') {
            $values = [];
            foreach ($key_pos as $pos) {
                $values[] = $row[$pos];
            }
            $state['values'] = $values;
            $where = ['key' => self::cursor_items($values)];
        } else {
            $where = ['offset' => $state['offset']];
            $state['offset']++;
        }
        if ($page['length_at'] !== null && (float) $row[$page['length_at']] > $opts['max_row']) {
            $page['skipped'][] = $where + ['bytes' => (int) $row[$page['length_at']]];
        } else {
            $values = [];
            foreach ($kinds as $i => $kind) {
                $values[] = self::literal($kind, $row[$i], $escape);
            }
            $tuple = '(' . implode(',', $values) . ')';
            if ($page['line'] === '') {
                $page['line'] = $page['head'] . $tuple;
            } elseif (strlen($page['line']) + 1 + strlen($tuple) > self::LINE_BYTES) {
                $out .= $page['line'] . ";\n";
                $page['line'] = $page['head'] . $tuple;
            } else {
                $page['line'] .= ',' . $tuple;
            }
            $page['rows']++;
        }
        if (strlen($out) + strlen($page['line']) >= $opts['max'] || microtime(true) >= $opts['deadline']) {
            $page['full'] = true;
            return false;
        }
        return true;
    }
}
