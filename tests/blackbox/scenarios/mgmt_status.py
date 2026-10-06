"""`lcu status` and app validation (platforms.py) as seen through status and doctor.

Variants mutate the fake app in place and restore it, so one sandbox walks a whole table of broken states. The
macOS variants run on darwin hosts (fake `codesign`); the Linux variants run everywhere on a Linux-layout fixture,
and the ones that depend on real Linux file ownership/ACL semantics run only in the container.
"""
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import sys

import fixtures
import fixtures_mgmt as fm

from . import scenario

ANY = ('darwin', 'linux')
# Doctor's Linux sandbox probe runs in $TMPDIR/lcu-sandbox-probe-<random>.
TMP = ('tmpdir-suffix',)
MAC = ('darwin',)
LINUX = ('linux',)


def _note(sb, text):
    sb.run(['echo', text], label=text)


def _survey(sb, *, doctor=True, env=None):
    sb.lcu('status', env=env)
    sb.lcu('status', '--json', env=env)
    if doctor:
        sb.lcu('doctor', '--non-interactive', env=env)


def _descriptor_path(sb):
    return sb.release / 'installation.json'


def _linux_app(sb):
    return sb.apps / 'chatgpt'


def _mac_app(sb):
    return sb.apps / 'ChatGPT.app'


class _Swap:
    """Temporarily rename a path away (and back)."""

    def __init__(self, path):
        self.path, self.saved = Path(path), Path(str(path) + '.bb-saved')

    def __enter__(self):
        self.path.rename(self.saved)

    def __exit__(self, *exc):
        if self.path.exists() or self.path.is_symlink():
            if self.path.is_dir() and not self.path.is_symlink():
                shutil.rmtree(self.path)
            else:
                self.path.unlink()
        self.saved.rename(self.path)


class _Edit:
    """Temporarily replace a file's bytes (and restore bytes and mode)."""

    def __init__(self, path, data):
        self.path, self.data = Path(path), data

    def __enter__(self):
        self.original = self.path.read_bytes() if self.path.exists() else None
        self.mode = stat.S_IMODE(self.path.stat().st_mode) if self.path.exists() else None
        if self.path.is_symlink() or not self.path.is_dir():
            self.path.write_bytes(self.data if isinstance(self.data, bytes) else self.data.encode())

    def __exit__(self, *exc):
        if self.original is None:
            self.path.unlink()
        else:
            self.path.write_bytes(self.original)
            self.path.chmod(self.mode)


def _mode(path, mode):
    class Mode:
        def __enter__(self):
            self.old = stat.S_IMODE(Path(path).stat().st_mode)
            Path(path).chmod(mode)

        def __exit__(self, *exc):
            Path(path).chmod(self.old)
    return Mode()


# -- status -------------------------------------------------------------------------------------------------

