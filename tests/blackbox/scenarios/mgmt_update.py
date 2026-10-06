"""`lcu update`: the release check, cache and notices, hook output, the apply step (download, checksum, extraction
guards, prompts, non-writable prefix), the installer hand-off and post-install refresh.

LCU's URLs are hard-coded (github.com, raw.githubusercontent.com) with no override, so every command gets
`https_proxy` pointing at a local CONNECT proxy (assets/mgmt/fixture_server.py) that terminates TLS with a test CA.
Python is told to trust that CA with SSL_CERT_FILE (Node: NODE_EXTRA_CA_CERTS). Without it, certificate
verification fails and LCU falls back to the system `curl`, which the curl-fallback scenarios run through a
recording wrapper that trusts only the test CA. Archives are built from the implementation tree under test.

Everything up to the installer runs on every host. Running the real installer (scripts/install*.py from the
downloaded archive) writes the OS account home, so those scenarios run only in the disposable container.
"""
import gzip
import json
import os
from pathlib import Path
import shutil
import time

import fixtures
import fixtures_mgmt as fm

from . import scenario

ANY = ('darwin', 'linux')
LINUX = ('linux',)
NORMALISE = ('tmpdir-suffix', 'release-id', 'account')


def _note(sb, text):
    sb.run(['echo', text], label=text)


def _bump(version, index=2, by=1):
    parts = [int(p) for p in version.split('.')]
    parts[index] += by
    for i in range(index + 1, len(parts)):
        parts[i] = 0
    return '.'.join(map(str, parts))


def _current():
    return fixtures.BUNDLE_VERSION


def _show_cache(sb):
    for name in ('update.json', 'announced.json', 'refresh.stamp'):
        fm.show_scrubbed(sb, fm.cache_dir(sb) / name, f'cache {name}')


def _claim_refresh(sb):
    """A fresh refresh.stamp: --notice on a stale cache then starts no background refresh (which would write the
    cache at an unpredictable time)."""
    fixtures.write(fm.cache_dir(sb) / 'refresh.stamp', '')


def _rename_kept(sb):
    """Kept extractions are `lcu-update-<random>`; give them names in creation order so the tree sorts stably
    (still 8 characters, so the tmpdir-suffix normaliser shows them all as <RANDOM>)."""
    for path in sorted(sb.tmp.glob('lcu-update-*')):
        if not path.name.startswith('lcu-update-kept'):
            index = len(list(sb.tmp.glob('lcu-update-kept*'))) + 1
            # The kept archive is built from the implementation under test: keep the file, not its bytes.
            for archive in path.glob('*.tar.gz'):
                archive.write_bytes(b'(archive bytes elided: built from the implementation under test)\n')
            path.rename(sb.tmp / f'lcu-update-kept{index:04d}')


def _target(sb):
    return fm.host()


# -- check -------------------------------------------------------------------------------------------------------

@scenario('update/check', hosts=ANY)
def _(sb):
    sb.place_release()
    current = _current()
    newer, minor, older = _bump(current), _bump(current, 1), _bump(current, 2, -1) if current.split('.')[2] != '0' \
        else '0.0.1'
    with fm.server(sb) as srv:
        env = srv.env()
        cases = [
            ('newer patch release', f'v{newer}', '# Notes\n'),
            ('newer minor release, severity security', f'v{minor}', 'intro\n  <!-- lcu-severity: security -->  \nmore\n'),
            ('severity breaking', f'v{newer}', '<!--lcu-severity:breaking-->\n'),
            ('unknown severity is normal', f'v{newer}', '<!-- lcu-severity: critical -->\n'),
            ('inline marker does not count', f'v{newer}', 'Use `<!-- lcu-severity: security -->` to flag.\n'),
            ('notes missing (404)', f'v{newer}', None),
            ('same version', f'v{current}', ''),
            ('older version', f'v{older}', ''),
            ('tag without v', newer, ''),
            ('tag with two v', f'vv{newer}', ''),
            ('unrecognised tag', f'v{newer}-rc1', ''),
            ('tag with spaces', f'v{newer}%20', ''),
        ]
        for label, tag, notes in cases:
            srv.routes()
            srv.latest(tag, notes=notes, version=tag[1:] if tag[:1] == 'v' else tag)
            _note(sb, f'--- {label}')
            sb.lcu('update', '--check', env=env)
            sb.lcu('update', '--check', '--json', env=env)
            fm.show_scrubbed(sb, fm.cache_dir(sb) / 'update.json', 'cache update.json')
        # Response shapes of /releases/latest.
        for label, rule in (
                ('404', {'status': 404, 'body': 'Not Found'}),
                ('500', {'status': 500}),
                ('200 without Location', {'status': 200}),
                ('200 with Location', {'status': 200, 'headers': {'Location': f'https://github.com/amontlabs/lcu/releases/tag/v{newer}'}}),
                ('301', {'status': 301, 'headers': {'Location': f'https://github.com/amontlabs/lcu/releases/tag/v{newer}'}}),
                ('302 to an unexpected place', {'status': 302, 'headers': {'Location': 'https://github.com/amontlabs/lcu'}}),
                ('302 with a query string', {'status': 302, 'headers': {'Location': f'https://github.com/amontlabs/lcu/releases/tag/v{newer}?x=1'}}),
                ('302 relative Location', {'status': 302, 'headers': {'Location': f'/amontlabs/lcu/releases/tag/v{newer}'}}),
                ('connection closed without a response', {'abort': True})):
            srv.routes({'host': 'github.com', 'path': '/amontlabs/lcu/releases/latest', **rule})
            _note(sb, f'--- latest: {label}')
            sb.lcu('update', '--check', env=env)
            sb.lcu('update', '--check', '--json', env=env)
            fm.show_scrubbed(sb, fm.cache_dir(sb) / 'update.json', 'cache update.json')
        _note(sb, '--- plain update when up to date / when the check fails')
        srv.routes()
        srv.latest(f'v{current}', notes='')
        sb.lcu('update', env=env)
        srv.routes()
        sb.lcu('update', env=env)
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


