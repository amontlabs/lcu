"""Cached `npm ci` of the two lockfile-pinned dependency sets a built archive ships.

A release archive carries `agent-tools/node_modules` (scripts/agent-tools: `npm ci --ignore-scripts`) and
`adapters/node_modules` (adapters: `npm ci --omit=dev --omit=peer --ignore-scripts`), see
scripts/provision_agent_tools.py. One install is cached per (package.json, package-lock.json, flags) hash under
$LCU_BB_NPM_CACHE (default $TMPDIR/lcu-bb-npm) and copied into each sandbox; once cached nothing needs the
network. Packages are pure JavaScript (no install scripts), so a cache built on one OS works on another:
docker.sh builds it on the host and mounts it into the container.

    python3 tests/blackbox/npmcache.py [IMPLEMENTATION_ROOT]    # populate the cache, print the entries
"""
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

AGENT_TOOLS = ('scripts/agent-tools', ['--ignore-scripts'])
ADAPTERS = ('adapters', ['--omit=dev', '--omit=peer', '--ignore-scripts'])


def cache_root():
    return Path(os.environ.get('LCU_BB_NPM_CACHE') or Path(tempfile.gettempdir()) / 'lcu-bb-npm')


def node_modules(source_dir, flags):
    """Path of a cached node_modules for the package files in `source_dir` (built on first use)."""
    source_dir = Path(source_dir)
    digest = hashlib.sha256()
    for name in ('package.json', 'package-lock.json'):
        digest.update((source_dir / name).read_bytes())
    digest.update(' '.join(flags).encode())
    entry = cache_root() / digest.hexdigest()[:24]
    if (entry / '.complete').is_file():
        return entry / 'node_modules'
    cache_root().mkdir(parents=True, exist_ok=True)
    with open(cache_root() / (entry.name + '.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _build(source_dir, flags, entry)


def _build(source_dir, flags, entry):
    if (entry / '.complete').is_file():
        return entry / 'node_modules'
    npm = shutil.which('npm')
    if not npm:
        raise RuntimeError('npm is needed once to populate the black-box dependency cache '
                           f'({entry}); run tests/blackbox/npmcache.py on a host with network and npm')
    scratch = Path(tempfile.mkdtemp(prefix='lcu-bb-npm-build-'))
    try:
        for name in ('package.json', 'package-lock.json'):
            shutil.copy(source_dir / name, scratch / name)
        (scratch / 'user.npmrc').write_text('')
        (scratch / 'global.npmrc').write_text('')
        env = dict(os.environ, NPM_CONFIG_USERCONFIG=str(scratch / 'user.npmrc'),
                   NPM_CONFIG_GLOBALCONFIG=str(scratch / 'global.npmrc'))
        built = subprocess.run([npm, 'ci', '--cache', str(scratch / 'cache'), '--no-audit', '--no-fund',
                        '--registry=https://registry.npmjs.org', *flags], cwd=scratch, env=env, check=False,
                       capture_output=True, text=True)
        if built.returncode:
            raise RuntimeError('npm ci failed: ' + (built.stderr or built.stdout)[-500:])
        if entry.exists():
            shutil.rmtree(entry)
        entry.mkdir(parents=True)
        shutil.copytree(scratch / 'node_modules', entry / 'node_modules', symlinks=True)
        (entry / '.complete').write_text('')
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return entry / 'node_modules'


def install(impl_root, destination_root, only=None):
    """Copy both cached dependency sets into an archive-shaped tree rooted at `destination_root`."""
    impl_root = Path(impl_root)
    destination_root = Path(destination_root)
    for relative, flags in (AGENT_TOOLS, ADAPTERS):
        if only == 'adapters' and relative != ADAPTERS[0]:
            continue
        source = node_modules(impl_root / relative, flags)
        target = destination_root / ('agent-tools' if relative.startswith('scripts') else 'adapters') / 'node_modules'
        shutil.copytree(source, target, symlinks=True)
        if relative.startswith('scripts'):
            for name in ('package.json', 'package-lock.json'):
                shutil.copy(impl_root / relative / name, target.parent / name)


if __name__ == '__main__':
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    for relative, flags in (AGENT_TOOLS, ADAPTERS):
        print(node_modules(root / relative, flags))
