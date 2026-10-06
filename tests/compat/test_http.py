"""Differential test: lcu/compat/http.mjs against lcu/update.py and lcu/update_apply.py networking.

A raw-socket fixture records the exact request heads Python and Node send; every scenario runs through the real
Python functions and through the Node module and the results, error texts, request bytes, proxy logs and curl-fallback
argv are compared.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402
import http_fixture as FX  # noqa: E402
from lcu import update, update_apply  # noqa: E402

RUNNER = S.ROOT / 'tests/compat/run_http.mjs'
PROXY_VARS = ('http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'ftp_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
              'NO_PROXY', 'ALL_PROXY', 'REQUEST_METHOD', 'SSL_CERT_FILE', 'SSL_CERT_DIR')

FAKE_CURL = r'''#!/bin/sh
{
  echo "--- curl"
  for a in "$@"; do printf '%s\n' "$a"; done
} >> "$FAKE_CURL_LOG"
case "$FAKE_CURL_MODE" in
  fail) printf '%s' "$FAKE_CURL_ERR" >&2; exit "${FAKE_CURL_CODE:-22}" ;;
  file)
    out=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-o" ]; then out="$a"; fi
      prev="$a"
    done
    printf '%s' "$FAKE_CURL_BODY" > "$out"
    ;;
  *) printf '%s' "$FAKE_CURL_BODY" ;;
esac
'''


def have_openssl():
    return shutil.which('openssl') is not None


def make_cert(directory, name, sans, days=2, extra=()):
    key, cert = Path(directory, f'{name}.key'), Path(directory, f'{name}.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert),
                    '-days', str(days), '-subj', f'/CN={name}', '-addext', f'subjectAltName={sans}', *extra],
                   check=True, capture_output=True)
    return cert, key


def nt_functions():
    """CPython's urllib.request nt branch (getproxies_registry, proxy_bypass_registry, getproxies, proxy_bypass)."""
    import ast
    source = Path(urllib.request.__file__).read_text()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if (isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Attribute)
                and node.test.left.attr == 'name' and any(isinstance(c, ast.Constant) and c.value == 'nt'
                                                         for c in node.test.comparators)):
            functions = [n for n in node.body if isinstance(n, ast.FunctionDef)]
            if not any(f.name == 'getproxies_registry' for f in functions):
                continue
            namespace = dict(vars(urllib.request))
            exec(compile(ast.Module(body=functions, type_ignores=[]), 'urllib/request.py(nt)', 'exec'), namespace)
            return namespace
    raise AssertionError('nt branch not found')


@contextlib.contextmanager
def windows_registry(values):
    """Make urllib.request behave as on Windows with these Internet Settings values (a fake winreg module)."""
    import types
    fake = types.ModuleType('winreg')
    fake.HKEY_CURRENT_USER = object()

    class Key:
        def Close(self):
            pass

    fake.OpenKey = lambda hive, path: Key()

    def query(key, name):
        if name not in values:
            raise FileNotFoundError(2, 'The system cannot find the file specified')
        return values[name], 4 if isinstance(values[name], int) else 1
    fake.QueryValueEx = query
    namespace = nt_functions()
    with mock.patch.dict(sys.modules, {'winreg': fake}), \
            mock.patch.object(urllib.request, 'getproxies', namespace['getproxies']), \
            mock.patch.object(urllib.request, 'proxy_bypass', namespace['proxy_bypass']), \
            mock.patch.object(urllib.request, 'proxy_bypass_registry', namespace['proxy_bypass_registry'], create=True):
        yield


def py_run(scenario, env):
    """Execute one scenario through the Python implementation."""
    op = scenario['op']
    import urllib.request
    urllib.request._opener = None  # urlopen caches its opener (and the proxy environment) per process
    base = {'PATH': env['PATH']}
    full = {**base, **scenario.get('env', {})}
    system = scenario.get('system')
    try:
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, full, clear=True))
            stack.enter_context(mock.patch.object(update, 'LATEST_URL', scenario.get('url', update.LATEST_URL)))
            stack.enter_context(mock.patch.object(update, 'TIMEOUT', scenario.get('timeout', 5)))
            stack.enter_context(mock.patch.object(update_apply, 'TIMEOUT', scenario.get('timeout', 60)))
            stack.enter_context(mock.patch.object(update, 'NOTES_URL', scenario.get('notes', update.NOTES_URL)))
            if system and 'registry' in system:  # Windows: CPython's own nt functions over a fake registry
                stack.enter_context(windows_registry(system['registry']))
            elif sys.platform == 'darwin':  # urllib consults _scproxy; never the host's real settings
                stack.enter_context(mock.patch.object(urllib.request, '_get_proxies',
                                                      lambda: dict(system['proxies']) if system else {}))
                stack.enter_context(mock.patch.object(urllib.request, '_get_proxy_settings', lambda: {
                    'exclude_simple': bool(system and system.get('exclude_simple')),
                    'exceptions': list(system['exceptions']) if system and 'exceptions' in system else []}))
            if op == 'latest_tag':
                value = update.latest_tag()
            elif op == 'severity':
                value = update.severity_of(scenario.get('tag', 'v1.0.0'), '1.0.0')
            elif op == 'fetch_latest':
                value = update.fetch_latest()
            elif op == 'fetch_bytes':
                data = update_apply._fetch(scenario['url'])
                value = {'length': len(data), 'sha': hashlib.sha256(data).hexdigest()}
            elif op == 'fetch_file':
                dest = Path(scenario['dest'])
                digest = update_apply._fetch(scenario['url'], dest)
                size = dest.stat().st_size if dest.exists() else None
                value = {'digest': digest, 'size': size,
                         'filesha': hashlib.sha256(dest.read_bytes()).hexdigest() if size is not None else None}
            elif op == 'open':
                import urllib.request
                with update._open(urllib.request.Request(scenario['url'], headers={'User-Agent': 'lcu-update'})) as r:
                    value = r.status
            elif op == 'curl':
                data = update.curl(scenario['args'], timeout=scenario.get('curl_timeout', 5))
                value = {'length': len(data), 'sha': hashlib.sha256(data).hexdigest()}
            else:
                raise AssertionError(op)
        return {'ok': True, 'value': value}
    except BaseException as exc:  # noqa: BLE001
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc) or type(exc).__name__,
                'caught': isinstance(exc, (OSError, ValueError, subprocess.SubprocessError))}


