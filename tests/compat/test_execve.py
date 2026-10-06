"""lcu/compat/execve.mjs against os.execve / os.execvpe."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import NODE, NodeTestCase, run_node

PY_EXEC = r'''
import json, os, sys
spec = json.load(sys.stdin)
try:
    if spec['mode'] == 'execve':
        os.execve(spec['file'], spec['argv'], spec['env'])
    else:
        os.execvpe(spec['file'], spec['argv'], spec['env'])
except BaseException as exc:
    sys.stdout.write('ERR ' + type(exc).__name__ + ': ' + str(exc))
    sys.stdout.flush()
'''

NODE_EXEC = """
const m = await import(COMPAT + 'execve.mjs');
const { mode, file, argv, env } = input;
try {
  const opts = input.opts ?? {};
  if (mode === 'execve') m.execve(file, argv, env, opts); else m.execvpe(file, argv, env, opts);
} catch (err) {
  process.stdout.write('ERR ' + err.name + ': ' + err.message);
}
"""


def python_result(spec, cwd=None):
    done = subprocess.run([sys.executable, '-c', PY_EXEC], input=json.dumps(spec), capture_output=True, text=True,
                          cwd=cwd, env={})
    return done.stdout.strip(), done.stderr


class NativeAbort(AssertionError):
    pass


def node_run(spec, cwd=None, prelude_extra=''):
    prelude = ("const COMPAT = " + json.dumps((Path(__file__).resolve().parents[2] / 'lcu/compat').as_uri() + '/') +
               ";\nimport * as require_fs from 'node:fs';\nconst input = JSON.parse(require_fs.readFileSync(0, 'utf8'));\n"
               + prelude_extra)
    done = subprocess.run([NODE, '--input-type=module', '-e', prelude + NODE_EXEC],
                          input=json.dumps(spec), capture_output=True, text=True, cwd=cwd, env={},
                          preexec_fn=no_core_files)
    return done.stdout.strip(), done.stderr, done.returncode


def no_core_files():
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def node_result(spec, cwd=None):
    """Node's outcome; with no explicit opts, both paths are run (the authoritative catchable exec when the
    running Node has it, and the preflight path old Nodes use) and must agree and never abort."""
    results = []
    for opts in ([spec['opts']] if 'opts' in spec else [{}, {'catchable': False}]):
        out, err, code = node_run({**spec, 'opts': opts}, cwd)
        if code < 0 or 'process.execve failed' in err:
            raise NativeAbort(f'node aborted ({code}) with {opts}: {err[:300]}')
        results.append((out, err))
    if len(results) == 2:
        assert results[0] == results[1], results
    return results[0]


def make_script(path, body, mode=0o755):
    path.write_text(body)
    path.chmod(mode)


def argument_space():
    """The bytes this system lets one exec carry, as lcu/compat/execve.mjs derives them (the kernel's
    bprm_stack_limits on Linux: a quarter of the soft stack limit, at most 6 MiB, at least 128 KiB; kern.argmax on
    macOS). CI kernels and ulimits differ from a developer machine's, so the cases below are sized from this."""
    if sys.platform == 'darwin':
        return 1048576
    import resource
    soft = resource.getrlimit(resource.RLIMIT_STACK)[0]
    stack = float('inf') if soft == resource.RLIM_INFINITY else soft
    return int(max(min(8 * 1024 * 1024 / 4 * 3, stack / 4), 32 * 4096))


