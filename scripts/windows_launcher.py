#!/usr/bin/env python3
"""Stable account-local launcher for the selected thin Windows release.

Compatibility trampoline (installed as <prefix>/windows_launcher.py) for harness registrations made before the Node
port, which embed [python.exe, '-B', <prefix>/windows_launcher.py]. It selects the release exactly as before. A Node
release is started with its private-copy node.exe only after the generation checks lcu/runtime.py made (managed
<prefix>/apps/<sha256>/app, no reparse point, inventory digest, node.exe digest), with the Node startup variables
quarantined (lcu/entry.mjs restores them for the release's children). A release from before the port still runs
through this interpreter. Rerunning `lcu setup` registers the Node launcher; this file is then unused.
"""

import hashlib
import json
from pathlib import Path
import os
import subprocess
import sys

ENTRY = 'lcu/entry.mjs'
NODE = 'app/resources/cua_node/bin/node.exe'
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


def selected_release(prefix):
    prefix = Path(prefix).resolve(strict=True)
    descriptor = json.loads((prefix / 'current.json').read_text())
    name = descriptor.get('release')
    if (not isinstance(name, str) or not name or '/' in name or '\\' in name or
            name in ('.', '..') or any(ord(character) < 32 for character in name)):
        raise ValueError('Invalid selected Windows release name.')
    release = prefix / 'releases' / name
    if release.is_symlink() or release.resolve(strict=True).parent != (prefix / 'releases').resolve(strict=True):
        raise ValueError('Selected Windows release leaves the managed prefix.')
    if not (release / ENTRY).is_file() and not (release / 'bin/lcu').is_file():
        raise ValueError('Selected Windows release is incomplete.')
    return release


def _redirected(path):
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def _sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validated_node(prefix, release):
    descriptor = json.loads((release / 'installation.json').read_text())
    app, digest = descriptor.get('app'), descriptor.get('sha256')
    if (not isinstance(app, str) or not Path(app).is_absolute() or not isinstance(digest, str) or
            len(digest) != 64 or any(char not in '0123456789abcdef' for char in digest)):
        raise ValueError('Selected Windows application descriptor is incomplete or unsupported.')
    prefix = Path(prefix).resolve(strict=True)
    apps = prefix / 'apps'
    generation = apps / digest
    expected = generation / 'app'
    inventory_path = generation / 'inventory.json'
    node = expected / NODE
    chain = [apps, generation, expected, inventory_path, *[parent for parent in node.parents
                                                          if expected in parent.parents], node]
    if Path(app) != expected or any(_redirected(path) for path in chain) or not inventory_path.is_file():
        raise ValueError('Selected Windows application is not the managed private generation.')
    try:
        inventory = json.loads(inventory_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError('Managed Windows application inventory is invalid.') from exc
    encoded = json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if hashlib.sha256(encoded).hexdigest() != digest:
        raise ValueError('Managed Windows application inventory does not match its descriptor.')
    recorded = inventory.get(NODE) if isinstance(inventory, dict) else None
    if (not node.is_file() or not isinstance(recorded, dict) or recorded.get('type') != 'file' or
            _sha256(node) != recorded.get('sha256')):
        raise ValueError(f'Windows application differs from selected source inventory: {NODE}')
    return node


def quarantined_environment(environ):
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


def release_command(prefix, release, argv, environ=None):
    environ = dict(os.environ if environ is None else environ)
    if (release / ENTRY).is_file():
        node = validated_node(prefix, release)
        return ([str(node), '--disable-warning=ExperimentalWarning', str(release / ENTRY), 'lcu', *argv],
                quarantined_environment(environ))
    return [sys.executable, '-B', str(release / 'bin/lcu'), *argv], environ


def main(argv=None):
    prefix = Path(__file__).resolve().parent
    release = selected_release(prefix)
    command, env = release_command(prefix, release, sys.argv[1:] if argv is None else argv)
    return subprocess.call(command, env=env)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f'LCU Windows launcher: {exc}')
