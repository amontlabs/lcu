#!/usr/bin/env python3
"""Install thin LCU beside the current user's official Windows Store app."""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import uuid

SOURCE = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(SOURCE))

from bundle import VERSION, architecture, verify
from lcu import setup
from lcu.windows import (_component, inventory_sha256, resolve_installed_windows_app,
                         validate_windows_app_tree)
from lcu.windows_host import materialize_original_host, plan_original_host


def _redirected(path):
    path = Path(path)
    return path.is_symlink() or path.is_junction()


def _extended_windows_name(value):
    if value.startswith('\\\\?\\'):
        return value
    if value.startswith('\\\\'):
        return '\\\\?\\UNC\\' + value[2:]
    return '\\\\?\\' + value


def _copy_path(path):
    # Windows long-path registry settings vary. The standard extended-length
    # spelling applies only to internal traversal/copy; descriptors stay normal.
    return _extended_windows_name(os.path.abspath(path)) if os.name == 'nt' else Path(path)


def _regular_tree(root):
    """Refuse reparse redirects before copying a registered package tree."""
    if _redirected(root) or not root.is_dir():
        raise ValueError(f'Windows application directory is missing or redirected: {root}')
    def unreadable(error):
        raise error
    for parent, directories, files in os.walk(_copy_path(root), followlinks=False, onerror=unreadable):
        for name in directories + files:
            item = Path(parent) / name
            if _redirected(item):
                raise ValueError(f'Windows application contains a redirected path: {item}')


def _generation(prefix, inventory_digest):
    return prefix / 'apps' / inventory_digest


def _validated_copy(app, selected):
    _regular_tree(app)
    return validate_windows_app_tree(app, expected_version=selected.version,
        expected_runtime=selected.runtime_version,
        expected_inventory=selected.inventory)


def _preflight_host(selected):
    """Check the selected app's native-pipe host layout read-only, before anything is copied.

    The protected Store directory refuses direct execution, so the structural
    analyzer runs with a temporary copy of only the app's own node.exe; the
    selected app itself is only read. Nothing from this check remains afterwards.
    """
    node = _component(selected.app, 'app/resources/cua_node/bin/node.exe')
    if _redirected(node) or not node.is_file():
        raise ValueError('The selected ChatGPT app has no usable app/resources/cua_node/bin/node.exe.')
    with tempfile.TemporaryDirectory(prefix='lcu-host-check-', ignore_cleanup_errors=True) as scratch:
        staged = Path(scratch) / 'node.exe'
        shutil.copy2(_copy_path(node), _copy_path(staged))
        try:
            plan_original_host(selected.app, node=staged)
        except ValueError as exc:
            raise ValueError(f'{exc} (observed ChatGPT app {selected.version}, '
                             f'runtime {selected.runtime_version}; nothing was installed)') from exc


def _atomic_bytes(path, data):
    if _redirected(path):
        raise ValueError(f'Refusing a redirected Windows launcher file: {path}')
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def checked_prefix(prefix):
    prefix = Path(prefix)
    if not prefix.is_absolute() or '..' in prefix.parts or len(prefix.parts) < 3:
        raise ValueError('Choose a dedicated absolute Windows installation directory.')
    for item in (prefix, *prefix.parents):
        if _redirected(item):
            raise ValueError(f'Refusing a linked Windows installation path: {item}')
    prefix = prefix.resolve()
    if prefix == SOURCE.resolve() or SOURCE.resolve().is_relative_to(prefix):
        raise ValueError('Install outside the extracted release archive.')
    if prefix.exists() and any(prefix.iterdir()) and not (prefix / '.lcu-install').is_file():
        raise ValueError('Installation directory is occupied by another application.')
    if _redirected(prefix / '.lcu-install'):
        raise ValueError('Refusing a redirected Windows installation marker.')
    return prefix


