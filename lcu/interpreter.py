"""Select a Python new enough for LCU when the launching PATH finds an older one."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

REQUIRED = (3, 12)
CHECK = 'import sys; sys.exit(sys.version_info < (3, 12))'
NAMES = ('python3.14', 'python3.13', 'python3.12', 'python3')
EXTRA_DIRS = ('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')


def _suitable(path):
    try:
        return subprocess.run([path, '-c', CHECK], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _candidates(extra_dirs):
    override = os.environ.get('LCU_PYTHON')
    if override:
        yield override
    search = os.pathsep.join([os.environ.get('PATH', ''), *extra_dirs])
    for name in NAMES:
        found = shutil.which(name, path=search)
        if found:
            yield found


def ensure(script, argv, version=None, execv=os.execv, extra_dirs=EXTRA_DIRS):
    """Return when this interpreter is new enough, else re-run `script` with one that is."""
    version = version if version is not None else sys.version_info
    if tuple(version[:2]) >= REQUIRED:
        return
    for candidate in _candidates(extra_dirs):
        if _suitable(candidate):
            execv(candidate, [candidate, '-B', str(script), *argv])
            return
    raise ValueError(
        f'Python 3.12 or newer is required, but {sys.executable} is Python '
        f'{".".join(str(part) for part in version[:3])}. Install Python 3.12+ or set LCU_PYTHON to its path.')
