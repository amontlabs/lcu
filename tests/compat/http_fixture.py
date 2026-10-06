"""Raw-socket HTTP/HTTPS/proxy fixture that records the exact bytes of every request head."""
import hashlib
import socket
import socketserver
import ssl
import threading
import time

BODY = bytes((i * 7 + i // 256) % 256 for i in range(2_621_440))  # 2.5 MiB, deterministic
BODY_SHA = hashlib.sha256(BODY).hexdigest()
NOTES_SECURITY = b'# Notes\n\nSome text\n<!-- lcu-severity: security -->\nmore\n'
NOTES_INLINE = b'# Notes\nthe marker syntax `<!-- lcu-severity: breaking -->` inline\n'
NOTES_UNKNOWN = b'<!-- lcu-severity: cosmetic -->\n'
NOTES_LATE = b'x' * 262144 + b'\n<!-- lcu-severity: breaking -->\n'


def response(status, reason, headers=(), body=b'', length=True):
    head = f'HTTP/1.1 {status} {reason}\r\n'
    for k, v in headers:
        head += f'{k}: {v}\r\n'
    if length:
        head += f'Content-Length: {len(body)}\r\n'
    return head.encode('latin-1') + b'\r\n' + body


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        fixture = self.server.fixture
        sock = self.request
        sock.settimeout(10)
        try:
            if self.server.tls is not None:
                sock = self.server.tls.wrap_socket(sock, server_side=True)
        except (ssl.SSLError, OSError):
            return
        data = b''
        try:
            while b'\r\n\r\n' not in data and len(data) < 70000:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        except OSError:
            return
        if b'\r\n\r\n' not in data:
            return
        head = data.split(b'\r\n\r\n', 1)[0] + b'\r\n\r\n'
        line = head.split(b'\r\n', 1)[0].decode('latin-1')
        with fixture.lock:
            fixture.log.append((self.server.kind, head))
        try:
            fixture.respond(sock, line, self.server)
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Fixture:
    def __init__(self, certfile=None, keyfile=None):
        self.lock = threading.Lock()
        self.log = []
        self.servers = {}
        for kind in ('http', 'https'):
            server = Server(('127.0.0.1', 0), Handler)
            server.fixture, server.kind, server.tls = self, kind, None
            if kind == 'https':
                if certfile is None:
                    server.server_close()
                    continue
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(certfile, keyfile)
                server.tls = context
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.servers[kind] = server
        self.http_port = self.servers['http'].server_address[1]
        self.https_port = self.servers['https'].server_address[1] if 'https' in self.servers else None

    def close(self):
        for server in self.servers.values():
            server.shutdown()
            server.server_close()

    def take_log(self):
        with self.lock:
            out, self.log = self.log, []
        return out

    def respond(self, sock, line, server):
        method, target, _ = line.split(' ', 2)
        path = target.split('?')[0]
        port = server.server_address[1]
        base = f'http://127.0.0.1:{port}'
        if path.startswith('/chain/'):
            n = int(path.rsplit('/', 1)[1])
            if n >= 12:
                return sock.sendall(response(200, 'OK', body=b'end of chain'))
            return sock.sendall(response(302, 'Found', [('Location', f'/chain/{n + 1}')]))
        if path.startswith('/short-chain/'):
            n = int(path.rsplit('/', 1)[1])
            if n >= 3:
                return sock.sendall(response(200, 'OK', body=b'short chain end'))
            return sock.sendall(response(302, 'Found', [('Location', f'/short-chain/{n + 1}')]))
        simple = {
            '/latest/ok': response(302, 'Found', [('Location', 'https://github.com/amontlabs/lcu/releases/tag/v1.2.3')]),
            '/latest/rel': response(301, 'Moved Permanently', [('Location', '/amontlabs/lcu/releases/tag/v9.9.9')]),
            '/latest/303': response(303, 'See Other', [('Location', '/x/releases/tag/v3.0.0')]),
            '/latest/307': response(307, 'Temporary Redirect', [('Location', '/x/releases/tag/v3.0.7')]),
            '/latest/308': response(308, 'Permanent Redirect', [('Location', '/x/releases/tag/v3.0.8')]),
            '/latest/200': response(200, 'OK', body=b'ok'),
            '/latest/404': response(404, 'Not Found', body=b'nope'),
            '/latest/500': response(500, 'Internal Server Error', body=b'boom'),
            '/latest/304': response(304, 'Not Modified', length=False),
            '/latest/nolocation': response(302, 'Found'),
            '/latest/fileproto': response(302, 'Found', [('Location', 'file:///etc/passwd')]),
            '/latest/badtag': response(302, 'Found', [('Location', '/x/releases/tag/vbad')]),
            '/latest/query': response(302, 'Found', [('Location', '/x/releases/tag/v1.0.0?x=1')]),
            '/latest/dupe': response(302, 'Found', [('Location', '/x/releases/tag/v4.0.0'),
                                                     ('Location', '/x/releases/tag/v5.0.0')]),
            '/latest/uri-header': response(302, 'Found', [('URI', '/x/releases/tag/v6.0.0')]),
            '/notes/security': response(200, 'OK', body=NOTES_SECURITY),
            '/notes/inline': response(200, 'OK', body=NOTES_INLINE),
            '/notes/unknown': response(200, 'OK', body=NOTES_UNKNOWN),
            '/notes/late': response(200, 'OK', body=NOTES_LATE),
            '/notes/404': response(404, 'Not Found', body=b'x'),
            '/notes/redirect': response(302, 'Found', [('Location', '/notes/security')]),
            '/dl/data': response(200, 'OK', [('Content-Type', 'application/octet-stream')], BODY),
            '/dl/with%20space': response(200, 'OK', body=b'space ok'),
            '/dl/redirect': response(302, 'Found', [('Location', '/dl/data')]),
            '/dl/redirect-301': response(301, 'Moved Permanently', [('Location', '/dl/data')]),
            '/dl/redirect-307': response(307, 'Temporary Redirect', [('Location', '/dl/data')]),
            '/dl/redirect-308': response(308, 'Permanent Redirect', [('Location', '/dl/data')]),
            '/dl/redirect-abs': response(302, 'Found', [('Location', f'{base}/dl/data')]),
            '/dl/redirect-space': response(302, 'Found', [('Location', '/dl/with space')]),
            '/dl/redirect-fileproto': response(302, 'Found', [('Location', 'file:///etc/passwd')]),
            # Location values: urllib quotes everything outside string.punctuation (as ISO-8859-1) before joining
            '/dl/redirect-nonascii': response(302, 'Found', [('Location', '/dl/caf\u00e9')]),
            '/dl/redirect-ctrl': response(302, 'Found', [('Location', '/dl/a\x01b\x7fc')]),
            '/dl/redirect-tab': response(302, 'Found', [('Location', '/dl/da\tta')]),
            '/dl/redirect-punct': response(302, 'Found', [('Location', '/dl/a\\b^c`d{e}|f"g<h>i')]),
            '/dl/redirect-dots': response(302, 'Found', [('Location', '../dl/./x/../data')]),
            '/dl/redirect-fragment': response(302, 'Found', [('Location', '/dl/data#frag')]),
            '/dl/redirect-query-only': response(302, 'Found', [('Location', '?x=1')]),
            '/dl/redirect-params': response(302, 'Found', [('Location', '/dl/a;b=1?q=2')]),
            '/dl/redirect-protocol-relative': response(302, 'Found', [('Location', f'//127.0.0.1:{port}/dl/data')]),
            '/dl/redirect-authority-only': response(302, 'Found', [('Location', f'http://127.0.0.1:{port}')]),
            '/dl/redirect-leading-space': response(302, 'Found', [('Location', '   /dl/data')]),
            '/dl/redirect-bad-ipv6': response(302, 'Found', [('Location', 'http://[::1/x')]),
            '/dl/redirect-bracket-ipv4': response(302, 'Found', [('Location', 'http://[127.0.0.1]/x')]),
            '/dl/redirect-uppercase-scheme': response(302, 'Found', [('Location', f'HTTP://127.0.0.1:{port}/dl/data')]),
            '/latest/bad-ipv6': response(302, 'Found', [('Location', 'http://[::1/x')]),
            '/latest/ctrl': response(302, 'Found', [('Location', '/x/releases/tag/v1\x01.0')]),
            '/dl/redirect-nolocation': response(302, 'Found'),
            '/dl/loop': response(302, 'Found', [('Location', '/dl/loop')]),
            '/dl/404': response(404, 'Not Found', body=b'missing'),
            '/dl/empty-reason': b'HTTP/1.1 404 \r\nContent-Length: 0\r\n\r\n',
            '/dl/garbage': b'garbage not http\r\n\r\n',
            '/dl/bad-code': b'HTTP/1.1 abc OK\r\n\r\n',
            '/dl/cl-abc': b'HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\nhello',
            '/dl/no-length': b'HTTP/1.1 200 OK\r\n\r\nclose delimited body',
            '/dl/continue': b'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/truncated': b'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n' + b'x' * 400,
            '/dl/chunked': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + b''.join(
                f'{len(p):x}\r\n'.encode() + p + b'\r\n' for p in (BODY[:70000], BODY[70000:200000])) +
            b'0\r\nX-Trailer: 1\r\n\r\n',
            '/dl/truncated-chunked': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n20\r\n0123',
            '/dl/bad-chunk': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n',
            '/dl/many-headers': b'HTTP/1.1 200 OK\r\n' + b''.join(f'X-H{i}: v\r\n'.encode() for i in range(120)) + b'\r\nbody',
            '/dl/header-utf8': 'HTTP/1.1 200 OK\r\nX-Name: café\r\nContent-Length: 2\r\n\r\nok'.encode('utf-8'),
            '/dl/sha': response(200, 'OK', body=b'abc'),
            '/dl/sha.sha256': response(200, 'OK', body=(hashlib.sha256(b'abc').hexdigest() + '  x\n').encode()),
            '/dl/head-only': response(200, 'OK', body=b'zz'),
            # body framing: Python's int() grammar (signs, spaces, underscores, 0x) for lengths and chunk sizes
            '/dl/len-plus': b'HTTP/1.1 200 OK\r\nContent-Length: +3\r\n\r\nabcdef',
            '/dl/len-space': b'HTTP/1.1 200 OK\r\nContent-Length:  3 \r\n\r\nabcdef',
            '/dl/len-underscore': b'HTTP/1.1 200 OK\r\nContent-Length: 1_0\r\n\r\n0123456789ABCDEF',
            '/dl/len-comma': b'HTTP/1.1 200 OK\r\nContent-Length: 3, 3\r\n\r\nabcdef',
            '/dl/len-negative': b'HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\nabc',
            '/dl/len-superscript': b'HTTP/1.1 200 OK\r\nContent-Length: \xb2\r\n\r\nabc',
            '/dl/len-empty': b'HTTP/1.1 200 OK\r\nContent-Length:\r\n\r\nabc',
            '/dl/len-zero-prefix': b'HTTP/1.1 200 OK\r\nContent-Length: 0003\r\n\r\nabcdef',
            '/dl/len-chunked-ignored': b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-plus': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n+3\r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-0x': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0x3\r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-underscore': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1_0\r\n0123456789abcdef\r\n0\r\n\r\n',
            '/dl/chunk-spaces': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n 3 \r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-extension': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n0;x\r\n\r\n',
            '/dl/chunk-negative': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n-3\r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-garbage-crlf': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcXX3\r\ndef\r\n0\r\n\r\n',
            '/dl/chunk-missing-crlf': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc',
            '/dl/chunk-size-empty': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\r\nabc',
            '/dl/chunk-upper-case-te': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
            '/dl/chunk-no-trailer': b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n',
            # status lines
            '/dl/status-plus': b'HTTP/1.1 +200 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-no-reason': b'HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-http2': b'HTTP/2.0 200 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-http10': b'HTTP/1.0 200 OK\r\n\r\nclose body',
            '/dl/status-http09': b'HTTP/0.9 200 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-leading-space': b' HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-tabs': b'HTTP/1.1\t200\tOK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-underscore': b'HTTP/1.1 2_00 OK\r\nContent-Length: 2\r\n\r\nok',
            '/dl/status-too-low': b'HTTP/1.1 099 Low\r\n\r\n',
            '/dl/status-empty-line': b'\r\nHTTP/1.1 200 OK\r\n\r\n',
            '/dl/status-bare-version': b'HTTP/1.1\r\n\r\n',
            '/dl/status-reason-spaces': b'HTTP/1.1 404   Not   Found  \r\nContent-Length: 0\r\n\r\n',
            # header parsing (email.parser semantics) and the 100-line limit
            '/dl/headers-99': b'HTTP/1.1 200 OK\r\n' + b''.join(f'X-H{i}: v\r\n'.encode() for i in range(98)) + b'Content-Length: 2\r\n\r\nok',
            '/dl/headers-100': b'HTTP/1.1 200 OK\r\n' + b''.join(f'X-H{i}: v\r\n'.encode() for i in range(99)) + b'Content-Length: 2\r\n\r\nok',
            '/dl/headers-folded': b'HTTP/1.1 200 OK\r\n' + b''.join(f'X-H{i}: v\r\n folded\r\n'.encode() for i in range(60)) + b'Content-Length: 2\r\n\r\nok',
            '/dl/headers-continuation-first': b'HTTP/1.1 200 OK\r\n ignored continuation\r\nContent-Length: 2\r\n\r\nok',
            '/dl/headers-no-colon': b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nGarbage line\r\nX: y\r\n\r\nok',
            '/dl/headers-folded-length': b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n  \r\n\r\nok',
            '/dl/headers-lone-cr': b'HTTP/1.1 200 OK\r\nX-A: a\rbroken\r\nContent-Length: 2\r\n\r\nok',
            '/dl/headers-empty-name': b'HTTP/1.1 200 OK\r\n: no name\r\nContent-Length: 2\r\n\r\nok',
            '/dl/headers-space-name': b'HTTP/1.1 200 OK\r\nContent-Length : 2\r\n\r\nok',
            '/dl/headers-dup-length': b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncontent-length: 5\r\n\r\nokay!!',
            '/latest/trailing-space': response(302, 'Found', [('Location', 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2 ')]),
            '/latest/folded': b'HTTP/1.1 302 Found\r\nLocation: /x/releases/tag/v1\r\n .0.0\r\nContent-Length: 0\r\n\r\n',
            '/latest/leading-tab': b'HTTP/1.1 302 Found\r\nLocation:\t/x/releases/tag/v2.0.0\r\nContent-Length: 0\r\n\r\n',
            '/latest/no-colon-stops': b'HTTP/1.1 302 Found\r\nbroken line\r\nLocation: /x/releases/tag/v3.0.0\r\nContent-Length: 0\r\n\r\n',
            '/latest/name-space': b'HTTP/1.1 302 Found\r\nLocation : /x/releases/tag/v4.0.0\r\nContent-Length: 0\r\n\r\n',
            '/latest/duplicate-case': b'HTTP/1.1 302 Found\r\nlocation: /x/releases/tag/v5.0.0\r\nLOCATION: /x/releases/tag/v6.0.0\r\nContent-Length: 0\r\n\r\n',
            '/latest/value-colon': b'HTTP/1.1 302 Found\r\nLocation: /x/releases/tag/v7.0.0\r\nX-Other: a: b\r\nContent-Length: 0\r\n\r\n',
            # release notes markers
            '/notes/crlf': response(200, 'OK', body=b'# Notes\r\n<!-- lcu-severity: security -->\r\nmore\r\n'),
            '/notes/crlf-end-only': response(200, 'OK', body=b'<!-- lcu-severity: breaking -->\r'),
            '/notes/nel': response(200, 'OK', body='<!--\u0085lcu-severity: security -->\n'.encode()),
            '/notes/nbsp': response(200, 'OK', body='<!--\u00a0lcu-severity:\u00a0security\u00a0-->\n'.encode()),
            '/notes/ideographic': response(200, 'OK', body='<!--\u3000lcu-severity:\u3000breaking\u3000-->\n'.encode()),
            '/notes/fs': response(200, 'OK', body='<!--\x1clcu-severity: security -->\n'.encode()),
            '/notes/feff': response(200, 'OK', body='<!--\ufefflcu-severity: security -->\n'.encode()),
            '/notes/multiline-whitespace': response(200, 'OK', body=b'<!--\n\n lcu-severity:\n security\n -->\nend'),
            '/notes/line-separator': response(200, 'OK', body='<!-- lcu-severity: security -->\u2028'.encode()),
            '/notes/trailing-tab': response(200, 'OK', body=b'<!-- lcu-severity: security -->\t\t\nx'),
            '/notes/leading-space-marker': response(200, 'OK', body=b'x\n  \t<!--lcu-severity:security-->'),
            '/notes/unicode-word': response(200, 'OK', body='<!-- lcu-severity: sécurité -->\n'.encode()),
            '/notes/invalid-utf8': response(200, 'OK', body=b'\xff\xfe\n<!-- lcu-severity: security -->\n\xc3'),
            '/notes/inline-then-line': response(200, 'OK', body=b'see <!-- lcu-severity: breaking --> inline\n<!-- lcu-severity: security -->\n'),
        }
        if path in ('/dl/disconnect',):
            return None
        if path == '/dl/slow-head':
            time.sleep(1.5)
            return sock.sendall(response(200, 'OK', body=b'late'))
        if path == '/dl/slow-body':
            sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n' + b'a' * 100)
            time.sleep(1.5)
            return sock.sendall(b'b' * 100)
        if path == '/dl/slow-trickle':
            sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n')
            for _ in range(6):
                time.sleep(0.2)
                sock.sendall(b'z')
            return None
        if path in simple:
            return sock.sendall(simple[path])
        return sock.sendall(response(404, 'Not Found', body=b'unknown fixture path'))


class Proxy:
    """Plain-HTTP proxy: records CONNECT / absolute-form requests; tunnels CONNECT to the real target."""

    def __init__(self, fail_connect=False):
        self.lock = threading.Lock()
        self.log = []
        self.fail_connect = fail_connect
        outer = self

        class H(socketserver.BaseRequestHandler):
            def handle(self):
                sock = self.request
                sock.settimeout(10)
                data = b''
                try:
                    while b'\r\n\r\n' not in data:
                        chunk = sock.recv(4096)
                        if not chunk:
                            return
                        data += chunk
                except OSError:
                    return
                head, rest = data.split(b'\r\n\r\n', 1)
                head += b'\r\n\r\n'
                with outer.lock:
                    outer.log.append(head)
                line = head.split(b'\r\n', 1)[0].decode('latin-1')
                method, target, _ = line.split(' ', 2)
                if method == 'CONNECT':
                    if outer.fail_connect:
                        sock.sendall(response(403, 'Forbidden', body=b'denied'))
                        return
                    host, port = target.rsplit(':', 1)
                    try:
                        upstream = socket.create_connection((host, int(port)), timeout=10)
                    except OSError:
                        sock.sendall(response(502, 'Bad Gateway'))
                        return
                    sock.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
                    outer.pipe(sock, upstream)
                else:
                    sock.sendall(response(200, 'OK', [('X-Via', 'proxy')], b'proxied ' + target.encode()))

        server = Server(('127.0.0.1', 0), H)
        self.server = server
        self.port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()

    @staticmethod
    def pipe(a, b):
        def forward(src, dst):
            try:
                while True:
                    chunk = src.recv(65536)
                    if not chunk:
                        break
                    dst.sendall(chunk)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
        t = threading.Thread(target=forward, args=(b, a), daemon=True)
        t.start()
        forward(a, b)
        t.join(5)
        a.close()
        b.close()

    def take_log(self):
        with self.lock:
            out, self.log = self.log, []
        return out

    def close(self):
        self.server.shutdown()
        self.server.server_close()
