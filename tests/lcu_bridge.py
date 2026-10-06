"""Call LCU's Node modules from the Python test drivers (the Node runtime port replaced `from lcu.<module> import ...`).

`call('harness_setup', 'configure_omp', home, command, release, scope='user', project=None, env=env)` runs
`<root>/lcu/harness_setup.mjs`'s `configure_omp(home, command, release, {scope, project, env})` in a Node process
(tests/lcu_bridge.mjs) and returns the JSON result. Keyword arguments become the trailing options object (the Node
form of Python's keyword-only parameters). Errors raise `BridgeError`, a `ValueError`, whose message is the Node error's
message (LCU's ValueError text is unchanged by the port). Real entry points (bin/lcu, scripts/install.sh) are not
bridged: drivers run those as subprocesses.

Which tree and which Node:
  root   $LCU_BRIDGE_ROOT, else an explicit `root=`, else the repository root. An installed release works as well:
         it ships lcu/*.mjs.
  node   $LCU_TEST_NODE, else <root>/agent-tools/node/bin/node (an installed release: the app's own Node), else the
         Node on PATH (development checkouts and CI, which have no ChatGPT app). Node >= 22.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parent
BRIDGE = HERE / 'lcu_bridge.mjs'
MARK = '\0LCU-BRIDGE-RESULT\0'


class BridgeError(ValueError):
    """An exception raised by the Node function (`name` is its class name)."""

    def __init__(self, message, name='Error', stack=''):
        super().__init__(message)
        self.name = name
        self.stack = stack


def default_root(root=None):
    return Path(root or os.environ.get('LCU_BRIDGE_ROOT') or REPOSITORY).resolve()


def find_node(root=None):
    configured = os.environ.get('LCU_TEST_NODE')
    if configured:
        return configured
    packaged = default_root(root) / 'agent-tools/node/bin/node'
    if packaged.is_file() and os.access(packaged, os.X_OK):
        return str(packaged)
    found = shutil.which('node')
    if not found:
        raise RuntimeError('Node.js >= 22 is required (set LCU_TEST_NODE or put node on PATH)')
    return found


def _jsonable(value):
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _split(stdout, stderr=''):
    """Everything before the result marker is what the function printed."""
    printed, marker, rest = stdout.partition(MARK)
    if not marker:
        raise RuntimeError('lcu_bridge.mjs produced no result: ' + stdout[-2000:] + ('\nstderr: ' + stderr[-2000:] if stderr else ''))
    return printed, json.loads(rest.splitlines()[0])


def _raise(reply):
    error = reply['error']
    raise BridgeError(error['message'], error.get('name', 'Error'), error.get('stack', ''))


def call_with_args(module, function, *args, root=None, node=None, timeout=300, process_env=None, **options):
    # `env` is not a parameter of its own: it is the Node function's own option (configure_omp(..., env=...)) and goes
    # to `options`; `process_env` is the environment of the Node process.
    """Return (result, args_after_call). The second value shows what a function filled into a caller-supplied dict."""
    root = default_root(root)
    request = {'root': str(root), 'module': module, 'function': function, 'args': _jsonable(list(args)),
               'options': _jsonable(options) if options else None}
    process = subprocess.run([node or find_node(root), '--disable-warning=ExperimentalWarning', str(BRIDGE), 'call'],
                             input=json.dumps(request), capture_output=True, text=True, timeout=timeout,
                             env=process_env if process_env is not None else os.environ.copy())
    printed, reply = _split(process.stdout, process.stderr)
    if printed:
        sys.stdout.write(printed)
    if process.stderr:
        sys.stderr.write(process.stderr)
    if not reply['ok']:
        _raise(reply)
    return reply['result'], reply['args']


def call(module, function, *args, **kwargs):
    return call_with_args(module, function, *args, **kwargs)[0]


class CodexTools:
    """locate_codex_tools()'s result: the original codex CLI and codex-code-mode-host paths."""

    def __init__(self, cli, code_mode_host):
        self.cli = Path(cli)
        self.code_mode_host = Path(code_mode_host)


def locate_codex_tools(resources, *, root=None, windows=False):
    found = call('app_layout', 'locate_codex_tools', resources, root=root, **({'windows': True} if windows else {}))
    return CodexTools(found['cli'], found['code_mode_host'])


def original_hooks(host_root, *, root=None):
    return call('codex_hooks', 'original_hooks', host_root, root=root)


def host_policy(release, *, root=None):
    return call('setup', 'host_policy', release, root=root)


def configure_omp(home, command, release, *, scope, project, env, root=None):
    """harness_setup.configure_omp: write the OMP plugin package under HOME and link it with the real `omp`."""
    return call('harness_setup', 'configure_omp', home, command, release, root=root,
                scope=scope, project=project, env=env)


def configure_hermes(home, command, node, release, *, scope, project, env, root=None):
    """harness_setup.configure_hermes: write the Hermes plugin under HERMES_HOME and enable it with the real `hermes`."""
    return call('harness_setup', 'configure_hermes', home, command, node, release, root=root,
                scope=scope, project=project, env=env)


class AppServerSession:
    """`with AppServerSession(cli, cwd, env) as api:` mirrors the old `with app_server(cli, cwd, env) as api:`.

    `api(method, params)` makes a JSON-RPC call, `api.receive(timeout)` returns the next message or None and
    `api.initialization` holds the initialize result. The bundled Codex app-server runs inside the Node process
    that executes lcu/app_server.mjs.
    """

    def __init__(self, cli, cwd, env, *, root=None, node=None):
        self._request = {'root': str(default_root(root)), 'cli': str(cli), 'cwd': str(cwd), 'env': _jsonable(env)}
        self._node = node
        self._process = None
        self.initialization = None

    def __enter__(self):
        root = Path(self._request['root'])
        self._process = subprocess.Popen(
            [self._node or find_node(root), '--disable-warning=ExperimentalWarning', str(BRIDGE), 'app_server'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=os.environ.copy())
        self._process.stdin.write(json.dumps(self._request) + '\n')
        self._process.stdin.flush()
        reply = self._read()
        self.initialization = reply['initialization']
        return self

    def _read(self):
        while True:
            line = self._process.stdout.readline()
            if not line:
                raise BridgeError('The Node app-server bridge exited unexpectedly.')
            _, marker, rest = line.partition(MARK)
            if marker:
                reply = json.loads(rest)
                if not reply['ok']:
                    _raise(reply)
                return reply

    def _send(self, command):
        self._process.stdin.write(json.dumps(command) + '\n')
        self._process.stdin.flush()
        return self._read()['result']

    def __call__(self, method, params, timeout=45):
        return self._send({'op': 'call', 'method': method, 'params': params, 'timeout': timeout})

    def receive(self, timeout):
        return self._send({'op': 'receive', 'timeout': timeout})

    def __exit__(self, *exc):
        process, self._process = self._process, None
        try:
            process.stdin.write(json.dumps({'op': 'close'}) + '\n')
            process.stdin.flush()
        except (BrokenPipeError, ValueError):
            pass
        try:
            process.stdin.close()
        except (BrokenPipeError, ValueError):
            pass
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()
        return False
