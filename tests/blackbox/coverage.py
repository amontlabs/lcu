"""Which Python in the oracle do the black-box scenarios exercise?  (`run.py --coverage`)

A `sitecustomize.py` is injected through PYTHONPATH into the ORACLE sandbox only (coverage runs never compare;
the extra variables would show up in recorded environments). It uses `sys.monitoring` (Python 3.12) LINE events,
disabled per location after the first hit, and dumps the executed lines of every file under a release or `src/`
directory when the process exits or execs. Children that inherit the environment (bin/lcu spawning
`lcu setup`, installers running `bin/lcu --version`) are traced too.

Aggregation parses every lcu/*.py, scripts/*.py and the Python bin/* launchers of the oracle tree: executable lines
come from the code objects' line tables, a function counts as exercised when any line of its own body ran.
"""
import inspect
import json
import os
from pathlib import Path
import re

SITECUSTOMIZE = r'''
import atexit, json, os, re, sys
_out = os.environ.get('LCU_BB_COV_DIR')
_root = os.environ.get('LCU_BB_COV_ROOT')
if _out and _root and hasattr(sys, 'monitoring'):
    _pattern = re.compile('^' + re.escape(_root.rstrip('/')) + r'/[^/]+/(?:prefix/releases/[^/]+|src)/(.+)$')
    _hits = {}
    _mon = sys.monitoring
    _tool = _mon.COVERAGE_ID
    _mon.use_tool_id(_tool, 'lcu-bb')

    def _line(code, line):
        match = _pattern.match(code.co_filename)
        if match:
            _hits.setdefault(match.group(1), set()).add(line)
        return _mon.DISABLE

    _mon.register_callback(_tool, _mon.events.LINE, _line)
    _mon.set_events(_tool, _mon.events.LINE)
    _done = []

    def _dump(*_):
        if _done:
            return
        _done.append(1)
        try:
            os.makedirs(_out, exist_ok=True)
            path = os.path.join(_out, f'{os.getpid()}-{os.urandom(4).hex()}.json')
            with open(path, 'w') as handle:
                json.dump({k: sorted(v) for k, v in _hits.items()}, handle)
        except Exception:
            pass

    atexit.register(_dump)
    for _name in ('execv', 'execve', 'execvp', 'execvpe', '_exit'):
        def _wrap(original):
            def wrapper(*args, **kwargs):
                _dump()
                _done.clear()
                return original(*args, **kwargs)
            return wrapper
        setattr(os, _name, _wrap(getattr(os, _name)))
'''


def prepare(directory):
    """Write the injected sitecustomize under `directory/tool`; return (pythonpath, hits_dir)."""
    directory = Path(directory)
    (directory / 'tool').mkdir(parents=True, exist_ok=True)
    (directory / 'tool/sitecustomize.py').write_text(SITECUSTOMIZE)
    (directory / 'hits').mkdir(exist_ok=True)
    return str(directory / 'tool'), directory / 'hits'


def collect(hits_dir):
    """Merge every dump in `hits_dir` into {relative path: set(lines)}."""
    merged = {}
    for dump in Path(hits_dir).glob('*.json'):
        for relative, lines in json.loads(dump.read_text()).items():
            merged.setdefault(relative, set()).update(lines)
    return merged


def _code_objects(code, out):
    out.append(code)
    for const in code.co_consts:
        if hasattr(const, 'co_code'):
            _code_objects(const, out)


def analyse(path):
    """(executable lines, {qualified function name: its own executable lines}) for one source file."""
    source = Path(path).read_text()
    code = compile(source, str(path), 'exec')
    codes = []
    _code_objects(code, codes)
    lines, functions = set(), {}
    for each in codes:
        own = {line for _, _, line in each.co_lines() if line is not None}
        lines |= own
        # Functions only (not the module, class bodies, lambdas or generator expressions). The `def` line itself
        # (RESUME) also runs when the module executes the def statement, so it never counts as a body hit.
        if each.co_name in ('<module>', '<lambda>', '<genexpr>', '<listcomp>', '<setcomp>', '<dictcomp>') or \
                not each.co_flags & inspect.CO_OPTIMIZED:
            continue
        functions[f'{each.co_qualname}@{each.co_firstlineno}'] = own - {each.co_firstlineno}
    return lines, functions


def python_files(root):
    root = Path(root)
    found = sorted(path for pattern in ('lcu/*.py', 'scripts/*.py') for path in root.glob(pattern))
    for launcher in sorted((root / 'bin').glob('*')):
        if launcher.is_file() and not launcher.is_symlink():
            head = launcher.read_bytes()[:64]
            if b'python' in head.split(b'\n', 1)[0]:
                found.append(launcher)
    return found


def report(root, data, hosts, scenarios):
    """Markdown report for the oracle tree `root` given merged hit data."""
    root = Path(root)
    rows, details = [], []
    total_lines = total_hit = total_funcs = total_funcs_hit = 0
    for path in python_files(root):
        relative = path.relative_to(root).as_posix()
        try:
            lines, functions = analyse(path)
        except SyntaxError:
            continue
        hit = data.get(relative, set())
        hit_lines = lines & hit
        hit_functions = {name for name, own in functions.items() if own & hit}
        total_lines += len(lines)
        total_hit += len(hit_lines)
        total_funcs += len(functions)
        total_funcs_hit += len(hit_functions)
        percent = 100.0 * len(hit_lines) / len(lines) if lines else 100.0
        rows.append((relative, len(hit_functions), len(functions), len(hit_lines), len(lines), percent))
        missing = sorted((name for name in functions if name not in hit_functions),
                         key=lambda name: int(name.rsplit('@', 1)[1]))
        details.append((relative, sorted(hit_functions, key=lambda n: int(n.rsplit('@', 1)[1])), missing))
    out = ['# Black-box coverage of the Python oracle', '',
           f'Generated by `tests/blackbox/run.py --coverage` from {scenarios} scenario runs on host(s): '
           f'{", ".join(sorted(hosts))}. Line = executable line in a code object; a function counts as exercised '
           'when any line of its own body ran at least once in any scenario. Windows-only and macOS-only code '
           'shows as unexercised on the other hosts.', '',
           f'Total: {total_funcs_hit}/{total_funcs} functions, {total_hit}/{total_lines} lines '
           f'({100.0 * total_hit / total_lines:.1f}%).', '',
           '| module | functions hit | lines hit | % lines |', '|---|---|---|---|']
    for relative, fh, ft, lh, lt, percent in sorted(rows, key=lambda r: (r[5], r[0])):
        out.append(f'| {relative} | {fh}/{ft} | {lh}/{lt} | {percent:.1f} |')
    out += ['', '## Functions per module', '']
    for relative, hit, missing in details:
        out.append(f'### {relative}')
        out.append('')
        if not missing and not hit:
            out.append('(no functions)')
        if hit:
            out.append('Exercised: ' + ', '.join(f'`{n.split("@")[0]}`' for n in hit))
            out.append('')
        if missing:
            out.append('NOT exercised: ' + ', '.join(f'`{n.split("@")[0]}`' for n in missing))
            out.append('')
    return '\n'.join(out) + '\n'
