"""Connect installed Chromium browsers using OpenAI's original native host."""
import argparse
import collections
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import re
import shutil
import stat
import subprocess
import sys
import tempfile

from . import capture
from .sandbox_shim import unshimmed_env


_MACOS_NATIVE_HOST_DIRS = (
    'Google/Chrome', 'Chromium', 'Google/ChromeForTesting',
    'Google/Chrome for Testing', 'Microsoft Edge',
    'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Vivaldi',
)


_PLUGIN_DIGEST = '.lcu-browser-plugin'
# The relay imports only the standard library and must stay parseable by this Python.
_RELAY_MINIMUM = (3, 8)


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


def _data_root(system, env=None):
    """Where this account keeps LCU's private browser host copies."""
    env = os.environ if env is None else env
    home = (Path(env.get('USERPROFILE', Path.home())) if system == 'Windows'
            else Path(env.get('HOME', Path.home())))
    if system == 'Darwin':
        data = home / 'Library/Application Support'
    elif system == 'Windows':
        data = Path(env.get('LOCALAPPDATA', home / 'AppData/Local'))
    else:
        data = Path(env.get('XDG_DATA_HOME', home / '.local/share'))
    return data / 'lcu/browser'


def _host_location(root, directory=None, env=None):
    """(system, destination, selected_app) of the private host copy `lcu browser install` keeps for `root`."""
    from .runtime import paths

    system = platform.system()
    if system not in ('Linux', 'Darwin', 'Windows'):
        raise ValueError('The original Chrome native host is supported on Linux, macOS, and Windows only.')
    # The upstream installer writes its host configuration beside the executable.
    # Keep the sealed release immutable; give this account a private host copy.
    selected_app = paths(root)[0] if system == 'Windows' else (root / 'app').resolve()
    identity = hashlib.sha256(str(selected_app).encode()).hexdigest()[:16]
    destination = Path(directory).expanduser().absolute() if directory else _data_root(system, env) / identity
    return system, destination, selected_app


def install(root, directory=None):
    system, destination, selected_app = _host_location(root, directory)
    with _destination_lock(destination):
        return _install_locked(root, system, destination, selected_app)


def _write_private(directory, path, data):
    """Publish `path` atomically with owner-only permissions."""
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.lcu-native-host-', delete=False) as staged:
        staged_path = Path(staged.name)
        staged.write(data)
    try:
        staged_path.chmod(0o700)
        staged_path.replace(path)
    finally:
        staged_path.unlink(missing_ok=True)


def _posix_wrapper(python, script, extra_dirs=None, system_python='/usr/bin/python3'):
    """Shell launcher for the relay: LCU's interpreter, else the same search as lcu/interpreter.py.

    It prints nothing to stdout, which carries Chrome's native-messaging frames.
    """
    from . import interpreter

    names = ' '.join(shlex.quote(name) for name in interpreter.NAMES)
    extra = ':'.join(interpreter.EXTRA_DIRS if extra_dirs is None else extra_dirs)
    # The relay itself runs on older Pythons; the system one is a last resort if it is new enough for that.
    relay_check = f'import sys; sys.exit(sys.version_info < {_RELAY_MINIMUM})'
    return f"""#!/bin/sh
# Written by `lcu browser install`. Chrome starts native hosts with a minimal PATH.
script={shlex.quote(str(script))}
python={shlex.quote(python)}
if [ ! -x "$python" ]; then
  python=
  search="$PATH:"{shlex.quote(extra)}
  set -f
  for name in {names}; do
    old_ifs=$IFS
    IFS=:
    for dir in $search; do
      IFS=$old_ifs
      if [ -x "$dir/$name" ] && "$dir/$name" -c {shlex.quote(interpreter.CHECK)} >/dev/null 2>&1; then
        python=$dir/$name
        break 2
      fi
    done
    IFS=$old_ifs
  done
  set +f
  if [ -z "$python" ] && [ -x {shlex.quote(system_python)} ] \\
      && {shlex.quote(system_python)} -c {shlex.quote(relay_check)} >/dev/null 2>&1; then
    python={shlex.quote(system_python)}
  fi
  if [ -z "$python" ]; then
    echo 'LCU Chrome native-host relay failed: no suitable Python was found.' >&2
    exit 127
  fi
fi
exec "$python" -B -u "$script" "$@"
"""


def _wrapper_is_current(text, script):
    """True when `text` is exactly the launcher this release writes for `script`, whatever interpreter it pins."""
    for line in text.splitlines():
        if line.startswith('python='):
            try:
                (python,) = shlex.split(line[len('python='):])
            except ValueError:
                return False
            return text == _posix_wrapper(python, script)
    return False


