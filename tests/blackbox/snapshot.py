"""Capture and render one scenario run as canonical text, so two implementations can be diffed."""
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat

SKIP_DIRS = {'__pycache__'}
INLINE_LIMIT = 8192

# Named, per-scenario normalisers. A scenario lists the ones it needs; nothing is applied globally.
NORMALISERS = {
    # NODE_REPL_REQUEST_META carries `lcu-<uuid4>` per launch.
    'uuid': (re.compile(r'lcu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'), 'lcu-<UUID>'),
    # An installer names each release `<version>-<uuid4 hex[:12]>`.
    'release-id': (re.compile(r'(\d+\.\d+\.\d+)-[0-9a-f]{12}\b'), r'\1-<ID>'),
    # tempfile.TemporaryDirectory(prefix='lcu-codex-config-') style random suffixes.
    'tmpdir-suffix': (re.compile(r'(lcu-[a-z]+(?:-[a-z]+)*-)[a-z0-9_]{8}\b'), r'\1<RANDOM>'),
    # macOS lifetime socket directory `lcu-ml-<suffix>`: Python mkdtemp uses 8 characters, Node mkdtemp 6, so any
    # length is accepted (scenarios that care report the suffix length separately).
    'lcu-ml': (re.compile(r'lcu-ml-[A-Za-z0-9_]+'), 'lcu-ml-<RANDOM>'),
    # An uncaught exception: the traceback body is implementation detail, the exception type is not. (The Node
    # port prints the same header and `Type: message`, followed by its stack frames `    at ...`, which go too.)
    'traceback': (re.compile(r'Traceback \(most recent call last\):\n(?:[ \t][^\n]*\n)*([A-Za-z_][\w.]*)(?::[^\n]*)?(?:\n[ \t]+at [^\n]*)*'),
                  r'[uncaught \1]'),
    # Wall-clock values LCU stores in update.json (`checked_at`) and announced.json (`at`).
    'update-times': (re.compile(r'("(?:checked_at|at)": ?)-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?'), r'\1<TIME>'),
    # Like release-id, but the version too (for comparing trees whose versions differ).
    'release-id-any': (re.compile(r'\b\d+\.\d+\.\d+-[0-9a-f]{12}\b'), '<VERSION>-<ID>'),
}


class _Account:
    """`account`: the real OS account running the harness (name and home directory) -> <ACCOUNT>/<ACCOUNT_HOME>,
    so snapshots, goldens and deviations name no personal account. The home is replaced as an exact path prefix.
    The name is replaced as a whole word, except for names that are also ordinary words in LCU's output (root,
    ubuntu, user, admin), which are replaced only in account contexts (`--user NAME`, `for NAME (`, JSON "NAME",
    `USER=`/`LOGNAME=` values, `uid NAME`)."""

    COMMON = {'root', 'ubuntu', 'user', 'admin', 'test'}

    def __init__(self):
        import pwd
        entry = pwd.getpwuid(os.getuid())
        self.name, self.home = entry.pw_name, entry.pw_dir.rstrip('/')
        name = re.escape(self.name)
        self.home_pattern = re.compile(re.escape(self.home) + r'(?=/|\b|$)') if self.home not in ('', '/') else None
        if self.name in self.COMMON:
            self.name_pattern = re.compile(
                rf'(?<=--user ){name}\b|(?<=\bfor ){name}(?= \()|(?<="){name}(?=")|(?<=USER=){name}\b|'
                rf'(?<=LOGNAME=){name}\b')
        else:
            self.name_pattern = re.compile(rf'(?<![\w.-]){name}(?![\w-])')

    def sub(self, _replacement, text):
        if self.home_pattern:
            text = self.home_pattern.sub('<ACCOUNT_HOME>', text)
        return self.name_pattern.sub('<ACCOUNT>', text)


NORMALISERS['account'] = (_Account(), None)


class _DiagnosticLog:
    """`diagnostic-log`: the adapters' metadata log (LCU 0.9.5+, `<dir>/<adapter>-<UTC stamp>-<pid>.jsonl`). Its
    name, size and hash vary with the clock and pid, and its lines carry `t`, `pid` and `ms` values; those become
    <TIME>/<PID>/<MS>. Event names, order, fields and every other value stay compared."""

    NAME = re.compile(r'\b([a-z][a-z0-9-]*)-\d{8}T\d{6}Z-\d+\.jsonl')
    ENTRY = re.compile(r'(-<TIME>-<PID>\.jsonl  file \d{4}) \d+B sha256:[0-9a-f]{64}')
    FIELDS = (re.compile(r'("t":)"[0-9T:.\-]+Z"'), re.compile(r'("pid":)\d+'), re.compile(r'("ms":)\d+'))
    VALUES = ('"<TIME>"', '<PID>', '<MS>')

    def sub(self, _replacement, text):
        text = self.NAME.sub(r'\1-<TIME>-<PID>.jsonl', text)
        text = self.ENTRY.sub(r'\1 <SIZE> sha256:<VARIES>', text)
        for pattern, value in zip(self.FIELDS, self.VALUES):
            text = pattern.sub(lambda match: match.group(1) + value, text)
        return text


NORMALISERS['diagnostic-log'] = (_DiagnosticLog(), None)


def normalise(text, names):
    for name in names:
        pattern, replacement = NORMALISERS[name]
        text = pattern.sub(replacement, text)
    return text


