<?php
// Every request to the container's server comes through here (`php -S … router.php`) and
// nothing else is served: the document root is an empty folder. Adminer is the one page; its
// own styles and scripts come from the same page with ?file=.

// Forwarded headers are not ours to believe: Adminer builds its URLs from X-Forwarded-Prefix.
foreach (array_keys($_SERVER) as $name) {
    if (strncmp($name, 'HTTP_X_FORWARDED_', 17) === 0 || $name === 'HTTP_FORWARDED') {
        unset($_SERVER[$name]);
    }
}

// A sign-in is the panel's alone: it carries the key the panel gave this container, and a
// request from a browser never does (the panel's front door drops X-Wpl7-* headers).
$key = (string) getenv('WPL7_LOGIN_KEY');
$given = $_SERVER['HTTP_X_WPL7_LOGIN_KEY'] ?? '';
unset($_SERVER['HTTP_X_WPL7_LOGIN_KEY']);
if (isset($_POST['auth']) && ($key === '' || !is_string($given) || !hash_equals($key, $given))) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Sign in to Adminer from the panel.\n";
    return true;
}

// A change the panel tags (X-Wpl7-Request: only the panel can send it) passes a gate before it
// runs, and the panel can ask the gate about it (/.wpl7/settle). Whichever comes first decides,
// by creating the tag's file: a change that finds the panel gave it up never runs, and the panel
// learns of one that started that it must wait for it. A request can wait in PHP - for a worker,
// its session, its connection - after the relay that brought it has gone.
const WPL7_GATE = '/tmp/wpl7-gate';

function wpl7_gate_file($tag)
{
    return WPL7_GATE . '/' . $tag;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path === '/.wpl7/settle') {
    $tag = (string) ($_GET['tag'] ?? '');
    header('Content-Type: application/json');
    if ($key === '' || !is_string($given) || !hash_equals($key, $given) || !preg_match('~^[A-Za-z0-9_-]{16,40}$~', $tag)) {
        http_response_code(403);
        echo "{}\n";
        return true;
    }
    @mkdir(WPL7_GATE, 0700);
    // Not started: given up here, it never will be.
    $file = @fopen(wpl7_gate_file($tag), 'x');
    if ($file !== false) {
        fwrite($file, 'canceled');
        fclose($file);
        $state = 'canceled';
    } else {
        $state = (string) @file_get_contents(wpl7_gate_file($tag));
    }
    // What is over is forgotten after a while; one still started is kept.
    foreach (glob(WPL7_GATE . '/*') ?: [] as $old) {
        if (filemtime($old) < time() - 7200 && @file_get_contents($old) !== 'started') {
            @unlink($old);
        }
    }
    echo json_encode(['state' => $state]), "\n";
    return true;
}

if ($path !== '/') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found.\n";
    return true;
}

$tag = (string) ($_SERVER['HTTP_X_WPL7_REQUEST'] ?? '');
if ($tag !== '') {
    @mkdir(WPL7_GATE, 0700);
    $file = preg_match('~^[A-Za-z0-9_-]{16,40}$~', $tag) ? @fopen(wpl7_gate_file($tag), 'x') : false;
    if ($file === false) {
        http_response_code(409);
        header('Content-Type: text/plain; charset=utf-8');
        echo "This change was given up. Open the database again from the panel.\n";
        return true;
    }
    fwrite($file, 'started');
    fclose($file);
    register_shutdown_function(function () use ($tag) {
        @file_put_contents(wpl7_gate_file($tag), 'done');
    });
}

// Adminer looks for its plugins beside itself; adminer_object() hands them over instead.
chdir(__DIR__);
function adminer_object()
{
    require __DIR__ . '/wpl7.php';
    return new \Adminer\Plugins([new \Wpl7Adminer()]);
}
require __DIR__ . '/adminer.php';
return true;