@scenario('update/check-network', hosts=ANY)
def _(sb):
    sb.place_release()
    newer = _bump(_current())
    with fm.server(sb) as srv:
        env = srv.env()
        dead = {**env, 'https_proxy': 'http://127.0.0.1:9'}       # nothing listens on the discard port
        _note(sb, '--- proxy refuses connections')
        sb.lcu('update', '--check', env=dead)
        sb.lcu('update', '--check', '--json', env=dead)
        _note(sb, '--- previous answer is kept when a later check fails')
        srv.latest(f'v{newer}', notes='')
        sb.lcu('update', '--check', env=env)
        sb.lcu('update', '--check', env=dead)
        fm.show_scrubbed(sb, fm.cache_dir(sb) / 'update.json', 'cache update.json')
        sb.lcu('status', env=dead)
        _note(sb, '--- server too slow (5 s timeout)')
        srv.routes({'host': 'github.com', 'path': '/amontlabs/lcu/releases/latest', 'delay': 8, 'status': 302,
                    'headers': {'Location': f'https://github.com/amontlabs/lcu/releases/tag/v{newer}'}})
        sb.lcu('update', '--check', env=env, timeout=40)
        _note(sb, '--- untrusted certificate and curl not usable (fake curl fails)')
        sb.lcu('update', '--check', env=srv.env(trust=False))
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


@scenario('update/curl-fallback', hosts=ANY, normalise=NORMALISE)
def _(sb):
    # No usable CA for the client: LCU retries through the system curl (recorded, trusting only the test CA).
    sb.place_release()
    fm.curl_with_ca(sb)
    newer = _bump(_current())
    with fm.server(sb) as srv:
        env = srv.env(trust=False)
        srv.latest(f'v{newer}', notes='<!-- lcu-severity: security -->\n')
        sb.lcu('update', '--check', env=env)
        sb.lcu('update', '--check', '--json', env=env)
        fm.show_scrubbed(sb, fm.cache_dir(sb) / 'update.json', 'cache update.json')
        srv.routes({'host': 'github.com', 'path': '/amontlabs/lcu/releases/latest', 'status': 404})
        _note(sb, '--- curl fails (HTTP 404)')
        sb.lcu('update', '--check', env=env)
        _note(sb, '--- download through curl: checksum mismatch stops before extraction')
        srv.routes()
        fm.serve_release(sb, srv, newer, _target(sb), style='junk')
        sb.lcu('update', '--yes', env=env)
        path, asset, digest = fm.build_archive(sb, newer, _target(sb), only_extra=True,
                                               extra=[fm.tar_entry('x/file', data=b'x')])
        srv.routes()
        fm.serve_release(sb, srv, newer, _target(sb), archive=(path, asset, '0' * 64))
        sb.lcu('update', '--yes', env=env)
        srv.routes()
        fm.serve_release(sb, srv, newer, _target(sb), archive=(path, asset, digest))
        _note(sb, '--- download through curl, valid checksum, archive without a release bundle')
        sb.lcu('update', '--yes', env=env)
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


