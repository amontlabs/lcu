"""bin/lcu: the legacy `server/discover` compatibility mode, Linux sandbox/input configuration, and every way the
installed descriptor can be wrong (Linux, macOS and Windows descriptors, on any host)."""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path

import fixtures
import fixtures_rt as rt
from fixtures_rt import place, rt_scenario
from scenarios.rt_launch import INITIALIZE, STATUSES, _launch

COMPAT = '--mcp-discovery-compat'


def _discover(sb, ctx, label, stdin, **spec):
    probe = {'stdin': 'all', 'env': False, **spec.pop('probe', {})}
    return _launch(sb, ctx, label, COMPAT, probe=probe, stdin=stdin, **spec)


def _request(literal='1', **extra):
    body = '{"jsonrpc":"2.0","id":%s,"method":"server/discover"%s}' % (
        literal, ''.join(',"%s":%s' % item for item in extra.items()))
    return body + '\n'


@rt_scenario('rt/discovery/ids', normalise=STATUSES)
def _(sb):
    # The reply echoes the request id the way Python's json module renders it (ASCII-escaped, float repr, ...).
    ctx = place(sb, 'linux')
    for literal in ('1', '0', '-0', '-1', '"abc"', '""', '1.5', '1.0', '-0.0', '1e2', '1E2', '1e-7', '0.1',
                    '123456789.123456789', '12345678901234567890', '100000000000000000000.0', '1e21', '1e22',
                    '1.5e300', '1e400', '-1e400', 'NaN', 'Infinity', '-Infinity', '"é☃😀"', '"\\ud83d\\ude00"',
                    '"\\ud800"', '"a\\"b\\\\c\\n\\t\\u001f\\u007f/"', '"\\u00e9"', '"line\\u2028sep"',
                    '9007199254740993', '0.30000000000000004', '5e-324', '2.2250738585072014e-308'):
        _discover(sb, ctx, 'id ' + literal, _request(literal))


