"""Extract the unchanged original Windows pipe host into a private generation.

Only the tiny launch entry and the structural analyzer are LCU code. The native
host and its dependencies come unchanged from the installed application's
app.asar. The host factory is located by structure (a parsed top-level function
whose options are the native-pipe settings), never by a minified name, and the
declarations it needs are copied verbatim into one generated module.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import posixpath
from pathlib import Path
from queue import Empty, Queue
import re
import subprocess
from threading import Thread

from .asar import list_asar_members, read_asar_members

_MAIN_PATH = re.compile(r'^\.vite/build/main(?:-[^/]+)?\.js$')
_ANALYZER = Path(__file__).with_name('windows_host_analyze.cjs')
_GENERATED = 'lcu-original-pipe-host.cjs'
_RESOLVED_SUFFIXES = ('', '.js', '.json', '.node', '/package.json', '/index.js', '/index.json', '/index.node')
_MAX_CHUNKS = 400
_NODE_MEMBER = 'app/resources/cua_node/bin/node.exe'


def _required_layout(detail: str):
    raise ValueError(f'Required Windows host layout is unavailable: {detail}')


@dataclass(frozen=True)
class HostPlan:
    """The read-only result of analysing an app.asar; nothing here is written yet."""
    main: str
    factory: str
    module: str
    contents: dict[str, bytes]


def _analyzer_env() -> dict[str, str]:
    env = {'PATH': os.environ.get('PATH', '')}
    if 'SYSTEMROOT' in os.environ:  # Node aborts at startup on Windows without it
        env['SYSTEMROOT'] = os.environ['SYSTEMROOT']
    return env


def _analyze(node: Path, request: dict) -> dict:
    if not Path(node).is_file():
        _required_layout('the original Node needed to read the host layout is missing')
    try:
        result = subprocess.run(
            [str(node), '--max-old-space-size=2048', str(_ANALYZER)],
            input=json.dumps(request).encode('utf-8'),
            capture_output=True, env=_analyzer_env(), timeout=180, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        _required_layout(f'the structural analyzer could not run ({exc.__class__.__name__})')
    try:
        response = json.loads(result.stdout)
    except ValueError:
        response = None
    if result.returncode != 0 or not isinstance(response, dict):
        detail = result.stderr.decode('utf-8', 'replace').strip().splitlines()[:1]
        _required_layout('the structural analyzer failed to read the main bundle' +
                         (f' ({detail[0][:160]})' if detail else ''))
    if response.get('ok') is not True:
        _required_layout(str(response.get('error') or 'the structural analyzer rejected the main bundle'))
    return response


def _decode(source: bytes, name: str) -> str:
    try:
        return source.decode('utf-8')
    except UnicodeDecodeError:
        _required_layout(f'{name} is not UTF-8')


def _member_for(current: str, specifier: str, members: set[str]) -> str:
    base = posixpath.normpath(posixpath.join(posixpath.dirname(current), specifier))
    if base == '..' or base.startswith('../') or posixpath.isabs(base):
        _required_layout(f'original dependency {specifier!r} leaves the application archive')
    # Node's own order for a relative specifier: the exact file, then .js, .json, .node,
    # then a directory's package.json "main" (not supported here) or index file.
    for suffix in _RESOLVED_SUFFIXES:
        if base + suffix in members:
            if suffix == '/package.json':
                _required_layout(f'original dependency {base} is a package directory, which is not supported')
            return base + suffix
    _required_layout(f'original dependency is missing: {base}')


def _local_dependencies(current: str, requires: list[dict], imports: list[dict],
                        members: set[str]) -> list[str]:
    """Resolve one module's static dependencies; fail closed on anything not plain and local."""
    for item in imports:
        if not item['builtin']:
            _required_layout(f'{current} imports {item["spec"]!r} statically, which is not supported')
    found = []
    for item in requires:
        spec = item['spec']
        if item['builtin']:
            continue
        if spec == 'electron' or spec.startswith('electron/'):
            _required_layout(f'the native-pipe host depends on Electron through {current}')
        if not spec.startswith('.'):
            _required_layout(f'unsupported non-relative original dependency {spec!r} in {current}')
        found.append(_member_for(current, spec, members))
    return found


def plan_original_host(app: Path, *, node: Path | None = None) -> HostPlan:
    """Read the selected app's app.asar and plan the host extraction without writing anything.

    `node` runs the structural analyzer; it defaults to the app's own Node, which
    the protected Store directory does not let LCU execute (the installer passes a
    private copy).
    """
    from .windows import _component
    archive = app / 'app/resources/app.asar'
    if archive.is_symlink() or not archive.is_file():
        _required_layout('app/resources/app.asar is missing or redirected')
    return plan_original_asar(archive, node=node or _component(app, _NODE_MEMBER))


