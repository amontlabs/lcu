"""Connect installed Chromium browsers using OpenAI's original native host."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

from . import capture


_MACOS_NATIVE_HOST_DIRS = (
    'Google/Chrome', 'Chromium', 'Google/ChromeForTesting',
    'Google/Chrome for Testing', 'Microsoft Edge',
    'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Vivaldi',
)


_PLUGIN_DIGEST = '.lcu-browser-plugin'


def _plugin_digest(plugin):
    """Content identity of the upstream Chrome plugin directory (paths, modes, bytes, links)."""
    plugin = Path(plugin)
    digest = hashlib.sha256()
    for path in sorted(plugin.rglob('*')):
        relative = path.relative_to(plugin).as_posix()
        if path.is_symlink():
            digest.update(f'L {relative} {os.readlink(path)}\0'.encode())
        elif path.is_file():
            with path.open('rb') as stream:
                digest.update(f'F {relative} {path.stat().st_mode & 0o111} '
                              f'{hashlib.file_digest(stream, "sha256").hexdigest()}\0'.encode())
        elif path.is_dir():
            digest.update(f'D {relative}\0'.encode())
    return digest.hexdigest()


def _manifest_paths(env, system):
    home = Path(env.get('USERPROFILE', Path.home())) if system == 'Windows' else Path(env.get('HOME', Path.home()))
    name = 'com.openai.codexextension.json'
    if system == 'Darwin':
        # These are the per-user destinations in the original Chrome plugin's
        # installManifest.mjs for macOS. Do not inspect system-wide registrations.
        support = home / 'Library/Application Support'
        return {support / browser / 'NativeMessagingHosts' / name
                for browser in _MACOS_NATIVE_HOST_DIRS}
    if system == 'Windows':
        # The pinned original installer writes here and registers this exact
        # manifest path under the current user's Chrome native-host key.
        return {home / 'AppData/Local/OpenAI/extension' / name}
    config_roots = {home / '.config'}
    for key in ('XDG_CONFIG_HOME', 'CHROME_CONFIG_HOME'):
        if env.get(key):
            config_roots.add(Path(env[key]))
    paths = set()
    for config_root in config_roots:
        paths.update(config_root.glob(f'*/NativeMessagingHosts/{name}'))
        paths.update(config_root.glob(f'*/*/NativeMessagingHosts/{name}'))
    return paths


@contextlib.contextmanager
def _destination_lock(destination):
    """Serialize everything that changes one private host copy."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    path = destination.parent / f'.{destination.name}.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if sys.platform == 'win32':
            import msvcrt
            # Lock byte 0 without writing it: a write into a range another handle
            # holds fails with a lock violation instead of waiting. Windows allows
            # locking past the end of the file.
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if sys.platform == 'win32':
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


def _write_stamp(destination, digest):
    """Replace the digest with a staged regular file; a symlink at the name is replaced, never followed."""
    fd, staged = tempfile.mkstemp(prefix='.lcu-browser-stamp-', dir=destination)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(digest + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staged, destination / _PLUGIN_DIGEST)
    finally:
        Path(staged).unlink(missing_ok=True)