def describe_exit(returncode, timed_out=False):
    if timed_out:
        return 'TIMEOUT (killed)'
    if returncode is None:
        return 'unknown'
    if returncode < 0:
        try:
            return f'signal {signal.Signals(-returncode).name}'
        except ValueError:
            return f'signal {-returncode}'
    return f'exit {returncode}'


def text(data):
    return data.decode('utf-8', errors='backslashreplace')


def _file_digest(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def scan(root, skip=()):
    """Map relative path -> entry dict for every entry under root (symlinks not followed)."""
    root = Path(root)
    skip = {Path(item) for item in skip}
    entries = {}

    def walk(directory):
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            path = directory / name
            relative = path.relative_to(root)
            if name in SKIP_DIRS or relative in skip:
                continue
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            entry = {'mode': f'{mode:04o}'}
            if stat.S_ISLNK(info.st_mode):
                entry.update(type='symlink', target=os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                entry['type'] = 'dir'
            elif stat.S_ISREG(info.st_mode):
                entry.update(type='file', size=info.st_size, sha256=_file_digest(path))
            else:
                entry['type'] = 'other'
            entries[str(relative)] = entry
            if entry['type'] == 'dir':
                walk(path)

    walk(root)
    return entries


def _inline(path):
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if len(data) > INLINE_LIMIT or b'\0' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def _impl_match(relative, impl, references):
    """None outside the implementation. Else (reference entry, is_root, has_reference) for the matching item.

    An impl item is (glob, reference_dir_or_None): the glob selects implementation directories relative to the
    tree root; entries inside are compared to the baseline (no reference) or to the same relative path inside
    `reference_dir` (an extracted archive an installer copied from).
    """
    for pattern, reference in impl:
        depth = pattern.count('/') + 1
        parts = relative.split('/')
        if len(parts) >= depth and fnmatch.fnmatchcase('/'.join(parts[:depth]), pattern):
            rest = '/'.join(parts[depth:])
            if reference is None:
                return None, rest == '', False
            return references[reference].get(rest), rest == '', True
    return None


def render_tree(root, entries, baseline, impl_dirs):
    """Lines for the tree section.

    Everything outside the implementation directories is listed in full. Content is inlined for small text
    files that are new or changed since the baseline taken just before the first command ran. Inside an
    implementation directory (the code under test) only differences are listed, because the code itself
    differs between implementations: from the baseline for a directory the harness placed, or from a
    reference tree (the extracted archive) for a release an installer created.
    """
    references = {reference: scan(Path(root) / reference) for _, reference in impl_dirs if reference}
    lines = []
    for relative in sorted(entries):
        entry = entries[relative]
        previous = baseline.get(relative)
        match = _impl_match(relative, impl_dirs, references)
        if match is not None:
            ref_entry, is_root, has_reference = match
            if is_root or (ref_entry == entry if has_reference else previous == entry):
                continue
        changed = previous != entry
        marker = ' [new]' if previous is None else ' [changed]' if changed else ''
        head = f'{relative}  {entry["type"]} {entry["mode"]}'
        if entry['type'] == 'symlink':
            head += f' -> {entry["target"]}'
        elif entry['type'] == 'file':
            head += f' {entry["size"]}B sha256:{entry["sha256"]}'
        lines.append(head + marker)
        if entry['type'] == 'file' and (previous is None or changed):
            content = _inline(Path(root) / relative)
            if content is not None:
                lines.extend('    | ' + line for line in content.split('\n'))
    for relative in sorted(set(baseline) - set(entries)):
        lines.append(f'{relative}  [deleted]')
    return lines


def render_log(path):
    try:
        raw = Path(path).read_text()
    except OSError:
        return []
    lines = []
    for number, line in enumerate(raw.splitlines(), 1):
        try:
            # One field per line (env one variable per line) so a difference is a one-line diff.
            body = json.dumps(json.loads(line), indent=2, sort_keys=True, ensure_ascii=False)
            lines.append(f'--- call {number}')
            lines.extend('    ' + part for part in body.splitlines())
        except ValueError:
            lines.append(f'{number}: (unparseable) {line}')
    return lines


def render(sandbox, results, names):
    out = []
    for index, result in enumerate(results, 1):
        out.append(f'### run {index}: {result["label"]}')
        out.append('$ ' + ' '.join(result['argv']))
        out.append(f'cwd: {result["cwd"]}')
        if result.get('stdin') is not None:
            out.append(f'stdin: {result["stdin"]!r}')
        if result.get('tty') == 'all':
            out.append('tty: stdin+stdout+stderr attached to a pty')
        elif result.get('tty'):
            out.append('tty: stdin+stdout attached to a pty')
        for pattern, answer in result.get('script') or []:
            out.append(f'tty answer: on {pattern!r} type {answer!r}')
        out.append(f'result: {describe_exit(result["returncode"], result["timed_out"])}')
        out.append('--- stdout ---')
        out.append(result['stdout'])
        out.append('--- stderr ---')
        out.append(result['stderr'])
    for tree in sandbox.trees():
        out.append(f'### file tree: {tree["label"]}')
        out.extend(render_tree(tree['root'], scan(tree['root'], tree['skip']),
                               sandbox.baseline.get(tree['label'], {}), tree['impl']))
    out.append('### recorder log')
    out.extend(render_log(sandbox.log_path))
    return normalise('\n'.join(out) + '\n', names)
