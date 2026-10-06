"""`lcu apps`: argument parsing, the approvals store bytes, name/id/path resolution, owner authentication.

macOS only (the command refuses elsewhere). Apps are fake bundles under the sandbox HOME's ~/Applications (one of
the five directories LCU scans); the Touch ID helper is a recorder, so every authentication request (its reason
argument) is in the recorder log. Real /Applications and /System/Applications are scanned too, so scenarios use
made-up names and ids except where a system id is the point (Terminal, forbidden).
"""
import json
import os
import stat

import fixtures
import fixtures_mgmt as fm

from . import scenario

MAC = ('darwin',)
LINUX = ('linux',)
KEY = 'approvedBundleIdentifiers'


def _write(sb, *args, **kw):
    """An allow/revoke command followed by the exact store bytes and mode it left."""
    result = sb.lcu('apps', *args, **kw)
    fm.show_store(sb)
    return result


def _prepare(sb, *, helper=True):
    sb.place_release()
    if helper:
        fm.auth_helper(sb)
    (sb.home / 'Applications').mkdir(parents=True, exist_ok=True)
    return sb.home / 'Applications'


@scenario('apps/linux-gate', hosts=LINUX)
def _(sb):
    # The platform gate runs before argument parsing: even --help prints the macOS-only message.
    sb.place_release()
    sb.lcu('apps')
    sb.lcu('apps', '--help')
    _write(sb, 'allow', 'Zed')
    sb.lcu('apps', '--bogus')


@scenario('apps/help', hosts=MAC)
def _(sb):
    _prepare(sb)
    for args in (['--help'], ['-h'], ['list', '--help'], ['allow', '--help'], ['revoke', '--help'],
                 ['list', '-h'], ['allow', '-h']):
        sb.lcu('apps', *args)


@scenario('apps/usage-errors', hosts=MAC)
def _(sb):
    _prepare(sb)
    for args in (['bogus'], ['allow'], ['revoke'], ['--bogus'], ['list', '--bogus'], ['list', 'extra'],
                 ['allow', 'a', 'b'], ['-x'], ['list', '--json', '--json'], ['--json', 'allow'], ['Zed']):
        sb.lcu('apps', *args)


@scenario('apps/list-empty', hosts=MAC)
def _(sb):
    _prepare(sb)
    sb.lcu('apps')
    sb.lcu('apps', 'list')
    sb.lcu('apps', '--json')
    sb.lcu('apps', 'list', '--json')
    fm.write_store(sb, '{}\n')
    sb.lcu('apps')
    fm.write_store(sb, {KEY: []})
    sb.lcu('apps', '--json')
    fm.write_store(sb, '')
    sb.lcu('apps')
    # No store was ever written by a read-only command.


