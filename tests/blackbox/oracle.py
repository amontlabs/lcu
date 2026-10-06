#!/usr/bin/env python3
"""Materialise the oracle: the Python implementation at the commit named in tests/blackbox/BASE."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[1]


def base_commit():
    return (HERE / 'BASE').read_text().strip()


def cache_root():
    override = os.environ.get('LCU_BB_ORACLE_CACHE')
    return Path(override) if override else Path(tempfile.gettempdir()) / 'lcu-bb-oracle'


def materialise(worktree=WORKTREE, force=False):
    """Return the directory holding `git archive <base>`; cached by full commit SHA."""
    commit = base_commit()
    destination = cache_root() / commit
    marker = destination / '.complete'
    if marker.is_file() and not force:
        return destination
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    archive = subprocess.run(['git', '-C', str(worktree), 'archive', '--format=tar', commit],
                             check=True, capture_output=True).stdout
    scratch = destination.with_name(destination.name + '.tar')
    scratch.write_bytes(archive)
    try:
        with tarfile.open(scratch) as tar:
            tar.extractall(destination, filter='tar')
    finally:
        scratch.unlink()
    marker.write_text(commit + '\n')
    return destination


if __name__ == '__main__':
    print(materialise(force='--force' in sys.argv[1:]))
