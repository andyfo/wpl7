<?php
// The plugin's pure parts, checked without WordPress against the shared vectors in
// panel/test/fixtures/migrateProtocol.json, which the panel's tests read too. CI runs it on the
// oldest and the newest PHP the plugin supports:
//
//   php panel/migrate-plugin/tests/run.php
//
// The class files only define classes, and refuse to load without ABSPATH, so it is defined first.

error_reporting(E_ALL);
ini_set('display_errors', '1');

define('ABSPATH', __DIR__ . '/');

$includes = __DIR__ . '/../wpl7-migrate/includes/';
foreach (['plugin', 'server', 'manifest', 'sql', 'info', 'maintenance'] as $name) {
    require $includes . 'class-wpl7-migrate-' . $name . '.php';
}

// WordPress's wrapper, for panel_url(): the same as parse_url() for the absolute URLs used here.
if (!function_exists('wp_parse_url')) {
    function wp_parse_url($url, $component = -1)
    {
        return parse_url($url, $component);
    }
}

$vectors = json_decode((string) file_get_contents(__DIR__ . '/../../test/fixtures/migrateProtocol.json'), true);
if (!is_array($vectors)) {
    fwrite(STDERR, "Cannot read panel/test/fixtures/migrateProtocol.json\n");
    exit(2);
}

$checks = 0;
$failures = [];

function same($got, $want, $what)
{
    global $checks, $failures;
    $checks++;
    if ($got !== $want) {
        $failures[] = $what . "\n    got:  " . var_export($got, true) . "\n    want: " . var_export($want, true);
    }
}

/**
 * mysqli_real_escape_string for a utf8mb4 connection without NO_BACKSLASH_ESCAPES, in PHP: the
 * seven bytes MySQL escapes. Multibyte UTF-8 never contains them, so byte by byte is exact.
 */