def _refresh_plugin(source, destination):
    """Publish the private plugin copy for `source` and its digest; recover interrupted updates.

    Must run under `_destination_lock`. The new copy is staged completely first and moved
    into place by rename. An interruption between the two renames leaves `chrome` missing
    and `.chrome-previous` present, which the next run restores before deciding what to do.
    The digest is written last, so a copy and digest that disagree only cause one more refresh.
    """
    plugin, retired = destination / 'chrome', destination / '.chrome-previous'
    if not plugin.exists() and retired.exists():
        retired.rename(plugin)
    elif plugin.exists():
        shutil.rmtree(retired, ignore_errors=True)
    for leftover in destination.glob('.lcu-browser-*'):
        if leftover.name in ('.lcu-browser-host', _PLUGIN_DIGEST):
            continue
        if leftover.is_dir() and not leftover.is_symlink():
            shutil.rmtree(leftover, ignore_errors=True)  # scratch from an interrupted refresh
        else:
            leftover.unlink(missing_ok=True)
    digest = _plugin_digest(source)
    stamp = destination / _PLUGIN_DIGEST
    current = (plugin.is_dir() and not plugin.is_symlink() and (plugin / 'scripts/installManifest.mjs').is_file()
               and stamp.is_file() and not stamp.is_symlink() and stamp.read_text().strip() == digest)
    if current:
        return
    scratch = Path(tempfile.mkdtemp(prefix='.lcu-browser-', dir=destination))
    try:
        shutil.copytree(source, scratch / 'chrome', symlinks=True)
        if plugin.exists() or plugin.is_symlink():
            if plugin.is_symlink():
                plugin.unlink()
            else:
                plugin.rename(retired)
        (scratch / 'chrome').rename(plugin)
        shutil.rmtree(retired, ignore_errors=True)
        _write_stamp(destination, digest)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def install(root, directory=None):
    from .runtime import environment, paths

    system = platform.system()
    if system not in ('Linux', 'Darwin', 'Windows'):
        raise ValueError('The original Chrome native host is supported on Linux, macOS, and Windows only.')
    # The upstream installer writes its host configuration beside the executable.
    # Keep the sealed release immutable; give this account a private host copy.
    home = (Path(os.environ.get('USERPROFILE', Path.home())) if system == 'Windows'
            else Path(os.environ.get('HOME', Path.home())))
    if system == 'Darwin':
        data = home / 'Library/Application Support'
    elif system == 'Windows':
        data = Path(os.environ.get('LOCALAPPDATA', home / 'AppData/Local'))
    else:
        data = Path(os.environ.get('XDG_DATA_HOME', home / '.local/share'))
    selected_app = paths(root)[0] if system == 'Windows' else (root / 'app').resolve()
    identity = hashlib.sha256(str(selected_app).encode()).hexdigest()[:16]
    destination = Path(directory).expanduser().absolute() if directory else data / 'lcu/browser' / identity
    with _destination_lock(destination):
        return _install_locked(root, system, destination, selected_app)