@scenario('apps/list-rows', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    fm.app_bundle(apps, 'beta-file', 'org.bbtest.beta', display='Beta Display')
    fm.app_bundle(apps, 'Zeta', 'org.bbtest.zeta', bundle_name='Zeta Bundle Name', binary=True)
    fm.app_bundle(apps, 'Café Noir', 'org.bbtest.cafe')
    fm.app_bundle(apps, 'Vivaldi Fake', 'com.vivaldi.Vivaldi', display='Vivaldi')
    fm.write_store(sb, {KEY: ['org.bbtest.zeta', 'org.bbtest.alpha', 'org.bbtest.gone', 'org.bbtest.cafe',
                              'org.bbtest.beta', 'com.vivaldi.Vivaldi', 'com.bbtest.NotInstalledEither',
                              'com.apple.Terminal']})
    sb.lcu('apps')
    sb.lcu('apps', 'list', '--json')
    # Unicode names: width is counted in code points, JSON output is ASCII-escaped.
    fm.write_store(sb, {KEY: ['org.bbtest.cafe', 'org.bbtest.alpha']})
    sb.lcu('apps')
    sb.lcu('apps', '--json')


@scenario('apps/store-formats', hosts=MAC)
def _(sb):
    # What read_store accepts: BOM, UTF-16, duplicate keys, NaN, extra keys; each with `list --json`.
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    doc = json.dumps({KEY: ['org.bbtest.alpha']})
    for label, data in (('utf-8 bom', b'\xef\xbb\xbf' + doc.encode()),
                        ('utf-16', doc.encode('utf-16')),
                        ('utf-32 le', doc.encode('utf-32-le')),
                        ('duplicate key last wins', ('{"%s": ["x.y"], "%s": ["org.bbtest.alpha"]}' % (KEY, KEY)).encode()),
                        ('nan elsewhere', ('{"n": NaN, "%s": ["org.bbtest.alpha"]}' % KEY).encode()),
                        ('trailing garbage newline', (doc + '\n\n').encode()),
                        ('no key', b'{"other": 1}'),
                        ('empty list', ('{"%s": []}' % KEY).encode())):
        fm.write_store(sb, data)
        sb.run(['echo', f'--- {label}'], label=f'store: {label}')
        sb.lcu('apps', 'list')


@scenario('apps/store-invalid', hosts=MAC)
def _(sb):
    # A damaged store is never overwritten: every command reports it and exits 1, the bytes stay.
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    for label, data in (('not json', b'not json'),
                        ('array', b'[]'),
                        ('key is object', ('{"%s": {}}' % KEY).encode()),
                        ('non-string item', ('{"%s": ["a", 3]}' % KEY).encode()),
                        ('null', b'null'),
                        ('latin-1 bytes', b'{"\xe9": 1}'),
                        ('truncated', ('{"%s": ["org.bbtest.alpha"' % KEY).encode())):
        fm.write_store(sb, data)
        sb.run(['echo', f'--- {label}'], label=f'store: {label}')
        sb.lcu('apps', 'list')
        _write(sb, 'allow', 'Bbtest Alpha')
        _write(sb, 'revoke', 'org.bbtest.alpha')
    # Unreadable file (a directory in its place, then a mode-000 file).
    path = fm.store_path(sb)
    path.unlink()
    path.mkdir()
    sb.run(['echo', '--- directory'], label='store: directory')
    sb.lcu('apps', 'list')
    path.rmdir()
    fm.write_store(sb, {KEY: []}, 0o000)
    sb.run(['echo', '--- mode 000'], label='store: mode 000')
    sb.lcu('apps', 'list')
    path.chmod(0o644)


@scenario('apps/allow', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    fm.app_bundle(apps, 'beta-file', 'org.bbtest.beta', display='Beta Display')
    _write(sb, 'allow', 'bbtest alpha')            # name, case-insensitive; first write creates dir + 0600 file
    _write(sb, 'allow', 'org.bbtest.alpha')        # already allowed by id
    _write(sb, 'allow', 'Beta Display')            # display name differing from the file stem
    _write(sb, 'allow', 'BETA-FILE')               # file stem, upper case
    sb.lcu('apps', '--json')
    # A store the user keeps with other permissions and keys: mode is copied, unknown keys and order survive.
    fm.write_store(sb, '{\n  "zz": 1,\n  "3": "three",\n  "%s": ["old.id"],\n  "unicode": "café ☃"\n}\n' % KEY,
                   0o644)
    fm.app_bundle(apps, 'Gamma', 'org.bbtest.gamma')
    _write(sb, 'allow', 'Gamma')
    sb.lcu('apps', 'list')
    fm.write_store(sb, '{"%s": ["old.id"], "last": true}' % KEY, 0o640)   # no trailing newline, other mode
    _write(sb, 'allow', 'org.bbtest.gamma')


@scenario('apps/allow-by-path', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    elsewhere = sb.work / 'Elsewhere'
    elsewhere.mkdir()
    fm.app_bundle(elsewhere, 'Path App', 'org.bbtest.path')
    fm.app_bundle(apps, 'Home App', 'org.bbtest.home')
    _write(sb, 'allow', elsewhere / 'Path App.app')
    _write(sb, 'allow', str(elsewhere / 'Path App.app') + '/')       # trailing slash
    _write(sb, 'allow', '~/Applications/Home App.app')               # ~ expansion
    _write(sb, 'allow', 'Applications/Home App.app', cwd=sb.home)    # relative path containing '/'
    _write(sb, 'allow', 'Missing.app')
    _write(sb, 'allow', elsewhere / 'Nope.app')
    (elsewhere / 'Plain.app').mkdir()
    _write(sb, 'allow', elsewhere / 'Plain.app')                      # no Info.plist
    fm.app_bundle(elsewhere, 'NoId', None, info={'CFBundleName': 'NoId'})
    _write(sb, 'allow', elsewhere / 'NoId.app')
    fm.app_bundle(elsewhere, 'EmptyId', None, info={'CFBundleIdentifier': ''})
    _write(sb, 'allow', elsewhere / 'EmptyId.app')
    fm.app_bundle(elsewhere, 'IntId', None, info={'CFBundleIdentifier': 5})
    _write(sb, 'allow', elsewhere / 'IntId.app')
    (elsewhere / 'Bad.app/Contents').mkdir(parents=True)
    (elsewhere / 'Bad.app/Contents/Info.plist').write_text('this is not a plist')
    _write(sb, 'allow', elsewhere / 'Bad.app')
    (elsewhere / 'afile.app').write_text('x')
    _write(sb, 'allow', elsewhere / 'afile.app')                      # a file, not a bundle
    sb.lcu('apps', 'list')


@scenario('apps/allow-refusals', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Twin', 'org.bbtest.twin.one', display='Twin')
    elsewhere = sb.home / 'Applications'
    fm.app_bundle(elsewhere, 'Twin Copy', 'org.bbtest.twin.two', display='Twin')
    fm.app_bundle(apps, 'High Vivaldi', 'com.vivaldi.Vivaldi', display='Vivaldi')
    fm.app_bundle(apps, 'High Chromium', 'org.chromium.Chromium', display='Chromium')
    fm.app_bundle(apps, 'Fake ChatGPT', 'com.openai.codex', display='ChatGPT')
    _write(sb, 'allow', 'Twin')                       # several apps match
    _write(sb, 'allow', 'Terminal')                   # forbidden (system app)
    _write(sb, 'allow', 'com.apple.Terminal')
    _write(sb, 'allow', 'ChatGPT')
    _write(sb, 'allow', 'com.openai.codex')
    _write(sb, 'allow', 'com.apple.UserNotificationCenter')
    _write(sb, 'allow', 'com.googlecode.iterm2')      # forbidden even when not installed
    _write(sb, 'allow', 'org.bbtest.missing.id')      # not installed
    _write(sb, 'allow', 'No Such App Bbtest')         # unknown name
    _write(sb, 'allow', 'Vivaldi')                    # high risk: warning, reason suffix
    _write(sb, 'allow', 'org.chromium.Chromium')
    _write(sb, 'allow', 'vivaldi')                    # already allowed, no warning, no auth
    sb.lcu('apps', 'list')
    sb.lcu('apps', '--json')


@scenario('apps/auth', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    fm.app_bundle(apps, 'Bbtest Beta', 'org.bbtest.beta')
    fm.app_bundle(apps, 'Bbtest Gamma', 'org.bbtest.gamma')
    fm.app_bundle(apps, 'Bbtest Delta', 'org.bbtest.delta')
    sb.fake('lcu-owner-auth', rules=[
        {'match': r'control Bbtest Beta', 'exit': 1},
        {'match': r'control Bbtest Gamma', 'exit': 2, 'stderr': 'no graphical login session is active\n\n'},
        {'match': r'control Bbtest Delta', 'exit': 64},
    ], default={})
    _write(sb, 'allow', 'Bbtest Alpha')    # approved
    _write(sb, 'allow', 'Bbtest Beta')     # cancelled
    _write(sb, 'allow', 'Bbtest Gamma')    # unavailable, stderr as detail
    _write(sb, 'allow', 'Bbtest Delta')    # exit 64 without stderr: "exit status 64"
    sb.lcu('apps', 'list')
    _write(sb, 'revoke', 'Bbtest Alpha')   # revoke reason text; approved
    sb.fake('lcu-owner-auth', default={'exit': 1})
    _write(sb, 'allow', 'Bbtest Alpha')
    _write(sb, 'revoke', 'Bbtest Alpha')   # cancelled: nothing changes
    sb.lcu('apps', 'list')


@scenario('apps/auth-helper-problems', hosts=MAC)
def _(sb):
    apps = _prepare(sb, helper=False)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    _write(sb, 'allow', 'Bbtest Alpha')                                  # helper missing
    fm.auth_helper(sb, mode=0o644)
    _write(sb, 'allow', 'Bbtest Alpha')                                  # not executable
    (sb.release / 'bin/lcu-owner-auth').unlink()
    (sb.release / 'bin/lcu-owner-auth').mkdir()
    _write(sb, 'allow', 'Bbtest Alpha')                                  # a directory
    (sb.release / 'bin/lcu-owner-auth').rmdir()
    fixtures.write(sb.release / 'bin/lcu-owner-auth', 'not a program\n', 0o755)
    _write(sb, 'allow', 'Bbtest Alpha')                                  # cannot be executed (no interpreter line)
    fixtures.write(sb.release / 'bin/lcu-owner-auth', '#!/nonexistent/interpreter\n', 0o755)
    _write(sb, 'allow', 'Bbtest Alpha')
    sb.lcu('apps', 'list')


@scenario('apps/revoke', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Bbtest Alpha', 'org.bbtest.alpha')
    fm.app_bundle(apps, 'Bbtest Beta', 'org.bbtest.beta', display='Beta Name')
    fm.write_store(sb, {KEY: ['org.bbtest.alpha', 'org.bbtest.beta', 'com.bbtest.uninstalled', 'org.bbtest.keep'],
                        'other': {'x': [1, 2]}, 'café': '☃'})
    _write(sb, 'revoke', 'bbtest alpha')            # by name (casefold)
    _write(sb, 'revoke', 'bbtest alpha')            # now absent: not an error, no auth
    _write(sb, 'revoke', 'Beta Name')               # by display name
    _write(sb, 'revoke', 'com.bbtest.uninstalled')  # uninstalled id: bare id label
    _write(sb, 'revoke', 'Unknown Bbtest Thing')    # not among approved
    _write(sb, 'revoke', 'org.bbtest.alpha')        # installed but not approved any more
    sb.lcu('apps', 'list')
    _write(sb, 'revoke', 'org.bbtest.keep')         # last one: empty list keeps the other keys
    sb.lcu('apps', '--json')


@scenario('apps/revoke-ambiguous', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Twin One', 'org.bbtest.twin.one', display='Twin')
    fm.app_bundle(apps, 'Twin Two', 'org.bbtest.twin.two', display='Twin')
    fm.write_store(sb, {KEY: ['org.bbtest.twin.one', 'org.bbtest.twin.two']})
    _write(sb, 'revoke', 'Twin')                    # several approved apps
    _write(sb, 'revoke', 'org.bbtest.twin.one')     # id wins
    _write(sb, 'revoke', 'Twin')                    # now unique among approved
    sb.lcu('apps', 'list')


@scenario('apps/plist-edge', hosts=MAC)
def _(sb):
    apps = _prepare(sb)
    fm.app_bundle(apps, 'Binary App', 'org.bbtest.binary', display='Bïnary', binary=True)
    fm.app_bundle(apps, 'Display Empty', 'org.bbtest.emptydisplay', info={
        'CFBundleIdentifier': 'org.bbtest.emptydisplay', 'CFBundleDisplayName': '', 'CFBundleName': 'Fallback Name'})
    fm.app_bundle(apps, 'Stem Fallback', 'org.bbtest.stem', info={'CFBundleIdentifier': 'org.bbtest.stem'})
    fm.app_bundle(apps, 'Num Name', 'org.bbtest.num', info={'CFBundleIdentifier': 'org.bbtest.num',
                                                          'CFBundleDisplayName': 42})
    # Case folding is Unicode full case folding: a German sharp s matches its folded form.
    fm.app_bundle(apps, 'Straße', 'org.bbtest.strasse')
    for query in ('BÏNARY', 'fallback name', 'stem fallback', '42', 'STRASSE', 'strasse', 'Straße'):
        _write(sb, 'allow', query)
    sb.lcu('apps', 'list')
    sb.lcu('apps', '--json')
