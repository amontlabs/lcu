"""lcu/compat/pyerr.mjs against the real Python interpreter."""
import errno
import json
import os
import random
import signal
import subprocess
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import NodeTestCase, py_cases, run_node

REPR_CASES = [
    '', 'plain', "it's", 'say "hi"', 'both \' and "', "\\", "tab\there", 'nl\nx', 'cr\rx', '\x00\x01\x1f\x7f',
    '\x80\x9f\xa0\xad', 'café', 'é中文', '​‎  ﻿', '\U0001f600 emoji',
    '\U0001f1eb\U0001f1f7', '\ud800', '\udc80abc', 'a\udfffb', '\U000e0001', '\U0010ffff', '�', '　',
    '/Users/x y/Library/Application Support/é\'s', 'é', '', "''\"\"",
]


class ReprTests(NodeTestCase):
    def test_repr_fixed(self):
        got = run_node("const m = await import(COMPAT + 'pyerr.mjs'); emit(input.map(m.reprStr));", REPR_CASES)
        self.assertEqual(got, [repr(case) for case in REPR_CASES])

    def test_repr_fuzz(self):
        rng = random.Random(7)
        cases = []
        while len(cases) < 4000:
            text = ''
            for _ in range(rng.randint(1, 8)):
                cp = rng.choice([rng.randint(0, 0x2ff), rng.randint(0, 0xffff), rng.randint(0x10000, 0x2ffff),
                                 rng.randint(0xe0000, 0xe01ff)])
                if 0xd800 <= cp < 0xe000:
                    continue
                # Unassigned (Cn) code points included: printability comes from Python's own table now.
                text += chr(cp)
            cases.append(text)
        got = run_node("const m = await import(COMPAT + 'pyerr.mjs'); emit(input.map(m.reprStr));", cases)
        self.assertEqual(got, [repr(case) for case in cases])

    def test_printable_table_is_python_312(self):
        # finding 16 (pyerr-new-unicode): every code point's printability equals this interpreter's
        # (Python 3.12, Unicode 15.0.0), whatever ICU the running Node has.
        if sys.version_info[:2] != (3, 12):
            self.skipTest('the table is Python 3.12 data')
        want = ''.join('1' if chr(cp).isprintable() else '0' for cp in range(0x110000))
        got = run_node("""
const m = await import(COMPAT + 'pyerr.mjs');
let s = '';
for (let cp = 0; cp < 0x110000; cp++) s += m.isPrintable(cp) ? '1' : '0';
emit(s);""")
        self.assertEqual(len(got), len(want))
        diff = [hex(cp) for cp in range(0x110000) if got[cp] != want[cp]][:20]
        self.assertEqual(diff, [])
        name = '/absent/\U0001cc00'
        try:
            open(name)
        except OSError as err:
            expected = str(err)
        got = run_node("""
const fs = await import('node:fs');
const e = await import(COMPAT + 'pyerr.mjs');
try { fs.readFileSync(input); } catch (err) { emit(e.pyStr(err)); }""", name)
        self.assertEqual(got, expected)

    def test_float_repr(self):
        cases = [0.0, 1.0, 20.0, 0.5, 1.5, 1e16, 1e15, 1e-4, 1e-5, 123456789.125, -2.0, 1e22, 5e-324, 0.1 + 0.2]
        got = run_node("const m = await import(COMPAT + 'pyerr.mjs'); emit(input.map(m.reprFloat));", cases)
        self.assertEqual(got, [repr(case) for case in cases])


class TableTests(NodeTestCase):
    def test_tables_match_live_platform(self):
        names = {n: getattr(errno, n) for n in dir(errno) if n.startswith('E') and isinstance(getattr(errno, n), int)}
        got = run_node("""
const m = await import(COMPAT + 'pyerr.mjs');
const out = { errno: {}, strerror: {}, cls: {}, signals: {} };
for (const name of input.names) {
  out.errno[name] = m.errnoNumber(name);
  out.cls[name] = m.errorClassName(name);
}
for (let n = 0; n < 200; n++) out.strerror[n] = m.strerror(n);
for (let n = 1; n < 70; n++) out.signals[n] = m.calledProcessError(-n, 'x');
emit(out);
""", {'names': sorted(names)})
        self.assertEqual(got['errno'], names)
        self.assertEqual(got['strerror'], {str(i): os.strerror(i) for i in range(200)})
        self.assertEqual(got['cls'], {n: type(OSError(v, 'x')).__name__ for n, v in names.items()})
        expected = {}
        for n in range(1, 70):
            expected[str(n)] = str(subprocess.CalledProcessError(-n, 'x'))
        self.assertEqual(got['signals'], expected)


