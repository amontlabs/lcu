"""Where the adapters' local diagnostic log lives and its retention policy (mirrors adapters/diagnostics.mjs)."""
import os
from pathlib import Path
import sys

RETENTION_DAYS = 7
MAX_TOTAL_MB = 20
MAX_FILE_MB = 2


def directory(env=None, platform=None, home=None):
    """The log directory: LCU_LOG_DIR, else the platform's per-user log or state directory."""
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else Path(home)
    if env.get('LCU_LOG_DIR'):
        return Path(env['LCU_LOG_DIR'])
    if platform == 'darwin':
        return home / 'Library/Logs/LCU'
    return Path(env.get('XDG_STATE_HOME') or home / '.local/state') / 'lcu/logs'


def enabled(env=None):
    return (os.environ if env is None else env).get('LCU_DIAGNOSTIC_LOG') != '0'


def status(env=None, platform=None, home=None):
    """Machine-readable diagnostic log settings for `lcu status --json`."""
    return {'dir': str(directory(env, platform, home)), 'enabled': enabled(env), 'retention_days': RETENTION_DAYS,
            'max_total_mb': MAX_TOTAL_MB, 'max_file_mb': MAX_FILE_MB}


def summary(env=None, platform=None, home=None):
    """One line naming the directory and the policy, for `lcu status` and `lcu doctor`."""
    state = status(env, platform, home)
    if not state['enabled']:
        return 'Diagnostic log: off (LCU_DIAGNOSTIC_LOG=0).'
    return (f"Diagnostic log: {state['dir']} (metadata only; kept {RETENTION_DAYS} days, "
            f"at most {MAX_TOTAL_MB} MB in total and {MAX_FILE_MB} MB per file; LCU_DIAGNOSTIC_LOG=0 turns it off).")
