#!/usr/bin/env python3
"""Install thin LCU beside the current user's official Windows Store app.

Install-time bridge only (stdlib Python 3.12 or later, as before: bundle.verify uses hashlib.file_digest and the
redirect checks use Path.is_junction). The registered Store app cannot be executed in place, so
this script makes the intact private copy of it, validates the copy completely, publishes the generation
atomically and then hands over to that copy's own node.exe, which runs scripts/install_windows.mjs. Nothing else
of the installation happens in Python. It ships as scripts/install_windows.py (the name `lcu update` of an
older release runs).
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from typing import Mapping

SOURCE = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bundle import architecture, verify

PROG = 'install_windows.py'
# lcu.setup.CLIENTS plus lcu.setup.ALIASES (checked against lcu/setup_clients.mjs by tests/node).
CLIENTS = ('codex', 'claude-code', 'pi', 'omp', 'hermes')
ALIASES = ('claude', 'oh-my-pi', 'hermes-agent')
APP_DOWNLOAD_URL = 'https://chatgpt.com/download/'

# ---- verbatim from lcu/windows.py (no imports of lcu: the Python runtime modules are gone) ----
PACKAGE_NAME = 'OpenAI.Codex'
PACKAGE_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
WINDOWS_REQUIRED_FILES = (
    'app/ChatGPT.exe',
    'app/resources/app.asar',
    'app/resources/cua_node/bin/node.exe',
    'app/resources/cua_node/bin/node_repl.exe',
    'app/resources/cua_node/manifest.json',
    'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
    'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe',
    'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/swift/x64/codex-computer-use-swift.exe',
    'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js',
    'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js',
    'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/computer_use_client.js',
    'app/resources/codex.exe',
    'app/resources/codex-code-mode-host.exe',
    'app/resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
    'app/resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe',
    'app/resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
)


class InstalledWindowsApplication:
    def __init__(self, app, resources, runtime, launcher, backend, version, arch, runtime_version,
                 inventory, inventory_digest):
        self.app = app
        self.resources = resources
        self.runtime = runtime
        self.launcher = launcher
        self.backend = backend
        self.version = version
        self.arch = arch
        self.runtime_version = runtime_version
        self.inventory = inventory
        self.inventory_digest = inventory_digest


def _sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _redirected(path):
    path = Path(path)
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def application_inventory(app):
    """Hash the selected Store package tree for managed-copy integrity checks."""
    app = Path(app)
    root = app.lstat()
    if not stat.S_ISDIR(root.st_mode) or _redirected(app):
        raise ValueError(f'Windows application directory is missing or redirected: {app}')
    inventory = {'.': {'type': 'directory'}}
    def unreadable(error):
        raise ValueError(f'Windows application tree cannot be read: {error.filename}') from error
    for parent, directories, files in os.walk(app, followlinks=False, onerror=unreadable):
        parent = Path(parent)
        for name in sorted(directories + files):
            path = parent / name
            relative = path.relative_to(app).as_posix()
            info = path.lstat()
            if _redirected(path):
                raise ValueError(f'Windows application contains a redirected path: {path}')
            if stat.S_ISDIR(info.st_mode):
                inventory[relative] = {'type': 'directory'}
            elif stat.S_ISREG(info.st_mode):
                inventory[relative] = {'type': 'file', 'sha256': _sha256(path)}
            else:
                raise ValueError(f'Windows application contains an unsupported file: {path}')
    return inventory


def inventory_sha256(inventory):
    encoded = json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _appx_identity(app):
    if _redirected(app) or not app.is_dir():
        raise ValueError('Windows package application directory is missing or redirected.')
    manifest_path = app / 'AppxManifest.xml'
    if _redirected(manifest_path) or not manifest_path.is_file():
        raise ValueError('Windows package identity manifest is missing or redirected.')
    try:
        root = ET.parse(manifest_path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise ValueError('Windows package identity manifest is invalid.') from exc
    identity = next((node for node in root.iter()
                     if node.tag.rsplit('}', 1)[-1] == 'Identity'), None)
    if identity is None:
        raise ValueError('Windows package identity is missing.')
    name, publisher = identity.get('Name'), identity.get('Publisher')
    version, architecture = identity.get('Version'), identity.get('ProcessorArchitecture')
    if (name != PACKAGE_NAME or publisher != PACKAGE_PUBLISHER or
            not isinstance(version, str) or
            not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', version) or
            architecture not in ('x64', 'X64')):
        raise ValueError('Windows package identity, version, or architecture is invalid.')
    return name, publisher, version, architecture.lower()


def _registered_package():
    # Get-AppxPackage only sees packages registered for this account. Use its
    # InstallLocation rather than guessing the WindowsApps package volume.
    command = (
        "$ErrorActionPreference='Stop'; "
        "$packages=@(Get-AppxPackage -Name 'OpenAI.Codex'); "
        "$packages | Select-Object Name,Publisher,"
        "@{Name='Version';Expression={$_.Version.ToString()}},"
        "@{Name='Architecture';Expression={$_.Architecture.ToString()}},"
        "@{Name='SignatureKind';Expression={$_.SignatureKind.ToString()}},"
        'InstallLocation '
        '| ConvertTo-Json -Compress'
    )
    result = subprocess.run(
        ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        check=True, capture_output=True, text=True, timeout=30,
    )
    if not result.stdout.strip():
        raise ValueError('Install the official ChatGPT MSIX for this Windows account first.')
    parsed = json.loads(result.stdout)
    packages = parsed if isinstance(parsed, list) else [parsed]
    if len(packages) != 1 or not isinstance(packages[0], dict):
        raise ValueError('Expected exactly one registered OpenAI.Codex package for this account.')
    if (not isinstance(packages[0].get('Version'), str) or
            not isinstance(packages[0].get('Architecture'), str) or
            not isinstance(packages[0].get('SignatureKind'), str)):
        raise ValueError('Windows package query did not return string version, architecture and signature kind.')
    return packages[0]


def _component(app, relative):
    expected = app / relative
    if expected.is_file():
        return expected
    # MSIX stores `@` as `%40` in its OPC archive. Accept either spelling in
    # the deployed package, but no arbitrary path fallback.
    encoded = app / relative.replace('@oai/', '%40oai/')
    return encoded if encoded.is_file() else expected


def resolve_installed_windows_app():
    """Select and structurally validate the current user's official Store app."""
    _validate_host()
    package = _registered_package()
    if (package.get('Name') != PACKAGE_NAME or package.get('Publisher') != PACKAGE_PUBLISHER or
            str(package.get('Architecture')).lower() not in ('x64', 'amd64') or
            package.get('SignatureKind') != 'Store'):
        raise ValueError('Registered ChatGPT package is not the official Windows x64 Store app.')
    selected = package.get('InstallLocation')
    if not isinstance(selected, str) or not selected:
        raise ValueError('Registered ChatGPT package has no install location.')
    app = Path(selected)
    _, _, version, _ = _appx_identity(app)
    if str(package.get('Version')) != version:
        raise ValueError('Registered ChatGPT package version does not match its identity manifest.')
    manifest = _runtime_manifest(app)
    runtime_version = manifest['runtime_archive_version']
    # Capture the registered source's exact tree as the baseline for its
    # managed copy. The validator recomputes it before returning the selection.
    inventory = application_inventory(app)
    return validate_windows_app_tree(app, expected_version=version,
        expected_runtime=runtime_version, expected_inventory=inventory)