# -- notices and hooks -------------------------------------------------------------------------------------------

@scenario('update/notice', hosts=ANY)
def _(sb):
    sb.place_release()
    current = _current()
    newer = _bump(current)
    no_refresh = {'https_proxy': 'http://127.0.0.1:9'}      # a stale cache would start a refresh: never reach out
    cases = [
        ('no cache: nothing (stale, refresh claimed)', None),
        ('newer cached', (fm.latest_info(newer), None)),
        ('security', (fm.latest_info(newer, severity='security'), None)),
        ('breaking', (fm.latest_info(newer, severity='breaking'), None)),
        ('unknown severity', (fm.latest_info(newer, severity='critical'), None)),
        ('same version', (fm.latest_info(current), None)),
        ('error with previous latest', (fm.latest_info(newer), 'timed out')),
        ('latest not a dict', ('x', None)),
    ]
    for label, cache in cases:
        if cache is None:
            shutil.rmtree(fm.cache_dir(sb), ignore_errors=True)
        else:
            fm.write_update_cache(sb, *cache)
        _claim_refresh(sb)
        _note(sb, f'--- {label}')
        sb.lcu('update', '--notice', env=no_refresh)
        sb.lcu('update', '--notice', '--json', env=no_refresh)
    fm.write_update_cache(sb, fm.latest_info(newer))
    _note(sb, '--- disabled by LCU_NO_UPDATE_CHECK')
    sb.lcu('update', '--notice', env={'LCU_NO_UPDATE_CHECK': 'yes'})
    sb.lcu('update', '--notice', '--json', env={'LCU_NO_UPDATE_CHECK': '1'})
    sb.lcu('update', '--notice', '--json', env={'LCU_NO_UPDATE_CHECK': ' 0 '})
    _note(sb, '--- cache variants')
    for label, raw in (('checked_at is a bool', json.dumps({'checked_at': True, 'latest': fm.latest_info(newer)})),
                       ('checked_at missing', json.dumps({'latest': fm.latest_info(newer)})),
                       ('not JSON', '{nope'), ('a list', '[]'),
                       ('in the future (stale)', json.dumps({'checked_at': time.time() + 10 ** 6,
                                                             'latest': fm.latest_info(newer)}))):
        fm.write_update_cache(sb, None, raw=raw)
        _claim_refresh(sb)
        _note(sb, f'--- cache: {label}')
        sb.lcu('update', '--notice', '--json', env=no_refresh)
    _note(sb, '--- XDG_CACHE_HOME (Linux only) moves the cache')
    xdg = sb.work / 'xdg-cache'
    fixtures.write(xdg / 'lcu/update.json', json.dumps({'checked_at': time.time(), 'latest': fm.latest_info(newer, severity='breaking'),
                                                         'error': None}))
    sb.lcu('update', '--notice', env={**no_refresh, 'XDG_CACHE_HOME': str(xdg)})
    fixtures.write(xdg / 'lcu/update.json', 'scrubbed')
    fm.scrub_times(sb)