class ExecveTests(NodeTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name).resolve()
        d = self.d
        make_script(d / 'ok.sh', '#!/bin/sh\necho EXECOK\n')
        make_script(d / 'ok_args.sh', '#!/bin/sh -e\necho EXECOK "$@"\n')
        make_script(d / 'ok_env.sh', '#!/usr/bin/env sh\necho EXECOK\n')
        make_script(d / 'noexec.sh', '#!/bin/sh\necho EXECOK\n', 0o644)
        make_script(d / 'noshebang', 'echo EXECOK\n')
        make_script(d / 'empty', '')
        make_script(d / 'binary_junk', 'JUNKJUNKJUNK')
        make_script(d / 'shebang_missing', '#!/nonexistent/interpreter\necho EXECOK\n')
        make_script(d / 'shebang_empty', '#!\necho EXECOK\n')
        make_script(d / 'shebang_spaces', '#!   \necho EXECOK\n')
        make_script(d / 'interp_noexec.txt', '#!/bin/sh\n', 0o644)
        make_script(d / 'shebang_noexec', f'#!{d}/interp_noexec.txt\n')
        make_script(d / 'shebang_dir', '#!/tmp\n')
        make_script(d / 'shebang_chain', f'#!{d}/ok.sh\necho EXECOK\n')
        make_script(d / 'shebang_chain_noshebang', f'#!{d}/noshebang\n')
        (d / 'dir').mkdir()
        (d / 'link_ok').symlink_to('ok.sh')
        (d / 'link_loop_a').symlink_to('link_loop_b')
        (d / 'link_loop_b').symlink_to('link_loop_a')
        (d / 'link_dangling').symlink_to('nowhere')
        os.mkfifo(d / 'fifo', 0o755)
        (d / 'sub').mkdir()
        make_script(d / 'sub' / 'ok.sh', '#!/bin/sh\necho EXECOK\n')

    def targets(self):
        d = str(self.d)
        long_name = 'a' * 300
        return [
            f'{d}/ok.sh', f'{d}/ok_args.sh', f'{d}/ok_env.sh', f'{d}/link_ok', f'{d}/sub/../ok.sh', f'{d}/missing',
            f'{d}/sub/missing', f'{d}/noexec.sh', f'{d}/noshebang', f'{d}/empty', f'{d}/binary_junk',
            f'{d}/shebang_missing', f'{d}/shebang_empty', f'{d}/shebang_spaces', f'{d}/shebang_noexec',
            f'{d}/shebang_dir', f'{d}/shebang_chain', f'{d}/shebang_chain_noshebang', f'{d}/dir', f'{d}/dir/',
            f'{d}/ok.sh/', f'{d}/ok.sh/x', f'{d}/link_loop_a', f'{d}/link_dangling', f'{d}/fifo',
            f'{d}/{long_name}', '/', '/etc/passwd', '/bin/sh', '/bin/echo', '/nonexistent', f'{d}/sub/ok.sh',
        ]

    def test_execve_matches_python(self):
        for target in self.targets():
            spec = {'mode': 'execve', 'file': target, 'argv': [target, 'one'], 'env': {'A': 'b'}}
            with self.subTest(target=target):
                want = python_result(spec)
                have = node_result(spec)
                self.assertEqual(have, want)

    def test_relative_paths(self):
        for target in ['ok.sh', './ok.sh', 'sub/ok.sh', 'missing', 'dir', '../' + self.d.name + '/ok.sh']:
            spec = {'mode': 'execve', 'file': target, 'argv': ['x'], 'env': {}}
            with self.subTest(target=target):
                self.assertEqual(node_result(spec, cwd=self.d), python_result(spec, cwd=self.d))

    def test_argument_errors(self):
        d = str(self.d)
        specs = [
            {'file': f'{d}/ok.sh', 'argv': [], 'env': {}},
            {'file': f'{d}/ok.sh', 'argv': ['a\0b'], 'env': {}},
            {'file': f'{d}/ok.sh', 'argv': ['a'], 'env': {'A=B': '1'}},
            {'file': f'{d}/ok.sh', 'argv': ['a'], 'env': {'A': '1\0'}},
            {'file': f'{d}/ok.sh', 'argv': ['a'], 'env': {'': '1'}},
            {'file': f'{d}/ok\0.sh', 'argv': ['a'], 'env': {}},
            {'file': f'{d}/ok.sh', 'argv': ['a'], 'env': {'LANG': 'é', 'X': ''}},
        ]
        for spec in specs:
            spec['mode'] = 'execve'
            with self.subTest(spec=spec):
                have, want = node_result(spec), python_result(spec)
                # Python 3.12 patch releases word the NUL-in-path error differently.
                norm = lambda r: (r[0].replace('execve: embedded null character in path', 'embedded null byte'), r[1])
                self.assertEqual(norm(have), norm(want))

    def test_argument_too_long(self):
        d = str(self.d)
        spec = {'mode': 'execve', 'file': f'{d}/ok.sh', 'argv': ['x', 'y' * 2_000_000], 'env': {}}
        want = python_result(spec)
        self.assertIn('Argument list too long', want[0])
        self.assertEqual(node_result(spec), want)

    def test_execvpe_search(self):
        d = self.d
        for name in ('first', 'second', 'third'):
            (d / name).mkdir()
        make_script(d / 'first' / 'tool', '#!/bin/sh\necho FIRST\n', 0o644)  # EACCES: wins over later ENOENT
        make_script(d / 'second' / 'tool', '#!/bin/sh\necho EXECOK second\n')
        make_script(d / 'third' / 'tool2', '#!/bin/sh\necho EXECOK third\n')
        (d / 'third' / 'asfile').write_text('x')
        make_script(d / 'cwdtool', '#!/bin/sh\necho EXECOK cwd\n')
        paths = [
            f'{d}/first:{d}/second', f'{d}/second:{d}/first', f'{d}/missing:{d}/third', f'{d}/third:{d}/missing',
            f'{d}/missing:{d}/also-missing', f'{d}/asfile:{d}/third', ':', f'{d}/missing:', '', f'{d}/second/',
            f'{d}/first:{d}/missing',
        ]
        cases = []
        for path in paths:
            for name in ('tool', 'tool2', 'cwdtool', 'nothing', 'asfile', ''):
                cases.append((path, name))
        for path, name in cases:
            spec = {'mode': 'execvpe', 'file': name, 'argv': [name or 'x'], 'env': {'PATH': path}}
            with self.subTest(path=path, name=name):
                self.assertEqual(node_result(spec, cwd=d), python_result(spec, cwd=d))
        # PATH absent from env: os.defpath
        spec = {'mode': 'execvpe', 'file': 'sh', 'argv': ['sh', '-c', 'echo EXECOK'], 'env': {}}
        self.assertEqual(node_result(spec, cwd=d), python_result(spec, cwd=d))
        spec = {'mode': 'execvpe', 'file': 'nothing-like-this', 'argv': ['x'], 'env': {}}
        self.assertEqual(node_result(spec, cwd=d), python_result(spec, cwd=d))
        # a name with a slash is never searched
        spec = {'mode': 'execvpe', 'file': 'second/tool', 'argv': ['x'], 'env': {'PATH': f'{d}/third'}}
        self.assertEqual(node_result(spec, cwd=d), python_result(spec, cwd=d))

    def test_success_replaces_process_silently(self):
        d = self.d
        done = subprocess.run([NODE, '--input-type=module', '-e', f"""
import {{ execve }} from {json.dumps((Path(__file__).resolve().parents[2] / 'lcu/compat/execve.mjs').as_uri())};
process.stdout.write('before\\n');
execve({json.dumps(str(d / 'ok_args.sh'))}, ['ok_args.sh', 'a b'], {{ MARK: '1' }});
"""], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, 'before\nEXECOK a b\n')
        self.assertEqual(done.stderr, '')

    def test_failure_never_aborts(self):
        # the whole point: a bad target is an exception, not SIGABRT
        spec = {'mode': 'execve', 'file': str(self.d / 'noexec.sh'), 'argv': ['x'], 'env': {}}
        done = subprocess.run([NODE, '--input-type=module', '-e', f"""
import {{ execve }} from {json.dumps((Path(__file__).resolve().parents[2] / 'lcu/compat/execve.mjs').as_uri())};
try {{ execve({json.dumps(spec['file'])}, ['x'], {{}}); }} catch (err) {{ console.log(err.name, err.message); }}
console.log('still running');
"""], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('[Errno 13] Permission denied', done.stdout)
        self.assertIn('still running', done.stdout)

    # ---- compat-os review finding 5: deterministic failures beyond the old preflight ------------------

    def true_binary(self):
        return '/usr/bin/true' if os.path.exists('/usr/bin/true') else '/bin/true'

    def compare(self, spec):
        want = python_result(spec)
        self.assertNotEqual(want[0], '', 'the case must fail in Python')
        self.assertEqual(node_result(spec), want)

    def test_aggregate_argument_space(self):
        # app_exec.py aggregate-pointers-E2BIG and exec-aggregate-E2BIG: many strings whose bytes fit but
        # whose pointers / sum do not.
        true = self.true_binary()
        # Sized to exceed this system's limit twice over: the pointers alone (8 bytes each), resp. the string bytes.
        limit = argument_space()
        for argv in (['true'] + [''] * (2 * limit // 8), ['echo'] + ['x' * 1000] * (2 * limit // 1000)):
            with self.subTest(count=len(argv)):
                self.compare({'mode': 'execve', 'file': true, 'argv': argv, 'env': {}})
        # order: a missing target with oversized arguments (Linux reports the target, macOS the arguments)
        self.compare({'mode': 'execve', 'file': '/nonexistent', 'argv': ['true'] + [''] * (2 * limit // 8), 'env': {}})

    def test_argument_space_boundary(self):
        # The largest argument list Python's execve accepts is accepted, one more string is E2BIG.
        true = self.true_binary()
        code = ("import os,sys\nn,k=int(sys.argv[1]),int(sys.argv[2])\n"
                f"try: os.execve({true!r}, ['true'] + ['x' * k] * n, {{}})\nexcept OSError as e: print(e.errno)")

        def fits(n, k):
            return subprocess.run([sys.executable, '-c', code, str(n), str(k)], capture_output=True,
                                  text=True).stdout.strip() == ''
        for k in (0, 7, 1000):
            lo, hi = 0, 2 * argument_space() // (k + 9)  # twice what the system allows: never the cap itself
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if fits(mid, k):
                    lo = mid
                else:
                    hi = mid - 1
            got = run_node("""
const m = await import(COMPAT + 'execve.mjs');
const args = (n) => ['true', ...Array(n).fill('x'.repeat(input.k))];
emit([m.argumentSpaceFailure(input.file, args(input.n), {}), m.argumentSpaceFailure(input.file, args(input.n + 1), {})]);
""", {'file': true, 'n': lo, 'k': k})
            with self.subTest(k=k, max_count=lo):
                self.assertEqual(got, [None, 'E2BIG'])

    def test_shebang_nesting_bound(self):
        # exec-shebang-depth-5: Linux follows at most five #! levels; macOS none through a script.
        d = self.d
        for n in range(7):
            make_script(d / f's{n}', '#!/bin/echo\n' if n == 0 else f'#!{d}/s{n - 1}\n')
        for n in range(7):
            spec = {'mode': 'execve', 'file': str(d / f's{n}'), 'argv': ['x'], 'env': {}}
            with self.subTest(depth=n):
                self.assertEqual(node_result(spec), python_result(spec))

    def test_non_ascii_shebang_interpreters(self):
        # .port/requests/compat.md item 7 (port-runtime review #8): the #! interpreter is raw bytes; a UTF-8
        # (or other non-ASCII) interpreter path must be opened as is, not Latin-1-decoded and re-encoded.
        d = os.fsencode(str(self.d))
        names = [b'caf\xc3\xa9-shell', b'\xe4\xb8\xad-shell', b'latin\xe9-shell']
        cases = []
        for name in names:
            try:
                os.symlink(b'/bin/sh', d + b'/' + name)
            except OSError:
                continue  # the filesystem refuses this byte sequence (e.g. non-UTF-8 on APFS)
            cases.append(name)
        cases.append(b'caf\xc3\xa9-missing')
        self.assertGreaterEqual(len(cases), 3)
        for index, name in enumerate(cases):
            for suffix in (b'', b' -e', b'\t-e'):
                script = d + b'/shebang-%d-%d' % (index, len(suffix))
                with open(script, 'wb') as out:
                    out.write(b'#!' + d + b'/' + name + suffix + b'\necho EXECOK\n')
                os.chmod(script, 0o755)
                target = os.fsdecode(script)
                spec = {'mode': 'execve', 'file': target, 'argv': [target], 'env': {}}
                with self.subTest(interpreter=name, suffix=suffix):
                    self.assertEqual(node_result(spec), python_result(spec))
        got = run_node("""
const m = await import(COMPAT + 'execve.mjs');
emit(m.preflight(input, [input], {}));""", os.fsdecode(d + b'/shebang-0-0'))
        self.assertIsNone(got)

    @unittest.skipUnless(sys.platform == 'darwin', 'Mach-O')
    def test_macho_without_a_runnable_slice(self):
        d = self.d
        import struct
        thin_ppc = struct.pack('<IIIIIII', 0xfeedface, 18, 0, 2, 0, 0, 0)
        fat_ppc_i386 = struct.pack('>II', 0xcafebabe, 2) + struct.pack('>IIIII', 18, 0, 4096, 64, 12) \
            + struct.pack('>IIIII', 7, 3, 8192, 64, 12)
        fat_ppc_i386 = fat_ppc_i386.ljust(4096, b'\0') + thin_ppc.ljust(4096, b'\0') \
            + struct.pack('<IIIIIII', 0xfeedface, 7, 3, 2, 0, 0, 0).ljust(4096, b'\0')
        for name, data in (('thin_ppc', thin_ppc), ('fat_ppc_i386', fat_ppc_i386)):
            (d / name).write_bytes(data)
            (d / name).chmod(0o755)
            with self.subTest(name):
                self.compare({'mode': 'execve', 'file': str(d / name), 'argv': ['x'], 'env': {}})

    @unittest.skipUnless(os.path.isdir('/lcu-noexec'), 'needs the noexec tmpfs docker.sh mounts at /lcu-noexec')
    def test_noexec_mount(self):
        with tempfile.TemporaryDirectory(dir='/lcu-noexec') as tmp:
            make_script(Path(tmp) / 'script', '#!/bin/sh\necho EXECOK\n')
            binary = Path(tmp) / 'true'
            binary.write_bytes(Path(self.true_binary()).read_bytes())
            binary.chmod(0o755)
            make_script(self.d / 'via_noexec', f'#!{binary}\n')
            for target in (Path(tmp) / 'script', binary, self.d / 'via_noexec'):
                with self.subTest(target=str(target)):
                    self.compare({'mode': 'execve', 'file': str(target), 'argv': ['x'], 'env': {}})

    def test_closed_standard_stream_is_a_distinct_error(self):
        # Python execs with a closed fd 0; Node's process.execve cannot (it must clear FD_CLOEXEC on 0-2).
        py = subprocess.run([sys.executable, '-c', "import os\nos.close(0)\nos.execve('/bin/sh', ['sh', '-c', 'echo EXECOK'], {})"],
                            capture_output=True, text=True)
        self.assertEqual(py.stdout, 'EXECOK\n')
        for opts in ('{}', '{ catchable: false }'):
            done = subprocess.run([NODE, '--input-type=module', '-e', f"""
import {{ closeSync }} from 'node:fs';
const m = await import({json.dumps((Path(__file__).resolve().parents[2] / 'lcu/compat/execve.mjs').as_uri())});
closeSync(0);
try {{ m.execve('/bin/sh', ['sh', '-c', 'echo EXECOK'], {{}}, {opts}); }} catch (err) {{ console.log(err.name); }}
"""], capture_output=True, text=True, preexec_fn=no_core_files)
            self.assertEqual((done.returncode, done.stdout), (0, 'ExecUnsupportedError\n'), done.stderr)

    def test_catchable_path_selection(self):
        got = run_node("""
const m = await import(COMPAT + 'execve.mjs');
emit(['24.21.0', '25.9.0', '26.0.0', '26.1.0', '26.10.0', '27.0.0'].map((v) => m.catchableExecFailures(v)));""")
        self.assertEqual(got, [False, False, False, True, True, True])


if __name__ == '__main__':
    unittest.main()
