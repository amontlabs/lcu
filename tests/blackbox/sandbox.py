"""A fresh, fully controlled sandbox in which one scenario runs one implementation."""
import copy
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import time

import fixtures
import npmcache
import snapshot

HERE = Path(__file__).resolve().parent
# Resolved so no path component is a symlink (macOS /tmp -> /private/tmp): LCU refuses symlinked prefixes.
BASE = Path(os.environ.get('LCU_BB_ROOT') or os.path.realpath('/tmp')) / ('' if os.environ.get('LCU_BB_ROOT') else 'lcu-bb')

# The implementation tree is copied the way a release/bundle would carry it: no VCS, tests, docs, site.
TOP_LEVEL_EXCLUDES = {'.git', '.port', '.claude', 'tests', 'site', 'docs', '.verification', 'dist', '.complete'}
# Developer-only files a built archive does not ship (.port/inventory/install.md section 1.1).
ARCHIVE_EXCLUDES = {'scripts/agent-tools', 'scripts/build_bundle.py', 'scripts/check_archive.py',
                    'scripts/provision_agent_tools.py', 'scripts/host-source-inventory.json',
                    'scripts/instructions.lock.json', 'scripts/native'}
ANYWHERE_EXCLUDES = {'node_modules', '__pycache__', '.DS_Store', '.pytest_cache'}

# Executables found by name. Each is a recorder; see assets/recorder.mjs and DEFAULT_FAKES.
FAKE_NAMES = ('codex', 'claude', 'pi', 'omp', 'hermes', 'npx', 'npm', 'codesign', 'dpkg', 'dpkg-query',
              'apt-get', 'sudo', 'curl', 'open', 'osascript', 'swiftc', 'xdg-open')

DEFAULT_FAKES = {
    'codex': {'rules': [{'argv': ['--version'], 'stdout': 'codex-cli 0.0.0-fake\n'}]},
    'claude': {'rules': [{'argv': ['--version'], 'stdout': '0.0.0-fake (Claude Code)\n'}]},
    'pi': {'rules': [{'argv': ['--version'], 'stdout': '0.0.0-fake\n'}]},
    'omp': {'rules': [{'argv': ['--version'], 'stdout': '0.0.0-fake\n'}]},
    'hermes': {'rules': [{'argv': ['--version'], 'stdout': '0.0.0-fake\n'}]},
    'codesign': {'rules': [
        {'match': r'^-dv .*Codex Computer Use\.app$', 'stderr': 'Identifier=com.openai.sky.CUAService\nTeamIdentifier=2DC432GLL2\n'},
        {'match': r'^-dv .*ChatGPT\.app$', 'stderr': 'Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n'},
    ]},
    'dpkg-query': {'default': {'exit': 1, 'stderr': 'dpkg-query: no path found matching pattern\n'}},
    'curl': {'default': {'exit': 6, 'stderr': 'curl: (6) Could not resolve host (fake)\n'}},
    # The fake app's own entry points (not on PATH): behaviour keyed by recorder name.
    'app-codex': {'env': ['HOME', 'CODEX_HOME'], 'appServer': True,
                  'rules': [{'argv': ['--version'], 'stdout': 'codex-cli 0.0.0-fake\n'}]},
    'cua-repl': {'env': '*'},
}


def _real_python():
    candidate = Path(sys.executable).resolve()
    if sys.version_info < (3, 12):
        raise SystemExit('The harness needs Python 3.12+')
    return candidate


def _real_node():
    # LCU_BB_NODE (run.py --node) selects the Node every fake app and recorder runs on.
    found = os.environ.get('LCU_BB_NODE') or shutil.which('node')
    found = shutil.which(found) if found else None
    if not found:
        raise SystemExit('The harness needs `node` on PATH (the fake apps exec it)')
    return Path(found).resolve()


