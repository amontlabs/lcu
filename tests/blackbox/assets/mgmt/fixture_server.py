#!/usr/bin/env python3
"""A GitHub-shaped HTTPS fixture served through an HTTP CONNECT proxy, for the `lcu update` scenarios.

    fixture_server.py PORT DIR TLSDIR

LCU talks to hard-coded https://github.com URLs and has no override, so the harness points the client at this
process with `https_proxy=http://127.0.0.1:PORT` and trusts TLSDIR/ca.pem (`SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`).
The tunnel is terminated here with TLSDIR/server.pem for the GitHub host names: a throwaway CA and key the harness
generates per sandbox with /usr/bin/openssl (fixtures_mgmt.tls_dir); nothing is checked in.
Behaviour comes from DIR/routes.json, re-read for every request, so a scenario can change the world between
commands:

    [{"host": "github.com", "path": "/amontlabs/lcu/releases/latest", "method": "HEAD",
      "status": 302, "headers": {"Location": "..."}, "body": "text", "file": "relative/under/DIR/www",
      "delay": 0.0, "abort": false}, ...]

The first matching rule wins (`host`, `path` and `method` are fnmatch patterns; all optional). With no rule a
file under DIR/www/<host>/<path> is served, else 404. Every request is appended to DIR/requests.log as
`METHOD host path` (plus the User-Agent) so the scenario can show what LCU asked for. Plain (non-CONNECT) proxy
requests are answered 502: LCU only uses https.
"""
import fnmatch
import json
import os
from pathlib import Path
import socketserver
import ssl
import sys
import time

PORT = int(sys.argv[1])
ROOT = Path(sys.argv[2])
TLS = Path(sys.argv[3])
CONTEXT = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
CONTEXT.load_cert_chain(TLS / 'server.pem', TLS / 'server.key')
REASONS = {200: 'OK', 301: 'Moved Permanently', 302: 'Found', 403: 'Forbidden', 404: 'Not Found',
           500: 'Internal Server Error', 503: 'Service Unavailable'}


def rules():
    try:
        return json.loads((ROOT / 'routes.json').read_text())
    except (OSError, ValueError):
        return []


def record(line):
    with open(ROOT / 'requests.log', 'a') as log:
        log.write(line + '\n')


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline(65537).decode('latin-1').strip()
            if not line:
                return
            method, target, _ = line.split(' ', 2)
            self._headers()
            if method != 'CONNECT':
                self.wfile.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                return
            host = target.rsplit(':', 1)[0]
            self.wfile.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
            self.wfile.flush()
            tls = CONTEXT.wrap_socket(self.connection, server_side=True)
            self.rfile, self.wfile = tls.makefile('rb'), tls.makefile('wb')
            self._serve(host)
        except (OSError, ssl.SSLError, ValueError):
            pass

    def _headers(self):
        headers = {}
        while True:
            line = self.rfile.readline(65537).decode('latin-1')
            if line in ('\r\n', '\n', ''):
                return headers
            name, _, value = line.partition(':')
            headers[name.strip().lower()] = value.strip()

    def _serve(self, host):
        line = self.rfile.readline(65537).decode('latin-1').strip()
        if not line:
            return
        method, path, _ = line.split(' ', 2)
        headers = self._headers()
        record(f'{method} {host} {path}' + (f' ua={headers["user-agent"]}' if 'user-agent' in headers else ''))
        status, out_headers, body = 404, {}, b'not found\n'
        for rule in rules():
            if (fnmatch.fnmatchcase(host, rule.get('host', '*')) and fnmatch.fnmatchcase(path, rule.get('path', '*'))
                    and fnmatch.fnmatchcase(method, rule.get('method', '*'))):
                if rule.get('abort'):
                    return
                time.sleep(rule.get('delay', 0))
                status = rule.get('status', 200)
                out_headers = dict(rule.get('headers', {}))
                if 'file' in rule:
                    body = (ROOT / 'www' / rule['file']).read_bytes()
                else:
                    body = rule.get('body', '').encode()
                break
        else:
            candidate = ROOT / 'www' / host / path.lstrip('/').split('?')[0]
            if candidate.is_file():
                status, body = 200, candidate.read_bytes()
        head = f'HTTP/1.1 {status} {REASONS.get(status, "Status")}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n'
        head += ''.join(f'{k}: {v}\r\n' for k, v in out_headers.items()) + '\r\n'
        self.wfile.write(head.encode('latin-1'))
        if method != 'HEAD':
            self.wfile.write(body)
        self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), Handler) as server:
        (ROOT / 'ready').write_text(str(os.getpid()))
        server.serve_forever()
