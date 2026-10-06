"""Fetch the pinned development/test package fixture named in runtime.lock.json (tests/run.sh).

Development tooling only: the LCU installer never downloads the app (AGENTS.md). Standard library only.
"""
import hashlib
import os
from pathlib import Path
from urllib.request import Request, urlopen


def download(lock, entry, destination):
    """Fetch the pinned package to DESTINATION (which must not exist) and verify its SHA-256."""
    destination = Path(destination)
    url = lock['source'].format(deb_arch=entry['deb_arch'])
    request = Request(url, headers={'User-Agent': 'lcu/0.3.0'})
    digest = hashlib.sha256()
    try:
        with urlopen(request, timeout=60) as response, destination.open('xb') as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    if digest.hexdigest() != entry['sha256']:
        destination.unlink(missing_ok=True)
        raise ValueError('Official application package checksum mismatch; refusing to extract it')