class OSErrorTests(NodeTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()

    def cases(self):
        d = self.dir
        (d / 'file').write_text('x')
        (d / "q'uote \"x\" é").write_text('x')
        (d / 'dir').mkdir()
        (d / 'link').symlink_to('file')
        (d / 'exec_no').write_text('#!/bin/sh\n')
        (d / 'exec_no').chmod(0o644)
        (d / 'enoexec').write_text('not a script\n')
        (d / 'enoexec').chmod(0o755)
        return d

    def test_matches_python_for_real_syscalls(self):
        d = self.cases()
        ops = [
            ('open-missing', 'readFileSync', [str(d / 'missing')]),
            ('open-missing-quote', 'readFileSync', [str(d / "q'uote \"x\" é" / 'sub')]),
            ('mkdir-exists', 'mkdirSync', [str(d / 'dir')]),
            ('listdir-file', 'readdirSync', [str(d / 'file')]),
            ('write-dir', 'writeFileSync', [str(d / 'dir'), 'x']),
            ('rename-missing', 'renameSync', [str(d / 'nope'), str(d / 'dest')]),
            ('symlink-exists', 'symlinkSync', ['target', str(d / 'file')]),
            ('rmdir-nonempty', 'rmdirSync', [str(d)]),
            ('open-through-file', 'readFileSync', [str(d / 'file' / 'sub')]),
            ('unlink-dir', 'unlinkSync', [str(d / 'dir')]),
            ('readlink-nonlink', 'readlinkSync', [str(d / 'file')]),
        ]

        def python(case):
            name, _, args = case
            try:
                if name.startswith('open'):
                    open(args[0]).read()
                elif name == 'mkdir-exists':
                    os.mkdir(args[0])
                elif name == 'listdir-file':
                    os.listdir(args[0])
                elif name == 'write-dir':
                    open(args[0], 'w').write('x')
                elif name == 'rename-missing':
                    os.rename(args[0], args[1])
                elif name == 'symlink-exists':
                    os.symlink(args[0], args[1])
                elif name == 'rmdir-nonempty':
                    os.rmdir(args[0])
                elif name == 'unlink-dir':
                    os.unlink(args[0])
                elif name == 'readlink-nonlink':
                    os.readlink(args[0])
            except OSError as exc:
                return {'text': str(exc), 'cls': type(exc).__name__}
            return {'text': None}

        expected = py_cases(python, ops)
        got = run_node("""
const fs = await import('node:fs');
const m = await import(COMPAT + 'pyerr.mjs');
const out = [];
for (const [name, fn, args] of input) {
  try { fs[fn](...args); out.push({ text: null }); }
  catch (err) { const e = m.fromNodeError(err); out.push({ text: e?.message ?? 'NOT-SYSTEM ' + err.message, cls: e?.name }); }
}
emit(out);
""", ops)
        for (name, _, _), want, have in zip(ops, expected, got):
            with self.subTest(name):
                # shutil.copyfile reports through its own wording for some failures; keep to errno text.
                self.assertEqual(have, want)

    def test_spawn_errors(self):
        d = self.cases()
        targets = [str(d / 'missing'), str(d / 'exec_no'), str(d / 'dir'), 'definitely-not-a-command-xyz',
                   str(d / 'file' / 'x')]

        def python(path):
            try:
                subprocess.run([path], capture_output=True)
            except OSError as exc:
                return {'text': str(exc), 'cls': type(exc).__name__}
            return {'text': None}

        expected = py_cases(python, targets)
        got = run_node("""
import { spawnSync } from 'node:child_process';
const m = await import(COMPAT + 'pyerr.mjs');
emit(input.map((p) => { const r = spawnSync(p, [], { env: { PATH: process.env.PATH } });
  if (!r.error) return { text: null };
  const e = m.fromNodeError(r.error); return { text: e?.message, cls: e?.name }; }));
""", targets)
        for target, want, have in zip(targets, expected, got):
            with self.subTest(target):
                self.assertEqual(have, want)

    def test_cwd_override(self):
        def python(_):
            try:
                subprocess.run(['true'], cwd='/no/such/cwd')
            except OSError as exc:
                return str(exc)
        got = run_node("""
import { spawnSync } from 'node:child_process';
const m = await import(COMPAT + 'pyerr.mjs');
const r = spawnSync('true', [], { cwd: '/no/such/cwd' });
emit(m.spawnErrorText(r.error, { cwd: '/no/such/cwd' }));
""")
        self.assertEqual(got, python(None))

    def test_cwd_blamed_only_when_it_fails(self):
        # finding 12 (pyerr-existing-cwd): Python's precedence: an unusable cwd first, else the executable.
        with tempfile.TemporaryDirectory() as tmp:
            afile = Path(tmp) / 'afile'
            afile.write_text('x')
            cases = [['/absent/command', '/tmp'], ['true', '/no/such/cwd'], ['/absent/command', '/no/such/cwd'],
                     ['true', str(afile)], ['/absent/command', str(afile)], ['/absent/command', ''],
                     ['/absent/command', None]]

            def python(case):
                command, cwd = case
                try:
                    subprocess.run([command], cwd=cwd, capture_output=True)
                    return 'ran'
                except OSError as exc:
                    return f'{type(exc).__name__}: {exc}'
            want = [python(case) for case in cases]
            got = run_node("""
import { spawnSync } from 'node:child_process';
const m = await import(COMPAT + 'pyerr.mjs');
emit(input.map(([command, cwd]) => {
  const r = spawnSync(command, [], cwd === null ? {} : { cwd });
  if (!r.error) return 'ran';
  const text = m.spawnErrorText(r.error, cwd === null ? {} : { cwd });
  return text;
}));""", cases)
        self.assertEqual(got, [w.split(': ', 1)[1] if w != 'ran' else w for w in want])

    def test_converted_errors_are_not_rerendered(self):
        # finding 11 (pyerr-rerender-PyOSError): pyStr/fromNodeError keep a PyOSError's own filename.
        want = str(OSError(2, os.strerror(2), '/absent/command'))
        got = run_node("""
const m = await import(COMPAT + 'execve.mjs');
const e = await import(COMPAT + 'pyerr.mjs');
const err = m.execError('ENOENT', '/absent/command');
let failed = null;
try { m.execve('/absent/command', ['x'], {}); } catch (x) { failed = x; }
emit({ message: err.message, pyStr: e.pyStr(err), same: e.fromNodeError(err) === err, failed: e.pyStr(failed),
       renamed: e.pyStr(err, { filename: '/other' }), cls: e.fromNodeError(err, { filename: '/other' }).name });""")
        self.assertEqual(got, {'message': want, 'pyStr': want, 'same': True, 'failed': want,
                               'renamed': str(OSError(2, os.strerror(2), '/other')), 'cls': 'FileNotFoundError'})

    def test_formats(self):
        got = run_node("""
const m = await import(COMPAT + 'pyerr.mjs');
emit([
  m.formatOSError({ errno: 18, strerror: 'Invalid cross-device link', filename: 'a', filename2: 'b' }),
  m.formatOSError({ errno: 2, strerror: 'No such file or directory' }),
  m.formatOSError({ strerror: 'plain' }),
  m.pyStr(new Error('boom')),
]);
""")
        self.assertEqual(got, [
            str(OSError(18, 'Invalid cross-device link', 'a', None, 'b')),
            str(OSError(2, 'No such file or directory')),
            str(OSError('plain')),
            'boom',
        ])


class SubprocessErrorTests(NodeTestCase):
    def test_called_process_and_timeout(self):
        cmds = [
            ['open', 'https://x/y?a=1&b=\'2\''], 'ls -l', ['a'], [], ['it\'s', '"q"'],
            ['/usr/bin/x', '--version', 'café\n'],
        ]
        codes = [1, 2, 127, 255, -9, -15, -11, -1, -99, 0]
        expected = []
        cases = []
        for cmd in cmds:
            for code in codes:
                cases.append(['cpe', cmd, code])
                expected.append(str(subprocess.CalledProcessError(code, cmd)))
            for timeout, flt in ((20, False), (10, False), (20.0, True), (0.5, False), (2.5, True), (1e-5, False)):
                cases.append(['to', cmd, timeout, flt])
                expected.append(str(subprocess.TimeoutExpired(cmd, timeout)))
        got = run_node("""
const m = await import(COMPAT + 'pyerr.mjs');
emit(input.map(([kind, cmd, a, flt]) => kind === 'cpe' ? m.calledProcessError(a, cmd) : m.timeoutExpired(cmd, a, { float: flt })));
""", cases)
        self.assertEqual(got, expected)

    def test_path_elements(self):
        from pathlib import Path as P
        want = str(subprocess.CalledProcessError(1, [P('/x/y'), '--version']))
        got = run_node("""
const m = await import(COMPAT + 'pyerr.mjs');
emit(m.calledProcessError(1, [new m.PyRepr(m.reprPath('/x/y')), '--version']));
""")
        self.assertEqual(got, want)


if __name__ == '__main__':
    unittest.main()
