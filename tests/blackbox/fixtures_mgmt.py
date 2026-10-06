"""Fixtures for the management-command scenarios (apps, browser, doctor, status, prune, update).

Everything here is built as real files or real helper processes; nothing imports the implementation under test.
Pieces: fake .app bundles and the approvals store (`lcu apps`), a stand-in for the Touch ID helper, a pty driver
for TTY prompts, the fake upstream Chrome plugin (`lcu browser`), doctor probe variants, update cache helpers, a
GitHub-shaped HTTPS fixture server reached through https_proxy, and a release-archive builder.
"""
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
import zlib

import fixtures
import sandbox

HERE = Path(__file__).resolve().parent
ASSETS = HERE / 'assets/mgmt'
ACCOUNT_STORE = ('Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/'
                 'Library/Application Support/Software/ComputerUseAppApprovals.json')


def host():
    return 'darwin' if sys.platform == 'darwin' else 'linux'


# -- apps ---------------------------------------------------------------------------------------------------

def app_bundle(directory, name, identifier, *, display=None, bundle_name=None, binary=False, info=None):
    """<directory>/<name>.app with a Contents/Info.plist (XML or binary). `info` replaces the plist dict."""
    app = Path(directory) / f'{name}.app'
    document = info
    if document is None:
        document = {'CFBundleIdentifier': identifier}
        if display:
            document['CFBundleDisplayName'] = display
        if bundle_name:
            document['CFBundleName'] = bundle_name
    fixtures.write(app / 'Contents/Info.plist',
                   plistlib.dumps(document, fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML))
    return app


def store_path(sb):
    return sb.home / ACCOUNT_STORE


def show(sb, path, label=None):
    """Put a file's mode and exact bytes into the snapshot as a command result (the harness inlines only the
    final state of the tree; this records intermediate states)."""
    return sb.run([sb.bb / 'tools/python3', ASSETS / 'showfile.py', path], label=label or f'show {Path(path).name}')


def show_scrubbed(sb, path, label=None):
    """Like show(), with the wall-clock numbers of the update cache files replaced by <TIME>."""
    return sb.run([sb.bb / 'tools/python3', ASSETS / 'showfile.py', '--scrub', path],
                  label=label or f'show {Path(path).name}')


def show_store(sb, label='approvals store'):
    return show(sb, store_path(sb), label)


def write_store(sb, content, mode=None):
    """Write the approvals store (str/bytes or a dict dumped like the runtime does)."""
    if isinstance(content, (dict, list)):
        content = json.dumps(content, indent=2) + '\n'
    path = store_path(sb)
    fixtures.write(path, content, mode)
    return path


def auth_helper(sb, *, mode=0o755, rules=None, default=None):
    """A recorder in place of bin/lcu-owner-auth (the native Touch ID helper is never run)."""
    path = sb.release / 'bin/lcu-owner-auth'
    fixtures.write(path, fixtures.recorder_script('lcu-owner-auth'), mode)
    config = {}
    if rules:
        config['rules'] = rules
    if default is not None:
        config['default'] = default
    sb.fake('lcu-owner-auth', **config)
    return path


# -- terminals ----------------------------------------------------------------------------------------------

def pty(sb, steps, argv, *, label=None, env=None, timeout=60):
    """Run `argv` on a pseudo-terminal, answering prompts: steps = [(expect substring, text to send), ...]."""
    helper = ASSETS / 'ptydrive.py'
    return sb.run([sb.bb / 'tools/python3', helper, json.dumps(steps), '--', *argv], label=label, env=env,
                  timeout=timeout)


# -- chrome plugin / browser ---------------------------------------------------------------------------------

def app_resources(sb):
    """Resources of the fixture app placed in this sandbox (a Linux-layout app can be placed on a macOS host)."""
    return sb.apps / ('chatgpt/resources' if (sb.apps / 'chatgpt').is_dir() else 'ChatGPT.app/Contents/Resources')