def install(prefix):
    if platform.system() != 'Windows':
        raise ValueError('The Windows installer must run in Windows 11 x64.')
    if sys.version_info < (3, 12):
        raise ValueError('Python 3.12 or later is required.')
    arch = architecture('windows')
    verify(SOURCE, arch, 'windows')
    prefix = checked_prefix(prefix)
    lock = json.loads((SOURCE / 'runtime.lock.json').read_text())['platforms']['windows']
    if 'x64' not in lock.get('architectures', {}):
        raise ValueError('This LCU archive does not include the Windows x64 runtime.')
    print('LCU: Verifying the registered official Windows application...', file=sys.stderr, flush=True)
    try:
        selected = resolve_installed_windows_app()
    except ValueError as exc:
        if str(exc) == 'Install the official ChatGPT MSIX for this Windows account first.':
            raise ValueError(setup.app_prerequisite_message() +
                             ' The app must be installed for the currently signed-in account.') from exc
        raise
    inventory = dict(selected.inventory)
    digest = inventory_sha256(inventory)
    if digest != selected.inventory_digest:
        raise ValueError('Selected Windows application inventory changed after validation.')
    # Fail on an unrecognised host layout before the 2 GB copy or any prefix write.
    print('LCU: Checking the original Windows native host layout...', file=sys.stderr, flush=True)
    _preflight_host(selected)
    # Keep the registered MSIX intact. Its protected WindowsApps directory does
    # not permit direct execution, so run an unchanged private copy instead.
    prefix.mkdir(parents=True, exist_ok=True)
    (prefix / '.lcu-install').touch(exist_ok=True)
    apps = prefix / 'apps'
    if _redirected(apps):
        raise ValueError(f'Refusing a redirected Windows app generation directory: {apps}')
    apps.mkdir(exist_ok=True)
    generation = _generation(prefix, digest)
    created_generation = False
    if _redirected(generation):
        raise ValueError(f'Refusing a redirected Windows app generation: {generation}')
    if generation.exists():
        inventory_path = generation / 'inventory.json'
        if _redirected(inventory_path) or not inventory_path.is_file():
            raise ValueError('Managed Windows application inventory is missing or redirected.')
        try:
            recorded_inventory = json.loads(inventory_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError('Managed Windows application inventory is missing or invalid.') from exc
        if recorded_inventory != inventory or inventory_sha256(recorded_inventory) != digest:
            raise ValueError('Managed Windows application inventory differs from the selected Store app.')
        _validated_copy(generation / 'app', selected)
    else:
        stage = apps / ('.' + uuid.uuid4().hex[:8])
        try:
            stage.mkdir()
            _regular_tree(selected.app)
            print('LCU: Copying the original application into the private runtime; this can take several minutes...',
                  file=sys.stderr, flush=True)
            shutil.copytree(_copy_path(selected.app), _copy_path(stage / 'app'), symlinks=True)
            _validated_copy(stage / 'app', selected)
            (stage / 'inventory.json').write_text(json.dumps(
                inventory, sort_keys=True, separators=(',', ':')) + '\n')
            os.replace(stage, generation)
            created_generation = True
        except BaseException:
            shutil.rmtree(_copy_path(stage), ignore_errors=True)
            raise
    release = None
    previous_launchers = {}
    replaced_launchers = []
    temporary = None
    committed = False
    # Everything from here on is inside the cleanup boundary, including the
    # release directory checks, so a failure never leaves a new app copy behind.
    try:
        releases = prefix / 'releases'
        if _redirected(releases):
            raise ValueError(f'Refusing a redirected Windows release directory: {releases}')
        releases.mkdir(exist_ok=True)
        release = releases / (VERSION + '-' + uuid.uuid4().hex[:12])
        shutil.copytree(SOURCE, release)
        verify(release, arch, 'windows')
        materialize_original_host(generation / 'app', release / 'lcu-host')
        (release / 'installation.json').write_text(json.dumps({
            'platform': 'windows', 'architecture': 'x64', 'app': str(generation / 'app'),
            'package_version': selected.version, 'runtime': selected.runtime_version,
            'sha256': digest,
        }, indent=2) + '\n')
        from lcu.runtime import paths
        paths(release)
        stable = prefix / 'windows_launcher.py'
        command_file = prefix / 'lcu.cmd'
        if _redirected(stable) or _redirected(command_file):
            raise ValueError('Refusing a redirected Windows launcher file.')
        previous_launchers = {path: path.read_bytes() if path.exists() else None
                              for path in (stable, command_file)}
        _atomic_bytes(stable, (release / 'scripts/windows_launcher.py').read_bytes())
        replaced_launchers.append(stable)
        _atomic_bytes(command_file, (
            f'@echo off\r\n"{sys.executable}" -B "%~dp0windows_launcher.py" %*\r\n'
            'exit /b %ERRORLEVEL%\r\n').encode())
        replaced_launchers.append(command_file)
        temporary = prefix / ('.current-' + uuid.uuid4().hex + '.json')
        temporary.write_text(json.dumps({'release': release.name}) + '\n')
        os.replace(temporary, prefix / 'current.json')
        committed = True
    except BaseException:
        if committed:
            raise
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            for path in reversed(replaced_launchers):
                content = previous_launchers[path]
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_bytes(path, content)
        finally:
            if release is not None:
                shutil.rmtree(_copy_path(release), ignore_errors=True)
            # Remove only a copy this run created; a generation that already existed
            # (or that a committed release uses) is never touched.
            if created_generation:
                shutil.rmtree(_copy_path(generation), ignore_errors=True)
        raise
    return release


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'LCU'
    parser.add_argument('--prefix', type=Path, default=default)
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--agent', action='append', choices=tuple(setup.CLIENTS) + tuple(setup.ALIASES))
    parser.add_argument('--chrome', action='store_true')
    parser.add_argument('--no-chrome', action='store_true')
    parser.add_argument('--audio', action='store_true')
    parser.add_argument('--no-audio', action='store_true')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--scope', choices=('user', 'project'), default='user')
    parser.add_argument('--project', type=Path)
    args = parser.parse_args(argv)
    if args.runtime_only and (args.agent or args.chrome or args.audio or args.no_chrome
                              or args.no_audio or args.project or args.scope != 'user'):
        parser.error('--runtime-only cannot include agent setup options')
    if not args.runtime_only and not args.agent:
        parser.error('Choose --agent NAME or --runtime-only. Agents: ' + ', '.join(setup.CLIENTS))
    release = install(args.prefix)
    print(f'LCU installed: {args.prefix / "lcu.cmd"}')
    if not args.runtime_only:
        command = [sys.executable, '-B', str(release / 'bin/lcu'), 'setup',
                   '--prefix', str(args.prefix), '--session', 'direct', '--scope', args.scope]
        for agent in args.agent:
            command += ['--agent', agent]
        if args.project:
            command += ['--project', str(args.project)]
        if args.chrome:
            command += ['--chrome']
        if args.no_chrome:
            command += ['--no-chrome']
        if args.audio:
            command += ['--audio']
        if args.no_audio:
            command += ['--no-audio']
        if args.yes:
            command += ['--yes']
        subprocess.run(command, check=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SystemExit(f'LCU Windows installer: {exc}')