def _install_locked(root, system, destination, selected_app):
    from .runtime import environment, paths

    marker = destination / '.lcu-browser-host'
    expected = str(selected_app) + '\n'
    if destination.is_symlink():
        raise ValueError('The browser host directory must not be a symlink.')
    if destination.exists():
        if not marker.is_file() or marker.is_symlink() or marker.read_text() != expected:
            raise ValueError('The browser host directory belongs to another installation; select an empty directory.')
    selected = paths(root)
    env = environment(root, selected)
    # Runtime selection returns the original resource tree. Linux stores it
    # under app/resources; macOS stores it under app/Contents/Resources.
    source = selected[1] / 'plugins/openai-bundled/plugins/chrome'
    if not (source / 'scripts/installManifest.mjs').is_file():
        raise ValueError('The complete upstream Chrome plugin is missing from this bundle.')
    # The app can be upgraded in place at the same path, so the private copy follows the
    # content of the selected plugin, not only the app path.
    if not destination.exists():
        scratch = Path(tempfile.mkdtemp(prefix='.lcu-browser-', dir=destination.parent))
        try:
            shutil.copytree(source, scratch / 'chrome', symlinks=True)
            (scratch / '.lcu-browser-host').write_text(expected)
            (scratch / _PLUGIN_DIGEST).write_text(_plugin_digest(source) + '\n')
            scratch.rename(destination)
        finally:
            if scratch.exists():
                shutil.rmtree(scratch)
    else:
        _refresh_plugin(source, destination)
    relay_source = root / 'lcu/native_host.py'
    if not relay_source.is_file():
        raise ValueError('The LCU Chrome native-host relay is missing from this release.')
    relay = destination / ('lcu-native-host.py' if system == 'Windows' else 'lcu-native-host')
    with tempfile.NamedTemporaryFile(dir=destination, prefix='.lcu-native-host-', delete=False) as staged:
        staged_path = Path(staged.name)
    try:
        shutil.copyfile(relay_source, staged_path)
        staged_path.chmod(0o700)
        staged_path.replace(relay)
    finally:
        staged_path.unlink(missing_ok=True)
    if system == 'Windows':
        # Chromium uses cmd.exe for a non-.exe native host. The wrapper emits
        # no text before Python's binary native-messaging frames.
        command = destination / 'lcu-native-host.cmd'
        command.write_text(
            f'@echo off\r\n"{sys.executable}" -B -u "%~dp0lcu-native-host.py" %*\r\n'
            'exit /b %ERRORLEVEL%\r\n', newline='')
        relay = command
    script = ('const {install} = await import(process.argv[1]); '
              'await install({appServerRuntimePaths:{codexCliPath:process.env.CODEX_CLI_PATH,'
              'nodePath:process.env.NODE_REPL_NODE_PATH,nodeReplPath:process.env.CUA_REPL_NODE_REPL_PATH}});')
    installed = capture.run([env['NODE_REPL_NODE_PATH'], '--input-type=module', '-e', script,
                             (destination / 'chrome/scripts/installManifest.mjs').as_uri()],
                            env=env, timeout=120)
    if installed.returncode:
        detail = installed.stderr.strip()[-2000:] or installed.stdout.strip()[-2000:]
        raise ValueError(f'The original Chrome installer failed (exit {installed.returncode}).'
                         + (f' {detail}' if detail else ''))
    # The pinned original installer returns no manifest list. Locate only its
    # native-host manifest name at the documented config depths, then require
    # each candidate to point at this selected private copy before changing it.
    manifest_paths = _manifest_paths(env, system)
    host_name = {'Linux': 'extension-host', 'Darwin': 'ChatGPT for Chrome',
                 'Windows': 'extension-host.exe'}[system]
    changed = 0
    for manifest_path in sorted(manifest_paths):
        if manifest_path.is_symlink():
            raise ValueError(f'Native-host manifest must be a regular file: {manifest_path}')
        if not manifest_path.is_file():
            continue
        manifest = json.loads(manifest_path.read_text())
        original = Path(manifest.get('path', ''))
        if (original.name != host_name or
                not original.resolve().is_relative_to((destination / 'chrome/extension-host').resolve())):
            continue
        manifest['path'] = str(relay)
        with tempfile.NamedTemporaryFile(mode='w', dir=manifest_path.parent,
                                         prefix='.lcu-manifest-', delete=False) as staged:
            staged_path = Path(staged.name)
            json.dump(manifest, staged, indent=2)
            staged.write('\n')
        try:
            staged_path.chmod(0o644)
            staged_path.replace(manifest_path)
        finally:
            staged_path.unlink(missing_ok=True)
        changed += 1
    if changed == 0:
        raise ValueError('The original Chrome installer produced no manifest for the selected host.')
    if system == 'Windows':
        key = r'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openai.codexextension'
        registered = subprocess.run(['reg.exe', 'query', key, '/ve'],
                                    capture_output=True, text=True, timeout=20)
        if registered.returncode or str(next(iter(manifest_paths))) not in registered.stdout:
            raise ValueError('The original Chrome installer did not register the selected manifest for this account.')
    return destination


