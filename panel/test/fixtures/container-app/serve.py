# The container app of test/engine/containerApps.test.ts: a few lines that answer the way an app
# would, and say what they see of their container. Standard library only.
import http.server
import json
import os
import signal
import socket
import socketserver
import sys
import time
import urllib.request

PORT = int(os.environ.get('APP_PORT', '80'))
DATA = os.environ.get('APP_DATA', '/data')
SECRET = os.environ.get('APP_SECRET_FILE', '/mnt/secret/key.txt')


def status_line(name):
    for line in open('/proc/self/status'):
        if line.startswith(name + ':'):
            return line.split(':', 1)[1].strip()
    return None


def can_write(path):
    try:
        with open(path, 'w') as f:
            f.write('written')
        return True
    except OSError as e:
        return e.strerror


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        # One line per request, for the test to count what reached the container.
        sys.stdout.write('request %s %s %s\n' % (self.command, self.headers.get('Host'), self.path))
        sys.stdout.flush()

    def answer(self, status, body, ctype='application/json'):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            return self.answer(200, 'ok', 'text/plain')
        if path == '/fail':
            return self.answer(500, 'failing on purpose', 'text/plain')
        if path == '/whoami':
            alias = os.environ.get('APP_ALIAS', '')
            try:
                resolved = socket.gethostbyname(alias) if alias else None
            except OSError as e:
                resolved = 'error: %s' % e
            port_start = open('/proc/sys/net/ipv4/ip_unprivileged_port_start').read().strip()
            return self.answer(200, json.dumps({
                'uid': os.getuid(), 'gid': os.getgid(),
                'capEff': status_line('CapEff'), 'noNewPrivs': status_line('NoNewPrivs'),
                'unprivilegedPortStart': port_start, 'alias': resolved,
            }))
        if path == '/secret':
            try:
                return self.answer(200, open(SECRET).read(), 'text/plain')
            except OSError as e:
                return self.answer(403, e.strerror, 'text/plain')
        if path == '/write':
            return self.answer(200, json.dumps({
                'data': can_write(os.path.join(DATA, 'note.txt')),
                'tmp': can_write('/tmp/note.txt'),
                'root': can_write('/note.txt'),
            }))
        if path == '/self':
            # The app calling itself by a public name, as a key generator calls back during a sale.
            url = 'http://%s:%d/health' % (os.environ['APP_ALIAS'], PORT)
            try:
                return self.answer(200, urllib.request.urlopen(url, timeout=5).read())
            except OSError as e:
                return self.answer(502, str(e), 'text/plain')
        if path == '/env':
            return self.answer(200, json.dumps({k: v for k, v in os.environ.items() if k.startswith('APP_')}))
        return self.answer(200, json.dumps({
            'app': os.environ.get('APP_NAME', ''), 'host': self.headers.get('Host'), 'path': self.path,
            'proto': self.headers.get('X-Forwarded-Proto'),
        }))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def stop(signum, frame):
    # A worker that finishes what it holds before it goes: it needs the time its stop gives it.
    time.sleep(float(os.environ.get('APP_DRAIN_SECONDS', '0')))
    try:
        with open(os.path.join(DATA, 'drained'), 'w') as f:
            f.write(str(signum))
    except OSError:
        pass
    os._exit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
sys.stdout.write('listening on %d as %d\n' % (PORT, os.getuid()))
sys.stdout.flush()
Server(('', PORT), Handler).serve_forever()
