"""Shared helpers for the Node compat differential tests."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402  (one Node selector for every runner)
import oracle_tree  # noqa: E402,F401  (the Python oracle first on sys.path: `from lcu import x` is 0.9.4)
ORACLE = oracle_tree.ORACLE
sys.path.insert(0, str(ROOT))


def find_node():
    """The Node selected by support.selected_node() (LCU_COMPAT_NODE / LCU_TEST_NODE / PATH), when it is >= 22."""
    node = support.selected_node()
    if not node:
        return None
    try:
        out = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=20).stdout.strip()
        return node if int(out.lstrip('v').split('.')[0]) >= 22 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


NODE = find_node()


def run_node(script, *args, input=None, env=None, timeout=60):
    return subprocess.run([NODE, str(script), *map(str, args)], input=input, capture_output=True, text=True,
                          timeout=timeout, env=env)


def rmtree(path):
    """Remove a tree even when it holds read-only directories."""
    for parent, dirs, files in os.walk(path):
        for name in dirs:
            try:
                os.chmod(os.path.join(parent, name), 0o700)
            except OSError:
                pass
    shutil.rmtree(path, ignore_errors=True)


def snapshot(dest):
    """paths -> (type, perm, link target / digest, mtime_ns, inode group)."""
    inodes = {}
    out = {}
    for parent, dirs, files in os.walk(dest):
        for name in dirs + files:
            path = Path(parent, name)
            rel = path.relative_to(dest).as_posix()
            st = path.lstat()
            if stat.S_ISLNK(st.st_mode):
                out[rel] = ['symlink', None, os.readlink(path), None, None]
            elif stat.S_ISDIR(st.st_mode):
                out[rel] = ['dir', stat.S_IMODE(st.st_mode), None, st.st_mtime_ns, None]
            elif stat.S_ISREG(st.st_mode):
                out[rel] = ['file', stat.S_IMODE(st.st_mode), hashlib.sha256(path.read_bytes()).hexdigest(),
                            st.st_mtime_ns, st.st_ino]
                inodes.setdefault(st.st_ino, []).append(rel)
            else:
                out[rel] = ['other', stat.S_IMODE(st.st_mode), None, None, None]
    for rel, row in out.items():
        if row[0] == 'file':
            row[4] = sorted(inodes[row[4]]) if len(inodes[row[4]]) > 1 else None
    return out


def same_snapshot(a, b):
    if a.keys() != b.keys():
        return False
    for key in a:
        x, y = a[key], b[key]
        if x[:3] != y[:3] or x[4] != y[4]:
            return False
        if (x[3] is None) != (y[3] is None):
            return False
        # Implicit parents and untouched directories carry "now"; only archive-supplied mtimes are comparable.
        if x[3] is not None and abs(x[3] - time.time_ns()) > 600 * 10 ** 9 and abs(x[3] - y[3]) > 2000:
            return False
    return True
