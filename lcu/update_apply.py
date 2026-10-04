"""`lcu update` apply step: fetch the release archive, verify it, run its installer.

Downloads only LCU's own release archive from GitHub. The official app is never
fetched or touched; the extracted installer reuses the one the installation
already points at. Agent registrations point at `<prefix>/current`, so a
runtime-only reinstall keeps them working; setup is not re-run.
"""
import hashlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.error import URLError
from urllib.request import Request, urlopen
import zipfile

DOWNLOAD = 'https://github.com/amontlabs/lcu/releases/download'
TIMEOUT = 60
_SHA = re.compile(r'[0-9a-fA-F]{64}')


def _read_json(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f'Cannot read {path}: {exc}') from None
    if not isinstance(data, dict):
        raise ValueError(f'Malformed {path}')
    return data


def asset_name(version, platform, arch):
    """Release archive name for one platform and architecture."""
    if platform not in ('darwin', 'linux', 'windows') or arch not in ('arm64', 'x64'):
        raise ValueError(f'No LCU release archive for {platform} {arch}.')
    return f'lcu-{version}-{platform}-{arch}' + ('.zip' if platform == 'windows' else '.tar.gz')


def _layout(root):
    """Return (prefix, bundle, installation) for a release dir, or refuse."""
    root = Path(root).resolve()
    if not (root / 'bundle.json').is_file():
        raise ValueError('This LCU is a source checkout; `lcu update` only updates an installed release. '
                         'Rebuild from source or install a release archive.')
    prefix = root.parent.parent
    if root.parent.name != 'releases' or not (prefix / '.lcu-install').is_file():
        raise ValueError(f'{root} is not inside an LCU installation prefix (<prefix>/releases/<name>); '
                         'update refused.')
    return prefix, _read_json(root / 'bundle.json'), _read_json(root / 'installation.json')


def installer_command(platform, prefix, installation, source, *, python=None):
    """Installer command line that reproduces the existing install (runtime only)."""
    python = python or sys.executable
    scripts = Path(source) / 'scripts'
    if platform == 'windows':
        return [python, '-B', str(scripts / 'install_windows.py'), '--prefix', str(prefix), '--runtime-only']
    script = 'install_macos.py' if platform == 'darwin' else 'install.py'
    command = [python, '-B', str(scripts / script), '--prefix', str(prefix), '--runtime-only']
    app = installation.get('app')
    if isinstance(app, str) and os.path.isabs(app) and Path(app).is_dir():
        command += ['--existing-app', app]
    if platform == 'linux':
        # apt cannot run unattended; system libraries stay as installed.
        command.append('--skip-system')
    return command


def _sha256_expected(text, name):
    for line in text.splitlines():
        parts = line.split()
        if parts and _SHA.fullmatch(parts[0]) and (len(parts) == 1 or parts[-1].lstrip('*') == name):
            return parts[0].lower()
    raise ValueError(f'Malformed checksum file for {name}.')


def _fetch(url, destination=None):
    try:
        return _fetch_urllib(url, destination)
    except URLError as exc:
        from .update import cert_failure, curl
        if not cert_failure(exc):
            raise
    # Python has no CA store here; the system curl verifies against the system one.
    if destination is None:
        return curl(['-L', url])[:1 << 16]
    curl(['-L', '-o', str(destination), url], timeout=TIMEOUT * 30)
    digest = hashlib.sha256()
    with destination.open('rb') as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _fetch_urllib(url, destination=None):
    request = Request(url, headers={'User-Agent': 'lcu-update'})
    digest = hashlib.sha256()
    with urlopen(request, timeout=TIMEOUT) as response:
        if destination is None:
            return response.read(1 << 16)
        total = int(response.headers.get('Content-Length') or 0) if getattr(response, 'headers', None) else 0
        done = 0
        with destination.open('wb') as output:
            while chunk := response.read(1 << 20):
                digest.update(chunk)
                output.write(chunk)
                done += len(chunk)
                if total and sys.stderr.isatty():
                    print(f'\rDownloading {done * 100 // total}%', end='', file=sys.stderr)
        if total and sys.stderr.isatty():
            print(file=sys.stderr)
    return digest.hexdigest()


def _unsafe(name):
    posix, windows = PurePosixPath(name), PureWindowsPath(name)
    return (not name or posix.is_absolute() or windows.is_absolute() or windows.drive
            or '..' in posix.parts or '..' in windows.parts)


