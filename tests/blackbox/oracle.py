#!/usr/bin/env python3
"""Materialise the oracle: the Python implementation at the commit named in tests/blackbox/BASE."""
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

try:
    import fcntl
except ImportError:  # Windows: the atomic rename below still keeps the cache consistent
    fcntl = None

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[1]


def base_commit():
    return (HERE / 'BASE').read_text().strip()


def cache_root():
    override = os.environ.get('LCU_BB_ORACLE_CACHE')
    return Path(override) if override else Path(tempfile.gettempdir()) / 'lcu-bb-oracle'


def _extract(worktree, commit, destination):
    """Build the tree in a private temporary sibling directory and rename it into place."""
    staging = Path(tempfile.mkdtemp(prefix=destination.name + '.tmp-', dir=destination.parent))
    try:
        archive = subprocess.run(['git', '-C', str(worktree), 'archive', '--format=tar', commit],
                                 check=True, capture_output=True).stdout
        tree = staging / 'tree'
        tree.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(tree, filter='tar')
        (tree / '.complete').write_text(commit + '\n')
        if destination.exists():
            # `force`, or a leftover incomplete tree: move it aside so the rename below cannot collide.
            os.rename(destination, staging / 'old')
        os.rename(tree, destination)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def materialise(worktree=WORKTREE, force=False):
    """Return the directory holding `git archive <base>`; cached by full commit SHA.

    Safe to call from concurrent processes (parallel test files share one cache): an exclusive file lock serialises
    the build, the tree is assembled in a temporary directory and renamed into place only when complete, and a
    reader that finds the completion marker never takes the lock.
    """
    commit = base_commit()
    root = cache_root()
    destination = root / commit
    marker = destination / '.complete'
    if marker.is_file() and not force:
        return destination
    root.mkdir(parents=True, exist_ok=True)
    with open(root / (commit + '.lock'), 'a') as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        # Another process may have finished while this one waited for the lock.
        if marker.is_file() and not force:
            return destination
        _extract(worktree, commit, destination)
    return destination


if __name__ == '__main__':
    print(materialise(force='--force' in sys.argv[1:]))
