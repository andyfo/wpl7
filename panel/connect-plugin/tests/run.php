<?php
// The plugin's pure parts, checked without WordPress against the shared vectors in
// panel/test/fixtures/connectProtocol.json, which the panel's tests read too, and against the SQL
// vectors of panel/test/fixtures/migrateProtocol.json: the paging code is a copy of WPL7 Migrate's
// and must write the same. CI runs it on the oldest and the newest PHP the plugin supports:
//
//   php panel/connect-plugin/tests/run.php
//
// The signature checks need sodium, which PHP has from 7.2. Where it is missing (PHP 7.0 and 7.1,
// or a PHP built without it), WPL7_SODIUM_COMPAT names sodium_compat's autoload.php, as
// WordPress bundles it and CI installs it with Composer:
//
//   composer require --working-dir=/tmp/sodium paragonie/sodium_compat
//   WPL7_SODIUM_COMPAT=/tmp/sodium/vendor/autoload.php php panel/connect-plugin/tests/run.php
//
// The class files only define classes, and refuse to load without ABSPATH, so it is defined first.

error_reporting(E_ALL);
ini_set('display_errors', '1');

define('ABSPATH', __DIR__ . '/');
define('WPL7_CONNECT_VERSION', '0.0.0-dev');
define('WPL7_CONNECT_FILE', dirname(__DIR__) . '/wpl7-connect/wpl7-connect.php');

if (!function_exists('sodium_crypto_sign_verify_detached')) {
    $compat = getenv('WPL7_SODIUM_COMPAT');
    if (is_string($compat) && $compat !== '' && is_file($compat)) {
        require $compat;
    }
}
if (!function_exists('sodium_crypto_sign_verify_detached')) {
    fwrite(STDERR, "This PHP has no sodium: install paragonie/sodium_compat and name its autoload.php in WPL7_SODIUM_COMPAT.\n");
    exit(2);
}

$includes = dirname(__DIR__) . '/wpl7-connect/includes/';
foreach (['plugin', 'server', 'manifest', 'sql', 'info', 'inventory', 'updates', 'rest', 'commands', 'login', 'loader', 'selfupdate'] as $name) {
    require $includes . 'class-wpl7-connect-' . $name . '.php';
}

// WordPress's own helpers the pure parts use, as WordPress defines them for these inputs.
if (!function_exists('wp_parse_url')) {
    function wp_parse_url($url, $component = -1)
    {
        return parse_url($url, $component);
    }
}
if (!function_exists('untrailingslashit')) {
    function untrailingslashit($value)
    {
        return rtrim($value, '/\\');
    }
}
if (!function_exists('wp_normalize_path')) {
    function wp_normalize_path($path)
    {
        $path = str_replace('\\', '/', $path);
        return preg_replace('|(?<=.)/+|', '/', $path);
    }
}