@rt_scenario('rt/discovery/bad-ids', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    for literal in ('true', 'false', 'null', '[]', '[1]', '{}', '{"a":1}'):
        _discover(sb, ctx, 'id ' + literal, _request(literal))
    for label, text in (
        ('no id', '{"jsonrpc":"2.0","method":"server/discover"}\n'),
        ('no jsonrpc', '{"id":1,"method":"server/discover"}\n'),
        ('jsonrpc 2.1', '{"jsonrpc":"2.1","id":1,"method":"server/discover"}\n'),
        ('jsonrpc number', '{"jsonrpc":2.0,"id":1,"method":"server/discover"}\n'),
        ('jsonrpc with space', '{"jsonrpc":"2.0 ","id":1,"method":"server/discover"}\n'),
        ('method initialize', INITIALIZE),
        ('method case', '{"jsonrpc":"2.0","id":1,"method":"server/Discover"}\n'),
        ('method missing', '{"jsonrpc":"2.0","id":1}\n'),
        ('method number', '{"jsonrpc":"2.0","id":1,"method":1}\n'),
        ('empty object', '{}\n'),
        ('array', '[1,2]\n'),
        ('string', '"server/discover"\n'),
        ('number', '1\n'),
        ('null', 'null\n'),
        ('true', 'true\n'),
        ('empty line', '\n'),
        ('spaces line', '   \n'),
    ):
        _discover(sb, ctx, label, text)


@rt_scenario('rt/discovery/request-forms', normalise=STATUSES)
def _(sb):
    # Forms of a valid probe that are accepted, and which bytes after the first newline reach the child.
    ctx = place(sb, 'linux')
    discover = _request()
    for label, stdin in (
        ('extra fields and params', _request(params='{"x":[1,2,{"y":null}]}', extra='"z"')),
        ('spaced', '{ "jsonrpc" : "2.0" , "id" : 5 , "method" : "server/discover" }\n'),
        ('keys reordered', '{"method":"server/discover","id":6,"jsonrpc":"2.0"}\n'),
        ('duplicate keys (last wins)', '{"jsonrpc":"2.0","id":1,"id":2,"method":"server/discover"}\n'),
        ('CRLF terminated', discover.replace('\n', '\r\n')),
        ('leading whitespace', '  \t' + discover),
        ('non-ASCII elsewhere', '{"jsonrpc":"2.0","id":"x","method":"server/discover","note":"é☃😀"}\n'),
        ('probe then initialize in the same write', discover + INITIALIZE),
        ('probe then two requests in the same write', discover + INITIALIZE + INITIALIZE),
        ('probe then partial line', discover + '{"jsonrpc":"2.0","id":2,'),
        ('probe then bytes without newline', discover + 'tail'),
        ('probe then blank lines', discover + '\n\n'),
        ('probe followed by NUL and binary', discover + '\x00\x01\x02'),
    ):
        _discover(sb, ctx, label, stdin)
    _discover(sb, ctx, 'probe then invalid UTF-8', [{'b64': base64.b64encode(discover.encode() + b'\xff\xfe\n').decode()}, {'close': True}])
    _discover(sb, ctx, 'UTF-8 BOM before the probe', [{'b64': base64.b64encode(b'\xef\xbb\xbf' + discover.encode()).decode()}, {'close': True}])
    _discover(sb, ctx, 'probe, pause, then initialize', [{'write': discover}, {'sleep': 1.0}, {'write': INITIALIZE}, {'close': True}])
    _discover(sb, ctx, 'probe written in three pieces', [{'write': discover[:10]}, {'sleep': 0.4}, {'write': discover[10:30]},
                                                          {'sleep': 0.4}, {'write': discover[30:]}, {'write': INITIALIZE}, {'close': True}])
    _discover(sb, ctx, 'probe then 300000 bytes in one burst', [{'write': discover}, {'fill': 300000}, {'close': True}])
    _discover(sb, ctx, 'probe, child echoes the rest', [{'write': discover + INITIALIZE}, {'close': True}], probe={'stdin': 'echo'})
    _discover(sb, ctx, 'reply is written before the child output', discover, probe={'print': 'child output\n'})
    _discover(sb, ctx, 'stdin from a file', None, stdinFile=discover + INITIALIZE)


@rt_scenario('rt/discovery/refusals', normalise=STATUSES)
def _(sb):
    # Anything but a proper probe stops the launch before the child exists.
    ctx = place(sb, 'linux')
    base = _request()
    for label, stdin in (
        ('empty stdin', ''), ('stdin /dev/null', None), ('only a newline', '\n'), ('no newline, EOF', base.strip()),
        ('whitespace, EOF', '  '), ('truncated JSON', '{"jsonrpc":"2.0",\n'), ('not JSON', 'hello\n'),
        ('trailing text after the object', base.strip() + ' x\n'), ('two objects on a line', base.strip() * 2 + '\n'),
        ('single quotes', "{'jsonrpc':'2.0'}\n"), ('trailing comma', '{"jsonrpc":"2.0","id":1,}\n'),
        ('comment', '{"jsonrpc":"2.0","id":1} // c\n'), ('unterminated string', '{"jsonrpc":"2.0","id":"x\n'),
        ('invalid escape', '{"jsonrpc":"2.0","id":"\\q"}\n'), ('control character in string', '{"a":"\t"}\n'),
        ('bare word', 'discover\n'), ('NaN literal object', '{"id":NaN}\n'), ('deep array', '[' * 400 + ']' * 400 + '\n'),
        ('emoji before a syntax error', '{"a":"😀"} x\n'), ('lone brace', '{\n'), ('unicode error position', '{"é":1,}\n'),
    ):
        _discover(sb, ctx, label, stdin)
    for label, raw in (
        ('invalid UTF-8', b'{"a":"\xff"}\n'), ('UTF-16 text', '{"a":1}\n'.encode('utf-16')),
        ('UTF-32 text', '{"a":1}\n'.encode('utf-32')), ('NUL byte', b'{"a":1}\x00\n'), ('lone 0xff', b'\xff\n'),
    ):
        _discover(sb, ctx, label, [{'b64': base64.b64encode(raw).decode()}, {'close': True}])


@rt_scenario('rt/discovery/size-limits', normalise=STATUSES)
def _(sb):
    # The probe line may be at most 1 MiB including its newline; the three failure regimes read differently.
    ctx = place(sb, 'linux')
    limit = 1024 * 1024
    for label, step in (
        ('exactly 1 MiB with newline', {'discover': {'total': limit}}),
        ('one byte over with newline', {'discover': {'total': limit + 1}}),
        ('one byte under', {'discover': {'total': limit - 1}}),
        ('1 MiB + 1 without newline, EOF', {'discover': {'total': limit + 1, 'newline': False}}),
        ('1 MiB without newline, EOF', {'discover': {'total': limit, 'newline': False}}),
        ('two MiB with newline', {'discover': {'total': 2 * limit}}),
    ):
        _discover(sb, ctx, label, [step, {'close': True}], timeout=60)


# -- Linux sandbox / input translation configuration ---------------------------------------------------------------
def _pair(version, runtime, **extra):
    return {'platform': 'linux', 'architecture': fixtures.architecture(), 'app_version': version, 'runtime': runtime,
            'lcu_version': '0.9.0', **extra}


@contextlib.contextmanager
def _file(path, content):
    path = Path(path)
    original = path.read_bytes() if path.exists() else None
    mode = path.stat().st_mode & 0o7777 if original is not None else None
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.write_text(content if isinstance(content, str) else json.dumps(content))
    try:
        yield
    finally:
        if original is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(original)
            path.chmod(mode)   # a restored executable stays executable (the launcher's gate checks the mode)


@rt_scenario('rt/launch/linux-sandbox', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    meta = json.dumps({'x-codex-turn-metadata': {'session_id': 's', 'turn_id': 't'}})
    for label, env in (
        ('default', {}),
        ('sandbox off', {'LCU_NODE_REPL_SANDBOX': 'off'}),
        ('sandbox OFF', {'LCU_NODE_REPL_SANDBOX': 'OFF'}),
        ('sandbox " off "', {'LCU_NODE_REPL_SANDBOX': ' off '}),
        ('sandbox host', {'LCU_NODE_REPL_SANDBOX': 'host'}),
        ('sandbox HOST', {'LCU_NODE_REPL_SANDBOX': ' Host'}),
        ('sandbox empty', {'LCU_NODE_REPL_SANDBOX': ''}),
        ('sandbox on', {'LCU_NODE_REPL_SANDBOX': 'on'}),
        ('sandbox off, request meta with a state already', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': json.dumps({'codex/sandbox-state-meta': {'permissionProfile': {'type': 'managed'}}})}),
        ('sandbox off, request meta other keys', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': meta}),
        ('sandbox off, request meta not JSON', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': 'nope'}),
        ('sandbox off, request meta a list', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': '[1]'}),
        ('sandbox off, request meta null', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': 'null'}),
        ('sandbox off, request meta empty', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': ''}),
        ('sandbox off, request meta {}', {'LCU_NODE_REPL_SANDBOX': 'off', 'NODE_REPL_REQUEST_META': '{}'}),
        ('sandbox off, non-ASCII cwd', {'LCU_NODE_REPL_SANDBOX': 'off'}),
        ('allowlist preset', {'NODE_REPL_UNTRUSTED_ENV_ALLOWLIST': 'FOO,BAR'}),
        ('allowlist preset empty', {'NODE_REPL_UNTRUSTED_ENV_ALLOWLIST': ''}),
        ('fault injection variable', {'LCU_TEST_SANDBOX_SHIM_FAULT': 'unrecognized-kernel'}),
        ('CODEX_CLI_PATH preset', {'CODEX_CLI_PATH': '/somewhere/codex'}),
        ('CODEX_CLI_PATH preset empty (no shim)', {'CODEX_CLI_PATH': ''}),
    ):
        cwd = sb.work / 'dïr ☃' if 'non-ASCII' in label else None
        if cwd:
            cwd.mkdir(exist_ok=True)
        _launch(sb, ctx, label, env=env, probe={'env': True}, cwd=str(cwd) if cwd else None)
    # the shim file or the Sky wrapper missing from the release: nothing is configured for them
    shim = ctx.release / 'bin/lcu-codex-sandbox'
    wrapper = ctx.release / 'lcu/linux_sky_service.mjs'
    with _file(shim, None):
        _launch(sb, ctx, 'no shim file', probe={'env': True})
    with _file(wrapper, None):
        _launch(sb, ctx, 'no Sky wrapper file', probe={'env': True})
    with _file(shim, None), _file(wrapper, None):
        _launch(sb, ctx, 'neither', probe={'env': True})


@rt_scenario('rt/launch/linux-input', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    for label, env in (
        ('translation off', {'LCU_LINUX_INPUT_TRANSLATION': 'off'}), ('translation OFF', {'LCU_LINUX_INPUT_TRANSLATION': 'OFF'}),
        ('translation 0', {'LCU_LINUX_INPUT_TRANSLATION': '0'}), ('translation false', {'LCU_LINUX_INPUT_TRANSLATION': ' False '}),
        ('translation no', {'LCU_LINUX_INPUT_TRANSLATION': 'no'}), ('translation 1', {'LCU_LINUX_INPUT_TRANSLATION': '1'}),
        ('translation yes', {'LCU_LINUX_INPUT_TRANSLATION': 'yes'}), ('translation empty', {'LCU_LINUX_INPUT_TRANSLATION': ''}),
        ('translation off, sandbox host', {'LCU_LINUX_INPUT_TRANSLATION': 'off', 'LCU_NODE_REPL_SANDBOX': 'host'}),
        ('browser surface only (no wrapper)', {'CUA_REPL_ENABLED_SURFACES': 'browser'}),
        ('both surfaces', {'CUA_REPL_ENABLED_SURFACES': 'browser,computer'}),
    ):
        _launch(sb, ctx, label, env=env, probe={'env': True})
    pair = _pair(fixtures.VERSION, fixtures.RUNTIME)
    for label, record in (
        ('tested pair with native gtk4', {'format': 1, 'entries': [{**pair, 'native_input': ['gtk4']}]}),
        ('tested pair with native gtk4 and qt-scroll (no wrapper)', {'format': 1, 'entries': [{**pair, 'native_input': ['gtk4', 'qt-scroll']}]}),
        ('tested pair with native qt-scroll', {'format': 1, 'entries': [{**pair, 'native_input': ['qt-scroll']}]}),
        ('tested pair with empty native_input', {'format': 1, 'entries': [{**pair, 'native_input': []}]}),
        ('tested pair without native_input', {'format': 1, 'entries': [pair]}),
        ('another pair has native input', {'format': 1, 'entries': [{**_pair('1.0', 'x'), 'native_input': ['gtk4']}]}),
        ('invalid native_input value', {'format': 1, 'entries': [{**pair, 'native_input': ['gtk3']}]}),
        ('wrong format', {'format': 2, 'entries': [pair]}),
        ('not JSON', 'not json'),
        ('missing record', None),
    ):
        with _file(ctx.release / 'tested-versions.json', record):
            _launch(sb, ctx, 'tested-versions: ' + label, probe={'env': True})
    for key in ('app_sha256',):
        with _file(ctx.release / 'tested-versions.json', {'format': 1, 'entries': [{**pair, 'native_input': ['gtk4'], key: 'xyz'}]}):
            _launch(sb, ctx, 'tested-versions: bad sha entry', probe={'env': True})


@rt_scenario('rt/launch/linux-services', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    wrapper = str(ctx.release / 'lcu/linux_sky_service.mjs')
    for label, services in (
        ('services not JSON', 'nope'), ('services empty string', ''), ('services null', 'null'), ('services list', '[]'),
        ('services number', '1'), ('services empty map', '{}'), ('sky original', '{"sky":"@oai/sky/service"}'),
        ('sky is the wrapper already', json.dumps({'sky': wrapper})), ('sky custom', '{"sky":"custom"}'),
        ('sky custom plus browser', '{"sky":"custom","browser":"@oai/browser-desktop/service"}'),
        ('browser only', '{"browser":"@oai/browser-desktop/service"}'),
        ('sky original plus extra service', '{"sky":"@oai/sky/service","x":"y","z":"w"}'),
        ('sky non-string', '{"sky":1}'), ('sky null', '{"sky":null}'), ('extra non-string value', '{"sky":"@oai/sky/service","x":1}'),
        ('unicode key and value', '{"sky":"@oai/sky/service","é☃":"😀"}'),
        ('whitespace and key order', '{ "z" : "1", "sky" : "@oai/sky/service" , "a":"2"}'),
        ('duplicate sky key', '{"sky":"custom","sky":"@oai/sky/service"}'),
        ('NaN value', '{"sky":"@oai/sky/service","n":NaN}'),
    ):
        _launch(sb, ctx, label, env={'NODE_REPL_TRUSTED_SERVICES': services}, probe={'env': True})
        _launch(sb, ctx, label + ', --chrome', '--chrome', env={'NODE_REPL_TRUSTED_SERVICES': services}, probe={'env': True})
        _launch(sb, ctx, label + ', sandbox off', env={'NODE_REPL_TRUSTED_SERVICES': services, 'LCU_NODE_REPL_SANDBOX': 'off'},
                probe={'env': False})
    _launch(sb, ctx, 'browser surface adds the browser service', '--chrome', probe={'env': True})
    _launch(sb, ctx, 'surfaces browser only', env={'CUA_REPL_ENABLED_SURFACES': 'browser'}, probe={'env': True})


# -- descriptor problems ---------------------------------------------------------------------------------------------
def _both(sb, ctx, label):
    sb.run([ctx.lcu, '--version'], label=label + ': --version')
    _launch(sb, ctx, label + ': launch', probe={'env': False})


@rt_scenario('rt/launch/descriptor-errors-linux', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    descriptor = ctx.release / 'installation.json'
    good = json.loads(descriptor.read_text())
    for label, content in (
        ('no installation.json', None), ('installation.json not JSON', '{'), ('installation.json empty file', ''),
        ('empty object', {}), ('app relative', {**good, 'app': 'app'}), ('app elsewhere', {**good, 'app': '/nonexistent/app'}),
        ('app empty string', {**good, 'app': ''}),
        ('no architecture', {k: v for k, v in good.items() if k != 'architecture'}),
        ('architecture x64 vs arm64', {**good, 'architecture': 'x64' if good['architecture'] == 'arm64' else 'arm64'}),
        ('architecture unknown', {**good, 'architecture': 'riscv64'}), ('architecture null', {**good, 'architecture': None}),
        ('platform plan9', {**good, 'platform': 'plan9'}), ('platform null', {**good, 'platform': None}),
        ('platform darwin on a Linux app', {**good, 'platform': 'darwin'}),
        ('platform LINUX', {**good, 'platform': 'LINUX'}),
        ('package_version differs (ignored on launch)', {**good, 'package_version': '0.0.1'}),
        ('extra keys', {**good, 'extra': {'a': [1, 2]}}),
    ):
        with _file(descriptor, content if content != {} else '{}'):
            _both(sb, ctx, label)
    lock = ctx.release / 'runtime.lock.json'
    for label, content in (('no runtime.lock.json', None), ('runtime.lock.json not JSON', 'x')):
        with _file(lock, content):
            _both(sb, ctx, label)
    with _file(ctx.release / 'bundle.json', None):
        _both(sb, ctx, 'no bundle.json')
    app = sb.apps / 'chatgpt'
    for relative in ('ChatGPT', 'resources/codex', 'resources/codex-code-mode-host', 'resources/app.asar',
                     'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl',
                     'resources/cua_node/manifest.json',
                     'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
                     f'resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/{fixtures.architecture()}/extension-host',
                     'resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
                     'resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'):
        with _file(app / relative, None):
            _both(sb, ctx, f'app file missing: {relative}')
    manifest = app / 'resources/cua_node/manifest.json'
    for label, content in (
        ('manifest wrong platform', {'platform': 'darwin', 'arch': fixtures.architecture(), 'runtime_archive_version': fixtures.RUNTIME}),
        ('manifest wrong arch', {'platform': 'linux', 'arch': 'sparc', 'runtime_archive_version': fixtures.RUNTIME}),
        ('manifest no version', {'platform': 'linux', 'arch': fixtures.architecture()}),
        ('manifest blank version', {'platform': 'linux', 'arch': fixtures.architecture(), 'runtime_archive_version': '  '}),
        ('manifest version number', {'platform': 'linux', 'arch': fixtures.architecture(), 'runtime_archive_version': 7}),
        ('manifest not JSON', '{'),
    ):
        with _file(manifest, content):
            _both(sb, ctx, label)
    # a descriptor naming a different but valid app directory than the release's app link
    with _file(app / 'resources/cua_node/bin/node_repl', '#!/bin/sh\nexit 0\n'):
        os.chmod(app / 'resources/cua_node/bin/node_repl', 0o644)
        _both(sb, ctx, 'node_repl not executable')
        os.chmod(app / 'resources/cua_node/bin/node_repl', 0o755)


@rt_scenario('rt/launch/descriptor-app-link', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    link = ctx.release / 'app'
    target = os.readlink(link)
    other = sb.work / 'other-app'
    other.mkdir()
    link.unlink()
    link.symlink_to('/nonexistent/app')
    _both(sb, ctx, 'app link dangling')
    link.unlink()
    link.symlink_to(other)
    _both(sb, ctx, 'app link points at an empty directory')
    link.unlink()
    link.symlink_to(target)
    holder = sb.work / 'holder'
    holder.symlink_to(target)
    link.unlink()
    link.symlink_to(holder)
    _both(sb, ctx, 'app link through another symlink (same app)')
    link.unlink()
    link.symlink_to(target)
    _both(sb, ctx, 'app link restored')


@rt_scenario('rt/launch/descriptor-errors-windows', normalise=STATUSES)
def _(sb):
    # A Windows descriptor on a POSIX host: every check before the Windows-only validation is reachable.
    ctx = place(sb, 'linux')
    descriptor = ctx.release / 'installation.json'
    digest = 'a' * 64
    prefix = ctx.release.parent.parent
    generation = prefix / 'apps' / digest
    base = {'platform': 'windows', 'architecture': 'x64', 'app': str(generation / 'app'), 'package_version': '26.1.1.0',
            'runtime': '0.0.1', 'sha256': digest}
    inventory = {'.': {'type': 'directory'}}
    inventory_digest = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    cases = [
        ('empty windows descriptor', {'platform': 'windows'}),
        ('architecture arm64', {**base, 'architecture': 'arm64'}),
        ('no package_version', {k: v for k, v in base.items() if k != 'package_version'}),
        ('empty package_version', {**base, 'package_version': ''}),
        ('package_version number', {**base, 'package_version': 3}),
        ('no runtime', {k: v for k, v in base.items() if k != 'runtime'}),
        ('sha256 too short', {**base, 'sha256': 'abc'}),
        ('sha256 upper case', {**base, 'sha256': 'A' * 64}),
        ('sha256 not hex', {**base, 'sha256': 'g' * 64}),
        ('app relative', {**base, 'app': 'apps/x/app'}),
        ('app is not the generation', {**base, 'app': '/somewhere/else'}),
        ('generation without inventory', base),
    ]
    for label, content in cases:
        with _file(descriptor, content):
            _both(sb, ctx, 'windows: ' + label)
    generation.mkdir(parents=True)
    (generation / 'app').mkdir()
    inventory_file = generation / 'inventory.json'
    for label, text in (('inventory not JSON', 'x'), ('inventory empty', ''),
                        ('inventory digest mismatch', json.dumps({'.': {'type': 'file'}}))):
        inventory_file.write_text(text)
        with _file(descriptor, base):
            _both(sb, ctx, 'windows: ' + label)
    inventory_file.write_text(json.dumps(inventory))
    good = {**base, 'sha256': inventory_digest}
    new_generation = prefix / 'apps' / inventory_digest
    generation.rename(new_generation)
    good['app'] = str(new_generation / 'app')
    with _file(descriptor, good):
        _both(sb, ctx, 'windows: consistent descriptor (validation needs Windows)')
    with _file(descriptor, good):
        (new_generation / 'app').rmdir()
        (new_generation / 'app').symlink_to(sb.work)
        _both(sb, ctx, 'windows: app is a symlink')
    with _file(descriptor, good):
        (new_generation / 'app').unlink()
        (new_generation / 'app').mkdir()
        apps = prefix / 'apps'
        moved = prefix / 'apps-real'
        apps.rename(moved)
        apps.symlink_to(moved)
        _both(sb, ctx, 'windows: apps directory is a symlink')
