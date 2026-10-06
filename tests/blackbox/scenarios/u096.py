"""LCU 0.9.5/0.9.6 behaviour: `lcu origins`, the diagnostic log line in status/doctor, the Chrome relay refresh
after `lcu update`, the reconnect message, the macOS long-home doctor check and the Windows host analyzer.
"""
import json
from pathlib import Path

import fixtures_mgmt as fm

from . import scenario

ANY = ('darwin', 'linux')
DARWIN = ('darwin',)


def _note(sb, text):
    sb.run(['echo', text], label=text)


# -- lcu origins ---------------------------------------------------------------------------------------------

SESSION_A = '[origins]\nallowed = ["https://example.com", "http://localhost:8080"]\ndenied = ["https://bad.example"]\n'
SESSION_B = ('# kept comment\n[origins]\nallowed = []\ndenied = ["https://bad.example", "HTTPS://Bad.Example:443"]\n'
             '[other]\nkey = "value"\n')


def _sessions(sb, home=None):
    directory = (home or sb.home / '.codex') / 'browser/sessions'
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@scenario('origins/arguments', hosts=ANY)
def _(sb):
    sb.place_release()
    for args in (['--help'], ['-h'], ['list', '--help'], ['forget', '--help'], ['bogus'], ['forget'],
                 ['forget', 'https://x.example', '--session', 's', '--all-sessions'], ['list', '--session'],
                 ['--json']):
        sb.lcu('origins', *args)


@scenario('origins/list', hosts=ANY)
def _(sb):
    sb.place_release()
    sb.lcu('origins')
    sb.lcu('origins', 'list', '--json')
    directory = _sessions(sb)
    (directory / 's-one.toml').write_text(SESSION_A)
    (directory / 's_two.toml').write_text(SESSION_B)
    (directory / 'empty.toml').write_text('[origins]\nallowed = []\ndenied = []\n')
    (directory / 'not a session.toml').write_text(SESSION_A)
    (directory / 'notes.txt').write_text('ignored\n')
    sb.lcu('origins')
    sb.lcu('origins', 'list', '--json')
    sb.lcu('origins', 'list', '--session', 's-one')
    sb.lcu('origins', 'list', '--session', 'missing')
    sb.lcu('origins', 'list', '--session', 'bad/id')
    (directory / 'broken.toml').write_text('[origins\n')
    (directory / 'shape.toml').write_text('origins = 3\n')
    sb.lcu('origins')
    sb.lcu('origins', 'list', '--json')
    sb.lcu('origins', 'list', '--session', 'broken')


@scenario('origins/forget', hosts=ANY)
def _(sb):
    sb.place_release()
    sb.lcu('origins', 'forget', 'https://bad.example')
    directory = _sessions(sb)
    (directory / 's-one.toml').write_text(SESSION_A)
    (directory / 's_two.toml').write_text(SESSION_B)
    (directory / 's-one.toml').chmod(0o600)
    sb.lcu('origins', 'forget', 'https://bad.example')
    sb.lcu('origins', 'forget', 'https://bad.example')
    sb.lcu('origins', 'forget', 'https://example.com', '--session', 's-one')
    sb.lcu('origins', 'forget', 'https://example.com', '--session', 's-one', '--allowed')
    sb.lcu('origins', 'forget', 'http://LOCALHOST:8080/', '--allowed', '--denied', '--all-sessions')
    sb.lcu('origins', 'forget', 'https://x.example', '--session', 'missing')
    sb.lcu('origins', 'list', '--json')


@scenario('origins/origin-forms', hosts=ANY)
def _(sb):
    sb.place_release()
    directory = _sessions(sb)
    (directory / 's.toml').write_text('[origins]\nallowed = []\ndenied = ["https://example.com"]\n')
    for origin in ('example.com', 'ftp://example.com', 'https://user@example.com', 'https://example.com/path',
                   'https://example.com?q', 'https://example.com#f', 'https://exämple.com', 'https://[::1]:8443',
                   'https://[zz::1]', 'http://127.1', 'http://0x7f.0.0.1', 'http://10.0.0.1:80',
                   'https://example.com:0', 'https://example.com:65536', 'https://EXAMPLE.com.', 'https://a_b.example'):
        sb.lcu('origins', 'forget', origin, label=f'forget {origin}')


@scenario('origins/codex-home', hosts=ANY)
def _(sb):
    sb.place_release()
    custom = sb.work / 'codex-home'
    (_sessions(sb, custom) / 's.toml').write_text(SESSION_A)
    sb.lcu('origins', env={'CODEX_HOME': custom}, label='origins with CODEX_HOME')
    sb.lcu('origins', env={'CODEX_HOME': ''}, label='origins with empty CODEX_HOME')
    sb.lcu('origins', env={'CODEX_HOME': 'relative/home'}, label='origins with relative CODEX_HOME')
    sb.lcu('origins', 'forget', 'https://bad.example', env={'CODEX_HOME': custom}, label='forget with CODEX_HOME')


# -- diagnostic log --------------------------------------------------------------------------------------------