$fixtures = dirname(__DIR__, 2) . '/test/fixtures/';
$vectors = json_decode((string) file_get_contents($fixtures . 'connectProtocol.json'), true);
$sqlVectors = json_decode((string) file_get_contents($fixtures . 'migrateProtocol.json'), true);
if (!is_array($vectors) || !is_array($sqlVectors)) {
    fwrite(STDERR, "Cannot read panel/test/fixtures/connectProtocol.json or migrateProtocol.json\n");
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

/** base64url without padding, written here rather than taken from the plugin. */
function b64url($bytes)
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

// The must-use loader's own functions, from the source the plugin writes, without running it.
define('WPL7_CONNECT_LOADER_TEST', true);
$loaderFile = tempnam(sys_get_temp_dir(), 'wpl7-loader-');
file_put_contents($loaderFile, WPL7_Connect_Loader::source());
require $loaderFile;
unlink($loaderFile);

/**
 * The server's checks and the loader's, which must agree: [server, loader] pairs of callables.
 */
$both = [
    'server' => [
        'parse' => ['WPL7_Connect_Server', 'parse_auth'],
        'home' => ['WPL7_Connect_Server', 'decode_home'],
        'decode' => ['WPL7_Connect_Server', 'base64url_decode'],
        'canonical' => ['WPL7_Connect_Server', 'canonical'],
        'time' => ['WPL7_Connect_Server', 'timestamp_ok'],
        'verify' => ['WPL7_Connect_Server', 'verify_signature'],
    ],
    'loader' => [
        'parse' => 'wpl7_connect_loader_parse_auth',
        'home' => 'wpl7_connect_loader_decode_home',
        'decode' => 'wpl7_connect_loader_base64url_decode',
        'canonical' => 'wpl7_connect_loader_canonical',
        'time' => 'wpl7_connect_loader_timestamp_ok',
        'verify' => 'wpl7_connect_loader_verify',
    ],
];

// -- The key pair -----------------------------------------------------------------------------

$publicKey = WPL7_Connect_Server::base64url_decode($vectors['keyPair']['publicKey'], 32);
same(is_string($publicKey) ? strlen($publicKey) : null, 32, 'key pair: the public key is 32 bytes of base64url');
$seed = hex2bin($vectors['keyPair']['seedHex']);
same(b64url(sodium_crypto_sign_publickey(sodium_crypto_sign_seed_keypair($seed))), $vectors['keyPair']['publicKey'],
    'key pair: the public key is the seed\'s');
$der = base64_decode(preg_replace('/-----[A-Z ]+-----|\s+/', '', $vectors['keyPair']['privateKeyPem']));
same(bin2hex(substr($der, 0, 16)) . ':' . bin2hex(substr($der, 16)), '302e020100300506032b657004220420:' . $vectors['keyPair']['seedHex'],
    'key pair: the PEM is PKCS #8 around the seed, as tests/client.php reads it');

// -- Signing ----------------------------------------------------------------------------------

foreach ($vectors['signature'] as $v) {
    $sig = substr($v['signature'], strlen('ed25519='));
    $raw = WPL7_Connect_Server::base64url_decode($sig, 64);
    $values = ['site' => $v['connectionId'], 'home' => $v['homeHeader'], 'ts' => (string) $v['timestamp'], 'nonce' => $v['nonce'],
        'sig' => $v['signature']];
    $want = ['site' => $v['connectionId'], 'home' => $v['home'], 'ts' => $v['timestamp'], 'nonce' => $v['nonce'], 'sig' => $raw];
    same(hash('sha256', $v['body']), $v['bodySha256'], "signature, {$v['name']}: body hash");
    foreach ($both as $who => $f) {
        $canonical = call_user_func($f['canonical'], $v['connectionId'], $v['home'], $v['action'], $v['timestamp'], $v['nonce'], $v['body']);
        same($canonical, $v['canonical'], "signature, {$v['name']}, $who: canonical string");
        same(call_user_func($f['parse'], $values, []), $want, "signature, {$v['name']}, $who: the headers parse");
        same(call_user_func($f['parse'], [], $values), $want, "signature, {$v['name']}, $who: the query parameters parse");
        same(call_user_func($f['verify'], $raw, $canonical, $publicKey), true, "signature, {$v['name']}, $who: verifies");
        same(call_user_func($f['verify'], $raw, $canonical . 'x', $publicKey), false, "signature, {$v['name']}, $who: a longer message does not");
        $other = call_user_func($f['canonical'], $v['connectionId'], $v['home'] . '/', $v['action'], $v['timestamp'], $v['nonce'], $v['body']);
        same(call_user_func($f['verify'], $raw, $other, $publicKey), false, "signature, {$v['name']}, $who: another home does not");
        $flipped = $raw;
        $flipped[10] = chr(ord($flipped[10]) ^ 1);
        same(call_user_func($f['verify'], $flipped, $canonical, $publicKey), false, "signature, {$v['name']}, $who: a changed bit does not");
    }
}
foreach ($both as $who => $f) {
    $v = $vectors['signature'][0];
    $raw = WPL7_Connect_Server::base64url_decode(substr($v['signature'], 8), 64);
    // sodium throws on lengths it cannot take; the plugin never lets one through.
    same(call_user_func($f['verify'], substr($raw, 1), $v['canonical'], $publicKey), false, "verify, $who: a short signature is false, not an error");
    same(call_user_func($f['verify'], $raw, $v['canonical'], substr($publicKey, 1)), false, "verify, $who: a short key is false, not an error");
    same(call_user_func($f['verify'], $raw, $v['canonical'], str_repeat("\0", 32)), false, "verify, $who: a key of zeros is false, not an error");
    same(call_user_func($f['verify'], null, $v['canonical'], $publicKey), false, "verify, $who: no signature is false");
}

foreach ($vectors['homes'] as $v) {
    foreach ($both as $who => $f) {
        same(call_user_func($f['home'], $v['header']), $v['home'], "home, $who: {$v['header']}");
    }
}
foreach (['' => null, '%0A' => null, 'https%3A%2F%2Fexample.com%0Aping' => null, 'https://example.com%00' => null] as $header => $home) {
    foreach ($both as $who => $f) {
        same(call_user_func($f['home'], (string) $header), $home, "home, $who: refused, " . json_encode((string) $header));
    }
}

foreach ($vectors['timestamps'] as $v) {
    foreach ($both as $who => $f) {
        same(call_user_func($f['time'], $v['timestamp'], $v['now']), $v['ok'], "timestamp, $who: {$v['timestamp']} at {$v['now']}");
    }
}

foreach ($vectors['badAuth'] as $v) {
    foreach ($both as $who => $f) {
        same(call_user_func($f['parse'], $v['values'], []), null, "auth, $who: refused in headers, {$v['what']}");
        same(call_user_func($f['parse'], [], $v['values']), null, "auth, $who: refused in the query, {$v['what']}");
    }
}

$good = ['site' => '7', 'home' => 'https%3A%2F%2Fexample.com', 'ts' => '1759843200', 'nonce' => str_repeat('0f', 16),
    'sig' => $vectors['signature'][0]['signature']];
foreach ($both as $who => $f) {
    $parse = $f['parse'];
    same(call_user_func($parse, ['site' => '13'] + $good, ['site' => '99'] + $good)['site'], '13', "auth, $who: a header wins over its query parameter");
    same(call_user_func($parse, ['site' => ''] + $good, ['site' => '99'] + $good)['site'], '99', "auth, $who: an empty header gives way to the query");
    same(call_user_func($parse, ['site' => '7', 'home' => $good['home']], ['ts' => $good['ts'], 'nonce' => $good['nonce'], 'sig' => $good['sig']])['nonce'],
        $good['nonce'], "auth, $who: each value from wherever it came");
    same(call_user_func($parse, ['home' => '  ' . $good['home'] . ' '] + $good, [])['home'], 'https://example.com', "auth, $who: values are trimmed");
}

// base64url, strictly: one spelling for one value.
$key = $vectors['keyPair']['publicKey'];
foreach ($both as $who => $f) {
    $decode = $f['decode'];
    same(call_user_func($decode, $key, 32), $publicKey, "base64url, $who: the key");
    same(call_user_func($decode, substr($key, 0, -1) . 'h', 32), null, "base64url, $who: stray bits in the last character");
    same(call_user_func($decode, $key . 'A', 32), null, "base64url, $who: one character too many");
    same(call_user_func($decode, substr($key, 1), 32), null, "base64url, $who: one character short");
    same(call_user_func($decode, substr($key, 0, -1) . '=', 32), null, "base64url, $who: padding");
    same(call_user_func($decode, strtr($key, '-_', '+/'), 32), $key === strtr($key, '-_', '+/') ? $publicKey : null,
        "base64url, $who: standard base64's characters");
    same(call_user_func($decode, null, 32), null, "base64url, $who: not a string");
    $sig = substr($vectors['signature'][0]['signature'], 8);
    same(call_user_func($decode, substr($sig, 0, -1) . 'B', 64), null, "base64url, $who: a signature with stray bits");
}

// -- The loader agrees with the plugin --------------------------------------------------------

$source = WPL7_Connect_Loader::source();
same(wpl7_connect_loader_actions(), WPL7_Connect_Server::ACTIONS, 'loader: the actions are the plugin\'s');
same(strpos($source, " * Version: 0.0.0-dev\n") !== false, true, 'loader: it carries the plugin\'s version');
same(strpos($source, WPL7_Connect_Loader::MARK) !== false, true, 'loader: it carries its mark');
same(strpos($source, '{{'), false, 'loader: every placeholder is filled in');
$tail = "if (!defined('WPL7_CONNECT_LOADER_TEST')) {\n    wpl7_connect_loader_main();\n}";
same(substr(rtrim($source), -strlen($tail)), $tail, 'loader: it runs its check last, and only outside these tests');
foreach ([
    'skip what was asked' => [['akismet/akismet.php', 'hello.php', 'wpl7-connect/wpl7-connect.php'], ['hello.php'], ['akismet/akismet.php', 'wpl7-connect/wpl7-connect.php']],
    'never WPL7 Connect itself' => [['a/a.php', 'wpl7-connect/wpl7-connect.php'], ['wpl7-connect/wpl7-connect.php', 'a/a.php'], ['wpl7-connect/wpl7-connect.php']],
    'never WPL7 Connect, whatever its folder' => [['wpl7-connect-2/wpl7-connect.php'], ['wpl7-connect-2/wpl7-connect.php'], ['wpl7-connect-2/wpl7-connect.php']],
    'a network list keeps its keys' => [['a/a.php' => 1, 'b/b.php' => 2], ['a/a.php'], ['b/b.php' => 2]],
    'not a list' => [false, ['a/a.php'], false],
] as $what => $case) {
    same(wpl7_connect_loader_without($case[0], $case[1]), $case[2], "loader: skip_plugins, $what");
}
same(wpl7_connect_loader_keep(['a/a.php'], ['a/a.php', 'b/b.php', 'c/c.php'], ['b/b.php']), ['a/a.php', 'b/b.php'],
    'loader: a list saved meanwhile keeps the skipped plugins that were active');
same(wpl7_connect_loader_keep(['b/b.php'], ['b/b.php'], ['b/b.php']), ['b/b.php'], 'loader: and does not repeat one');
same(wpl7_connect_loader_skip_list(['a/a.php', 5, '', null, 'b.php']), ['a/a.php', 'b.php'], 'loader: skip_plugins takes strings only');
same(wpl7_connect_loader_skip_list('a/a.php'), [], 'loader: skip_plugins is a list');

// -- Files ------------------------------------------------------------------------------------

same(WPL7_Connect_Manifest::DEFAULT_EXCLUDES, $vectors['excludes']['defaults'], 'excludes: the default list');
foreach ($vectors['excludes']['cases'] as $v) {
    same(WPL7_Connect_Manifest::exclude_match($v['path'], WPL7_Connect_Manifest::DEFAULT_EXCLUDES), $v['excluded'], "excludes: {$v['path']}");
}
same(WPL7_Connect_Manifest::patterns([]), WPL7_Connect_Manifest::DEFAULT_EXCLUDES, 'excludes: the plugin\'s own folder is not left out');
same(WPL7_Connect_Manifest::patterns(['*.bak', '.git/**']), array_merge(WPL7_Connect_Manifest::DEFAULT_EXCLUDES, ['*.bak']), 'excludes: the panel\'s patterns are added once');
same(WPL7_Connect_Manifest::flag_names(1 | 16 | 64), ['link', 'dangling', 'unchanged'], 'flag names');
same(WPL7_Connect_Manifest::relative('/srv/www/a/b', '/srv/www'), 'a/b', 'relative: inside');
same(WPL7_Connect_Manifest::relative('/srv/wwwx/a', '/srv/www'), null, 'relative: a sibling with the same start');

// -- SQL, the same as WPL7 Migrate's ----------------------------------------------------------

$escape = function ($s) {
    return strtr($s, ["\\" => "\\\\", "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "'" => "\\'", '"' => '\\"', "\x1a" => "\\Z"]);
};
foreach ($sqlVectors['literals'] as $i => $v) {
    $value = array_key_exists('hex', $v) ? hex2bin($v['hex']) : $v['value'];
    same(WPL7_Connect_Sql::literal($v['kind'], $value, $escape), $v['sql'], "literal #$i ({$v['kind']})");
    same(WPL7_Connect_Sql::literal($v['kind'], $value, ['WPL7_Connect_Sql', 'escape']), $v['sql'], "literal #$i ({$v['kind']}), own escaping");
}
$bytes = '';
$expected = '';
for ($b = 0; $b < 256; $b++) {
    $bytes .= chr($b);
    $special = [0 => '\0', 10 => '\n', 13 => '\r', 26 => '\Z', 34 => '\"', 39 => "\\'", 92 => '\\\\'];
    $expected .= isset($special[$b]) ? $special[$b] : chr($b);
}
same(WPL7_Connect_Sql::escape($bytes), $expected, 'own escaping: a backslash before exactly the seven bytes, every other byte as it is');
foreach ($sqlVectors['cursors'] as $i => $v) {
    if (isset($v['offset'])) {
        same(WPL7_Connect_Sql::offset_cursor($v['offset']), $v['cursor'], "cursor #$i: encode an offset");
        same(WPL7_Connect_Sql::decode_cursor($v['cursor']), ['mode' => 'o', 'offset' => $v['offset']], "cursor #$i: decode an offset");
        continue;
    }
    $values = array_map('hex2bin', $v['valuesHex']);
    same(WPL7_Connect_Sql::encode_cursor($values), $v['cursor'], "cursor #$i: encode");
    same(WPL7_Connect_Sql::decode_cursor($v['cursor']), ['mode' => 'k', 'values' => $values], "cursor #$i: decode");
}
same(WPL7_Connect_Sql::decode_cursor(''), ['mode' => 'start'], 'cursor: empty is the first page');
foreach ($sqlVectors['badCursors'] as $cursor) {
    same(WPL7_Connect_Sql::decode_cursor($cursor), null, "cursor refused: $cursor");
}
same(WPL7_Connect_Sql::keyset_where([['id', 'numeric']], ['41'], $escape), '(`id` > 41)', 'keyset: one column');
same(
    WPL7_Connect_Sql::keyset_where([['a', 'numeric'], ['b', 'string'], ['c', 'binary']], ['7', "it's", "\x00\xff"], $escape),
    "(`a` > 7) OR (`a` = 7 AND `b` > 'it\\'s') OR (`a` = 7 AND `b` = 'it\\'s' AND `c` > X'00ff')",
    'keyset: three columns'
);
same(WPL7_Connect_Sql::insert_head('wp_t', ['id', 'we`ird']), 'INSERT INTO `wp_t` (`id`,`we``ird`) VALUES ', 'INSERT head');
same(WPL7_Connect_Sql::select_expr('flags', 'bit(5)'), '(`flags` + 0)', 'BIT is read as a number');
foreach ([
    ['bigint(20) unsigned', 'numeric', false, true],
    ['double', 'numeric', false, false],
    ['varchar(191)', 'string', false, true],
    ['longtext', 'string', true, false],
    ["enum('a','b')", 'string', false, false],
    ['varbinary(255)', 'binary', false, true],
    ['bit(1)', 'numeric', false, false],
    ['point', 'binary', true, false],
] as $case) {
    same([WPL7_Connect_Sql::classify($case[0]), WPL7_Connect_Sql::is_big($case[0]), WPL7_Connect_Sql::keyable($case[0])],
        [$case[1], $case[2], $case[3]], "column type {$case[0]}");
}
$col = function ($type, $nullable = false, $generated = false) {
    return ['type' => $type, 'nullable' => $nullable, 'generated' => $generated];
};
$columns = ['id' => $col('bigint(20) unsigned'), 'slug' => $col('varchar(100)'), 'n' => $col('int(11)', true),
    'f' => $col('double'), 'g' => $col('int(11)', false, true), 'a' => $col('int(11)'), 'b' => $col('int(11)')];
foreach ([
    'the primary key' => [[['name' => 'slug_u', 'unique' => true, 'columns' => ['slug']], ['name' => 'PRIMARY', 'unique' => true, 'columns' => ['id']]], ['id']],
    'no unique key over a NULL column' => [[['name' => 'n_u', 'unique' => true, 'columns' => ['n']]], null],
    'not a float primary key' => [[['name' => 'PRIMARY', 'unique' => true, 'columns' => ['f']], ['name' => 'slug_u', 'unique' => true, 'columns' => ['slug']]], ['slug']],
    'not a generated column' => [[['name' => 'PRIMARY', 'unique' => true, 'columns' => ['g']]], null],
    'the unique key with the fewest columns' => [[['name' => 'ab', 'unique' => true, 'columns' => ['a', 'b']], ['name' => 'zz', 'unique' => true, 'columns' => ['b']]], ['b']],
] as $what => $case) {
    same(WPL7_Connect_Sql::choose_key($columns, $case[0]), $case[1], "key: $what");
}
foreach ($sqlVectors['createTable'] as $v) {
    $n = WPL7_Connect_Sql::normalize_create($v['raw']);
    same($n['sql'], $v['sql'], "CREATE TABLE, {$v['name']}: the line");
    same($n['warning'], $v['warning'], "CREATE TABLE, {$v['name']}: the warning");
}
foreach ($sqlVectors['utf8'] as $v) {
    $bytes = hex2bin($v['hex']);
    same(WPL7_Connect_Plugin::is_utf8($bytes), $v['valid'], "UTF-8 {$v['hex']}: valid");
    same(WPL7_Connect_Plugin::utf8_display($bytes), $v['display'], "UTF-8 {$v['hex']}: display");
}

// -- Limits -----------------------------------------------------------------------------------

$mib = 1048576;
foreach ([
    [30, 256 * $mib, ['max_ms' => 10000, 'max_bytes' => 8 * $mib, 'max_row_bytes' => 15 * $mib]],
    [0, -1, ['max_ms' => 10000, 'max_bytes' => 8 * $mib, 'max_row_bytes' => 15 * $mib]],
    [10, 64 * $mib, ['max_ms' => 5000, 'max_bytes' => 5592405, 'max_row_bytes' => 8 * $mib]],
    [30, 2 * $mib, ['max_ms' => 10000, 'max_bytes' => 262144, 'max_row_bytes' => $mib]],
] as $case) {
    same(WPL7_Connect_Server::limits_for($case[0], $case[1]), $case[2], "limits for max_execution_time {$case[0]}, memory_limit {$case[1]}");
}

// -- Registered commands ----------------------------------------------------------------------

foreach ($vectors['globalFlags'] as $v) {
    $got = WPL7_Connect_Commands::global_flags($v['args']);
    $what = 'global flags: ' . implode(' ', $v['args']);
    if (isset($v['error'])) {
        same($got, ['error' => $v['error']], $what);
    } else {
        same($got, $v['out'], $what);
    }
}
foreach ($vectors['commandNames']['valid'] as $name) {
    same(WPL7_Connect_Commands::valid_name($name), true, "command name: $name");
}
foreach ($vectors['commandNames']['invalid'] as $name) {
    same(WPL7_Connect_Commands::valid_name($name), false, 'command name refused: ' . json_encode($name));
}
same(WPL7_Connect_Commands::valid_name(5), false, 'command name refused: a number');
same(
    WPL7_Connect_Commands::overview(['godmode' => 'Drive WP Godmode.', 'hello' => 'Says hello', 'x' => '']),
    "usage: wp <command> [<args>...]\n\nCommands registered with WPL7 Connect:\n\n  godmode  Drive WP Godmode.\n  hello    Says hello\n  x\n",
    'help without words: a usage line and each command with its summary'
);
same(WPL7_Connect_Commands::overview([]), "usage: wp <command> [<args>...]\n\nNo commands are registered with WPL7 Connect.\n", 'help without words, none registered');

// -- Login links ------------------------------------------------------------------------------

same(WPL7_Connect_Login::TOKEN_RE, '/' . $vectors['loginTokens']['pattern'] . '/D', 'login: the token pattern is the vectors\'');
foreach ($vectors['loginTokens']['valid'] as $token) {
    same(WPL7_Connect_Login::token_parts($token), explode('.', $token), "login token: $token");
}
foreach ($vectors['loginTokens']['invalid'] as $token) {
    same(WPL7_Connect_Login::token_parts($token), null, "login token refused: $token");
}
same(WPL7_Connect_Login::token_parts(str_repeat('0', 24) . '.' . str_repeat('A', 43) . "\n"), null, 'login token refused: a line break after it');

// -- Inventory --------------------------------------------------------------------------------

same(WPL7_Connect_Inventory::plugin_rows($vectors['inventory']['plugins']['input']), $vectors['inventory']['plugins']['rows'], 'inventory: plugin rows');
same(WPL7_Connect_Inventory::theme_rows($vectors['inventory']['themes']['input']), $vectors['inventory']['themes']['rows'], 'inventory: theme rows');
foreach ($vectors['inventory']['core'] as $v) {
    same(WPL7_Connect_Inventory::core_update($v['version'], $v['offers']), $v['update'], "inventory: core {$v['version']} offered " . implode(', ', $v['offers']));
}
same(WPL7_Connect_Inventory::core_update('7.1', ['7.1.0']), null, 'inventory: core 7.1 and 7.1.0 are one version');
same(WPL7_Connect_Inventory::core_update('7.2-src', ['7.2.1']), ['version' => '7.2.1', 'type' => 'minor'], 'inventory: a checkout\'s -src');
same(
    WPL7_Connect_Inventory::plugin_names(['a/a.php', 'a.php', 'b/main.php', 'c.php', 'my.plugin/x.php']),
    ['a/a.php' => 'a/a', 'a.php' => 'a', 'b/main.php' => 'b', 'c.php' => 'c', 'my.plugin/x.php' => 'my.plugin'],
    'inventory: names, a shared one made unique'
);

// -- Self-update and catalog links ------------------------------------------------------------

$panel = 'https://panel.example.com';
foreach ([
    'https://panel.example.com/api/connect/package?v=1.2.4&e=1759850400&s=abc' => true,
    'https://panel.example.com/api/connect/package?' => false,
    'https://panel.example.com.example.net/api/connect/package?v=1' => false,
    'https://panel.example.com:8443/api/connect/package?v=1' => false,
    'http://panel.example.com/api/connect/package?v=1' => false,
    'https://panel.example.com/api/connect/packages?v=1' => false,
    'https://panel.example.com/api/connect/package?v=1 x' => false,
    "https://panel.example.com/api/connect/package?v=1\n" => false,
    'https://203.0.113.9/https://panel.example.com/api/connect/package?v=1' => false,
] as $url => $ok) {
    same(WPL7_Connect_Selfupdate::package_allowed((string) $url, $panel), $ok, 'self-update package: ' . json_encode((string) $url));
}
same(WPL7_Connect_Selfupdate::package_allowed('https://panel.example.com/api/connect/package?v=1', ''), false, 'self-update package: no panel, no offer');
same(WPL7_Connect_Plugin::panel_link('https://panel.example.com/sub/api/connect/catalog/7?site=1', '/api/connect/catalog/', 'https://panel.example.com/sub'), true,
    'catalog link: under the panel\'s path');
same(WPL7_Connect_Plugin::panel_link('https://panel.example.com/api/connect/catalog/7', '/api/connect/catalog/', 'https://panel.example.com/sub'), false,
    'catalog link: not beside it');

// -- The activity log -------------------------------------------------------------------------

$done = function ($ok, $from, $to) {
    return ['op' => 'aaaaaaaaaaaaaaaa', 'state' => 'done', 'result' => ['ok' => $ok, 'from' => $from, 'to' => $to, 'rollback' => true]];
};
foreach ([
    'a plugin update' => [['update', ['op' => 'aaaaaaaaaaaaaaaa', 'kind' => 'plugin', 'slug' => 'akismet'], $done(true, '5.7.2', '5.8'), true], 'Updated plugin akismet 5.7.2 → 5.8'],
    'a failed plugin update' => [['update', ['op' => 'aaaaaaaaaaaaaaaa', 'kind' => 'plugin', 'slug' => 'akismet'], $done(false, '5.7.2', '5.7.2'), false], 'Could not update plugin akismet'],
    'a core update that goes on' => [['update', ['op' => 'aaaaaaaaaaaaaaaa', 'kind' => 'core', 'version' => '7.1.3'], ['op' => 'aaaaaaaaaaaaaaaa', 'state' => 'running'], true], 'Updating WordPress to 7.1.3'],
    'a core update done' => [['update', ['kind' => 'core', 'version' => '7.1.3'], $done(true, '7.1.2', '7.1.3'), true], 'Updated WordPress 7.1.2 → 7.1.3'],
    'a REST request, without its query or body' => [['rest', ['method' => 'GET', 'route' => '/wp/v2/posts', 'query' => 'search=secret', 'body' => ['a' => 'secret']], ['status' => 200], true], 'REST GET /wp/v2/posts'],
    'a command, without its values or stdin' => [['run', ['args' => ['godmode', 'chat', 'send', '--new', '--message=-'], 'stdin' => 'secret'], ['exit_code' => 0], true], 'Command: godmode chat send'],
    'a command\'s free text stays out' => [['run', ['args' => ['hello', 'My Secret Words']], ['exit_code' => 0], true], 'Command: hello'],
    'help' => [['help', ['words' => ['godmode', 'chat']], ['text' => ''], true], 'Help: godmode chat'],
    'a backup' => [['snapshot', ['op' => 'start'], [], true], 'Backup started'],
    'a component' => [['component', ['kind' => 'plugin', 'slug' => 'hello', 'action' => 'deactivate'], ['ok' => true], true], 'Deactivated plugin hello'],
    'a refused component' => [['component', ['kind' => 'plugin', 'slug' => 'wpl7-connect', 'action' => 'delete'], ['ok' => false], false], 'Could not delete plugin wpl7-connect'],
    'a rollback' => [['rollback', ['op' => 'a', 'items' => [['kind' => 'plugin', 'slug' => 'akismet'], ['kind' => 'theme', 'slug' => 'x']]], [], true], 'Rolled back plugin akismet, theme x'],
    'a login link' => [['login', [], ['url' => 'https://example.com/?wpl7-connect-login=x', 'user' => 'admin'], true], 'Login link for admin'],
    'a name with a line break' => [['component', ['kind' => 'plugin', 'slug' => "a\nb", 'action' => 'activate'], ['ok' => true], true], 'Activated plugin a b'],
] as $what => $case) {
    same(call_user_func_array(['WPL7_Connect_Server', 'summary'], $case[0]), $case[1], "log: $what");
}
foreach (['ping', 'op', 'files', 'range', 'bundle', 'tables', 'sql'] as $action) {
    same(WPL7_Connect_Server::summary($action, [], [], true), null, "log: no row for $action");
}
same(WPL7_Connect_Server::summary('snapshot', ['op' => 'continue'], [], true), null, 'log: no row for snapshot continue');
$long = WPL7_Connect_Server::summary('rollback', ['op' => 'a', 'items' => array_fill(0, 40, ['kind' => 'plugin', 'slug' => str_repeat('é', 60)])], [], true);
same(is_string($long) && preg_match('//u', $long) === 1 && preg_match_all('/./su', $long) <= 255, true, 'log: at most 255 characters, cut on a character');
same(count(array_diff(WPL7_Connect_Server::ACTIONS, WPL7_Connect_Server::UNLOGGED, ['snapshot'])), 12, 'log: every other action writes a row');

// -- Small helpers ----------------------------------------------------------------------------

same(WPL7_Connect_Plugin::cut('abcdef', 3), 'abc', 'cut: characters');
same(WPL7_Connect_Plugin::cut('ééé', 2), 'éé', 'cut: on a character');
same(WPL7_Connect_Plugin::cut_bytes('aé', 2), 'a', 'cut by bytes: never inside a character');
same(WPL7_Connect_Plugin::cut_bytes("a\xff", 10), "a\xEF\xBF\xBD", 'cut by bytes: valid UTF-8');
same(WPL7_Connect_Updates::inside('/srv/www/wp-content/wpl7-rollback/x', '/srv/www/wp-content/wpl7-rollback'), true, 'inside: below');
same(WPL7_Connect_Updates::inside('/srv/www/wp-content/wpl7-rollbackx', '/srv/www/wp-content/wpl7-rollback'), false, 'inside: a sibling with the same start');
same(WPL7_Connect_Updates::inside('/srv/www/wp-content/wpl7-rollback/../plugins', '/srv/www/wp-content/wpl7-rollback'), false, 'inside: not through ..');
same(WPL7_Connect_Info::server_label('5.5.5-10.4.32-MariaDB'), 'MariaDB 10.4.32', 'server label');
same(WPL7_Connect_Inventory::normal_version('7.1'), '7.1.0', 'versions: 7.1 is 7.1.0');

foreach ([
    'https://panel.example.com/' => 'https://panel.example.com',
    'https://Panel.Example.COM/sub/' => 'https://panel.example.com/sub',
    'ftp://panel.example.com' => null,
    'https://user:pass@panel.example.com' => null,
    'https://panel.example.com/?a=1' => null,
    'panel.example.com' => null,
] as $url => $want) {
    same(WPL7_Connect_Plugin::panel_url($url), $want, "panel address: $url");
}
foreach (['127.0.0.1' => true, '10.1.2.3' => true, '172.16.0.1' => true, '172.32.0.1' => false, '192.168.65.254' => true,
    '203.0.113.5' => false, '::1' => true, 'fd00::1' => true, 'fe80::1' => false, '::ffff:127.0.0.1' => true, '::ffff:8.8.8.8' => false] as $ip => $local) {
    same(WPL7_Connect_Plugin::local_ip((string) $ip), $local, "loopback or private: $ip");
}
$resolve = function ($host) {
    $names = ['host.docker.internal' => ['192.168.65.254'], 'mixed.example' => ['10.0.0.5', '203.0.113.7']];
    return isset($names[$host]) ? $names[$host] : [];
};
foreach ([
    'https://panel.example.com' => true,
    'http://panel.example.com' => false,
    'http://host.docker.internal:18080' => true,
    'http://mixed.example' => false,
    'http://localhost:3000' => true,
    'http://[::1]:8080' => true,
    'http://198.51.100.10' => false,
] as $url => $allowed) {
    same(WPL7_Connect_Plugin::panel_allowed($url, $resolve), $allowed, "the token may go to $url");
}
same(preg_match(WPL7_Connect_Plugin::CODE_RE, str_repeat('a', 43) . '.' . $vectors['keyPair']['publicKey']), 1, 'a connection code is the token and the key');
same(preg_match(WPL7_Connect_Plugin::CODE_RE, str_repeat('a', 43) . $vectors['keyPair']['publicKey']), 0, 'a connection code has its dot');

// -- The result -------------------------------------------------------------------------------

foreach ($failures as $failure) {
    echo "FAIL $failure\n";
}
printf("%d checks, %d failed (PHP %s, sodium %s)\n", $checks, count($failures), PHP_VERSION,
    extension_loaded('sodium') ? 'native' : 'sodium_compat');
exit($failures ? 1 : 0);
