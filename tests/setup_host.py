"""Drive `lcu setup` through the test host's own platform path (the registered runtime command it expects).

POSIX hosts take the Linux path; Windows hosts take the Windows path, so its
setup lock and state locations are exercised natively instead of simulated.
"""
import os
from pathlib import Path
import sys
from types import SimpleNamespace

PLATFORM = 'win32' if sys.platform == 'win32' else 'linux'
WINDOWS = PLATFORM == 'win32'


def uid():
    return os.getuid() if hasattr(os, 'getuid') else None


def is_root():
    return uid() == 0


def account(home):
    return SimpleNamespace(pw_name='fixture', pw_uid=uid(), pw_dir=str(home))


def make_runtime(prefix):
    """The launchers `setup.runtime_paths` requires for either platform."""
    for name in ('current/bin/lcu', 'current/bin/lcu-session', 'lcu.cmd'):
        path = Path(prefix) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture')
        path.chmod(0o755)


def direct_command(prefix):
    """The registered runtime command for a direct session."""
    prefix = Path(prefix)
    if WINDOWS:
        # lcu/setup.mjs windows_registration_command: the validating <prefix>\lcu.cmd run through cmd.exe.
        root = os.environ.get('SystemRoot') or 'C:\\Windows'
        return [str(Path(root) / 'System32/cmd.exe'), '/d', '/c', str(prefix / 'lcu.cmd')]
    return [str(prefix / 'current/bin/lcu')]
