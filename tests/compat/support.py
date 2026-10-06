"""Shared helpers for the Node compatibility-module differential tests."""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_tree  # noqa: E402,F401  (the Python oracle first on sys.path: `from lcu import x` is 0.9.4)
ORACLE = oracle_tree.ORACLE
COMPAT = ROOT / 'lcu' / 'compat'


def selected_node():
    """THE Node every differential runner uses (round-2 R10): LCU_COMPAT_NODE (docker.sh, host recipes), else
    LCU_TEST_NODE (the older name, still honoured), else the node on PATH. The two variables must agree when both are set."""
    compat, test = os.environ.get('LCU_COMPAT_NODE'), os.environ.get('LCU_TEST_NODE')
    if compat and test and compat != test:
        raise RuntimeError(f'LCU_COMPAT_NODE ({compat}) and LCU_TEST_NODE ({test}) select different Node binaries')
    return compat or test or shutil.which('node')


def node_version(node):
    """The `node --version` of the binary a runner will really execute (e.g. 'v22.23.3'), or None."""
    try:
        return subprocess.run([node, '--version'], capture_output=True, text=True, timeout=20).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


NODE = selected_node()
NODE_VERSION = node_version(NODE) if NODE else None
if NODE and os.environ.get('LCU_COMPAT_NODE_VERSION') and not (NODE_VERSION or '').startswith(os.environ['LCU_COMPAT_NODE_VERSION']):
    raise RuntimeError(f'the selected Node {NODE} reports {NODE_VERSION}, not {os.environ["LCU_COMPAT_NODE_VERSION"]}')
SYSTOOL_URL = (COMPAT / 'systool.mjs').as_uri()
DOCKER = os.environ.get('LCU_COMPAT_DOCKER') == '1'


def require_node():
    if not NODE:
        raise unittest.SkipTest('node is not installed')


class NodeError(AssertionError):
    pass


def run_node(code, data=None, *, timeout=60, env=None):
    """Run ES-module `code` under node; `data` arrives as JSON on stdin (`input`), result is parsed stdout JSON.

    The module sees `COMPAT` (file URL prefix of lcu/compat/) and `input`; it prints its answer with `emit(value)`.
    """
    prelude = (
        "import { readFileSync } from 'node:fs';\n"
        f"const COMPAT = {json.dumps(COMPAT.as_uri() + '/')};\n"
        "const input = JSON.parse(readFileSync(0, 'utf8') || 'null');\n"
        "const emit = (value) => process.stdout.write(JSON.stringify(value));\n"
    )
    done = subprocess.run([NODE, '--input-type=module', '-e', prelude + code],
                          input=json.dumps(data), capture_output=True, text=True, timeout=timeout, env=env)
    if done.returncode:
        raise NodeError(f'node failed ({done.returncode}): {done.stderr}')
    return json.loads(done.stdout) if done.stdout else None


def py_cases(function, cases):
    """Run `function` over cases in Python, returning results (exceptions become {'error': str})."""
    results = []
    for case in cases:
        try:
            results.append(function(case))
        except Exception as exc:  # noqa: BLE001 - differential oracle
            results.append({'error': f'{type(exc).__name__}: {exc}'})
    return results


def in_disposable_linux():
    """True inside the disposable Docker container docker.sh starts (Linux, /.dockerenv)."""
    return sys.platform == 'linux' and (os.environ.get('LCU_COMPAT_IN_DOCKER') == '1' or Path('/.dockerenv').exists())


def own_session_popen(argv, **kwargs):
    """Popen in a new session, so `send` can prove the target is ours before signalling it."""
    return subprocess.Popen(argv, start_new_session=True, **kwargs)


def send(proc, sig, *, group=False):
    """Signal a child this test spawned with own_session_popen, and nothing else.

    SAFETY RULE (.port/BRIEF.md): never signal a pid we did not spawn, never by name or listing. The
    target must be a live, unreaped Popen whose session (and process group) id is its own pid, i.e. one
    created with start_new_session=True. `group` signals that process group (a terminal Ctrl-C).
    """
    if not isinstance(proc, subprocess.Popen) or proc.pid <= 1 or proc.pid == os.getpid():
        raise ProcessLookupError('not a child of this test')
    if proc.poll() is not None:
        return False
    try:
        session, group_id = os.getsid(proc.pid), os.getpgid(proc.pid)
    except ProcessLookupError:
        return False  # exited (an unreaped zombie keeps its pid, so nothing else can own it)
    if session != proc.pid or group_id != proc.pid:
        raise ProcessLookupError(f'{proc.pid} is not in its own session')
    if group:
        os.killpg(proc.pid, sig)
    else:
        os.kill(proc.pid, sig)
    return True


class NodeTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_node()