@scenario('status/saved-setup', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    path = fm.state_path(sb)
    cases = [
        ('absent', None),
        ('chrome on, audio off, ask', {'chrome': True, 'audio': False, 'approval': 'ask'}),
        ('both on, auto', {'chrome': True, 'audio': True, 'approval': 'auto'}),
        ('legacy file without approval or pending', {'chrome': False, 'audio': True}),
        ('pending harnesses', {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi', 'omp', 'pi'],
                               'pending_context': {'scope': 'user', 'session': 'direct', 'project': None}}),
        ('pending with project context', {'chrome': True, 'audio': False, 'approval': 'auto', 'pending': ['hermes'],
                                          'pending_context': {'scope': 'project', 'session': 'discover',
                                                              'project': '/work/proj'}}),
        ('pending context without pending', {'chrome': False, 'audio': False, 'pending': [],
                                             'pending_context': {'scope': 'user', 'session': 'direct',
                                                                 'project': None}}),
        ('unknown extra keys', {'chrome': False, 'audio': False, 'extra': 1}),
        ('chrome not a bool', {'chrome': 1, 'audio': False}),
        ('approval invalid', {'chrome': False, 'audio': False, 'approval': 'sometimes'}),
        ('pending has unknown harness', {'chrome': False, 'audio': False, 'pending': ['codex']}),
        ('pending not a list', {'chrome': False, 'audio': False, 'pending': 'pi'}),
        ('context bad scope', {'chrome': False, 'audio': False, 'pending': ['pi'],
                               'pending_context': {'scope': 'x', 'session': 'direct', 'project': None}}),
        ('not a dict', [1, 2]),
    ]
    for label, document in cases:
        if document is None:
            if path.exists():
                path.unlink()
        else:
            fixtures.write(path, json.dumps(document, indent=2) + '\n')
        _note(sb, f'--- setup.json: {label}')
        sb.lcu('status')
        sb.lcu('status', '--json')
    for label, raw in (('malformed json', '{not json'), ('empty file', ''), ('binary', b'\xff\xfe\x00')):
        fixtures.write(path, raw)
        _note(sb, f'--- setup.json: {label}')
        sb.lcu('status')
    path.unlink()
    path.symlink_to('elsewhere.json')
    _note(sb, '--- setup.json: symlink')
    sb.lcu('status', '--json')
    path.unlink()
    path.mkdir()
    _note(sb, '--- setup.json: directory')
    sb.lcu('status')


@scenario('status/tested-record', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    record = sb.release / 'tested-versions.json'
    target = fm.host()
    arch = fixtures.architecture()
    exact = {'platform': target, 'architecture': arch, 'app_version': fixtures.VERSION, 'runtime': fixtures.RUNTIME,
             'lcu_version': '0.9.3'}
    other = {'platform': target, 'architecture': arch, 'app_version': '1.0', 'runtime': '0.0.1', 'lcu_version': '0.9.0'}
    cases = [
        ('as shipped', None),
        ('exact pair', {'format': 1, 'entries': [exact]}),
        ('exact pair with evidence, sha and native input',
         {'format': 1, 'entries': [{**exact, 'evidence': 'docs/x.md', 'app_sha256': 'a' * 64,
                                    'native_input': ['gtk4']}]}),
        ('untested, others listed', {'format': 1, 'entries': [other, {**other, 'architecture': 'x64'}]}),
        ('no pair for this platform', {'format': 1, 'entries': [{**other, 'platform': 'windows'}]}),
        ('empty entries', {'format': 1, 'entries': []}),
        ('wrong format number', {'format': 2, 'entries': []}),
        ('entries not a list', {'format': 1, 'entries': {}}),
        ('invalid entry', {'format': 1, 'entries': [{'platform': target}]}),
        ('bad sha', {'format': 1, 'entries': [{**exact, 'app_sha256': 'xyz'}]}),
        ('bad native_input', {'format': 1, 'entries': [{**exact, 'native_input': ['motif']}]}),
        ('not a dict', []),
    ]
    original = record.read_bytes()
    for label, document in cases:
        record.write_bytes(original if document is None else (json.dumps(document) + '\n').encode())
        _note(sb, f'--- tested-versions.json: {label}')
        sb.lcu('status')
        sb.lcu('status', '--json')
        sb.lcu('doctor', '--non-interactive')
    for label, raw in (('malformed', b'{nope'), ('empty', b''), ('invalid utf-8', b'\xff\xfe')):
        record.write_bytes(raw)
        _note(sb, f'--- tested-versions.json: {label}')
        sb.lcu('status')
    record.unlink()
    _note(sb, '--- tested-versions.json: missing')
    sb.lcu('status')
    sb.lcu('status', '--json')


@scenario('status/changed-since-install', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    path = _descriptor_path(sb)
    descriptor = json.loads(path.read_text())
    for label, edits in (('same as installed', {}),
                         ('app version changed', {'package_version': '1.2.3'}),
                         ('runtime changed', {'runtime': '9.9.9/other'}),
                         ('both changed', {'package_version': '1.2.3', 'runtime': '9.9.9/other'}),
                         ('package_version not a string', {'package_version': 5}),
                         ('package_version empty', {'package_version': ''}),
                         ('package_version missing', {'package_version': None}),
                         ('runtime missing', {'runtime': None})):
        merged = {**descriptor, **edits}
        merged = {k: v for k, v in merged.items() if v is not None}
        path.write_text(json.dumps(merged, indent=2) + '\n')
        _note(sb, f'--- {label}')
        sb.lcu('status')
        sb.lcu('status', '--json')
        sb.lcu('doctor', '--non-interactive')


@scenario('status/errors', hosts=ANY, normalise=(*TMP, 'traceback'))
def _(sb):
    sb.place_release()
    descriptor = _descriptor_path(sb)
    original = descriptor.read_text()
    parsed = json.loads(original)
    for label, text in (('malformed json', '{nope'), ('empty', ''), ('trailing comma', '{"a": 1,}'),
                        ('empty object', '{}'), ('relative app', json.dumps({**parsed, 'app': 'rel/path'})),
                        ('unknown architecture', json.dumps({**parsed, 'architecture': 'riscv'})),
                        ('app is another directory', json.dumps({**parsed, 'app': str(sb.apps)})),
                        ('app missing', json.dumps({**parsed, 'app': str(sb.apps / 'missing')})),
                        ('unsupported platform', json.dumps({**parsed, 'platform': 'plan9'})),
                        ('platform null', json.dumps({**parsed, 'platform': None})),
                        ('app not a string', json.dumps({**parsed, 'app': 5}))):
        descriptor.write_text(text)
        _note(sb, f'--- installation.json: {label}')
        _survey(sb)
    descriptor.write_text(original)
    for name, label in (('bundle.json', 'bundle.json'), ('runtime.lock.json', 'runtime.lock.json')):
        path = sb.release / name
        data = path.read_bytes()
        for variant, content in (('missing', None), ('malformed', b'{nope'), ('empty object', b'{}'),
                                 ('no version', b'{"format": 1}'), ('invalid utf-8', b'\xff\xfe')):
            if content is None:
                path.unlink()
            else:
                path.write_bytes(content)
            _note(sb, f'--- {label}: {variant}')
            _survey(sb)
        path.write_bytes(data)
    _note(sb, '--- everything restored')
    _survey(sb)


@scenario('status/source-checkout', hosts=ANY, normalise=TMP)
def _(sb):
    # A source tree has no bundle.json: status reports `source-checkout` instead of a version.
    sb.place_release(bundle=False)
    sb.lcu('status')
    sb.lcu('status', '--json')


@scenario('status/update-line', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    newer = fm.latest_info('0.9.9')
    for label, cache, env in (
            ('no cache', None, {}),
            ('newer release cached', (newer, None), {}),
            ('security severity', (fm.latest_info('0.9.9', severity='security'), None), {}),
            ('same version', (fm.latest_info('0.9.3'), None), {}),
            ('older version', (fm.latest_info('0.9.0'), None), {}),
            ('stale cache still shown, never refreshed', (newer, None), {'age': 100000}),
            ('error cached, keeps latest', (newer, 'HTTP Error 503: Service Unavailable'), {}),
            ('update checks disabled', (newer, None), {'LCU_NO_UPDATE_CHECK': '1'}),
            ('disable flag 0 is off', (newer, None), {'LCU_NO_UPDATE_CHECK': '0'}),
            ('disable flag blank', (newer, None), {'LCU_NO_UPDATE_CHECK': '  '}),
            ('latest without version', ({'tag': 'v1'}, None), {}),
            ('latest not a dict', ('v0.9.9', None), {})):
        age = env.pop('age', 0)
        if cache is None:
            path = fm.cache_dir(sb) / 'update.json'
            if path.exists():
                path.unlink()
        else:
            fm.write_update_cache(sb, cache[0], cache[1], age=age)
        _note(sb, f'--- {label}')
        sb.lcu('status', env=env)
        sb.lcu('status', '--json', env=env)
    fm.scrub_times(sb)


@scenario('status/arguments', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    for args in (['--help'], ['-h'], ['--json', '--json'], ['--jso'], ['--js'], ['extra'], ['--json', 'extra'],
                 ['-j'], ['--', '--json']):
        sb.lcu('status', *args)


# -- app validation: macOS ------------------------------------------------------------------------------------

def _mac_variants(sb):
    app = _mac_app(sb)
    contents = app / 'Contents'
    helper = contents / 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app'
    runtime = contents / 'Resources/cua_node'
    resources = contents / 'Resources'
    arch = fixtures.architecture()
    plist = __import__('plistlib')

    def info(path, **changes):
        document = plist.loads((path / 'Contents/Info.plist').read_bytes() if path != contents
                               else (contents / 'Info.plist').read_bytes())
        document.update(changes)
        return plist.dumps({k: v for k, v in document.items() if v is not None})

    yield 'baseline', _Edit(runtime / 'manifest.json', (runtime / 'manifest.json').read_bytes())
    for relative in ('Resources/cua_node/bin/node', 'Resources/cua_node/bin/node_repl',
                     'Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
                     'Resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
                     'Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json'):
        yield f'required file missing: {relative}', _Swap(contents / relative)
    yield 'node not executable', _mode(runtime / 'bin/node', 0o644)
    yield 'node_repl not executable', _mode(runtime / 'bin/node_repl', 0o644)
    yield 'codex not executable', _mode(resources / 'codex', 0o644)
    yield 'code-mode host not executable', _mode(resources / 'codex-code-mode-host', 0o644)
    yield 'codex missing', _Swap(resources / 'codex')
    yield 'app Info.plist missing', _Swap(contents / 'Info.plist')
    yield 'app Info.plist wrong identifier', _Edit(contents / 'Info.plist', info(contents, CFBundleIdentifier='x.y'))
    yield 'app version missing', _Edit(contents / 'Info.plist', info(contents, CFBundleShortVersionString=None))
    yield 'app version blank', _Edit(contents / 'Info.plist', info(contents, CFBundleShortVersionString='  '))
    yield 'app Info.plist not a plist', _Edit(contents / 'Info.plist', b'garbage')
    yield 'helper Info.plist missing', _Swap(helper / 'Contents/Info.plist')
    yield 'helper wrong identifier', _Edit(helper / 'Contents/Info.plist',
                                           info(helper, CFBundleIdentifier='com.example.helper'))
    yield 'helper missing', _Swap(helper)
    manifest = json.loads((runtime / 'manifest.json').read_text())
    for label, document in (('wrong platform', {**manifest, 'platform': 'linux'}),
                            ('wrong arch', {**manifest, 'arch': 'x64' if arch == 'arm64' else 'arm64'}),
                            ('runtime version missing', {k: v for k, v in manifest.items()
                                                         if k != 'runtime_archive_version'}),
                            ('runtime version blank', {**manifest, 'runtime_archive_version': ' '}),
                            ('runtime version number', {**manifest, 'runtime_archive_version': 3})):
        yield f'manifest {label}', _Edit(runtime / 'manifest.json', json.dumps(document))
    yield 'manifest malformed', _Edit(runtime / 'manifest.json', '{nope')
    yield 'manifest missing', _Swap(runtime / 'manifest.json')
    yield 'duplicate codex layout', _Dup(resources)


class _Dup:
    """A second complete Codex CLI layout (codex-cli/bin) next to the first: ambiguous."""

    def __init__(self, resources):
        self.resources = Path(resources)

    def __enter__(self):
        base = self.resources / 'codex-cli/bin'
        base.mkdir(parents=True)
        for name in ('codex', 'codex-code-mode-host'):
            shutil.copy2(self.resources / name, base / name)

    def __exit__(self, *exc):
        shutil.rmtree(self.resources / 'codex-cli')


@scenario('status/mac-app-validation', hosts=MAC, normalise=(*TMP, 'traceback'))
def _(sb):
    sb.place_release()
    for label, change in _mac_variants(sb):
        _note(sb, f'--- {label}')
        with change:
            _survey(sb)
            if label == 'baseline':
                sb.lcu('--version')


@scenario('status/mac-signature', hosts=MAC, normalise=TMP)
def _(sb):
    sb.place_release()
    long = 'a long codesign complaint ' * 20 + '\nsecond line'
    for label, rules in (
            ('verify fails (stderr, truncated, newlines folded)',
             [{'match': r'^--verify', 'exit': 1, 'stderr': long}]),
            ('verify fails (stdout only)', [{'match': r'^--verify', 'exit': 3, 'stdout': 'on stdout\n'}]),
            ('verify fails with no output', [{'match': r'^--verify', 'exit': 1}]),
            ('identity wrong team', [{'match': r'^-dv .*ChatGPT\.app$',
                                      'stderr': 'Identifier=com.openai.codex\nTeamIdentifier=ABCDE12345\n'},
                                     {'match': r'^-dv .*Computer Use\.app$',
                                      'stderr': 'Identifier=com.openai.sky.CUAService\nTeamIdentifier=2DC432GLL2\n'}]),
            ('identity wrong identifier', [{'match': r'^-dv .*ChatGPT\.app$',
                                            'stderr': 'Identifier=com.evil.codex\nTeamIdentifier=2DC432GLL2\n'},
                                           {'match': r'^-dv .*Computer Use\.app$',
                                            'stderr': 'Identifier=com.openai.sky.CUAService\nTeamIdentifier=2DC432GLL2\n'}]),
            ('identity on stdout is not accepted',
             [{'match': r'^-dv ', 'stdout': 'Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n'}]),
            ('identity command fails', [{'match': r'^-dv ', 'exit': 1,
                                         'stderr': 'Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n'}]),
            ('helper signature wrong', [{'match': r'^-dv .*ChatGPT\.app$',
                                         'stderr': 'Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n'},
                                        {'match': r'^-dv .*Computer Use\.app$',
                                         'stderr': 'Identifier=com.openai.sky.CUAService\nTeamIdentifier=OTHER\n'}]),
            ('identity lines with trailing space', [{'match': r'^-dv ',
                                                     'stderr': 'Identifier=com.openai.codex \nTeamIdentifier=2DC432GLL2\n'}])):
        sb.fake('codesign', rules=rules)
        _note(sb, f'--- {label}')
        _survey(sb)
    sb.fake('codesign', **fixtures_default_codesign())
    _note(sb, '--- codesign restored')
    _survey(sb)
    sb.remove_fake('codesign')
    _note(sb, '--- no codesign on PATH')
    _survey(sb)


def fixtures_default_codesign():
    import sandbox
    return sandbox.DEFAULT_FAKES['codesign']


@scenario('status/mac-app-path', hosts=MAC, normalise=TMP)
def _(sb):
    sb.place_release()
    real = _mac_app(sb)
    moved = sb.apps / 'Real.app'
    real.rename(moved)
    real.symlink_to(moved)
    _note(sb, '--- ChatGPT.app is a symlink')
    _survey(sb)
    real.unlink()
    moved.rename(real)
    descriptor = _descriptor_path(sb)
    text = descriptor.read_text()
    other = sb.apps / 'Other Name.app'
    shutil.copytree(real, other, symlinks=True)
    (sb.release / 'app').unlink()
    (sb.release / 'app').symlink_to(other)
    descriptor.write_text(text.replace(str(real), str(other)))
    _note(sb, '--- app not named ChatGPT.app')
    _survey(sb)
    (sb.release / 'app').unlink()
    (sb.release / 'app').symlink_to(real)
    descriptor.write_text(text)
    descriptor.write_text(json.dumps({**json.loads(text), 'platform': 'darwin', 'architecture': 'ppc'}))
    _note(sb, '--- unsupported architecture')
    _survey(sb)
    descriptor.write_text(text)
    (sb.release / 'app').unlink()
    (sb.release / 'app').symlink_to(other)
    _note(sb, '--- release app link points elsewhere than the descriptor')
    _survey(sb)


# -- app validation: Linux layout ---------------------------------------------------------------------------

def _linux_variants(sb):
    app = _linux_app(sb)
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    plugins = resources / 'plugins/openai-bundled/plugins'
    arch = fixtures.architecture()
    manifest = json.loads((runtime / 'manifest.json').read_text())
    yield 'baseline', _Mode0(app)
    for relative in ('ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl',
                     'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs', 'resources/codex',
                     'resources/codex-code-mode-host', 'resources/app.asar',
                     'resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
                     f'resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/{arch}/extension-host',
                     'resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
                     'resources/plugins/openai-bundled/plugins/browser'):
        yield f'missing: {relative}', _Swap(app / relative)
    yield 'missing: manifest', _Swap(runtime / 'manifest.json')
    yield 'manifest malformed', _Edit(runtime / 'manifest.json', '{nope')
    yield 'manifest not an object', _Edit(runtime / 'manifest.json', '[]')
    for label, document in (('wrong platform', {**manifest, 'platform': 'darwin'}),
                            ('wrong arch', {**manifest, 'arch': 'x64' if arch == 'arm64' else 'arm64'}),
                            ('no runtime version', {k: v for k, v in manifest.items() if k != 'runtime_archive_version'}),
                            ('blank runtime version', {**manifest, 'runtime_archive_version': '  '})):
        yield f'manifest {label}', _Edit(runtime / 'manifest.json', json.dumps(document))
    for relative in ('ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl', 'resources/codex',
                     'resources/codex-code-mode-host',
                     f'resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/{arch}/extension-host'):
        yield f'not executable: {relative}', _mode(app / relative, 0o644)
    yield 'codex layout ambiguous', _Dup(resources)
    yield 'app.asar garbage -> dpkg unavailable', _Edit(resources / 'app.asar', b'not an asar archive')
    yield 'app.asar empty', _Edit(resources / 'app.asar', b'')
    yield 'required file is a symlink', _Link(runtime / 'bin/node_repl')


class _Mode0:
    def __init__(self, path):
        pass

    def __enter__(self):
        pass

    def __exit__(self, *exc):
        pass


class _Link:
    """Replace a regular file with a symlink to a copy of it (required files must not be links)."""

    def __init__(self, path):
        self.path = Path(path)

    def __enter__(self):
        self.copy = self.path.with_name(self.path.name + '.target')
        self.path.rename(self.copy)
        self.path.symlink_to(self.copy.name)

    def __exit__(self, *exc):
        self.path.unlink()
        self.copy.rename(self.path)


@scenario('status/linux-app-validation', hosts=ANY, normalise=(*TMP, 'traceback'))
def _(sb):
    sb.place_release('linux')
    for label, change in _linux_variants(sb):
        _note(sb, f'--- {label}')
        with change:
            _survey(sb)


@scenario('status/linux-version-sources', hosts=ANY, normalise=(*TMP, 'traceback'))
def _(sb):
    # The app version comes from app.asar's package.json, or from dpkg when the asar cannot say.
    sb.place_release('linux')
    app = _linux_app(sb)
    asar = app / 'resources/app.asar'
    original = asar.read_bytes()
    good = fixtures.write_asar
    for label, package in (('plain version', {'name': 'chatgpt', 'version': '1.2.3'}),
                           ('version with plus and tilde', {'version': '1.0.0+build~1:x_y-z'}),
                           ('version with space', {'version': '1.0 beta'}),
                           ('version leading dot', {'version': '.1'}),
                           ('version not a string', {'version': 5}),
                           ('version missing', {'name': 'chatgpt'}),
                           ('package.json is a list', [1]),
                           ('empty version', {'version': ''})):
        good(asar, {'package.json': json.dumps(package).encode()})
        _note(sb, f'--- app.asar: {label}')
        sb.lcu('status', '--json')
    good(asar, {'other.txt': b'x'})
    _note(sb, '--- app.asar without package.json')
    sb.lcu('status')
    asar.write_bytes(b'\x00' * 40)
    _note(sb, '--- app.asar truncated')
    sb.lcu('status')
    owner = str(app / 'ChatGPT')
    sb.fake('dpkg-query', rules=[
        {'argv': ['-S'], 'stdout': f'chatgpt: {owner}\n'},
        {'argv': ['-W'], 'stdout': '9.8.7 arm64\n' if fixtures.architecture() == 'arm64' else '9.8.7 amd64\n'}])
    _note(sb, '--- dpkg owns the path')
    sb.lcu('status')
    sb.lcu('status', '--json')
    for label, rules in (
            ('arch package suffix and other lines', [
                {'argv': ['-S'], 'stdout': f'other: /elsewhere\nchatgpt:arm64: {owner}\nchatgpt-extra: /x\n'},
                {'argv': ['-W'], 'stdout': '9.8.7 arm64\n' if fixtures.architecture() == 'arm64' else '9.8.7 amd64\n'}]),
            ('two owners', [{'argv': ['-S'], 'stdout': f'chatgpt: {owner}\nchatgpt:arm64: {owner}\n'}]),
            ('owner is another package', [{'argv': ['-S'], 'stdout': f'notchatgpt: {owner}\n'}]),
            ('wrong architecture', [{'argv': ['-S'], 'stdout': f'chatgpt: {owner}\n'},
                                    {'argv': ['-W'], 'stdout': '9.8.7 s390x\n'}]),
            ('invalid version', [{'argv': ['-S'], 'stdout': f'chatgpt: {owner}\n'},
                                 {'argv': ['-W'], 'stdout': '!bad arm64\n'}]),
            ('malformed -W output', [{'argv': ['-S'], 'stdout': f'chatgpt: {owner}\n'},
                                     {'argv': ['-W'], 'stdout': 'just-one-field\n'}]),
            ('-S fails', [{'argv': ['-S'], 'exit': 1, 'stderr': 'dpkg-query: no path found\n'}]),
            ('-W fails', [{'argv': ['-S'], 'stdout': f'chatgpt: {owner}\n'}, {'argv': ['-W'], 'exit': 2}])):
        sb.fake('dpkg-query', rules=rules)
        _note(sb, f'--- dpkg: {label}')
        sb.lcu('status')
    sb.remove_fake('dpkg-query')
    _note(sb, '--- no dpkg-query on PATH')
    sb.lcu('status')
    asar.write_bytes(original)


# -- Linux trust (ownership, modes, links, ACLs): needs the container's real semantics ------------------------

def _trust_survey(sb):
    sb.lcu('status')
    sb.lcu('doctor', '--non-interactive')


@scenario('status/linux-trust-modes', hosts=LINUX, normalise=TMP)
def _(sb):
    sb.place_release('linux')
    app = _linux_app(sb)
    resources = app / 'resources'
    node_repl = resources / 'cua_node/bin/node_repl'
    tree_file = resources / 'cua_node/lib/node_modules/@oai/sky/package.json'
    plugin_file = resources / 'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json'
    unrelated = resources / 'unrelated.txt'
    unrelated.write_text('not part of any checked tree')
    cases = [
        ('world-writable app directory', app, 0o777),
        ('world-writable executable', node_repl, 0o777),
        ('group-writable executable (group has only trusted members)', node_repl, 0o775),
        ('world-writable file inside a checked tree', tree_file, 0o666),
        ('group-writable file inside a checked tree', tree_file, 0o664),
        ('world-writable plugin file', plugin_file, 0o666),
        ('world-writable ancestor (the apps directory)', sb.apps, 0o777),
        ('sticky world-writable ancestor is accepted', sb.apps, 0o1777),
        ('world-writable file outside the checked trees is ignored', unrelated, 0o666),
        ('read-only app directory', app, 0o555),
        ('setuid executable', node_repl, 0o4755),
        ('world-readable only', node_repl, 0o755),
    ]
    for label, path, mode in cases:
        previous = stat.S_IMODE(Path(path).stat().st_mode)
        Path(path).chmod(mode)
        try:
            _note(sb, f'--- {label}')
            _trust_survey(sb)
        finally:
            Path(path).chmod(previous)
    # More than three problems are summarised.
    files = sorted((resources / 'plugins/openai-bundled/plugins').rglob('*.json'))
    extra = [resources / 'cua_node/manifest.json', *files]
    changed = []
    try:
        for path in extra[:6]:
            changed.append((path, stat.S_IMODE(path.stat().st_mode)))
            path.chmod(0o666)
        _note(sb, f'--- {len(changed)} world-writable files')
        _trust_survey(sb)
    finally:
        for path, mode in changed:
            path.chmod(mode)


@scenario('status/linux-trust-links', hosts=LINUX, normalise=TMP)
def _(sb):
    sb.place_release('linux')
    app = _linux_app(sb)
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    outside = sb.root / 'outside'
    outside.mkdir()
    (outside / 'file').write_text('x')
    (runtime / 'lib/node_modules/inner').mkdir()
    cases = [
        ('link to a file inside the app', runtime / 'lib/node_modules/link-in', 'inner'),
        ('link to a directory inside the app', runtime / 'lib/node_modules/dir-link', '../node_modules/inner'),
        ('link to a file outside the app', runtime / 'lib/node_modules/link-out', str(outside / 'file')),
        ('relative link escaping the app', runtime / 'lib/node_modules/link-up', '../../../../../../outside/file'),
        ('broken link', runtime / 'lib/node_modules/broken', 'does-not-exist'),
        ('self-referencing link', runtime / 'lib/node_modules/self', 'self'),
        ('link to /', runtime / 'lib/node_modules/root', '/'),
        ('link to /etc/passwd (root-owned, outside)', runtime / 'lib/node_modules/passwd', '/etc/passwd'),
    ]
    for label, link, target in cases:
        link.symlink_to(target)
        try:
            _note(sb, f'--- {label}')
            _trust_survey(sb)
        finally:
            link.unlink()
    # Two links forming a cycle inside the app are ignored; a link to a world-writable directory is not.
    a, b = runtime / 'lib/node_modules/cycle-a', runtime / 'lib/node_modules/cycle-b'
    a.symlink_to('cycle-b')
    b.symlink_to('cycle-a')
    try:
        _note(sb, '--- link cycle')
        _trust_survey(sb)
    finally:
        a.unlink()
        b.unlink()
    inner = runtime / 'lib/node_modules/inner'
    inner.chmod(0o777)
    link = runtime / 'lib/node_modules/to-writable'
    link.symlink_to('inner')
    try:
        _note(sb, '--- link to a world-writable directory inside the app')
        _trust_survey(sb)
    finally:
        link.unlink()
        inner.chmod(0o755)
    # A required file reached through a directory link.
    real = runtime / 'bin.real'
    (runtime / 'bin').rename(real)
    (runtime / 'bin').symlink_to('bin.real')
    try:
        _note(sb, '--- bin is a link to a directory inside the app')
        _trust_survey(sb)
    finally:
        (runtime / 'bin').unlink()
        real.rename(runtime / 'bin')
    # A required file that resolves outside the app.
    saved = runtime / 'bin/node_repl'
    kept = saved.read_bytes()
    saved.unlink()
    (outside / 'node_repl').write_bytes(kept)
    (outside / 'node_repl').chmod(0o755)
    saved.symlink_to(outside / 'node_repl')
    try:
        _note(sb, '--- node_repl is a link outside the app')
        _trust_survey(sb)
    finally:
        saved.unlink()
        saved.write_bytes(kept)
        saved.chmod(0o755)
    _note(sb, '--- restored')
    _trust_survey(sb)


def _acl(entries, mask=None):
    """posix_acl_xattr: version 2, entries (tag, perm, id). 1 USER_OBJ 2 USER 4 GROUP_OBJ 8 GROUP 0x10 MASK 0x20 OTHER."""
    blob = struct.pack('<I', 2)
    for tag, perm, ident in entries:
        blob += struct.pack('<HHI', tag, perm, ident)
    return blob


@scenario('status/linux-trust-acl', hosts=LINUX, normalise=TMP)
def _(sb):
    sb.place_release('linux')
    node_repl = _linux_app(sb) / 'resources/cua_node/bin/node_repl'
    uid, gid = os.getuid(), os.getgid()
    base = [(1, 7, 0xFFFFFFFF), (4, 5, 0xFFFFFFFF), (0x20, 5, 0xFFFFFFFF)]
    cases = [
        ('named user 4242 with write', [(1, 7, 0xFFFFFFFF), (2, 7, 4242), (4, 5, 0xFFFFFFFF), (0x10, 7, 0xFFFFFFFF),
                                        (0x20, 5, 0xFFFFFFFF)]),
        ('named user 4242 with write but mask read-only', [(1, 7, 0xFFFFFFFF), (2, 7, 4242), (4, 5, 0xFFFFFFFF),
                                                            (0x10, 5, 0xFFFFFFFF), (0x20, 5, 0xFFFFFFFF)]),
        ('named user 4242 read only', [(1, 7, 0xFFFFFFFF), (2, 5, 4242), (4, 5, 0xFFFFFFFF), (0x10, 7, 0xFFFFFFFF),
                                       (0x20, 5, 0xFFFFFFFF)]),
        ('named user is this account', [(1, 7, 0xFFFFFFFF), (2, 7, uid), (4, 5, 0xFFFFFFFF), (0x10, 7, 0xFFFFFFFF),
                                        (0x20, 5, 0xFFFFFFFF)]),
        ('named user root', [(1, 7, 0xFFFFFFFF), (2, 7, 0), (4, 5, 0xFFFFFFFF), (0x10, 7, 0xFFFFFFFF),
                             (0x20, 5, 0xFFFFFFFF)]),
        ('named group 4242 with write (not in the account database)', [
            (1, 7, 0xFFFFFFFF), (4, 5, 0xFFFFFFFF), (8, 7, 4242), (0x10, 7, 0xFFFFFFFF), (0x20, 5, 0xFFFFFFFF)]),
        ('named group of this account with write', [
            (1, 7, 0xFFFFFFFF), (4, 5, 0xFFFFFFFF), (8, 7, gid), (0x10, 7, 0xFFFFFFFF), (0x20, 5, 0xFFFFFFFF)]),
    ]
    saved = None
    for label, entries in cases:
        blob = _acl(entries)
        try:
            os.setxattr(node_repl, 'system.posix_acl_access', blob)
        except OSError as exc:
            _note(sb, f'--- {label}: ACL not settable here ({exc.strerror}); skipped')
            continue
        try:
            _note(sb, f'--- {label}')
            _trust_survey(sb)
        finally:
            os.removexattr(node_repl, 'system.posix_acl_access')
            node_repl.chmod(0o755)
    for label, blob in (('truncated ACL blob', struct.pack('<I', 2) + b'\x00\x01'),
                        ('wrong ACL version', struct.pack('<I', 9))):
        try:
            os.setxattr(node_repl, 'system.posix_acl_access', blob)
        except OSError as exc:
            _note(sb, f'--- {label}: ACL not settable here ({exc.strerror}); skipped')
            continue
        try:
            _note(sb, f'--- {label}')
            _trust_survey(sb)
        finally:
            try:
                os.removexattr(node_repl, 'system.posix_acl_access')
            except OSError:
                pass
            node_repl.chmod(0o755)
