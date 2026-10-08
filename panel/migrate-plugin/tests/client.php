<?php
// A signed client for the WPL7 Migrate protocol (docs/internal/import-protocol.md), for trying the
// plugin by hand or from a script. It is not part of the plugin. Run without arguments for help.
//
// `call` sends one signed request and prints what came back. `pull` copies a whole site the way the
// panel does, checks every hash the plugin sends, and writes what it got: manifest.json (each
// path, by its bytes in base64, with its type, size and sha256) and dump.sql (the tables, after the
// panel's preamble).

error_reporting(E_ALL);

const USAGE = <<<'TXT'
Usage: php client.php --url=<site> --id=<import id> --token=<code> [options] <command>

  call <action> [<json body>]   One signed request; prints status, protocol headers and body.
  pull --out=<dir>              Copies the site: snapshot, files, tables.

Options:
  --transport=rest|query        REST route or ?wpl7-migrate= (default rest)
  --endpoint=<url>              The REST base the report names (default <site>/?rest_route=/wpl7-migrate/v1/)
  --auth=headers|query          Where the four signing values go (default headers)
  --skew=<seconds>              Added to this machine's clock
call:
  --timestamp=<n> --nonce=<hex> --bad-signature --method=<GET|POST> --body-out=<file>
pull:
  --files=range|bundle          Small files whole through bundle, or every file through range (default bundle)
  --encoding=raw|base64|gzip    Range encoding (default raw)
  --chunk=<bytes>               Range length (default the plugin's max_bytes)
  --sql-encoding=json|gzip      (default json)
  --sql-max=<bytes>             max_bytes for sql pages (default the plugin's max_bytes)
  --tables=<a,b>                Only these tables (default every table with the site's prefix)
  --follow=none|inside          (default none)
  --page=<n>                    Entries per files page (default 1000)

TXT;

final class Wpl7MigrateClient
{
    public $url;
    public $id;
    public $token;
    public $transport = 'rest';
    public $endpoint;
    public $auth = 'headers';
    public $skew = 0;
    public $requests = 0;
    private $curl;

    public function __construct($url, $id, $token)
    {
        $this->url = rtrim($url, '/');
        $this->id = (string) $id;
        $this->token = $token;
        $this->endpoint = $this->url . '/?rest_route=/wpl7-migrate/v1/';
        $this->curl = curl_init();
    }

    /** One signed request. Returns status, lower-cased headers, the raw body and the body as JSON. */
    public function request($action, $body, $opts = [])
    {
        $timestamp = isset($opts['timestamp']) ? (int) $opts['timestamp'] : time() + $this->skew;
        $nonce = isset($opts['nonce']) ? $opts['nonce'] : bin2hex(random_bytes(16));
        $canonical = "WPL7-MIGRATE-V1\n" . $this->id . "\n" . $action . "\n" . $timestamp . "\n" . $nonce . "\n" . hash('sha256', $body);
        $signature = 'v1=' . (empty($opts['bad_signature']) ? hash_hmac('sha256', $canonical, $this->token) : str_repeat('0', 64));
        $url = $this->transport === 'rest'
            ? $this->endpoint . rawurlencode($action)
            : $this->url . '/?wpl7-migrate=' . rawurlencode($action);
        $headers = ['Content-Type: application/json; charset=utf-8', 'Accept-Encoding: identity', 'Expect:'];
        $signing = ['_id' => $this->id, '_ts' => (string) $timestamp, '_nonce' => $nonce, '_sig' => $signature];
        if ($this->auth === 'query') {
            $url .= (strpos($url, '?') === false ? '?' : '&') . http_build_query($signing);
        } else {
            $headers[] = 'X-WPL7-Import-Id: ' . $this->id;
            $headers[] = 'X-WPL7-Timestamp: ' . $timestamp;
            $headers[] = 'X-WPL7-Nonce: ' . $nonce;
            $headers[] = 'X-WPL7-Signature: ' . $signature;
        }
        $received = [];
        curl_reset($this->curl);
        curl_setopt_array($this->curl, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => isset($opts['method']) ? $opts['method'] : 'POST',
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$received) {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $received[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $raw = curl_exec($this->curl);
        $this->requests++;
        if ($raw === false) {
            throw new RuntimeException("$action: " . curl_error($this->curl));
        }
        $status = (int) curl_getinfo($this->curl, CURLINFO_HTTP_CODE);
        $json = null;
        if (isset($received['content-type']) && strpos($received['content-type'], 'application/json') === 0) {
            $json = json_decode($raw, true);
        }
        return ['status' => $status, 'headers' => $received, 'body' => $raw, 'json' => $json];
    }

    /** A request that must succeed: 200, the protocol header, and JSON unless $raw. */
    public function ok($action, $params, $raw = false)
    {
        $response = $this->request($action, $params === [] ? '{}' : json_encode($params, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        if (!isset($response['headers']['x-wpl7-protocol']) || $response['headers']['x-wpl7-protocol'] !== '1') {
            throw new RuntimeException("$action: no X-WPL7-Protocol: 1 (HTTP {$response['status']}): " . substr($response['body'], 0, 300));
        }
        if ($response['status'] !== 200) {
            throw new RuntimeException("$action: HTTP {$response['status']}: " . substr($response['body'], 0, 500));
        }
        if (!$raw && !is_array($response['json'])) {
            throw new RuntimeException("$action: not JSON: " . substr($response['body'], 0, 300));
        }
        return $raw ? $response : $response['json'];
    }
}

/** Copies the site as the panel would, checking every hash on the way. */
function pull(Wpl7MigrateClient $client, $out, $o)
{
    $started = microtime(true);
    $stats = ['requests' => 0, 'files' => 0, 'bytes' => 0, 'dirs' => 0, 'links' => 0, 'not_copied' => [], 'bundled' => 0,
        'ranges' => 0, 'tables' => 0, 'rows' => 0, 'skipped_rows' => [], 'warnings' => []];
    $ping = $client->ok('ping', []);
    $client->skew = $ping['time'] - time();
    $max = $ping['limits']['max_bytes'];

    $snap = $client->ok('snapshot', ['op' => 'start', 'follow' => $o['follow']]);
    while (!$snap['done']) {
        $snap = $client->ok('snapshot', ['op' => 'continue', 'snapshot_id' => $snap['snapshot_id']]);
    }
    $stats['snapshot'] = $snap;
    $status = $client->ok('snapshot', ['op' => 'status']);
    if ($status['snapshot_id'] !== $snap['snapshot_id'] || !$status['done']) {
        throw new RuntimeException('snapshot status does not match');
    }

    $entries = [];
    $after = 0;
    do {
        $page = $client->ok('files', ['snapshot_id' => $snap['snapshot_id'], 'after' => $after, 'limit' => $o['page']]);
        foreach ($page['entries'] as $e) {
            if ($e['id'] <= $after) {
                throw new RuntimeException('files: ids out of order');
            }
            $after = $e['id'];
            $entries[] = $e;
        }
    } while ($page['next'] !== null && ($after = $page['next']) > 0);
    if (count($entries) !== $snap['entries']) {
        throw new RuntimeException('files: ' . count($entries) . " entries, the snapshot said {$snap['entries']}");
    }

    $manifest = [];
    $small = [];
    foreach ($entries as $e) {
        $path = isset($e['pb']) ? base64_decode($e['pb']) : $e['p'];
        $key = base64_encode($path);
        $flags = isset($e['f']) ? $e['f'] : [];
        if ($e['t'] === 'd') {
            $manifest[$key] = ['t' => 'd'];
            $stats['dirs']++;
            continue;
        }
        if ($e['t'] === 'l') {
            $manifest[$key] = ['t' => 'l', 'target' => base64_encode(isset($e['lb']) ? base64_decode($e['lb']) : (isset($e['l']) ? $e['l'] : ''))];
            $stats['links']++;
            continue;
        }
        if (in_array('unreadable', $flags, true) || in_array('too_large', $flags, true)) {
            $stats['not_copied'][] = $e['p'] . ' (' . implode(',', $flags) . ')';
            continue;
        }
        if ($o['files'] === 'bundle' && $e['s'] <= 1048576 && $e['s'] <= $max) {
            $small[] = $e;
            continue;
        }
        $manifest[$key] = ['t' => 'f', 's' => $e['s'], 'sha256' => fetch_ranges($client, $snap['snapshot_id'], $e, $o, $max, $stats)];
        $stats['files']++;
        $stats['bytes'] += $e['s'];
    }

    // Small files, several at a time.
    $byId = [];
    foreach ($small as $e) {
        $byId[$e['id']] = $e;
    }
    $ids = array_keys($byId);
    while ($ids) {
        $batch = array_slice($ids, 0, 500);
        $res = $client->ok('bundle', ['snapshot_id' => $snap['snapshot_id'], 'ids' => $batch, 'max_bytes' => $max,
            'encoding' => $o['encoding'] === 'gzip' ? 'gzip' : 'base64']);
        if (!$res['files']) {
            throw new RuntimeException('bundle: answered for no file');
        }
        foreach ($res['files'] as $f) {
            $e = $byId[$f['id']];
            $path = isset($e['pb']) ? base64_decode($e['pb']) : $e['p'];
            if (isset($f['error'])) {
                $stats['not_copied'][] = $e['p'] . ' (bundle: ' . $f['error'] . ')';
                continue;
            }
            $data = base64_decode($f['data']);
            if ($o['encoding'] === 'gzip') {
                $data = gzdecode($data);
            }
            if (strlen($data) !== $f['size'] || hash('sha256', $data) !== $f['sha256']) {
                throw new RuntimeException("bundle: {$e['p']} does not match its size or sha256");
            }
            if (empty($f['changed']) && isset($e['h']) && $e['h'] !== $f['sha256']) {
                throw new RuntimeException("bundle: {$e['p']} does not match the listing's sha256");
            }
            $manifest[base64_encode($path)] = ['t' => 'f', 's' => $f['size'], 'sha256' => $f['sha256']];
            $stats['files']++;
            $stats['bytes'] += $f['size'];
            $stats['bundled']++;
        }
        $done = count($res['files']);
        if ($res['next'] !== null && $batch[$done] !== $res['next']) {
            throw new RuntimeException('bundle: next is not the first id left out');
        }
        $ids = array_slice($ids, $done);
    }

    // The database.
    $tables = $client->ok('tables', []);
    $dump = "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET sql_mode='NO_AUTO_VALUE_ON_ZERO';\nSET time_zone='+00:00';\n";
    foreach ($tables['tables'] as $t) {
        if ($o['tables'] !== null ? !in_array($t['name'], $o['tables'], true) : strpos($t['name'], $tables['prefix']) !== 0) {
            continue;
        }
        $cursor = '';
        $first = true;
        do {
            $params = ['table' => $t['name'], 'cursor' => $cursor, 'encoding' => $o['sql_encoding']];
            if ($o['sql_max'] !== null) {
                $params['max_bytes'] = $o['sql_max'];
            }
            $page = $client->ok('sql', $params);
            $sql = $o['sql_encoding'] === 'gzip' ? gzdecode(base64_decode($page['gz'])) : $page['sql'];
            if (hash('sha256', $sql) !== $page['sha256']) {
                throw new RuntimeException("sql: {$t['name']} page does not match its sha256");
            }
            check_grammar($sql, $t['name'], $first);
            $dump .= $sql;
            $stats['rows'] += $page['rows'];
            foreach ($page['skipped'] as $s) {
                $stats['skipped_rows'][] = $t['name'] . ' ' . json_encode($s);
            }
            if (!empty($page['warnings'])) {
                $stats['warnings'][$t['name']] = $page['warnings'];
            }
            $cursor = $page['next'];
            $first = false;
        } while ($cursor !== null);
        $stats['tables']++;
    }

    if (!is_dir($out)) {
        mkdir($out, 0777, true);
    }
    ksort($manifest);
    file_put_contents($out . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    file_put_contents($out . '/dump.sql', $dump);
    $stats['requests'] = $client->requests;
    $stats['seconds'] = round(microtime(true) - $started, 1);
    return $stats;
}

/** One file through `range`, in chunks, every chunk's hash checked. Returns the file's sha256. */
function fetch_ranges(Wpl7MigrateClient $client, $snapshot, $e, $o, $max, &$stats)
{
    $chunk = $o['chunk'] !== null ? $o['chunk'] : $max;
    $hash = hash_init('sha256');
    $offset = 0;
    do {
        $params = ['snapshot_id' => $snapshot, 'id' => $e['id'], 'offset' => $offset, 'length' => $chunk, 'encoding' => $o['encoding']];
        $res = $client->ok('range', $params, $o['encoding'] === 'raw');
        if ($o['encoding'] === 'raw') {
            $data = $res['body'];
            $range_sha = $res['headers']['x-wpl7-range-sha256'];
            $size = (int) $res['headers']['x-wpl7-size'];
            $file_sha = isset($res['headers']['x-wpl7-sha256']) ? $res['headers']['x-wpl7-sha256'] : null;
        } else {
            $data = base64_decode($res['data']);
            if ($o['encoding'] === 'gzip') {
                $data = gzdecode($data);
            }
            $range_sha = $res['sha256'];
            $size = $res['size'];
            $file_sha = isset($res['file_sha256']) ? $res['file_sha256'] : null;
        }
        if (hash('sha256', $data) !== $range_sha) {
            throw new RuntimeException("range: {$e['p']} at $offset does not match its sha256");
        }
        if ($size !== $e['s']) {
            throw new RuntimeException("range: {$e['p']} changed size");
        }
        hash_update($hash, $data);
        $offset += strlen($data);
        $stats['ranges']++;
    } while ($offset < $e['s'] && strlen($data) > 0);
    $sha = hash_final($hash);
    if ($file_sha !== null && $file_sha !== $sha) {
        throw new RuntimeException("range: {$e['p']} does not match X-WPL7-Sha256");
    }
    if (isset($e['h']) && $e['h'] !== $sha) {
        throw new RuntimeException("range: {$e['p']} does not match the listing's sha256");
    }
    return $sha;
}

/** What the panel will check of every line (docs/internal/import-protocol.md, SQL the plugin writes), in short. */
function check_grammar($sql, $table, $first)
{
    $lines = explode("\n", $sql);
    if (array_pop($lines) !== '') {
        throw new RuntimeException("sql: $table: a page must end in a line break");
    }
    $q = '`' . $table . '`';
    foreach ($lines as $i => $line) {
        if (substr($line, -1) !== ';') {
            throw new RuntimeException("sql: $table: line $i does not end in ;");
        }
        if ($first && $i === 0) {
            $ok = $line === "DROP TABLE IF EXISTS $q;";
        } elseif ($first && $i === 1) {
            $ok = strpos($line, "CREATE TABLE $q (") === 0;
        } else {
            $ok = strpos($line, "INSERT INTO $q (") === 0;
        }
        if (!$ok) {
            throw new RuntimeException("sql: $table: line $i: " . substr($line, 0, 80));
        }
    }
}

function options($argv)
{
    $o = ['args' => []];
    foreach (array_slice($argv, 1) as $arg) {
        if (strncmp($arg, '--', 2) === 0) {
            $parts = explode('=', substr($arg, 2), 2);
            $o[$parts[0]] = isset($parts[1]) ? $parts[1] : true;
        } else {
            $o['args'][] = $arg;
        }
    }
    return $o;
}

function show($response)
{
    $headers = [];
    foreach ($response['headers'] as $name => $value) {
        if (strpos($name, 'x-wpl7-') === 0 || in_array($name, ['content-type', 'cache-control', 'retry-after', 'allow'], true)) {
            $headers[$name] = $value;
        }
    }
    $out = ['status' => $response['status'], 'headers' => $headers];
    if ($response['json'] !== null) {
        $out['json'] = $response['json'];
    } else {
        $out['length'] = strlen($response['body']);
        $out['sha256'] = hash('sha256', $response['body']);
    }
    return json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
}

function pull_options($o)
{
    return [
        'files' => isset($o['files']) ? $o['files'] : 'bundle',
        'encoding' => isset($o['encoding']) ? $o['encoding'] : 'raw',
        'chunk' => isset($o['chunk']) ? (int) $o['chunk'] : null,
        'sql_encoding' => isset($o['sql-encoding']) ? $o['sql-encoding'] : 'json',
        'sql_max' => isset($o['sql-max']) ? (int) $o['sql-max'] : null,
        'tables' => isset($o['tables']) ? explode(',', $o['tables']) : null,
        'follow' => isset($o['follow']) ? $o['follow'] : 'none',
        'page' => isset($o['page']) ? (int) $o['page'] : 1000,
    ];
}

function client_main($argv)
{
    $o = options($argv);
    if (!isset($o['url'], $o['id'], $o['token']) || !$o['args']) {
        fwrite(STDERR, USAGE);
        return 2;
    }
    $client = new Wpl7MigrateClient($o['url'], $o['id'], $o['token']);
    foreach (['transport', 'endpoint', 'auth'] as $name) {
        if (isset($o[$name])) {
            $client->$name = $o[$name];
        }
    }
    if (isset($o['skew'])) {
        $client->skew = (int) $o['skew'];
    }
    try {
        $command = $o['args'][0];
        if ($command === 'call' && isset($o['args'][1])) {
            $response = $client->request($o['args'][1], isset($o['args'][2]) ? $o['args'][2] : '{}', [
                'timestamp' => isset($o['timestamp']) ? $o['timestamp'] : null,
                'nonce' => isset($o['nonce']) ? $o['nonce'] : null,
                'bad_signature' => isset($o['bad-signature']),
                'method' => isset($o['method']) ? $o['method'] : 'POST',
            ]);
            if (isset($o['body-out'])) {
                file_put_contents($o['body-out'], $response['body']);
            }
            echo show($response);
            return 0;
        }
        if ($command === 'pull' && isset($o['out'])) {
            $stats = pull($client, $o['out'], pull_options($o));
            echo json_encode($stats, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            return 0;
        }
        fwrite(STDERR, USAGE);
        return 2;
    } catch (RuntimeException $e) {
        fwrite(STDERR, 'FAIL ' . $e->getMessage() . "\n");
        return 1;
    }
}

// Run as a command; included, it is a library (Wpl7MigrateClient, pull()).
if (isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    exit(client_main($argv));
}