def plan_original_asar(archive: Path, *, node: Path) -> HostPlan:
    """The same read-only plan for a bare app.asar (the development check uses this)."""
    members = set(list_asar_members(archive))
    results = []
    for name in sorted(member for member in members if _MAIN_PATH.fullmatch(member)):
        source = read_asar_members(archive, (name,))[name]
        response = _analyze(node, {'op': 'host', 'source': _decode(source, name)})
        if response.get('matches', 0) != 0:
            results.append((name, response))
    if not results:
        _required_layout('no main bundle has a top-level native-pipe host factory (a function taking '
                         'codexCliPath, nativePipeDirectory, windowsHelperPath and '
                         'windowsHelperTransportModulePath options)')
    if len(results) != 1 or results[0][1]['matches'] != 1:
        _required_layout('more than one top-level native-pipe host factory matches')
    main, response = results[0]
    # Walk the relative-require graph from the generated module's own requirements.
    queue = list(dict.fromkeys(
        _local_dependencies(main, response['requires'], response['imports'], members)))
    chunks: dict[str, bytes] = {}
    while queue:
        batch = [name for name in queue if name not in chunks]
        if not batch:
            break
        if len(chunks) + len(batch) > _MAX_CHUNKS:
            _required_layout('original dependency graph is unexpectedly large')
        sources = read_asar_members(archive, tuple(batch))
        scripts = {}
        for name in batch:
            if _MAIN_PATH.fullmatch(name):
                _required_layout(f'original dependency graph reaches the main bundle through {name}')
            if name.endswith('.node'):
                _required_layout(f'original dependency {name} is a native module')
            chunks[name] = sources[name]
            if name.endswith('.json'):
                continue
            if not name.endswith(('.js', '.cjs')):
                _required_layout(f'original dependency {name} is not a CommonJS module')
            scripts[name] = _decode(sources[name], name)
        queue = []
        if scripts:
            listed = _analyze(node, {'op': 'requires', 'files': scripts})['files']
            for name in scripts:
                queue.extend(_local_dependencies(
                    name, listed[name]['requires'], listed[name]['imports'], members))
        queue = list(dict.fromkeys(queue))
    return HostPlan(main, response['factory'], response['module'], chunks)


def materialize_original_host(app: Path, destination: Path, *, node: Path | None = None) -> Path:
    """Extract the structurally selected host factory and its exact dependencies."""
    return write_original_host(plan_original_host(app, node=node), destination)


def write_original_host(plan: HostPlan, destination: Path) -> Path:
    """Write a planned host (generated module, chunks, thin entry) into a new directory."""
    template = Path(__file__).with_name('windows_host_entry.cjs').read_bytes()
    marker = b'// ORIGINAL_WINDOWS_PIPE_HOST_MODULE'
    if template.count(marker) != 1:
        raise ValueError('Windows host entry marker is missing or ambiguous.')
    # The generated module sits beside the original main bundle, so every original
    # relative require inside it keeps resolving as written.
    generated = posixpath.join(posixpath.dirname(plan.main), _GENERATED)
    entry = template.replace(
        marker, f'const createPipeHost = require({json.dumps("./" + generated)});'.encode('utf-8'))
    destination.mkdir(parents=True, exist_ok=False)
    for name, content in plan.contents.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    module = destination / generated
    module.parent.mkdir(parents=True, exist_ok=True)
    module.write_bytes(plan.module.encode('utf-8'))
    launcher = destination / 'windows-pipe-host.cjs'
    launcher.write_bytes(entry)
    for source, target in (
        ('windows_lifetime_host.cjs', 'windows-lifetime-host.cjs'),
        ('windows_sky_service.mjs', 'windows-sky-service.mjs'),
    ):
        (destination / target).write_bytes(Path(__file__).with_name(source).read_bytes())
    return launcher


def start_original_host(*, node: Path, entry: Path, helper: Path, transport: Path,
                        env: dict[str, str]) -> tuple[subprocess.Popen, str, str]:
    """Start the extracted original host and wait for its actual pipe readiness."""
    if not all(path.is_file() for path in (node, entry, helper, transport)):
        raise ValueError('The selected original Windows native host is incomplete.')
    child_env = dict(env)
    child_env['LCU_WRE_HELPER_PATH'] = str(helper)
    child_env['LCU_WRE_TRANSPORT_PATH'] = str(transport)
    process = subprocess.Popen([str(node), str(entry)], cwd=entry.parent, env=child_env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    ready = Queue(maxsize=1)
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        line = ready.get(timeout=15)
        state = json.loads(line)
        pipe = state.get('pipePath') if isinstance(state, dict) else None
        lifetime = state.get('lifetimePath') if isinstance(state, dict) else None
        if (not isinstance(state, dict) or state.get('ready') is not True or
                not isinstance(pipe, str) or
                not pipe.startswith('\\\\.\\pipe\\lcu-wre-') or len(pipe) > 256 or
                not isinstance(lifetime, str) or
                not lifetime.startswith('\\\\.\\pipe\\lcu-lifetime-') or len(lifetime) > 256):
            raise ValueError('Original Windows native host did not report its private pipes.')
        return process, pipe, lifetime
    except (Empty, ValueError, json.JSONDecodeError) as exc:
        stop_original_host(process, require_success=False)
        raise ValueError('Original Windows native host failed to become ready.') from exc


def stop_original_host(process: subprocess.Popen, *, require_success=True) -> None:
    """Dispose only the host process owned by this LCU MCP connection."""
    if process.stdin and not process.stdin.closed:
        process.stdin.close()
    try:
        try:
            status = process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            status = process.wait(timeout=5)
    finally:
        if process.stdout:
            process.stdout.close()
    if require_success and status != 0:
        raise ValueError(f'Original Windows native host exited with status {status}.')
