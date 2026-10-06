"""Validate an installed official application for the original CUA runtime."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import platform as host_platform
import plistlib
import re
import stat
import subprocess

from .app_layout import locate_codex_tools
from .asar import read_asar_members


MAC_BUNDLE_ID = 'com.openai.codex'
MAC_HELPER_ID = 'com.openai.sky.CUAService'
OPENAI_TEAM_ID = '2DC432GLL2'
MAC_HELPER = Path('Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app')
MAC_REQUIRED_FILES = (
    'Resources/cua_node/bin/node',
    'Resources/cua_node/bin/node_repl',
    'Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
    'Resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
    'Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
)
MAC_EXECUTABLES = (
    'Resources/cua_node/bin/node',
    'Resources/cua_node/bin/node_repl',
)


# The signed helper binds its socket here (or at the path in this variable) and
# refuses a path longer than the AF_UNIX sun_path limit. LCU cannot change that
# in the helper; it can only detect it.
MAC_SOCKET_ENV = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH'
MAC_SOCKET_SUFFIX = f'Library/Group Containers/{OPENAI_TEAM_ID}.{MAC_HELPER_ID}/IPC/computeruse.sock'
MAC_SOCKET_MAX_BYTES = 103


def mac_socket_path(environ=None) -> tuple[str, bool]:
    """The socket path the signed Mac helper will try to bind, and whether the env override set it.

    SKY_CUA_SERVICE_NATIVE_PIPE_PATH in the given environment wins when set (the helper's own
    environment is not visible to LCU); otherwise the path is
    under the account's real home folder, not $HOME.
    """
    override = (os.environ if environ is None else environ).get(MAC_SOCKET_ENV)
    if override:
        return override, True
    import pwd
    return os.path.join(pwd.getpwuid(os.getuid()).pw_dir, MAC_SOCKET_SUFFIX), False


def mac_socket_path_problem(environ=None) -> str | None:
    """A message when the helper's socket path is too long to bind, else None."""
    path, overridden = mac_socket_path(environ)
    size = len(os.fsencode(path))
    if size <= MAC_SOCKET_MAX_BYTES:
        return None
    source = (f'The path comes from {MAC_SOCKET_ENV}.' if overridden else
              'The path comes from your home folder, so the ChatGPT app is affected too.')
    return (f"Computer Use cannot start for this macOS account: the ChatGPT helper's socket path is "
            f'{size} bytes (macOS limit {MAC_SOCKET_MAX_BYTES}): {path}. {source} '
            'LCU cannot change the signed helper. Use an account whose home folder path is short enough '
            '(13 ASCII characters or fewer after /Users/).')


@dataclass(frozen=True)
class InstalledApplication:
    app: Path
    resources: Path
    runtime: Path
    backend: str
    version: str
    arch: str
    codex_cli: Path
    code_mode_host: Path
    runtime_version: str


def _identity(bundle: Path, identifier: str) -> dict:
    info = bundle / 'Contents/Info.plist'
    if not info.is_file() or info.is_symlink():
        raise ValueError(f'Application bundle metadata is missing: {info}')
    with info.open('rb') as source:
        details = plistlib.load(source)
    if details.get('CFBundleIdentifier') != identifier:
        raise ValueError(f'Unexpected application bundle identifier: {bundle}')
    return details


def _verify_signature(bundle: Path, identifier: str) -> None:
    # `codesign` verifies sealed resources and nested code in place. The
    # installed app and signed helper are never copied or modified by LCU.
    verified = subprocess.run(
        ['codesign', '--verify', '--deep', '--strict', str(bundle)],
        capture_output=True, text=True, check=False, timeout=120,
    )
    if verified.returncode:
        detail = (verified.stderr or verified.stdout).strip().replace('\n', ' ')[:300]
        raise ValueError(f'Installed application signature verification failed: {bundle}: {detail}')
    identity = subprocess.run(
        ['codesign', '-dv', '--verbose=2', str(bundle)],
        capture_output=True, text=True, check=False, timeout=30,
    )
    if (identity.returncode or
            f'Identifier={identifier}' not in identity.stderr.splitlines() or
            f'TeamIdentifier={OPENAI_TEAM_ID}' not in identity.stderr.splitlines()):
        raise ValueError(f'Installed application signer does not match OpenAI: {bundle}')