def status(root, family='chrome'):
    """Report setup from upstream diagnostics; this is not a connection test."""
    from .runtime import environment, paths

    selected = paths(root)
    env = environment(root, selected)
    plugin = selected[1] / 'plugins/openai-bundled/plugins/chrome'
    config = json.loads((plugin / 'scripts/extension-ids.json').read_text())
    browser = next(item for item in config['browserDiagnostics']
                   if item['browserFamily'] == family)

    def check(script):
        result = capture.run(
            [env['NODE_REPL_NODE_PATH'], str(plugin / 'scripts' / script),
             '--browser', family, '--json'], env=env, timeout=20)
        try:
            parsed = json.loads(result.stdout)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
        if result.stderr.strip():
            return {'problem': result.stderr.strip()}
        size = len(result.stdout.encode())
        return {'problem': 'The original diagnostic output could not be parsed '
                           f'({size} bytes).' if size else 'The original diagnostic returned no result.'}

    extension = check('check-extension-installed.js')
    manifest = check('check-native-host-manifest.js')
    label = browser['shortDisplayName']
    profile = extension.get('selectedProfileDirectory')
    suffix = f' in {profile}' if profile else ''
    enabled = extension.get('enabled') is True
    if enabled:
        print(f'{label} extension: enabled{suffix}.')
    elif extension.get('installed'):
        print(f'{label} extension: disabled{suffix}. Enable it at {browser["extensionManagementUrl"]}.')
    elif extension.get('problem'):
        print(f'{label} extension: could not check. {extension["problem"]}')
        print(f'  Open {label} once and install or enable the official extension: {browser["storeUrl"]}')
    else:
        print(f'{label} extension: not found{suffix}.')
        print(f'  Install the official extension in the profile you want to use: {browser["storeUrl"]}')

    connected_host = False
    if manifest.get('correct') and manifest.get('manifestPath'):
        try:
            data = json.loads(Path(manifest['manifestPath']).read_text())
            relay = Path(data['path'])
            directory = relay.parent
            arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
            system, name = {'Darwin': ('macos', 'ChatGPT for Chrome'),
                            'Linux': ('linux', 'extension-host'),
                            'Windows': ('windows', 'extension-host.exe')}[platform.system()]
            host = directory / 'chrome/extension-host' / system / arch / name
            relay_name = 'lcu-native-host.cmd' if system == 'windows' else 'lcu-native-host'
            source_matches = ((directory / 'lcu-native-host.py').read_bytes() ==
                              (root / 'lcu/native_host.py').read_bytes()) if system == 'windows' else (
                              relay.read_bytes() == (root / 'lcu/native_host.py').read_bytes())
            connected_host = (
                relay.name == relay_name and relay.is_file() and os.access(relay, os.X_OK)
                and source_matches
                and (directory / '.lcu-browser-host').read_text() == str(
                    selected[0] if system == 'windows' else (root / 'app').resolve()) + '\n'
                and (directory / _PLUGIN_DIGEST).read_text().strip() == _plugin_digest(plugin)
                and host.is_file() and os.access(host, os.X_OK))
        except (KeyError, OSError, ValueError):
            pass
    if connected_host:
        print(f'{label} connector: configured for this LCU installation.')
    else:
        print(f'{label} connector: missing or outdated. Run `lcu browser install`.')
    print(f'Live browser connection: not checked. After setup, ask your agent to use LCU to list {label} tabs.')
    return enabled and connected_host


def main(root, argv):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='action', required=True)
    setup = subparsers.add_parser('install', help='Install the original native host for the current desktop account')
    setup.add_argument('--directory', type=Path, help='Private writable host directory')
    check = subparsers.add_parser('status', help='Check extension and connector setup without changing the browser')
    check.add_argument('--browser', choices=('chrome', 'edge'), default='chrome')
    if argv[:1] in (['serve'], ['protocol']):
        parser.error('the in-app browser host and codex:// protocol commands were removed; use the installed app browser. For external Chrome, run `lcu browser install` and enable the official ChatGPT extension.')
    args = parser.parse_args(argv)
    if args.action == 'status':
        if not status(root, args.browser):
            raise SystemExit(1)
        return
    destination = install(root, args.directory)
    print(f'LCU browser native host configured: {destination}')
    print('Install or enable the official ChatGPT browser extension in the browser you want to use.')
    print('The extension and browser must run under this same desktop account. See docs/INSTALLATION.md.')
    print('Check extension and connector setup with: lcu browser status')
