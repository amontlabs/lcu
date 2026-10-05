"""Run a child and capture its output through files rather than pipes.

Node writes to pipes asynchronously on macOS, so a CLI that prints and then calls
`process.exit()` loses everything past the 64 KiB pipe buffer. File writes are
synchronous on every platform, so the whole output survives the exit.
"""
from __future__ import annotations

import subprocess
import tempfile


def run(argv, *, timeout=None, **kwargs):
    """subprocess.run with stdout and stderr read back from temporary files, as text."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                timeout=timeout, **kwargs)
        out.seek(0)
        err.seek(0)
        return subprocess.CompletedProcess(result.args, result.returncode,
                                           out.read().decode('utf-8', 'replace'),
                                           err.read().decode('utf-8', 'replace'))