def _install_locked(root, system, destination, selected_app, env_overrides=None):
    from .runtime import environment, paths

    marker = destination / '.lcu-browser-host'
    expected = str(selected_app) + '\n'
    if destination.is_symlink():
        raise ValueError('The browser host directory must not be a symlink.')
    if destination.exists():
        if not marker.is_file() or marker.is_symlink() or marker.read_text() != expected:
            raise ValueError('The browser host directory belongs to another installation; select an empty directory.')
    selected = paths(root)
    # The persisted Codex path is the real executable, not the sandbox shim.
    env = unshimmed_env(environment(root, selected))
    for key, value in (env_overrides or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
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
    relay_script = destination / 'lcu-native-host.py'
    _write_private(destination, relay_script, relay_source.read_bytes())
    relay = destination / 'lcu-native-host'
    if system != 'Windows':
        # Chrome starts native hosts with launchd's short PATH, so pin the interpreter
        # LCU runs on instead of letting a shebang find whatever python3 comes first.
        _write_private(destination, relay, _posix_wrapper(sys.executable, relay_script).encode())
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
        if not _windows_registered(next(iter(manifest_paths))):
            raise ValueError('The original Chrome installer did not register the selected manifest for this account.')
    return destination


def _launcher_dir(manifest_path):
    """The directory of the launcher the regular manifest file `manifest_path` names, else None."""
    try:
        if manifest_path.is_symlink() or not manifest_path.is_file():
            return None
        return Path(json.loads(manifest_path.read_text()).get('path', '')).parent
    except (OSError, ValueError, AttributeError):
        return None


def _points_into(manifest_path, directories):
    return _launcher_dir(manifest_path) in directories


def _marker_beside(manifest_path):
    directory = _launcher_dir(manifest_path)
    return directory is not None and (directory / '.lcu-browser-host').is_file()


def _read_or_none(path):
    """The bytes of `path`, None when it does not exist. Any other failure propagates."""
    try:
        return path.read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return None


def _file_state(path):
    """(bytes, permission bits) of `path`, None when it does not exist."""
    data = _read_or_none(path)
    return None if data is None else (data, stat.S_IMODE(path.stat().st_mode))


def _restore(path, saved):
    """Put back what `path` held before, bytes and permissions (nothing, when `saved` is None)."""
    if path.is_symlink() or _file_state(path) == saved:
        return
    if saved is None:
        path.unlink(missing_ok=True)
        return
    data, mode = saved
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.lcu-manifest-', delete=False) as staged:
        staged_path = Path(staged.name)
        staged.write(data)
    try:
        staged_path.chmod(mode)
        staged_path.replace(path)
    finally:
        staged_path.unlink(missing_ok=True)


def _relay_snapshot(destination, system, manifest_paths):
    """The bytes Chrome and the extension depend on, to tell whether a refresh changed anything."""
    launcher = 'lcu-native-host.cmd' if system == 'Windows' else 'lcu-native-host'
    # The original installer also writes the host's runtime paths beside its binary.
    host_configs = sorted(destination.glob('chrome/extension-host/*/*/extension-host-config.json'))
    files = [destination / launcher, destination / 'lcu-native-host.py', destination / _PLUGIN_DIGEST,
             *host_configs, *sorted(manifest_paths)]
    return [(str(path), _file_state(path)) for path in files]


Refreshed = collections.namedtuple('Refreshed', 'status destination displaced')


def _owned_marker(directory, expected_app, apps):
    """The app a relay directory's marker records when this installation made it, else None.

    A directory is ours when its `.lcu-browser-host` marker names the selected app, or (Windows) a
    private app generation under this prefix: the Store app changed since `lcu browser install` ran.
    """
    marker = directory / '.lcu-browser-host'
    try:
        if directory.is_symlink() or marker.is_symlink() or not marker.is_file():
            return None
        recorded = marker.read_text()
    except OSError:
        return None
    app = os.path.normcase(recorded.strip())
    if recorded == expected_app or (apps and app.startswith(os.path.normcase(str(apps)) + os.sep)):
        return recorded
    return None


def _owned_relay_dirs(manifests, data_root, expected_app, apps):
    """{directory: recorded app} of this installation's relays: those the manifests name and those kept under `data_root`."""
    directories = {directory for directory in map(_launcher_dir, manifests) if directory is not None}
    try:
        directories.update(path for path in data_root.iterdir() if path.is_dir())
    except OSError:
        pass
    owned = {}
    for directory in directories:
        recorded = _owned_marker(directory, expected_app, apps)
        if recorded is not None:
            owned[directory] = recorded
    return owned


def _windows_registered(manifest_path):
    """True when the account's Chrome native-host registration names `manifest_path`."""
    key = r'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openai.codexextension'
    registered = subprocess.run(['reg.exe', 'query', key, '/ve'], capture_output=True, text=True, timeout=20)
    if registered.returncode:
        return False
    # `reg query` prints `    <value name>    REG_SZ    <data>`; the name is localized, so match the type.
    values = re.findall(r'REG_(?:EXPAND_)?SZ\s+(.*?)\s*$', registered.stdout, re.MULTILINE)

    def normal(text):
        return os.path.normcase(os.path.normpath(str(text)))
    return any(normal(value) == normal(manifest_path) for value in values)


def _scratch_environment(env, scratch):
    """Overrides that make the original installer write its manifests under `scratch`, plus real -> scratch roots."""
    roots = [(Path(env.get('HOME', Path.home())), scratch / 'home')]
    overrides = {'HOME': str(scratch / 'home'), 'XDG_CONFIG_HOME': None, 'CHROME_CONFIG_HOME': None}
    for key, name in (('XDG_CONFIG_HOME', 'xdg'), ('CHROME_CONFIG_HOME', 'chrome')):
        if env.get(key):
            roots.append((Path(env[key]), scratch / name))
            overrides[key] = str(scratch / name)
    return overrides, sorted(roots, key=lambda pair: len(pair[0].parts), reverse=True)


def _write_manifest(path, data):
    """Publish a manifest the way `_install_locked` does: staged beside it and renamed over it."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.lcu-manifest-', delete=False) as staged:
        staged_path = Path(staged.name)
        staged.write(data)
    try:
        staged_path.chmod(0o644)
        staged_path.replace(path)
    finally:
        staged_path.unlink(missing_ok=True)


def _refresh_in_scratch(root, system, destination, selected_app, ours, env, saved):
    """Run the install path with the original installer's manifests going to a scratch home, then publish ours.

    The original installer writes a manifest for every browser. Run against the real ones it would, for a
    moment or after a failure, point other owners' (or never set up) browsers at LCU's host and could
    overwrite what another installer wrote meanwhile. In scratch it cannot touch them: only the manifests
    that already named this relay are then replaced, once the whole install path has succeeded.
    """
    with tempfile.TemporaryDirectory(prefix='lcu-browser-refresh-') as temporary:
        scratch = Path(temporary).resolve()
        overrides, roots = _scratch_environment(env, scratch)
        (scratch / 'home').mkdir()
        _install_locked(root, system, destination, selected_app, overrides)
        staged = {}
        for path in ours:
            twin = next((replacement / path.relative_to(real) for real, replacement in roots
                         if path.is_relative_to(real)), None)
            if twin is None or not twin.is_file():
                raise ValueError(f'The original Chrome installer produced no manifest for {path}.')
            staged[path] = twin.read_bytes()
        for path, data in staged.items():
            if _file_state(path) == saved[path]:  # changed or removed meanwhile by someone else: theirs now
                _write_manifest(path, data)


def refresh(root):
    """Refresh the relay a previous `lcu browser install` made for this installation; never enables Chrome.

    Returns Refreshed(status, destination, displaced). `status` is
      'absent'     no relay was installed for this installation, or its manifests were removed (nothing is touched),
      'elsewhere'  one is, but no native-host manifest (or Windows registry entry) points at it any more (nothing is touched),
      'root'       one is installed but this process runs as root (nothing is touched),
      'unchanged'  reinstalled; every relay file and manifest came out byte for byte the same,
      'changed'    reinstalled; the relay, its host configuration or its manifest differs, so Chrome must reconnect.
    `displaced` lists Chrome manifests that point somewhere other than a relay of this installation and were left alone.
    The relay is found from the manifests that name it and from LCU's host directory, so a custom `--directory`
    that is still registered and a Windows app generation that has since been replaced are found too. Errors
    propagate. The existing install path does the work; only manifests that already named the relay are replaced.
    """
    system = platform.system()
    if system not in ('Linux', 'Darwin', 'Windows'):
        return Refreshed('absent', None, [])
    env = dict(os.environ)
    as_root = hasattr(os, 'geteuid') and os.geteuid() == 0
    if as_root and env.get('SUDO_USER'):
        # `sudo lcu update` runs with root's home; look where the desktop account keeps its relay.
        try:
            import pwd
            env = {key: value for key, value in env.items()
                   if key not in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_CONFIG_HOME')}
            env['HOME'] = pwd.getpwnam(env['SUDO_USER']).pw_dir
        except (ImportError, KeyError):
            pass
    manifests = _manifest_paths(env, system)
    existing = sorted(path for path in manifests if path.is_file() or path.is_symlink())
    if not any(_marker_beside(path) for path in existing) and not _data_root(system, env).is_dir():
        return Refreshed('absent', None, [])  # never set up: do not even resolve the app
    system, default, selected_app = _host_location(root, env=env)
    expected = str(selected_app) + '\n'
    prefix = Path(root).resolve().parent.parent
    owned = _owned_relay_dirs(existing, _data_root(system, env), expected,
                              prefix / 'apps' if system == 'Windows' else None)
    if not owned:
        return Refreshed('absent', None, [])
    ours = sorted(path for path in existing if _points_into(path, owned))
    if not ours:
        if not existing:
            return Refreshed('absent', None, [])
        # The ChatGPT app (or the user) took the manifest back. Re-pointing it is what the explicit
        # `lcu browser install` is for; an update must not take the connector from another owner.
        return Refreshed('elsewhere', default, [])
    # Reinstall where the relay is. A replaced app generation moves to the directory of the selected one.
    active = {directory for directory in map(_launcher_dir, ours)}
    current = sorted(directory for directory in active if owned.get(directory) == expected)
    destination = default if default in active else (current[0] if current else default)
    if system == 'Windows' and not _windows_registered(ours[0]):
        # The original installer would replace the registration; another owner holds it, so only report.
        return Refreshed('elsewhere', default, [])
    if as_root:
        # `sudo lcu update` must not write root-owned files into the desktop account's browser setup.
        return Refreshed('root', destination, [])
    displaced = [path for path in existing if path not in ours and 'chrome' in str(path).lower()]
    with _destination_lock(destination):
        before = _relay_snapshot(destination, system, ours)
        saved = {path: _file_state(path) for path in ours}
        try:
            if system == 'Windows':
                # One manifest, already ours, and the registry entry is checked above; the installer
                # records the manifest path in HKCU, so it has to write the real one.
                _install_locked(root, system, destination, selected_app)
            else:
                _refresh_in_scratch(root, system, destination, selected_app, ours, env, saved)
        except BaseException:
            if system == 'Windows':
                # Only the real manifest was written, and it may now name the original host instead of
                # the relay. Put it back only in that state; a later change by someone else stays theirs.
                for path, state in saved.items():
                    directory = _launcher_dir(path)
                    if directory is not None and directory.is_relative_to(destination / 'chrome/extension-host'):
                        _restore(path, state)
            raise
        after = _relay_snapshot(destination, system, ours)
    return Refreshed('unchanged' if before == after else 'changed', destination, displaced)


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
    foreign_host = None
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
            expected_app = str(selected[0] if system == 'windows' else (root / 'app').resolve()) + '\n'
            try:
                own_relay = (relay.name == relay_name
                             and (directory / '.lcu-browser-host').read_text() == expected_app)
            except OSError:
                own_relay = False
            if not own_relay:
                foreign_host = str(relay)
            script = directory / 'lcu-native-host.py'
            source_matches = script.read_bytes() == (root / 'lcu/native_host.py').read_bytes()
            if system != 'windows':
                # The launcher Chrome runs must be ours and must point at this script.
                source_matches = source_matches and _wrapper_is_current(relay.read_text(), script)
            connected_host = (
                relay.name == relay_name and relay.is_file() and os.access(relay, os.X_OK)
                and source_matches
                and own_relay
                and (directory / _PLUGIN_DIGEST).read_text().strip() == _plugin_digest(plugin)
                and host.is_file() and os.access(host, os.X_OK))
        except (KeyError, OSError, ValueError):
            pass
    if connected_host:
        print(f'{label} connector: configured for this LCU installation.')
    elif foreign_host:
        print(f'{label} connector: the native-host manifest points to {foreign_host}, not this LCU installation\'s relay. '
              f'Run `lcu browser install`, then {_reconnect_step(browser)}')
    else:
        print(f'{label} connector: missing or outdated. Run `lcu browser install`.')
    print(f'Live browser connection: not checked. After setup, {_reconnect_step(browser)} '
          f'Then ask your agent to use LCU to list {label} tabs.')
    return enabled and connected_host


def _reconnect_step(browser):
    return (f'restart {browser["shortDisplayName"]}, or turn the ChatGPT extension off and on at '
            f'{browser["extensionManagementUrl"]}, so an already-connected extension reconnects through LCU\'s relay.')


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
    print('If the extension was already connected, restart the browser or turn the extension off and on in its extensions page so it reconnects through LCU\'s relay.')
    print('Check extension and connector setup with: lcu browser status')