def kill_own_session(process):
    """SIGKILL a timed-out command: only the Popen child the harness spawned itself, and only its own session.

    SAFETY RULE (.port/BRIEF.md): never signal a pid we did not spawn, never by name, parent pid or discovery.
    `process` is our unreaped Popen child (its pid cannot be reused while unreaped), started with
    start_new_session=True, so it leads session and process group `process.pid`. The group is signalled only after
    verifying exactly that (getsid == getpgid == pid); members are descendants that stayed in our session.
    Otherwise only the child itself is signalled, through Popen (which refuses an already reaped pid).
    """
    if process.poll() is not None:
        return
    pid = process.pid
    try:
        ours = pid > 1 and pid != os.getpid() and os.getsid(pid) == pid and os.getpgid(pid) == pid
    except (ProcessLookupError, PermissionError):
        ours = False
    if ours and process.poll() is None:
        try:
            os.killpg(pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            pass
    process.kill()


def copy_impl(source, destination):
    source = Path(source).resolve()

    def ignore(directory, names):
        directory = Path(directory)
        skipped = {n for n in names if n in ANYWHERE_EXCLUDES}
        if directory == source:
            skipped |= {n for n in names if n in TOP_LEVEL_EXCLUDES}
        relative = directory.relative_to(source)
        skipped |= {n for n in names if (relative / n).as_posix() in ARCHIVE_EXCLUDES}
        return skipped

    shutil.copytree(source, destination, symlinks=True, ignore=ignore, dirs_exist_ok=True)


class Sandbox:
    def __init__(self, name, impl_root, *, account_home=False, extra_env=None):
        self.name = name
        self.extra_env = dict(extra_env or {})
        self.impl_root = Path(impl_root)
        fixtures.use_version(fixtures.read_version(self.impl_root))
        self.root = BASE / name
        self.account_home = account_home
        self.account = None
        if account_home:
            if os.environ.get('LCU_BB_DISPOSABLE') != '1':
                raise RuntimeError('account-home scenarios write to the OS account home; they only run in a '
                                   'disposable container (LCU_BB_DISPOSABLE=1, see docker.sh)')
            import pwd
            # True: the account running the harness. A name (root container mode): that account's home.
            entry = pwd.getpwnam(account_home) if isinstance(account_home, str) else pwd.getpwuid(os.getuid())
            self.account = entry.pw_name
            self.home = Path(entry.pw_dir)
        else:
            self.home = self.root / 'home'
        self.tmp = self.root / 'tmp'
        self.work = self.root / 'work'
        self.prefix = self.root / 'prefix'
        self.apps = self.root / 'apps'
        self.src = self.root / 'src'
        self.bb = self.root / '.bb'
        self.log_path = self.bb / 'log/calls.jsonl'
        self.recorder = self.bb / 'recorder.mjs'
        self.config_path = self.bb / 'config.json'
        self.release = self.prefix / 'releases' / fixtures.RELEASE_NAME
        self.fakes = copy.deepcopy(DEFAULT_FAKES)
        self.results = []
        self.baseline = {}
        self._baselined = False
        self._impl_dirs = []
        self._create()

    # -- construction -----------------------------------------------------------------------------------
    def _create(self):
        if self.root.exists():
            shutil.rmtree(self.root)
        if self.account_home:
            for child in self.home.iterdir():
                shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
        self.root.mkdir(parents=True, mode=0o755)
        os.chmod(self.root, 0o755)
        for directory in (self.home, self.tmp, self.work, self.apps, self.bb / 'fakes', self.bb / 'tools',
                          self.bb / 'log'):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o755)
        shutil.copy(HERE / 'assets/recorder.mjs', self.recorder)
        self.log_path.touch()
        for name in FAKE_NAMES:
            self.add_fake(name)
        tools = self.bb / 'tools'
        python = _real_python()
        for link, target in (('python3', python), ('python3.12', python), ('node', _real_node())):
            (tools / link).symlink_to(target)

    def add_fake(self, name):
        # Self-contained: some LCU code runs `codex` and friends with a scrubbed environment, so the recorder
        # must not depend on variables the caller passes.
        node = shlex.quote(str(_real_node()))
        script = ('#!/bin/sh\n'
                  f'export LCU_BB_NODE={node} LCU_BB_RECORDER={shlex.quote(str(self.recorder))} '
                  f'LCU_BB_CONFIG={shlex.quote(str(self.config_path))} LCU_BB_LOG={shlex.quote(str(self.log_path))}\n'
                  f'exec {node} "$LCU_BB_RECORDER" {shlex.quote(name)} "$@"\n')
        fixtures.write(self.bb / 'fakes' / name, script, 0o755)

    def remove_fake(self, name):
        (self.bb / 'fakes' / name).unlink()

    def fake(self, name, **config):
        """Set (replace) a recorder's behaviour: env, stdin, rules=[{argv|match, stdout, stderr, exit}], default."""
        self.fakes[name] = config
        return self

    def place_src(self, sealed=None):
        """Extracted-archive layout: the implementation tree at <sandbox>/src (for installer scenarios).

        `sealed='linux'|'darwin'` also writes the bundle.json an official archive carries (format 1, version,
        platform, architecture and the sha256/mode inventory of every file), so installers accept it. Releases
        an installer creates under <prefix>/releases are compared with this tree, not listed in full.
        """
        copy_impl(self.impl_root, self.src)
        self._impl_dirs.append(('src', None))
        self._impl_dirs.append(('prefix/releases/*', 'src'))
        if sealed:
            self.archive_modules(self.src, sealed, True)
            fixtures.seal(self.src, sealed)
        self._rebaseline(self.src)
        return self.src

    def archive_modules(self, root, target, agent_tools):
        """Add what a built archive carries beyond the source tree: `agent-tools/{package files,node_modules,
        node/bin/node -> ../../../app/.../cua_node/bin/node}` and `adapters/node_modules` (cached `npm ci`, see
        npmcache.py). `agent_tools='fake'` swaps the add-mcp and skills packages for recorders (to observe what
        LCU passes them); the adapters' real node_modules stay."""
        if agent_tools == 'fake':
            npmcache.install(self.impl_root, root, only='adapters')
            fixtures.agent_tools(root, self.recorder)
        else:
            npmcache.install(self.impl_root, root)
        fixtures.agent_tools_node_link(root, target)

    def place_release(self, target=None, *, app=True, bundle=True, installation=True, agent_tools=True,
                      app_omit=(), app_kwargs=None, current=True):
        """An installed release exactly where a real install puts it, with a fixture app selected in place.

        `agent_tools`: True (default) makes the release archive-faithful (real cached node_modules, relative node
        symlink); 'fake' uses recorder add-mcp/skills; False leaves them out.

        Layout: <prefix>/.lcu-install, <prefix>/releases/<name>/{implementation, bundle.json, app ->, installation.json},
        <prefix>/current -> releases/<name>. Returns the release directory.
        """
        target = target or ('darwin' if sys.platform == 'darwin' else 'linux')
        self.prefix.mkdir(exist_ok=True)
        fixtures.write(self.prefix / '.lcu-install', '')
        copy_impl(self.impl_root, self.release)
        self._impl_dirs.append((str(self.release.relative_to(self.root)), None))
        arch = fixtures.architecture()
        if bundle:
            fixtures.write(self.release / 'bundle.json', json.dumps({
                'format': 1, 'version': fixtures.BUNDLE_VERSION, 'platform': target,
                'architecture': arch, 'files': {}}, indent=2, sort_keys=True) + '\n')
        if agent_tools:
            self.archive_modules(self.release, target, agent_tools)
        application = None
        if app:
            if target == 'darwin':
                application = fixtures.mac_app(self.apps / 'ChatGPT.app', self.recorder, omit=app_omit,
                                               **(app_kwargs or {}))
            else:
                application = fixtures.linux_app(self.apps / 'chatgpt', self.recorder, omit=app_omit,
                                                 **(app_kwargs or {}))
            (self.release / 'app').symlink_to(str(application), target_is_directory=True)
        if installation and application is not None:
            descriptor = {'platform': target, 'architecture': arch, 'package_version': fixtures.VERSION,
                          'runtime': fixtures.RUNTIME}
            if target == 'linux':
                descriptor.pop('platform')
            if isinstance(installation, dict):
                descriptor.update(installation)
            descriptor['app'] = str(application)
            (self.release / 'installation.json').write_text(json.dumps(descriptor, indent=2) + '\n')
        if current:
            (self.prefix / 'current').symlink_to(self.release.relative_to(self.prefix))
        self._rebaseline(self.release)
        return self.release

    def add_old_release(self, name, mtime):
        """A superseded release directory (descriptor only) with a fixed modification time."""
        directory = self.prefix / 'releases' / name
        directory.mkdir()
        shutil.copy(self.release / 'installation.json', directory / 'installation.json')
        os.utime(directory, (mtime, mtime))
        return directory

    # -- running ----------------------------------------------------------------------------------------
    def base_env(self):
        return {**self.extra_env, **self._base_env()}

    def _base_env(self):
        return {
            'HOME': str(self.home),
            'PATH': os.pathsep.join([str(self.bb / 'fakes'), str(self.bb / 'tools'), '/usr/bin', '/bin',
                                     '/usr/sbin', '/sbin']),
            'TMPDIR': str(self.tmp),
            'LANG': 'C.UTF-8', 'TZ': 'UTC', 'COLUMNS': '80',
            'PYTHONDONTWRITEBYTECODE': '1',
            'LCU_BB_NODE': str(_real_node()), 'LCU_BB_RECORDER': str(self.recorder),
            'LCU_BB_CONFIG': str(self.config_path), 'LCU_BB_LOG': str(self.log_path),
        }

    def trees(self):
        # Node's on-disk compile cache (written whenever real Node code runs) has nondeterministic content.
        skip = ['.bb', 'tmp/node-compile-cache'] + (['home'] if self.account_home else [])
        trees = [{'label': 'sandbox', 'root': self.root, 'skip': skip,
                  'impl': self._impl_dirs}]
        if self.account_home:
            trees.append({'label': 'account home', 'root': self.home, 'skip': [], 'impl': []})
        return trees

    def _rebaseline(self, directory):
        """An implementation tree placed after the first command: its pristine state joins the baseline, so only
        what LCU later changes inside it is reported."""
        if not self._baselined:
            return
        relative = Path(directory).relative_to(self.root)
        base = self.baseline.setdefault('sandbox', {})
        base[str(relative)] = snapshot.scan(self.root, ['.bb']).get(str(relative))
        for path, entry in snapshot.scan(directory).items():
            base[str(relative / path)] = entry

    def take_baseline(self):
        """Fix the 'before' state now (it is otherwise taken just before the first command). Idempotent."""
        self._take_baseline()

    def compare_with(self, pattern, reference=None):
        """Treat directories matching `pattern` (a glob relative to the sandbox root) as implementation trees:
        list only entries differing from `reference` (a directory relative to the sandbox root, e.g. an archive
        tree the code was copied from), or from the baseline when `reference` is None."""
        self._impl_dirs.append((pattern, reference))

    def show(self, path, label=None):
        """Record a file's state now (type, mode, and its text or sha256) as a pseudo-command in the snapshot,
        for intermediate states the final tree cannot show."""
        path = Path(path)
        try:
            info = path.lstat()
        except OSError as exc:
            body = f'missing ({exc.strerror})\n'
        else:
            import stat as _stat
            if _stat.S_ISLNK(info.st_mode):
                body = f'symlink -> {os.readlink(path)}\n'
            elif _stat.S_ISDIR(info.st_mode):
                body = f'dir {_stat.S_IMODE(info.st_mode):04o}: ' + ' '.join(sorted(os.listdir(path))) + '\n'
            else:
                data = path.read_bytes()
                head = f'file {_stat.S_IMODE(info.st_mode):04o} {len(data)}B'
                try:
                    text = data.decode('utf-8')
                    body = head + '\n' + text if b'\0' not in data else None
                except UnicodeDecodeError:
                    body = None
                if body is None:
                    import hashlib
                    body = head + f' sha256:{hashlib.sha256(data).hexdigest()}\n'
        self.results.append({'label': label or f'show {path}', 'argv': ['(show)', str(path)], 'cwd': '-',
                             'stdin': None, 'tty': False, 'returncode': 0, 'timed_out': False,
                             'stdout': body, 'stderr': ''})
        return body

    def _take_baseline(self):
        if not self._baselined:
            self.baseline = {tree['label']: snapshot.scan(tree['root'], tree['skip']) for tree in self.trees()}
            self._baselined = True

    def run(self, argv, *, stdin=b'', tty=False, env=None, cwd=None, timeout=60, label=None, new_session=True,
            script=None):
        """Run one command. `stdin`: bytes (closed after writing), or None for /dev/null. `env`: overrides, None deletes.

        `tty=True`: stdin and stdout on a pty, stderr on a pipe. `tty='all'`: stdin, stdout and stderr on the pty
        (what a person at a terminal has). `script`: [(regex, text), ...] answers for prompts in tty mode: each regex
        is searched in the output seen since the previous answer (pty and stderr), and `text` is then typed.
        """
        self._take_baseline()
        self.config_path.write_text(json.dumps(self.fakes, indent=2, sort_keys=True))
        environment = self.base_env()
        for key, value in (env or {}).items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = str(value)
        argv = [str(item) for item in argv]
        cwd = Path(cwd) if cwd else self.work
        # Always a new session (the `new_session` argument is kept for API stability only): the timeout kill
        # relies on it, see kill_own_session().
        options = dict(cwd=cwd, env=environment, start_new_session=True)
        master = None
        try:
            if tty:
                master, slave = pty.openpty()
                process = subprocess.Popen(argv, stdin=slave, stdout=slave,
                                           stderr=slave if tty == 'all' else subprocess.PIPE, **options)
                os.close(slave)
            else:
                process = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
        except OSError as exc:
            if master is not None:
                os.close(master)
            self.results.append({
                'label': label or Path(argv[0]).name, 'argv': argv, 'cwd': str(cwd), 'stdin': None, 'tty': tty,
                'returncode': None, 'timed_out': False, 'stdout': '',
                'stderr': f'harness: could not execute: {exc.strerror} ({argv[0]})\n'})
            return self.results[-1]
        timed_out = False
        stdout_pty = b''
        try:
            if tty:
                deadline = time.monotonic() + timeout
                stderr = b''
                open_fds = {master: 'pty'}
                if process.stderr is not None:
                    open_fds[process.stderr.fileno()] = 'stderr'
                pending = list(script or [])
                seen = b''
                while open_fds:
                    ready, _, _ = select.select(list(open_fds), [], [], 0.05)
                    for fd in ready:
                        try:
                            data = os.read(fd, 65536)
                        except OSError:
                            data = b''
                        if not data:
                            del open_fds[fd]
                        elif open_fds[fd] == 'pty':
                            stdout_pty += data
                            seen += data
                        else:
                            stderr += data
                            seen += data
                    while pending and re.search(pending[0][0].encode(), seen):
                        os.write(master, pending.pop(0)[1].encode())
                        seen = b''
                    if time.monotonic() > deadline:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    if not ready and process.poll() is not None and (
                            process.stderr is None or process.stderr.fileno() not in open_fds):
                        break
                process.wait(timeout=max(1, deadline - time.monotonic()))
                stdout = stdout_pty
            else:
                stdout, stderr = process.communicate(stdin if stdin is not None else None, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_own_session(process)
            try:
                stdout, stderr = process.communicate(timeout=10) if not tty else (stdout_pty, b'')
            except subprocess.TimeoutExpired:
                # A descendant that left our session still holds the pipes; it is not ours to signal.
                stdout, stderr = b'', b'harness: output pipes still held after the timeout kill\n'
        finally:
            if master is not None:
                os.close(master)
        self.results.append({
            'label': label or Path(argv[0]).name, 'argv': argv, 'cwd': str(cwd),
            'stdin': None if stdin is None or tty or stdin == b'' else stdin.decode('utf-8', 'backslashreplace'),
            'tty': tty, 'script': script, 'returncode': process.returncode, 'timed_out': timed_out,
            'stdout': snapshot.text(stdout), 'stderr': snapshot.text(stderr)})
        return self.results[-1]

    def lcu(self, *args, **kwargs):
        """Run <release>/bin/lcu (the installed entry point) with arguments."""
        return self.run([self.release / 'bin/lcu', *args], **kwargs)

    def finish(self, names):
        self._take_baseline()
        return snapshot.render(self, self.results, names)