def _validate_host():
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise ValueError('The Windows application can only be validated on Windows x64.')


def _runtime_manifest(app):
    path = _component(app, 'app/resources/cua_node/manifest.json')
    if _redirected(path) or not path.is_file():
        raise ValueError('Windows CUA runtime manifest is missing or redirected.')
    try:
        manifest = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError('Windows CUA runtime manifest is invalid.') from exc
    if not isinstance(manifest, dict):
        raise ValueError('Windows CUA runtime manifest is invalid.')
    version = manifest.get('runtime_archive_version')
    if (manifest.get('platform') != 'windows' or manifest.get('arch') != 'x64' or
            not isinstance(version, str) or not version.strip()):
        raise ValueError('Windows CUA runtime manifest has an unsupported platform or architecture.')
    return manifest


def validate_windows_app_tree(app, *, expected_version, expected_runtime, expected_inventory):
    """Validate host layout and exact equality with a source-derived inventory."""
    _validate_host()
    if not expected_version or not expected_runtime or not isinstance(expected_inventory, Mapping):
        raise ValueError('A selected Windows version, runtime and source inventory are required.')
    app = Path(app)
    if _redirected(app) or not app.is_dir():
        raise ValueError('Windows application directory is missing or redirected.')
    app = app.resolve(strict=True)
    _, _, manifest_version, _ = _appx_identity(app)
    if manifest_version != expected_version:
        raise ValueError('Windows application identity version changed after selection.')
    resources = app / 'app/resources'
    runtime = resources / 'cua_node'
    for relative in WINDOWS_REQUIRED_FILES:
        file = _component(app, relative)
        if (not file.is_file() or _redirected(file) or
                any(_redirected(parent)
                    for parent in file.parents if parent != app and _is_relative_to(parent, app)) or
                not _is_relative_to(file.resolve(strict=True), app) or
                not file.resolve(strict=True).is_file()):
            raise ValueError(f'Required Windows application file is missing or outside the app: {relative}')
    manifest = _runtime_manifest(app)
    runtime_version = manifest['runtime_archive_version']
    if runtime_version != expected_runtime:
        raise ValueError('Windows CUA runtime changed after selection.')
    actual_inventory = application_inventory(app)
    if actual_inventory != expected_inventory:
        differing = sorted(set(actual_inventory) | set(expected_inventory))
        first = next((path for path in differing
                      if actual_inventory.get(path) != expected_inventory.get(path)), '<tree>')
        raise ValueError(f'Windows application differs from selected source inventory: {first}')
    launcher = _component(app, 'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
    return InstalledWindowsApplication(app, resources, runtime, launcher, 'windows',
                                       expected_version, 'x64', runtime_version,
                                       expected_inventory, inventory_sha256(expected_inventory))


def _is_relative_to(path, root):
    return path == root or root in path.parents


def app_prerequisite_message(location=None, *, alternate_location=False):
    message = ('LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. '
               'LCU does not download or install the app.')
    if location is not None:
        message += f' No app was found at {location}.'
    message += f' Install it from {APP_DOWNLOAD_URL} and rerun LCU.'
    if alternate_location:
        message += ' If it is installed elsewhere, pass --existing-app PATH.'
    return message


# ---- verbatim from scripts/install_windows.py (the copy and its validation) ----
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


def checked_prefix(prefix):
    prefix = Path(prefix)
    if not prefix.is_absolute() or '..' in prefix.parts or len(prefix.parts) < 3:
        raise ValueError('Choose a dedicated absolute Windows installation directory.')
    for item in (prefix, *prefix.parents):
        if _redirected(item):
            raise ValueError(f'Refusing a linked Windows installation path: {item}')
    prefix = prefix.resolve()
    if prefix == SOURCE.resolve() or _is_relative_to(SOURCE.resolve(), prefix):
        raise ValueError('Install outside the extracted release archive.')
    if prefix.exists() and any(prefix.iterdir()) and not (prefix / '.lcu-install').is_file():
        raise ValueError('Installation directory is occupied by another application.')
    if _redirected(prefix / '.lcu-install'):
        raise ValueError('Refusing a redirected Windows installation marker.')
    return prefix


def prepare_generation(prefix):
    """The part of scripts/install_windows.py install() that precedes the release: select the registered Store app
    and make (or reuse, after full validation) its intact private copy. Returns (generation, selected)."""
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
            raise ValueError(app_prerequisite_message() +
                             ' The app must be installed for the currently signed-in account.') from exc
        raise
    inventory = dict(selected.inventory)
    digest = inventory_sha256(inventory)
    if digest != selected.inventory_digest:
        raise ValueError('Selected Windows application inventory changed after validation.')
    # Keep the registered MSIX intact. Its protected WindowsApps directory does
    # not permit direct execution, so run an unchanged private copy instead.
    prefix.mkdir(parents=True, exist_ok=True)
    (prefix / '.lcu-install').touch(exist_ok=True)
    apps = prefix / 'apps'
    if _redirected(apps):
        raise ValueError(f'Refusing a redirected Windows app generation directory: {apps}')
    apps.mkdir(exist_ok=True)
    generation = _generation(prefix, digest)
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
        except BaseException:
            shutil.rmtree(_copy_path(stage), ignore_errors=True)
            raise
    return generation, selected


def build_parser():
    parser = argparse.ArgumentParser(prog=PROG, description=__doc__.split('\n\n')[0])
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'LCU'
    parser.add_argument('--prefix', type=Path, default=default)
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--agent', action='append', choices=CLIENTS + ALIASES)
    parser.add_argument('--chrome', action='store_true')
    parser.add_argument('--no-chrome', action='store_true')
    parser.add_argument('--audio', action='store_true')
    parser.add_argument('--no-audio', action='store_true')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--scope', choices=('user', 'project'), default='user')
    parser.add_argument('--project', type=Path)
    return parser


def validate_arguments(parser, args):
    """Reject bad argument combinations before the long private copy (same messages as install_windows.py)."""
    if args.runtime_only and (args.agent or args.chrome or args.audio or args.no_chrome
                              or args.no_audio or args.project or args.scope != 'user'):
        parser.error('--runtime-only cannot include agent setup options')
    if not args.runtime_only and not args.agent:
        parser.error('Choose --agent NAME or --runtime-only. Agents: ' + ', '.join(CLIENTS))


def node_executable(generation):
    """The private copy's node.exe (the generation was fully validated before this is run)."""
    return Path(generation) / 'app/app/resources/cua_node/bin/node.exe'


# The Node startup variables (BRIEF addendum B; same list as lcu/startup_vars.mjs, tests compare them).
QUARANTINED = (
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA', 'NODE_V8_COVERAGE',
    'NODE_COMPILE_CACHE', 'NODE_REDIRECT_WARNINGS', 'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_PRESERVE_SYMLINKS',
    'NODE_PRESERVE_SYMLINKS_MAIN', 'NODE_DISABLE_COLORS', 'NODE_SKIP_PLATFORM_CHECK', 'UV_THREADPOOL_SIZE',
    'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE',
    'NODE_TEST_CONTEXT', 'NODE_PENDING_PIPE_INSTANCES', 'UV_USE_IO_URING', 'FORCE_COLOR', 'NO_COLOR',
    'NODE_FORCE_READLINE', 'OPENSSL_CONF', 'OPENSSL_ENGINES', 'OPENSSL_MODULES', 'OPENSSL_ia32cap',
    'OPENSSL_armcap', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
)


def quarantined_environment(environ):
    """The caller's environment with Node's startup variables moved to __LCU_Q_<NAME> (restored by
    scripts/startup_env.mjs inside the installer, so its children see the caller's values unchanged)."""
    env = {key: value for key, value in environ.items() if not key.upper().startswith('__LCU_')}
    moved = []
    for name in QUARANTINED:
        key = next((key for key in env if key.upper() == name.upper()), None)
        if key is not None:
            env['__LCU_Q_' + name] = env.pop(key)
            moved.append(name)
    if moved:
        env['__LCU_Q'] = ','.join(moved)
    return env


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_arguments(parser, args)
    generation, _ = prepare_generation(args.prefix)
    node = node_executable(generation)
    command = [str(node), '--disable-warning=ExperimentalWarning', str(SOURCE / 'scripts/install_windows.mjs'),
               '--app-generation', str(generation), '--legacy-python', sys.executable, *argv]
    return subprocess.run(command, check=False, env=quarantined_environment(os.environ)).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SystemExit(f'LCU Windows installer: {exc}')
