"""Local release inventory. This module has no download or build dependencies."""
import hashlib
import json
import os
from pathlib import Path
import platform

VERSION = '0.9.2'


def architecture(target='linux'):
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    expected = {'linux': 'Linux', 'darwin': 'Darwin', 'windows': 'Windows'}.get(target)
    if expected is None or platform.system() != expected or arch is None or (target == 'windows' and arch != 'x64'):
        raise ValueError(f'LCU requires {target} ARM64 or x86-64.')
    return arch


def inventory(root, target='linux'):
    root = root.resolve()
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == 'bundle.json':
            continue
        if path.is_symlink():
            link = os.readlink(path)
            if Path(link).is_absolute() or not path.resolve().is_relative_to(root):
                raise ValueError(f'Unsafe bundle symlink: {relative}')
            files[relative] = {'type': 'symlink', 'target': link}
        elif path.is_file():
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            entry = {'type': 'file', 'sha256': digest}
            if target != 'windows':
                entry['mode'] = path.stat().st_mode & 0o777
            files[relative] = entry
        elif not path.is_dir():
            raise ValueError(f'Unsupported bundle entry: {relative}')
    return files


def seal(root, arch, target='linux'):
    manifest = {'format': 1, 'version': VERSION, 'platform': target, 'architecture': arch,
                'files': inventory(root, target)}
    (root / 'bundle.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


def verify(root, arch, target='linux'):
    path = root / 'bundle.json'
    if not path.is_file() or path.is_symlink():
        raise ValueError('Install from an extracted LCU release bundle. Source checkouts contain no runtime; build a release with scripts/build_bundle.py first.')
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict) or manifest.get('format') != 1 or manifest.get('platform') != target or manifest.get('version') != VERSION:
        raise ValueError('Unsupported LCU bundle manifest')
    if manifest.get('architecture') != arch:
        raise ValueError(f'Bundle architecture {manifest.get("architecture")} does not match this machine ({arch})')
    expected, actual = manifest.get('files'), inventory(root, target)
    if not isinstance(expected, dict) or expected != actual:
        raise ValueError('LCU bundle integrity check failed; extract a clean release archive.')
    return manifest