def chrome_plugin(sb, *, executable_host=True, with_scripts=True):
    """Complete the fake app's Chrome plugin with stand-ins for the upstream scripts and native host binary."""
    plugin = app_resources(sb) / 'plugins/openai-bundled/plugins/chrome'
    if with_scripts:
        for source in sorted((ASSETS / 'chrome-plugin').rglob('*')):
            if source.is_file():
                fixtures.write(plugin / source.relative_to(ASSETS / 'chrome-plugin'), source.read_bytes(), 0o644)
    arch = fixtures.architecture()
    if host() == 'darwin':
        fixtures.write(plugin / f'extension-host/macos/{arch}/ChatGPT for Chrome',
                       fixtures.recorder_script('extension-host'), 0o755 if executable_host else 0o644)
    elif not executable_host:
        (plugin / f'extension-host/linux/{arch}/extension-host').chmod(0o644)
    return plugin


def fake_browser(sb, **config):
    """Scenario control for the fake upstream scripts: install/extension/manifest dicts (see assets)."""
    path = sb.bb / 'browser-fake.json'
    path.write_text(json.dumps(config))
    return {'LCU_BB_FAKE_BROWSER': str(path)}


def browser_destination(sb):
    """Default private host directory of this sandbox's selected app (identity = sha256 of the app path)."""
    app = (sb.release / 'app').resolve()
    identity = hashlib.sha256(str(app).encode()).hexdigest()[:16]
    if host() == 'darwin':
        return sb.home / 'Library/Application Support/lcu/browser' / identity
    return sb.home / '.local/share/lcu/browser' / identity


def neutralise_relay(sb, destination):
    """The relay is code under test (Python script today); record only that it exists, its type and mode, then
    replace it by a marker so the tree snapshot does not depend on the implementation language."""
    relay = Path(destination) / 'lcu-native-host'
    if not relay.exists() and not relay.is_symlink():
        return
    info = relay.lstat()
    kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
    mode = f'{stat.S_IMODE(info.st_mode):04o}'
    relay.unlink()
    marker = Path(destination) / 'lcu-native-host.summary'
    marker.write_text(f'relay: {kind} mode {mode}\n')


# -- doctor probes ------------------------------------------------------------------------------------------

def sky_service_path(sb):
    return app_resources(sb) / 'cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'


def sky_service(sb, body):
    """Replace the fake Sky service module (the code doctor's probe imports). `body` is the module text."""
    sky_service_path(sb).write_text(body)


def service_returning(target, **parts):
    """A Sky service whose setup says `target` and whose RPC answers come from JSON literals in `parts`."""
    return ('export async function handleRpc(request) {\n'
            f'  const parts = {json.dumps(parts)};\n'
            f"  if (request.type === 'setup') return {{ target: {json.dumps(target)}, methods: parts.methods || [] }};\n"
            '  const answer = parts[request.method];\n'
            "  if (answer && answer.throw) { const e = new Error(answer.throw.message || ''); "
            "if (answer.throw.code !== undefined) e.code = answer.throw.code; "
            "if (answer.throw.name) e.errorName = answer.throw.name; throw e; }\n"
            '  return answer === undefined ? null : answer.value;\n'
            '}\n')


# -- status / update state -----------------------------------------------------------------------------------

def state_path(sb):
    return sb.home / '.local/state/lcu/setup.json'


def cache_dir(sb):
    return sb.home / ('Library/Caches/lcu' if host() == 'darwin' else '.cache/lcu')


def write_update_cache(sb, latest, error=None, *, age=0, mode=None, raw=None):
    """Seed update.json. `age` seconds old (relative to now; times are scrubbed from the snapshot afterwards)."""
    path = cache_dir(sb) / 'update.json'
    if raw is None:
        raw = json.dumps({'checked_at': time.time() - age, 'latest': latest, 'error': error})
    fixtures.write(path, raw, mode)
    return path


def latest_info(version, *, severity='normal', tag=None):
    tag = tag or 'v' + version
    return {'version': version, 'tag': tag, 'release_url': 'https://github.com/amontlabs/lcu/releases/tag/' + tag,
            'severity': severity}


