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

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) !== '/') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found.\n";
    return true;
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