def resolve_installed_mac_app(app_path: Path, *, arch: str | None = None) -> InstalledApplication:
    """Validate a local ChatGPT.app without relocating or modifying signed files."""
    if host_platform.system() != 'Darwin':
        raise ValueError('The macOS application can only be validated on macOS')
    app = Path(app_path).expanduser()
    if app.is_symlink() or not app.is_dir() or app.name != 'ChatGPT.app':
        raise ValueError(f'Expected a local ChatGPT.app directory: {app}')
    app = app.resolve(strict=True)
    architecture = arch or {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64'}.get(host_platform.machine())
    if architecture not in ('arm64', 'x64'):
        raise ValueError(f'Unsupported macOS architecture: {architecture}')
    contents = app / 'Contents'
    resources = contents / 'Resources'
    runtime = resources / 'cua_node'
    details = _identity(app, MAC_BUNDLE_ID)
    version = details.get('CFBundleShortVersionString')
    if not isinstance(version, str) or not version.strip():
        raise ValueError(f'Installed application version is missing: {app}')
    helper = contents / MAC_HELPER
    _identity(helper, MAC_HELPER_ID)
    manifest_path = runtime / 'manifest.json'
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError('Installed application CUA manifest is missing')
    manifest = json.loads(manifest_path.read_text())
    runtime_version = manifest.get('runtime_archive_version')
    if (manifest.get('platform') != 'darwin' or manifest.get('arch') != architecture or
            not isinstance(runtime_version, str) or not runtime_version.strip()):
        raise ValueError('Installed application CUA runtime has an incompatible platform or architecture')
    for relative in MAC_REQUIRED_FILES:
        file = contents / relative
        if not file.is_file() or file.is_symlink():
            raise ValueError(f'Required application file is missing or invalid: {relative}')
        if relative in MAC_EXECUTABLES and not os.access(file, os.X_OK):
            raise ValueError(f'Installed application executable is not executable: {relative}')
    tools = locate_codex_tools(resources)
    for executable in (tools.cli, tools.code_mode_host):
        if not os.access(executable, os.X_OK):
            raise ValueError(f'Installed application executable is not executable: {executable.relative_to(contents)}')
    _verify_signature(app, MAC_BUNDLE_ID)
    _verify_signature(helper, MAC_HELPER_ID)
    return InstalledApplication(app, resources, runtime, 'mac', version, architecture,
                                tools.cli, tools.code_mode_host, runtime_version)


LINUX_APP_PATH = Path('/usr/lib/chatgpt')
_VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9.+:~_-]*')


def _linux_version(app: Path, arch: str) -> str:
    """Read the selected app version, or confirm that dpkg owns its exact path."""
    try:
        package = json.loads(read_asar_members(app / 'resources/app.asar', ('package.json',))['package.json'])
        version = package.get('version')
        if isinstance(version, str) and _VERSION.fullmatch(version):
            return version
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        pass
    executable = app / 'ChatGPT'
    try:
        ownership = subprocess.run(['dpkg-query', '-S', '--', str(executable)],
                                   check=True, capture_output=True, text=True, timeout=20)
        owners = [owner for owner, separator, path in
                  (line.partition(': ') for line in ownership.stdout.splitlines())
                  if separator and Path(path) == executable and owner.split(':', 1)[0] == 'chatgpt']
        if len(owners) != 1:
            raise ValueError('No unique chatgpt package owns the selected executable path')
        fields = subprocess.run(['dpkg-query', '-W', '--showformat=%v %a', owners[0]],
                                check=True, capture_output=True, text=True, timeout=20).stdout.split()
        expected_arch = 'arm64' if arch == 'arm64' else 'amd64'
        if len(fields) != 2 or fields[1] != expected_arch:
            raise ValueError('The selected dpkg-owned ChatGPT path has the wrong architecture')
        if _VERSION.fullmatch(fields[0]):
            return fields[0]
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError('Cannot determine the selected app version from app.asar or its dpkg-owned path') from exc
    raise ValueError('Cannot determine the selected app version from app.asar or its dpkg-owned path')


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


_ACL_ACCESS = 'system.posix_acl_access'
_ACL_USER, _ACL_GROUP, _ACL_MASK = 0x02, 0x08, 0x10
_ACL_WRITE = 0x02


def _group_members(gid: int) -> set[int] | None:
    """Every account that holds `gid` as its primary or a supplementary group (None: unknown)."""
    try:
        import grp
        import pwd
    except ImportError:
        return None
    members = set()
    try:
        for name in grp.getgrgid(gid).gr_mem:
            try:
                members.add(pwd.getpwnam(name).pw_uid)
            except KeyError:
                pass
    except KeyError:
        pass
    members.update(account.pw_uid for account in pwd.getpwall() if account.pw_gid == gid)
    return members