@scenario('update/notice-hooks', hosts=ANY)
def _(sb):
    sb.place_release()
    newer = _bump(_current())
    env = {'https_proxy': 'http://127.0.0.1:9'}
    fm.write_update_cache(sb, fm.latest_info(newer))
    hook = lambda event, stdin, label: sb.lcu('update', '--notice', '--hook', event, stdin=stdin, env=env,  # noqa: E731
                                             label=label)
    hook('SessionStart', b'{"session_id": "s-1"}', 'SessionStart s-1: announced')
    hook('SessionStart', b'{"session_id": "s-1"}', 'SessionStart s-1 again: silent')
    hook('UserPromptSubmit', b'{"session_id": "s-1"}', 'UserPromptSubmit s-1: silent (already told)')
    hook('UserPromptSubmit', b'{"session_id": "s-2", "other": 1}', 'UserPromptSubmit s-2: announced')
    hook('UserPromptSubmit', b'', 'UserPromptSubmit without input: silent')
    hook('UserPromptSubmit', b'not json', 'UserPromptSubmit with garbage: silent')
    hook('UserPromptSubmit', b'{"session_id": 5}', 'UserPromptSubmit with a numeric id: silent')
    hook('UserPromptSubmit', b'{"session_id": ""}', 'UserPromptSubmit with an empty id: silent')
    hook('SessionStart', b'', 'SessionStart without input: announced (no session to remember)')
    hook('SessionStart', b'[1]', 'SessionStart with a list: announced')
    sb.lcu('update', '--notice', '--hook', 'SessionStart', '--json', stdin=b'{"session_id": "s-3"}', env=env,
           label='--json with --hook: hook output wins')
    sb.lcu('update', '--notice', '--hook', 'SessionStart', stdin=None, env=env, label='stdin closed (/dev/null)')
    _show_cache(sb)
    _note(sb, '--- a newer release is announced again to the same session')
    fm.write_update_cache(sb, fm.latest_info(_bump(newer)))
    hook('SessionStart', b'{"session_id": "s-1"}', 's-1 told about the next release')
    _show_cache(sb)
    _note(sb, '--- old and malformed announcement records are dropped')
    fixtures.write(fm.cache_dir(sb) / 'announced.json', json.dumps({
        'old': {'version': newer, 'at': 1.0}, 'future': {'version': newer, 'at': time.time() + 10 ** 7},
        'bad': {'version': newer}, 'list': [1], 'keep': {'version': newer, 'at': time.time()}}))
    hook('SessionStart', b'{"session_id": "s-9"}', 's-9 announced; record pruned')
    _show_cache(sb)
    (fm.cache_dir(sb) / 'announced.json').write_text('{nope')
    hook('SessionStart', b'{"session_id": "s-9"}', 'unreadable record: announced again')
    _show_cache(sb)
    _note(sb, '--- no notice: hooks are silent')
    fm.write_update_cache(sb, fm.latest_info(_current()))
    hook('SessionStart', b'{"session_id": "s-10"}', 'nothing newer')
    _note(sb, '--- piped hook input on a terminal: notice text only on --notice')
    fm.write_update_cache(sb, fm.latest_info(newer))
    fm.pty(sb, [], [sb.release / 'bin/lcu', 'update', '--notice', '--hook', 'UserPromptSubmit'], env=env,
           label='UserPromptSubmit on a terminal: no session id, silent')
    fm.pty(sb, [], [sb.release / 'bin/lcu', 'update', '--notice', '--hook', 'SessionStart'], env=env,
           label='SessionStart on a terminal: announced')
    fm.scrub_times(sb)