_TIME_FIELDS = ((re.compile(r'("checked_at": )[-+0-9.eE]+'), r'\g<1>1700000000.0'),
                (re.compile(r'("at": )[-+0-9.eE]+'), r'\g<1>1700000000.0'))


def scrub_times(sb):
    """Replace wall-clock numbers LCU wrote (checked_at, announced at) by a constant, keeping the byte layout."""
    for name in ('update.json', 'announced.json'):
        path = cache_dir(sb) / name
        if not path.is_file():
            continue
        text = path.read_text()
        for pattern, replacement in _TIME_FIELDS:
            text = pattern.sub(replacement, text)
        mode = path.stat().st_mode
        path.write_text(text)
        path.chmod(stat.S_IMODE(mode))


def cache_summary(sb):
    """Record (not scrub) facts about the cache files the snapshot cannot show: modes are in the tree already."""
    return None


# -- fixture server -----------------------------------------------------------------------------------------

OPENSSL = '/usr/bin/openssl'
TLS_HOSTS = ('github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
             'release-assets.githubusercontent.com')


def tls_dir(sb):
    """A throwaway test CA and a server certificate for the GitHub host names, generated with /usr/bin/openssl
    into the sandbox's harness directory (same absolute path for A and B; never in the tree snapshot, never in Git)."""
    directory = sb.bb / 'tls'
    if (directory / 'server.pem').is_file():
        return directory
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'ca.cnf').write_text(
        '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=LCU blackbox test CA\n'
        '[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n'
        'subjectKeyIdentifier=hash\n')
    (directory / 'server.cnf').write_text(
        '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=github.com\n[v3]\nbasicConstraints=CA:FALSE\n'
        'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
        'authorityKeyIdentifier=keyid\nsubjectAltName=' + ','.join('DNS:' + host for host in TLS_HOSTS) + '\n')

    def openssl(*args):
        subprocess.run([OPENSSL, *args], cwd=directory, check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30',
            '-sha256', '-config', 'ca.cnf')
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr',
            '-config', 'server.cnf')
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
            '-out', 'server.pem', '-days', '30', '-sha256', '-extfile', 'server.cnf', '-extensions', 'v3')
    return directory


def ca_path(sb):
    return tls_dir(sb) / 'ca.pem'


def _free_port(start):
    for port in range(start, start + 200):
        with contextlib.closing(socket.socket()) as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                continue
            return port
    raise RuntimeError('no free port')