def _posix_acl(path: Path) -> bytes | None:
    """The raw access ACL when the entry has one (Linux xattr); None when absent or unreadable."""
    if not (hasattr(os, 'listxattr') and hasattr(os, 'getxattr')):
        return None
    try:
        if _ACL_ACCESS not in os.listxattr(path, follow_symlinks=False):
            return None
        return os.getxattr(path, _ACL_ACCESS, follow_symlinks=False)
    except OSError:
        return None


def _acl_writers_untrusted(blob: bytes, trusted: set[int], group_members) -> str | None:
    """Why a named-user or named-group ACL entry lets an untrusted account write, if one does.

    Entries are (tag u16, perm u16, id u32) after a 4-byte version header. Named entries are
    limited by the mask, so only entries whose permission and the mask both include write count.
    """
    if len(blob) < 4 or (len(blob) - 4) % 8 or int.from_bytes(blob[:4], 'little') != 2:
        return 'carrying a POSIX ACL LCU cannot read'
    entries = [(int.from_bytes(blob[i:i + 2], 'little'), int.from_bytes(blob[i + 2:i + 4], 'little'),
                int.from_bytes(blob[i + 4:i + 8], 'little')) for i in range(4, len(blob), 8)]
    masks = [perm for tag, perm, _ in entries if tag == _ACL_MASK]
    mask = masks[0] if masks else 0x7
    for tag, perm, ident in entries:
        if not perm & mask & _ACL_WRITE:
            continue
        if tag == _ACL_USER and ident not in trusted:
            return f'writable by uid {ident} through a POSIX ACL'
        if tag == _ACL_GROUP:
            members = group_members(ident)
            if members is None or not members <= trusted:
                return f'writable by group {ident} through a POSIX ACL'
    return None


def _untrusted_entry(path: Path, info: os.stat_result, trusted: set[int], group_members=_group_members) -> str | None:
    """Why this entry lets another account change what the desktop account executes.

    A symlink's own mode is meaningless; only its owner counts. Group write is accepted only
    when every account in that group is trusted (root's group normally has no unprivileged
    member); named-user and named-group POSIX ACL entries with write are judged the same way.
    Limits: group membership comes from the local account database, so members supplied by
    a directory service or granted later are not seen, and ACLs are only read where the
    platform exposes them as the `system.posix_acl_access` extended attribute (Linux).
    """
    if info.st_uid not in trusted:
        return f'owned by uid {info.st_uid}'
    if stat.S_ISLNK(info.st_mode):
        return None
    sticky_directory = stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX
    if info.st_mode & stat.S_IWOTH and not sticky_directory:
        # A sticky directory (like /tmp) only lets accounts add entries; they cannot
        # replace ones owned by someone else.
        return 'writable by group or other accounts'
    if info.st_mode & stat.S_IWGRP and not sticky_directory:
        members = group_members(info.st_gid)
        if members is None or not members <= trusted:
            return 'writable by group or other accounts'
    blob = _posix_acl(path)
    if blob is not None:
        return _acl_writers_untrusted(blob, trusted, group_members)
    return None