def _extract_tar(archive, destination):
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            if _unsafe(member.name):
                raise ValueError(f'Unsafe path in archive: {member.name}')
            if member.isdev() or member.isfifo():
                raise ValueError(f'Unsupported entry in archive: {member.name}')
            if member.issym() or member.islnk():
                base = posixpath.dirname(member.name) if member.issym() else ''
                target = member.linkname
                resolved = posixpath.normpath(posixpath.join(base, target))
                if (PurePosixPath(target).is_absolute() or PureWindowsPath(target).drive
                        or resolved == '..' or resolved.startswith('../')):
                    raise ValueError(f'Archive link escapes the release: {member.name}')
        try:
            bundle.extractall(destination, members, filter='data')
        except TypeError:  # Python without extraction filters; members were checked above.
            bundle.extractall(destination, members)


def _extract_zip(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if _unsafe(info.filename) or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f'Unsafe entry in archive: {info.filename}')
        bundle.extractall(destination)


def download(info, name, directory):
    """Download, verify and extract the archive; return the extracted release directory."""
    base = f'{DOWNLOAD}/{info["tag"]}/{name}'
    archive = directory / name
    print(f'Downloading {base}', file=sys.stderr)
    actual = _fetch(base, archive)
    expected = _sha256_expected(_fetch(base + '.sha256').decode('utf-8', 'replace'), name)
    if actual != expected:
        archive.unlink(missing_ok=True)
        raise ValueError(f'Checksum mismatch for {name}; refusing to install it.')
    extracted = directory / 'extract'
    extracted.mkdir()
    (_extract_zip if name.endswith('.zip') else _extract_tar)(archive, extracted)
    source = extracted / name.removesuffix('.zip').removesuffix('.tar.gz')
    if not source.is_dir() or not (source / 'bundle.json').is_file():
        raise ValueError('The archive does not contain an LCU release bundle.')
    return source


def apply(root, info, *, yes):
    """Update the installation containing `root`; return an exit status."""
    try:
        prefix, bundle, installation = _layout(root)
        platform = installation.get('platform', 'linux')
        arch = installation.get('architecture') or bundle.get('architecture')
        name = asset_name(info['version'], platform, arch)
    except (ValueError, KeyError) as exc:
        print(f'lcu update: {exc}', file=sys.stderr)
        return 1
    lcu = prefix / ('lcu.cmd' if platform == 'windows' else 'current/bin/lcu')
    print(f'LCU update: {bundle.get("version")} -> {info["version"]}\n'
          f'  prefix:  {prefix}\n  archive: {name}\n  release: {info.get("release_url", "")}')
    if not yes:
        if not sys.stdin.isatty():
            print(f'Not interactive; nothing changed. To apply, run:\n  {shlex.quote(str(lcu))} update --yes',
                  file=sys.stderr)
            return 2
        if input('Proceed? [y/N] ').strip().lower() not in ('y', 'yes'):
            print('Cancelled.')
            return 1
    temporary = Path(tempfile.mkdtemp(prefix='lcu-update-'))
    keep = False
    try:
        source = download(info, name, temporary)
        command = installer_command(platform, prefix, installation, source)
        if platform == 'linux':
            user = os.environ.get('SUDO_USER') if os.getuid() == 0 else None
            if os.getuid() == 0 and not user:
                print('lcu update: running as root without SUDO_USER; run it as the desktop account '
                      'through sudo or as that account.', file=sys.stderr)
                return 1
            if os.getuid() != 0 and not (os.access(prefix, os.W_OK)
                                         and os.access(prefix / '.lcu-install', os.W_OK)
                                         and os.access(prefix / 'releases', os.W_OK)):
                import getpass
                keep = True
                print(f'{prefix} is not writable by this account. The verified release is at {source}; '
                      'install it with:\n  sudo ' + shlex.join([*command, '--user', getpass.getuser()]) +
                      f'\nThen delete {temporary}.', file=sys.stderr)
                return 1
            if user:
                command += ['--user', user]
        status = subprocess.run(command, check=False).returncode
        if status:
            print(f'lcu update: the installer failed (exit {status}); the previous release stays current.',
                  file=sys.stderr)
            return status
        print(f'LCU {info["version"]} installed. Restart agents that use LCU so they load the new release.\n'
              f'To reclaim space from superseded releases, run: {shlex.quote(str(lcu))} prune')
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as exc:
        print(f'lcu update: {exc}', file=sys.stderr)
        return 1
    finally:
        if not keep:
            shutil.rmtree(temporary, ignore_errors=True)