def _wait_for(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


@scenario('update/notice-refresh', hosts=ANY)
def _(sb):
    # A stale cache makes --notice start a detached `lcu update --refresh` (claimed through refresh.stamp, at most
    # once per 120 s). The scenario waits for the refresh to rewrite the cache before looking.
    sb.place_release()
    newer = _bump(_current())
    with fm.server(sb) as srv:
        env = srv.env()
        srv.latest(f'v{newer}', notes='<!-- lcu-severity: breaking -->\n')
        cache = fm.cache_dir(sb) / 'update.json'
        sb.lcu('update', '--notice', '--json', env=env, label='no cache: prints {} and starts a refresh')
        ok = _wait_for(lambda: cache.is_file() and 'breaking' in cache.read_text())
        time.sleep(0.5)
        _note(sb, f'--- refresh finished: {ok}')
        _show_cache(sb)
        sb.lcu('update', '--notice', env=env, label='fresh cache: notice, no refresh')
        _note(sb, '--- stale again, but the refresh was claimed less than 120 s ago')
        fm.write_update_cache(sb, fm.latest_info(newer), age=10 ** 5)
        before = cache.read_bytes()
        sb.lcu('update', '--notice', env=env, label='stale cache, stamp fresh: no refresh')
        time.sleep(2)
        _note(sb, f'--- cache unchanged: {cache.read_bytes() == before}')
        _note(sb, '--- stale with an old stamp: refreshed again (error cached, 1 h retry)')
        stamp = fm.cache_dir(sb) / 'refresh.stamp'
        os.utime(stamp, (time.time() - 1000, time.time() - 1000))
        srv.routes({'host': 'github.com', 'path': '/amontlabs/lcu/releases/latest', 'status': 503})
        sb.lcu('update', '--notice', env=env, label='stale cache, old stamp: refresh starts')
        ok = _wait_for(lambda: '503' in cache.read_text())
        time.sleep(0.5)
        _note(sb, f'--- refresh finished: {ok}')
        _show_cache(sb)
        _note(sb, '--- explicit --refresh: silent, exit 0, writes the cache; disabled: no network')
        srv.latest(f'v{newer}')
        srv.routes(*srv._rules[1:])
        sb.lcu('update', '--refresh', env=env)
        _show_cache(sb)
        sb.lcu('update', '--refresh', env={**env, 'LCU_NO_UPDATE_CHECK': '1'})
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


@scenario('update/arguments', hosts=ANY)
def _(sb):
    sb.place_release()
    _claim_refresh(sb)
    dead = {'https_proxy': 'http://127.0.0.1:9'}
    for args in (['--help'], ['-h'], ['--check', '--notice'], ['--notice', '--refresh'], ['--check', '--post-install'],
                 ['--refresh', '--post-install'], ['--hook', 'Stop', '--notice'], ['--hook'], ['--bogus'], ['extra'],
                 ['--chec'], ['--not', '--js'], ['--check', '--check'], ['--hook', 'SessionStart']):
        sb.lcu('update', *args, env=dead)
    fm.scrub_times(sb)


@scenario('update/source-checkout', hosts=ANY)
def _(sb):
    sb.place_release(bundle=False)
    dead = {'https_proxy': 'http://127.0.0.1:9'}
    sb.lcu('update', '--check', env=dead)
    sb.lcu('update', env=dead)
    sb.lcu('update', '--notice', '--json', env=dead)
    sb.lcu('update', '--refresh', env=dead)
    (sb.release / 'bundle.json').write_text(json.dumps({'version': 'not.a.version'}))
    sb.lcu('update', '--check', env=dead)
    (sb.release / 'bundle.json').write_text(json.dumps({'version': 5}))
    sb.lcu('update', '--check', env=dead)
    fm.scrub_times(sb)


# -- apply (up to the installer) -----------------------------------------------------------------------------

@scenario('update/apply-prompt', hosts=ANY, normalise=NORMALISE)
def _(sb):
    sb.place_release()
    newer = _bump(_current())
    with fm.server(sb) as srv:
        env = srv.env()
        fm.serve_release(sb, srv, newer, _target(sb), style='other')    # stops at the checksum
        _note(sb, '--- not a terminal, no --yes')
        sb.lcu('update', env=env)
        sb.lcu('update', env=env, stdin=None)
        lcu = [sb.release / 'bin/lcu', 'update']
        for label, answer in (('n', 'n\n'), ('Enter', '\n'), ('no', 'no\n'), ('yes, then checksum file names another '
                                                                             'asset', 'yes\n'),
                              ('Y', 'Y\n'), ('  y  ', '  y  \n'), ('yep', 'yep\n')):
            _note(sb, f'--- answer {label}')
            fm.pty(sb, [('Proceed? [y/N] ', answer)], lcu, env=env, label=f'update on a terminal: {label}')
        _note(sb, '--- --yes on a terminal does not ask')
        fm.pty(sb, [], [*lcu, '--yes'], env=env, label='update --yes on a terminal')
        _note(sb, '--- the prefix path is shell-quoted in the hint')
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


@scenario('update/apply-checksums', hosts=ANY, normalise=NORMALISE)
def _(sb):
    # Every checksum file form; a valid checksum continues to extraction, and the archive here has no release bundle
    # (stops before the installer).
    sb.place_release()
    newer = _bump(_current())
    target = _target(sb)
    with fm.server(sb) as srv:
        env = srv.env()
        built = fm.build_archive(sb, newer, target, only_extra=True, extra=[fm.tar_entry('stub/file', data=b'x')])
        for style in ('plain', 'star', 'bare', 'upper', 'multi', 'other', 'junk'):
            srv.routes()
            fm.serve_release(sb, srv, newer, target, archive=built, style=style)
            _note(sb, f'--- checksum file: {style}')
            sb.lcu('update', '--yes', env=env)
        srv.routes()
        fm.serve_release(sb, srv, newer, target, archive=(built[0], built[1], 'f' * 64))
        _note(sb, '--- checksum mismatch')
        sb.lcu('update', '--yes', env=env)
        srv.routes()
        fm.serve_release(sb, srv, newer, target, archive=built)
        srv.routes(*[r for r in srv._rules if not r.get('path', '').endswith('.sha256')])
        _note(sb, '--- checksum file missing (404)')
        sb.lcu('update', '--yes', env=env)
        srv.routes()
        srv.latest(f'v{newer}')
        _note(sb, '--- archive missing (404)')
        sb.lcu('update', '--yes', env=env)
        sb.run(['ls', '-A', sb.tmp], label='temporary directory cleaned up')
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


HOSTILE_TAR = [
    ('parent path', [fm.tar_entry('../evil', data=b'x')]),
    ('absolute path', [fm.tar_entry('/abs/evil', data=b'x')]),
    ('parent inside the path', [fm.tar_entry('top/../../evil', data=b'x')]),
    ('windows drive', [fm.tar_entry('C:evil', data=b'x')]),
    ('windows backslash parent', [fm.tar_entry('top\\..\\..\\evil', data=b'x')]),
    ('symlink to an absolute path', [fm.tar_entry('top/link', kind='symlink', link='/etc/passwd')]),
    ('symlink escaping', [fm.tar_entry('top/sub/link', kind='symlink', link='../../../x')]),
    ('symlink to a windows drive', [fm.tar_entry('top/link', kind='symlink', link='C:/x')]),
    ('hard link escaping', [fm.tar_entry('top/hard', kind='hardlink', link='../x')]),
    ('character device', [fm.tar_entry('top/dev', kind='chardev')]),
    ('block device', [fm.tar_entry('top/blk', kind='blockdev')]),
    ('fifo', [fm.tar_entry('top/fifo', kind='fifo')]),
    ('first safe, second unsafe', [fm.tar_entry('top/ok', data=b'x'), fm.tar_entry('../evil', data=b'x')]),
    ('safe links only', [fm.tar_entry('top/a', data=b'x'), fm.tar_entry('top/sub/l', kind='symlink', link='../a'),
                         fm.tar_entry('top/h', kind='hardlink', link='top/a')]),
]


@scenario('update/apply-hostile-tar', hosts=ANY, normalise=NORMALISE)
def _(sb):
    sb.place_release()
    newer = _bump(_current())
    target = _target(sb)
    with fm.server(sb) as srv:
        env = srv.env()
        for label, extra in HOSTILE_TAR:
            srv.routes()
            name = 'case-' + str(HOSTILE_TAR.index((label, extra))) + '.tar.gz'
            path, asset, digest = fm.build_archive(sb, newer, target, only_extra=True, extra=extra, name=name)
            fm.serve_release(sb, srv, newer, target, archive=(path, asset, digest))
            _note(sb, f'--- {label}')
            sb.lcu('update', '--yes', env=env)
        for label, data in (('not gzip', b'plain bytes, not an archive'),
                            ('gzip but not tar', gzip.compress(b'hello world' * 100, mtime=0)),
                            ('truncated gzip', gzip.compress(b'x' * 5000, mtime=0)[:30]),
                            ('empty file', b'')):
            path = sb.bb / 'build' / (label.replace(' ', '-') + '.bin')
            path.write_bytes(data)
            import hashlib
            asset = f'lcu-{newer}-{target}-{fixtures.architecture()}.tar.gz'
            srv.routes()
            fm.serve_release(sb, srv, newer, target, archive=(path, asset, hashlib.sha256(data).hexdigest()))
            _note(sb, f'--- {label}')
            sb.lcu('update', '--yes', env=env)
        _note(sb, '--- a real tree under the wrong top-level name')
        srv.routes()
        fm.serve_release(sb, srv, newer, target, top='lcu-something-else', name='wrong-top.tar.gz')
        sb.lcu('update', '--yes', env=env)
        sb.run(['ls', '-A', sb.tmp], label='temporary directory cleaned up')
    fm.scrub_times(sb)


@scenario('update/apply-windows-zip', hosts=ANY, normalise=NORMALISE)
def _(sb):
    # A Windows installation downloads the .zip; the zip guards run before the (never reached) installer.
    sb.place_release()
    descriptor = sb.release / 'installation.json'
    descriptor.write_text(json.dumps({'platform': 'windows', 'architecture': 'x64', 'app': 'C:\\nowhere',
                                      'package_version': fixtures.VERSION, 'runtime': fixtures.RUNTIME}) + '\n')
    newer = _bump(_current())
    with fm.server(sb) as srv:
        env = srv.env()
        srv.latest(f'v{newer}', notes='')
        _note(sb, '--- not a terminal: the hint names lcu.cmd')
        sb.lcu('update', env=env)
        cases = [('parent path', [fm.zip_entry('../evil')]), ('absolute', [fm.zip_entry('/evil')]),
                 ('drive', [fm.zip_entry('C:/evil')]), ('backslash parent', [fm.zip_entry('top\\..\\..\\evil')]),
                 ('symlink entry', [fm.zip_entry('top/link', data=b'target', symlink=True)]),
                 ('safe, no bundle', [fm.zip_entry('top/file')])]
        for index, (label, extra) in enumerate(cases):
            srv.routes()
            built = fm.build_archive(sb, newer, 'windows', arch='x64', only_extra=True, extra=extra,
                                     name=f'case-{index}.zip')
            fm.serve_release(sb, srv, newer, 'windows', archive=built)
            _note(sb, f'--- zip: {label}')
            sb.lcu('update', '--yes', env=env)
        path = sb.bb / 'build/not-a-zip.zip'
        path.write_bytes(b'not a zip')
        import hashlib
        srv.routes()
        fm.serve_release(sb, srv, newer, 'windows', archive=(path, f'lcu-{newer}-windows-x64.zip',
                                                              hashlib.sha256(b'not a zip').hexdigest()))
        _note(sb, '--- zip: not a zip')
        sb.lcu('update', '--yes', env=env)
    fm.scrub_times(sb)


@scenario('update/apply-layout-errors', hosts=ANY, normalise=NORMALISE)
def _(sb):
    sb.place_release()
    newer = _bump(_current())
    descriptor = sb.release / 'installation.json'
    original = descriptor.read_text()
    with fm.server(sb) as srv:
        env = srv.env()
        srv.latest(f'v{newer}', notes='')
        for label, text in (('architecture unsupported', json.dumps({**json.loads(original), 'architecture': 'ppc'})),
                            ('platform unsupported', json.dumps({**json.loads(original), 'platform': 'plan9'})),
                            ('architecture missing (falls back to bundle.json)',
                             json.dumps({k: v for k, v in json.loads(original).items() if k != 'architecture'})),
                            ('not JSON', '{nope'), ('a list', '[]')):
            descriptor.write_text(text)
            _note(sb, f'--- installation.json: {label}')
            sb.lcu('update', env=env, stdin=None)
        descriptor.unlink()
        _note(sb, '--- installation.json missing')
        sb.lcu('update', env=env, stdin=None)
        descriptor.write_text(original)
        marker = sb.prefix / '.lcu-install'
        marker.unlink()
        _note(sb, '--- not inside an installation prefix')
        sb.lcu('update', env=env, stdin=None)
        marker.write_text('')
        bundle = sb.release / 'bundle.json'
        saved = bundle.read_text()
        bundle.write_text(json.dumps({'version': _current()}))
        _note(sb, '--- bundle.json without architecture (installation.json has it)')
        sb.lcu('update', env=env, stdin=None)
        bundle.write_text(saved)
    fm.scrub_times(sb)


@scenario('update/apply-unwritable-prefix', hosts=ANY, normalise=NORMALISE)
def _(sb):
    # Linux, not root, prefix not writable: the verified extraction is kept and the sudo command printed.
    sb.place_release('linux')
    newer = _bump(_current())
    reference = fm.register_new_release_reference(sb, newer, 'linux')
    with fm.server(sb) as srv:
        env = srv.env()
        fm.serve_release(sb, srv, newer, 'linux', extra=[fm.tar_entry(f'lcu-{newer}-linux-{fixtures.architecture()}/bin/setuid-tool',
                                                                      data=b'#!/bin/sh\n', mode=0o6777)])
        for label, path in (('prefix', sb.prefix), ('.lcu-install', sb.prefix / '.lcu-install'),
                            ('releases', sb.prefix / 'releases')):
            os.chmod(path, 0o555 if path.is_dir() else 0o444)
            try:
                _note(sb, f'--- {label} not writable')
                sb.lcu('update', '--yes', env=env)
                _rename_kept(sb)
            finally:
                os.chmod(path, 0o755 if path.is_dir() else 0o644)
        _note(sb, f'--- (kept extractions are compared with {reference})')
    fm.scrub_times(sb)


# -- post-install ------------------------------------------------------------------------------------------------

@scenario('update/post-install', hosts=ANY)
def _(sb):
    sb.place_release()
    home = sb.home
    mod = home / '.claude/skills/lcu-approve'
    codex = home / '.codex/config.toml'
    _note(sb, '--- nothing to refresh')
    sb.lcu('update', '--post-install')
    _note(sb, '--- an owned mod with a stale file and an old lcu.json')
    fixtures.write(mod / '.claude-plugin/plugin.json', json.dumps({'name': 'lcu-approve', 'version': '0.0.1'}))
    fixtures.write(mod / 'stale-from-old-release.txt', 'old\n')
    fixtures.write(mod / 'lcu.json', '{"lcu": "/old/path/bin/lcu"}\n')
    sb.lcu('update', '--post-install')
    fm.show(sb, mod / 'lcu.json', 'mod lcu.json')
    _note(sb, '--- a foreign plugin with the same folder name is left alone')
    shutil.rmtree(mod)
    fixtures.write(mod / '.claude-plugin/plugin.json', json.dumps({'name': 'someone-else'}))
    sb.lcu('update', '--post-install')
    shutil.rmtree(mod)
    fixtures.write(mod / '.claude-plugin/plugin.json', '{broken')
    sb.lcu('update', '--post-install')
    shutil.rmtree(mod)
    fixtures.write(mod, 'a file, not a folder')
    sb.lcu('update', '--post-install')
    mod.unlink()
    lcu = str(sb.prefix / 'current/bin/lcu')
    for label, text, env in (
            ('codex: lcu registered, no hooks', '[mcp_servers.lcu]\ncommand = "x"\n', {}),
            ('codex: hooks for one event only', '[mcp_servers.lcu]\ncommand = "x"\n'
             f'[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "{lcu} update --notice --hook SessionStart"\n', {}),
            ('codex: both hooks present', '[mcp_servers.lcu]\ncommand = "x"\n'
             f'[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "{lcu} update --notice --hook SessionStart"\n'
             f'[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "{lcu} update --notice --hook UserPromptSubmit"\n', {}),
            ('codex: hook command of another program', '[mcp_servers.lcu]\ncommand = "x"\n'
             '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "/bin/other update --notice --hook SessionStart"\n'
             '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "/bin/other update --notice --hook UserPromptSubmit"\n', {}),
            ('codex: lcu not registered', '[mcp_servers.other]\ncommand = "x"\n', {}),
            ('codex: malformed TOML', '[mcp_servers.lcu\n', {}),
            ('codex: CODEX_HOME elsewhere', None, {'CODEX_HOME': str(sb.work / 'codex-home')})):
        if text is not None:
            fixtures.write(codex, text)
        else:
            fixtures.write(sb.work / 'codex-home/config.toml', '[mcp_servers.lcu]\ncommand = "x"\n')
        _note(sb, f'--- {label}')
        sb.lcu('update', '--post-install', env=env)


# -- the whole update with the real installer (container only) ----------------------------------------------------

def _full(sb, *, mod=True):
    sb.place_release('linux')
    newer = _bump(_current())
    fm.register_new_release_reference(sb, newer, 'linux')
    if mod:
        target = sb.home / '.claude/skills/lcu-approve'
        fixtures.write(target / '.claude-plugin/plugin.json', json.dumps({'name': 'lcu-approve'}))
        fixtures.write(target / 'stale.txt', 'from the old release\n')
        fixtures.write(sb.home / '.codex/config.toml', '[mcp_servers.lcu]\ncommand = "x"\n')
    return newer


@scenario('update/apply-install', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    newer = _full(sb)
    with fm.server(sb) as srv:
        env = srv.env()
        fm.serve_release(sb, srv, newer, 'linux', notes='<!-- lcu-severity: security -->\n')
        sb.lcu('update', '--yes', env=env, timeout=300)
        sb.run([sb.prefix / 'current/bin/lcu', '--version'], label='current lcu --version')
        sb.run([sb.prefix / 'current/bin/lcu', 'update', '--check'], env=env, label='new release: up to date')
        sb.run([sb.prefix / 'current/bin/lcu', 'prune'], label='prune dry run after the update')
        fm.show(sb, sb.home / '.claude/skills/lcu-approve/lcu.json', 'mod lcu.json')
        fm.show_requests(sb, srv)
    fm.scrub_times(sb)


@scenario('update/apply-install-terminal', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    newer = _full(sb, mod=False)
    with fm.server(sb) as srv:
        env = srv.env()
        fm.serve_release(sb, srv, newer, 'linux')
        fm.pty(sb, [('Proceed? [y/N] ', 'y\n')], [sb.release / 'bin/lcu', 'update'], env=env,
               label='update on a terminal: y', timeout=300)
        sb.run([sb.prefix / 'current/bin/lcu', '--version'], label='current lcu --version')
    fm.scrub_times(sb)


@scenario('update/apply-installer-fails', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    # The installer itself rejects the selected app (a required file is gone): its exit status is returned and the
    # previous release stays current.
    newer = _full(sb, mod=False)
    (sb.apps / 'chatgpt/resources/cua_node/bin/node_repl').unlink()
    with fm.server(sb) as srv:
        env = srv.env()
        fm.serve_release(sb, srv, newer, 'linux')
        sb.lcu('update', '--yes', env=env, timeout=300)
        sb.run(['readlink', sb.prefix / 'current'], label='current still points at the old release')
    fm.scrub_times(sb)