class HttpDifferential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.fakebin = cls.base / 'bin'
        cls.fakebin.mkdir()
        curl = cls.fakebin / 'curl'
        curl.write_text(FAKE_CURL)
        curl.chmod(0o755)
        cls.emptybin = cls.base / 'empty'
        cls.emptybin.mkdir()
        cls.certs = None
        if have_openssl():
            try:
                cls.good = make_cert(cls.base, 'good', 'DNS:localhost,IP:127.0.0.1')
                cls.other = make_cert(cls.base, 'other', 'DNS:other.test')
                cls.certs = True
            except (subprocess.CalledProcessError, OSError):
                cls.certs = None
        if cls.certs:
            digest = subprocess.run(['openssl', 'x509', '-noout', '-subject_hash', '-in', str(cls.good[0])],
                                    capture_output=True, text=True, check=True).stdout.strip()
            for name, filename in (('certdir', f'{digest}.0'), ('baddir', 'deadbeef.0'), ('gapdir', f'{digest}.1')):
                Path(cls.base, name).mkdir()
                shutil.copy(cls.good[0], Path(cls.base, name, filename))
            cls.fixture = FX.Fixture(str(cls.good[0]), str(cls.good[1]))
            cls.other_fixture = FX.Fixture(str(cls.other[0]), str(cls.other[1]))
        else:
            cls.fixture = FX.Fixture()
            cls.other_fixture = None
        cls.proxy = FX.Proxy()
        cls.bad_proxy = FX.Proxy(fail_connect=True)
        cls.PATH = f'{cls.fakebin}:/usr/bin:/bin'
        cls.results = {}
        cls.run_all()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        if cls.other_fixture:
            cls.other_fixture.close()
        cls.proxy.close()
        cls.bad_proxy.close()
        cls.tmp.cleanup()

    # ------------------------------------------------------------ scenarios
    @classmethod
    def subst(cls, value, phase, ident):
        if isinstance(value, str):
            repl = {'{HTTP}': f'http://127.0.0.1:{cls.fixture.http_port}',
                    '{HTTPS}': f'https://127.0.0.1:{cls.fixture.https_port}' if cls.fixture.https_port else '',
                    '{HTTPSLOCAL}': f'https://localhost:{cls.fixture.https_port}' if cls.fixture.https_port else '',
                    '{OTHER}': f'https://127.0.0.1:{cls.other_fixture.https_port}' if cls.other_fixture else '',
                    '{PROXY}': f'127.0.0.1:{cls.proxy.port}', '{BADPROXY}': f'127.0.0.1:{cls.bad_proxy.port}',
                    '{CERT}': str(cls.good[0]) if cls.certs else '', '{OTHERCERT}': str(cls.other[0]) if cls.certs else '',
                    '{CERTDIR}': str(cls.base / 'certdir'), '{BADDIR}': str(cls.base / 'baddir'),
                    '{GAPDIR}': str(cls.base / 'gapdir'),
                    '{LOG}': str(cls.base / f'{ident}-{phase}.curl.log'),
                    '{DEST}': str(cls.base / f'{ident}-{phase}.bin'), '{EMPTYBIN}': str(cls.emptybin)}
            for key, val in repl.items():
                value = value.replace(key, val)
            return value
        if isinstance(value, dict):
            return {k: cls.subst(v, phase, ident) for k, v in value.items()}
        if isinstance(value, list):
            return [cls.subst(v, phase, ident) for v in value]
        return value

    @staticmethod
    def scenarios(certs):
        s = []

        def add(ident, op, **kw):
            s.append(dict(id=ident, op=op, **kw))

        for name in ('ok', 'rel', '303', '307', '308', '200', '404', '500', '304', 'nolocation', 'fileproto', 'badtag',
                     'query', 'dupe', 'uri-header'):
            add(f'latest-{name}', 'latest_tag', url='{HTTP}/latest/' + name)
        add('latest-refused', 'latest_tag', url='http://127.0.0.1:9/latest/ok')
        add('latest-dns', 'latest_tag', url='http://no-such-host.invalid/latest/ok')
        add('latest-unknown-scheme', 'latest_tag', url='gopher://example.test/x')
        add('latest-nohost', 'latest_tag', url='http:///x')
        add('latest-disconnect', 'latest_tag', url='{HTTP}/dl/disconnect')
        add('latest-slow', 'latest_tag', url='{HTTP}/dl/slow-head', timeout=0.4)
        add('fetch-latest-ok', 'fetch_latest', url='{HTTP}/latest/ok', notes='{HTTP}/notes/security?t=%s&v=%s')
        add('fetch-latest-badtag', 'fetch_latest', url='{HTTP}/latest/badtag', notes='{HTTP}/notes/security?t=%s&v=%s')
        for name in ('security', 'inline', 'unknown', 'late', '404', 'redirect'):
            add(f'severity-{name}', 'severity', notes='{HTTP}/notes/' + name + '?t=%s&v=%s')
        add('severity-refused', 'severity', notes='http://127.0.0.1:9/notes/x?t=%s&v=%s')
        for name in ('data', 'chunked', 'redirect', 'redirect-301', 'redirect-307', 'redirect-308', 'redirect-abs',
                     'redirect-space', 'redirect-fileproto', 'redirect-nolocation', 'loop', '404', 'empty-reason',
                     'garbage', 'bad-code', 'cl-abc', 'no-length', 'continue', 'truncated', 'truncated-chunked',
                     'bad-chunk', 'many-headers', 'header-utf8', 'disconnect', 'with%20space', 'sha', 'sha.sha256'):
            add(f'dl-{name}-bytes', 'fetch_bytes', url='{HTTP}/dl/' + name)
            add(f'dl-{name}-file', 'fetch_file', url='{HTTP}/dl/' + name, dest='{DEST}')
        add('dl-chain-long', 'fetch_bytes', url='{HTTP}/chain/0')
        add('dl-chain-short', 'fetch_file', url='{HTTP}/short-chain/0', dest='{DEST}')
        add('dl-slow-head', 'fetch_bytes', url='{HTTP}/dl/slow-head', timeout=0.4)
        add('dl-slow-body', 'fetch_file', url='{HTTP}/dl/slow-body', dest='{DEST}', timeout=0.4)
        add('dl-slow-trickle-ok', 'fetch_file', url='{HTTP}/dl/slow-trickle', dest='{DEST}', timeout=0.5)
        add('dl-dest-unwritable', 'fetch_file', url='{HTTP}/dl/data', dest='/nonexistent-dir/x.bin')
        # proxies
        add('proxy-http', 'latest_tag', url='{HTTP}/latest/ok', env={'http_proxy': 'http://{PROXY}'})
        add('proxy-http-upper', 'fetch_bytes', url='{HTTP}/dl/sha', env={'HTTP_PROXY': 'http://{PROXY}'})
        add('proxy-conflict', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'HTTP_PROXY': 'http://127.0.0.1:1', 'http_proxy': 'http://{PROXY}'})
        add('proxy-lower-empty-deletes', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'HTTP_PROXY': 'http://{PROXY}', 'http_proxy': ''})
        add('proxy-no-proxy-host', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'http_proxy': 'http://{PROXY}', 'no_proxy': '127.0.0.1'})
        add('proxy-no-proxy-port', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'http_proxy': 'http://{PROXY}', 'NO_PROXY': 'other.test, .local'})
        add('proxy-no-proxy-star', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'http_proxy': 'http://{PROXY}', 'no_proxy': '*'})
        add('proxy-no-proxy-suffix', 'fetch_bytes', url='http://127.0.0.1:{HTTPPORT}/dl/sha',
            env={'http_proxy': 'http://{PROXY}', 'no_proxy': '.0.0.1'})
        add('proxy-auth', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'http_proxy': 'http://us%40er:p%3Ass@{PROXY}'})
        add('proxy-bare-authority', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': '{PROXY}'})
        add('proxy-all-ignored', 'fetch_bytes', url='{HTTP}/dl/sha', env={'all_proxy': 'http://{PROXY}'})
        add('proxy-https-only-ignored-for-http', 'fetch_bytes', url='{HTTP}/dl/sha', env={'https_proxy': 'http://{PROXY}'})
        add('proxy-request-method', 'fetch_bytes', url='{HTTP}/dl/sha',
            env={'http_proxy': 'http://{PROXY}', 'REQUEST_METHOD': 'GET'})
        add('proxy-bad-url', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': 'http:/oops'})
        add('proxy-dead', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': 'http://127.0.0.1:9'})
        if certs:
            tls_env = {'SSL_CERT_FILE': '{CERT}'}
            for name in ('latest-ok', 'latest-404'):
                add(f'tls-{name}', 'latest_tag', url='{HTTPS}/latest/' + name.split('-', 1)[1], env=tls_env)
            add('tls-localhost-name', 'latest_tag', url='{HTTPSLOCAL}/latest/ok', env=tls_env)
            add('tls-bytes', 'fetch_bytes', url='{HTTPS}/dl/data', env=tls_env)
            add('tls-file', 'fetch_file', url='{HTTPS}/dl/chunked', dest='{DEST}', env=tls_env)
            add('tls-redirect-to-http', 'fetch_bytes', url='{HTTPS}/dl/redirect-abs', env=tls_env)
            add('tls-hostname-mismatch', 'open', url='{OTHER}/dl/sha', env={'SSL_CERT_FILE': '{OTHERCERT}'})
            add('tls-untrusted-self-signed', 'open', url='{HTTPS}/dl/sha', env={})
            add('tls-trusted-open', 'open', url='{HTTPS}/dl/sha', env=tls_env)
            add('tls-hostname-mismatch-fallback', 'fetch_bytes', url='{OTHER}/dl/sha', env={'SSL_CERT_FILE': '{OTHERCERT}'})
            add('tls-no-curl-self-signed', 'fetch_bytes', url='{HTTPS}/dl/sha', env={'PATH': '{EMPTYBIN}'})
            fake = {'FAKE_CURL_LOG': '{LOG}', 'FAKE_CURL_MODE': 'out'}
            # untrusted (self-signed) -> certificate failure -> curl fallback
            add('tls-fallback-latest', 'latest_tag', url='{HTTPS}/latest/ok',
                env={**fake, 'FAKE_CURL_BODY': 'https://github.com/amontlabs/lcu/releases/tag/v7.7.7\n'})
            add('tls-fallback-latest-bad', 'latest_tag', url='{HTTPS}/latest/ok',
                env={**fake, 'FAKE_CURL_BODY': 'nothing useful'})
            add('tls-fallback-severity', 'severity', notes='{HTTPS}/notes/security?t=%s&v=%s',
                env={**fake, 'FAKE_CURL_BODY': '<!-- lcu-severity: breaking -->\n'})
            add('tls-fallback-severity-fail', 'severity', notes='{HTTPS}/notes/security?t=%s&v=%s',
                env={**fake, 'FAKE_CURL_MODE': 'fail', 'FAKE_CURL_ERR': 'boom'})
            add('tls-fallback-bytes', 'fetch_bytes', url='{HTTPS}/dl/sha', env={**fake, 'FAKE_CURL_BODY': 'x' * 70000})
            add('tls-fallback-file', 'fetch_file', url='{HTTPS}/dl/sha', dest='{DEST}',
                env={**fake, 'FAKE_CURL_MODE': 'file', 'FAKE_CURL_BODY': 'downloaded by curl'})
            add('tls-fallback-fail-stderr', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**fake, 'FAKE_CURL_MODE': 'fail', 'FAKE_CURL_ERR': 'curl: (60) SSL certificate problem  \n'})
            add('tls-fallback-fail-silent', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**fake, 'FAKE_CURL_MODE': 'fail', 'FAKE_CURL_ERR': '', 'FAKE_CURL_CODE': '7'})
            add('tls-fallback-no-curl', 'latest_tag', url='{HTTPS}/latest/ok', env={'PATH': '{EMPTYBIN}'})
            add('tls-fallback-http-error-not-curl', 'latest_tag', url='{HTTPS}/latest/404', env={**fake, **tls_env})
            # tunnel through the proxy
            add('tls-proxy-tunnel', 'latest_tag', url='{HTTPS}/latest/ok', env={**tls_env, 'https_proxy': 'http://{PROXY}'})
            add('tls-proxy-auth', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**tls_env, 'HTTPS_PROXY': 'http://user:pw@{PROXY}'})
            add('tls-proxy-refused', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**tls_env, 'https_proxy': 'http://{BADPROXY}'})
            add('tls-proxy-bypass', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**tls_env, 'https_proxy': 'http://{PROXY}', 'no_proxy': 'localhost,127.0.0.1'})
        # F04: URL validation happens before anything is connected or sent
        add('proxy-bare-no-port-http', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': '127.0.0.1'})
        if certs:
            # a proxy without a port is contacted on the default port of the connection class (443 for https targets)
            add('tls-proxy-bare-no-port', 'fetch_bytes', url='{HTTPS}/dl/sha', env={'SSL_CERT_FILE': '{CERT}', 'https_proxy': '127.0.0.1'})
        add('url-crlf', 'fetch_bytes', url='{HTTP}/ok\r\nX-Injected: yes')
        add('url-crlf-open', 'open', url='{HTTP}/ok\r\nX-Injected: yes')
        add('url-space', 'fetch_bytes', url='{HTTP}/dl/a b')
        add('url-nonascii', 'fetch_bytes', url='{HTTP}/dl/caf\u00e9')
        add('url-nonascii-run', 'fetch_bytes', url='{HTTP}/dl/\u65e5\u672c\U0001f600x')
        add('url-del-char', 'fetch_bytes', url='{HTTP}/dl/a\x7fb')
        add('url-host-crlf', 'fetch_bytes', url='http://127.0.0.1%0d%0a:{HTTPPORT}/dl/sha')
        add('url-host-space', 'fetch_bytes', url='http://127.0.0.1%20:{HTTPPORT}/dl/sha')
        add('url-nonnumeric-port', 'fetch_bytes', url='http://127.0.0.1:abc/dl/sha')
        add('url-port-spaces', 'fetch_bytes', url='http://127.0.0.1:{HTTPPORT}%20/dl/sha')
        add('url-wrapped', 'fetch_bytes', url='<URL:{HTTP}/dl/sha>')
        add('url-whitespace', 'fetch_bytes', url='  \t{HTTP}/dl/sha\n ')
        add('url-fragment', 'fetch_bytes', url='{HTTP}/dl/sha#frag#more')
        add('url-fragment-latest', 'latest_tag', url='{HTTP}/latest/ok#frag')
        add('url-uppercase-scheme', 'fetch_bytes', url='HTTP://127.0.0.1:{HTTPPORT}/dl/sha')
        add('url-host-percent', 'fetch_bytes', url='http://127.0.0.%31:{HTTPPORT}/dl/sha')
        add('url-query-no-path', 'fetch_bytes', url='http://127.0.0.1:{HTTPPORT}?x=1')
        add('url-fragment-proxy', 'fetch_bytes', url='{HTTP}/dl/sha#frag', env={'http_proxy': 'http://{PROXY}'})
        add('url-crlf-proxy', 'fetch_bytes', url='{HTTP}/ok\r\nX: y', env={'http_proxy': 'http://{PROXY}'})
        add('url-proxy-control-char', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': 'http://127.0.0.1\r\n:1'})
        for name in ('nonascii', 'ctrl', 'tab', 'punct', 'dots', 'fragment', 'query-only', 'params', 'protocol-relative',
                     'authority-only', 'leading-space', 'bad-ipv6', 'bracket-ipv4', 'uppercase-scheme'):
            add(f'dl-redirect-{name}-bytes', 'fetch_bytes', url='{HTTP}/dl/redirect-' + name)
        add('latest-bad-ipv6', 'latest_tag', url='{HTTP}/latest/bad-ipv6')
        add('latest-ctrl', 'latest_tag', url='{HTTP}/latest/ctrl')
        if certs:
            # an https:// proxy URL for a plain-http target: TLS to the proxy, absolute-form request line (the fixture answers 404)
            add('proxy-https-scheme-for-http-tls', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': '{HTTPS}', 'SSL_CERT_FILE': '{CERT}'})
            add('proxy-https-scheme-untrusted', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': '{HTTPS}'})
            add('tls-redirect-to-http-file', 'fetch_file', url='{HTTPS}/dl/redirect-abs', dest='{DEST}', env=tls_env)
            add('tls-proxy-socks-scheme-tunnels', 'fetch_bytes', url='{HTTPS}/dl/sha',
                env={**tls_env, 'https_proxy': 'socks5://{PROXY}'})
            add('tls-ssl-cert-dir', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '{CERTDIR}'})
            add('tls-ssl-cert-dir-fetch', 'fetch_bytes', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '{CERTDIR}'})
            add('tls-ssl-cert-dir-list', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '{BADDIR}:{CERTDIR}'})
            add('tls-ssl-cert-dir-wrong-name', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '{BADDIR}'})
            add('tls-ssl-cert-dir-number-gap', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '{GAPDIR}'})
            add('tls-ssl-cert-dir-missing', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_DIR': '/nonexistent/certs'})
            add('tls-ssl-cert-file-and-dir', 'open', url='{HTTPS}/dl/sha',
                env={'SSL_CERT_FILE': '{OTHERCERT}', 'SSL_CERT_DIR': '{CERTDIR}'})
            add('tls-ssl-cert-file-other-only', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_FILE': '{OTHERCERT}'})
            add('tls-ssl-cert-file-missing', 'open', url='{HTTPS}/dl/sha', env={'SSL_CERT_FILE': '/nonexistent/ca.pem'})
            add('tls-ssl-cert-dir-mismatch', 'open', url='{OTHER}/dl/sha', env={'SSL_CERT_DIR': '{CERTDIR}'})
        if sys.platform == 'darwin':
            # F06: the system proxy configuration is used only while the proxy environment is empty
            system = {'proxies': {'http': 'http://{PROXY}', 'https': 'http://{PROXY}'}, 'exclude_simple': False,
                      'exceptions': ['*.local', '169.254/16']}
            add('sys-proxy-http', 'fetch_bytes', url='{HTTP}/dl/sha', system=system)
            add('sys-proxy-latest', 'latest_tag', url='{HTTP}/latest/ok', system=system)
            add('sys-proxy-env-wins', 'fetch_bytes', url='{HTTP}/dl/sha', system=system,
                env={'http_proxy': 'http://127.0.0.1:9'})
            add('sys-proxy-no-proxy-only-env', 'fetch_bytes', url='{HTTP}/dl/sha', system=system, env={'no_proxy': 'other.test'})
            add('sys-proxy-env-no-proxy-bypass', 'fetch_bytes', url='{HTTP}/dl/sha', system=system,
                env={'http_proxy': 'http://{PROXY}', 'no_proxy': '127.0.0.1'})
            for label, exceptions in {'ip': ['127.0.0.1'], 'cidr': ['127.0.0.0/8'], 'short-cidr': ['127/8'], 'bare-prefix': ['127'],
                                      'glob': ['127.0.0.*'], 'glob-port': ['127.0.0.1:*'], 'other': ['10.0.0.0/8'],
                                      'bad-mask': ['127.0.0.1/33', '127.0.0.1/99999999999999999999'], 'empty': ['', '*.test']}.items():
                add(f'sys-proxy-bypass-{label}', 'fetch_bytes', url='{HTTP}/dl/sha',
                    system={**system, 'exceptions': exceptions})
            add('sys-proxy-exclude-simple', 'fetch_bytes', url='http://localhost:{HTTPPORT}/dl/sha',
                system={**system, 'exclude_simple': True})
            add('sys-proxy-exclude-simple-off', 'fetch_bytes', url='http://localhost:{HTTPPORT}/dl/sha', system=system)
            add('sys-proxy-https-not-configured', 'fetch_bytes', url='{HTTP}/dl/sha',
                system={'proxies': {'https': 'http://{PROXY}'}})
            if certs:
                add('sys-proxy-tunnel', 'latest_tag', url='{HTTPS}/latest/ok', env={'SSL_CERT_FILE': '{CERT}'}, system=system)
        # F09 / F10 / F26: http.client framing, status lines, header limits and email.parser values
        for name in ('len-plus', 'len-space', 'len-underscore', 'len-comma', 'len-negative', 'len-superscript', 'len-empty',
                     'len-zero-prefix', 'len-chunked-ignored', 'chunk-plus', 'chunk-0x', 'chunk-underscore', 'chunk-spaces',
                     'chunk-extension', 'chunk-negative', 'chunk-garbage-crlf', 'chunk-missing-crlf', 'chunk-size-empty',
                     'chunk-upper-case-te', 'chunk-no-trailer', 'status-plus', 'status-no-reason', 'status-http2',
                     'status-http10', 'status-http09', 'status-leading-space', 'status-tabs', 'status-underscore',
                     'status-too-low', 'status-empty-line', 'status-bare-version', 'status-reason-spaces', 'headers-99',
                     'headers-100', 'headers-folded', 'headers-continuation-first', 'headers-no-colon',
                     'headers-folded-length', 'headers-lone-cr', 'headers-empty-name', 'headers-space-name',
                     'headers-dup-length'):
            add(f'dl-{name}-bytes', 'fetch_bytes', url='{HTTP}/dl/' + name)
            add(f'dl-{name}-file', 'fetch_file', url='{HTTP}/dl/' + name, dest='{DEST}')
        for name in ('trailing-space', 'folded', 'leading-tab', 'no-colon-stops', 'name-space', 'duplicate-case', 'value-colon'):
            add(f'latest-{name}', 'latest_tag', url='{HTTP}/latest/' + name)
        add('fetch-latest-trailing-space', 'fetch_latest', url='{HTTP}/latest/trailing-space', notes='{HTTP}/notes/security?t=%s&v=%s')
        # F27: Python's re classes in the severity marker
        for name in ('crlf', 'crlf-end-only', 'nel', 'nbsp', 'ideographic', 'fs', 'feff', 'multiline-whitespace',
                     'line-separator', 'trailing-tab', 'leading-space-marker', 'unicode-word', 'invalid-utf8',
                     'inline-then-line'):
            add(f'severity-{name}', 'severity', notes='{HTTP}/notes/' + name + '?t=%s&v=%s')
        # the tag is data, never a replacement pattern ($&, $', $`, $$)
        for label, tag in {'amp': 'x$&y', 'quote': "x$'y", 'backtick': 'x$`y', 'dollars': 'x$$y', 'percent': '1%2'}.items():
            add(f'severity-tag-{label}', 'severity', notes='{HTTP}/notes/security?t=%s&v=%s', tag=tag)
        # F41 / F06: Windows registry proxies (CPython's own nt functions over a fake registry are the oracle)
        registry = {'ProxyEnable': 1, 'ProxyServer': '{PROXY}', 'ProxyOverride': '<local>;*.example.test'}
        for label, values in {
            'http': registry,
            'disabled': {**registry, 'ProxyEnable': 0},
            'no-server': {'ProxyEnable': 1},
            'no-enable': {'ProxyServer': '{PROXY}'},
            'per-protocol': {**registry, 'ProxyServer': 'http={PROXY};https=127.0.0.1:1'},
            'typed-address': {**registry, 'ProxyServer': 'http=http://{PROXY};https=http://127.0.0.1:1'},
            'bad-entry': {**registry, 'ProxyServer': 'http={PROXY};oops'},
            'socks': {**registry, 'ProxyServer': 'socks=127.0.0.1:1'},
            'socks-and-http': {**registry, 'ProxyServer': 'socks=127.0.0.1:1;http={PROXY}'},
            'override-glob': {**registry, 'ProxyOverride': '127.*'},
            'override-spaced': {**registry, 'ProxyOverride': ' 127.0.0.1 ; other'},
            'override-other': {**registry, 'ProxyOverride': 'example.test;<local>'},
            'override-empty': {**registry, 'ProxyOverride': ''},
            'override-missing': {key: value for key, value in registry.items() if key != 'ProxyOverride'},
            'enable-string': {**registry, 'ProxyEnable': '0'},
        }.items():
            add(f'win-proxy-{label}', 'fetch_bytes', url='{HTTP}/dl/sha', system={'registry': values})
        add('win-proxy-local-host', 'fetch_bytes', url='http://localhost:{HTTPPORT}/dl/sha', system={'registry': registry})
        add('win-proxy-env-wins', 'fetch_bytes', url='{HTTP}/dl/sha', system={'registry': registry},
            env={'http_proxy': 'http://127.0.0.1:9'})
        add('win-proxy-no-proxy-only-env', 'fetch_bytes', url='{HTTP}/dl/sha', system={'registry': registry}, env={'no_proxy': 'x'})
        add('proxy-password-with-slash', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': 'http://user:pa/ss@{PROXY}'})
        add('proxy-socks-scheme-for-http', 'fetch_bytes', url='{HTTP}/dl/sha', env={'http_proxy': 'socks5://{PROXY}'})
        add('curl-direct-redirect', 'curl', args=['-I', '-o', os.devnull, '-w', '%{redirect_url}', 'https://x.test/y'],
            env={'FAKE_CURL_LOG': '{LOG}', 'FAKE_CURL_MODE': 'out', 'FAKE_CURL_BODY': 'ok'})
        add('curl-direct-timeout-arg', 'curl', args=['-L', 'https://x.test/y'], curl_timeout=1800,
            env={'FAKE_CURL_LOG': '{LOG}', 'FAKE_CURL_MODE': 'out', 'FAKE_CURL_BODY': 'ok'})
        return s

    @classmethod
    def run_all(cls):
        cls.list = cls.scenarios(bool(cls.certs))
        node = subprocess.Popen([S.NODE, str(RUNNER), '--serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                text=True, env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
        cls.node_proc = node
        for scenario in cls.list:
            ident = scenario['id']
            cls.results[ident] = {}
            for phase in ('py', 'js'):
                concrete = cls.subst(scenario, phase, ident)
                for key in ('url', 'notes'):
                    if key in concrete:
                        concrete[key] = concrete[key].replace('{HTTPPORT}', str(cls.fixture.http_port))
                concrete_env = dict(concrete.get('env', {}))
                concrete_env.setdefault('PATH', cls.PATH)
                concrete['env'] = concrete_env
                for fixture in (cls.fixture, cls.other_fixture):
                    if fixture:
                        fixture.take_log()
                cls.proxy.take_log()
                cls.bad_proxy.take_log()
                if phase == 'py':
                    result = py_run(concrete, {'PATH': concrete_env['PATH']} | {})
                    # py_run passes scenario env itself; PATH comes from the scenario env
                else:
                    node.stdin.write(json.dumps(concrete) + '\n')
                    node.stdin.flush()
                    line = node.stdout.readline()
                    if not line:
                        raise AssertionError(f'{ident}: node runner exited')
                    result = json.loads(line)
                time.sleep(0.01)
                logs = [head for kind, head in cls.fixture.take_log()]
                if cls.other_fixture:
                    logs += [head for kind, head in cls.other_fixture.take_log()]
                cls.results[ident][phase] = {
                    'result': result, 'requests': logs, 'proxy': cls.proxy.take_log() + cls.bad_proxy.take_log(),
                    'curl': Path(concrete_env.get('FAKE_CURL_LOG', '/nonexistent')).read_text()
                    if Path(concrete_env.get('FAKE_CURL_LOG', '/nonexistent')).exists() else None,
                }
        node.stdin.close()
        node.wait(10)

    # ------------------------------------------------------------ comparison
    def normalize(self, text):
        text = re.sub(r'\(_ssl\.c:\d+\)', '(_ssl.c:N)', text)
        # deliberate rewording (docs/releases/UNRELEASED-node-runtime.md): Python's text names Python, LCU's names LCU
        text = text.replace('Python cannot verify HTTPS certificates', 'LCU cannot verify HTTPS certificates')
        for port in (self.fixture.http_port, self.fixture.https_port, self.proxy.port, self.bad_proxy.port,
                     self.other_fixture.https_port if self.other_fixture else None):
            if port:
                text = text.replace(f':{port}', ':PORT')
        return text.replace(str(self.base), '<B>').replace('-py.', '-X.').replace('-js.', '-X.')

    def norm_bytes(self, items):
        return [self.normalize(b.decode('latin-1')) for b in items]

    # Release downloads never follow a redirect from https to plain http (urllib does): scenario -> Node's error text.
    HARDENED = {'tls-redirect-to-http': r'^<urlopen error redirect from https to http refused: http://127\.0\.0\.1:\d+/dl/data>$',
                'tls-redirect-to-http-file': r'^<urlopen error redirect from https to http refused: http://127\.0\.0\.1:\d+/dl/data>$'}

    def assert_hardened(self, ident, js):
        result = js['result']
        self.assertFalse(result['ok'], f'{ident}: {result}')
        self.assertEqual(result['name'], 'URLError')
        self.assertRegex(result['message'], self.HARDENED[ident])
        sent = ' '.join(b.decode('latin-1') for b in js['requests'])
        self.assertIn('GET /dl/redirect-abs', sent)  # the https hop is requested, the plain one is not
        self.assertNotIn('GET /dl/data', sent, f'{ident}: the plain-http hop must not be requested')

    def test_scenarios_match(self):
        failures = []
        for scenario in self.list:
            ident = scenario['id']
            py, js = self.results[ident]['py'], self.results[ident]['js']
            if ident in self.HARDENED:  # documented security hardening: no Python parity is claimed
                self.assert_hardened(ident, js)
                continue
            problems = []
            a, b = py['result'], js['result']
            if a['ok'] != b['ok']:
                problems.append(f'outcome python={a} node={b}')
            elif a['ok']:
                va, vb = a['value'], b['value']
                if isinstance(va, dict):
                    va, vb = dict(va), dict(vb)
                if va != vb:
                    problems.append(f'value python={a["value"]} node={b["value"]}')
            else:
                if a['name'] != b['name']:
                    problems.append(f'error type python={a["name"]} node={b["name"]}')
                if self.normalize(a['message']) != self.normalize(b['message']):
                    problems.append(f'error text python={a["message"]!r} node={b["message"]!r}')
                if a['caught'] != b['caught']:
                    problems.append(f'caught-by-update python={a["caught"]} node={b["caught"]}')
            if self.norm_bytes(py['requests']) != self.norm_bytes(js['requests']):
                problems.append(f'requests\npython={self.norm_bytes(py["requests"])}\nnode={self.norm_bytes(js["requests"])}')
            if self.norm_bytes(py['proxy']) != self.norm_bytes(js['proxy']):
                problems.append(f'proxy\npython={self.norm_bytes(py["proxy"])}\nnode={self.norm_bytes(js["proxy"])}')
            ca, cb = py['curl'], js['curl']
            if cb:
                self.assertEqual(cb.count('--- curl\n-q\n'), cb.count('--- curl\n'), f'{ident}: -q must be the first argument')
                cb = cb.replace('--- curl\n-q\n', '--- curl\n')
            if (ca is None) != (cb is None) or (ca and self.normalize(ca) != self.normalize(cb)):
                problems.append(f'curl argv python={ca!r} node={cb!r}')
            if problems:
                failures.append(f'[{ident}] ' + '\n'.join(problems))
        self.assertFalse(failures, f'{len(failures)} of {len(self.list)} differ:\n' + '\n\n'.join(failures[:8]))

    def test_expected_error_forms_were_exercised(self):
        names = set()
        for ident, phases in self.results.items():
            r = phases['py']['result']
            if not r['ok']:
                names.add(r['name'])
        for required in ('HTTPError', 'URLError', 'ValueError', 'TimeoutError', 'RemoteDisconnected', 'BadStatusLine'):
            self.assertIn(required, names, sorted(names))
        if self.certs:
            texts = ' '.join(phases['py']['result'].get('message', '') for phases in self.results.values())
            self.assertIn('IP address mismatch', texts)
            self.assertIn('certificate verify failed: self-signed certificate', texts)

    def test_curl_fallback_decisions(self):
        """The curl fallback fires exactly for certificate failures."""
        if not self.certs:
            self.skipTest('openssl not available')
        for ident, phases in self.results.items():
            fired = {phase: bool(phases[phase]['curl']) for phase in ('py', 'js')}
            self.assertEqual(fired['py'], fired['js'], ident)
        self.assertTrue(self.results['tls-fallback-latest']['js']['curl'])
        self.assertFalse(self.results['tls-fallback-http-error-not-curl']['js']['curl'])

    def test_timeout_expired_text(self):
        script = (f'import {{TimeoutExpired}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'const e=new TimeoutExpired(["/usr/bin/curl","-fsS","a b"],10);'
                  'console.log(JSON.stringify([e.message,e.name]));')
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        message, name = json.loads(out.stdout)
        expected = subprocess.TimeoutExpired(['/usr/bin/curl', '-fsS', 'a b'], 10)
        self.assertEqual(message, str(expected))
        self.assertEqual(name, 'TimeoutExpired')

    def test_progress_output_on_a_tty(self):
        """`\\rDownloading N%` on stderr only for a TTY and a known length, one line break at the end."""
        import pty
        code = ('import sys; sys.path.insert(0, %r)\nfrom pathlib import Path\nfrom lcu import update_apply\n'
                'update_apply._fetch(sys.argv[1], Path(sys.argv[2]))\n' % str(S.ORACLE))
        url = f'http://127.0.0.1:{self.fixture.http_port}/dl/data'
        master, slave = pty.openpty()
        proc = subprocess.run([sys.executable, '-c', code, url, str(self.base / 'tty-py.bin')], stderr=slave,
                              env={'PATH': os.environ['PATH']}, timeout=30)
        import select
        python_out = b''
        while select.select([master], [], [], 0.2)[0]:
            python_out += os.read(master, 65536)
        os.close(slave)
        os.close(master)
        python_out = python_out.decode()
        self.assertEqual(proc.returncode, 0)
        node_code = (f'import {{fetchToFile}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                     'let out="";const err={isTTY:true,write:(s)=>{out+=s}};'
                     'await fetchToFile(process.argv[1], process.argv[2], {stderr: err, env: {}});'
                     'console.log(JSON.stringify(out));')
        out = subprocess.run([S.NODE, '--input-type=module', '-e', node_code, url, str(self.base / 'tty-js.bin')],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), python_out.replace('\r\n', '\n'))


# ---------------------------------------------------------------------------------------------------------------
# Pure-function differentials against urllib / http.client / fnmatch (F04, F05, F06) and security properties.
# ---------------------------------------------------------------------------------------------------------------
import fnmatch  # noqa: E402
import http.client  # noqa: E402
import urllib.parse  # noqa: E402

UNITS_RUNNER = S.ROOT / 'tests/compat/run_http_units.mjs'


def node_units(base, calls, env=None):
    spec = Path(base, f'units-{abs(hash(json.dumps(calls, sort_keys=True)))}.json')
    spec.write_text(json.dumps([{'id': str(i), 'fn': fn, 'args': args} for i, (fn, args) in enumerate(calls)]))
    result = S.run_node(UNITS_RUNNER, spec, env=env)
    if result.returncode:
        raise AssertionError(result.stderr)
    out = json.loads(result.stdout)
    return [out[str(i)] for i in range(len(calls))]


def py_outcome(fn):
    try:
        return {'ok': True, 'value': fn()}
    except BaseException as exc:  # noqa: BLE001
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}


class HttpUnits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def compare(self, calls, python, label):
        node = node_units(self.base, calls)
        failures = []
        for (fn, args), got in zip(calls, node):
            want = py_outcome(lambda a=args: python(*a))
            if want != got:
                failures.append(f'{fn}{tuple(args)!r}\n  python={want}\n  node  ={got}')
        self.assertFalse(failures, f'{label}: {len(failures)} of {len(calls)} differ\n' + '\n'.join(failures[:8]))

    # -- environment proxies / bypass
    ENVS = [{}, {'http_proxy': 'a'}, {'HTTP_PROXY': 'a'}, {'HTTP_PROXY': 'a', 'http_proxy': 'b'}, {'HTTP_PROXY': 'a', 'http_proxy': ''},
            {'http_proxy': '', 'https_proxy': 'x'}, {'REQUEST_METHOD': 'GET', 'http_proxy': 'a', 'HTTPS_PROXY': 'b'},
            {'NO_PROXY': 'x'}, {'no_proxy': ''}, {'all_proxy': 'a', 'ALL_PROXY': 'b'}, {'_proxy': 'x'}, {'Http_Proxy': 'a'},
            {'FTP_PROXY': 'f', 'ftp_proxy': ''}, {'xproxy': 'no', 'x_proxyz': 'no'}, {'a_b_proxy': 'ab'}]

    def test_getproxies_environment_matches_urllib(self):
        def python(env):
            with mock.patch.dict(os.environ, env, clear=True):
                return urllib.request.getproxies_environment()
        self.compare([('getEnvProxies', [env]) for env in self.ENVS], python, 'getproxies_environment')

    def test_proxy_bypass_environment_matches_urllib(self):
        envs = [{'no_proxy': v} for v in ('*', 'example.com', '.example.com', 'a.b, c.d', ' ,x, ', 'EXAMPLE.com', '127.0.0.1',
                                           'host:80', '..x', 'x.y.', '')] + [{'NO_PROXY': 'q', 'no_proxy': 'r'}, {}]
        hosts = ['example.com', 'www.example.com', 'EXAMPLE.COM:80', 'x.y', 'c.d', 'a.b:99', '127.0.0.1:8080', 'host:80', 'x', '']

        def python(host, env):
            with mock.patch.dict(os.environ, env, clear=True):
                return urllib.request.proxy_bypass_environment(host, urllib.request.getproxies_environment())
        self.compare([('proxyBypassEnvironment', [h, e]) for e in envs for h in hosts], python, 'proxy_bypass_environment')

    @unittest.skipUnless(sys.platform == 'darwin', 'urllib has no system proxy bypass off macOS')
    def test_macos_bypass_matches_urllib(self):
        hosts = ['localhost', 'localhost:80', 'example.com', 'a.local', 'a.local:8080', '127.0.0.1', '127.0.0.1:80', '127.1.2.3',
                 '169.254.1.1', '10.0.0.5', '192.168.1.1', '[::1]:80', 'EXAMPLE.COM', 'x.y.example.com', '1.2.3', '256.1.1.1',
                 '01.2.3.4', '10.0.5.1:99', '']
        exceptions = [['*.local', '169.254/16'], ['127.0.0.1'], ['127'], ['10.0.0.0/8'], ['10.0/16'], ['example.com'],
                      ['*.example.com'], ['*example*'], ['[ab]xample.com'], ['?xample.com'], ['192.168.*'], ['127.0.0.1/0'],
                      ['127.0.0.1/32', '1.2.3.4/33'], ['1.2.3.4.5'], ['1.2.3.4.5/8'], [''], ['!!!'], ['[!a]*'], ['[a-c]*.com'],
                      ['*.local:80'], ['0/0'], ['127.0.0.1/99999999999999999999'], ['10.*/8'], ['1.2.3'], ['1.2.3/24'],
                      ['localhost'], ['a.local'], [], ['300.1.1.1', '127.0.0.1']]
        calls = [('proxyBypassMacosx', [h, {'excludeSimple': simple, 'exceptions': ex}])
                 for ex in exceptions for h in hosts for simple in (False, True)]

        def python(host, settings):
            return urllib.request._proxy_bypass_macosx_sysconf(
                host, {'exclude_simple': settings['excludeSimple'], 'exceptions': settings['exceptions']})
        self.compare(calls, python, 'proxy_bypass_macosx_sysconf')

    def test_fnmatch_matches_python(self):
        patterns = ['*', '?', 'a*b', '[abc]', '[!abc]', '[a-c]', '[]]', '[!]]', '[', 'a[', '[a', '[]', '[!]', '[a-]', '[-a]',
                    '[a-c-e]', '\\*', 'a\\b', '[\\]', '*.com', '**', 'a**b', '[z-a]', '[^a]', '[[]', '[a-z]*', '[!a-z]', '[a-b-]',
                    '[!-a]', '[]-a]', '[a&&b]', '[a||b]', '[a~~b]', '[\\-a]', '*.[ch]', 'x[]', '[!', '[!!]', '.', 'a.b', '(x)',
                    '[A-Z]*[a-z]', '?*', '*?', '[a-a]', '[--a]', '[+--]']
        names = ['', 'a', 'ab', 'b', 'abc', 'a.b', 'x.c', 'x.h', 'xh', '[', ']', '-', '*', '\\', 'A', 'z', '!', '^', '&', '|', '~',
                 'a-b', 'x(x)', 'example.com', 'a\nb', '\U0001f600', 'é', 'a]']
        self.compare([('fnmatch', [n, p]) for p in patterns for n in names], fnmatch.fnmatchcase, 'fnmatch')

    # -- URL parsing
    URLS = ['http://a/b', 'HTTP://A:80/x?y#z', '<URL:http://a/b>', ' http://a/b ', 'http://a b/c', 'http:///x', 'http://h',
            'http://h?q', 'http://h#f#g', 'a:b', 'nocolon', '//x', 'http://%41/x', 'http://h%zz/', 'http://[::1]:80/x',
            'ftp://h/x', 'mailto:a@b', 'file:///etc/x', 'http://u:p@h:1/x', 'http:/h', 'http:h', '1http://h', 'ht tp://h',
            'URL:http://x', '<http://x/>', '< http://x >', 'http://h/a#', 'http://h/#frag', 'http://h:80:90/', 'http://h/\t\r\n',
            'http://h/a b', 'http://h:/x', 'http://h/%00', 'http://%0d%0a/x', 'http://h/é', 'HtTp://H/X', '  <URL: http://x >  ',
            '\x01http://h/', 'http://h/?a#b?c', 'https://h?x', 'http://[::1', 'http://::1]/x', 'http://[v1.x]/', 'http://[127.0.0.1]/']

    def test_request_parse_matches_urllib(self):
        def python(url):
            r = urllib.request.Request(url)
            return {'type': r.type, 'host': r.host, 'selector': r.selector, 'full': r._full_url, 'fragment': r.fragment}
        self.compare([('parseUrl', [u]) for u in self.URLS], python, 'Request parsing')

    def test_urlparse_and_urljoin_match_urllib(self):
        def parse(url, scheme=''):
            return list(urllib.parse.urlparse(url, scheme))
        calls = [('urlparse', [u]) for u in self.URLS] + [('urlparse', ['/x', 'http']), ('urlparse', ['a;b;c/d;e', 'http'])]
        self.compare(calls, parse, 'urlparse')
        base = 'http://a/b/c/d;p?q'
        rfc = ['g:h', 'g', './g', 'g/', '/g', '//g', '?y', 'g?y', '#s', 'g#s', 'g?y#s', ';x', 'g;x', 'g;x?y#s', '', '.', './', '..',
               '../', '../g', '../..', '../../', '../../g', '../../../g', '../../../../g', '/./g', '/../g', 'g.', '.g', 'g..',
               '..g', './../g', './g/.', 'g/./h', 'g/../h', 'g;x=1/./y', 'g;x=1/../y', 'g?y/./x', 'g?y/../x', 'g#s/./x',
               'g#s/../x', 'http:g', 'http://x/y', 'HTTP://X/Y', 'https://h/p', 'ftp://h/p', 'mailto:x', 'file:///x',
               '/a b', 'é', '//h:80/p?q#f', 'a/b/../../../c', '/a/b/..', '../a/.', 'x\ty', 'x\r\ny', ' lead', 'http://[::1/x']
        calls = [('urljoin', [base, u]) for u in rfc] + [('urljoin', ['', 'x']), ('urljoin', ['http://a', 'x']),
                                                           ('urljoin', ['http://a/', '']), ('urljoin', ['http://a/b?q#f', '#g']),
                                                           ('urljoin', ['http://a/b/', '../..']), ('urljoin', ['mailto:x', 'y']),
                                                           ('urljoin', ['http://a?x', 'y']), ('urljoin', ['http://a/b;p', ';q'])]
        self.compare(calls, urllib.parse.urljoin, 'urljoin')

    def test_unquote_matches_urllib(self):
        samples = ['a%20b', '%41%42', '%e2%82%ac', '%e2%82', '%ff', '100%', '%zz', '%4', 'a%2Fb', '%C3%A9', '%c3%a9%c3', '', 'x',
                   '%f0%9f%98%80', '%ef%bb%bfx', '%00', '%ed%a0%80']
        self.compare([('unquote', [x]) for x in samples], urllib.parse.unquote, 'unquote')

    # -- http.client validation
    HOSTS = ['h', 'h:80', 'h:', 'h:abc', '[::1]', '[::1]:8080', '[::1', 'h:1_0', 'h: 5', 'h:+5', 'h:-5', 'h:\u0665', ':80', '',
             'h:80:90', '[x]y:80', 'h:00', 'h:80 ', '[::1]:', '[a]:b']

    def test_hostport_matches_http_client(self):
        def python(host, port):
            c = http.client.HTTPConnection('x')
            return list(c._get_hostport(host, None))
        # default_port is 80 for HTTPConnection
        self.compare([('getHostport', [h, 80]) for h in self.HOSTS], python_with_default(), '_get_hostport')

    def test_control_characters_in_hosts_and_selectors(self):
        hosts = ['h', 'h\r\n', 'h x', 'h\x00', 'h\x7f', 'h\x1f', 'h\x20', 'h\u00e9', 'h\t', '\nh', '']
        self.compare([('validateNoControl', [h]) for h in hosts], lambda h: http.client.HTTPConnection('x')._validate_host(h),
                     '_validate_host')
        selectors = ['/ok', '', '/a b', '/a\r\nb', '/a\x7fb', '/\u00e9', '/\u65e5\u672c\U0001f600', '/\x00', '/a\tb', 'x', ' ',
                     '/\u00e9\u00e8x\u00ff', '/\u0100', 'http://h/\u00e9?q=\u00fc']

        def python(method, selector):
            conn = http.client.HTTPConnection('example.test')
            conn.putrequest(method, selector)
        self.compare([('validateRequestLine', ['GET', sel]) for sel in selectors] + [('validateRequestLine', ['HEAD', '/\u00e9'])],
                     python, 'putrequest')

    # -- system proxy settings (macOS)
    SCUTIL_SAMPLE = """<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 10.0.0.0/8
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.example.com
  HTTPSEnable : 1
  HTTPSProxy : secure.example.com
  FTPEnable : 0
  FTPProxy : ftp.example.com
  FTPPort : 21
  GopherEnable : 1
  GopherProxy : g.example
  GopherPort : 70
  Other : <dictionary> {
    Nested : 1
    List : <array> {
      0 : x
    }
  }
}
"""

    def test_scutil_output_is_parsed_like_scproxy(self):
        got = node_units(self.base, [('parseScutilProxy', [self.SCUTIL_SAMPLE])])[0]
        self.assertTrue(got['ok'], got)
        self.assertEqual(got['value'], {
            'proxies': {'http': 'http://proxy.example.com:8080', 'https': 'http://secure.example.com',
                        'gopher': 'http://g.example:70'},
            'excludeSimple': True, 'exceptions': ['*.local', '169.254/16', '10.0.0.0/8']})
        empty = node_units(self.base, [('parseScutilProxy', ['<dictionary> {\n  FTPPassive : 1\n}\n'])])[0]
        self.assertEqual(empty['value'], {'proxies': {}, 'excludeSimple': False, 'exceptions': []})

    @unittest.skipUnless(sys.platform == 'darwin', 'scutil / _scproxy are macOS only')
    def test_live_system_settings_match_scproxy(self):
        got = node_units(self.base, [('macosSystemProxy', [])])[0]
        self.assertTrue(got['ok'], got)
        settings = urllib.request._get_proxy_settings()
        self.assertEqual(got['value'], {'proxies': urllib.request._get_proxies(),
                                        'excludeSimple': bool(settings['exclude_simple']),
                                        'exceptions': list(settings.get('exceptions', []))})

    # -- security properties
    def test_curl_argv_disables_curlrc_first(self):
        got = node_units(self.base, [('curlArgv', ['/usr/bin/curl', ['-L', 'https://x.test/y'], 5])])[0]['value']
        self.assertEqual(got, ['/usr/bin/curl', '-q', '-fsS', '--proto', '=https', '--max-time', '5', '-L', 'https://x.test/y'])

    @unittest.skipUnless(have_openssl(), 'openssl not available')
    def test_curlrc_cannot_disable_verification(self):
        """The real curl, given a ~/.curlrc with `insecure`, still refuses a self-signed server (-q)."""
        curl = shutil.which('curl')
        if curl is None:
            self.skipTest('curl not available')
        cert, key = make_cert(self.base, 'rc', 'DNS:localhost,IP:127.0.0.1')
        fixture = FX.Fixture(str(cert), str(key))
        self.addCleanup(fixture.close)
        home = self.base / 'rc-home'
        home.mkdir()
        (home / '.curlrc').write_text('insecure\n')
        url = f'https://127.0.0.1:{fixture.https_port}/dl/sha'
        env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CURL_HOME': str(home)}
        plain = subprocess.run([curl, '-fsS', '--max-time', '5', url], env=env, capture_output=True)
        self.assertEqual(plain.returncode, 0, 'precondition: .curlrc insecure is honoured without -q')
        argv = node_units(self.base, [('curlArgv', [curl, [url], 5])])[0]['value']
        hardened = subprocess.run(argv, env=env, capture_output=True)
        self.assertNotEqual(hardened.returncode, 0)
        self.assertIn(b'certificate', hardened.stderr.lower())

    @unittest.skipUnless(have_openssl(), 'openssl not available')
    def test_inherited_node_tls_environment_cannot_disable_verification(self):
        cert, key = make_cert(self.base, 'envtls', 'DNS:localhost,IP:127.0.0.1')
        fixture = FX.Fixture(str(cert), str(key))
        self.addCleanup(fixture.close)
        scenario = {'op': 'open', 'url': f'https://127.0.0.1:{fixture.https_port}/dl/sha', 'env': {}}
        path = self.base / 'tls-env.json'
        path.write_text(json.dumps(scenario))
        outcomes = []
        for extra in ({}, {'NODE_TLS_REJECT_UNAUTHORIZED': '0'}, {'NODE_TLS_REJECT_UNAUTHORIZED': '0', 'NODE_OPTIONS': '--tls-min-v1.0'},
                      {'NODE_EXTRA_CA_CERTS': str(cert)}):
            result = S.run_node(RUNNER, path, env={'PATH': os.environ['PATH'], **extra})
            self.assertEqual(result.returncode, 0, result.stderr)
            outcomes.append(json.loads(result.stdout))
        for outcome in outcomes:
            self.assertFalse(outcome['ok'], outcome)
            self.assertIn('CERTIFICATE_VERIFY_FAILED', outcome['message'])
        fixture.take_log()

    @unittest.skipUnless(have_openssl(), 'openssl not available')
    def test_subject_hash_matches_openssl(self):
        subjects = ['/CN=plain', '/C=US/O=Example Corp/CN=Mixed Case', '/CN=  Padded   Inner   Spaces  ', '/O=\u00dcnic\u00f6de/CN=\u65e5\u672c',
                    '/CN=UPPER lower 123', '/C=DE/ST=Berlin/L=Berlin/O=Acme/OU=Unit/CN=Many.Rdns', '/CN=a+O=b', '/DC=example/DC=com/CN=x']
        pems, hashes = [], []
        for n, subject in enumerate(subjects):
            key, cert = Path(self.base, f's{n}.key'), Path(self.base, f's{n}.pem')
            made = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert),
                                   '-days', '2', '-subj', subject], capture_output=True)
            if made.returncode:
                continue
            pems.append(cert.read_text())
            hashes.append(subprocess.run(['openssl', 'x509', '-noout', '-subject_hash', '-in', str(cert)], capture_output=True,
                                         text=True, check=True).stdout.strip())
        self.assertTrue(pems)
        got = node_units(self.base, [('subjectHash', [pem]) for pem in pems])
        self.assertEqual([g.get('value') for g in got], hashes, got)
        # the bundled roots exercise PrintableString, UTF8String, T61String, BMPString and multi-RDN names
        import ssl
        roots = ssl.create_default_context().get_ca_certs(binary_form=True)
        sample = [ssl.DER_cert_to_PEM_cert(der) for der in roots[:60]]
        if sample:
            expected = []
            for pem in sample:
                path = Path(self.base, 'root.pem')
                path.write_text(pem)
                expected.append(subprocess.run(['openssl', 'x509', '-noout', '-subject_hash', '-in', str(path)],
                                               capture_output=True, text=True, check=True).stdout.strip())
            got = node_units(self.base, [('subjectHash', [pem]) for pem in sample])
            self.assertEqual([g.get('value') for g in got], expected)