def _check_trusted_tree(app: Path, files: tuple[Path, ...], trees: tuple[Path, ...], trusted: set[int]) -> None:
    """Refuse a tree where accounts other than root and the desktop account could replace code.

    Covers the executables the runtime launches and every directory above them up to `/`, plus
    the complete trees the desktop account executes from (the CUA runtime and the Chrome,
    browser and computer-use plugins). Symlinks may only point inside the app; each target and
    its ancestors are validated, and a linked directory is walked once (cycles are ignored).
    Read-only mounts are checked like any other: ownership and mode say who could change
    the files through another view of the same source.
    """
    problems = []
    seen = set()
    groups = {}

    def members(gid):
        if gid not in groups:
            groups[gid] = _group_members(gid)
        return groups[gid]

    pending = []
    inspected, walked = {}, set()

    def check(path: Path, walk: bool = False):
        """Validate one entry. With `walk`, also validate what it leads to (a link's target, a directory's contents)."""
        if path not in inspected:
            try:
                info = path.lstat()
            except OSError as exc:
                problems.append(f'{path} cannot be inspected ({exc.strerror})')
                inspected[path] = None
                return
            inspected[path] = info
            reason = _untrusted_entry(path, info, trusted, members)
            if reason:
                problems.append(f'{path} is {reason}')
        info = inspected[path]
        if info is None:
            return
        if stat.S_ISLNK(info.st_mode):
            try:
                real = path.resolve(strict=True)
            except (OSError, RuntimeError):
                if path not in walked:
                    problems.append(f'{path} is a broken or looping link')
                walked.add(path)
                return
            if not _within(real, app):
                if path not in walked:
                    problems.append(f'{path} links outside the application ({real})')
                walked.add(path)
                return
            if path not in walked:
                walked.add(path)
                pending.append(real)  # the target is validated and, if a directory, walked
        elif walk and stat.S_ISDIR(info.st_mode) and path not in walked:
            walked.add(path)
            try:
                pending.extend(Path(entry.path) for entry in os.scandir(path))
            except OSError as exc:
                problems.append(f'{path} cannot be read ({exc.strerror})')

    def ancestors(path: Path):
        for candidate in (path, *path.parents):
            check(candidate)

    for path in files:
        real = path.resolve(strict=True)
        if not _within(real, app):
            problems.append(f'{path} resolves outside the application ({real})')
            continue
        for candidate in (*path.parents, path):  # links on the unresolved path count too
            if _within(candidate, app):
                check(candidate)
        ancestors(real)
    for tree in trees:
        real = tree.resolve(strict=True)
        if not _within(real, app):
            problems.append(f'{tree} resolves outside the application ({real})')
            continue
        ancestors(real)
        pending.append(real)
    while pending:
        path = pending.pop()
        check(path, walk=True)
        if not path.is_symlink():
            ancestors(path)
    if problems:
        shown = '; '.join(problems[:3]) + (f'; and {len(problems) - 3} more' if len(problems) > 3 else '')
        raise ValueError('The application is not in a location only root and this account can change: '
                         f'{shown}. Install the app with a package manager or make it root-owned and not '
                         'writable by other accounts')


def resolve_installed_linux_app(app_path: Path, *, arch: str,
                               trusted_uids: set[int] | None = None) -> InstalledApplication:
    """Validate an installed ChatGPT Linux app in place, without copying or modifying it."""
    app = Path(app_path).expanduser()
    if not app.is_dir():
        raise ValueError(f'Expected an installed ChatGPT application directory: {app}')
    app = app.resolve(strict=True)
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    manifest_path = runtime / 'manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError(f'Application runtime manifest is missing: {manifest_path}')
    manifest = json.loads(manifest_path.read_text())
    runtime_version = manifest.get('runtime_archive_version')
    if (manifest.get('platform') != 'linux' or manifest.get('arch') != arch or
            not isinstance(runtime_version, str) or not runtime_version.strip()):
        raise ValueError('Application runtime manifest has an unsupported platform, architecture, or version')
    tools = locate_codex_tools(resources)
    extension_host = resources / f'plugins/openai-bundled/plugins/chrome/extension-host/linux/{arch}/extension-host'
    required = (
        app / 'ChatGPT', runtime / 'bin/node', runtime / 'bin/node_repl',
        runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
        tools.cli, tools.code_mode_host, resources / 'app.asar',
        resources / 'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
        extension_host,
        resources / 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
    )
    missing = [str(path) for path in required if path.is_symlink() or not path.is_file()]
    browser_plugin = resources / 'plugins/openai-bundled/plugins/browser'
    if browser_plugin.is_symlink() or not browser_plugin.is_dir():
        missing.append(str(browser_plugin))
    if missing:
        raise ValueError('Application payload is incomplete: ' + ', '.join(missing))
    for path in (app / 'ChatGPT', runtime / 'bin/node', runtime / 'bin/node_repl',
                 tools.cli, tools.code_mode_host, extension_host):
        if not os.access(path, os.X_OK):
            raise ValueError(f'Application executable is not executable: {path}')
    trusted = {0, os.getuid(), os.geteuid()} | set(trusted_uids or ())
    modules = runtime / 'lib/node_modules'
    plugins = resources / 'plugins/openai-bundled/plugins'
    _check_trusted_tree(app, (*required, *((modules,) if modules.exists() else ())),
                        (runtime, plugins / 'chrome', browser_plugin, plugins / 'unified-computer-use'), trusted)
    return InstalledApplication(app, resources, runtime, 'linux', _linux_version(app, arch), arch,
                                tools.cli, tools.code_mode_host, runtime_version)