@scenario('diagnostic-log/status', hosts=ANY)
def _(sb):
    sb.place_release()
    sb.lcu('status')
    sb.lcu('status', '--json')
    sb.lcu('status', env={'LCU_DIAGNOSTIC_LOG': '0'}, label='status, log off')
    sb.lcu('status', '--json', env={'LCU_DIAGNOSTIC_LOG': '0'}, label='status --json, log off')
    sb.lcu('status', env={'LCU_DIAGNOSTIC_LOG': '1', 'LCU_LOG_DIR': sb.work / 'logs'}, label='status, LCU_LOG_DIR')
    sb.lcu('status', '--json', env={'XDG_STATE_HOME': sb.work / 'state'}, label='status --json, XDG_STATE_HOME')
    sb.lcu('status', env={'LCU_LOG_DIR': ''}, label='status, empty LCU_LOG_DIR')


@scenario('diagnostic-log/doctor', hosts=ANY, normalise=('tmpdir-suffix',))
def _(sb):
    sb.place_release()
    sb.lcu('doctor', '--non-interactive', env={'LCU_DIAGNOSTIC_LOG': '0'}, label='doctor, log off')
    sb.lcu('doctor', '--non-interactive', env={'LCU_LOG_DIR': sb.work / 'logs'}, label='doctor, LCU_LOG_DIR')


# -- macOS home folder too long for the Sky helper socket -------------------------------------------------------

@scenario('doctor/mac-socket-path', hosts=DARWIN)
def _(sb):
    sb.place_release('darwin')
    variable = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH'
    sb.lcu('doctor', '--non-interactive', env={variable: '/tmp/' + 'a' * 98}, label='override at 103 bytes')
    sb.lcu('doctor', '--non-interactive', env={variable: '/tmp/' + 'a' * 99}, label='override at 104 bytes')
    sb.lcu('doctor', '--non-interactive', env={variable: '/tmp/' + 'é' * 60}, label='override, multibyte')
    sb.lcu('doctor', '--non-interactive', env={variable: ''}, label='empty override (account home is short)')


# -- Chrome relay: reconnect message and refresh after an update ---------------------------------------------

@scenario('browser/reconnect-message', hosts=ANY)
def _(sb):
    sb.place_release()
    fm.chrome_plugin(sb)
    destination = fm.browser_destination(sb)
    sb.lcu('browser', 'install')
    sb.lcu('browser', 'status')
    sb.lcu('browser', 'status', '--browser', 'edge')
    fm.neutralise_relay(sb, destination)


@scenario('update/post-install-relay', hosts=ANY)
def _(sb):
    sb.place_release()
    destination = fm.browser_destination(sb)
    _note(sb, '--- no relay installed: nothing to refresh')
    sb.lcu('update', '--post-install')
    fm.chrome_plugin(sb)
    sb.lcu('browser', 'install')
    _note(sb, '--- relay current: refreshed in place')
    sb.lcu('update', '--post-install')
    _note(sb, '--- the app plugin changed: refreshed and the reconnect hint shown')
    plugin = fm.app_resources(sb) / 'plugins/openai-bundled/plugins/chrome'
    (plugin / 'scripts/new-file.txt').write_text('added by an app update\n')
    sb.lcu('update', '--post-install')
    _note(sb, '--- a manifest now points elsewhere: left alone')
    manifests = ([sb.home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json']
                 if fm.host() == 'darwin' else
                 [sb.home / '.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json'])
    for manifest in manifests:
        if manifest.is_file():
            data = json.loads(manifest.read_text())
            data['path'] = '/opt/other/native-host'
            manifest.write_text(json.dumps(data, indent=2) + '\n')
    sb.lcu('update', '--post-install')
    for manifest in manifests:
        fm.show(sb, manifest, f'manifest {manifest.parent.parent.name}')
    fm.neutralise_relay(sb, destination)


# -- Windows native-pipe host analyzer (a shipped JavaScript file, runnable off Windows) ------------------------

FACTORY_SOURCE = '''"use strict";
const path = require("node:path");
const zod = require("zod");
let counter = 0;
function helper(value) { counter += 1; return path.join(value, String(counter)); }
zod.register(helper);
function makeHost({codexCliPath, nativePipeDirectory, windowsHelperPath, windowsHelperTransportModulePath}) {
  return {nativePipeDirectory, closeActiveTurn: async () => helper(codexCliPath), dispose: async () => null};
}
function unrelated() { return require("electron"); }
'''


@scenario('windows-host/analyzer', hosts=ANY)
def _(sb):
    sb.place_release()
    node = sb.bb / 'tools/node'
    analyzer = sb.release / 'lcu/windows_host_analyze.cjs'
    requests = (
        ('host op', {'op': 'host', 'source': FACTORY_SOURCE}),
        ('no factory', {'op': 'host', 'source': 'function other() { return 1; }\n'}),
        ('unparseable', {'op': 'host', 'source': 'function ( {'}),
        ('eval in a dependency', {'op': 'host', 'source': FACTORY_SOURCE.replace('counter += 1;', 'eval("1");')}),
        ('reassigned outside', {'op': 'host', 'source': FACTORY_SOURCE + 'counter = 5;\n'}),
        ('requires op', {'op': 'requires', 'files': {'a.js': 'require("./b"); require("node:fs"); require(x);',
                                                      'b.js': 'module.exports = require("electron");'}}),
        ('unknown op', {'op': 'other'}),
    )
    for label, request in requests:
        sb.run([node, analyzer], stdin=json.dumps(request).encode(), label=f'analyzer: {label}')
    sb.run([node, analyzer], stdin=b'not json', label='analyzer: invalid JSON')