class Server:
    """The GitHub-shaped fixture (see assets/mgmt/fixture_server.py) as a child of the harness."""

    def __init__(self, sb):
        self.sb = sb
        self.root = sb.bb / 'srv'
        self.root.mkdir(parents=True, exist_ok=True)
        self.port = _free_port(20000 + zlib.crc32(sb.name.encode()) % 20000)
        self.process = None
        self._rules = []

    def start(self):
        (self.root / 'routes.json').write_text('[]')
        (self.root / 'requests.log').write_text('')
        self.process = subprocess.Popen(
            [self.sb.bb / 'tools/python3', ASSETS / 'fixture_server.py', str(self.port), str(self.root),
             str(tls_dir(self.sb))],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'}, start_new_session=True)
        for _ in range(100):
            if (self.root / 'ready').exists():
                return self
            time.sleep(0.05)
        raise RuntimeError('fixture server did not start')

    def stop(self):
        # Safety rule (.port/BRIEF.md): only signal the one pid this object spawned, and only while it is still
        # our unreaped child leading its own session (start_new_session=True above).
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        pid = process.pid
        try:
            if pid > 1 and pid != os.getpid() and os.getsid(pid) == pid:
                os.kill(pid, 9)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait(timeout=10)

    def env(self, *, trust=True, proxy=True):
        """Environment that points LCU's HTTPS at this server (and trusts its CA unless trust=False)."""
        env = {}
        if proxy:
            env['https_proxy'] = f'http://127.0.0.1:{self.port}'
        if trust:
            env['SSL_CERT_FILE'] = str(ca_path(self.sb))
            env['NODE_EXTRA_CA_CERTS'] = str(ca_path(self.sb))
        return env

    def routes(self, *rules):
        self._rules = list(rules)
        (self.root / 'routes.json').write_text(json.dumps(self._rules))

    def add(self, *rules):
        self.routes(*self._rules, *rules)

    def latest(self, tag, *, notes=None, version=None):
        """The releases/latest redirect, plus release notes for severity."""
        rules = [{'host': 'github.com', 'path': '/amontlabs/lcu/releases/latest', 'status': 302,
                  'headers': {'Location': 'https://github.com/amontlabs/lcu/releases/tag/' + tag}}]
        if notes is not None:
            version = version or tag.lstrip('v')
            rules.append({'host': 'raw.githubusercontent.com',
                          'path': f'/amontlabs/lcu/{tag}/docs/releases/{version}.md', 'body': notes})
        self.add(*rules)

    def www(self, host_name, path, data):
        target = self.root / 'www' / host_name / path.lstrip('/')
        fixtures.write(target, data)
        return target

    def publish(self, tag, name, archive, checksum):
        """Serve a release asset the way GitHub does: github.com redirects to an assets host."""
        for suffix, data in (('', archive), ('.sha256', checksum)):
            self.www('objects.githubusercontent.com', f'/lcu-assets/{tag}/{name}{suffix}', data)
            self.add({'host': 'github.com', 'path': f'/amontlabs/lcu/releases/download/{tag}/{name}{suffix}',
                      'status': 302,
                      'headers': {'Location': f'https://objects.githubusercontent.com/lcu-assets/{tag}/{name}{suffix}'}})

    def requests(self):
        return (self.root / 'requests.log').read_text()


@contextlib.contextmanager
def server(sb):
    fixture = Server(sb).start()
    try:
        yield fixture
    finally:
        fixture.stop()


def show_requests(sb, fixture, label='fixture server requests'):
    """Put what the server saw into the snapshot as a command result (cat of the request log)."""
    return sb.run(['cat', fixture.root / 'requests.log'], label=label)


def curl_with_ca(sb):
    """A `curl` on PATH that records its arguments like every fake and then runs the system curl trusting only
    the fixture CA (the curl-fallback path of `lcu update` when Python has no usable CA store)."""
    script = ('#!/bin/sh\n'
              f'export LCU_BB_NODE={sandbox.shlex.quote(str(sandbox._real_node()))} '
              f'LCU_BB_RECORDER={sandbox.shlex.quote(str(sb.recorder))} '
              f'LCU_BB_CONFIG={sandbox.shlex.quote(str(sb.config_path))} LCU_BB_LOG={sandbox.shlex.quote(str(sb.log_path))}\n'
              '"$LCU_BB_NODE" "$LCU_BB_RECORDER" curl "$@" || exit $?\n'
              f'exec /usr/bin/curl --cacert {sandbox.shlex.quote(str(ca_path(sb)))} "$@"\n')
    fixtures.write(sb.bb / 'fakes/curl', script, 0o755)
    sb.fake('curl', default={})


# -- release archives ---------------------------------------------------------------------------------------

def build_tree(sb, version, target, name):
    """A sealed release tree (what `lcu update` extracts) under <sandbox>/.bb/build/<name>; modes normalised."""
    destination = sb.bb / 'build' / name
    sandbox.copy_impl(sb.impl_root, destination)
    for path in [destination, *destination.rglob('*')]:
        if path.is_symlink():
            continue
        if path.is_dir():
            path.chmod(0o755)
        else:
            path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
    # A newer release carries its own version constant, which its installer checks against bundle.json.
    current = fixtures.BUNDLE_VERSION
    for script in sorted((destination / 'scripts').glob('*')):
        if script.is_file() and script.suffix in ('.py', '.mjs', '.js', '.sh'):
            text = script.read_text()
            updated = re.sub(r"^((?:export )?(?:const )?VERSION = )'" + re.escape(current) + "'",
                             lambda m: m.group(1) + repr(version), text, flags=re.M)
            if updated != text:
                script.write_text(updated)
    if target != 'windows':
        sb.archive_modules(destination, target, True)
    fixtures.seal(destination, target)
    bundle = json.loads((destination / 'bundle.json').read_text())
    bundle['version'] = version
    (destination / 'bundle.json').write_text(json.dumps(bundle, indent=2, sort_keys=True) + '\n')
    return destination


def _clean(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = 0
    return info


def build_archive(sb, version, target, *, tree=None, name=None, extra=(), arch=None, only_extra=False,
                  top=None):
    """Build lcu-<version>-<target>-<arch>.tar.gz (or .zip for windows). Returns (path, asset name, sha256).

    `extra` are (tarfile.TarInfo | zipfile.ZipInfo, bytes) additions, used for hostile entries. `tree` overrides
    the directory archived; `top` renames the archive's top directory (default the asset stem).
    """
    arch = arch or fixtures.architecture()
    stem = f'lcu-{version}-{target}-{arch}'
    asset = stem + ('.zip' if target == 'windows' else '.tar.gz')
    directory = sb.bb / 'build'
    directory.mkdir(parents=True, exist_ok=True)
    if tree is None and not only_extra:
        tree = build_tree(sb, version, target, stem)
    path = directory / (name or asset)
    top = top or stem
    if target == 'windows':
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            if tree is not None:
                for item in sorted(Path(tree).rglob('*')):
                    arcname = f'{top}/{item.relative_to(tree).as_posix()}'
                    if item.is_dir():
                        archive.writestr(arcname + '/', b'')
                    elif not item.is_symlink():
                        archive.write(item, arcname)
            for info, data in extra:
                archive.writestr(info, data)
    else:
        buffer = io.BytesIO()
        with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                if tree is not None:
                    archive.add(tree, arcname=top, filter=_clean)
                for info, data in extra:
                    archive.addfile(_clean(info), io.BytesIO(data) if data is not None else None)
        path.write_bytes(buffer.getvalue())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, asset, digest


def tar_entry(name, *, kind='file', data=b'', link=None, mode=0o644):
    """A TarInfo for a hostile or odd member, plus its payload."""
    info = tarfile.TarInfo(name)
    info.mode = mode
    types = {'file': tarfile.REGTYPE, 'dir': tarfile.DIRTYPE, 'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
             'chardev': tarfile.CHRTYPE, 'blockdev': tarfile.BLKTYPE, 'fifo': tarfile.FIFOTYPE}
    info.type = types[kind]
    if kind == 'file':
        info.size = len(data)
    if link is not None:
        info.linkname = link
    return info, (data if kind == 'file' else None)


def zip_entry(name, *, data=b'', symlink=False):
    info = zipfile.ZipInfo(name)
    info.external_attr = ((0o120777 if symlink else 0o100644) << 16)
    return info, data


def sha_file(digest, asset, style='plain'):
    return {'plain': f'{digest}  {asset}\n', 'star': f'{digest} *{asset}\n', 'bare': f'{digest}\n',
            'upper': f'{digest.upper()}  {asset}\n', 'other': f'{digest}  something-else.tar.gz\n',
            'junk': 'not a checksum\n', 'multi': f'# comment\n{"0" * 64}  other.tar.gz\n{digest}  {asset}\n'}[style]


def serve_release(sb, fixture, version, target, *, tag=None, style='plain', archive=None, notes=None, **kwargs):
    """Build an archive, publish it with its .sha256, and point /releases/latest at it."""
    tag = tag or 'v' + version
    path, asset, digest = archive or build_archive(sb, version, target, **kwargs)
    fixture.latest(tag, notes=notes, version=version)
    fixture.publish(tag, asset, path.read_bytes(), sha_file(digest, asset, style))
    return asset, digest


def register_new_release_reference(sb, version, target):
    """Compare releases an installer creates (and a kept extraction) with the archive's own tree."""
    stem = f'lcu-{version}-{target}-{fixtures.architecture()}'
    reference = str((sb.bb / 'build' / stem).relative_to(sb.root))
    sb._impl_dirs.append(('prefix/releases/*', reference))
    sb._impl_dirs.append(('tmp/lcu-update-*/extract/' + stem, reference))
    return reference
