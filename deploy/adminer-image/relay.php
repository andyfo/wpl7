<?php
// How the panel reaches Adminer: `docker exec … php relay.php` joins this stdin and stdout to
// the container's own server, which listens on nothing another container could reach. When the
// panel has sent its request, end of input closes our side of the connection; the server's
// closing its side ends the relay.
$server = @stream_socket_client('tcp://127.0.0.1:8080', $errno, $errstr, 10);
if ($server === false) {
    fwrite(STDERR, "relay: {$errstr}\n");
    exit(1);
}

function write_all($to, string $data): bool
{
    while ($data !== '') {
        $n = fwrite($to, $data);
        if ($n === false || $n === 0) {
            return false;
        }
        $data = substr($data, $n);
    }
    return true;
}

$inputOpen = true;
while (true) {
    $read = $inputOpen ? [$server, STDIN] : [$server];
    $write = null;
    $except = null;
    if (stream_select($read, $write, $except, null) === false) {
        exit(1);
    }
    foreach ($read as $stream) {
        $data = fread($stream, 65536);
        if ($stream === $server) {
            if ($data === '' || $data === false) {
                if (feof($server)) {
                    exit(0);
                }
                continue;
            }
            if (!write_all(STDOUT, $data)) {
                exit(1);
            }
        } else {
            if ($data === '' || $data === false) {
                if (feof(STDIN)) {
                    $inputOpen = false;
                    stream_socket_shutdown($server, STREAM_SHUT_WR);
                }
                continue;
            }
            if (!write_all($server, $data)) {
                exit(1);
            }
        }
    }
}