def python_with_default():
    def python(host, port):
        return list(http.client.HTTPConnection('x')._get_hostport(host, None))
    return python


# ---------------------------------------------------------------------------------------------------------------
# Update-review findings for the HTTP/tar/zip helpers: F04 short writes, F05 SIGKILL, F06 leaks, F23 progress output,
# F34 silence, F35 schemes, F41 registry adapter, F19 raw tar names.
# ---------------------------------------------------------------------------------------------------------------
import hashlib  # noqa: E402,F811
import time  # noqa: E402,F811


class UpdateReviewFixes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.fixture = FX.Fixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.tmp.cleanup()

    def node(self, script, *args, env=None, timeout=60):
        return subprocess.run([S.NODE, '--input-type=module', '-e', script, *map(str, args)], capture_output=True, text=True,
                              timeout=timeout, env=env if env is not None else {'PATH': os.environ['PATH']})

    # -- F04: a short write is completed, so the stored bytes are the hashed bytes
    SHORT = ('import fs from "node:fs";'
             'const real = fs.writeSync;'
             'fs.writeSync = (fd, buf, off, len, pos) => (Buffer.isBuffer(buf) ? real(fd, buf, off, Math.min(len, 1), pos)'
             ' : real(fd, buf, off, len, pos));')

    def test_short_writes_are_completed_by_the_downloader(self):
        dest = self.base / 'short.bin'
        script = (self.SHORT + f'import {{fetchToFile, sha256File}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'const digest = await fetchToFile(process.argv[1], process.argv[2], {env: {}, stderr: {isTTY: false, write() {}}});'
                  'console.log(JSON.stringify([digest, sha256File(process.argv[2])]));')
        out = self.node(script, f'http://127.0.0.1:{self.fixture.http_port}/dl/chunked', dest)
        self.assertEqual(out.returncode, 0, out.stderr)
        digest, on_disk = json.loads(out.stdout)
        self.assertEqual(digest, on_disk)
        self.assertEqual(dest.stat().st_size, 200000)
        self.assertEqual(hashlib.sha256(dest.read_bytes()).hexdigest(), digest)

    def test_short_writes_are_completed_by_the_extractors(self):
        import io
        import tarfile
        import zipfile
        payload = bytes(range(256)) * 20
        tar_path, zip_path = self.base / 'w.tar.gz', self.base / 'w.zip'
        with tarfile.open(tar_path, 'w:gz') as archive:
            info = tarfile.TarInfo('r/f.bin')
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('r/f.bin', payload)
        for kind, extract, archive_path in (('tar', 'extractLcuTar', tar_path), ('zip', 'extractLcuZip', zip_path)):
            out_dir = self.base / f'out-{kind}'
            out_dir.mkdir()
            script = (self.SHORT + f'import {{{extract}}} from "{S.ROOT / f"lcu/compat/{kind}.mjs"}";'
                      f'{extract}(process.argv[1], process.argv[2]);')
            out = self.node(script, archive_path, out_dir)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual((out_dir / 'r/f.bin').read_bytes(), payload, kind)

    # -- F05: a curl that ignores SIGTERM is killed (SIGKILL), like subprocess.run
    def test_curl_timeout_kills_the_child(self):
        fake = self.base / 'stubborn-bin'
        fake.mkdir()
        script = fake / 'curl'
        pid_file = self.base / 'curl.pid'
        script.write_text(f'#!/bin/sh\necho $$ > {pid_file}\ntrap "" TERM\nwhile :; do sleep 1; done\n')
        script.chmod(0o755)
        js = (f'import {{curl}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
              'const t0 = Date.now(); let outcome;'
              'try { curl(["-L", "https://x.test/"], {timeout: -4.5, env: {PATH: process.argv[1]}}); outcome = "returned"; }'
              'catch (e) { outcome = [e.name, e.message]; }'
              'console.log(JSON.stringify([outcome, Date.now() - t0]));')
        out = self.node(js, fake)
        self.assertEqual(out.returncode, 0, out.stderr)
        outcome, elapsed = json.loads(out.stdout)
        self.assertEqual(outcome[0], 'TimeoutExpired', outcome)
        self.assertIn('timed out after 0.5 seconds', outcome[1])
        self.assertLess(elapsed, 4000, 'a SIGTERM-ignoring curl must not block the synchronous call')
        pid = int(pid_file.read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)  # the wrapper was killed (signal 0 only probes a pid this test started through node)

    # -- F06: the response (socket) is closed whatever fails after the head
    def test_a_bad_content_length_does_not_leak_the_connection(self):
        script = ('import net from "node:net";'
                  f'import {{fetchToFile, fetchBytes}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'let closed = 0; const sockets = [];'
                  'const server = net.createServer((socket) => { sockets.push(socket); socket.on("close", () => { closed++; });'
                  ' socket.on("error", () => {}); socket.resume();'
                  ' socket.write("HTTP/1.1 200 OK\\r\\nContent-Length: abc\\r\\n\\r\\nhello"); });'
                  'await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));'
                  'const url = `http://127.0.0.1:${server.address().port}/x`;'
                  'let error;'
                  'try { await fetchToFile(url, process.argv[1], {env: {}, stderr: {isTTY: false, write() {}}}); } catch (e) { error = e.message; }'
                  'await new Promise((resolve) => setTimeout(resolve, 300));'
                  'console.log(JSON.stringify([error, closed, sockets.length])); server.close(); process.exit(0);')
        out = self.node(script, self.base / 'leak.bin')
        self.assertEqual(out.returncode, 0, out.stderr)
        error, closed, count = json.loads(out.stdout)
        self.assertEqual(error, "invalid literal for int() with base 10: 'abc'")
        self.assertEqual((closed, count), (1, 1), 'the client closed its socket straight away')

    def test_read_failures_close_the_response_in_every_helper(self):
        script = ('import net from "node:net";'
                  f'import {{fetchBytes, severityOf}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'let closed = 0; let opened = 0;'
                  'const server = net.createServer((socket) => { opened++; socket.on("close", () => { closed++; }); socket.on("error", () => {});'
                  ' socket.resume();'
                  ' socket.write("HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nzz\\r\\n"); });'
                  'await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));'
                  'const url = `http://127.0.0.1:${server.address().port}/x`; const errors = [];'
                  'try { await fetchBytes(url, {env: {}}); } catch (e) { errors.push(e.name); }'
                  'try { await severityOf("v1", "1", {notesTemplate: url + "?%s&%s", env: {}}); } catch (e) { errors.push(e.name); }'
                  'await new Promise((resolve) => setTimeout(resolve, 300));'
                  'console.log(JSON.stringify([errors, opened, closed])); server.close(); process.exit(0);')
        out = self.node(script)
        self.assertEqual(out.returncode, 0, out.stderr)
        errors, opened, closed = json.loads(out.stdout)
        self.assertEqual(errors, ['IncompleteRead', 'IncompleteRead'])  # http.client.HTTPException: not caught by severity_of
        self.assertEqual((opened, closed), (2, 2))

    # -- F23: progress output goes through a callback; Windows' stderr translates the final newline
    def test_progress_output_callback_and_windows_newline(self):
        script = (f'import {{fetchToFile}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'const url = process.argv[1]; const rows = [];'
                  'for (const platform of ["linux", "win32"]) {'
                  ' let out = ""; await fetchToFile(url, process.argv[2], {env: {}, platform, stderr: {isTTY: true, write() { throw new Error("stderr used"); }},'
                  '  progress: (text) => { out += text; }}); rows.push(out); }'
                  'console.log(JSON.stringify(rows));')
        out = self.node(script, f'http://127.0.0.1:{self.fixture.http_port}/dl/data', self.base / 'progress.bin')
        self.assertEqual(out.returncode, 0, out.stderr)
        linux, windows = json.loads(out.stdout)
        self.assertTrue(linux.startswith('\rDownloading 40%'), linux[:40])
        self.assertTrue(linux.endswith('\rDownloading 100%\n'))
        self.assertTrue(windows.endswith('\rDownloading 100%\r\n'))
        self.assertEqual(linux.replace('\n', ''), windows.replace('\r\n', ''))

    # -- F35: only http(s) URLs (documented narrower contract than urllib's file:/data:/ftp:)
    def test_non_http_schemes_are_refused_with_urllib_wording(self):
        script = (f'import {{fetchBytes}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'const rows = [];'
                  'for (const url of ["file:///etc/hosts", "data:text/plain,hi", "ftp://127.0.0.1/x", "gopher://x/"]) {'
                  ' try { await fetchBytes(url, {env: {}}); rows.push("read"); } catch (e) { rows.push([e.name, e.message]); } }'
                  'console.log(JSON.stringify(rows));')
        out = self.node(script)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), [['URLError', '<urlopen error unknown url type: file>'],
                                                  ['URLError', '<urlopen error unknown url type: data>'],
                                                  ['URLError', '<urlopen error unknown url type: ftp>'],
                                                  ['URLError', '<urlopen error unknown url type: gopher>']])

    # -- F41: Windows registry proxies (CPython's nt functions are the oracle; fixture only)
    def registry_oracle(self, values):
        with windows_registry(values):
            return {'proxies': urllib.request.getproxies_registry() if hasattr(urllib.request, 'getproxies_registry')
                    else nt_functions()['getproxies_registry']()}

    def test_registry_proxy_parsing_matches_cpython(self):
        servers = ['proxy:8080', 'http=a:1;https=b:2', 'a:1;b:2', 'http=http://a:1;ftp=ftp://f:3;socks=s:4', 'socks=s:4',
                   'socks=socks5://s:4;https=h:5', 'http=a:1;', ';', '=x', 'http=', 'noeq;http=a:1', 'https://secure:1', 'x=y=z',
                   'http=a:1;https=b:2;ftp=c:3;gopher=d:4', 'HTTP=a:1', 'http=a b:1']
        calls, expected = [], []
        for server in servers:
            for enable in (1, 0, '1', ''):
                values = {'ProxyEnable': enable, 'ProxyServer': server}
                node_values = {k: v for k, v in values.items()}
                calls.append(('registryProxies', [node_values]))
                with windows_registry(values):
                    expected.append(py_outcome(lambda: nt_functions()['getproxies_registry']()))
        calls.append(('registryProxies', [{'ProxyEnable': 1}]))
        with windows_registry({'ProxyEnable': 1}):
            expected.append(py_outcome(lambda: nt_functions()['getproxies_registry']()))
        calls.append(('registryProxies', [{}]))
        with windows_registry({}):
            expected.append(py_outcome(lambda: nt_functions()['getproxies_registry']()))
        node = node_units(self.base, calls)
        failures = [f'{c[1]} python={e} node={n}' for c, e, n in zip(calls, expected, node) if e != n]
        self.assertFalse(failures, '\n'.join(failures[:6]))

    def test_registry_bypass_matches_cpython(self):
        overrides = ['<local>', '<local>;*.example.test', 'www.example.com;*.example.net; 192.168.0.1', '127.*', ' a ; b ', '',
                     '*', '?.x', '<LOCAL>', 'example.test:80', '[ab].test', ';;', '<local>;']
        hosts = ['localhost', 'localhost:80', 'www.example.com', 'a.example.net', '192.168.0.1', '192.168.0.1:8080', '127.0.0.1', 'a',
                 'b.test', 'a.test', 'Example.Test', 'x.y', 'example.test:80', '']
        calls = [('proxyBypassWinreg', [h, o, False]) for o in overrides for h in hosts]
        node = node_units(self.base, calls)
        failures = []
        for (fn, (host, override, _)), got in zip(calls, node):
            want = py_outcome(lambda h=host, o=override: urllib.request._proxy_bypass_winreg_override(h, o))
            if want != got:
                failures.append(f'{host!r} {override!r}: python={want} node={got}')
        self.assertFalse(failures, '\n'.join(failures[:6]))
        # ntpath.normcase on Windows lower-cases both sides: case-insensitive matching
        folded = node_units(self.base, [('proxyBypassWinreg', ['EXAMPLE.test', '*.TEST', True]),
                                        ('proxyBypassWinreg', ['EXAMPLE.test', '*.TEST', False])])
        self.assertEqual([r['value'] for r in folded], [True, False])

    def test_reg_exe_output_parsing(self):
        sample = ('\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n'
                  '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=a:1;https=b:2\r\n'
                  '    ProxyOverride    REG_SZ    <local>;*.example.test\r\n    AutoConfigURL    REG_SZ    \r\n'
                  '    Name With Space    REG_SZ    x y  z\r\n\r\n')
        got = node_units(self.base, [('parseRegQuery', [sample]), ('registrySettings', [sample])])
        self.assertEqual(got[0]['value']['ProxyEnable'], {'type': 'REG_DWORD', 'data': '0x1'})
        self.assertEqual(got[0]['value']['ProxyServer']['data'], 'http=a:1;https=b:2')
        self.assertEqual(got[0]['value']['AutoConfigURL']['data'], '')
        self.assertEqual(got[1]['value'], {'kind': 'windows', 'proxies': {'http': 'http://a:1', 'https': 'http://b:2'},
                                           'enabled': True, 'override': '<local>;*.example.test'})

    # -- F34: the restored startup variable must not make LCU's verified requests print a warning
    @unittest.skipUnless(have_openssl(), 'openssl not available')
    def test_node_tls_environment_does_not_warn(self):
        cert, key = make_cert(self.base, 'quiet', 'DNS:localhost,IP:127.0.0.1')
        fixture = FX.Fixture(str(cert), str(key))
        self.addCleanup(fixture.close)
        scenario = self.base / 'quiet.json'
        scenario.write_text(json.dumps({'op': 'open', 'url': f'https://127.0.0.1:{fixture.https_port}/dl/sha', 'env': {}}))
        for extra in ({}, {'NODE_TLS_REJECT_UNAUTHORIZED': '0'}):
            result = S.run_node(RUNNER, scenario, env={'PATH': os.environ['PATH'], **extra})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, '', f'{extra}: stderr must stay empty')
            self.assertIn('CERTIFICATE_VERIFY_FAILED', result.stdout)
        script = (f'import {{urlopen}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  'try { await urlopen(process.argv[1], {env: {}}); } catch {}'
                  'console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED);')
        restored = self.node(script, f'https://127.0.0.1:{fixture.https_port}/', env={'PATH': os.environ['PATH'],
                                                                                    'NODE_TLS_REJECT_UNAUTHORIZED': '0'})
        self.assertEqual(restored.stdout.strip(), '0', 'the variable is restored for children')
        self.assertEqual(restored.stderr, '')


if __name__ == '__main__':
    unittest.main()
