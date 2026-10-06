"""`lcu prune`: release/app generation selection, argument parsing, layout refusals, sizes, the install lock.

Prune never validates the app, so these layouts are crafted directly (descriptor files with the shapes installers
write) and run on every host. Directory sizes in the output are the host filesystem's own numbers.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import fixtures
import fixtures_mgmt as fm
import sandbox

from . import scenario

ANY = ('darwin', 'linux')
HEX12 = ('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee')


def _note(sb, text):
    sb.run(['echo', text], label=text)


def _descriptor(sb, **fields):
    """installation.json for a crafted release: Linux in-place app by default (absolute, outside <prefix>/apps)."""
    base = {'architecture': fixtures.architecture(), 'package_version': fixtures.VERSION,
            'runtime': fixtures.RUNTIME, 'app': str(sb.apps / 'chatgpt')}
    base.update(fields)
    return {k: v for k, v in base.items() if v is not None}


def _release(sb, name, mtime, descriptor=None, files=None):
    directory = sb.prefix / 'releases' / name
    directory.mkdir()
    (directory / 'installation.json').write_text(json.dumps(descriptor or _descriptor(sb), indent=2) + '\n')
    for relative, data in (files or {}).items():
        fixtures.write(directory / relative, data)
    os.utime(directory, (mtime, mtime))
    return directory


def _target():
    return 'darwin' if sys.platform == 'darwin' else 'linux'


def _node_files():
    """The fixture app's interpreter wrapper at the path the release's agent-tools/node link resolves to."""
    resources = 'Contents/Resources' if _target() == 'darwin' else 'resources'
    return {f'{resources}/cua_node/bin/node': fixtures.NODE_WRAPPER}


def _generation(sb, name, files=None):
    directory = sb.prefix / 'apps' / name
    directory.mkdir(parents=True, exist_ok=True)
    for relative, data in (files or {'payload': b'x' * 1500}).items():
        fixtures.write(directory / relative, data)
    return directory


def _base(sb):
    sb.place_release()
    # The harness release must look like an installer-created one for a Linux-style layout.
    (sb.release / 'installation.json').write_text(json.dumps(_descriptor(sb), indent=2) + '\n')
    os.utime(sb.release, (1_800_000_000, 1_800_000_000))


def _five(sb):
    _base(sb)
    for index, name in enumerate(('0.9.2-aaaaaaaaaaaa', '0.9.1-bbbbbbbbbbbb', '0.9.0-cccccccccccc',
                                  '0.8.9-dddddddddddd', '0.8.8-eeeeeeeeeeee')):
        _release(sb, name, 1_700_000_000 - index * 1000, files={'bin/lcu': b'#!/bin/sh\n' * (index + 1)})


@scenario('prune/keep-values', hosts=ANY)
def _(sb):
    _five(sb)
    for args in ([], ['--keep', '1'], ['--keep', '2'], ['--keep', '3'], ['--keep', '10'], ['--keep', '0'],
                 ['--keep', '-5'], ['--keep=3'], ['--keep', ' 3 '], ['--keep', '+3'], ['--keep', '1_0'],
                 ['--keep', '٣'], ['--ke', '3'], ['--keep', 'x'], ['--keep', '1.5'], ['--keep', ''], ['--keep'],
                 ['--keep', '3', '--keep', '4'], ['--bogus'], ['extra'], ['--help'], ['-h'], ['--ye'], ['-y']):
        sb.lcu('prune', *args)


@scenario('prune/yes', hosts=ANY)
def _(sb):
    _five(sb)
    sb.lcu('prune', '--yes', '--keep', '3')
    sb.lcu('prune')
    sb.lcu('prune', '--yes', '--keep', '1')
    sb.lcu('prune', '--yes')
    sb.lcu('prune', '--yes', '--keep', '0')


@scenario('prune/running-release', hosts=ANY)
def _(sb):
    # The release that runs prune is kept even when `current` points elsewhere; mtime order decides the rest.
    _base(sb)
    for index, name in enumerate(('0.9.2-aaaaaaaaaaaa', '0.9.1-bbbbbbbbbbbb', '0.9.0-cccccccccccc')):
        _release(sb, name, 1_700_000_000 - index * 1000)
    other = sb.prefix / 'releases/0.9.4-ffffffffffff'
    sandbox.copy_impl(sb.impl_root, other)
    # Archive-faithful like Sandbox.place_release: the interpreter alias and the app it resolves through.
    sb.archive_modules(other, _target(), True)
    (other / 'app').symlink_to(os.readlink(sb.release / 'app'), target_is_directory=True)
    sb._impl_dirs.append(('prefix/releases/0.9.4-ffffffffffff', None))
    fixtures.write(other / 'bundle.json', json.dumps({'format': 1, 'version': '0.9.4', 'platform': fm.host(),
                                                      'architecture': fixtures.architecture(), 'files': {}}))
    (other / 'installation.json').write_text(json.dumps(_descriptor(sb)) + '\n')
    os.utime(other, (1_600_000_000, 1_600_000_000))     # oldest, but it is the running release
    sb.run([other / 'bin/lcu', 'prune', '--keep', '1'], label='prune from the non-current release')
    sb.run([other / 'bin/lcu', 'prune', '--keep', '2'], label='prune --keep 2 from the non-current release')
    sb.run([other / 'bin/lcu', 'prune', '--keep', '2', '--yes'], label='prune --yes from the non-current release')


@scenario('prune/nothing', hosts=ANY)
def _(sb):
    _base(sb)
    sb.lcu('prune')
    sb.lcu('prune', '--yes')
    (sb.prefix / 'releases/.hidden-staging').mkdir()
    (sb.prefix / 'releases/.0.9.5-staging').write_text('transient file')
    sb.lcu('prune', '--yes')


@scenario('prune/layout-errors', hosts=ANY)
def _(sb):
    _base(sb)
    sb.place_src()            # before the first command: the baseline must already contain the source tree
    _release(sb, '0.9.2-aaaaaaaaaaaa', 1_700_000_000)
    releases = sb.prefix / 'releases'
    marker = sb.prefix / '.lcu-install'
    _note(sb, '(layout errors follow)')
    # Not installed releases/<name>
    sb.run([sb.src / 'bin/lcu', 'prune'], label='prune from a source tree')
    # Marker problems.
    marker.rename(sb.prefix / 'marker-moved')
    sb.lcu('prune')
    marker.symlink_to('marker-moved')
    sb.lcu('prune')
    marker.unlink()
    marker.mkdir()
    sb.lcu('prune')
    marker.rmdir()
    (sb.prefix / 'marker-moved').rename(marker)
    # current pointer problems.
    current = sb.prefix / 'current'
    current.unlink()
    sb.lcu('prune')                                                    # missing
    current.mkdir()
    sb.lcu('prune')                                                    # a directory, not a symlink
    current.rmdir()
    current.symlink_to('releases/does-not-exist')
    sb.lcu('prune')                                                    # dangling
    current.unlink()
    current.symlink_to('releases')
    sb.lcu('prune')                                                    # the releases directory itself
    current.unlink()
    current.symlink_to('../../..')
    sb.lcu('prune')                                                    # outside the prefix
    current.unlink()
    current.symlink_to(f'releases/{fixtures.RELEASE_NAME}/app')
    sb.lcu('prune')                                                    # not a release directory
    current.unlink()
    current.symlink_to(f'releases/{fixtures.RELEASE_NAME}')
    sb.lcu('prune')
    # Entries prune refuses to touch.
    for label, make in (('file', lambda p: p.write_text('x')),
                        ('misnamed dir', lambda p: p.mkdir()),
                        ('symlink', lambda p: p.symlink_to(fixtures.RELEASE_NAME))):
        entry = releases / ('notarelease' if label != 'symlink' else '0.9.1-bbbbbbbbbbbb')
        make(entry)
        _note(sb, f'(unexpected {label})')
        sb.lcu('prune')
        if entry.is_dir() and not entry.is_symlink():
            entry.rmdir()
        else:
            entry.unlink()
    (releases / '0.9.9-UPPERCASE123').mkdir()                          # hex12 must be lower case
    sb.lcu('prune')
    (releases / '0.9.9-UPPERCASE123').rmdir()
    (releases / '0.9.9-abc').mkdir()                                   # too short
    sb.lcu('prune')
    (releases / '0.9.9-abc').rmdir()
    # releases is a symlink / missing descriptor.
    (releases / '0.9.2-aaaaaaaaaaaa/installation.json').unlink()
    sb.lcu('prune', '--keep', '1')                                     # needed only when apps exist: still fine
    (sb.release / 'installation.json').rename(sb.release / 'installation.json.moved')
    sb.lcu('prune')                                                    # running release lost its descriptor
    (sb.release / 'installation.json.moved').rename(sb.release / 'installation.json')
    (sb.release / 'installation.json').write_text('{not json')
    sb.lcu('prune')
    (sb.release / 'installation.json').write_text(json.dumps(_descriptor(sb)))


@scenario('prune/apps-generations', hosts=ANY)
def _(sb):
    _base(sb)
    arch = fixtures.architecture()
    gens = {name: _generation(sb, name) for name in (f'26.1-{arch}-0123456789abcdef', f'26.2-{arch}-fedcba9876543210',
                                                     f'26.3-{arch}-aaaaaaaaaaaaaaaa')}
    names = list(gens)
    # The running release's app is a managed generation: it carries the app interpreter the launcher runs
    # (executable wrapper, as in the fixture apps) beside its payload.
    for relative, data in _node_files().items():
        fixtures.write(gens[names[0]] / relative, data, 0o755)
    # kept release references: the current one via a relative `app` symlink (0.7.0 layout), an older via an
    # absolute path into apps/ (an app copy passed to --existing-app).
    (sb.release / 'app').unlink()
    (sb.release / 'app').symlink_to(f'../../apps/{names[0]}')
    (sb.release / 'installation.json').write_text(json.dumps(_descriptor(sb, app='app'), indent=2) + '\n')
    _release(sb, '0.9.2-aaaaaaaaaaaa', 1_700_000_000, _descriptor(sb, app=str(gens[names[1]] / 'payload')))
    _release(sb, '0.9.1-bbbbbbbbbbbb', 1_600_000_000, _descriptor(sb, app=str(sb.apps / 'in-place')))
    sb.lcu('prune')
    sb.lcu('prune', '--keep', '2')
    sb.lcu('prune', '--keep', '3', '--yes')
    sb.lcu('prune', '--keep', '1', '--yes')
    sb.lcu('prune')


@scenario('prune/apps-errors', hosts=ANY, normalise=('traceback',))
def _(sb):
    _base(sb)
    arch = fixtures.architecture()
    apps = sb.prefix / 'apps'
    apps.write_text('a file')
    sb.lcu('prune')                                                    # apps is not a directory
    apps.unlink()
    apps.symlink_to('releases')
    sb.lcu('prune')                                                    # apps is a symlink
    apps.unlink()
    apps.mkdir()
    sb.lcu('prune')                                                    # empty apps: nothing
    (apps / 'stray').mkdir()
    sb.lcu('prune')                                                    # unexpected entry
    (apps / 'stray').rmdir()
    _generation(sb, f'26.1-{arch}-0123456789abcdef')
    _generation(sb, '.app-stage-1234')                                 # transient staging is skipped
    sb.lcu('prune')                                                    # unreferenced generation is removable
    for label, descriptor in (('no app', _descriptor(sb, app=None)),
                              ('empty app', _descriptor(sb, app='')),
                              ('non-string app', _descriptor(sb, app=5)),
                              ('relative app outside', _descriptor(sb, app='../../elsewhere')),
                              ('absolute with sha256', _descriptor(sb, app='/nowhere', sha256='0' * 64)),
                              ('darwin platform ignores app', _descriptor(sb, platform='darwin', app=None))):
        (sb.release / 'installation.json').write_text(json.dumps(descriptor) + '\n')
        _note(sb, f'(descriptor: {label})')
        sb.lcu('prune')
    (sb.release / 'installation.json').write_text('[]')
    sb.lcu('prune')
    (sb.release / 'installation.json').write_text(json.dumps(_descriptor(sb)))
    sb.lcu('prune', '--yes')


@scenario('prune/windows-layout', hosts=ANY, normalise=('traceback',))
def _(sb):
    # The Windows layout is plain files, so its rules are checkable anywhere: current.json, 64-hex app copies.
    sb.place_release()
    windows = lambda **kw: {'platform': 'windows', 'architecture': 'x64', 'app': None, **kw}   # noqa: E731
    apps = sb.prefix / 'apps'
    first, second = '1' * 64, '2' * 64
    _generation(sb, first)
    _generation(sb, second)
    (sb.release / 'installation.json').write_text(json.dumps(windows(app=str(apps / first))) + '\n')
    _release(sb, '0.9.2-aaaaaaaaaaaa', 1_700_000_000, windows(app=str(apps / second)))
    _release(sb, '0.9.1-bbbbbbbbbbbb', 1_600_000_000, windows(app=str(apps / first / 'nested/app')))
    current = sb.prefix / 'current'
    current.unlink()
    sb.lcu('prune')                                                    # no current.json
    pointer = sb.prefix / 'current.json'
    for label, text in (('not json', 'nope'), ('array', '[]'), ('no release', '{}'),
                        ('release is a path', json.dumps({'release': '../x'})),
                        ('release backslash', json.dumps({'release': 'a\\b'})),
                        ('release dot', json.dumps({'release': '.'})),
                        ('release empty', json.dumps({'release': ''})),
                        ('release number', json.dumps({'release': 3})),
                        ('release missing', json.dumps({'release': '0.0.0-000000000000'})),
                        ('release ok', json.dumps({'release': fixtures.RELEASE_NAME}))):
        pointer.write_text(text)
        _note(sb, f'(current.json: {label})')
        sb.lcu('prune')
    sb.lcu('prune', '--keep', '1')
    sb.lcu('prune', '--keep', '2', '--yes')
    sb.lcu('prune')
    pointer.unlink()
    pointer.symlink_to('missing')
    sb.lcu('prune')


def _tree_sizes(sb):
    _base(sb)
    sb._take_baseline()          # before the huge sparse files: the baseline scan hashes every file it sees
    # Sparse files give exact apparent sizes without writing data: B, KiB, MiB, GiB and TiB thresholds.
    for index, (name, size) in enumerate((('0.9.2-aaaaaaaaaaaa', 0), ('0.9.1-bbbbbbbbbbbb', 1023),
                                          ('0.9.0-cccccccccccc', 1024), ('0.8.9-dddddddddddd', 1536 * 1024),
                                          ('0.8.8-eeeeeeeeeeee', 3 * 1024 ** 3), ('0.8.7-ffffffffffff', 2 * 1024 ** 4))):
        directory = _release(sb, name, 1_700_000_000 - index * 1000)
        with open(directory / 'payload', 'wb') as handle:
            handle.truncate(size)


@scenario('prune/sizes', hosts=ANY)
def _(sb):
    _tree_sizes(sb)
    try:
        sb.lcu('prune', '--keep', '1')
        sb.lcu('prune', '--keep', '1', '--yes')
    finally:
        for payload in (sb.prefix / 'releases').glob('*/payload'):
            payload.unlink()      # never let the snapshot hash a sparse terabyte


@scenario('prune/size-accounting', hosts=ANY)
def _(sb):
    # Symlinks count by link length, hard links count twice, unreadable directories are ignored.
    _base(sb)
    directory = _release(sb, '0.9.2-aaaaaaaaaaaa', 1_700_000_000, files={'a/file': b'x' * 100})
    (directory / 'link').symlink_to('a/file')
    (directory / 'dirlink').symlink_to('../..')
    os.link(directory / 'a/file', directory / 'a/hard')
    (directory / 'locked').mkdir()
    (directory / 'locked/hidden').write_bytes(b'y' * 5000)
    (directory / 'locked').chmod(0o000)
    try:
        sb.lcu('prune')
        sb.lcu('prune', '--keep', '1', '--yes')
    finally:
        if (directory / 'locked').exists():
            (directory / 'locked').chmod(0o755)


@scenario('prune/lock', hosts=ANY)
def _(sb):
    # prune takes an exclusive flock on <prefix>/.lcu-install for the whole run (the installers' lock): a holder
    # blocks it; once released it proceeds.
    _base(sb)
    _release(sb, '0.9.2-aaaaaaaaaaaa', 1_700_000_000)
    marker = sb.prefix / '.lcu-install'

    def hold():
        handle = open(marker, 'a')
        fcntl.flock(handle, fcntl.LOCK_EX)
        return handle

    handle = hold()
    sb.lcu('prune', '--keep', '1', '--yes', timeout=3, label='prune while the install lock is held')
    _note(sb, '(the blocked prune removed nothing)')
    timer = threading.Timer(1.5, handle.close)
    timer.start()
    sb.lcu('prune', '--keep', '1', '--yes', timeout=30, label='prune waits, then runs when the lock is released')
    timer.join()
    # A shared lock held by someone else blocks it just the same.
    _release(sb, '0.9.1-bbbbbbbbbbbb', 1_600_000_000)
    shared = open(marker, 'a')
    fcntl.flock(shared, fcntl.LOCK_SH)
    sb.lcu('prune', '--keep', '1', '--yes', timeout=3, label='prune while a shared lock is held')
    shared.close()
    sb.lcu('prune', '--keep', '1', '--yes', timeout=30)
    # The lock does not outlive prune: a second holder gets it immediately.
    again = open(marker, 'a')
    fcntl.flock(again, fcntl.LOCK_EX | fcntl.LOCK_NB)
    again.close()
    sb.run(['echo', 'lock free after prune'], label='lock free after prune')