$escape = function ($s) {
    return strtr($s, ["\\" => "\\\\", "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "'" => "\\'", '"' => '\\"', "\x1a" => "\\Z"]);
};

// -- Signing --------------------------------------------------------------------------------

foreach ($vectors['signature'] as $v) {
    $canonical = WPL7_Migrate_Server::canonical($v['importId'], $v['action'], $v['timestamp'], $v['nonce'], $v['body']);
    same($canonical, $v['canonical'], "signature, {$v['name']}: canonical string");
    same(hash('sha256', $v['body']), $v['bodySha256'], "signature, {$v['name']}: body hash");
    same('v1=' . WPL7_Migrate_Server::sign($v['token'], $canonical), $v['signature'], "signature, {$v['name']}: signature");
    $auth = WPL7_Migrate_Server::parse_auth(
        ['id' => $v['importId'], 'ts' => (string) $v['timestamp'], 'nonce' => $v['nonce'], 'sig' => $v['signature']],
        []
    );
    same($auth, ['id' => $v['importId'], 'ts' => $v['timestamp'], 'nonce' => $v['nonce'], 'sig' => substr($v['signature'], 3)],
        "signature, {$v['name']}: the headers parse");
}

foreach ($vectors['timestamps'] as $v) {
    same(WPL7_Migrate_Server::timestamp_ok($v['timestamp'], $v['now']), $v['ok'], "timestamp {$v['timestamp']} at {$v['now']}");
}

$sig = 'v1=' . str_repeat('ab', 32);
$good = ['id' => '12', 'ts' => '1759843200', 'nonce' => str_repeat('0f', 16), 'sig' => $sig];
same(WPL7_Migrate_Server::parse_auth([], $good)['id'], '12', 'auth: query parameters stand in for headers');
same(WPL7_Migrate_Server::parse_auth(['id' => '13'] + $good, ['id' => '99'] + $good)['id'], '13', 'auth: a header wins over its query parameter');
same(WPL7_Migrate_Server::parse_auth(['id' => '12', 'ts' => '1759843200'], ['nonce' => $good['nonce'], 'sig' => $sig])['nonce'], $good['nonce'],
    'auth: each value from wherever it came');
foreach ([
    'no signature' => ['sig' => ''],
    'signature without v1=' => ['sig' => str_repeat('ab', 32)],
    'upper-case hex' => ['sig' => 'v1=' . str_repeat('AB', 32)],
    'short nonce' => ['nonce' => 'abc'],
    'upper-case nonce' => ['nonce' => str_repeat('0F', 16)],
    'import id 0' => ['id' => '0'],
    'leading zero in the timestamp' => ['ts' => '01759843200'],
    'a negative timestamp' => ['ts' => '-5'],
] as $what => $change) {
    same(WPL7_Migrate_Server::parse_auth(array_merge($good, $change), []), null, "auth: refused, $what");
}

// -- Limits ---------------------------------------------------------------------------------

$mib = 1048576;
foreach ([
    [30, 256 * $mib, ['max_ms' => 10000, 'max_bytes' => 8 * $mib, 'max_row_bytes' => 15 * $mib]],
    [0, -1, ['max_ms' => 10000, 'max_bytes' => 8 * $mib, 'max_row_bytes' => 15 * $mib]],
    [10, 64 * $mib, ['max_ms' => 5000, 'max_bytes' => 5592405, 'max_row_bytes' => 8 * $mib]],
    [30, 2 * $mib, ['max_ms' => 10000, 'max_bytes' => 262144, 'max_row_bytes' => $mib]],
] as $case) {
    same(WPL7_Migrate_Server::limits_for($case[0], $case[1]), $case[2], "limits for max_execution_time {$case[0]}, memory_limit {$case[1]}");
}

// -- SQL literals and cursors ---------------------------------------------------------------

foreach ($vectors['literals'] as $i => $v) {
    $value = array_key_exists('hex', $v) ? hex2bin($v['hex']) : $v['value'];
    same(WPL7_Migrate_Sql::literal($v['kind'], $value, $escape), $v['sql'], "literal #$i ({$v['kind']})");
    // The plugin's own escaping, for connections that are not mysqli, writes the same.
    same(WPL7_Migrate_Sql::literal($v['kind'], $value, ['WPL7_Migrate_Sql', 'escape']), $v['sql'], "literal #$i ({$v['kind']}), own escaping");
}
$bytes = '';
$expected = '';
for ($b = 0; $b < 256; $b++) {
    $bytes .= chr($b);
    $special = [0 => '\0', 10 => '\n', 13 => '\r', 26 => '\Z', 34 => '\"', 39 => "\\'", 92 => '\\\\'];
    $expected .= isset($special[$b]) ? $special[$b] : chr($b);
}
same(WPL7_Migrate_Sql::escape($bytes), $expected, 'own escaping: a backslash before exactly the seven bytes, every other byte as it is');

foreach ($vectors['cursors'] as $i => $v) {
    if (isset($v['offset'])) {
        same(WPL7_Migrate_Sql::offset_cursor($v['offset']), $v['cursor'], "cursor #$i: encode an offset");
        same(WPL7_Migrate_Sql::decode_cursor($v['cursor']), ['mode' => 'o', 'offset' => $v['offset']], "cursor #$i: decode an offset");
        continue;
    }
    $values = array_map('hex2bin', $v['valuesHex']);
    same(WPL7_Migrate_Sql::encode_cursor($values), $v['cursor'], "cursor #$i: encode");
    same(WPL7_Migrate_Sql::decode_cursor($v['cursor']), ['mode' => 'k', 'values' => $values], "cursor #$i: decode");
}
same(WPL7_Migrate_Sql::decode_cursor(''), ['mode' => 'start'], 'cursor: empty is the first page');
foreach ($vectors['badCursors'] as $cursor) {
    same(WPL7_Migrate_Sql::decode_cursor($cursor), null, "cursor refused: $cursor");
}

$keys = [['id', 'numeric']];
same(WPL7_Migrate_Sql::keyset_where($keys, ['41'], $escape), '(`id` > 41)', 'keyset: one column');
$keys = [['a', 'numeric'], ['b', 'string'], ['c', 'binary']];
same(
    WPL7_Migrate_Sql::keyset_where($keys, ['7', "it's", "\x00\xff"], $escape),
    "(`a` > 7) OR (`a` = 7 AND `b` > 'it\\'s') OR (`a` = 7 AND `b` = 'it\\'s' AND `c` > X'00ff')",
    'keyset: three columns'
);
same(WPL7_Migrate_Sql::insert_head('wp_t', ['id', 'we`ird']), 'INSERT INTO `wp_t` (`id`,`we``ird`) VALUES ', 'INSERT head');
same(WPL7_Migrate_Sql::select_expr('flags', 'bit(5)'), '(`flags` + 0)', 'BIT is read as a number');
same(WPL7_Migrate_Sql::select_expr('n', 'int(11)'), '`n`', 'other columns are read as they are');

foreach ([
    ['bigint(20) unsigned', 'numeric', false, true],
    ['decimal(10,2)', 'numeric', false, true],
    ['double', 'numeric', false, false],
    ['varchar(191)', 'string', false, true],
    ['longtext', 'string', true, false],
    ["enum('a','b')", 'string', false, false],
    ['json', 'string', true, false],
    ['datetime(6)', 'string', false, true],
    ['varbinary(255)', 'binary', false, true],
    ['longblob', 'binary', true, false],
    ['bit(1)', 'numeric', false, false],
    ['point', 'binary', true, false],
] as $case) {
    same(
        [WPL7_Migrate_Sql::classify($case[0]), WPL7_Migrate_Sql::is_big($case[0]), WPL7_Migrate_Sql::keyable($case[0])],
        [$case[1], $case[2], $case[3]],
        "column type {$case[0]}"
    );
}

// -- The key a table is paged by ------------------------------------------------------------

$col = function ($type, $nullable = false, $generated = false) {
    return ['type' => $type, 'nullable' => $nullable, 'generated' => $generated];
};
$columns = ['id' => $col('bigint(20) unsigned'), 'slug' => $col('varchar(100)'), 'n' => $col('int(11)', true),
    'f' => $col('double'), 'g' => $col('int(11)', false, true), 'a' => $col('int(11)'), 'b' => $col('int(11)')];
foreach ([
    'the primary key' => [[['name' => 'slug_u', 'unique' => true, 'columns' => ['slug']], ['name' => 'PRIMARY', 'unique' => true, 'columns' => ['id']]], ['id']],
    'a NOT NULL unique key without a primary key' => [[['name' => 'k', 'unique' => false, 'columns' => ['id']], ['name' => 'slug_u', 'unique' => true, 'columns' => ['slug']]], ['slug']],
    'no unique key over a NULL column' => [[['name' => 'n_u', 'unique' => true, 'columns' => ['n']]], null],
    'not a float primary key' => [[['name' => 'PRIMARY', 'unique' => true, 'columns' => ['f']], ['name' => 'slug_u', 'unique' => true, 'columns' => ['slug']]], ['slug']],
    'not a generated column' => [[['name' => 'PRIMARY', 'unique' => true, 'columns' => ['g']]], null],
    'not a functional key part' => [[['name' => 'fx', 'unique' => true, 'columns' => [null]]], null],
    'the unique key with the fewest columns' => [[['name' => 'ab', 'unique' => true, 'columns' => ['a', 'b']], ['name' => 'zz', 'unique' => true, 'columns' => ['b']]], ['b']],
    'nothing' => [[], null],
] as $what => $case) {
    same(WPL7_Migrate_Sql::choose_key($columns, $case[0]), $case[1], "key: $what");
}

// -- CREATE TABLE ---------------------------------------------------------------------------

foreach ($vectors['createTable'] as $v) {
    $n = WPL7_Migrate_Sql::normalize_create($v['raw']);
    same($n['sql'], $v['sql'], "CREATE TABLE, {$v['name']}: the line");
    same($n['warning'], $v['warning'], "CREATE TABLE, {$v['name']}: the warning");
}

// -- Files ----------------------------------------------------------------------------------

same(WPL7_Migrate_Manifest::DEFAULT_EXCLUDES, $vectors['excludes']['defaults'], 'excludes: the default list');
foreach ($vectors['excludes']['cases'] as $v) {
    $path = isset($v['pathHex']) ? hex2bin($v['pathHex']) : $v['path'];
    same(WPL7_Migrate_Manifest::exclude_match($path, $vectors['excludes']['defaults']), $v['excluded'], 'excludes: ' . bin2hex($path) . " ($path)");
}
foreach ($vectors['excludes']['extra']['cases'] as $v) {
    same(WPL7_Migrate_Manifest::exclude_match($v['path'], $vectors['excludes']['extra']['patterns']), $v['excluded'], "excludes, extra patterns: {$v['path']}");
}

foreach ($vectors['utf8'] as $v) {
    $bytes = hex2bin($v['hex']);
    same(WPL7_Migrate_Plugin::is_utf8($bytes), $v['valid'], "UTF-8 {$v['hex']}: valid");
    same(WPL7_Migrate_Plugin::utf8_display($bytes), $v['display'], "UTF-8 {$v['hex']}: display");
}

same(WPL7_Migrate_Manifest::flag_names(1 | 16 | 64), ['link', 'dangling', 'unchanged'], 'flag names');
foreach (['a' => true, 'a/b.php' => true, '' => false, '/a' => false, 'a/' => false, 'a//b' => false, './a' => false,
    'a/../b' => false, "a\0b" => false, '...' => true] as $path => $ok) {
    same(WPL7_Migrate_Manifest::safe_relative((string) $path), $ok, "safe path: " . json_encode((string) $path));
}
same(WPL7_Migrate_Manifest::relative('/srv/www/a/b', '/srv/www'), 'a/b', 'relative: inside');
same(WPL7_Migrate_Manifest::relative('/srv/www', '/srv/www'), '', 'relative: the root itself');
same(WPL7_Migrate_Manifest::relative('/srv/wwwx/a', '/srv/www'), null, 'relative: a sibling with the same start');
same(WPL7_Migrate_Manifest::relative('/a', ''), 'a', 'relative: below the file system root');

// -- The report -----------------------------------------------------------------------------

$config = <<<'PHP'
<?php
define( 'DB_PASSWORD', 'secret' );
define('WP_MEMORY_LIMIT', '256M');
if ( ! defined( 'WP_DEBUG' ) ) {
    define( "WP_DEBUG", false );
}
// define('COMMENTED_OUT', 1);
/* define('ALSO_COMMENTED', 1); */
$object->define('A_METHOD', 1);
Some_Class::define('A_STATIC', 1);
\define('FULLY_QUALIFIED', 1);
define('lower_case', 1);
define( 'WP_MEMORY_LIMIT', '512M' );
DEFINE('SHOUTED', true);
define(SOME_CONSTANT, 1);
PHP;
same(WPL7_Migrate_Info::define_names($config), ['DB_PASSWORD', 'WP_MEMORY_LIMIT', 'WP_DEBUG', 'FULLY_QUALIFIED', 'SHOUTED'], 'wp-config.php: define() names');
foreach (['DB_PASSWORD' => true, 'NONCE_SALT' => true, 'FTP_PASS' => true, 'FS_METHOD' => true, 'WP_DEBUG' => false, 'WP_MEMORY_LIMIT' => false] as $name => $blocked) {
    same(WPL7_Migrate_Info::blocklisted($name), $blocked, "blocklist: $name");
}

$wordpress = "# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule ^index\\.php$ - [L]\n</IfModule>\n# END WordPress\n";
same(WPL7_Migrate_Info::htaccess_custom($wordpress), false, '.htaccess: only WordPress\'s block');
same(WPL7_Migrate_Info::htaccess_custom("# a comment\n\n" . $wordpress), false, '.htaccess: comments and blank lines');
same(WPL7_Migrate_Info::htaccess_custom("Header set X-Example 1\r\n" . $wordpress), true, '.htaccess: a rule of its own');

foreach ([
    '11.4.3-MariaDB-ubu2404' => 'MariaDB 11.4.3',
    '5.5.5-10.4.32-MariaDB' => 'MariaDB 10.4.32',
    '10.11.6-MariaDB-1:10.11.6+maria~ubu2204-log' => 'MariaDB 10.11.6',
    '8.0.36' => 'MySQL 8.0.36',
    '8.0.36-0ubuntu0.22.04.1' => 'MySQL 8.0.36',
] as $version => $label) {
    same(WPL7_Migrate_Info::server_label($version), $label, "server label: $version");
}

foreach ([
    'https://panel.example.com/' => 'https://panel.example.com',
    'http://panel.example.test:8080' => 'http://panel.example.test:8080',
    'https://Panel.Example.COM/sub/' => 'https://panel.example.com/sub',
    'ftp://panel.example.com' => null,
    'https://user:pass@panel.example.com' => null,
    'https://panel.example.com/?a=1' => null,
    'https://panel.example.com/#x' => null,
    'panel.example.com' => null,
] as $url => $want) {
    same(WPL7_Migrate_Plugin::panel_url($url), $want, "panel address: $url");
}
same(preg_match(WPL7_Migrate_Plugin::TOKEN_RE, $vectors['signature'][0]['token']), 1, 'a connection code is 43 base64url characters');

// -- Plain http only to this machine or a private network -----------------------------------

foreach (['127.0.0.1' => true, '127.255.0.9' => true, '10.1.2.3' => true, '172.16.0.1' => true, '172.31.255.255' => true,
    '172.32.0.1' => false, '192.168.65.254' => true, '192.169.0.1' => false, '8.8.8.8' => false, '203.0.113.5' => false,
    '169.254.1.1' => false, '::1' => true, '[::1]' => true, 'fd00::1' => true, 'fc00::5' => true, 'fe80::1' => false,
    '2001:db8::1' => false, '::ffff:127.0.0.1' => true, '::ffff:8.8.8.8' => false, 'not-an-address' => false] as $ip => $local) {
    same(WPL7_Migrate_Plugin::local_ip((string) $ip), $local, "loopback or private: $ip");
}
$names = [
    'panel.example.com' => ['93.184.215.14'],
    'host.docker.internal' => ['192.168.65.254'],
    'panel.internal.test' => ['10.0.0.5', 'fd12::5'],
    'mixed.example' => ['10.0.0.5', '203.0.113.7'],
    'v6.example' => ['2001:db8::7'],
];
$resolve = function ($host) use ($names) {
    return isset($names[$host]) ? $names[$host] : [];
};
foreach ([
    'https://panel.example.com' => true,
    'https://203.0.113.9:8443/panel' => true,
    'http://panel.example.com' => false,
    'http://host.docker.internal:18080' => true,
    'http://panel.internal.test' => true,
    'http://mixed.example' => false,
    'http://v6.example' => false,
    'http://nowhere.example' => false,
    'http://localhost:3000' => true,
    'http://app.localhost' => true,
    'http://127.0.0.1:8080' => true,
    'http://[::1]:8080' => true,
    'http://10.0.0.8' => true,
    'http://192.0.2.10' => false,
    'ftp://panel.example.com' => false,
] as $url => $allowed) {
    same(WPL7_Migrate_Plugin::panel_allowed($url, $resolve), $allowed, "token may go to $url");
}

// -- What the maintenance gate lets past init -----------------------------------------------

foreach ([
    'rest_route in the query string' => [[null, '/wpl7-migrate/v1/ping', '/', '/', 'wp-json'], 'ping'],
    'rest_route in the body' => [['/wpl7-migrate/v1/sql', null, '/', '/', null], 'sql'],
    'the body before the query string' => [['/wpl7-migrate/v1/ping', '/wpl7-migrate/v1/ping', '/', '/', null], 'ping'],
    'body and query string that differ (WordPress refuses those)' => [['/wp/v2/posts', '/wpl7-migrate/v1/ping', '/', '/', null], null],
    'without regard to case' => [[null, '/WPL7-Migrate/V1/Ping', '/', '/', null], 'Ping'],
    'a trailing slash' => [[null, '/wpl7-migrate/v1/ping/', '/', '/', null], 'ping'],
    'a longer route' => [[null, '/wpl7-migrate/v1/ping/x', '/', '/', null], null],
    'another plugin\'s route' => [[null, '/wc/store/v1/checkout', '/', '/', null], null],
    'no leading slash' => [[null, 'wpl7-migrate/v1/ping', '/', '/', null], null],
    'a route that is not a string' => [[null, ['/wpl7-migrate/v1/ping'], '/', '/', null], null],
    'a pretty path' => [[null, null, '/wp-json/wpl7-migrate/v1/ping', '/', 'wp-json'], 'ping'],
    'a pretty path, URL-encoded' => [[null, null, '/wp-json/%77pl7-migrate/v1/ping', '/', 'wp-json'], 'ping'],
    'a pretty path below home' => [[null, null, '/blog/wp-json/wpl7-migrate/v1/ping', '/blog/', 'wp-json'], 'ping'],
    'home\'s path in another case' => [[null, null, '/BLOG/wp-json/wpl7-migrate/v1/ping', '/blog/', 'wp-json'], 'ping'],
    'through index.php' => [[null, null, '/index.php/wp-json/wpl7-migrate/v1/ping', '/', 'wp-json'], 'ping'],
    'a pretty path with plain permalinks' => [[null, null, '/wp-json/wpl7-migrate/v1/ping', '/', null], null],
    'a pretty path, but a query string route wins' => [[null, '/wp/v2/posts', '/wp-json/wpl7-migrate/v1/ping', '/', 'wp-json'], null],
    'another REST path' => [[null, null, '/wp-json/wp/v2/posts', '/', 'wp-json'], null],
    'a page' => [[null, null, '/shop/checkout/', '/', 'wp-json'], null],
] as $what => $case) {
    same(call_user_func_array(['WPL7_Migrate_Maintenance', 'rest_action'], $case[0]), $case[1], "maintenance, the plugin's route: $what");
}

// -- The result -----------------------------------------------------------------------------

foreach ($failures as $failure) {
    echo "FAIL $failure\n";
}
printf("%d checks, %d failed (PHP %s)\n", $checks, count($failures), PHP_VERSION);
exit($failures ? 1 : 0);
